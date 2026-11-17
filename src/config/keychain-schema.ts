import { isAbsolute } from "node:path";
import { z } from "zod";
import { protectedEnvName } from "./managed-env.ts";

export const secretName = /^[A-Z][A-Z0-9_]{0,127}$/;
export const channelId = /^[CDG][A-Z0-9]+$/;
export const validSecretName = (name: string): boolean => secretName.test(name) && !protectedEnvName(name);
export const SecretScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("channel"), channel: z.string().regex(channelId) }).strict(),
  z.object({ kind: z.literal("global-channel") }).strict(),
  z.object({ kind: z.literal("main-process") }).strict(),
]);
export type SecretScope = z.infer<typeof SecretScopeSchema>;
const name = z.string().refine(validSecretName, "invalid or protected secret name");
const names = z.array(name).max(256).refine((values) => new Set(values).size === values.length, "duplicate secret names");
export const KeychainSchema = z.object({
  helperPath: z.string().refine(isAbsolute, "use an absolute private helper path"),
  namespace: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).default("default"),
  adminWrites: z.boolean().default(false),
  /** Operator accepts same-user host execution bypassing Keychain import scopes. */
  acceptHostExecutionRisk: z.boolean().default(false),
  timeoutMs: z.number().int().min(100).max(10000).default(3000),
  cache: z.object({
    ttlMs: z.number().int().min(0).max(3600000).default(60000),
    maxEntries: z.number().int().min(0).max(4096).default(256),
    maxBytes: z.number().int().min(0).max(64 * 1024 * 1024).default(4 * 1024 * 1024),
  }).prefault({}),
  globalChannel: names.default([]),
  channels: z.record(z.string().regex(channelId), names).default({}),
  mainProcess: names.default([]),
  providerKeys: z.record(z.string().regex(/^[a-z0-9][a-z0-9_-]*$/), name).default({}),
}).strict().superRefine((value, ctx) => {
  for (const key of Object.values(value.providerKeys)) {
    if (!value.mainProcess.includes(key)) ctx.addIssue({ code: "custom", path: ["providerKeys"], message: "provider keys must be imported in mainProcess" });
  }
});
export type KeychainConfig = z.infer<typeof KeychainSchema>;
