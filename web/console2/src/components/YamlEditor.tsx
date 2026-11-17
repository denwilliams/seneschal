import { useEffect, useRef, useState } from "react";
import { Compartment, EditorState, Text, Transaction } from "@codemirror/state";
import { EditorView, drawSelection, keymap, lineNumbers } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { HighlightStyle, bracketMatching, foldAll, foldGutter, foldKeymap, forceParsing, indentOnInput, syntaxHighlighting, toggleFold, unfoldAll } from "@codemirror/language";
import { yaml } from "@codemirror/lang-yaml";
import { tags } from "@lezer/highlight";
import { Button } from "@/components/ui/button";
import { applyYamlChanges, revealYamlSection, yamlSections, type YamlSection } from "@/lib/yaml-editor";
import "./YamlEditor.css";

const highlighting = HighlightStyle.define([
  { tag: tags.definition(tags.propertyName), class: "yaml-key" },
  { tag: [tags.string, tags.content], class: "yaml-value" },
  { tag: tags.comment, class: "yaml-comment" },
  { tag: [tags.meta, tags.keyword, tags.typeName, tags.labelName], class: "yaml-meta" },
  { tag: [tags.separator, tags.punctuation], class: "yaml-punctuation" },
]);
const documentText = (text: string) => Text.of(text.split(/\r\n?|\n/));
const editability = (disabled: boolean) => [EditorState.readOnly.of(disabled), EditorView.editable.of(!disabled)];

export function YamlEditor({ value, onChange, disabled }: { value: string; onChange: (value: string) => void; disabled: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const change = useRef(onChange);
  change.current = onChange;
  const syncing = useRef(false);
  const access = useRef(new Compartment());
  const source = useRef(value);
  const [sections, setSections] = useState<YamlSection[]>([]);

  useEffect(() => {
    const editor = new EditorView({
      parent: host.current!,
      state: EditorState.create({ doc: documentText(value), extensions: [
        yaml(), lineNumbers(), foldGutter(), history(), drawSelection(), bracketMatching(), indentOnInput(),
        keymap.of([...defaultKeymap, ...historyKeymap, ...foldKeymap, indentWithTab]),
        EditorView.lineWrapping, syntaxHighlighting(highlighting),
        access.current.of(editability(disabled)),
        EditorView.contentAttributes.of({ "aria-label": "Raw configuration YAML", "aria-describedby": "yaml-editor-help", spellcheck: "false" }),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          setSections(yamlSections(update.state.doc.toString()));
          if (!syncing.current) {
            source.current = applyYamlChanges(source.current, update.changes);
            change.current(source.current);
          }
        }),
      ] }),
    });
    view.current = editor;
    setSections(yamlSections(editor.state.doc.toString()));
    return () => { view.current = null; editor.destroy(); };
    // The view lives for this mount. Prop updates are transactions, not remounts
    // that would lose selection, history and folds on every keystroke.
  }, []);

  useEffect(() => {
    const editor = view.current;
    if (!editor || source.current === value) return;
    source.current = value;
    syncing.current = true;
    try {
      // External reloads/form patches are not user edits or undo steps.
      editor.dispatch({
        changes: { from: 0, to: editor.state.doc.length, insert: documentText(value) },
        annotations: Transaction.addToHistory.of(false),
      });
    } finally { syncing.current = false; }
  }, [value]);

  useEffect(() => { view.current?.dispatch({ effects: access.current.reconfigure(editability(disabled)) }); }, [disabled]);

  return <div className="min-w-0 space-y-2">
    <p className="text-sm font-medium">Persisted config draft (YAML)</p>
    <nav aria-label="Top-level YAML sections" className="max-h-32 overflow-y-auto rounded-md border bg-muted/40 p-2">
      <p className="mb-1 text-xs text-muted-foreground">Jump to section</p>
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {sections.length ? sections.map((section) => <button key={section.from} type="button" disabled={disabled} className="max-w-full break-all text-left font-mono text-xs underline underline-offset-2 focus-visible:outline focus-visible:outline-2" onClick={() => view.current && revealYamlSection(view.current, section)}>{section.label}</button>) : <span className="text-xs text-muted-foreground">No top-level mapping sections in this draft.</span>}
      </div>
    </nav>
    <div className="flex flex-wrap gap-2">
      <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => { if (view.current) { forceParsing(view.current, view.current.state.doc.length, 1000); foldAll(view.current); } }}>Fold all</Button>
      <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => view.current && unfoldAll(view.current)}>Expand all</Button>
      <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => view.current && toggleFold(view.current)}>Toggle current fold</Button>
    </div>
    <div ref={host} className="yaml-editor min-w-0 overflow-hidden rounded-md border bg-background text-xs font-normal" />
    <p id="yaml-editor-help" className="text-xs text-muted-foreground">Use the gutter arrows to fold nested nodes, or Ctrl+Shift+[ / ] (Mac: Cmd+Alt+[ / ]). Tab indents; Escape then Tab leaves the editor. Folding and section jumps never change your draft.</p>
  </div>;
}
