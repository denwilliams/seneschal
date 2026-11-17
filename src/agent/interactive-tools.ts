import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";

/**
 * The first interactive surface deliberately has a small, fixed vocabulary.
 * A component click only resumes the current Slack conversation with one of
 * these values; it cannot invoke code, a URL, or an agent-supplied callback.
 */
export const CANNED_RESPONSES = ["yes", "no", "continue", "stop", "cancel"] as const;
export type CannedResponse = (typeof CANNED_RESPONSES)[number];

export const CANNED_RESPONSE_LABELS: Record<CannedResponse, string> = {
  yes: "Yes",
  no: "No",
  continue: "Continue",
  stop: "Stop",
  cancel: "Cancel",
};

export const INTERACTIVE_RESPONSE_ACTION_PREFIX = "harness_canned_response";

export function cannedResponseActionId(response: CannedResponse): string {
  return `${INTERACTIVE_RESPONSE_ACTION_PREFIX}_${response}`;
}

export function isCannedResponse(value: unknown): value is CannedResponse {
  return typeof value === "string" && (CANNED_RESPONSES as readonly string[]).includes(value);
}

export interface InteractiveResponseService {
  present(input: {
    channelId: string;
    threadTs: string;
    question: string;
    responses: CannedResponse[];
  }): Promise<{ ts: string; permalink?: string }>;
}

export interface InteractiveToolsContext {
  service: InteractiveResponseService;
  channelId: string;
  channelLabel: string;
  /** Interactive answers must come back to a real conversation thread. */
  currentThreadTs: () => string | undefined;
}

export function createInteractiveTools(ctx: InteractiveToolsContext): ToolDefinition[] {
  const ask = defineTool({
    name: "ask_canned_response",
    label: "Ask with canned response buttons",
    description:
      `Present safe canned-response buttons in the current ${ctx.channelLabel} conversation instead of asking the user to type. ` +
      "Use this for a short decision such as Yes/No, then stop and wait for the click; the selected response returns as a structured user response in this same conversation. " +
      "Only the listed canned responses are supported. This never runs a script or an HTTP callback.",
    parameters: Type.Object({
      question: Type.String({ description: "Short question shown above the response buttons." }),
      responses: Type.Array(
        Type.Union([
          Type.Literal("yes"),
          Type.Literal("no"),
          Type.Literal("continue"),
          Type.Literal("stop"),
          Type.Literal("cancel"),
        ]),
        {
          minItems: 1,
          maxItems: CANNED_RESPONSES.length,
          description: "Fixed canned response buttons to show; use [\"yes\", \"no\"] for a normal confirmation.",
        },
      ),
    }),
    execute: async (_id, params: { question: string; responses: CannedResponse[] }) => {
      const question = params.question.trim();
      if (!question) throw new Error("ask_canned_response needs a question.");
      // Slack caps a button value at 2,000 characters. The Block Kit builder
      // also measures the final encoded value, but this keeps normal questions
      // comfortably below the cap before the service is called.
      if (question.length > 1_500) throw new Error("The interactive question must be 1,500 characters or fewer.");

      const responses = [...new Set(params.responses)];
      if (responses.length === 0 || !responses.every(isCannedResponse)) {
        throw new Error("Choose one or more supported canned responses.");
      }
      const threadTs = ctx.currentThreadTs();
      if (!threadTs) throw new Error("Interactive responses are only available inside a Slack conversation thread.");

      const result = await ctx.service.present({
        channelId: ctx.channelId,
        threadTs,
        question,
        responses,
      });
      return {
        content: [{
          type: "text" as const,
          text: "Canned response buttons are posted in this thread. Stop and wait for the user's selection; do not repeat the question in your reply.",
        }],
        details: { ts: result.ts, permalink: result.permalink },
      };
    },
  });

  return [ask] as ToolDefinition[];
}
