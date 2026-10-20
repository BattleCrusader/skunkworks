/**
 * S2e (1–3) — the Data Source registry, the resolver on `render-read`, and the
 * publish gate that refuses a plan containing SCAN (SDS §6.1/§6.2).
 *
 * Every test runs against a real `site.db` built by the real DDL runner, so
 * `cms_table_registry.columns_json` — the column allowlist — is the one the app
 * writes, not a fixture's guess.
 */
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { openAdminWrite, openRenderRead } from '../app/db/classes.ts';
import { runDdl } from '../app/ddl/run.ts';
import { createRenderData } from '../app/render/data.ts';
import { SourceCache } from '../app/sources/cache.ts';
import { publishSource, saveSourceDraft, type SourceInput } from '../app/sources/publish.ts';
import { hashRelationSql, resetViewChecksumStats, viewChecksumStats } from '../app/sources/registry.ts';
import { resolveSource } from '../app/sources/resolve.ts';
import { makeFixture, REPO, type Fixture } from './helpers/fixture.ts';

const ACTOR = { userId: 7, label: 'owner@acme.test' };

/**
 * The ceiling the fixture publishes state, in ms. Not the product's 1.5 ms budget — that is a
 * wall-clock statistic, and `make test` must not be decided by the box (see `POSTS` below).
 */
const TEST_BUDGET_MS = 1_000;

let fixture: Fixture;
let file: string;

function site(): Database.Database {
  return openAdminWrite(file);
}

function count(db: Database.Database, sql: string, ...args: unknown[]): number {
  const row = db.prepare(sql).get(...(args as never[])) as { n: number } | undefined;
  return Number(row?.n ?? 0);
}

const SPEC = {
  table: 'u_posts',
  columns: ['title', 'slug'],
  where: [{ col: 'status', op: '=' as const, param: 'status' }],
  order: [{ col: 'published_at', dir: 'desc' as const }],
  limit_default: 3,
  limit_max: 50,
};

/** The source under test: filter on `status`, order by `published_at`. */
const POSTS: SourceInput = {
  key: 'posts',
  kind: 'query',
  spec: SPEC,
  params: [{ name: 'status', kind: 'enum', values: ['published', 'draft'] }],
  isPublic: true,
  ttlS: 60,
  // §6.1's 1.5 ms ceiling is a wall-clock **rate** measurement, so `make test` must not let the
  // box decide whether this publish succeeds: under six `yes(1)` processes one publish in ten
  // measured 1.401 ms against the 1.5 ms ceiling (`make test-perf` prints the numbers). Every
  // fixture publish here therefore states a ceiling that load cannot cross; the budget's real
  // value is asserted by `make test-perf` P-1, and its refusal is proved structurally by S2E-3
  // (`budgetMsMax: 0`) and V1-4 (`budgetMsMax: 0` on a `view`).
  budgetMsMax: TEST_BUDGET_MS,
};

/** The source the plan gate refuses: `section` has no index until S2E-2 adds one. */
const SECTION: SourceInput = {
  ...POSTS,
  key: 'posts-by-section',
  spec: {
    ...SPEC,
    where: [{ col: 'section', op: '=' as const, param: 'section' }],
  },
  params: [{ name: 'section', kind: 'enum', values: ['news', 'blog'] }],
};

function insertPosts(db: Database.Database): void {
  const insert = db.prepare('INSERT INTO u_posts (title, slug, status, section, published_at) VALUES (?, ?, ?, ?, ?)');
  for (let i = 1; i <= 5; i += 1) {
    insert.run(`Published ${i}`, `published-${i}`, 'published', 'news', `2026-10-0${i}T00:00:00.000Z`);
  }
  insert.run('Draft one', 'draft-1', 'draft', 'blog', '2026-09-01T00:00:00.000Z');
  insert.run('Draft two', 'draft-2', 'draft', 'blog', '2026-09-02T00:00:00.000Z');
}

before(() => {
  fixture = makeFixture({
    specs: [{ key: 'acme', hosts: ['acme.test'], title: 'Acme', body: '<h1>acme</h1>' }],
  });
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
          { name: 'section', type: 'TEXT', notNull: true },
          { name: 'published_at', type: 'DATE' },
        ],
      },
      { op: 'create_index', table: 'u_posts', name: 'ix_posts_slug', columns: ['slug'], unique: true },
      { op: 'create_index', table: 'u_posts', name: 'ix_posts_published_at', columns: ['published_at'], unique: false },
      // `status` is indexed from the start; the plan gate's witness is `section`.
      { op: 'create_index', table: 'u_posts', name: 'ix_posts_status', columns: ['status'], unique: false },
    ],
    { actor: ACTOR },
  );
  const db = site();
  try {
    insertPosts(db);
  } finally {
    db.close();
  }
  // One published source the read-side tests resolve; each test that mutates the
  // schema creates its own key, so a single test can be run on its own.
  publishSource(file, POSTS, ACTOR);
});

after(() => {
  fixture.cleanup();
});

// --- 2. the publish gate: a SCAN refuses, and the error names the column ---

test('S2E-1. a query source with SCAN in its plan is refused at publish, naming the column that caused it', () => {
  assert.equal(existsSync(join(fixture.dir, 'tenants', 'acme', 'content', 'sources')), false);
  let error: unknown;
  try {
    publishSource(file, SECTION, ACTOR);
  } catch (err) {
    error = err;
  }
  assert.ok(error !== undefined, 'an unindexed filter column must be refused');
  const e = error as { code?: string; message?: string; detail?: { column?: string; plan?: string[]; role?: string } };
  assert.equal(e.code, 'SKW_E_RT_SOURCE_UNINDEXED');
  assert.equal(e.detail?.column, 'section', `the refusal must name section; detail was ${JSON.stringify(e.detail)}`);
  // Refused by the INDEX rule, not by the plan rule: the shape says which control fired (E-22).
  assert.equal(e.detail?.role, 'where');
  const plan = (e.detail?.plan ?? []).join('\n');
  assert.match(plan, /SCAN/);
  assert.match(e.message ?? '', /section/);
  // Nothing was written: a refused publish leaves no registry row.
  const db = site();
  try {
    assert.equal(count(db, "SELECT count(*) AS n FROM cms_datasource WHERE key = 'posts-by-section'"), 0);
    assert.equal(count(db, "SELECT count(*) AS n FROM cms_audit WHERE action = 'source.publish' AND target_id = 'posts-by-section'"), 0);
  } finally {
    db.close();
  }
});

test('S2E-11. a plan-only SCAN is refused even when every column it names is indexed, and the refusal names the plan (exclusive witness for refusePlan)', () => {
  // `status` IS indexed in the fixture — asserted here, so this case cannot silently degrade into
  // S2E-1 (where `section` is not indexed and the index rule refuses first).
  const admin = site();
  try {
    const indexed = (admin.prepare("PRAGMA index_info('ix_posts_status')").all() as { name: string }[]).map((c) => c.name);
    assert.deepEqual(indexed, ['status'], 'the fixture must index status for this case to mean anything');
  } finally {
    admin.close();
  }

  const PLAN_ONLY: SourceInput = {
    ...POSTS,
    key: 'posts-not-published',
    // An inequality does not start a SEARCH: SQLite plans `SCAN u_posts` even with the index there,
    // so `assertIndexedColumns` passes and only `refusePlan` can refuse this spec.
    spec: { ...SPEC, where: [{ col: 'status', op: '!=' as const, param: 'status' }] },
  };
  let error: unknown;
  try {
    publishSource(file, PLAN_ONLY, ACTOR);
  } catch (err) {
    error = err;
  }
  assert.ok(error !== undefined, 'a plan-only SCAN must be refused');
  const e = error as {
    code?: string;
    message?: string;
    detail?: { column?: string | null; plan?: string[]; reason?: string; role?: string; relation?: string };
  };
  assert.equal(e.code, 'SKW_E_RT_SOURCE_UNINDEXED');
  // The two refusals are distinguishable by shape, which is what lets a test name one of them.
  assert.equal(e.detail?.reason, 'plan_scan');
  assert.equal(e.detail?.role, 'plan');
  assert.equal(e.detail?.column, null, 'there is no culprit column: every referenced column is indexed');
  assert.equal(e.detail?.relation, 'u_posts');
  assert.match((e.detail?.plan ?? []).join('\n'), /SCAN/);
  assert.equal(
    e.message,
    'the plan for source u_posts contains SCAN although every referenced column is indexed; the predicate does not start a SEARCH',
  );
  // Nothing was written.
  const db = site();
  try {
    assert.equal(count(db, "SELECT count(*) AS n FROM cms_datasource WHERE key = 'posts-not-published'"), 0);
  } finally {
    db.close();
  }

  // The positive control in the same suite (§13.1a rule 3): the same spec with the offending
  // property removed — equality instead of inequality — publishes.
  const control = publishSource(file, { ...POSTS, key: 'posts-published-only' }, ACTOR);
  assert.equal(control.kind, 'query');
  assert.match(control.plan.join('\n'), /SEARCH/);
});

test('S2E-2. adding the index the refusal named makes the same source publish, with the measured cost stored', () => {
  runDdl(
    file,
    [{ op: 'create_index', table: 'u_posts', name: 'ix_posts_section', columns: ['section'], unique: false }],
    { actor: ACTOR },
  );
  const report = publishSource(file, SECTION, ACTOR);
  assert.equal(report.key, 'posts-by-section');
  assert.ok(report.plan.join('\n').includes('SEARCH'), `the plan must contain SEARCH:\n${report.plan.join('\n')}`);
  assert.ok(!report.plan.join('\n').includes('SCAN'), `the plan must contain no SCAN:\n${report.plan.join('\n')}`);
  // The measurement is real and is stored — asserted as a **shape**, never as a wall-clock value:
  // a max-of-200 statistic measures the box (`make test-perf` P-1 asserts it against the 1.5 ms
  // ceiling, with the idle baseline and the load evidence beside it). What `make test` owns is
  // that the gate measured something and recorded it, which is what a regression in this path
  // would break.
  assert.equal(typeof report.cost_ms_max, 'number');
  assert.ok(Number.isFinite(Number(report.cost_ms_max)) && Number(report.cost_ms_max) > 0);
  assert.equal(typeof report.cost_ms_p95, 'number');
  assert.ok(report.cost_rows !== null && report.cost_rows >= 7, 'cost_rows records the relation size the measurement was taken at');

  const db = site();
  try {
    const row = db
      .prepare('SELECT kind, is_public, cost_ms_max, cost_ms_p95, cost_rows, cost_plan, published_at, published_by FROM cms_datasource WHERE key = ?')
      .get('posts-by-section') as Record<string, unknown>;
    assert.equal(row.kind, 'query');
    assert.equal(row.is_public, 1);
    assert.equal(typeof row.published_at, 'string');
    assert.equal(row.published_by, ACTOR.userId);
    assert.match(String(row.cost_plan), /SEARCH/);
    assert.equal(count(db, "SELECT count(*) AS n FROM cms_audit WHERE action = 'source.publish' AND target_id = 'posts-by-section'"), 1);
  } finally {
    db.close();
  }
});

test('S2E-3. group_by of three columns and an over-budget cost are refused with their own codes', () => {
  const three = {
    ...POSTS,
    key: 'posts-three',
    spec: { ...SPEC, group_by: ['status', 'title', 'slug'], aggregate: { fn: 'count', column: 'id' } },
  } as SourceInput;
  assert.throws(
    () => publishSource(file, three, ACTOR),
    (err: { code?: string; detail?: { reason?: string } }) =>
      err.code === 'SKW_E_RT_SOURCE_BUDGET' && err.detail?.reason === 'group_by',
  );

  // A deliberately impossible budget: the gate reads cost_ms_max from measurement,
  // so a source that measures above the configured ceiling is refused.
  assert.throws(
    () => publishSource(file, { ...POSTS, key: 'posts-budget', budgetMsMax: 0 }, ACTOR),
    (err: { code?: string; detail?: { reason?: string } }) => err.code === 'SKW_E_RT_SOURCE_BUDGET' && err.detail?.reason === 'cost',
  );
});

// --- 1. is_public, the resolver, the allowlist ---

test('S2E-4. is_public=false is refused by the resolver; an audited publish flips it and the same call resolves', () => {
  publishSource(file, { ...POSTS, key: 'private-posts', isPublic: false }, ACTOR);
  const db = openRenderRead(file);
  try {
    assert.throws(
      () => resolveSource(db, 'private-posts', { tenantKey: 'acme', params: { status: 'published' } }),
      (err: { code?: string; detail?: { reason?: string } }) =>
        err.code === 'SKW_E_RT_SOURCE_UNKNOWN' && err.detail?.reason === 'not_public',
    );
    // An unpublished row is refused too — `is_public` alone is not publication.
    saveSourceDraft(file, { ...POSTS, key: 'draft-posts', isPublic: true }, ACTOR);
    assert.throws(
      () => resolveSource(db, 'draft-posts', { tenantKey: 'acme', params: { status: 'published' } }),
      (err: { code?: string; detail?: { reason?: string } }) =>
        err.code === 'SKW_E_RT_SOURCE_UNKNOWN' && err.detail?.reason === 'not_published',
    );

    // `is_public` defaults false: omitting it must not publish a public source.
    const { isPublic: _omitted, ...withoutPublic } = POSTS;
    const defaulted = publishSource(file, { ...withoutPublic, key: 'default-private' }, ACTOR);
    assert.equal(defaulted.is_public, false);
    assert.throws(
      () => resolveSource(db, 'default-private', { tenantKey: 'acme', params: { status: 'published' } }),
      (err: { code?: string; detail?: { reason?: string } }) =>
        err.code === 'SKW_E_RT_SOURCE_UNKNOWN' && err.detail?.reason === 'not_public',
    );

    publishSource(file, { ...POSTS, key: 'private-posts', isPublic: true }, ACTOR);
    const resolved = resolveSource(db, 'private-posts', { tenantKey: 'acme', params: { status: 'published' } });
    assert.equal(resolved.rows.length, 3);
    assert.deepEqual(resolved.rows[0], { title: 'Published 5', slug: 'published-5' });
  } finally {
    db.close();
  }
  const audit = site();
  try {
    assert.equal(count(audit, "SELECT count(*) AS n FROM cms_audit WHERE action = 'source.publish' AND target_id = 'private-posts'"), 2);
    assert.equal(count(audit, "SELECT count(*) AS n FROM cms_audit WHERE action = 'source.draft' AND target_id = 'draft-posts'"), 1);
  } finally {
    audit.close();
  }
});

test('S2E-5. a column outside the allowlist is refused at publish AND at resolve time', () => {
  const bad = {
    ...POSTS,
    key: 'posts-bad-column',
    spec: { ...SPEC, columns: ['title', 'secret_col'] },
  } as SourceInput;
  assert.throws(
    () => publishSource(file, bad, ACTOR),
    (err: { code?: string; message?: string; detail?: { column?: string } }) =>
      err.code === 'SKW_E_RT_SOURCE_UNKNOWN' && err.detail?.column === 'secret_col' && /secret_col/.test(err.message ?? ''),
  );

  // Publish a valid source, then change the schema's record: the column the source
  // names no longer exists, so the resolver must refuse rather than emit SQL.
  publishSource(file, { ...POSTS, key: 'posts-vanished' }, ACTOR);
  const db = openRenderRead(file);
  try {
    const before = resolveSource(db, 'posts-vanished', { tenantKey: 'acme', params: { status: 'published' } });
    assert.equal(before.rows.length, 3);
  } finally {
    db.close();
  }

  const admin = site();
  try {
    const row = admin.prepare("SELECT columns_json FROM cms_table_registry WHERE table_name = 'u_posts'").get() as { columns_json: string };
    const columns = JSON.parse(row.columns_json) as { name: string }[];
    const without = columns.filter((c) => c.name !== 'title');
    admin
      .prepare("UPDATE cms_table_registry SET columns_json = ?, column_count = ? WHERE table_name = 'u_posts'")
      .run(JSON.stringify(without), without.length);
  } finally {
    admin.close();
  }

  const db2 = openRenderRead(file);
  try {
    assert.throws(
      () => resolveSource(db2, 'posts-vanished', { tenantKey: 'acme', params: { status: 'published' } }),
      (err: { code?: string; detail?: { column?: string } }) =>
        err.code === 'SKW_E_RT_SOURCE_UNKNOWN' && err.detail?.column === 'title',
    );
  } finally {
    db2.close();
  }

  // Restore the registry for the tests that follow.
  const restore = site();
  try {
    const row = restore.prepare("SELECT columns_json FROM cms_table_registry WHERE table_name = 'u_posts'").get() as { columns_json: string };
    const columns = JSON.parse(row.columns_json) as { name: string; type?: string; notNull?: boolean }[];
    columns.push({ name: 'title', type: 'TEXT', notNull: true });
    restore
      .prepare("UPDATE cms_table_registry SET columns_json = ?, column_count = ? WHERE table_name = 'u_posts'")
      .run(JSON.stringify(columns), columns.length);
  } finally {
    restore.close();
  }
});

// --- 1. the cache key contains the parameters -----------------------------

function signature(rows: readonly Record<string, unknown>[]): string {
  return rows.map((r) => JSON.stringify(r)).join('|');
}

test('S2E-6. two parameter sets inside one TTL return their own rows, in both orders (O-10)', () => {
  const clock = 1_000_000;
  const a = new SourceCache({ now: () => clock });
  const db = openRenderRead(file);
  try {
    const three = resolveSource(db, 'posts', { tenantKey: 'acme', params: { status: 'published', limit: 3 }, cache: a });
    const five = resolveSource(db, 'posts', { tenantKey: 'acme', params: { status: 'published', limit: 5 }, cache: a });
    assert.equal(three.rows.length, 3, 'the {limit:3} request got the wrong row count');
    assert.equal(five.rows.length, 5, 'the {limit:5} request was served the {limit:3} entry');
    assert.notEqual(signature(three.rows), signature(five.rows), 'the two parameter sets returned the same rows');

    // A second cache, opposite order: the values must follow the parameters, not
    // whichever request happened to fill the cache first.
    const b = new SourceCache({ now: () => clock });
    const fiveFirst = resolveSource(db, 'posts', { tenantKey: 'acme', params: { status: 'published', limit: 5 }, cache: b });
    const threeSecond = resolveSource(db, 'posts', { tenantKey: 'acme', params: { status: 'published', limit: 3 }, cache: b });
    assert.equal(fiveFirst.rows.length, 5);
    assert.equal(threeSecond.rows.length, 3);
    assert.notEqual(signature(fiveFirst.rows), signature(threeSecond.rows));

    // And an enum parameter set is its own key too.
    const c = new SourceCache({ now: () => clock });
    const drafts = resolveSource(db, 'posts', { tenantKey: 'acme', params: { status: 'draft', limit: 5 }, cache: c });
    const published = resolveSource(db, 'posts', { tenantKey: 'acme', params: { status: 'published', limit: 5 }, cache: c });
    assert.equal(drafts.rows.length, 2);
    assert.equal(published.rows.length, 5);
    assert.notEqual(signature(drafts.rows), signature(published.rows));
  } finally {
    db.close();
  }
  assert.equal(a.size, 2);
});

test('S2E-7. TTL: a row inserted after publish is invisible before the TTL and visible after it', () => {
  publishSource(file, { ...POSTS, key: 'posts-ttl', ttlS: 1 }, ACTOR);
  let clock = 5_000_000;
  const cache = new SourceCache({ now: () => clock });
  const db = openRenderRead(file);
  try {
    const first = resolveSource(db, 'posts-ttl', { tenantKey: 'acme', params: { status: 'draft', limit: 10 }, cache });
    assert.equal(first.rows.length, 2);

    const admin = site();
    try {
      admin
        .prepare('INSERT INTO u_posts (title, slug, status, section, published_at) VALUES (?, ?, ?, ?, ?)')
        .run('Draft three', 'draft-3', 'draft', 'blog', '2026-09-03T00:00:00.000Z');
    } finally {
      admin.close();
    }

    const beforeExpiry = resolveSource(db, 'posts-ttl', { tenantKey: 'acme', params: { status: 'draft', limit: 10 }, cache });
    assert.equal(beforeExpiry.rows.length, 2, 'a cached entry must not see a row written after it was cached');

    clock += 1_001;
    const afterExpiry = resolveSource(db, 'posts-ttl', { tenantKey: 'acme', params: { status: 'draft', limit: 10 }, cache });
    assert.equal(afterExpiry.rows.length, 3, 'the TTL expired and the resolver must re-read');
  } finally {
    db.close();
  }
});

// --- 1. `function` is refused with its code, and nothing is loaded --------

test('S2E-8. a `function` source is refused with C-18\'s code and no file is loaded', () => {
  const sourcesDir = join(fixture.dir, 'tenants', 'acme', 'content', 'sources');
  mkdirSync(sourcesDir, { recursive: true });
  const marker = join(fixture.dir, 'loaded-marker');
  const evil = join(sourcesDir, 'evil.mjs');
  writeFileSync(evil, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'loaded');\n`);

  const opened: string[] = [];
  let error: unknown;
  try {
    publishSource(
      file,
      { ...POSTS, key: 'evil', kind: 'function', spec: { file: 'evil.mjs' } } as unknown as SourceInput,
      ACTOR,
      {
        open: (path: string) => {
          opened.push(path);
          return openAdminWrite(path);
        },
      },
    );
  } catch (err) {
    error = err;
  }
  assert.ok(error !== undefined, 'a function source must be refused');
  const e = error as { code?: string; message?: string; detail?: { kind?: string; register?: string; reason?: string } };
  assert.equal(e.code, 'SKW_E_RT_SOURCE_UNKNOWN');
  assert.equal(e.detail?.reason, 'kind_not_representable');
  assert.equal(e.detail?.kind, 'function');
  assert.equal(e.detail?.register, 'C-18');
  assert.match(e.message ?? '', /function/);
  // Refused before any connection exists, and before anything on disk is read.
  assert.deepEqual(opened, [], 'a refused function source opened a database connection');
  assert.equal(existsSync(marker), false, 'a file under content/sources/ was loaded');

  // The schema cannot even hold the row: `kind` is CHECK(kind IN ('view','query')).
  const db = site();
  try {
    assert.throws(
      () =>
        db
          .prepare("INSERT INTO cms_datasource (key, kind, spec_json, params_json) VALUES ('fn-row', 'function', '{}', '[]')")
          .run(),
      /CHECK constraint failed/,
    );
  } finally {
    db.close();
  }

  // The code has no import/require/readFile anywhere: the module boundary is the
  // reason a `function` source cannot be loaded even if a caller asks twice.
  const moduleFiles = readdirSync(join(REPO, 'app', 'sources')).filter((f) => f.endsWith('.ts'));
  assert.ok(moduleFiles.length >= 4, 'the sources module is missing');
  for (const name of moduleFiles) {
    const text = readFileSync(join(REPO, 'app', 'sources', name), 'utf8');
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.ok(!/\bimport\s*\(/.test(code), `${name} contains a dynamic import`);
    assert.ok(!/\brequire\s*\(/.test(code), `${name} contains require()`);
    assert.ok(!/\breadFileSync\b|\breadFile\b/.test(code), `${name} reads a file`);
  }
});

// --- 3. the resolver on render-read, exposed as data to the render path ----

test('S2E-9. the render path gets resolved rows and no handle', () => {
  const db = openRenderRead(file);
  try {
    const data = createRenderData(db, { tenantKey: 'acme' });
    assert.deepEqual(Object.keys(data), ['source'], 'the render path exposes exactly one accessor');
    assert.equal((data as unknown as { db?: unknown }).db, undefined);
    assert.equal((data as unknown as { prepare?: unknown }).prepare, undefined);

    const result = data.source('posts', { status: 'published', limit: 4 });
    assert.equal(result.rows.length, 4);
    assert.deepEqual(result.rows[0], { title: 'Published 5', slug: 'published-5' });
    assert.equal(result.truncated, false);
    assert.ok(!('db' in result) && !('handle' in result));
  } finally {
    db.close();
  }
});

test('S2E-10. a query source cannot name a `cms_*` table, and a limit above limit_max is clamped and flagged', () => {
  // A `cms_*` table is not a `query` source's grammar at all …
  assert.throws(
    () => publishSource(file, { ...POSTS, key: 'pages-src', spec: { ...SPEC, table: 'cms_page' } }, ACTOR),
    (err: { code?: string }) => err.code === 'SKW_E_RT_SOURCE_UNKNOWN',
  );
  // … and a `u_*` table the registry does not carry is refused by the allowlist.
  assert.throws(
    () => publishSource(file, { ...POSTS, key: 'ghost-src', spec: { ...SPEC, table: 'u_ghost' } }, ACTOR),
    (err: { code?: string; detail?: { reason?: string } }) =>
      err.code === 'SKW_E_RT_SOURCE_UNKNOWN' && err.detail?.reason === 'table_not_registered',
  );

  publishSource(file, { ...POSTS, key: 'posts-clamp' }, ACTOR);
  const db = openRenderRead(file);
  try {
    const result = resolveSource(db, 'posts-clamp', { tenantKey: 'acme', params: { status: 'published', limit: 999 } });
    assert.equal(result.rows.length, 5, 'limit_max is 50 and only five rows match');
    assert.equal(result.truncated, true, 'a clamped limit sets data-truncated');
  } finally {
    db.close();
  }
});

// =========================================================================
// M5 (`S2-qa.md` §3.3, §8) — §6.2 asserts that a non-integer `limit` is
// refused, and the code silently ignored it: `typeof requested === 'number'`
// let `'5'` fall through to `limit_default`, and `5.5` was floored with no
// refusal. A rule with two answers is not a rule, so this is the table that
// pins one answer at both moments the rule claims: publish **and** render.
// =========================================================================

test('M5-1. a non-integer `limit` is refused at publish and at resolve, with its taxonomy shape', () => {
  // The four shapes QA measured (`S2-qa.md` §3.3 `b.`) plus the two the old code got
  // differently wrong: a fractional number floors, a negative already refused but for a
  // different reason string. Every one of them must produce the *same* refusal.
  const shapes: { label: string; value: unknown }[] = [
    { label: "the string '5' (a `data-limit` attribute is always a string)", value: '5' },
    { label: '5.5 (a fractional number)', value: 5.5 },
    { label: '-1 (a negative number)', value: -1 },
    { label: "'abc' (not a number at all)", value: 'abc' },
  ];
  const isLimitRefusal = (err: { code?: string; detail?: { reason?: string; param?: string } }): boolean =>
    err.code === 'SKW_E_RT_SOURCE_UNKNOWN' && err.detail?.reason === 'param_invalid' && err.detail?.param === 'limit';

  const rdb = openRenderRead(file);
  const admin = site();
  try {
    const rowsBefore = count(admin, 'SELECT count(*) AS n FROM cms_datasource');
    for (const shape of shapes) {
      // --- at render: the request-level `limit` ---
      assert.throws(
        () => resolveSource(rdb, 'posts', { tenantKey: 'acme', params: { status: 'published', limit: shape.value } }),
        isLimitRefusal,
        `resolve must refuse ${shape.label}`,
      );

      // --- at publish: the spec's own limit, which is the only limit the publish gate has ---
      assert.throws(
        () => publishSource(file, { ...POSTS, key: 'limit-shape', spec: { ...SPEC, limit_max: shape.value } }, ACTOR),
        isLimitRefusal,
        `publish must refuse ${shape.label}`,
      );
      assert.equal(
        count(admin, "SELECT count(*) AS n FROM cms_datasource WHERE key = 'limit-shape'"),
        0,
        `a refused limit wrote a row for ${shape.label}`,
      );
    }
    assert.equal(count(admin, 'SELECT count(*) AS n FROM cms_datasource'), rowsBefore, 'a refusal wrote a row');
  } finally {
    admin.close();
    rdb.close();
  }

  // The positive controls, so the table above cannot pass by refusing everything:
  // an integer limit resolves, and a fractional limit is not silently floored.
  const check = openRenderRead(file);
  try {
    const exact = resolveSource(check, 'posts', { tenantKey: 'acme', params: { status: 'published', limit: 2 } });
    assert.equal(exact.limit, 2);
    assert.equal(exact.rows.length, 2);
    assert.equal(exact.truncated, false);
  } finally {
    check.close();
  }
});

// =========================================================================
// E-21 / §6.1a — a `view` source is anchored to the definition it was published
// against. QA defeated the old code in one statement (`S2-qa.md` §4 A5): publish
// over a view, DROP + CREATE it as something else, resolve — and the published
// source served another table, with no republish and no refusal.
// =========================================================================

/** A view exists only by migration, so the test creates it as one would, registry row included. */
function migrateView(db: Database.Database, name: string, body: string): string {
  db.exec(`DROP VIEW IF EXISTS ${name}`);
  db.exec(`CREATE VIEW ${name} AS ${body}`);
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'view' AND name = ?").get(name) as { sql: string };
  const checksum = hashRelationSql(row.sql);
  db.prepare('INSERT OR REPLACE INTO cms_view_registry (name, checksum) VALUES (?, ?)').run(name, checksum);
  return checksum;
}

const POSTS_VIEW: SourceInput = {
  key: 'posts-view',
  kind: 'view',
  spec: {
    view: 'cms_v_posts_public',
    columns: ['title', 'slug'],
    order: [{ col: 'published_at', dir: 'desc' as const }],
    limit_default: 3,
    limit_max: 50,
  },
  isPublic: true,
  ttlS: 60,
  // Same reason as `POSTS`: a wall-clock ceiling must not decide a fixture publish in `make test`
  // (measured at 14× CPU load: the default 1.5 ms ceiling refused this publish twice with
  // `cost_ms_max 12.358 ms`). `make test-perf` P-1/P-3 assert the real ceiling.
  budgetMsMax: TEST_BUDGET_MS,
};

test('V1-1. re-pointing a published view out of band refuses with reason=view_checksum and serves ZERO rows', () => {
  const admin = site();
  let original: string;
  try {
    original = migrateView(admin, 'cms_v_posts_public', 'SELECT title, slug, published_at FROM u_posts');
  } finally {
    admin.close();
  }
  publishSource(file, POSTS_VIEW, ACTOR);

  const db = openRenderRead(file);
  try {
    const before = resolveSource(db, 'posts-view', { tenantKey: 'acme' });
    assert.equal(before.rows.length, 3, 'the anchored view must resolve before it is re-pointed');
    assert.deepEqual(Object.keys(before.rows[0] ?? {}).sort(), ['slug', 'title']);
  } finally {
    db.close();
  }

  // A5's exact attack: DROP + CREATE the same NAME over a different table, out of band, with no
  // republish, no audit row and — before this item — no refusal. The columns even satisfy the
  // allowlist (`path AS title`), which is why the allowlist alone could not notice.
  const out = site();
  try {
    out.exec('DROP VIEW cms_v_posts_public');
    out.exec("CREATE VIEW cms_v_posts_public AS SELECT path AS title, slug FROM cms_page");
  } finally {
    out.close();
  }

  const db2 = openRenderRead(file);
  let served: Record<string, unknown>[] | null = null;
  try {
    assert.throws(
      () => {
        served = resolveSource(db2, 'posts-view', { tenantKey: 'acme' }).rows;
      },
      (err: { code?: string; message?: string; detail?: { reason?: string; relation?: string; registered?: string; found?: string } }) => {
        assert.equal(err.code, 'SKW_E_RT_SOURCE_UNKNOWN');
        assert.equal(err.detail?.reason, 'view_checksum');
        assert.equal(err.detail?.relation, 'cms_v_posts_public');
        // Both digests, truncated to 16 hex: nothing on the wire beyond the two digests.
        assert.match(String(err.detail?.registered), /^[0-9a-f]{16}$/);
        assert.match(String(err.detail?.found), /^[0-9a-f]{16}$/);
        assert.notEqual(err.detail?.registered, err.detail?.found);
        assert.match(String(err.message), /is not the one the source was published against/);
        assert.match(String(err.message), /republish/);
        return true;
      },
    );
    // The assertion is on the ROW SET, not only on the code: a test that refused for another reason
    // (or served `cms_page` rows before consulting the checksum) cannot pass in its place.
    assert.equal(served, null, `the re-pointed view served ${JSON.stringify(served)}`);
  } finally {
    db2.close();
  }

  // Restore the fixture for the tests that follow: the view AND its registry row. The restored body
  // is the same text as before, so the same body hashes to the same digest — which is the property
  // a checksum is supposed to have.
  const restore = site();
  try {
    const restored = migrateView(restore, 'cms_v_posts_public', 'SELECT title, slug, published_at FROM u_posts');
    assert.equal(restored, original, 'the same body must hash to the same digest');
  } finally {
    restore.close();
  }
  const db3 = openRenderRead(file);
  try {
    assert.equal(resolveSource(db3, 'posts-view', { tenantKey: 'acme' }).rows.length, 3, 'the restored view must resolve again');
  } finally {
    db3.close();
  }
});

test('V1-2. a DDL op that changes a published view refreshes the checksum, un-publishes its sources, and audits both digests', () => {
  // Its own file: this test renames a table, which is not a change the other cases can share.
  const own = makeFixture({ specs: [{ key: 'vtest', hosts: ['v.test'] }] });
  const ownFile = own.sitePath('vtest');
  try {
    runDdl(
      ownFile,
      [
        {
          op: 'create_table',
          name: 'u_articles',
          columns: [
            { name: 'title', type: 'TEXT', notNull: true },
            { name: 'slug', type: 'TEXT', notNull: true },
            { name: 'published_at', type: 'DATE' },
          ],
        },
        { op: 'create_index', table: 'u_articles', name: 'ix_articles_published_at', columns: ['published_at'], unique: false },
      ],
      { actor: ACTOR },
    );
    const admin = openAdminWrite(ownFile);
    let beforeChecksum: string;
    try {
      beforeChecksum = migrateView(admin, 'cms_v_posts_public', 'SELECT title, slug, published_at FROM u_articles');
      admin.prepare('INSERT INTO u_articles (title, slug, published_at) VALUES (?, ?, ?)').run('A', 'a', '2026-10-01T00:00:00.000Z');
    } finally {
      admin.close();
    }
    publishSource(ownFile, POSTS_VIEW, ACTOR);
    const read = openRenderRead(ownFile);
    try {
      assert.equal(resolveSource(read, 'posts-view', { tenantKey: 'vtest' }).rows.length, 1);
      assert.equal(resolveSource(read, 'posts-view', { tenantKey: 'vtest' }).rows[0]?.slug, 'a');
    } finally {
      read.close();
    }

    // Through the runner: a rename that SQLite rewrites into the view's body.
    const report = runDdl(ownFile, [{ op: 'rename_table', from: 'u_articles', to: 'u_articles_2' }], { actor: ACTOR });
    assert.deepEqual(report.views, ['cms_v_posts_public'], `the postcondition did not see the redefinition: ${JSON.stringify(report.views)}`);

    const after = openAdminWrite(ownFile);
    try {
      // (i) the stored text now names the new table — measured, not assumed.
      const sql = (after.prepare("SELECT sql FROM sqlite_master WHERE type = 'view' AND name = 'cms_v_posts_public'").get() as { sql: string }).sql;
      assert.match(sql, /u_articles_2/);
      // (ii) the registry checksum moved …
      const registry = after.prepare("SELECT checksum FROM cms_view_registry WHERE name = 'cms_v_posts_public'").get() as { checksum: string };
      assert.notEqual(registry.checksum, beforeChecksum, 'the registry still carries the pre-rename checksum');
      assert.equal(registry.checksum, hashRelationSql(sql), 'the stored checksum is not the hash of the stored text');
      // (iii) … the source is no longer published …
      const source = after.prepare("SELECT published_at, is_public FROM cms_datasource WHERE key = 'posts-view'").get() as {
        published_at: string | null;
        is_public: number;
      };
      assert.equal(source.published_at, null, 'a changed view left its source published');
      assert.equal(source.is_public, 0);
      // (iv) … and there is exactly one audit row carrying both digests.
      const audit = after
        .prepare("SELECT target_kind, target_id, before_json, after_json FROM cms_audit WHERE action = 'source.view_redefined'")
        .all() as { target_kind: string; target_id: string; before_json: string; after_json: string }[];
      assert.equal(audit.length, 1, `one audit row per redefined view; got ${JSON.stringify(audit)}`);
      assert.equal(audit[0]?.target_kind, 'view');
      assert.equal(audit[0]?.target_id, 'cms_v_posts_public');
      assert.equal(JSON.parse(audit[0]?.before_json ?? '{}').checksum, beforeChecksum);
      const afterJson = JSON.parse(audit[0]?.after_json ?? '{}') as { checksum: string; unpublished: string[] };
      assert.equal(afterJson.checksum, registry.checksum);
      assert.deepEqual(afterJson.unpublished, ['posts-view']);
    } finally {
      after.close();
    }

    // (v) the next resolve refuses with the existing `not_published` — republication re-runs the gate.
    const read2 = openRenderRead(ownFile);
    try {
      assert.throws(
        () => resolveSource(read2, 'posts-view', { tenantKey: 'vtest' }),
        (err: { code?: string; detail?: { reason?: string } }) => err.code === 'SKW_E_RT_SOURCE_UNKNOWN' && err.detail?.reason === 'not_published',
      );
    } finally {
      read2.close();
    }
    // (vi) republishing succeeds and resolves against the new definition.
    publishSource(ownFile, POSTS_VIEW, ACTOR);
    const read3 = openRenderRead(ownFile);
    try {
      const rows = resolveSource(read3, 'posts-view', { tenantKey: 'vtest' }).rows;
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.slug, 'a');
    } finally {
      read3.close();
    }
  } finally {
    own.cleanup();
  }
});

test('V1-3. the view hash is paid once per schema stamp, not once per resolve', () => {
  resetViewChecksumStats();
  const db = openRenderRead(file);
  try {
    for (let i = 0; i < 100; i += 1) resolveSource(db, 'posts-view', { tenantKey: 'acme' });
    assert.equal(viewChecksumStats.viewChecksumHashes, 1, `100 resolves under one stamp cost ${viewChecksumStats.viewChecksumHashes} hashes`);
    assert.equal(viewChecksumStats.stampMoves, 0);

    // One DDL statement that changes the schema moves the cookie; the next resolve pays one hash.
    runDdl(file, [{ op: 'create_index', table: 'u_posts', name: 'ix_posts_section_v13', columns: ['section'], unique: false }], {
      actor: ACTOR,
    });
    for (let i = 0; i < 100; i += 1) resolveSource(db, 'posts-view', { tenantKey: 'acme' });
    assert.equal(
      viewChecksumStats.viewChecksumHashes,
      2,
      `one DDL must cost exactly one more hash, got ${viewChecksumStats.viewChecksumHashes}`,
    );
    assert.equal(viewChecksumStats.stampMoves, 1, 'the stamp did not move on a CREATE INDEX');
  } finally {
    db.close();
  }
});

test('V1-4. the cost budget applies to a `view` source: the ceiling is consulted and refuses with its own code', () => {
  // `budgetMsMax: 0` is the **structural** form of "the budget applies to a view": every measured
  // statement costs more than zero, so the ceiling must refuse whatever the box is doing and the
  // refusal cannot flake. Load can only push a measurement up, so this case is monotone by
  // construction. The 1.5 ms form of the same claim needs a real measurement of a genuinely
  // expensive body — 400 runs at ~26 ms, 10.6 s — and that is `make test-perf` P-2.
  assert.throws(
    () =>
      publishSource(
        file,
        {
          key: 'zero-budget-view',
          kind: 'view',
          spec: { view: 'cms_v_posts_public', columns: ['title', 'slug'], limit_default: 1, limit_max: 1 },
          isPublic: true,
          budgetMsMax: 0,
        },
        ACTOR,
      ),
    (err: { code?: string; detail?: { reason?: string; limit_ms?: number } }) =>
      err.code === 'SKW_E_RT_SOURCE_BUDGET' && err.detail?.reason === 'cost' && err.detail?.limit_ms === 0,
    'a view source must be measured against the same ceiling as a query source',
  );

  // The positive control: the same view publishes under a ceiling it can meet, so the refusal
  // above is the budget and not the view.
  const ok = publishSource(
    file,
    { key: 'budgeted-view', kind: 'view', spec: { view: 'cms_v_posts_public', columns: ['title', 'slug'], limit_default: 1, limit_max: 1 }, isPublic: true, budgetMsMax: TEST_BUDGET_MS },
    ACTOR,
  );
  assert.equal(ok.kind, 'view');
  assert.equal(typeof ok.cost_ms_max, 'number');
  assert.ok(Number(ok.cost_ms_max) > 0, 'the view was measured, not skipped');
});
