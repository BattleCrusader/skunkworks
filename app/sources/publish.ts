/**
 * §6.1/§6.2 — the publish gate. A source is published only when it survives every
 * refusal in this order, and the order is load-bearing:
 *
 *   1. the **kind** — `function` is refused before a connection exists (C-18): it
 *      is arbitrary code in the tenant tree, not a data source;
 *   2. the grammar (`spec.ts`) — a spec the resolver could not compile;
 *   3. the **column allowlist** (`registry.ts`) — the relation's own record;
 *   4. **EXPLAIN QUERY PLAN** — `SEARCH` present, no `SCAN`, and the refusal names
 *      the column (0.015 ms; measuring first would spend 1,304 ms to reject the
 *      same source);
 *   5. the index rule on every where/order/group_by column;
 *   6. the **measured worst case** (`cost_ms_max`) against the budget;
 *   7. one transaction: the row, then `cms_audit`.
 *
 * A draft (`saveSourceDraft`) runs 1–3 and stops: an operator building a source
 * needs to be told a column is not in the allowlist, but a draft with no index yet
 * is a source in progress. Saving a draft clears `published_at`, because a spec
 * that changed under a published plan is a source whose measured cost nobody knows.
 */
import type Database from 'better-sqlite3';

import { appendAudit, type AuditActor } from '../audit/chain.ts';
import { openAdminWrite } from '../db/classes.ts';
import { AppError } from '../errors.ts';
import { compile, measurementParams } from './compile.ts';
import { allowlistFor, readSource } from './registry.ts';
import { assertIndexedColumns, measure, planReport, refusePlan, rowCount } from './plan.ts';
import {
  COST_MS_MAX,
  assertKey,
  assertKind,
  parseSpec,
  sourceUnknown,
  type Aggregate,
  type SourceParam,
  type SourceSpec,
} from './spec.ts';

export interface SourceInput {
  key: string;
  /** `view` | `query`. Anything else is refused with C-18's code. */
  kind: string;
  spec: unknown;
  params?: SourceParam[];
  /** Mirrors `spec_json.aggregate`; the spec wins when both are given. */
  aggregate?: Aggregate | null;
  /** Mirrors `spec_json.group_by`; the spec wins when both are given. */
  groupBy?: string[] | null;
  isPublic?: boolean;
  ttlS?: number;
  /** The publish gate's ceiling for THIS source, default `COST_MS_MAX` (1.5 ms). */
  budgetMsMax?: number;
}

export interface PublishOptions {
  open?: (file: string) => Database.Database;
  nowMs?: number;
  measureRuns?: number;
}

export interface PublishReport {
  key: string;
  kind: string;
  is_public: boolean;
  published_at: string | null;
  plan: string[];
  cost_ms_max: number | null;
  cost_ms_p95: number | null;
  cost_rows: number | null;
  audit: { hash: string; ts: string };
}

interface Normalised {
  key: string;
  spec: SourceSpec;
  specJson: string;
  aggregateJson: string | null;
  groupByJson: string | null;
  paramsJson: string;
  isPublic: boolean;
  ttlS: number;
}

function normalise(input: SourceInput): Normalised {
  assertKind(input.kind);
  const key = assertKey(input.key);
  const kind = input.kind as 'view' | 'query';
  const base = parseSpec(kind, input.spec, input.params ?? []);

  // The two table columns mirror the spec. A caller that passes them separately is
  // describing the same thing; the spec wins, because that is what the resolver reads.
  const aggregate = base.aggregate ?? input.aggregate ?? null;
  const groupBy = base.groupBy.length > 0 ? base.groupBy : (input.groupBy ?? []);
  if (groupBy.length > 2) {
    throw new AppError('SKW_E_RT_SOURCE_BUDGET', 'group_by carries at most 2 columns', { reason: 'group_by' });
  }
  if (groupBy.length > 0 && aggregate === null) throw sourceUnknown('spec', 'group_by needs an aggregate');

  const spec: SourceSpec = { ...base, aggregate, groupBy };
  const ttlS = input.ttlS ?? 60;
  if (!Number.isInteger(ttlS) || ttlS < 0 || ttlS > 86_400) {
    throw new AppError('SKW_E_PLT_REQUEST_INVALID', 'ttl_s is 0–86400 seconds');
  }

  return {
    key,
    spec,
    specJson: JSON.stringify({
      ...(kind === 'query' ? { table: spec.relation } : { view: spec.relation }),
      columns: spec.columns,
      where: spec.where,
      order: spec.order,
      limit_default: spec.limitDefault,
      limit_max: spec.limitMax,
      ...(spec.aggregate === null ? {} : { aggregate: spec.aggregate }),
      ...(spec.groupBy.length === 0 ? {} : { group_by: spec.groupBy }),
    }),
    aggregateJson: spec.aggregate === null ? null : JSON.stringify(spec.aggregate),
    groupByJson: spec.groupBy.length === 0 ? null : JSON.stringify(spec.groupBy),
    paramsJson: JSON.stringify(spec.params),
    isPublic: input.isPublic === true,
    ttlS,
  };
}

function beforeImage(db: Database.Database, key: string): unknown {
  const row = readSource(db, key);
  if (row === undefined) return null;
  return {
    kind: row.kind,
    is_public: row.is_public,
    ttl_s: row.ttl_s,
    spec: JSON.parse(row.spec_json) as unknown,
    published_at: row.published_at,
  };
}

function upsert(db: Database.Database, n: Normalised, report: PublishReport | null, actor: AuditActor, atMs: number): void {
  const published = report !== null && report.published_at !== null;
  db.prepare(
    `INSERT INTO cms_datasource
       (key, kind, spec_json, aggregate_json, group_by_json, params_json, is_public, ttl_s,
        cost_ms_p95, cost_ms_max, cost_rows, cost_measured_at, cost_plan, published_at, published_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
        kind = excluded.kind, spec_json = excluded.spec_json,
        aggregate_json = excluded.aggregate_json, group_by_json = excluded.group_by_json,
        params_json = excluded.params_json, is_public = excluded.is_public, ttl_s = excluded.ttl_s,
        cost_ms_p95 = excluded.cost_ms_p95, cost_ms_max = excluded.cost_ms_max,
        cost_rows = excluded.cost_rows, cost_measured_at = excluded.cost_measured_at,
        cost_plan = excluded.cost_plan, published_at = excluded.published_at,
        published_by = excluded.published_by`,
  ).run(
    n.key,
    n.spec.kind,
    n.specJson,
    n.aggregateJson,
    n.groupByJson,
    n.paramsJson,
    n.isPublic ? 1 : 0,
    n.ttlS,
    published ? report.cost_ms_p95 : null,
    published ? report.cost_ms_max : null,
    published ? report.cost_rows : null,
    published ? new Date(atMs).toISOString() : null,
    published ? report.plan.join('\n') : null,
    published ? report.published_at : null,
    published ? actor.userId : null,
  );
}

/** §6.1: `function` is refused with its code before any handle exists. */
export function publishSource(file: string, input: SourceInput, actor: AuditActor, opts: PublishOptions = {}): PublishReport {
  // `assertKind` runs before the key and before `open`, so a `function` request
  // cannot be mistaken for a malformed name and cannot reach a connection.
  assertKind(input.kind);
  const n = normalise(input);
  const open = opts.open ?? ((path: string) => openAdminWrite(path));
  const atMs = opts.nowMs ?? Date.now();
  const db = open(file);
  try {
    const allowed = allowlistFor(db, n.spec.kind, n.spec.relation);
    // The publish-time allowlist check is this `compile` call: the first column
    // outside the relation's record is refused with its name.
    const compiled = compile(n.spec, allowed, measurementParams(n.spec));

    let plan: string[] = [];
    if (n.spec.kind === 'query') {
      const report = planReport(db, compiled.sql, compiled.bind, n.spec, allowed.indexed);
      if (report.scan) refusePlan(report, n.spec);
      plan = report.plan;
      assertIndexedColumns(n.spec, allowed, plan);
    }
    let measured = measure(db, compiled.sql, compiled.bind, opts.measureRuns ?? 200);
    const rows = rowCount(db, n.spec.relation);
    const ceiling = input.budgetMsMax ?? COST_MS_MAX;
    if (measured.cost_ms_max > ceiling) {
      // A max-of-200 is an extreme-value statistic, and this query's whole 200-run
      // batch is a few milliseconds: one OS deschedule inside that window can put a
      // 0.01 ms statement over a 1.5 ms ceiling. Confirm with a second max-of-200.
      // A source that is genuinely over budget is over in **both** batches; a host
      // stall is not. The accepted batch is what gets stored, so the stamp is a
      // measurement and not the larger of an accident and a fact.
      const confirm = measure(db, compiled.sql, compiled.bind, opts.measureRuns ?? 200);
      if (confirm.cost_ms_max > ceiling) {
        throw new AppError(
          'SKW_E_RT_SOURCE_BUDGET',
          `cost_ms_max ${confirm.cost_ms_max.toFixed(3)} ms exceeds the ${ceiling} ms budget (confirmed twice)`,
          { reason: 'cost', cost_ms_max: confirm.cost_ms_max, limit_ms: ceiling, rows, attempts: [measured.cost_ms_max, confirm.cost_ms_max] },
        );
      }
      measured = confirm;
    }

    const report: PublishReport = {
      key: n.key,
      kind: n.spec.kind,
      is_public: n.isPublic,
      published_at: new Date(atMs).toISOString(),
      plan,
      cost_ms_max: measured.cost_ms_max,
      cost_ms_p95: measured.cost_ms_p95,
      cost_rows: rows,
      audit: { hash: '', ts: '' },
    };

    const tx = db.transaction(() => {
      const before = beforeImage(db, n.key);
      upsert(db, n, report, actor, atMs);
      const after = {
        kind: report.kind,
        is_public: report.is_public,
        plan: report.plan,
        cost_ms_max: report.cost_ms_max,
        published_at: report.published_at,
      };
      report.audit = appendAudit(db, actor, 'source.publish', 'cms_datasource', n.key, before, after, atMs);
    });
    tx();
    return report;
  } finally {
    db.close();
  }
}

/**
 * A draft: grammar and allowlist only. No plan, no measurement, no `published_at` —
 * the resolver refuses it until someone publishes it (`reason=not_published`).
 */
export function saveSourceDraft(file: string, input: SourceInput, actor: AuditActor, opts: PublishOptions = {}): PublishReport {
  assertKind(input.kind);
  const n = normalise(input);
  const open = opts.open ?? ((path: string) => openAdminWrite(path));
  const atMs = opts.nowMs ?? Date.now();
  const db = open(file);
  try {
    const allowed = allowlistFor(db, n.spec.kind, n.spec.relation);
    compile(n.spec, allowed, measurementParams(n.spec));
    const report: PublishReport = {
      key: n.key,
      kind: n.spec.kind,
      is_public: n.isPublic,
      published_at: null,
      plan: [],
      cost_ms_max: null,
      cost_ms_p95: null,
      cost_rows: null,
      audit: { hash: '', ts: '' },
    };
    const tx = db.transaction(() => {
      const before = beforeImage(db, n.key);
      upsert(db, n, null, actor, atMs);
      report.audit = appendAudit(db, actor, 'source.draft', 'cms_datasource', n.key, before, { kind: report.kind, is_public: report.is_public }, atMs);
    });
    tx();
    return report;
  } finally {
    db.close();
  }
}
