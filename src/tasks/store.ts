import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const TASK_STATUSES = ["in_progress", "blocked", "waiting", "closed_successfully", "failed", "abandoned"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export type TaskKind = "agent" | "scheduled" | "research" | "code" | "file" | "review" | "delegated" | "other";

export interface TaskLink {
  url: string;
  label?: string;
}

export interface TaskRecord {
  id: string;
  channelId: string;
  channelName?: string;
  threadKey?: string;
  summary: string;
  kind: TaskKind;
  status: TaskStatus;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  detail?: string;
  /** Public references such as the PR, incident, dashboard, or source thread. */
  links?: TaskLink[];
}

interface TaskFile { version: 1; tasks: TaskRecord[] }
export interface TaskStoreOptions { maxHistory?: number }

/** Durable, deliberately boring task history shared by the web console task status and runtime. */
export class TaskStatusStore {
  readonly file: string;
  private readonly maxHistory: number;
  private tasks: TaskRecord[] = [];

  constructor(dataDir: string, options: TaskStoreOptions = {}) {
    this.file = join(dataDir, "shared", "tasks", "tasks.json");
    this.maxHistory = options.maxHistory ?? 2_000;
    this.load();
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as TaskFile;
      if (parsed.version === 1 && Array.isArray(parsed.tasks)) this.tasks = parsed.tasks.filter(isTaskRecord);
    } catch {
      // Web console task status must not stop the Slack bot because its optional history was hand-edited badly.
      this.tasks = [];
    }
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ version: 1, tasks: this.tasks }, null, 2) + "\n");
    renameSync(temporary, this.file);
  }

  start(input: Omit<TaskRecord, "id" | "status" | "startedAt" | "updatedAt"> & { id?: string }): TaskRecord {
    const now = new Date().toISOString();
    const { id, links, ...record } = input;
    const safeLinks = normaliseLinks(links ?? []);
    const task: TaskRecord = {
      ...record,
      summary: redactTaskUrls(record.summary),
      id: id ?? randomUUID(),
      status: "in_progress",
      startedAt: now,
      updatedAt: now,
      ...(safeLinks.length > 0 ? { links: safeLinks } : {}),
    };
    this.tasks.push(task);
    this.trim();
    this.save();
    return { ...task };
  }

  update(id: string, status: TaskStatus, detail?: string): TaskRecord | undefined {
    const task = this.tasks.find((candidate) => candidate.id === id);
    if (!task) return undefined;
    task.status = status;
    task.updatedAt = new Date().toISOString();
    if (detail !== undefined) task.detail = detail || undefined;
    if (isTerminal(status)) task.finishedAt = task.updatedAt;
    else delete task.finishedAt;
    this.save();
    return { ...task };
  }

  setThreadKey(id: string, threadKey: string): TaskRecord | undefined {
    const task = this.tasks.find((candidate) => candidate.id === id);
    if (!task) return undefined;
    task.threadKey = threadKey;
    task.updatedAt = new Date().toISOString();
    this.save();
    return { ...task, ...(task.links ? { links: [...task.links] } : {}) };
  }

  addLinks(id: string, links: readonly TaskLink[]): TaskRecord | undefined {
    const task = this.tasks.find((candidate) => candidate.id === id);
    if (!task) return undefined;
    const valid = normaliseLinks(links);
    if (valid.length === 0) return { ...task, ...(task.links ? { links: [...task.links] } : {}) };
    const byUrl = new Map((task.links ?? []).map((link) => [link.url, link]));
    for (const link of valid) byUrl.set(link.url, link);
    task.links = [...byUrl.values()];
    task.updatedAt = new Date().toISOString();
    this.save();
    return { ...task, links: [...task.links] };
  }

  get(id: string): TaskRecord | undefined {
    const task = this.tasks.find((candidate) => candidate.id === id);
    return task ? { ...task } : undefined;
  }

  all(): TaskRecord[] { return this.tasks.map((task) => ({ ...task })); }

  forChannel(channelId: string): TaskRecord[] {
    return this.tasks.filter((task) => task.channelId === channelId).map((task) => ({ ...task }));
  }

  /** Whether an ordinary reply should continue explicitly waiting work. */
  hasWaiting(channelId: string, threadKey: string | undefined): boolean {
    return Boolean(threadKey && this.tasks.some(
      (task) => task.channelId === channelId && task.threadKey === threadKey &&
        (task.status === "waiting" || task.status === "blocked"),
    ));
  }

  /** A follow-up in the same Slack thread resumes an explicit wait/block. */
  resume(channelId: string, threadKey: string | undefined): TaskRecord | undefined {
    if (!threadKey) return undefined;
    const task = this.tasks
      .filter((candidate) => candidate.channelId === channelId && candidate.threadKey === threadKey &&
        (candidate.status === "waiting" || candidate.status === "blocked"))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    if (!task) return undefined;
    return this.update(task.id, "in_progress");
  }

  /** Mark crashes/restarts visible instead of leaving a misleading forever-spinner. */
  abandonInProgress(detail = "Harness restarted before the task completed."): number {
    let count = 0;
    for (const task of this.tasks) {
      if (task.status !== "in_progress") continue;
      task.status = "abandoned";
      task.updatedAt = new Date().toISOString();
      task.finishedAt = task.updatedAt;
      task.detail = detail;
      count++;
    }
    if (count) this.save();
    return count;
  }

  private trim(): void {
    if (this.tasks.length <= this.maxHistory) return;
    const terminal = this.tasks.filter((task) => isTerminal(task.status));
    const active = this.tasks.filter((task) => !isTerminal(task.status));
    this.tasks = [...terminal.slice(-(this.maxHistory - active.length)), ...active]
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }
}

export function isTerminal(status: TaskStatus): boolean {
  return status === "closed_successfully" || status === "failed" || status === "abandoned";
}

function isTaskRecord(value: unknown): value is TaskRecord {
  if (!value || typeof value !== "object") return false;
  const task = value as Partial<TaskRecord>;
  return typeof task.id === "string" && typeof task.channelId === "string" && typeof task.summary === "string" &&
    typeof task.startedAt === "string" && typeof task.updatedAt === "string" && TASK_STATUSES.includes(task.status as TaskStatus);
}

/** One agent turn may create a task lazily once it proves it is substantive. */
export class TaskRunTracker {
  private task?: TaskRecord;
  private toolError?: string;
  private readonly store: TaskStatusStore;
  private readonly input: { channelId: string; channelName?: string; threadKey?: string; summary: string; kind?: TaskKind };
  constructor(
    store: TaskStatusStore,
    input: { channelId: string; channelName?: string; threadKey?: string; summary: string; kind?: TaskKind },
  ) {
    this.store = store;
    this.input = input;
  }

  start(kind = this.input.kind ?? "agent"): TaskRecord {
    if (!this.task) {
      this.task = this.store.resume(this.input.channelId, this.input.threadKey) ?? this.store.start({
        ...this.input,
        kind,
        ...(linksIn(this.input.summary).length > 0 ? { links: linksIn(this.input.summary) } : {}),
      });
    }
    return this.task;
  }

  onToolStart(name: string): void {
    const kind = substantiveToolKind(name);
    if (kind) this.start(kind);
  }

  onToolError(name: string, error?: string): void {
    if (!substantiveToolKind(name)) return;
    this.toolError = error ? `${name}: ${error}` : `${name} failed`;
  }

  setStatus(status: TaskStatus, detail?: string): TaskRecord {
    const task = this.start();
    this.task = this.store.update(task.id, status, detail) ?? task;
    return this.task;
  }

  finish(outcome: "completed" | "failed", detail?: string): void {
    // An explicit wait/block is the agent's durable outcome, not a successful
    // response merely because it managed to tell the user about the dependency.
    if (!this.task || this.task.status !== "in_progress") return;
    this.setStatus(outcome === "completed" ? "closed_successfully" : "failed", detail ?? this.toolError);
  }

  setThreadKey(threadKey: string): TaskRecord {
    const task = this.start();
    this.task = this.store.setThreadKey(task.id, threadKey) ?? task;
    return this.task;
  }

  addLinks(links: readonly TaskLink[]): TaskRecord {
    const task = this.start();
    this.task = this.store.addLinks(task.id, links) ?? task;
    return this.task;
  }

  current(): TaskRecord | undefined { return this.task ? { ...this.task } : undefined; }
}

const URL_IN_TEXT = /https?:\/\/[^\s<>]+/gi;

/** Remove credentials, queries, and fragments before task text is persisted. */
export function redactTaskUrls(text: string): string {
  return text.replace(URL_IN_TEXT, (raw) => {
    const safe = safeTaskUrl(raw.replace(/[.,;:!?]+$/, ""));
    return safe ?? "[private URL omitted]";
  });
}

export function linksIn(text: string): TaskLink[] {
  return normaliseLinks([...text.matchAll(URL_IN_TEXT)].map(([url]) => ({ url: url.replace(/[.,;:!?]+$/, "") })));
}

function safeTaskUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw.trim());
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return undefined;
    // Query strings commonly contain credentials; no query is needed to link a
    // PR or report, and discarding all of them avoids a fragile denylist.
    url.search = "";
    url.hash = "";
    return url.href;
  } catch { return undefined; }
}

export function normaliseLinks(links: readonly TaskLink[]): TaskLink[] {
  const seen = new Set<string>();
  const result: TaskLink[] = [];
  for (const link of links) {
    const url = safeTaskUrl(link.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const label = link.label?.trim() ? redactTaskUrls(link.label).slice(0, 200) : undefined;
    result.push({ url, ...(label ? { label } : {}) });
  }
  return result;
}

/** Conservative intent detector for work that is substantive before its first tool call (notably reviews). */
export function substantivePromptKind(prompt: string): TaskKind | undefined {
  const text = prompt.toLowerCase();
  if (/\b(review|code review|audit|test plan)\b/.test(text)) return "review";
  if (/\b(research|investigat|look up|compare sources|find out)\b/.test(text)) return "research";
  if (/\b(download|fetch (?:the |a )?(?:file|report|pdf)|upload|attach)\b/.test(text)) return "file";
  if (/\b(implement|build|fix|debug|deploy|refactor|code|pr\b|pull request)\b/.test(text)) return "code";
  return undefined;
}

export function substantiveToolKind(name: string): TaskKind | undefined {
  if (["bash", "exec", "write", "edit", "file_ops"].includes(name)) return "code";
  if (["search_web", "fetch_url", "download_url", "sqlite_query", "sqlite_schema"].includes(name)) return name === "download_url" ? "file" : "research";
  if (["upload_file", "add_document", "charts", "create_slide_deck", "images"].includes(name)) return "file";
  if (["transfer_to_channel", "delegate_task"].includes(name)) return "delegated";
  return undefined;
}
