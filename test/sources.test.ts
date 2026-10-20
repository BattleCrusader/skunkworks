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
import { resolveSource } from '../app/sources/resolve.ts';
import { makeFixture, REPO, type Fixture } from './helpers/fixture.ts';

const ACTOR = { userId: 7, label: 'owner@acme.test' };

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
  const e = error as { code?: string; message?: string; detail?: { column?: string; plan?: string[] } };
  assert.equal(e.code, 'SKW_E_RT_SOURCE_UNINDEXED');
  assert.equal(e.detail?.column, 'section', `the refusal must name section; detail was ${JSON.stringify(e.detail)}`);
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
  assert.ok(report.cost_ms_max !== null && report.cost_ms_max <= 1.5, `cost_ms_max ${String(report.cost_ms_max)} exceeds the 1.5 ms budget`);
  assert.ok(report.cost_ms_max !== null && report.cost_ms_max >= 0);
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
