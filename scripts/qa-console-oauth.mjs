// Offline Chromium regression. Run with:
// node --experimental-strip-types scripts/qa-console-oauth.mjs
// Optional PLAYWRIGHT_CHROMIUM_EXECUTABLE points to an existing sandbox browser.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { TaskStatusStore } from '../src/tasks/store.ts';
import { ArtifactServer } from '../src/artifacts/server.ts';
import { consoleOAuthFixture } from '../src/agent/consoleConnectorOAuth-fixture.ts';

const cleanup = [];
const f = consoleOAuthFixture({ after: (fn) => cleanup.push(fn) }, { allowed: (target) => target.userId === 'UINITIATOR' });
const source = {
  baseUrl: 'https://console.example.org/harness', dataDir: f.target.channelRoot, tasks: new TaskStatusStore(f.target.channelRoot),
  config: () => ({ name: 'Harness', channels: { CTARGET: {} }, webConsole: { oauth: { callbackUrl: f.manager.callbackUrl } } }),
  channels: () => [{ id: 'CTARGET', name: 'test-channel', isDm: false, firstSeen: '', lastSeen: '' }],
  resolve: () => ({ model: 'm', thinkingLevel: 'medium', tools: [], sandbox: { mode: 'host' }, schedulesEnabled: false,
    dreamsEnabled: false, respondToRootMessages: false, library: {}, documents: {}, memory: {},
    connectors: [{ name: f.target.connectorName, config: { transport: 'http', oauth: f.target.oauth } }] }),
};
const server = new ArtifactServer({ enabled: true, console: true, artifacts: true, host: '127.0.0.1', port: 0, baseUrl: 'https://console.example.org/harness' }, f.target.channelRoot, {}, () => source, f.manager);
let browser;
try {
  await server.start();
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const local = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
  const context = await browser.newContext();
  let providerHits = 0;
  let holdConsent = false;
  let heldCallback;
  let sandboxOrigin;
  let sandboxStatus;
  await context.route('https://console.example.org/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const headers = await request.allHeaders();
    const response = await route.fetch({ url: local + url.pathname + url.search, headers, maxRedirects: 0 });
    if (headers.origin === 'null' && url.pathname.endsWith('/poll')) { sandboxOrigin = headers.origin; sandboxStatus = response.status(); }
    // Playwright interception is only applied to the first request in an HTTP
    // redirect chain. Use a fresh meta navigation for this offline fake origin;
    // HTTP regressions separately verify the real callback's exact 303 headers.
    if (response.status() === 303) {
      const headers = response.headers();
      const destination = new URL(headers.location, f.manager.origin).toString();
      delete headers.location; delete headers['content-length'];
      headers['content-type'] = 'text/html; charset=utf-8';
      await route.fulfill({ status: 200, headers, body: `<meta http-equiv="refresh" content="0;url=${destination}">` });
    } else await route.fulfill({ response });
  });
  await context.route('https://login.example.org/authorize**', async (route) => {
    providerHits++;
    const url = new URL(route.request().url());
    assert.equal(url.searchParams.get('redirect_uri'), f.manager.callbackUrl);
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('scope'), 'mcp:read');
    const callback = new URL(f.manager.callbackUrl);
    callback.searchParams.set('state', url.searchParams.get('state'));
    callback.searchParams.set('code', 'synthetic-browser-code');
    if (holdConsent) {
      heldCallback = callback.toString();
      await route.fulfill({ status: 200, contentType: 'text/html', body: 'Synthetic provider consent pending' });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'text/html', body: `<meta http-equiv="refresh" content="0;url=${callback.toString()}">` });
  });
  const page = await context.newPage();
  const link = f.manager.start(f.target);
  await page.goto(link);
  await page.waitForFunction(() => location.hash === '');
  await page.getByRole('button', { name: 'Pair this browser' }).click();
  await page.waitForFunction(() => document.getElementById('message').textContent.includes('Browser pairing:'));
  assert.equal(f.pairings.length, 1);
  assert.ok((await page.locator('#message').textContent()).includes(f.pairings[0].phrase));
  assert.equal(providerHits, 0, 'mere console visitation/pairing cannot initiate consent');
  assert.equal(f.file.tokens(), undefined);
  assert.equal(f.manager.decide(f.pairings[0].id, 'UOTHER', f.target.channelId, true), false);
  const cookies = await context.cookies();
  const cookie = cookies.find((c) => c.name === '__Secure-harness-connector-oauth');
  assert.ok(cookie?.secure && cookie.httpOnly && cookie.sameSite === 'Lax');
  assert.ok(!(await page.evaluate(() => document.cookie)).includes('__Secure-harness-connector-oauth'));

  // A user-authored artifact on this shared listener has an opaque origin,
  // so even credentials:include cannot impersonate the paired console browser.
  const root = join(f.target.channelRoot, 'channels', 'CTARGET', 'workspace', 'artifacts');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'attack.html'), `<!doctype html><body><script>
    fetch('/harness/oauth/poll', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      .then((res) => { document.body.textContent = res.ok ? 'unexpected' : 'blocked'; }).catch(() => { document.body.textContent = 'blocked'; });
  </script>`);
  const attack = await context.newPage();
  await attack.goto('https://console.example.org/harness/channels/CTARGET/artifacts/attack.html');
  await attack.waitForFunction(() => document.body.textContent === 'blocked');
  assert.equal(sandboxOrigin, 'null');
  assert.equal(sandboxStatus, 403);
  assert.equal(providerHits, 0);
  await attack.close();

  assert.equal(f.manager.decide(f.pairings[0].id, f.target.userId, f.target.channelId, true), true);
  await page.waitForURL('https://console.example.org/harness/oauth/result');
  await page.waitForFunction(() => document.body.textContent.includes('Return to Slack'));
  assert.equal(providerHits, 1);
  assert.equal(f.exchanges.length, 1);
  assert.equal(f.file.tokens().access_token, 'synthetic-new-access');
  assert.equal(f.notices.length, 1);
  assert.match(f.notices[0].message, /Authorization complete/);
  assert.doesNotMatch(await page.textContent('body'), /synthetic-browser-code|synthetic-new-access|state=/);
  assert.equal((await context.cookies()).find((c) => c.name === '__Secure-harness-connector-oauth'), undefined);
  // A second grant can originate directly from the channel page, but its
  // provisional browser request has no Slack identity or provider consent yet.
  await page.goto('https://console.example.org/harness/channels/CTARGET');
  await page.getByRole('link', { name: 'Connect calendar', exact: true }).click();
  await page.getByRole('button', { name: 'Request Slack approval' }).waitFor();
  assert.equal(f.webPairings.length, 0, 'GET channel/connect pages never create Slack prompts');
  await page.getByRole('button', { name: 'Request Slack approval' }).click();
  await page.waitForFunction(() => document.getElementById('message').textContent.includes('Browser pairing:'));
  assert.equal(f.webPairings.length, 1);
  assert.ok((await page.locator('#message').textContent()).includes(f.webPairings[0].phrase));
  assert.equal(providerHits, 1);
  assert.equal(f.manager.decide(f.webPairings[0].id, 'UOTHER', f.target.channelId, true), false);
  assert.equal(f.manager.decide(f.webPairings[0].id, 'UINITIATOR', f.target.channelId, true), true);
  await page.waitForURL('https://console.example.org/harness/oauth/result');
  await page.waitForFunction(() => document.body.textContent.includes('Return to Slack'));
  assert.equal(providerHits, 2);
  assert.equal(f.exchanges.length, 2);
  assert.equal(f.notices.length, 2);
  assert.equal(f.notices[1].target.userId, 'UINITIATOR');
  assert.equal(f.notices[1].target.threadTs, '789.012');
  assert.doesNotMatch(await page.textContent('body'), /synthetic-browser-code|synthetic-new-access|state=/);
  // Reproduce the still-visible Slack Cancel button after approval, with a
  // subsequent provider callback using the same paired browser cookie.
  const priorGrant = f.file.tokens();
  holdConsent = true;
  const cancelledPage = await context.newPage();
  await cancelledPage.goto(f.manager.start(f.target));
  await cancelledPage.getByRole('button', { name: 'Pair this browser' }).click();
  await cancelledPage.waitForFunction(() => document.getElementById('message').textContent.includes('Browser pairing:'));
  const cancellationId = f.pairings.at(-1).id;
  assert.equal(f.manager.decide(cancellationId, f.target.userId, f.target.channelId, true), true);
  await cancelledPage.waitForURL('https://login.example.org/authorize**');
  await cancelledPage.waitForFunction(() => document.body.textContent.includes('Synthetic provider consent pending'));
  assert.ok(heldCallback);
  assert.equal(f.manager.decide(cancellationId, f.target.userId, f.target.channelId, false), true);
  await cancelledPage.goto(heldCallback);
  await cancelledPage.waitForURL('https://console.example.org/harness/oauth/result');
  assert.deepEqual(f.file.tokens(), priorGrant, 'cancelled callback cannot replace the existing grant');
  assert.equal(f.exchanges.length, 2, 'cancelled callback cannot exchange');
  assert.equal(f.notices.length, 3);
  assert.match(f.notices[2].message, /cancelled/);
  assert.doesNotMatch(await cancelledPage.textContent('body'), /synthetic-browser-code|synthetic-new-access|state=/);
  console.log('PASS: Chromium Slack + channel-page initiation/approval/S256/callback/clean-result and sandboxed-artifact origin boundary; post-approval Cancel rejects later callback (synthetic offline provider).');
} finally {
  await browser?.close();
  await server.stop();
  for (const fn of cleanup) await fn();
}
