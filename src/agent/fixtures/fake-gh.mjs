#!/usr/bin/env node
// A stand-in for the GitHub CLI for the live software-factory trial. It speaks the small part of `gh` the factory roles use,
// against a JSON file and a local git repository, so a real model can run the whole pipeline with no GitHub involved.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

const STATE = process.env.FAKE_GH_STATE;
const REPO = process.env.FAKE_GH_REPO;
const NAME = process.env.FAKE_GH_NAME ?? "acme/app";
if (!STATE || !REPO) { console.error("fake gh: FAKE_GH_STATE and FAKE_GH_REPO must be set"); process.exit(2); }

const load = () => JSON.parse(readFileSync(STATE, "utf8"));
const save = (state) => writeFileSync(STATE, JSON.stringify(state, null, 2));
const git = (...args) => execFileSync("git", ["-C", REPO, ...args], { encoding: "utf8" });

const args = process.argv.slice(2);
const positional = [];
const flags = {};
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a.startsWith("--") || (a.startsWith("-") && a.length === 2)) {
    const key = a.replace(/^-+/, "");
    const next = args[i + 1];
    if (next === undefined || (next.startsWith("-") && next.length > 1 && !/^-\d/.test(next))) flags[key] = true;
    else { flags[key] = next; i++; }
  } else positional.push(a);
}
const [area, verb, id] = positional;
const body = flags.body ?? flags.b ?? flags["body-file"] ?? "";
const labelsOf = (item) => item.labels.map((name) => ({ name }));
const view = (item, fields) => {
  const full = { ...item, labels: labelsOf(item), url: `https://github.example/${NAME}/${item.kind}/${item.number}`, comments: item.comments.map((c) => ({ author: { login: "bot" }, body: c })) };
  if (!fields) return full;
  return Object.fromEntries(String(fields).split(",").map((f) => [f, full[f]]));
};
const split = (v) => (v === undefined || v === true ? [] : String(v).split(",").map((s) => s.trim()).filter(Boolean));
const state = load();
const find = (list, n) => { const item = list.find((x) => String(x.number) === String(n)); if (!item) { console.error(`no such item #${n}`); process.exit(1); } return item; };

if (area === "label") {
  if (verb === "create") { state.labels = [...new Set([...(state.labels ?? []), id])]; save(state); console.log(`Label "${id}" created`); }
  else console.log((state.labels ?? []).join("\n"));
} else if (area === "issue") {
  if (verb === "list") {
    let items = state.issues.filter((i) => flags.state === "all" || (flags.state ?? "open") === i.state);
    for (const l of split(flags.label)) items = items.filter((i) => i.labels.includes(l));
    if (typeof flags.search === "string") { const q = flags.search.toLowerCase().split(/\s+/); items = items.filter((i) => q.some((w) => `${i.title} ${i.body}`.toLowerCase().includes(w))); }
    const out = items.slice(0, Number(flags.limit ?? 30)).map((i) => view(i, flags.json === true ? "number,title,state,labels" : flags.json));
    console.log(flags.json ? JSON.stringify(out) : out.map((i) => `#${i.number}\t${i.title}`).join("\n"));
  } else if (verb === "view") {
    const item = find(state.issues, id);
    console.log(flags.json ? JSON.stringify(view(item, flags.json === true ? undefined : flags.json)) : `#${item.number} ${item.title}\nstate: ${item.state}\nlabels: ${item.labels.join(", ")}\n\n${item.body}${flags.comments ? `\n\n--\n${item.comments.join("\n--\n")}` : ""}`);
  } else if (verb === "edit") {
    const item = find(state.issues, id);
    item.labels = [...new Set([...item.labels.filter((l) => !split(flags["remove-label"]).includes(l)), ...split(flags["add-label"])])];
    if (typeof flags.title === "string") item.title = flags.title;
    save(state); console.log(`https://github.example/${NAME}/issues/${item.number}`);
  } else if (verb === "comment") {
    find(state.issues, id).comments.push(String(body)); save(state); console.log(`https://github.example/${NAME}/issues/${id}#comment`);
  } else if (verb === "close") {
    const item = find(state.issues, id); item.state = "closed"; save(state); console.log(`Closed #${id}`);
  } else { console.error(`fake gh: unsupported: issue ${verb}`); process.exit(2); }
} else if (area === "pr") {
  if (verb === "create") {
    const head = flags.head ?? git("rev-parse", "--abbrev-ref", "HEAD").trim();
    const base = flags.base ?? "main";
    const number = (state.prs.reduce((m, p) => Math.max(m, p.number), 0)) + 1 + state.issues.length;
    state.prs.push({ number, kind: "pull", title: String(flags.title ?? head), body: String(body), head, base, state: "open", labels: [], comments: [], reviews: [] });
    save(state); console.log(`https://github.example/${NAME}/pull/${number}`);
  } else if (verb === "list") {
    console.log(JSON.stringify(state.prs.filter((p) => (flags.state ?? "open") === "all" || p.state === (flags.state ?? "open")).map((p) => view(p, flags.json === true ? "number,title,state,headRefName" : flags.json))));
  } else if (verb === "view") {
    const pr = find(state.prs, id);
    const full = { ...view(pr), headRefName: pr.head, baseRefName: pr.base, reviews: pr.reviews };
    console.log(flags.json ? JSON.stringify(flags.json === true ? full : Object.fromEntries(String(flags.json).split(",").map((f) => [f, full[f]]))) : `#${pr.number} ${pr.title}\n${pr.head} -> ${pr.base}\n\n${pr.body}`);
  } else if (verb === "diff") {
    const pr = find(state.prs, id);
    console.log(git("diff", `${pr.base}...${pr.head}`));
  } else if (verb === "checkout") {
    const pr = find(state.prs, id); git("checkout", pr.head); console.log(`Switched to ${pr.head}`);
  } else if (verb === "comment") {
    find(state.prs, id).comments.push(String(body)); save(state); console.log("comment added");
  } else if (verb === "review") {
    const pr = find(state.prs, id);
    const kind = flags.approve ? "APPROVED" : flags["request-changes"] ? "CHANGES_REQUESTED" : "COMMENTED";
    pr.reviews.push({ state: kind, body: String(body) }); save(state); console.log(`Review submitted: ${kind}`);
  } else { console.error(`fake gh: unsupported: pr ${verb}`); process.exit(2); }
} else if (area === "auth" || area === "--version") {
  console.log("fake gh 0.0.0");
} else { console.error(`fake gh: unsupported command: ${args.join(" ")}`); process.exit(2); }
