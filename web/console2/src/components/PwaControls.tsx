import { Download, WifiOff } from "lucide-react";
import { useSyncExternalStore } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { installController, subscribeOnline } from "@/lib/pwa";

/** Whether the browser thinks the network is up. It can be wrong in the other direction (connected to nothing), never in this one. */
export function useOnline(): boolean {
  return useSyncExternalStore((notify) => subscribeOnline(window, notify), () => navigator.onLine, () => true);
}

const noop = () => () => undefined;

/** The browser's install offer, when there is one. */
export function useCanInstall(): boolean {
  return useSyncExternalStore(installController ? installController.subscribe : noop, () => installController?.canInstall() ?? false, () => false);
}

/** Shown only while the browser is offering installation. Hidden once installed, when running installed, and on iOS (no offer). */
export function InstallButton() {
  const canInstall = useCanInstall();
  if (!canInstall) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="outline" size="sm" className="shrink-0 gap-2" data-testid="install" aria-label="Install the console as an app" onClick={() => { void installController?.install(); }}>
          <Download aria-hidden /><span className="hidden sm:inline">Install</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent>Install this console as an app on this device</TooltipContent>
    </Tooltip>
  );
}

/** A small marker in the header while offline. */
export function OfflineBadge() {
  if (useOnline()) return null;
  return (
    <Badge variant="outline" className="shrink-0 gap-1.5 border-amber-500/60 text-amber-700 dark:text-amber-400" data-testid="offline-badge">
      <WifiOff className="size-3" aria-hidden /><span className="hidden sm:inline">Offline</span>
    </Badge>
  );
}

/** Under the header while offline: what is on screen is the last data received, and may be out of date. */
export function OfflineBanner() {
  if (useOnline()) return null;
  return (
    <div role="status" data-testid="offline" className="flex shrink-0 items-center gap-2 border-b border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-900 dark:text-amber-200">
      <WifiOff className="size-3.5 shrink-0" aria-hidden />
      <span>You are offline. Anything shown is the last data received and may be out of date; it will refresh when the connection returns.</span>
    </div>
  );
}
