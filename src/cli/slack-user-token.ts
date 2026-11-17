import { stdin } from "node:process";
import { WebClient } from "@slack/web-api";
import { loadConfig } from "../config/load.ts";
import { ensureSharedDirs } from "../workspace/paths.ts";
import { usage } from "./slack-user-token-help.ts";
import { defaultSlackUserTokenPath, SlackUserTokenStore } from "../agent/slack-user-tokens.ts";

async function readToken(): Promise<string> {
  const fromEnv = process.env.SLACK_USER_TOKEN?.trim();
  if (fromEnv) return fromEnv;

  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const token = Buffer.concat(chunks).toString("utf-8").trim();
  if (!token) throw new Error("No token provided on stdin or SLACK_USER_TOKEN.");
  return token;
}

async function authTest(token: string): Promise<{ userId: string; teamId?: string; team?: string }> {
  const res = (await new WebClient(token).auth.test()) as { ok?: boolean; user_id?: string; team_id?: string; team?: string; error?: string };
  if (res.ok === false) throw new Error(`Slack auth.test failed: ${res.error ?? "unknown_error"}`);
  if (!res.user_id) throw new Error("Slack auth.test did not return a user_id; this does not look like a user token.");
  return { userId: res.user_id, ...(res.team_id ? { teamId: res.team_id } : {}), ...(res.team ? { team: res.team } : {}) };
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(usage());
    return;
  }

  const { dataDir } = loadConfig(process.env.HARNESS_CONFIG);
  const shared = ensureSharedDirs(dataDir);
  const store = new SlackUserTokenStore(defaultSlackUserTokenPath(shared));

  switch (cmd) {
    case "list": {
      const users = store.listUsers();
      if (users.length === 0) console.log("No Slack user tokens stored.");
      else console.log(users.join("\n"));
      return;
    }
    case "remove": {
      const userId = args[0];
      if (!userId) throw new Error("Usage: npm run slack-user-token -- remove USER_ID");
      console.log(store.removeUser(userId) ? `Removed ${userId}.` : `No stored token for ${userId}.`);
      return;
    }
    case "set": {
      const noVerify = args.includes("--no-verify");
      const userArg = args.find((a) => !a.startsWith("--"));
      const token = await readToken();

      let userId = userArg;
      let teamId: string | undefined;
      let team: string | undefined;
      if (!noVerify) {
        const auth = await authTest(token);
        userId = userId ?? auth.userId;
        if (userId !== auth.userId) {
          throw new Error(`Token belongs to ${auth.userId}, not ${userId}.`);
        }
        teamId = auth.teamId;
        team = auth.team;
      }
      if (!userId) throw new Error("USER_ID is required with --no-verify.");

      store.setUser(userId, { token, ...(teamId ? { teamId } : {}), ...(team ? { team } : {}) });
      console.log(`Stored Slack user token for ${userId}.`);
      return;
    }
    default:
      throw new Error(`Unknown command: ${cmd}\n\n${usage()}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
