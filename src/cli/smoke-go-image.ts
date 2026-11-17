// CI integration smoke: enter both actual Docker agent command paths, not a
// hand-written bash wrapper. Does not start the harness or use credentials.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { SandboxSchema } from "../config/schema.ts";
import { buildCreateArgs, buildExecArgs, buildRunArgs, type DockerSandboxOptions } from "../agent/sandbox.ts";

export const goAgentSmokeCommand = `set -eu
[ "$GOTOOLCHAIN" = local ]
case "$PATH" in /workspace/bin:*) ;; *) echo 'Workspace bin must remain first' >&2; exit 1 ;; esac
[ "$(harness-go-path-marker)" = workspace-bin-first ]
# No PATH repair or GOROOT override here: exercise the final image login shell.
command -v go
command -v gofmt
/bin/sh /workspace/smoke-go.sh`;

export function smokeGoImage(image: string, user: string): void {
  if (!image || !user) throw new Error("Usage: smoke-go-image <image> <non-root-user>");
  const dataDir = mkdtempSync(join(tmpdir(), "go-image-smoke-"));
  const workspace = join(dataDir, "workspace");
  const reusable = `go-smoke-reused-${randomUUID()}`;
  const throwaway = `go-smoke-throwaway-${randomUUID()}`;
  function docker(args: string[]) {
    const result = spawnSync("docker", args, { stdio: "inherit", timeout: 300_000 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Docker smoke failed (${result.status ?? result.signal}): ${args[0]}`);
  }
  try {
    chmodSync(dataDir, 0o755);
    mkdirSync(workspace, { mode: 0o777 });
    chmodSync(workspace, 0o777);
    mkdirSync(join(workspace, "bin"));
    writeFileSync(join(workspace, "bin/harness-go-path-marker"), "#!/bin/sh\nprintf 'workspace-bin-first\\n'\n", { mode: 0o755 });
    copyFileSync(resolve(import.meta.dirname, "../../scripts/smoke-go.sh"), join(workspace, "smoke-go.sh"));
    const opts: DockerSandboxOptions = {
      config: SandboxSchema.parse({ mode: "docker", image, user, network: "none", memory: "1g", cpus: 2 }),
      workspace, dataDir, dockerDataDir: dataDir, env: {}, channelId: "go-smoke", threadKey: randomUUID(),
    };
    console.log("Go agent smoke: reused container via buildCreateArgs/buildExecArgs");
    docker(buildCreateArgs(opts, reusable));
    docker(buildExecArgs(opts, reusable, goAgentSmokeCommand));
    console.log("Go agent smoke: throwaway container via buildRunArgs");
    docker(buildRunArgs(opts, throwaway, goAgentSmokeCommand));
  } finally {
    spawnSync("docker", ["rm", "-f", reusable, throwaway], { stdio: "ignore", timeout: 30_000 });
    rmSync(dataDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  smokeGoImage(process.argv[2] ?? "", process.argv[3] ?? "");
}
