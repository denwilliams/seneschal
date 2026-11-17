import type { AnyModel, Models, Provider } from "@earendil-works/pi-ai";
import type { ModelRef, TaskInspection } from "@earendil-works/pi-durable";
import { modelDispatch } from "./model-dispatch.ts";

/** One immutable policy for admission, recovered checkpoints AND actual dispatch. */
export function modelPolicy(models: Models, allowedModels: readonly string[]) {
  const allowed = new Set(allowedModels);
  function check(ref: ModelRef): void {
    const name = `${ref.provider}/${ref.modelId}`;
    if (!allowed.has(name)) throw new Error(`Model is not allowed: ${name}`);
    if (!models.getModel(ref.provider, ref.modelId)) throw new Error(`Unknown model: ${name}`);
  }
  function dispatch(model: AnyModel, handle?: unknown): void {
    const name = `${model.provider}/${model.id}`;
    if (!allowed.has(name)) throw new Error(`Model is not allowed: ${name}`);
    if (!models.getModelOfType(model.type ?? "chat", model.provider, model.id)) throw new Error(`Unknown model: ${name}`);
    if (handle !== undefined) {
      const ref = reference(handle);
      check(ref);
      if (ref.provider !== model.provider || ref.modelId !== model.id) throw new Error("Deferred model mismatch");
    }
  }
  const boundary = modelDispatch(models, dispatch);
  // Retain the single credential/router owner without mutating it or its providers.
  // All facade transports dispatch via the authorized physical provider boundary.
  function provider(value: Provider): Provider {
    return new Proxy(value, {
      get(target, key) {
        const member = Reflect.get(target, key, target);
        if (typeof member !== "function") return member;
        if (["stream", "streamSimple", "fetchDeferred", "cancelDeferred", "generateImages", "classify"].includes(String(key))) {
          return (model: AnyModel, ...args: unknown[]) => {
            if (model.provider !== target.id) throw new Error("Provider/model mismatch");
            const snapshot = structuredClone(model);
            boundary.physical(snapshot, key === "fetchDeferred" || key === "cancelDeferred" ? args[0] : undefined);
            return Reflect.apply(member, target, [snapshot, ...args]);
          };
        }
        return member.bind(target);
      },
    });
  }
  const guarded: Models = new Proxy(models, {
    get(target, key) {
      if (key === "getProvider") return (id: string) => { const found = target.getProvider(id); return found && provider(found); };
      if (key === "getProviders") return () => target.getProviders().map(provider);
      if (key === "resolveModel") return boundary.resolveModel;
      if (Object.hasOwn(boundary.transport, key)) {
        return (model: AnyModel, ...args: unknown[]) => {
          dispatch(model, ["streamDeferred", "fetchDeferred", "cancelDeferred"].includes(String(key)) ? args[0] : undefined);
          return Reflect.apply(Reflect.get(boundary.transport, key), boundary.transport, [structuredClone(model), ...args]);
        };
      }
      // Expose only the pinned Models non-transport contract, not private runtime
      // state or future unreviewed routing/dispatch APIs.
      if (!["getModels", "getModel", "getModelsOfType", "getModelOfType", "getAllModels", "refresh", "checkAuth",
        "getAvailable", "getAvailableOfType", "getAllAvailable", "getAuth", "login", "logout"].includes(String(key))) return undefined;
      const member = Reflect.get(target, key, target);
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
  return {
    check,
    models: guarded,
    checkCheckpoint({ record }: TaskInspection): void {
      if (record.state.status === "completing" || record.state.status === "terminal") return;
      if (record.kind !== "pi.generation" && record.kind !== "pi.compaction") return;
      const checkpoint = record.state.checkpoint;
      // Generation v2 adds unoffered-tool bookkeeping and run-end phases; v1 checkpoints migrate unchanged.
      const versions = record.kind === "pi.generation" ? [1, 2] : [1];
      if (!versions.includes(record.version) || !checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint)) {
        throw new Error(`Unsupported model task checkpoint: ${record.kind}`);
      }
      const phases = record.kind === "pi.generation"
        ? ["prepare", "request", "retry", "poll", "tools", ...(record.version === 2 ? ["finish", "drain"] : [])] : ["select", "summarize", "retry"];
      if (typeof checkpoint.phase !== "string" || !phases.includes(checkpoint.phase)) {
        throw new Error(`Unsupported model task phase: ${record.kind}`);
      }
      const pinned = record.kind === "pi.generation"
        ? ["request", "poll"].includes(checkpoint.phase) : ["summarize", "retry"].includes(checkpoint.phase);
      if (pinned) check(reference(checkpoint.model));
      // A poll interrupted in 1.5 sleeps in retry.poll, retaining the provider handle and pinned model.
      const poll = checkpoint.phase === "poll" ? checkpoint
        : checkpoint.phase === "retry" && record.kind === "pi.generation" ? checkpoint.poll : undefined;
      if (poll !== undefined) {
        if (!poll || typeof poll !== "object" || Array.isArray(poll)) throw new Error("Missing pinned model");
        const model = reference("model" in poll ? poll.model : undefined);
        const handle = reference("handle" in poll ? poll.handle : undefined);
        check(model);
        check(handle);
        if (handle.provider !== model.provider || handle.modelId !== model.modelId) throw new Error("Deferred model mismatch");
      }
    },
  };
}

function reference(value: unknown): ModelRef {
  if (!value || typeof value !== "object" || !("provider" in value) || !("modelId" in value) ||
      typeof value.provider !== "string" || typeof value.modelId !== "string") throw new Error("Missing pinned model");
  return { provider: value.provider, modelId: value.modelId };
}
