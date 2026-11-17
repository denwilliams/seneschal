import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { FactoryJiraConfig } from "../../config/schema.ts";
import type { FactoryRunData } from "./docs.ts";
import { agentFooter, requireFooter } from "./footer.ts";
import type { SourceIssue, SourceComment } from "./source.ts";
import type { WorkTracker } from "./tracker.ts";
import { AcliError, acliFailure, acliOutput, acliStage } from "./jira-errors.ts";

export type AcliRun = (args: string[]) => Promise<{ stdout: string }>;
const exec = promisify(execFile);
/** Host-side only: no shell or sandbox credential import; never propagate CLI output or env on failure. */
export const acliRunner = (env: Record<string, string>, limits: { timeout?: number; maxBuffer?: number } = {}): AcliRun => async (args) => {
  try {
    const { stdout } = await exec("acli", args, { env, timeout: limits.timeout ?? 30_000, maxBuffer: limits.maxBuffer ?? 4_000_000 });
    return { stdout };
  } catch (error) { throw new AcliError(acliStage(args), acliFailure(error)); }
};

const quote = (s: string): string => `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replace(/[\r\n]/g, " ")}"`;
export function jiraJql(config: FactoryJiraConfig): string {
  return [
    ...(config.projects.length ? [`project IN (${config.projects.map(quote).join(", ")})`] : []),
    `component IN (${config.components.map(quote).join(", ")})`,
    `labels = ${quote(config.intakeLabel)}`, "assignee = currentUser()", "statusCategory != Done",
  ].join(" AND ");
}

const account = z.object({ accountId: z.string() }).passthrough();
const rawIssue = z.object({
  id: z.union([z.string().regex(/^\d+$/), z.number().int().positive()]), key: z.string().regex(/^[A-Z][A-Z0-9_]*-\d+$/),
  fields: z.object({
    summary: z.string(), description: z.unknown().optional(), creator: account.nullable().optional(), reporter: account.nullable().optional(),
    labels: z.array(z.string()), components: z.array(z.object({ name: z.string() }).passthrough()), project: z.object({ key: z.string() }).passthrough(), assignee: account.nullable(), created: z.string(), updated: z.string(),
    status: z.object({ name: z.string(), statusCategory: z.object({ key: z.string() }) }),
    comment: z.object({ total: z.number().int() }).passthrough().optional(),
  }).passthrough(),
}).passthrough();
type RawIssue = z.infer<typeof rawIssue>;
const rawComment = z.object({ author: account, body: z.unknown(), created: z.string(), updated: z.string() }).passthrough();
const stamp = (value: string): number => { const n = Date.parse(value); if (!Number.isFinite(n)) throw new Error("ACLI returned an invalid date"); return n; };
/** Jira descriptions/comments may be ADF. Extract text only, never execute embedded content. */
export function jiraText(value: unknown, depth = 0): string {
  if (depth > 30) throw new Error("ACLI document nesting exceeds limit");
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const node = value as { text?: unknown; content?: unknown; type?: unknown };
  return (typeof node.text === "string" ? node.text : "") + (Array.isArray(node.content) ? node.content.map(v => jiraText(v, depth + 1)).join(node.type === "doc" ? "\n" : "") : "") + (node.type === "paragraph" ? "\n" : "");
}
// Search --fields is an ACLI display-field allowlist, NOT arbitrary Jira fields.
// Discover keys with a supported search field, then hydrate via view's Jira-field selector.
const detailFields = "summary,description,creator,reporter,labels,created,updated,status,comment,assignee,components,project";
const candidate = rawIssue.pick({ id: true, key: true }).partial({ id: true });
function rows(stdout: string, key: string): unknown[] {
  let data: unknown;
  try { data = JSON.parse(stdout); } catch { throw new Error("ACLI returned invalid JSON"); }
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object" && Array.isArray((data as Record<string, unknown>)[key])) return (data as Record<string, unknown>)[key] as unknown[];
  throw new Error(`ACLI returned an unsupported ${key} JSON shape`);
}

export function createJiraTracker(config: FactoryJiraConfig, run: AcliRun, options: {
  /** All configured Jira factories, not only open stores. Must fail closed if a candidate cannot be checked. */
  ambiguous?: (id: number) => Promise<boolean>;
} = {}): WorkTracker {
  const trusted = (id: string): string => config.trustedAccountIds.includes(id) ? "COLLABORATOR" : "NONE";
  const auth = async (): Promise<void> => {
    const { stdout } = await run(["jira", "auth", "status"]);
    // ACLI 1.3.x has no --json here. Verify the active site without switching shared login state.
    const hosts = stdout.match(/[a-zA-Z0-9-]+\.atlassian\.net/g) ?? [];
    if (!hosts.some(host => host.toLowerCase() === config.site.toLowerCase())) throw new AcliError("auth-status", "site-validation");
  };
  const search = async (jql: string): Promise<RawIssue[]> => {
    const { stdout } = await run(["jira", "workitem", "search", "--jql", jql, "--fields", "key", "--paginate", "--json"]);
    const found = acliOutput("workitem-search", () => z.array(candidate).parse(rows(stdout, "issues")));
    const hydrated: RawIssue[] = [];
    const seen = new Set<string>();
    for (const item of found) {
      if (seen.has(item.key)) continue;
      seen.add(item.key);
      const detail = await run(["jira", "workitem", "view", item.key, "--fields", detailFields, "--json"]);
      const raw = acliOutput("workitem-view", () => rawIssue.parse(JSON.parse(detail.stdout)));
      // Never allow a stale/misrouted wrapper response to substitute another ticket.
      if (raw.key !== item.key || (item.id !== undefined && String(raw.id) !== String(item.id))) throw new AcliError("workitem-view", "malformed-output");
      hydrated.push(raw);
    }
    return hydrated;
  };
  const normalize = (repo: string, raw: RawIssue): SourceIssue => acliOutput("workitem-view", () => {
    const id = Number(raw.id);
    if (!Number.isSafeInteger(id) || id < 1) throw new Error("ACLI returned an invalid ticket ID");
    const url = `https://${config.site}/browse/${raw.key}`;
    const author = raw.fields.creator?.accountId ?? raw.fields.reporter?.accountId ?? "";
    return {
      repo, number: id, title: raw.fields.summary, body: jiraText(raw.fields.description), url, author, association: trusted(author),
      workItem: { tracker: "jira", site: config.site, id, key: raw.key, url },
      state: raw.fields.status.statusCategory.key.toLowerCase() === "done" ? "closed" : "open", locked: false, isPullRequest: false,
      labels: raw.fields.labels ?? [], createdAt: stamp(raw.fields.created), updatedAt: stamp(raw.fields.updated), comments: raw.fields.comment?.total ?? -1,
    };
  });
  const get = async (id: number): Promise<RawIssue | undefined> => {
    if (!Number.isSafeInteger(id) || id < 1) throw new Error("Invalid Jira ticket ID");
    const found = await search(`id = ${id}`);
    if (found.length > 1 || (found[0] && Number(found[0].id) !== id)) throw new AcliError("workitem-search", "malformed-output");
    return found[0];
  };
  const inScope = (raw: RawIssue): boolean => raw.fields.assignee !== null
    && raw.fields.labels.includes(config.intakeLabel)
    && raw.fields.components.some(component => config.components.includes(component.name))
    && (!config.projects.length || config.projects.includes(raw.fields.project.key))
    && raw.fields.status.statusCategory.key.toLowerCase() !== "done";
  const comments = async (key: string): Promise<SourceComment[]> => {
    const { stdout } = await run(["jira", "workitem", "comment", "list", "--key", key, "--paginate", "--json"]);
    return acliOutput("comment-list", () => z.array(rawComment).parse(rows(stdout, "comments")).map(c => ({
      author: c.author.accountId, association: trusted(c.author.accountId), body: jiraText(c.body), createdAt: stamp(c.created), updatedAt: stamp(c.updated),
    })).sort((a,b) => a.createdAt - b.createdAt));
  };
  const comment = async (key: string, body: string): Promise<void> => {
    const dir = await mkdtemp(join(tmpdir(), "factory-jira-"));
    try {
      const file = join(dir, "comment.txt");
      await writeFile(file, requireFooter(body, "a Jira comment"), { mode: 0o600 });
      await run(["jira", "workitem", "comment", "create", "--key", key, "--body-file", file, "--json"]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  };
  const tracker: WorkTracker = {
    async resolve(_repo, ref) {
      const key = /^[A-Z][A-Z0-9_]*-\d+$/.test(ref) ? ref : /^https:\/\/([^/]+)\/browse\/([A-Z][A-Z0-9_]*-\d+)$/.exec(ref)?.[1] === config.site ? ref.split("/").at(-1)! : undefined;
      if (!key) throw new Error("Name a Jira ticket as HAR-123 or its configured site's browse URL");
      await auth();
      const found = await search(`key = ${quote(key)}`);
      if (found.length !== 1) throw new Error("Jira ticket is not accessible");
      return normalize(_repo, found[0]!).number;
    },
    source: {
      explicitTrust: true,
      async selfLogin() {
        await auth();
        // ACLI has no current-user/profile JSON command. A server-evaluated currentUser()
        // assignment identifies the account without parsing display names or trusting config.
        // Include Done tickets too: identity is independent of intake scope/open status.
        const { stdout } = await run(["jira", "workitem", "search", "--jql", "assignee = currentUser()", "--fields", "assignee", "--limit", "1", "--json"]);
        const found = acliOutput("identity-search", () => z.array(z.object({ fields: z.object({ assignee: z.object({ accountId: z.string().min(1) }) }) })).max(1).parse(rows(stdout, "issues")));
        // No assigned accessible ticket means no identity witness. Idle intake can still
        // succeed, but mapped-ticket comment delivery must fail closed until one exists.
        return found[0]?.fields.assignee.accountId ?? "";
      },
      async changedSince(repo, _since, page) {
        if (page !== 1) return { issues: [], full: false };
        await auth();
        // Scope changes (label/assignment) must be noticed even on old tickets. No backfill/date restriction in JQL.
        const found = await search(jiraJql(config));
        const unique = new Map(found.filter(inScope).map(raw => [String(raw.id), normalize(repo, raw)]));
        for (const issue of unique.values()) {
          const ambiguous = await options.ambiguous?.(issue.number) ?? false;
          issue.selection = { eligible: !ambiguous, ambiguous, reason: ambiguous ? "matches multiple Jira factories; clarify component/project routing" : "" };
        }
        return { issues: [...unique.values()], full: false };
      },
      async issue(repo, id) {
        await auth();
        const raw = await get(id);
        if (!raw) return undefined;
        const issue = normalize(repo, raw);
        // Server evaluates currentUser() in precisely the authenticated CLI context, including immediately before dispatch.
        const eligible = (await search(`id = ${id} AND (${jiraJql(config)})`)).some(row => Number(row.id) === id && inScope(row));
        const ambiguous = eligible && (await options.ambiguous?.(id) ?? false);
        issue.selection = { eligible: eligible && !ambiguous, ambiguous, reason: ambiguous ? "matches multiple Jira factories; clarify component/project routing" : "no longer matches Jira intake scope, label, authenticated assignee or open status" };
        return issue;
      },
      async comments(_repo, id, since) {
        await auth();
        const raw = await get(id);
        if (!raw) throw new Error("Jira ticket is no longer accessible");
        return (await comments(raw.key)).filter(c => c.createdAt > since);
      },
    },
    async readIssue(repo, id) { return tracker.source.issue(repo, id); },
    async commentIssue({ number, body }) {
      await auth();
      const raw = await get(number);
      if (!raw) throw new Error("Jira ticket is no longer accessible");
      await comment(raw.key, body);
    },
    async sync(factoryRun) {
      const item = factoryRun.workItem;
      if (!item) return;
      if (item.site.toLowerCase() !== config.site.toLowerCase()) throw new Error("Jira site changed; refusing to update a different tracker");
      await auth();
      const raw = await get(item.id);
      if (!raw) throw new Error("Jira ticket is no longer accessible");
      if (!["completed", "rejected", "failed", "aborted"].includes(factoryRun.status) && raw.fields.status.statusCategory.key.toLowerCase() === "done") throw new Error("Jira ticket is already in the Done category before workflow completion; restore a non-Done status before retrying");
      const target = jiraStatus(config, factoryRun);
      if (target && raw.fields.status.name !== target) {
        await run(["jira", "workitem", "transition", "--key", raw.key, "--status", target, "--yes", "--json"]);
        const after = await get(item.id);
        if (after?.fields.status.name !== target) throw new Error(`Jira transition to ${target} was not applied; check workflow permissions/mapping`);
        if (factoryRun.status !== "completed" && after.fields.status.statusCategory.key.toLowerCase() === "done") throw new Error("Pre-completion Jira status unexpectedly belongs to Done category; fix the mapping before continuing");
      }
      const event = `${factoryRun.runId}:${factoryRun.current}:${factoryRun.stages.find(s => s.name === factoryRun.current)?.entries ?? 0}:${factoryRun.status}:${factoryRun.wait.kind}:${factoryRun.pr.number}`;
      const marker = `[harness-milestone:${event}]`;
      if (!(await comments(raw.key)).some(c => c.body.includes(marker))) {
        await comment(raw.key, `${raw.key}: ${factoryRun.current} — ${factoryRun.status}${factoryRun.wait.kind ? ` (waiting on ${factoryRun.wait.kind})` : ""}.${factoryRun.reason ? `\n${factoryRun.reason}` : ""}${factoryRun.pr.url ? `\nPull request: ${factoryRun.pr.url}` : ""}\n${marker}\n\n${agentFooter({ role: "factory", stage: factoryRun.current, runId: factoryRun.runId })}`);
      }
    },
  };
  return tracker;
}

export function jiraStatus(config: FactoryJiraConfig, run: FactoryRunData): string | undefined {
  if (run.status === "completed") return config.statuses.completed;
  if (["rejected", "failed", "aborted"].includes(run.status)) return undefined;
  if (run.current === "triage") return config.statuses.triage;
  if (run.current === "implement") return config.statuses.implement;
  return config.statuses.review; // Review, merge/approval, and deployment are not Done.
}
