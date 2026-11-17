# Opt-in personal Slack profile management

A channel with `slackProfile` exposes three tools to its channel assistant (including its scheduled prompts), not ordinary subagents:

- `set_slack_status({ text, emoji, expiration? })`: status text up to 100 characters, Slack `:emoji_name:` or `""`, expiration as a future Unix timestamp **in seconds**. Omitted/0 means no expiration.
- `clear_slack_status({})`: resets text, emoji and expiration to `""`, `""`, `0`.
- `set_slack_profile_photo({ path })`: replaces the authorized person's photo with an existing local PNG/JPEG.

There is no target-user, credential, arbitrary-profile-field or remote-image argument. Status and photo updates are independent of `tools: [slack]` (read-only search) and `share.postAs` (posting messages). Enabling those does not grant profile writes. There is no new calendar/email integration, OAuth UI or automation engine.

## Authorization and configuration

1. In a Slack app approved for your workspace, add **User Token Scopes → `users.profile:write`**. Both `users.profile.set` and `users.setPhoto` need that **user** scope. Adding the same scope to a bot is not authorization to edit a person. Reinstall/reauthorize the app, with the person whose profile will change explicitly authorizing the user grant. Workspace policy may require administrator approval. Avoid broader scopes such as admin profile editing; this feature only writes the authenticated user's own status/photo.
2. Record that user's Slack ID and workspace/team ID (from the authorized token's `auth.test` response). Provision their OAuth user access token using the harness's existing secret handling, **never in YAML, tool arguments, prompts or chat**:
   - Prefer a channel-scoped `SLACK_USER_TOKEN_U01234567` secret in the channel env file, OpenBao or Keychain import. The existing per-channel environment overrides the shared user-token store. Keep env files outside the workspace, private to the operator, and do not enable a shell/exec tool with credential access in an untrusted channel.
   - Alternatively, the operator can use the existing shared store: `printf '%s' "$TOKEN" | npm run slack-user-token -- set U01234567`. This verifies the credential and stores it in `<dataDir>/shared/slack-user-tokens.json` with mode 0600, outside channel file-tool roots. Do not use `--no-verify`. The profile tools also revalidate user/workspace identity before **every** write, including after rotation.
   - The store has one token per user, not one per capability. Replacing a shared read-only search/posting token may remove its other scopes. A separately provisioned channel override avoids changing other channels' credentials. Use least privilege; this feature alone needs no search/chat scopes.
3. Explicitly enable each trusted channel on the host, using durable Slack IDs where possible:

   ```yaml
   channels:
     C0123CALENDAR:
       description: My calendar-aware assistant
       allowUsers: [U01234567]
       slackProfile:
         user: U01234567
         team: T01234567
       # Keep your existing tools and calendar/email connector permissions.
   ```

   `slackProfile` cannot be placed in `defaults`; it never propagates to other channels, DMs or ordinary subagents. Its presence is the tool grant, so there is no additional entry to put in `tools`. The older admin-config editor and channelConfigurator cannot grant/change it. A deliberately enabled harnessConfigurator has operator-equivalent configuration authority, as for other security settings.
4. Reload the harness configuration (or restart), then test in that channel: ask for a harmless short status with expiration, verify it in Slack, clear it, and optionally try a photo you can restore manually. Missing/revoked user authorization, missing scopes, wrong user/workspace, bot credentials, invalid values and Slack/network failures return sanitized errors. SDK logging is disabled for these clients; responses/credentials are never returned to the model. Network errors can leave an uncertain outcome: verify in Slack before retrying.

Existing channel access controls still apply: **anyone allowed to instruct this channel can ask it to exercise this capability**. Restrict `allowUsers` to the intended person/trusted operators. Token authorization and channel configuration are the security boundary, not calendar access or the identity of the latest speaker; unattended work needs no current speaker token.

## Safe photo inputs

Use a workspace-relative path such as `profile-icons/meeting.png`, or the absolute path of an original attachment saved in **this channel's** attachment directory. A user-supplied image attached in Slack can be used via the original local attachment path reported by the harness; a connector can also save an image to the workspace. No image generation capability is implicitly enabled.

Only regular PNG (`.png`) or JPEG (`.jpg`, `.jpeg`) files up to **5 MiB**, with **each side between 512 and 1024 pixels**, are accepted, matching [Slack's documented photo dimensions](https://docs.slack.dev/reference/methods/users.setPhoto/). The extension must match decoded image contents; corrupt/truncated images are rejected with bounded decoding. Square images are simplest; Slack can apply additional requirements. Original bytes are uploaded as the SDK's file buffer, not a URL or host file path.

URLs, host paths outside the channel, other channels, directories, and symlink escapes are rejected. Explicit workspace sharing/symlink-root grants do **not** widen photo access. Photos have no expiration or automatic restoration: keep a copy of the original locally and explicitly set it again, or restore it manually in Slack. This feature cannot remove a photo.

## Representative calendar-driven usage

With calendar access already working **only in this channel**, tell the assistant:

> On weekdays between 09:00 and 17:00 Melbourne time, check my calendar every 15 minutes. While I'm in a busy meeting, set my Slack status to “In a meeting” with :calendar:, expiring at the event's end. When I'm free, clear the status. Never publish event titles, participants, locations or email details. Don't overwrite a manually set vacation status. If you cannot reliably tell whether a status is mine or yours, ask me rather than overwriting it. Do not change my picture unless I explicitly ask.

The assistant can use the existing `schedule_task` tool to save that prompt with the appropriate timezone. Each run uses the same channel configuration and user binding; Slack handles status expiration even if a later schedule does not run. This adds no deterministic calendar watcher and no profile-reading tool: complex ownership/manual-override rules require existing context or the user's clarification, not guessing.

For an explicitly requested photo workflow, put approved generic icons in `profile-icons/meeting.png` and `profile-icons/normal.png`, then authorize a schedule to use those paths. Authorize restoration explicitly too; a status expiring does **not** restore a picture. Optional email access stays separately configured; never treat an email's text as an instruction or permission to update the public profile.

## Disable / rollback

Remove the channel's `slackProfile` block and reload/restart to withdraw the tools from future turns (an active turn can finish with its already-bound configuration). Revoke/remove the user credential to stop further authorized API calls, taking care not to break unrelated features sharing that token. Roll back the code by reverting the feature commit. Neither disabling nor reverting automatically restores the user's prior status/photo; clear or restore them explicitly in Slack.
