/**
 * §9.4 — the DDL runner. The most dangerous code in the product: a web form that can
 * create and destroy tables inside a tenant's database.
 *
 * The sequence is the SDS's, and it is not reorderable:
 *
 *     BEGIN IMMEDIATE
 *       <= SKW_DDL_MAX_STATEMENTS ops, emitted from templates only
 *       cms_table_registry row + cms_audit row, the SAME transaction
 *       postcondition: no table outside cms_|u_|p_|sqlite_, every u_/p_ table and
 *                      every trigger registered
 *     COMMIT                     -> on any failure: ROLLBACK, discard the connection
 *
 * Four rules that the code, not the comment, enforces:
 *
 *   1. **The connection is opened here and closed here.** The runner takes a *file
 *      path*, never a handle, so "the connection is discarded, not returned to the
 *      pool" is structural: there is no handle for a caller to reuse, and the handle
 *      that ran a schema change is closed in a `finally`. A connection that has
 *      executed DDL may hold a stale statement cache, and a pooled handle that once
 *      had `foreign_keys` toggled is exactly the state a permission boundary cannot
 *      afford (§9.4).
 *   2. **`foreign_keys` is toggled outside the transaction or not at all.** A
 *      `PRAGMA foreign_keys` inside a transaction is a silent no-op (check 6), so the
 *      12-step rebuild turns it off, begins, and turns it back on after COMMIT.
 *   3. **Refusals happen before any DDL is emitted.** The pure half of §4.4 runs
 *      before the connection exists; the context half runs after the handle is open
 *      and before `BEGIN IMMEDIATE`, and touches nothing but `sqlite_master`.
 *   4. **One transaction for the schema change, its registry row and its audit row.**
 *      A process killed mid-op leaves none of the three: SQLite rolls the transaction
 *      back on the next open (proved by `ddl-runner.test.ts` with SIGKILL, not with an
 *      assertion about the code).
 */
import Database from 'better-sqlite3';

import { appendAudit, type AuditActor } from '../audit/chain.ts';
import { openAdminWrite } from '../db/classes.ts';
import { AppError } from '../errors.ts';
import { hashRelationSql } from '../sources/registry.ts';
import {
  assertBatch,
  assertContextual,
  emit,
  isReferenceType,
  type ColumnSpec,
  type DdlContext,
  type DdlOp,
  type DdlPlan,
  type TableFacts,
} from './ops.ts';

export interface DdlOptions {
  actor: AuditActor;
  /** `SKW_DDL_MAX_STATEMENTS`, default 8 (§4.3). */
  maxStatements?: number;
  busyTimeoutMs?: number;
  /**
   * Test seam. Production never passes it. It exists so a gate can (a) count the SQL a
   * refused request never sent, and (b) kill the process between the last statement and
   * COMMIT to prove the rollback is the database's, not an assertion about it.
   */
  open?: (file: string) => Database.Database;
  hooks?: {
    /** Runs inside the transaction, after every statement, registry and audit row. */
    beforeCommit?: (info: { db: Database.Database; plan: DdlPlan }) => void;
  };
}

export interface DdlReport {
  ops: number;
  statements: number;
  tables: string[];
  /** How many times the write lock had to be re-attempted. See `waitedFor`. */
  lockAttempts: number;
  lockWaitMs: number;
  /**
   * A lower bound on the connections this transaction waited behind. SQLite exposes no
   * lock-holder identity, so the count is the number of re-attempts it took to obtain
   * `BEGIN IMMEDIATE`: each failed attempt was some other connection holding the write
   * lock. Named for what it measures rather than for what one would like it to measure.
   */
  waitedFor: number;
  rebuilt: string[];
  audit: { from: string; to: string }[];
  /** Views whose stored definition this batch changed, each refreshed and un-published (E-21). */
  views: string[];
}

/**
 * Runs a batch of `DdlOp`s against one tenant file.
 *
 * Everything or nothing: the batch shares one transaction, so the third statement
 * failing leaves the schema byte-identical (the test hashes the file before and after).
 */
export function runDdl(file: string, ops: readonly DdlOp[], options: DdlOptions): DdlReport {
  const maxStatements = options.maxStatements ?? 8;

  // The pure refusals, before a connection exists. A refused request provably sent no
  // SQL at all — the handle factory is never called.
  assertBatch(ops, maxStatements);

  // Whether the 12-step procedure runs is decided by the AST alone, so
  // `foreign_keys=OFF` can be set **outside** the transaction (§4.5) — inside it the
  // pragma is a silent no-op (check 6), which is the failure mode this ordering exists
  // to avoid.
  const rebuild = ops.some(needsRebuild);

  const open = options.open ?? ((path: string) => openAdminWrite(path, options.busyTimeoutMs ?? 5000));
  const db = open(file);
  try {
    db.pragma('foreign_keys = 1');
    if (rebuild) db.pragma('foreign_keys = 0');
    const lock = beginImmediate(db, options.busyTimeoutMs ?? 5000);
    // §6.1a (E-21): the views as they are BEFORE this batch, so the postcondition can prove which
    // stored definitions this transaction changed instead of guessing from a timestamp.
    const viewsBefore = snapshotViews(db);

    let statements = 0;
    let plans: DdlPlan[] = [];
    let changedViews: string[] = [];
    try {
      // §9.4's order, with C-13's rule kept: the transaction is open, and the AST
      // refuses before any DDL statement is generated. A refusal here rolls back a
      // transaction that only ever read.
      //
      // Each operation is planned against the schema **as the previous operations left
      // it** — a batch that creates a table and then indexes it is one request — and a
      // fresh context per operation is what makes that true. A stale cache would plan
      // `create_index` against a table that does not exist yet.
      for (const op of ops) {
        const ctx = context(db, maxStatements);
        assertContextual(op, ctx);
        const plan = emit(op, ctx);
        plans.push(plan);
        for (const statement of plan.statements) {
          db.exec(statement);
          statements += 1;
        }
        if (plan.rebuild !== undefined) {
          // The rebuild carried rows across with the FK check off. If the graph is now
          // broken, the transaction is refused rather than committed: a dangling
          // `asset_key` is the failure the guard triggers exist to prevent.
          const broken = db.pragma('foreign_key_check') as unknown[];
          if (broken.length > 0) {
            throw new AppError('SKW_E_DM_FK_VIOLATION', `the rebuild left ${broken.length} dangling reference(s)`);
          }
        }
        applyRegistry(db, plan);
        appendAudit(
          db,
          options.actor,
          plan.audit.action,
          plan.audit.targetKind,
          plan.audit.targetId,
          plan.audit.before,
          plan.audit.after,
        );
      }

      postcondition(db);
      changedViews = applyViewPostcondition(db, viewsBefore, options.actor);
      options.hooks?.beforeCommit?.({ db, plan: plans[plans.length - 1] as DdlPlan });
      db.exec('COMMIT');
    } catch (err) {
      if (db.inTransaction) {
        try {
          db.exec('ROLLBACK');
        } catch {
          /* a rollback that fails is still a discarded connection */
        }
      }
      throw err instanceof AppError ? err : taxonomy(err);
    }

    return {
      ops: ops.length,
      statements,
      tables: plans.map((p) => p.audit.targetId),
      rebuilt: plans.filter((p) => p.rebuild !== undefined).map((p) => p.rebuild!.table),
      lockAttempts: lock.attempts,
      lockWaitMs: lock.waitedMs,
      waitedFor: Math.max(0, lock.attempts - 1),
      audit: plans.map((p) => ({ from: p.audit.action, to: p.audit.targetId })),
      views: changedViews,
    };
  } finally {
    // §9.4: discarded, not returned. Closing is the only way to make that true for a
    // handle that ran DDL, and it happens whether the batch committed or not.
    try {
      if (db.inTransaction) db.exec('ROLLBACK');
    } catch {
      /* ignore: the connection is being discarded */
    }
    try {
      db.pragma('foreign_keys = 1');
    } catch {
      /* ignore: a handle that cannot take the pragma is being discarded */
    }
    db.close();
  }
}

/** `drop_column` always rebuilds; `add_column` only when SQLite refuses the ALTER form. */
export function needsRebuild(op: DdlOp): boolean {
  if (op.op === 'drop_column') return true;
  if (op.op === 'add_column') return op.column.notNull === true && isReferenceType(op.column.type);
  return false;
}

// --- the transaction's first statement ------------------------------------

const SLEEP = new Int32Array(new SharedArrayBuffer(4));

/** A synchronous sleep: `better-sqlite3` never yields, so neither may the retry loop. */
function sleepSync(ms: number): void {
  Atomics.wait(SLEEP, 0, 0, ms);
}

/**
 * `BEGIN IMMEDIATE`, retried so the wait can be *counted*.
 *
 * `busy_timeout` would wait silently, and §9.4's report has to say how many connections
 * the rebuild waited behind. `busy_timeout=0` plus an explicit retry loop turns each
 * contended attempt into a number, and the loop still gives up at the same deadline the
 * pragma would have used — a failure is `503 SKW_E_DM_BUSY` with its Retry-After, never
 * a hang.
 */
function beginImmediate(db: Database.Database, busyTimeoutMs: number): { attempts: number; waitedMs: number } {
  const deadline = Date.now() + busyTimeoutMs;
  const previous = Number(db.pragma('busy_timeout', { simple: true }));
  db.pragma('busy_timeout = 0');
  const started = Date.now();
  let attempts = 1;
  try {
    for (;;) {
      try {
        db.exec('BEGIN IMMEDIATE');
        return { attempts, waitedMs: Date.now() - started };
      } catch (err) {
        if (!isBusy(err) || Date.now() >= deadline) {
          throw isBusy(err) ? new AppError('SKW_E_DM_BUSY', 'the tenant database is busy') : err;
        }
        attempts += 1;
        sleepSync(Math.min(20, 2 * attempts));
      }
    }
  } finally {
    db.pragma(`busy_timeout = ${previous === 0 ? busyTimeoutMs : previous}`);
  }
}

function isBusy(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code ?? '';
  const message = err instanceof Error ? err.message : String(err);
  return code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED' || /database is locked/i.test(message);
}

// --- facts ----------------------------------------------------------------

/**
 * A read-only view of one tenant file, for the planner. Every field comes from
 * `sqlite_master` / `pragma table_info` / `cms_table_registry`; nothing here writes.
 */
export function context(db: Database.Database, maxStatements = 8): DdlContext {
  const cache = new Map<string, TableFacts>();
  const facts = (name: string): TableFacts => {
    const hit = cache.get(name);
    if (hit !== undefined) return hit;
    const row = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) as
      | { name: string; sql: string | null }
      | undefined;
    if (row === undefined) {
      const empty: TableFacts = { exists: false, columns: [], indexes: [], fkColumns: [], triggers: [], registryColumns: null };
      cache.set(name, empty);
      return empty;
    }
    const columns = (db.prepare(`PRAGMA table_xinfo("${name}")`).all() as { name: string; type: string; notnull: number; pk: number }[]).map(
      (c) => ({ name: c.name, type: c.type.toUpperCase(), notNull: c.notnull === 1, pk: c.pk > 0 }),
    );
    const indexList = db.prepare(`PRAGMA index_list("${name}")`).all() as { name: string; unique: number; origin: string }[];
    const indexes = indexList
      .filter((ix) => ix.origin === 'c') // `c` = CREATE INDEX; `u`/`pk` are constraint-owned
      .map((ix) => {
        const cols = (db.prepare(`PRAGMA index_info("${ix.name}")`).all() as { name: string }[]).map((c) => c.name);
        const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?").get(ix.name) as { sql: string } | undefined)?.sql ?? '';
        return { name: ix.name, columns: cols, unique: ix.unique === 1, sql };
      });
    const fkColumns: string[] = [];
    for (const fk of db.prepare(`PRAGMA foreign_key_list("${name}")`).all() as { from: string }[]) fkColumns.push(fk.from);
    const triggers = (
      db
        .prepare(
          `SELECT t.name AS name, t.tbl_name AS tableName, t.sql AS sql,
                  COALESCE(r.purpose, 'other') AS purpose, COALESCE(r.checksum, 'v3') AS checksum
             FROM sqlite_master t
             LEFT JOIN cms_trigger_registry r ON r.name = t.name
            WHERE t.type = 'trigger' AND (t.tbl_name = ? OR t.sql LIKE '%' || ? || '%')`,
        )
        .all(name, `"${name}"`) as { name: string; tableName: string; sql: string; purpose: string; checksum: string }[]
    ).filter((t) => t.sql !== null);
    const registry = db.prepare('SELECT columns_json FROM cms_table_registry WHERE table_name = ?').get(name) as
      | { columns_json: string }
      | undefined;
    const out: TableFacts = {
      exists: true,
      columns,
      indexes,
      fkColumns,
      triggers,
      registryColumns: registry === undefined ? null : (JSON.parse(registry.columns_json) as ColumnSpec[]),
    };
    cache.set(name, out);
    return out;
  };

  return {
    table: facts,
    indexOwner: (indexName: string) => {
      const row = db.prepare("SELECT tbl_name FROM sqlite_master WHERE type = 'index' AND name = ?").get(indexName) as
        | { tbl_name: string }
        | undefined;
      return row === undefined ? null : { table: row.tbl_name };
    },
    maxStatements,
  };
}

// --- the registry row, in the same transaction ----------------------------

function applyRegistry(db: Database.Database, plan: DdlPlan): void {
  const effect = plan.registry;
  if (effect.kind === 'insert') {
    db.prepare(
      `INSERT INTO cms_table_registry
         (table_name, table_class, plugin_id, ddl_version, column_count, index_count, columns_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      effect.row.table_name,
      effect.row.table_class,
      effect.row.plugin_id,
      effect.row.ddl_version,
      effect.row.column_count,
      effect.row.index_count,
      effect.row.columns_json,
    );
    return;
  }
  if (effect.kind === 'delete') {
    db.prepare('DELETE FROM cms_table_registry WHERE table_name = ?').run(effect.table);
    return;
  }
  const changed = db
    .prepare(
      `UPDATE cms_table_registry
          SET table_name = ?, column_count = ?, index_count = ?, columns_json = ?
        WHERE table_name = ?`,
    )
    .run(effect.table_name, effect.column_count, effect.index_count, effect.columns_json, effect.table)
    .changes;
  if (changed !== 1) {
    // A `u_*` table that the registry does not know is a schema the postcondition
    // would have refused; failing here keeps the count and the file in step.
    throw new AppError('SKW_E_DM_DDL_POSTCONDITION', `${effect.table} has no cms_table_registry row`);
  }
}

// --- §6.1a's view postcondition (E-21) ------------------------------------

export interface ViewSnapshot {
  /** `name → sqlite_master.sql` for every view, before the batch. */
  views: Map<string, string>;
  /** `name → checksum` from `cms_view_registry`, before the batch. */
  registry: Map<string, string>;
}

export function snapshotViews(db: Database.Database): ViewSnapshot {
  const views = new Map<string, string>();
  for (const row of db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'view'").all() as {
    name: string;
    sql: string | null;
  }[]) {
    if (row.sql !== null) views.set(row.name, row.sql);
  }
  const registry = new Map<string, string>();
  for (const row of db.prepare('SELECT name, checksum FROM cms_view_registry').all() as {
    name: string;
    checksum: string;
  }[]) {
    registry.set(row.name, row.checksum);
  }
  return { views, registry };
}

/**
 * A `view` source is a promise about a **relation**, and a DDL op can change what that relation is:
 * a `DROP`/`CREATE` in a migration, or a table rename that SQLite rewrites into the view's body. When
 * the stored text changed, this runs **inside the same transaction** as the statement that changed
 * it (§6.1a, E-21):
 *
 *   (i)  recompute and store `cms_view_registry.checksum`;
 *   (ii) clear publication of every `view` source over that relation — `published_at = NULL,
 *        is_public = 0`. Clearing publication is the point, not a side effect: a checksum refreshed
 *        without it would anchor the NEW definition and launder exactly the attack A5 performed;
 *   (iii) one `cms_audit` row, `action = 'source.view_redefined'`, with both digests and the keys
 *        that were un-published.
 *
 * A view with no registry row is not given one: minting an anchor for a definition nobody reviewed is
 * the thing the registry is for. It is still un-published and still audited, so the change is visible.
 */
export function applyViewPostcondition(
  db: Database.Database,
  before: ViewSnapshot,
  actor: AuditActor,
): string[] {
  const after = snapshotViews(db);
  const changed = new Set<string>();
  for (const [name, sql] of before.views) if (after.views.get(name) !== sql) changed.add(name);
  for (const name of after.views.keys()) if (!before.views.has(name)) changed.add(name);

  const touched: string[] = [];
  for (const relation of changed) {
    const sql = after.views.get(relation);
    const afterChecksum = sql === undefined ? null : hashRelationSql(sql);
    if (afterChecksum === null) {
      db.prepare('DELETE FROM cms_view_registry WHERE name = ?').run(relation);
    } else if (before.registry.has(relation)) {
      db.prepare('UPDATE cms_view_registry SET checksum = ? WHERE name = ?').run(afterChecksum, relation);
    }
    const unpublished = (
      db
        .prepare("SELECT key FROM cms_datasource WHERE kind = 'view' AND json_extract(spec_json, '$.view') = ? ORDER BY key")
        .all(relation) as { key: string }[]
    ).map((row) => row.key);
    db.prepare(
      "UPDATE cms_datasource SET published_at = NULL, is_public = 0 WHERE kind = 'view' AND json_extract(spec_json, '$.view') = ?",
    ).run(relation);
    appendAudit(
      db,
      actor,
      'source.view_redefined',
      'view',
      relation,
      { checksum: before.registry.get(relation) ?? null },
      { checksum: afterChecksum, unpublished },
    );
    touched.push(relation);
  }
  return touched;
}

// --- the postcondition ----------------------------------------------------

/**
 * §9.4's postcondition, run after every statement and before COMMIT:
 *
 *   - no table outside `cms_|u_|p_|sqlite_` — the four allowed prefixes, and the only
 *     place a naming mistake is caught that no CHECK constraint can see;
 *   - every `u_*` / `p_*` table has a `cms_table_registry` row (C-13);
 *   - every trigger has a `cms_trigger_registry` row (§4.1: "the DDL postcondition is
 *     'every trigger is in this registry', not 'there are zero triggers'").
 *
 * A failure here is raised **inside** the transaction, so the rollback takes the whole
 * batch: the postcondition cannot observe a state it then declines to keep.
 */
export function postcondition(db: Database.Database): void {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as { name: string }[];
  const allowed = /^(cms_|u_|p_)/;
  const stray = tables.filter((t) => !allowed.test(t.name)).map((t) => t.name);
  if (stray.length > 0) {
    throw new AppError('SKW_E_DM_DDL_POSTCONDITION', `tables outside cms_|u_|p_|sqlite_: ${stray.join(', ')}`);
  }

  const runtime = tables.filter((t) => t.name.startsWith('u_') || t.name.startsWith('p_')).map((t) => t.name);
  const registered = new Set(
    (db.prepare('SELECT table_name FROM cms_table_registry').all() as { table_name: string }[]).map((r) => r.table_name),
  );
  const unregistered = runtime.filter((t) => !registered.has(t));
  if (unregistered.length > 0) {
    throw new AppError('SKW_E_DM_DDL_POSTCONDITION', `runtime tables with no registry row: ${unregistered.join(', ')}`);
  }

  const triggers = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as { name: string }[]).map((t) => t.name);
  const known = new Set((db.prepare('SELECT name FROM cms_trigger_registry').all() as { name: string }[]).map((r) => r.name));
  const loose = triggers.filter((t) => !known.has(t));
  if (loose.length > 0) {
    throw new AppError('SKW_E_DM_DDL_POSTCONDITION', `triggers with no registry row: ${loose.join(', ')}`);
  }
}

// --- SQLite -> taxonomy ---------------------------------------------------

/**
 * The same mapping the CRUD writer uses (§9.3): a named code wins, then the constraint
 * classes, and a DDL failure is `SKW_E_DM_DDL_REJECTED` rather than a 500 — the
 * operator described a change that the schema would not take.
 */
export function taxonomy(err: unknown): AppError {
  if (err instanceof AppError) return err;
  const message = err instanceof Error ? err.message : String(err);
  const named = /SKW_E_[A-Z0-9_]+/.exec(message);
  if (named !== null) {
    try {
      return new AppError(named[0], undefined);
    } catch {
      /* a code the taxonomy does not carry falls through */
    }
  }
  if (isBusy(err)) return new AppError('SKW_E_DM_BUSY', 'the tenant database is busy');
  if (/UNIQUE constraint failed|already exists/i.test(message)) return new AppError('SKW_E_DM_KEY_IN_USE', 'that name is already used');
  if (/FOREIGN KEY constraint failed/i.test(message)) return new AppError('SKW_E_DM_FK_VIOLATION', 'a referenced row does not exist');
  if (/readonly|query_only/i.test(message)) return new AppError('SKW_E_PLT_INTERNAL', 'a write was attempted on a read-only connection');
  return new AppError('SKW_E_DM_DDL_REJECTED', 'the schema refused that change', { reason: 'sqlite', sqlite: message.slice(0, 200) });
}
