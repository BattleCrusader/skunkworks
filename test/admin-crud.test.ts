/**
 * §9.3 — row data in `cms_*` is editable through generated forms.
 * §9.6 — every change writes one `cms_audit` row, in the same transaction, with
 *        the actor and the before/after images; a failed write writes none.
 * §2.2 — the write path uses `admin-write`; a write on `render-read` throws and
 *        must not be retried, swallowed or answered as a success.
 *
 * Every request goes over a socket to the real app; the assertions about rows are
 * made against the real `site.db` the app just wrote.
 */
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { totpCode } from '../app/admin/auth.ts';
import { openRenderRead } from '../app/db/classes.ts';
import { loadEnv } from '../app/env.ts';
import { buildApp, type AppHandle } from '../app/main.ts';
import {
  ADMIN_HOST,
  ADMIN_ORIGIN,
  TOTP_SECRET,
  codeOf,
  login,
  seedUser,
  type Sessioned,
} from './helpers/admin.ts';
import { REPO, makeFixture, type Fixture } from './helpers/fixture.ts';
import { call, header, type Res } from './helpers/http.ts';

let fixture: Fixture;
let handle: AppHandle;
let port = 0;
let session: Sessioned;

interface AuditRow {
  actor_label: string;
  action: string;
  target_kind: string | null;
  target_id: string | null;
  before_json: string | null;
  after_json: string | null;
  prev_hash: string;
  hash: string;
}

function listen(app: AppHandle): Promise<number> {
  return app.app.listen({ port: 0, host: '127.0.0.1' }).then(() => {
    const address = app.app.server.address();
    return typeof address === 'object' && address !== null ? address.port : 0;
  });
}

function site(): Database.Database {
  const db = new Database(fixture.sitePath('acme'));
  db.pragma('foreign_keys = ON');
  return db;
}

function count(table: string, where: string, ...args: unknown[]): number {
  const db = site();
  try {
    return (db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${where}`).get(...args) as { n: number }).n;
  } finally {
    db.close();
  }
}

function auditRows(): AuditRow[] {
  const db = site();
  try {
    return db
      .prepare('SELECT actor_label, action, target_kind, target_id, before_json, after_json, prev_hash, hash FROM cms_audit ORDER BY id')
      .all() as AuditRow[];
  } finally {
    db.close();
  }
}

async function postForm(path: string, fields: Record<string, string>, s: Sessioned = session): Promise<Res> {
  return call({
    port,
    path,
    method: 'POST',
    host: ADMIN_HOST,
    headers: {
      cookie: s.cookie,
      origin: ADMIN_ORIGIN,
      'x-csrf-token': s.csrfToken,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(fields).toString(),
  });
}

before(async () => {
  fixture = makeFixture();
  await seedUser({ controlDb: fixture.controlDb, tenantKey: 'acme', email: 'owner@acme.test', totpSecret: TOTP_SECRET });
  handle = await buildApp({ env: loadEnv(fixture.env) });
  port = await listen(handle);
  const res = await login({ port, key: 'acme', email: 'owner@acme.test', totp: totpCode(TOTP_SECRET, Date.now()) });
  assert.equal(res.status, 200, res.body);
  const raw = String(header(res, 'set-cookie'));
  const json = res.json as { csrfToken: string };
  session = { cookie: raw.slice(0, raw.indexOf(';')), csrfToken: json.csrfToken, email: 'owner@acme.test' };
});

after(async () => {
  await handle.close();
  fixture.cleanup();
});

// --- the forms ------------------------------------------------------------

test('CRUD-3. the CRUD pages are server-rendered, and the edit form has one control per editable column', async () => {
  const list = await call({ port, path: '/admin/t/acme/tables', host: ADMIN_HOST, headers: { cookie: session.cookie } });
  assert.equal(list.status, 200, list.body);
  assert.match(String(header(list, 'content-type')), /text\/html/);
  assert.match(list.body, /\/admin\/t\/acme\/tables\/cms_page/, 'the table list links cms_page');

  const page = await call({ port, path: '/admin/t/acme/tables/cms_page', host: ADMIN_HOST, headers: { cookie: session.cookie } });
  assert.equal(page.status, 200, page.body);
  assert.match(page.body, /Acme pricing/, 'the row list shows the seeded page');

  const edit = await call({ port, path: '/admin/t/acme/tables/cms_page/1', host: ADMIN_HOST, headers: { cookie: session.cookie } });
  assert.equal(edit.status, 200, edit.body);
  assert.match(edit.body, /<form method="post" action="\/admin\/t\/acme\/tables\/cms_page\/1"/);
  for (const column of ['path', 'slug', 'title', 'status', 'body_html', 'template']) {
    assert.match(edit.body, new RegExp(`name="${column}"`), `no control for ${column}`);
  }
  // D28: the token is a header, never a form field.
  assert.doesNotMatch(edit.body, /name="(_csrf|csrfToken|csrf_token)"/);
  assert.match(edit.body, /data-csrf-token="/, 'the page carries the token for the header the form posts');
});

// --- create / edit / delete, each with an audit row -----------------------

test('CRUD-4. create writes the row and one audit row carrying actor, before=null and after', async () => {
  const before = auditRows().length;
  const res = await postForm('/admin/t/acme/tables/cms_page', {
    path: '/created',
    slug: 'created',
    title: 'Created by the form',
    status: 'draft',
    template: 'page',
    body_html: '<p>new</p>',
    body_css: '',
  });
  assert.equal(res.status, 303, res.body);
  assert.match(String(header(res, 'location')), /\/admin\/t\/acme\/tables\/cms_page\/\d+$/);

  const db = site();
  const row = db.prepare("SELECT id, title FROM cms_page WHERE path = '/created'").get() as { id: number; title: string };
  db.close();
  assert.equal(row.title, 'Created by the form');

  const audit = auditRows();
  assert.equal(audit.length, before + 1);
  const entry = audit[audit.length - 1] as AuditRow;
  assert.equal(entry.actor_label, 'owner@acme.test');
  assert.equal(entry.action, 'cms_page.create');
  assert.equal(entry.target_kind, 'cms_page');
  assert.equal(entry.target_id, String(row.id));
  assert.equal(entry.before_json, null);
  assert.equal((JSON.parse(entry.after_json as string) as { title: string }).title, 'Created by the form');
  assert.equal(entry.hash.length, 64, 'the chain row is hashed, not left empty');
  assert.notEqual(entry.hash, entry.prev_hash);
});

test('CRUD-5. edit writes before and after, and the row chains onto the previous hash', async () => {
  const db = site();
  const id = (db.prepare("SELECT id FROM cms_page WHERE path = '/created'").get() as { id: number }).id;
  db.close();

  const res = await postForm(`/admin/t/acme/tables/cms_page/${id}`, {
    path: '/created',
    slug: 'created',
    title: 'Edited by the form',
    status: 'published',
    template: 'page',
    body_html: '<p>edited</p>',
    body_css: '',
  });
  assert.equal(res.status, 303, res.body);

  const audit = auditRows();
  const entry = audit[audit.length - 1] as AuditRow;
  assert.equal(entry.action, 'cms_page.update');
  assert.equal((JSON.parse(entry.before_json as string) as { title: string }).title, 'Created by the form');
  assert.equal((JSON.parse(entry.after_json as string) as { title: string }).title, 'Edited by the form');
  assert.equal(entry.prev_hash, (audit[audit.length - 2] as AuditRow).hash, 'the chain is a chain');
});

test('CRUD-6. delete removes the row and records what it was', async () => {
  const db = site();
  const id = (db.prepare("SELECT id FROM cms_page WHERE path = '/created'").get() as { id: number }).id;
  db.close();

  const res = await postForm(`/admin/t/acme/tables/cms_page/${id}/delete`, {});
  assert.equal(res.status, 303, res.body);
  assert.equal(count('cms_page', 'id = ?', id), 0);

  const entry = auditRows().at(-1) as AuditRow;
  assert.equal(entry.action, 'cms_page.delete');
  assert.equal((JSON.parse(entry.before_json as string) as { title: string }).title, 'Edited by the form');
  assert.equal(entry.after_json, null);
});

// --- a refused write writes nothing --------------------------------------

test('CRUD-7. a write the schema refuses is a taxonomy 400, and writes no audit row', async () => {
  const before = auditRows().length;
  const res = await postForm('/admin/t/acme/tables/cms_page', {
    path: '/bad',
    slug: 'bad',
    title: 'Bad',
    status: 'not-a-status',
    template: 'page',
    body_html: '',
    body_css: '',
  });
  assert.equal(res.status, 400, res.body);
  assert.equal(codeOf(res), 'SKW_E_PLT_REQUEST_INVALID');
  assert.equal(auditRows().length, before, 'a refused write must not leave an audit row');
  assert.equal(count('cms_page', "path = '/bad'"), 0);
});

test('CRUD-8. delete of a row another table references is the taxonomy 409, not a 500', async () => {
  const db = site();
  const asset = db
    .prepare(
      `INSERT INTO cms_asset (key, filename, mime, bytes, sha256, kind, access_class)
       VALUES ('media/used.pdf', 'used.pdf', 'application/pdf', 10, ?, 'document', 'gated')`,
    )
    .run('a'.repeat(64));
  const assetId = Number(asset.lastInsertRowid);
  db.prepare("INSERT INTO cms_asset_link (asset_id, owner_kind, owner_id) VALUES (?, 'page', 1)").run(assetId);
  db.close();

  const before = auditRows().length;
  const res = await postForm(`/admin/t/acme/tables/cms_asset/${assetId}/delete`, {});
  assert.equal(res.status, 409, res.body);
  assert.equal(codeOf(res), 'SKW_E_DM_ASSET_IN_USE', 'the trigger names the code; the app must not answer 500');
  assert.equal(auditRows().length, before, 'a refused delete writes no audit row');
  assert.equal(count('cms_asset', 'id = ?', assetId), 1);
});

test('CRUD-9. a unique-key collision is SKW_E_DM_KEY_IN_USE, not a 500', async () => {
  const res = await postForm('/admin/t/acme/tables/cms_page', {
    path: '/pricing',
    slug: 'pricing',
    title: 'Duplicate path',
    status: 'draft',
    template: 'page',
    body_html: '',
    body_css: '',
  });
  assert.equal(res.status, 409, res.body);
  assert.equal(codeOf(res), 'SKW_E_DM_KEY_IN_USE');
});

// --- the connection classes ----------------------------------------------

test('CRUD-10. a write on the render-read class throws, and nothing is written', () => {
  const db = openRenderRead(fixture.sitePath('acme'));
  try {
    assert.throws(
      () => db.prepare("INSERT INTO cms_page (path, slug, title) VALUES ('/ro', 'ro', 'ro')").run(),
      /readonly|query_only/i,
      'render-read must refuse the write itself, not rely on the caller',
    );
    // Turning the pragma off is not a way out: the handle is opened `readonly`, so
    // the write is still refused. Both halves of §2.2's class are load-bearing.
    db.pragma('query_only = 0');
    assert.throws(
      () => db.prepare("INSERT INTO cms_page (path, slug, title) VALUES ('/ro', 'ro', 'ro')").run(),
      /readonly/i,
    );
  } finally {
    db.close();
  }
  assert.equal(count('cms_page', "path = '/ro'"), 0);
});

test('CRUD-11. the write path never opens render-read and never retries', () => {
  const text = readFileSync(join(REPO, 'app', 'admin', 'crud.ts'), 'utf8');
  assert.doesNotMatch(text, /openRenderRead/, 'the write path must not own a read handle');
  assert.doesNotMatch(text, /\bretry\b/i, 'a failed write is reported, never retried');
  assert.doesNotMatch(text, /\bwhile\s*\(/, 'no retry loop');
});

// --- isolation ------------------------------------------------------------

test('CRUD-12. the same write against another tenant is refused before any row is touched', async () => {
  const res = await postForm('/admin/t/beta/tables/cms_page', {
    path: '/cross',
    slug: 'cross',
    title: 'Cross',
    status: 'draft',
    template: 'page',
    body_html: '',
    body_css: '',
  });
  assert.equal(res.status, 404, res.body);
  assert.equal(codeOf(res), 'SKW_E_PLT_TENANT_UNKNOWN');
  assert.equal(count('cms_page', "path = '/cross'"), 0);
});

test('CRUD-13. a CRUD write without the CSRF header is 403', async () => {
  const res = await call({
    port,
    path: '/admin/t/acme/tables/cms_page',
    method: 'POST',
    host: ADMIN_HOST,
    headers: { cookie: session.cookie, origin: ADMIN_ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ path: '/nocsrf', slug: 'nocsrf', title: 'No', status: 'draft', template: 'page', body_html: '', body_css: '' }).toString(),
  });
  assert.equal(res.status, 403);
  assert.equal(codeOf(res), 'SKW_E_SEC_CSRF');
  assert.equal(count('cms_page', "path = '/nocsrf'"), 0);
});
