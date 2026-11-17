import type { FactoryGitHub, IssueFacts } from "./deps.ts";
import type { FactoryRunData } from "./docs.ts";
import type { IssueSource } from "./source.ts";

/** Work tracking is separate from code hosting: PR/check/merge operations stay on GitHub. */
export interface WorkTracker {
  source: IssueSource;
  resolve?(repo: string, ref: string): Promise<number>;
  readIssue(repo: string, number: number): Promise<IssueFacts | undefined>;
  commentIssue(input: { repo: string; number: number; body: string }): Promise<void>;
  /** Idempotent milestone publication; failures block progression, never approve anything. */
  sync?(run: FactoryRunData): Promise<void>;
}

export function githubTracker(github: FactoryGitHub): WorkTracker {
  if (!github.source) throw new Error("GitHub issue source is unavailable");
  return { source: github.source, readIssue: github.readIssue, commentIssue: github.commentIssue };
}
