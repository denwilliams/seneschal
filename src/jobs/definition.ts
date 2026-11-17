import { createHash } from "node:crypto";
import { z } from "zod";
import { parsePointer, StateError } from "../agent/durable/state.ts";

/**
 * Job definitions: named, repeatable workflows made of phases (docs/STATE_AND_JOBS_DESIGN.md, part 2).
 *
 * A definition is data, not code. Each phase composes something the harness already trusts: `exec` runs a command from the
 * channel's own `exec` policy, `state` writes into the channel's state object. There is no expression evaluation and no
 * shell: templates are plain string substitution, and an `exec` phase's arguments are an argv array, so a substituted value
 * can only ever be one argument.
 */

const NAME = /^[a-z][a-z0-9_-]{0,47}$/;
const PARAM = /^[a-z][a-z0-9_]{0,31}$/;

export const JOB_LIMITS = {
  phases: 20,
  params: 10,
  args: 32,
  argChars: 1_024,
  /** One substituted value, and the stored result of one phase. */
  valueChars: 4_096,
  descriptionChars: 300,
  definitionsPerChannel: 20,
} as const;

const paramShape = z.object({
  type: z.literal("string").default("string"),
  description: z.string().max(JOB_LIMITS.descriptionChars).optional(),
  /** Absent means the parameter is required. */
  default: z.string().max(1_024).optional(),
  maxLength: z.number().int().min(1).max(1_024).default(256),
}).strict();

const execPhaseShape = z.object({
  name: z.string().regex(NAME),
  kind: z.literal("exec"),
  /** The name of a command in this channel's `exec.commands`, not an executable path. */
  command: z.string().min(1).max(64),
  /** Arguments after the command's fixed prefix. Each item is one argv token; `${...}` references are substituted per token. */
  args: z.array(z.string().max(JOB_LIMITS.argChars)).max(JOB_LIMITS.args).default([]),
  /** Defaults to the command's own timeout. */
  timeoutSeconds: z.number().int().min(1).max(3_600).optional(),
  /** `fail` (the default) ends the run when the command exits non-zero; `continue` records the failure and goes on. */
  onFailure: z.enum(["fail", "continue"]).default("fail"),
}).strict();

const statePhaseShape = z.object({
  name: z.string().regex(NAME),
  kind: z.literal("state"),
  op: z.enum(["set", "merge", "delete", "append"]),
  /** A JSON Pointer into the channel's state object. Fixed text: it is not templated. */
  path: z.string().max(256),
  /** Any JSON; string values may contain `${...}` references. Not used by `delete`. */
  value: z.unknown().optional(),
}).strict();

const phaseShape = z.discriminatedUnion("kind", [execPhaseShape, statePhaseShape]);

export const JobDefinitionSchema = z.object({
  description: z.string().max(JOB_LIMITS.descriptionChars).optional(),
  input: z.record(z.string().regex(PARAM), paramShape).default({}),
  phases: z.array(phaseShape).min(1).max(JOB_LIMITS.phases),
}).strict().superRefine((job, ctx) => {
  if (Object.keys(job.input).length > JOB_LIMITS.params) {
    ctx.addIssue({ code: "custom", path: ["input"], message: `a job takes at most ${JOB_LIMITS.params} inputs` });
  }
  const seen = new Set<string>();
  job.phases.forEach((phase, index) => {
    if (seen.has(phase.name)) ctx.addIssue({ code: "custom", path: ["phases", index, "name"], message: `phase name "${phase.name}" is used twice` });
    seen.add(phase.name);
  });
  // Every reference must point at something that exists by the time the phase runs.
  const earlier = new Map<string, "exec" | "state">();
  job.phases.forEach((phase, index) => {
    const templates: { where: (string | number)[]; text: string }[] = [];
    if (phase.kind === "exec") phase.args.forEach((text, i) => templates.push({ where: ["phases", index, "args", i], text }));
    else collectStrings(phase.value, ["phases", index, "value"], templates);
    for (const { where, text } of templates) {
      for (const problem of checkTemplate(text, { inputs: new Set(Object.keys(job.input)), earlier })) {
        ctx.addIssue({ code: "custom", path: where, message: problem });
      }
    }
    if (phase.kind === "state") {
      try {
        parsePointer(phase.path);
      } catch (error) {
        ctx.addIssue({ code: "custom", path: ["phases", index, "path"], message: error instanceof StateError ? error.message : String(error) });
      }
      if (phase.op !== "delete" && phase.value === undefined) ctx.addIssue({ code: "custom", path: ["phases", index, "value"], message: `the "${phase.op}" operation needs a value` });
    }
    earlier.set(phase.name, phase.kind);
  });
});

export type JobDefinition = z.infer<typeof JobDefinitionSchema>;
export type JobPhase = JobDefinition["phases"][number];
export type ExecPhase = Extract<JobPhase, { kind: "exec" }>;
export type StatePhase = Extract<JobPhase, { kind: "state" }>;

export const JobNameSchema = z.string().regex(NAME);

/** The job table of a channel: name to definition. Names are validated here, definitions by `JobDefinitionSchema`. */
export const JobTableSchema = z.record(JobNameSchema, JobDefinitionSchema).superRefine((jobs, ctx) => {
  if (Object.keys(jobs).length > JOB_LIMITS.definitionsPerChannel) {
    ctx.addIssue({ code: "custom", message: `at most ${JOB_LIMITS.definitionsPerChannel} jobs per channel` });
  }
});
export const JobsSchema = JobTableSchema.default({});
export type JobTable = z.infer<typeof JobTableSchema>;

function collectStrings(value: unknown, where: (string | number)[], out: { where: (string | number)[]; text: string }[]): void {
  if (typeof value === "string") out.push({ where, text: value });
  else if (Array.isArray(value)) value.forEach((item, i) => collectStrings(item, [...where, i], out));
  else if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) collectStrings(item, [...where, key], out);
}

/** A stable fingerprint of a definition: the same definition always hashes the same, whatever its key order. */
export function hashDefinition(definition: JobDefinition): string {
  return createHash("sha256").update(canonical(definition)).digest("hex");
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

// ── Templates ────────────────────────────────────────────────────────────────────────────────────────────────

export type TemplatePart = { text: string } | { ref: TemplateRef };
export type TemplateRef =
  | { kind: "input"; name: string }
  | { kind: "result"; phase: string }
  | { kind: "exit"; phase: string }
  | { kind: "state"; path: string };

function parseRef(body: string): TemplateRef | undefined {
  let m: RegExpExecArray | null;
  if ((m = /^input\.([a-z][a-z0-9_]{0,31})$/.exec(body))) return { kind: "input", name: m[1]! };
  if ((m = /^phases\.([a-z][a-z0-9_-]{0,47})\.result$/.exec(body))) return { kind: "result", phase: m[1]! };
  if ((m = /^phases\.([a-z][a-z0-9_-]{0,47})\.exit$/.exec(body))) return { kind: "exit", phase: m[1]! };
  if ((m = /^state:(\/.*)$/.exec(body))) return { kind: "state", path: m[1]! };
  return undefined;
}

/**
 * Split text into literal parts and references. `$${` is a literal `${`. A `${` that is not a well-formed reference is an
 * error, never silently left in: a typo in a reference must not become part of a command.
 */
export function parseTemplate(text: string): TemplatePart[] | { error: string } {
  const parts: TemplatePart[] = [];
  let literal = "";
  const flush = () => { if (literal) { parts.push({ text: literal }); literal = ""; } };
  for (let i = 0; i < text.length;) {
    if (text.startsWith("$${", i)) { literal += "${"; i += 3; continue; }
    if (text.startsWith("${", i)) {
      const end = text.indexOf("}", i + 2);
      if (end === -1) return { error: 'a "${" with no closing "}"; write "$${" for a literal "${"' };
      const body = text.slice(i + 2, end).trim();
      const ref = parseRef(body);
      if (!ref) return { error: `"\${${body}}" is not a reference this job understands: use \${input.name}, \${phases.name.result}, \${phases.name.exit} or \${state:/pointer}` };
      flush();
      parts.push({ ref });
      i = end + 1;
      continue;
    }
    literal += text[i]!;
    i++;
  }
  flush();
  return parts;
}

/** What a template may refer to, for validating a definition: its inputs, and the phases that come before it. */
export function checkTemplate(text: string, scope: { inputs: ReadonlySet<string>; earlier: ReadonlyMap<string, "exec" | "state"> }): string[] {
  const parsed = parseTemplate(text);
  if ("error" in parsed) return [parsed.error];
  const problems: string[] = [];
  for (const part of parsed) {
    if (!("ref" in part)) continue;
    const { ref } = part;
    if (ref.kind === "input" && !scope.inputs.has(ref.name)) problems.push(`\${input.${ref.name}} is not an input of this job`);
    if (ref.kind === "result" || ref.kind === "exit") {
      const kind = scope.earlier.get(ref.phase);
      if (kind === undefined) problems.push(`phase "${ref.phase}" has not run by this point (a phase can only refer to an earlier one)`);
      else if (kind !== "exec") problems.push(`phase "${ref.phase}" is not an exec phase, so it has no ${ref.kind}`);
    }
    if (ref.kind === "state") {
      try { parsePointer(ref.path); } catch (error) { problems.push(error instanceof StateError ? error.message : String(error)); }
    }
  }
  return problems;
}

/** What a run knows while it renders a phase: the inputs it was given, what earlier phases produced, and the live state. */
export interface RenderContext {
  input: Readonly<Record<string, string>>;
  results: Readonly<Record<string, { result: string; exit: number | null }>>;
  /** Looks up a state pointer; `undefined` means nothing is there. */
  state: (path: string) => string | undefined;
}

export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateError";
  }
}

/** Substitute every reference. A missing value, an over-long value or a NUL is an error, never an empty string or a truncation. */
export function renderTemplate(text: string, context: RenderContext): string {
  const parsed = parseTemplate(text);
  if ("error" in parsed) throw new TemplateError(parsed.error);
  return parsed.map((part) => {
    if ("text" in part) return part.text;
    const { ref } = part;
    let value: string | undefined;
    if (ref.kind === "input") value = context.input[ref.name];
    else if (ref.kind === "result") value = context.results[ref.phase]?.result;
    else if (ref.kind === "exit") { const exit = context.results[ref.phase]?.exit; value = exit === undefined || exit === null ? undefined : String(exit); }
    else value = context.state(ref.path);
    if (value === undefined) throw new TemplateError(`\${${describeRef(ref)}} has no value`);
    if (value.length > JOB_LIMITS.valueChars) throw new TemplateError(`\${${describeRef(ref)}} is longer than ${JOB_LIMITS.valueChars} characters`);
    if (value.includes("\u0000")) throw new TemplateError(`\${${describeRef(ref)}} contains a NUL character`);
    return value;
  }).join("");
}

function describeRef(ref: TemplateRef): string {
  return ref.kind === "input" ? `input.${ref.name}` : ref.kind === "state" ? `state:${ref.path}` : `phases.${ref.phase}.${ref.kind}`;
}

/** Render every string inside a JSON value; everything else is copied as is. */
export function renderValue(value: unknown, context: RenderContext): unknown {
  if (typeof value === "string") return renderTemplate(value, context);
  if (Array.isArray(value)) return value.map((item) => renderValue(item, context));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, renderValue(item, context)]));
  return value;
}

// ── Inputs ───────────────────────────────────────────────────────────────────────────────────────────────────

export class JobInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobInputError";
  }
}

/** The inputs a run starts with: what was given, the defaults for what was not, and nothing the definition does not declare. */
export function resolveInputs(definition: JobDefinition, given: Record<string, unknown> | undefined): Record<string, string> {
  const supplied = given ?? {};
  for (const key of Object.keys(supplied)) {
    if (!(key in definition.input)) throw new JobInputError(`this job has no input "${key}"; its inputs are ${Object.keys(definition.input).map((k) => `"${k}"`).join(", ") || "none"}`);
  }
  const out: Record<string, string> = {};
  for (const [name, param] of Object.entries(definition.input)) {
    const value = supplied[name] ?? param.default;
    if (value === undefined) throw new JobInputError(`input "${name}" is required`);
    if (typeof value !== "string") throw new JobInputError(`input "${name}" must be a string`);
    if (value.length > param.maxLength) throw new JobInputError(`input "${name}" is longer than ${param.maxLength} characters`);
    if (value.includes("\u0000")) throw new JobInputError(`input "${name}" contains a NUL character`);
    out[name] = value;
  }
  return out;
}
