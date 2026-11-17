import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ContextOverrideSchema,
  ContextSchema,
  ExecOverrideSchema,
  ExecSchema,
  HarnessConfigSchema,
  ImageGenerationOverrideSchema,
  ImageGenerationSchema,
  PermissionsOverrideSchema,
  PermissionsSchema,
  RecentConversationsOverrideSchema,
  RecentConversationsSchema,
  SandboxOverrideSchema,
  SandboxSchema,
  ShortcutsSchema,
  WebOverrideSchema,
  WebSchema,
  WorkspaceOverrideSchema,
  WorkspaceSchema,
} from "./schema.ts";

/**
 * The override schemas are written out by hand so they carry no defaults.
 * These guard the two ways that can go wrong: drifting out of step with the
 * full schema, and quietly re-introducing a default.
 */

function keysOf(schema: any): string[] {
  const inner = schema.def?.innerType ?? schema;
  return Object.keys(inner.shape ?? inner.def?.shape ?? {}).sort();
}

test("sandbox override covers exactly the same keys as the full schema", () => {
  assert.deepEqual(keysOf(SandboxOverrideSchema), keysOf(SandboxSchema));
});

test("permissions override covers exactly the same keys as the full schema", () => {
  assert.deepEqual(keysOf(PermissionsOverrideSchema), keysOf(PermissionsSchema));
});

test("context override covers exactly the same keys as the full schema", () => {
  assert.deepEqual(keysOf(ContextOverrideSchema), keysOf(ContextSchema));
});

test("web override covers exactly the same keys as the full schema", () => {
  assert.deepEqual(keysOf(WebOverrideSchema), keysOf(WebSchema));
});

test("image generation override covers exactly the same keys as the full schema", () => {
  assert.deepEqual(keysOf(ImageGenerationOverrideSchema), keysOf(ImageGenerationSchema));
});

test("exec override covers exactly the same keys as the full schema", () => {
  assert.deepEqual(keysOf(ExecOverrideSchema), keysOf(ExecSchema));
});

test("recent conversations override covers exactly the same keys as the full schema", () => {
  assert.deepEqual(keysOf(RecentConversationsOverrideSchema), keysOf(RecentConversationsSchema));
});

test("workspace override covers exactly the same keys as the full schema", () => {
  assert.deepEqual(keysOf(WorkspaceOverrideSchema), keysOf(WorkspaceSchema));
});

test("HTTP connector OAuth manual completion sessions default to ten minutes and stay bounded", () => {
  const parsed = HarnessConfigSchema.parse({
    connectors: {
      calendar: {
        transport: "http",
        url: "https://mcp.example.test",
        oauth: { redirectUrl: "https://oauth-complete.example.test/" },
      },
    },
  });
  const calendar = parsed.connectors.calendar!;
  if (calendar.transport !== "http") assert.fail("calendar should be an HTTP connector");
  assert.equal(calendar.oauth!.manualCompletionTtlSeconds, 600);
  assert.throws(
    () => HarnessConfigSchema.parse({ connectors: { calendar: { transport: "http", url: "https://mcp.example.test", oauth: { redirectUrl: "https://oauth-complete.example.test/", manualCompletionTtlSeconds: 30 } } } }),
    /manualCompletionTtlSeconds/,
  );
});

test("an override fills in nothing it was not given", () => {
  // The whole point: spreading this over the defaults must not reset them.
  assert.deepEqual(SandboxOverrideSchema.parse({ network: "bridge" }), { network: "bridge" });
  assert.deepEqual(PermissionsOverrideSchema.parse({ maxMinutes: 60 }), { maxMinutes: 60 });
  assert.deepEqual(ImageGenerationOverrideSchema.parse({ model: "dall-e-3" }), { model: "dall-e-3" });
  assert.deepEqual(SandboxOverrideSchema.parse({}), {});
  assert.deepEqual(RecentConversationsOverrideSchema.parse({ debounceSeconds: 10 }), { debounceSeconds: 10 });
  assert.deepEqual(WorkspaceOverrideSchema.parse({ symlinkTargets: ["/srv/project"] }), {
    symlinkTargets: ["/srv/project"],
  });
});

test("the full schemas still supply defaults", () => {
  const sandbox = SandboxSchema.parse({});
  assert.equal(sandbox.mode, "host");
  assert.equal(sandbox.network, "none");

  const permissions = PermissionsSchema.parse({});
  assert.deepEqual(permissions.grantable, ["network", "web"]);
  assert.equal(permissions.allowPermanent, false);

  // Reading the web is on, but only ever as a public-internet GET: reaching
  // the network the harness itself sits on is a separate decision.
  const web = WebSchema.parse({});
  assert.equal(web.allowPrivateHosts, false);
  assert.equal(web.search.provider, "none");
  assert.equal(web.downloadMaxBytes, 20 * 1024 * 1024);

  const exec = ExecSchema.parse({});
  assert.deepEqual(exec.commands, {});

  assert.deepEqual(WorkspaceSchema.parse({}).symlinkTargets, []);

  const images = ImageGenerationSchema.parse({});
  assert.equal(images.provider, "none");
  assert.equal(images.model, "gpt-image-1");
  assert.equal(images.authProvider, "");

  // Reading the thread you were tagged into is the default; reading a channel
  // nobody invited you into the middle of is not.
  const context = ContextSchema.parse({});
  assert.equal(context.threadBackfill, 50);
  assert.equal(context.channelBackfill, 0);
  assert.equal(context.dmBackfill, 20);

  const recent = RecentConversationsSchema.parse({});
  assert.equal(recent.enabled, true);
  assert.equal(recent.debounceSeconds, 60);
  assert.equal(recent.maxThreads, 10);
  assert.equal(recent.model, "deepseek-flash");
});

test("backups are on by default with bounded rotation", () => {
  const config = HarnessConfigSchema.parse({});

  assert.deepEqual(config.defaults.tools, ["read", "write", "edit", "ls", "find", "grep", "sqlite", "charts", "slides", "file_ops", "web"]);
  assert.equal(config.backups.enabled, true);
  assert.equal(config.backups.cron, "30 2 * * *");
  assert.equal(config.backups.directory, "");
  assert.equal(config.backups.keepLast, 14);
  assert.equal(config.channelTopicUsage.enabled, false);
  assert.equal(config.channelTopicUsage.channel, "");
  assert.equal(config.notifications.enabled, true);
  assert.equal(config.notifications.channel, "");
  assert.equal(config.notifications.maxPending, 200);
  assert.equal(config.notifications.maxMessageChars, 4000);
  assert.equal(config.shortcuts.sendToAssistant.defaultChannel, "");
  assert.equal(ShortcutsSchema.parse({ sendToAssistant: { defaultChannel: "#admin" } }).sendToAssistant.defaultChannel, "#admin");
  assert.deepEqual(config.defaults.share.delegateTo, []);
});

test("whole-CLI access is an explicit boolean opt-in on exec commands, not shared-bin tools", () => {
  const config = HarnessConfigSchema.parse({
    cliTools: { restricted: { command: "mycli", allowArgs: [["**"]] }, trusted: { command: "mycli", allowAllArgs: true } },
    channels: { ops: { exec: { commands: { local: { command: "mycli", allowAllArgs: true }, restricted: { command: "mycli", allowAllArgs: false } } },
      share: { sharedTools: { script: { allowAllArgs: true, allowArgs: [["**"]] } } } } },
  });
  assert.equal(config.cliTools.restricted?.allowAllArgs, false);
  assert.equal(config.cliTools.trusted?.allowAllArgs, true);
  assert.deepEqual(config.cliTools.trusted?.allowArgs, []);
  assert.equal(config.channels.ops?.exec?.commands?.local?.allowAllArgs, true);
  assert.equal(config.channels.ops?.exec?.commands?.restricted?.allowAllArgs, false);
  assert.equal(Object.hasOwn(config.channels.ops!.share!.sharedTools!.script!, "allowAllArgs"), false);
  for (const allowAllArgs of ["true", 1, null]) {
    assert.equal(HarnessConfigSchema.safeParse({ cliTools: { bad: { command: "mycli", allowAllArgs } } }).success, false);
  }
});

test("shared CLI registry entries are inert until a channel explicitly allowlists them", () => {
  const parsed = HarnessConfigSchema.parse({
    cliTools: {
      release: { command: "/usr/local/bin/release", allowArgs: [["status"]] },
    },
    channels: { deploys: { exec: { shared: ["release"] } } },
  });
  assert.equal(parsed.cliTools.release?.command, "/usr/local/bin/release");
  assert.deepEqual(parsed.channels.deploys?.exec?.shared, ["release"]);

  const invalid = (input: unknown, expected: RegExp) => {
    const result = HarnessConfigSchema.safeParse(input);
    assert.equal(result.success, false);
    if (!result.success) assert.match(result.error.issues.map((issue) => issue.message).join("\n"), expected);
  };
  invalid({ channels: { deploys: { exec: { shared: ["missing"] } } } }, /no account-wide cliTools entry/);
  invalid(
    { cliTools: { release: { command: "release" } }, channels: { deploys: { exec: { shared: ["release", "release"] } } } },
    /listed more than once/,
  );
  invalid(
    { cliTools: { release: { command: "release" } }, defaults: { exec: { shared: ["release"] } } },
    /must be allowlisted per channel/,
  );
  invalid(
    {
      cliTools: { release: { command: "release" } },
      channels: { deploys: { exec: { commands: { release: { command: "other-release" } }, shared: ["release"] } } },
    },
    /conflicts with local exec.commands entry "release"/,
  );
  // Match the names Pi actually registers, rather than only raw config keys.
  // `foo.bar` normalizes to the same cli__ name as registry `foo_bar`.
  invalid(
    {
      cliTools: { foo_bar: { command: "shared" } },
      defaults: { exec: { commands: { "foo.bar": { command: "local" } } } },
      channels: { deploys: { exec: { shared: ["foo_bar"] } } },
    },
    /both become cli__foo_bar/,
  );
  invalid(
    {
      cliTools: { foo_bar: { command: "shared" } },
      channels: { deploys: { exec: { commands: { "foo.bar": { command: "local" } }, shared: ["foo_bar"] } } },
    },
    /both become cli__foo_bar/,
  );
});

test("shared CLI allowlists cannot select inherited object properties as registry entries", () => {
  for (const name of ["toString", "constructor", "__proto__"]) {
    const missing = HarnessConfigSchema.safeParse({
      channels: { release: { exec: { shared: [name] } } },
    });
    assert.equal(missing.success, false, `${name} must require an explicit registry entry`);
    if (!missing.success) {
      assert.ok(missing.error.issues.some((issue) => issue.message.includes("no account-wide cliTools entry")));
    }
    // Ordinary prototype names remain usable when explicitly declared.
    // Zod deliberately strips __proto__ keys from record output.
    if (name !== "__proto__") {
      const declared = HarnessConfigSchema.parse({
        cliTools: { [name]: { command: "status" } },
        channels: { release: { exec: { shared: [name] } } },
      });
      assert.equal(declared.cliTools[name]?.command, "status");
    }
  }
});

test("shared CLI collision checks account for the 64-character registered tool-name limit", () => {
  const name = "x".repeat(59);
  const commands = { [`${name}-local`]: { command: "local-status" } };
  for (const localScope of ["defaults", "channel"]) {
    const result = HarnessConfigSchema.safeParse({
      cliTools: { [name]: { command: "shared-status" } },
      defaults: localScope === "defaults" ? { exec: { commands } } : {},
      channels: {
        release: { exec: { shared: [name], ...(localScope === "channel" ? { commands } : {}) } },
      },
    });
    assert.equal(result.success, false);
    if (!result.success) {
      assert.ok(result.error.issues.some((issue) => issue.message.includes(`both become cli__${name}`)));
    }
  }
});

test("the one web server is opt-in, requires a browser-facing base URL, and serves artifacts only when asked", () => {
  const defaults = HarnessConfigSchema.parse({});
  assert.equal(defaults.webConsole.enabled, false);
  assert.equal(defaults.webConsole.host, "127.0.0.1");
  assert.equal(defaults.webConsole.port, 3012);
  assert.equal(defaults.webConsole.artifacts, false);
  assert.equal(defaults.webConsole.historyLimit, 100);
  assert.ok(!("artifacts" in defaults), "no top-level artifacts block");
  assert.ok(!("dashboard" in defaults), "no top-level dashboard block");
  assert.equal(HarnessConfigSchema.safeParse({ webConsole: { enabled: true } }).success, false);
  assert.equal(HarnessConfigSchema.safeParse({ webConsole: { enabled: true, artifacts: true } }).success, false);
  assert.equal(HarnessConfigSchema.safeParse({ webConsole: { enabled: true, baseUrl: "https://c.example.test" } }).success, true);
  assert.equal(HarnessConfigSchema.safeParse({ webConsole: { enabled: true, baseUrl: "not a url" } }).success, false);
  assert.equal(HarnessConfigSchema.safeParse({ webConsole: { enabled: true, baseUrl: "ftp://files.example.test" } }).success, false);
  assert.equal(HarnessConfigSchema.safeParse({ webConsole: { enabled: true, baseUrl: "https://files.example.test/?token=secret" } }).success, false);
  assert.equal(HarnessConfigSchema.safeParse({ webConsole: { artifacts: "yes" } }).success, false);
  const configured = HarnessConfigSchema.parse({ webConsole: { enabled: true, artifacts: true, historyLimit: 7, host: "0.0.0.0", port: 4010, baseUrl: "https://files.example.test/static" } });
  assert.equal(configured.webConsole.artifacts, true);
  assert.equal(configured.webConsole.historyLimit, 7);
  assert.equal(configured.webConsole.host, "0.0.0.0");
  assert.equal(configured.webConsole.port, 4010);
});

test("webConsole.historyLimit is a whole number from 1 to 1000", () => {
  for (const historyLimit of [1, 1000]) assert.equal(HarnessConfigSchema.safeParse({ webConsole: { historyLimit } }).success, true, String(historyLimit));
  for (const historyLimit of [0, -1, 1001, 2.5]) assert.equal(HarnessConfigSchema.safeParse({ webConsole: { historyLimit } }).success, false, String(historyLimit));
});

test("interactive components are off by default and may be enabled per channel", () => {
  const defaults = HarnessConfigSchema.parse({});
  assert.equal(defaults.defaults.interactiveComponents.enabled, false);

  const configured = HarnessConfigSchema.parse({
    defaults: { interactiveComponents: { enabled: true } },
    channels: { eng: { interactiveComponents: { enabled: false } } },
  });
  assert.equal(configured.defaults.interactiveComponents.enabled, true);
  assert.equal(configured.channels.eng?.interactiveComponents?.enabled, false);
});

test("channel topic usage requires a public Slack channel ID when enabled", () => {
  assert.deepEqual(HarnessConfigSchema.parse({
    channelTopicUsage: { enabled: true, channel: "C0EXAMPLE01" },
  }).channelTopicUsage, { enabled: true, channel: "C0EXAMPLE01" });

  assert.throws(
    () => HarnessConfigSchema.parse({ channelTopicUsage: { enabled: true, channel: "" } }),
    /required when channelTopicUsage is enabled/,
  );
  assert.throws(
    () => HarnessConfigSchema.parse({ channelTopicUsage: { enabled: true, channel: "G0PRIVATE" } }),
    /public Slack channel ID starting with C/,
  );
  assert.throws(
    () => HarnessConfigSchema.parse({ channelTopicUsage: { enabled: true, channel: "#admin" } }),
    /public Slack channel ID starting with C/,
  );
});

test("delegation targets are explicit channel share settings", () => {
  const config = HarnessConfigSchema.parse({
    channels: {
      "life-admin": {
        share: {
          delegateTo: [
            "engineering",
            { channel: "#ops", reason: "operational alerts and on-call context" },
            "C123",
          ],
        },
      },
    },
  });

  assert.deepEqual(config.channels["life-admin"]?.share.delegateTo, [
    { channel: "engineering" },
    { channel: "#ops", reason: "operational alerts and on-call context" },
    { channel: "C123" },
  ]);
});

test("post targets are explicit channel share settings and default to none", () => {
  const config = HarnessConfigSchema.parse({
    channels: {
      "den-inbox": {
        share: {
          postTo: [
            "announcements",
            { channel: "C0123ABC", reason: "invoices for finance" },
          ],
        },
      },
    },
  });

  assert.deepEqual(config.channels["den-inbox"]?.share.postTo, [
    { channel: "announcements" },
    { channel: "C0123ABC", reason: "invoices for finance" },
  ]);
  assert.deepEqual(config.defaults.share.postTo, []);
});

function postAsConfig(postAs: unknown, extra: Record<string, unknown> = {}, guard: object = { description: "Reviews.", tools: [] }) {
  return {
    agentSets: { guards: { agents: { post_guard: guard } } },
    channels: { inbox: { agentSet: "guards", share: { postAs }, ...extra } },
  };
}
const postAsIssues = (input: unknown) => {
  const result = HarnessConfigSchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
};

test("postAs parses with defaults, and a channel without it has none", () => {
  const config = HarnessConfigSchema.parse(postAsConfig({ user: "U123ABC", reviewer: "post_guard" }));
  const postAs = config.channels.inbox!.share.postAs!;
  assert.equal(postAs.maxPerHour, 10);
  assert.deepEqual(postAs.privateLinkHosts, []);
  assert.equal(postAs.rules, undefined);
  assert.equal(HarnessConfigSchema.parse({}).defaults.share.postAs, undefined);
});

test("postAs refuses a reviewer that is not in the channel's agent set, or a channel with no agent set", () => {
  assert.match(postAsIssues(postAsConfig({ user: "U123ABC", reviewer: "nobody" })).join("\n"), /postAs\.reviewer.*no agent "nobody"/);
  const noSet = { channels: { inbox: { share: { postAs: { user: "U123ABC", reviewer: "post_guard" } } } } };
  assert.match(postAsIssues(noSet).join("\n"), /postAs\.reviewer.*needs an agentSet/);
});

test("postAs refuses a reviewer role that has tools or connectors", () => {
  const withTools = postAsIssues(postAsConfig({ user: "U123ABC", reviewer: "post_guard" }, {}, { description: "R.", tools: ["read"] }));
  assert.match(withTools.join("\n"), /postAs\.reviewer.*no tools/);
  const withConnectors = postAsIssues(postAsConfig({ user: "U123ABC", reviewer: "post_guard" }, {}, { description: "R.", tools: [], connectors: ["x"] }));
  assert.match(withConnectors.join("\n"), /postAs\.reviewer.*no connectors/);
});

test("postAs validates the user id, the hourly cap and unknown keys", () => {
  assert.match(postAsIssues(postAsConfig({ user: "bob", reviewer: "post_guard" })).join("\n"), /postAs\.user/);
  for (const maxPerHour of [0, 101]) {
    assert.match(postAsIssues(postAsConfig({ user: "U123ABC", reviewer: "post_guard", maxPerHour })).join("\n"), /postAs\.maxPerHour/);
  }
  assert.equal(HarnessConfigSchema.parse(postAsConfig({ user: "U123ABC", reviewer: "post_guard", maxPerHour: 100 })).channels.inbox!.share.postAs!.maxPerHour, 100);
  assert.match(postAsIssues(postAsConfig({ user: "U123ABC", reviewer: "post_guard", extra: 1 })).join("\n"), /postAs/);
});

test("postAs is channel-only: defaults.share.postAs is refused", () => {
  const issues = postAsIssues({ defaults: { share: { postAs: { user: "U123ABC", reviewer: "post_guard" } } } });
  assert.match(issues.join("\n"), /defaults\.share\.postAs.*channel setting/);
});

test("local OpenAI-compatible model providers have local auth defaults", () => {
  const config = HarnessConfigSchema.parse({
    modelProviders: {
      turbofieldfare: {
        baseUrl: "http://127.0.0.1:8080/v1",
        models: [{ id: "gemma-4-26b-a4b-it", contextWindow: 16384 }],
      },
    },
  });

  assert.equal(config.modelProviders.turbofieldfare?.apiKey, "local");
  assert.equal(config.modelProviders.turbofieldfare?.models[0]?.reasoning, false);
  assert.deepEqual(config.modelProviders.turbofieldfare?.models[0]?.input, ["text"]);
});

test("workspace symlink targets must be absolute", () => {
  assert.throws(
    () => HarnessConfigSchema.parse({ defaults: { workspace: { symlinkTargets: ["./project"] } } }),
    /workspace\.symlinkTargets entries must be absolute paths/,
  );
});

test("shared tool publishing and execution are off/empty by default", () => {
  const config = HarnessConfigSchema.parse({});
  assert.equal(config.defaults.share.sharedToolsPublish, false);
  assert.deepEqual(config.defaults.share.sharedTools, {});
});

test("a channel's shared tool entries take the same argv/env/limit defaults as exec commands", () => {
  const config = HarnessConfigSchema.parse({
    channels: {
      home: {
        share: {
          sharedToolsPublish: true,
          sharedTools: {
            "deploy-notify": { allowArgs: [["--env", "staging"]] },
          },
        },
      },
    },
  });

  const entry = config.channels.home?.share.sharedTools["deploy-notify"];
  assert.equal(config.channels.home?.share.sharedToolsPublish, true);
  assert.deepEqual(entry?.allowArgs, [["--env", "staging"]]);
  assert.deepEqual(entry?.env, {});
  assert.equal(entry?.timeoutSeconds, 30);
  assert.equal(entry?.maxOutputBytes, 200_000);
  assert.equal(entry?.sha256, undefined);
});

test("a shared tool's ** argv wildcard must be the final pattern token, same rule as exec", () => {
  assert.throws(
    () =>
      HarnessConfigSchema.parse({
        channels: {
          home: { share: { sharedTools: { bad: { allowArgs: [["**", "oops"]] } } } },
        },
      }),
    /\*\* may only appear as the final argv pattern token/,
  );
});

test("a shared tool sha256 pin must be 64 lowercase hex characters", () => {
  assert.throws(
    () =>
      HarnessConfigSchema.parse({
        channels: {
          home: { share: { sharedTools: { greet: { sha256: "not-a-hash" } } } },
        },
      }),
    /sha256 must be 64 lowercase hex characters/,
  );

  const config = HarnessConfigSchema.parse({
    channels: {
      home: { share: { sharedTools: { greet: { sha256: "a".repeat(64) } } } },
    },
  });
  assert.equal(config.channels.home?.share.sharedTools.greet?.sha256, "a".repeat(64));
});


test("factory channels require reviewed GitHub repository names and unique lifecycle settings", () => {
  const config = HarnessConfigSchema.parse({
    channels: { engineering: { factory: { name: "Home Services", repositories: ["denwilliams/seneschal"], lifecycleSkills: ["planning", "review"] } } },
  });
  assert.deepEqual(config.channels.engineering?.factory, {
    name: "Home Services", repositories: ["denwilliams/seneschal"], lifecycleSkills: ["planning", "review"], announce: true, maxLiveRuns: 3,
  });
  assert.equal(HarnessConfigSchema.safeParse({ channels: { engineering: { factory: { name: "Bad", repositories: ["not a repo"] } } } }).success, false);
  assert.equal(HarnessConfigSchema.safeParse({ channels: { engineering: { factory: { name: "Dup", repositories: ["a/b", "A/B"] } } } }).success, false);
  assert.equal(HarnessConfigSchema.safeParse({ channels: { engineering: { factory: { name: "Dup", repositories: ["a/b"], lifecycleSkills: ["review", "review"] } } } }).success, false);
});

test("factory merge rules: nothing merges by itself unless set, rules are strict and bounded, and a repository rule needs its repository", () => {
  const parse = (factory: object) => HarnessConfigSchema.safeParse({ channels: { eng: { factory: { name: "F", repositories: ["acme/web", "acme/api"], ...factory } } } });
  const plain = HarnessConfigSchema.parse({ channels: { eng: { factory: { name: "F", repositories: ["acme/web"] } } } }).channels.eng!.factory!;
  assert.equal(plain.merge, undefined, "no rules by default: the engine reads that as never automatic");
  assert.equal(plain.announce, true);

  const good = parse({
    merge: { approvers: ["U123ABC"], autoMergeMaxRisk: 2, method: "rebase", sensitivePaths: ["infra/**"], largeDiffLines: 500, deployEnvironment: "production" },
    repositoryRules: { "acme/api": { autoMergeMaxRisk: 1 } }, announce: false,
  });
  assert.ok(good.success, JSON.stringify(good.error?.issues));
  assert.equal(good.data.channels.eng!.factory!.announce, false);

  for (const [what, bad] of [
    ["a typo in a rule", { merge: { autoMergeMaxRsik: 4 } }],
    ["a risk above 4 (5 is never automatic)", { merge: { autoMergeMaxRisk: 5 } }],
    ["a negative risk", { merge: { autoMergeMaxRisk: -1 } }],
    ["a fractional risk", { merge: { autoMergeMaxRisk: 1.5 } }],
    ["an approver that is not a Slack user id", { merge: { approvers: ["denwilliams"] } }],
    ["a merge method GitHub does not have", { merge: { method: "fast-forward" } }],
    ["a repository rule for a repository the factory does not have", { repositoryRules: { "acme/other": { autoMergeMaxRisk: 1 } } }],
    ["a typo inside a repository rule", { repositoryRules: { "acme/api": { autoMergeMaxRsik: 1 } } }],
    ["too many sensitive paths", { merge: { sensitivePaths: Array.from({ length: 51 }, (_, i) => `p${i}`) } }],
    ["an unknown deploy environment", { merge: { deployEnvironment: "dev" } }],
  ] as const) assert.equal(parse(bad).success, false, `${what} is refused`);
});

test("factory issue filing is off by default, bounded and strict, and approval for it is refused until it is built", () => {
  const parse = (issues: unknown) => HarnessConfigSchema.safeParse({ channels: { eng: { factory: { name: "F", repositories: ["acme/web"], ...(issues === undefined ? {} : { issues }) } } } });
  const plain = parse(undefined);
  assert.ok(plain.success);
  assert.equal(plain.data.channels.eng!.factory!.issues, undefined, "nothing is set, so nothing is filed");
  const on = parse({ create: true });
  assert.ok(on.success, JSON.stringify(!on.success && on.error.issues));
  assert.deepEqual(on.data.channels.eng!.factory!.issues, { create: true, labels: ["status:triage"], maxPerHour: 10, requireApproval: false });
  assert.deepEqual(parse({}).success && parse({}).data!.channels.eng!.factory!.issues!.create, false, "present but empty is still off");
  const custom = parse({ create: true, labels: ["status:triage", "from slack"], maxPerHour: 3 });
  assert.ok(custom.success);
  for (const [what, bad] of [
    ["a typo", { crate: true }],
    ["a label with a comma", { labels: ["a,b"] }],
    ["a label with a quote", { labels: ["a\"b"] }],
    ["an empty label", { labels: [""] }],
    ["too many labels", { labels: Array.from({ length: 11 }, (_, i) => `l${i}`) }],
    ["no limit at all", { maxPerHour: 0 }],
    ["an absurd limit", { maxPerHour: 1000 }],
    ["a fractional limit", { maxPerHour: 1.5 }],
  ] as const) assert.equal(parse(bad).success, false, `${what} is refused`);
  const approval = parse({ create: true, requireApproval: true });
  assert.equal(approval.success, false);
  assert.match(JSON.stringify(!approval.success && approval.error.issues), /not supported yet: a created issue cannot wait for an approver/);
});

test("console OAuth requires exact HTTPS callback under enabled console including proxy path prefix", () => {
  const webConsole = { enabled: true, baseUrl: "https://console.example.test/harness", oauth: { callbackUrl: "https://console.example.test/harness/oauth/callback" } };
  const parsed = HarnessConfigSchema.parse({ webConsole });
  assert.equal(parsed.webConsole.oauth!.ttlSeconds, 600);
  assert.equal(HarnessConfigSchema.parse({}).webConsole.oauth, undefined);
  for (const change of [
    { enabled: false }, { baseUrl: "http://console.example.test/harness" }, { baseUrl: undefined },
    { oauth: { callbackUrl: "https://attacker.example.test/harness/oauth/callback" } },
    { oauth: { callbackUrl: "https://console.example.test/oauth/callback" } },
    { oauth: { callbackUrl: "https://console.example.test/harness/oauth/callback?next=evil" } },
    { oauth: { callbackUrl: "https://console.example.test/harness/oauth/callback#secret" } },
    { oauth: { callbackUrl: "https://user:secret@console.example.test/harness/oauth/callback" } },
    { oauth: { ...webConsole.oauth, ttlSeconds: 30 } }, { oauth: { ...webConsole.oauth, ttlSeconds: 901 } },
  ]) assert.throws(() => HarnessConfigSchema.parse({ webConsole: { ...webConsole, ...change } }));
});

test("a config that still lists the removed `herdr` tool says what to delete instead of listing valid tool names", () => {
  assert.throws(
    () => HarnessConfigSchema.parse({ channels: { eng: { tools: ["read", "herdr"] } } }),
    /tool was removed along with Herdr worker delegation \(delegate_task\)\. Delete it from `tools`/,
  );
  // The same name in the defaults, which every channel inherits.
  assert.throws(() => HarnessConfigSchema.parse({ defaults: { tools: ["read", "herdr"] } }), /tool was removed along with Herdr worker delegation/);
  // An ordinary typo still gets the ordinary message, not the migration one.
  assert.throws(() => HarnessConfigSchema.parse({ channels: { eng: { tools: ["raed"] } } }), (error: Error) => !/herdr/.test(error.message));
});

test("leftover `herdrRepos` / `herdr` settings no longer do anything, and do not stop a config from loading", () => {
  const parsed = HarnessConfigSchema.parse({
    herdrRepos: { app: { cwd: "/tmp/app", kind: "claude" } },
    herdr: { session: "harness-worker" },
    channels: { eng: { tools: ["read"], share: { herdrRepos: ["app"] } } },
  });
  assert.equal("herdr" in parsed, false);
  assert.equal("herdrRepos" in parsed, false);
  assert.equal("herdrRepos" in parsed.channels.eng!.share, false);
});

test("jobs are set on a channel, validated there, and refused in defaults", () => {
  const job = { description: "d", phases: [{ name: "a", kind: "exec", command: "git", args: ["status"] }] };
  const ok = HarnessConfigSchema.parse({ channels: { C1: { jobs: { "release-check": job } } } });
  assert.deepEqual(Object.keys(ok.channels.C1!.jobs!), ["release-check"]);
  assert.equal(HarnessConfigSchema.parse({ channels: { C1: {} } }).channels.C1!.jobs, undefined, "no jobs unless the channel lists them");
  assert.throws(() => HarnessConfigSchema.parse({ defaults: { jobs: { "release-check": job } } }), /jobs are set on each channel, not in defaults/);
  assert.throws(() => HarnessConfigSchema.parse({ channels: { C1: { jobs: { "release-check": { phases: [] } } } } }), "a job needs a phase");
  assert.throws(() => HarnessConfigSchema.parse({ channels: { C1: { jobs: { "Bad Name": job } } } }), "names are lower-case identifiers");
  assert.throws(() => HarnessConfigSchema.parse({ channels: { C1: { jobs: { j: { phases: [{ name: "a", kind: "approve", message: "x" }] } } } } }), "kinds that are not built are refused");
  assert.throws(() => HarnessConfigSchema.parse({ channels: { C1: { jobs: { j: { phases: [{ name: "a", kind: "exec", command: "git", args: ["${input.nope}"] }] } } } } }), "a reference to an input the job does not declare");
});

test("factory intake is off unless set, strict, bounded, and its defaults are the safe ones", () => {
  const parse = (factory: object) => HarnessConfigSchema.safeParse({ channels: { eng: { factory: { name: "F", repositories: ["acme/web"], ...factory } } } });
  assert.equal(parse({}).success && parse({}).data?.channels.eng?.factory?.intake, undefined);
  const on = parse({ intake: { enabled: true } });
  assert.ok(on.success);
  assert.deepEqual(on.data.channels.eng!.factory!.intake, {
    enabled: true, source: "github", intervalSeconds: 120, goLabel: "factory:go", ignoreLabels: ["wontfix", "duplicate", "invalid", "status:rejected"],
    maxStartsPerPoll: 5, maxPerHour: 20, needsInfoDays: 14, backfill: false,
  });
  assert.equal(parse({ intake: { enabled: true, surprise: 1 } }).success, false, "unknown keys are refused");
  assert.equal(parse({ intake: { enabled: true, source: "jira" } }).success, false, "only github is built");
  assert.equal(parse({ intake: { intervalSeconds: 5 } }).success, false, "polling faster than a minute is refused");
  assert.equal(parse({ intake: { intervalSeconds: 99999 } }).success, false);
  assert.equal(parse({ intake: { goLabel: "bad,label" } }).success, false);
  assert.equal(parse({ intake: { maxStartsPerPoll: 0 } }).success, false);
  assert.equal(parse({ intake: { needsInfoDays: 0 } }).success, false);
});
