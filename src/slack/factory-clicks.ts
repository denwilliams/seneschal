import type { WebClient } from "@slack/web-api";
import { FactoryRunError, type FactoryRunService } from "../factory/workflow/service.ts";
import { canApprove, resolveMergeRules } from "../factory/workflow/merge.ts";
import type { ResolvedChannel } from "../workspace/resolve.ts";
import { logger } from "../util/log.ts";
import { buttonsFor, FACTORY_ACTION_PREFIX, parseButtonValue, type FactoryButton } from "./factory-render.ts";
import type { FactoryPresence, PresenceChannel } from "./factory-presence.ts";
import { escapeSlack } from "./subagent-progress.ts";

/**
 * A click on a status post's buttons: **Approve**, **Decline**, **One more round**, **Stop**, and, for a stage that failed or was
 * interrupted, **Retry** or **Abort**.
 *
 * The clicker is who Slack says pressed it (`body.user.id`), checked in the service against the factory's approvers exactly as a
 * decision made through the agent is. The button carries only which run and which wait it belongs to. It does not carry the commit:
 * an approval is bound to the commit the run recorded as reviewed, read by the service, so a click cannot be pointed at another one.
 * A button from an earlier wait, from a post that has since been replaced, or one pressed twice, does nothing and says why.
 */

type Deps = {
  client: Pick<WebClient, "chat"> & Partial<Pick<WebClient, "views">>;
  presence: Pick<FactoryPresence, "claimDecision" | "releaseDecision" | "redraw">;
  /** The channel as the configuration says it is now, or undefined when it is not (or no longer) a factory. */
  channelFor: (channelId: string) => Promise<(ResolvedChannel & PresenceChannel) | undefined>;
  /** The service acting as the clicker, in the run's thread. */
  serviceFor: (channel: ResolvedChannel, clicker: string, threadTs: string) => FactoryRunService | undefined;
};

const WORDS: Record<FactoryButton, string> = { approve: "approved", decline: "declined", request_changes: "asked for changes", more_rounds: "given another round", stop: "stopped", retry: "retried", abort: "aborted" };

export const FACTORY_CHANGES_VIEW = "harness_factory_request_changes_view";

/** Modal metadata is routing data only; all wait, identity and permission checks run again on submission. */
export async function submitFactoryRunChanges(deps: Deps, body: any): Promise<void> {
  let metadata: { channel: string; ts: string; value: string };
  try { metadata = JSON.parse(body?.view?.private_metadata ?? ""); } catch { return; }
  if (!metadata || typeof metadata.channel !== "string" || typeof metadata.ts !== "string" || typeof metadata.value !== "string") return;
  await decideFactoryRunClick(deps, {
    user: body.user, channel: { id: metadata.channel }, message: { ts: metadata.ts },
    actions: [{ action_id: `${FACTORY_ACTION_PREFIX}_request_changes`, value: metadata.value }],
    feedback: body?.view?.state?.values?.feedback?.text?.value ?? "",
  });
}

export async function decideFactoryRunClick(deps: Deps, body: any): Promise<void> {
  const action = body?.actions?.[0];
  const actionId: string = String(action?.action_id ?? "");
  const button = actionId.startsWith(`${FACTORY_ACTION_PREFIX}_`) ? (actionId.slice(FACTORY_ACTION_PREFIX.length + 1) as FactoryButton) : undefined;
  const token = parseButtonValue(String(action?.value ?? ""));
  const clicker: string = body?.user?.id ?? "";
  const channelId: string = body?.channel?.id || body?.container?.channel_id || "";
  const messageTs: string = typeof body?.message?.ts === "string" ? body.message.ts : "";

  const tell = async (text: string) => {
    if (!channelId || !clicker) {
      logger.warn("workflow run click: nobody to tell privately; the answer was dropped");
      return;
    }
    await deps.client.chat.postEphemeral({ channel: channelId, user: clicker, ...(messageTs ? { thread_ts: messageTs } : {}), text }).catch((err: unknown) => {
      logger.warn(`could not post a workflow run ephemeral: ${err instanceof Error ? err.message : String(err)}`);
    });
  };

  if (!button || !token || !clicker || !channelId) {
    await tell("That button is not one this harness recognises.");
    return;
  }
  const channel = await deps.channelFor(channelId);
  const service = channel ? deps.serviceFor(channel, clicker, messageTs) : undefined;
  if (!channel || !service) {
    await tell("This channel is no longer set up to run workflows, so that button does nothing.");
    return;
  }

  let run;
  try {
    [run] = await service.check(token.runId);
  } catch (error) {
    await tell(error instanceof FactoryRunError ? error.message : "That run could not be read just now. Try again in a moment.");
    return;
  }
  if (!run) {
    await tell("That run no longer exists.");
    return;
  }
  // The post the button is on must still be the run's post, and the run must still be waiting on what the button answers.
  const stale = (run.status !== "waiting" && run.status !== "needs_decision") || run.wait.kind !== token.kind || run.wait.since !== token.since || (run.slack.ts !== "" && messageTs !== "" && messageTs !== run.slack.ts);
  if (stale) {
    await tell(`That is no longer waiting for that decision (run ${run.runId} is ${run.status.replace("_", " ")}${run.wait.kind ? `, waiting on ${run.wait.kind}` : ""}).`);
    await deps.presence.redraw(channel, run.runId);
    return;
  }
  // The button must be one this wait offers (a forged value cannot use a button to answer a different wait).
  if (!buttonsFor(run).includes(button)) {
    await tell("That button does not answer what this run is waiting for.");
    await deps.presence.redraw(channel, run.runId);
    return;
  }
  // Said here as well as in the service so a stranger's click cannot take the claim, and so they are told who can decide.
  if (!canApprove(clicker, resolveMergeRules(channel.factory, run.repo), channel.allowUsers)) {
    await tell(`You are not one of the people who may approve or decline runs for ${escapeSlack(run.repo)}.`);
    return;
  }
  if (button === "request_changes" && body.feedback === undefined) {
    if (!body.trigger_id || !deps.client.views) {
      await tell("The feedback form could not be opened. Try Request changes again.");
      return;
    }
    try {
      await deps.client.views.open({ trigger_id: body.trigger_id, view: {
        type: "modal", callback_id: FACTORY_CHANGES_VIEW,
        title: { type: "plain_text", text: "Request changes" },
        submit: { type: "plain_text", text: "Request changes" }, close: { type: "plain_text", text: "Cancel" },
        private_metadata: JSON.stringify({ channel: channelId, ts: messageTs, value: action.value }),
        blocks: [{ type: "input", block_id: "feedback", label: { type: "plain_text", text: "What needs to change?" },
          element: { type: "plain_text_input", action_id: "text", multiline: true, min_length: 1, max_length: 3000 } }],
      } });
    } catch (error) {
      logger.warn(`could not open factory feedback form: ${error instanceof Error ? error.message : String(error)}`);
      await tell("The feedback form could not be opened. Try Request changes again.");
    }
    return; // Opening or cancelling a form never claims or decides the wait.
  }
  if (button === "request_changes" && (typeof body.feedback !== "string" || !body.feedback.trim() || body.feedback.trim().length > 3000)) {
    await tell("Supply actionable feedback (1–3000 characters).");
    return;
  }
  const claim = await deps.presence.claimDecision(channel, run.runId, { kind: button, since: token.since, by: clicker });
  if (!claim.ok) {
    await tell(claim.by ? `That was already ${WORDS[claim.kind as FactoryButton] ?? "decided"} by <@${claim.by}>.` : "That run could not be read just now. Try again in a moment.");
    return;
  }
  try {
    if (button === "request_changes") await service.requestChanges(run.runId, body.feedback, token.since);
    else if (button === "approve") await service.approve(run.runId);
    else if (button === "more_rounds") await service.moreRounds(run.runId);
    else if (button === "retry" || button === "abort") await service.decide(run.runId, button);
    else await service.decline(run.runId); // on a run out of rounds, declining is stopping
  } catch (error) {
    await deps.presence.releaseDecision(channel, run.runId);
    await tell(error instanceof FactoryRunError ? error.message : "That could not be done just now. Try again in a moment.");
    if (!(error instanceof FactoryRunError)) logger.warn(`workflow run click failed: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  // The buttons give way to who decided.
  await deps.presence.redraw(channel, run.runId);
}
