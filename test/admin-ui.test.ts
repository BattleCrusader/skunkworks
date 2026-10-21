/**
 * S7 — the Guided Cards admin UI, phase 1: sign-in, the page list, the media library.
 *
 * These tests are written against the **contract of the screen**, not its HTML soup: the
 * form targets and field names the routes already read, the facts a row must carry (state
 * as a word, a usage count, a version count), and the two promises the media library makes
 * before an operator clicks anything —
 *
 *   1. a gated file is never offered as if it had a public address;
 *   2. no control is offered that the server would refuse (a delete on a file something
 *      refers to, or on a private file at all).
 *
 * They also hold the "works with JavaScript off" line: every form is a real `method` +
 * `action`, the sign-in page carries no script at all, and the media library's single
 * script is an enhancement (`src`-free, and the page is complete without it).
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import sharp from 'sharp';

import { totpCode } from '../app/admin/auth.ts';
import { uploadAsset } from '../app/assets/library.ts';
import { ensureVariants } from '../app/assets/renditions.ts';
import { openAdminWrite } from '../app/db/classes.ts';
import { loadEnv } from '../app/env.ts';
import { buildApp, type AppHandle } from '../app/main.ts';
import { cspPolicy } from '../app/render/csp.ts';
import { ADMIN_HOST, ADMIN_ORIGIN, TOTP_SECRET, login, seedUser, type Sessioned } from './helpers/admin.ts';
import { makeFixture, type Fixture } from './helpers/fixture.ts';
import { call, header, type Res } from './helpers/http.ts';

let fixture: Fixture;
let handle: AppHandle;
let port = 0;
let session: Sessioned;
let contentRoot = '';
let draftId = 0;
let usedId = 0;
let unusedId = 0;
let gatedId = 0;

async function png(): Promise<Buffer> {
  return sharp({ create: { width: 120, height: 90, channels: 3, background: { r: 30, g: 60, b: 90 } } }).png().toBuffer();
}

async function upload(key: string, opts: { accessClass?: 'public' | 'gated'; alt?: string } = {}): Promise<number> {
  const db = openAdminWrite(fixture.sitePath('acme'));
  try {
    const result = await uploadAsset({
      db,
      contentRoot,
      tenantKey: 'acme',
      key,
      filename: `${key.split('/').pop() ?? key}.png`,
      bytes: await png(),
      quotaLimitBytes: 10_000_000,
      ...(opts.accessClass === undefined ? {} : { accessClass: opts.accessClass }),
      ...(opts.alt === undefined ? {} : { altText: opts.alt }),
    });
    await ensureVariants({ db, contentRoot, assetId: result.asset.id });
    return result.asset.id;
  } finally {
    db.close();
  }
}

async function get(path: string): Promise<Res> {
  return call({ port, path, host: ADMIN_HOST, headers: { cookie: session.cookie } });
}

/** Everything between `<figure … data-asset-key="key">` and its `</figure>`. */
function figureOf(body: string, key: string): string {
  const start = body.indexOf(`data-asset-key="${key}"`);
  assert.notEqual(start, -1, `no tile for ${key}`);
  const end = body.indexOf('</figure>', start);
  assert.notEqual(end, -1, `unterminated tile for ${key}`);
  return body.slice(body.lastIndexOf('<figure', start), end);
}

function count(haystack: string, needle: RegExp): number {
  return (haystack.match(needle) ?? []).length;
}

before(async () => {
  fixture = makeFixture({ specs: [{ key: 'acme', hosts: ['acme.test'], title: 'Acme pricing' }] });
  contentRoot = join(fixture.dir, 'content');
  await seedUser({ controlDb: fixture.controlDb, tenantKey: 'acme', email: 'owner@acme.test', totpSecret: TOTP_SECRET });

  // Three pages in the three states the design draws: live, draft, hidden. The draft is
  // what arms the next-step banner, and it carries one revision so "versions" is a fact.
  const db = openAdminWrite(fixture.sitePath('acme'));
  try {
    const draft = db
      .prepare(
        `INSERT INTO cms_page (path, slug, title, status, template, body_html)
         VALUES ('/services', 'services', 'Services', 'draft', 'page', '<h1>Services</h1>')`,
      )
      .run();
    draftId = Number(draft.lastInsertRowid);
    db.prepare(
      `INSERT INTO cms_page_revision (page_id, rev, body_html, body_css) VALUES (?, 1, '<h1>Services</h1>', '')`,
    ).run(draftId);
    db.prepare(
      `INSERT INTO cms_page (path, slug, title, status, template, body_html) VALUES ('/about', 'about', 'About', 'hidden', 'page', '')`,
    ).run();
  } finally {
    db.close();
  }

  usedId = await upload('hero/wide', { alt: 'a wide hero' });
  unusedId = await upload('scan/leaflet', { alt: 'a leaflet' });
  gatedId = await upload('vault/paid', { accessClass: 'gated', alt: 'paid download' });

  // The usage graph is what the tile reads: one page refers to hero/wide, nothing refers
  // to scan/leaflet, and the gated file is referred to by the draft page.
  const links = openAdminWrite(fixture.sitePath('acme'));
  try {
    links.prepare("INSERT INTO cms_asset_link (asset_id, owner_kind, owner_id) VALUES (?, 'page', 1)").run(usedId);
    links.prepare("INSERT INTO cms_asset_link (asset_id, owner_kind, owner_id) VALUES (?, 'page', ?)").run(gatedId, draftId);
  } finally {
    links.close();
  }

  handle = await buildApp({ env: loadEnv(fixture.env) });
  port = await handle.app.listen({ port: 0, host: '127.0.0.1' }).then(() => {
    const address = handle.app.server.address();
    return typeof address === 'object' && address !== null ? address.port : 0;
  });
  const res = await login({ port, key: 'acme', email: 'owner@acme.test', totp: totpCode(TOTP_SECRET, Date.now()) });
  assert.equal(res.status, 200, res.body);
  const raw = String(header(res, 'set-cookie'));
  session = {
    cookie: raw.slice(0, raw.indexOf(';')),
    csrfToken: (res.json as { csrfToken: string }).csrfToken,
    email: 'owner@acme.test',
  };
});

after(async () => {
  await handle.close();
  fixture.cleanup();
});

// --- sign in ---------------------------------------------------------------

test('S7-1. the sign-in page is the Guided Cards card and the same form contract', async () => {
  const res = await call({ port, path: '/admin/login', host: ADMIN_HOST });
  assert.equal(res.status, 200, res.body);
  assert.match(String(header(res, 'content-type')), /text\/html/);

  // The POST target and the three field names the route reads (§9.1, D29).
  assert.match(res.body, /<form method="post" action="\/admin\/login"/);
  assert.match(res.body, /<input id="email" type="email" name="email" autocomplete="username"[^>]*\brequired\b/);
  assert.match(res.body, /<input id="password" type="password" name="password" autocomplete="current-password"[^>]*\brequired\b/);
  assert.match(res.body, /<input id="totp" type="text" name="totp" inputmode="numeric" autocomplete="one-time-code" pattern="\[0-9\]\{6\}"[^>]*>/);

  // Real labels, not a placeholder pretending to be one.
  for (const id of ['email', 'password', 'totp']) assert.match(res.body, new RegExp(`<label for="${id}">`), `no label for ${id}`);

  // Login has no session to bind a token to, so there is no CSRF field here (D28).
  assert.doesNotMatch(res.body, /name="csrf"/);
  // The design's posture words, and the tenant this Host serves.
  assert.match(res.body, /<h1 id="signin-title">Welcome back<\/h1>/);
  assert.match(res.body, /<title>Sign in — acme — Skunkworks<\/title>/);
  assert.equal(count(res.body, /<h1[ >]/g), 1, 'exactly one h1');
  assert.doesNotMatch(res.body, /<script/i, 'sign-in carries no JavaScript at all');
  assert.doesNotMatch(res.body, /<link[^>]+rel="stylesheet"/i, 'no stylesheet request');
  assert.doesNotMatch(res.body, /<(?:img|iframe)[^>]+src="https?:/i, 'no third-party request');
});

// --- the page list ---------------------------------------------------------

test('S7-2. the page list is the landing screen, and every word on it is a database fact', async () => {
  const res = await get('/admin');
  assert.equal(res.status, 200, res.body);
  assert.match(res.body, /<h1>Your pages<\/h1>/);
  assert.equal(count(res.body, /<h1[ >]/g), 1, 'exactly one h1');

  // The fixture seeds /pricing published; this file adds /services (draft) and /about
  // (hidden). The draft arms the banner and is named in it.
  assert.match(res.body, /class="nextstep"/, 'a draft must arm the next-step banner');
  assert.match(res.body, /<b>Services is almost ready<\/b>/);
  assert.match(res.body, new RegExp(`href="/admin/t/acme/editor\\?page=${draftId}">Finish Services</a>`));

  // State is a word in a pill, not a colour: Live, Draft and Hidden all appear.
  assert.match(res.body, /class="pill pill--live"[^>]*><i aria-hidden="true"><\/i>Live<\/span>/);
  assert.match(res.body, /class="pill pill--draft"[^>]*><i aria-hidden="true"><\/i>Draft<\/span>/);
  assert.match(res.body, /class="pill pill--private"[^>]*><i aria-hidden="true"><\/i>Hidden<\/span>/);

  // The row carries the four facts the design draws: initial, address, update, versions.
  assert.match(res.body, /class="thumb-ic [abc]" aria-hidden="true">[A-Z]<\/span>/);
  assert.match(res.body, /<span>\/services<\/span>/);
  assert.match(res.body, /<span>1 version<\/span>/, 'the revision row must be counted');
  assert.match(res.body, /class="btn btn--sm" href="\/admin\/t\/acme\/editor\?page=\d+">Edit/);

  // The stat tiles are a definition list with the number in a dd.
  assert.match(res.body, /<dt>pages live for visitors<\/dt><dd>1<\/dd>/);
  assert.match(res.body, /<dt>drafts? only you can see<\/dt><dd>1<\/dd>/);

  // Navigation: the current screen is marked, and the rest of the admin is still reachable.
  assert.match(res.body, /<a href="\/admin\/t\/acme\/" aria-current="page">Pages<\/a>/);
  assert.match(res.body, /<a href="\/admin\/t\/acme\/media">Photos &amp; files<\/a>/);
  assert.match(res.body, /<a href="\/admin\/t\/acme\/plugins">Plugins<\/a>/);
  assert.match(res.body, /href="\/admin\/t\/acme\/tables"/, 'Tables is still reachable');
  assert.match(res.body, /href="\/admin\/t\/acme\/session"/, 'Session is still reachable');

  // The skip link, first in the document.
  assert.match(res.body, /<body>\n {2}<a class="skip" href="#main">Skip to content<\/a>/);
  assert.match(res.body, /<main id="main" class="page">/);
  assert.doesNotMatch(res.body, /<script/i, 'the page list needs no JavaScript');
});

test('S7-9. a published page is never described as "not published yet", whatever its revision count', async () => {
  // The live defect: the four seeded pages are `status = 'published'` with no rows in
  // `cms_page_revision`, and the row's third fact was derived from the revision count —
  // so every row read "Live · … · not published yet". A screen that contradicts itself on
  // its own headline fact is worse than one that says less.
  const res = await get('/admin');
  assert.equal(res.status, 200, res.body);

  // Seeded published page, zero revisions: it must not claim it is unpublished.
  // S8b added `data-draft` beside `data-status`, so the row opener is matched by prefix rather
  // than by a closing `>` immediately after the status attribute.
  const publishedRow = /<div class="pagerow" data-page-id="\d+" data-status="published"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i.exec(res.body);
  assert.ok(publishedRow !== null, 'the fixture must have a published row to inspect');
  assert.doesNotMatch(publishedRow[0], /not published yet/, 'a Live row must not say it is unpublished');
  assert.match(publishedRow[0], /no earlier versions kept/);

  // A draft with no revisions is the one case where the phrase is true, and it stays.
  // The fixture's own draft carries a revision, so this inserts a page that has none —
  // the case the old line got right, kept so the fix cannot turn into "never say it".
  const db = openAdminWrite(fixture.sitePath('acme'));
  try {
    db.prepare(
      "INSERT INTO cms_page (path, slug, title, status) VALUES ('/brand-new', 'brand-new', 'Brand new', 'draft')",
    ).run();
  } finally {
    db.close();
  }
  const after = await get('/admin');
  assert.equal(after.status, 200, after.body);
  const draftRow = /<div class="pagerow" data-page-id="\d+" data-status="draft"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i.exec(after.body);
  assert.ok(draftRow !== null, 'the fixture must have a draft row to inspect');
  assert.match(draftRow[0], /not published yet/);
});

test('S7-3. a site database the screen cannot read is a sentence, not a 500 and not invented rows', async () => {
  // The tenant still routes (its file opens); the table the screen needs is gone. That is
  // the branch `#pageRows` returns null for, and the screen must say so rather than throw
  // — the operator can do nothing about a broken file, and an error page invites a retry.
  const db = openAdminWrite(fixture.sitePath('acme'));
  try {
    db.prepare('ALTER TABLE cms_page RENAME TO cms_page_hidden').run();
    const res = await get('/admin');
    assert.equal(res.status, 200, 'a tenant the screen cannot read is still a 200 with a sentence');
    assert.match(res.body, /We could not read this site's pages just now/);
    assert.doesNotMatch(res.body, /class="pagerow"/, 'no rows are invented');
  } finally {
    db.prepare('ALTER TABLE cms_page_hidden RENAME TO cms_page').run();
    db.close();
  }
});

// --- the media library -----------------------------------------------------

test('S7-4. every tile says what it is used on, and the gated file is visibly not publishable', async () => {
  const res = await get('/admin/t/acme/media');
  assert.equal(res.status, 200, res.body);
  assert.match(res.body, /<h1>Photos &amp; files<\/h1>/);
  assert.equal(count(res.body, /<h1[ >]/g), 1, 'exactly one h1');

  // Usage counts come from `cms_asset_link`, and the tile names the page when there is one.
  const used = figureOf(res.body, 'hero/wide');
  assert.match(used, /Used on <b>1 page<\/b> — Acme pricing/);
  const unused = figureOf(res.body, 'scan/leaflet');
  assert.match(unused, /Not used on any page/);

  // The gated tile: dashed, locked, and it says why in words.
  const gated = figureOf(res.body, 'vault/paid');
  assert.match(gated, /class="asset asset--gated"/);
  assert.match(gated, /No preview/);
  assert.match(gated, /Needs a code/);
  assert.match(gated, /Private file/);
  assert.match(gated, /href="\/admin\/t\/acme\/codes">Share/);
  assert.doesNotMatch(gated, /<img/, 'a gated file has no public URL to render');
  assert.doesNotMatch(gated, /\/media\/vault\/paid/, 'no farm URL for a gated asset');

  // The rule this phase exists to keep: no delete control the API would refuse.
  assert.doesNotMatch(gated, /<form/i, 'the gated tile must not offer a write');
  assert.doesNotMatch(gated, /Delete/i, 'no delete word on a private file');
  assert.doesNotMatch(used, /<form/i, 'a file used on a page cannot be deleted, so no form');
  assert.match(used, /Cannot delete — used on a page/);
  assert.match(unused, new RegExp(`<form method="post" action="/admin/t/acme/tables/cms_asset/${unusedId}/delete"`));
  assert.match(unused, /name="csrf" value="[A-Za-z0-9_-]+"/);

  // Search is a GET form a browser can submit with JavaScript off; the chips are links.
  assert.match(res.body, /<form class="search" role="search" method="get" action="\/admin\/t\/acme\/media">/);
  assert.match(res.body, /<label class="sr-only" for="media-filter">Search files by name, description or kind<\/label>/);
  assert.match(res.body, /<input id="media-filter" type="search" name="q" value="" placeholder="Search by name or description">/);
  assert.match(res.body, /<a class="chip" href="\/admin\/t\/acme\/media"[^>]*>All 3<\/a>/);
  assert.match(res.body, /<a class="chip" href="\/admin\/t\/acme\/media\?q=image">Photos<\/a>/);

  // One inline style, one enhancement script, no external request.
  assert.equal(count(res.body, /<style[ >]/g), 1);
  const scripts = res.body.match(/<script[\s\S]*?<\/script>/g) ?? [];
  assert.equal(scripts.length, 1, 'exactly one inline script');
  assert.doesNotMatch(scripts[0] ?? '', /src=/, 'the script is inline, not fetched');
  assert.doesNotMatch(res.body, /<link[^>]+rel="stylesheet"/i);
});

test('S7-5. the delete the library offers is the delete the server accepts', async () => {
  // The page's own form, taken out of the HTML: action, method and the `csrf` field.
  const before = await get('/admin/t/acme/media');
  const action = new RegExp(`<form method="post" action="(/admin/t/acme/tables/cms_asset/${unusedId}/delete)"`).exec(before.body)?.[1];
  assert.ok(action !== undefined, 'no delete form for the unused asset');
  const res = await call({
    port,
    path: action,
    method: 'POST',
    host: ADMIN_HOST,
    headers: { cookie: session.cookie, origin: ADMIN_ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf: session.csrfToken }).toString(),
  });
  assert.equal(res.status, 303, res.body);
  const after = await get('/admin/t/acme/media');
  assert.doesNotMatch(after.body, /data-asset-key="scan\/leaflet"/, 'the row the UI deleted is gone');
});

test('S7-6. the picker still writes a key, and still refuses a gated one', async () => {
  const ok = await get('/admin/t/acme/media?pick=cover&key=hero%2Fwide');
  assert.match(ok.body, /<label for="picked_value">cover<\/label><input id="picked_value" type="text" name="cover" value="hero\/wide" readonly>/);
  assert.doesNotMatch(ok.body, /value="\/media\//, 'the picker wrote a URL rather than a key');
  const refused = await get('/admin/t/acme/media?pick=cover&key=vault%2Fpaid');
  assert.doesNotMatch(refused.body, /name="cover"/, 'a gated key was written into a field');
});

// --- accessibility, as a gate rather than a checklist ----------------------

test('S7-7. heading order, labels and the lock sentence are present on all three screens', async () => {
  const screens = [
    { name: 'sign in', res: await call({ port, path: '/admin/login', host: ADMIN_HOST }) },
    { name: 'pages', res: await get('/admin') },
    { name: 'media', res: await get('/admin/t/acme/media') },
  ];
  for (const { name, res } of screens) {
    assert.equal(res.status, 200, `${name}: ${res.body}`);
    assert.equal(count(res.body, /<h1[ >]/g), 1, `${name}: exactly one h1`);
    // No h3 may precede an h2: every screen here uses h1 then h2 only.
    const firstH2 = res.body.search(/<h2[ >]/);
    const firstH3 = res.body.search(/<h3[ >]/);
    if (firstH3 !== -1) assert.ok(firstH2 !== -1 && firstH2 < firstH3, `${name}: an h3 before any h2`);
  }
  const media = await get('/admin/t/acme/media');
  // The lock is announced, not tinted: three separate statements of state.
  assert.match(figureOf(media.body, 'vault/paid'), /No preview[\s\S]*Needs a code|Needs a code[\s\S]*No preview/);
  // And colour is never the only carrier of state.
  for (const state of ['Live', 'Draft', 'Hidden']) {
    assert.match((await get('/admin')).body, new RegExp(`>${state}<`), `the word ${state} must be in the document`);
  }
});

// --- the policy the browser will actually enforce --------------------------

test('S7-8. the admin document carries the frozen policy plus one nonce, and the public site carries neither', async () => {
  const page = await call({ port, path: '/pricing', host: ADMIN_HOST });
  assert.equal(page.status, 200);
  assert.equal(page.headers['content-security-policy'], cspPolicy(), 'the public document is byte-identical to the frozen policy');
  assert.doesNotMatch(page.body, /nonce=/);

  const admin = await call({ port, path: '/admin/login', host: ADMIN_HOST });
  const policy = String(admin.headers['content-security-policy']);
  const nonce = /'nonce-([A-Za-z0-9+/=]+)'/.exec(policy)?.[1];
  assert.ok(nonce !== undefined, `the admin policy has no nonce: ${policy}`);
  // The policy is the frozen one plus exactly two nonce sources — nothing else moved.
  assert.equal(policy.split(" 'nonce-" + nonce + "'").length, 3, 'the nonce must appear in script-src and style-src only');
  assert.equal(policy.replaceAll(` 'nonce-${nonce}'`, ''), cspPolicy());
  // …and the document's one style element carries it, or the browser drops the styles.
  assert.match(admin.body, new RegExp(`<style nonce="${nonce.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}">`));
});
