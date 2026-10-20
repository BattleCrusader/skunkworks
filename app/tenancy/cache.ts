/**
 * The tenant map cache (SDS §5.4 as amended by 02-errata E-3).
 *
 * `control.db` carries one revision row, moved by six triggers — AFTER INSERT,
 * AFTER UPDATE and AFTER DELETE on `tenant`, and the same three on `domain`. The
 * stamp is `rev || ':' || PRAGMA user_version`, read from the control handle the
 * map already holds: one `SEARCH control_revision USING INTEGER PRIMARY KEY` plus
 * one pragma read.
 *
 * The old `MAX(control_migration.id) || count(tenant)` stamp is deleted: it could
 * not see an UPDATE (a status flip is an UPDATE) and could not see a `domain` row
 * deleted while the tenant count was unchanged. That blindness is what made a
 * suspended tenant serve and a deleted host route until a restart.
 *
 * The map carries every column a request decision reads — `tenant.id`, `key`,
 * `mode`, `status`, `db_version` and the host list — so any bump is a full
 * rebuild of one immutable generation. There is no partial invalidation and no
 * per-table invalidation to forget.
 *
 * MID-REQUEST RULE (§5.4a). The stamp is read exactly once per request, before
 * the map is consulted, and the generation it selects is immutable for the rest
 * of that request. The resolver makes exactly one lookup per request, so
 * `stats.stampReads` must increase by one per request and no more. A write that
 * commits while a request is in flight is observed by the next request.
 *
 * SINGLE-FLIGHT. The rebuild is synchronous: `better-sqlite3` never yields, so
 * two requests cannot interleave inside `refresh()`. The request that sees the
 * new stamp performs the one rebuild; every other request arrives after it and
 * finds the stamp already current (`stats.rebuilds` is the proof).
 */
import Database from 'better-sqlite3';
import type { Tenant, TenantMode, TenantStatus } from './resolve.ts';

interface Row {
  id: number;
  key: string;
  mode: string;
  status: string;
  db_version: number;
}

function toTenant(row: Row): Tenant {
  return {
    id: row.id,
    key: row.key,
    mode: row.mode as TenantMode,
    status: row.status as TenantStatus,
    dbVersion: row.db_version,
  };
}

export class TenantMap {
  readonly #db: Database.Database;
  readonly #stampStmt: Database.Statement<[], { rev: number }>;
  #stamp = '';
  #byHost = new Map<string, Tenant>();
  #byKey = new Map<string, Tenant>();
  #byId = new Map<number, Tenant>();

  /** Instrumentation for §5.4a's one-read-per-request gate. */
  readonly stats = { stampReads: 0, rebuilds: 0 };

  constructor(controlDbPath: string, opts: { busyTimeoutMs?: number } = {}) {
    this.#db = new Database(controlDbPath, { readonly: true, fileMustExist: true });
    this.#db.pragma('query_only = 1');
    this.#db.pragma('foreign_keys = 1');
    this.#db.pragma(`busy_timeout = ${opts.busyTimeoutMs ?? 5000}`);
    this.#stampStmt = this.#db.prepare('SELECT rev FROM control_revision WHERE id = 1');
    this.refresh(true);
  }

  /** `rev || ':' || PRAGMA user_version` (§5.4, E-3). One SEARCH + one pragma. */
  stamp(): string {
    this.stats.stampReads += 1;
    const row = this.#stampStmt.get();
    if (row === undefined) {
      // A control.db migrated to v3 always has this row; its absence means the
      // file was hand-edited or migrated by something that skipped control-r3.
      throw new Error('control.db has no control_revision row (E-3): run `migrate`');
    }
    const version = Number(this.#db.pragma('user_version', { simple: true }));
    return `${row.rev}:${version}`;
  }

  refresh(force = false): boolean {
    const stamp = this.stamp();
    if (!force && stamp === this.#stamp) return false;
    const tenants = (this.#db
      .prepare('SELECT id, key, mode, status, db_version FROM tenant')
      .all() as Row[]).map(toTenant);
    const hosts = this.#db
      .prepare('SELECT host, tenant_id FROM domain')
      .all() as { host: string; tenant_id: number }[];

    const byKey = new Map<string, Tenant>();
    const byId = new Map<number, Tenant>();
    for (const t of tenants) {
      byKey.set(t.key, t);
      byId.set(t.id, t);
    }
    const byHost = new Map<string, Tenant>();
    for (const h of hosts) {
      const t = byId.get(h.tenant_id);
      // domain.host is COLLATE NOCASE and CHECKed to lowercase already.
      if (t !== undefined) byHost.set(h.host.toLowerCase(), t);
    }

    // One immutable generation: swapped wholesale, never mutated in place.
    this.#byKey = byKey;
    this.#byId = byId;
    this.#byHost = byHost;
    this.#stamp = stamp;
    this.stats.rebuilds += 1;
    return true;
  }

  lookupHost(host: string): Tenant | undefined {
    this.refresh();
    return this.#byHost.get(host);
  }

  lookupKey(key: string): Tenant | undefined {
    this.refresh();
    return this.#byKey.get(key);
  }

  lookupId(id: number): Tenant | undefined {
    this.refresh();
    return this.#byId.get(id);
  }

  all(): Tenant[] {
    this.refresh();
    return [...this.#byId.values()];
  }

  hosts(): Map<string, string> {
    this.refresh();
    const out = new Map<string, string>();
    for (const [host, tenant] of this.#byHost) out.set(host, tenant.key);
    return out;
  }

  close(): void {
    this.#db.close();
  }
}
