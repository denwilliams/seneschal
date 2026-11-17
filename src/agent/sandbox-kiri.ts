import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { kiriCall, type DockerCall } from "./sandbox-runtime.ts";

const probe: DockerCall = (args) => execFileSync("kiri", args, {
  encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5_000,
});
const setup = "Install Kiri 0.2.1+ with its Docker CLI, expose kiri on the harness PATH, open Kiri once to finish setup, and start Kiri (or run kiri daemon). Verify kiri version and kiri info as the harness user; no Docker-context or host fallback is used.";

/** Verify the server's Kiri component, not Docker's compatibility version. */
export function kiriUnavailableReason(call: DockerCall = probe): string | undefined {
  try {
    const server = JSON.parse(call(["version", "--format", "{{json .Server}}"]));
    const component = Array.isArray(server?.Components) ? server.Components.find((c: { Name?: string }) => c?.Name === "Kiri") : undefined;
    const match = typeof component?.Version === "string" && /^(\d+)\.(\d+)\.(\d+)$/.exec(component.Version);
    if (match && (Number(match[1]) > 0 || Number(match[2]) > 2 || (Number(match[2]) === 2 && Number(match[3]) >= 1))) return undefined;
    return `Kiri server 0.2.1+ could not be verified. ${setup}`;
  } catch {
    return `Kiri runtime/CLI is unavailable or its version response is invalid. ${setup}`;
  }
}

const configs = new Map<string, { Labels?: Record<string, string>; Volumes?: Record<string, unknown> | null }>();

/** Kiri 0.2.1's image inspect omits Labels AND Volumes. Read the digest-bound
 * OCI config from its documented Docker save archive, not absence-as-empty.
 * No archive paths are extracted to the host filesystem.
 */
function savedConfig(id: string): string {
  const dir = mkdtempSync(join(tmpdir(), "harness-kiri-image-"));
  try {
    const archive = join(dir, "image.tar");
    kiriCall(["image", "save", "--output", archive, id]);
    return execFileSync("tar", ["-xOf", archive, `blobs/sha256/${id.slice(7)}`], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

export function inspectKiriImage(image: string, call: DockerCall = kiriCall, load = savedConfig) {
  const list = JSON.parse(call(["image", "inspect", image]));
  const id = Array.isArray(list) && list.length === 1 ? list[0]?.Id : undefined;
  if (typeof id !== "string" || !/^sha256:[0-9a-f]{64}$/.test(id)) throw new Error("Invalid Kiri image identity");
  let config = configs.get(id);
  if (!config) {
    const raw = load(id);
    if (`sha256:${createHash("sha256").update(raw).digest("hex")}` !== id) throw new Error("Kiri image config digest mismatch");
    config = JSON.parse(raw)?.config;
    if (!config || typeof config !== "object" || Array.isArray(config) ||
        (config.Labels !== undefined && config.Labels !== null && (typeof config.Labels !== "object" || Array.isArray(config.Labels) || Object.values(config.Labels).some((v) => typeof v !== "string"))) ||
        (config.Volumes !== undefined && config.Volumes !== null && (typeof config.Volumes !== "object" || Array.isArray(config.Volumes)))) throw new Error("Invalid Kiri image config");
    if (configs.size >= 100) configs.delete(configs.keys().next().value!);
    configs.set(id, config);
  }
  if (Object.keys(config.Volumes ?? {}).length) throw new Error("Sandbox images must not declare VOLUME: anonymous/external volumes would outlive container-local repos");
  return { id, labels: config.Labels ?? {} };
}
