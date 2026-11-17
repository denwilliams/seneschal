import "./config/managed-env-bootstrap.ts";
import { resolve } from "node:path";
import { ScopedSecretAdmin, openBaoWriter, keychainWriter } from "./config/scoped-secrets.ts";
import { applyKeychainProviderKeys, keychainMainSecret, validateKeychainHost } from "./config/keychain.ts";
import { keychainRiskWarning } from "./config/keychain-policy.ts";
import { openBaoRiskWarning } from "./config/openbao-policy.ts";
import type { HarnessConfig } from "./config/schema.ts";
import { SecretAdmin } from "./config/managed-env.ts";
import { boundedShutdown } from "./util/shutdown.ts";
import { startMemoryDiagnostics } from "./util/memory-diagnostics.ts";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { loadConfig, REPO_ROOT } from "./config/load.ts";
import { initializeOpenBao, mainProcessSecret, applyOpenBaoProviderKeys } from "./config/openbao.ts";
import { checkRequirements, describeMissing } from "./config/requirements.ts";
import { ensureSharedDirs } from "./workspace/paths.ts";
import { resolveAuthPath, setAuthPath } from "./agent/credentials.ts";
import { listModels } from "./agent/model.ts";
import { registerConfiguredModelProviders } from "./agent/model-providers.ts";
import { HarnessApp } from "./slack/app.ts";
import { logger } from "./util/log.ts";
import { assertSupportedNode } from "./util/runtime-check.ts";
import { BackupRunner, resolveBackupDirectory } from "./backup.ts";
import { ArtifactServer, webServerPlan } from "./artifacts/server.ts";

function requireEnv(config: HarnessConfig, name: string): string {
  const value = keychainMainSecret(config, name) ?? mainProcessSecret(config, name) ?? process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. Copy .env.example to .env and fill in your Slack credentials.`,
    );
  }
  return value;
}

async function main(): Promise<void> {
  assertSupportedNode();
  const stopMemoryDiagnostics = startMemoryDiagnostics(process.env.HARNESS_MEMORY_SAMPLE_SECONDS);
  const { config, dataDir, configPath } = loadConfig(process.env.HARNESS_CONFIG);
  const secrets = new SecretAdmin(process.env.HARNESS_MANAGED_ENV_FILE, process.env.HARNESS_ALLOW_RESTART === "1" ? () => { void shutdown("Admin restart"); } : undefined);
  secrets.assertOutsideData(dataDir);
  logger.info(`loaded config from ${configPath}`);
  logger.info(`data directory: ${dataDir}`);

  const openBaoWarning = openBaoRiskWarning(config);
  if (openBaoWarning) logger.warn(openBaoWarning);
  const keychainWarning = keychainRiskWarning(config);
  if (keychainWarning) logger.warn(keychainWarning);

  ensureSharedDirs(dataDir, config.documentsDir === undefined ? undefined : resolve(REPO_ROOT, config.documentsDir));
  validateKeychainHost(config, dataDir);
  await initializeOpenBao(config, { forbiddenRoots: [dataDir, REPO_ROOT] });

  // One credential store for the whole harness. Channels are isolated from
  // each other, but they all run on the operator's single API key or
  // subscription, and OAuth tokens must refresh in exactly one place.
  const authPath = resolveAuthPath(config.authPath, dataDir);
  setAuthPath(authPath);
  const modelRuntime = await ModelRuntime.create({ authPath });
  registerConfiguredModelProviders(modelRuntime, config.modelProviders);
  await applyOpenBaoProviderKeys(config, modelRuntime);
  await applyKeychainProviderKeys(config, modelRuntime);
  logger.info(`credential store: ${authPath}`);

  const usable = listModels({ catalog: modelRuntime, onlyAvailable: true });
  if (usable.length === 0) {
    throw new Error(
      [
        "No usable models. Configure at least one provider:",
        "  - API key: set DEEPSEEK_API_KEY, OPENAI_API_KEY, ... in the environment",
        `  - Subscription: run \`npx pi\` and use /login, then set authPath to that auth.json`,
        `    (currently reading ${authPath})`,
      ].join("\n"),
    );
  }
  const providers = [...new Set(usable.map((m) => m.provider))];
  logger.info(`models available from: ${providers.join(", ")} (${usable.length} model(s))`);

  // Account-level requirements are checked before we touch Slack, so a
  // misconfigured host fails loudly at boot instead of mid-conversation.
  const accountEnv = { ...process.env };
  for (const name of config.requires.env) {
    const value = keychainMainSecret(config, name) ?? mainProcessSecret(config, name);
    if (value !== undefined) accountEnv[name] = value;
  }
  const report = checkRequirements(config.requires, accountEnv);
  if (!report.ok) {
    const detail = describeMissing(report);
    if (report.onMissing === "fail") {
      throw new Error(`Missing required tooling:\n${detail}`);
    }
    logger.warn(`Missing required tooling (continuing anyway):\n${detail}`);
  }

  const app = new HarnessApp({
    config,
    dataDir,
    botToken: requireEnv(config, "SLACK_BOT_TOKEN"),
    appToken: requireEnv(config, "SLACK_APP_TOKEN"),
    modelRuntime,
    configPath,
  });

  const scopedSecrets = new ScopedSecretAdmin([
    openBaoWriter(() => app.console2Source().config().openbao, [dataDir, REPO_ROOT]),
    keychainWriter(() => app.console2Source().config(), dataDir),
  ], () => {
    const source = app.console2Source();
    const ids = new Map(source.channels().map((channel) => [channel.id, { id: channel.id, name: channel.name }]));
    for (const id of [...Object.keys(source.config().channels), ...Object.keys(source.config().openbao?.channels ?? {}), ...Object.keys(source.config().keychain?.channels ?? {})]) {
      if (!ids.has(id)) ids.set(id, { id, name: undefined });
    }
    return [...ids.values()];
  });
  const web = webServerPlan(config);
  const webServer = new ArtifactServer(web, dataDir, {}, () => app.consoleSource(), app.connectorOAuth, app.statusSource(), () => ({ ...app.console2Source(), secrets, scopedSecrets }));

  const backups = new BackupRunner(dataDir, {
    enabled: config.backups.enabled,
    cron: config.backups.cron,
    timezone: config.backups.timezone ?? config.schedules.timezone,
    directory: resolveBackupDirectory(dataDir, config.backups.directory, REPO_ROOT),
    keepLast: config.backups.keepLast,
  });

  await app.start();
  await webServer.start();
  backups.start();
  if (web.enabled) logger.info(`web server listening on ${web.host}:${web.port} (${[web.console && "console", web.artifacts && "artifacts"].filter(Boolean).join(" + ")})`);
  logger.info(`${config.name} is running. Socket Mode — no inbound ports required.`);

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info(`${signal} received, shutting down…`);
    await boundedShutdown(async () => {
      stopMemoryDiagnostics();
      backups.stop();
      await Promise.all([webServer.stop(), app.stop()]);
    }, (code) => process.exit(code));
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
