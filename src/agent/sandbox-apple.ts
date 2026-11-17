import { existsSync } from "node:fs";
import { release } from "node:os";
import type { SandboxConfig } from "../config/schema.ts";
import { appleCall, type DockerCall } from "./sandbox-runtime.ts";

/** No runtime equivalent of Docker's cgroup pids limit; require explicit opt-out.
 * A read-only trusted image keeps the setpriv launcher and its loader immutable.
 */
export function appleConfigProblem(config: SandboxConfig, env: Record<string, string> = {}): string | undefined {
  if (config.pidsLimit !== null) return "Apple container cannot enforce pidsLimit; explicitly set sandbox.pidsLimit: null to accept no PID limit, or use Docker";
  if (!config.readOnlyRoot) return "Apple container requires sandbox.readOnlyRoot: true to protect the no-new-privileges launcher";
  if (!Number.isInteger(config.cpus)) return "Apple container requires a whole number of sandbox.cpus (VM CPUs, not a Docker CPU quota)";
  if (Object.keys(env).some((key) => key.startsWith("LD_"))) return "Apple container cannot forward LD_* environment variables: they could bypass the no-new-privileges launcher";
  return undefined;
}

export function appleHostProblem(platform = process.platform, arch = process.arch, osRelease = release(), inDocker = existsSync("/.dockerenv")): string | undefined {
  if (platform !== "darwin" || arch !== "arm64" || Number(osRelease.split(".")[0]) < 25 || inDocker) {
    return "Apple container requires a native Apple Silicon Mac running macOS 26 or newer; remote runtimes and Compose are not supported";
  }
  return undefined;
}

export function appleAvailable(call: DockerCall = appleCall): boolean {
  try {
    const status = JSON.parse(call(["system", "status", "--format", "json"])) as {
      status: string; client?: { version: string }; server?: { version: string };
    };
    // These JSON schemas and capabilities were checked against 1.6.1. Unknown
    // major versions fail closed instead of guessing about isolation semantics.
    const compatible = (version?: string) => {
      const match = /^v?1\.(\d+)\.(\d+)$/.exec(version ?? "");
      return !!match && (Number(match[1]) > 6 || (Number(match[1]) === 6 && Number(match[2]) >= 1));
    };
    return status.status === "running" && compatible(status.client?.version) && compatible(status.server?.version);
  } catch { return false; }
}

interface AppleImage {
  configuration: { name: string; descriptor: { digest: string } };
  variants: { platform: { os: string; architecture: string }; config: {
    config?: { Labels?: Record<string, string>; Env?: string[]; Volumes?: Record<string, unknown> };
  } }[];
}

/** Parse the supported native image only, never recursively accept unrelated labels. */
export function inspectAppleImage(image: string, call: DockerCall = appleCall): {
  reference: string; labels: Record<string, string>;
} {
  const info = (JSON.parse(call(["image", "inspect", image])) as AppleImage[])[0];
  const digest = info?.configuration?.descriptor?.digest;
  const name = info?.configuration?.name;
  const variant = info?.variants?.find((v) => v.platform?.os === "linux" && v.platform.architecture === "arm64");
  if (!name || !/^sha256:[a-f0-9]{64}$/.test(digest ?? "") || !variant?.config?.config) {
    throw new Error("Invalid Apple image inspection or missing linux/arm64 image (requires container 1.6.1 or compatible)");
  }
  const config = variant.config.config;
  if (config.Env?.some((value) => value.split("=", 1)[0]?.startsWith("LD_"))) {
    throw new Error("Apple sandbox images must not configure LD_* environment variables: they could bypass setpriv");
  }
  // Apple 1.6.1 ignores image VOLUME declarations, rather than provisioning
  // Docker anonymous volumes. Still refuse them if a newer CLI reports them.
  if (Object.keys(config.Volumes ?? {}).length) throw new Error("Sandbox images must not declare VOLUME");
  return { reference: `${name.split("@")[0]!.replace(/:[^/:]+$/, "")}@${digest}`, labels: config.Labels ?? {} };
}

/** Apple's local lookup is by reference, not bare digest. Register a local
 * digest-qualified alias before run, then inspect it to catch a retag/build
 * racing between source inspection and tag. Never pull a local build remotely.
 */
export function pinAppleImage(image: string, call: DockerCall = appleCall): string {
  const expected = inspectAppleImage(image, call).reference;
  try {
    const pinned = inspectAppleImage(expected, call).reference;
    if (pinned !== expected) throw new Error("Apple image digest alias does not match its content");
  } catch (err) {
    if (!/image not found:/i.test(String(err))) throw err;
    call(["image", "tag", image, expected]);
    if (inspectAppleImage(expected, call).reference !== expected) {
      throw new Error("Apple image changed while creating its digest alias; retry after image builds finish");
    }
  }
  return expected;
}

/** Every Apple init/exec is launched through immutable util-linux setpriv.
 * This is not optional: absent/unsupported setpriv exits before agent code.
 */
export const APPLE_LAUNCHER = ["/usr/bin/setpriv", "--no-new-privs", "--"];
