import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { FactoryRunService } from "../factory/workflow/service.ts";
import { ChannelActivityLog } from "../agent/activity.ts";
import { fixture } from "./fixture.ts";
import type { Console2Actions } from "./source.ts";

/**
 * The real console2 server over a fake harness, for the browser smoke test (`web/console2/e2e/real-server.spec.ts`) and for
 * looking at the UI against the real API and the real Content-Security-Policy without Slack or a model.
 *
 *   node --experimental-strip-types src/console2/dev-server.ts [port]
 *
 * Serves the built app from `web/console2/dist` at `/console2/`. Not imported by the harness.
 */
const port = Number(process.argv[2] ?? process.env.PORT ?? 4020);
// Actions are on, backed by a service that only says yes: the real server, its checks and its CSP are what this exercises, not the engine.
const yes = async () => undefined;
const service = { decide: yes, abort: yes, recheckIssue: yes, answer: async () => ({ commented: true }), start: async () => ({ runId: "frun_info", repo: "acme/web", issue: 11, title: "Started from the dev server" }) } as unknown as FactoryRunService;
const actions: Console2Actions = { service: () => service, pollNow: () => true, audit: () => undefined };
const f = fixture({ port, factory: true, actions });
const activity = new ChannelActivityLog(join(f.dataDir, "channels", f.channelId), f.channelId);
activity.record({ key: "dev-schedule", kind: "scheduled", title: "Scheduled investigation update", text: "The investigation report is ready.", sourceTs: "1700000000.000100" });
activity.record({ key: "dev-prompt", kind: "approval", title: "Review deployment approval", text: "Open the original post to decide.", sourceTs: "1700000000.000101", interaction: "pending" });
// Exercise workspace navigation and SQLite against the real API/CSP, not an intercepted response.
const reports = join(f.dataDir, "channels", f.channelId, "workspace", "reports");
mkdirSync(reports, { recursive: true });
writeFileSync(join(reports, "notes.txt"), "Workspace fixture notes");
const database = new DatabaseSync(join(reports, "metrics.sqlite"));
database.exec("CREATE TABLE metrics(day TEXT, requests INTEGER); INSERT INTO metrics VALUES ('2026-10-28', 1250)");
database.close();
await f.server.start();
console.log(`console2 dev server ready: http://127.0.0.1:${port}/console2/  (channel ${f.channelId})`);
const stop = async () => { await f.server.stop(); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
