import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChartTools } from "./chart-tools.ts";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "harness-chart-tool-"));
  const workspace = join(root, "workspace");
  const other = join(root, "other");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(other, { recursive: true });
  const [tool] = createChartTools({
    channelLabel: "#ops",
    jail: { readRoots: [workspace], writeRoots: [workspace], cwd: workspace },
    canUpload: true,
  });
  return { workspace, other, tool: tool as any };
}

test("create_chart writes a PNG chart in the workspace", async () => {
  const { workspace, tool } = setup();

  const result = await tool.execute("id", {
    chart_type: "bar",
    output_path: "charts/sales",
    title: "Sales",
    data: [
      { label: "Jan", value: 12 },
      { label: "Feb", value: 18 },
    ],
  });

  const path = join(workspace, "charts/sales.png");
  assert.equal(existsSync(path), true);
  const png = readFileSync(path);
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.match(result.content[0].text, /PNG chart/);
  assert.match(result.content[0].text, /Use upload_file/);
  assert.equal(result.details.mimeType, "image/png");
});

test("create_chart refuses paths outside the channel jail", async () => {
  const { other, tool } = setup();

  await assert.rejects(
    () => tool.execute("id", { chart_type: "bar", output_path: join(other, "chart.svg"), data: [{ label: "A", value: 1 }] }),
    /outside this channel's workspace/,
  );
});

test("create_chart refuses to overwrite an existing file", async () => {
  const { workspace, tool } = setup();
  writeFileSync(join(workspace, "chart.png"), "old");

  await assert.rejects(
    () => tool.execute("id", { chart_type: "bar", output_path: "chart.svg", data: [{ label: "A", value: 1 }] }),
    /already exists/,
  );
});

test("scatter charts require numeric x values", async () => {
  const { tool } = setup();

  await assert.rejects(
    () => tool.execute("id", { chart_type: "scatter", output_path: "scatter.svg", data: [{ x: "A", y: 1 }] }),
    /numeric `x`/,
  );
});
