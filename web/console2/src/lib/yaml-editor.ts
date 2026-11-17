import type { ChangeSet } from "@codemirror/state";
import { yamlLanguage } from "@codemirror/lang-yaml";
import { foldedRanges, unfoldEffect } from "@codemirror/language";
import { EditorView } from "@codemirror/view";

export interface YamlSection { label: string; from: number; to: number }

// CodeMirror uses normalized line boundaries. Apply only the edited ranges to
// the original source, retaining even mixed LF/CRLF/CR endings outside an edit.
// Newly inserted lines use the draft's first line ending (LF for an empty file).
export function applyYamlChanges(source: string, changes: ChangeSet): string {
  const crlf = Array.from(source.matchAll(/\r\n/g), (match, index) => match.index - index);
  function rawOffset(position: number) {
    let low = 0, high = crlf.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (crlf[middle]! < position) low = middle + 1;
      else high = middle;
    }
    return position + low;
  }
  const newline = source.match(/\r\n?|\n/)?.[0] ?? "\n";
  let result = "", previous = 0;
  changes.iterChanges((from, to, _fromB, _toB, inserted) => {
    const start = rawOffset(from), end = rawOffset(to);
    result += source.slice(previous, start) + inserted.toString().replaceAll("\n", newline);
    previous = end;
  });
  return result + source.slice(previous);
}

// Use the YAML grammar, not indentation regexes: block strings, quoted keys,
// flow mappings and comments must not create spurious outline entries.
// Positions use CodeMirror's normalized (LF) document coordinates.
export function yamlSections(text: string): YamlSection[] {
  const sections: YamlSection[] = [];
  const tree = yamlLanguage.parser.parse(text);
  for (const document of tree.topNode.getChildren("Document")) {
    let root = document.firstChild;
    while (root && ["Directive", "DirectiveEnd", "Comment", "BOM"].includes(root.name)) root = root.nextSibling;
    while (root && ["Anchored", "Tagged"].includes(root.name)) root = root.lastChild;
    if (!root || !["BlockMapping", "FlowMapping"].includes(root.name)) continue;
    for (const pair of root.getChildren("Pair")) {
      const key = pair.getChild("Key");
      if (key) sections.push({ label: text.slice(key.from, key.to), from: key.from, to: key.to });
    }
  }
  return sections;
}

export function revealYamlSection(view: EditorView, section: YamlSection) {
  const effects = [];
  // Reveal a folded ancestor (including a root flow mapping), and the
  // destination's own body. Keep unrelated/nested folds as the user left them.
  const lineEnd = view.state.doc.lineAt(section.from).to;
  foldedRanges(view.state).between(0, view.state.doc.length, (from, to) => {
    if (from <= lineEnd && to >= section.from) effects.push(unfoldEffect.of({ from, to }));
  });
  effects.push(EditorView.scrollIntoView(section.from, { y: "center" }));
  view.dispatch({ selection: { anchor: section.from, head: section.to }, effects });
  view.focus();
}
