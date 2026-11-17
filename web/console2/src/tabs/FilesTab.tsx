import { FileText } from "lucide-react";
import { WorkspaceBrowser } from "@/components/WorkspaceBrowser";
import { api } from "@/lib/api";
import { formatBytes, relativeTime } from "@/lib/format";
import { useApi } from "@/lib/hooks";
import { Async, Empty, Notice, Section } from "@/components/common";

/** Read-only channel workspace browsing, followed by published artifact links. */
export function FilesTab({ channelId, refreshToken, now }: { channelId: string; refreshToken: number; now: number }) {
  const files = useApi((signal) => api.artifacts(channelId, signal), `artifacts\n${channelId}`, refreshToken);
  return (
    <div className="min-w-0 space-y-4">
    <WorkspaceBrowser key={channelId} channelId={channelId} refreshToken={refreshToken} />
    <Async result={files}>
      {(data) => (
        <div className="space-y-4">
          {!data.enabled ? (
            <Notice><span data-testid="files-disabled">{data.reason ?? "Artifact hosting is not enabled for this channel."}</span></Notice>
          ) : (
            <Section title="Artifacts" count={data.entries.length}>
              {data.entries.length === 0 ? (
                <Empty>No files have been published yet.</Empty>
              ) : (
                <ul className="divide-y rounded-md border" aria-label="Published files">
                  {data.entries.map((entry) => (
                    <li key={entry.path} data-testid="artifact" className="flex items-start gap-2 px-3 py-2 text-sm">
                      <FileText className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                      <div className="min-w-0 flex-1">
                        <a
                          href={entry.url} target="_blank" rel="noopener noreferrer"
                          className="break-all font-mono text-xs underline-offset-2 hover:underline"
                        >{entry.path}<span className="sr-only"> (opens in a new tab)</span></a>
                        <p className="text-[11px] text-muted-foreground">
                          <span className="tabular-nums">{formatBytes(entry.size)}</span> · <time dateTime={entry.modified} title={entry.modified}>{relativeTime(entry.modified, now)}</time>
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              {data.truncated && <Notice>The list stops at a fixed limit, so some files are not shown.</Notice>}
            </Section>
          )}
        </div>
      )}
    </Async>
    </div>
  );
}
