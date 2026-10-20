/**
 * The three connection classes (SDS §2.2 / C-15). There are exactly three, and
 * no fourth:
 *
 *   render-read   readonly:true + PRAGMA query_only=1 + foreign_keys=1 + busy_timeout
 *                 pooled LRU (SKW_DB_POOL_MAX, default 64). May only read.
 *   admin-write   foreign_keys=1. Discarded — not returned to the pool — after
 *                 any DDL or any statement not emitted from a template.
 *   exporter      foreign_keys=1, never inside a transaction, never pooled.
 *                 The only class permitted to run VACUUM INTO.
 *
 * query_only=1 is what closes Security's VACUUM INTO finding: with it, VACUUM
 * INTO and CREATE TEMP TRIGGER both fail "attempt to write a readonly database"
 * while ATTACH still succeeds — which is why the no-SQL-text rule stays
 * load-bearing rather than decorative (§2.2).
 */
import Database from 'better-sqlite3';

export type ConnectionClass = 'render-read' | 'admin-write' | 'exporter';

/**
 * How many SQLite connections this process has opened, ever. A diagnostic, not a policy: a
 * connection costs ~0.7 ms to open on a loaded box (the cost `runtime.sync` used to pay per
 * plugin-bearing request), and a budget nobody can measure is a budget nobody keeps. The counter
 * is monotonic and process-wide, so a gate takes deltas rather than absolute values.
 */
let connectionsOpened = 0;

export function connectionCount(): number {
  return connectionsOpened;
}

export function resetConnectionCount(): void {
  connectionsOpened = 0;
}

export interface ClassPragmas {
  queryOnly: boolean;
  foreignKeys: boolean;
  busyTimeoutMs: number;
}

export const PRAGMAS: Record<ConnectionClass, ClassPragmas> = {
  'render-read': { queryOnly: true, foreignKeys: true, busyTimeoutMs: 5000 },
  'admin-write': { queryOnly: false, foreignKeys: true, busyTimeoutMs: 5000 },
  exporter: { queryOnly: false, foreignKeys: true, busyTimeoutMs: 5000 },
};

export function openRenderRead(file: string, busyTimeoutMs = 5000): Database.Database {
  connectionsOpened += 1;
  const db = new Database(file, { readonly: true, fileMustExist: true });
  db.pragma('query_only = 1');
  db.pragma('foreign_keys = 1');
  db.pragma(`busy_timeout = ${busyTimeoutMs}`);
  assertClass(db, 'render-read', busyTimeoutMs);
  return db;
}

export function openAdminWrite(file: string, busyTimeoutMs = 5000): Database.Database {
  connectionsOpened += 1;
  const db = new Database(file);
  db.pragma('foreign_keys = 1');
  db.pragma(`busy_timeout = ${busyTimeoutMs}`);
  assertClass(db, 'admin-write', busyTimeoutMs);
  return db;
}

export function openExporter(file: string, busyTimeoutMs = 5000): Database.Database {
  connectionsOpened += 1;
  const db = new Database(file, { readonly: false, fileMustExist: true });
  db.pragma('foreign_keys = 1');
  db.pragma(`busy_timeout = ${busyTimeoutMs}`);
  // "never inside a transaction" is a caller obligation; assert we are not in one.
  if (db.inTransaction) throw new Error('exporter connection opened inside a transaction');
  assertClass(db, 'exporter', busyTimeoutMs);
  return db;
}

/**
 * Asserts on checkout. A handle that lost its pragmas is a permission boundary
 * that has already failed; refuse to use it.
 */
export function assertClass(db: Database.Database, cls: ConnectionClass, busyTimeoutMs = 5000): void {
  const want = PRAGMAS[cls];
  const fk = db.pragma('foreign_keys', { simple: true });
  if (Boolean(fk) !== want.foreignKeys) {
    throw new Error(`${cls}: foreign_keys is ${String(fk)}, expected ${want.foreignKeys ? 1 : 0}`);
  }
  if (cls === 'render-read') {
    const qo = db.pragma('query_only', { simple: true });
    if (Boolean(qo) !== want.queryOnly) {
      throw new Error(`render-read: query_only is ${String(qo)}, expected 1`);
    }
    if (!db.readonly) throw new Error('render-read: the handle is not readonly');
  }
  const bt = Number(db.pragma('busy_timeout', { simple: true }));
  if (!Number.isFinite(bt) || bt !== busyTimeoutMs) {
    throw new Error(`${cls}: busy_timeout is ${String(bt)}, expected ${busyTimeoutMs}`);
  }
}

/**
 * LRU of render-read handles (§2.2, SKW_DB_POOL_MAX default 64 — 185 KB per
 * handle, ≈11.8 MB at 64, which is why the default is not "all tenants").
 */
export class RenderPool {
  readonly #max: number;
  readonly #busyTimeoutMs: number;
  readonly #open = new Map<string, Database.Database>();
  #hits = 0;
  #misses = 0;
  #evictions = 0;

  constructor(max: number, busyTimeoutMs = 5000) {
    if (!Number.isInteger(max) || max < 1) throw new Error('pool max must be a positive integer');
    this.#max = max;
    this.#busyTimeoutMs = busyTimeoutMs;
  }

  get size(): number {
    return this.#open.size;
  }

  stats(): { size: number; hits: number; misses: number; evictions: number; max: number } {
    return { size: this.#open.size, hits: this.#hits, misses: this.#misses, evictions: this.#evictions, max: this.#max };
  }

  /** A warm handle for `file`; callers must not close it. */
  get(file: string): Database.Database {
    const existing = this.#open.get(file);
    if (existing !== undefined) {
      this.#hits += 1;
      // refresh recency
      this.#open.delete(file);
      this.#open.set(file, existing);
      return existing;
    }
    this.#misses += 1;
    const db = openRenderRead(file, this.#busyTimeoutMs);
    this.#open.set(file, db);
    this.#evictIfNeeded();
    return db;
  }

  #evictIfNeeded(): void {
    while (this.#open.size > this.#max) {
      const oldest = this.#open.keys().next();
      if (oldest.done === true) return;
      const db = this.#open.get(oldest.value);
      this.#open.delete(oldest.value);
      try {
        db?.close();
      } catch {
        /* a handle that cannot close is still out of the pool */
      }
      this.#evictions += 1;
    }
  }

  /** Drop a handle (a corrupt or migrated file must not stay cached). */
  discard(file: string): void {
    const db = this.#open.get(file);
    if (db === undefined) return;
    this.#open.delete(file);
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }

  close(): void {
    for (const db of this.#open.values()) {
      try {
        db.close();
      } catch {
        /* ignore */
      }
    }
    this.#open.clear();
  }
}
