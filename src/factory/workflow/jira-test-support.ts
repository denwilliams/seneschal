import { readFileSync } from "node:fs";
import { FactoryJiraSchema } from "../../config/schema.ts";
import type { AcliRun } from "./jira.ts";

export const JIRA = FactoryJiraSchema.parse({ site: "example.atlassian.net", components: ["harness", "platform"], intakeLabel: "agent_ready", trustedAccountIds: ["maintainer"] });
export function mockAcli() {
  const state = {
    calls: [] as string[][], eligible: true, duplicate: false, unauthorized: false, wrongSite: false, transitionError: false, silentTransition: false, malformed: false, identityAccountId: "agent" as string | null,
    raw: { id: "10001", key: "HAR-123", fields: {
      summary: "Add Jira tracking", description: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Acceptance criteria: preserve merge safeguards" }] }] },
      creator: { accountId: "maintainer" }, assignee: { accountId: "agent" } as { accountId: string } | null, components: [{ name: "harness" }, { name: "platform" }], project: { key: "HAR" }, labels: ["agent_ready"], created: new Date().toISOString(), updated: new Date().toISOString(),
      status: { name: "To Do", statusCategory: { key: "new" } }, comment: { total: 0 },
    } },
    comments: [] as { author: { accountId: string }; body: string; created: string; updated: string }[],
  };
  const addComment = (body: string, author = "agent", at = Date.now()) => {
    const date = new Date(at).toISOString();
    state.comments.push({ author: { accountId: author }, body, created: date, updated: date });
    state.raw.fields.comment.total = state.comments.length;
    state.raw.fields.updated = date;
  };
  const run: AcliRun = async (args) => {
    state.calls.push([...args]);
    if (state.unauthorized) throw new Error("ACLI authentication failed");
    if (args.join(" ") === "jira auth status") return { stdout: `Logged in to ${state.wrongSite ? "wrong.atlassian.net" : JIRA.site}` };
    if (args[2] === "view") return { stdout: JSON.stringify(state.raw) };
    if (args[2] === "search") {
      const requested = args[args.indexOf("--fields") + 1];
      if (requested !== "key" && requested !== "assignee") throw new Error("ACLI search field allowlist violated");
      if (state.malformed) return { stdout: '{"unexpected":true}' };
      const jql = args[args.indexOf("--jql") + 1]!;
      if (jql === "assignee = currentUser()") return { stdout: JSON.stringify(state.identityAccountId ? [{ fields: { assignee: { accountId: state.identityAccountId } } }] : []) };
      const selected = !jql.includes("currentUser()") || (state.eligible && state.raw.fields.status.statusCategory.key !== "done");
      const key = { id: state.raw.id, key: state.raw.key };
      return { stdout: JSON.stringify(selected ? state.duplicate && !jql.startsWith("id =") && !jql.startsWith("key =") ? [key, key] : [key] : []) };
    }
    if (args[2] === "transition") {
      if (state.transitionError) throw new Error("ACLI transition forbidden");
      if (!state.silentTransition) {
        state.raw.fields.status.name = args[args.indexOf("--status") + 1]!;
        state.raw.fields.status.statusCategory.key = state.raw.fields.status.name === JIRA.statuses.completed ? "done" : "indeterminate";
      }
      return { stdout: "{}" };
    }
    if (args[2] === "comment" && args[3] === "list") return { stdout: JSON.stringify(state.comments) };
    if (args[2] === "comment" && args[3] === "create") {
      addComment(readFileSync(args[args.indexOf("--body-file") + 1]!, "utf8"));
      return { stdout: "{}" };
    }
    throw new Error(`Unexpected ACLI command ${args.join(" ")}`);
  };
  return { state, run, addComment };
}
