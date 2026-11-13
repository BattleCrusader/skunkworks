/**
 * Per-page search-engine visibility, and the admin surface's absolute one.
 *
 * Two features with one word between them, and the difference is the point:
 *
 *   a hidden PAGE   `<meta name="robots" content="noindex">` + `X-Robots-Tag: noindex`, dropped
 *                   from `/sitemap.xml`, still served to a person at its address. `follow` is
 *                   left on — its links are ordinary links.
 *   the ADMIN       `X-Robots-Tag: noindex, nofollow` on **every** response under `/admin` and
 *                   `/fleet` (login page, API, redirects, unknown routes), plus the same claim in
 *                   each admin document's `<head>`, plus `Disallow: /admin` in `/robots.txt`.
 *
 *   PV-1  `seo_json` round-trips `robots`: write → parse → head tag → read back
 *   PV-2  the writer preserves every other key and refuses invalid JSON by name
 *   PV-3  a hidden page is noindex in the document AND the header, and absent from the sitemap,
 *         and still renders for a human
 *   PV-4  an indexable page is byte-unchanged — no tag, no header, still in the sitemap — and
 *         storing `"index"` is a no-op rather than a rewrite
 *   PV-5  `/robots.txt` names `/admin` and `/fleet`
 *   PV-6  every admin answer carries the header, including one route-per-verb and one path that
 *         does not exist — the check that the rule is central and not route-by-route
 *   PV-7  the admin shell's document carries the meta tag
 *   PV-8  the Pages screen offers the control, shows the state, and a post survives a reload
 *   PV-9  a token-less post is refused and writes nothing (the control is not a new write surface)
 *   PV-10 the toggle touches `seo_json` only: rev, status, published_at and the draft columns hold
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { openAdminWrite } from '../app/db/classes.ts';
import { loadEnv } from '../app/env.ts';
import { buildApp, type AppHandle } from '../app/main.ts';
import { pageRobots, pageSeoHead, parsePageSeo, withPageRobots } from '../app/render/seo.ts';
import { ADMIN_HOST, ADMIN_ORIGIN, TOTP_SECRET, openSession, seedUser, type Sessioned } from './helpers/admin.ts';
import { makeFixture, type Fixture } from './helpers/fixture.ts';
import { call, header, type Res } from './helpers/http.ts';

const TENANT = 'acme';
const HOST = 'acme.test';
const OWNER = 'pages@acme.test';

let fixture: Fixture;
let handle: AppHandle;
let port = 0;
let session: Sessioned;

function write(query: (db: ReturnType<typeof openAdminWrite>) => void): void {
  const db = openAdminWrite(fixture.sitePath(TENANT), 5000);
  try {
    query(db);
  } finally {
    db.close();
  }
}

function read<T>(query: (db: ReturnType<typeof openAdminWrite>) => T): T {
  const db = openAdminWrite(fixture.sitePath(TENANT), 5000);
  try {
    return query(db);
  } finally {
    db.close();
  }
}

async function get(path: string): Promise<Res> {
  return call({ port, path, host: HOST });
}

/** The page id of `/pricing`, the one row the fixture seeds. */
function pricingId(): number {
  return read((db) => (db.prepare("SELECT id FROM cms_page WHERE path = '/pricing'").get() as { id: number }).id);
}

function seoOf(path: string): string | null {
  return read(
    (db) => (db.prepare('SELECT seo_json FROM cms_page WHERE path = ?').get(path) as { seo_json: string | null }).seo_json,
  );
}

function head(body: string): string {
  const end = body.indexOf('</head>');
  assert.ok(end > 0, 'the document has a head');
  return body.slice(0, end);
}

function sitemapHas(body: string, path: string): boolean {
  return body.includes(`<loc>https://${HOST}${path}</loc>`);
}

before(async () => {
  fixture = makeFixture({
    specs: [{ key: TENANT, hosts: [HOST], title: 'Acme', body: '<h1>Fractional engineering</h1><p>Two days a week.</p>' }],
  });
  await seedUser({ controlDb: fixture.controlDb, tenantKey: TENANT, email: OWNER, totpSecret: TOTP_SECRET });
  handle = await buildApp({ env: loadEnv(fixture.env) });
  await handle.app.listen({ port: 0, host: '127.0.0.1' });
  const address = handle.app.server.address();
  port = typeof address === 'object' && address !== null ? address.port : 0;
  session = await openSession({ port, key: TENANT, email: OWNER });
});

after(async () => {
  await handle.close();
  fixture.cleanup();
});

test('PV-1. robots round-trips: written → parsed → in the head → read back', () => {
  const written = withPageRobots(null, 'noindex');
  assert.ok(written.ok);
  assert.deepEqual(JSON.parse(String(written.json)), { robots: 'noindex' });

  const parsed = parsePageSeo(written.json);
  assert.equal(parsed?.robots, 'noindex');
  assert.equal(pageRobots(written.json), 'noindex');

  const markup = pageSeoHead({
    seo: parsed ?? {},
    path: '/pricing',
    documentTitle: 'Acme pricing',
    siteName: 'Acme',
    origin: 'https://acme.test',
  });
  assert.match(markup, /<meta name="robots" content="noindex">/);
  // The tag is the first thing in the head fragment: it decides whether the rest is read.
  assert.ok(markup.startsWith('<meta name="robots" content="noindex">'), markup.slice(0, 60));
  // …and it does not forbid following: a hidden page's links are ordinary links.
  assert.doesNotMatch(markup, /nofollow/);

  // Back to indexable: the key is removed, and the column goes back to NULL when nothing is left.
  const cleared = withPageRobots(written.json, 'index');
  assert.ok(cleared.ok);
  assert.equal(cleared.json, null);
  assert.equal(pageRobots(null), 'index');
});

test('PV-2. the writer keeps every other key, and refuses invalid JSON instead of overwriting it', () => {
  const raw = JSON.stringify({ description: 'Senior engineers.', canonical: 'https://acme.test/x', unknownKey: 7 });
  const hidden = withPageRobots(raw, 'noindex');
  assert.ok(hidden.ok);
  const parsed = JSON.parse(String(hidden.json)) as Record<string, unknown>;
  assert.equal(parsed.description, 'Senior engineers.');
  assert.equal(parsed.canonical, 'https://acme.test/x');
  assert.equal(parsed.unknownKey, 7, 'a key this module does not understand is still the operator’s data');
  assert.equal(parsed.robots, 'noindex');

  const broken = withPageRobots('{not json', 'noindex');
  assert.equal(broken.ok, false);
  assert.match(broken.ok === false ? broken.reason : '', /not JSON/);
  const array = withPageRobots('[1,2]', 'noindex');
  assert.equal(array.ok, false);
});

test('PV-3. a hidden page: noindex in the document and the header, gone from the sitemap, still served', async () => {
  write((db) => {
    db.prepare("UPDATE cms_page SET seo_json = ? WHERE path = '/pricing'").run(JSON.stringify({ robots: 'noindex' }));
  });

  const res = await get('/pricing');
  assert.equal(res.status, 200, 'hiding from search is not unpublishing');
  assert.match(res.body, /<h1>Fractional engineering<\/h1>/, 'the body is still the page');
  assert.match(head(res.body), /<meta name="robots" content="noindex">/);
  assert.equal(header(res, 'x-robots-tag'), 'noindex', 'the header a crawler reads before the body');
  assert.doesNotMatch(String(header(res, 'x-robots-tag')), /nofollow/);

  const sitemap = await get('/sitemap.xml');
  assert.equal(sitemap.status, 200);
  assert.equal(sitemapHas(sitemap.body, '/pricing'), false, 'a `<loc>` is an invitation to crawl it');
});

test('PV-4. an indexable page is byte-unchanged, and storing "index" is a no-op', async () => {
  write((db) => {
    db.prepare("UPDATE cms_page SET seo_json = NULL WHERE path = '/pricing'").run();
  });
  const plain = await get('/pricing');
  assert.equal(plain.status, 200);
  assert.doesNotMatch(head(plain.body), /name="robots"/);
  assert.equal(header(plain, 'x-robots-tag'), undefined, 'no header, exactly as before this existed');
  assert.equal(sitemapHas((await get('/sitemap.xml')).body, '/pricing'), true, 'still in the sitemap');

  // "Indexable" is the default, so an operator saving it must not rewrite the row into a document
  // that carries a card and a canonical it never had. Same bytes, column by column.
  write((db) => {
    db.prepare("UPDATE cms_page SET seo_json = ? WHERE path = '/pricing'").run(JSON.stringify({ robots: 'index' }));
  });
  const explicit = await get('/pricing');
  assert.equal(explicit.body, plain.body, 'the whole document is identical, byte for byte');
  assert.equal(header(explicit, 'x-robots-tag'), undefined);

  // And a page with real metadata gains nothing from this feature: the head is the head it had.
  write((db) => {
    db.prepare("UPDATE cms_page SET seo_json = ? WHERE path = '/pricing'").run(
      JSON.stringify({ description: 'Two days a week.', robots: 'index' }),
    );
  });
  const withSeo = await get('/pricing');
  assert.doesNotMatch(head(withSeo.body), /name="robots"/);
  assert.match(head(withSeo.body), /<meta name="description" content="Two days a week.">/);
});

test('PV-5. robots.txt names the two admin prefixes', async () => {
  const res = await get('/robots.txt');
  assert.equal(res.status, 200);
  assert.match(res.body, /^Disallow: \/admin$/m);
  assert.match(res.body, /^Disallow: \/fleet$/m);
  assert.match(res.body, /^Disallow: \/search$/m, 'the results pages stay disallowed');
  assert.match(res.body, new RegExp(`^Sitemap: https://${HOST.replace(/\./g, '\\.')}/sitemap\\.xml$`, 'm'));
});

test('PV-6. every admin answer carries X-Robots-Tag, including one that does not exist', async () => {
  // The login page: the one admin URL that answers 200 to a stranger.
  const login = await get('/admin/login');
  assert.equal(login.status, 200, login.body.slice(0, 200));
  assert.equal(header(login, 'x-robots-tag'), 'noindex, nofollow');

  // The tenant home: a 302 to the login page for a caller with no session — a redirect, where a
  // header written by a route handler is easiest to lose.
  const home = await get(`/admin/t/${TENANT}/`);
  assert.ok([302, 404].includes(home.status), `unexpected ${home.status}`);
  assert.equal(header(home, 'x-robots-tag'), 'noindex, nofollow');

  // The JSON API, both authenticated and not.
  const api = await get(`/admin/t/${TENANT}/pages`);
  assert.equal(header(api, 'x-robots-tag'), 'noindex, nofollow');
  const apiAuthed = await call({ port, path: `/admin/t/${TENANT}/pages`, host: HOST, headers: { cookie: session.cookie } });
  assert.equal(apiAuthed.status, 200, apiAuthed.body.slice(0, 200));
  assert.equal(header(apiAuthed, 'x-robots-tag'), 'noindex, nofollow');

  // A POST: the CSRF refusal path (403) keeps the header too.
  const refused = await call({
    port,
    path: `/admin/t/${TENANT}/session/rotate`,
    method: 'POST',
    host: HOST,
    headers: { 'content-type': 'application/json', cookie: session.cookie },
    body: '{}',
  });
  assert.equal(refused.status, 403, refused.body.slice(0, 200));
  assert.equal(header(refused, 'x-robots-tag'), 'noindex, nofollow');

  // The proof that this is not route-by-route: a path no route mentions still carries it, because
  // the header is written before routing (an `onRequest` hook on the root instance).
  const nowhere = await get('/admin/a-route-that-was-never-written');
  assert.equal(header(nowhere, 'x-robots-tag'), 'noindex, nofollow');
  const fleetNowhere = await get('/fleet/a-route-that-was-never-written');
  assert.equal(header(fleetNowhere, 'x-robots-tag'), 'noindex, nofollow');

  // …and a public page is untouched by it.
  const page = await get('/pricing');
  assert.equal(header(page, 'x-robots-tag'), undefined);
});

test('PV-7. the admin shell carries the meta tag as well as the header', async () => {
  const login = await get('/admin/login');
  assert.match(head(login.body), /<meta name="robots" content="noindex, nofollow">/);
  const home = await call({ port, path: `/admin/t/${TENANT}/`, host: HOST, headers: { cookie: session.cookie } });
  assert.equal(home.status, 200, home.body.slice(0, 200));
  assert.match(head(home.body), /<meta name="robots" content="noindex, nofollow">/);
});

test('PV-8. the Pages screen offers the control, shows the state, and a post persists', async () => {
  write((db) => {
    db.prepare("UPDATE cms_page SET seo_json = NULL WHERE path = '/pricing'").run();
  });
  const before = await call({ port, path: `/admin/t/${TENANT}/`, host: HOST, headers: { cookie: session.cookie } });
  assert.equal(before.status, 200);
  // One form per row, choosing between the two states, with the current one selected.
  assert.match(before.body, new RegExp(`method="post" action="/admin/t/${TENANT}/pages/visibility"`));
  assert.match(before.body, /<option value="index" selected>In search results<\/option>/);
  assert.match(before.body, /<option value="noindex">Hidden from search<\/option>/);
  assert.match(before.body, /name="csrf" value="[^"]+"/);
  assert.match(before.body, new RegExp(`data-page-id="${pricingId()}" data-status="published" data-draft="0" data-robots="index"`));
  assert.doesNotMatch(before.body, /not in search/);

  const posted = await call({
    port,
    path: `/admin/t/${TENANT}/pages/visibility`,
    method: 'POST',
    host: HOST,
    headers: { origin: ADMIN_ORIGIN, 'content-type': 'application/x-www-form-urlencoded', cookie: session.cookie },
    body: new URLSearchParams({ csrf: session.csrfToken, page_id: String(pricingId()), robots: 'noindex' }).toString(),
  });
  assert.equal(posted.status, 303, posted.body.slice(0, 200));
  assert.equal(header(posted, 'location'), `/admin/t/${TENANT}/?robots=1`);
  assert.equal(header(posted, 'x-robots-tag'), 'noindex, nofollow');

  // Persisted on the row…
  assert.equal(pageRobots(seoOf('/pricing')), 'noindex');
  // …and visible without opening the page, after the redirect.
  const after = await call({ port, path: `/admin/t/${TENANT}/?robots=1`, host: HOST, headers: { cookie: session.cookie } });
  assert.match(after.body, /data-robots="noindex"/);
  assert.match(after.body, /not in search/);
  assert.match(after.body, /<option value="noindex" selected>Hidden from search<\/option>/);
  assert.match(after.body, /Search visibility saved\./);

  // Back to indexable, so the rest of the suite (and the next run) starts from the default.
  const back = await call({
    port,
    path: `/admin/t/${TENANT}/pages/visibility`,
    method: 'POST',
    host: HOST,
    headers: { origin: ADMIN_ORIGIN, 'content-type': 'application/x-www-form-urlencoded', cookie: session.cookie },
    body: new URLSearchParams({ csrf: session.csrfToken, page_id: String(pricingId()), robots: 'index' }).toString(),
  });
  assert.equal(back.status, 303);
  assert.equal(seoOf('/pricing'), null, 'index is the default, so the column goes back to NULL');
});

test('PV-9. the visibility write is origin- and CSRF-guarded like every other write', async () => {
  const noToken = await call({
    port,
    path: `/admin/t/${TENANT}/pages/visibility`,
    method: 'POST',
    host: HOST,
    headers: { origin: ADMIN_ORIGIN, 'content-type': 'application/x-www-form-urlencoded', cookie: session.cookie },
    body: new URLSearchParams({ page_id: String(pricingId()), robots: 'noindex' }).toString(),
  });
  assert.equal(noToken.status, 403);
  assert.equal(seoOf('/pricing'), null, 'nothing was written');

  const noOrigin = await call({
    port,
    path: `/admin/t/${TENANT}/pages/visibility`,
    method: 'POST',
    host: HOST,
    headers: { origin: 'https://evil.test', 'content-type': 'application/x-www-form-urlencoded', cookie: session.cookie },
    body: new URLSearchParams({ csrf: session.csrfToken, page_id: String(pricingId()), robots: 'noindex' }).toString(),
  });
  assert.equal(noOrigin.status, 403);
  assert.equal(seoOf('/pricing'), null, 'still nothing');

  const noSession = await call({
    port,
    path: `/admin/t/${TENANT}/pages/visibility`,
    method: 'POST',
    host: HOST,
    headers: { origin: ADMIN_ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf: session.csrfToken, page_id: String(pricingId()), robots: 'noindex' }).toString(),
  });
  assert.ok([302, 403, 404].includes(noSession.status), `unexpected ${noSession.status}`);
  assert.equal(seoOf('/pricing'), null);
});

test('PV-10. the toggle writes seo_json and nothing else', async () => {
  // A draft-bearing page: rev, a pending draft and a publish date that the toggle must not touch.
  write((db) => {
    db.prepare(
      `UPDATE cms_page SET status = 'published', rev = 3, draft_sha = ?, draft_html = '<h2>Draft</h2>',
              published_at = '2026-01-01T00:00:00.000Z', seo_json = NULL WHERE path = '/pricing'`,
    ).run('a'.repeat(64));
  });
  const before = read((db) =>
    db.prepare('SELECT status, rev, draft_sha, published_at, updated_at, body_html FROM cms_page WHERE path = ?').get('/pricing'),
  ) as Record<string, unknown>;

  const posted = await call({
    port,
    path: `/admin/t/${TENANT}/pages/visibility`,
    method: 'POST',
    host: HOST,
    headers: { origin: ADMIN_ORIGIN, 'content-type': 'application/x-www-form-urlencoded', cookie: session.cookie },
    body: new URLSearchParams({ csrf: session.csrfToken, page_id: String(pricingId()), robots: 'noindex' }).toString(),
  });
  assert.equal(posted.status, 303);

  const after = read((db) =>
    db.prepare('SELECT status, rev, draft_sha, published_at, updated_at, body_html, seo_json FROM cms_page WHERE path = ?').get('/pricing'),
  ) as Record<string, unknown>;
  for (const column of ['status', 'rev', 'draft_sha', 'published_at', 'updated_at', 'body_html']) {
    assert.deepEqual(after[column], before[column], `${column} is not a search-visibility column`);
  }
  assert.deepEqual(JSON.parse(String(after.seo_json)), { robots: 'noindex' });

  // Clean up so the fixture's row is the one every other gate expects.
  write((db) => {
    db.prepare("UPDATE cms_page SET seo_json = NULL, draft_sha = '', draft_html = '' WHERE path = '/pricing'").run();
  });
});
