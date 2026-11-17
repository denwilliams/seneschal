import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import ts from "typescript";

test("console wire contract compiles with no other harness sources, as copied by Dockerfile.harness", (t) => {
  const root = mkdtempSync(join(tmpdir(), "console2-contract-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const contract = join(root, "api-types.ts");
  copyFileSync(new URL("./api-types.ts", import.meta.url), contract);
  const program = ts.createProgram([contract], {
    strict: true, noEmit: true, skipLibCheck: true, types: [],
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.deepEqual(diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")), []);
});
