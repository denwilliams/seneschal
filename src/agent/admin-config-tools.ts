import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { ConfigEditError, describeLimits, type ConfigEdit, type ConfigEditResult } from "../config/edit.ts";

/**
 * How the admin channel's agent reads and changes `harness.yaml`. Only the admin channel gets these, and a subagent never does.
 * What may be changed, and what stays an edit on the host, is decided by the config module (`edit-policy.ts`), not here: these
 * tools hand the request over and report what happened.
 */

export interface AdminConfigService {
  /** What the file says at a path, with literal secrets removed. */
  read(path: string[]): { path: string; found: boolean; value?: unknown; channels?: string[] };
  /** Apply a batch of changes as one validated, backed-up, reloaded change. Throws `ConfigEditError` with what to tell the person. */
  edit(input: { edits: ConfigEdit[]; reason: string; actor: { channelId: string; channelKey?: string; userId: string } }): Promise<ConfigEditResult>;
  /**
   * Ask a person to approve a change that needs one (a sandbox, a shell, delegation). Posts the buttons and returns at once; nothing
   * is written until someone on `approvers` clicks. Throws `ConfigEditError` when the change is refused outright, or needs no approval.
   */
  propose(input: { edits: ConfigEdit[]; reason: string; actor: { channelId: string; channelKey?: string; userId: string }; approvers: string[] }): Promise<{ id: string; changes: ConfigEditResult["changes"] }>;
}

export interface AdminConfigToolsContext {
  service: AdminConfigService;
  channelId: string;
  /** This channel's key in the config: it is the one thing that can never be changed from inside it. */
  channelKey: string;
  currentUserId: () => string;
  /** Who may approve a change: the admin channel's own people. Empty means nobody can, and a request is refused. */
  approvers: () => string[];
}

/** One shape for the tool's details whether it changed something or refused, so the two results have the same type. */
interface EditDetails { refused: boolean; changes?: number; backup?: string }

const show = (value: unknown): string => {
  const text = value === undefined ? "(not set)" : JSON.stringify(value);
  return text.length > 300 ? `${text.slice(0, 299)}…` : text;
};

export function createAdminConfigTools(ctx: AdminConfigToolsContext): ToolDefinition[] {
  const get = defineTool({
    name: "admin_config_get",
    label: "Read the harness config",
    description:
      "Read a part of the harness config (harness.yaml), as it is on disk now. Literal secrets are never shown (a ${VAR} reference is, because it names where a secret is, not what it is). " +
      "Give `path` as a list of keys from the top, for example [\"connectors\"], [\"channels\", \"engineering\"] or [\"channels\", \"engineering\", \"share\"]; leave it empty for the whole file. " +
      "Read before you change anything, so you edit what is there and not what you remember. A channel can be named by its key, its name, or #name.",
    parameters: Type.Object({
      path: Type.Optional(Type.Array(Type.String(), { description: "Keys from the top of the file. Empty or omitted: the whole file." })),
    }),
    execute: async (_id, params: { path?: string[] }) => {
      const result = ctx.service.read(params.path ?? []);
      const text = result.found
        ? `${result.path}:\n${JSON.stringify(result.value, null, 2)}${result.channels ? `\n\nConfigured channels: ${result.channels.join(", ")}` : ""}`
        : `Nothing is set at ${result.path}.${result.channels ? ` Configured channels: ${result.channels.join(", ")}` : ""}`;
      return { content: [{ type: "text" as const, text }], details: { path: result.path, found: result.found } };
    },
  });

  const edit = defineTool({
    name: "admin_config_edit",
    label: "Change the harness config",
    description:
      "Change the harness config (harness.yaml) in place: comments and layout are kept and only the lines you change move. " +
      "Give a list of `edits`, applied together as ONE change that is validated, backed up and reloaded, or not applied at all. " +
      "Each edit is a `path` (keys from the top) with a `value`, or `remove: true` to delete a setting. " +
      "Use it to set up the environment and then link it to channels: add or update a connector under [\"connectors\", name], then give it to channels with " +
      "[\"channels\", channel, \"share\", \"connectors\"] (set the whole list); set models, thinking level, who may use a channel, which team a channel has, and so on. " +
      "Read the current value first with admin_config_get and send the whole new value for what you change (a list is replaced, not appended to). " +
      "Never put a secret in a value: a connector's credentials are ${VAR} references that the person sets on the host.\n\n" +
      `What you may NOT change (a person does these on the host):\n${describeLimits()}\n\n` +
      "If a change is refused, the reason says why; tell the person, and what they would do on the host instead. Do not look for another way round it.",
    parameters: Type.Object({
      edits: Type.Array(
        Type.Object({
          path: Type.Array(Type.String(), { description: "Keys from the top of the file, for example [\"channels\", \"engineering\", \"model\"]." }),
          value: Type.Optional(Type.Any({ description: "The new value (a string, number, boolean, list or map). Omit when removing." })),
          remove: Type.Optional(Type.Boolean({ description: "Delete this setting, so the default applies again." })),
        }),
        { description: "The changes to make together. At most 25.", minItems: 1 },
      ),
      reason: Type.String({ description: "One sentence on why, recorded with the change." }),
    }),
    execute: async (_id, params: { edits: ConfigEdit[]; reason: string }) => {
      try {
        const result = await ctx.service.edit({
          edits: params.edits,
          reason: params.reason,
          actor: { channelId: ctx.channelId, channelKey: ctx.channelKey, userId: ctx.currentUserId() },
        });
        const lines = result.changes.map((c) => `- ${c.path}: ${show(c.before)} → ${show(c.after)}`);
        const warnings = result.reload?.warnings.length ? `\nWarnings from the reload: ${result.reload.warnings.join(" ")}` : "";
        return {
          content: [{
            type: "text" as const,
            text: `Changed and reloaded (backup: ${result.backup}).\n${lines.join("\n")}${warnings}\n` +
              "Future turns use the new config; sessions are rebuilt as soon as it is safe. To undo, the previous file is the backup above.",
          }],
          details: { refused: false, changes: result.changes.length, backup: result.backup } as EditDetails,
        };
      } catch (error) {
        // A refusal is an answer, not a crash: it goes back to the model as the tool's result so it can tell the person.
        if (error instanceof ConfigEditError) {
          return { content: [{ type: "text" as const, text: error.message }], details: { refused: true } as EditDetails, isError: true };
        }
        throw error;
      }
    },
  });
  const request = defineTool({
    name: "admin_config_request_approval",
    label: "Ask for approval to change the harness config",
    description:
      "For the four changes admin_config_edit refuses but a person may approve: a channel's `sandbox`, its `share.delegateTo`, its `share.postAs` (including any change to the reviewer role that guards it, or to that channel's `agentSet`), and `bash`/`exec` added to its `tools` " +
      "(for example, moving a channel onto an agent set whose roles need a shell), and removing a channel's `exec` commands. Same shape as admin_config_edit. Nothing is changed by this call: it posts a message " +
      "with the exact before/after and Approve/Deny buttons, and the change is applied only if someone allowed to approve clicks Approve. " +
      "Put ALL the changes for one migration in one request, so one click applies them together. Use field-level edits (path [\"channels\", name, \"sandbox\"], not the whole channel) so settings you may not touch, like `requires`, are never part of the request. Never for the admin channel or the channel you are in. " +
      "Everything else is checked exactly as for admin_config_edit, and a request that needs no approval is told to use that tool instead. " +
      "After calling it, tell the person you have asked, then stop: do not call it again and do not look for another way to make the change.",
    parameters: Type.Object({
      edits: Type.Array(
        Type.Object({
          path: Type.Array(Type.String(), { description: "Keys from the top of the file." }),
          value: Type.Optional(Type.Any({ description: "The new value. Omit when removing." })),
          remove: Type.Optional(Type.Boolean({ description: "Delete this setting." })),
        }),
        { description: "The changes to make together. At most 25.", minItems: 1 },
      ),
      reason: Type.String({ description: "One or two sentences for the approver on why this is needed. Shown with the change." }),
    }),
    execute: async (_id, params: { edits: ConfigEdit[]; reason: string }) => {
      try {
        const approvers = ctx.approvers();
        if (approvers.length === 0) {
          throw new ConfigEditError("Nobody is set up to approve changes: the admin channel has no `allowUsers`. Someone adds it on the host first.");
        }
        const result = await ctx.service.propose({
          edits: params.edits,
          reason: params.reason,
          actor: { channelId: ctx.channelId, channelKey: ctx.channelKey, userId: ctx.currentUserId() },
          approvers,
        });
        const lines = result.changes.map((c) => `- ${c.path}: ${show(c.before)} → ${show(c.after)}`);
        return {
          content: [{
            type: "text" as const,
            text: `Asked ${approvers.map((u) => `<@${u}>`).join(", ")} to approve (request ${result.id}); nothing has changed yet.\n${lines.join("\n")}\n` +
              "Tell the person the request is posted and what it will change. It expires in 30 minutes. Stop here.",
          }],
          details: { refused: false, changes: result.changes.length } as EditDetails,
        };
      } catch (error) {
        if (error instanceof ConfigEditError) {
          return { content: [{ type: "text" as const, text: error.message }], details: { refused: true } as EditDetails, isError: true };
        }
        throw error;
      }
    },
  });
  return [get, edit, request] as ToolDefinition[];
}
