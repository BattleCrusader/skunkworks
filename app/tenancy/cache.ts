/**
 * The tenant map cache (SDS §5.4).
 *
 * Read once per process and cached with a version stamp
 * (`MAX(control_migration.id) || tenant count`), so a tenant created in another
 * process is picked up on the next request without a restart. A cache miss on a
 * host is a 404 — never a second source, and no fallback tenant exists.
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
  #stamp = '';
  #byHost = new Map<string, Tenant>();
  #byKey = new Map<string, Tenant>();
  #byId = new Map<number, Tenant>();

  constructor(controlDbPath: string, opts: { busyTimeoutMs?: number } = {}) {
    this.#db = new Database(controlDbPath, { readonly: true, fileMustExist: true });
    this.#db.pragma('query_only = 1');
    this.#db.pragma('foreign_keys = 1');
    this.#db.pragma(`busy_timeout = ${opts.busyTimeoutMs ?? 5000}`);
    this.refresh(true);
  }

  /** `MAX(control_migration.id) || tenant count` (§5.4, verbatim). */
  stamp(): string {
    const row = this.#db
      .prepare(
        `SELECT ifnull((SELECT max(id) FROM control_migration), 0) || ':' ||
                (SELECT count(*) FROM tenant) AS stamp`,
      )
      .get() as { stamp: string };
    return row.stamp;
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

    this.#byKey = byKey;
    this.#byId = byId;
    this.#byHost = byHost;
    this.#stamp = stamp;
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
