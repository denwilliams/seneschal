import { kiriUnavailableReason } from "../agent/sandbox-kiri.ts";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { keychainRiskWarning } from "../config/keychain-policy.ts";
import { openBaoRiskWarning } from "../config/openbao-policy.ts";
import { loadConfig } from "../config/load.ts";
import { initializeOpenBao, applyOpenBaoProviderKeys, mainProcessSecret } from "../config/openbao.ts";
import { applyKeychainProviderKeys, keychainMainSecret, validateKeychainHost } from "../config/keychain.ts";
import { scopedChannelEnvironment } from "../config/secret-environment.ts";
import { checkRequirements, describeMissing, mergeRequirements } from "../config/requirements.ts";
import { channelPaths, ensureSharedDirs } from "../workspace/paths.ts";
import { ChannelRegistry } from "../workspace/registry.ts";
import { findLegacyFlatSkills } from "../workspace/collections.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { isAllowed, listModels, parseRef, providerHasCredentials, resolveModel } from "../agent/model.ts";
import { authSourceFor, resolveAuthPath, setAuthPath } from "../agent/credentials.ts";
import { registerConfiguredModelProviders } from "../agent/model-providers.ts";
import {
  channelImageTag,
  describeSandbox,
  containerBackendAvailable,
  isContainerMode,
  appleConfigProblem,
  appleHostProblem,
  dockerWorkspaceMountSource,
  sandboxImageExists,
} from "../agent/sandbox.ts";
import { layerEnv, readEnvFile, resolveEnvPath } from "../config/envfile.ts";
import { hasPdftotext } from "../agent/extract.ts";
import { REPO_ROOT } from "../config/load.ts";

/**
 * Pre-flight check. Prints what each configured channel would get, so the
 * isolation boundaries are visible before anyone talks to the bot.
 */

async function main(): Promise<void> {
  const { config, dataDir, configPath } = loadConfig(process.env.HARNESS_CONFIG);
  const openBaoWarning = openBaoRiskWarning(config);
  if (openBaoWarning) console.warn(`WARNING: ${openBaoWarning}`);
  const keychainWarning = keychainRiskWarning(config);
  if (keychainWarning) console.warn(`WARNING: ${keychainWarning}`);
  ensureSharedDirs(dataDir);
  await initializeOpenBao(config, { forbiddenRoots: [dataDir, REPO_ROOT] });
  const registry = new ChannelRegistry(dataDir);
  validateKeychainHost(config, dataDir);

  console.log(`config:   ${configPath}`);
  console.log(`data dir: ${dataDir}`);
  console.log(`name:     ${config.name}\n`);

  let failed = false;

  const accountEnv = { ...process.env };
  for (const name of config.requires.env) {
    const value = keychainMainSecret(config, name) ?? mainProcessSecret(config, name);
    if (value !== undefined) accountEnv[name] = value;
  }
  const account = checkRequirements(config.requires, accountEnv);
  console.log("Account requirements:");
  if (account.checks.length === 0) console.log("  (none declared)");
  for (const c of account.checks) {
    console.log(`  ${c.ok ? "OK  " : "MISS"} ${c.kind} ${c.name}${c.detail ? ` -> ${c.detail}` : ""}`);
  }
  if (!account.ok && account.onMissing === "fail") failed = true;

  // Not a hard requirement — bundled pdf.js handles normal PDFs — but poppler
  // remains a useful fast path when it is installed.
  console.log(
    hasPdftotext()
      ? "\nPDF text:  pdftotext (poppler) found; bundled pdf.js is available as fallback"
      : "\nPDF text:  bundled pdf.js available; no pdftotext on PATH.\n" +
          "           Install poppler-utils only if you want the optional fast path.",
  );

  const authPath = resolveAuthPath(config.authPath, dataDir);
  setAuthPath(authPath);
  const modelRuntime = await ModelRuntime.create({ authPath });
  registerConfiguredModelProviders(modelRuntime, config.modelProviders);
  await applyOpenBaoProviderKeys(config, modelRuntime);
  await applyKeychainProviderKeys(config, modelRuntime);
  console.log(`auth:     ${authPath}${existsSync(authPath) ? "" : "  (not present)"}\n`);

  const available = listModels({ catalog: modelRuntime, onlyAvailable: true });
  console.log("Models available:");
  if (available.length === 0) {
    console.log("  NONE. Configure a provider one of two ways:");
    console.log("    API key      — set DEEPSEEK_API_KEY, OPENAI_API_KEY, ... in the environment");
    console.log("    Subscription — run `npx pi`, use /login, then point authPath at that auth.json");
    failed = true;
  } else {
    const byProvider = new Map<string, number>();
    for (const m of available) byProvider.set(m.provider, (byProvider.get(m.provider) ?? 0) + 1);
    for (const [provider, count] of byProvider) {
      const source = config.keychain?.providerKeys[provider]
        ? "macOS Keychain"
        : config.modelProviders[provider]
        ? "configured provider"
        : authSourceFor(provider) === "env"
          ? "API key"
          : "subscription/OAuth";
      console.log(`  ${provider}: ${count} model(s)  [${source}]`);
    }
  }

  console.log("\nChannels:");
  const names = Object.keys(config.channels);
  if (names.length === 0) console.log("  (none configured; all channels use defaults)");

  for (const key of names) {
    const entry = config.channels[key]!;
    // Per-channel secrets and implicit env files are keyed by durable Slack ID,
    // never a configured alias or an arbitrary imported channel.
    const channelId = registry.resolveId(key);
    const share = entry.share;
    const tools = entry.tools ?? config.defaults.tools;
    const connectors = [...share.connectors, ...Object.keys(entry.connectors)];

    const model = entry.model ?? config.defaults.model;
    const allow = entry.models ?? config.defaults.models;

    console.log(`\n  ${key}`);
    console.log(`    model:      ${model}`);
    console.log(`    can switch: ${allow.length > 0 ? allow.join(", ") : "any available model"}`);

    // A channel pinned to a model it cannot reach would fail on first message.
    try {
      resolveModel(model, modelRuntime);
      if (!providerHasCredentials(parseRef(model, modelRuntime)?.provider ?? "", modelRuntime)) {
        console.log(`    WARNING: no API key configured for this model's provider`);
        failed = true;
      }
    } catch (err) {
      console.log(`    ERROR: ${err instanceof Error ? err.message : String(err)}`);
      failed = true;
    }
    if (allow.length > 0 && !isAllowed(model, allow, modelRuntime)) {
      console.log(`    WARNING: the configured model is not in this channel's own allowlist`);
      failed = true;
    }

    console.log(`    tools:      ${tools.join(", ") || "none"}`);
    if (tools.includes("bash")) {
      const configured = { ...config.defaults.sandbox, ...(entry.sandbox ?? {}) };
      // The config can be keyed by a human-friendly name while workspaces are
      // keyed by Slack ID. Use the learned ID when available; for an unseen
      // named channel, doctor prints a template rather than a false exact path.
      const paths = channelPaths(dataDir, channelId ?? key);
      const dockerfile = paths.dockerfile;
      const hasDockerfile = isContainerMode(configured.mode) && existsSync(dockerfile);
      const sandbox = hasDockerfile
        ? { ...configured, image: channelImageTag(channelId ?? key) }
        : configured;
      console.log(`    bash:       ${describeSandbox(sandbox, hasDockerfile ? dockerfile : undefined)}`);
      if (isContainerMode(sandbox.mode)) {
        try {
          const workspace = channelId
            ? paths.workspace
            : join(dataDir, "channels", "<Slack channel ID>", "workspace");
          const source = sandbox.mode === "macos-container" ? workspace : dockerWorkspaceMountSource(workspace, dataDir);
          const problem = sandbox.mode === "macos-container" ? appleConfigProblem(sandbox) ?? appleHostProblem() : undefined;
          if (problem) throw new Error(problem);
          const suffix = channelId
            ? "writable bind mount"
            : `template; config name ${JSON.stringify(key)} has not been resolved to a Slack ID yet`;
          console.log(`      workspace:  ${source} -> /workspace (${suffix})`);
        } catch (err) {
          console.log(`      MISSING: ${err instanceof Error ? err.message : String(err)}`);
          failed = true;
        }
        if (!containerBackendAvailable(sandbox.mode)) {
          console.log(`      MISSING: ${sandbox.mode} is not available/compatible, so bash cannot run here${sandbox.mode === "macos-container" ? " (requires native macOS 26+, container 1.6.1+ 1.x client/server, and container system start)" : sandbox.mode === "kiri" ? `: ${kiriUnavailableReason()}` : ""}`);
          failed = true;
        } else if (hasDockerfile) {
          console.log(
            `      image is built from ${dockerfile}` +
              `${sandboxImageExists(sandbox.image, sandbox.mode) ? "" : " — on the first bash command"}`,
          );
        } else if (!sandboxImageExists(sandbox.image, sandbox.mode)) {
          console.log(
            `      MISSING: image "${sandbox.image}" — build it, or drop a Dockerfile in ${paths.root}`,
          );
          failed = true;
        }
      } else {
        console.log(`      NOTE: bash on the host can reach other channels' data`);
      }
    }
    if (tools.includes("exec")) {
      // Registry entries are definition-only: only this channel's explicit
      // exec.shared allowlist turns one into an executable CLI.
      const selectedShared = Object.fromEntries(
        (entry.exec?.shared ?? [])
          .filter((name) => Object.hasOwn(config.cliTools, name))
          .map((name) => [name, config.cliTools[name]!]),
      );
      const exec = {
        commands: {
          ...config.defaults.exec.commands,
          ...selectedShared,
          ...(entry.exec?.commands ?? {}),
        },
      };
      const names = Object.keys(exec.commands);
      console.log(`    exec:       ${names.length ? names.join(", ") : "enabled but no commands configured"}`);
      if (names.length === 0) failed = true;
      for (const [name, command] of Object.entries(exec.commands)) {
        if (command.allowArgs.some((pattern) => pattern.includes("**") && pattern.at(-1) !== "**")) {
          console.log(`      WARNING: ${name} has ** outside the final argv position`);
          failed = true;
        }
      }
    }
    if (tools.includes("web")) {
      const web = {
        ...config.defaults.web,
        ...(entry.web ?? {}),
        search: { ...config.defaults.web.search, ...(entry.web?.search ?? {}) },
      };
      const search =
        web.search.provider === "none"
          ? "no search provider (fetch_url + download_url)"
          : `search via ${web.search.provider}`;
      console.log(`    web:        ${search}${web.allowPrivateHosts ? ", private addresses allowed" : ""}`);
      if (web.search.provider === "brave" || web.search.provider === "tavily") {
        // ${VAR} is expanded per channel at runtime; an empty literal here is
        // the case that fails on the first search rather than at startup.
        if (!web.search.apiKey) {
          console.log(`      MISSING: web.search.apiKey is empty, so search will fail`);
          failed = true;
        }
      }
      if (web.search.provider === "searxng" && !web.search.url) {
        console.log(`      MISSING: web.search.url is empty, so search will fail`);
        failed = true;
      }
    }
    if (tools.includes("images")) {
      const images = { ...config.defaults.images, ...(entry.images ?? {}) };
      console.log(
        `    images:     ${
          images.provider === "none"
            ? "enabled but no provider configured"
            : `${images.provider}/${images.model} (${images.size}, ${images.outputFormat}${images.authProvider ? `, auth: ${images.authProvider}` : ""})`
        }`,
      );
      if (images.provider !== "none" && !images.apiKey && !images.authProvider) {
        console.log(`      MISSING: images.apiKey is empty and images.authProvider is unset, so generate_image will fail`);
        failed = true;
      }
    }
    console.log(`    knowledge:  ${share.knowledge === true ? "all" : share.knowledge === false ? "none" : share.knowledge.join(", ")}`);
    console.log(
      `    skills:     ${share.skillCollections.map((c) => `${c.name} (${c.mode})`).join(", ") || "channel-private only"}`,
    );
    for (const c of share.skillCollections) {
      if (!existsSync(join(dataDir, "shared", "skills", c.name))) {
        console.log(`      MISSING: skill collection "${c.name}" does not exist under data/shared/skills, so it is skipped`);
        failed = true;
      }
    }
    if (findLegacyFlatSkills(join(dataDir, "shared", "skills")).length > 0) {
      console.log(`      WARNING: flat shared skills found under data/shared/skills are NOT loaded; run \`npm run migrate-skills\``);
    }
    console.log(`    connectors: ${connectors.join(", ") || "none"}`);
    console.log(`    acct memory:${share.memoryWrite ? " read+write" : share.memoryRead ? " read" : " none"}`);
    console.log(
      `    documents:  ${
        share.documents
          ? share.documentsAdd
            ? "read + file"
            : "read only"
          : share.documentsAdd
            ? "file only"
            : "no access"
      }`,
    );
    if (share.channelMemoryRead.length > 0) {
      console.log(`    reads memory of: ${share.channelMemoryRead.join(", ")}`);
    }

    // Match the runtime as closely as possible: env requirements can be
    // satisfied by an env file, not just the process environment. Without an
    // explicit envFile the runtime reads data/channels/<id>/env, which can be
    // checked once the Slack id is known; for an unseen named channel it is
    // called out instead.
    const merged = mergeRequirements(config.requires, entry.requires);
    const channelEnvPath = entry.envFile
      ? resolveEnvPath(entry.envFile, REPO_ROOT)
      : channelId
      ? join(channelPaths(dataDir, channelId).root, "env")
      : undefined;
    const { bundle: channelEnv } = layerEnv([
      { label: "process", values: process.env as Record<string, string>, ambient: true },
      ...(config.envFile
        ? [{ label: "global", values: readEnvFile(resolveEnvPath(config.envFile, REPO_ROOT)) }]
        : []),
      ...(channelEnvPath ? [{ label: "channel", values: readEnvFile(channelEnvPath) }] : []),
    ]);
    let scopedEnv: Record<string, string>;
    try {
      // Unknown named channels have no private imports yet; global/main isolation still applies.
      scopedEnv = scopedChannelEnvironment(config, channelId ?? key, channelEnv, dataDir);
    } catch {
      console.log("    ERROR: Scoped channel imports unavailable; check configured scopes and host permissions.");
      failed = true;
      continue;
    }
    const report = checkRequirements(merged, scopedEnv);
    if (report.missing.length > 0) {
      console.log(`    requirements MISSING:\n${describeMissing(report).replace(/^/gm, "    ")}`);
      if (!channelEnvPath && report.missing.some((m) => m.kind === "env")) {
        console.log(`      (an env var may still be supplied by data/channels/<id>/env at runtime)`);
      }
      if (report.onMissing === "fail") failed = true;
    }

    for (const name of share.connectors) {
      if (!config.connectors[name]) {
        console.log(`    WARNING: connector "${name}" is not defined in the catalogue`);
        failed = true;
      }
    }
  }

  console.log(failed ? "\nFAILED: fix the issues above before starting." : "\nAll checks passed.");
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
