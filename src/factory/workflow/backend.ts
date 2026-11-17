import type { FactoryConfig } from "../../config/schema.ts";
import type { ResolvedChannel } from "../../workspace/resolve.ts";
import { channelPathEnv } from "../../agent/sandbox.ts";
import { createGitHub, ghRunner } from "./github.ts";
import { acliRunner, createJiraTracker } from "./jira.ts";
import { githubTracker } from "./tracker.ts";
import type { FactoryGitHub } from "./deps.ts";

/** Namespace tracker mappings, retaining old GitHub records when a factory switches trackers. */
export function scopedFactoryStore<T extends object>(store: T, factory: FactoryConfig | undefined): T {
  const prefix = factory?.intake?.source === "jira" && factory.jira ? `jira:${factory.jira.site}:` : "";
  const scoped = (repo: string) => !prefix || repo.startsWith(prefix) ? repo : `${prefix}${repo}`;
  return new Proxy(store, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      if (typeof value !== "function") return value;
      if (prop === "factoryIntake" || prop === "mutateFactoryIntake") return (repo: string, ...args: unknown[]) => value.call(target, scoped(repo), ...args);
      if (prop === "recordIntakeUpdates") return (input: { repo: string }) => value.call(target, { ...input, repo: scoped(input.repo) });
      if (prop === "listFactoryIntake") return async () => (await value.call(target)).filter((data: { repo: string }) => prefix ? data.repo.startsWith(prefix) : !data.repo.startsWith("jira:")).map((data: { repo: string }) => ({ ...data, repo: data.repo.slice(prefix.length) }));
      return value.bind(target);
    },
  });
}

/** Compatibility facade: existing services consume issue methods; PR methods always remain GitHub's. */
export function createFactoryBackend(channel: Pick<ResolvedChannel, "factory"> & Parameters<typeof channelPathEnv>[0], options: { ambiguous?: (id: number) => Promise<boolean> } = {}): FactoryGitHub {
  const github = createGitHub(ghRunner(channel.env));
  if (channel.factory?.intake?.source !== "jira") return { ...github, tracker: githubTracker(github) };
  const config = channel.factory.jira;
  if (!config) throw new Error("Jira tracker settings are missing");
  const tracker = createJiraTracker(config, acliRunner(channelPathEnv(channel)), options);
  return {
    ...github, tracker, source: tracker.source, labels: undefined,
    readIssue: tracker.readIssue, commentIssue: tracker.commentIssue,
    async createIssue() { throw new Error("File Jira work in Jira; mirrored GitHub issues are not supported"); },
  };
}
