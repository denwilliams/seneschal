import { factoryApiResponse, loadFactory } from "./data.ts";
import type { ChannelRecord } from "../workspace/registry.ts";
import type { FactoryResponse } from "./api-types.ts";
import type { Console2Source } from "./source.ts";

/**
 * A software-factory channel's live, read-only GitHub view. Repositories come from reviewed channel config, never the request;
 * the result is cached briefly and shared between viewers, and a manual refresh is rate limited (all of that is `loadFactory`).
 * Undefined for a channel that is not a factory.
 */
export async function buildFactory(source: Console2Source, channel: ChannelRecord, refresh: boolean): Promise<FactoryResponse | undefined> {
  const resolved = source.resolve(channel);
  if (!resolved?.factory) return undefined;
  return factoryApiResponse(await loadFactory(source, resolved, { refresh })) as FactoryResponse;
}
