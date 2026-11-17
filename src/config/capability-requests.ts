import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseConfigText } from "./load.ts";
import { createConfiguratorService, type ConfiguratorActor } from "./configurator.ts";
import { configRevision, type OperatorConfig } from "./operator.ts";
import { redact, type ConfigEdit } from "./edit.ts";

export type CapabilityKind = "connector" | "cli";
export interface CapabilityActor { channelId: string; channelKey: string; userId: string }
export type CapabilityState = "awaiting_plan" | "pending_provision" | "provisioning_approved" | "pending_enable" | "approved" | "applying" | "applied" | "saved" | "failed" | "rejected" | "expired";
export interface CapabilityRequest {
  id: string; type: "enable" | "new"; kind: CapabilityKind; name: string; reason: string;
  actor: CapabilityActor; adminKey: string; adminId: string; approvers: string[];
  state: CapabilityState; expiresAt: number; messageTs?: string; plan?: string;
  edits?: ConfigEdit[]; revision?: string; definitionRevision?: string; definition?: unknown; approvedBy?: string;
}
export interface CapabilityRequestDeps {
  operator: OperatorConfig;
  resolveId(key: string): Promise<string | undefined>;
  isHuman(userId: string): Promise<boolean>;
  post(item: CapabilityRequest): Promise<string>;
  notify(item: CapabilityRequest, text: string): Promise<void>;
  now?: () => number;
}
const TTL = 30 * 60_000;
const terminal = new Set<CapabilityState>(["applied", "saved", "failed", "rejected", "expired"]);
const text = (value: string, max: number) => {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`Provide non-empty text of at most ${max} characters.`);
  return value.trim();
};

/** Process-local, single-use approvals. Restart discards authority, never resumes a side effect. */
export class CapabilityRequests {
  private readonly items = new Map<string, CapabilityRequest>();
  private readonly deps: CapabilityRequestDeps;
  private posting = 0;
  constructor(deps: CapabilityRequestDeps) { this.deps = deps; }
  private now() { return this.deps.now?.() ?? Date.now(); }
  private current() {
    const raw = readFileSync(this.deps.operator.configPath, "utf8");
    try { return { config: parseConfigText(raw), revision: configRevision(raw) }; }
    catch { throw new Error("The persisted harness configuration is invalid; ask the host operator to repair it."); }
  }
  private target(actor: CapabilityActor) {
    const current = this.current();
    const entry = current.config.channels[actor.channelKey];
    if (!entry) throw new Error("This channel needs an explicit channels entry before requesting capabilities.");
    return { ...current, entry };
  }
  private async admin() {
    const { config } = this.current();
    const admins = Object.entries(config.channels).filter(([, c]) => c.admin);
    const [key, entry] = admins[0] ?? [];
    if (admins.length !== 1 || !key || !entry?.configurators.harness || !entry.allowUsers?.length) {
      throw new Error("Configure one admin: true channel with allowUsers and configurators.harness: true on the host.");
    }
    const id = await this.deps.resolveId(key);
    if (!id) throw new Error("The admin channel could not be resolved; configure its Slack ID or invite the bot there.");
    return { key, id, approvers: entry.allowUsers };
  }
  private async check(item: CapabilityRequest) {
    const admin = await this.admin();
    if (admin.key !== item.adminKey || admin.id !== item.adminId) throw new Error("Admin routing changed; submit a fresh request.");
    if (await this.deps.resolveId(item.actor.channelKey) !== item.actor.channelId) throw new Error("Requesting channel identity changed; submit a fresh request.");
    this.target(item.actor);
    return admin;
  }
  private get(id: string) {
    const item = this.items.get(id);
    if (!item) throw new Error("Unknown request (or harness restarted); submit a fresh request.");
    if (!terminal.has(item.state) && item.expiresAt <= this.now()) item.state = "expired";
    return item;
  }
  search(actor: CapabilityActor, query = "", kind?: CapabilityKind) {
    const { config, entry } = this.target(actor);
    const q = query.toLowerCase();
    return (["connector", "cli"] as const).flatMap((k) => {
      if (kind && kind !== k) return [];
      const catalog = k === "connector" ? config.connectors : config.cliTools;
      return Object.entries(catalog).flatMap(([name, definition]) => {
        const description = definition.description ?? "";
        if (!(name + " " + description).toLowerCase().includes(q)) return [];
        const selected = k === "connector" ? entry.share.connectors : entry.exec?.shared ?? [];
        return [{ kind: k, name, description, enabled: selected.includes(name) && (k !== "cli" || (entry.tools ?? config.defaults.tools).includes("exec")) }];
      });
    });
  }
  private prepare(item: CapabilityRequest) {
    const { config, entry, revision } = this.target(item.actor);
    const catalog = item.kind === "connector" ? config.connectors : config.cliTools;
    if (!Object.hasOwn(catalog, item.name)) throw new Error("Capability is not in the account catalog yet; an authorized administrator must provide it first.");
    // Do not silently enable a private/local command that shadows the selected account definition.
    if (item.kind === "cli" && (Object.hasOwn(entry.exec?.commands ?? {}, item.name) || Object.hasOwn(config.defaults.exec.commands, item.name)) ||
        item.kind === "connector" && Object.hasOwn(entry.connectors, item.name)) throw new Error("A private/local capability shadows this name; an operator must reconcile it first.");
    const root = ["channels", item.actor.channelKey];
    const edits: ConfigEdit[] = [];
    if (item.kind === "connector") edits.push({ path: [...root, "share", "connectors"], value: [...new Set([...entry.share.connectors, item.name])] });
    else {
      edits.push({ path: [...root, "exec", "shared"], value: [...new Set([...(entry.exec?.shared ?? []), item.name])] });
      const tools = entry.tools ?? config.defaults.tools;
      if (!tools.includes("exec")) {
        // Enabling exec also exposes local/default commands. That is not an approval of just this capability.
        if (Object.keys(config.defaults.exec.commands).length || Object.keys(entry.exec?.commands ?? {}).length || (entry.exec?.shared?.length ?? 0)) {
          throw new Error("Enabling exec would expose other commands; an operator must reconcile this channel first.");
        }
        edits.push({ path: [...root, "tools"], value: [...tools, "exec"] });
      }
    }
    const actor: ConfiguratorActor = { scope: "harness", channelKey: item.adminKey, channelId: item.adminId, userId: item.actor.userId };
    createConfiguratorService(this.deps.operator, actor).validate(edits, revision);
    item.edits = edits; item.revision = revision;
    item.definitionRevision = configRevision(JSON.stringify(catalog[item.name]));
    item.definition = redact(catalog[item.name]);
  }
  async request(actor: CapabilityActor, input: { type: "enable" | "new"; kind: CapabilityKind; name: string; reason: string }) {
    if (!["connector", "cli"].includes(input.kind) || !["enable", "new"].includes(input.type)) throw new Error("Invalid capability request type.");
    this.target(actor);
    if (await this.deps.resolveId(actor.channelKey) !== actor.channelId) throw new Error("Requesting channel cannot be resolved; configure its Slack ID or register its name.");
    const admin = await this.admin();
    for (const [id] of this.items) if (terminal.has(this.get(id).state)) this.items.delete(id);
    if (this.items.size + this.posting >= 100) throw new Error("Too many pending capability requests; decide or let them expire first.");
    const item: CapabilityRequest = { id: randomUUID(), type: input.type, kind: input.kind, name: text(input.name, 100), reason: text(input.reason, 1500), actor: { ...actor },
      adminKey: admin.key, adminId: admin.id, approvers: [...admin.approvers], state: input.type === "enable" ? "pending_enable" : "awaiting_plan", expiresAt: this.now() + TTL };
    if (input.type === "enable") this.prepare(item);
    else if (this.search(actor).some((c) => c.kind === item.kind && c.name === item.name)) throw new Error("This capability already exists; use request_enable_capability.");
    // Register only after successful delivery: a failed post can never leave an actionable hidden approval.
    this.posting++;
    try { item.messageTs = await this.deps.post(structuredClone(item)); }
    finally { this.posting--; }
    this.items.set(item.id, item);
    return { id: item.id, state: item.state, expiresAt: item.expiresAt };
  }
  async decide(input: { id: string; channelId: string; messageTs: string; userId: string; approve: boolean }) {
    const item = this.get(input.id);
    const expectedMessage = item.messageTs;
    const expectedState = item.state;
    const decisionRevision = this.current().revision;
    if (!["pending_enable", "pending_provision"].includes(item.state)) throw new Error(`Request is ${item.state}, not awaiting a decision.`);
    if (input.channelId !== item.adminId || input.messageTs !== item.messageTs) throw new Error("Approval message does not match the request.");
    const admin = await this.check(item);
    if (!item.approvers.includes(input.userId) || !admin.approvers.includes(input.userId) || !await this.deps.isHuman(input.userId)) throw new Error("Only an allowlisted human in the admin channel can decide this request.");
    // Recheck after asynchronous identity verification to prevent double-click races and expiry races.
    if (this.get(item.id).state !== expectedState || item.messageTs !== expectedMessage) throw new Error("Request expired, changed or already decided.");
    if (this.current().revision !== decisionRevision) throw new Error("Configuration changed during verification; retry the decision.");
    if (!input.approve) item.state = "rejected";
    else if (item.state === "pending_provision") item.state = "provisioning_approved";
    else {
      if (this.current().revision !== item.revision) throw new Error("Configuration changed; have the configurator prepare a fresh approval.");
      item.state = "approved";
    }
    item.approvedBy = input.userId;
    item.expiresAt = this.now() + TTL;
    await this.deps.notify(structuredClone(item), item.state === "approved"
      ? `Approved by ${input.userId}. Run harnessConfigurator with config_capability_request action apply and id ${item.id}. Only the stored edits are authorized.`
      : item.state === "provisioning_approved"
        ? `Provisioning plan approved by ${input.userId}. An authorized administrator may now perform exactly that plan. No installation runs automatically. After providing the account catalog entry, run harnessConfigurator with config_capability_request action prepare and id ${item.id}; enabling still requires a second human approval.`
        : `Rejected by ${input.userId}; no further action is authorized by this request.`);
    return { id: item.id, state: item.state };
  }
  private async publish(item: CapabilityRequest, next: CapabilityRequest) {
    const message = item.messageTs;
    const state = item.state;
    next.messageTs = await this.deps.post(structuredClone(next));
    if (this.get(item.id).state !== state || item.messageTs !== message) throw new Error("Request changed while posting; inspect its current state.");
    Object.assign(item, next);
  }

  /** Offered only inside the admin channel's already-enabled harnessConfigurator. No model-supplied target or edits. */
  async manage(actor: ConfiguratorActor, input: { id: string; action: "inspect" | "plan" | "prepare" | "apply"; plan?: string }) {
    const item = this.get(input.id);
    const admin = await this.check(item);
    this.get(item.id); // An async routing lookup must not extend an approval past its expiry.
    if (actor.scope !== "harness" || actor.channelKey !== admin.key || actor.channelId !== admin.id || !admin.approvers.includes(actor.userId)) throw new Error("Use the enabled admin harnessConfigurator from an allowlisted user's turn.");
    if (input.action === "inspect") return structuredClone(item);
    if (terminal.has(item.state) || item.state === "applying") throw new Error(`Request is ${item.state}; submit a fresh request if needed.`);
    if (input.action === "plan") {
      if (item.type !== "new" || item.state !== "awaiting_plan") throw new Error("This request is not awaiting a provisioning plan.");
      const next = { ...item, plan: text(input.plan ?? "", 6000), state: "pending_provision" as const, expiresAt: this.now() + TTL };
      await this.publish(item, next);
    } else if (input.action === "prepare") {
      if (!(item.type === "new" && item.state === "provisioning_approved") && item.state !== "pending_enable") throw new Error("Provisioning must be approved before preparing enablement.");
      const next = structuredClone(item);
      this.prepare(next); next.state = "pending_enable"; next.expiresAt = this.now() + TTL;
      await this.publish(item, next);
    } else if (input.action === "apply") {
      if (item.state !== "approved" || !item.approvedBy || !admin.approvers.includes(item.approvedBy)) throw new Error("Enablement needs a current, authorized human approval first.");
      // Claim before the first write/await. The configurator rechecks revision, scope, aliases, validation, backup and reload.
      item.state = "applying";
      try {
        const result = await createConfiguratorService(this.deps.operator, actor).save(item.edits!, item.revision!);
        item.state = result.applied ? "applied" : "saved";
        // Delivery failure must not turn an applied configuration into a reported application failure.
        let notificationFailed = false;
        try { await this.deps.notify(structuredClone(item), result.applied ? "Capability applied by harnessConfigurator." : "Configuration saved; restart required before capability is applied."); }
        catch { notificationFailed = true; }
        return { id: item.id, state: item.state, ...result, notificationFailed };
      } catch {
        item.state = "failed";
        await this.deps.notify(structuredClone(item), "Configurator application failed; inspect the persisted configuration and submit a fresh request. No approval is reusable.");
        throw new Error("Configurator application failed; inspect the configuration and reload status in the admin channel.");
      }
    } else throw new Error("Unknown capability lifecycle action.");
    return { id: item.id, state: item.state, expiresAt: item.expiresAt };
  }
}
