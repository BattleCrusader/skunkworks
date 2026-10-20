/**
 * §6.2 — the compiler. **No value is ever concatenated**: every value is a `?`,
 * and every identifier comes from a name the allowlist already accepted.
 *
 * The two refusals this module owns, in the order the gate wants them:
 *
 *   1. a projected / filtered / ordered / grouped column outside the allowlist
 *      → `SKW_E_RT_SOURCE_UNKNOWN` naming the column (checked at publish AND at
 *      resolve, because a table can be rebuilt between the two);
 *   2. a value that does not fit its declared domain → `SKW_E_RT_SOURCE_UNKNOWN`
 *      with `reason=param_invalid`, naming the parameter. A typo must not silently
 *      serve unfiltered rows.
 */
import { sourceUnknown, type SourceParam, type SourceSpec } from './spec.ts';
import type { Allowlist } from './registry.ts';

export interface Compiled {
  sql: string;
  bind: unknown[];
  /** The limit actually applied, after `limit_max` clamping. */
  limit: number;
  /** True when the caller asked for more rows than the source allows (§6.3). */
  truncated: boolean;
}

export function quote(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

/**
 * Every column the spec names must be in the relation's allowlist. Refuses the
 * first offender, in projection→where→order→group_by→aggregate order, and says
 * which role it had.
 */
export function assertWithinAllowlist(spec: SourceSpec, allowed: Allowlist): void {
  const check = (column: string, role: string): void => {
    if (allowed.columns.has(column)) return;
    // D6: a registered column the live table lost is `column_drift`, not `column_not_allowed`.
    // The two refusals share a code because they share a cause — the source no longer matches
    // the relation — but they are different operator facts: one is a typo in a spec, the other
    // is a schema that moved out of band.
    if (allowed.drifted.has(column)) {
      throw sourceUnknown('column_drift', `column ${JSON.stringify(column)} no longer exists in ${spec.relation}`, {
        column,
        role,
        relation: spec.relation,
      });
    }
    throw sourceUnknown('column_not_allowed', `column ${JSON.stringify(column)} is not in the allowlist (${role})`, {
      column,
      role,
      relation: spec.relation,
    });
  };
  for (const column of spec.columns) check(column, 'columns');
  for (const clause of spec.where) check(clause.col, 'where');
  for (const clause of spec.order) check(clause.col, 'order');
  for (const column of spec.groupBy) check(column, 'group_by');
  if (spec.aggregate !== null) check(spec.aggregate.column, 'aggregate');
}

/** The default for a parameter that a render did not pass: the first declared value. */
export function defaultParam(param: SourceParam): unknown {
  if (param.kind === 'enum') return param.values?.[0] ?? '';
  if (param.kind === 'int' || param.kind === 'page') return 0;
  return '';
}

function coerce(param: SourceParam, value: unknown): unknown {
  if (param.kind === 'enum') {
    const text = String(value);
    if (!(param.values ?? []).includes(text)) {
      throw sourceUnknown('param_invalid', `parameter ${param.name} is not one of its declared values`, {
        param: param.name,
        value: text,
      });
    }
    return text;
  }
  if (param.kind === 'int' || param.kind === 'page') {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isInteger(n) || n < 0 || n > 1_000_000_000) {
      throw sourceUnknown('param_invalid', `parameter ${param.name} must be a non-negative integer`, { param: param.name });
    }
    return n;
  }
  // `bound` and `free` are text, bounded. `free` is the search box the exporter
  // refuses (§6.4); the resolver still bounds it so one request cannot send 2 MB.
  const text = String(value);
  if (text.length > 200) {
    throw sourceUnknown('param_invalid', `parameter ${param.name} is longer than 200 characters`, { param: param.name });
  }
  return text;
}

/**
 * Fill defaults, refuse unknown keys, and validate each value against its declared
 * domain. `limit` is the one request-level key that is not declared: it is the
 * `list` component's `data-limit` (§6.3) and is clamped by `compile`.
 */
export function bindParams(spec: SourceSpec, request: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const declared = new Map(spec.params.map((p) => [p.name, p]));
  for (const key of Object.keys(request)) {
    if (key !== 'limit' && !declared.has(key)) {
      throw sourceUnknown('param_unknown', `parameter ${key} is not declared by this source`, { param: key });
    }
  }
  for (const param of spec.params) {
    const value = Object.prototype.hasOwnProperty.call(request, param.name) ? request[param.name] : defaultParam(param);
    out[param.name] = coerce(param, value);
  }
  return out;
}

export interface CompileOptions {
  /** False only when the caller has already run `assertWithinAllowlist`. */
  checkAllowlist?: boolean;
}

/**
 * The request-level `limit`, and the one rule about it: **an integer, or a refusal**.
 *
 * `data-limit` is an HTML attribute, so it arrives as a string, and the old shape here
 * (`typeof requested === 'number' && Number.isFinite(...)`) had two answers for one rule:
 * `'5'` fell through to `limit_default` and served silently, `5.5` was floored with no
 * refusal, and only `-1` refused — for a message that named no parameter. QA measured all
 * three (`S2-qa.md` §3.3, M5) while §6.2 claimed the refusal existed.
 *
 * The refusal is the same code, reason and detail every other invalid parameter produces
 * (`param_invalid`, `detail.param`), which is why this is a code fix and not a taxonomy
 * change. Clamping to `limit_max` stays, because asking for too many rows is a request the
 * product answers with `data-truncated` — asking for *five and a half* rows is not a number
 * of rows at all.
 */
export function requestLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw sourceUnknown('param_invalid', `limit must be an integer, got ${JSON.stringify(value)}`, { param: 'limit' });
  }
  if (value < 1) {
    throw sourceUnknown('param_invalid', `limit must be at least 1, got ${String(value)}`, { param: 'limit' });
  }
  return value;
}

export function compile(spec: SourceSpec, allowed: Allowlist, request: Record<string, unknown>, opts: CompileOptions = {}): Compiled {
  if (opts.checkAllowlist !== false) assertWithinAllowlist(spec, allowed);

  const bind: unknown[] = [];
  const projection: string[] = [];
  if (spec.aggregate === null) {
    for (const column of spec.columns) projection.push(quote(column));
  } else {
    for (const column of spec.groupBy) projection.push(quote(column));
    projection.push(`${spec.aggregate.fn}(${quote(spec.aggregate.column)}) AS ${quote(`${spec.aggregate.fn}_${spec.aggregate.column}`)}`);
  }

  let sql = `SELECT ${projection.join(', ')} FROM ${quote(spec.relation)}`;
  if (spec.where.length > 0) {
    const clauses = spec.where.map((clause) => {
      bind.push(request[clause.param]);
      return `${quote(clause.col)} ${clause.op} ?`;
    });
    sql += ` WHERE ${clauses.join(' AND ')}`;
  }
  if (spec.groupBy.length > 0) sql += ` GROUP BY ${spec.groupBy.map(quote).join(', ')}`;
  if (spec.order.length > 0) {
    sql += ` ORDER BY ${spec.order.map((clause) => `${quote(clause.col)} ${clause.dir.toUpperCase()}`).join(', ')}`;
  }

  const requested = request.limit;
  // D31: the default is clamped here as well as at parse. Two clamps of one number look
  // redundant until you ask which one a caller can bypass: `compile` is exported and a test, a
  // component or a future route can hand it a hand-built `SourceSpec` that never went through
  // `parseSpec`. A clamp the render path owns is the only one that cannot be skipped.
  let limit = Math.min(spec.limitDefault, spec.limitMax);
  let truncated = false;
  if (requested !== undefined) {
    const wanted = requestLimit(requested);
    if (wanted > spec.limitMax) {
      limit = spec.limitMax;
      truncated = true;
    } else {
      limit = wanted;
    }
  }
  sql += ' LIMIT ?';
  bind.push(limit);

  return { sql, bind, limit, truncated };
}

/**
 * The parameter set the publish gate measures with. Every declared parameter gets a
 * value from its own domain — an enum's first value, 0 for int/page, `''` for
 * text — so the measured plan is the plan a real render can produce, and the
 * measurement is taken at `limit_max` (the worst case the source allows).
 */
export function measurementParams(spec: SourceSpec): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const param of spec.params) out[param.name] = defaultParam(param);
  out.limit = spec.limitMax;
  return out;
}
