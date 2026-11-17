import { stdin } from "node:process";
import { join } from "node:path";
import { loadConfig, REPO_ROOT } from "../config/load.ts";
import { readSecretFile, listSecretKeys, removeSecretValue, setSecretValue, writeSecretFile } from "../config/secretfile.ts";
import { resolveEnvPath } from "../config/envfile.ts";
import { ChannelRegistry } from "../workspace/registry.ts";
import { runOpenBaoCommand } from "./openbao-secrets.ts";

function usage(): string {
  return [
    "Usage:",
    "  npm run secrets -- list CHANNEL",
    "  npm run secrets -- set CHANNEL KEY",
    "  npm run secrets -- remove CHANNEL KEY",
    "  npm run secrets -- openbao list SCOPE [CHANNEL_ID]",
    "  npm run secrets -- openbao set SCOPE [CHANNEL_ID] KEY",
    "  npm run secrets -- openbao remove SCOPE [CHANNEL_ID] KEY",
    "SCOPE is channel, global-channel, or main-process. OpenBao remove deletes ALL versions.",
    "",
    "CHANNEL may be a Slack channel ID, a known channel name, or #name.",
    "For set, pass the secret value on stdin or in SECRET_VALUE:",
    "  printf '%s' \"$TOKEN\" | npm run secrets -- set engineering GITHUB_TOKEN",
    "",
    "The command prints secret names and target files, never values.",
  ].join("\n");
}

async function readSecretValue(): Promise<string> {
  const fromEnv = process.env.SECRET_VALUE;
  if (fromEnv !== undefined) return fromEnv;

  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const value = Buffer.concat(chunks).toString("utf-8");
  if (value.length === 0) throw new Error("No secret value provided on stdin or SECRET_VALUE.");
  return value.replace(/\r?\n$/, "");
}

function looksLikeSlackId(value: string): boolean {
  return /^[CDG][A-Z0-9]{2,}$/.test(value);
}

function channelEnvPath(input: string, config: ReturnType<typeof loadConfig>["config"], dataDir: string): string {
  const registry = new ChannelRegistry(dataDir);
  const bare = input.startsWith("#") ? input.slice(1) : input;
  const entry = config.channels[input] ?? config.channels[bare];
  if (entry?.envFile) return resolveEnvPath(entry.envFile, REPO_ROOT);

  const id = registry.resolveId(input) ?? (looksLikeSlackId(bare) ? bare : undefined);
  if (id) return join(dataDir, "channels", id, "env");

  throw new Error(
    `Channel ${input} has no explicit envFile and has not been seen yet, so its ID-backed env file is unknown. ` +
      "Use the Slack channel ID or add an envFile in harness.yaml.",
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "openbao") {
    const { config, dataDir } = loadConfig(process.env.HARNESS_CONFIG);
    console.log(await runOpenBaoCommand(args.slice(1), config, dataDir, readSecretValue));
    return;
  }
  const [cmd, channelArg, keyArg, ...extra] = args;
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(usage());
    return;
  }
  if (extra.length > 0) throw new Error(`Unexpected argument: ${extra[0]}`);
  if (!channelArg) throw new Error(usage());

  const { config, dataDir } = loadConfig(process.env.HARNESS_CONFIG);
  if ((cmd === "set" || cmd === "remove") && keyArg && config.keychain) {
    const managed = [...config.keychain.mainProcess, ...config.keychain.globalChannel, ...Object.values(config.keychain.channels).flat()];
    if (managed.includes(keyArg)) throw new Error("This name is managed by Keychain. Use the scoped write-only Admin form; no plaintext env file was changed.");
  }
  const path = channelEnvPath(channelArg, config, dataDir);
  const content = readSecretFile(path);

  switch (cmd) {
    case "list": {
      const keys = listSecretKeys(content);
      console.log(`Secrets for ${channelArg}: ${path}`);
      if (keys.length === 0) console.log("No secrets stored.");
      else console.log(keys.map((k) => `- ${k}`).join("\n"));
      return;
    }
    case "set": {
      if (!keyArg) throw new Error("Usage: npm run secrets -- set CHANNEL KEY");
      const value = await readSecretValue();
      writeSecretFile(path, setSecretValue(content, keyArg, value));
      console.log(`Stored ${keyArg} for ${channelArg} in ${path}.`);
      return;
    }
    case "remove": {
      if (!keyArg) throw new Error("Usage: npm run secrets -- remove CHANNEL KEY");
      const result = removeSecretValue(content, keyArg);
      if (result.removed) writeSecretFile(path, result.content);
      console.log(result.removed ? `Removed ${keyArg} for ${channelArg} from ${path}.` : `No ${keyArg} secret for ${channelArg}.`);
      return;
    }
    default:
      throw new Error(`Unknown command: ${cmd}\n\n${usage()}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
