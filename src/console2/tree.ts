import { listChannels } from "./data.ts";
import type { ActivityState, TreeChannel, TreeNode, TreeResponse } from "./api-types.ts";
import { busyThreads, iso, nodeKind, type Console2Source, worst } from "./source.ts";
import { recentTimeline, TREE_TTL_MS } from "./timeline-cache.ts";

/** The most conversations listed per channel. Running and blocked ones are always listed. */
export const MAX_NODES = 150;
const ROUTES_TTL_MS = 2_000;
type Routes = Awaited<ReturnType<NonNullable<ReturnType<Console2Source["runtime"]>>["store"]["consoleRoutes"]>>;
const routesCache = new WeakMap<object, { at: number; routes: Promise<Routes> }>();

/** Listing threads takes one snapshot each, so share one listing between everyone polling the same store. */
function cachedRoutes(store: { consoleRoutes(): Promise<Routes> }, now: number): Promise<Routes> {
  const hit = routesCache.get(store);
  if (hit && now - hit.at < ROUTES_TTL_MS) return hit.routes;
  const routes = store.consoleRoutes();
  routesCache.set(store, { at: now, routes });
  routes.catch(() => routesCache.delete(store));
  return routes;
}

function label(threadKey: string): string {
  const kind = nodeKind(threadKey);
  if (kind === "main") return "main";
  if (kind === "thread") {
    // A Slack thread key is its root message timestamp: seconds since the epoch, then a sequence.
    const seconds = Number(threadKey.split(".")[0]);
    if (Number.isFinite(seconds) && seconds > 1e9 && seconds < 1e11) return new Date(seconds * 1000).toISOString().slice(0, 16).replace("T", " ");
  }
  return threadKey.replace(/^sub-/, "").slice(0, 24);
}

/** Channel-level state from its tasks, mapped onto the console's vocabulary. */
function channelState(state: "blocked" | "waiting" | "active" | "idle"): ActivityState {
  return state === "active" ? "running" : state;
}

/**
 * The workspace tree: every known channel, and for those whose durable store is open in this process, its trunk, threads,
 * scheduled and dream forks, and subagent runs (nested under the thread that started them when the timeline says so).
 * A closed store cannot be read from outside the process that owns it, so those channels list no nodes.
 */
export async function buildTree(source: Console2Source, now = Date.now()): Promise<TreeResponse> {
  const channels: TreeChannel[] = [];
  for (const item of listChannels(source)) {
    const runtime = item.linkable ? source.runtime(item.id) : undefined;
    let nodes: TreeNode[] = [];
    let hidden = 0;
    let stateRev: number | undefined;
    const jobVersion = runtime?.jobs?.version;
    let state = channelState(item.state);
    if (runtime) {
      try {
        stateRev = await runtime.store.stateRev();
      } catch { /* an unreadable state leaves the rest of the tree intact */ }
      try {
        const [routes, busy, blocked] = await Promise.all([cachedRoutes(runtime.store, now), busyThreads(runtime.store, now), runtime.store.blocked()]);
        const blockedKeys = new Set(blocked.map((entry) => entry.threadKey));
        const nodeState = (key: string): ActivityState => (blockedKeys.has(key) ? "blocked" : busy.has(key) ? "running" : "idle");
        const parentOfRun = new Map<string, string>();
        for (const event of recentTimeline(source.dataDir, item.id, item.isDm, 500, now, TREE_TTL_MS)) {
          if (event.kind === "run.start" && event.runKey && event.threadKey) parentOfRun.set(event.runKey, event.threadKey);
        }
        const byKey = new Map<string, TreeNode>();
        const sorted = [...routes].sort((a, b) => b.lastActivityAt - a.lastActivityAt);
        // Keep the newest, plus anything that needs attention however old. A run's parent must stay too, to nest it.
        const keep = new Set<string>(sorted.slice(0, MAX_NODES).map((route) => route.threadKey));
        for (const route of sorted) if (nodeState(route.threadKey) !== "idle") keep.add(route.threadKey);
        for (const [runKey, parent] of parentOfRun) if (keep.has(runKey)) keep.add(parent);
        hidden = sorted.filter((route) => !keep.has(route.threadKey)).length;
        for (const route of sorted.filter((entry) => keep.has(entry.threadKey))) {
          byKey.set(route.threadKey, {
            id: route.threadKey, kind: nodeKind(route.threadKey), label: label(route.threadKey), state: nodeState(route.threadKey),
            ...(iso(route.lastActivityAt) ? { lastActivity: iso(route.lastActivityAt)! } : {}),
            ...(route.forkedFromEntry > 0 ? { forkedFromEntry: route.forkedFromEntry } : {}),
          });
        }
        const top: TreeNode[] = [];
        for (const node of byKey.values()) {
          const parent = node.kind === "run" ? byKey.get(parentOfRun.get(node.id) ?? "") : undefined;
          if (parent) (parent.children ??= []).push(node);
          else top.push(node);
        }
        // A node is as busy as the busiest run anywhere under it: a blocked or running descendant must show on a collapsed
        // ancestor, and on the channel.
        const settle = (node: TreeNode): ActivityState => {
          if (node.children?.length) node.state = worst(node.state, ...node.children.map(settle));
          return node.state;
        };
        for (const node of top) settle(node);
        nodes = [{ id: "main", kind: "main", label: "main", state: nodeState("main") }, ...top];
        state = worst(state, ...nodes.map((node) => node.state));
      } catch {
        nodes = [];
      }
    }
    channels.push({
      id: item.id, ...(item.name ? { name: item.name } : {}), isDm: item.isDm, linkable: item.linkable, state,
      activeTasks: item.activeTasks, ...(item.lastActivity ? { lastActivity: item.lastActivity } : {}),
      live: runtime !== undefined, ...(item.factory ? { factory: item.factory } : {}), nodes, ...(hidden > 0 ? { hiddenNodes: hidden } : {}), ...(stateRev !== undefined ? { stateRev } : {}), ...(jobVersion !== undefined ? { jobVersion } : {}),
    });
  }
  return { generatedAt: new Date(now).toISOString(), harnessName: source.config().name, ...(source.actionsEnabled || source.listsWritable ? { actions: true as const } : {}), channels };
}
