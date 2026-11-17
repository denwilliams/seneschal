import { Type } from "typebox";
import { defineTool, type ModelRuntime, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { formatModel, isAllowed, listModels, parseRef, resolveModel } from "./model.ts";
import { logger } from "../util/log.ts";

/**
 * Lets the agent see which models it can run on and move itself between them —
 * e.g. escalating to a reasoning model for a hard problem, or dropping to a
 * cheap one for routine chatter.
 *
 * The switch is bounded by the channel's `models` allowlist and by which
 * providers actually have credentials, so the agent cannot wander onto a model
 * the deployment does not pay for.
 */

/**
 * The conversation's selected model. The conversation itself persists it, so a switch
 * outlives the in-memory session; the tools only need to read and change it.
 */
export interface ModelControl {
  current(): Model<never> | undefined;
  /** Takes effect from the thread's next request; an in-flight generation is undisturbed. */
  set(model: Model<never>): Promise<void>;
}

export interface ModelToolsContext {
  /** Resolved lazily: the conversation does not exist yet when tools are built. */
  control: ModelControl;
  allow: string[];
  modelRuntime: ModelRuntime;
  /** Called after a successful switch, for logging/UI. */
  onSwitch?: (spec: string) => void;
}

export function createModelTools(ctx: ModelToolsContext): ToolDefinition[] {
  const listTool = defineTool({
    name: "list_models",
    label: "List models",
    description:
      "List the models this channel can run on, with context window, reasoning support and price. Use before switching if you are unsure what is available.",
    parameters: Type.Object({
      provider: Type.Optional(
        Type.String({ description: 'Filter to one provider, e.g. "openai" or "deepseek".' }),
      ),
    }),
    execute: async (_id, params: { provider?: string }) => {
      let models = listModels({ catalog: ctx.modelRuntime, allow: ctx.allow, onlyAvailable: true });
      if (params.provider) {
        models = models.filter((m) => m.provider === params.provider);
      }

      if (models.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No models are available. The harness has no provider credentials configured, or this channel's allowlist excludes everything.",
            },
          ],
          details: { count: 0, current: undefined as string | undefined },
        };
      }

      const current = ctx.control.current();
      const currentRef = current ? `${current.provider}/${current.id}` : undefined;

      const byProvider = new Map<string, string[]>();
      for (const m of models) {
        const line = `${formatModel(m)}${m.ref === currentRef ? "  <- current" : ""}`;
        const list = byProvider.get(m.provider) ?? [];
        list.push(line);
        byProvider.set(m.provider, list);
      }

      const text = [...byProvider.entries()]
        .map(([provider, lines]) => `${provider}:\n${lines.map((l) => `  ${l}`).join("\n")}`)
        .join("\n\n");

      return {
        content: [{ type: "text" as const, text }],
        details: { count: models.length, current: currentRef },
      };
    },
  });

  const switchTool = defineTool({
    name: "switch_model",
    label: "Switch model",
    description:
      "Switch yourself to a different model for the rest of this conversation. Use it to escalate to a stronger or reasoning-capable model for a hard task, or to drop to a cheaper one for simple work. Tell the user you switched and why.",
    parameters: Type.Object({
      model: Type.String({
        description:
          'Model to switch to, e.g. "deepseek-v4-pro" or "openai/gpt-5.4". Call list_models first if unsure.',
      }),
      reason: Type.Optional(
        Type.String({ description: "Short reason for the switch, shown to the user." }),
      ),
    }),
    execute: async (_id, params: { model: string; reason?: string }) => {
      if (!isAllowed(params.model, ctx.allow, ctx.modelRuntime)) {
        throw new Error(
          `Model "${params.model}" is not permitted in this channel. Call list_models to see the allowed set.`,
        );
      }

      const parsed = parseRef(params.model, ctx.modelRuntime);
      if (
        parsed &&
        !listModels({ catalog: ctx.modelRuntime, allow: ctx.allow }).some(
          (m) => m.ref === `${parsed.provider}/${parsed.modelId}`,
        )
      ) {
        throw new Error(
          `Model "${params.model}" is not available — the harness has no credentials for provider "${parsed.provider}". Call list_models to see what you can use.`,
        );
      }

      // resolveModel throws with a useful message for unknown ids.
      const model = resolveModel(params.model, ctx.modelRuntime);
      const previous = ctx.control.current();
      await ctx.control.set(model as Model<never>);

      const ref = `${model.provider}/${model.id}`;
      ctx.onSwitch?.(ref);
      logger.info(
        `model switch: ${previous ? `${previous.provider}/${previous.id}` : "?"} -> ${ref}` +
          (params.reason ? ` (${params.reason})` : ""),
      );

      return {
        content: [
          {
            type: "text" as const,
            text: `Switched to ${ref}. This applies for the rest of this conversation.`,
          },
        ],
        details: { model: ref, previous: previous ? `${previous.provider}/${previous.id}` : undefined },
      };
    },
  });

  return [listTool, switchTool] as ToolDefinition[];
}
