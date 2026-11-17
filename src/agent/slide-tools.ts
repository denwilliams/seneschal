import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname } from "node:path";
import { marked, Renderer, type Tokens } from "marked";
import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { checkPath, type JailConfig } from "./jail.ts";

export interface SlideToolsContext {
  channelLabel: string;
  jail: JailConfig;
  canUpload?: boolean;
}

type Theme = "midnight" | "paper";

const MAX_SOURCE_CHARS = 200_000;
const MAX_SLIDES = 100;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 8 * 1024 * 1024;

const imageMimeTypes: Record<string, string> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

function defaultDeckPath(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `generated/deck-${stamp}.html`;
}

function ensureHtmlExtension(path: string): string {
  const ext = extname(path);
  return ext ? `${path.slice(0, -ext.length)}.html` : `${path}.html`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/`/g, "&#96;");
}

function splitSlides(markdown: string): string[] {
  const slides = markdown
    .replace(/\r\n/g, "\n")
    .split(/^---[ \t]*$/m)
    .map((slide) => slide.trim())
    .filter(Boolean);

  if (slides.length === 0) throw new Error("create_slide_deck needs Markdown content for at least one slide.");
  if (slides.length > MAX_SLIDES) throw new Error(`create_slide_deck accepts at most ${MAX_SLIDES} slides.`);
  return slides;
}

function safeLink(href: string, text: string, title: string | null): string {
  const value = href.trim();
  if (value.startsWith("#")) return `<a href="${escapeAttribute(value)}">${text}</a>`;
  if (!/^(https?:|mailto:)/i.test(value)) return text;
  const titleAttr = title ? ` title="${escapeAttribute(title)}"` : "";
  return `<a href="${escapeAttribute(value)}"${titleAttr} target="_blank" rel="noopener noreferrer">${text}</a>`;
}

function deckHtml(input: { title: string; theme: Theme; slides: string[] }): string {
  const themeClass = input.theme === "paper" ? "theme-paper" : "theme-midnight";
  const slideMarkup = input.slides
    .map((content, index) => `<section class="slide${index === 0 ? " is-active" : ""}" aria-hidden="${index === 0 ? "false" : "true"}" data-slide="${index}">${content}</section>`)
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>${escapeHtml(input.title)}</title>
<style>
:root { font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
* { box-sizing: border-box; }
body { margin: 0; overflow: hidden; background: #080b16; }
.deck { min-height: 100vh; min-height: 100dvh; }
.slide { display: none; min-height: 100vh; min-height: 100dvh; padding: clamp(2rem, 6vw, 7rem); place-content: center; gap: 1.25rem; }
.slide.is-active { display: grid; }
.theme-midnight .slide { color: #f8fafc; background: radial-gradient(circle at 85% 5%, #24356e, transparent 35%), linear-gradient(135deg, #10172f, #080b16 70%); }
.theme-paper .slide { color: #172033; background: radial-gradient(circle at 85% 5%, #d7e5ff, transparent 40%), #f7f8fb; }
h1 { font-size: clamp(2.65rem, 7vw, 7.5rem); line-height: .98; letter-spacing: -.065em; margin: 0; max-width: 15ch; }
h2 { font-size: clamp(2rem, 4.5vw, 5rem); line-height: 1.02; letter-spacing: -.05em; margin: 0; max-width: 18ch; }
h3 { font-size: clamp(1.35rem, 2.5vw, 2.5rem); margin: 0; }
p, li { font-size: clamp(1.15rem, 2vw, 2rem); line-height: 1.42; max-width: 54ch; }
p { margin: 0; }
ul, ol { margin: 0; padding-left: 1.25em; max-width: 55ch; display: grid; gap: .35em; }
blockquote { margin: 0; padding: .5em 0 .5em 1em; border-left: .2em solid #72a7ff; font-size: clamp(1.3rem, 2.5vw, 2.8rem); font-weight: 600; max-width: 35ch; }
pre { max-width: min(100%, 80ch); overflow: auto; padding: 1em; border-radius: .6em; background: #03071288; font-size: clamp(.8rem, 1.35vw, 1.3rem); }
code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
:not(pre) > code { padding: .1em .3em; border-radius: .25em; background: #64748b33; }
a { color: inherit; text-decoration-color: #72a7ff; text-underline-offset: .14em; }
img { max-width: min(100%, 1100px); max-height: 62vh; object-fit: contain; border-radius: .7rem; box-shadow: 0 18px 50px #0005; }
table { border-collapse: collapse; font-size: clamp(.9rem, 1.6vw, 1.5rem); }
th, td { padding: .5em .75em; border: 1px solid #94a3b855; text-align: left; }
.controls { position: fixed; right: 1.25rem; bottom: 1.25rem; display: flex; align-items: center; gap: .5rem; color: #fff; }
.controls button { color: inherit; border: 1px solid #ffffff55; border-radius: .45rem; padding: .45rem .7rem; background: #0f172acc; font: inherit; cursor: pointer; }
.controls button:focus-visible { outline: 3px solid #72a7ff; outline-offset: 2px; }
.counter { min-width: 4.5em; text-align: center; text-shadow: 0 1px 3px #000; }
@media print { body { overflow: visible; background: white; } .slide, .slide.is-active { display: grid; min-height: 100vh; break-after: page; } .controls { display: none; } }
</style>
</head>
<body class="${themeClass}">
<main class="deck" aria-label="${escapeAttribute(input.title)} presentation">
${slideMarkup}
</main>
<nav class="controls" aria-label="Presentation controls"><button type="button" data-action="previous" aria-label="Previous slide">←</button><span class="counter" aria-live="polite"></span><button type="button" data-action="next" aria-label="Next slide">→</button></nav>
<script>
(() => {
  const slides = [...document.querySelectorAll('.slide')];
  const counter = document.querySelector('.counter');
  let current = 0;
  const show = (next) => {
    current = Math.max(0, Math.min(next, slides.length - 1));
    slides.forEach((slide, index) => { const active = index === current; slide.classList.toggle('is-active', active); slide.setAttribute('aria-hidden', String(!active)); });
    counter.textContent = (current + 1) + ' / ' + slides.length;
    history.replaceState(null, '', '#slide-' + (current + 1));
  };
  document.querySelector('[data-action="previous"]').addEventListener('click', () => show(current - 1));
  document.querySelector('[data-action="next"]').addEventListener('click', () => show(current + 1));
  document.addEventListener('keydown', (event) => { if (['ArrowRight', 'ArrowDown', 'PageDown', ' '].includes(event.key)) { event.preventDefault(); show(current + 1); } if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(event.key)) { event.preventDefault(); show(current - 1); } if (event.key === 'Home') show(0); if (event.key === 'End') show(slides.length - 1); });
  const initial = /^#slide-(\\d+)$/.exec(location.hash); show(initial ? Number(initial[1]) - 1 : 0);
})();
</script>
</body>
</html>`;
}

export function createSlideTools(ctx: SlideToolsContext): ToolDefinition[] {
  const tool = defineTool({
    name: "create_slide_deck",
    label: "Create a slide deck",
    description:
      "Turn Markdown into a self-contained HTML slide deck without bash, network access, or a hosted presentation service. " +
      "Use a line containing only `---` to separate slides. Markdown is rendered safely: raw HTML is shown as text, only local PNG/JPEG/GIF/WebP Markdown images are embedded, and no remote assets are loaded." +
      (ctx.canUpload ? ` Use upload_file to attach the resulting HTML file in ${ctx.channelLabel}.` : ""),
    parameters: Type.Object({
      markdown: Type.String({ description: "Markdown source. A line containing only --- separates slides. Standard headings, lists, tables, quotes, code, links, and local Markdown images are supported." }),
      output_path: Type.Optional(Type.String({ description: "Where to write the HTML deck, relative to the workspace. Defaults to generated/deck-<timestamp>.html. Non-HTML extensions are changed to .html." })),
      title: Type.Optional(Type.String({ description: "Document title for the deck. Defaults to the first Markdown heading, or Presentation." })),
      theme: Type.Optional(Type.Union([Type.Literal("midnight"), Type.Literal("paper")], { description: "Visual theme. Defaults to midnight." })),
    }),
    execute: async (_id, params: { markdown: string; output_path?: string; title?: string; theme?: Theme }) => {
      if (params.markdown.length > MAX_SOURCE_CHARS) throw new Error(`Markdown is limited to ${MAX_SOURCE_CHARS.toLocaleString()} characters.`);
      const rawPath = ensureHtmlExtension(params.output_path?.trim() || defaultDeckPath());
      const decision = checkPath(ctx.jail, rawPath, "write");
      if (!decision.allowed) throw new Error(decision.reason ?? `${rawPath} is outside this channel's workspace.`);
      if (existsSync(decision.resolved)) throw new Error(`${rawPath} already exists. Pick a new output_path rather than overwriting it.`);

      const slides = splitSlides(params.markdown);
      const warnings: string[] = [];
      let embeddedBytes = 0;
      const renderImage = ({ href, title, text }: Tokens.Image): string => {
        const imagePath = href.trim();
        const imageDecision = checkPath(ctx.jail, imagePath, "read");
        const mimeType = imageMimeTypes[extname(imagePath).toLowerCase()];
        if (!imageDecision.allowed || !mimeType || /[?#]/.test(imagePath)) {
          warnings.push(`Skipped image \`${imagePath}\`: use a readable workspace PNG, JPEG, GIF, or WebP path without a query or fragment.`);
          return `<span class="image-note">${escapeHtml(text || "Image unavailable")}</span>`;
        }
        try {
          const stats = statSync(imageDecision.resolved);
          if (!stats.isFile() || stats.size > MAX_IMAGE_BYTES || embeddedBytes + stats.size > MAX_TOTAL_IMAGE_BYTES) {
            warnings.push(`Skipped image \`${imagePath}\`: images are limited to ${MAX_IMAGE_BYTES / 1024 / 1024} MiB each and ${MAX_TOTAL_IMAGE_BYTES / 1024 / 1024} MiB per deck.`);
            return `<span class="image-note">${escapeHtml(text || "Image unavailable")}</span>`;
          }
          const data = readFileSync(imageDecision.resolved).toString("base64");
          embeddedBytes += stats.size;
          return `<img src="data:${mimeType};base64,${data}" alt="${escapeAttribute(text)}"${title ? ` title="${escapeAttribute(title)}"` : ""}>`;
        } catch {
          warnings.push(`Skipped image \`${imagePath}\`: it could not be read.`);
          return `<span class="image-note">${escapeHtml(text || "Image unavailable")}</span>`;
        }
      };

      const renderer = new Renderer();
      renderer.html = ({ text }: Tokens.HTML | Tokens.Tag) => escapeHtml(text);
      renderer.image = renderImage;
      renderer.link = ({ href, title, text }: Tokens.Link) => safeLink(href, text, title ?? null);
      const renderedSlides = slides.map((slide) => marked.parse(slide, { async: false, gfm: true, breaks: true, renderer }));
      const heading = /^\s*#\s+(.+)$/m.exec(params.markdown)?.[1]?.replace(/[*_`]/g, "").trim();
      const title = params.title?.trim() || heading || "Presentation";
      const html = deckHtml({ title, theme: params.theme ?? "midnight", slides: renderedSlides });

      mkdirSync(dirname(decision.resolved), { recursive: true });
      writeFileSync(decision.resolved, html, "utf8");
      const warningText = warnings.length > 0 ? ` ${warnings.length} image${warnings.length === 1 ? " was" : "s were"} skipped; inspect the deck or use the supported local image paths.` : "";
      return {
        content: [{ type: "text" as const, text: `Created ${rawPath} (${slides.length} self-contained HTML slide${slides.length === 1 ? "" : "s"}).${warningText}${ctx.canUpload ? ` Use upload_file with path \`${rawPath}\` to attach it in ${ctx.channelLabel}.` : ""}` }],
        details: { path: rawPath, slides: slides.length, mimeType: "text/html", embeddedImageBytes: embeddedBytes, warnings },
      };
    },
  });

  return [tool] as ToolDefinition[];
}
