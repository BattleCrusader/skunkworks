/**
 * The navigation pilot: one script, served once, wired into both surfaces, refusing everything that
 * is not a plain same-origin GET navigation.
 *
 * These are string-level assertions on purpose. Whether a click actually swaps `<main>` without a
 * document load is a browser fact and is verified against the running site; what a unit test can
 * pin is the contract that makes that safe — the pilot must refuse form submissions, downloads,
 * new-tab targets, cross-origin hrefs, modifier clicks and same-document hashes, because each of
 * those is a case where the browser's own navigation is the correct behaviour and a swap would be a
 * bug the reader would blame on the site.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { NAV_PILOT_JS } from '../app/render/nav-pilot.ts';
import { layout } from '../app/admin/ui/layout.ts';

const root = join(import.meta.dirname, '..');

test('N1 — the pilot is a script, and it is one file for both surfaces', () => {
  assert.ok(NAV_PILOT_JS.length > 1500, 'the pilot has a body');
  assert.ok(!NAV_PILOT_JS.includes('</script'), 'a string that ends a script tag would break the page');
  assert.ok(!NAV_PILOT_JS.includes('\u2028'), 'a raw line separator is a syntax error in older engines');
  // A backtick inside the String.raw template closes the literal and the file stops parsing —
  // this has now cost two runs, so it is a test rather than a note.
  assert.equal((NAV_PILOT_JS.match(/`/g) ?? []).length, 0, 'no backticks survive inside the pilot');
  assert.match(NAV_PILOT_JS, /__skwNavLoaded/, 'it is idempotent');
  assert.match(NAV_PILOT_JS, /data-mode/, 'it knows which surface it is on');
});

test('N2 — everything the browser should handle stays the browser’s', () => {
  const guards: Array<[string, RegExp]> = [
    ['form submission', /closest\('form'\)/],
    ['download attribute', /hasAttribute\('download'\)/],
    ['target other than _self', /getAttribute\('target'\)/],
    ['opt-out hook', /data-skw-noajax/],
    ['cross-origin', /origin === location\.origin/],
    ['modifier click', /metaKey \|\| ev\.ctrlKey/],
    ['non-primary button', /ev\.button !== 0/],
    ['same-document hash', /there\.hash && there\.pathname === here\.pathname/],
  ];
  for (const [name, pattern] of guards) {
    assert.match(NAV_PILOT_JS, pattern, `the pilot refuses ${name}`);
  }
});

test('N3 — a failed fetch falls back to a real navigation, never to nothing', () => {
  assert.match(NAV_PILOT_JS, /location\.href = url/, 'the fallback is the URL the reader asked for');
  assert.match(NAV_PILOT_JS, /stats\.fallbacks/, 'and it is counted, so a silent fallback is visible');
});

test('N4 — what a swap must carry over: title, page path, per-page sheet, nonce’d scripts', () => {
  assert.match(NAV_PILOT_JS, /document\.title = doc\.title/);
  assert.match(NAV_PILOT_JS, /data-page-path/);
  assert.match(NAV_PILOT_JS, /link\[rel="stylesheet"\]/, 'a page that owns a sheet keeps it');
  assert.match(NAV_PILOT_JS, /data-skw-nav-sheet/, 'and the previous page’s sheet does not leak');
  assert.match(NAV_PILOT_JS, /setAttribute\('nonce', nonce\)/, 'admin inline scripts are re-stamped to run');
  assert.match(NAV_PILOT_JS, /pushState/, 'history gets an entry');
  assert.match(NAV_PILOT_JS, /popstate/, 'and back/forward swaps instead of reloading');
});

test('N5 — both surfaces load it from the same origin, because the policy allows only that', () => {
  const page = readFileSync(join(root, 'app/render/components/shells/page.astro'), 'utf8');
  assert.match(page, /<script src="\/_js\/nav\.js" data-mode="site" defer><\/script>/);

  const admin = layout({ title: 'x', body: '<p>y</p>' } as Parameters<typeof layout>[0]);
  assert.match(admin, /<script src="\/_js\/nav\.js" data-mode="admin" defer><\/script>/);
});

test('N6 — the admin shell keeps the pilot last, so it never blocks the screen it navigates', () => {
  const admin = layout({ title: 'x', body: '<p>y</p>' } as Parameters<typeof layout>[0]);
  const pilot = admin.indexOf('/_js/nav.js');
  assert.ok(pilot > admin.indexOf('<main'), 'the script sits after the main content');
  assert.ok(pilot < admin.indexOf('</body>'), 'and inside the body');
});
