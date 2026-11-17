/** Whether the workspace panel is collapsed to its rail. Kept per browser; the page works the same when storage is not available. */
export const SIDEBAR_KEY = "console2-tree-collapsed";

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const browserStore = (): KeyValueStore | undefined => { try { return localStorage; } catch { return undefined; } };

export function readCollapsed(store: KeyValueStore | undefined = browserStore()): boolean {
  try { return store?.getItem(SIDEBAR_KEY) === "1"; } catch { return false; }
}

export function writeCollapsed(collapsed: boolean, store: KeyValueStore | undefined = browserStore()): void {
  try { store?.setItem(SIDEBAR_KEY, collapsed ? "1" : "0"); } catch { /* private mode or blocked storage: the choice just does not outlive the page */ }
}
