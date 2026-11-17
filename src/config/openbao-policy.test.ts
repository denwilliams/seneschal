import assert from "node:assert/strict";
import { test } from "node:test";
import { HarnessConfigSchema } from "./schema.ts";
import { OpenBaoSchema } from "./openbao-schema.ts";
import { openBaoIsolationIssues, openBaoRiskWarning } from "./openbao-policy.ts";
import { checkEdits } from "./edit-policy.ts";
import { openBaoWriter, ScopedSecretAdmin } from "./scoped-secrets.ts";

const openbao = { address: "https://bao.example.test", tokenFile: "/private/runtime-token" };

test("OpenBao risk acceptance defaults false and requires an operator-managed literal boolean", () => {
  assert.equal(OpenBaoSchema.parse(openbao).acceptHostExecutionRisk, false);
  for (const value of ["true", "false", 1, null]) {
    assert.equal(OpenBaoSchema.safeParse({ ...openbao, acceptHostExecutionRisk: value }).success, false);
  }
  for (const privileged of [false, true]) {
    const errors = checkEdits([{ path: ["openbao", "acceptHostExecutionRisk"], value: true }], {
      before: {}, after: { openbao: { acceptHostExecutionRisk: true } }, protectedChannels: new Set(), privileged,
    });
    assert.match(errors.join(" "), /openbao.*edited on the host/);
  }
});

test("OpenBao strict and accepted config guards cover inherited/default/channel host routes", () => {
  for (const mode of ["host", "docker", "macos-container", "kiri"]) {
    for (const settings of [{ tools: ["bash"] }, { tools: ["exec"] }, { share: { sharedTools: { planted: {} } } }]) {
      for (const location of ["defaults", "channel", "inherited"]) {
        for (const acceptHostExecutionRisk of [undefined, false, true]) {
          const config = {
            openbao: { ...openbao, acceptHostExecutionRisk },
            defaults: { sandbox: { mode }, ...(location !== "channel" ? settings : {}) },
            channels: location === "defaults" ? {} : { C1: location === "channel" ? settings : {} },
          };
          const result = HarnessConfigSchema.safeParse(config);
          const containerBash = "tools" in settings && settings.tools?.includes("bash") && mode !== "host";
          assert.equal(result.success, acceptHostExecutionRisk === true || containerBash, JSON.stringify(config));
          if (result.success) assert.deepEqual(openBaoIsolationIssues(result.data), []);
          else assert.match(result.error.message, /OpenBao.*Strict mode.*openbao.acceptHostExecutionRisk: true/);
        }
      }
    }
  }
});

test("neither backend's acceptance weakens the other's unaccepted config protection", () => {
  for (const settings of [{ tools: ["bash"] }, { tools: ["exec"] }, { share: { sharedTools: { planted: {} } } }]) {
    for (const baoRisk of [false, true]) for (const keychainRisk of [false, true]) {
      const result = HarnessConfigSchema.safeParse({
        openbao: { ...openbao, acceptHostExecutionRisk: baoRisk },
        keychain: { helperPath: "/private/helper", acceptHostExecutionRisk: keychainRisk },
        defaults: { sandbox: { mode: "host" }, ...settings },
      });
      assert.equal(result.success, baoRisk && keychainRisk);
      if (!result.success) {
        const paths = result.error.issues.map((issue) => issue.path[0]);
        assert.equal(paths.includes("openbao"), !baoRisk);
        assert.equal(paths.includes("keychain"), !keychainRisk);
      }
    }
  }
});

test("Admin reports accepted risk independently of provisioning availability and follows config changes", () => {
  let current = OpenBaoSchema.parse(openbao);
  const admin = new ScopedSecretAdmin([openBaoWriter(() => current, [])], () => []);
  assert.equal(openBaoRiskWarning({}), undefined);
  assert.equal(admin.snapshot().backends[0]!.warning, undefined);
  current.acceptHostExecutionRisk = true;
  let backend = admin.snapshot().backends[0]!;
  assert.equal(backend.enabled, false);
  assert.match(backend.unavailableReason!, /provisioning-token file/);
  assert.match(backend.warning!, /risk accepted.*token file or process memory.*backend secrets outside configured channel scopes/);
  assert.match(backend.warning!, /Container channels do not isolate their secrets.*not an OS-enforced boundary/);
  current.adminTokenFile = "/private/admin-token";
  backend = admin.snapshot().backends[0]!;
  assert.equal(backend.enabled, true);
  assert.equal(backend.unavailableReason, undefined);
  assert.ok(backend.warning);
  current.acceptHostExecutionRisk = false;
  assert.equal(admin.snapshot().backends[0]!.warning, undefined);
  assert.equal(admin.snapshot().backends[0]!.enabled, true);
});
