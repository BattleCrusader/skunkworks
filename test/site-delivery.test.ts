/**
 * S8r — the paperwork a browser and a crawler ask for first.
 *
 * A Lighthouse run against the live tenant scored **SEO 90**, and the missing ten points were one
 * audit: `meta-description`. Around it, three files a static Astro build gets for free from
 * `public/` were 404s on the CMS: `/robots.txt`, `/sitemap.xml` and — on every single page load —
 * `/favicon.ico`.
 *
 * These tests hold the answers to what those requests now get, and the two properties that make
 * the answers safe: a draft page is not in the sitemap, and a site that has set no description
 * emits no tag (which is what keeps the exported document byte-identical).
 */
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';

import { loadEnv } from '../app/env.ts';
import { buildApp, type AppHandle } from '../app/main.ts';
import { ADMIN_HOST } from './helpers/admin.ts';
import { makeFixture, type Fixture } from './helpers/fixture.ts';
import { call, header, type Res } from './helpers/http.ts';

let fixture: Fixture;
let handle: AppHandle;
let port = 0;

const HOST = 'acme.test';
const ORIGIN = `https://${HOST}`;

/**
 * S8t: the artwork a themed tenant ships, as a *file*. This is what a deploy installs
 * (`tenants/<key>/theme-assets/<themeKey>/assets/favicon.svg`), and the point of the fixture is
 * that there is no `cms_theme_asset` row for it: the route reads the file, because a file is what
 * an operator can drop in.
 */
const THEME_KEY = 'beta-mark';
const THEME_MARK =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="#b4400f"/><path d="M8 8h16v6H8z" fill="#ffffff"/><path d="M8 18h10v6H8z" fill="#ffffff"/></svg>';

function themeMarkFile(): string {
  return join(fixture.dir, 'tenants', 'beta', 'theme-assets', THEME_KEY, 'assets', 'favicon.svg');
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The IHDR's width and height: 8 signature bytes, 4 length, `IHDR`, then two big-endian u32s. */
function pngSize(png: Buffer): { width: number; height: number; bitDepth: number } {
  assert.equal(png.subarray(0, 8).toString('latin1'), '\u0089PNG\r\n\u001a\n', 'not a PNG at all');
  assert.equal(png.subarray(12, 16).toString('latin1'), 'IHDR', 'a PNG with no IHDR where it belongs');
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20), bitDepth: png.readUInt8(24) };
}

function get(path: string): Promise<Res> {
  return call({ port, path, host: HOST });
}

/** A second tenant, so the two icons can be compared without one test's settings leaking. */
function themedGet(path: string): Promise<Res> {
  return call({ port, path, host: 'beta.test' });
}

function listen(app: AppHandle): Promise<number> {
  return app.app.listen({ port: 0, host: '127.0.0.1' }).then(() => {
    const address = app.app.server.address();
    return typeof address === 'object' && address !== null ? address.port : 0;
  });
}

function setting(key: string, value: string): void {
  const db = new Database(fixture.sitePath('acme'));
  try {
    db.prepare(
      `INSERT INTO cms_settings (key, value_json, type) VALUES (?, ?, 'string')
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
    ).run(key, JSON.stringify(value));
  } finally {
    db.close();
  }
}

before(async () => {
  fixture = makeFixture();
  // The fixture seeds one published page (`/pricing`, title "Acme pricing"). A draft page is the
  // one thing a sitemap must never carry, so there is one to be absent.
  const db = new Database(fixture.sitePath('acme'));
  db.prepare(
    `INSERT INTO cms_page (path, slug, title, status, template, body_html, body_css, body_sha, created_at, updated_at)
     VALUES ('/secret', 'secret', 'Not yet', 'draft', 'page', '<h1>Not yet</h1>', '', '', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`,
  ).run();
  db.close();

  // The themed tenant: a theme row, the pointer that makes it active, and the mark on disk. The
  // artwork is written *after* `makeFixture` because it lives beside the tenant, not in the DB.
  const beta = new Database(fixture.sitePath('beta'));
  try {
    const css = ':root{--ink:#202020}';
    const cssSha = sha256(Buffer.from(css, 'utf8'));
    beta.prepare('INSERT INTO cms_css_blob (sha256, css, bytes) VALUES (?, ?, ?)').run(
      cssSha,
      css,
      Buffer.byteLength(css),
    );
    beta.prepare("INSERT INTO cms_theme (theme_key, name, css_sha256) VALUES (?, 'Beta mark', ?)").run(
      THEME_KEY,
      cssSha,
    );
    beta.prepare(
      `INSERT INTO cms_settings (key, value_json, type) VALUES ('site.theme_key', ?, 'string')
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
    ).run(JSON.stringify(THEME_KEY));
  } finally {
    beta.close();
  }
  const markFile = themeMarkFile();
  mkdirSync(dirname(markFile), { recursive: true });
  writeFileSync(markFile, THEME_MARK);

  handle = await buildApp({ env: loadEnv(fixture.env) });
  port = await listen(handle);
});

after(() => {
  handle.app.close();
  fixture.cleanup();
});

test('D1. robots.txt allows the site and names the sitemap', async () => {
  const res = await get('/robots.txt');
  assert.equal(res.status, 200, res.body);
  assert.match(String(header(res, 'content-type')), /text\/plain/);
  assert.match(res.body, /^User-agent: \*$/m);
  assert.match(res.body, /^Allow: \/$/m);
  assert.match(res.body, new RegExp(`^Sitemap: ${ORIGIN}/sitemap\\.xml$`, 'm'));
  assert.match(String(header(res, 'cache-control')), /max-age=3600/);
});

test('D2. the sitemap lists published pages, and never a draft', async () => {
  const res = await get('/sitemap.xml');
  assert.equal(res.status, 200, res.body);
  assert.match(String(header(res, 'content-type')), /application\/xml/);
  assert.match(res.body, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
  assert.match(res.body, new RegExp(`<loc>${ORIGIN}/pricing</loc>`));
  assert.match(res.body, /<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/);
  assert.doesNotMatch(res.body, /\/secret/, 'a draft page must not be published by the sitemap');
});

test('D3. a favicon answers 200 as a real PNG, not a 404 on every page load', async () => {
  const res = await get('/favicon.ico');
  assert.equal(res.status, 200);
  assert.equal(String(header(res, 'content-type')), 'image/png');
  // The PNG signature, byte for byte, so this cannot pass on an HTML error page wearing the
  // right content type. Read from `bytes`: UTF-8 decoding would rewrite 0x89.
  const png = res.bytes;
  assert.notEqual(png, undefined, 'the client kept the bytes');
  assert.deepEqual([...(png as Buffer).subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.ok((png as Buffer).length > 100, `a real icon, got ${(png as Buffer).length} bytes`);
  assert.match(String(header(res, 'cache-control')), /max-age=86400/);

  const svg = await get('/favicon.svg');
  assert.equal(svg.status, 200);
  assert.match(String(header(svg, 'content-type')), /image\/svg\+xml/);
  assert.match(svg.body, /<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
});

test('D4. a page carries no script at all — and the prefetch experiment is gone with its reason', async () => {
  // A `rel=prefetch` on hover was built for this, then measured: site documents are
  // `cache-control: no-store`, so Chrome discards the prefetched response and the click still costs
  // a full request (`fromPrefetchCache: false`, `transferSize: 1991`). The script and its route
  // were removed; this test holds both halves of that decision, so neither half can come back
  // without the other being reconsidered.
  const page = await get('/pricing');
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.body, /<script/, 'the public shell loads no script');
  const gone = await get('/skw-nav.js');
  assert.equal(gone.status, 404, 'the prefetch route was removed with the script');
});

test('D5. a site with no description emits no meta tag — the exported document stays identical', async () => {
  const res = await get('/pricing');
  assert.equal(res.status, 200, res.body);
  assert.doesNotMatch(res.body, /<meta name="description"/);
});

test('D6. with a description set, the page carries it and the stylesheet is versioned and immutable', async () => {
  setting('site.description', 'Acme pays less: the widget people keep.');
  setting('site.title', 'Acme');
  setting('site.theme_css', ':root{--ink:#101010}');

  const res = await get('/pricing');
  assert.equal(res.status, 200, res.body);
  assert.match(res.body, /<meta name="description" content="Acme pays less: the widget people keep\.">/);

  const href = /<link rel="stylesheet" href="(\/theme\.css\?v=[0-9a-f]{12})">/.exec(res.body)?.[1];
  assert.notEqual(href, undefined, `a versioned stylesheet, got: ${res.body.slice(0, 400)}`);

  // The versioned URL may be cached for a year: its bytes are named in it.
  const versioned = await get(String(href));
  assert.equal(versioned.status, 200);
  assert.match(String(header(versioned, 'cache-control')), /max-age=31536000, immutable/);
  assert.match(versioned.body, /--ink:#101010/);

  // The unversioned URL still answers and still revalidates — no stale-CSS trap for a document
  // cached before this existed.
  const plain = await get('/theme.css');
  assert.equal(plain.status, 200);
  assert.match(String(header(plain, 'cache-control')), /max-age=0, must-revalidate/);

  // A version that does not match the bytes it would get is not immutable.
  const bogus = await get('/theme.css?v=000000000000');
  assert.match(String(header(bogus, 'cache-control')), /max-age=0, must-revalidate/);
});

test('D7. the description is escaped into the attribute, not trusted', async () => {
  setting('site.description', 'Widgets & "gadgets" <script>alert(1)</script>');
  const res = await get('/pricing');
  assert.equal(res.status, 200);
  // `&` and `"` escaped by Astro's attribute writer; the angle brackets are gone entirely, so the
  // head cannot even look like it carries markup. `alert(1)` stays as text inside the attribute.
  assert.match(res.body, /content="Widgets &amp; &quot;gadgets&quot; scriptalert\(1\)\/script"/);
  assert.doesNotMatch(res.body, /<script>alert/);
});

test('D8. a themed tenant serves its own artwork at /favicon.svg, byte for byte', async () => {
  const res = await themedGet('/favicon.svg');
  assert.equal(res.status, 200);
  assert.equal(String(header(res, 'content-type')), 'image/svg+xml; charset=utf-8');
  assert.match(String(header(res, 'cache-control')), /max-age=86400/);
  const bytes = res.bytes;
  assert.notEqual(bytes, undefined, 'the client kept the bytes');
  // The file's bytes, not a re-render of them: a designer's SVG is what the browser must get.
  assert.equal(sha256(bytes as Buffer), sha256(Buffer.from(THEME_MARK, 'utf8')));
  assert.equal((bytes as Buffer).toString('utf8'), THEME_MARK);
  assert.doesNotMatch(res.body, /<text/, 'the artwork, not the generated letter tile');
});

test('D9. a tenant with no artwork still gets the generated tile — 200, never a 404', async () => {
  const res = await get('/favicon.svg');
  assert.equal(res.status, 200);
  assert.equal(String(header(res, 'content-type')), 'image/svg+xml; charset=utf-8');
  assert.match(res.body, /<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 64 64"/);
  // The fallback is the letter tile, `<text>` and all — the artwork path is what has to win.
  assert.match(res.body, /<text /);
});

test('D10. /apple-touch-icon.png is a real 180×180 PNG, and the two tenants do not share one', async () => {
  const themed = await themedGet('/apple-touch-icon.png');
  assert.equal(themed.status, 200);
  assert.equal(String(header(themed, 'content-type')), 'image/png');
  assert.match(String(header(themed, 'cache-control')), /max-age=86400/);
  const png = themed.bytes as Buffer;
  assert.notEqual(png, undefined);
  const size = pngSize(png);
  assert.deepEqual([size.width, size.height], [180, 180]);
  assert.ok(png.length > 400, `a real raster, got ${png.length} bytes`);

  const letter = await get('/apple-touch-icon.png');
  assert.equal(letter.status, 200);
  const letterSize = pngSize(letter.bytes as Buffer);
  assert.deepEqual([letterSize.width, letterSize.height], [180, 180]);
  assert.notEqual(sha256(png), sha256(letter.bytes as Buffer), 'two tenants, one raster: the artwork never reached the PNG');
});

test('D11. /favicon.ico is rasterised from the artwork, so the two tenants differ', async () => {
  const themed = await themedGet('/favicon.ico');
  const letter = await get('/favicon.ico');
  for (const res of [themed, letter]) {
    assert.equal(res.status, 200);
    assert.equal(String(header(res, 'content-type')), 'image/png');
    const size = pngSize(res.bytes as Buffer);
    assert.deepEqual([size.width, size.height], [32, 32]);
  }
  // The defect this replaces: both tenants answered one 291-byte blank tile.
  assert.notEqual(sha256(themed.bytes as Buffer), sha256(letter.bytes as Buffer));
});

test('D12. the public page names both icons, so the browser stops falling back to a blank tile', async () => {
  for (const [where, res] of [
    ['acme', await get('/pricing')],
    ['beta', await themedGet('/pricing')],
  ] as const) {
    assert.equal(res.status, 200, `${where}: ${res.status}`);
    assert.match(res.body, /<link rel="icon" type="image\/svg\+xml" href="\/favicon\.svg">/, `${where}: no icon link`);
    assert.match(
      res.body,
      /<link rel="apple-touch-icon" href="\/apple-touch-icon\.png">/,
      `${where}: no apple-touch-icon link`,
    );
    // Still no script: this change adds links and nothing else.
    assert.doesNotMatch(res.body, /<script/);
  }
});

test('D13. replacing the artwork is picked up without a restart — the cache is keyed by the file', async () => {
  const before = await themedGet('/favicon.ico');
  assert.equal(before.status, 200);
  const next = THEME_MARK.replace('#b4400f', '#0b1f33');
  // A distinct mtime: the key is (tenant, size, mtime, size-in-bytes), so this must be visible
  // even though the process has already cached a raster for the previous file.
  writeFileSync(themeMarkFile(), next);
  const after = await themedGet('/favicon.ico');
  assert.equal(after.status, 200);
  assert.notEqual(sha256(before.bytes as Buffer), sha256(after.bytes as Buffer), 'a stale raster survived the artwork change');
  const svg = await themedGet('/favicon.svg');
  assert.equal(svg.body, next);
});
