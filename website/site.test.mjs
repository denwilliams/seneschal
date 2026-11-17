import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build, escape, pages, root, validateInventory } from './build.mjs';

const { output, categories, count } = await build();
const html = new Map(await Promise.all(pages.map(async page => [page, await readFile(resolve(output, page), 'utf8')])));

test('inventory has implementation evidence, never design-plan-only evidence', async () => {
  assert.equal(count, categories.flatMap(c => c.features).length);
  assert.ok(count >= 40);
  for (const category of categories) for (const feature of category.features) {
    assert.ok(feature.sources.some(s => !/DESIGN|PLAN|TODO/.test(s)), feature.id);
    for (const source of feature.sources) assert.ok(await stat(resolve(root, '..', source)), `${feature.id}: ${source}`);
  }
});

test('reject duplicate IDs, empty descriptions and path traversal in evidence', () => {
  const duplicate = structuredClone(categories); duplicate[0].features[0].id = duplicate[0].id;
  assert.throws(() => validateInventory(duplicate), /duplicate/);
  const empty = structuredClone(categories); empty[0].features[0].description = '';
  assert.throws(() => validateInventory(empty), /description/);
  const unsafe = structuredClone(categories); unsafe[0].features[0].sources = ['../secret'];
  assert.throws(() => validateInventory(unsafe), /evidence path/);
});

test('build publishes only its explicit static allowlist, not repository data or inventory evidence', async () => {
  assert.deepEqual((await readdir(output)).sort(), [...pages, 'styles.css', 'icon.svg', '.nojekyll'].sort());
  for (const body of html.values()) {
    assert.doesNotMatch(body, /<script|<iframe|<form|src\/agent\//);
    assert.doesNotMatch(body, /https?:\/\/(?:localhost|127\.0\.0\.1)/);
  }
});

test('every local link and fragment resolves, including from a project subpath', () => {
  const base = 'https://example.org/seneschal/';
  for (const [page, body] of html) {
    const ids = [...body.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
    assert.equal(new Set(ids).size, ids.length, `${page}: duplicate IDs`);
    for (const [, ref] of body.matchAll(/\b(?:href|src)="([^"]+)"/g)) {
      const url = new URL(ref, base + page);
      if (url.origin !== new URL(base).origin) continue;
      assert.ok(url.pathname.startsWith('/seneschal/'), ref);
      const file = url.pathname.slice('/seneschal/'.length);
      assert.ok([...pages, 'styles.css', 'icon.svg'].includes(file), ref);
      if (url.hash) assert.ok(html.get(file).includes(`id="${url.hash.slice(1)}"`), `${page}: ${ref}`);
    }
  }
});

test('every capability appears once, with its stable anchor and actual description', () => {
  const body = html.get('features.html');
  assert.equal([...body.matchAll(/class="feature-card"/g)].length, count);
  for (const category of categories) for (const feature of category.features) {
    assert.ok(body.includes(`id="${feature.id}"`));
    assert.ok(body.includes(escape(feature.description)));
  }
});

test('all pages have navigation, page language, one h1, skip link and description', () => {
  for (const [page, body] of html) {
    assert.match(body, /<html lang="en">/);
    assert.match(body, /name="viewport"/);
    assert.match(body, /name="description"/);
    assert.equal([...body.matchAll(/<h1>/g)].length, 1, page);
    assert.match(body, /class="skip" href="#main"/);
    assert.match(body, new RegExp(`href="${page.replace('.', '\\.')}" aria-current="page"`));
    for (const other of pages) assert.ok(body.includes(`href="${other}"`));
  }
});

test('content escapes HTML instead of treating descriptions as markup', () => {
  assert.equal(escape('<script>"&\''), '&lt;script&gt;&quot;&amp;&#39;');
});

test('setup and boundary guidance distinguish public website from private operator console', () => {
  assert.match(html.get('getting-started.html'), /no hosted signup/);
  assert.match(html.get('getting-started.html'), /no built-in login by default/);
  assert.match(html.get('getting-started.html'), /tunnel alone is not authentication/);
  assert.match(html.get('features.html'), /not a roadmap/);
});
