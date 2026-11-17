/**
 * Where a factory's issues come from, behind one small interface so a tracker other than GitHub can slot in later (Jira, Linear).
 * Everything intake knows about an issue is this normalised shape; nothing above this file speaks GitHub's JSON.
 */

export type WorkItem = { tracker: "jira"; site: string; id: number; key: string; url: string };

export type SourceIssue = {
  workItem?: WorkItem;
  /** Mandatory tracker selection gate, independent of release/trust. */
  selection?: { eligible: boolean; reason: string; ambiguous?: boolean };
  repo: string;
  number: number;
  title: string;
  body: string;
  url: string;
  author: string;
  /** GitHub's `author_association` for the author (OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR, NONE, ...). */
  association: string;
  state: "open" | "closed";
  locked: boolean;
  /** The issues API returns pull requests too; they are never worked as issues. */
  isPullRequest: boolean;
  labels: string[];
  createdAt: number;
  updatedAt: number;
  /** How many comments it has. */
  comments: number;
};

export type SourceComment = {
  author: string;
  association: string;
  body: string;
  createdAt: number;
  updatedAt: number;
};

export interface IssueSource {
  /** Jira has explicit account trust; neither possession of a token nor label editing grants trust. */
  explicitTrust?: boolean;
  /** The login the harness acts as: its own comments are not updates, and its own filings are recognised by it. */
  selfLogin(): Promise<string>;
  /**
   * Issues of `repo` changed since `since` (open or closed), oldest change first, one page. `full` is true when the page is full,
   * so there may be more: the caller asks for the next page.
   */
  changedSince(repo: string, since: number, page: number): Promise<{ issues: SourceIssue[]; full: boolean }>;
  /** One issue, or undefined when it is gone (deleted, or moved out of the repository). */
  issue(repo: string, number: number): Promise<SourceIssue | undefined>;
  /** Comments of an issue created or edited since `since`, oldest first. */
  comments(repo: string, number: number, since: number): Promise<SourceComment[]>;
}

/** People who may add to an issue's work: its repository's owner, members and collaborators. Anyone else's words are information at most. */
export const TRUSTED_ASSOCIATIONS: readonly string[] = ["OWNER", "MEMBER", "COLLABORATOR"];
export const isTrustedAssociation = (association: string): boolean => TRUSTED_ASSOCIATIONS.includes(association.toUpperCase());
