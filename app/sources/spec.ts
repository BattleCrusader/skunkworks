/**
 * §6.2 — the `query` grammar, parsed once, refused by name.
 *
 * A source spec is data, never SQL text. This module turns `spec_json` into a
 * typed `SourceSpec` and refuses anything the grammar does not carry:
 *
 *   - a kind that is not `view` or `query` — `function` is not representable
 *     (C-18) and is refused with `SKW_E_RT_SOURCE_UNKNOWN` rather than ignored;
 *   - a table/view name or a column that the allowlist does not carry;
 *   - a `where` operator outside the six, an `order` direction outside asc|desc;
 *   - more than two `group_by` columns (the aggregate gap is closed by grammar).
 *
 * Values never appear in the SQL: `compile.ts` emits `?` for each and this module
 * only names the parameter. That is what makes §6.2's last row ("values are bound
 * parameters, never interpolated") a property of the shape rather than a review
 * note.
 */
import { AppError } from '../errors.ts';

export type SourceKind = 'view' | 'query';
export type ParamKind = 'enum' | 'int' | 'page' | 'bound' | 'free';
export const PARAM_KINDS: readonly ParamKind[] = ['enum', 'int', 'page', 'bound', 'free'];

export type WhereOp = '=' | '!=' | '<' | '<=' | '>' | '>=';
export const WHERE_OPS: readonly WhereOp[] = ['=', '!=', '<', '<=', '>', '>='];

export interface WhereClause {
  col: string;
  op: WhereOp;
  param: string;
}

export interface OrderClause {
  col: string;
  dir: 'asc' | 'desc';
}

export interface SourceParam {
  name: string;
  kind: ParamKind;
  /** `enum` only: the closed domain. `free` is a search box (refused by export, §6.4). */
  values?: string[];
}

export interface Aggregate {
  fn: 'count' | 'sum' | 'min' | 'max';
  column: string;
}

export interface SourceSpec {
  kind: SourceKind;
  /** `u_*`/`p_*` for `query`; `cms_v_*` for `view`. */
  relation: string;
  columns: string[];
  where: WhereClause[];
  order: OrderClause[];
  limitDefault: number;
  limitMax: number;
  aggregate: Aggregate | null;
  groupBy: string[];
  params: SourceParam[];
}

export const DEFAULT_LIMIT = 10;
export const MAX_LIMIT = 500;
export const MAX_COLUMNS = 40;
export const MAX_GROUP_BY = 2;
/** §6.1: the worst-case per-source budget the publish gate enforces. */
export const COST_MS_MAX = 1.5;

const KEY_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;
const RELATION_RE = /^(u_|p_|cms_v_)[a-z0-9_]+$/;
const COLUMN_RE = /^[a-z][a-z0-9_]{0,39}$/;
const PARAM_RE = /^[a-z][a-z0-9_]{0,39}$/;

/** A malformed source *row*: the table/view it names cannot be used. */
export function sourceUnknown(reason: string, message: string, extra: Record<string, unknown> = {}): AppError {
  return new AppError('SKW_E_RT_SOURCE_UNKNOWN', message, { reason, ...extra });
}

export function unindexed(column: string, message: string, extra: Record<string, unknown> = {}): AppError {
  return new AppError('SKW_E_RT_SOURCE_UNINDEXED', message, { column, ...extra });
}

export function budget(reason: string, message: string, extra: Record<string, unknown> = {}): AppError {
  return new AppError('SKW_E_RT_SOURCE_BUDGET', message, { reason, ...extra });
}

export function assertKey(key: unknown): string {
  if (typeof key !== 'string' || !KEY_RE.test(key)) {
    throw new AppError('SKW_E_PLT_REQUEST_INVALID', 'a source key is 2–40 lowercase letters, digits or hyphens');
  }
  return key;
}

/**
 * The kind gate, before anything else happens. `function` is the one value the
 * schema cannot hold and the one the register killed; the message names C-18 so
 * an operator reading the refusal has the reason, not just the rule.
 */
export function assertKind(kind: unknown): SourceKind {
  if (kind === 'view' || kind === 'query') return kind;
  throw sourceUnknown(
    'kind_not_representable',
    `${String(kind)} data sources are not representable in v1: a function source is arbitrary code in the tenant tree with a cross-tenant read primitive (C-18)`,
    { kind: String(kind), register: 'C-18' },
  );
}

interface RawSpec {
  table?: unknown;
  view?: unknown;
  columns?: unknown;
  where?: unknown;
  order?: unknown;
  limit_default?: unknown;
  limit_max?: unknown;
  aggregate?: unknown;
  group_by?: unknown;
  params?: unknown;
}

function asArray(value: unknown, what: string): unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw sourceUnknown('spec', `${what} must be an array`);
  return value;
}

function asLimit(value: unknown, fallback: number, what: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
    throw sourceUnknown('spec', `${what} must be an integer between 1 and ${MAX_LIMIT}`);
  }
  return value;
}

export function parseParams(raw: unknown): SourceParam[] {
  const out: SourceParam[] = [];
  for (const item of asArray(raw, 'params_json')) {
    const p = item as { name?: unknown; kind?: unknown; values?: unknown };
    if (typeof p.name !== 'string' || !PARAM_RE.test(p.name)) {
      throw sourceUnknown('spec', 'a parameter name must match [a-z][a-z0-9_]*');
    }
    if (!PARAM_KINDS.includes(p.kind as ParamKind)) {
      throw sourceUnknown('spec', `parameter ${p.name} has an unknown kind ${String(p.kind)}`);
    }
    if (out.some((existing) => existing.name === p.name)) {
      throw sourceUnknown('spec', `parameter ${p.name} is declared twice`);
    }
    const values = asArray(p.values, `parameter ${p.name} values`).map((v) => String(v));
    if (p.kind === 'enum' && values.length === 0) {
      throw sourceUnknown('spec', `parameter ${p.name} is an enum with no values`);
    }
    out.push(values.length === 0 ? { name: p.name, kind: p.kind as ParamKind } : { name: p.name, kind: p.kind as ParamKind, values });
  }
  return out;
}

/**
 * `spec_json` + the two columns the schema keeps beside it. The grammar in §6.2
 * carries `aggregate` and `group_by` inside the spec; the table also has
 * `aggregate_json`/`group_by_json`, so a caller may pass either and this is the one
 * place they are reconciled (the spec wins, and publish mirrors both).
 */
export function parseSpec(kind: SourceKind, raw: unknown, paramsRaw: unknown = []): SourceSpec {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw sourceUnknown('spec', 'spec_json must be an object');
  }
  const spec = raw as RawSpec;
  const relation = kind === 'query' ? spec.table : spec.view;
  if (typeof relation !== 'string' || !RELATION_RE.test(relation)) {
    throw sourceUnknown(
      'spec',
      kind === 'query'
        ? 'a query source names a u_* or p_* table'
        : 'a view source names a cms_v_* view',
    );
  }
  if (kind === 'query' && relation.startsWith('cms_v_')) {
    throw sourceUnknown('spec', 'a query source cannot name a view; use kind=view');
  }
  if (kind === 'view' && !relation.startsWith('cms_v_')) {
    throw sourceUnknown('spec', 'a view source must name a cms_v_* view');
  }

  const columns = asArray(spec.columns, 'columns').map((c) => String(c));
  if (columns.length === 0) throw sourceUnknown('spec', 'a source projects at least one column');
  if (columns.length > MAX_COLUMNS) throw sourceUnknown('spec', `a source projects at most ${MAX_COLUMNS} columns`);
  for (const column of columns) {
    if (!COLUMN_RE.test(column)) throw sourceUnknown('spec', `${column} is not a column name`);
  }
  if (new Set(columns).size !== columns.length) throw sourceUnknown('spec', 'a column is projected twice');

  const where: WhereClause[] = asArray(spec.where, 'where').map((item) => {
    const w = item as { col?: unknown; op?: unknown; param?: unknown };
    if (typeof w.col !== 'string' || !COLUMN_RE.test(w.col)) throw sourceUnknown('spec', 'where.col is not a column name');
    if (!WHERE_OPS.includes(w.op as WhereOp)) throw sourceUnknown('spec', `where.op ${String(w.op)} is not one of ${WHERE_OPS.join(' ')}`);
    if (typeof w.param !== 'string' || !PARAM_RE.test(w.param)) throw sourceUnknown('spec', 'where.param is not a parameter name');
    return { col: w.col, op: w.op as WhereOp, param: w.param };
  });

  const order: OrderClause[] = asArray(spec.order, 'order').map((item) => {
    const o = item as { col?: unknown; dir?: unknown };
    if (typeof o.col !== 'string' || !COLUMN_RE.test(o.col)) throw sourceUnknown('spec', 'order.col is not a column name');
    if (o.dir !== 'asc' && o.dir !== 'desc') throw sourceUnknown('spec', 'order.dir is asc or desc');
    return { col: o.col, dir: o.dir };
  });

  const limitMax = asLimit(spec.limit_max, 50, 'limit_max');
  const limitDefault = asLimit(spec.limit_default, Math.min(DEFAULT_LIMIT, limitMax), 'limit_default');
  if (limitDefault > limitMax) throw sourceUnknown('spec', 'limit_default exceeds limit_max');

  let aggregate: Aggregate | null = null;
  if (spec.aggregate !== undefined && spec.aggregate !== null) {
    const a = spec.aggregate as { fn?: unknown; column?: unknown };
    if (!['count', 'sum', 'min', 'max'].includes(String(a.fn))) {
      throw sourceUnknown('spec', 'aggregate.fn is count, sum, min or max');
    }
    if (typeof a.column !== 'string' || !COLUMN_RE.test(a.column)) throw sourceUnknown('spec', 'aggregate.column is not a column name');
    aggregate = { fn: a.fn as Aggregate['fn'], column: a.column };
  }

  const groupBy = asArray(spec.group_by, 'group_by').map((c) => String(c));
  if (groupBy.length > MAX_GROUP_BY) {
    // §6.2's own refusal: the aggregate gap is closed by grammar, and a third
    // grouping column is a query plan nobody budgeted for.
    throw budget('group_by', `group_by carries at most ${MAX_GROUP_BY} columns`);
  }
  if (groupBy.length > 0 && aggregate === null) throw sourceUnknown('spec', 'group_by needs an aggregate');
  for (const column of groupBy) {
    if (!COLUMN_RE.test(column)) throw sourceUnknown('spec', `${column} is not a column name`);
  }

  const params = parseParams(paramsRaw ?? spec.params ?? []);

  // Every `where` parameter must be declared: an undeclared parameter is a value
  // nobody can bind, and a source that cannot be parameterised is a bug at render.
  for (const clause of where) {
    if (!params.some((p) => p.name === clause.param)) {
      throw sourceUnknown('param_unknown', `where.param ${clause.param} is not declared in params_json`, { param: clause.param });
    }
  }

  return { kind, relation, columns, where, order, limitDefault, limitMax, aggregate, groupBy, params };
}

/** The columns a spec names, in the order the refusals should name them. */
export function referencedColumns(spec: SourceSpec): { column: string; role: string }[] {
  const out: { column: string; role: string }[] = [];
  for (const column of spec.columns) out.push({ column, role: 'columns' });
  for (const clause of spec.where) out.push({ column: clause.col, role: 'where' });
  for (const clause of spec.order) out.push({ column: clause.col, role: 'order' });
  for (const column of spec.groupBy) out.push({ column, role: 'group_by' });
  if (spec.aggregate !== null) out.push({ column: spec.aggregate.column, role: 'aggregate' });
  return out;
}
