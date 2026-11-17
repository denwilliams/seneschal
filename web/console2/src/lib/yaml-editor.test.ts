import { describe, expect, it } from "vitest";
import { ChangeSet, Text } from "@codemirror/state";
import { applyYamlChanges, yamlSections } from "./yaml-editor";

function edit(source: string, changes: Parameters<typeof ChangeSet.of>[0]) {
  const doc = Text.of(source.split(/\r\n?|\n/));
  return applyYamlChanges(source, ChangeSet.of(changes, doc.length));
}

describe("lossless YAML source edits", () => {
  it("preserves comments, whitespace, literal references and mixed line endings outside edits", () => {
    const source = '# keep  \r\ndefaults:\n  model: old\rconnectors: {}\r\n# ${TOKEN}\n';
    const normalized = source.replace(/\r\n?|\n/g, "\n");
    const from = normalized.indexOf("old");
    expect(edit(source, { from, to: from + 3, insert: "new" })).toBe(source.replace("old", "new"));
    expect(edit(source, [])).toBe(source);
  });
  it("maps multiple disjoint edits across CRLF boundaries and uses the source newline for insertions", () => {
    const source = 'a: 1\r\nb: 2\r\nc: 3\r\n';
    expect(edit(source, [{ from: 3, to: 4, insert: "one" }, { from: 13, to: 14, insert: "three\nnext: 4" }])).toBe('a: one\r\nb: 2\r\nc: three\r\nnext: 4\r\n');
    expect(edit(source, { from: 4, to: 5 })).toBe('a: 1b: 2\r\nc: 3\r\n');
    expect(edit("", { from: 0, insert: "a:\n  b: 1\n" })).toBe("a:\n  b: 1\n");
  });
});

describe("YAML draft outline", () => {
  it("lists only top-level keys, preserving order and source positions", () => {
    const text = '# comment\ndefaults:\n  model: test\n  prompt: |\n    fake: section\nconnectors:\n  github:\n    enabled: true\n';
    const sections = yamlSections(text);
    expect(sections.map((s) => s.label)).toEqual(["defaults", "connectors"]);
    for (const section of sections) expect(text.slice(section.from, section.to)).toBe(section.label);
  });
  it("supports quoted/explicit keys, flow maps, anchors and document markers", () => {
    expect(yamlSections('---\n"quoted key": {}\n? explicit\n: value\n').map((s) => s.label)).toEqual(['"quoted key"', "explicit"]);
    expect(yamlSections('{defaults: {model: test}, connectors: []}').map((s) => s.label)).toEqual(["defaults", "connectors"]);
    expect(yamlSections('&root\ndefaults: {}\n').map((s) => s.label)).toEqual(["defaults"]);
    expect(yamlSections('---\ndefaults: {}\n---\nconnectors: {}').map((s) => s.label)).toEqual(["defaults", "connectors"]);
  });
  it("tolerates incomplete YAML without inventing scalar/list sections", () => {
    expect(yamlSections('defaults: [').map((s) => s.label)).toEqual(["defaults"]);
    expect(yamlSections('')).toEqual([]);
    expect(yamlSections('# comment\njust a scalar')).toEqual([]);
    expect(yamlSections('- name: not-a-top-level-key')).toEqual([]);
  });
  it("handles a large draft without mistaking thousands of nested nodes for sections", () => {
    const text = 'defaults:\n  model: test\nchannels:\n' + Array.from({ length: 3000 }, (_, n) => `  channel-${n}:\n    model: test\n`).join('') + 'connectors: {}\n';
    expect(yamlSections(text).map((s) => s.label)).toEqual(["defaults", "channels", "connectors"]);
  });
});
