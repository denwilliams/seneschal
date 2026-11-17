import { logger } from "../../util/log.ts";
import type { IntakeOutcome } from "./intake.ts";

/**
 * The clock behind issue intake: one poll loop per factory channel that has intake on, in this process. It follows the lifecycle
 * of the other background loops: started at boot, reconciled when the configuration is reloaded (a channel gaining intake starts
 * a loop, losing it stops one, a new interval re-times it), stopped on shutdown, nothing left running.
 *
 * A poll for a channel never overlaps another for it; a request that arrives while one runs (a Slack conversation filed an issue)
 * runs one more poll straight after. A failed poll backs the channel off, doubling up to half an hour, so a rate limit or a missing
 * credential is not hammered. Nothing here throws into the app.
 */

/** What the loop needs to know about a channel that has intake on. */
export interface IntakeTarget {
  channelId: string;
  intervalSeconds: number;
}

export interface IntakeLoopDeps {
  /** The channels that should be polled now. Called on `reconcile`. */
  targets(): Promise<IntakeTarget[]> | IntakeTarget[];
  /** One poll of one channel. */
  poll(channelId: string): Promise<IntakeOutcome | undefined>;
  /** A timer, replaceable so a test can drive time. Returns how to cancel it. */
  schedule?: (fn: () => void, ms: number) => () => void;
  /** 0 to 1: the jitter. Replaceable so a test is exact. */
  random?: () => number;
}

interface Loop {
  target: IntakeTarget;
  cancel?: () => void;
  running?: Promise<void>;
  again: boolean;
  failures: number;
}

const MAX_BACKOFF_MS = 30 * 60_000;
/** The first poll after boot or after a loop starts: soon, but after the stores have opened. */
const FIRST_POLL_MS = 15_000;

export class IntakeLoop {
  private readonly deps: IntakeLoopDeps;
  private readonly loops = new Map<string, Loop>();
  private readonly schedule: (fn: () => void, ms: number) => () => void;
  private readonly random: () => number;
  private stopped = false;

  constructor(deps: IntakeLoopDeps) {
    this.deps = deps;
    this.random = deps.random ?? Math.random;
    this.schedule = deps.schedule ?? ((fn, ms) => { const timer = setTimeout(fn, ms); timer.unref?.(); return () => clearTimeout(timer); });
  }

  /** The channels with a live loop. */
  channels(): string[] { return [...this.loops.keys()]; }

  /** Make the loops match the configuration now: start the new, stop the gone, re-time a changed interval. */
  async reconcile(): Promise<void> {
    if (this.stopped) return;
    let targets: IntakeTarget[];
    try {
      targets = await this.deps.targets();
    } catch (error) {
      logger.warn(`factory intake: could not work out which channels to poll: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const wanted = new Map(targets.map((target) => [target.channelId, target]));
    for (const [channelId, loop] of this.loops) {
      if (wanted.has(channelId)) continue;
      loop.cancel?.();
      this.loops.delete(channelId);
    }
    for (const target of wanted.values()) {
      const existing = this.loops.get(target.channelId);
      if (!existing) {
        const loop: Loop = { target, again: false, failures: 0 };
        this.loops.set(target.channelId, loop);
        this.arm(loop, FIRST_POLL_MS);
      } else if (existing.target.intervalSeconds !== target.intervalSeconds) {
        existing.target = target;
        if (!existing.running) this.arm(existing, this.interval(existing));
      } else {
        existing.target = target;
      }
    }
  }

  private interval(loop: Loop): number {
    const base = loop.target.intervalSeconds * 1000;
    const backoff = loop.failures > 0 ? Math.min(MAX_BACKOFF_MS, base * 2 ** Math.min(loop.failures, 6)) : base;
    // ±10%, so channels do not all hit GitHub in the same second.
    return Math.round(backoff * (0.9 + 0.2 * this.random()));
  }

  private arm(loop: Loop, ms: number): void {
    loop.cancel?.();
    loop.cancel = this.schedule(() => { loop.cancel = undefined; void this.run(loop); }, ms);
  }

  private async run(loop: Loop): Promise<void> {
    if (this.stopped || this.loops.get(loop.target.channelId) !== loop) return;
    if (loop.running) { loop.again = true; return; }
    loop.running = (async () => {
      try {
        const outcome = await this.deps.poll(loop.target.channelId);
        loop.failures = outcome?.failed ? loop.failures + 1 : 0;
      } catch (error) {
        loop.failures++;
        logger.warn(`factory intake: poll of ${loop.target.channelId} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    })();
    try { await loop.running; } finally { loop.running = undefined; }
    if (this.stopped || this.loops.get(loop.target.channelId) !== loop) return;
    if (loop.again) { loop.again = false; this.arm(loop, 0); return; }
    this.arm(loop, this.interval(loop));
  }

  /** Poll a channel now (a conversation filed an issue). Overlap-safe. A channel with no loop is ignored. */
  pollNow(channelId: string): void {
    const loop = this.loops.get(channelId);
    if (this.stopped || !loop) return;
    if (loop.running) { loop.again = true; return; }
    this.arm(loop, 0);
  }

  /** For a test and for shutdown: wait for the polls in flight. */
  async idle(): Promise<void> {
    for (const loop of this.loops.values()) await loop.running;
  }

  stop(): void {
    this.stopped = true;
    for (const loop of this.loops.values()) loop.cancel?.();
    this.loops.clear();
  }
}
