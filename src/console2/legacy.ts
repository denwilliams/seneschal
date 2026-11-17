import type { ServerResponse } from "node:http";
import { ConsoleLinks } from "./links.ts";

/**
 * The original console's pages are gone. Their addresses still turn up in bookmarks and old Slack messages, so the ones that had a
 * page redirect to where that page now lives. A temporary redirect: a browser must not remember it past a day the console moves again.
 * `/channels/<id>/artifacts/<file>` is an artifact download, not a page, and is not matched.
 */
export function legacyConsoleTarget(pathname: string, links: ConsoleLinks): string | undefined {
  const trimmed = pathname.replace(/\/+$/, "");
  if (trimmed === "") return links.root();
  let parts: string[];
  try { parts = trimmed.split("/").slice(1).map(decodeURIComponent); } catch { return undefined; }
  if (parts[0] !== "channels" || !parts[1]) return undefined;
  const id = parts[1];
  if (parts.length === 2) return links.channel(id);
  if (parts.length !== 3) return undefined;
  if (parts[2] === "factory" || parts[2] === "timeline") return links.channel(id, parts[2]);
  if (parts[2] === "artifacts") return links.channel(id, undefined, "files");
  return undefined;
}

export function redirectLegacyConsole(res: ServerResponse, location: string): void {
  res.writeHead(302, { location, "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end();
}
