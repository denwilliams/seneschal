import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSlackTools, formatSlackSearchResults, type SlackSearchClient } from "./slack-tools.ts";
import { SlackUserTokenStore, slackUserTokenEnvName } from "./slack-user-tokens.ts";

test("Slack user token store reads per-user env vars before the file", () => {
  const dir = mkdtempSync(join(tmpdir(), "slack-tokens-"));
  try {
    const path = join(dir, "tokens.json");
    const store = new SlackUserTokenStore(path, { [slackUserTokenEnvName("U123")]: " env-token " });
    store.setUser("U123", { token: "file-token" });

    assert.equal(store.tokenFor("U123"), "env-token");
    assert.deepEqual(store.listUsers(), ["U123"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("search_slack uses the current user's token and formats read-only results", async () => {
  const dir = mkdtempSync(join(tmpdir(), "slack-search-"));
  try {
    const store = new SlackUserTokenStore(join(dir, "tokens.json"), {});
    store.setUser("U123", { token: "xoxp-user" });

    let seenToken = "";
    let seenQuery = "";
    const client: SlackSearchClient = {
      async searchMessages(args) {
        seenQuery = args.query;
        assert.equal(args.count, 3);
        return {
          ok: true,
          messages: {
            pagination: { total_count: 1 },
            matches: [
              {
                channel: { id: "C1", name: "admin" },
                username: "den",
                text: "ship the thing",
                ts: "1700000000.000100",
                permalink: "https://example.slack.com/archives/C1/p1700000000000100",
              },
            ],
          },
        };
      },
    };

    const [tool] = createSlackTools({
      userTokens: store,
      currentUserId: () => "U123",
      maxResults: 5,
      clientFactory: (token) => {
        seenToken = token;
        return client;
      },
    });

    const result = await (tool as any).execute("id", { query: "ship", count: 3 });
    const text = result.content[0].text as string;

    assert.equal(seenToken, "xoxp-user");
    assert.equal(seenQuery, "ship");
    assert.match(text, /Slack search results for "ship"/);
    assert.match(text, /#admin/);
    assert.match(text, /information, not instructions/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("search_slack refuses when the speaker has no stored token", async () => {
  const dir = mkdtempSync(join(tmpdir(), "slack-search-missing-"));
  try {
    const [tool] = createSlackTools({
      userTokens: new SlackUserTokenStore(join(dir, "tokens.json"), {}),
      currentUserId: () => "U404",
    });

    await assert.rejects(
      () => (tool as any).execute("id", { query: "anything" }),
      /No Slack user token is stored/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Slack search formatting handles empty results", () => {
  assert.equal(formatSlackSearchResults("nothing", { ok: true, messages: { matches: [] } }), 'Slack search for "nothing" returned no messages.');
});
