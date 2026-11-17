import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { CapabilityActor, CapabilityKind, CapabilityRequests } from "../config/capability-requests.ts";
import type { ConfiguratorActor } from "../config/configurator.ts";

const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: {} });
const kind = Type.Union([Type.Literal("connector"), Type.Literal("cli")]);

/** Exactly three channel-facing tools. Identity comes from the host, never tool arguments. */
export function createCapabilityTools(service: CapabilityRequests, actor: () => CapabilityActor): ToolDefinition[] {
  const parameters = Type.Object({ kind, name: Type.String({ maxLength: 100 }), reason: Type.String({ maxLength: 1500 }) });
  return [
    defineTool({ name: "search_capabilities", label: "Search available capabilities",
      description: "Search account connectors/connections and CLI tools by name or description. Returns safe metadata and this channel's enablement only; changes nothing.",
      parameters: Type.Object({ query: Type.Optional(Type.String()), kind: Type.Optional(kind) }),
      execute: async (_id, p: { query?: string; kind?: CapabilityKind }) => result(service.search(actor(), p.query, p.kind)),
    }),
    ...(["enable", "new"] as const).map((type) => defineTool({
      name: type === "enable" ? "request_enable_capability" : "request_new_capability", label: type === "enable" ? "Request capability enablement" : "Request new capability",
      description: type === "enable"
        ? "Ask the admin channel's authorized humans to enable an account catalog connector or CLI for this channel. Does not enable anything. Explain why, report pending, then wait."
        : "Request a connector or CLI not in the account catalog. Routes to the admin channel for a concrete provisioning plan, human approval, administrator provisioning, then a separate human approval before configurator enablement. A request authorizes nothing.",
      parameters,
      execute: async (_id, p: { kind: CapabilityKind; name: string; reason: string }) => result(await service.request(actor(), { ...p, type })),
    })),
  ] as ToolDefinition[];
}

/** A private lifecycle tool, not offered to channel agents, ordinary roles or channelConfigurator. */
export function createCapabilityConfiguratorTools(service?: CapabilityRequests, actor?: ConfiguratorActor): ToolDefinition[] {
  return [defineTool({ name: "config_capability_request", label: "Manage approved capability request",
    description: "Admin harnessConfigurator only: inspect a request; plan a new capability's exact provisioning steps for a human to approve (no execution); prepare concrete enablement edits after an authorized administrator provides the account catalog entry; or apply single-use, human-approved edits. Never install or create before provisioning approval, and never enable before the separate enablement approval. No arbitrary target, definition or edits accepted.",
    parameters: Type.Object({ id: Type.String(), action: Type.Union([Type.Literal("inspect"), Type.Literal("plan"), Type.Literal("prepare"), Type.Literal("apply")]), plan: Type.Optional(Type.String({ maxLength: 6000 })) }),
    execute: async (_id, p: { id: string; action: "inspect" | "plan" | "prepare" | "apply"; plan?: string }) => {
      if (!service || !actor) throw new Error("Capability lifecycle is available only inside the admin harnessConfigurator.");
      return result(await service.manage(actor, p));
    },
  })] as ToolDefinition[];
}
