import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AuthEvent, AuthPrompt } from "@earendil-works/pi-ai";
import { loadConfig } from "../config/load.ts";
import { resolveAuthPath, setAuthPath } from "../agent/credentials.ts";
import { listModels } from "../agent/model.ts";
import { registerConfiguredModelProviders } from "../agent/model-providers.ts";

/**
 * Sign in to a model provider, writing to the harness's own credential store.
 *
 * The harness is built on the pi SDK, not its CLI, so authentication belongs
 * here too: borrowing another tool's login and then pointing `authPath` at its
 * file works, but it makes a second install a prerequisite and leaves
 * credentials somewhere the harness does not own.
 *
 *   npm run login                    # pick a provider
 *   npm run login -- openai-codex    # ChatGPT subscription
 *   npm run login -- anthropic --api-key
 *   npm run login -- --list          # show what is signed in
 *   npm run login -- --logout openai-codex
 */

function terminal() {
  const rl = createInterface({ input: stdin, output: stdout });

  /** Read without echoing, so pasted keys and tokens do not linger on screen. */
  const secret = async (message: string): Promise<string> => {
    const wasRaw = stdin.isTTY ? stdin.isRaw : false;
    const iface = rl as unknown as { output?: { write(chunk: string): void } };
    const original = iface.output?.write.bind(iface.output);
    let muted = false;

    if (original && iface.output) {
      iface.output.write = (chunk: string) => {
        if (!muted) original(chunk);
      };
    }
    const answer = rl.question(`${message} `);
    muted = true;
    const value = await answer;
    muted = false;
    if (original && iface.output) iface.output.write = original;
    stdout.write("\n");
    if (stdin.isTTY && wasRaw !== stdin.isRaw) stdin.setRawMode?.(wasRaw);
    return value.trim();
  };

  return { rl, secret };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const wantsApiKey = argv.includes("--api-key");
  const wantsList = argv.includes("--list");
  const logoutIndex = argv.indexOf("--logout");
  const positional = argv.filter((a) => !a.startsWith("--"));

  const { config, dataDir, configPath } = loadConfig(process.env.HARNESS_CONFIG);
  const authPath = resolveAuthPath(config.authPath, dataDir);
  setAuthPath(authPath);

  console.log(`config: ${configPath}`);
  console.log(`auth:   ${authPath}\n`);

  const runtime = await ModelRuntime.create({ authPath });
  registerConfiguredModelProviders(runtime, config.modelProviders);

  if (wantsList) {
    const credentials = await runtime.listCredentials();
    if (credentials.length === 0) {
      console.log("No stored credentials. Run `npm run login` to add one.");
    } else {
      console.log("Signed in:");
      for (const c of credentials) {
        console.log(`  ${c.providerId}  (${c.type})`);
      }
    }
    const usable = listModels({ catalog: runtime, onlyAvailable: true });
    const providers = [...new Set(usable.map((m) => m.provider))];
    console.log(
      `\nUsable models: ${usable.length}${providers.length > 0 ? ` from ${providers.join(", ")}` : ""}`,
    );
    process.exit(0);
  }

  if (logoutIndex !== -1) {
    const target = argv[logoutIndex + 1] ?? positional[0];
    if (!target) throw new Error("Usage: npm run login -- --logout <provider>");
    await runtime.removeRuntimeApiKey(target).catch(() => undefined);
    console.log(`Removed stored credentials for ${target}.`);
    process.exit(0);
  }

  // --- Pick a provider ----------------------------------------------------
  const providers = runtime
    .getProviders()
    .filter((p) => (p as any).auth?.oauth || (p as any).auth?.apiKey?.login);

  let providerId = positional[0];
  const { rl, secret } = terminal();

  try {
    if (!providerId) {
      console.log("Providers you can sign in to:\n");
      const subscription = providers.filter((p) => (p as any).auth?.oauth?.isSubscription);
      const others = providers.filter((p) => !(p as any).auth?.oauth?.isSubscription);

      if (subscription.length > 0) {
        console.log("  Subscription (sign in with an existing plan):");
        for (const p of subscription) {
          console.log(`    ${p.id.padEnd(18)} ${(p as any).auth.oauth.name}`);
        }
      }
      console.log("\n  API key:");
      for (const p of others) console.log(`    ${p.id}`);

      providerId = (await rl.question("\nProvider: ")).trim();
    }

    const provider = providers.find((p) => p.id === providerId);
    if (!provider) {
      throw new Error(`Unknown provider "${providerId}". Run without arguments to see the list.`);
    }

    const auth = (provider as any).auth;
    const type: "oauth" | "api_key" = !wantsApiKey && auth?.oauth ? "oauth" : "api_key";
    if (type === "oauth" && !auth?.oauth) {
      throw new Error(`${providerId} does not support OAuth. Use --api-key.`);
    }
    if (type === "api_key" && !auth?.apiKey?.login) {
      throw new Error(`${providerId} has no interactive API-key setup; set its env var instead.`);
    }

    console.log(`\nSigning in to ${provider.name} (${type === "oauth" ? "OAuth" : "API key"})…\n`);

    const credential = await runtime.login(providerId, type, {
      async prompt(p: AuthPrompt): Promise<string> {
        switch (p.type) {
          case "secret":
            return secret(p.message);
          case "select": {
            console.log(`\n${p.message}`);
            p.options.forEach((o, i) => {
              console.log(`  ${i + 1}. ${o.label}${o.description ? ` — ${o.description}` : ""}`);
            });
            const answer = (await rl.question("Choice: ")).trim();
            const byIndex = p.options[Number(answer) - 1];
            const byId = p.options.find((o) => o.id === answer);
            const chosen = byIndex ?? byId;
            if (!chosen) throw new Error(`"${answer}" is not one of the options.`);
            return chosen.id;
          }
          case "manual_code":
          case "text":
          default:
            return (await rl.question(`${p.message} `)).trim();
        }
      },
      notify(event: AuthEvent): void {
        switch (event.type) {
          case "auth_url":
            console.log(`\nOpen this in a browser to continue:\n  ${event.url}\n`);
            if (event.instructions) console.log(event.instructions);
            break;
          case "device_code":
            console.log(`\nGo to ${event.verificationUri} and enter code: ${event.userCode}\n`);
            break;
          case "info":
            console.log(event.message);
            for (const link of event.links ?? []) {
              console.log(`  ${link.label ? `${link.label}: ` : ""}${link.url}`);
            }
            break;
          case "progress":
            console.log(`… ${event.message}`);
            break;
        }
      },
    });

    console.log(`\nSigned in to ${providerId} (${credential.type}).`);

    const usable = listModels({ catalog: runtime, onlyAvailable: true }).filter((m) => m.provider === providerId);
    if (usable.length > 0) {
      console.log(`\n${usable.length} model(s) now available, for example:`);
      for (const m of usable.slice(0, 5)) console.log(`  ${m.ref}`);
      console.log(`\nSet one as the default in ${configPath}:`);
      console.log(`  defaults:\n    model: ${usable[0]!.ref}`);
    }
  } finally {
    rl.close();
  }
}

main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
