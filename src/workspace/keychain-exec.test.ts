import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HarnessConfigSchema } from "../config/schema.ts";
import { KeychainSchema } from "../config/keychain-schema.ts";
import { createExecTools } from "../agent/exec-tools.ts";
import { createSharedToolTools } from "../agent/shared-tool-tools.ts";
import { publishSharedTool } from "../agent/shared-bin.ts";
import { workspaceFixture } from "./fixture.ts";

// No real Keychain or container runtime is needed: these routes execute on the
// host for BOTH sandbox backends. The dummy private helper leaves a marker so
// the positive control proves the planted code actually reached the host.
const keychain = () => KeychainSchema.parse({ helperPath: "/private/helper", mainProcess: ["MAIN"] });
const executable = (path: string, source: string) => writeFileSync(path, `#!${process.execPath}\n${source}\n`, { mode: 0o755 });

for (const mode of ["docker", "macos-container", "kiri"] as const) {
  for (const route of ["workspace PATH", "relative path", "absolute path", "command PATH", "account CLI", "shared script", "pinned shared script"] as const) {
    test(`Keychain blocks ${route} reaching the host helper for ${mode}`, async (t) => {
      const sharedScript = route === "shared script" || route === "pinned shared script";
      const f = workspaceFixture({
        defaults: { sandbox: { mode } },
        cliTools: { gh: { command: "gh", allowArgs: [["--version"]] } },
        channels: {
          C1: {
            tools: ["bash", ...(sharedScript ? [] : ["exec"])],
            exec: route === "account CLI" ? { shared: ["gh"] } : sharedScript ? {} : { commands: { gh: { command: "gh", allowArgs: [["--version"]] } } },
            share: sharedScript ? { sharedTools: { planted: { allowArgs: [["--version"]] } } } : {},
          },
          C2: { share: { sharedToolsPublish: true } },
        },
      });
      t.after(() => rmSync(f.dataDir, { recursive: true, force: true }));
      const initial = f.resolve("C1");
      const marker = join(f.dataDir, "host-helper-called");
      const helper = join(f.dataDir, "private-dummy-helper");
      executable(helper, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'main-only-read');`);
      const source = `import { execFileSync } from 'node:child_process'; execFileSync(${JSON.stringify(helper)}, []);`;
      const planted = join(initial.paths.bin, "gh");
      executable(planted, source);
      if (sharedScript) {
        const entry = publishSharedTool(f.shared, f.resolve("C2"), { name: "planted", description: "Dummy host helper call", content: `#!${process.execPath}\n${source}\n` });
        if (route === "pinned shared script") f.config.channels.C1!.share.sharedTools.planted!.sha256 = entry.sha256;
      } else if (route !== "account CLI") {
        const command = f.config.channels.C1!.exec!.commands!.gh!;
        if (route === "relative path") command.command = "./bin/gh";
        if (route === "absolute path") command.command = planted;
        if (route === "command PATH") command.env.PATH = initial.paths.bin;
      }
      const call = async () => {
        const channel = f.resolve("C1");
        assert.equal(channel.env.MAIN, undefined);
        const [tool] = sharedScript
          ? createSharedToolTools({ channel, cwd: channel.paths.workspace })
          : createExecTools({ config: channel.exec, cwd: channel.paths.workspace, binDir: channel.paths.bin, globalBinDir: channel.globalBin, env: channel.env });
        return tool!.execute("test", { args: ["--version"] }, undefined, undefined, undefined as never);
      };
      await call();
      assert.equal(existsSync(marker), true, "positive control must reach the host helper without Keychain");
      rmSync(marker);
      f.config.keychain = keychain();
      const parsed = HarnessConfigSchema.safeParse(f.config);
      assert.equal(parsed.success, false, "normal config validation must fail closed");
      if (!parsed.success) assert.match(parsed.error.message, /Keychain forbids host/);
      // Bypass parsing deliberately to verify effective resolution also guards
      // existing/mutated config objects before tool construction or imports.
      await assert.rejects(call, /Keychain forbids host/);
      assert.equal(existsSync(marker), false, "no planted code may reach the host helper");
      f.config.keychain.acceptHostExecutionRisk = true;
      assert.equal(HarnessConfigSchema.safeParse(f.config).success, true);
      await call();
      assert.equal(existsSync(marker), true, "accepted risk deliberately permits same-user helper access");
    });
  }
}

test("Keychain checks defaults, inherited exec and shared-tool allowlists, regardless of sandbox", () => {
  for (const mode of ["host", "docker", "macos-container", "kiri"] as const) {
    for (const settings of [{ tools: ["exec"] }, { share: { sharedTools: { planted: {} } } }]) {
      for (const location of ["defaults", "channel", "inherited"] as const) {
        const config = {
          keychain: keychain(),
          defaults: { sandbox: { mode }, ...(location !== "channel" ? settings : {}) },
          channels: location === "defaults" ? {} : { C1: location === "channel" ? settings : {} },
        };
        const result = HarnessConfigSchema.safeParse(config);
        assert.equal(result.success, false, `${mode} ${location} ${JSON.stringify(settings)}`);
        if (!result.success) assert.match(result.error.message, /Keychain forbids host/);
      }
    }
  }
});

test("Keychain runtime guard covers inherited and unconfigured channel policies", (t) => {
  for (const settings of [{ tools: ["exec"] }, { share: { sharedTools: { planted: {} } } }]) {
    const f = workspaceFixture({ defaults: settings, channels: { C1: settings } });
    t.after(() => rmSync(f.dataDir, { recursive: true, force: true }));
    f.config.keychain = keychain(); // Deliberately bypass schema validation.
    for (const id of ["C1", "CUNCONFIGURED"]) {
      assert.throws(() => f.resolve(id), /Keychain forbids host/);
    }
  }
  const inherited = workspaceFixture({ defaults: { tools: ["exec"] }, channels: { C1: {} } });
  t.after(() => rmSync(inherited.dataDir, { recursive: true, force: true }));
  inherited.config.keychain = keychain();
  assert.throws(() => inherited.resolve("C1"), /Keychain forbids host CLI execution/);
});

test("Keychain permits container bash, inert CLI definitions and publishing without execution", (t) => {
  for (const mode of ["docker", "macos-container", "kiri"] as const) {
    const f = workspaceFixture({
      keychain: KeychainSchema.parse({ helperPath: "/private/helper" }),
      cliTools: { unused: { command: "gh" } },
      defaults: { sandbox: { mode }, tools: ["bash"] },
      channels: { C1: { exec: { shared: ["unused"] }, share: { sharedToolsPublish: true } } },
    });
    t.after(() => rmSync(f.dataDir, { recursive: true, force: true }));
    const channel = f.resolve("C1");
    assert.deepEqual(channel.tools, ["bash"]);
    assert.equal(channel.sandbox.mode, mode);
    assert.deepEqual(createSharedToolTools({ channel, cwd: channel.paths.workspace }).map((tool) => tool.name).sort(),
      ["list_shared_tools", "publish_shared_tool", "read_shared_tool", "unpublish_shared_tool"].sort());
  }
});
