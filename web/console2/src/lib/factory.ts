import type { FactoryMergedView, FactoryPullRequestView, FactoryIssueView, FactoryRepositoryView } from "@api/api-types";

export const AUTO_REFRESH_MS = 30_000;

/** The server already restricts URLs to github.com; this keeps the browser safe on its own. */
export const safeGithubUrl = (raw: unknown): string | undefined =>
  typeof raw === "string" && raw.startsWith("https://github.com/") ? raw : undefined;

/** Case-insensitive substring match over any of the fields; an empty query matches everything. */
export function matches(query: string, ...fields: unknown[]): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return fields.some((field) => String(field ?? "").toLowerCase().includes(needle));
}

export interface FilteredRepository {
  issues: FactoryIssueView[];
  pullRequests: FactoryPullRequestView[];
  merged: FactoryMergedView[];
  filtered: boolean;
}

export function filterRepository(repo: FactoryRepositoryView, query: string): FilteredRepository {
  return {
    issues: repo.issues.filter((i) => matches(query, i.title, `#${i.number}`, ...(i.labels ?? []).map((l) => l.name))),
    pullRequests: repo.pullRequests.filter((p) => matches(query, p.title, `#${p.number}`, p.reviewDecision)),
    merged: repo.merged.filter((p) => matches(query, p.title, `#${p.number}`, p.author?.login)),
    filtered: query.trim() !== "",
  };
}

/** `12` when unfiltered, `3 of 12` when a filter is active. */
export const countLabel = (shown: number, total: number, filtered: boolean): string => (filtered ? `${shown} of ${total}` : String(total));

/** Only poll while the user can see the page and has not turned it off. */
export const shouldAutoRefresh = (auto: boolean, hidden: boolean): boolean => auto && !hidden;

export const reviewLabel = (decision: string): string => decision.replaceAll("_", " ").toLowerCase();
