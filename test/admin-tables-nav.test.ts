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
