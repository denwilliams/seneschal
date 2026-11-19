/**
 * What the admin channel's agent may change in `harness.yaml`, and what stays an edit on the host.
 *
 * It is a blacklist, with a safety net: EVERY key the schema has is classified here (a test fails when one is added without a
 * decision), so a new setting cannot become editable by being forgotten. Two layers:
 *
 *  1. Which setting is being touched. The refusals are the ones that move trust: where secrets live, what runs on the host,
 *     what the harness listens on, who administers it.
 *  2. What the file would MEAN afterwards, because the dangerous cases are about a value, not a path: a connector that runs a
 *     command, a tool list that gains a shell, an approval that has been switched off.
 *
 * The admin channel's own entry is never editable from inside it, and nothing here sets or clears `admin`.
 */

export interface PolicyEdit { path: string[]; remove?: boolean; value?: unknown }

export interface PolicyContext {
  /** The parsed file as it is now, and as it would be, with `${VAR}` left unexpanded. */
  before: unknown;
  after: unknown;
  /** Config keys of channels with `admin: true`, plus the channel the request came from. Nothing under them is editable. */
  protectedChannels: ReadonlySet<string>;
  /** The config key each person-supplied channel name resolved to (so `engineering` and `#engineering` are one channel). */
  resolve?: (name: string) => string | undefined;
  /**
   * A person has approved these edits one by one in Slack. Lifts exactly the settings in `NEEDS_APPROVAL` and nothing else:
   * everything else on the blacklist stays refused.
   */
  privileged?: boolean;
}

type Tree = Record<string, unknown>;
const isTree = (v: unknown): v is Tree => typeof v === "object" && v !== null && !Array.isArray(v);
const get = (tree: unknown, ...path: string[]): unknown => path.reduce<unknown>((node, key) => (isTree(node) ? node[key] : undefined), tree);

const HOST = "is edited on the host";

/** Top-level settings. `deny` carries the reason, which is what the person is told. */
export const TOP_LEVEL: Record<string, "allow" | { deny: string }> = {
  name: "allow",
  connectors: "allow", // with its own rules below
  defaults: "allow", // only some of it, see DEFAULTS
  agentSets: "allow", // with its own rules below
  channels: "allow", // with its own rules below
  channelTopicUsage: "allow",
  schedules: "allow",
  dreams: "allow",
  notifications: "allow",
  shortcuts: "allow",
  reactionTriggers: "allow", // invocation only; channel/user/tool/approval boundaries are unchanged
  feedback: "allow",
  ui: "allow",
  dataDir: { deny: "decides where every channel's state and secrets are kept" },
  documentsDir: { deny: "points the document library at a folder on the host" },
  keychain: { deny: "controls host Keychain access, scope and imports" },
  authPath: { deny: "is the credential store for model logins" },
  openbao: { deny: "controls secret scopes, backend destinations and host authentication credentials" },
  envFile: { deny: "is the file of secrets shared by every channel" },
  cliTools: { deny: "defines commands that run on the host" },
  knowledgeBases: { deny: "points the harness at folders on the host" },
  librarian: "allow",
  modelProviders: { deny: "sets where prompts and API keys are sent" },
  requires: { deny: "can stop the harness from starting if it is wrong" },
  allowUnconfiguredChannels: { deny: "decides whether channels nobody configured can use the bot" },
  allowDirectMessages: { deny: "decides whether anyone can open a private conversation with the bot" },
  webConsole: { deny: "sets what the harness listens on and who can reach it" },
  backups: { deny: "sets where copies of the harness's data go" },
};

/** Account defaults every channel inherits, the admin channel included. Only the harmless ones. */
export const DEFAULTS: Record<string, "allow" | { deny: string }> = {
  slackProfile: { deny: "profile writes are enabled on individual channels on the host" },
  model: "allow", thinkingLevel: "allow", models: "allow", preferences: "allow", context: "allow", recentConversations: "allow", interactiveComponents: "allow",
  tools: { deny: "would change what every channel can do, the admin channel too" },
  sandbox: { deny: "decides where shell commands run and what they can reach" },
  exec: { deny: "defines commands that run on the host" },
  jobs: { deny: "defines what a channel runs unattended, built from commands that run on the host: an operator's decision, not the admin agent's" },
  workspace: { deny: "can give every channel access to folders on the host" },
  web: { deny: "decides what every channel's web tools can reach, local network included" },
  images: { deny: "holds an image provider's key and settings" },
  permissions: { deny: "decides what can be granted and who approves it" },
  share: { deny: "would change what every channel shares, the admin channel too" },
  allowUsers: { deny: "decides who can use every channel" },
};

/** Per-channel settings. `tools` is allowed but cannot gain a shell (a result check below). */
export const CHANNEL: Record<string, "allow" | { deny: string }> = {
  slackProfile: { deny: "authorizes writes to a person's Slack status and profile picture" },
  description: "allow", model: "allow", thinkingLevel: "allow", models: "allow", preferences: "allow", respondToRootMessages: "allow",
  context: "allow", recentConversations: "allow", interactiveComponents: "allow", schedules: "allow", dreams: "allow",
  agentSet: "allow", agentOverrides: "allow", factory: "allow", allowUsers: "allow", tools: "allow",
  connectors: "allow", // this channel's own connectors: same rules as the shared ones
  share: "allow", // only some of it, see SHARE
  admin: { deny: "decides which channel administers the harness" },
  configurators: { deny: "grants configuration administration, including harness-wide authority" },
  requires: { deny: "can stop the harness from starting if it is wrong" },
  sandbox: { deny: "decides where shell commands run and what they can reach" },
  exec: { deny: "defines commands that run on the host" },
  jobs: { deny: "defines what a channel runs unattended, built from commands that run on the host: an operator's decision, not the admin agent's" },
  workspace: { deny: "can give a channel access to folders on the host" },
  web: { deny: "decides what a channel's web tools can reach, local network included" },
  images: { deny: "holds an image provider's key and settings" },
  permissions: { deny: "decides what can be granted and who approves it" },
  envFile: { deny: "points a channel at a file of secrets" },
};

/**
 * A channel's `factory` block. Which repositories and skills it works with is the admin agent's to change; who may approve a merge
 * and when one happens without a person is not: it decides what reaches a default branch, so it is an operator's decision.
 */
export const FACTORY: Record<string, "allow" | { deny: string }> = {
  name: "allow", repositories: "allow", lifecycleSkills: "allow", announce: "allow",
  deploy: { deny: "selects how deployment is performed or observed: an operator's decision, not the admin agent's" },
  commitAuthor: { deny: "sets attribution for new factory commits: an operator's decision, not the admin agent's" },
  merge: { deny: "decides who can approve a merge and when a pull request merges without a person: an operator's decision, not the admin agent's" },
  repositoryRules: { deny: "decides who can approve a merge and when a pull request merges without a person: an operator's decision, not the admin agent's" },
  issues: { deny: "lets the channel write issues to GitHub from whatever it is told: an operator's decision, not the admin agent's" },
  jira: { deny: "selects Jira scope, trusted accounts and workflow transitions: an operator's decision, not the admin agent's" },
  intake: { deny: "makes the harness start workflow runs, and spend model time, for issues anyone can file: an operator's decision, not the admin agent's" },
  reviewRounds: { deny: "sets how many review rounds run before a person is asked, and so how much model time one issue may use: an operator's decision, not the admin agent's" },
  autonomy: { deny: "sets how much of its own judgement the factory is trusted with (when a pull request merges without a person, how long it waits before going on with assumptions, how many rounds and retries it takes): an operator's decision, not the admin agent's" },
  autoRetries: { deny: "sets how many times a failed stage is tried again without asking a person, and so how much model time one issue may use: an operator's decision, not the admin agent's" },
  maxLiveRuns: { deny: "sets how many workflow runs work at once, and so how much model time the factory may use: an operator's decision, not the admin agent's" },
};

/** What a channel shares or reads. Connectors and read-only sharing are fine; anything that writes where others read, or reaches into another channel, is not. */
export const SHARE: Record<string, "allow" | { deny: string }> = {
  knowledge: "allow", knowledgeBases: "allow", skillCollections: "allow", library: "allow", documents: "allow", documentsAdd: "allow", connectors: "allow", memoryRead: "allow",
  skills: { deny: "was removed from the config" },
  delegateTo: { deny: "lets a channel hand work to another channel and run it with that channel's powers" },
  postTo: { deny: "lets a channel publish messages to other channels" },
  postAs: { deny: "lets a channel post to Slack as a real person" },
  memoryWrite: { deny: "writes to the memory every channel reads" },
  channelMemoryRead: { deny: "lets a channel read another channel's memory" },
  libraryPublish: { deny: "puts instructions where other channels may follow them" },
  sharedToolsPublish: { deny: "puts executable scripts where other channels may run them" },
  sharedTools: { deny: "decides which shared scripts a channel may run" },
};

/**
 * The four things a channel's agent may only change with a person's click. Each is about reach: where shell commands run,
 * whether a channel has a shell, whether it can run work with another channel's powers, and whether it can speak as a person
 * (which includes the reviewer role that guards it, checked in `checkResult`). Only for channels other than the admin one; the
 * approval message shows exactly what would change.
 */
export const NEEDS_APPROVAL = {
  channel: ["sandbox"],
  share: ["delegateTo", "postAs"],
  /** Taking host commands away from a channel. Defining them stays on the host. */
  channelRemoveOnly: ["exec"],
  shellTools: ["bash", "exec"],
} as const;

const SLACK_USER_ID = /^[UW][A-Z0-9]{2,}$/;
const MAX_ALLOWED_USERS = 50;
const SHELL_TOOLS: readonly string[] = NEEDS_APPROVAL.shellTools;
const LOCAL_HOSTS = /^(localhost|0\.0\.0\.0|\[?::1?\]?|metadata\.google\.internal|.*\.localhost)$/i;

function classify(table: Record<string, "allow" | { deny: string }>, key: string): "allow" | { deny: string } {
  return table[key] ?? { deny: "is not a setting this tool knows" };
}

/** Why a path cannot be edited, if it cannot. Only looks at which setting is touched. */
function checkPath(edit: PolicyEdit, ctx: PolicyContext): string | undefined {
  const [top, second, third, fourth] = edit.path;
  const label = edit.path.join(".");
  if (!top) return "An edit needs a path.";
  const topClass = classify(TOP_LEVEL, top);
  if (topClass !== "allow") return `"${top}" ${topClass.deny}, so it ${HOST}.`;

  if (top === "defaults") {
    if (!second) return `"defaults" as a whole cannot be replaced; change its individual settings.`;
    const c = classify(DEFAULTS, second);
    if (c !== "allow") return `"defaults.${second}" ${c.deny}, so it ${HOST}.`;
  }

  if (top === "channels") {
    if (!second) return `"channels" as a whole cannot be replaced; change one channel's settings.`;
    const key = ctx.resolve?.(second) ?? second;
    if (ctx.protectedChannels.has(key)) {
      return `"${second}" is the admin channel (or is the channel you are in). Nothing about it is changed from inside it, because it decides who controls the harness, so it ${HOST}.`;
    }
    if (!third) {
      // A whole channel at once. Removing one is fine (it falls back to the defaults); adding one is checked key by key.
      if (edit.remove) return undefined;
      return isTree(edit.value) ? undefined : `A channel is a map of settings.`;
    }
    const c = classify(CHANNEL, third);
    const lifted = ctx.privileged && ((NEEDS_APPROVAL.channel as readonly string[]).includes(third) || (edit.remove === true && fourth === undefined && (NEEDS_APPROVAL.channelRemoveOnly as readonly string[]).includes(third)));
    if (c !== "allow" && !lifted) return `"channels.${second}.${third}" ${c.deny}, so it ${HOST}.`;
    if (third === "factory" && fourth) {
      const f = classify(FACTORY, fourth);
      if (f !== "allow") return `"${label}" ${f.deny}, so it ${HOST}.`;
    }
    if (third === "share" && fourth) {
      const s = classify(SHARE, fourth);
      if (s !== "allow" && !(ctx.privileged && (NEEDS_APPROVAL.share as readonly string[]).includes(fourth))) return `"${label}" ${s.deny}, so it ${HOST}.`;
    }
  }
  return undefined;
}

/**
 * The settings a whole-channel (or whole-`share`) value would put in place, so a new channel is held to the same rules as an
 * edit. Recursive, so a `share` map inside a whole-channel value is broken into its keys too, and a key the value drops from
 * what is there now is a removal, held to the same rules as removing it on its own.
 */
function expand(edit: PolicyEdit, ctx: PolicyContext): PolicyEdit[] {
  const [top, channel, third] = edit.path;
  const whole = top === "channels" && channel !== undefined && !edit.remove && isTree(edit.value) &&
    (edit.path.length === 2 || (edit.path.length === 3 && (third === "share" || third === "factory")));
  if (!whole) return [edit];
  const value = edit.value as Tree;
  const out = Object.entries(value).flatMap(([k, v]) => expand({ path: [...edit.path, k], value: v }, ctx));
  const was = get(ctx.before, "channels", ctx.resolve?.(channel) ?? channel, ...edit.path.slice(2));
  if (isTree(was)) for (const k of Object.keys(was)) if (!(k in value)) out.push({ path: [...edit.path, k], remove: true });
  return out;
}

/** ${NAME} references in a value, at any depth. */
function references(value: unknown): string[] {
  if (typeof value === "string") return [...value.matchAll(/\$\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1]!);
  if (Array.isArray(value)) return value.flatMap(references);
  if (isTree(value)) return Object.values(value).flatMap(references);
  return [];
}

/** The prefix a connector's own secrets must carry: `google-calendar` -> `GOOGLE_CALENDAR_`. */
export const connectorPrefix = (name: string): string => `${name.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "")}_`;

/** The reasons a connector definition cannot be written from here. */
export function checkConnector(name: string, def: unknown): string[] {
  const problems: string[] = [];
  const why = (text: string) => problems.push(`connector "${name}": ${text}`);
  if (!isTree(def)) return [`connector "${name}": a connector is a map with a transport and a url`];
  if (def.transport !== "http") {
    why(`only \`transport: http\` (a remote MCP server) can be defined from here. A \`stdio\` connector runs a command on the host, so it ${HOST}.`);
    return problems;
  }
  let url: URL | undefined;
  try { url = new URL(String(def.url)); } catch { why("`url` must be a full URL"); }
  if (url) {
    if (url.protocol !== "https:" && url.protocol !== "http:") why("`url` must be http or https");
    if (url.username || url.password) why("`url` must not carry a username or password; use a header with a ${VAR} reference");
    const host = url.hostname.toLowerCase();
    if (LOCAL_HOSTS.test(host) || /^127\./.test(host) || /^169\.254\./.test(host)) {
      why("`url` points at this machine or at a cloud metadata address, which a connector set up from here may not reach");
    }
  }
  // A secret must be a reference the operator fills in, never a value written into the file (and then read back out of it).
  const headers = def.headers;
  if (isTree(headers)) {
    for (const [header, value] of Object.entries(headers)) {
      if (typeof value !== "string" || !/\$\{[A-Za-z0-9_]+\}/.test(value)) {
        why(`header "${header}" must be a \${VAR} reference (for example "Bearer \${${connectorPrefix(name)}TOKEN}"), not a literal value`);
      }
    }
  }
  const oauth = def.oauth;
  if (isTree(oauth)) {
    if (oauth.tokenFile !== undefined) why("`oauth.tokenFile` names a file on the host, so it " + HOST);
    if (oauth.clientSecret !== undefined && !(typeof oauth.clientSecret === "string" && /^\$\{[A-Za-z0-9_]+\}$/.test(oauth.clientSecret))) {
      why("`oauth.clientSecret` must be a ${VAR} reference, not a literal value");
    }
  }
  const prefix = connectorPrefix(name);
  const stray = [...new Set(references(def))].filter((ref) => !ref.toUpperCase().startsWith(prefix));
  if (stray.length > 0) {
    why(`it may only use variables that start with ${prefix} (${stray.map((r) => "${" + r + "}").join(", ")} do not). A connector can only be given secrets named for it, so it cannot be pointed at unrelated ones; the person who owns the host sets the value.`);
  }
  return problems;
}

/** Every connector definition in a tree, with where it lives. */
function connectorsOf(tree: unknown): { where: string; name: string; def: unknown }[] {
  const out: { where: string; name: string; def: unknown }[] = [];
  const shared = get(tree, "connectors");
  if (isTree(shared)) for (const [name, def] of Object.entries(shared)) out.push({ where: "connectors", name, def });
  const channels = get(tree, "channels");
  if (isTree(channels)) {
    for (const [key, channel] of Object.entries(channels)) {
      const own = get(channel, "connectors");
      if (isTree(own)) for (const [name, def] of Object.entries(own)) out.push({ where: `channels.${key}.connectors`, name, def });
    }
  }
  return out;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Checks on what the file would mean, for the things that are dangerous because of their value. */
function checkResult(edits: PolicyEdit[], ctx: PolicyContext): string[] {
  const problems: string[] = [];
  const { before, after } = ctx;

  // Connectors: any that is new or changed must be one that could be written from here.
  const was = new Map(connectorsOf(before).map((c) => [`${c.where}/${c.name}`, c.def]));
  for (const c of connectorsOf(after)) {
    if (same(was.get(`${c.where}/${c.name}`), c.def)) continue;
    problems.push(...checkConnector(c.name, c.def));
  }

  // Channels the edits touched: their tools may not gain a shell, their people must be real Slack IDs, their sharing may not write.
  const touched = new Set<string>();
  for (const e of edits) if (e.path[0] === "channels" && e.path[1]) touched.add(ctx.resolve?.(e.path[1]) ?? e.path[1]);
  for (const key of touched) {
    const oldTools = get(before, "channels", key, "tools");
    const newTools = get(after, "channels", key, "tools");
    if (Array.isArray(newTools)) {
      const had = new Set(Array.isArray(oldTools) ? oldTools : []);
      const gained = newTools.filter((t) => SHELL_TOOLS.includes(String(t)) && !had.has(t));
      if (gained.length > 0 && !ctx.privileged) problems.push(`"${key}" would gain ${gained.map((t) => `"${t}"`).join(", ")}. A shell is not granted from here; that ${HOST}.`);
    }
    const oldUsers = get(before, "channels", key, "allowUsers");
    const newUsers = get(after, "channels", key, "allowUsers");
    if (!same(oldUsers, newUsers)) {
      if (!Array.isArray(newUsers)) {
        problems.push(`"${key}": allowUsers cannot be removed from here, because that would let anyone in the channel use it. Replace it with a list of people.`);
      } else if (newUsers.length === 0) {
        problems.push(`"${key}": allowUsers cannot be empty (that would lock everyone out); give at least one Slack user ID.`);
      } else if (newUsers.length > MAX_ALLOWED_USERS) {
        problems.push(`"${key}": allowUsers is limited to ${MAX_ALLOWED_USERS} people.`);
      } else {
        const bad = newUsers.filter((id) => typeof id !== "string" || !SLACK_USER_ID.test(id));
        if (bad.length > 0) problems.push(`"${key}": ${bad.map((b) => `"${String(b)}"`).join(", ")} ${bad.length === 1 ? "is not a Slack user ID" : "are not Slack user IDs"} (they look like U01ABCDEF).`);
      }
    }
    const collections = get(after, "channels", key, "share", "skillCollections");
    if (Array.isArray(collections)) {
      const oldCollections = get(before, "channels", key, "share", "skillCollections");
      const rw = collections.filter((c) => isTree(c) && c.mode === "rw" && !(Array.isArray(oldCollections) && oldCollections.some((o) => same(o, c))));
      if (rw.length > 0) problems.push(`"${key}": a read-write skill collection lets that channel change what every channel holding it runs, so it ${HOST}.`);
    }
  }

  // Approval gates can be added from here but never switched off: a role that needed a person's approval still does.
  const rolesBefore = get(before, "agentSets");
  if (isTree(rolesBefore)) {
    for (const [setName, set] of Object.entries(rolesBefore)) {
      const agents = get(set, "agents");
      if (!isTree(agents)) continue;
      for (const [role, def] of Object.entries(agents)) {
        if (isTree(def) && def.requireApproval === true && get(after, "agentSets", setName, "agents", role, "requireApproval") !== true) {
          problems.push(`"${setName}.${role}" requires a person's approval to run, and that is not switched off (or the role removed) from here; it ${HOST}.`);
        }
      }
    }
  }

  // Belt and braces for the approval-gated sharing: whatever path the edits took (a whole channel, a whole `share` map, a
  // new channel), the result may not gain, lose or change `share.postAs` or `share.delegateTo` without a person's click.
  // Deleting a whole channel only takes power away, so it is not counted.
  if (!ctx.privileged) {
    const keys = new Set<string>([...Object.keys(isTree(get(before, "channels")) ? (get(before, "channels") as Tree) : {}), ...Object.keys(isTree(get(after, "channels")) ? (get(after, "channels") as Tree) : {})]);
    for (const key of keys) {
      if (get(after, "channels", key) === undefined) continue;
      for (const field of NEEDS_APPROVAL.share) {
        if (!same(get(before, "channels", key, "share", field), get(after, "channels", key, "share", field))) {
          problems.push(`"${key}": share.${field} ${SHARE[field] !== "allow" && SHARE[field] ? SHARE[field].deny : "needs approval"}, so changing it needs a person's approval; ask with admin_config_request_approval.`);
        }
      }
    }
  }

  // The reviewer that guards posting as a person is part of that power, so changing it needs the same click as `share.postAs`:
  // otherwise an injected admin turn could loosen the very guard that stops it (its instructions are the reviewer's trusted prompt).
  if (!ctx.privileged) {
    const channelsBefore = get(before, "channels");
    if (isTree(channelsBefore)) {
      for (const [key, channel] of Object.entries(channelsBefore)) {
        const reviewer = get(channel, "share", "postAs", "reviewer");
        const setName = get(channel, "agentSet");
        if (typeof reviewer !== "string" || typeof setName !== "string") continue;
        // A channel that no longer posts as a person afterwards has lost the power, not loosened its guard.
        if (get(after, "channels", key, "share", "postAs") === undefined) continue;
        const roleBefore = get(before, "agentSets", setName, "agents", reviewer);
        const roleAfter = get(after, "agentSets", setName, "agents", reviewer);
        const inherited = (tree: unknown, role: unknown, field: string) => get(role, field) ?? get(tree, "channels", key, field) ?? get(tree, "defaults", field);
        const changed =
          get(after, "channels", key, "agentSet") !== setName ||
          get(after, "channels", key, "share", "postAs", "reviewer") !== reviewer ||
          roleAfter === undefined ||
          !same(roleBefore, roleAfter) ||
          inherited(before, roleBefore, "model") !== inherited(after, roleAfter, "model") ||
          inherited(before, roleBefore, "thinkingLevel") !== inherited(after, roleAfter, "thinkingLevel");
        if (changed) {
          problems.push(`"${setName}.${reviewer}" reviews what "${key}" posts as a person, so it (its instructions, model and timeout, the model it inherits, the role itself, and the channel's agent set) needs a person's approval to change; ask with admin_config_request_approval.`);
        }
      }
    }
  }
  return problems;
}

/** Everything that stops these edits being applied, or an empty list. */
export function checkEdits(edits: PolicyEdit[], ctx: PolicyContext): string[] {
  const problems: string[] = [];
  for (const edit of edits.flatMap((e) => expand(e, ctx))) {
    const reason = checkPath(edit, ctx);
    if (reason) problems.push(reason);
  }
  // Only worth judging the result when the paths themselves were acceptable.
  return problems.length > 0 ? [...new Set(problems)] : [...new Set(checkResult(edits, ctx))];
}
