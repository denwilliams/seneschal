import { test } from "node:test";
import assert from "node:assert/strict";
import { postStartupNotice, startupNoticeText } from "./startup.ts";

test("startup notice posts to the configured digest channel", async () => {
  const posts: { channelId: string; text: string }[] = [];

  const result = await postStartupNotice({
    digestChannel: "admin",
    registry: { resolveId: (key) => (key === "admin" ? "CADMIN" : undefined) },
    harnessName: "Home Harness",
    botUser: "harness",
    botUserId: "U123",
    team: "T1",
    now: new Date("2026-08-11T10:00:00.000Z"),
    post: async (input) => {
      posts.push(input);
    },
  });

  assert.deepEqual(result, { status: "posted", channelId: "CADMIN" });
  assert.deepEqual(posts, [
    {
      channelId: "CADMIN",
      text:
        ":white_check_mark: *Home Harness started successfully*\n" +
        "at 2026-08-11T10:00:00.000Z · bot harness (U123) · workspace T1",
    },
  ]);
});

test("empty digest channel disables startup notice", async () => {
  let posted = false;

  const result = await postStartupNotice({
    digestChannel: "   ",
    registry: { resolveId: () => "CADMIN" },
    harnessName: "Home Harness",
    post: async () => {
      posted = true;
    },
  });

  assert.deepEqual(result, { status: "disabled" });
  assert.equal(posted, false);
});

test("unresolved digest channel is reported instead of posted", async () => {
  let posted = false;

  const result = await postStartupNotice({
    digestChannel: "admin",
    registry: { resolveId: () => undefined },
    harnessName: "Home Harness",
    post: async () => {
      posted = true;
    },
  });

  assert.deepEqual(result, { status: "no-channel", configured: "admin" });
  assert.equal(posted, false);
});

test("startup notice text includes a timestamp even without Slack auth details", () => {
  assert.equal(
    startupNoticeText({ harnessName: "Home Harness", now: new Date("2026-08-11T10:00:00.000Z") }),
    ":white_check_mark: *Home Harness started successfully*\nat 2026-08-11T10:00:00.000Z",
  );
});
