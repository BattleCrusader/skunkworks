/**
 * D6 (`S2-qa.md` §2.1, §3.3 `a1.`, §6) — an out-of-band column drop must surface as a
 * taxonomy refusal, not as a raw `SQLITE_ERROR` that becomes a 500 on a public render.
 *
 * The defect, exactly as QA reproduced it: `cms_table_registry.columns_json` still names
 * `slug`, the live table lost it, so the allowlist agreed with the source and disagreed
 * with the database. `db.prepare()` then threw `no such column: "slug"`, which is not an
 * `AppError`, so `sendError` turned it into `500 SKW_E_PLT_INTERNAL` — a status that says
 * "our bug" to a reader and a code that says nothing about which column moved.
 *
 * What this file gates:
 *
 *   D6-1  the resolver refuses with `422 SKW_E_RT_SOURCE_UNKNOWN`, `reason='column_drift'`,
 *         naming the column and the relation;
 *   D6-2  a source that does not name the drifted column still resolves — drift is not a
 *         licence to take out every page on the table;
 *   D6-3  the refusal writes one log line naming the drifted column (the operator's half);
 *   D6-4  the catch-all maps a real SQLite error from the resolve statement to the same
 *         code, so a drift that lands between the allowlist read and the prepare (TOCTOU)
 *         is not a 500 either;
 *   D6-5  on the wire: 422, a taxonomy body, and **zero** stack frames, paths or SQL text.
 */
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { after, before, test } from 'node:test';

import { openRenderRead } from '../app/db/classes.ts';
import { runDdl } from '../app/ddl/run.ts';
import { CODE_PATTERN } from '../app/errors.ts';
import { loadEnv } from '../app/env.ts';
import { buildApp, type AppHandle } from '../app/main.ts';
import { createRenderData } from '../app/render/data.ts';
import { publishSource, type SourceInput } from '../app/sources/publish.ts';
import { setDriftLogSink } from '../app/sources/registry.ts';
import { mapSourceSqliteError, resolveSource } from '../app/sources/resolve.ts';
import { makeFixture, type Fixture } from './helpers/fixture.ts';

const ACTOR = { userId: 7, label: 'qa@acme.test' };
const D6_PATH = '/__d6/drift';

let fixture: Fixture;
let file: string;
let handle: AppHandle;
const driftLines: string[] = [];

const POSTS: SourceInput = {
  key: 'posts',
  kind: 'query',
  spec: {
    table: 'u_posts',
    columns: ['title', 'slug'],
    where: [{ col: 'status', op: '=', param: 'status' }],
    order: [{ col: 'published_at', dir: 'desc' }],
    limit_default: 3,
    limit_max: 5,
  },
  params: [{ name: 'status', kind: 'enum', values: ['published', 'draft'] }],
  isPublic: true,
  ttlS: 0,
  budgetMsMax: 1_000,
};

/** Names no drifted column: the control that must keep rendering. */
const TITLES: SourceInput = {
  ...POSTS,
  key: 'titles',
  spec: {
    table: 'u_posts',
    columns: ['title'],
    where: [{ col: 'status', op: '=', param: 'status' }],
    limit_default: 3,
    limit_max: 5,
  },
};

before(async () => {
  fixture = makeFixture({ specs: [{ key: 'acme', hosts: ['acme.test'] }] });
  file = fixture.sitePath('acme');
  runDdl(
    file,
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
  {
    const db = new Database(file);
    try {
      for (let i = 1; i <= 3; i += 1) {
        db.prepare('INSERT INTO u_posts (title, slug, status, published_at) VALUES (?,?,?,?)').run(
          `Post ${i}`,
          `post-${i}`,
          'published',
          `2026-10-0${i}T00:00:00Z`,
        );
      }
    } finally {
      db.close();
    }
  }
  publishSource(file, POSTS, ACTOR);
  publishSource(file, TITLES, ACTOR);

  setDriftLogSink((line) => driftLines.push(line));

  handle = await buildApp({ env: loadEnv(fixture.env) });
  // The route is registered by the gate, not by the app: v1 has no page-level `list`
  // (that is S4), so there is no product route that resolves a source today. Everything
  // under test is the app's — `sendError`, `setErrorHandler`, the render-read class and
  // the resolver — and the closure is the one the Astro page will call.
  handle.app.get(D6_PATH, () => {
    const db = openRenderRead(file);
    try {
      return createRenderData(db, { tenantKey: 'acme' }).source('posts', { status: 'published' });
    } finally {
      db.close();
    }
  });
});

after(async () => {
  setDriftLogSink(null);
  await handle.close();
  fixture.cleanup();
});

test('D6-0. the control resolves before any drift', () => {
  const db = openRenderRead(file);
  try {
    const rows = resolveSource(db, 'posts', { tenantKey: 'acme', params: { status: 'published' } }).rows;
    assert.equal(rows.length, 3);
  } finally {
    db.close();
  }
});

test('D6-1. an out-of-band column drop refuses with the taxonomy code, naming the column', () => {
  // Out of band: no DDL runner, so `cms_table_registry.columns_json` still lists `slug`.
  const writer = new Database(file);
  try {
    writer.exec('ALTER TABLE u_posts DROP COLUMN slug');
  } finally {
    writer.close();
  }

  const db = openRenderRead(file);
  try {
    assert.throws(
      () => resolveSource(db, 'posts', { tenantKey: 'acme', params: { status: 'published' } }),
      (err: unknown) => {
        const e = err as { code?: string; status?: number; detail?: { reason?: string; column?: string; relation?: string } };
        assert.equal(e.code, 'SKW_E_RT_SOURCE_UNKNOWN', `expected a taxonomy code, got ${String(e.code)}`);
        assert.equal(e.status, 422);
        assert.equal(e.detail?.reason, 'column_drift');
        assert.equal(e.detail?.column, 'slug');
        assert.equal(e.detail?.relation, 'u_posts');
        return true;
      },
    );
  } finally {
    db.close();
  }
});

test('D6-2. a source that does not name the drifted column still resolves', () => {
  const db = openRenderRead(file);
  try {
    const rows = resolveSource(db, 'titles', { tenantKey: 'acme', params: { status: 'published' } }).rows;
    assert.equal(rows.length, 3);
  } finally {
    db.close();
  }
});

test('D6-3. the refusal logs one line that names the drifted column', () => {
  assert.equal(driftLines.length >= 1, true, 'no drift line was written');
  const line = driftLines.at(-1) ?? '';
  assert.match(line, /column_drift/);
  assert.match(line, /tenant=acme/);
  assert.match(line, /relation=u_posts/);
  assert.match(line, /column=slug/);
});

test('D6-4. a real SQLite error from the resolve statement is mapped, not rethrown', () => {
  const db = openRenderRead(file);
  try {
    let real: unknown;
    try {
      db.prepare('SELECT "nope" FROM u_posts').all();
    } catch (err) {
      real = err;
    }
    assert.ok(real instanceof Error, 'the probe did not raise a SQLite error');
    assert.equal((real as { code?: string }).code, 'SQLITE_ERROR');
    const mapped = mapSourceSqliteError(real, { tenantKey: 'acme', source: 'posts', relation: 'u_posts' });
    assert.ok(mapped !== null);
    assert.equal(mapped.code, 'SKW_E_RT_SOURCE_UNKNOWN');
    assert.equal((mapped.detail as { reason?: string }).reason, 'column_drift');
    assert.equal((mapped.detail as { column?: string }).column, 'nope');
    // A non-SQLite failure is not swallowed into a refusal.
    assert.equal(mapSourceSqliteError(new Error('boom'), { tenantKey: 'acme', source: 'posts', relation: 'u_posts' }), null);
  } finally {
    db.close();
  }
});

test('D6-5. on the wire: 422, a taxonomy body, and no stack, path or SQL text', async () => {
  const res = await handle.app.inject({ method: 'GET', url: D6_PATH, headers: { host: 'acme.test' } });
  assert.equal(res.statusCode, 422, `a drifted source must not 500; body: ${res.body}`);
  assert.match(String(res.headers['content-type']), /application\/json/);

  const body = res.body;
  const parsed = JSON.parse(body) as { error?: { code?: string; requestId?: string; detail?: { reason?: string } } };
  assert.ok(parsed.error !== undefined);
  assert.equal(parsed.error.code, 'SKW_E_RT_SOURCE_UNKNOWN');
  assert.ok(CODE_PATTERN.test(String(parsed.error.code)));
  assert.equal(parsed.error.detail?.reason, 'column_drift');
  assert.equal(typeof parsed.error.requestId, 'string');

  // Zero stack frames: no `at fn (file:line)`, no source path, no module path, no SQL.
  assert.equal(/\n\s+at\s/.test(body), false, `a stack frame leaked: ${body}`);
  assert.equal(/node_modules/.test(body), false, `a module path leaked: ${body}`);
  assert.equal(/\.ts:\d+/.test(body), false, `a source path leaked: ${body}`);
  assert.equal(/SQLITE_ERROR/.test(body), false, `a driver code leaked: ${body}`);
  assert.equal(/no such column/i.test(body), false, `SQLite's message leaked: ${body}`);
  assert.equal(/SELECT |INSERT |PRAGMA /i.test(body), false, `SQL text leaked: ${body}`);
  assert.equal(body.includes('/Volumes/'), false, 'an absolute path leaked');
});
