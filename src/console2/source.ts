import type { ScopedSecretAdmin } from "../config/scoped-secrets.ts";
import type { SecretAdmin } from "../config/managed-env.ts";
import type { OperatorConfig } from "../config/operator.ts";
import type { ChannelRuntime } from "../agent/channel-runtime.ts";
import type { ConsoleMergeApprovals, ConsoleMergeIdentity } from "../factory/workflow/console-approvals.ts";
import type { FactoryRunService } from "../factory/workflow/service.ts";
import type { ScheduleStore } from "../agent/schedules.ts";
import type { UsageLog } from "../agent/usage.ts";
import type { ConsoleSource } from "./data.ts";
import type { ChannelRecord } from "../workspace/registry.ts";
import type { ActivityState, NodeKind } from "./api-types.ts";

/**
 * What the console may do to a software factory run, when the operator turned `webConsole.actions` on. The services are the same
 * ones the agent's tools use. Merge decisions additionally require run-scoped, verified Slack identity.
 */
export interface Console2Actions {
  /** Request an inspection, never an automatic step retry, in the owning task conversation. */
  inspectTaskWorkflow?: (channelId: string, workflow: import("../tasks/workflow.ts").TaskWorkflow) => Promise<void>;
  /** The channel's workflow service for a request that came from `remote`. Undefined when the channel is not a software factory. */
  service(channelId: string, remote: string, identity?: ConsoleMergeIdentity): FactoryRunService | undefined;
  /** Verifies a browser with a Slack approver without treating console access as Slack identity. */
  mergeApprovals?: ConsoleMergeApprovals;
  /** Ask the channel's issue intake to poll now. False when intake is not on for the channel. */
  pollNow(channelId: string): boolean;
  /** One line in the channel's factory audit file. Never throws. */
  audit(channelId: string, event: string, fields: Record<string, unknown>): void;
}

/**
 * Everything webConsole2 reads. It extends the original console's source with the pieces the new one needs: the durable
 * stores that are already open in this process (never opened for the console), schedules, usage and model windows.
 */
export interface Console2Source extends ConsoleSource {
  /** Full operator administration, separate from the Slack-agent policy and factory action switch. */
  admin?: OperatorConfig;
  /** Write-only environment administration and opt-in supervised restart, same external Admin boundary. */
  secrets?: SecretAdmin;
  /** Backend-neutral scoped, write-only secret administration. */
  scopedSecrets?: ScopedSecretAdmin;
  /** The channel's durable runtime only if its store is already open. The console never opens a store. */
  runtime: (channelId: string) => ChannelRuntime | undefined;
  schedules: ScheduleStore;
  usage: UsageLog;
  /** Context window of a `provider/model` ref, when the catalog knows it. */
  contextWindow: (model: string) => number | undefined;
  /** How the console acts on factory runs. Present when the process can; it is used only when `actionsEnabled`. */
  actions?: Console2Actions;
  /** Set by the web server from `webConsole.actions`, and only with `actions` present: the operator allowed the console to act. */
  actionsEnabled?: boolean;
  /** List editing uses webConsole.actions independently of factory services. */
  listsWritable?: boolean;
}

export const SUBAGENT_KEY_PREFIX = "sub-";

/** What kind of conversation a thread key names. */
export function nodeKind(threadKey: string): NodeKind {
  if (threadKey === "main") return "main";
  if (threadKey.startsWith(SUBAGENT_KEY_PREFIX)) return "run";
  if (threadKey.startsWith("scheduled-")) return "scheduled";
  if (threadKey === "dream" || threadKey.startsWith("dream-")) return "dream";
  return "thread";
}

/** A direct message channel: its content is never shown. */
export function isDirect(channel: Pick<ChannelRecord, "isDm">): boolean {
  return channel.isDm;
}

export function stateRank(state: ActivityState): number {
  return state === "blocked" ? 3 : state === "running" ? 2 : state === "waiting" ? 1 : 0;
}

/** The busiest of several states: blocked > running > waiting > idle. */
export function worst(...states: ActivityState[]): ActivityState {
  return states.reduce<ActivityState>((a, b) => (stateRank(b) > stateRank(a) ? b : a), "idle");
}

export function iso(ms: number | undefined): string | undefined {
  return ms && Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : undefined;
}

const BUSY_TTL_MS = 1_000;
const busyCache = new WeakMap<object, { at: number; busy: Promise<Set<string>> }>();

/**
 * Which threads have unfinished work, shared for a second between everyone asking of the same store. Listing live routes
 * inspects the whole harness, and the tree, transcript and event poll all want it.
 */
export function busyThreads(store: { consoleBusyThreads(): Promise<Set<string>> }, now = Date.now()): Promise<Set<string>> {
  const hit = busyCache.get(store);
  if (hit && now - hit.at < BUSY_TTL_MS) return hit.busy;
  const busy = store.consoleBusyThreads();
  busyCache.set(store, { at: now, busy });
  busy.catch(() => busyCache.delete(store));
  return busy;
}
