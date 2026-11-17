import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

/**
 * Wrangler is baked into both runtime images from a locked package, not downloaded by an agent or fetched at runtime.
 * These pin the properties that matter: the version is exact and agrees everywhere, the install reuses the lockfile
 * and runs no dependency scripts, and both images carry it (the sandbox image also needs a Node to run it).
 */
const manifest = JSON.parse(read("scripts/wrangler/package.json")) as { dependencies: Record<string, string> };
const lock = JSON.parse(read("scripts/wrangler/package-lock.json")) as { packages: Record<string, { version?: string; integrity?: string; resolved?: string }> };
const version = manifest.dependencies.wrangler!;

test("wrangler is pinned to one exact version, and the lockfile agrees", () => {
  assert.match(version, /^\d+\.\d+\.\d+$/, "an exact version, never a range or a tag");
  assert.equal(lock.packages["node_modules/wrangler"]?.version, version);
  assert.deepEqual(Object.keys(manifest.dependencies), ["wrangler"], "nothing else is installed alongside it");
});

test("every package in the lockfile is verified by an integrity hash and comes from the npm registry", () => {
  const entries = Object.entries(lock.packages).filter(([name]) => name !== "");
  assert.ok(entries.length > 10);
  for (const [name, entry] of entries) {
    assert.match(entry.integrity ?? "", /^sha512-/, `${name} has an integrity hash`);
    assert.match(entry.resolved ?? "", /^https:\/\/registry\.npmjs\.org\//, `${name} resolves from the npm registry`);
  }
});

test("the smoke test asserts the same version the lockfile pins", () => {
  assert.match(read("scripts/smoke-harness-clis.sh"), new RegExp(`grep -Fx '${version.replaceAll(".", "\\.")}'`));
});

const escapedVersion = version.replaceAll(".", "\\.");
const lockedInstall = "npm ci --omit=dev --ignore-scripts --no-audit --no-fund";
const explicitInstall = `npm install --omit=dev --ignore-scripts --no-audit --no-fund wrangler@${version}`;

function assertSandboxInstall(dockerfile: string) {
  assert.match(dockerfile, new RegExp(`^RUN (?:${lockedInstall}|${explicitInstall.replaceAll(".", "\\.")})(?= &&|$)`, "m"),
    "reuse the lockfile with lifecycle scripts off; an explicit install must pin the manifest's exact version");
  assert.doesNotMatch(dockerfile, new RegExp(`npm (install|i) .*wrangler(?!@${escapedVersion}(?=\\s|$))|npx wrangler|wrangler@latest`),
    "never an unpinned or mismatched install");
}

for (const file of ["Dockerfile.harness", "Dockerfile.sandbox"]) {
  test(`${file} installs pinned wrangler using the lockfile with lifecycle scripts off, and puts it on PATH`, () => {
    const dockerfile = read(file);
    assert.match(dockerfile, /^FROM node:\$\{NODE_VERSION\}-bookworm-slim AS wrangler$/m);
    assert.match(dockerfile, /^COPY scripts\/wrangler\/package\.json scripts\/wrangler\/package-lock\.json \.\/$/m);
    if (file === "Dockerfile.sandbox") {
      assertSandboxInstall(dockerfile);
    } else {
      assert.match(dockerfile, /npm ci --omit=dev --ignore-scripts/, "reproducible, and no dependency script runs at build time");
      assert.doesNotMatch(dockerfile, /npm (install|i) .*wrangler|npx wrangler|wrangler@latest/, "never an unpinned install");
    }
    assert.match(dockerfile, /^COPY --from=wrangler \/opt\/wrangler \/opt\/wrangler$/m);
    assert.match(dockerfile, /ln -s \/opt\/wrangler\/node_modules\/\.bin\/wrangler \/usr\/local\/bin\/wrangler/);
    assert.match(dockerfile, /^ENV WRANGLER_SEND_METRICS=false$/m, "no telemetry from an agent's shell");
  });
}

test("the sandbox install contract accepts both locked ci and the explicit pinned install", () => {
  for (const command of [lockedInstall, explicitInstall]) {
    assertSandboxInstall(`RUN ${command} && npm cache clean --force`);
  }
});

test("the sandbox install contract rejects unsafe installs and comment-only matches", () => {
  for (const command of [
    explicitInstall.replace(`@${version}`, ""),
    explicitInstall.replace(`@${version}`, "@latest"),
    explicitInstall.replace(`@${version}`, `@^${version}`),
    explicitInstall.replace(`@${version}`, "@0.0.0"),
    explicitInstall.replace(`@${version}`, `@${version}0`),
    explicitInstall.replace(" --ignore-scripts", ""),
    explicitInstall.replace("--ignore-scripts", "--ignore-scripts=false"),
    explicitInstall.replace("npm install", "npm i"),
  ]) {
    assert.throws(() => assertSandboxInstall(`RUN ${command} && npm cache clean --force`), command);
  }
  assert.throws(() => assertSandboxInstall(`# RUN ${explicitInstall}`));
  assert.throws(() => assertSandboxInstall(`RUN ${lockedInstall}\nRUN npm install wrangler@latest`));
});

test("the sandbox image, which has no Node of its own, carries the node binary wrangler needs from the same pinned image", () => {
  const dockerfile = read("Dockerfile.sandbox");
  assert.match(dockerfile, /^COPY --from=wrangler \/usr\/local\/bin\/node \/usr\/local\/bin\/node$/m);
  const pin = (file: string) => /^ARG NODE_VERSION=(\S+)$/m.exec(read(file))?.[1];
  assert.equal(pin("Dockerfile.sandbox"), pin("Dockerfile.harness"), "both images use the same Node");
});

test("no credential is baked into either image", () => {
  for (const file of ["Dockerfile.harness", "Dockerfile.sandbox"]) {
    // Instructions only: a comment may say which variables the channel supplies, but no ENV/ARG/RUN may set one.
    const instructions = read(file).split("\n").filter((line) => !line.trim().startsWith("#")).join("\n");
    assert.doesNotMatch(instructions, /CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID|CLOUDFLARE_API_KEY/, file);
  }
});

test("the CI smoke job watches the files that decide what wrangler is installed", () => {
  const workflow = read(".github/workflows/bundled-clis.yml");
  assert.equal((workflow.match(/scripts\/wrangler\/package-lock\.json/g) ?? []).length, 2, "on pull requests and on pushes");
});

test("the deployer role uses wrangler through the shell, not a Cloudflare connector, and needs an approval", () => {
  const example = read("config/harness.example.yaml");
  const role = /      cloudflare_deployer:[\s\S]*?(?=\n\nchannels:)/.exec(example)?.[0] ?? "";
  assert.match(role, /tools: \[read, bash\]/);
  assert.match(role, /requireApproval: true/);
  assert.doesNotMatch(role, /connectors:/);
  assert.match(role, /wrangler/);
});
