import assert from "node:assert/strict";
import { test } from "node:test";
import { agentFooter, FOOTER_TEXT, footerInstruction, footerMarker, parseFooter, withFooter } from "./footer.ts";

/** The footer on everything the factory agent writes to GitHub, and the one parser that reads it. docs/FACTORY_WORKFLOW_DESIGN.md section 19. */

const parts = { role: "github_triage", stage: "triage", runId: "run-ab12" };

test("the footer is a visible line and a hidden marker, and parses back to what was put in", () => {
  const footer = agentFooter(parts);
  assert.equal(footer, "*Sent by the factory agent (github_triage) · run run-ab12*\n<!-- harness:factory run=run-ab12 role=github_triage stage=triage -->");
  assert.deepEqual(parseFooter(`I need the browser version.\n\n${footer}`), { runId: "run-ab12", role: "github_triage", stage: "triage", marker: true, visible: true });
  assert.equal(footerMarker({ role: "filing", stage: "issue" }), "<!-- harness:factory role=filing stage=issue -->");
  assert.ok(footerInstruction(parts).includes(footer), "the brief carries the exact text");
});

test("only a footer at the very end counts: not in the middle, not quoted, not after a person's own words", () => {
  const footer = agentFooter(parts);
  assert.equal(parseFooter(`${footer}\n\nand then more text`), undefined, "in the middle");
  assert.equal(parseFooter("A comment with no footer."), undefined);
  assert.equal(parseFooter(""), undefined);

  // GitHub's quote-reply copies the agent's comment with `>` in front of every line, and the person writes under it.
  const quoted = `> I need the browser version.\n>\n> ${footer.split("\n").join("\n> ")}\n\nChrome 126, on a Mac.`;
  assert.equal(parseFooter(quoted), undefined, "a quote with the person's reply after it");
  assert.equal(parseFooter(`> ${footer.split("\n").join("\n> ")}`), undefined, "a quote with nothing after it: the lines start with >");
  assert.equal(parseFooter(`Reply: ${footer.split("\n")[0]}`), undefined, "the visible line must start its line");
  assert.equal(parseFooter(`- ${footer.split("\n")[0]}`), undefined, "a list item is not the footer");
  assert.equal(parseFooter(`text\n  ${footer.split("\n")[1]}`), undefined, "an indented marker is not the harness's");
});

test("trailing blank lines and Windows line endings do not hide it; either half alone is enough", () => {
  const footer = agentFooter(parts);
  assert.ok(parseFooter(`text\r\n\r\n${footer.replace(/\n/g, "\r\n")}\r\n\r\n`));
  const visibleOnly = parseFooter(`text\n\n*${FOOTER_TEXT} (coder) · run r1*\n`);
  assert.deepEqual([visibleOnly?.marker, visibleOnly?.visible, visibleOnly?.role, visibleOnly?.runId], [false, true, "coder", "r1"]);
  const markerOnly = parseFooter("text\n<!-- harness:factory role=filing stage=issue -->");
  assert.deepEqual([markerOnly?.marker, markerOnly?.visible, markerOnly?.role], [true, false, "filing"]);
});

test("values are plain identifiers, so a footer cannot carry markup or break out of the comment", () => {
  const hostile = agentFooter({ role: "coder -->\n<script>", stage: "a b", runId: "x*\n[l](http://e)" });
  assert.ok(!/<script|\]\(|-->\n/.test(hostile.replace(/<!-- harness:factory[^\n]*-->$/, "")), hostile);
  assert.equal(hostile.split("\n").length, 2, "always exactly the two lines");
  assert.ok(parseFooter(hostile));
});

test("withFooter ends a body with the footer once", () => {
  const once = withFooter("The change is ready.\n\n", parts);
  assert.ok(once.endsWith(agentFooter(parts)));
  assert.equal(withFooter(once, parts), once, "not added twice");
});
