/**
 * S2d — the DDL runner (§9.4), the six remaining `DdlOp`s, the three context-dependent
 * refusals, and the seven acceptance criteria of the work order.
 *
 * Every test here writes to a real `site.db` built from `schema/site.sql`. Nothing is
 * mocked: the refusal tests assert on the wire code *and* on the SQL that did not run,
 * the rollback test hashes the schema before and after, and the serialisation and
 * kill-mid-op tests use a second **process**, because `better-sqlite3` is synchronous
 * and a second connection in one process cannot race the first.
 */
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';

import { appendAudit, auditHash, sealNow, verifyAgainstSeal, verifyChain } from '../app/audit/chain.ts';
import { createRow } from '../app/admin/crud.ts';
import { AppError } from '../app/errors.ts';
import { emitCreateTable } from '../app/ddl/emit.ts';
import { emit, type DdlOp } from '../app/ddl/ops.ts';
import { context, runDdl } from '../app/ddl/run.ts';
import { makeFixture, REPO, SCHEMA, type Fixture } from './helpers/fixture.ts';

const ACTOR = { userId: 3, label: 'owner@acme.test' };
const CHILD = join(REPO, 'test', 'helpers', 'ddl-child.ts');

let fixture: Fixture;
let seq = 0;

before(() => {
  fixture = makeFixture({ specs: [{ key: 'acme', hosts: ['acme.test'] }] });
});

after(() => {
  fixture.cleanup();
});

/** A fresh tenant file per test: a DDL gate must not inherit the previous one's schema. */
function freshSite(): string {
  seq += 1;
  const path = fixture.sitePath(`ddl-${seq}`);
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec(readFileSync(join(SCHEMA, 'site.sql'), 'utf8'));
  db.close();
  return path;
}

function open(path: string): Database.Database {
  return new Database(path);
}

/**
 * The schema's identity: every object's kind, name, owner and SQL, plus the registry's
 * own rows. Hashing this before and after is the rollback proof — a file hash would be
 * a witness to WAL bookkeeping as much as to the schema.
 */
function schemaDigest(path: string): string {
  const db = open(path);
  try {
    const objects = db
      .prepare("SELECT type, name, tbl_name, COALESCE(sql, '') AS sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
      .all() as { type: string; name: string; tbl_name: string; sql: string }[];
    const registry = db.prepare('SELECT table_name, column_count, index_count, columns_json FROM cms_table_registry ORDER BY table_name').all();
    const counts = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as { name: string }[];
    const rows = counts.map((t) => {
      const row = db.prepare(`SELECT count(*) AS n FROM "${t.name}"`).get() as { n: number };
      return [t.name, row.n];
    });
    return createHash('sha256')
      .update(JSON.stringify({ objects, registry, rows }))
      .digest('hex');
  } finally {
    db.close();
  }
}

function runChild(mode: string, file: string, spec: unknown): Promise<{ code: number | null; signal: string | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CHILD, mode, file, JSON.stringify(spec)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (c) => {
      out += String(c);
    });
    child.stderr.on('data', (c) => {
      out += String(c);
    });
    child.on('close', (code, signal) => resolve({ code, signal, out }));
  });
}

/** Starts a child and resolves once it says it is running, so a race is a race. */
function started(mode: string, file: string, spec: unknown): Promise<{ done: Promise<{ code: number | null; signal: string | null; out: string }>; out: () => string }> {
  const child = spawn(process.execPath, [CHILD, mode, file, JSON.stringify(spec)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let resolveReady: () => void = () => {};
  const ready = new Promise<void>((r) => {
    resolveReady = r;
  });
  child.stdout.on('data', (c) => {
    out += String(c);
  });
  child.stderr.on('data', (c) => {
    out += String(c);
    if (out.includes('ready')) resolveReady();
  });
  const done = new Promise<{ code: number | null; signal: string | null; out: string }>((resolve) => {
    child.on('close', (code, signal) => resolve({ code, signal, out }));
  });
  return ready.then(() => ({ done, out: () => out }));
}

function createTable(name: string, columns: { name: string; type: string; notNull?: boolean; default?: string | number | boolean; relation?: string }[]): DdlOp {
  return { op: 'create_table', name, columns: columns as never };
}

// =========================================================================
// Criterion 1 — a name outside the four prefixes is refused by the AST, and
//               no SQL reaches the engine.
// =========================================================================

test('C1. a table named outside u_ is refused by the AST, and the connection is never opened', () => {
  const path = freshSite();
  let opened = 0;
  const before = schemaDigest(path);

  for (const name of ['cms_evil', 'p_plugin_thing', 'sqlite_shadow', 'people', 'u_Bad', 'u_']) {
    assert.throws(
      () =>
        runDdl(path, [createTable(name, [{ name: 'x', type: 'TEXT' }])], {
          actor: ACTOR,
          open: (file) => {
            opened += 1;
            return open(file);
          },
        }),
      (err: unknown) => {
        assert.ok(err instanceof AppError, `must be a taxonomy error, got ${String(err)}`);
        assert.equal(err.code, 'SKW_E_DM_DDL_REJECTED');
        assert.equal(err.status, 422);
        assert.deepEqual(err.detail, { reason: 'reserved_prefix' });
        return true;
      },
      `${name} must be refused`,
    );
  }

  // The whole point: the refusal happened before a handle existed, so there is no path
  // by which a statement could have reached the engine.
  assert.equal(opened, 0, 'the runner opened a connection for a request the AST refuses');
  assert.equal(schemaDigest(path), before, 'a refused request changed the schema');
});

// =========================================================================
// Criterion 2 — a batch that fails on its third statement rolls back entirely.
// =========================================================================

test('C2. a batch failing on its third statement leaves the schema byte-identical', () => {
  const path = freshSite();
  const before = schemaDigest(path);

  const ops: DdlOp[] = [
    createTable('u_alpha', [{ name: 'title', type: 'TEXT' }]),
    { op: 'create_index', table: 'u_alpha', name: 'ix_alpha_title', columns: ['title'], unique: false },
    // The third statement cannot succeed: the table exists (created by statement 1 in
    // this very transaction).
    createTable('u_alpha', [{ name: 'other', type: 'TEXT' }]),
  ];

  assert.throws(
    () => runDdl(path, ops, { actor: ACTOR }),
    (err: unknown) => err instanceof AppError && err.code === 'SKW_E_DM_KEY_IN_USE',
  );

  assert.equal(schemaDigest(path), before, 'the rollback did not restore the schema');

  const db = open(path);
  try {
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE substr(name, 1, 2) = 'u_'").all() as { name: string }[]).map((r) => r.name);
    assert.deepEqual(names, [], 'the first statement of the batch survived the rollback');
    assert.equal((db.prepare('SELECT count(*) AS n FROM cms_table_registry').get() as { n: number }).n, 0);
    assert.equal((db.prepare('SELECT count(*) AS n FROM cms_audit').get() as { n: number }).n, 0);
  } finally {
    db.close();
  }
});

// =========================================================================
// Criterion 3 — two DDL ops racing on one tenant do not interleave.
// =========================================================================

test('C3. two processes: BEGIN IMMEDIATE serialises the second behind the first', async () => {
  const path = freshSite();
  const a = runChild('ddl', path, { ops: [createTable('u_first', [{ name: 'title', type: 'TEXT' }])], holdMs: 400 });
  // Start B while A is inside its transaction: it has the table-creation statement
  // written and 400 ms of sleep left before COMMIT.
  await new Promise((r) => setTimeout(r, 120));
  const b = runChild('ddl', path, { ops: [createTable('u_second', [{ name: 'title', type: 'TEXT' }])] });

  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra.code, 0, `A failed: ${ra.out}`);
  assert.equal(rb.code, 0, `B failed: ${rb.out}`);
  const ja = JSON.parse(ra.out.trim().split('\n').pop() as string);
  const jb = JSON.parse(rb.out.trim().split('\n').pop() as string);
  assert.equal(ja.ok, true);
  assert.equal(jb.ok, true);

  // A held the write lock from before B started until its COMMIT; B could not have
  // finished inside that window without interleaving.
  assert.ok(
    ja.report.lockAttempts >= 1 && jb.report.lockAttempts >= 2,
    `B must have re-attempted the lock: A=${JSON.stringify(ja.report)} B=${JSON.stringify(jb.report)}`,
  );
  assert.ok(jb.endedAt >= ja.endedAt, `B ended (${jb.endedAt}) before A committed (${ja.endedAt}) — the ops interleaved`);

  const db = open(path);
  try {
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE substr(name, 1, 2) = 'u_' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
    assert.deepEqual(names, ['u_first', 'u_second']);
    // Both registry rows and both audit rows, one chain: the serialisation did not
    // corrupt either transaction's bookkeeping.
    assert.equal((db.prepare('SELECT count(*) AS n FROM cms_table_registry').get() as { n: number }).n, 2);
    assert.equal((db.prepare('SELECT count(*) AS n FROM cms_audit').get() as { n: number }).n, 2);
    assert.equal(verifyChain(db).ok, true);
  } finally {
    db.close();
  }
});

// =========================================================================
// Criterion 4 — the registry row and the audit row commit with the DDL, or not at all.
// =========================================================================

test('C4. SIGKILL between the last statement and COMMIT leaves no table, no registry row, no audit row', async () => {
  const path = freshSite();
  const before = schemaDigest(path);
  const child = await runChild('ddl', path, { ops: [createTable('u_murdered', [{ name: 'title', type: 'TEXT', notNull: true, default: 'x' }])], kill: true });

  assert.equal(child.signal, 'SIGKILL', `the child was expected to be killed mid-transaction, got code=${String(child.code)} signal=${String(child.signal)}: ${child.out}`);

  const db = open(path);
  try {
    assert.equal((db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'u_murdered'").get() as { n: number }).n, 0);
    assert.equal((db.prepare('SELECT count(*) AS n FROM cms_table_registry').get() as { n: number }).n, 0, 'the registry row committed without the table');
    assert.equal((db.prepare('SELECT count(*) AS n FROM cms_audit').get() as { n: number }).n, 0, 'the audit row committed without the table');
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
  } finally {
    db.close();
  }
  assert.equal(schemaDigest(path), before, 'the killed transaction left a trace');
});

// =========================================================================
// Criterion 5 — the runner executes exactly what emit() previews, for all six ops.
// =========================================================================

test('C5. the executed SQL text equals the preview text for all six ops', () => {
  const path = freshSite();
  const executed: string[] = [];
  const instrument = (file: string): Database.Database => {
    const db = open(file);
    const exec = db.exec.bind(db);
    db.exec = (sql: string): Database.Database => {
      executed.push(sql);
      return exec(sql);
    };
    return db;
  };

  // Setup through the runner (not instrumented): the tables the six ops act on.
  runDdl(
    path,
    [
      createTable('u_post', [
        { name: 'title', type: 'TEXT', notNull: true },
        { name: 'cover', type: 'ASSET' },
        { name: 'age', type: 'INTEGER' },
      ]),
      createTable('u_author', [{ name: 'name', type: 'TEXT', notNull: true, default: 'anon' }]),
    ],
    { actor: ACTOR },
  );
  const db = open(path);
  db.prepare("INSERT INTO u_author(name) VALUES ('Ada')").run();
  const ctxBefore = context(db, 8);
  db.close();

  const cases: { label: string; op: DdlOp }[] = [
    { label: 'create_table', op: createTable('u_tag', [{ name: 'label', type: 'TEXT', notNull: true }]) },
    { label: 'add_column', op: { op: 'add_column', table: 'u_post', column: { name: 'subtitle', type: 'TEXT' } } },
    { label: 'create_index', op: { op: 'create_index', table: 'u_post', name: 'ix_post_age', columns: ['age'], unique: false } },
    { label: 'drop_index', op: { op: 'drop_index', name: 'ix_post_age' } },
    { label: 'rename_table', op: { op: 'rename_table', from: 'u_tag', to: 'u_tagged' } },
    { label: 'drop_column', op: { op: 'drop_column', table: 'u_post', column: 'subtitle' } },
    { label: 'drop_table', op: { op: 'drop_table', name: 'u_tagged' } },
  ];

  for (const { label, op } of cases) {
    const previewDb = open(path);
    const preview = emit(op, context(previewDb, 8)).statements;
    previewDb.close();

    executed.length = 0;
    const report = runDdl(path, [op], { actor: ACTOR, open: instrument });
    // The transaction boundaries are the runner's, not the operation's: §9.4 wraps the
    // op, it is not part of it. Everything else the handle was sent must be the preview,
    // in order, byte for byte.
    const ddl = executed.filter((sql) => !/^(BEGIN IMMEDIATE|COMMIT|ROLLBACK)$/.test(sql));
    assert.equal(report.statements, preview.length, `${label}: the runner executed ${report.statements} statements, the preview has ${preview.length}`);
    assert.deepEqual(ddl, preview, `${label}: the executed SQL is not the previewed SQL`);
  }
  void ctxBefore;
});

// =========================================================================
// Criterion 6 — tamper one audit row and recompute the chain: the seal refuses.
// =========================================================================

test('C6. a DDL audit row tampered with and recomputed still fails against the seal', () => {
  const path = freshSite();
  runDdl(path, [createTable('u_post', [{ name: 'title', type: 'TEXT' }])], { actor: ACTOR });
  runDdl(path, [{ op: 'add_column', table: 'u_post', column: { name: 'body', type: 'TEXT' } }], { actor: ACTOR });

  const control = open(join(fixture.dir, 'seal-control.db'));
  control.exec(readFileSync(join(SCHEMA, 'control.sql'), 'utf8'));
  const db = open(path);
  try {
    assert.equal(verifyChain(db).ok, true);
    // §9.6's anchor, written by the module S2d ships.
    sealNow(db, control, 'acme', '2026-10-20');
    assert.equal(verifyAgainstSeal(db, control, 'acme', '2026-10-20').ok, true);

    // Tamper: rewrite what the DDL row claims, delete the append-only trigger, and
    // recompute every hash so the file is internally consistent.
    db.exec('DROP TRIGGER trg_cms_audit_append_only');
    db.prepare("UPDATE cms_audit SET action = 'ddl.drop_table' WHERE id = 2").run();
    const rows = db.prepare('SELECT * FROM cms_audit ORDER BY id').all() as Record<string, unknown>[];
    let prev = '';
    const stamp = db.prepare('UPDATE cms_audit SET prev_hash = ?, hash = ? WHERE id = ?');
    for (const row of rows) {
      const hash = auditHash(prev, row as never);
      stamp.run(prev, hash, row.id as number);
      prev = hash;
    }
    assert.equal(verifyChain(db).ok, true, 'the recomputed chain must walk — otherwise the seal is not what catches it');
    assert.throws(
      () => verifyAgainstSeal(db, control, 'acme', '2026-10-20'),
      (err: unknown) => err instanceof AppError && err.code === 'SKW_E_SEC_AUDIT_SEAL',
    );
  } finally {
    db.close();
    control.close();
  }
});

// =========================================================================
// Criterion 7 — CRUD writes during a rebuild: no lost update, and the rebuild reports
//               the connections it waited behind.
// =========================================================================

test('C7. concurrent CRUD writes during a rebuild lose nothing, and the rebuild reports its lock waits', async () => {
  const path = freshSite();
  runDdl(
    path,
    [
      createTable('u_post', [
        { name: 'title', type: 'TEXT' },
        { name: 'slug', type: 'TEXT' },
        { name: 'body_html', type: 'TEXT' },
        { name: 'legacy', type: 'TEXT' },
      ]),
    ],
    { actor: ACTOR },
  );

  // Two writer processes, one row per transaction through the production CRUD writer,
  // each transaction held open for 12 ms so it owns the write lock a third of the time.
  const w1 = await started('crud', path, { table: 'u_post', rows: 40, pauseMs: 1, holdMs: 12, prefix: 'w1' });
  const w2 = await started('crud', path, { table: 'u_post', rows: 40, pauseMs: 1, holdMs: 12, prefix: 'w2' });

  // The rebuilds run *while* both writers are inserting into the same table. Each holds
  // the write lock for its whole duration, which is exactly when a lost update would
  // happen if the copy were not inside the same transaction.
  //
  // Contention is a race, so the gate runs several rebuilds and asserts on the busiest
  // report: the subject is what the runner says when it waits, not that one particular
  // attempt happened to collide.
  const passes = [
    { op: 'drop_column', table: 'u_post', column: 'legacy' } as DdlOp,
    { op: 'add_column', table: 'u_post', column: { name: 'extra', type: 'TEXT' } } as DdlOp,
    { op: 'drop_column', table: 'u_post', column: 'extra' } as DdlOp,
    { op: 'add_column', table: 'u_post', column: { name: 'extra2', type: 'TEXT' } } as DdlOp,
    { op: 'drop_column', table: 'u_post', column: 'extra2' } as DdlOp,
  ];
  const reports = [];
  for (const op of passes) {
    reports.push(runDdl(path, [op], { actor: ACTOR, busyTimeoutMs: 10_000 }));
    await new Promise((r) => setTimeout(r, 5));
  }
  const rebuild = reports[0] as ReturnType<typeof runDdl>;
  const contended = reports.reduce((best, r) => (r.waitedFor > best.waitedFor ? r : best), reports[0] as ReturnType<typeof runDdl>);

  const results = await Promise.all([w1.done, w2.done]);
  for (const res of results) {
    assert.equal(res.code, 0, `a writer failed: ${res.out}`);
  }

  assert.deepEqual(rebuild.rebuilt, ['u_post']);
  assert.ok(
    contended.waitedFor >= 1,
    `the rebuild must report the connections it waited behind: ${JSON.stringify(reports.map((r) => ({ attempts: r.lockAttempts, waitedMs: r.lockWaitMs })))}`,
  );

  const db = open(path);
  try {
    const total = (db.prepare('SELECT count(*) AS n FROM u_post').get() as { n: number }).n;
    assert.equal(total, 80, `lost update: ${total} of 80 rows survived the rebuild`);
    const slugs = (db.prepare("SELECT slug FROM u_post WHERE slug LIKE 'w1-%' OR slug LIKE 'w2-%' ORDER BY slug").all() as { slug: string }[]).map((r) => r.slug);
    assert.equal(new Set(slugs).size, 80, 'a row was written twice or not at all');
    // The rebuilt table is the table `create_table` would have produced, without the
    // dropped column: a rebuild cannot drift from a create.
    const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'u_post'").get() as { sql: string }).sql;
    const expected = emitCreateTable({
      op: 'create_table',
      name: 'u_post',
      columns: [
        { name: 'title', type: 'TEXT' },
        { name: 'slug', type: 'TEXT' },
        { name: 'body_html', type: 'TEXT' },
      ],
    })[0] as string;
    assert.equal(sql, expected, 'the rebuilt table is not what create_table would have emitted');
    assert.equal(verifyChain(db).ok, true);
  } finally {
    db.close();
  }
});

// =========================================================================
// The six ops individually, with their taxonomy codes on refusal.
// =========================================================================

test('O1. create_table: registry row, audit row and the asset guard in one transaction', () => {
  const path = freshSite();
  const db0 = open(path);
  const statements = emit(createTable('u_post', [{ name: 'title', type: 'TEXT' }, { name: 'cover', type: 'ASSET' }]), context(db0, 8)).statements;
  db0.close();
  assert.equal(statements.length, 3, 'create + guard trigger + its registry row');
  assert.match(statements[1]!, /CREATE TRIGGER "trg_asset_guard_u_post" BEFORE DELETE ON cms_asset/);
  assert.match(statements[2]!, /INSERT (OR REPLACE )?INTO cms_trigger_registry/);

  runDdl(path, [createTable('u_post', [{ name: 'title', type: 'TEXT' }, { name: 'cover', type: 'ASSET' }])], { actor: ACTOR });

  const db = open(path);
  try {
    const registry = db.prepare('SELECT * FROM cms_table_registry WHERE table_name = ?').get('u_post') as Record<string, unknown>;
    assert.equal(registry.table_class, 'user');
    assert.equal(registry.column_count, 3);
    assert.equal(JSON.parse(registry.columns_json as string).length, 3);
    assert.equal((db.prepare("SELECT count(*) AS n FROM cms_trigger_registry WHERE name = 'trg_asset_guard_u_post'").get() as { n: number }).n, 1);
    assert.equal((db.prepare("SELECT count(*) AS n FROM cms_audit WHERE action = 'ddl.create_table' AND target_id = 'u_post'").get() as { n: number }).n, 1);
    // The guard actually fires, with foreign_keys OFF — the whole reason it exists.
    db.prepare("INSERT INTO cms_asset(key, filename, mime, bytes, sha256, kind) VALUES ('banner','b.pdf','application/pdf',1,?,'document')").run('ab'.repeat(32));
    db.prepare("INSERT INTO u_post(title, cover) VALUES ('x','banner')").run();
    db.pragma('foreign_keys = 0');
    assert.throws(() => db.prepare("DELETE FROM cms_asset WHERE key = 'banner'").run(), /SKW_E_DM_ASSET_IN_USE/);
  } finally {
    db.close();
  }
});

test('O2. add_column: in place when SQLite allows it, refused without a default when it does not', () => {
  const path = freshSite();
  runDdl(path, [createTable('u_post', [{ name: 'title', type: 'TEXT' }])], { actor: ACTOR });

  // §4.4's refusal #1, before any SQL.
  assert.throws(
    () =>
      runDdl(path, [{ op: 'add_column', table: 'u_post', column: { name: 'price', type: 'NUMERIC', notNull: true } }], {
        actor: ACTOR,
        open: () => {
          throw new Error('the connection must not be opened for a default_required refusal');
        },
      }),
    (err: unknown) => err instanceof AppError && err.code === 'SKW_E_DM_DDL_REJECTED' && (err.detail as { reason: string }).reason === 'default_required',
  );

  const report = runDdl(path, [{ op: 'add_column', table: 'u_post', column: { name: 'price', type: 'NUMERIC', notNull: true, default: 0 } }], { actor: ACTOR });
  assert.equal(report.statements, 1);
  const db = open(path);
  try {
    const columns = db.prepare('PRAGMA table_info("u_post")').all() as { name: string; notnull: number }[];
    assert.deepEqual(columns.map((c) => c.name), ['id', 'title', 'price']);
    assert.equal(columns[2]!.notnull, 1);
    const registry = db.prepare('SELECT column_count, columns_json FROM cms_table_registry WHERE table_name = ?').get('u_post') as { column_count: number; columns_json: string };
    assert.equal(registry.column_count, 3);
    assert.equal(JSON.parse(registry.columns_json).length, 3);
  } finally {
    db.close();
  }
});

test('O3. drop_column: rebuild_required on an indexed column, rebuild when the caller asks', () => {
  const path = freshSite();
  runDdl(
    path,
    [
      createTable('u_post', [
        { name: 'title', type: 'TEXT' },
        { name: 'slug', type: 'TEXT' },
      ]),
      { op: 'create_index', table: 'u_post', name: 'ix_post_slug', columns: ['slug'], unique: true },
      { op: 'create_index', table: 'u_post', name: 'ix_post_title', columns: ['title'], unique: false },
    ],
    { actor: ACTOR },
  );

  assert.throws(
    () => runDdl(path, [{ op: 'drop_column', table: 'u_post', column: 'slug' }], { actor: ACTOR }),
    (err: unknown) =>
      err instanceof AppError && err.code === 'SKW_E_DM_DDL_REJECTED' && (err.detail as { reason: string }).reason === 'rebuild_required',
  );

  const db0 = open(path);
  const preview = emit({ op: 'drop_column', table: 'u_post', column: 'slug', rebuild: true }, context(db0, 8)).statements;
  db0.close();
  // §4.5's twelve steps, in order: create, carry, drop triggers, drop table, rename,
  // recreate indexes, restore sqlite_sequence, recreate triggers, registry rows.
  assert.match(preview[0]!, /^CREATE TABLE "u_post__rebuild"/);
  assert.match(preview[1]!, /^INSERT INTO "u_post__rebuild"/);
  assert.ok(preview.some((s) => /^DROP TABLE "u_post"$/.test(s)));
  assert.match(preview.find((s) => s.startsWith('ALTER TABLE'))!, /RENAME TO "u_post"/);
  // The index on the dropped column goes with it; the other one is recreated against
  // the rebuilt table, which is what "recreate every index" has to mean.
  assert.equal(preview.some((s) => s.includes('ix_post_slug')), false, 'an index on the dropped column must not be recreated');
  assert.match(preview.find((s) => s.startsWith('CREATE INDEX "ix_post_title"'))!, /ON "u_post"/);
  assert.ok(preview.some((s) => s.startsWith('UPDATE sqlite_sequence')));
  assert.ok(preview.some((s) => s.startsWith('INSERT INTO sqlite_sequence')));

  const report = runDdl(path, [{ op: 'drop_column', table: 'u_post', column: 'slug', rebuild: true }], { actor: ACTOR });
  assert.deepEqual(report.rebuilt, ['u_post']);
  const db = open(path);
  try {
    const columns = (db.prepare('PRAGMA table_info("u_post")').all() as { name: string }[]).map((c) => c.name);
    assert.deepEqual(columns, ['id', 'title']);
    // The index that mentioned the dropped column is gone; the table is otherwise intact.
    assert.deepEqual((db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'u_post'").all() as { name: string }[]).map((r) => r.name), ['ix_post_title']);
    assert.equal((db.prepare('SELECT column_count FROM cms_table_registry WHERE table_name = ?').get('u_post') as { column_count: number }).column_count, 2);
  } finally {
    db.close();
  }
});

test('O4. rename_table moves the table, its indexes and its registry row together', () => {
  const path = freshSite();
  runDdl(
    path,
    [createTable('u_post', [{ name: 'title', type: 'TEXT' }]), { op: 'create_index', table: 'u_post', name: 'ix_post_title', columns: ['title'], unique: false }],
    { actor: ACTOR },
  );
  const report = runDdl(path, [{ op: 'rename_table', from: 'u_post', to: 'u_article' }], { actor: ACTOR });
  assert.equal(report.statements, 1);
  const db = open(path);
  try {
    assert.equal((db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'u_article'").get() as { n: number }).n, 1);
    assert.equal((db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'u_post'").get() as { n: number }).n, 0);
    const registry = db.prepare('SELECT table_name, index_count FROM cms_table_registry').all() as { table_name: string; index_count: number }[];
    assert.deepEqual(registry.map((r) => r.table_name), ['u_article']);
    assert.equal(registry[0]!.index_count, 1);
  } finally {
    db.close();
  }
});

test('O5. create_index / drop_index keep cms_table_registry.index_count true, and the limit is enforced', () => {
  const path = freshSite();
  const columns = Array.from({ length: 10 }, (_, i) => ({ name: `c${i}`, type: 'TEXT' as const }));
  runDdl(path, [createTable('u_wide', columns)], { actor: ACTOR });

  const db0 = open(path);
  const eight: DdlOp[] = columns.slice(0, 8).map((c) => ({ op: 'create_index', table: 'u_wide', name: `ix_wide_${c.name}`, columns: [c.name], unique: false }));
  db0.close();
  runDdl(path, eight, { actor: ACTOR, maxStatements: 8 });

  assert.throws(
    () => runDdl(path, [{ op: 'create_index', table: 'u_wide', name: 'ix_wide_ninth', columns: ['c8'], unique: false }], { actor: ACTOR }),
    (err: unknown) => err instanceof AppError && err.code === 'SKW_E_DM_DDL_REJECTED' && (err.detail as { reason: string }).reason === 'limit',
  );

  const db = open(path);
  try {
    assert.equal((db.prepare('SELECT index_count FROM cms_table_registry WHERE table_name = ?').get('u_wide') as { index_count: number }).index_count, 8);
  } finally {
    db.close();
  }

  const dropped = runDdl(path, [{ op: 'drop_index', name: 'ix_wide_c0' }], { actor: ACTOR });
  assert.equal(dropped.statements, 1);
  const db2 = open(path);
  try {
    assert.equal((db2.prepare('SELECT index_count FROM cms_table_registry WHERE table_name = ?').get('u_wide') as { index_count: number }).index_count, 7);
  } finally {
    db2.close();
  }

  // The name rule is the same one the AST applies to a table: ix_ or nothing.
  assert.throws(
    () => runDdl(path, [{ op: 'drop_index', name: 'cms_index' }], { actor: ACTOR }),
    (err: unknown) => err instanceof AppError && (err.detail as { reason: string }).reason === 'reserved_prefix',
  );
});

test('O6. drop_table removes the table, its guard trigger, its registry rows and nothing else', () => {
  const path = freshSite();
  runDdl(
    path,
    [
      createTable('u_post', [{ name: 'title', type: 'TEXT' }, { name: 'cover', type: 'ASSET' }]),
      createTable('u_keep', [{ name: 'title', type: 'TEXT' }]),
    ],
    { actor: ACTOR },
  );
  const report = runDdl(path, [{ op: 'drop_table', name: 'u_post' }], { actor: ACTOR });
  assert.equal(report.statements, 3, 'DROP TABLE + the guard trigger + its registry row');

  const db = open(path);
  try {
    assert.equal((db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'u_post'").get() as { n: number }).n, 0);
    assert.equal((db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'trg_asset_guard_u_post'").get() as { n: number }).n, 0);
    assert.deepEqual((db.prepare('SELECT table_name FROM cms_table_registry').all() as { table_name: string }[]).map((r) => r.table_name), ['u_keep']);
    assert.equal(
      (db.prepare("SELECT count(*) AS n FROM cms_trigger_registry WHERE name = 'trg_asset_guard_u_post'").get() as { n: number }).n,
      0,
      'the guard survived its table',
    );
    // The three registered cms triggers are untouched: a drop of one table is not a licence
    // to clear the registry.
    assert.equal((db.prepare('SELECT count(*) AS n FROM cms_trigger_registry').get() as { n: number }).n, 5);
    assert.equal(verifyChain(db).ok, true);
  } finally {
    db.close();
  }
});

test('O7. a rebuild regenerates the asset guard: dropping the last asset column removes it', () => {
  const path = freshSite();
  runDdl(
    path,
    [
      createTable('u_post', [
        { name: 'title', type: 'TEXT' },
        { name: 'cover', type: 'ASSET' },
        { name: 'hero', type: 'ASSET' },
      ]),
    ],
    { actor: ACTOR },
  );
  const db = open(path);
  db.prepare("INSERT INTO cms_asset(key, filename, mime, bytes, sha256, kind) VALUES ('a','a.pdf','application/pdf',1,?,'document')").run('aa'.repeat(32));
  db.prepare("INSERT INTO cms_asset(key, filename, mime, bytes, sha256, kind) VALUES ('b','b.pdf','application/pdf',1,?,'document')").run('bb'.repeat(32));
  db.prepare("INSERT INTO u_post(title, cover, hero) VALUES ('x','a','b')").run();
  db.close();

  // An ASSET column carries a REFERENCES clause, so §4.4 requires the flag — which is
  // also the only way this test can be about the guard rather than about the refusal.
  assert.throws(
    () => runDdl(path, [{ op: 'drop_column', table: 'u_post', column: 'cover' }], { actor: ACTOR }),
    (err: unknown) => err instanceof AppError && (err.detail as { reason: string }).reason === 'rebuild_required',
  );

  // Drop one of two asset columns: the guard must survive, over the remaining column.
  runDdl(path, [{ op: 'drop_column', table: 'u_post', column: 'cover', rebuild: true }], { actor: ACTOR });
  const mid = open(path);
  try {
    const sql = (mid.prepare("SELECT sql FROM sqlite_master WHERE name = 'trg_asset_guard_u_post'").get() as { sql: string }).sql;
    assert.match(sql, /"hero" = OLD\."key"/, 'the regenerated guard must name the column that remains');
    assert.doesNotMatch(sql, /"cover"/, 'the guard must not name a column the rebuild dropped');
    // 'a' is no longer referenced by anything; 'b' still is.
    mid.prepare("DELETE FROM cms_asset WHERE key = 'a'").run();
    assert.throws(() => mid.prepare("DELETE FROM cms_asset WHERE key = 'b'").run(), /SKW_E_DM_ASSET_IN_USE/);
  } finally {
    mid.close();
  }

  // Drop the last asset column: no guard, no registry row, and an asset delete works.
  runDdl(path, [{ op: 'drop_column', table: 'u_post', column: 'hero', rebuild: true }], { actor: ACTOR });
  const after = open(path);
  try {
    assert.equal((after.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'trg_asset_guard_u_post'").get() as { n: number }).n, 0);
    assert.equal(
      (after.prepare("SELECT count(*) AS n FROM cms_trigger_registry WHERE name = 'trg_asset_guard_u_post'").get() as { n: number }).n,
      0,
      'the registry row must go with the trigger',
    );
    after.prepare("DELETE FROM cms_asset WHERE key = 'b'").run();
    assert.equal(verifyChain(after).ok, true);
  } finally {
    after.close();
  }
});


test('R1. too_many_statements: a batch over SKW_DDL_MAX_STATEMENTS is refused before the connection', () => {
  const path = freshSite();
  const ops = Array.from({ length: 9 }, (_, i) => createTable(`u_t${i}`, [{ name: 'x', type: 'TEXT' }]));
  assert.throws(
    () =>
      runDdl(path, ops, {
        actor: ACTOR,
        maxStatements: 8,
        open: () => {
          throw new Error('the connection must not be opened for a too_many_statements refusal');
        },
      }),
    (err: unknown) => err instanceof AppError && err.code === 'SKW_E_DM_DDL_REJECTED' && (err.detail as { reason: string }).reason === 'too_many_statements',
  );
});

test('R2. the postcondition refuses a table outside the four prefixes even if SQLite accepted it', () => {
  const path = freshSite();
  // A hand-planted table is exactly the state the postcondition exists to see. The
  // runner's own statements cannot create one (the AST refuses first), so the fixture
  // plants it and the runner is asked to commit a batch over it.
  const db0 = open(path);
  db0.exec('CREATE TABLE "stowaway" (id INTEGER PRIMARY KEY)');
  db0.close();

  const db = open(path);
  try {
    // The refusal is a code, not a thrown string.
    assert.throws(
      () => runDdl(path, [createTable('u_ok', [{ name: 'x', type: 'TEXT' }])], { actor: ACTOR }),
      (err: unknown) => err instanceof AppError && err.code === 'SKW_E_DM_DDL_POSTCONDITION',
    );
  } finally {
    db.close();
  }
  const after = open(path);
  try {
    assert.equal((after.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'u_ok'").get() as { n: number }).n, 0, 'the batch committed over a failing postcondition');
    assert.equal((after.prepare('SELECT count(*) AS n FROM cms_audit').get() as { n: number }).n, 0);
  } finally {
    after.close();
  }
});

test('R3. the postcondition is not vacuous: an unregistered trigger fails it', () => {
  const path = freshSite();
  runDdl(path, [createTable('u_post', [{ name: 'title', type: 'TEXT' }])], { actor: ACTOR });
  const db0 = open(path);
  db0.exec('CREATE TRIGGER trg_loose AFTER INSERT ON u_post BEGIN SELECT 1; END');
  db0.close();
  assert.throws(
    () => runDdl(path, [{ op: 'add_column', table: 'u_post', column: { name: 'sub', type: 'TEXT' } }], { actor: ACTOR }),
    (err: unknown) => err instanceof AppError && err.code === 'SKW_E_DM_DDL_POSTCONDITION',
  );
});

test('R4. the audit row of a DDL op chains onto the rows the CRUD path wrote', () => {
  const path = freshSite();
  runDdl(path, [createTable('u_post', [{ name: 'title', type: 'TEXT' }, { name: 'slug', type: 'TEXT' }, { name: 'body_html', type: 'TEXT' }])], { actor: ACTOR });
  const db = open(path);
  const tx = db.transaction(() => {
    createRow(db, 'cms_page', { path: '/one', slug: 'one', title: 'One', body_html: '<p>x</p>' }, ACTOR);
    appendAudit(db, ACTOR, 'manual.noop', 'u_table', 'u_post', null, null);
  });
  tx();
  db.close();

  runDdl(path, [{ op: 'add_column', table: 'u_post', column: { name: 'sub', type: 'TEXT' } }], { actor: ACTOR });

  const after = open(path);
  try {
    assert.equal(verifyChain(after).ok, true);
    const rows = after.prepare('SELECT action, prev_hash, hash FROM cms_audit ORDER BY id').all() as { action: string; prev_hash: string; hash: string }[];
    assert.deepEqual(rows.map((r) => r.action), ['ddl.create_table', 'cms_page.create', 'manual.noop', 'ddl.add_column']);
    for (let i = 1; i < rows.length; i += 1) assert.equal(rows[i]!.prev_hash, rows[i - 1]!.hash);
  } finally {
    after.close();
  }
});
