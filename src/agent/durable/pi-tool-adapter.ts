import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ConversationId, ToolExecutionResult, ToolRegistration } from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord";
import { enforceJail, type JailConfig } from "../jail.ts";

/**
 * The live, per-thread implementations behind a store-wide tool registration.
 *
 * Durable registers tools by name for a whole channel store, but this harness's tools are
 * closures over one thread: the speaker, the Slack thread to post into, the sandbox
 * container, the task tracker. A registration therefore carries only the schema; calling it
 * looks up the implementation bound to the calling conversation.
 */
export interface BoundThreadTools {
  readonly tools: ReadonlyMap<string, ToolDefinition>;
  /** Filesystem policy for the Pi-native file tools, enforced before they run. */
  readonly jail?: JailConfig;
  readonly onViolation?: (message: string) => void;
}

export interface ThreadToolResolver {
  /**
   * The tools bound to a conversation. After a restart nothing is bound until the host
   * rebuilds it, so this is also where a recovered task's identity and permissions are
   * restored (and where it can be refused).
   */
  resolve(conversationId: ConversationId): Promise<BoundThreadTools | undefined>;
}

function toJson(value: unknown): JsonValue | undefined {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
  } catch {
    return undefined;
  }
}

function errorResult(text: string): ToolExecutionResult {
  return { isError: true, output: [{ type: "text", text }] };
}

/** Adapt one Pi tool definition into a Durable registration that dispatches per conversation. */
export function adaptPiTool(definition: ToolDefinition, resolver: ThreadToolResolver): ToolRegistration {
  return {
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    // The store forces every tool to "unsafe" anyway: an interrupted effect is reported, never repeated.
    replay: "unsafe",
    ...(definition.prepareArguments ? { prepareArguments: definition.prepareArguments as (args: unknown) => never } : {}),
    async execute(args, api, context) {
      const bound = await resolver.resolve(api.conversationId);
      const implementation = bound?.tools.get(definition.name);
      if (!bound || !implementation) {
        return errorResult(`Tool ${definition.name} is not available in this conversation right now.`);
      }
      const input = { ...(args as Record<string, unknown>) };
      if (bound.jail) {
        const blocked = enforceJail(bound.jail, definition.name, input, bound.onViolation);
        if (blocked !== undefined) return errorResult(blocked);
      }
      // Progress callbacks are cumulative in Pi and append-only here, so they are not forwarded:
      // the final result content is authoritative.
      const result = await implementation.execute(api.callId, input as never, context.abortSignal, undefined, {} as never);
      const details = toJson(result.details);
      return {
        output: result.content,
        ...(result.isError ? { isError: true } : {}),
        ...(details !== undefined ? { details } : {}),
        ...(result.usage ? { usage: result.usage } : {}),
      };
    },
  };
}

export function adaptPiTools(definitions: readonly ToolDefinition[], resolver: ThreadToolResolver): ToolRegistration[] {
  return definitions.map((definition) => adaptPiTool(definition, resolver));
}

/**
 * Per-store table of conversation -> live tool set. A conversation with no live binding (the
 * process restarted, or the thread session was evicted mid-run) is rebuilt through `rebuild`,
 * which is where identity and permissions are restored; if it returns undefined the tool call
 * fails closed with an error result instead of running with ambient authority.
 */
export class ThreadToolBindings implements ThreadToolResolver {
  private readonly bound = new Map<ConversationId, BoundThreadTools>();
  private readonly recovered = new Set<ConversationId>();
  private readonly rebuild: ((conversationId: ConversationId) => Promise<BoundThreadTools | undefined>) | undefined;

  constructor(rebuild?: (conversationId: ConversationId) => Promise<BoundThreadTools | undefined>) {
    this.rebuild = rebuild;
  }

  /** `recovered`: bound for a turn resumed after a restart, which a live session must not silently replace. */
  bind(conversationId: ConversationId, tools: BoundThreadTools, options: { recovered?: boolean } = {}): void {
    this.bound.set(conversationId, tools);
    if (options.recovered) this.recovered.add(conversationId);
    else this.recovered.delete(conversationId);
  }

  isRecovered(conversationId: ConversationId): boolean {
    return this.recovered.has(conversationId);
  }

  unbind(conversationId: ConversationId, tools?: BoundThreadTools): void {
    // Only remove the binding the caller owns: a newer session may already have replaced it.
    if (tools === undefined || this.bound.get(conversationId) === tools) {
      this.bound.delete(conversationId);
      this.recovered.delete(conversationId);
    }
  }

  async resolve(conversationId: ConversationId): Promise<BoundThreadTools | undefined> {
    const existing = this.bound.get(conversationId);
    if (existing) return existing;
    const rebuilt = await this.rebuild?.(conversationId);
    if (rebuilt) this.bound.set(conversationId, rebuilt);
    return rebuilt;
  }

  has(conversationId: ConversationId): boolean {
    return this.bound.has(conversationId);
  }
}
