import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expandWith, layerEnv, parseEnvFile, readEnvFile } from "./envfile.ts";
import { HarnessConfigSchema } from "./schema.ts";
import { parseConfigText } from "./load.ts";
import { ChannelRegistry } from "../workspace/registry.ts";
import { resolveChannel } from "../workspace/resolve.ts";

test("parses plain, quoted, exported and commented entries", () => {
  const env = parseEnvFile(
    [
      "# a comment",
      "PLAIN=value",
      "export EXPORTED=yes",
      'QUOTED="has spaces"',
      "SINGLE='literal'",
      "WITH_COMMENT=value # trailing",
      "EMPTY=",
      "  SPACED = padded ",
      "not a valid line",
    ].join("\n"),
  );

  assert.equal(env.PLAIN, "value");
  assert.equal(env.EXPORTED, "yes");
  assert.equal(env.QUOTED, "has spaces");
  assert.equal(env.SINGLE, "literal");
  assert.equal(env.WITH_COMMENT, "value");
  assert.equal(env.EMPTY, "");
  assert.equal(env.SPACED, "padded");
});

test("double quoted values unescape newline, quote and backslash", () => {
  const env = parseEnvFile('SECRET="line 1\\nline 2 with \\"quote\\" and backslash \\\\ here"');
  assert.equal(env.SECRET, 'line 1\nline 2 with "quote" and backslash \\ here');
});

test("a value containing '#' without a space is not treated as a comment", () => {
  const env = parseEnvFile("TOKEN=abc#def");
  assert.equal(env.TOKEN, "abc#def");
});

test("later layers win", () => {
  const { bundle } = layerEnv([
    { label: "global", values: { TOKEN: "global", SHARED: "yes" } },
    { label: "channel", values: { TOKEN: "channel" } },
  ]);
  assert.equal(bundle.TOKEN, "channel", "channel must override global");
  assert.equal(bundle.SHARED, "yes", "unrelated globals still apply");
});

test("layer sources record only files that contributed", () => {
  const { sources } = layerEnv([
    { label: "global", values: { A: "1" } },
    { label: "empty", values: {} },
    { label: "channel", values: { B: "2" } },
  ]);
  assert.deepEqual(sources, ["global", "channel"]);
});

test("expansion names the missing variable rather than guessing", () => {
  assert.equal(expandWith("Bearer ${TOKEN}", { TOKEN: "abc" }, "ctx"), "Bearer abc");
  assert.throws(() => expandWith("${NOPE}", {}, "Connector x"), /Connector x references \$\{NOPE\}/);
});

test("a missing env file is empty, not an error", () => {
  assert.deepEqual(readEnvFile("/definitely/not/here.env"), {});
});

test("channel env files do not leak between channels", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "env-"));
  for (const id of ["C1", "C2"]) {
    mkdirSync(join(dataDir, "channels", id), { recursive: true });
  }
  writeFileSync(join(dataDir, "channels", "C1", "env"), "CONNECTOR_TOKEN=secret-for-c1\n");
  writeFileSync(join(dataDir, "channels", "C2", "env"), "CONNECTOR_TOKEN=secret-for-c2\n");

  const config = HarnessConfigSchema.parse({
    connectors: {
      api: {
        transport: "http",
        url: "https://example.com/mcp",
        headers: { Authorization: "Bearer ${CONNECTOR_TOKEN}" },
      },
    },
    channels: {
      one: { share: { connectors: ["api"] } },
      two: { share: { connectors: ["api"] } },
    },
  });
  const registry = new ChannelRegistry(dataDir);

  const one = resolveChannel(config, dataDir, { id: "C1", name: "one", isDm: false }, registry)
    .channel!;
  const two = resolveChannel(config, dataDir, { id: "C2", name: "two", isDm: false }, registry)
    .channel!;

  const headerOf = (c: typeof one) =>
    (c.connectors[0]!.config as { headers: Record<string, string> }).headers.Authorization;

  assert.equal(headerOf(one), "Bearer secret-for-c1");
  assert.equal(headerOf(two), "Bearer secret-for-c2");
  assert.equal(one.env.CONNECTOR_TOKEN, "secret-for-c1");
  assert.equal(two.env.CONNECTOR_TOKEN, "secret-for-c2");
});

test("the channel env file is outside the channel's own read jail", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "env-"));
  mkdirSync(join(dataDir, "channels", "C1"), { recursive: true });
  writeFileSync(join(dataDir, "channels", "C1", "env"), "SECRET=hunter2\n");

  const config = HarnessConfigSchema.parse({ channels: { one: {} } });
  const registry = new ChannelRegistry(dataDir);
  const channel = resolveChannel(config, dataDir, { id: "C1", name: "one", isDm: false }, registry)
    .channel!;

  const envPath = join(channel.paths.root, "env");
  for (const root of [...channel.jail.readRoots, ...channel.jail.writeRoots]) {
    assert.ok(
      !envPath.startsWith(root.endsWith("/") ? root : `${root}/`),
      `the agent must not be able to read its own secrets back out via ${root}`,
    );
  }
});

test("an exec command env value keeps its ${VAR} until a channel resolves it", () => {
  const config = parseConfigText(
    [
      "defaults:",
      "  exec:",
      "    commands:",
      "      acli:",
      "        command: acli",
      "        env:",
      "          ACLI_TOKEN: ${NEVER_SET_IN_THE_ENVIRONMENT}",
    ].join("\n"),
  );

  assert.equal(config.defaults.exec.commands.acli?.env.ACLI_TOKEN, "${NEVER_SET_IN_THE_ENVIRONMENT}");
});

test("a web search key keeps its ${VAR} until a channel resolves it", () => {
  // Loading must not bake in the process-environment value: the key is
  // per channel, like a connector's token, so one channel can search as
  // itself without every other channel inheriting the same credential.
  const config = parseConfigText(
    [
      "defaults:",
      "  web:",
      "    search:",
      "      provider: brave",
      "      apiKey: ${NEVER_SET_IN_THE_ENVIRONMENT}",
    ].join("\n"),
  );

  assert.equal(config.defaults.web.search.apiKey, "${NEVER_SET_IN_THE_ENVIRONMENT}");
});

test("an image API key keeps its ${VAR} until a channel resolves it", () => {
  const config = parseConfigText(
    [
      "defaults:",
      "  images:",
      "    provider: openai",
      "    apiKey: ${NEVER_SET_IN_THE_ENVIRONMENT}",
    ].join("\n"),
  );

  assert.equal(config.defaults.images.apiKey, "${NEVER_SET_IN_THE_ENVIRONMENT}");
});

test("HTTP connectors may use per-channel OAuth config", () => {
  const config = HarnessConfigSchema.parse({
    connectors: {
      calendar: {
        transport: "http",
        url: "https://calendarmcp.googleapis.com/mcp/v1",
        oauth: {
          clientId: "client-id",
          clientSecret: "secret",
          redirectUrl: "http://localhost:37645/oauth/callback",
          tokenFile: "secrets/calendar-token.json",
        },
      },
    },
    channels: { admin: { share: { connectors: ["calendar"] } } },
  });

  assert.equal(config.connectors.calendar?.transport, "http");
  if (config.connectors.calendar?.transport !== "http") assert.fail("calendar should be HTTP");
  assert.equal(config.connectors.calendar.oauth?.clientId, "client-id");
});
