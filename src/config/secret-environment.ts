import type { HarnessConfig } from "./schema.ts";
import { bootstrapName } from "./openbao-schema.ts";
import { openBaoChannelEnvironment } from "./openbao.ts";
import { keychainChannelEnvironment } from "./keychain.ts";

/** Shared by runtime and doctor. Filter legacy names before adding explicitly visible imports.
 * When both backends are configured, Keychain overrides OpenBao; neither failure falls back.
 * Filtering one backend must never remove a value explicitly imported from the other.
 */
export function scopedChannelEnvironment(config: HarnessConfig, channel: string, legacy: Record<string, string>, dataDir: string): Record<string, string> {
  if (!config.openbao && !config.keychain) return legacy;
  const hidden = new Set([
    ...(config.openbao?.mainProcess ?? []),
    ...(config.openbao?.globalChannel ?? []),
    ...Object.values(config.openbao?.channels ?? {}).flat(),
    ...(config.keychain?.mainProcess ?? []),
    ...(config.keychain?.globalChannel ?? []),
    ...Object.values(config.keychain?.channels ?? {}).flat(),
  ]);
  const clean = Object.fromEntries(Object.entries(legacy).filter(([name]) => !hidden.has(name) && !(config.openbao && bootstrapName(name))));
  return { ...clean, ...openBaoChannelEnvironment(config, channel, {}), ...keychainChannelEnvironment(config, channel, {}, dataDir) };
}
