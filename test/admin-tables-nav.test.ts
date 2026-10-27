/**
 * S8d — you can get back out of the table screens.
 *
 * The operator's report: "when entering the edit table view, there's no way to go back". They
 * were right twice over. The table screens were the only admin pages that called `page()`
 * without the shell's chrome, so they had no app bar and no section nav; and the row form —
 * the deepest screen in the admin — had no link to anything at all. A browser Back button is
 * not navigation: after a POST that redirects, Back lands on a form that has already been
 * submitted.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { loadEnv } from '../app/env.ts';
import { buildApp, type AppHandle } from '../app/main.ts';
import { ADMIN_HOST, TOTP_SECRET, openSession, seedUser, type Sessioned } from './helpers/admin.ts';
import { makeFixture, type Fixture } from './helpers/fixture.ts';
import { call, type Res } from './helpers/http.ts';

let fixture: Fixture;
let handle: AppHandle;
let port = 0;
let session: Sessioned;

function get(path: string): Promise<Res> {
  return call({ port, path, host: ADMIN_HOST, headers: { cookie: session.cookie } });
}

before(async () => {
  fixture = makeFixture({ specs: [{ key: 'acme', hosts: [ADMIN_HOST], title: 'Acme' }] });
  await seedUser({ controlDb: fixture.controlDb, tenantKey: 'acme', email: 'owner@acme.test', totpSecret: TOTP_SECRET });
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

test('S8d-1. the tables index has the admin shell and a breadcrumb back to the pages', async () => {
  const res = await get('/admin/t/acme/tables');
  assert.equal(res.status, 200, res.body);
  // The shell: app bar with the section nav, which the table screens never had.
  assert.match(res.body, /class="appnav"/, 'the tables index must carry the admin nav');
  assert.match(res.body, /aria-label="Breadcrumb"/);
  assert.match(res.body, /<a href="\/admin\/t\/acme\/">\s*(<span[^>]*>[^<]*<\/span>)?\s*Pages/i);
});

test('S8d-2. a table\'s row list shows where it sits, with a working way back', async () => {
  const res = await get('/admin/t/acme/tables/cms_page');
  assert.equal(res.status, 200, res.body);
  assert.match(res.body, /aria-label="Breadcrumb"/);
  // The trail names the section and the table, and the table is the current page.
  assert.match(res.body, /href="\/admin\/t\/acme\/tables"/);
  assert.match(res.body, /aria-current="page"[^>]*>cms_page|>cms_page<[^>]*aria-current/);
  assert.match(res.body, /class="appnav"/);
});

test('S8d-3. the row form — the deepest screen — carries the same trail and links back', async () => {
  const list = await get('/admin/t/acme/tables/cms_page');
  const id = /data-id="(\d+)"/.exec(list.body)?.[1];
  assert.ok(id !== undefined, 'the fixture must have at least one row to edit');

  const res = await get(`/admin/t/acme/tables/cms_page/${id}`);
  assert.equal(res.status, 200, res.body);
  assert.match(res.body, /aria-label="Breadcrumb"/);
  // Back to the rows of this table, not to the browser history.
  assert.match(res.body, new RegExp(`href="/admin/t/acme/tables/cms_page"[^>]*>`));
  assert.match(res.body, /class="appnav"/);
  // The form's own target is unchanged by any of this.
  assert.match(res.body, new RegExp(`<form[^>]*action="/admin/t/acme/tables/cms_page/${id}"`));
});

test('S8d-4. "new row" is a place you can leave without submitting', async () => {
  const res = await get('/admin/t/acme/tables/cms_page/new');
  assert.equal(res.status, 200, res.body);
  assert.match(res.body, /aria-label="Breadcrumb"/);
  assert.match(res.body, /href="\/admin\/t\/acme\/tables\/cms_page"/);
  assert.match(res.body, /class="appnav"/);
});

/**
 * S8d-5 (E-59). **The list shows the row's id, and an empty list says so.**
 *
 * The browser sweep caught two things in one table: the `id` column was blank on every row (the
 * cells were rendered by mapping over `[String(row[pk]), ...names]`, so each cell read
 * `row['6']` — a column that does not exist — and printed nothing), and a table with no rows
 * rendered a bare header with nothing under it, which reads as a broken screen rather than an
 * empty one.
 */
test('S8d-5. the row list prints the primary key, and an empty table says it is empty', async () => {
  const fixtureDb = new (await import('better-sqlite3')).default(fixture.sitePath('acme'));
  try {
    fixtureDb.prepare("DELETE FROM cms_nav").run();
    fixtureDb
      .prepare("INSERT INTO cms_nav (location, label, href_kind, href_target, position, visible) VALUES ('header', 'Home', 'page', '/', 0, 1)")
      .run();
  } finally {
    fixtureDb.close();
  }

  const list = await get('/admin/t/acme/tables/cms_nav');
  assert.equal(list.status, 200, list.body);
  assert.match(list.body, /<tbody>[\s\S]*<tr data-id="(\d+)"><td>\1<\/td>/, 'the id cell carries the id, not an empty string');
  // id, location, parent_id, label — the empty parent_id is a real column, not a gap.
  assert.match(list.body, /data-id="(\d+)"><td>\1<\/td><td>header<\/td><td><\/td><td>Home<\/td>/, 'and the row reads across in column order');

  // Empty is a sentence, not a void.
  const emptyDb = new (await import('better-sqlite3')).default(fixture.sitePath('acme'));
  try {
    emptyDb.prepare('DELETE FROM cms_nav').run();
  } finally {
    emptyDb.close();
  }
  const empty = await get('/admin/t/acme/tables/cms_nav');
  assert.equal(empty.status, 200, empty.body);
  assert.match(empty.body, /Nothing here yet/, 'an empty table says so');
  assert.match(empty.body, /Add the first one/, 'and offers the way to start');
});
