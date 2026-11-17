export function usage(): string {
  return [
    "Usage:",
    "  npm run slack-user-token -- list",
    "  npm run slack-user-token -- set [USER_ID] [--no-verify]",
    "  npm run slack-user-token -- remove USER_ID",
    "",
    "For set, pass the token on stdin or in SLACK_USER_TOKEN:",
    "  printf '%s' \"$TOKEN\" | npm run slack-user-token -- set U01234567",
    "",
    "Use a Slack user token with read/search scopes (search:read) to let the harness use search.messages.",
    "Posting as a user (share.postAs) additionally needs chat:write, im:write, users:read, channels:read,",
    "groups:read, im:read and mpim:read on that user's token. Tokens are stored per Slack user id, and a",
    "token is only ever used by the channel's own postAs.user.",
  ].join("\n");
}
