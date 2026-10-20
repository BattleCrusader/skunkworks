/**
 * §6.2 — the plan check and the cost measurement, in that order.
 *
 * **The gate reads the plan before it measures anything.** A `SCAN` refuses in
 * 0.015 ms; measuring first would spend 1,304 ms to reject the same source. So
 * `explain()` runs before `measure()`, and `publish.ts` calls them in that order.
 *
 * **The refusal names the column that caused the plan.** SQLite's `EXPLAIN QUERY
 * PLAN` says `SCAN u_posts USING INDEX ix_posts_published_at` and never says
 * "because `status` has no index". The culprit is derived from the spec: the first
 * `where` column an index cannot start from, then the first `order` column, then
 * the first `group_by` column. That is the column the operator must index, and the
 * message says so.
 *
 * **The gate reads the maximum, not a percentile** (§6.2: p95 of 20 is not an
 * estimator). `cost_ms_max` is the worst of `measureRuns` (200 by default) and is
 * what decides; p95 is stored beside it for the report, not for the decision.
 */
import type Database from 'better-sqlite3';
import { performance } from 'node:perf_hooks';

import { unindexed, type SourceSpec } from './spec.ts';
import type { Allowlist } from './registry.ts';

export interface PlanRow {
  id: number;
  parent: number;
  notused: number;
  detail: string;
}

export interface PlanReport {
  plan: string[];
  /** A `SCAN` anywhere in the plan — a full table scan or an index scan. */
  scan: boolean;
  /** The column the spec blames for the scan, when there is one. */
  column: string | null;
}

export function explain(db: Database.Database, sql: string, bind: readonly unknown[]): PlanRow[] {
  return db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(bind as never[])) as PlanRow[];
}

/**
 * The column that caused a SCAN. `indexed` is the leftmost-column set, because an
 * index whose second column matches cannot start the search.
 */
export function culpritColumn(spec: SourceSpec, indexed: Set<string>): string | null {
  for (const clause of spec.where) if (!indexed.has(clause.col)) return clause.col;
  for (const clause of spec.order) if (!indexed.has(clause.col)) return clause.col;
  for (const column of spec.groupBy) if (!indexed.has(column)) return column;
  const first = spec.columns[0];
  return first ?? null;
}

export function planReport(db: Database.Database, sql: string, bind: readonly unknown[], spec: SourceSpec, indexed: Set<string>): PlanReport {
  const rows = explain(db, sql, bind);
  const plan = rows.map((row) => row.detail);
  const scan = plan.some((detail) => /\bSCAN\b/.test(detail));
  return { plan, scan, column: scan ? culpritColumn(spec, indexed) : null };
}

/** The refusal for a plan carrying SCAN: `422 SKW_E_RT_SOURCE_UNINDEXED`, column named. */
export function refusePlan(report: PlanReport, spec: SourceSpec): never {
  const column = report.column ?? '(unknown)';
  throw unindexed(
    column,
    `the plan for source ${spec.relation} contains SCAN; column ${JSON.stringify(column)} has no usable index`,
    { plan: report.plan, relation: spec.relation },
  );
}

/**
 * §6.2's second index rule: every `where`/`order`/`group_by` column is indexed,
 * even when SQLite found a plan without a SCAN (it can use a temp B-tree for
 * ORDER BY, which is not a SCAN but is not an index either).
 */
export function assertIndexedColumns(spec: SourceSpec, allowed: Allowlist, plan: readonly string[]): void {
  for (const clause of spec.where) {
    if (!allowed.indexed.has(clause.col)) {
      throw unindexed(clause.col, `where column ${JSON.stringify(clause.col)} is not indexed`, { plan, role: 'where', relation: spec.relation });
    }
  }
  for (const clause of spec.order) {
    if (!allowed.indexed.has(clause.col)) {
      throw unindexed(clause.col, `order column ${JSON.stringify(clause.col)} is not indexed`, { plan, role: 'order', relation: spec.relation });
    }
  }
  for (const column of spec.groupBy) {
    if (!allowed.indexed.has(column)) {
      throw unindexed(column, `group_by column ${JSON.stringify(column)} is not indexed`, { plan, role: 'group_by', relation: spec.relation });
    }
  }
}

export interface CostReport {
  /** The number that decides: the worst of every measured run, in ms. */
  cost_ms_max: number;
  cost_ms_p95: number;
  cost_rows: number;
  samples: number;
}

/**
 * Runs the compiled statement `runs` times and returns the worst and the p95.
 *
 * The statement is prepared once, outside the loop: `prepare` is the compiler and
 * not the query, and measuring it would report a number no render pays.
 */
export function measure(db: Database.Database, sql: string, bind: readonly unknown[], runs = 200): CostReport {
  const statement = db.prepare(sql);
  // One warm-up execution, not counted: `prepare` compiles the statement but the
  // first `step` still faults in the b-tree pages and the WAL index. Charging that
  // to the query would report a cost no render after the first pays, and on a cold
  // file it is several milliseconds.
  statement.all(...(bind as never[]));
  const samples: number[] = [];
  for (let i = 0; i < runs; i += 1) {
    const started = performance.now();
    statement.all(...(bind as never[]));
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  const max = samples[samples.length - 1] ?? 0;
  const index = Math.min(samples.length - 1, Math.max(0, Math.round(0.95 * (samples.length - 1))));
  const p95 = samples[index] ?? 0;
  return { cost_ms_max: max, cost_ms_p95: p95, cost_rows: 0, samples: runs };
}

/** The relation's row count — the number that invalidates `cost_ms_max` when it doubles. */
export function rowCount(db: Database.Database, relation: string): number {
  const row = db.prepare(`SELECT count(*) AS n FROM "${relation.replace(/"/g, '""')}"`).get() as { n: number } | undefined;
  return Number(row?.n ?? 0);
}
