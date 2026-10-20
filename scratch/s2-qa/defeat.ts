/**
 * S2 QA defeat attempts — NOT a deliverable, NOT committed (scratch/ is gitignored).
 * Everything here goes through the real routes, the real schema and the real resolver.
 */
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { totpCode } from '../../app/admin/auth.ts';
import { runDdl } from '../../app/ddl/run.ts';
import { loadEnv } from '../../app/env.ts';
import { buildApp, type AppHandle } from '../../app/main.ts';
import { mintPreviewToken, loadPageForRender } from '../../app/render/preview.ts';
import { createRenderData } from '../../app/render/data.ts';
import { openRenderRead } from '../../app/db/classes.ts';
import { SOURCE_COLUMNS } from '../../app/sources/registry.ts';
import { ADMIN_HOST, ADMIN_ORIGIN, TOTP_SECRET, codeOf, login, seedUser, type Sessioned } from '../../test/helpers/admin.ts';
import { makeFixture, type Fixture } from '../../test/helpers/fixture.ts';
import { call, type Res } from '../../test/helpers/http.ts';

const ACTOR = { userId: 1, label: 'qa@acme.test' };
const SESSION_KEY = 'test-session-key-0123456789abcdef';

let fixture: Fixture;
let handle: AppHandle;
let port = 0;
let session: Sessioned;
let draftId = 0;

function post(path: string, body: unknown, opts: { csrf?: boolean; origin?: string } = {}): Promise<Res> {
  const headers: Record<string, string> = {
    cookie: session.cookie,
    origin: opts.origin ?? ADMIN_ORIGIN,
    'content-type': 'application/json',
  };
  if (opts.csrf !== false) headers['x-csrf-token'] = session.csrfToken;
  return call({ port, path, method: 'POST', host: ADMIN_HOST, headers, body: JSON.stringify(body) });
}

function site(): Database.Database {
  return new Database(fixture.sitePath('acme'));
}

function n(db: Database.Database, sql: string, ...args: unknown[]): number {
  return Number((db.prepare(sql).get(...(args as never[])) as { n: number }).n);
}

function show(label: string, value: unknown): void {
  console.log(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
}

const SPEC = {
  table: 'u_posts',
  columns: ['title', 'slug'],
  where: [{ col: 'status', op: '=' as const, param: 'status' }],
  order: [{ col: 'published_at', dir: 'desc' as const }],
  limit_default: 3,
  limit_max: 5,
};

await (async () => {
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
    for (let i = 1; i <= 6; i += 1) {
      db.prepare("INSERT INTO u_posts (title, slug, status, published_at) VALUES (?, ?, ?, ?)").run(
        `Post ${i}`,
        `post-${i}`,
        i % 2 === 0 ? 'draft' : 'published',
        `2026-10-0${i}T00:00:00Z`,
      );
    }
    draftId = Number(
      db.prepare(
        `INSERT INTO cms_page (path, slug, title, status, template, body_html)
         VALUES ('/soon', 'soon', 'Soon', 'draft', 'page', '<h1>not yet</h1>')`,
      ).run().lastInsertRowid,
    );
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
  session = {
    cookie: raw.slice(0, raw.indexOf(';')),
    csrfToken: (res.json as { csrfToken: string }).csrfToken,
    email: 'owner@acme.test',
  };

  // ============================================================ D1
  console.log('\n=== D1. publish a `query` source projecting a column outside the allowlist, via the JSON route ===');
  {
    const r = await post('/admin/t/acme/sources/publish', {
      key: 'leak',
      kind: 'query',
      spec: { table: 'u_posts', columns: ['title', 'secret_col'], order: [{ col: 'published_at', dir: 'desc' }] },
      is_public: true,
    });
    show('status', r.status);
    show('code', codeOf(r));
    show('detail', (r.json as { error: { detail: unknown } } | undefined)?.error?.detail);
    const r2 = await post('/admin/t/acme/sources/publish', {
      key: 'leak2',
      kind: 'query',
      spec: { table: 'u_posts', columns: ['title', 'body_html'] },
      is_public: true,
    });
    show('a column of another table (body_html): status/code', `${r2.status}/${codeOf(r2)}`);
    const r3 = await post('/admin/t/acme/sources/publish', {
      key: 'leak3',
      kind: 'query',
      spec: { table: 'cms_audit', columns: ['action'] },
      is_public: true,
    });
    show('a cms_* table (cms_audit): status/code', `${r3.status}/${codeOf(r3)}`);
    show('detail', (r3.json as { error: { detail: unknown } } | undefined)?.error?.detail);
    const db = site();
    try {
      show('rows written to cms_datasource', n(db, 'SELECT count(*) AS n FROM cms_datasource'));
    } finally {
      db.close();
    }
  }

  // ============================================================ D2
  console.log('\n=== D2. parameter / operator / column injection ===');
  {
    const vectors: { name: string; body: unknown }[] = [
      {
        name: "where.op = `= ? OR 1=1 --`",
        body: { key: 'inj1', kind: 'query', spec: { table: 'u_posts', columns: ['title'], where: [{ col: 'status', op: '= ? OR 1=1 --', param: 'status' }] }, params: [{ name: 'status', kind: 'bound' }] },
      },
      {
        name: 'where.col = `status" OR 1=1 --`',
        body: { key: 'inj2', kind: 'query', spec: { table: 'u_posts', columns: ['title'], where: [{ col: 'status" OR 1=1 --', op: '=', param: 'status' }] }, params: [{ name: 'status', kind: 'bound' }] },
      },
      {
        name: 'order.dir = `DESC; DROP TABLE u_posts`',
        body: { key: 'inj3', kind: 'query', spec: { table: 'u_posts', columns: ['title'], order: [{ col: 'title', dir: 'DESC; DROP TABLE u_posts' }] } },
      },
      {
        name: 'table = `u_posts; DROP TABLE u_posts`',
        body: { key: 'inj4', kind: 'query', spec: { table: 'u_posts; DROP TABLE u_posts', columns: ['title'] } },
      },
      {
        name: 'columns = [`title`, `title FROM u_posts; --`]',
        body: { key: 'inj5', kind: 'query', spec: { table: 'u_posts', columns: ['title', 'title FROM u_posts; --'] } },
      },
    ];
    for (const v of vectors) {
      const r = await post('/admin/t/acme/sources/publish', v.body);
      show(v.name, `status=${r.status} code=${codeOf(r) ?? '-'}`);
    }
    const db = site();
    try {
      show('u_posts still exists, rows', `${n(db, "SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='u_posts'")} table(s), ${n(db, 'SELECT count(*) AS n FROM u_posts')} row(s)`);
    } finally {
      db.close();
    }
  }

  // publish the good source for the runtime probes
  const ok = await post('/admin/t/acme/sources/publish', {
    key: 'posts',
    kind: 'query',
    spec: SPEC,
    params: [{ name: 'status', kind: 'enum', values: ['published', 'draft'] }],
    is_public: true,
    ttl_s: 60,
  });
  show('\npublish good source `posts`', `status=${ok.status} code=${codeOf(ok) ?? '-'}`);

  console.log('\n=== D2b. runtime parameter injection against the published source ===');
  {
    const db = openRenderRead(fixture.sitePath('acme'));
    const data = createRenderData(db, { tenantKey: 'acme' });
    const vectors: { name: string; params: Record<string, unknown> }[] = [
      { name: "status = `published' OR 1=1 --`", params: { status: "published' OR 1=1 --", limit: 5 } },
      { name: 'order = `title;--` (undeclared key)', params: { status: 'published', order: 'title;--' } },
      { name: 'status = 1 (an int for an enum)', params: { status: 1, limit: 5 } },
      { name: 'limit = `5; DROP TABLE u_posts` (a string)', params: { status: 'published', limit: '5; DROP TABLE u_posts' } },
    ];
    for (const v of vectors) {
      try {
        const r = data.source('posts', v.params);
        show(v.name, `RESOLVED rows=${r.rows.length} limit=${r.limit} truncated=${String(r.truncated)}`);
      } catch (err) {
        const e = err as { code?: string; detail?: { reason?: string } };
        show(v.name, `REFUSED ${String(e.code)} reason=${String(e.detail?.reason)}`);
      }
    }
    db.close();
    const d2 = site();
    try {
      show('u_posts row count after the runtime vectors', n(d2, 'SELECT count(*) AS n FROM u_posts'));
    } finally {
      d2.close();
    }
  }

  // ============================================================ D3
  console.log('\n=== D3. is_public=false from the public render path, with and without a preview token ===');
  {
    const priv = await post('/admin/t/acme/sources/publish', {
      key: 'private-posts',
      kind: 'query',
      spec: { ...SPEC, columns: ['title'] },
      params: [{ name: 'status', kind: 'enum', values: ['published', 'draft'] }],
      is_public: false,
      ttl_s: 60,
    });
    show('publish private-posts (is_public:false)', `status=${priv.status} is_public=${String((priv.json as { published?: { is_public?: boolean } } | undefined)?.published?.is_public)}`);

    const db = openRenderRead(fixture.sitePath('acme'));
    const publicView = createRenderData(db, { tenantKey: 'acme', audience: 'render' });
    try {
      publicView.source('private-posts', { status: 'published', limit: 5 });
      show('public render (audience=render)', 'RESOLVED — DEFEAT');
    } catch (err) {
      const e = err as { code?: string; detail?: { reason?: string; key?: string } };
      show('public render (audience=render)', `REFUSED ${String(e.code)} reason=${String(e.detail?.reason)} key=${String(e.detail?.key)}`);
    }
    const previewView = createRenderData(db, { tenantKey: 'acme', audience: 'preview' });
    try {
      const r = previewView.source('private-posts', { status: 'published', limit: 5 });
      show('preview render (audience=preview)', `RESOLVED rows=${r.rows.length} (by design: an O-29 token is required to reach this object)`);
    } catch (err) {
      show('preview render (audience=preview)', `REFUSED ${String((err as { code?: string }).code)}`);
    }
    db.close();

    // HTTP: does the public host serve the private source at all?
    const draftDetail = await call({ port, host: ADMIN_HOST, path: `/admin/t/acme/pages/${draftId}`, headers: { cookie: session.cookie } });
    const url = (draftDetail.json as { preview: { url: string } }).preview.url;
    const withToken = await call({ port, host: 'acme.test', path: url });
    show('GET /soon?preview=<valid token> on the public host', `status=${withToken.status} cache-control=${String(withToken.headers['cache-control'])} preview_page=${withToken.status === 200 ? 'served' : 'not served'}`);
    const noToken = await call({ port, host: 'acme.test', path: '/soon' });
    show('GET /soon with no token', `status=${noToken.status} code=${codeOf(noToken) ?? '-'}`);
    const badToken = await call({ port, host: 'acme.test', path: '/soon?preview=9999999999.' + 'a'.repeat(64) });
    show('GET /soon?preview=<forged>', `status=${badToken.status} code=${codeOf(badToken) ?? '-'}`);
    const onPublished = await call({ port, host: 'acme.test', path: '/pricing?preview=' + url.split('preview=')[1] });
    show('GET /pricing?preview=<token minted for /soon>', `status=${onPublished.status} code=${codeOf(onPublished) ?? '-'}`);
  }

  // ============================================================ D4
  console.log('\n=== D4. preview token reused after 30 min and after publish ===');
  {
    const now = Date.now();
    const stale = mintPreviewToken('acme', '/soon', SESSION_KEY, now - 1_801_000);
    const staleRes = await call({ port, host: 'acme.test', path: `/soon?preview=${stale}` });
    show('token minted 30 min + 1 s ago', `status=${staleRes.status} code=${codeOf(staleRes) ?? '-'}`);

    const fresh = mintPreviewToken('acme', '/soon', SESSION_KEY, now);
    const freshRes = await call({ port, host: 'acme.test', path: `/soon?preview=${fresh}` });
    show('fresh token (control)', `status=${freshRes.status}`);

    const otherTenant = mintPreviewToken('beta', '/soon', SESSION_KEY, now);
    const otherRes = await call({ port, host: 'acme.test', path: `/soon?preview=${otherTenant}` });
    show('token minted for another tenant', `status=${otherRes.status}`);

    const future = mintPreviewToken('acme', '/soon', SESSION_KEY, now + 3_600_000);
    const futureRes = await call({ port, host: 'acme.test', path: `/soon?preview=${future}` });
    show('token with exp 90 min out (TTL ceiling)', `status=${futureRes.status}`);

    const db = site();
    try {
      db.prepare("UPDATE cms_page SET status = 'published', published_at = '2026-10-20T00:00:00.000Z' WHERE id = ?").run(draftId);
    } finally {
      db.close();
    }
    const afterPublish = await call({ port, host: 'acme.test', path: `/soon?preview=${fresh}` });
    show('the same fresh token after the page was published', `status=${afterPublish.status} code=${codeOf(afterPublish) ?? '-'}`);
    const plain = await call({ port, host: 'acme.test', path: '/soon' });
    show('the published page with no token', `status=${plain.status}`);
  }

  // ============================================================ D5
  console.log('\n=== D5. a `view` source whose view is dropped or altered after publish ===');
  {
    const db = site();
    try {
      const sql = "CREATE VIEW cms_v_posts_public AS SELECT title, slug FROM u_posts WHERE status = 'published'";
      db.exec(sql);
      const sum = createHash('sha256').update(sql).digest('hex');
      db.prepare('INSERT INTO cms_view_registry (name, checksum) VALUES (?, ?)').run('cms_v_posts_public', sum);
    } finally {
      db.close();
    }
    const pub = await post('/admin/t/acme/sources/publish', {
      key: 'view-posts',
      kind: 'view',
      spec: { view: 'cms_v_posts_public', columns: ['title', 'slug'], order: [{ col: 'title', dir: 'asc' }], limit_max: 10 },
      is_public: true,
      ttl_s: 0,
    });
    show('publish view source', `status=${pub.status} code=${codeOf(pub) ?? '-'}`);

    const read = (): void => {
      const rdb = openRenderRead(fixture.sitePath('acme'));
      try {
        const r = createRenderData(rdb, { tenantKey: 'acme' }).source('view-posts', { limit: 10 });
        show('resolve after the change', `RESOLVED rows=${JSON.stringify(r.rows.slice(0, 3))}`);
      } catch (err) {
        const e = err as { code?: string; detail?: { reason?: string; column?: string } };
        show('resolve after the change', `REFUSED ${String(e.code)} reason=${String(e.detail?.reason)} column=${String(e.detail?.column)}`);
      } finally {
        rdb.close();
      }
    };

    const drop = site();
    try {
      drop.exec('DROP VIEW cms_v_posts_public');
    } finally {
      drop.close();
    }
    read();

    const repoint = site();
    try {
      repoint.exec('CREATE VIEW cms_v_posts_public AS SELECT path AS title, slug AS slug FROM cms_page');
    } finally {
      repoint.close();
    }
    read();

    const alter = site();
    try {
      alter.exec('DROP VIEW cms_v_posts_public');
      alter.exec('CREATE VIEW cms_v_posts_public AS SELECT slug FROM u_posts');
    } finally {
      alter.close();
    }
    read();
  }

  // ============================================================ D7
  console.log('\n=== D7. limit above max, and a negative limit ===');
  {
    const db = openRenderRead(fixture.sitePath('acme'));
    const data = createRenderData(db, { tenantKey: 'acme' });
    const vectors: { name: string; params: Record<string, unknown> }[] = [
      { name: 'limit=1000 (max is 5)', params: { status: 'published', limit: 1000 } },
      { name: 'limit=-5', params: { status: 'published', limit: -5 } },
      { name: 'limit=0', params: { status: 'published', limit: 0 } },
      { name: 'limit=2.7', params: { status: 'published', limit: 2.7 } },
      { name: 'limit="5" (the data-limit attribute is a string)', params: { status: 'published', limit: '5' } },
      { name: 'limit=Number.MAX_SAFE_INTEGER', params: { status: 'published', limit: Number.MAX_SAFE_INTEGER } },
    ];
    for (const v of vectors) {
      try {
        const r = data.source('posts', v.params);
        show(v.name, `rows=${r.rows.length} limit=${r.limit} truncated=${String(r.truncated)}`);
      } catch (err) {
        const e = err as { code?: string; detail?: { reason?: string } };
        show(v.name, `REFUSED ${String(e.code)} reason=${String(e.detail?.reason)}`);
      }
    }
    db.close();
  }

  await handle.close();
  fixture.cleanup();
})();
