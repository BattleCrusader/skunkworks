/**
 * S8b — draft and publish, and the page that must not go dark while you edit it.
 *
 * The defect this file pins, as the operator saw it: open a LIVE page in the editor, press
 * Save, and the page stops existing for visitors — `{"code":"SKW_E_RT_PAGE_NOT_FOUND"}` on a
 * URL that was fine a second earlier. The cause was structural: `savePage` wrote the canvas
 * bytes straight into `cms_page.body_html`, the same column the renderer reads, and flipped
 * `status` to `draft` on the way. One row, one body, two audiences.
 *
 * The model this file asserts:
 *
 *   - `body_*` is the **published** body. Only publish writes it.
 *   - `draft_*` is the work in progress. Only the editor writes it.
 *   - `status` keeps its three values and its meaning. A page that has been published is
 *     still `published` while you edit it, because it *is* still published.
 *   - a person with no publish rights and no preview token can never see `draft_*`.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import type Database from 'better-sqlite3';

import { openAdminWrite } from '../app/db/classes.ts';
import { loadRegistry } from '../app/editor/registry.ts';
import { loadForEditor, savePage } from '../app/editor/save.ts';
import { loadEnv } from '../app/env.ts';
import { buildApp, type AppHandle } from '../app/main.ts';
import { ADMIN_HOST, ADMIN_ORIGIN, TOTP_SECRET, openSession, seedUser, type Sessioned } from './helpers/admin.ts';
import { SCHEMA, makeFixture, type Fixture } from './helpers/fixture.ts';
import { call, header, type Res } from './helpers/http.ts';

const registry = loadRegistry(SCHEMA);
const HOST = 'acme.test';

const OLD_BODY = '<div class="prose" data-gjs-type="prose"><p data-prop="body">Old hero</p></div>';
const NEW_BODY = '<div class="prose" data-gjs-type="prose"><p data-prop="body">New hero</p></div>';

let fixture: Fixture;
let handle: AppHandle;
let port = 0;
let session: Sessioned;
let liveId = 0;

function siteDb(): Database.Database {
  return openAdminWrite(fixture.sitePath('acme'));
}

/** A visitor: no cookie, no token, the tenant's own Host. */
function visit(path: string): Promise<Res> {
  return call({ port, path, host: HOST });
}

async function save(html: string): Promise<void> {
  const db = siteDb();
  try {
    await savePage({
      db,
      registry,
      pageId: liveId,
      path: '/',
      slug: 'home',
      title: 'Home',
      template: 'page',
      html,
      actorId: 1,
    });
  } finally {
    db.close();
  }
}

function row(): { status: string; body_html: string; draft_html: string; draft_sha: string; rev: number; published_at: string | null } {
  const db = siteDb();
  try {
    return db
      .prepare('SELECT status, body_html, draft_html, draft_sha, rev, published_at FROM cms_page WHERE id = ?')
      .get(liveId) as { status: string; body_html: string; draft_html: string; draft_sha: string; rev: number; published_at: string | null };
  } finally {
    db.close();
  }
}

before(async () => {
  fixture = makeFixture({ specs: [{ key: 'acme', hosts: [HOST], title: 'Acme' }] });
  // The allowlist is empty in a bundle, so TOTP is mandatory: a row with no secret cannot sign in.
  await seedUser({ controlDb: fixture.controlDb, tenantKey: 'acme', email: 'owner@acme.test', totpSecret: TOTP_SECRET });
  const db = siteDb();
  try {
    const info = db
      .prepare(
        `INSERT INTO cms_page (path, slug, title, status, template, body_html, body_css, rev, body_sha, published_at)
         VALUES ('/', 'home', 'Home', 'published', 'page', ?, '', 1, ?, '2026-01-01T00:00:00.000Z')`,
      )
      .run(OLD_BODY, 'a'.repeat(64));
    liveId = Number(info.lastInsertRowid);
  } finally {
    db.close();
  }
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

// --- 1. the defect ----------------------------------------------------------

test('S8b-1. the live page is served before anyone touches it', async () => {
  const res = await visit('/');
  assert.equal(res.status, 200, res.body);
  assert.match(res.body, /Old hero/);
});

test('S8b-2. saving an edit does NOT take the live page down and does NOT change what a visitor sees', async () => {
  await save(NEW_BODY);

  // The visitor is still served the published bytes. This is the bug the operator reported:
  // before S8b this request was 404 SKW_E_RT_PAGE_NOT_FOUND.
  const res = await visit('/');
  assert.equal(res.status, 200, res.body);
  assert.match(res.body, /Old hero/);
  assert.doesNotMatch(res.body, /New hero/, 'a draft must never reach a visitor');

  const after = row();
  assert.equal(after.status, 'published');
  assert.equal(after.body_html.includes('Old hero'), true, 'body_* is the published body and only publish writes it');
  assert.equal(after.draft_html.includes('New hero'), true, 'the edit went to draft_*');
  assert.notEqual(after.draft_sha, '', 'a pending draft is identified by its sha');
});

test('S8b-3. the editor reopens with the draft, not the published body', async () => {
  const db = siteDb();
  try {
    const page = loadForEditor(db, registry, liveId);
    assert.match(page.bodyHtml, /New hero/);
    assert.equal(page.status, 'published', 'status describes publication, not the editor');
  } finally {
    db.close();
  }
});

// --- 2. publish -------------------------------------------------------------

test('S8b-4. publish moves the draft to the live body, in one step', async () => {
  const res = await call({
    port,
    path: '/admin/t/acme/editor/publish',
    method: 'POST',
    host: ADMIN_HOST,
    headers: { origin: ADMIN_ORIGIN, cookie: session.cookie, 'x-csrf-token': session.csrfToken, 'content-type': 'application/json' },
    body: JSON.stringify({ id: liveId }),
  });
  assert.equal(res.status, 200, res.body);
  assert.equal((res.json as { ok?: boolean }).ok, true);

  const live = await visit('/');
  assert.equal(live.status, 200, live.body);
  assert.match(live.body, /New hero/);
  assert.doesNotMatch(live.body, /Old hero/);

  const after = row();
  assert.equal(after.status, 'published');
  assert.match(after.body_html, /New hero/);
  assert.equal(after.draft_html, '', 'publishing clears the pending draft');
  assert.equal(after.draft_sha, '');
  assert.notEqual(after.published_at, null);
});

test('S8b-5. publishing appends the published body to the revision history', async () => {
  const db = siteDb();
  try {
    const rows = db
      .prepare('SELECT body_html, note FROM cms_page_revision WHERE page_id = ? ORDER BY id DESC LIMIT 1')
      .all(liveId) as { body_html: string; note: string | null }[];
    assert.equal(rows.length, 1, 'one revision per publish');
    assert.match(rows[0]?.body_html ?? '', /New hero/);
    assert.match(rows[0]?.note ?? '', /publish/i);
  } finally {
    db.close();
  }
});

test('S8b-6. publishing with nothing pending is refused by name, and changes nothing', async () => {
  const before = row();
  const res = await call({
    port,
    path: '/admin/t/acme/editor/publish',
    method: 'POST',
    host: ADMIN_HOST,
    headers: { origin: ADMIN_ORIGIN, cookie: session.cookie, 'x-csrf-token': session.csrfToken, 'content-type': 'application/json' },
    body: JSON.stringify({ id: liveId }),
  });
  assert.equal(res.status, 400, res.body);
  assert.equal((res.json as { error?: { code?: string } }).error?.code, 'SKW_E_PLT_REQUEST_INVALID');
  assert.deepEqual(row(), before, 'a refusal is not a write');
});

test('S8b-7. publish needs a CSRF token: a bare session cookie is not an authorisation', async () => {
  const res = await call({
    port,
    path: '/admin/t/acme/editor/publish',
    method: 'POST',
    host: ADMIN_HOST,
    headers: { origin: ADMIN_ORIGIN, cookie: session.cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ id: liveId }),
  });
  assert.equal(res.status, 403, res.body);
});

// --- 3. a page that has never been published --------------------------------

test('S8b-8. a never-published page is invisible to visitors until it is published, then it appears', async () => {
  const db = siteDb();
  let wipId = 0;
  try {
    const saved = await savePage({
      db,
      registry,
      path: '/wip',
      slug: 'wip',
      title: 'Work in progress',
      template: 'page',
      html: NEW_BODY,
      actorId: 1,
    });
    wipId = saved.id;
    assert.equal(saved.status ?? 'draft', 'draft');
  } finally {
    db.close();
  }

  const hidden = await visit('/wip');
  assert.equal(hidden.status, 404, 'a draft page is not a public URL — there is no last-good page to serve');

  const res = await call({
    port,
    path: '/admin/t/acme/editor/publish',
    method: 'POST',
    host: ADMIN_HOST,
    headers: { origin: ADMIN_ORIGIN, cookie: session.cookie, 'x-csrf-token': session.csrfToken, 'content-type': 'application/json' },
    body: JSON.stringify({ id: wipId }),
  });
  assert.equal(res.status, 200, res.body);

  const live = await visit('/wip');
  assert.equal(live.status, 200, live.body);
  assert.match(live.body, /New hero/);
});

// --- 4. the page list tells the operator there is something to publish ------

test('S8b-9. the page list says a live page has unpublished changes', async () => {
  await save('<div class="prose" data-gjs-type="prose"><p data-prop="body">Third draft</p></div>');
  const res = await call({ port, path: '/admin', host: ADMIN_HOST, headers: { cookie: session.cookie } });
  assert.equal(res.status, 200, res.body);
  assert.match(res.body, /data-status="published"[^>]*data-draft="1"/, 'the row must carry the pending-draft fact');
  assert.match(res.body, /unpublished change/i);
});
