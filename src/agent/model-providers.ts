import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ModelProviderConfig } from "../config/schema.ts";

/**
 * Register model servers declared in harness.yaml.
 *
 * These are OpenAI-compatible Chat Completions endpoints such as Ollama, LM
 * Studio, vLLM, llama.cpp, or TurboFieldfare. They are account-wide model
 * providers; channel `models` allowlists still decide where they may be used.
 */
export function registerConfiguredModelProviders(
  runtime: ModelRuntime,
  providers: Record<string, ModelProviderConfig>,
): void {
  for (const [providerId, provider] of Object.entries(providers)) {
    runtime.registerProvider(providerId, {
      ...(provider.name ? { name: provider.name } : {}),
      baseUrl: provider.baseUrl,
      api: "openai-completions",
      apiKey: provider.apiKey,
      ...(Object.keys(provider.headers).length > 0 ? { headers: provider.headers } : {}),
      ...(provider.compat ? { compat: provider.compat } : {}),
      models: provider.models.map((model) => ({
        ...model,
        api: "openai-completions",
      })),
    } as Parameters<ModelRuntime["registerProvider"]>[1]);
  }
}
