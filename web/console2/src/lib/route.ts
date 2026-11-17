export const TABS = ["session", "state", "tasks", "tools", "extend", "files"] as const;
export type TabName = (typeof TABS)[number];

export const VIEWS = ["transcript", "timeline", "factory"] as const;
export type ViewName = (typeof VIEWS)[number];

export interface Route {
  admin?: boolean;
  channelId?: string;
  threadKey?: string;
  tab: TabName;
  /** What the main pane shows for the selected channel. */
  view: ViewName;
  /** A workflow run open in the Tasks tab's detail sheet. */
  run?: string;
}

export const DEFAULT_TAB: TabName = "session";
export const DEFAULT_VIEW: ViewName = "transcript";

const isTab = (value: string | null): value is TabName => value !== null && (TABS as readonly string[]).includes(value);
/** Matches the server's run id check; anything else is not a run. */
const RUN_ID = /^[A-Za-z0-9._-]{1,100}$/;
const isView = (value: string | null): value is ViewName => value !== null && (VIEWS as readonly string[]).includes(value);

/** `#/c/<channel>/t/<thread>?tab=tasks&view=timeline`. Anything unparseable is the empty route, never an error. */
export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#/, "");
  if (raw === "/admin") return { admin: true, tab: DEFAULT_TAB, view: DEFAULT_VIEW };
  const [path = "", query = ""] = raw.split("?", 2);
  const params = new URLSearchParams(query);
  const tabParam = params.get("tab");
  const viewParam = params.get("view");
  const runParam = params.get("run");
  const run = runParam !== null && RUN_ID.test(runParam) ? runParam : undefined;
  const tab = isTab(tabParam) ? tabParam : DEFAULT_TAB;
  const view = isView(viewParam) ? viewParam : DEFAULT_VIEW;
  const parts = path.split("/").filter(Boolean);
  try {
    if (parts[0] === "c" && parts[1]) {
      const channelId = decodeURIComponent(parts[1]);
      if (parts[2] === "t" && parts[3]) return { channelId, threadKey: decodeURIComponent(parts[3]), tab, view, ...(run ? { run } : {}) };
      return { channelId, tab, view, ...(run ? { run } : {}) };
    }
  } catch { /* malformed escape */ }
  return { tab, view: DEFAULT_VIEW };
}

export function buildRoute(route: Route): string {
  if (route.admin) return "#/admin";
  let path = "#/";
  if (route.channelId) {
    path = `#/c/${encodeURIComponent(route.channelId)}`;
    if (route.threadKey) path += `/t/${encodeURIComponent(route.threadKey)}`;
  }
  const query: string[] = [];
  if (route.tab !== DEFAULT_TAB) query.push(`tab=${route.tab}`);
  if (route.channelId && route.view !== DEFAULT_VIEW) query.push(`view=${route.view}`);
  if (route.channelId && route.run) query.push(`run=${encodeURIComponent(route.run)}`);
  return query.length ? `${path}?${query.join("&")}` : path;
}
