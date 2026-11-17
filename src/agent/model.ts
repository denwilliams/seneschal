import { getModel, getModels, getProviders } from "@earendil-works/pi-ai/compat";
import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { authSourceFor, hasCredentials, type AuthSource } from "./credentials.ts";

/**
 * Model selection.
 *
 * Model strings are written as "deepseek-v4-pro" or, when a bare id would be
 * ambiguous, as "provider/model" ("openai/gpt-5.4"). Bare ids are resolved by
 * searching providers in preference order, so the common case stays short.
 */

/** Providers searched first when resolving a bare model id. */
export const PROVIDER_PREFERENCE = [
  "deepseek",
  "openai",
  "anthropic",
  "google",
  "groq",
  "cerebras",
  "xai",
  "mistral",
  "openrouter",
];

export interface ModelInfo {
  /** Fully qualified "provider/id". */
  ref: string;
  id: string;
  provider: string;
  name: string;
  contextWindow?: number;
  reasoning?: boolean;
  /** Whether the model can be shown images. */
  acceptsImages: boolean;
  /** Cost per million input/output tokens, when the registry knows it. */
  cost?: { input: number; output: number };
  /** Whether credentials for this provider are present in the environment/config. */
  available: boolean;
}

export interface ModelCatalog {
  getProviders(): readonly Provider[];
  getModels(providerId?: string): readonly Model<Api>[];
  getModel(providerId: string, modelId: string): Model<Api> | undefined;
  hasConfiguredAuth(providerId: string): boolean;
}

/**
 * Whether this provider can actually be used — either an API key in the
 * environment/config or a stored credential from an OAuth/subscription login.
 *
 * Ambient credential sources (AWS profiles, Google ADC) are deliberately not
 * treated as configured; without that distinction a host that happens to have
 * AWS credentials would offer every Bedrock model as though it were ready.
 */
export function providerHasCredentials(provider: string, catalog?: ModelCatalog): boolean {
  return catalog ? catalog.hasConfiguredAuth(provider) : hasCredentials(provider);
}

export { authSourceFor };
export type { AuthSource };

function providerId(provider: string | Provider): string {
  return typeof provider === "string" ? provider : provider.id;
}

function allProviders(catalog?: ModelCatalog): string[] {
  let known: string[];
  try {
    known = catalog ? catalog.getProviders().map((p) => p.id) : ([...getProviders()] as string[]);
  } catch {
    known = [...PROVIDER_PREFERENCE];
  }
  const rank = (p: string) => {
    const i = PROVIDER_PREFERENCE.indexOf(p);
    return i === -1 ? PROVIDER_PREFERENCE.length : i;
  };
  return known.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

function modelsOf(provider: string, catalog?: ModelCatalog): { id: string; name?: string; [k: string]: unknown }[] {
  try {
    return catalog ? ([...catalog.getModels(provider)] as any[]) : ([...getModels(provider as any)] as any[]);
  } catch {
    return [];
  }
}

/**
 * Find the provider that owns a bare model id. Providers with credentials
 * configured win, so "gpt-5.4" resolves to the one you can actually call.
 */
export function inferProvider(modelId: string, catalog?: ModelCatalog): string | undefined {
  const candidates = allProviders(catalog).filter((p) => modelsOf(p, catalog).some((m) => m.id === modelId));
  if (candidates.length === 0) return undefined;
  return candidates.find((p) => providerHasCredentials(p, catalog)) ?? candidates[0];
}

export function parseRef(
  spec: string,
  catalog?: ModelCatalog,
): { provider: string; modelId: string } | undefined {
  const slash = spec.indexOf("/");
  if (slash > 0) {
    return { provider: spec.slice(0, slash), modelId: spec.slice(slash + 1) };
  }
  const provider = inferProvider(spec, catalog);
  return provider ? { provider, modelId: spec } : undefined;
}

export function resolveModel(spec: string, catalog?: ModelCatalog) {
  const parsed = parseRef(spec, catalog);
  if (!parsed) {
    throw new Error(
      `Unknown model "${spec}". Use \`!models\` to see what is available, or write it as provider/model.`,
    );
  }
  // getModel returns undefined (rather than throwing) for an unknown id, which
  // would otherwise surface much later as a confusing stream failure.
  let model: Model<Api> | undefined;
  try {
    model = catalog
      ? catalog.getModel(parsed.provider, parsed.modelId)
      : (getModel(parsed.provider as any, parsed.modelId as any) as Model<Api> | undefined);
  } catch {
    model = undefined;
  }
  if (!model) {
    const available = modelsOf(parsed.provider, catalog)
      .map((m) => m.id)
      .join(", ");
    throw new Error(
      `Unknown model "${spec}". Available for provider "${parsed.provider}": ${available || "(none)"}`,
    );
  }
  return model;
}

function describe(provider: string, raw: Record<string, any>, catalog?: ModelCatalog): ModelInfo {
  return {
    ref: `${provider}/${raw.id}`,
    id: raw.id,
    provider,
    name: raw.name ?? raw.id,
    ...(typeof raw.contextWindow === "number" ? { contextWindow: raw.contextWindow } : {}),
    ...(typeof raw.reasoning === "boolean" ? { reasoning: raw.reasoning } : {}),
    acceptsImages: Array.isArray(raw.input) && raw.input.includes("image"),
    ...(raw.cost && typeof raw.cost.input === "number"
      ? { cost: { input: raw.cost.input, output: raw.cost.output } }
      : {}),
    available: providerHasCredentials(provider, catalog),
  };
}

export interface ListModelsOptions {
  /** Catalog/runtime to read from. Defaults to the built-in pi compatibility catalog. */
  catalog?: ModelCatalog | ModelRuntime;
  /** Only providers with credentials configured. Defaults to true. */
  onlyAvailable?: boolean;
  /**
   * Channel allowlist. Entries may be a bare id, "provider/id", or "provider/*"
   * to permit a whole provider. Empty means no restriction.
   */
  allow?: string[];
}

function matchesAllow(info: ModelInfo, allow: string[]): boolean {
  if (allow.length === 0) return true;
  return allow.some((entry) => {
    if (entry === info.id || entry === info.ref) return true;
    if (entry.endsWith("/*")) return info.provider === entry.slice(0, -2);
    return false;
  });
}

export function listModels(options: ListModelsOptions = {}): ModelInfo[] {
  const onlyAvailable = options.onlyAvailable ?? true;
  const allow = options.allow ?? [];
  const catalog = options.catalog;

  const out: ModelInfo[] = [];
  for (const provider of allProviders(catalog)) {
    if (onlyAvailable && !providerHasCredentials(provider, catalog)) continue;
    for (const raw of modelsOf(provider, catalog)) {
      const info = describe(providerId(provider), raw as Record<string, any>, catalog);
      if (matchesAllow(info, allow)) out.push(info);
    }
  }
  return out;
}

/** True when the spec is permitted by the channel's allowlist. */
export function isAllowed(spec: string, allow: string[], catalog?: ModelCatalog): boolean {
  if (allow.length === 0) return true;
  const parsed = parseRef(spec, catalog);
  if (!parsed) return false;
  const info: ModelInfo = {
    ref: `${parsed.provider}/${parsed.modelId}`,
    id: parsed.modelId,
    provider: parsed.provider,
    name: parsed.modelId,
    acceptsImages: false,
    available: providerHasCredentials(parsed.provider, catalog),
  };
  return matchesAllow(info, allow);
}

/** Human-readable one-liner used in Slack replies and tool output. */
export function formatModel(info: ModelInfo): string {
  const bits: string[] = [];
  if (info.contextWindow) bits.push(`${Math.round(info.contextWindow / 1000)}k ctx`);
  if (info.reasoning) bits.push("reasoning");
  if (info.acceptsImages) bits.push("sees images");
  if (info.cost) bits.push(`$${info.cost.input}/$${info.cost.output} per Mtok`);
  return `${info.ref}${bits.length > 0 ? ` — ${bits.join(", ")}` : ""}`;
}
