#!/usr/bin/env node
// A stand-in for wrangler for the live software-factory trial. It speaks the part of the CLI the deployer is allowed to use,
// keeps Worker versions in a JSON file, and records EVERY invocation (arguments, working directory, and the commit checked
// out at that moment) so a test can check what was really done rather than what a report claims.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const STATE = process.env.FAKE_WRANGLER_STATE;
const LOG = process.env.FAKE_WRANGLER_LOG;
if (!STATE || !LOG) { console.error("fake wrangler: FAKE_WRANGLER_STATE and FAKE_WRANGLER_LOG must be set"); process.exit(2); }

const args = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a.startsWith("--") || (a.startsWith("-") && a.length === 2)) {
    const key = a.replace(/^-+/, "");
    const next = args[i + 1];
    if (next === undefined || (next.startsWith("-") && next.length > 1)) flags[key] = true; else { flags[key] = next; i++; }
  } else positional.push(a);
}
const env = flags.env ?? flags.e ?? null; // null: the top-level config, which is production

let head = "";
try { head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(); } catch { /* not in a repository */ }
const log = { argv: args, cwd: process.cwd(), env, head, hasToken: Boolean(process.env.CLOUDFLARE_API_TOKEN), at: Date.now() };
appendFileSync(LOG, `${JSON.stringify(log)}\n`);

const load = () => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : { envs: {} });
const save = (state) => writeFileSync(STATE, JSON.stringify(state, null, 2));
const envName = env ?? "production";
const urlFor = (name) => `https://app${name === "production" ? "" : `-${name}`}.acme.example`;
const needAuth = () => {
  if (!process.env.CLOUDFLARE_API_TOKEN || !process.env.CLOUDFLARE_ACCOUNT_ID) {
    console.error("✘ [ERROR] In a non-interactive environment, it's necessary to set a CLOUDFLARE_API_TOKEN environment variable for wrangler to work.");
    process.exit(1);
  }
};
const [verb, sub] = positional;

if (flags.version || flags.v || verb === undefined && args.includes("--version")) { console.log("4.151.1"); process.exit(0); }
if (args.includes("--install-skills") || args.includes("--env-file") || args.includes("--var") || args.includes("--define")) {
  console.error("fake wrangler: refusing a flag the deployer must not use"); process.exit(2);
}

if (verb === "whoami") {
  needAuth();
  console.log(flags.json ? JSON.stringify({ loggedIn: true, authType: "API Token", accounts: [{ id: process.env.CLOUDFLARE_ACCOUNT_ID, name: "Acme (trial)" }] }) : "Getting User settings...\n👋 You are logged in with an API Token. Account: Acme (trial)");
} else if (verb === "deploy") {
  const out = typeof flags.outdir === "string" ? flags.outdir : null;
  if (flags["dry-run"]) {
    if (out) { mkdirSync(out, { recursive: true }); writeFileSync(join(out, "index.js"), "// bundled\n"); }
    console.log(`Total Upload: 1.00 KiB\n--dry-run: exiting now.`);
  } else {
    needAuth();
    const state = load();
    const versions = (state.envs[envName] ??= { versions: [], live: null });
    const id = `ver-${envName}-${versions.versions.length + 1}`;
    versions.versions.push({ id, sha: head, message: typeof flags.message === "string" ? flags.message : "", tag: typeof flags.tag === "string" ? flags.tag : "" });
    versions.live = id;
    save(state);
    console.log(`Uploaded app (1.00 sec)\nDeployed app triggers (0.50 sec)\n  ${urlFor(envName)}\nCurrent Version ID: ${id}`);
  }
} else if (verb === "deployments" && (sub === "list" || sub === "status")) {
  needAuth();
  const v = load().envs[envName];
  if (!v?.live) console.log("No deployments found.");
  else console.log(sub === "status" ? `Version(s):\n  (100%) ${v.live}` : v.versions.map((x) => `Version: ${x.id}  ${x.message}${x.id === v.live ? "  (current)" : ""}`).join("\n"));
} else if (verb === "versions" && (sub === "list" || sub === "view")) {
  needAuth();
  const v = load().envs[envName];
  console.log((v?.versions ?? []).map((x) => `Version ID: ${x.id}${x.id === v.live ? " (active)" : ""}\nMessage: ${x.message}`).join("\n\n") || "No versions found.");
} else if (verb === "rollback") {
  needAuth();
  const state = load();
  const v = state.envs[envName];
  const target = sub ?? v?.versions.at(-2)?.id;
  if (!v || !target || !v.versions.some((x) => x.id === target)) { console.error("✘ [ERROR] No such version to roll back to."); process.exit(1); }
  v.live = target; save(state);
  console.log(`Successfully rolled back to Worker Version ${target}.`);
} else {
  console.error(`fake wrangler: unsupported command: ${args.join(" ")}`);
  process.exit(2);
}
