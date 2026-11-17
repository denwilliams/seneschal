import { isAbsolute } from "node:path";
import { z } from "zod";
import { protectedEnvName } from "./managed-env.ts";

export const secretName = /^[A-Z][A-Z0-9_]{0,127}$/;
export const channelId = /^[CDG][A-Z0-9]+$/;
export const bootstrapName = (name: string): boolean => /^(BAO_|VAULT_|HARNESS_OPENBAO_)/.test(name);
const name = z.string().regex(secretName).refine((value) => !protectedEnvName(value) && !bootstrapName(value), "protected secret name");
const names = z.array(name).max(256).refine((values) => new Set(values).size === values.length, "duplicate secret names");
const path = z.string().regex(/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/);
export const OpenBaoSchema = z.object({
  address: z.string().url().refine((value) => {
    try {
      const url = new URL(value);
      return (url.protocol === "https:" || url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
        && !url.username && !url.password && !url.search && !url.hash && url.pathname === "/";
    } catch { return false; }
  }, "use an HTTPS origin (HTTP is only allowed on loopback), without credentials, path, query or fragment"),
  tokenFile: z.string().refine(isAbsolute, "use an absolute private token file path"),
  /** Optional separate provisioning credential; enables write-only web Admin saves. */
  adminTokenFile: z.string().refine(isAbsolute, "use an absolute private token file path").optional(),
  /** Operator-only acceptance of same-user access to token files, process memory and all backend scopes. */
  acceptHostExecutionRisk: z.boolean().default(false),
  mount: path.default("secret"),
  prefix: path.default("harness"),
  timeoutMs: z.number().int().min(100).max(30000).default(5000),
  globalChannel: names.default([]),
  channels: z.record(z.string().regex(channelId), names).default({}),
  mainProcess: names.default([]),
  /** Provider id -> name in mainProcess. Passed to the SDK's memory-only credential API. */
  providerKeys: z.record(z.string().regex(/^[a-z0-9][a-z0-9_-]*$/), name).default({}),
}).strict().superRefine((value, ctx) => {
  for (const key of Object.values(value.providerKeys)) {
    if (!value.mainProcess.includes(key)) ctx.addIssue({ code: "custom", path: ["providerKeys"], message: "provider keys must be imported in mainProcess" });
  }
});
export type OpenBaoConfig = z.infer<typeof OpenBaoSchema>;
export type SecretScope = { kind: "channel"; channel: string } | { kind: "global-channel" | "main-process" };
