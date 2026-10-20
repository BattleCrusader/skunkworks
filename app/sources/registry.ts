/**
 * §6.1 — the registry: one row per named source, and the column allowlist the
 * server enforces.
 *
 * The allowlist is not a list in a config file. It is the schema's own record of
 * the relation:
 *
 *   - `query` → `cms_table_registry.columns_json` (C-13's closed-type inventory,
 *     the same JSON the DDL rebuild regenerates from);
 *   - `view`  → `cms_view_registry` (views are migration-owned) plus
 *     `PRAGMA table_xinfo`, which is where the view's real columns live.
 *
 * A `view`'s allowlist is only meaningful for the body it was published against, so
 * `assertViewChecksum` runs **before** it (E-21, §6.1a): the registry's
 * `checksum` is `sha256(sqlite_master.sql)`, verified at publish and at every
 * resolve, and cached under `user_version:schema_version` so it is not per-request.
 *
 * A `query` source may not name any relation with no registry row — including a
 * `cms_*` table. That is the point of C-13: the registry is the set of tables the
 * builder created, and a source that reads `cms_audit` or `cms_page_revision` is
 * reading something the operator never agreed to export.
 */
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';

import { sourceUnknown } from './spec.ts';

export interface SourceRow {
  id: number;
  key: string;
  kind: string;
  spec_json: string;
  aggregate_json: string | null;
  group_by_json: string | null;
  params_json: string;
  is_public: number;
  ttl_s: number;
  cost_ms_p95: number | null;
  cost_ms_max: number | null;
  cost_rows: number | null;
  cost_measured_at: string | null;
  cost_plan: string | null;
  created_at: string;
  published_at: string | null;
  published_by: number | null;
}

export const SOURCE_COLUMNS =
  'id, key, kind, spec_json, aggregate_json, group_by_json, params_json, is_public, ttl_s, cost_ms_p95, cost_ms_max, cost_rows, cost_measured_at, cost_plan, created_at, published_at, published_by';

export function readSource(db: Database.Database, key: string): SourceRow | undefined {
  return db.prepare(`SELECT ${SOURCE_COLUMNS} FROM cms_datasource WHERE key = ?`).get(key) as SourceRow | undefined;
}

export function listSources(db: Database.Database): SourceRow[] {
  return db.prepare(`SELECT ${SOURCE_COLUMNS} FROM cms_datasource ORDER BY key`).all() as SourceRow[];
}

/** Does the relation exist at all? A missing table is `SOURCE_UNKNOWN`, not a SQL error. */
function relationExists(db: Database.Database, relation: string, type: 'table' | 'view'): boolean {
  const row = db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = ? AND name = ?").get(type, relation);
  return row !== undefined;
}

export interface Allowlist {
  columns: Set<string>;
  /** Leftmost column of each index: the columns a SEARCH can actually start from. */
  indexed: Set<string>;
}

/**
 * The columns a source is allowed to name, and the ones an index can serve.
 *
 * Refusals name the column: §6.2's `422 SKW_E_RT_SOURCE_UNKNOWN` is the code, and
 * an operator who typed `secret_col` needs to see `secret_col`, not "invalid".
 */
export function allowlistFor(db: Database.Database, kind: string, relation: string): Allowlist {
  if (kind === 'query') {
    const row = db.prepare('SELECT columns_json FROM cms_table_registry WHERE table_name = ?').get(relation) as
      | { columns_json: string }
      | undefined;
    if (row === undefined) {
      throw sourceUnknown('table_not_registered', `${relation} is not a registered runtime table (cms_table_registry)`, {
        relation,
      });
    }
    if (!relationExists(db, relation, 'table')) {
      throw sourceUnknown('table_missing', `${relation} is in cms_table_registry but not in the schema`, { relation });
    }
    const columns = new Set<string>(['id']);
    for (const column of JSON.parse(row.columns_json) as { name: string }[]) columns.add(column.name);
    return { columns, indexed: leftmostIndexed(db, relation) };
  }

  if (kind === 'view') {
    const registered = db.prepare('SELECT name FROM cms_view_registry WHERE name = ?').get(relation);
    if (registered === undefined) {
      throw sourceUnknown('view_not_registered', `${relation} is not in cms_view_registry`, { relation });
    }
    if (!relationExists(db, relation, 'view')) {
      throw sourceUnknown('view_missing', `${relation} is registered but not in the schema`, { relation });
    }
    const columns = new Set<string>(
      (db.prepare(`PRAGMA table_xinfo("${relation}")`).all() as { name: string }[]).map((c) => c.name),
    );
    return { columns, indexed: leftmostIndexed(db, relation) };
  }

  // Defence in depth: `assertKind` refuses this before a connection exists, and the
  // schema CHECK refuses the row. A caller that reached here with `function` gets
  // the same refusal rather than a silent view-shaped read.
  throw sourceUnknown('kind_not_representable', `${kind} data sources are not representable in v1 (C-18)`, { kind });
}

export function leftmostIndexed(db: Database.Database, relation: string): Set<string> {
  const out = new Set<string>();
  const indexes = db.prepare(`PRAGMA index_list("${relation}")`).all() as { name: string; origin: string }[];
  for (const index of indexes) {
    const info = db.prepare(`PRAGMA index_info("${index.name}")`).all() as { seqno: number; name: string | null }[];
    const first = info.find((c) => c.seqno === 0);
    if (first?.name !== null && first?.name !== undefined) out.add(first.name);
  }
  // The integer primary key is the rowid and is indexed by definition.
  out.add('id');
  return out;
}

// --- §6.1a (E-21): a `view` source is anchored to the definition it was published against ------

/**
 * `sha256(sqlite_master.sql)`, lower-case hex, over the exact text SQLite stores — no
 * normalisation. Normalising it (stripping `CREATE VIEW`, folding whitespace) would let two
 * different definitions share a checksum, which is the failure mode a checksum is for.
 */
export function hashRelationSql(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}

/** `stamp = PRAGMA user_version || ':' || PRAGMA schema_version` — SQLite's schema cookie. */
export function schemaStamp(db: Database.Database): string {
  const userVersion = Number(db.pragma('user_version', { simple: true }));
  const schemaVersion = Number(db.pragma('schema_version', { simple: true }));
  return `${userVersion}:${schemaVersion}`;
}

/**
 * The verdict map, keyed by the connection it belongs to.
 *
 * `PRAGMA schema_version` advances on **every** DDL statement that changes the schema — including
 * `CREATE VIEW`, `DROP VIEW`, and an `ALTER TABLE … RENAME` that rewrites a view's body — so one
 * pragma read and **no hash** is the cost when the stamp is unchanged, and one
 * `SELECT sql FROM sqlite_master` plus one sha256 per view when it moved. A cache that could go
 * stale is not needed and is not permitted: if the stamp did not move, the stored text did not
 * change. Keyed by handle because two connections to the same file are two schema cookies.
 */
const viewChecksumCache = new WeakMap<Database.Database, { stamp: string; checksums: Map<string, string> }>();

/** How many hashes were actually computed. `V1-3` asserts 100 resolves cost one. */
export const viewChecksumStats = { viewChecksumHashes: 0, stampMoves: 0 };

export function resetViewChecksumStats(): void {
  viewChecksumStats.viewChecksumHashes = 0;
  viewChecksumStats.stampMoves = 0;
}

/** The hash of a view's stored definition, cached under the schema stamp. */
export function viewChecksum(db: Database.Database, relation: string): string {
  const stamp = schemaStamp(db);
  let entry = viewChecksumCache.get(db);
  if (entry === undefined) {
    entry = { stamp, checksums: new Map() };
    viewChecksumCache.set(db, entry);
  } else if (entry.stamp !== stamp) {
    // Every DDL statement that changed the schema: the stored text may have changed with it.
    entry.stamp = stamp;
    entry.checksums.clear();
    viewChecksumStats.stampMoves += 1;
  }
  const hit = entry.checksums.get(relation);
  if (hit !== undefined) return hit;
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'view' AND name = ?").get(relation) as
    | { sql: string | null }
    | undefined;
  if (row === undefined || row.sql === null) {
    throw sourceUnknown('view_missing', `${relation} is registered but not in the schema`, { relation });
  }
  const checksum = hashRelationSql(row.sql);
  entry.checksums.set(relation, checksum);
  viewChecksumStats.viewChecksumHashes += 1;
  return checksum;
}

export interface ViewAnchor {
  relation: string;
  /** What `cms_view_registry` says the body was. */
  registered: string;
  /** What `sqlite_master` says it is now. */
  found: string;
  ok: boolean;
}

/** The registered checksum and the live one, without refusing. Used by the DDL postcondition. */
export function viewAnchor(db: Database.Database, relation: string): ViewAnchor | null {
  const row = db.prepare('SELECT checksum FROM cms_view_registry WHERE name = ?').get(relation) as
    | { checksum: string }
    | undefined;
  if (row === undefined) return null;
  const found = viewChecksum(db, relation);
  return { relation, registered: row.checksum, found, ok: row.checksum === found };
}

/**
 * Step 5a of the resolve order — and the publish-time half of the same rule.
 *
 * The order matters: the column allowlist reads the live view (`PRAGMA table_xinfo`), so it must not
 * run before the body has been proved to be the one that was registered.
 *
 * The refusal is `422 SKW_E_RT_SOURCE_UNKNOWN`, `reason = 'view_checksum'`, with the two digests
 * truncated to 16 hex: the source is no longer the object that was published, which is the same
 * class as `reason = 'view_missing'`, so no new code is minted for it.
 *
 * Exclusive witness: test/sources.test.ts V1-1
 */
export function assertViewChecksum(db: Database.Database, relation: string): void {
  const anchor = viewAnchor(db, relation);
  if (anchor === null) {
    throw sourceUnknown('view_not_registered', `${relation} is not in cms_view_registry`, { relation });
  }
  if (!anchor.ok) {
    throw sourceUnknown(
      'view_checksum',
      `the definition of view ${relation} is not the one the source was published against; review it and republish the source`,
      { relation, registered: anchor.registered.slice(0, 16), found: anchor.found.slice(0, 16) },
    );
  }
}

/**
 * One line per refusal, carrying the tenant, the relation and both digests, rate-limited to one per
 * `(tenant, relation)` per 60 s so a page in a hot loop cannot flood the log. The sink is a seam:
 * production writes to stderr through it, a test counts calls.
 */
const refusalAt = new Map<string, number>();
export const VIEW_REFUSAL_LOG_WINDOW_MS = 60_000;
let refusalSink: (line: string) => void = (line) => {
  process.stderr.write(`${line}\n`);
};

export function setViewRefusalSink(sink: ((line: string) => void) | null): void {
  refusalSink =
    sink ??
    ((line) => {
      process.stderr.write(`${line}\n`);
    });
  refusalAt.clear();
}

export function noteViewChecksumRefusal(
  tenantKey: string,
  anchor: { relation: string; registered: string; found: string },
  nowMs: number = Date.now(),
): boolean {
  const key = `${tenantKey}\u0000${anchor.relation}`;
  const last = refusalAt.get(key);
  if (last !== undefined && nowMs - last < VIEW_REFUSAL_LOG_WINDOW_MS) return false;
  refusalAt.set(key, nowMs);
  refusalSink(
    `view_checksum tenant=${tenantKey} relation=${anchor.relation} registered=${anchor.registered.slice(0, 16)} found=${anchor.found.slice(0, 16)}`,
  );
  return true;
}
