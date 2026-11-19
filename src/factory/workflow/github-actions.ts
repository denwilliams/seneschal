import type { GhRun } from "./github.ts";

export interface DeploymentRun {
  id: number; attempt: number; workflowId: number; repo: string; sha: string;
  status: string; conclusion: string | null; url: string;
}
export type ReadDeploymentRun = (input: {
  repo: string; workflow: string | number; sha: string;
  workflowId?: number; runId?: number; signal?: AbortSignal;
}) => Promise<{ workflowId: number; run?: DeploymentRun }>;

type RawRun = {
  id: number; run_attempt: number; workflow_id: number; head_sha: string;
  repository: { full_name: string }; status: string; conclusion: string | null;
};
const positive = (n: number) => Number.isSafeInteger(n) && n > 0;

/** Only GET endpoints. Resolve a filename to an ID, then correlate repository, workflow and full SHA locally as well. */
export function createDeploymentReader(gh: GhRun): ReadDeploymentRun {
  return async ({ repo, workflow, sha, workflowId, runId, signal }) => {
    const get = async (path: string): Promise<unknown> => {
      signal?.throwIfAborted();
      const { stdout } = await gh(["api", "--method", "GET", path]);
      signal?.throwIfAborted();
      return JSON.parse(stdout);
    };
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || !/^[a-f0-9]{40}$/i.test(sha)) throw new Error("Actions monitoring requires a repository and full merged commit SHA");
    if (workflowId === undefined) {
      const key = typeof workflow === "string" ? workflow.replace(/^\.github\/workflows\//, "") : String(workflow);
      workflowId = (await get(`repos/${repo}/actions/workflows/${encodeURIComponent(key)}`) as { id: number }).id;
    }
    if (!positive(workflowId)) throw new Error("Actions API returned an invalid workflow ID");
    const convert = (raw: RawRun): DeploymentRun => {
      if (!positive(raw.id) || !positive(raw.run_attempt) || raw.workflow_id !== workflowId || raw.head_sha.toLowerCase() !== sha.toLowerCase() || raw.repository?.full_name?.toLowerCase() !== repo.toLowerCase()) throw new Error("Actions run does not match the pinned repository, workflow and merged commit");
      if (typeof raw.status !== "string" || (raw.conclusion !== null && typeof raw.conclusion !== "string")) throw new Error("Actions API returned an invalid run outcome");
      return { id: raw.id, attempt: raw.run_attempt, workflowId: raw.workflow_id, repo, sha, status: raw.status, conclusion: raw.conclusion, url: `https://github.com/${repo}/actions/runs/${raw.id}` };
    };
    if (runId !== undefined) {
      if (!positive(runId)) throw new Error("Invalid pinned Actions run ID");
      const run = convert(await get(`repos/${repo}/actions/runs/${runId}`) as RawRun);
      if (run.id !== runId) throw new Error("Actions API returned a different run ID");
      return { workflowId, run };
    }
    const matches: DeploymentRun[] = [];
    // The filtered workflow endpoint permits at most 1,000 results. Never silently select from truncated evidence.
    for (let page = 1; page <= 10; page++) {
      const data = await get(`repos/${repo}/actions/workflows/${workflowId}/runs?head_sha=${sha}&per_page=100&page=${page}`) as { total_count: number; workflow_runs: RawRun[] };
      if (!Array.isArray(data.workflow_runs) || !Number.isSafeInteger(data.total_count) || data.total_count > 1000) throw new Error("Actions run listing is invalid or exceeds the 1,000-run polling limit");
      for (const raw of data.workflow_runs) {
        // Ignore unrelated evidence, never treating it as a successful deployment.
        if (raw.workflow_id === workflowId && raw.head_sha?.toLowerCase() === sha.toLowerCase() && raw.repository?.full_name?.toLowerCase() === repo.toLowerCase()) matches.push(convert(raw));
      }
      if (data.workflow_runs.length < 100) return { workflowId, run: matches.sort((a, b) => b.id - a.id)[0] };
    }
    throw new Error("Actions run listing reached its pagination limit");
  };
}
