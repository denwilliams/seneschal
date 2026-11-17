import assert from "node:assert/strict";
import { test } from "node:test";
import {
  hashDefinition, JOB_LIMITS, JobDefinitionSchema, JobInputError, JobsSchema, parseTemplate, renderTemplate, renderValue,
  resolveInputs, TemplateError, type JobDefinition, type RenderContext,
} from "./definition.ts";

const parse = (value: unknown) => JobDefinitionSchema.safeParse(value);
const issues = (value: unknown) => { const r = parse(value); return r.success ? [] : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`); };

const release: unknown = {
  description: "Review the release candidate",
  input: { branch: { default: "main" }, ticket: {} },
  phases: [
    { name: "plan", kind: "exec", command: "git", args: ["log", "--oneline", "${input.branch}"] },
    { name: "notes", kind: "state", op: "set", path: "/releases/last", value: { branch: "${input.branch}", log: "${phases.plan.result}", code: "${phases.plan.exit}" } },
  ],
};

test("a well-formed definition is accepted, with defaults filled in", () => {
  const result = parse(release);
  assert.ok(result.success, JSON.stringify(issues(release)));
  const job = result.data;
  assert.equal(job.input.branch!.maxLength, 256);
  assert.equal((job.phases[0] as { onFailure: string }).onFailure, "fail");
  assert.deepEqual(job.phases[0]!.kind, "exec");
});

test("unknown keys are refused rather than ignored", () => {
  assert.ok(issues({ ...(release as object), surprise: 1 }).length > 0);
  assert.ok(issues({ phases: [{ name: "a", kind: "exec", command: "git", shell: "rm -rf /" }] }).length > 0, "no shell field sneaks in");
  assert.ok(issues({ phases: [{ name: "a", kind: "exec", command: "git", argv: ["x"] }] }).length > 0);
});

test("phase kinds that are not built yet are refused, not silently dropped", () => {
  assert.ok(issues({ phases: [{ name: "a", kind: "approve", message: "ok?" }] }).length > 0);
  assert.ok(issues({ phases: [{ name: "a", kind: "agent", role: "x", prompt: "y" }] }).length > 0);
  assert.ok(issues({ phases: [{ name: "a", kind: "bash", script: "ls" }] }).length > 0);
});

test("names: phases are lower-case identifiers and unique; a job needs at least one and at most the limit", () => {
  const phase = (name: string) => ({ name, kind: "exec", command: "git" });
  assert.ok(issues({ phases: [phase("Bad Name")] }).length > 0);
  assert.ok(issues({ phases: [phase("a"), phase("a")] }).some((i) => /used twice/.test(i)));
  assert.ok(issues({ phases: [] }).length > 0);
  assert.ok(issues({ phases: Array.from({ length: JOB_LIMITS.phases + 1 }, (_, i) => phase(`p${i}`)) }).length > 0);
  assert.ok(parse({ phases: Array.from({ length: JOB_LIMITS.phases }, (_, i) => phase(`p${i}`)) }).success);
});

test("inputs: bounded in number and shape", () => {
  const phases = [{ name: "a", kind: "exec", command: "git" }];
  assert.ok(issues({ input: { "Bad-Name": {} }, phases }).length > 0);
  assert.ok(issues({ input: Object.fromEntries(Array.from({ length: JOB_LIMITS.params + 1 }, (_, i) => [`p${i}`, {}])), phases }).some((i) => /at most/.test(i)));
  assert.ok(issues({ input: { n: { type: "number" } }, phases }).length > 0, "strings only");
  assert.ok(issues({ input: { n: { maxLength: 5000 } }, phases }).length > 0);
});

test("exec phases: bounded arguments, a sane timeout, and only the two failure modes", () => {
  const base = { name: "a", kind: "exec", command: "git" };
  assert.ok(issues({ phases: [{ ...base, args: Array.from({ length: JOB_LIMITS.args + 1 }, () => "x") }] }).length > 0);
  assert.ok(issues({ phases: [{ ...base, args: ["x".repeat(JOB_LIMITS.argChars + 1)] }] }).length > 0);
  assert.ok(issues({ phases: [{ ...base, timeoutSeconds: 0 }] }).length > 0);
  assert.ok(issues({ phases: [{ ...base, timeoutSeconds: 99_999 }] }).length > 0);
  assert.ok(issues({ phases: [{ ...base, onFailure: "ignore" }] }).length > 0);
  assert.ok(parse({ phases: [{ ...base, onFailure: "continue", timeoutSeconds: 60 }] }).success);
});

test("state phases: the path must be a pointer and a value is needed except for delete", () => {
  const phase = (extra: object) => ({ phases: [{ name: "s", kind: "state", op: "set", path: "/a", value: 1, ...extra }] });
  assert.ok(parse(phase({})).success);
  assert.ok(issues(phase({ path: "no-slash" })).some((i) => /JSON Pointer/.test(i)));
  assert.ok(issues(phase({ path: "/__proto__/x" })).length > 0);
  assert.ok(issues(phase({ value: undefined })).some((i) => /needs a value/.test(i)));
  assert.ok(parse(phase({ op: "delete", value: undefined })).success);
  assert.ok(issues(phase({ op: "replace" })).length > 0);
});

test("references: only to inputs that exist and to phases that have already run", () => {
  const exec = (name: string, args: string[]) => ({ name, kind: "exec", command: "git", args });
  assert.deepEqual(issues({ phases: [exec("a", ["${input.nope}"])] }).length, 1);
  assert.ok(issues({ phases: [exec("a", ["${phases.b.result}"]), exec("b", [])] }).some((i) => /has not run by this point/.test(i)), "forward reference");
  assert.ok(issues({ phases: [exec("a", ["${phases.a.result}"])] }).some((i) => /has not run/.test(i)), "self reference");
  assert.ok(issues({ phases: [{ name: "s", kind: "state", op: "set", path: "/x", value: 1 }, exec("a", ["${phases.s.result}"])] }).some((i) => /not an exec phase/.test(i)));
  assert.ok(parse({ phases: [exec("a", []), exec("b", ["${phases.a.result}", "${phases.a.exit}"])] }).success);
});

test("references: anything else that looks like one is an error, not text", () => {
  const exec = (arg: string) => ({ phases: [{ name: "a", kind: "exec", command: "git", args: [arg] }] });
  for (const bad of ["${input}", "${INPUT.x}", "${env.HOME}", "${process.env.X}", "${`ls`}", "${input.x", "$(whoami)x${", "${ input.x.y }"]) {
    assert.ok(issues(exec(bad)).length > 0, `${bad} should be refused`);
  }
  assert.ok(parse(exec("$$" + "{literal}")).success, "$${ is an escaped literal");
  assert.ok(parse(exec("$HOME and $(date) are just text: there is no shell")).success);
});

test("state references are checked as pointers", () => {
  const phase = (arg: string) => ({ input: {}, phases: [{ name: "a", kind: "exec", command: "git", args: [arg] }] });
  assert.ok(parse(phase("${state:/jobs/cursor}")).success);
  assert.ok(issues(phase("${state:/__proto__}")).length > 0);
  assert.ok(issues(phase("${state:nope}")).length > 0, "a pointer starts with a slash");
});

test("templates parse into literal and reference parts, with escapes", () => {
  assert.deepEqual(parseTemplate("a${input.x}b"), [{ text: "a" }, { ref: { kind: "input", name: "x" } }, { text: "b" }]);
  assert.deepEqual(parseTemplate("$${input.x}"), [{ text: "${input.x}" }]);
  assert.deepEqual(parseTemplate("plain"), [{ text: "plain" }]);
  assert.deepEqual(parseTemplate(""), []);
  assert.deepEqual(parseTemplate("${ input.x }"), [{ ref: { kind: "input", name: "x" } }], "spaces inside the braces are fine");
  assert.ok("error" in (parseTemplate("${phases.x.other}") as object));
});

const context = (overrides: Partial<RenderContext> = {}): RenderContext => ({
  input: { branch: "main", odd: "-rf; $(x) `y` ${input.branch}" },
  results: { plan: { result: "abc123 first\nabc124 second", exit: 0 } },
  state: (path) => (path === "/jobs/cursor" ? "41" : undefined),
  ...overrides,
});

test("rendering substitutes inputs, results, exit codes and state", () => {
  assert.equal(renderTemplate("log ${input.branch}", context()), "log main");
  assert.equal(renderTemplate("${phases.plan.result}", context()), "abc123 first\nabc124 second");
  assert.equal(renderTemplate("exit=${phases.plan.exit}", context()), "exit=0");
  assert.equal(renderTemplate("at ${state:/jobs/cursor}", context()), "at 41");
  assert.equal(renderTemplate("no refs", context()), "no refs");
});

test("a substituted value is data: it is never parsed again, so it cannot smuggle in a reference or a command", () => {
  const out = renderTemplate("--grep=${input.odd}", context());
  assert.equal(out, "--grep=-rf; $(x) `y` ${input.branch}", "the braces in the value stay text; they are not substituted a second time");
});

test("rendering refuses what it cannot render faithfully, rather than guessing", () => {
  const fails = (text: string, ctx = context()) => assert.throws(() => renderTemplate(text, ctx), TemplateError);
  fails("${input.nope}");
  fails("${phases.missing.result}");
  fails("${state:/nothing/here}");
  fails("${phases.plan.exit}", context({ results: { plan: { result: "", exit: null } } }));
  fails("${input.branch}", context({ input: { branch: "x".repeat(JOB_LIMITS.valueChars + 1) } }));
  fails("${input.branch}", context({ input: { branch: "a\u0000b" } }));
  fails("${input.branch", context());
});

test("rendering a JSON value renders every string in it and copies the rest", () => {
  assert.deepEqual(
    renderValue({ a: "${input.branch}", b: [1, true, null, "${phases.plan.exit}"], c: { d: "x${input.branch}" } }, context()),
    { a: "main", b: [1, true, null, "0"], c: { d: "xmain" } },
  );
  assert.equal(renderValue(5, context()), 5);
});

test("inputs: defaults fill in, required ones must come, unknown ones are refused, and bounds hold", () => {
  const job = parse(release);
  assert.ok(job.success);
  const def: JobDefinition = job.data;
  assert.deepEqual(resolveInputs(def, { ticket: "T-1" }), { branch: "main", ticket: "T-1" });
  assert.deepEqual(resolveInputs(def, { ticket: "T-1", branch: "dev" }), { branch: "dev", ticket: "T-1" });
  assert.throws(() => resolveInputs(def, {}), (e: unknown) => e instanceof JobInputError && /"ticket" is required/.test(e.message));
  assert.throws(() => resolveInputs(def, { ticket: "x", extra: "y" }), /has no input "extra".*"branch", "ticket"/);
  assert.throws(() => resolveInputs(def, { ticket: 5 }), /must be a string/);
  assert.throws(() => resolveInputs(def, { ticket: "x".repeat(300) }), /longer than 256/);
  assert.throws(() => resolveInputs(def, { ticket: "a\u0000b" }), /NUL/);
  assert.deepEqual(resolveInputs(def, undefined === undefined ? { ticket: "t" } : {}), { branch: "main", ticket: "t" });
});

test("the hash is stable across key order and changes with any difference", () => {
  const a = parse(release); assert.ok(a.success);
  const reordered = parse({ phases: (release as { phases: unknown[] }).phases, input: (release as { input: object }).input, description: (release as { description: string }).description });
  assert.ok(reordered.success);
  assert.equal(hashDefinition(a.data), hashDefinition(reordered.data));
  const changed = parse({ ...(release as object), description: "different" }); assert.ok(changed.success);
  assert.notEqual(hashDefinition(a.data), hashDefinition(changed.data));
  assert.match(hashDefinition(a.data), /^[0-9a-f]{64}$/);
});

test("a channel's job table: names are checked and the count is capped", () => {
  assert.ok(JobsSchema.safeParse({ "release-check": release }).success);
  assert.ok(!JobsSchema.safeParse({ "Bad Name": release }).success);
  const many = Object.fromEntries(Array.from({ length: JOB_LIMITS.definitionsPerChannel + 1 }, (_, i) => [`job${i}`, release]));
  assert.ok(!JobsSchema.safeParse(many).success);
  assert.deepEqual(JobsSchema.parse(undefined), {}, "no jobs by default");
});
