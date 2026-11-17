import type { Page } from "@playwright/test";
import type { EditorView } from "@codemirror/view";

export const rawEditor = (page: Page) => page.getByRole("textbox", { name: "Raw configuration YAML" });

// CodeMirror virtualizes the document, so DOM textContent is not the draft.
// Keep the internal DOM-to-view bridge isolated to this test helper; no test
// hooks or copies of potentially sensitive config are shipped in the app.
export async function rawText(page: Page): Promise<string> {
  return rawEditor(page).evaluate((element) => (element as unknown as { cmTile: { root: { view: EditorView } } }).cmTile.root.view.state.sliceDoc());
}
