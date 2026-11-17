export const ADMIN_CONFIG = `# Operator-maintained harness config
name: Mock harness
defaults:
  model: anthropic/claude-sonnet-5-5
  thinkingLevel: medium
  preferences: Be concise.
channels:
  general:
    description: Team assistant
    model: openai/gpt-5.4
    thinkingLevel: low
    preferences: Summarise decisions.
  project-x:
    description: Software factory
    admin: true
webConsole:
  enabled: true
  baseUrl: https://console.example.test
# This section has no form controls; references must survive.
connectors:
  github:
    transport: http
    url: https://api.githubcopilot.com/mcp/
    headers:
      Authorization: Bearer \${GITHUB_TOKEN}
`;
