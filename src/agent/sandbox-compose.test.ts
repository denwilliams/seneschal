import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";

const compose = parse(readFileSync(new URL("../../docker-compose.sandbox.yml", import.meta.url), "utf8")) as {
  services: { harness: { environment: Record<string, string>; volumes: Array<{ source: string; target: string }> } };
};
const dockerfile = readFileSync(new URL("../../Dockerfile.harness", import.meta.url), "utf8");
const entrypoint = readFileSync(
  new URL("../../scripts/docker-harness-entrypoint.sh", import.meta.url),
  "utf8",
);

test("the opt-in Compose backend maps host data and only gives the harness the Docker socket", () => {
  const harness = compose.services.harness;
  assert.match(harness.environment.HARNESS_DOCKER_DATA_DIR ?? "", /HARNESS_DOCKER_DATA_DIR/);
  assert.deepEqual(
    harness.volumes.map((volume) => volume.target),
    ["/app/data", "/var/run/docker.sock"],
  );
  assert.match(harness.volumes[0]!.source, /HARNESS_DOCKER_DATA_DIR/);
  assert.equal(harness.volumes[1]!.source, "/var/run/docker.sock");
});

test("the runtime ships a Docker client then drops socket access to node", () => {
  assert.match(dockerfile, /docker-ce-cli/);
  assert.match(dockerfile, /ENTRYPOINT \["\/usr\/local\/bin\/docker-harness-entrypoint"\]/);
  assert.match(entrypoint, /stat -c '%g' \/var\/run\/docker\.sock/);
  assert.match(entrypoint, /--reuid=node --regid=node/);
});
