import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, api, postAction } from "./api";

beforeEach(() => { vi.stubGlobal("location", { href: "http://127.0.0.1:4011/proxy/harness/console2/#/c/C1" }); });
afterEach(() => { vi.unstubAllGlobals(); });

function stubFetch(status: number, body: unknown) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("postAction", () => {
  it("sends JSON with the custom header a cross-site form cannot send, and no cache", async () => {
    const fetchMock = stubFetch(200, { ok: true, message: "Retrying." });
    const result = await postAction("channels/C1/workflows/r1/actions/retry", { a: 1 });
    expect(result).toEqual({ ok: true, message: "Retrying." });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/api\/v1\/channels\/C1\/workflows\/r1\/actions\/retry$/);
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ "content-type": "application/json", "x-console-action": "1" });
    expect(init.body).toBe('{"a":1}');
    expect(init.cache).toBe("no-store");
  });

  it("turns a refusal into an error that says what the server said", async () => {
    stubFetch(409, { error: "Run r1 has already finished (completed)." });
    await expect(postAction("x")).rejects.toMatchObject({ status: 409, message: "Run r1 has already finished (completed)." });
    stubFetch(500, "not json");
    await expect(postAction("x")).rejects.toBeInstanceOf(ApiError);
  });
});

describe("api actions", () => {
  it("names the run and the action, encoded", async () => {
    const fetchMock = stubFetch(200, { ok: true, message: "ok" });
    await api.runAction("C 1", "a/b", "restart_from", { stage: "triage" });
    await api.factoryAction("C1", "poll");
    const urls = fetchMock.mock.calls.map((call) => (call as unknown as [string])[0]);
    expect(urls[0]).toMatch(/channels\/C%201\/workflows\/a%2Fb\/actions\/restart_from$/);
    expect(urls[1]).toMatch(/channels\/C1\/factory\/poll$/);
  });
});
