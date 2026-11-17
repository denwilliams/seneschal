import { createHash } from "node:crypto";

/** Use Slack's immutable envelope event ID, not a delivery retry count or UUID. */
export function slackRequestId(teamId: string, eventId: string): string {
  if (!teamId || !eventId) throw new Error("Slack teamId and eventId are required");
  return `slack:v1:${JSON.stringify([teamId, eventId])}`;
}

export function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
