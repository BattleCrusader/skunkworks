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
 * A `query` source may not name any relation with no registry row — including a
 * `cms_*` table. That is the point of C-13: the registry is the set of tables the
 * builder created, and a source that reads `cms_audit` or `cms_page_revision` is
 * reading something the operator never agreed to export.
 */
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
