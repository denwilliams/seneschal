import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ResolvedChannel } from "../workspace/resolve.ts";
import type { FactoryIssue, FactoryPullRequest, FactoryRepositorySnapshot } from "./dashboard.ts";
import { githubDeploymentActivity, githubEventActivity, type GitHubDeployment, type GitHubEvent } from "./activity.ts";

const run = promisify(execFile);
const LIMIT = 30;

export async function ghJson<T>(env: Record<string, string>, args: string[]): Promise<T> {
  const { stdout } = await run("gh", args, { env, timeout: 20_000, maxBuffer: 1_000_000 });
  return JSON.parse(stdout) as T;
}

export type FactoryGitHubReader = <T>(env: Record<string, string>, args: string[]) => Promise<T>;
const ACTIVITY_PAGES = 3;
const ACTIVITY_PAGE_SIZE = 100;

async function readActivityPages<T>(repository: string, endpoint: "events" | "deployments", env: Record<string, string>, reader: FactoryGitHubReader): Promise<T[]> {
  const records: T[] = [];
  for (let page = 1; page <= ACTIVITY_PAGES; page++) {
    const batch = await reader<T[]>(env, ["api", `repos/${repository}/${endpoint}?per_page=${ACTIVITY_PAGE_SIZE}&page=${page}`]);
    records.push(...batch);
    if (batch.length < ACTIVITY_PAGE_SIZE) break;
  }
  return records;
}

/** Read-only GitHub collection. Repositories come from reviewed channel config, never model input. */
export async function readFactoryRepository(repository: string, env: Record<string, string>, reader: FactoryGitHubReader = ghJson): Promise<FactoryRepositorySnapshot> {
  try {
    const [issues, pullRequests, events, deployments] = await Promise.all([
      reader<FactoryIssue[]>(env, ["issue", "list", "--repo", repository, "--state", "open", "--limit", String(LIMIT), "--json", "number,title,state,updatedAt,url,labels"]),
      reader<FactoryPullRequest[]>(env, ["pr", "list", "--repo", repository, "--state", "open", "--limit", String(LIMIT), "--json", "number,title,state,updatedAt,url,isDraft,reviewDecision"]),
      readActivityPages<GitHubEvent>(repository, "events", env, reader),
      // Deployment access is optional: its failure must not erase issue/PR/event data.
      readActivityPages<GitHubDeployment>(repository, "deployments", env, reader).catch(() => undefined),
    ]);
    const activity = [
      ...events.map((event) => githubEventActivity(repository, event)),
      ...(deployments ?? []).map((deployment) => githubDeploymentActivity(repository, deployment)),
    ];
    const activityCoverage = `Read-only GitHub snapshot: up to 300 latest repository events and 300 deployment creation records. Only returned records in the trailing seven days are shown. Events may be delayed or omitted and busy repositories may exceed these limits; this is not a complete activity history. ${deployments === undefined ? "Deployment data unavailable (access, network or API error)." : "Deployments mark creation only; outcome/status not checked. Releases and pushes are not deployments."}`;
    return { repository, issues, pullRequests, activity, activityCoverage };
  } catch {
    // Do not expose CLI output: it can include host-specific details. Keep a
    // dashboard useful even if one repo's GitHub access is unavailable.
    return { repository, issues: [], pullRequests: [], activity: [], error: "GitHub data unavailable. Check gh authentication, network access, and repository permissions." };
  }
}

export function createFactoryTools(channel: ResolvedChannel): ToolDefinition[] {
  if (!channel.factory) return [];
  return [defineTool({
    name: "get_factory_dashboard_link",
    label: "Factory dashboard link",
    description: "Return the link to this factory's live web console page: open issues, pull requests, merges and recent activity for the configured repositories. The page reads GitHub itself, read-only, each time it is opened.",
    parameters: Type.Object({}),
    execute: async () => {
      const factory = channel.factory!;
      const url = channel.consoleUrl ? `${channel.consoleUrl}?view=factory` : undefined;
      return {
        content: [{ type: "text" as const, text: url
          ? `The live ${factory.name} factory dashboard is at ${url}`
          : "The web console is not enabled, so there is no factory dashboard to link. An operator can enable `webConsole` behind a protected proxy." }],
        details: { url, repositories: factory.repositories },
      };
    },
  })] as ToolDefinition[];
}
