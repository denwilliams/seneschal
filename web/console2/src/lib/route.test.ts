import { describe, expect, it } from "vitest";
import { buildRoute, parseRoute } from "./route";

describe("route", () => {
  it("opens configuration independently of channels and round-trips its route", () => {
    const admin = parseRoute("#/admin");
    expect(admin.admin).toBe(true);
    expect(admin.channelId).toBeUndefined();
    expect(buildRoute(admin)).toBe("#/admin");
  });
  it("round-trips channel, thread, tab and view", () => {
    const route = { channelId: "C1", threadKey: "1712.34/x", tab: "tasks" as const, view: "timeline" as const };
    expect(parseRoute(buildRoute(route))).toEqual(route);
    const files = { channelId: "C1", tab: "files" as const, view: "factory" as const };
    expect(buildRoute(files)).toBe("#/c/C1?tab=files&view=factory");
    expect(parseRoute(buildRoute(files))).toEqual(files);
  });
  it("defaults to the session tab and the transcript view and omits both from the hash", () => {
    expect(buildRoute({ channelId: "C1", tab: "session", view: "transcript" })).toBe("#/c/C1");
    expect(parseRoute("#/c/C1")).toEqual({ channelId: "C1", tab: "session", view: "transcript" });
    expect(buildRoute({ channelId: "C1", tab: "session", view: "timeline" })).toBe("#/c/C1?view=timeline");
  });
  it("keeps the view when only the thread changes", () => {
    const before = parseRoute("#/c/C1/t/1.2?view=timeline");
    expect(buildRoute({ ...before, threadKey: "3.4" })).toBe("#/c/C1/t/3.4?view=timeline");
  });
  it("carries an open workflow run, and refuses a run id that is not one", () => {
    const route = { channelId: "C1", tab: "tasks" as const, view: "transcript" as const, run: "frun_ab.1" };
    expect(buildRoute(route)).toBe("#/c/C1?tab=tasks&run=frun_ab.1");
    expect(parseRoute(buildRoute(route))).toEqual(route);
    expect(parseRoute("#/c/C1?tab=tasks&run=a%2Fb")).toEqual({ channelId: "C1", tab: "tasks", view: "transcript" });
    expect(parseRoute("#/?run=frun_1")).toEqual({ tab: "session", view: "transcript" });
    expect(buildRoute({ tab: "tasks", view: "transcript", run: "frun_1" })).toBe("#/?tab=tasks");
  });
  it("treats junk as the empty route", () => {
    expect(parseRoute("")).toEqual({ tab: "session", view: "transcript" });
    expect(parseRoute("#/c/%E0%A4%A")).toEqual({ tab: "session", view: "transcript" });
    expect(parseRoute("#/c/C1?tab=nope&view=nope")).toEqual({ channelId: "C1", tab: "session", view: "transcript" });
  });
});
