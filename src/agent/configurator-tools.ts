import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ConfigEdit } from "../config/edit.ts";
import type { ConfiguratorService } from "../config/configurator.ts";

/** No paths to files, scope selectors, channel identities or permission flags are accepted. */
export function createConfiguratorTools(service?: ConfiguratorService): ToolDefinition[] {
  const run = async (work: (service: ConfiguratorService) => unknown) => {
    try {
      if (!service) throw new Error("Configuration tools are available only inside an enabled configurator subagent.");
      const result = await work(service);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: {} };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: service?.error(error) ?? "Configuration tools are unavailable in this conversation." }],
        details: {}, isError: true,
      };
    }
  };
  const edits = Type.Object({
    edits: Type.Array(Type.Object({
      path: Type.Array(Type.String()),
      value: Type.Optional(Type.Any()),
      remove: Type.Optional(Type.Boolean()),
    }), { minItems: 1, maxItems: 25 }),
    revision: Type.String({ description: "The revision from config_get. A stale revision is refused." }),
  });
  return [
    defineTool({
      name: "config_get", label: "Inspect configuration",
      description: "Read persisted configuration with literal secrets redacted and environment references preserved. " +
        "Paths start at the harness root. Omit path for your scope. Returns the revision required by validate/save.",
      parameters: Type.Object({ path: Type.Optional(Type.Array(Type.String())) }),
      execute: async (_id, p: { path?: string[] }) => run((s) => s.get(p.path)),
    }),
    defineTool({
      name: "config_backup", label: "Back up configuration",
      description: "Back up the configured file without exposing its contents. Saves also automatically back up before replacement. " +
        "Returns a backup identifier for host-side recovery.",
      parameters: Type.Object({}),
      execute: async () => run((s) => s.backup()),
    }),
    defineTool({
      name: "config_validate", label: "Validate configuration edits",
      description: "Check scope, YAML side effects and the harness loader rules for proposed edits without saving or reloading. " +
        'Use full paths, for example ["channels", "your-channel-key", "description"]. Lists are replaced, not appended.',
      parameters: edits,
      execute: async (_id, p: { edits: ConfigEdit[]; revision: string }) => run((s) => s.validate(p.edits, p.revision)),
    }),
    defineTool({
      name: "config_save", label: "Save and reload configuration",
      description: "Apply a validated batch atomically, with automatic backup and reload. Reports saved and applied separately, " +
        "plus warnings for restart-required settings and active turns still using old settings. Failed reload restores the previous " +
        "file when safe. Never put literal credentials in edits: use environment references.",
      parameters: edits,
      execute: async (_id, p: { edits: ConfigEdit[]; revision: string }) => run((s) => s.save(p.edits, p.revision)),
    }),
  ] as ToolDefinition[];
}
