import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isAllowed, listModels, parseRef, resolveModel, type ModelCatalog } from "./model.ts";
import { authSourceFor, getAuthPath, setAuthPath } from "./credentials.ts";

/** listModels(onlyAvailable) depends on env keys, so tests set them explicitly. */
function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("resolves a provider-qualified model", () => {
  const model = resolveModel("openai/gpt-5.4");
  assert.equal(model.provider, "openai");
  assert.equal(model.id, "gpt-5.4");
});

test("infers the provider for a bare model id", () => {
  assert.equal(parseRef("deepseek-v4-pro")?.provider, "deepseek");
  assert.equal(parseRef("gpt-5.4")?.provider, "openai");
});

test("rejects an unknown model with a helpful message", () => {
  assert.throws(() => resolveModel("not-a-real-model"), /Unknown model/);
  assert.throws(() => resolveModel("openai/nope"), /Available for provider "openai"/);
});

test("lists only models whose provider has credentials", () => {
  // Hermetic: an empty credential store, so a developer's own `pi` login (e.g. a Codex subscription in
  // ~/.pi/agent/auth.json) cannot add providers to what this test expects.
  const dir = mkdtempSync(join(tmpdir(), "model-list-auth-"));
  const empty = join(dir, "auth.json");
  writeFileSync(empty, "{}");
  const previous = getAuthPath();
  setAuthPath(empty);
  try {
    withEnv({ DEEPSEEK_API_KEY: "x", OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined }, () => {
      const models = listModels({ onlyAvailable: true });
      assert.ok(models.length > 0, "deepseek models should be listed");
      assert.ok(
        models.every((m) => m.provider === "deepseek"),
        "no models from providers without credentials",
      );
    });
  } finally {
    setAuthPath(previous as string);
  }
});

test("an empty allowlist permits anything", () => {
  assert.equal(isAllowed("openai/gpt-5.4", []), true);
  assert.equal(isAllowed("deepseek-v4-pro", []), true);
});

test("an allowlist restricts switching", () => {
  const allow = ["deepseek-v4-pro", "openai/gpt-5.4"];
  assert.equal(isAllowed("deepseek-v4-pro", allow), true);
  assert.equal(isAllowed("openai/gpt-5.4", allow), true);
  assert.equal(isAllowed("openai/gpt-5.4-mini", allow), false);
  assert.equal(isAllowed("anthropic/claude-opus-5", allow), false);
});

test("a provider wildcard permits the whole provider", () => {
  const allow = ["openai/*"];
  assert.equal(isAllowed("openai/gpt-5.4", allow), true);
  assert.equal(isAllowed("openai/o4-mini", allow), true);
  assert.equal(isAllowed("deepseek-v4-pro", allow), false);
});

test("a stored OAuth credential makes a subscription provider available", () => {
  const dir = mkdtempSync(join(tmpdir(), "auth-"));
  const authPath = join(dir, "auth.json");
  writeFileSync(
    authPath,
    JSON.stringify({
      "openai-codex": { type: "oauth", refresh: "r", access: "a", expires: 9_999_999_999_999 },
    }),
  );

  const previous = getAuthPath();
  setAuthPath(authPath);
  try {
    withEnv({ DEEPSEEK_API_KEY: undefined, OPENAI_API_KEY: undefined }, () => {
      assert.equal(authSourceFor("openai-codex"), "stored");
      // The API-key OpenAI provider is a different provider and stays unavailable.
      assert.equal(authSourceFor("openai"), "none");

      const models = listModels({ onlyAvailable: true });
      assert.ok(models.length > 0);
      assert.ok(
        models.every((m) => m.provider === "openai-codex"),
        "only the subscription provider should be available",
      );
    });
  } finally {
    if (previous) setAuthPath(previous);
  }
});

test("listModels honours the allowlist", () => {
  withEnv({ DEEPSEEK_API_KEY: "x", OPENAI_API_KEY: "y" }, () => {
    const models = listModels({ allow: ["deepseek-v4-pro"], onlyAvailable: true });
    assert.equal(models.length, 1);
    assert.equal(models[0]!.ref, "deepseek/deepseek-v4-pro");
  });
});

test("custom model catalogs support local OpenAI-compatible providers", () => {
  const model = {
    id: "gemma-4-26b-a4b-it",
    name: "Gemma 4 26B-A4B IT",
    api: "openai-completions",
    provider: "turbofieldfare",
    baseUrl: "http://127.0.0.1:8080/v1",
    input: ["text"],
    reasoning: false,
    contextWindow: 16384,
    maxTokens: 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  } as any;
  const catalog: ModelCatalog = {
    getProviders: () => [{ id: "turbofieldfare", name: "TurboFieldfare" } as any],
    getModels: (providerId?: string) => (providerId && providerId !== "turbofieldfare" ? [] : [model]),
    getModel: (providerId: string, modelId: string) =>
      providerId === "turbofieldfare" && modelId === model.id ? model : undefined,
    hasConfiguredAuth: (providerId: string) => providerId === "turbofieldfare",
  };

  assert.equal(parseRef("gemma-4-26b-a4b-it", catalog)?.provider, "turbofieldfare");
  assert.equal(resolveModel("turbofieldfare/gemma-4-26b-a4b-it", catalog), model);
  assert.equal(isAllowed("gemma-4-26b-a4b-it", ["turbofieldfare/*"], catalog), true);
  assert.deepEqual(
    listModels({ catalog, onlyAvailable: true }).map((m) => m.ref),
    ["turbofieldfare/gemma-4-26b-a4b-it"],
  );
});
