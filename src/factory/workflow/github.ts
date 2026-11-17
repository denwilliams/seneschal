import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { FactoryGitHub } from "./deps.ts";
import { requireFooter } from "./footer.ts";
import type { FactoryLabels } from "./labels.ts";
import type { IssueSource, SourceComment, SourceIssue } from "./source.ts";
import { prMergeability, type ChecksFacts, type PrFacts } from "./merge.ts";

const exec = promisify(execFile);

/**
 * Runs `gh` with these arguments, and `input` on its standard input when given (an issue body is never put on the command line).
 * A failure carries the CLI's `stdout` when it printed any (gh checks exits non-zero by design).
 */
export type GhRun = (args: string[], input?: string) => Promise<{ stdout: string }>;

export const ghRunner = (env: Record<string, string>): GhRun => (args, input) => {
  const running = exec("gh", args, { env, timeout: 30_000, maxBuffer: 2_000_000 });
  // `gh issue create --body-file -` reads the body to the end of its input.
  if (input !== undefined) running.child.stdin?.end(input);
  return running;
};

const POLL_MS = 30_000;

/** What GitHub's REST API says of an issue, as far as intake reads it. */
type RestIssue = {
  number: number; title: string; body: string | null; html_url: string; state: string; locked?: boolean; comments?: number;
  user?: { login?: string } | null; author_association?: string; labels?: (string | { name?: string })[]; created_at: string; updated_at: string;
  pull_request?: unknown;
};
type RestComment = { user?: { login?: string } | null; author_association?: string; body?: string | null; created_at: string; updated_at: string };

const REST_PAGE = 100;
const MAX_COMMENT_PAGES = 5;

const toIssue = (repo: string, raw: RestIssue): SourceIssue => ({
  repo, number: raw.number, title: raw.title ?? "", body: raw.body ?? "", url: raw.html_url, author: raw.user?.login ?? "", association: raw.author_association ?? "",
  state: raw.state === "open" ? "open" : "closed", locked: raw.locked === true, isPullRequest: raw.pull_request !== undefined,
  labels: (raw.labels ?? []).map((label) => (typeof label === "string" ? label : label.name ?? "")).filter(Boolean),
  createdAt: Date.parse(raw.created_at), updatedAt: Date.parse(raw.updated_at), comments: raw.comments ?? 0,
});

/**
 * Intake's view of GitHub through `gh api`, with the channel's own credentials: the REST issues listing, not search (search lags
 * a freshly filed issue by minutes), because it carries `author_association`, which `gh issue list --json` does not. Repositories
 * come from the factory's configuration and numbers from the mapping, never from model output; every argument is one argv element.
 */
export function createIssueSource(run: GhRun): IssueSource {
  let login: Promise<string> | undefined;
  const iso = (ms: number): string => new Date(Math.max(0, ms)).toISOString();
  return {
    selfLogin() {
      login ??= run(["api", "user", "--jq", ".login"]).then(({ stdout }) => stdout.trim(), (error) => { login = undefined; throw error; });
      return login;
    },

    async changedSince(repo, since, page) {
      const { stdout } = await run(["api", `repos/${repo}/issues?state=all&sort=updated&direction=asc&since=${iso(since)}&per_page=${REST_PAGE}&page=${page}`]);
      const rows = JSON.parse(stdout) as RestIssue[];
      return { issues: rows.map((row) => toIssue(repo, row)), full: rows.length >= REST_PAGE };
    },

    async issue(repo, number) {
      try {
        const { stdout } = await run(["api", `repos/${repo}/issues/${number}`]);
        return toIssue(repo, JSON.parse(stdout) as RestIssue);
      } catch (error) {
        // Gone (deleted, or transferred out) is an answer; no credentials or no network is a failure.
        if (/\b(404|410)\b|not found|gone/i.test(`${String((error as { stderr?: unknown }).stderr ?? "")}${(error as Error).message}`)) return undefined;
        throw error;
      }
    },

    async comments(repo, number, since) {
      // Every page (oldest first), up to a bound: a long thread read again must not stop at the first hundred, or the newest answer is missed.
      const all: SourceComment[] = [];
      for (let page = 1; page <= MAX_COMMENT_PAGES; page++) {
        const { stdout } = await run(["api", `repos/${repo}/issues/${number}/comments?since=${iso(since)}&per_page=${REST_PAGE}&page=${page}`]);
        const rows = JSON.parse(stdout) as RestComment[];
        for (const row of rows) all.push({
          author: row.user?.login ?? "", association: row.author_association ?? "", body: row.body ?? "",
          createdAt: Date.parse(row.created_at), updatedAt: Date.parse(row.updated_at),
        });
        if (rows.length < REST_PAGE) break;
      }
      return all;
    },
  };
}

/**
 * The factory's labels through `gh`, with the channel's own credentials. The repository comes from the factory's configuration and
 * a label name from configuration or the shipped list (both validated as plain names), each one argv element. Listing follows every
 * page; creating never passes `--force`, so an existing label is left exactly as it is.
 */
export function createLabels(run: GhRun): FactoryLabels {
  return {
    async list(repo) {
      const { stdout } = await run(["api", "--paginate", `repos/${repo}/labels?per_page=100`, "--jq", ".[].name"]);
      return stdout.split("\n").map((line) => line.trim()).filter(Boolean);
    },
    async create(repo, label) {
      try {
        await run(["label", "create", label.name, "--repo", repo, "--color", label.color, "--description", label.description]);
        return "created";
      } catch (error) {
        // Made by someone else a moment ago: it is there, which is all that was wanted.
        if (/already exists/i.test(`${String((error as { stderr?: unknown }).stderr ?? "")}${(error as Error).message}`)) return "exists";
        throw error;
      }
    },
  };
}

type PrView = { state: "OPEN" | "MERGED" | "CLOSED"; headRefOid: string; mergeable?: string; mergeStateStatus?: string; headRefName?: string; baseRefName?: string; baseRefOid?: string; files?: { path: string }[]; additions?: number; deletions?: number; mergeCommit?: { oid?: string } | null };

const toFacts = (view: PrView): PrFacts => ({
  state: view.state === "MERGED" ? "merged" : view.state === "CLOSED" ? "closed" : "open",
  headSha: view.headRefOid,
  mergeable: view.mergeable ?? "UNKNOWN",
  mergeStateStatus: view.mergeStateStatus ?? "UNKNOWN",
  headRefName: view.headRefName,
  baseRefName: view.baseRefName,
  baseSha: view.baseRefOid,
  changedFiles: (view.files ?? []).map((file) => file.path),
  additions: view.additions ?? 0,
  deletions: view.deletions ?? 0,
  ...(view.mergeCommit?.oid ? { mergeCommit: view.mergeCommit.oid } : {}),
});

/**
 * GitHub through the `gh` CLI, with the channel's own credentials. Repositories and numbers come from the run's record, which the
 * engine validated against the factory's configured repositories, never from model output.
 */
export function createGitHub(run: GhRun, options: { pollMs?: number; sleep?: (ms: number, signal: AbortSignal) => Promise<void> } = {}): FactoryGitHub {
  const view = async (repo: string, number: number): Promise<PrView> => {
    const { stdout } = await run(["pr", "view", String(number), "--repo", repo, "--json", "state,headRefOid,files,additions,deletions,mergeCommit,mergeable,mergeStateStatus,headRefName,baseRefName,baseRefOid"]);
    return JSON.parse(stdout) as PrView;
  };
  const sleep = options.sleep ?? ((ms, signal) => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); }, { once: true });
  }));
  // GitHub calculates mergeability asynchronously. Three reads, then an explicit unresolved answer.
  const readPr = async (repo: string, number: number): Promise<PrFacts> => {
    let facts = toFacts(await view(repo, number));
    for (let refresh = 0; facts.state === "open" && prMergeability(facts) === "unknown" && refresh < 2; refresh++) {
      await sleep(options.pollMs ?? 1_000, new AbortController().signal);
      facts = toFacts(await view(repo, number));
    }
    return facts;
  };
  return {
    source: createIssueSource(run),
    labels: createLabels(run),

    async readIssue(repo, number) {
      let stdout: string;
      try {
        ({ stdout } = await run(["issue", "view", String(number), "--repo", repo, "--json", "number,title,url,state"]));
      } catch (error) {
        // `gh` says so on stderr when there is no such issue; anything else (no credentials, no network) is a failure, not an answer.
        if (/could not resolve to an issue|not found|no issue/i.test(`${String((error as { stderr?: unknown }).stderr ?? "")}${(error as Error).message}`)) return undefined;
        throw error;
      }
      const issue = JSON.parse(stdout) as { number: number; title: string; url: string; state: string };
      return { number: issue.number, title: issue.title, url: issue.url, state: issue.state === "OPEN" ? "open" : "closed" };
    },

    async createIssue({ repo, title, body, labels }) {
      const args = ["issue", "create", "--repo", repo, "--title", title, "--body-file", "-", ...labels.flatMap((label) => ["--label", label])];
      // Everything the harness itself writes to GitHub is marked as the agent's (the roles' writes are marked by the `gh` guard).
      const { stdout } = await run(args, requireFooter(body, "an issue"));
      // `gh issue create` prints the new issue's URL on its last line.
      const url = stdout.trim().split(/\s+/).at(-1) ?? "";
      const found = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/issues\/(\d+)$/.exec(url);
      if (!found || found[1]!.toLowerCase() !== repo.toLowerCase()) throw new Error("gh did not say which issue it created");
      return { number: Number(found[2]), title, url, state: "open" };
    },

    async commentIssue({ repo, number, body }) {
      await run(["issue", "comment", String(number), "--repo", repo, "--body-file", "-"], requireFooter(body, "a comment"));
    },

    readPr,

    async readChecks(repo, number): Promise<ChecksFacts> {
      let stdout: string;
      try {
        ({ stdout } = await run(["pr", "checks", String(number), "--repo", repo, "--required", "--json", "bucket"]));
      } catch (error) {
        // `gh pr checks` exits non-zero when a check failed or is pending, and says so on stdout. With no required checks it
        // prints a message instead; both are answers, not failures.
        const out = String((error as { stdout?: unknown }).stdout ?? "");
        const text = `${out}${String((error as { stderr?: unknown }).stderr ?? "")}`;
        if (/no required checks/i.test(text)) return { required: 0, failing: 0, pending: 0 };
        if (!out.trim().startsWith("[")) throw error;
        stdout = out;
      }
      const checks = JSON.parse(stdout) as { bucket?: string }[];
      return {
        required: checks.length,
        failing: checks.filter((check) => check.bucket === "fail" || check.bucket === "cancel").length,
        pending: checks.filter((check) => check.bucket === "pending").length,
      };
    },

    async mergePr({ repo, number, method, expectedHead }) {
      const before = await readPr(repo, number);
      if (before.state === "merged") return { mergeCommit: before.mergeCommit ?? "" };
      if (before.state === "closed") throw new Error("the pull request is closed");
      if (before.headSha !== expectedHead) throw new Error("the pull request head changed after approval");
      if (prMergeability(before) !== "mergeable") throw new Error("the pull request has conflicting or unresolved mergeability");
      await run(["pr", "merge", String(number), "--repo", repo, `--${method}`, "--match-head-commit", expectedHead]);
      const after = await view(repo, number);
      return { mergeCommit: after.mergeCommit?.oid ?? "" };
    },

    async untilSettled({ repo, number, signal, expectedHead }) {
      for (;;) {
        const facts = toFacts(await view(repo, number));
        if (facts.state !== "open" || prMergeability(facts) === "conflicting" || (expectedHead && facts.headSha !== expectedHead)) return facts;
        await sleep(options.pollMs ?? POLL_MS, signal);
      }
    },
  };
}
