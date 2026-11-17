/**
 * pi can resolve prompt() normally after a provider failure. The failure is a
 * terminal assistant message, not necessarily a rejected promise. Inspect the
 * last assistant message from this turn only, after prompt settles: a retry
 * that succeeds must replace an earlier error.
 */
export class AgentTurnOutcome {
  private last?: { stopReason?: string; errorMessage?: string };

  observe(message: { role: string; stopReason?: string; errorMessage?: string }): void {
    if (message.role === "assistant") this.last = message;
  }

  assertCompleted(): void {
    if (this.last?.stopReason === "error") {
      throw new Error(this.last.errorMessage || "Model provider returned an error without details.");
    }
    if (this.last?.stopReason === "aborted") {
      throw new Error(this.last.errorMessage || "Model response was aborted.");
    }
  }
}
