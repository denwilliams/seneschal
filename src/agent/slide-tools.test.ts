import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createSlideTools } from "./slide-tools.ts";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "harness-slide-tool-"));
  const workspace = join(root, "workspace");
  const other = join(root, "other");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(other, { recursive: true });
  const [tool] = createSlideTools({
    channelLabel: "#admin",
    jail: { readRoots: [workspace], writeRoots: [workspace], cwd: workspace },
    canUpload: true,
  });
  return { workspace, other, tool: tool as any };
}

test("create_slide_deck writes a self-contained keyboard-navigable HTML presentation", async () => {
  const { workspace, tool } = setup();
  const result = await tool.execute("id", {
    output_path: "decks/q3.md",
    markdown: "# Q3 plan\n\n- Improve reliability\n\n---\n\n## Next steps\n\nShip the dashboard.",
    theme: "paper",
  });

  const path = join(workspace, "decks/q3.html");
  assert.equal(existsSync(path), true);
  const html = readFileSync(path, "utf8");
  assert.match(html, /<title>Q3 plan<\/title>/);
  assert.match(html, /class="slide is-active"/);
  assert.match(html, /data-slide="1"/);
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /ArrowRight/);
  assert.match(html, /theme-paper/);
  assert.match(result.content[0].text, /2 self-contained HTML slides/);
  assert.match(result.content[0].text, /upload_file/);
  assert.equal(result.details.mimeType, "text/html");
});

test("create_slide_deck escapes raw HTML and blocks unsafe links", async () => {
  const { workspace, tool } = setup();
  await tool.execute("id", {
    output_path: "safe.html",
    markdown: "# Safety\n\n<script>alert('no')</script>\n\n[unsafe](javascript:alert(1))\n\n[good](https://example.com)",
  });

  const html = readFileSync(join(workspace, "safe.html"), "utf8");
  assert.match(html, /&lt;script&gt;alert\(&#39;no&#39;\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /href="javascript:/i);
  assert.match(html, /href="https:\/\/example.com"[^>]*rel="noopener noreferrer"/);
});

test("create_slide_deck embeds supported workspace images as data URLs", async () => {
  const { workspace, tool } = setup();
  mkdirSync(join(workspace, "images"));
  writeFileSync(join(workspace, "images", "dot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  const result = await tool.execute("id", {
    output_path: "with-image.html",
    markdown: "# With image\n\n![A dot](images/dot.png)",
  });

  const html = readFileSync(join(workspace, "with-image.html"), "utf8");
  assert.match(html, /src="data:image\/png;base64,iVBORw==" alt="A dot"/);
  assert.equal(result.details.embeddedImageBytes, 4);
});

test("create_slide_deck refuses output outside the channel jail and does not overwrite", async () => {
  const { workspace, other, tool } = setup();
  await assert.rejects(
    () => tool.execute("id", { output_path: join(other, "deck.html"), markdown: "# no" }),
    /outside this channel's workspace/,
  );
  writeFileSync(join(workspace, "exists.html"), "old");
  await assert.rejects(
    () => tool.execute("id", { output_path: "exists.md", markdown: "# no" }),
    /already exists/,
  );
});
