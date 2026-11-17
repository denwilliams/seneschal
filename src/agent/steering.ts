import type { ImageContent } from "@earendil-works/pi-ai";

export interface SteeringInput {
  requestId: string;
  userId: string;
  messageTs: string;
  prepare(): Promise<{ text: string; images?: ImageContent[] }>;
}

type Delivery = { completion: Promise<{ text: string }> };
type Pending = { input: SteeringInput; accepted(value: boolean): void };

/** One Slack response owns these inputs, including those arriving during session startup.
 * Admission is serialized, waits are not: multiple messages can steer the same tool round.
 * Closing and the last emptiness check are synchronous, so a completion-boundary arrival
 * is either owned here or explicitly left for the chronology-preserving fallback.
 */
export class TurnSteering {
  private closed = false;
  private readonly known = new Map<string, Promise<boolean>>();
  private readonly pending: Pending[] = [];
  private submit?: (input: SteeringInput) => Promise<Delivery>;
  private admissions = Promise.resolve();
  private readonly completions: Promise<{ text: string } | { error: unknown }>[] = [];

  get isOpen(): boolean { return !this.closed; }

  offer(input: SteeringInput): Promise<boolean> {
    const known = this.known.get(input.requestId);
    if (known) return known;
    if (this.closed) return Promise.resolve(false);
    const accepted = new Promise<boolean>((resolve) => this.pending.push({ input, accepted: resolve }));
    this.known.set(input.requestId, accepted);
    this.pump();
    return accepted;
  }

  start(submit: (input: SteeringInput) => Promise<Delivery>): void {
    this.submit = submit;
    this.pump();
  }

  private pump(): void {
    if (!this.submit || this.closed) return;
    this.admissions = this.admissions.then(async () => {
      while (!this.closed && this.pending.length) {
        const item = this.pending.shift()!;
        try {
          const delivery = await this.submit!(item.input);
          this.completions.push(delivery.completion.catch((error: unknown) => ({ error })));
          item.accepted(true);
        } catch {
          // Admission/preparation failed: the ordinary queued path retains the original chronology.
          item.accepted(false);
        }
      }
    });
  }

  async finish(): Promise<string | undefined> {
    if (!this.submit) { this.close(); return; }
    for (;;) {
      const admissions = this.admissions;
      await admissions;
      const count = this.completions.length;
      const results = await Promise.all(this.completions);
      if (admissions !== this.admissions || count !== this.completions.length || this.pending.length) continue;
      this.close();
      const failed = results.find((result) => "error" in result);
      if (failed && "error" in failed) throw failed.error;
      const last = results.at(-1);
      return last && "text" in last ? last.text : undefined;
    }
  }

  /** Stop admission before aborting native work: an in-flight preparation/submit must
   * not admit a new request just after the abort or outlive the response watcher. */
  async cancel(abort: () => Promise<void>): Promise<void> {
    this.close();
    await this.admissions;
    await abort();
    await Promise.all(this.completions);
  }

  close(): void {
    this.closed = true;
    for (const item of this.pending.splice(0)) item.accepted(false);
  }
}

export function steeringText(userId: string, messageTs: string, text: string): string {
  return [
    "[Steering input received while the previous assistant turn was still active.",
    "This was NOT a reaction to its final response: the author had not yet seen that response.",
    "The runtime cannot change an in-flight model call; incorporate this at the next supported boundary.]",
    `Original Slack message timestamp: ${messageTs}; author: <@${userId}>`,
    "", text,
  ].join("\n");
}
