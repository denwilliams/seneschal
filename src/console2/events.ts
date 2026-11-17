import { createHash } from "node:crypto";
import type { ServerResponse } from "node:http";
import { TurnEventAdapter, type TurnEvent } from "../agent/turn-events.ts";
import type { AgentEventStream } from "../agent/durable/events.ts";
import { findChannel } from "./data.ts";
import type { ConsoleEvent, ThreadLiveEvent } from "./api-types.ts";
import { type Console2Source } from "./source.ts";
import { buildTree } from "./tree.ts";

export interface EventHubOptions {
  /** How often the tree is re-read while someone is connected. */
  pollMs?: number;
  heartbeatMs?: number;
  /** Total simultaneous connections; one more is refused with 503. */
  maxClients?: number;
  /** A connection is closed after this long; EventSource reconnects on its own. */
  maxLifetimeMs?: number;
}

/** The part of a turn event the console draws, and nothing else. Message text is dropped for direct messages. */
export function liveEvent(event: TurnEvent, redacted: boolean): ThreadLiveEvent | undefined {
  switch (event.type) {
    case "assistant_message_start": return { kind: "message_start" };
    case "text_delta": return redacted ? undefined : { kind: "text_delta", delta: event.delta };
    case "assistant_message_end": return { kind: "message_end" };
    case "tool_start": return { kind: "tool_start", callId: event.callId, name: event.toolName };
    case "tool_end": return { kind: "tool_end", callId: event.callId, name: event.toolName, isError: event.isError };
    case "compaction_start": return { kind: "compaction" };
    case "retry": return { kind: "retry", attempt: event.attempt };
    default: return undefined;
  }
}

/** A client that stops reading is cut off once this much is queued for it; the browser reconnects and refetches. */
const MAX_QUEUED_BYTES = 1_000_000;

function frame(event: ConsoleEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/**
 * Server-sent events for the console. One timer re-reads the tree while anyone is connected and announces a change; a client
 * that names a thread also gets that thread's live activity. The hub never holds a store open: it attaches to the store's
 * event stream, and if the store retires (a configuration reload) the stream ends, the connection closes, and the browser
 * reconnects.
 */
export class EventHub {
  private readonly clients = new Set<{ res: ServerResponse; write: (chunk: string) => void; close: () => void }>();
  private timer?: NodeJS.Timeout;
  private signature = "";
  private readonly opts: Required<EventHubOptions>;
  private readonly source: () => Console2Source;

  constructor(source: () => Console2Source, opts: EventHubOptions = {}) {
    this.source = source;
    this.opts = { pollMs: opts.pollMs ?? 2_000, heartbeatMs: opts.heartbeatMs ?? 15_000, maxClients: opts.maxClients ?? 20, maxLifetimeMs: opts.maxLifetimeMs ?? 30 * 60_000 };
  }

  get size(): number { return this.clients.size; }

  /** Attach a response as an event stream. Returns false (after answering) when the hub is full. */
  async connect(res: ServerResponse, request: { channelId?: string; threadKey?: string }, onClose: (callback: () => void) => void): Promise<boolean> {
    if (this.clients.size >= this.opts.maxClients) {
      res.writeHead(503, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "retry-after": "5" });
      res.end("Too many console connections");
      return false;
    }
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store, no-transform", "x-content-type-options": "nosniff",
      connection: "keep-alive", "x-accel-buffering": "no",
    });
    res.write(`retry: 3000\n${frame({ type: "hello", at: new Date().toISOString() })}`);
    let closed = false;
    const write = (chunk: string) => {
      if (closed) return;
      if (res.writableLength > MAX_QUEUED_BYTES) { close(); return; }
      res.write(chunk);
    };
    let stream: AgentEventStream | undefined;
    const timers: NodeJS.Timeout[] = [];
    const client = { res, write, close: () => {} };
    const close = () => {
      if (closed) return;
      closed = true;
      for (const timer of timers) { clearTimeout(timer); clearInterval(timer); }
      this.clients.delete(client);
      void stream?.stop().catch(() => undefined);
      if (!res.writableEnded) res.end();
      if (this.clients.size === 0) this.stopTimer();
    };
    client.close = close;
    this.clients.add(client);
    onClose(close);
    res.on("error", close);
    timers.push(setInterval(() => write(": keep-alive\n\n"), this.opts.heartbeatMs).unref());
    timers.push(setTimeout(close, this.opts.maxLifetimeMs).unref());
    this.startTimer();

    if (request.channelId && request.threadKey) {
      const source = this.source();
      const channel = findChannel(source, request.channelId);
      const runtime = channel ? source.runtime(channel.id) : undefined;
      if (channel && runtime) {
        try {
          const attached = await runtime.store.consoleWatch(request.threadKey);
          if (attached && !closed) {
            stream = attached;
            const adapter = new TurnEventAdapter();
            const redacted = channel.isDm;
            const send = (event: ConsoleEvent) => write(frame(event));
            attached.start(async (events) => {
              for (const turn of adapter.feed(events)) {
                if (turn.type === "resync") { send({ type: "resync", at: new Date().toISOString(), channelId: channel.id, threadKey: request.threadKey! }); continue; }
                const live = liveEvent(turn, redacted);
                if (live) send({ type: "thread", at: new Date().toISOString(), channelId: channel.id, threadKey: request.threadKey!, event: live });
              }
            });
            void attached.closed.then(close, close);
          } else if (attached) void attached.stop().catch(() => undefined);
        } catch { /* no live activity for this thread; the tree feed still works */ }
      }
    }
    return true;
  }

  private startTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.poll(); }, this.opts.pollMs);
    this.timer.unref();
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.signature = "";
  }

  /** Re-read the tree and tell everyone if anything but the timestamp changed. Exposed for tests. */
  async poll(): Promise<void> {
    if (this.clients.size === 0) return;
    try {
      const { generatedAt: _ignored, ...rest } = await buildTree(this.source());
      const signature = createHash("sha1").update(JSON.stringify(rest)).digest("hex");
      const changed = this.signature !== "" && signature !== this.signature;
      this.signature = signature;
      if (!changed) return;
      const message = frame({ type: "tree", at: new Date().toISOString() });
      for (const client of [...this.clients]) client.write(message);
    } catch { /* a failed read is retried on the next tick */ }
  }

  closeAll(): void {
    for (const client of [...this.clients]) client.close();
    this.stopTimer();
  }
}
