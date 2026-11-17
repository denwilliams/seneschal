import type { WebClient } from "@slack/web-api";
import type { KnownBlock } from "@slack/types";
import type { CapabilityRequest, CapabilityRequests } from "../config/capability-requests.ts";
import { escapeSlack } from "./subagent-progress.ts";

export const CAPABILITY_APPROVE = "harness_capability_approve";
export const CAPABILITY_DENY = "harness_capability_deny";

export function capabilityBlocks(item: CapabilityRequest, outcome?: string): KnownBlock[] {
  // Untrusted request text is plain_text, not Slack markup or executable instructions.
  const summary = [
    `Capability request ${item.id}: ${item.state}`,
    `Requesting channel: ${item.actor.channelId} (${item.actor.channelKey}); requested during ${item.actor.userId}'s turn`,
    `${item.type}: ${item.kind} / ${item.name}`, `Reason: ${item.reason}`,
    item.plan ? `Provisioning plan (administrator performs only after human approval):\n${item.plan}` : "",
    item.definition ? `Account catalog entry (literal credentials redacted):\n${JSON.stringify(item.definition, null, 2)}` : "",
    item.edits ? `Exact enablement edits:\n${JSON.stringify(item.edits, null, 2)}\nConfig revision: ${item.revision}\nCatalog definition fingerprint: ${item.definitionRevision}` : "",
    outcome ?? (item.state === "awaiting_plan"
      ? `No creation or installation is authorized. Ask harnessConfigurator to call config_capability_request action plan with this id and a concrete provisioning plan.`
      : `Only allowlisted humans may decide. Approval expires in 30 minutes. Approvers: ${item.approvers.join(", ")}`),
  ].filter(Boolean).join("\n\n");
  // Refuse oversized diffs rather than omit what the human approves. Slack has at most 50 blocks.
  if (summary.length > 35_000) throw new Error("Request is too large to show in full for approval; an operator must reconcile the channel configuration first.");
  const blocks: KnownBlock[] = [];
  for (let i = 0; i < summary.length; i += 2800) blocks.push({ type: "section", text: { type: "plain_text", text: summary.slice(i, i + 2800) } });
  if (!outcome && ["pending_provision", "pending_enable"].includes(item.state)) blocks.push({ type: "actions", elements: [
    { type: "button", action_id: CAPABILITY_APPROVE, value: item.id, text: { type: "plain_text", text: item.state === "pending_provision" ? "Approve provisioning plan" : "Approve enablement" }, style: "primary" },
    { type: "button", action_id: CAPABILITY_DENY, value: item.id, text: { type: "plain_text", text: "Reject" }, style: "danger" },
  ] });
  return blocks;
}

/** Called only from Bolt's authenticated action callback, never from a channel tool. */
export async function decideCapabilityRequest(service: CapabilityRequests, client: WebClient, body: any): Promise<void> {
  const action = body?.actions?.[0];
  if (![CAPABILITY_APPROVE, CAPABILITY_DENY].includes(action?.action_id)) return;
  try {
    await service.decide({ id: String(action.value ?? ""), channelId: body?.channel?.id ?? "", messageTs: body?.message?.ts ?? "", userId: body?.user?.id ?? "", approve: action.action_id === CAPABILITY_APPROVE });
  } catch (error) {
    await client.chat.postEphemeral({ channel: body?.channel?.id ?? "", user: body?.user?.id ?? "", text: escapeSlack(error instanceof Error ? error.message : "Capability decision failed.") }).catch(() => undefined);
  }
}
