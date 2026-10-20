/**
 * S4d item C5 — **island props breakout in a real user agent** (§13.2, §16 S4).
 *
 * The island's output is an HTML **attribute**: `data-props` carries JSON that the browser
 * (and a hydration script) reads. Per-context escaping is therefore the whole control — a
 * `"` that ends the attribute is an injected handler, a `<` that ends the tag is an injected
 * element.
 *
 * This gate does not assert the serialiser against itself. It:
 *
 *   1. stores a page row whose island props are a payload — `a" onmouseover="…` and
 *      `</button><img src=x onerror=…>` — in one JSON string;
 *   2. serves it from the real app on a real port;
 *   3. drives **Chromium** over CDP (`--headless=new`, no Playwright API dependency) and
 *      evaluates the DOM the browser actually built;
 *   4. asserts no injected element, no injected handler attribute, and that the attribute
 *      still parses to the original string — the positive control against an over-eager
 *      escaper that would also pass 1 and 2.
 *
 * Chrome is Playwright's cached "Google Chrome for Testing" on this box; `SKW_CHROME` names
 * another binary. Its absence is a **failure**, not a skip (E-15: a skip is a failure here),
 * because a browser gate that quietly does not run is how a breakout ships.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { openAdminWrite } from '../app/db/classes.ts';
import { loadEnv } from '../app/env.ts';
import { buildApp, type AppHandle } from '../app/main.ts';
import { makeFixture, type Fixture } from './helpers/fixture.ts';

const PAYLOAD = 'a" onmouseover="window.__pwned=1" x="';
const TAG_PAYLOAD = '</button><img src=x onerror="window.__pwned=2">';

function chromeBinary(): string {
  if (process.env.SKW_CHROME !== undefined) return process.env.SKW_CHROME;
  const cache = join(homedir(), 'Library', 'Caches', 'ms-playwright');
  if (existsSync(cache)) {
    for (const entry of readdirSync(cache).sort().reverse()) {
      for (const platform of ['chrome-mac-arm64', 'chrome-mac']) {
        const candidate = join(cache, entry, platform, 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  throw new Error('no Chromium found: set SKW_CHROME to a Chrome/Chromium binary (a skip here would hide the gate, E-15)');
}

let fixture: Fixture;
let handle: AppHandle;
let port = 0;
let profile = '';
let chrome: ChildProcess | null = null;
let cdpPort = 0;
let pageWs = '';

/**
 * The props attribute is single-quoted in the stored bytes, so the JSON's `"` is legal
 * input and the serialiser has to escape it on the way out.
 */
function islandBody(): string {
  const props = JSON.stringify({ address: `${PAYLOAD} ${TAG_PAYLOAD}` });
  return (
    '<div class="prose" data-gjs-type="prose"><p data-prop="body">Escaping</p></div>' +
    `<button class="island island--copy-email" data-gjs-type="copy-email" data-island="copy-email" data-props='${props}' type="button">Copy</button>`
  );
}

function waitForFile(path: string, ms: number): void {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    // A sleep in the hook is bounded by the deadline; there is no event for "Chrome wrote
    // its port file".
    spawnSyncSleep(50);
  }
  throw new Error(`chrome did not write ${path} within ${ms} ms`);
}

function spawnSyncSleep(ms: number): void {
  const shared = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(shared), 0, 0, ms);
}

async function cdp(method: string, params: Record<string, unknown>, id: number): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    const socket = new WebSocket(pageWs);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`CDP ${method} timed out`));
    }, 20_000);
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ id, method, params }));
    });
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: Record<string, unknown>; error?: unknown };
      if (message.id !== id) return;
      clearTimeout(timer);
      socket.close();
      if (message.error !== undefined) reject(new Error(`CDP ${method}: ${JSON.stringify(message.error)}`));
      else resolve(message.result ?? {});
    });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error(`CDP socket error on ${method}`));
    });
  });
}

before(async () => {
  fixture = makeFixture({ specs: [{ key: 'acme', hosts: ['acme.test'] }] });
  const db = openAdminWrite(fixture.sitePath('acme'), 5000);
  try {
    db.prepare(
      `INSERT INTO cms_page (path, slug, title, status, template, body_html, published_at)
       VALUES ('/island', 'island', 'Island', 'published', 'page', ?, '2026-10-21T00:00:00.000Z')`,
    ).run(islandBody());
  } finally {
    db.close();
  }
  handle = await buildApp({ env: loadEnv(fixture.env) });
  await handle.app.listen({ port: 0, host: '127.0.0.1' });
  const address = handle.app.server.address();
  port = typeof address === 'object' && address !== null ? address.port : 0;

  profile = mkdtempSync(join(tmpdir(), 'skw-chrome-'));
  chrome = spawn(
    chromeBinary(),
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--no-first-run',
      '--disable-extensions',
      '--disable-background-networking',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--host-resolver-rules=MAP acme.test 127.0.0.1',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  waitForFile(join(profile, 'DevToolsActivePort'), 20_000);
  const portFile = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n');
  cdpPort = Number(portFile[0]);
  assert.ok(Number.isInteger(cdpPort) && cdpPort > 0, `no CDP port in ${JSON.stringify(portFile)}`);

  // A new tab, so the URL is navigated by the browser itself (host-resolver-rules applies
  // to the renderer, and the Host header is what the app routes on).
  const created = await fetch(`http://127.0.0.1:${cdpPort}/json/new?${encodeURIComponent(`http://acme.test:${port}/island`)}`, {
    method: 'PUT',
  });
  const target = (await created.json()) as { webSocketDebuggerUrl?: string };
  assert.ok(typeof target.webSocketDebuggerUrl === 'string', `no page target: ${JSON.stringify(target)}`);
  pageWs = target.webSocketDebuggerUrl;

  // Wait for the document, not for a timer: the app renders on request and the page has no
  // subresources, so `complete` is the load.
  const deadline = Date.now() + 20_000;
  for (;;) {
    const ready = await cdp('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true }, 1);
    const value = (ready.result as { value?: string } | undefined)?.value;
    if (value === 'complete') break;
    if (Date.now() > deadline) throw new Error(`the island page never loaded (readyState=${String(value)})`);
    spawnSyncSleep(100);
  }
});

/**
 * Kill Chromium and wait for it to stop writing before removing its profile.
 *
 * `SIGKILL` is asynchronous and Chrome's helper processes outlive the browser process for a
 * moment; a bare `rmSync` then fails `ENOTEMPTY` **in teardown**, turning a passing gate red
 * (observed 2026-10-21). The wait and the retry are cleanup only — no assertion is relaxed —
 * and the loop still throws if the directory cannot be removed, so a genuinely stuck
 * browser is a red gate, not a silent leak.
 */
async function removeProfile(dir: string): Promise<void> {
  if (chrome !== null && chrome.exitCode === null && chrome.signalCode === null) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 5_000);
      chrome?.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      chrome?.kill('SIGKILL');
    });
  }
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      return;
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

after(async () => {
  await handle?.close();
  fixture?.cleanup();
  if (profile !== '') await removeProfile(profile);
});

test('C5 — island props stay data in Chromium: no injected element, no injected handler, JSON intact', async () => {
  const expression = `(() => {
    const button = document.querySelector('[data-island]');
    const props = button === null ? null : button.getAttribute('data-props');
    let address = null;
    let parseError = null;
    try { address = props === null ? null : JSON.parse(props).address; } catch (err) { parseError = String(err); }
    return JSON.stringify({
      found: button !== null,
      buttons: document.querySelectorAll('button').length,
      images: document.querySelectorAll('img').length,
      handlerAttributes: button === null ? -1 : [...button.attributes].filter((a) => a.name.toLowerCase().startsWith('on')).length,
      props,
      address,
      parseError,
      title: document.title,
    });
  })()`;
  const evaluated = await cdp('Runtime.evaluate', { expression, returnByValue: true }, 2);
  const raw = (evaluated.result as { value?: string } | undefined)?.value;
  assert.ok(typeof raw === 'string', `Runtime.evaluate returned ${JSON.stringify(evaluated)}`);
  const facts = JSON.parse(raw) as {
    found: boolean;
    buttons: number;
    images: number;
    handlerAttributes: number;
    props: string | null;
    address: string | null;
    parseError: string | null;
  };

  assert.equal(facts.found, true, 'the browser did not render the island at all');
  // 1. No injected element. The tag payload would close the <button> and open an <img>.
  assert.equal(facts.images, 0, 'the props broke out of the attribute and created an element');
  assert.equal(facts.buttons, 1, 'the tag payload created a second button');
  // 2. No injected handler. The quote payload would become a second attribute.
  assert.equal(facts.handlerAttributes, 0, 'the quote payload became an event-handler attribute');
  // 3. The attribute is still data, and the browser's parser reads the original string back.
  assert.equal(facts.parseError, null, `data-props is not JSON in the browser: ${String(facts.parseError)}`);
  assert.equal(facts.address, `${PAYLOAD} ${TAG_PAYLOAD}`, 'the attribute no longer carries the original props');
});
