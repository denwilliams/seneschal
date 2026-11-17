import type {
  ActivityResponse, ActionResponse, ArtifactsResponse, ChannelResponse, FactoryResponse, TimelineResponse, ExtendResponse, MemoryResponse, SessionResponse, StateResponse, TasksResponse, ToolsResponse, TranscriptResponse, TreeResponse,
  ListsView, WorkflowActionName, WorkflowRunResponse, WorkflowsResponse, WorkspaceResponse, DatabaseResponse,
} from "@api/api-types";

/**
 * The API lives beside the page: the app is served at `<prefix>/console2/` and the API at `<prefix>/console2/api/v1/`.
 * Resolving against the page's own directory keeps it working under any reverse-proxy prefix.
 */
export function apiRoot(pageUrl: string = location.href): URL {
  return new URL("api/v1/", new URL(".", pageUrl));
}

export function apiUrl(path: string, query: Record<string, string | number | undefined> = {}, pageUrl?: string): string {
  const url = new URL(path.replace(/^\//, ""), apiRoot(pageUrl));
  for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, String(value));
  return url.toString();
}

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function getJson<T>(path: string, query: Record<string, string | number | undefined> = {}, signal?: AbortSignal): Promise<T> {
  const response = await fetch(apiUrl(path, query), { signal, headers: { accept: "application/json" }, cache: "no-store" });
  if (!response.ok) throw new ApiError(response.status, `${response.status} ${response.statusText || "request failed"}`);
  return (await response.json()) as T;
}

/**
 * A console action: a POST the server only answers when the operator turned `webConsole.actions` on. The custom header is what a
 * form on another site cannot send, so a stray page cannot make the browser act; the server's message is what the person is told.
 */
export async function postAction<T = ActionResponse>(path: string, body: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch(apiUrl(path), {
    method: "POST", cache: "no-store",
    headers: { accept: "application/json", "content-type": "application/json", "x-console-action": "1" },
    body: JSON.stringify(body),
  });
  let payload: { error?: unknown } | undefined;
  try { payload = (await response.json()) as { error?: unknown }; } catch { /* no body */ }
  if (!response.ok) throw new ApiError(response.status, typeof payload?.error === "string" ? payload.error : `${response.status} ${response.statusText || "request failed"}`);
  return payload as unknown as T;
}

async function getBrowserJson<T>(path: string, query: Record<string, string | number | undefined>, signal?: AbortSignal): Promise<T> {
  const response = await fetch(apiUrl(path, query), { signal, cache: "no-store", headers: { accept: "application/json" } });
  const payload = await response.json();
  if (!response.ok) throw new ApiError(response.status, typeof payload.error === "string" ? payload.error : "Workspace request failed.");
  return payload as T;
}

const enc = encodeURIComponent;

export const api = {
  activity: (options: { cursor?: string; since?: string } = {}, signal?: AbortSignal) => getJson<ActivityResponse>("activity", { ...options, limit: 50 }, signal),
  identity: (signal?: AbortSignal) => getJson<{ identity: { subject: string; email?: string } | null }>("identity", {}, signal),
  tree: (signal?: AbortSignal) => getJson<TreeResponse>("tree", {}, signal),
  channel: (id: string, signal?: AbortSignal) => getJson<ChannelResponse>(`channels/${enc(id)}`, {}, signal),
  session: (id: string, thread: string | undefined, signal?: AbortSignal) => getJson<SessionResponse>(`channels/${enc(id)}/session`, { thread }, signal),
  transcript: (id: string, thread: string, before?: number, signal?: AbortSignal) =>
    getJson<TranscriptResponse>(`channels/${enc(id)}/threads/${enc(thread)}`, { before, limit: 60 }, signal),
  tasks: (id: string, signal?: AbortSignal) => getJson<TasksResponse>(`channels/${enc(id)}/tasks`, {}, signal),
  tools: (id: string, thread: string | undefined, signal?: AbortSignal) => getJson<ToolsResponse>(`channels/${enc(id)}/tools`, { thread }, signal),
  extend: (id: string, signal?: AbortSignal) => getJson<ExtendResponse>(`channels/${enc(id)}/extend`, {}, signal),
  memory: (id: string, signal?: AbortSignal) => getJson<MemoryResponse>(`channels/${enc(id)}/memory`, {}, signal),
  lists: (id: string, list?: string, offset = 0, signal?: AbortSignal) => getBrowserJson<ListsView & { writable: boolean }>(`channels/${enc(id)}/lists`, { list, offset }, signal),
  updateList: (id: string, body: Record<string, unknown>) => postAction<{ ok: true; id?: number }>(`channels/${enc(id)}/lists`, body),
  state: (id: string, signal?: AbortSignal) => getJson<StateResponse>(`channels/${enc(id)}/state`, {}, signal),
  artifacts: (id: string, signal?: AbortSignal) => getJson<ArtifactsResponse>(`channels/${enc(id)}/artifacts`, {}, signal),
  workspace: (id: string, path: string, offset: number, signal?: AbortSignal) => getBrowserJson<WorkspaceResponse>(`channels/${enc(id)}/workspace`, { path, offset }, signal),
  database: (id: string, path: string, table: string | undefined, offset: number, tableOffset: number, signal?: AbortSignal) => getBrowserJson<DatabaseResponse>(`channels/${enc(id)}/database`, { path, table, offset, tableOffset }, signal),
  timeline: (id: string, options: { hideTools?: boolean; actor?: string }, signal?: AbortSignal) =>
    getJson<TimelineResponse>(`channels/${enc(id)}/timeline`, { tools: options.hideTools ? 0 : undefined, actor: options.actor || undefined }, signal),
  workflows: (id: string, signal?: AbortSignal) => getJson<WorkflowsResponse>(`channels/${enc(id)}/workflows`, {}, signal),
  workflowRun: (id: string, runId: string, signal?: AbortSignal) => getJson<WorkflowRunResponse>(`channels/${enc(id)}/workflows/${enc(runId)}`, {}, signal),
  runAction: (id: string, runId: string, action: WorkflowActionName, body: Record<string, unknown> = {}) =>
    postAction(`channels/${enc(id)}/workflows/${enc(runId)}/actions/${action}`, body),
  taskAction: (id: string, runId: string, action: "stop" | "bump", revision: number) =>
    postAction(`channels/${enc(id)}/workflows/${enc(runId)}/actions/${action}`, { revision }),
  factoryAction: (id: string, action: "start" | "poll", body: Record<string, unknown> = {}) => postAction(`channels/${enc(id)}/factory/${action}`, body),
  factory: (id: string, refresh = false, signal?: AbortSignal) =>
    getJson<FactoryResponse>(`channels/${enc(id)}/factory`, { refresh: refresh ? 1 : undefined }, signal),
};

/** The live stream. A thread may be named so the server sends that thread's activity too. */
export function eventsUrl(channelId?: string, threadKey?: string, pageUrl?: string): string {
  return apiUrl("events", { channel: channelId, thread: channelId ? threadKey : undefined }, pageUrl);
}
