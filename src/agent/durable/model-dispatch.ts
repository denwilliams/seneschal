import {
  lazyStream, normalizeContext,
  type AnyModel, type Models, type ModelsRequestTransforms,
  type ProviderRequestOptions, type ProviderHeaders,
} from "@earendil-works/pi-ai";
import {
  assertChatModel, assertClassifierModel, assertImageModel, classifierErrorResult, imageErrorResult,
} from "@earendil-works/pi-ai/utils/model-operations";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

// Published ModelRuntime 1.0.3 / pi-ai 1.0.4 virtual catalog API. Unknown routing
// schemes must not silently become authorization grants on an SDK upgrade.
const virtual = (model: AnyModel) => model.api === "pi-virtual";
type RequestOptions = Pick<ProviderRequestOptions<AnyModel>, "apiKey" | "headers" | "env" | "signal"> & ModelsRequestTransforms;
const operations = ["stream", "complete", "streamSimple", "completeSimple", "streamDeferred", "fetchDeferred", "cancelDeferred", "generateImages", "classify"] as const;

/** Own the last transport boundary; never delegate to opaque Models routing. */
export function modelDispatch(models: Models, authorize: (model: AnyModel, handle?: unknown) => void) {
  function physical(model: AnyModel, handle?: unknown): void {
    authorize(model, handle);
    const catalog = models.getModelOfType(model.type ?? "chat", model.provider, model.id);
    if (!catalog || catalog.api !== model.api || virtual(catalog) || virtual(model)) {
      throw new Error(`Model must be a physical catalog target: ${model.provider}/${model.id}`);
    }
  }
  async function resolveModel(...args: Parameters<ModelRuntime["resolveModel"]>) {
    authorize(args[0]);
    const resolve = (models as Partial<ModelRuntime>).resolveModel;
    if (!resolve) throw new Error("Virtual model routing is unavailable");
    const route = await resolve.apply(models, args);
    physical(route.model);
    // A router must not retain a mutable object that can change the admitted target.
    return { ...route, model: structuredClone(route.model) };
  }
  async function prepare<T extends AnyModel, O extends RequestOptions>(model: T, options?: O, handle?: unknown) {
    physical(model, handle); // before credentials/OAuth refresh (which can use the network)
    const resolution = await models.getAuth(model, { apiKey: options?.apiKey, env: options?.env, signal: options?.signal });
    if (!resolution) throw new Error(`Provider is not configured: ${model.provider}`);
    let headers = mergeHeaders(resolution.auth.headers, options?.headers);
    if (options?.transformHeaders) headers = await options.transformHeaders(headers ?? {});
    const { transformHeaders: _transform, ...rest } = options ?? {};
    const requestModel = resolution.auth.baseUrl ? { ...model, baseUrl: resolution.auth.baseUrl } : model;
    // Recheck AFTER asynchronous auth/header hooks, immediately before provider dispatch.
    physical(requestModel, handle);
    const provider = models.getProvider(requestModel.provider);
    if (!provider || provider.id !== requestModel.provider) throw new Error("Provider/model mismatch");
    return { provider, model: requestModel, options: { ...rest,
      apiKey: options?.apiKey ?? resolution.auth.apiKey, headers,
      env: resolution.env || options?.env ? { ...resolution.env, ...options?.env } : undefined,
    } as O };
  }
  const transport: Pick<Models, typeof operations[number]> = {
    stream(model, context, options) {
      const transcript = normalizeContext(context);
      return lazyStream(model, async () => {
        assertChatModel(model);
        const p = await prepare(model, options);
        return p.provider.stream(p.model, transcript, p.options);
      });
    },
    complete(model, context, options) { return transport.stream(model, context, options).result(); },
    streamSimple(model, context, options) {
      const transcript = normalizeContext(context);
      return lazyStream(model, async () => {
        assertChatModel(model);
        const catalog = models.getModel(model.provider, model.id);
        if (virtual(model) || (catalog && virtual(catalog))) {
          const route = await resolveModel(model, transcript.messages, {
            reason: "direct", thinkingLevel: options?.reasoning ?? "off", signal: options?.signal,
          });
          const limit = route.model.maxTokens;
          const maxTokens = options?.maxTokens && limit > 0 ? Math.min(options.maxTokens, limit) : options?.maxTokens;
          const reasoning = route.thinkingLevel === "off" ? undefined : route.thinkingLevel;
          // Match ModelRuntime: do not leak alias credentials/headers/env to another provider.
          const { apiKey, headers, env, ...rest } = options ?? {};
          const auth = route.model.provider === model.provider ? { apiKey, headers, env } : {};
          return transport.streamSimple(route.model, transcript, { ...rest, ...auth, maxTokens, reasoning });
        }
        const p = await prepare(model, options);
        return p.provider.streamSimple(p.model, transcript, p.options);
      });
    },
    completeSimple(model, context, options) { return transport.streamSimple(model, context, options).result(); },
    streamDeferred(model, handle, options) {
      return lazyStream(model, async () => {
        assertChatModel(model);
        const p = await prepare(model, options, handle);
        if (!p.provider.fetchDeferred) throw new Error("Provider does not support deferred responses");
        return p.provider.fetchDeferred(p.model, handle, p.options);
      });
    },
    fetchDeferred(model, handle, options) { return transport.streamDeferred(model, handle, options).result(); },
    async cancelDeferred(model, handle, options) {
      assertChatModel(model);
      const p = await prepare(model, options, handle);
      if (!p.provider.cancelDeferred) throw new Error("Provider does not support deferred responses");
      await p.provider.cancelDeferred(p.model, handle, p.options);
    },
    async generateImages(model, context, options) {
      try {
        assertImageModel(model);
        const p = await prepare(model, options);
        if (!p.provider.generateImages) throw new Error("Provider does not support images");
        return await p.provider.generateImages(p.model, context, p.options);
      } catch (error) { return imageErrorResult(model, error, options?.signal?.aborted); }
    },
    async classify(model, context, options) {
      try {
        assertClassifierModel(model);
        const p = await prepare(model, options);
        if (!p.provider.classify) throw new Error("Provider does not support classification");
        return await p.provider.classify(p.model, context, p.options);
      } catch (error) { return classifierErrorResult(model, error, options?.signal?.aborted); }
    },
  };
  return { transport, resolveModel, physical };
}

function mergeHeaders(base?: ProviderHeaders, override?: ProviderHeaders) {
  if (!base && !override) return undefined;
  const merged = { ...base };
  for (const [name, value] of Object.entries(override ?? {})) {
    for (const existing of Object.keys(merged)) if (existing.toLowerCase() === name.toLowerCase()) delete merged[existing];
    merged[name] = value;
  }
  return merged;
}
