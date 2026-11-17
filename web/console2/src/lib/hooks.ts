import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ConsoleEvent } from "@api/api-types";
import { eventsUrl } from "./api";
import { readCollapsed, writeCollapsed } from "./sidebar";

export interface Fetched<T> {
  data: T | undefined;
  error: string | undefined;
  loading: boolean;
  reload: () => void;
}

/**
 * Fetch on mount and whenever `key` changes, aborting the previous request. `refreshToken` triggers a quiet refetch that
 * keeps the old data on screen, so live updates never flash a skeleton.
 */
export function useApi<T>(load: ((signal: AbortSignal) => Promise<T>) | undefined, key: string, refreshToken = 0): Fetched<T> {
  const [state, setState] = useState<{ key: string; data?: T; error?: string; loading: boolean }>({ key, loading: load !== undefined });
  const loadRef = useRef(load);
  loadRef.current = load;
  const [manual, setManual] = useState(0);

  useEffect(() => {
    const fn = loadRef.current;
    if (!fn) { setState({ key, loading: false }); return; }
    const controller = new AbortController();
    setState((previous) => (previous.key === key ? { ...previous, loading: previous.data === undefined } : { key, loading: true }));
    fn(controller.signal).then(
      (data) => { if (!controller.signal.aborted) setState({ key, data, loading: false }); },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setState((previous) => ({ key, data: previous.key === key ? previous.data : undefined, error: error instanceof Error ? error.message : String(error), loading: false }));
      },
    );
    return () => controller.abort();
  }, [key, refreshToken, manual, load !== undefined]);

  const reload = useCallback(() => setManual((n) => n + 1), []);
  const current = state.key === key ? state : { key, loading: load !== undefined } as typeof state;
  return { data: current.data, error: current.error, loading: current.loading, reload };
}

export type Connection = "connecting" | "connected" | "reconnecting";

/** One EventSource for the page, reopened when the watched thread changes, with capped exponential backoff. */
export function useEvents(channelId: string | undefined, threadKey: string | undefined, onEvent: (event: ConsoleEvent) => void, onReconnect?: () => void): Connection {
  const [connection, setConnection] = useState<Connection>("connecting");
  const handler = useRef(onEvent);
  handler.current = onEvent;
  const reconnect = useRef(onReconnect);
  reconnect.current = onReconnect;

  useEffect(() => {
    let source: EventSource | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let stopped = false;
    // Set when this stream failed; the next successful open is a reconnect, which has missed events.
    let recovering = false;
    const open = () => {
      if (stopped) return;
      source = new EventSource(eventsUrl(channelId, threadKey));
      source.onopen = () => {
        attempt = 0;
        setConnection("connected");
        if (recovering) { recovering = false; reconnect.current?.(); }
      };
      source.onmessage = (message) => {
        try { handler.current(JSON.parse(message.data) as ConsoleEvent); } catch { /* ignore a malformed frame */ }
      };
      source.onerror = () => {
        source?.close();
        recovering = true;
        setConnection("reconnecting");
        attempt += 1;
        timer = setTimeout(open, Math.min(30_000, 500 * 2 ** Math.min(attempt, 6)));
      };
    };
    setConnection("connecting");
    open();
    return () => { stopped = true; source?.close(); if (timer) clearTimeout(timer); };
  }, [channelId, threadKey]);

  return connection;
}

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (notify) => { const list = matchMedia(query); list.addEventListener("change", notify); return () => list.removeEventListener("change", notify); },
    () => matchMedia(query).matches,
    () => false,
  );
}

/** The workspace panel's collapsed flag: read once before the first paint (no flash of the wrong layout), written on every change. */
export function useTreeCollapsed(): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState(() => readCollapsed());
  const toggle = useCallback(() => {
    setCollapsed((previous) => { writeCollapsed(!previous); return !previous; });
  }, []);
  return [collapsed, toggle];
}

export function useTheme(): { dark: boolean; toggle: () => void } {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  const toggle = useCallback(() => {
    setDark((previous) => {
      const next = !previous;
      document.documentElement.classList.toggle("dark", next);
      try { localStorage.setItem("console2-theme", next ? "dark" : "light"); } catch { /* private mode */ }
      return next;
    });
  }, []);
  return { dark, toggle };
}

/** Re-render on an interval so relative times stay honest. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), intervalMs); return () => clearInterval(id); }, [intervalMs]);
  return now;
}

export function useHashRoute(): [string, (hash: string) => void] {
  const hash = useSyncExternalStore(
    (notify) => { addEventListener("hashchange", notify); return () => removeEventListener("hashchange", notify); },
    () => location.hash,
    () => "",
  );
  return [hash, (next) => { location.hash = next; }];
}
