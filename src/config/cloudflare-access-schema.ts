import { z } from "zod";

/** The issuer is the team's canonical Access origin, not an arbitrary key URL. */
export const CloudflareAccessSchema = z.object({
  enabled: z.boolean().default(false),
  issuer: z.string().regex(/^https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.cloudflareaccess\.com$/, "must be https://<team>.cloudflareaccess.com without a path or trailing slash").optional(),
  audience: z.string().min(1).max(1024).regex(/^\S+$/).optional(),
}).strict().superRefine((value, ctx) => {
  if (!value.enabled) return;
  for (const key of ["issuer", "audience"] as const) {
    if (!value[key]) ctx.addIssue({ code: "custom", path: [key], message: "is required when Cloudflare Access is enabled" });
  }
});

export type CloudflareAccessConfig = z.infer<typeof CloudflareAccessSchema>;
