/** Synthetic OAuth metadata shared by regression tests; no live provider traffic. */
export const oauthTestDiscovery = {
  authorizationServerUrl: "https://login.example.org",
  resourceMetadata: {
    resource: "https://mcp.example.org", authorization_servers: ["https://login.example.org"],
    scopes_supported: ["mcp:read", "account:read", "rules:write"],
  },
  authorizationServerMetadata: {
    issuer: "https://login.example.org", authorization_endpoint: "https://login.example.org/authorize",
    token_endpoint: "https://login.example.org/token", registration_endpoint: "https://login.example.org/register",
    response_types_supported: ["code"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"],
  },
};
