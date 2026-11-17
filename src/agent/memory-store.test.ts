import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryFile, archivePathFor, isSameFact, normalise } from "./memory-store.ts";

/**
 * The things worth pinning down here are the ones that make consolidation safe
 * to run unattended: repeating a fact must strengthen rather than duplicate,
 * a rewrite must never destroy anything outright, and "stale" must mean all
 * three of old, unused and unrepeated — anything looser eventually forgets
 * something it shouldn't.
 */

function setup(initial = "# Memory\n") {
  const root = mkdtempSync(join(tmpdir(), "harness-memory-"));
  const path = join(root, "MEMORY.md");
  writeFileSync(path, initial);
  return { root, path, file: new MemoryFile(path) };
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 86_400_000);
}

test("a new fact is appended with today's date and tracked", () => {
  const { file, path } = setup();

  const result = file.append("The upstairs valve lies.");

  assert.equal(result.reinforced, false);
  assert.match(readFileSync(path, "utf-8"), /- \(\d{4}-\d{2}-\d{2}\) The upstairs valve lies\./);
  assert.equal(file.entries().length, 1);
  assert.equal(file.entries()[0]!.stats.strength, 1);
});

test("hearing the same fact again strengthens it instead of duplicating it", () => {
  const { file } = setup();

  file.append("Bins go out on Tuesday.");
  const second = file.append("bins go out on tuesday");

  assert.equal(second.reinforced, true, "case and punctuation do not make a different fact");
  assert.equal(file.entries().length, 1, "a second bullet would be worse, not stronger");
  assert.equal(file.entries()[0]!.stats.strength, 2);
});

test("a fuller version of a fact refines the entry and keeps its strength", () => {
  const { file, path } = setup();

  file.append("The boiler is serviced in October.");
  file.append("The boiler is serviced in October.");
  const refined = file.append("The boiler is serviced in October by Kelly Heating.");

  assert.equal(refined.reinforced, true);
  assert.equal(refined.replaced, "The boiler is serviced in October.");
  assert.equal(file.entries().length, 1);
  assert.match(readFileSync(path, "utf-8"), /by Kelly Heating/);
  assert.equal(
    file.entries()[0]!.stats.strength,
    3,
    "the strength earned by the original has to survive the rewording",
  );
});

test("two different facts are not merged just because they overlap", () => {
  const { file } = setup();

  file.append("Deploys happen on Thursday.");
  file.append("Deploys are frozen in December.");

  assert.equal(file.entries().length, 2);
});

test("a targeted recall finds the right entries and records the use", () => {
  const { file } = setup();
  file.append("The boiler is serviced in October.");
  file.append("Deploys happen on Thursday afternoon.");

  const hits = file.search("when is the boiler serviced");
  assert.equal(hits.length, 1);
  assert.match(hits[0]!.text, /boiler/);

  file.markUsed(hits.map((h) => h.id));
  const boiler = file.entries().find((e) => e.text.includes("boiler"))!;
  const deploys = file.entries().find((e) => e.text.includes("Deploys"))!;
  assert.equal(boiler.stats.uses, 1);
  assert.equal(deploys.stats.uses, 0, "an entry nobody reached for stays at zero");
});

test("a rewrite archives what it drops rather than destroying it", () => {
  const { file, path } = setup();
  file.append("Fact one.");
  file.append("Fact two.");

  const result = file.rewrite("# Memory\n\n- (2026-01-01) Fact one.\n");

  assert.equal(result.dropped.length, 1);
  assert.match(result.dropped[0]!.text, /Fact two/);
  assert.equal(file.entries().length, 1);

  const archive = readFileSync(archivePathFor(path), "utf-8");
  assert.match(archive, /Fact two/, "a dropped fact has to be recoverable by hand");
});

test("a rewrite keeps the stats of entries that survived it", () => {
  const { file } = setup();
  file.append("Deploys happen on Thursday.");
  file.append("Deploys happen on Thursday."); // strength 2
  file.markUsed(file.entries().map((e) => e.id));

  file.rewrite("# Memory\n\n## Rota\n\n- (2026-01-01) Deploys happen on Thursday.\n");

  const entry = file.entries()[0]!;
  assert.equal(entry.stats.strength, 2, "consolidating must not reset what a fact has earned");
  assert.equal(entry.stats.uses, 1);
});

test("stale means old and unused and unrepeated, not just old", () => {
  const { file, path } = setup();
  const old = daysAgo(200).toISOString().slice(0, 10);
  writeFileSync(
    path,
    [
      "# Memory",
      "",
      `- (${old}) An old fact nobody has needed.`,
      `- (${old}) An old fact that keeps coming up.`,
      "- (2099-01-01) Something learned in the future.",
      "",
    ].join("\n"),
  );

  // Give the second one a reason to be kept.
  file.append("An old fact that keeps coming up.");

  const stale = file.stale({ days: 90 });
  assert.equal(stale.length, 1);
  assert.match(stale[0]!.text, /nobody has needed/);
});

test("the annotated view carries the age and use a consolidation pass needs", () => {
  const { file, path } = setup();
  writeFileSync(path, `# Memory\n\n- (${daysAgo(10).toISOString().slice(0, 10)}) A fact.\n`);

  const annotated = file.annotated();
  assert.match(annotated, /A fact/);
  assert.match(annotated, /\d+d old/);
  assert.match(annotated, /used 0×/);
});

test("a missing index is a cache miss, not a failure", () => {
  const { path } = setup("# Memory\n\n- (2026-01-01) A fact written by hand.\n");
  const file = new MemoryFile(path);

  const entries = file.entries();
  assert.equal(entries.length, 1, "a file edited by a human must still parse");
  assert.equal(entries[0]!.stats.strength, 1);
  assert.equal(entries[0]!.stats.uses, 0);
});

test("reading a file that does not exist yet is empty, not an error", () => {
  const root = mkdtempSync(join(tmpdir(), "harness-memory-"));
  const file = new MemoryFile(join(root, "nope", "MEMORY.md"));

  assert.equal(file.read(), "");
  assert.deepEqual(file.entries(), []);
  assert.deepEqual(file.search("anything"), []);

  file.append("Now it exists.");
  assert.equal(file.entries().length, 1);
  assert.equal(existsSync(file.path), true);
});

test("fact comparison ignores case, spacing and a trailing stop", () => {
  assert.equal(normalise("  The  Boiler is old. "), "the boiler is old");
  assert.equal(isSameFact("The boiler is old", "the boiler is old."), true);
  assert.equal(isSameFact("Bins on Tuesday", "Recycling on Wednesday"), false);
  assert.equal(isSameFact("cold", "the room upstairs is cold"), false, "a fragment cannot swallow a sentence");
});
