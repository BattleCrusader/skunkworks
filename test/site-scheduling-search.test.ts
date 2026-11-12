/**
 * **Scheduling and site search** — two features the marketing site's own price list now promises,
 * and the rules that keep them from lying.
 *
 * Scheduling: `cms_page.published_at` is when a page goes live, and it may be in the future. A
 * published page that is not due is as invisible as a draft — in the renderer, in the sitemap, in
 * the nav resolver, in the exporter and in search results. One predicate
 * (`app/render/visibility.ts`) answers all five, and this file is what stops them drifting apart.
 *
 * Search: `GET /search?q=…` reads `cms_page` and nothing else. It must find what a page says,
 * must not find what a visitor cannot see, must not let `%` or `_` become a wildcard, and must not
 * echo the query into the document unescaped.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import type Database from 'better-sqlite3';

import { openAdminWrite } from '../app/db/classes.ts';
import { loadRegistry } from '../app/editor/registry.ts';
import { publishPage } from '../app/editor/publish.ts';
import { loadEnv } from '../app/env.ts';
import { buildApp, type AppHandle } from '../app/main.ts';
import { ADMIN_HOST, ADMIN_ORIGIN, TOTP_SECRET, openSession, seedUser, type Sessioned } from './helpers/admin.ts';
import { SCHEMA, makeFixture, type Fixture } from './helpers/fixture.ts';
import { call, header, type Res } from './helpers/http.ts';

const registry = loadRegistry(SCHEMA);
const HOST = 'acme.test';
const PAST = '2026-01-01T00:00:00.000Z';
const FAR_FUTURE = '2999-01-01T00:00:00.000Z';

let fixture: Fixture;
let handle: AppHandle;
let port = 0;
let session: Sessioned;

function siteDb(): Database.Database {
  return openAdminWrite(fixture.sitePath('acme'));
}

function visit(path: string): Promise<Res> {
  return call({ port, path, host: HOST });
}

/** Insert a page directly. `published_at` decides visibility; `status` alone no longer does. */
function put(path: string, opts: { status?: string; publishedAt?: string | null; body?: string; draft?: string }): number {
  const slug = path === '/' ? 'home' : path.replace(/^\//, '');
  const db = siteDb();
  try {
    const info = db
      .prepare(
        `INSERT INTO cms_page
           (path, slug, title, status, template, body_html, body_css, rev, body_sha,
            draft_html, draft_css, draft_sha, published_at)
         VALUES (?, ?, ?, ?, 'page', ?, '', 1, ?, ?, '', ?, ?)`,
      )
      .run(
        path,
        slug,
        `Page ${path}`,
        opts.status ?? 'published',
        opts.body ?? `<p>${slug} text</p>`,
        'a'.repeat(64),
        opts.draft ?? '',
        opts.draft === undefined || opts.draft === '' ? '' : 'd'.repeat(64),
        opts.publishedAt === undefined ? PAST : opts.publishedAt,
      );
    return Number(info.lastInsertRowid);
  } finally {
    db.close();
  }
}

function setPublishedAt(id: number, at: string | null): void {
  const db = siteDb();
  try {
    db.prepare('UPDATE cms_page SET published_at = ? WHERE id = ?').run(at, id);
  } finally {
    db.close();
  }
}

before(async () => {
  fixture = makeFixture({ specs: [{ key: 'acme', hosts: [HOST], title: 'Acme' }] });
  await seedUser({ controlDb: fixture.controlDb, tenantKey: 'acme', email: 'owner@acme.test', totpSecret: TOTP_SECRET });

  put('/', { body: '<p>A page about the <b>Kumquat</b> harvest.</p>' });
  put('/draft-page', { status: 'draft', body: '<p>Kumquat unfinished</p>' });
  put('/hidden-page', { status: 'hidden', body: '<p>Kumquat private</p>' });
  put('/scheduled-page', { publishedAt: FAR_FUTURE, body: '<p>Zebra crossing</p>' });

  handle = await buildApp({ env: loadEnv(fixture.env) });
  port = await handle.app
    .listen({ port: 0, host: '127.0.0.1' })
    .then(() => (handle.app.server.address() as { port: number }).port);
  session = await openSession({ port, key: 'acme', email: 'owner@acme.test' });
});

after(async () => {
  await handle.close();
  fixture.cleanup();
});

async function publishViaRoute(id: number, publishAt?: string): Promise<Res> {
  return call({
    port,
    path: '/admin/t/acme/editor/publish',
    method: 'POST',
    host: ADMIN_HOST,
    headers: {
      origin: ADMIN_ORIGIN,
      cookie: session.cookie,
      'x-csrf-token': session.csrfToken,
      'content-type': 'application/json',
    },
    body: JSON.stringify(publishAt === undefined ? { id } : { id, publish_at: publishAt }),
  });
}

// --- 1. scheduling ---------------------------------------------------------------

test('SCH-1. a published page whose moment has not arrived is a 404 to a visitor', async () => {
  const res = await visit('/scheduled-page');
  assert.equal(res.status, 404, res.body);
});

test('SCH-2. …and it is absent from the sitemap, which lists only what is live', async () => {
  const res = await visit('/sitemap.xml');
  assert.equal(res.status, 200, res.body);
  assert.doesNotMatch(res.body, /\/scheduled-page/, 'a scheduled page must not be handed to a crawler');
  assert.match(res.body, /<loc>[^<]*\/<\/loc>/, 'the live home page is still listed');
});

test('SCH-3. publishing with a future time schedules rather than publishes', async () => {
  const id = put('/due-later', { status: 'draft', body: '', draft: '<p>Tuesday copy</p>' });
  const res = await publishViaRoute(id, FAR_FUTURE);
  assert.equal(res.status, 200, res.body);
  const page = (res.json as { page?: { scheduled?: boolean; publishedAt?: string } }).page;
  assert.equal(page?.scheduled, true, 'the answer must say scheduled, not published');
  assert.equal(page?.publishedAt, FAR_FUTURE);

  const hidden = await visit('/due-later');
  assert.equal(hidden.status, 404, 'a scheduled page is not visible before its time');

  const db = siteDb();
  try {
    const row = db.prepare('SELECT status, body_html, published_at FROM cms_page WHERE id = ?').get(id) as {
      status: string;
      body_html: string;
      published_at: string | null;
    };
    assert.equal(row.status, 'published', 'status keeps its three values: the page IS published');
    assert.match(row.body_html, /Tuesday copy/, 'the body is ready; only the moment is missing');
    assert.equal(row.published_at, FAR_FUTURE);
  } finally {
    db.close();
  }
});

test('SCH-4. when the moment passes the same row is served, with no other change', async () => {
  const res = await visit('/due-later');
  assert.equal(res.status, 404);
  const db = siteDb();
  let id = 0;
  try {
    id = Number((db.prepare("SELECT id FROM cms_page WHERE path = '/due-later'").get() as { id: number }).id);
  } finally {
    db.close();
  }
  // Time passes: the only thing that changes is the instant the page named.
  setPublishedAt(id, PAST);
  const live = await visit('/due-later');
  assert.equal(live.status, 200, live.body);
  assert.match(live.body, /Tuesday copy/);
  const sitemap = await visit('/sitemap.xml');
  assert.match(sitemap.body, /\/due-later/, 'a due page is crawlable');
});

test('SCH-5. a publish_at that is not a time is refused by name, not silently treated as now', async () => {
  const id = put('/bad-time', { status: 'draft', body: '', draft: '<p>never</p>' });
  const res = await publishViaRoute(id, 'next tuesday-ish');
  assert.equal(res.status, 400, res.body);
  const code = (res.json as { error?: { code?: string } }).error?.code;
  assert.equal(code, 'SKW_E_PLT_REQUEST_INVALID');
  const still = await visit('/bad-time');
  assert.equal(still.status, 404, 'a refused schedule must not put the page live');
});

test('SCH-6. a publish_at in the past is simply "now" — the page goes live', async () => {
  const id = put('/past-time', { status: 'draft', body: '', draft: '<p>already late</p>' });
  const res = await publishViaRoute(id, PAST);
  assert.equal(res.status, 200, res.body);
  assert.equal((res.json as { page?: { scheduled?: boolean } }).page?.scheduled, false);
  const live = await visit('/past-time');
  assert.equal(live.status, 200, live.body);
});

test('SCH-7. the publish is recorded in the revision note as a schedule', async () => {
  const db = siteDb();
  try {
    const row = db
      .prepare(
        `SELECT r.note FROM cms_page_revision r JOIN cms_page p ON p.id = r.page_id
          WHERE p.path = '/due-later' ORDER BY r.rev DESC LIMIT 1`,
      )
      .get() as { note: string } | undefined;
    assert.match(String(row?.note), /scheduled for/, 'the history says what actually happened');
  } finally {
    db.close();
  }
});

// --- 2. search -------------------------------------------------------------------

test('SRCH-1. a word in a page body is found, and the result links at its path', async () => {
  const res = await visit('/search?q=Kumquat');
  assert.equal(res.status, 200, res.body);
  assert.match(res.body, /href="\/"/);
  assert.match(res.body, /Kumquat/);
});

test('SRCH-2. drafts, hidden pages and pages that are not due are not in the results', async () => {
  const draftish = await visit('/search?q=Kumquat');
  assert.doesNotMatch(draftish.body, /\/draft-page/, 'a draft is not searchable');
  assert.doesNotMatch(draftish.body, /\/hidden-page/, 'a hidden page is not searchable');
  const scheduled = await visit('/search?q=Zebra');
  assert.equal(scheduled.status, 200, scheduled.body);
  assert.doesNotMatch(scheduled.body, /\/scheduled-page/, 'a page that is not due is not searchable');
});

test('SRCH-3. a page becomes searchable at the same moment it becomes visible', async () => {
  const db = siteDb();
  let id = 0;
  try {
    id = Number((db.prepare("SELECT id FROM cms_page WHERE path = '/scheduled-page'").get() as { id: number }).id);
  } finally {
    db.close();
  }
  setPublishedAt(id, PAST);
  const res = await visit('/search?q=Zebra');
  assert.match(res.body, /\/scheduled-page/, 'visibility is one predicate, and search reads it too');
});

test('SRCH-4. % and _ are literal characters, not wildcards', async () => {
  put('/percent-page', { body: '<p>We took 100% of it</p>' });
  put('/plain-page', { body: '<p>Nothing numeric here at all</p>' });
  // A bare `%` searched literally finds the page that contains a percent sign and ONLY that page.
  // Unescaped it would match every row, which is the bug this pins.
  const wildcard = await visit('/search?q=%25');
  assert.equal(wildcard.status, 200, wildcard.body);
  assert.match(wildcard.body, /\/percent-page/, 'a literal % finds the page that says %');
  assert.doesNotMatch(wildcard.body, /\/plain-page/, 'a bare % must not match a page with no % in it');
  const literal = await visit('/search?q=100%25');
  assert.match(literal.body, /\/percent-page/, 'the page that really says 100% is found');
});

test('SRCH-5. the query is escaped into the document, not injected', async () => {
  const res = await visit('/search?q=%3Cscript%3Ealert(1)%3C%2Fscript%3E');
  assert.equal(res.status, 200, res.body);
  assert.doesNotMatch(res.body, /<script>alert/, 'the echoed query must be escaped');
  assert.match(res.body, /&lt;script&gt;/);
});

test('SRCH-6. the box is on the page even with nothing typed, and results are not indexed', async () => {
  const res = await visit('/search');
  assert.equal(res.status, 200, res.body);
  assert.match(res.body, /<form class="skw-search__form"/);
  assert.match(res.body, /action="\/search"/);
  assert.match(String(header(res, 'x-robots-tag') ?? ''), /noindex/);
});

test('SRCH-7. robots.txt keeps crawlers out of the results pages', async () => {
  const res = await visit('/robots.txt');
  assert.equal(res.status, 200, res.body);
  assert.match(res.body, /Disallow: \/search/);
});
