/**
 * A DDL/CRUD worker for the two gates that need a second **process**, not a second
 * connection: `BEGIN IMMEDIATE` serialises across processes, and a rollback can only be
 * proved by killing a process that is inside a transaction.
 *
 *   node test/helpers/ddl-child.ts ddl  <site.db> '<json>'
 *   node test/helpers/ddl-child.ts crud <site.db> '<json>'
 *
 * `ddl` json: {ops: DdlOp[], holdMs?: number, kill?: boolean, actor?: string,
 *             holdUntil?: string, signalOnBusy?: string}
 *   holdMs      — sleep inside the transaction before COMMIT (a contended lock is the point)
 *   kill        — SIGKILL this process between the last statement and COMMIT
 *   holdUntil   — **barrier, A's side**: hold the write lock until this file exists, or until
 *                 `holdMs` elapses as a deadline. Prints `holding` on stderr the instant the lock
 *                 is held, so the parent can start the contender at the right moment.
 *   signalOnBusy — **barrier, B's side**: create this file on the first `BEGIN IMMEDIATE` that
 *                 returns SQLITE_BUSY. That is the moment A's window is proven, not guessed.
 *
 * The two barrier keys exist because `holdMs` alone made the serialisation gate a race against
 * node's boot: A slept 400 ms and the parent slept 120 ms, so the test was only correct on a box
 * where both processes started inside the gap. With the pair, A cannot commit before B has
 * collided with its lock — the overlap is a construction.
 * `crud` json: {table: string, rows: number, pauseMs?: number, prefix?: string}
 *
 * Everything it learns goes to stdout as one JSON line; the parent asserts on it.
 */
import { appendAudit } from '../../app/audit/chain.ts';
import { createRow } from '../../app/admin/crud.ts';
import { existsSync, writeFileSync } from 'node:fs';
import { runDdl, context } from '../../app/ddl/run.ts';
import { emit } from '../../app/ddl/ops.ts';
import type { DdlOp } from '../../app/ddl/ops.ts';
import { openAdminWrite } from '../../app/db/classes.ts';

const SLEEP = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms: number): void {
  Atomics.wait(SLEEP, 0, 0, ms);
}

const mode = process.argv[2] ?? '';
const file = process.argv[3] ?? '';
const spec = JSON.parse(process.argv[4] ?? '{}') as Record<string, unknown>;

function say(value: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

if (mode === 'ddl') {
  const ops = spec.ops as DdlOp[];
  const actor = { userId: 1, label: (spec.actor as string | undefined) ?? 'child@acme.test' };
  const began = Date.now();
  const holdUntil = typeof spec.holdUntil === 'string' ? spec.holdUntil : null;
  const signalOnBusy = typeof spec.signalOnBusy === 'string' ? spec.signalOnBusy : null;
  // B's half of the barrier: the first `BEGIN IMMEDIATE` that finds the lock held creates the
  // file A is waiting on. Instrumenting `exec` is the only way to see the collision from here,
  // and it uses the `open` seam `runDdl` already documents as a test seam — no product code moves.
  const openForDdl = (file: string): ReturnType<typeof openAdminWrite> => {
    const db = openAdminWrite(file);
    if (signalOnBusy === null) return db;
    const exec = db.exec.bind(db);
    db.exec = (sql: string): typeof db => {
      try {
        return exec(sql);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (/BEGIN\s+IMMEDIATE/i.test(sql) && /SQLITE_BUSY|SQLITE_LOCKED|database is locked/i.test(message)) {
          if (!existsSync(signalOnBusy)) writeFileSync(signalOnBusy, String(Date.now()));
        }
        throw err;
      }
    };
    return db;
  };
  try {
    const report = runDdl(file, ops, {
      actor,
      open: openForDdl,
      hooks: {
        beforeCommit: ({ db }) => {
          if (spec.kill === true) {
            // The exact point §9.4 calls "any failure": statements, registry row and
            // audit row are written and the transaction is not committed.
            process.kill(process.pid, 'SIGKILL');
          }
          if (typeof spec.holdMs === 'number' || holdUntil !== null) {
            // Prove the lock is held: a second process must not get in until COMMIT.
            db.prepare(
              `INSERT INTO cms_settings(key, value_json, type) VALUES (?, ?, 'string')
               ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
            ).run(`hold-${process.pid}`, String(Date.now()));
            // The instant the lock is held, said out loud. The parent starts the contender on
            // this line, so the contender's first `BEGIN IMMEDIATE` lands inside the window.
            process.stderr.write('holding\n');
            if (holdUntil !== null) {
              // Wait for the contender to prove it collided; `holdMs` is only a deadline, so a
              // broken barrier fails the gate on `lockAttempts` instead of hanging the suite.
              const deadline = Date.now() + Number(spec.holdMs ?? 10_000);
              while (!existsSync(holdUntil) && Date.now() < deadline) sleepSync(5);
            } else {
              sleepSync(Number(spec.holdMs));
            }
          }
        },
      },
    });
    say({ ok: true, beganAt: began, endedAt: Date.now(), report });
  } catch (err) {
    say({ ok: false, beganAt: began, endedAt: Date.now(), error: err instanceof Error ? `${(err as { code?: string }).code ?? ''}: ${err.message}` : String(err) });
    process.exitCode = 1;
  }
} else if (mode === 'crud') {
  const table = spec.table as string;
  const rows = Number(spec.rows ?? 10);
  const pauseMs = Number(spec.pauseMs ?? 0);
  const prefix = (spec.prefix as string | undefined) ?? 'row';
  const db = openAdminWrite(file);
  const holdMs = Number(spec.holdMs ?? 0);
  const holdFirstUntil = typeof spec.holdFirstUntil === 'string' ? spec.holdFirstUntil : null;
  const holdMaxMs = Number(spec.holdMaxMs ?? 15_000);
  // Readiness, so a parent can start the rebuild *while* the writers are running rather
  // than while node is still parsing this file.
  process.stderr.write('ready\n');
  let written = 0;
  const started = Date.now();
  try {
    for (let i = 0; i < rows; i += 1) {
      // One transaction per row, through the production writer: the rebuild must not be
      // able to lose a committed row, and a row the writer rolled back must not appear.
      // `holdMs` keeps that transaction — and therefore the write lock — open, which is
      // what a rebuild has to wait behind.
      // `IMMEDIATE`, not the default `DEFERRED`: a deferred transaction that reads and
      // then writes gets SQLITE_BUSY the moment another writer holds the lock, and
      // `busy_timeout` does not apply to that upgrade. An immediate begin is what the
      // DDL runner itself uses, so the writers contend the same way it does.
      db.transaction(() => {
        createRow(db, table, { slug: `${prefix}-${i}`, title: `${prefix} ${i}`, body_html: '<p>x</p>' }, { userId: 2, label: 'writer@acme.test' });
        if (holdFirstUntil !== null && i === 0) {
          // The barrier's writer side: the first transaction holds the write lock until someone
          // proves it collided (the rebuild writes `holdFirstUntil` on its first BUSY). The
          // assertion "the rebuild reported a wait" is then true by construction, not by luck.
          process.stderr.write('holding\n');
          const deadline = Date.now() + holdMaxMs;
          while (!existsSync(holdFirstUntil) && Date.now() < deadline) sleepSync(5);
        } else if (holdMs > 0) {
          sleepSync(holdMs);
        }
      }).immediate();
      written += 1;
      if (pauseMs > 0) sleepSync(pauseMs);
    }
    say({ ok: true, written, startedAt: started, endedAt: Date.now() });
  } catch (err) {
    say({ ok: false, written, startedAt: started, endedAt: Date.now(), error: err instanceof Error ? err.message : String(err) });
    process.exitCode = 1;
  } finally {
    db.close();
  }
} else if (mode === 'preview') {
  // The statements `emit()` produces for one op against the live schema — what the
  // preview route shows, printed so a parent can compare it with what ran.
  const db = openAdminWrite(file);
  try {
    const op = spec.op as DdlOp;
    const plan = emit(op, context(db, 8));
    say({ ok: true, statements: plan.statements });
  } finally {
    db.close();
  }
} else if (mode === 'audit') {
  // Appends a chained audit row from a second process (the seal gate uses it).
  const db = openAdminWrite(file);
  try {
    const tx = db.transaction(() => appendAudit(db, { userId: 1, label: 'child@acme.test' }, String(spec.action ?? 'noop'), 'u_table', 'x', null, { at: Date.now() }));
    tx();
    say({ ok: true });
  } finally {
    db.close();
  }
} else {
  say({ ok: false, error: `unknown mode ${mode}` });
  process.exitCode = 2;
}
