import type { IncomingMessage } from "node:http";
import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";
import { CloudflareAccessSchema, type CloudflareAccessConfig } from "../config/cloudflare-access-schema.ts";

export interface AccessIdentity { subject: string; email?: string }
export interface AccessSession { identity: AccessIdentity; expiresAt: number }

function assertion(req: IncomingMessage): string {
  // A supplied assertion always wins: an invalid header must not fall back to a cookie.
  const header = req.headers["cf-access-jwt-assertion"];
  if (header !== undefined) return typeof header === "string" ? header : "";
  const cookies = (req.headers.cookie ?? "").split(";").map((part) => part.trim()).filter((part) => part.startsWith("CF_Authorization="));
  return cookies.length === 1 ? cookies[0]!.slice("CF_Authorization=".length) : "";
}

/** One verifier/key cache per listener. Keys come ONLY from the configured trusted team. */
export class CloudflareAccess {
  private readonly verify: (token: string) => Promise<AccessSession>;

  constructor(input: CloudflareAccessConfig, fetcher: typeof fetch = fetch) {
    // Validate here too: hand-built server configs must not bypass startup validation.
    const config = CloudflareAccessSchema.parse(input);
    if (!config.enabled || !config.issuer || !config.audience) throw new Error("Cloudflare Access verifier requires enabled configuration");
    const keys = createRemoteJWKSet(new URL(`${config.issuer}/cdn-cgi/access/certs`), {
      timeoutDuration: 5_000, cooldownDuration: 30_000, cacheMaxAge: 600_000,
      [customFetch]: (url, options) => fetcher(url, { ...options, redirect: "error" }),
    });
    this.verify = async (token) => {
      const { payload } = await jwtVerify(token, keys, {
        issuer: config.issuer, audience: config.audience, algorithms: ["RS256"],
        requiredClaims: ["exp", "iat", "sub"],
      });
      if (!payload.sub?.trim() || typeof payload.iat !== "number" || payload.iat > Date.now() / 1000) throw new Error("Invalid Access claims");
      return {
        identity: { subject: payload.sub, ...(typeof payload.email === "string" && payload.email.trim() ? { email: payload.email } : {}) },
        expiresAt: payload.exp! * 1000,
      };
    };
  }

  async authenticate(req: IncomingMessage): Promise<AccessSession | undefined> {
    const token = assertion(req);
    if (!token || token.length > 16_384) return undefined;
    try { return await this.verify(token); } catch { return undefined; } // Never log tokens, claims or key-fetch errors.
  }
}
