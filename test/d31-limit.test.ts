/**
 * S3b item 0 / D31 — `limit_default` above `limit_max`.
 *
 * The invariant and the clamp fail differently, so each is asserted on its own path:
 *
 *   D31-0  the control: `{limit_max: 5, limit_default: 3}` publishes and renders 3 rows
 *   D31-1  **publish refuses** `{limit_max: 5, limit_default: 50}` with the taxonomy's
 *          `param_invalid`, `detail.field='limit_default'`, and writes **no row**
 *   D31-2  a spec that **bypassed publish** (written straight into `cms_datasource.spec_json`,
 *          which the schema checks for `json_valid` and nothing else) renders **clamped to 5**,
 *          not 50 and not a refusal
 *
 * The two mutation controls are run in `scratch/s3b/mutations.ts` and reported in
 * `docs/build/S3b-report.md`: removing the publish refusal must redden D31-1 only, and removing
 * the compile clamp must redden D31-2 only. That is what makes each test an exclusive witness
 * rather than a second opinion about the same code.
 */
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { after, before, test } from 'node:test';

import { openAdminWrite } from '../app/db/classes.ts';
import { runDdl } from '../app/ddl/run.ts';
import { AppError } from '../app/errors.ts';
import { publishSource } from '../app/sources/publish.ts';
import { resolveSource } from '../app/sources/resolve.ts';
import { makeFixture, type Fixture } from './helpers/fixture.ts';

const ACTOR = { userId: 7, label: 'owner@acme.test' };
/** A ceiling load cannot cross; the 1.5 ms product budget is `make test-perf`'s subject. */
const TEST_BUDGET_MS = 1_000;

let fixture: Fixture;
let file: string;

function site(): Database.Database {
  return openAdminWrite(file);
}

const SPEC = {
  table: 'u_posts',
  columns: ['title', 'slug'],
  where: [{ col: 'status', op: '=' as const, param: 'status' }],
  order: [{ col: 'published_at', dir: 'desc' as const }],
};
const PARAMS = [{ name: 'status', kind: 'enum' as const, values: ['published'] }];

function count(table: string): number {
  const db = site();
  try {
    return Number((db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n);
  } finally {
    db.close();
  }
}

before(() => {
  fixture = makeFixture({ specs: [{ key: 'acme', hosts: ['acme.test'], title: 'Acme' }] });
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
      { op: 'create_index', table: 'u_posts', name: 'ix_posts_slug', columns: ['slug'], unique: true },
      { op: 'create_index', table: 'u_posts', name: 'ix_posts_published_at', columns: ['published_at'], unique: false },
      { op: 'create_index', table: 'u_posts', name: 'ix_posts_status', columns: ['status'], unique: false },
    ],
    { actor: ACTOR },
  );
  const db = site();
  try {
    const insert = db.prepare('INSERT INTO u_posts (title, slug, status, published_at) VALUES (?, ?, ?, ?)');
    // 30 published rows, so a limit of 50 that leaked through would be visibly 30 and a
    // clamp to 5 is visibly 5 — the assertion does not depend on a table that happens to be small.
    for (let i = 1; i <= 30; i += 1) {
      insert.run(`Post ${i}`, `post-${i}`, 'published', `2026-09-${String(i).padStart(2, '0')}T00:00:00.000Z`);
    }
  } finally {
    db.close();
  }
});

after(() => fixture.cleanup());

// --- D31-0: the control ------------------------------------------------------------------

test('D31-0. control — limit_default below limit_max publishes and renders that many rows', () => {
  const report = publishSource(
    file,
    {
      key: 'ten-rows',
      kind: 'query',
      spec: { ...SPEC, limit_default: 3, limit_max: 5 },
      params: PARAMS,
      isPublic: true,
      ttlS: 60,
      budgetMsMax: TEST_BUDGET_MS,
    },
    ACTOR,
  );
  assert.equal(report.key, 'ten-rows');

  const db = site();
  try {
    const resolved = resolveSource(db, 'ten-rows', { tenantKey: 'acme' });
    assert.equal(resolved.limit, 3);
    assert.equal(resolved.rows.length, 3);
    assert.equal(resolved.truncated, false);
  } finally {
    db.close();
  }
});

// --- D31-1: publish refuses --------------------------------------------------------------

test('D31-1. publish refuses limit_default > limit_max, names the field, and writes no row', () => {
  const before = count('cms_datasource');
  assert.throws(
    () =>
      publishSource(
        file,
        {
          key: 'over-the-ceiling',
          kind: 'query',
          spec: { ...SPEC, limit_default: 50, limit_max: 5 },
          params: PARAMS,
          isPublic: true,
          ttlS: 60,
          budgetMsMax: TEST_BUDGET_MS,
        },
        ACTOR,
      ),
    (err: unknown) => {
      assert.ok(err instanceof AppError, `not an AppError: ${String(err)}`);
      assert.equal(err.code, 'SKW_E_RT_SOURCE_UNKNOWN');
      assert.equal(err.status, 422);
      const detail = err.detail as Record<string, unknown>;
      assert.equal(detail.reason, 'param_invalid', 'the refusal must be the limit rule, not a generic spec error');
      assert.equal(detail.param, 'limit');
      assert.equal(detail.field, 'limit_default', 'the field must be named: limit_max is a legal value here');
      assert.equal(detail.limit_default, 50);
      assert.equal(detail.limit_max, 5);
      return true;
    },
  );
  assert.equal(count('cms_datasource'), before, 'a refused publish wrote a row');
  // And no draft either: the refusal is before any write, not a rollback of one.
  const db = site();
  try {
    const row = db.prepare('SELECT count(*) AS n FROM cms_datasource WHERE key = ?').get('over-the-ceiling') as { n: number };
    assert.equal(row.n, 0);
  } finally {
    db.close();
  }
});

// --- D31-2: render clamps a row that never passed publish ---------------------------------

test('D31-2. a spec that bypassed publish renders clamped to limit_max, not refused and not 50', () => {
  // The schema checks `spec_json` for `json_valid` only, so this row is exactly what a restored
  // backup or a hand-written migration produces: a published, public source nobody gated.
  const db = site();
  try {
    db.prepare(
      `INSERT INTO cms_datasource (key, kind, spec_json, params_json, is_public, ttl_s, published_at)
       VALUES (?, 'query', ?, ?, 1, 60, '2026-01-01T00:00:00.000Z')`,
    ).run(
      'sneaked-in',
      JSON.stringify({
        table: 'u_posts',
        columns: ['title', 'slug'],
        where: [{ col: 'status', op: '=', param: 'status' }],
        order: [{ col: 'published_at', dir: 'desc' }],
        limit_default: 50,
        limit_max: 5,
      }),
      JSON.stringify([{ name: 'status', kind: 'enum', values: ['published'] }]),
    );
    const resolved = resolveSource(db, 'sneaked-in', { tenantKey: 'acme', params: { status: 'published' } });
    assert.equal(resolved.limit, 5, `the render served ${resolved.limit} rows for a ceiling of 5`);
    assert.equal(resolved.rows.length, 5);
    // A clamp is not a truncation: nothing was asked for, so there is no `data-truncated`.
    assert.equal(resolved.truncated, false);

    // The control for the clamp: the same row with a default inside the ceiling is honest.
    db.prepare(
      `INSERT INTO cms_datasource (key, kind, spec_json, params_json, is_public, ttl_s, published_at)
       VALUES (?, 'query', ?, ?, 1, 60, '2026-01-01T00:00:00.000Z')`,
    ).run(
      'inside-the-ceiling',
      JSON.stringify({
        table: 'u_posts',
        columns: ['title', 'slug'],
        where: [{ col: 'status', op: '=', param: 'status' }],
        order: [{ col: 'published_at', dir: 'desc' }],
        limit_default: 4,
        limit_max: 5,
      }),
      JSON.stringify([{ name: 'status', kind: 'enum', values: ['published'] }]),
    );
    const honest = resolveSource(db, 'inside-the-ceiling', { tenantKey: 'acme', params: { status: 'published' } });
    assert.equal(honest.limit, 4);
    assert.equal(honest.rows.length, 4);
  } finally {
    db.close();
  }
});

// --- the compile-level clamp, which is the one a hand-built spec meets --------------------

test('D31-3. compile() clamps a hand-built spec, so the clamp is not only a parse-time habit', async () => {
  const { compile } = await import('../app/sources/compile.ts');
  const spec = {
    kind: 'query' as const,
    relation: 'u_posts',
    columns: ['title'],
    where: [],
    order: [],
    limitDefault: 50,
    limitMax: 5,
    aggregate: null,
    groupBy: [],
    params: [],
  };
  const allowed = {
    columns: new Set(['title']),
    indexed: new Set<string>(),
    drifted: new Set<string>(),
    relation: 'u_posts',
  };
  const compiled = compile(spec, allowed, {});
  assert.equal(compiled.limit, 5);
  assert.equal(compiled.bind.at(-1), 5, 'the bound LIMIT is not the clamped value');
});