import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import type { SharedPaths } from "../workspace/paths.ts";

/**
 * Account-wide notification batching.
 *
 * Channels stay isolated until they explicitly submit something here. The
 * submission is the boundary crossing: it copies the text into a shared inbox,
 * stamped with the source channel by the harness rather than by the model. A
 * single configured notification channel may collect pending submissions and
 * ask its agent to summarise them into one Slack post.
 */

export interface NotificationLimits {
  /** Maximum uncollected submissions kept in the inbox. */
  maxPending: number;
  /** Maximum characters accepted for one submission body. */
  maxMessageChars: number;
}

export interface NotificationSubmission {
  id: string;
  at: string;
  sourceChannelId: string;
  sourceChannelLabel: string;
  userId?: string;
  title?: string;
  message: string;
}

export interface NotificationSubmitRecord extends NotificationSubmission {
  type: "submit";
}

export interface NotificationCollectionRecord {
  type: "collected";
  at: string;
  id: string;
  notificationIds: string[];
  channelId: string;
  userId?: string;
}

export type NotificationRecord = NotificationSubmitRecord | NotificationCollectionRecord;

export interface SubmitNotificationInput {
  sourceChannelId: string;
  sourceChannelLabel: string;
  userId?: string;
  title?: string;
  message: string;
}

export interface CollectNotificationsInput {
  channelId: string;
  userId?: string;
  max?: number;
}

export class NotificationError extends Error {}

const MAX_TITLE_CHARS = 120;

function clean(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function clamp(text: string, max: number): string {
  const cleaned = clean(text);
  return cleaned.length > max ? `${cleaned.slice(0, max - 1).trimEnd()}…` : cleaned;
}

function isSubmitRecord(record: NotificationRecord): record is NotificationSubmitRecord {
  return record.type === "submit";
}

function isCollectionRecord(record: NotificationRecord): record is NotificationCollectionRecord {
  return record.type === "collected";
}

export class NotificationInbox {
  readonly logPath: string;

  constructor(shared: SharedPaths) {
    this.logPath = shared.notificationsLog;
  }

  records(): NotificationRecord[] {
    let raw: string;
    try {
      raw = readFileSync(this.logPath, "utf-8");
    } catch {
      return [];
    }

    const records: NotificationRecord[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as NotificationRecord;
        if (parsed?.type === "submit" || parsed?.type === "collected") records.push(parsed);
      } catch {
        // A partial final line should cost one entry, not the inbox.
      }
    }
    return records;
  }

  pending(): NotificationSubmission[] {
    const submitted: NotificationSubmitRecord[] = [];
    const collected = new Set<string>();

    for (const record of this.records()) {
      if (isSubmitRecord(record)) submitted.push(record);
      if (isCollectionRecord(record)) {
        for (const id of record.notificationIds) collected.add(id);
      }
    }

    return submitted
      .filter((record) => !collected.has(record.id))
      .sort((a, b) => a.at.localeCompare(b.at))
      .map(({ type: _type, ...submission }) => submission);
  }

  submit(input: SubmitNotificationInput, limits: NotificationLimits): NotificationSubmission {
    const message = clean(input.message);
    if (!message) throw new NotificationError("A notification submission needs a message.");
    if (message.length > limits.maxMessageChars) {
      throw new NotificationError(
        `That notification is ${message.length} characters; the limit is ${limits.maxMessageChars}. Summarise it first.`,
      );
    }
    if (this.pending().length >= limits.maxPending) {
      throw new NotificationError(
        `The notification inbox already has ${limits.maxPending} pending submissions. Ask the notification channel to collect them first.`,
      );
    }

    const now = new Date().toISOString();
    const record: NotificationSubmitRecord = {
      type: "submit",
      id: randomUUID().slice(0, 8),
      at: now,
      sourceChannelId: input.sourceChannelId,
      sourceChannelLabel: input.sourceChannelLabel,
      ...(input.userId ? { userId: input.userId } : {}),
      ...(input.title ? { title: clamp(input.title, MAX_TITLE_CHARS) } : {}),
      message,
    };

    this.append(record);
    const { type: _type, ...submission } = record;
    return submission;
  }

  collect(input: CollectNotificationsInput): NotificationSubmission[] {
    const max = Math.max(1, Math.floor(input.max ?? Number.MAX_SAFE_INTEGER));
    const items = this.pending().slice(0, max);
    if (items.length === 0) return [];

    this.append({
      type: "collected",
      id: randomUUID().slice(0, 8),
      at: new Date().toISOString(),
      notificationIds: items.map((item) => item.id),
      channelId: input.channelId,
      ...(input.userId ? { userId: input.userId } : {}),
    });
    return items;
  }

  private append(record: NotificationRecord): void {
    mkdirSync(dirname(this.logPath), { recursive: true });
    appendFileSync(this.logPath, `${JSON.stringify(record)}\n`, "utf-8");
  }
}

export function renderNotifications(items: NotificationSubmission[]): string {
  if (items.length === 0) return "No pending notifications.";

  return items
    .map((item) => {
      const who = item.userId ? ` from <@${item.userId}>` : "";
      const title = item.title ? ` — *${item.title}*` : "";
      return `- \`${item.id}\` ${item.sourceChannelLabel}${who}, ${item.at}${title}\n  ${item.message}`;
    })
    .join("\n");
}
