import type { FactoryActivity } from "./dashboard.ts";

/** Only fields actually read from GitHub. Missing payloads remain generic events. */
export interface GitHubEvent {
  type?: string;
  created_at?: string;
  actor?: { login?: string };
  payload?: {
    action?: string;
    number?: number;
    issue?: { number?: number; title?: string; html_url?: string };
    pull_request?: { number?: number; title?: string; html_url?: string; merged?: boolean };
    comment?: { html_url?: string; body?: string };
    review?: { html_url?: string; state?: string };
    release?: { html_url?: string; tag_name?: string };
    discussion?: { html_url?: string; title?: string };
    forkee?: { html_url?: string; full_name?: string };
    ref?: string;
    ref_type?: string;
    head?: string;
    size?: number;
    commits?: { sha?: string; message?: string }[];
  };
}

export interface GitHubDeployment {
  id: number;
  created_at: string;
  environment?: string;
  ref?: string;
  sha?: string;
  creator?: { login?: string };
}

export function githubEventActivity(repository: string, event: GitHubEvent): FactoryActivity {
  const p = event.payload ?? {};
  let url = `https://github.com/${repository}`;
  let details = p.action ?? "";
  if (event.type === "IssuesEvent") {
    url = p.issue?.html_url ?? url;
    details = [p.action, p.issue?.number ? `Issue #${p.issue.number}` : "", p.issue?.title].filter(Boolean).join(" · ");
  } else if (event.type?.startsWith("PullRequest")) {
    url = p.comment?.html_url ?? p.review?.html_url ?? p.pull_request?.html_url ?? url;
    details = [p.action, p.pull_request?.number || p.number ? `PR #${p.pull_request?.number ?? p.number}` : "", p.pull_request?.title, p.review?.state].filter(Boolean).join(" · ");
  } else if (event.type === "PushEvent") {
    const head = p.head ?? p.commits?.at(-1)?.sha;
    if (head && /^[a-f0-9]{40}$/i.test(head)) url += `/commit/${head}`;
    details = [p.ref, head ? `head ${head.slice(0, 7)}` : "", p.size !== undefined ? `${p.size} commits` : "", p.commits?.[0]?.message].filter(Boolean).join(" · ");
  } else if (event.type === "IssueCommentEvent") {
    url = p.comment?.html_url ?? p.issue?.html_url ?? url;
    details = [p.action, p.issue?.number ? `Issue/PR #${p.issue.number}` : "", p.issue?.title].filter(Boolean).join(" · ");
  } else if (event.type === "CommitCommentEvent") {
    url = p.comment?.html_url ?? url;
  } else if (event.type === "ReleaseEvent") {
    url = p.release?.html_url ?? url;
    details = [p.action, p.release?.tag_name].filter(Boolean).join(" · ");
  } else if (event.type === "DiscussionEvent") {
    url = p.discussion?.html_url ?? url;
    details = [p.action, p.discussion?.title].filter(Boolean).join(" · ");
  } else if (event.type === "ForkEvent") {
    url = p.forkee?.html_url ?? url;
    details = p.forkee?.full_name ?? details;
  } else if (event.type === "CreateEvent" || event.type === "DeleteEvent") {
    details = [p.ref_type, p.ref].filter(Boolean).join(" · ");
  }
  return {
    type: event.type ?? "GitHub event", createdAt: event.created_at ?? "", actor: event.actor?.login,
    action: p.action, merged: p.pull_request?.merged, details, url,
  };
}

export function githubDeploymentActivity(repository: string, deployment: GitHubDeployment): FactoryActivity {
  return {
    type: "Deployment", createdAt: deployment.created_at, actor: deployment.creator?.login,
    url: `https://github.com/${repository}/deployments`,
    details: [`Deployment #${deployment.id}`, deployment.environment, deployment.ref, deployment.sha?.slice(0, 7), "Creation record only; outcome not checked"].filter(Boolean).join(" · "),
  };
}
