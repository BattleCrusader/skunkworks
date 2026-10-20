/**
 * S2e — the admin surface for the Data Source plane: the registry read, the two
 * write routes that call the publish gate, and O-29's token minted **in admin**.
 *
 * The point of the file is that the gate has real callers: a source published here
 * is the same source the render path resolves, and the preview URL handed out by
 * the page detail is the token the render path accepts.
 */
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { after, before, test } from 'node:test';

import { totpCode } from '../app/admin/auth.ts';
import { runDdl } from '../app/ddl/run.ts';
import { loadEnv } from '../app/env.ts';
import { buildApp, type AppHandle } from '../app/main.ts';
import { publishSource } from '../app/sources/publish.ts';
import { ADMIN_HOST, ADMIN_ORIGIN, TOTP_SECRET, codeOf, login, seedUser, type Sessioned } from './helpers/admin.ts';
import { makeFixture, type Fixture } from './helpers/fixture.ts';
import { call, type Res } from './helpers/http.ts';

const ACTOR = { userId: 1, label: 'builder@acme.test' };

let fixture: Fixture;
let handle: AppHandle;
let port = 0;
let session: Sessioned;
let draftId = 0;
let publishedId = 0;

const SPEC = {
  table: 'u_posts',
  columns: ['title', 'slug'],
  where: [{ col: 'status', op: '=' as const, param: 'status' }],
  order: [{ col: 'published_at', dir: 'desc' as const }],
  limit_default: 2,
  limit_max: 10,
};

function post(path: string, body: unknown, opts: { csrf?: boolean } = {}): Promise<Res> {
  const headers: Record<string, string> = { cookie: session.cookie, origin: ADMIN_ORIGIN, 'content-type': 'application/json' };
  if (opts.csrf !== false) headers['x-csrf-token'] = session.csrfToken;
  return call({ port, path, method: 'POST', host: ADMIN_HOST, headers, body: JSON.stringify(body) });
}

function get(path: string): Promise<Res> {
  return call({ port, path, host: ADMIN_HOST, headers: { cookie: session.cookie } });
}

before(async () => {
  fixture = makeFixture({ specs: [{ key: 'acme', hosts: ['acme.test'], title: 'Acme', body: '<h1>published</h1>' }] });
  runDdl(
    fixture.sitePath('acme'),
    [
      {
        op: 'create_table',
        name: 'u_posts',
        columns: [
          { name: 'title', type: 'TEXT', notNull: true },
          { name: 'slug', type: 'TEXT', notNull: true },
          { name: 'status', type: 'TEXT', notNull: true },
          { name: 'published_at', type: 'DATE' },
        ],
      },
      { op: 'create_index', table: 'u_posts', name: 'ix_posts_status', columns: ['status'], unique: false },
      { op: 'create_index', table: 'u_posts', name: 'ix_posts_published_at', columns: ['published_at'], unique: false },
    ],
    { actor: ACTOR },
  );
  const db = new Database(fixture.sitePath('acme'));
  try {
    db.prepare("INSERT INTO u_posts (title, slug, status, published_at) VALUES ('One', 'one', 'published', '2026-10-01T00:00:00Z')").run();
    db.prepare("INSERT INTO u_posts (title, slug, status, published_at) VALUES ('Two', 'two', 'draft', '2026-10-02T00:00:00Z')").run();
    draftId = Number(
      db
        .prepare(
          `INSERT INTO cms_page (path, slug, title, status, template, body_html)
           VALUES ('/soon', 'soon', 'Soon', 'draft', 'page', '<h1>not yet</h1>')`,
        )
        .run().lastInsertRowid,
    );
    publishedId = Number((db.prepare("SELECT id FROM cms_page WHERE path = '/pricing'").get() as { id: number }).id);
  } finally {
    db.close();
  }

  await seedUser({ controlDb: fixture.controlDb, tenantKey: 'acme', email: 'owner@acme.test', totpSecret: TOTP_SECRET });
  handle = await buildApp({ env: loadEnv(fixture.env) });
  await handle.app.listen({ port: 0, host: '127.0.0.1' });
  const address = handle.app.server.address();
  port = typeof address === 'object' && address !== null ? address.port : 0;
  const res = await login({ port, key: 'acme', email: 'owner@acme.test', totp: totpCode(TOTP_SECRET, Date.now()) });
  assert.equal(res.status, 200, res.body);
  const raw = String(res.headers['set-cookie']);
  session = { cookie: raw.slice(0, raw.indexOf(';')), csrfToken: (res.json as { csrfToken: string }).csrfToken, email: 'owner@acme.test' };
});

after(async () => {
  await handle.close();
  fixture.cleanup();
});

test('S2E-22. the admin lists the registry, and a source published through the gate is on it', async () => {
  const empty = await get('/admin/t/acme/sources');
  assert.equal(empty.status, 200, empty.body);
  assert.deepEqual((empty.json as { sources: unknown[] }).sources, []);

  // The publish runs through the same gate the route calls, with an explicit ceiling, because
  // §6.1's 1.5 ms budget is a wall-clock measurement and `make test` must not be decided by the
  // box (`make test-perf` P-1/P-3). What this file owns about the **route** is that it reaches
  // the gate and propagates its refusals — `S2E-23` (C-18's refusal through the route) and
  // `S2E-24` (CSRF) are that witness; the route's success path is asserted in `make test-perf`
  // P-3, where a measured `cost_ms_max` is the point rather than an accident.
  const report = publishSource(
    fixture.sitePath('acme'),
    {
      key: 'posts',
      kind: 'query',
      spec: SPEC,
      params: [{ name: 'status', kind: 'enum', values: ['published', 'draft'] }],
      isPublic: true,
      ttlS: 60,
      budgetMsMax: 1_000,
    },
    ACTOR,
  );
  assert.ok(report.plan.join('\n').includes('SEARCH'));
  assert.equal(typeof report.cost_ms_max, 'number');

  const list = await get('/admin/t/acme/sources');
  const sources = (list.json as { sources: { key: string; is_public: boolean; cost_rows: number }[] }).sources;
  assert.equal(sources.length, 1);
  assert.equal(sources[0]?.key, 'posts');
  assert.equal(sources[0]?.is_public, true);
  assert.equal(sources[0]?.cost_rows, 2);
});

test('S2E-23. the admin route refuses a `function` source with C-18\'s code', async () => {
  const res = await post('/admin/t/acme/sources/publish', { key: 'evil', kind: 'function', spec: { file: 'x.mjs' } });
  assert.equal(res.status, 422, res.body);
  assert.equal(codeOf(res), 'SKW_E_RT_SOURCE_UNKNOWN');
  assert.equal((res.json as { error: { detail: { register: string } } }).error.detail.register, 'C-18');
});

test('S2E-24. a source write without the CSRF token is the same 403 as every other write', async () => {
  const res = await post('/admin/t/acme/sources/publish', { key: 'posts', kind: 'query', spec: SPEC }, { csrf: false });
  assert.equal(res.status, 403, res.body);
  assert.equal(codeOf(res), 'SKW_E_SEC_CSRF');
});

test('S2E-25. the page detail mints the preview token in admin, and the render path accepts it', async () => {
  const draft = await get(`/admin/t/acme/pages/${draftId}`);
  assert.equal(draft.status, 200, draft.body);
  const preview = (draft.json as { preview: { url: string; expires_in_s: number } | null }).preview;
  assert.ok(preview !== null, 'a draft page must get a preview URL');
  assert.equal(preview.expires_in_s, 1_800);
  assert.match(preview.url, /^\/soon\?preview=\d+\.[0-9a-f]{64}$/);

  const page = await call({ port, path: preview.url, host: 'acme.test' });
  assert.equal(page.status, 200, `the minted preview did not render: ${page.body}`);
  assert.match(page.body, /not yet/);
  assert.equal(String(page.headers['cache-control']), 'no-store');

  const published = await get(`/admin/t/acme/pages/${publishedId}`);
  assert.equal((published.json as { preview: unknown }).preview, null, 'a published page has nothing to preview');
});
