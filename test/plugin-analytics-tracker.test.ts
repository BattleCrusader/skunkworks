/**
 * The tracker, executed in a DOM and observed. `client/t.js` is the one file in this repository
 * that runs on a visitor's machine, and it has no test framework there: a mistake in it is a
 * silent loss of data, not a red build. So the file is loaded into jsdom, the browser APIs it
 * asks for are supplied, and every beacon it sends is captured and asserted.
 *
 *   T1  loading the script sends one pageview, carrying path, viewport and a `text/plain` body
 *   T2  a press on a link sends a click with the link's own words, its resolved URL and its kind
 *   T3  a press on a button is a click too, and the same press twice in a row is one intention
 *   T4  scrolling reports each depth mark once, and leaving reports dwell time exactly once
 *   T5  the two opt-outs work: Global Privacy Control and an automated browser send nothing
 *
 * The body is asserted to be the JSON the collector validates, not a summary of it: the contract
 * between this file and `plugins/analytics/index.mjs` is the field letters, and it is the one
 * place where a rename on either side is invisible to the compiler.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { JSDOM } from 'jsdom';

const CODE = readFileSync(join(process.cwd(), 'plugins', 'analytics', 'client', 't.js'), 'utf8');
const ENDPOINT = '/_plugin/analytics/collect';

interface Harness {
  dom: JSDOM;
  beacons: { url: string; body: string; json: Record<string, unknown> }[];
  run(): void;
}

function harness(opts: { url?: string; html?: string; before?: (window: JSDOM['window']) => void } = {}): Harness {
  const dom = new JSDOM(opts.html ?? '<!doctype html><html><head></head><body></body></html>', {
    url: opts.url ?? 'https://acme.test/pricing',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const window = dom.window;
  const beacons: Harness['beacons'] = [];
  Object.defineProperty(window.navigator, 'sendBeacon', {
    configurable: true,
    value: (url: string, body: string): boolean => {
      beacons.push({ url, body, json: JSON.parse(body) as Record<string, unknown> });
      return true;
    },
  });
  opts.before?.(window);
  return {
    dom,
    beacons,
    run(): void {
      // The script finds its own endpoint through `document.currentScript`, which is null for an
      // eval'd string — the fallback (a `<script data-e>`) is what the real page provides.
      const tag = window.document.createElement('script');
      tag.setAttribute('data-e', ENDPOINT);
      window.document.head.appendChild(tag);
      window.eval(CODE);
    },
  };
}

test('T1. loading the script sends one pageview with the page it is on', () => {
  const h = harness({ html: '<!doctype html><html><head></head><body><a id="cta" href="/contact">Get a quote</a></body></html>' });
  h.run();
  assert.equal(h.beacons.length, 1);
  const first = h.beacons[0];
  assert.equal(first?.url, ENDPOINT);
  assert.equal(first?.json.k, 'pageview');
  assert.equal(first?.json.p, '/pricing');
  assert.equal(first?.json.u, 'https://acme.test/pricing');
  assert.equal(first?.json.vw, 1024);
  assert.match(String(first?.json.sid), /^[0-9a-f]{32}$/);
  assert.match(String(first?.json.vid), /^[0-9a-f]{32}$/);
  // A device, a browser and a language are always reported: the dashboard groups by them.
  assert.ok(['desktop', 'mobile', 'tablet'].includes(String(first?.json.d)));
});

test('T2. a press on a link sends the link, its words and its kind', () => {
  const h = harness({
    html: '<!doctype html><html><head></head><body><p><a id="cta" href="/contact">Get a quote</a></p></body></html>',
  });
  h.run();
  const anchor = h.dom.window.document.getElementById('cta') as HTMLAnchorElement;
  // Stop the navigation jsdom would otherwise attempt; the beacon is dispatched before it.
  anchor.addEventListener('click', (event) => event.preventDefault());
  anchor.click();

  const click = h.beacons.find((b) => b.json.k === 'click');
  assert.ok(click, 'no click beacon was sent');
  assert.equal(click?.json.t, 'Get a quote');
  assert.equal(click?.json.tu, 'https://acme.test/contact');
  assert.equal(click?.json.tk, 'internal');
  assert.equal(click?.json.p, '/pricing');
});

test('T3. a button press is a click, and a double press is one intention', () => {
  const h = harness({
    html: '<!doctype html><html><head></head><body><button id="buy" type="button" data-skw-label="Buy now">Buy</button></body></html>',
  });
  h.run();
  const button = h.dom.window.document.getElementById('buy') as HTMLButtonElement;
  button.click();
  button.click();
  const clicks = h.beacons.filter((b) => b.json.k === 'click');
  assert.equal(clicks.length, 1, 'a rapid double press must not be two clicks');
  assert.equal(clicks[0]?.json.t, 'Buy now');
  assert.equal(clicks[0]?.json.tk, 'button');
});

test('T4. scroll marks are reported once each, and leaving reports the dwell once', () => {
  const h = harness({ html: '<!doctype html><html><head></head><body><div style="height:4000px"></div></body></html>' });
  h.run();
  const window = h.dom.window;
  const doc = window.document;

  // jsdom has no layout, so the three numbers `scrollPct()` reads are supplied.
  Object.defineProperty(doc.documentElement, 'scrollHeight', { configurable: true, value: 4000 });
  Object.defineProperty(doc.documentElement, 'clientHeight', { configurable: true, value: 1000 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 1000 });
  Object.defineProperty(window, 'pageYOffset', { configurable: true, value: 1500, writable: true });
  window.dispatchEvent(new window.Event('scroll'));
  // The handler defers to rAF; `pretendToBeVisual` runs it, and a tick lets it land.
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      const marks = h.beacons.filter((b) => b.json.k === 'scroll');
      assert.ok(marks.length >= 1, 'no scroll beacon was sent');
      assert.equal(marks[0]?.json.sc, 25);
      // The same position again is not a second report of the same mark.
      window.dispatchEvent(new window.Event('scroll'));
      setTimeout(() => {
        assert.equal(h.beacons.filter((b) => b.json.k === 'scroll').length, marks.length);

        window.dispatchEvent(new window.Event('pagehide'));
        window.dispatchEvent(new window.Event('pagehide'));
        const engage = h.beacons.filter((b) => b.json.k === 'engage');
        assert.equal(engage.length, 1, 'leaving must report dwell exactly once');
        assert.equal(typeof engage[0]?.json.dw, 'number');
        resolve();
      }, 60);
    }, 60);
  });
});

test('T5. Global Privacy Control and an automated browser both send nothing', () => {
  const gpc = harness();
  Object.defineProperty(gpc.dom.window.navigator, 'globalPrivacyControl', { configurable: true, value: true });
  gpc.run();
  assert.deepEqual(gpc.beacons, []);

  const automated = harness();
  Object.defineProperty(automated.dom.window.navigator, 'webdriver', { configurable: true, value: true });
  automated.run();
  assert.deepEqual(automated.beacons, []);
});
