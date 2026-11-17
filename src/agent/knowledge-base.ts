import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import type { KnowledgeBaseConfig } from "../config/schema.ts";
import { logger } from "../util/log.ts";

/**
 * Read-only access to a knowledge base: a folder of markdown pages with index files that say what lives beneath them.
 *
 * Everything here takes a path the model wrote, so every path is resolved to a real path and must land inside the
 * knowledge base's own folder. A symlink inside the wiki that points elsewhere is a dead end, not a way out. Nothing in
 * this module writes.
 */

export interface KnowledgeBase {
  name: string;
  description?: string;
  /** The real (symlink-resolved) folder that holds the wiki. */
  root: string;
  /** The starting page, relative to `root`, with `/` separators. */
  index: string;
}

export interface DirEntry {
  name: string;
  kind: "file" | "directory";
  bytes?: number;
}

export interface PageRead {
  /** Path relative to the knowledge base root, `/` separated. */
  path: string;
  text: string;
  offset: number;
  /** Characters in the whole page. */
  total: number;
  /** Where the next read should start, when this one stopped short. */
  nextOffset?: number;
  /** Pages this one links to that exist, as paths relative to the knowledge base root. */
  links: string[];
}

export interface SearchHit {
  path: string;
  title: string;
  score: number;
  /** Matching lines, as `line: text`. */
  snippets: string[];
}

export const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_SEARCH_FILE_BYTES = 1024 * 1024;
/** Files scanned by search and link resolution. Costs time, not context, so it is generous; past it they see only part of the wiki. */
const MAX_FILES = 20_000;
const MAX_LINKS = 60;
export const DEFAULT_PAGE_CHARS = 20_000;
const TEXT_EXTENSIONS = new Set([".md", ".markdown", ".mdx", ".txt"]);
const SKIPPED_DIRS = new Set(["node_modules"]);

export class KnowledgeBaseError extends Error {}

const toPosix = (path: string) => path.split(sep).join("/");
const isHidden = (segment: string) => segment.startsWith(".");

/** Resolve a declared knowledge base to something usable, or say in the log why it is not. */
export function openKnowledgeBase(
  name: string,
  config: KnowledgeBaseConfig,
  baseDir: string,
  label: string,
): KnowledgeBase | undefined {
  const declared = isAbsolute(config.path) ? config.path : resolve(baseDir, config.path);
  let root: string;
  try {
    root = realpathSync(declared);
    if (!statSync(root).isDirectory()) throw new Error("not a directory");
  } catch {
    logger.warn(`${label}: knowledge base "${name}" has no folder at ${declared}; skipped`);
    return undefined;
  }
  const index = posix.normalize(config.index.replaceAll("\\", "/"));
  if (index.startsWith("../") || index === ".." || isAbsolute(index)) {
    logger.warn(`${label}: knowledge base "${name}" has an index outside its folder (${config.index}); skipped`);
    return undefined;
  }
  if (!existsSync(join(root, index))) {
    // Still usable: search and browsing work without an index. The agent is told it is missing when it asks for it.
    logger.warn(`${label}: knowledge base "${name}" has no index file at ${join(root, index)}`);
  }
  return { name, ...(config.description ? { description: config.description } : {}), root, index };
}

function isWithin(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * The real path of `rel` inside the knowledge base. Refuses anything that leaves the folder, however it is spelled, and
 * anything hidden (`.git`, `.obsidian`): those are the tooling's files, not the wiki's.
 */
export function resolveInside(kb: KnowledgeBase, rel: string | undefined): string {
  const raw = (rel ?? "").trim().replaceAll("\\", "/");
  if (isAbsolute(raw) || /^[a-zA-Z]:/.test(raw)) {
    throw new KnowledgeBaseError(`Paths are relative to the "${kb.name}" knowledge base, not absolute: ${raw}`);
  }
  const normalized = posix.normalize(raw === "" ? "." : raw);
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new KnowledgeBaseError(`${raw} is outside the "${kb.name}" knowledge base.`);
  }
  if (normalized.split("/").some((segment) => segment !== "." && isHidden(segment))) {
    throw new KnowledgeBaseError(`${raw} is not part of the wiki (hidden files and folders are not readable).`);
  }
  const candidate = resolve(kb.root, normalized);
  let real: string;
  try {
    real = realpathSync(candidate);
  } catch {
    throw new KnowledgeBaseError(`There is nothing at ${normalized === "." ? "the root of" : normalized + " in"} the "${kb.name}" knowledge base.`);
  }
  if (!isWithin(real, kb.root)) {
    throw new KnowledgeBaseError(`${raw} resolves outside the "${kb.name}" knowledge base.`);
  }
  return real;
}

const relPath = (kb: KnowledgeBase, real: string) => toPosix(relative(kb.root, real)) || ".";

export function listDirectory(kb: KnowledgeBase, rel: string | undefined): { path: string; entries: DirEntry[] } {
  const dir = resolveInside(kb, rel);
  if (!statSync(dir).isDirectory()) throw new KnowledgeBaseError(`${rel} is a file, not a folder. Use kb_read to open it.`);
  const entries: DirEntry[] = [];
  for (const dirent of readdirSync(dir, { withFileTypes: true })) {
    if (isHidden(dirent.name) || SKIPPED_DIRS.has(dirent.name)) continue;
    const full = join(dir, dirent.name);
    let info;
    try {
      info = statSync(full); // follows symlinks, so a link to a folder lists as one
      if (!isWithin(realpathSync(full), kb.root)) continue; // a symlink out of the wiki does not exist as far as it is concerned
    } catch {
      continue;
    }
    entries.push(info.isDirectory() ? { name: dirent.name, kind: "directory" } : { name: dirent.name, kind: "file", bytes: info.size });
  }
  entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "directory" ? -1 : 1));
  return { path: relPath(kb, dir), entries };
}

export const MAX_TREE_ENTRIES = 100;

/**
 * The folder and everything beneath it, as paths relative to the folder, depth first with folders before files. Stops at
 * `limit` entries and says so, so a huge wiki costs a bounded amount of context. Symlinked folders are not followed.
 */
export function listTree(
  kb: KnowledgeBase,
  rel: string | undefined,
  limit = MAX_TREE_ENTRIES,
): { path: string; entries: (DirEntry & { path: string })[]; truncated: boolean } {
  const top = listDirectory(kb, rel);
  const entries: (DirEntry & { path: string })[] = [];
  let truncated = false;
  const walk = (dirRel: string, prefix: string): void => {
    const { entries: children } = dirRel === top.path ? top : listDirectory(kb, dirRel);
    for (const child of children) {
      if (entries.length >= limit) {
        truncated = true;
        return;
      }
      const path = prefix + child.name;
      entries.push({ ...child, path });
      if (child.kind === "directory") {
        const childRel = dirRel === "." ? child.name : `${dirRel}/${child.name}`;
        // A symlinked folder lists as a folder but is not descended into: it could loop back into an ancestor.
        if (!lstatSync(join(kb.root, childRel)).isSymbolicLink()) walk(childRel, `${path}/`);
        if (truncated) return;
      }
    }
  };
  walk(top.path, "");
  return { path: top.path, entries, truncated };
}

/** Every text page in the knowledge base, as paths relative to its root. Capped, so a huge folder cannot stall a turn. */
export function listPages(kb: KnowledgeBase, under = "."): string[] {
  const start = resolveInside(kb, under);
  const out: string[] = [];
  const stack = [start];
  while (stack.length > 0 && out.length < MAX_FILES) {
    const dir = stack.pop()!;
    let dirents;
    try {
      dirents = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const dirent of dirents) {
      if (isHidden(dirent.name) || SKIPPED_DIRS.has(dirent.name)) continue;
      const full = join(dir, dirent.name);
      let real: string;
      try {
        real = realpathSync(full);
      } catch {
        continue;
      }
      if (!isWithin(real, kb.root)) continue;
      // A symlinked folder is not followed: it could loop back into an ancestor, and a wiki rarely needs one.
      if (dirent.isDirectory()) stack.push(full);
      else if (!statSync(real).isDirectory() && TEXT_EXTENSIONS.has(posix.extname(dirent.name).toLowerCase())) {
        out.push(toPosix(relative(kb.root, full)));
      }
    }
  }
  if (out.length >= MAX_FILES) logger.warn(`knowledge base "${kb.name}" has more than ${MAX_FILES} pages; search and links only cover the first ${MAX_FILES} found`);
  return out.sort();
}

/** Obsidian-style `[[Page]]`, `[[Page|alias]]`, `[[folder/Page#Heading]]` and ordinary markdown links, resolved to real pages. */
export function extractLinks(kb: KnowledgeBase, fromRel: string, text: string, pages?: string[]): string[] {
  const all = pages ?? listPages(kb);
  const known = new Set(all);
  const byBase = new Map<string, string[]>();
  for (const page of all) {
    const base = posix.basename(page, posix.extname(page)).toLowerCase();
    byBase.set(base, [...(byBase.get(base) ?? []), page]);
  }
  const fromDir = posix.dirname(fromRel);
  const found = new Set<string>();
  const add = (page: string | undefined) => {
    if (page && page !== fromRel) found.add(page);
  };

  for (const match of text.matchAll(/!?\[\[([^\]\n]+)\]\]/g)) {
    if (match[0].startsWith("!")) continue; // an embedded image or file, not a page to walk to
    const target = match[1]!.split("|")[0]!.split("#")[0]!.trim();
    if (!target) continue;
    const withExt = /\.[a-z0-9]+$/i.test(target) ? target : `${target}.md`;
    const direct = posix.normalize(withExt);
    if (known.has(direct)) add(direct);
    else {
      const candidates = byBase.get(posix.basename(withExt, posix.extname(withExt)).toLowerCase()) ?? [];
      // Obsidian takes the shortest path when a name is ambiguous.
      add([...candidates].sort((a, b) => a.length - b.length)[0]);
    }
  }
  for (const match of text.matchAll(/(?<!!)\[[^\]\n]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const href = match[1]!;
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("#")) continue;
    let decoded = href.split("#")[0]!;
    try { decoded = decodeURIComponent(decoded); } catch { /* keep it as written */ }
    if (!decoded) continue;
    const resolved = decoded.startsWith("/") ? posix.normalize(decoded.slice(1)) : posix.normalize(posix.join(fromDir, decoded));
    if (known.has(resolved)) add(resolved);
  }
  return [...found].slice(0, MAX_LINKS);
}

function looksBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 4096).includes(0);
}

/** One page of text from a file, plus the pages it links to. `offset` and `limit` count characters. */
export function readPage(kb: KnowledgeBase, rel: string | undefined, offset = 0, limit = DEFAULT_PAGE_CHARS): PageRead {
  const real = resolveInside(kb, rel ?? kb.index);
  const info = statSync(real);
  const path = relPath(kb, real);
  if (info.isDirectory()) {
    throw new KnowledgeBaseError(`${path} is a folder. Use kb_ls to see what is in it, or read its index page.`);
  }
  if (info.size > MAX_FILE_BYTES) {
    throw new KnowledgeBaseError(`${path} is ${Math.round(info.size / 1024 / 1024)} MB, over the ${MAX_FILE_BYTES / 1024 / 1024} MB limit for a page.`);
  }
  const buffer = readFileSync(real);
  if (looksBinary(buffer)) throw new KnowledgeBaseError(`${path} is not a text file.`);
  const full = buffer.toString("utf-8");
  const start = Math.max(0, Math.floor(offset));
  const size = Math.max(1, Math.floor(limit));
  const text = full.slice(start, start + size);
  const end = start + text.length;
  return {
    path,
    text,
    offset: start,
    total: full.length,
    ...(end < full.length ? { nextOffset: end } : {}),
    links: extractLinks(kb, path, full),
  };
}

function titleOf(path: string, text: string): string {
  const heading = /^#{1,3}\s+(.+?)\s*#*\s*$/m.exec(text)?.[1];
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
  const frontmatter = block ? /^title:\s*["']?(.+?)["']?\s*$/m.exec(block)?.[1] : undefined;
  return (frontmatter ?? heading ?? posix.basename(path, posix.extname(path))).trim();
}

function terms(query: string): string[] {
  const quoted = [...query.matchAll(/"([^"]+)"/g)].map((m) => m[1]!.toLowerCase().trim());
  const rest = query.replace(/"[^"]*"/g, " ").toLowerCase().split(/\s+/).filter((t) => t.length > 1);
  return [...new Set([...quoted, ...rest].filter(Boolean))];
}

/**
 * Keyword search over the whole wiki. A page that has every term outranks one that has more of fewer; a term in the path or
 * title counts for more than one in the body. Returns where to look, not the pages: the agent opens what it picks.
 */
export function searchKnowledgeBase(
  kb: KnowledgeBase,
  query: string,
  opts: { limit?: number; under?: string } = {},
): SearchHit[] {
  const wanted = terms(query);
  if (wanted.length === 0) return [];
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 50);
  const hits: SearchHit[] = [];
  for (const page of listPages(kb, opts.under ?? ".")) {
    let text: string;
    try {
      const full = join(kb.root, page);
      if (statSync(full).size > MAX_SEARCH_FILE_BYTES) continue;
      text = readFileSync(full, "utf-8");
    } catch {
      continue;
    }
    const lower = text.toLowerCase();
    const pathLower = page.toLowerCase();
    const title = titleOf(page, text);
    const titleLower = title.toLowerCase();
    let score = 0;
    let matched = 0;
    for (const term of wanted) {
      const body = lower.split(term).length - 1;
      const inPath = pathLower.includes(term);
      const inTitle = titleLower.includes(term);
      if (body === 0 && !inPath && !inTitle) continue;
      matched++;
      score += Math.min(body, 10) + (inPath ? 8 : 0) + (inTitle ? 8 : 0);
    }
    if (matched === 0) continue;
    score += matched === wanted.length ? 20 : 0;

    const snippets: string[] = [];
    const lines = text.split("\n");
    for (let i = 0; i < lines.length && snippets.length < 3; i++) {
      const line = lines[i]!;
      const lineLower = line.toLowerCase();
      if (wanted.some((term) => lineLower.includes(term))) {
        const trimmed = line.trim();
        snippets.push(`${i + 1}: ${trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed}`);
      }
    }
    hits.push({ path: page, title, score, snippets });
  }
  return hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, limit);
}
