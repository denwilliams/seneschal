import { LogLevel, WebClient } from "@slack/web-api";
import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ResolvedChannel } from "../workspace/resolve.ts";
import { userTokensFor } from "./slack-user-tokens.ts";
import { readSlackProfilePhoto } from "./slack-profile-photo.ts";

interface SlackResponse { ok?: boolean; error?: string }
export interface SlackProfileClient {
  authTest(): Promise<SlackResponse & { user_id?: string; team_id?: string; bot_id?: string }>;
  setStatus(profile: { status_text: string; status_emoji: string; status_expiration: number }): Promise<SlackResponse>;
  setPhoto(image: Buffer): Promise<SlackResponse>;
}
export interface SlackProfileToolsContext {
  channel: Pick<ResolvedChannel, "slackProfile" | "paths" | "shared" | "env">;
  clientFactory?: (token: string) => SlackProfileClient;
}

// Do not pass SDK errors, responses or logs through: they can carry request bodies and credentials.
const SAFE_ERRORS: Record<string, string> = {
  missing_scope: "The authorized Slack user token needs the users.profile:write USER scope. Reauthorize it after adding the scope.",
  not_allowed_token_type: "Use an explicitly authorized Slack USER token, not the bot credential.",
  invalid_auth: "The Slack user credential is invalid. Ask an operator to reauthorize it.",
  not_authed: "Slack user authorization is missing. Ask an operator to authorize it.",
  token_revoked: "The Slack user credential was revoked. Ask an operator to reauthorize it.",
  token_expired: "The Slack user credential expired. Ask an operator to reauthorize it.",
  account_inactive: "The authorized Slack user account is inactive.",
  no_permission: "Slack denied this profile change. Check the user's permissions and workspace policy.",
  restricted_action: "Workspace policy prevents this profile change.",
  invalid_profile: "Slack rejected the status values. Check text, emoji and expiration.",
  invalid_arguments: "Slack rejected the profile values. Check the status or image requirements.",
  invalid_emoji: "Slack rejected the emoji. Use an existing Slack :emoji_name:.",
  invalid_expiration: "Slack rejected the expiration. Use 0 or a future Unix timestamp in seconds.",
  bad_image: "Slack could not process the photo. Use a valid PNG/JPEG with each side between 512 and 1024 pixels.",
  invalid_image: "Slack rejected the photo. Use a valid PNG/JPEG; Slack requires dimensions between 512×512 and 1024×1024 pixels.",
  image_too_large: "Slack rejected the photo as too large. Use a smaller PNG/JPEG.",
  ratelimited: "Slack rate-limited profile updates. Wait before trying again.",
};

function safeFailure(error: unknown): Error {
  const err = error as { data?: { error?: unknown }; error?: unknown; code?: unknown } | undefined;
  const code = err?.data?.error ?? err?.error ?? (err?.code === "slack_webapi_rate_limited_error" ? "ratelimited" : undefined);
  return new Error(`Slack profile update failed: ${typeof code === "string" && Object.hasOwn(SAFE_ERRORS, code) ? SAFE_ERRORS[code] : "Slack API or network error. Check authorization, workspace policy and Slack availability; the change was not confirmed. Do not blindly retry."}`);
}

function makeClient(token: string): SlackProfileClient {
  const noop = () => {};
  const web = new WebClient(token, {
    retryConfig: { retries: 0 }, rejectRateLimitedCalls: true, timeout: 30_000,
    logger: { debug: noop, info: noop, warn: noop, error: noop, setName: noop, setLevel: noop, getLevel: () => LogLevel.ERROR },
  });
  return {
    authTest: () => web.auth.test(),
    // Never include `user`: Slack writes only the authenticated person's own profile.
    setStatus: (profile) => web.users.profile.set({ profile }),
    setPhoto: (image) => web.users.setPhoto({ image }),
  };
}

function onlyKeys(params: unknown, allowed: string[]): void {
  if (!params || typeof params !== "object" || Array.isArray(params) || Object.keys(params).some((key) => !allowed.includes(key))) {
    throw new Error("Only the documented status/photo arguments are accepted; credentials, target users and other profile fields are not allowed.");
  }
}
const result = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

export function createSlackProfileTools(ctx: SlackProfileToolsContext): ToolDefinition[] {
  const identity = ctx.channel.slackProfile;
  if (!identity) return [];

  async function authorized(): Promise<SlackProfileClient> {
    let token: string | undefined;
    try { token = userTokensFor(ctx.channel).tokenFor(identity!.user); }
    catch { throw new Error("Could not read Slack user authorization. Ask an operator to check the user-token store."); }
    if (!token) throw new Error("No Slack user authorization is stored for this channel's configured profile user. Ask an operator to provision their users.profile:write user token.");
    let client: SlackProfileClient;
    let auth: Awaited<ReturnType<SlackProfileClient["authTest"]>>;
    try {
      client = (ctx.clientFactory ?? makeClient)(token);
      auth = await client.authTest();
      if (auth.ok !== true) throw auth;
    } catch (err) { throw safeFailure(err); }
    if (auth.bot_id || auth.user_id !== identity!.user || auth.team_id !== identity!.team) {
      throw new Error("Slack authorization identity mismatch: the credential must belong to the configured user and workspace and must not be a bot. No profile change was made.");
    }
    return client;
  }
  async function update(action: (client: SlackProfileClient) => Promise<SlackResponse>): Promise<void> {
    const client = await authorized(); // Revalidate on each operation, including token rotation and scheduled turns.
    try {
      const response = await action(client);
      if (response.ok !== true) throw response;
    } catch (err) { throw safeFailure(err); }
  }

  return [
    defineTool({
      name: "set_slack_status", label: "Set authorized user's Slack status",
      description: "Set only the configured user's Slack status under their instructions. Visible to others: avoid private calendar/email details. No arbitrary target user or other profile fields. Omitted expiration means no expiration; use clear_slack_status to clear.",
      parameters: Type.Object({
        text: Type.String({ maxLength: 100, description: "Public status text, up to 100 characters." }),
        emoji: Type.String({ maxLength: 100, description: "Slack :emoji_name: or an empty string for no emoji." }),
        expiration: Type.Optional(Type.Integer({ minimum: 0, description: "Future Unix timestamp in seconds, or 0 for no expiration. Omitted means 0." })),
      }, { additionalProperties: false }),
      execute: async (_id, params: { text: string; emoji: string; expiration?: number }) => {
        onlyKeys(params, ["text", "emoji", "expiration"]);
        if (typeof params.text !== "string" || [...params.text].length > 100 || /[\u0000-\u001f\u007f]/.test(params.text)) throw new Error("Status text must be at most 100 characters with no control characters.");
        if (typeof params.emoji !== "string" || params.emoji.length > 100 || (params.emoji !== "" && !/^:[a-zA-Z0-9_+\-]+:$/.test(params.emoji))) throw new Error("Status emoji must be an existing Slack :emoji_name: or an empty string.");
        const expiration = params.expiration === undefined ? 0 : params.expiration;
        if (!Number.isSafeInteger(expiration) || (expiration !== 0 && expiration <= Math.floor(Date.now() / 1000))) throw new Error("Status expiration must be 0 or a future Unix timestamp in seconds.");
        await update((client) => client.setStatus({ status_text: params.text, status_emoji: params.emoji, status_expiration: expiration }));
        return result("Slack status updated for the configured user.");
      },
    }),
    defineTool({
      name: "clear_slack_status", label: "Clear authorized user's Slack status",
      description: "Clear only the configured user's Slack status text, emoji and expiration, under their instructions.",
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: async (_id, params) => {
        onlyKeys(params, []);
        await update((client) => client.setStatus({ status_text: "", status_emoji: "", status_expiration: 0 }));
        return result("Slack status cleared for the configured user.");
      },
    }),
    defineTool({
      name: "set_slack_profile_photo", label: "Set authorized user's Slack profile picture",
      description: "Replace only the configured user's public Slack profile picture, under their instructions. Use an existing PNG/JPEG inside this channel's workspace or original attachments, at most 5 MiB with each side between 512 and 1024 pixels. No URLs, external sharing roots or other channels. No automatic expiration/restoration.",
      parameters: Type.Object({ path: Type.String({ description: "Workspace-relative path, or an absolute path within this channel's workspace/original attachments. Use an image with each side between 512 and 1024 pixels." }) }, { additionalProperties: false }),
      execute: async (_id, params: { path: string }) => {
        onlyKeys(params, ["path"]);
        const image = readSlackProfilePhoto(params.path, ctx.channel.paths.workspace, ctx.channel.paths.attachments);
        await update((client) => client.setPhoto(image));
        return result("Slack profile picture updated for the configured user. It will remain until changed again.");
      },
    }),
  ] as ToolDefinition[];
}
