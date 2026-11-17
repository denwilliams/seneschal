import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessApp } from "./app.ts";
import type { ResolvedChannel } from "../workspace/resolve.ts";
import type { FactoryGitHub } from "../factory/workflow/deps.ts";
import { createFactoryRunService, type FactoryRunStore } from "../factory/workflow/service.ts";
import { fixture, REPO } from "../factory/workflow/test-support.ts";
import { JIRA, mockAcli } from "../factory/workflow/jira-test-support.ts";

// Exercise the application's actual routing callback and manual-start service, not
// a separately supplied ambiguity predicate. Only ACLI and the durable store are fakes.
for (const enabled of [true, false]) {
  for (const candidate of ["matching", "absent", "unmatched", "disabled", "unauthenticated", "unresolved"] as const) {
    test(`manual Jira routing: selected polling=${enabled}, other factory=${candidate}`, async (t) => {
      const f = fixture(t, { intake: { source: "jira", enabled }, factory: { jira: JIRA } });
      await f.ready;
      const dir = mkdtempSync(join(tmpdir(), "jira-routing-"));
      t.after(() => rmSync(dir, { recursive: true, force: true }));
      const raw = mockAcli().state.raw;
      writeFileSync(join(dir, "acli"), `#!${process.execPath}
const args = process.argv.slice(2);
if (process.env.MOCK_JIRA_AUTH_FAILURE) process.exit(1);
if (args.join(" ") === "jira auth status") console.log("Logged in to example.atlassian.net");
else if (args[2] === "view") console.log(JSON.stringify(${JSON.stringify(raw)}));
else if (args[2] === "search" && args[args.indexOf("--fields") + 1] === "key") console.log(JSON.stringify([{ id: "10001", key: "HAR-123" }]));
else process.exit(2);
`, { mode: 0o700 });
      const current: ResolvedChannel = {
        ...f.channel, env: { ...f.channel.env, PATH: `${dir}:${process.env.PATH ?? ""}` },
      };
      const other: ResolvedChannel = {
        ...current, ref: { ...current.ref, id: "C2" },
        env: { ...current.env, ...(candidate === "unauthenticated" ? { MOCK_JIRA_AUTH_FAILURE: "1" } : {}) },
        factory: {
          ...current.factory!, repositories: ["acme/other"],
          intake: { ...current.factory!.intake!, enabled: candidate !== "disabled" },
          jira: { ...JIRA, ...(candidate === "unmatched" ? { components: ["unrelated"] } : {}) },
        },
      };
      const channels = new Map([[current.ref.id, current]]);
      if (candidate !== "absent" && candidate !== "unresolved") channels.set(other.ref.id, other);
      const ids = [...channels.keys()];
      const app = Object.assign(Object.create(HarnessApp.prototype), {
        runtimes: { channelIds: () => ids },
        config: { channels: candidate === "unresolved" ? { unresolved: { factory: other.factory } } : {} },
        registry: { nameFor: () => undefined },
        channelsToOpen: () => ({ existing: ids, fresh: [] }),
        channelNow: (id: string) => channels.get(id),
      }) as unknown as { factoryBackend(channel: ResolvedChannel): FactoryGitHub };
      const backend = app.factoryBackend(current);
      const starts: Parameters<FactoryRunStore["startFactoryRun"]>[0][] = [];
      const store = {
        listFactoryRuns: async () => [],
        startFactoryRun: async (input: Parameters<FactoryRunStore["startFactoryRun"]>[0]) => {
          starts.push(input);
          return { runId: "fr_routing" };
        },
      } as unknown as FactoryRunStore;
      const service = createFactoryRunService({
        channel: current, store: () => store, github: () => backend,
        threadKey: "", currentUserId: () => "U1ADMIN", source: "operator",
      });
      if (candidate === "unauthenticated" || candidate === "unresolved") {
        const error = candidate === "unauthenticated" ? /ACLI auth-status \[command-failed\]/ : /routing cannot be verified/;
        await assert.rejects(backend.source!.issue(REPO, 10001), error);
        await assert.rejects(service.start("HAR-123"), error);
        assert.equal(starts.length, 0, "an unverifiable other route must fail closed");
      } else if (candidate === "matching") {
        const ticket = await backend.source!.issue(REPO, 10001);
        assert.equal(ticket!.selection!.eligible, false);
        assert.equal(ticket!.selection!.ambiguous, true);
        await assert.rejects(service.start("HAR-123"), /multiple Jira factories/);
        assert.equal(starts.length, 0, "neither polling setting may bypass the routing hold");
      } else {
        const ticket = await backend.source!.issue(REPO, 10001);
        assert.equal(ticket!.selection!.eligible, true);
        assert.equal(ticket!.selection!.ambiguous, false);
        const result = await service.start("HAR-123");
        assert.equal(result.runId, "fr_routing");
        assert.equal(starts.length, 1, "unambiguous manual starts still work with polling disabled");
        assert.equal(starts[0]!.repo, REPO);
        assert.equal(starts[0]!.workItem!.key, "HAR-123");
        assert.equal(starts[0]!.origin, "manual");
      }
    });
  }
}
