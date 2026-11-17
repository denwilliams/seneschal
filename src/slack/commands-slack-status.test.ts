import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand, type CommandContext } from "./commands.ts";
import { ensureSharedDirs } from "../workspace/paths.ts";
import { defaultSlackUserTokenPath } from "../agent/slack-user-tokens.ts";

const SECRET = "xoxp-SECRET-do-not-print";

function fixture(opts: { postAs?: boolean; token?: boolean; reviewerName?: string }) {
  const root = mkdtempSync(join(tmpdir(), "slack-status-"));
  const shared = ensureSharedDirs(join(root, "data"));
  const channel = {
    ref: { id: "C1", name: "eng" },
    configKey: "eng",
    description: "",
    model: "m/x",
    thinkingLevel: "off",
    models: [],
    tools: ["read", "slack"],
    web: { search: { provider: "none" }, allowPrivateHosts: false },
    images: {},
    context: { threadBackfill: 1, channelBackfill: 2, dmBackfill: 3 },
    grants: [],
    skillPaths: [],
    skillCollections: [],
    library: { canRead: false, canPublish: false },
    documents: { canRead: false, canAdd: false },
    dreamsEnabled: false,
    connectors: [],
    exec: { commands: {} },
    knowledge: [],
    memory: { foreignFiles: [] },
    paths: { workspace: join(root, "ws"), root: join(root, "ch"), skills: join(root, "skills") },
    shared,
    env: {},
    ...(opts.postAs
      ? { postAs: { user: "U01ALICE1", maxPerHour: 7, privateLinkHosts: [], reviewer: { name: opts.reviewerName ?? "post_guard", model: "m/x", thinkingLevel: "off", instructions: "Hold anything risky.", timeoutSeconds: 30 } } }
      : {}),
  };
  if (opts.token) {
    writeFileSync(defaultSlackUserTokenPath(shared), JSON.stringify({ users: { U01ALICE1: { token: SECRET } } }));
  }
  const ctx = {
    channel,
    userId: "U09OTHER",
    threadKey: "1.1",
    runtimes: { peek: () => undefined },
  } as unknown as CommandContext;
  return ctx;
}

test("!status without postAs has no Post as user line", async () => {
  const out = await runCommand("!status", fixture({}));
  assert.doesNotMatch(out, /Post as user/);
  assert.match(out, /\*Slack search:\* read-only user-token search \(no token stored for you\)/);
});

test("!status without postAs is byte-for-byte what it was (the same lines as with the line stripped)", async () => {
  const ctx = fixture({});
  const plain = await runCommand("!status", ctx);
  const withPostAs = fixture({ postAs: true, token: true });
  const out = await runCommand("!status", withPostAs);
  const stripped = out.split("\n").filter((l) => !l.startsWith("*Post as user:*")).join("\n");
  // Paths differ per fixture; normalise the temp dirs.
  const norm = (s: string) => s.replace(/\/[^\s`]*slack-status-[^/\s`]*/g, "<tmp>");
  assert.equal(norm(stripped), norm(plain));
});

test("!status with postAs and a stored token says configured, token stored, cap and reviewer, and never the token", async () => {
  const out = await runCommand("!status", fixture({ postAs: true, token: true }));
  const line = out.split("\n").find((l) => l.startsWith("*Post as user:*"));
  assert.ok(line, out);
  assert.match(line, /configured for <@U01ALICE1>, token stored/);
  assert.match(line, /7 per hour/);
  assert.match(line, /reviewer role `post_guard`/);
  assert.doesNotMatch(line, /\[object Object\]/);
  assert.doesNotMatch(line, /Hold anything risky/, "the reviewer's instructions are not printed");
  assert.match(line, /cannot tell from here whether the token has the posting scopes/);
  assert.ok(!out.includes(SECRET) && !out.includes("xoxp"));
});

test("!status with postAs and no token says no token stored for them", async () => {
  const out = await runCommand("!status", fixture({ postAs: true }));
  const line = out.split("\n").find((l) => l.startsWith("*Post as user:*"));
  assert.ok(line, out);
  assert.match(line, /configured for <@U01ALICE1>, NO token stored for them/);
});

test("!status strips backticks from the reviewer name so it cannot break out of its code span", async () => {
  const out = await runCommand("!status", fixture({ postAs: true, token: true, reviewerName: "a`<!channel>`b" }));
  const line = out.split("\n").find((l) => l.startsWith("*Post as user:*"))!;
  assert.match(line, /reviewer role `a&lt;!channel&gt;b`/);
});
