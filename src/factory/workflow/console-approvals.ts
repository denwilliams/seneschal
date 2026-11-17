import { randomBytes } from "node:crypto";
import type { FactoryRunData } from "./docs.ts";
import { FactoryRunError } from "./service.ts";

export const CONSOLE_MERGE_VERIFY_ACTION = "harness_console_merge_verify";
export const MERGE_VERIFICATION_MS = 10 * 60_000;
export interface ConsoleMergeIdentity { userId: string; runId: string; head: string; since: number }
export type MergeVerification = { state: "unavailable" | "unverified" | "pending" | "verified"; challenge?: string };
interface Session {
  browser: string; id: string; channelId: string; runId: string; head: string; since: number;
  challenge: string; expires: number; userId: string;
}
interface Deps {
  run(channelId: string, runId: string): Promise<FactoryRunData | undefined>;
  allowed(channelId: string, run: FactoryRunData, userId: string): boolean;
  post(input: { id: string; challenge: string; channelId: string; run: FactoryRunData }): Promise<void>;
  now?: () => number;
}

/** Short-lived, run/wait/commit-bound proof of Slack identity. Neither proxy headers nor browser-supplied user ids are trusted. */
export class ConsoleMergeApprovals {
  private sessions = new Map<string, Session>();
  private readonly deps: Deps;
  constructor(deps: Deps) { this.deps = deps; }
  private now(): number { return this.deps.now?.() ?? Date.now(); }
  private prune(): void {
    for (const [key, value] of this.sessions) if (value.expires <= this.now()) this.sessions.delete(key);
  }
  private async current(session: Session): Promise<FactoryRunData | undefined> {
    const run = await this.deps.run(session.channelId, session.runId);
    return run?.status === "waiting" && run.wait.kind === "merge" && run.wait.since === session.since && run.pr.reviewedHead === session.head ? run : undefined;
  }
  async request(channelId: string, runId: string): Promise<{ browser: string; challenge: string }> {
    this.prune();
    if (this.sessions.size >= 200) throw new FactoryRunError("Too many browser verifications are pending. Try again later.");
    const run = await this.deps.run(channelId, runId);
    if (!run || run.status !== "waiting" || run.wait.kind !== "merge" || !run.pr.reviewedHead) throw new FactoryRunError("This run is not waiting for merge approval of a reviewed commit.");
    const session: Session = {
      browser: randomBytes(32).toString("base64url"), id: randomBytes(32).toString("base64url"), channelId, runId,
      head: run.pr.reviewedHead, since: run.wait.since, challenge: randomBytes(6).toString("hex"), expires: this.now() + MERGE_VERIFICATION_MS, userId: "",
    };
    this.sessions.set(session.browser, session);
    try { await this.deps.post({ id: session.id, challenge: session.challenge, channelId, run }); }
    catch { this.sessions.delete(session.browser); throw new FactoryRunError("Slack verification could not be delivered. Use the run's existing Slack approval buttons or try again."); }
    return { browser: session.browser, challenge: session.challenge };
  }
  async confirm(id: string, userId: string, channelId: string): Promise<boolean> {
    this.prune();
    const session = [...this.sessions.values()].find((value) => value.id === id && value.channelId === channelId);
    if (!session || session.userId || !userId) return false;
    const run = await this.current(session);
    if (!run || !this.deps.allowed(channelId, run, userId)) return false;
    // One winner even if two Slack callbacks overlapped while reading the run.
    if (session.userId || session.expires <= this.now()) return false;
    session.userId = userId;
    return true;
  }
  async status(browser: string, channelId: string, runId: string): Promise<{ view: MergeVerification; identity?: ConsoleMergeIdentity }> {
    this.prune();
    const session = this.sessions.get(browser);
    if (!session || session.channelId !== channelId || session.runId !== runId) return { view: { state: "unverified" } };
    const run = await this.current(session);
    if (!run || session.expires <= this.now() || (session.userId && !this.deps.allowed(channelId, run, session.userId))) {
      this.sessions.delete(browser);
      return { view: { state: "unverified" } };
    }
    return session.userId ? {
      view: { state: "verified" }, identity: { userId: session.userId, runId, head: session.head, since: session.since },
    } : { view: { state: "pending", challenge: session.challenge } };
  }
}
