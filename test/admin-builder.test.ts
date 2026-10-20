/**
 * §9.4 / §4.4 — the table builder's **scaffold**: the form, and the preview of the
 * DDL it would emit. The executor is S2d (the AST runner and the transactional
 * `BEGIN IMMEDIATE … ≤8 statements … cms_table_registry + cms_audit` sequence), so
 * this file asserts two things and refuses to assert a third:
 *
 *   - the form exists when `SKW_SCHEMA_EDIT=on` and is **absent** when `off`
 *     (§9.4: "hides it entirely — no disabled button");
 *   - the preview is the emitter's own output, statement for statement;
 *   - previewing creates nothing. A preview that had a side effect would be the
 *     executor, and the executor is not in this slice.
 */
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { after, before, test } from 'node:test';

import { emitCreateTable, type CreateTableOp } from '../app/ddl/emit.ts';
import { totpCode } from '../app/admin/auth.ts';
import { loadEnv } from '../app/env.ts';
import { buildApp, type AppHandle } from '../app/main.ts';
import { ADMIN_HOST, ADMIN_ORIGIN, TOTP_SECRET, codeOf, login, seedUser, type Sessioned } from './helpers/admin.ts';
import { makeFixture, type Fixture } from './helpers/fixture.ts';
import { call, header, type Res } from './helpers/http.ts';

let fixture: Fixture;
let off: AppHandle;
let offPort = 0;
let on: AppHandle;
let onPort = 0;
let session: Sessioned;

function listen(app: AppHandle): Promise<number> {
  return app.app.listen({ port: 0, host: '127.0.0.1' }).then(() => {
    const address = app.app.server.address();
    return typeof address === 'object' && address !== null ? address.port : 0;
  });
}

async function post(port: number, path: string, fields: Record<string, string>): Promise<Res> {
  return call({
    port,
    path,
    method: 'POST',
    host: ADMIN_HOST,
    headers: {
      cookie: session.cookie,
      origin: ADMIN_ORIGIN,
      'x-csrf-token': session.csrfToken,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(fields).toString(),
  });
}

before(async () => {
  fixture = makeFixture();
  await seedUser({ controlDb: fixture.controlDb, tenantKey: 'acme', email: 'owner@acme.test', totpSecret: TOTP_SECRET });

  off = await buildApp({ env: loadEnv({ ...fixture.env, SKW_SCHEMA_EDIT: 'off' }) });
  offPort = await listen(off);
  on = await buildApp({ env: loadEnv({ ...fixture.env, SKW_SCHEMA_EDIT: 'on' }) });
  onPort = await listen(on);

  const res = await login({ port: onPort, key: 'acme', email: 'owner@acme.test', totp: totpCode(TOTP_SECRET, Date.now()) });
  assert.equal(res.status, 200, res.body);
  const raw = String(header(res, 'set-cookie'));
  session = { cookie: raw.slice(0, raw.indexOf(';')), csrfToken: (res.json as { csrfToken: string }).csrfToken, email: 'owner@acme.test' };
});

after(async () => {
  await off.close();
  await on.close();
  fixture.cleanup();
});

function uTables(): string[] {
  const db = new Database(fixture.sitePath('acme'), { readonly: true });
  try {
    return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB 'u_*'").all() as { name: string }[]).map((r) => r.name);
  } finally {
    db.close();
  }
}

// --- the emitter ----------------------------------------------------------

test('DDL-1. the emitter maps §4.4\'s ten types to SQLite, and derives every FK from the type', () => {
  const op: CreateTableOp = {
    op: 'create_table',
    name: 'u_people',
    columns: [
      { name: 'full_name', type: 'TEXT', notNull: true },
      { name: 'age', type: 'INTEGER' },
      { name: 'score', type: 'REAL', default: 0 },
      { name: 'photo', type: 'ASSET' },
      { name: 'home', type: 'PAGE' },
      { name: 'team', type: 'RELATION', relation: 'u_teams' },
      { name: 'active', type: 'BOOLEAN', notNull: true, default: true },
      { name: 'born_on', type: 'DATE' },
      { name: 'blob', type: 'BLOB' },
      { name: 'note', type: 'NUMERIC' },
    ],
  };
  const sql = emitCreateTable(op);
  assert.equal(sql.length, 1, 'create_table is one statement');
  const text = sql[0] as string;
  assert.match(text, /^CREATE TABLE "u_people" \(/);
  assert.match(text, /"full_name" TEXT NOT NULL/);
  assert.match(text, /"score" REAL DEFAULT 0/);
  assert.match(text, /"photo" TEXT REFERENCES "cms_asset"\("key"\)/);
  assert.match(text, /"home" TEXT REFERENCES "cms_page"\("path"\)/);
  assert.match(text, /"team" INTEGER REFERENCES "u_teams"\("id"\)/);
  assert.match(text, /"active" INTEGER NOT NULL DEFAULT 1 CHECK \("active" IN \(0,1\)\)/);
  assert.match(text, /"born_on" TEXT/, 'DATE has no storage class; the contract here is ISO-8601 TEXT');
  assert.match(text, /"blob" BLOB/);
  assert.match(text, /"note" NUMERIC/);
  // No STRICT: §4.4 carries NUMERIC, which a STRICT table cannot declare, and the
  // frozen cms_* schema is not STRICT either. A u_* table must behave like its neighbours.
  assert.match(text, /\)$/);
});

test('DDL-2. the emitter refuses a reserved or malformed name before any SQL exists', () => {
  for (const [name, reason] of [
    ['cms_page', 'reserved_prefix'],
    ['p_thing', 'reserved_prefix'],
    ['people', 'reserved_prefix'],
    ['u_Bad-Name', 'reserved_prefix'],
  ] as const) {
    assert.throws(
      () => emitCreateTable({ op: 'create_table', name, columns: [{ name: 'x', type: 'TEXT' }] }),
      (err: unknown) => (err as { detail?: { reason?: string } }).detail?.reason === reason,
      name,
    );
  }
  assert.throws(
    () => emitCreateTable({ op: 'create_table', name: 'u_big', columns: Array.from({ length: 41 }, (_, i) => ({ name: `c${i}`, type: 'TEXT' as const })) }),
    (err: unknown) => (err as { detail?: { reason?: string } }).detail?.reason === 'limit',
  );
});

// --- §9.4: off hides it entirely -----------------------------------------

test('BUILD-1. SKW_SCHEMA_EDIT=off has no builder: the route is not there and no page links it', async () => {
  const direct = await call({ port: offPort, path: '/admin/t/acme/builder', host: ADMIN_HOST, headers: { cookie: session.cookie } });
  assert.equal(direct.status, 404, direct.body);
  assert.equal(codeOf(direct), 'SKW_E_PLT_TENANT_UNKNOWN', 'a hidden surface is an absent route, not a refusal');

  const home = await call({ port: offPort, path: '/admin/t/acme/', host: ADMIN_HOST, headers: { cookie: session.cookie } });
  assert.equal(home.status, 200);
  assert.doesNotMatch(home.body, /builder/i, '§9.4: no disabled button, no link, nothing');
});

// --- §9.4: on shows the form and the preview ------------------------------

test('BUILD-2. SKW_SCHEMA_EDIT=on renders the form and links it from the tenant home', async () => {
  const home = await call({ port: onPort, path: '/admin/t/acme/', host: ADMIN_HOST, headers: { cookie: session.cookie } });
  assert.equal(home.status, 200);
  assert.match(home.body, /href="\/admin\/t\/acme\/builder"/);

  const form = await call({ port: onPort, path: '/admin/t/acme/builder', host: ADMIN_HOST, headers: { cookie: session.cookie } });
  assert.equal(form.status, 200, form.body);
  assert.match(String(header(form, 'content-type')), /text\/html/);
  assert.match(form.body, /<form method="post" action="\/admin\/t\/acme\/builder\/preview"/);
  assert.match(form.body, /name="table"/);
  assert.match(form.body, /name="columns"/);
  assert.doesNotMatch(form.body, /name="(_csrf|csrfToken)"/);
});

test('BUILD-3. the preview is the emitter output, statement for statement', async () => {
  const columns = ['full_name TEXT NOT NULL', 'age INTEGER', 'active BOOLEAN NOT NULL DEFAULT true'].join('\n');
  const res = await post(onPort, '/admin/t/acme/builder/preview', { table: 'people', columns });
  assert.equal(res.status, 200, res.body);
  assert.match(String(header(res, 'content-type')), /text\/html/);

  const expected = emitCreateTable({
    op: 'create_table',
    name: 'u_people',
    columns: [
      { name: 'full_name', type: 'TEXT', notNull: true },
      { name: 'age', type: 'INTEGER' },
      { name: 'active', type: 'BOOLEAN', notNull: true, default: true },
    ],
  });
  // The page is HTML, so the comparison is against the text of the <pre>, unescaped.
  const shown = /<pre data-role="ddl">([\s\S]*?)<\/pre>/.exec(res.body)?.[1];
  assert.ok(shown !== undefined, 'the preview has no DDL block');
  const text = shown
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
  assert.equal(text, `${expected.join(';\n\n')};`, 'the preview is not the emitter output');
  // The registry row it would write is shown, and the executor is named as absent.
  assert.match(res.body, /u_people/);
  assert.match(res.body, /not executed/i);
});

test('BUILD-4. a preview creates nothing — there is no executor in this slice', async () => {
  assert.deepEqual(uTables(), [], 'the preview must not run DDL');
});

test('BUILD-5. a reserved name in the form is 422 SKW_E_DM_DDL_REJECTED with its reason', async () => {
  const res = await post(onPort, '/admin/t/acme/builder/preview', { table: 'cms_page', columns: 'x TEXT' });
  assert.equal(res.status, 422, res.body);
  assert.equal(codeOf(res), 'SKW_E_DM_DDL_REJECTED');
  assert.equal((res.json as { error: { detail?: { reason?: string } } }).error.detail?.reason, 'reserved_prefix');
});

test('BUILD-6. a malformed column line is a 400 naming the line, not a half-parsed preview', async () => {
  const res = await post(onPort, '/admin/t/acme/builder/preview', { table: 'people', columns: 'full_name\nage INTEGER' });
  assert.equal(res.status, 400, res.body);
  assert.equal(codeOf(res), 'SKW_E_PLT_REQUEST_INVALID');
  assert.match(String((res.json as { error: { message?: string } }).error.message ?? ''), /line 1/);
});

test('BUILD-7. the preview is a POST with the CSRF header, like every other write-shaped request', async () => {
  const res = await call({
    port: onPort,
    path: '/admin/t/acme/builder/preview',
    method: 'POST',
    host: ADMIN_HOST,
    headers: { cookie: session.cookie, origin: ADMIN_ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ table: 'people', columns: 'x TEXT' }).toString(),
  });
  assert.equal(res.status, 403);
  assert.equal(codeOf(res), 'SKW_E_SEC_CSRF');
});
