import type { JobDefinitionView, SkillView } from "@api/api-types";
import { Badge } from "@/components/ui/badge";
import { api } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { Async, Empty, Section } from "@/components/common";
import { ConnectorRows } from "./ToolsTab";

const SOURCE_LABEL: Record<SkillView["source"], string> = { channel: "Channel skills", collection: "Collection skills", library: "Library skills", builtin: "Built-in skills" };

function JobDefinitions({ jobs }: { jobs: JobDefinitionView[] }) {
  return (
    <ul className="space-y-2" aria-label="Job definitions">
      {jobs.map((job) => (
        <li key={job.name} data-testid="job-definition" data-available={job.available} className="space-y-1.5 rounded-md border px-3 py-2 text-sm">
          <div className="flex items-start gap-2">
            <code className="min-w-0 flex-1 break-all font-mono text-sm font-medium">{job.name}</code>
            {!job.available && <Badge variant="destructive" data-testid="job-unavailable">Unavailable</Badge>}
          </div>
          {job.description && <p className="text-xs text-muted-foreground">{job.description}</p>}
          {!job.available && job.problem && <p className="break-words text-xs text-destructive" data-testid="job-problem">{job.problem}</p>}
          <p className="text-xs">
            <span className="text-muted-foreground">Inputs: </span>
            {job.inputs.length === 0 ? <span className="text-muted-foreground">none</span> : job.inputs.map((input, index) => (
              <span key={input.name}>{index > 0 ? ", " : ""}<code className="font-mono">{input.name}</code> <span className="text-muted-foreground">({input.required ? "required" : `default ${JSON.stringify(input.default ?? "")}`})</span></span>
            ))}
          </p>
          <ol className="flex flex-wrap items-center gap-x-1 gap-y-1 text-xs" aria-label={`Phases of ${job.name}`}>
            {job.phases.map((phase, index) => (
              <li key={`${index}-${phase.name}`} className="flex items-center gap-1">
                {index > 0 && <span aria-hidden className="text-muted-foreground">→</span>}
                <span className="rounded border bg-muted/40 px-1.5 py-0.5"><span className="break-all font-mono">{phase.name}</span> <span className="text-muted-foreground">{phase.kind}</span></span>
              </li>
            ))}
          </ol>
        </li>
      ))}
    </ul>
  );
}

export function ExtendTab({ channelId, refreshToken }: { channelId: string; refreshToken: number }) {
  const result = useApi((signal) => api.extend(channelId, signal), `extend\n${channelId}`, refreshToken);
  return (
    <Async result={result}>
      {(e) => (
        <div className="space-y-5">
          <Section title="Jobs" count={(e.jobs ?? []).length}>
            {(e.jobs ?? []).length === 0 ? <Empty>No jobs defined for this channel.</Empty> : <JobDefinitions jobs={e.jobs} />}
          </Section>
          {(["channel", "collection", "library", "builtin"] as const).map((source) => {
            const skills = e.skills.filter((skill) => skill.source === source);
            if (skills.length === 0) return null;
            return (
              <Section key={source} title={SOURCE_LABEL[source]} count={skills.length}>
                <ul className="flex flex-wrap gap-1.5">
                  {skills.map((skill) => (
                    <li key={`${skill.collection ?? ""}/${skill.name}`}>
                      <code className="rounded border bg-muted/40 px-1.5 py-0.5 font-mono text-xs" title={skill.collection ? `collection ${skill.collection} (${skill.mode})` : undefined}>{skill.name}</code>
                    </li>
                  ))}
                </ul>
              </Section>
            );
          })}
          {e.skills.length === 0 && <Section title="Skills"><Empty>No skills.</Empty></Section>}
          <Section title="Skill collections" count={e.collections.length}>
            {e.collections.length === 0 ? <Empty>No collections assigned.</Empty> : (
              <ul className="space-y-1.5">
                {e.collections.map((c) => (
                  <li key={c.name} className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
                    <span className="min-w-0 flex-1 truncate font-medium">{c.name}</span>
                    <span className="text-xs text-muted-foreground">{c.skills} skills</span>
                    <Badge variant={c.mode === "rw" ? "secondary" : "outline"}>{c.mode === "rw" ? "read-write" : "read-only"}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </Section>
          <Section title={`Subagents${e.agentSet ? ` · ${e.agentSet}` : ""}`} count={e.subagents.length}>
            {e.subagents.length === 0 ? <Empty>No subagents.</Empty> : (
              <ul className="space-y-1.5">
                {e.subagents.map((agent) => (
                  <li key={agent.name} className="rounded-md border px-3 py-2 text-sm">
                    <div className="flex items-center gap-2"><span className="min-w-0 flex-1 truncate font-medium">{agent.name}</span><span className="font-mono text-[11px] text-muted-foreground">{agent.model}</span></div>
                    {agent.description && <p className="text-xs text-muted-foreground">{agent.description}</p>}
                  </li>
                ))}
              </ul>
            )}
          </Section>
          <Section title="Knowledge bases" count={e.knowledgeBases.length}>
            {e.knowledgeBases.length === 0 && e.knowledgeFiles.length === 0 ? <Empty>No knowledge linked.</Empty> : (
              <ul className="flex flex-wrap gap-1.5">
                {e.knowledgeBases.map((kb) => <li key={`kb/${kb.name}`}><Badge variant="secondary">{kb.name}</Badge></li>)}
                {e.knowledgeFiles.map((file) => <li key={`f/${file.name}`}><Badge variant="outline">{file.name}</Badge></li>)}
              </ul>
            )}
          </Section>
          <Section title="Connectors" count={e.connectors.length}><ConnectorRows connectors={e.connectors} /></Section>
        </div>
      )}
    </Async>
  );
}
