/**
 * What the console needs to behave as an installed app: the browser's install offer, and whether the network is there.
 * Kept free of React so it can be tested with plain objects.
 */

/** The non-standard event Chromium fires when the page can be installed. iOS Safari has no equivalent. */
export interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export type InstallResult = "accepted" | "dismissed" | "unavailable";

export interface InstallController {
  subscribe(listener: () => void): () => void;
  /** True while the browser is offering installation and the app is not already installed or running installed. */
  canInstall(): boolean;
  /** Show the browser's own install dialog. The offer is single-use: afterwards the button hides until the browser offers again. */
  install(): Promise<InstallResult>;
}

/**
 * Listens for the install offer. It has to be created before the app mounts, because the browser may fire the event as soon
 * as the page loads and never again. The event is held (and its default mini-bar suppressed) so a button can use it later.
 */
export function createInstallController(target: EventTarget, isStandalone: () => boolean): InstallController {
  let offer: BeforeInstallPromptEvent | undefined;
  let installed = false;
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());

  target.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    offer = event as BeforeInstallPromptEvent;
    notify();
  });
  target.addEventListener("appinstalled", () => {
    installed = true;
    offer = undefined;
    notify();
  });

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    canInstall: () => offer !== undefined && !installed && !isStandalone(),
    async install() {
      const current = offer;
      if (!current) return "unavailable";
      offer = undefined;
      notify();
      try {
        await current.prompt();
        return (await current.userChoice).outcome;
      } catch {
        return "unavailable";
      }
    },
  };
}

/** Created at import, so the offer is caught even though the app mounts a moment later. Absent outside a browser. */
export const installController: InstallController | undefined = typeof window === "undefined"
  ? undefined
  : createInstallController(window, () => window.matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true);

/** Subscribe to the browser's online/offline events. */
export function subscribeOnline(target: Pick<EventTarget, "addEventListener" | "removeEventListener">, listener: () => void): () => void {
  target.addEventListener("online", listener);
  target.addEventListener("offline", listener);
  return () => { target.removeEventListener("online", listener); target.removeEventListener("offline", listener); };
}

/** Register the service worker. Relative, so it works under any reverse-proxy prefix. Never throws: the app works without it. */
export function registerServiceWorker(nav: Pick<Navigator, "serviceWorker"> | { serviceWorker?: undefined } = navigator): Promise<boolean> {
  if (!nav.serviceWorker) return Promise.resolve(false);
  return nav.serviceWorker.register("./sw.js", { scope: "./" }).then(() => true, () => false);
}
