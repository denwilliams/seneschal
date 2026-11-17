import { Eye, GitBranch, Menu, Moon, PanelRight, Search, Sun } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ConsoleEvent } from "@api/api-types";
import { ActivityView } from "@/components/ActivityView";
import { ConfigAdmin } from "@/components/ConfigAdmin";
import { CommandPalette } from "@/components/CommandPalette";
import { FactoryView } from "@/components/FactoryView";
import { TimelineView } from "@/components/TimelineView";
import { Transcript } from "@/components/Transcript";
import { channelTitle, TreeNav } from "@/components/TreeNav";
import { TreeRail } from "@/components/TreeRail";
import { StateBadge, StateDot } from "@/components/common";
import { InstallButton, OfflineBadge, OfflineBanner, useOnline } from "@/components/PwaControls";
import { Badge } from "@/components/ui/badge";
import { Breadcrumb, BreadcrumbItem, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import { threadLabel } from "@/lib/format";
import { useApi, useEvents, useHashRoute, useMediaQuery, useNow, useTheme, useTreeCollapsed, type Connection } from "@/lib/hooks";
import { reduceDraft, type Draft } from "@/lib/live";
import { buildRoute, parseRoute, TABS, type TabName, type ViewName } from "@/lib/route";
import { ExtendTab } from "@/tabs/ExtendTab";
import { FilesTab } from "@/tabs/FilesTab";
import { SessionTab } from "@/tabs/SessionTab";
import { StateTab } from "@/tabs/StateTab";
import { TasksTab } from "@/tabs/TasksTab";
import { ToolsTab } from "@/tabs/ToolsTab";

const TAB_LABEL: Record<TabName, string> = { session: "Session", state: "State", tasks: "Tasks", tools: "Tools", extend: "Extend", files: "Files" };

export default function App() {
  const [hash, setHash] = useHashRoute();
  const route = useMemo(() => parseRoute(hash), [hash]);
  const { dark, toggle } = useTheme();
  const wide = useMediaQuery("(min-width: 1024px)");
  const now = useNow();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [collapsed, toggleCollapsed] = useTreeCollapsed();
  const [treeSheet, setTreeSheet] = useState(false);
  const [panelSheet, setPanelSheet] = useState(false);
  const [treeToken, setTreeToken] = useState(0);
  const [transcriptToken, setTranscriptToken] = useState(0);
  const [draft, setDraft] = useState<Draft>();

  const { channelId } = route;
  const threadKey = route.threadKey ?? (channelId ? "main" : undefined);
  const watchKey = `${channelId ?? ""}\n${threadKey ?? ""}`;
  const watchRef = useRef(watchKey);
  watchRef.current = watchKey;
  const settle = useRef<ReturnType<typeof setTimeout>>(undefined);

  const identity = useApi((signal) => api.identity(signal), "identity", treeToken);
  const signedIn = identity.data?.identity;
  const tree = useApi((signal) => api.tree(signal), "tree", treeToken);
  const channel = useApi(channelId ? (signal) => api.channel(channelId, signal) : undefined, `channel\n${channelId ?? ""}`, treeToken);

  const navigate = useCallback((id: string, thread?: string) => {
    // Moving about inside the channel keeps its view; another channel starts on the transcript (it may have no factory).
    setHash(buildRoute({ channelId: id, ...(thread ? { threadKey: thread } : {}), tab: route.tab, view: id === route.channelId ? route.view : "transcript" }));
    setTreeSheet(false);
  }, [route.tab, route.view, route.channelId, setHash]);

  const navigateView = useCallback((id: string, view: ViewName) => {
    setHash(buildRoute({ channelId: id, ...(id === route.channelId && route.threadKey ? { threadKey: route.threadKey } : {}), tab: route.tab, view }));
    setTreeSheet(false);
  }, [route.tab, route.channelId, route.threadKey, setHash]);

  const openRun = useCallback((runId: string | undefined) => {
    setHash(buildRoute({ ...route, tab: "tasks", run: runId }));
  }, [route, setHash]);

  const onEvent = useCallback((event: ConsoleEvent) => {
    if (event.type === "tree") { setTreeToken((n) => n + 1); return; }
    if (event.type === "hello") return;
    const current = `${event.channelId}\n${event.threadKey}`;
    if (current !== watchRef.current) return;
    if (event.type === "resync") { setDraft(undefined); setTranscriptToken((n) => n + 1); return; }
    setDraft((previous) => reduceDraft(previous, event.event));
    if (event.event.kind === "message_end" || event.event.kind === "tool_end") {
      // The authoritative entry lands shortly after; refetch once things settle rather than on every event.
      clearTimeout(settle.current);
      settle.current = setTimeout(() => setTranscriptToken((n) => n + 1), 700);
    }
  }, []);

  // The stream dropped and came back (a network blip, a restart, the server's 30-minute limit). Events in the gap are
  // gone, so refetch everything and drop any half-built turn.
  const onReconnect = useCallback(() => { setDraft(undefined); setTreeToken((n) => n + 1); setTranscriptToken((n) => n + 1); }, []);
  const connection = useEvents(channelId, threadKey, onEvent, onReconnect);
  // While the browser says the network is down, an open event stream may simply not have noticed yet. Do not call that connected.
  const online = useOnline();
  const shownConnection: Connection = online ? connection : "reconnecting";

  useEffect(() => { setDraft(undefined); }, [watchKey]);
  useEffect(() => () => clearTimeout(settle.current), []);

  const treeChannel = tree.data?.channels.find((entry) => entry.id === channelId);
  const title = treeChannel ? channelTitle(treeChannel) : channelId;
  const node = treeChannel?.nodes.flatMap(function walk(n): typeof treeChannel.nodes { return [n, ...(n.children ?? []).flatMap(walk)]; }).find((n) => n.id === threadKey);
  useEffect(() => { document.title = title ? `${title} · Harness console` : "Harness console"; }, [title]);


  const treeNav = (collapsible: boolean) => (
    <TreeNav tree={tree.data} loading={tree.loading} error={tree.error} channelId={channelId} threadKey={route.threadKey} now={now} onSelect={navigate} onCollapse={collapsible ? toggleCollapsed : undefined} />
  );

  const sidePanel = (
    <Tabs value={route.tab} onValueChange={(value) => setHash(buildRoute({ ...route, tab: value as TabName, run: undefined }))} className="flex h-full min-h-0 flex-col">
      <div className="p-3 pb-0">
        <TabsList className="grid w-full grid-cols-6" aria-label="Details">
          {TABS.map((tab) => <TabsTrigger key={tab} value={tab} className="px-1.5 text-xs">{TAB_LABEL[tab]}</TabsTrigger>)}
        </TabsList>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="p-3">
          {!channelId ? (
            <p className="py-6 text-center text-sm text-muted-foreground">Select a channel to see its session, state, tasks, tools and extensions.</p>
          ) : (
            <>
              <TabsContent value="session"><SessionTab channelId={channelId} threadKey={route.threadKey} refreshToken={treeToken} /></TabsContent>
              <TabsContent value="state"><StateTab channelId={channelId} refreshToken={treeToken} /></TabsContent>
              <TabsContent value="tasks"><TasksTab channelId={channelId} refreshToken={treeToken} now={now} isDm={treeChannel?.isDm === true} isFactory={(channel.data?.factory?.name ?? treeChannel?.factory) !== undefined} runId={route.run} onOpenRun={openRun} /></TabsContent>
              <TabsContent value="tools"><ToolsTab channelId={channelId} threadKey={route.threadKey} refreshToken={treeToken} /></TabsContent>
              <TabsContent value="extend"><ExtendTab channelId={channelId} refreshToken={treeToken} /></TabsContent>
              <TabsContent value="files"><FilesTab channelId={channelId} refreshToken={treeToken} now={now} /></TabsContent>
            </>
          )}
        </div>
      </ScrollArea>
    </Tabs>
  );

  const factoryName = channel.data?.factory?.name ?? treeChannel?.factory;
  const view: ViewName = route.view === "factory" && !factoryName ? "transcript" : route.view;

  const views: { view: ViewName; label: string }[] = [
    { view: "transcript", label: "Transcript" }, { view: "timeline", label: "Timeline" }, ...(factoryName ? [{ view: "factory" as const, label: "Factory" }] : []),
  ];

  const main = channelId && threadKey ? (
    <div className="flex h-full min-h-0 flex-col">
      <div role="group" aria-label="View" className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
        <GitBranch className="size-3.5 text-muted-foreground" aria-hidden />
        <div className="inline-flex rounded-md bg-muted p-0.5">
          {views.map((entry) => (
            <button
              key={entry.view} type="button" aria-pressed={view === entry.view} data-testid={`view-${entry.view}`}
              onClick={() => navigateView(channelId, entry.view)}
              className="rounded px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring aria-pressed:bg-background aria-pressed:text-foreground aria-pressed:shadow-sm"
            >{entry.label}</button>
          ))}
        </div>
      </div>
      <div className="min-h-0 flex-1">
        {view === "timeline" ? (
          <TimelineView channelId={channelId} refreshToken={treeToken} />
        ) : view === "factory" && factoryName ? (
          <FactoryView channelId={channelId} name={factoryName} now={now} />
        ) : (
          <Transcript
            channelId={channelId}
            threadKey={threadKey}
            draft={draft}
            refreshToken={transcriptToken}
            onLoaded={() => setDraft((previous) => (previous?.done ? undefined : previous))}
          />
        )}
      </div>
    </div>
  ) : <ActivityView refreshToken={treeToken} />;

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex h-full flex-col">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
          {!wide && (
            <Button variant="ghost" size="icon" aria-label="Open workspace tree" onClick={() => setTreeSheet(true)}><Menu /></Button>
          )}
          <Breadcrumb className="min-w-0 flex-1 overflow-hidden">
            <BreadcrumbList className="flex-nowrap sm:gap-2">
              <BreadcrumbItem><span className="hidden font-semibold text-foreground sm:inline">Console</span></BreadcrumbItem>
              {channelId && (
                <>
                  <BreadcrumbSeparator className="hidden sm:block" />
                  <BreadcrumbItem className="min-w-0">
                    {threadKey && threadKey !== "main" ? (
                      <a href={buildRoute({ channelId, tab: route.tab, view: route.view })} className="truncate hover:text-foreground">{title}</a>
                    ) : (
                      <BreadcrumbPage className="truncate">{title}</BreadcrumbPage>
                    )}
                    {treeChannel && <StateDot state={treeChannel.state} />}
                  </BreadcrumbItem>
                  {threadKey && threadKey !== "main" && (
                    <>
                      <BreadcrumbSeparator />
                      <BreadcrumbItem className="min-w-0"><BreadcrumbPage className="truncate">{threadLabel(threadKey, node?.label ?? threadKey)}</BreadcrumbPage></BreadcrumbItem>
                    </>
                  )}
                </>
              )}
            </BreadcrumbList>
          </Breadcrumb>
          {channel.data && <span className="hidden md:inline-flex"><StateBadge state={channel.data.state} /></span>}
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge variant="outline" data-testid="console-mode" className="hidden gap-1 sm:inline-flex"><Eye className="size-3" aria-hidden />{route.admin ? "Config admin" : tree.data?.actions ? "Can act" : "Monitoring"}</Badge>
            </TooltipTrigger>
            <TooltipContent>{route.admin ? "Full configuration administration, independent of factory action permissions. External access protection is required." : tree.data?.actions ? "The operator let this console edit channel lists and act on software factory runs (retry, answer, abort, start). Merge approval additionally requires run-scoped Slack approver verification; there is no direct merge action." : "Monitoring views only show what the harness is doing. The Admin page separately grants full configuration administration."}</TooltipContent>
          </Tooltip>
          <Button variant={channelId || route.admin ? "outline" : "secondary"} size="sm" onClick={() => setHash("#/")}>Activity</Button>
          <Button variant="outline" size="sm" aria-label="Admin configuration" onClick={() => setHash(route.admin ? "#/" : "#/admin")}>Admin</Button>
          <OfflineBadge />
          <Badge variant={shownConnection === "connected" ? "secondary" : "destructive"} className="shrink-0 gap-1.5" role="status" data-testid="connection">
            <span className={`size-1.5 rounded-full ${shownConnection === "connected" ? "bg-emerald-500" : "bg-current animate-pulse"}`} aria-hidden />
            <span className="sr-only sm:not-sr-only">{shownConnection === "connected" ? "Connected" : shownConnection === "connecting" ? "Connecting" : "Reconnecting"}</span>
          </Badge>
          <Button variant="outline" size="sm" className="hidden gap-2 text-muted-foreground sm:inline-flex" onClick={() => setPaletteOpen(true)} aria-label="Search channels and threads">
            <Search />Jump to…<kbd className="rounded border px-1 font-mono text-[10px]">⌘K</kbd>
          </Button>
                    {!wide && <Button variant="ghost" size="icon" aria-label="Open details panel" onClick={() => setPanelSheet(true)}><PanelRight /></Button>}
          <InstallButton />
          <Button variant="ghost" size="icon" aria-label={dark ? "Switch to light theme" : "Switch to dark theme"} onClick={toggle}>{dark ? <Sun /> : <Moon />}</Button>
        </header>
        {signedIn && (
          <div className="flex shrink-0 items-center gap-1.5 border-b bg-muted/30 px-3 py-1 text-xs text-muted-foreground" data-testid="signed-in-identity">
            <span className="shrink-0">Signed in as</span>
            <span className="truncate font-medium text-foreground" title={signedIn.email || signedIn.subject}>{signedIn.email || signedIn.subject}</span>
          </div>
        )}
        <OfflineBanner />

        <div className={route.admin ? "min-h-0 flex-1" : "hidden"}><ConfigAdmin active={route.admin === true} /></div>
        <div className={route.admin ? "hidden" : "min-h-0 flex-1"}>
          {wide ? (
            <div className="flex h-full">
              {collapsed && <TreeRail tree={tree.data} channelId={channelId} onSelect={navigate} onExpand={toggleCollapsed} />}
              {/* A different group when the tree is folded away, so the two remaining panels share the room it freed. */}
              <ResizablePanelGroup key={collapsed ? "rail" : "full"} orientation="horizontal" id={collapsed ? "console2-layout-rail" : "console2-layout"} className="min-w-0 flex-1">
                {!collapsed && (
                  <>
                    <ResizablePanel id="tree" defaultSize="20%" minSize="14%" maxSize="35%"><div id="workspace-panel" className="h-full">{treeNav(true)}</div></ResizablePanel>
                    <ResizableHandle withHandle aria-label="Resize workspace tree" />
                  </>
                )}
                {channelId && <>
                  <ResizablePanel id="panel" defaultSize={collapsed ? "35%" : "30%"} minSize="22%" maxSize="45%">{sidePanel}</ResizablePanel>
                  <ResizableHandle withHandle aria-label="Resize details panel" />
                </>}
                <ResizablePanel id="main" defaultSize={collapsed ? "65%" : "50%"} minSize="30%"><main className="h-full">{main}</main></ResizablePanel>
              </ResizablePanelGroup>
            </div>
          ) : (
            <main className="h-full">{main}</main>
          )}
        </div>
      </div>

      {!wide && (
        <>
          <Sheet open={treeSheet} onOpenChange={setTreeSheet}>
            <SheetContent side="left" className="p-0 pt-9">
              <SheetTitle className="sr-only">Workspace tree</SheetTitle>
              <SheetDescription className="sr-only">Channels and threads</SheetDescription>
              {treeNav(false)}
            </SheetContent>
          </Sheet>
          <Sheet open={panelSheet} onOpenChange={setPanelSheet}>
            <SheetContent side="right" className="p-0 pt-9">
              <SheetTitle className="sr-only">Details</SheetTitle>
              <SheetDescription className="sr-only">Session, state, tasks, tools and extensions</SheetDescription>
              {sidePanel}
            </SheetContent>
          </Sheet>
        </>
      )}

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} tree={tree.data} onSelect={navigate} onView={navigateView} />
    </TooltipProvider>
  );
}
