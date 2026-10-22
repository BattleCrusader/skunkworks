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

function get(path: string): Promise<Res> {
  return call({ port, path, host: HOST });
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
