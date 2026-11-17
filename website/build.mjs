import { mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const root = fileURLToPath(new URL('.', import.meta.url));
export const escape = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const pages = ['index.html', 'features.html', 'getting-started.html'];

export function validateInventory(categories) {
  if (!Array.isArray(categories) || !categories.length) throw new Error('An inventory needs categories.');
  const ids = new Set(['main']);
  for (const category of categories) {
    for (const item of [category, ...category.features]) {
      if (!/^[a-z][a-z0-9-]*$/.test(item.id) || ids.has(item.id)) throw new Error(`Invalid or duplicate id: ${item.id}`);
      ids.add(item.id);
      if (!item.title?.trim()) throw new Error(`Missing title: ${item.id}`);
    }
    if (!category.intro?.trim() || !category.features.length) throw new Error(`Empty category: ${category.id}`);
    for (const feature of category.features) {
      if (!feature.description?.trim() || !feature.sources?.length) throw new Error(`Missing description/evidence: ${feature.id}`);
      if (feature.sources.some(s => typeof s !== 'string' || s.startsWith('/') || s.split('/').includes('..'))) throw new Error(`Invalid evidence path: ${feature.id}`);
    }
  }
}

export async function build() {
  const categories = JSON.parse(await readFile(new URL('features.json', import.meta.url)));
  validateInventory(categories);
  const count = categories.reduce((n, c) => n + c.features.length, 0);
  const nav = (current) => `<a class="skip" href="#main">Skip to content</a>
    <header class="site-header"><a class="brand" href="index.html" aria-label="Seneschal home"><span class="mark" aria-hidden="true">S</span> Seneschal<span class="brand-sub"> / for Slack</span></a>
    <nav aria-label="Main navigation">${[['index.html','Overview'],['features.html','Features'],['getting-started.html','Get started']].map(([url,label]) => `<a href="${url}" ${current === url ? 'aria-current="page"' : ''}>${label}</a>`).join('')}</nav></header>`;
  const layout = (page, title, description, body) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} · Seneschal</title><meta name="description" content="${escape(description)}">
<link rel="icon" href="icon.svg" type="image/svg+xml"><link rel="stylesheet" href="styles.css">
</head><body>${nav(page)}<main id="main" tabindex="-1">${body}</main>
<footer><a class="brand" href="index.html">Seneschal / for Slack</a><p>Self-hosted. Slack-first. Yours to configure.</p><p>An independent project built on <a href="https://pi.dev/">Pi</a>. Not affiliated with Slack. <a href="https://github.com/denwilliams/seneschal">Source on GitHub</a>.</p></footer></body></html>
`;
  const overview = `<section class="hero container"><div><p class="eyebrow"><span class="dot"></span> YOUR ASSISTANTS. YOUR INFRASTRUCTURE.</p>
    <h1>A home for your AI.<br><em>Not another inbox.</em></h1>
    <p class="lede">Give every Slack channel an assistant with its own memory, tools and skills. Let it do useful work — with boundaries you choose.</p>
    <div class="actions"><a class="button" href="features.html">Explore the features <span aria-hidden="true">↗</span></a><a class="text-link" href="getting-started.html">Make it yours <span aria-hidden="true">→</span></a></div>
    <p class="hero-note">For home networks and small teams. Runs on a Pi, in Docker, or on your own host.</p></div>
    <div class="channel-map" aria-label="Illustration: three separate channel assistants with explicitly shared skills">
      <div class="map-top"><span class="dot"></span> ONE HARNESS. DISTINCT CONTEXTS.</div>
      <div class="channel"><span class="channel-icon" aria-hidden="true">#</span><div><strong>engineering</strong><p>Ship a change. Review it independently.</p><div class="pills"><span>Code tools</span><span>Factory team</span></div></div><span class="node" aria-hidden="true"></span></div>
      <div class="channel"><span class="channel-icon" aria-hidden="true">#</span><div><strong>life-admin</strong><p>Keep the details. Remember to follow up.</p><div class="pills"><span>Memory</span><span>Schedules</span></div></div><span class="node" aria-hidden="true"></span></div>
      <div class="channel"><span class="channel-icon" aria-hidden="true">#</span><div><strong>operations</strong><p>Watch quietly. Speak when it matters.</p><div class="pills"><span>Connectors</span><span>Heartbeats</span></div></div><span class="node" aria-hidden="true"></span></div>
      <div class="map-bottom"><span aria-hidden="true">↳</span> Separate by default. Shared only by choice.</div>
      <p class="illustration-label">Illustrative channels, not a live workspace</p></div></section>
    <div class="principles"><div class="container"><p><strong>01 / Slack is the interface</strong><span>No new inbox to check.</span></p><p><strong>02 / Context stays local</strong><span>Each channel has its own world.</span></p><p><strong>03 / Access is explicit</strong><span>A connector isn’t a permission.</span></p></div></div>
    <section class="container section"><div class="section-heading"><div><p class="eyebrow">A SMALL SYSTEM. A BROAD TOOLBOX.</p><h2>From a conversation<br>to work that’s done.</h2></div><p>Start with one useful assistant. Add research, routines or a whole engineering team when you need them.</p></div>
    <div class="category-grid">${categories.map((c,i) => `<a class="category-card" href="features.html#${c.id}"><span class="card-number">0${i+1} / ${c.features.length} capabilities</span><h3>${escape(c.title)}</h3><p>${escape(c.intro)}</p><span class="card-arrow" aria-hidden="true">↗</span></a>`).join('')}</div></section>
    <section class="container section"><div class="work-band"><p class="eyebrow">AUTOMATION, WITHOUT HANDING OVER THE KEYS</p><h2>Let the team do the legwork.<br>Keep the decisions that matter.</h2><p>The software factory takes an issue through coding and independent review. Risk rules, required checks and commit-bound approvals control what can merge.</p><ol class="pipeline"><li>Triage</li><li>Implement</li><li>Review</li><li>Merge gate</li><li>Approved deploy</li></ol><a class="text-link" href="features.html#factory">Meet the software factory <span aria-hidden="true">→</span></a></div></section>
    <section class="container closing"><p class="eyebrow">NOT A HOSTED CHAT SERVICE</p><h2>Your setup is the product.</h2><p>Bring a Slack app and model credentials. Choose the channels, tools and sharing rules. Keep your data on infrastructure you operate.</p><a class="button" href="getting-started.html">Read the setup guide <span aria-hidden="true">→</span></a></section>`;
  const features = `<section class="container page-intro"><p class="eyebrow">THE CAPABILITY DIRECTORY</p><h1>What can it do?</h1><p class="lede">${count} implemented capabilities, grouped by the work they help with. Many are opt-in: enabled tools, credentials and channel policies decide what an assistant can actually use.</p></section>
    <div class="container feature-layout"><aside class="feature-nav"><nav aria-label="Feature categories"><p class="eyebrow">EXPLORE BY AREA</p>${categories.map(c => `<a href="#${c.id}">${escape(c.title)}</a>`).join('')}</nav><p class="aside-note">Available does not mean enabled.<br>Start with least privilege.</p></aside>
    <div class="feature-sections">${categories.map((c,i) => `<section class="feature-group" id="${c.id}" aria-labelledby="${c.id}-title"><p class="eyebrow">0${i+1} / ${c.features.length} CAPABILITIES</p><h2 id="${c.id}-title">${escape(c.title)}</h2><p class="group-intro">${escape(c.intro)}</p><div class="feature-cards">${c.features.map(f => `<article class="feature-card" id="${f.id}"><h3>${escape(f.title)}</h3><p>${escape(f.description)}</p></article>`).join('')}</div><a class="back-top" href="#main">Back to top ↑</a></section>`).join('')}</div></div>
    <section class="container closing"><h2>Built, not promised.</h2><p>This directory describes implemented behavior, not a roadmap. It does not promise every third-party service is configured. The operator console and its data remain private to your installation.</p><a class="button" href="getting-started.html">Plan your setup →</a></section>`;
  const started = `<section class="container page-intro"><p class="eyebrow">A SMALL, SELF-HOSTED SYSTEM</p><h1>Make room for<br><em>a useful assistant.</em></h1><p class="lede">Start with one channel and the minimum access it needs. Expand only when there’s work for it to do.</p></section>
    <div class="container setup-layout"><aside class="setup-summary"><h2>Bring these</h2><ul><li>A Slack workspace and a Slack app you can configure</li><li>Model API credentials or a supported OAuth login</li><li>Docker, or Node 22.19+ (current Node LTS recommended)</li><li>A checkout of <a href="https://github.com/denwilliams/seneschal">the source repository</a></li></ul><p>Seneschal is open source and self-hosted. There is no hosted signup.</p></aside>
    <div class="steps"><section><p class="eyebrow">01 / CONNECT</p><h2>Set up Slack & a model</h2><p>From your checkout, follow the README and copy the example environment and configuration files. Create the Slack app, enable Socket Mode, and install it with the scopes needed for your chosen features. Keep tokens out of source control.</p><pre><code>cp .env.example .env
cp config/harness.example.yaml config/harness.yaml</code></pre><p>Fill in Slack and provider credentials locally. A basic Slack-first installation uses outbound connections; it needs no public inbound listener.</p></section>
    <section><p class="eyebrow">02 / RUN</p><h2>Choose your host</h2><p>Docker Compose is a good starting point, including on a Raspberry Pi. From the configured checkout:</p><pre><code>docker compose up -d</code></pre><p>For a native Node installation:</p><pre><code>npm ci
npm run login  # or configure a provider API key
npm run doctor
npm start</code></pre><p>Review doctor’s results and the example configuration before enabling extra tools. Native macOS installations also support Keychain secrets and, on supported systems, Apple Containers. For Kiri sandboxes, opt in with sandbox.mode: kiri, install Kiri 0.2.1+ with its CLI and host tar, and run the documented host smoke test before use.</p></section>
    <section><p class="eyebrow">03 / SCOPE</p><h2>Give one channel a job</h2><p>Invite the bot, mention it in a thread, and set a clear purpose. Choose its model, allowed users and tools. Add only the connectors it needs. Memory, files and skills stay channel-local unless you explicitly share them.</p><p>Try a small research task, teach it a repeatable procedure, or schedule a follow-up. Monitoring, posting as a person and software-factory automation each have their own opt-in setup.</p><a class="text-link" href="features.html">Choose capabilities →</a></section>
    <section><p class="eyebrow">04 / OPERATE</p><h2>Protect & maintain it</h2><p>The optional operator console is not this website. It can expose sensitive configuration and operational data and has no built-in login by default. Bind it locally and protect access with an authenticated proxy/private network, or enable server-side Cloudflare Access validation. A tunnel alone is not authentication.</p><p>Keep the factory MCP endpoint separately authenticated. Do not put credentials, private documents or transcripts in served artifacts. Configure backups and follow the supported backup procedure; do not copy a live conversation store while the harness is running.</p><p>This is designed for a trusted single-owner or small-team environment, not hostile multi-tenancy. Host-mode bash can reach whatever the harness process can reach.</p></section></div></div>
    <section class="container closing"><h2>Start small. Keep it legible.</h2><p>Models, connectors and browser tools have their own costs and access policies. Use the console’s recorded usage and schedule history to understand what your assistants actually do.</p><a class="button" href="features.html#control">Understand the boundaries →</a></section>`;
  const output = resolve(root, 'dist');
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  for (const [page, title, description, content] of [
    ['index.html', 'AI assistants that belong in your channels', 'Seneschal is a self-hosted Slack AI harness with per-channel memory, tools, schedules and agent teams. Explicit sharing and permission boundaries.', overview],
    ['features.html', 'Features', 'Explore the implemented capabilities: Slack conversations, memory, skills, research, automation, software factory, operator console and security controls.', features],
    ['getting-started.html', 'Get started', 'Plan a small self-hosted Slack AI installation. Learn the prerequisites, setup steps, permission boundaries and operational safeguards.', started],
  ]) await writeFile(resolve(output, page), layout(page, title, description, content));
  // Explicit public allowlist: never recursively copy the repository or runtime data.
  for (const file of ['styles.css', 'icon.svg', '.nojekyll']) await copyFile(resolve(root, file), resolve(output, file));
  return { output, categories, count };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { count } = await build();
  console.log(`Built 3 pages covering ${count} capabilities in website/dist (static, no runtime dependencies).`);
}
