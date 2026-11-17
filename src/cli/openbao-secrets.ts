import { existsSync } from "node:fs";
import type { HarnessConfig } from "../config/schema.ts";
import { OpenBaoClient, OpenBaoError } from "../config/openbao.ts";
import { channelId, type SecretScope } from "../config/openbao-schema.ts";
import { REPO_ROOT } from "../config/load.ts";

/** Scope must always be explicit: never infer a channel/main target from a secret name. */
export function parseOpenBaoCommand(args: string[]): { command: "list" | "set" | "remove"; scope: SecretScope; name?: string } {
  const [command, kind, ...rest] = args;
  if (command !== "list" && command !== "set" && command !== "remove") throw new OpenBaoError("Use openbao list, set or remove.");
  let scope: SecretScope;
  if (kind === "channel" && rest[0] && channelId.test(rest[0])) scope = { kind, channel: rest.shift()! };
  else if (kind === "global-channel" || kind === "main-process") scope = { kind };
  else throw new OpenBaoError("Select channel CHANNEL_ID, global-channel or main-process explicitly.");
  if (rest.length !== (command === "list" ? 0 : 1)) throw new OpenBaoError("Supply one secret name for set/remove, and no secret name for list.");
  return { command, scope, name: rest[0] };
}

export async function runOpenBaoCommand(args: string[], config: HarnessConfig, dataDir: string, readValue: () => Promise<string>): Promise<string> {
  const { command, scope, name } = parseOpenBaoCommand(args);
  if (!config.openbao) throw new OpenBaoError("Configure openbao before managing backend secrets.");
  const client = new OpenBaoClient(config.openbao, { forbiddenRoots: [dataDir, REPO_ROOT].filter(existsSync) });
  if (command === "list") {
    const names = await client.list(scope);
    return names.length ? names.map((key) => `- ${key}`).join("\n") : "No secrets stored.";
  }
  if (command === "set") {
    await client.save(scope, name!, await readValue());
    return "Stored in OpenBao. Add the name to the matching config import list; reload channels or restart main-process clients to apply.";
  }
  await client.remove(scope, name!);
  return "Permanently removed all versions from OpenBao. Remove the matching config import before the next reload/startup.";
}
