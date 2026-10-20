/**
 * §6.2 — the resolver, on the **render-read** connection.
 *
 * Order, each step a contract:
 *
 *   1. the row exists                     → `SKW_E_RT_SOURCE_UNKNOWN` (unknown)
 *   2. `kind ∈ {view, query}`             → `SKW_E_RT_SOURCE_UNKNOWN` (C-18, defence in depth)
 *   3. `published_at IS NOT NULL`         → `SKW_E_RT_SOURCE_UNKNOWN` (not_published)
 *   4. `is_public = 1` for a public render→ `SKW_E_RT_SOURCE_UNKNOWN` (not_public)
 *   5. every named column is in the allowlist — **re-checked at render**, because a
 *      table can be rebuilt between publish and resolve
 *   5a. `kind = 'view'`: `sha256(sqlite_master.sql)` equals `cms_view_registry.checksum`
 *      (E-21, §6.1a) — before 5b, because 5b reads the live view
 *   5b. every named column is in the allowlist (`PRAGMA table_xinfo`, read after 5a)
 *   6. the compiled statement, with bound parameters, on this handle
 *   7. the parameter-set cache, TTL from `ttl_s`
 *
 * The resolver never returns a handle and never returns SQL: `ResolvedSource` is
 * rows and a clamped limit. That is what §6 asks the render path to receive.
 */
import type Database from 'better-sqlite3';

import { AppError } from '../errors.ts';
import { bindParams, compile } from './compile.ts';
import { SourceCache, cacheKey, sha256 } from './cache.ts';
import {
  allowlistFor,
  assertViewChecksum,
  noteSourceSqliteError,
  noteViewChecksumRefusal,
  readSource,
  viewAnchor,
} from './registry.ts';
import { assertKind, parseSpec, sourceUnknown, type SourceSpec } from './spec.ts';

export type ResolveAudience = 'render' | 'preview';

export interface ResolveOptions {
  tenantKey: string;
  params?: Record<string, unknown>;
  /** `render` enforces `is_public`; `preview` is the admin-minted O-29 path. */
  audience?: ResolveAudience;
  cache?: SourceCache;
  nowMs?: number;
}

export interface ResolvedSource {
  key: string;
  rows: Record<string, unknown>[];
  /** True when the requested limit was clamped to `limit_max` (§6.3). */
  truncated: boolean;
  /** The limit actually applied. */
  limit: number;
}

function specOf(row: { spec_json: string; params_json: string }, kind: 'view' | 'query'): SourceSpec {
  return parseSpec(kind, JSON.parse(row.spec_json) as unknown, JSON.parse(row.params_json) as unknown);
}

export function specRevision(row: { published_at: string | null; spec_json: string; params_json: string; aggregate_json: string | null; group_by_json: string | null }): string {
  return `${row.published_at ?? 'draft'}:${sha256(`${row.spec_json}|${row.params_json}|${row.aggregate_json ?? ''}|${row.group_by_json ?? ''}`).slice(0, 16)}`;
}

export function resolveSource(db: Database.Database, key: string, opts: ResolveOptions): ResolvedSource {
  const row = readSource(db, key);
  if (row === undefined) throw sourceUnknown('unknown', `no source named ${JSON.stringify(key)}`, { key });

  const kind = assertKind(row.kind);
  if (row.published_at === null) {
    throw sourceUnknown('not_published', `source ${key} is a draft; publish it before it can render`, { key });
  }
  const audience = opts.audience ?? 'render';
  // §6.2's `is_public` rule. Exclusive witness: test/sources.test.ts S2E-4
  if (audience === 'render' && row.is_public !== 1) {
    throw sourceUnknown('not_public', `source ${key} is not public`, { key });
  }

  const spec = specOf(row, kind);
  // Step 5a before 5b: the allowlist is a live read of whatever the view is NOW, so the body must
  // be proved to be the one that was registered before its columns are trusted (E-21).
  if (kind === 'view') {
    try {
      assertViewChecksum(db, spec.relation);
    } catch (err) {
      const anchor = viewAnchor(db, spec.relation);
      if (anchor !== null && !anchor.ok) noteViewChecksumRefusal(opts.tenantKey, anchor);
      throw err;
    }
  }
  const allowed = allowlistFor(db, kind, spec.relation, { tenantKey: opts.tenantKey });
  const bound = bindParams(spec, opts.params ?? {});
  const request: Record<string, unknown> = { ...bound };
  if (opts.params?.limit !== undefined) request.limit = opts.params.limit;
  const compiled = compile(spec, allowed, request);

  const effective = { ...bound, limit: compiled.limit };
  const cache = opts.cache;
  const keyOf = cache === undefined ? '' : cacheKey(opts.tenantKey, key, specRevision(row), effective);
  if (cache !== undefined) {
    const hit = cache.get<ResolvedSource>(keyOf);
    if (hit !== undefined) return { ...hit, rows: hit.rows };
  }

  // D6's catch-all: the allowlist is read from the live schema and the statement runs on the
  // same handle, but they are two reads of a schema anything with a file handle may change in
  // between. A drift that lands in that window is still a refusal, not a 500.
  let rows: Record<string, unknown>[];
  try {
    rows = db.prepare(compiled.sql).all(...(compiled.bind as never[])) as Record<string, unknown>[];
  } catch (err) {
    const mapped = mapSourceSqliteError(err, { tenantKey: opts.tenantKey, source: key, relation: spec.relation });
    if (mapped !== null) throw mapped;
    throw err;
  }
  const resolved: ResolvedSource = { key, rows, truncated: compiled.truncated, limit: compiled.limit };
  if (cache !== undefined) cache.set(keyOf, resolved, row.ttl_s * 1000);
  return resolved;
}

// --- D6: the resolver's catch-all --------------------------------------------------------

export interface SourceErrorContext {
  tenantKey: string;
  source: string;
  relation: string;
}

/**
 * Map a SQLite failure raised by the resolve statement onto the taxonomy, or return null when
 * the failure is not SQLite's.
 *
 * Why a mapper and not a `try { … } catch { throw internal }`: the allowlist already refuses a
 * column it can see is gone, so the only way to reach here is drift the allowlist could not
 * see. Turning that into `SKW_E_PLT_INTERNAL` would be the D6 defect with a different spelling
 * — a 500 on a public render — and turning it into a *message* would leak the statement.
 *
 * `no such column: "slug"` carries the column name in its text; that name is what the operator
 * needs and what `detail.column` is for. The rest of SQLite's message (`- should this be a
 * string literal in single-quotes?`) is noise and never leaves the process: the response carries
 * `reason` and the column, and the log line carries the SQLite code.
 */
export function mapSourceSqliteError(err: unknown, ctx: SourceErrorContext): AppError | null {
  const e = err as { code?: unknown; message?: unknown };
  const code = typeof e.code === 'string' ? e.code : '';
  if (!code.startsWith('SQLITE_')) return null;
  const message = typeof e.message === 'string' ? e.message : '';

  if (code === 'SQLITE_BUSY' || code === 'SQLITE_BUSY_SNAPSHOT' || code === 'SQLITE_LOCKED') {
    noteSourceSqliteError(ctx.tenantKey, ctx.source, ctx.relation, null, code);
    return new AppError('SKW_E_DM_BUSY', 'the tenant database is busy; retry shortly');
  }
  if (code === 'SQLITE_CORRUPT' || code === 'SQLITE_NOTADB' || code === 'SQLITE_IOERR') {
    noteSourceSqliteError(ctx.tenantKey, ctx.source, ctx.relation, null, code);
    return new AppError('SKW_E_PLT_TENANT_UNAVAILABLE', 'tenant database is not readable', { code });
  }

  const missingColumn = /no such column:\s*"?([^"\s]+)"?/i.exec(message);
  if (missingColumn !== null) {
    const column = missingColumn[1] ?? '';
    noteSourceSqliteError(ctx.tenantKey, ctx.source, ctx.relation, column, code);
    return sourceUnknown(
      'column_drift',
      `column ${JSON.stringify(column)} no longer exists in ${ctx.relation}`,
      { column, relation: ctx.relation },
    );
  }
  if (/no such table/i.test(message)) {
    noteSourceSqliteError(ctx.tenantKey, ctx.source, ctx.relation, null, code);
    return sourceUnknown('table_missing', `${ctx.relation} is no longer in the schema`, { relation: ctx.relation });
  }

  // Any other SQLite refusal: the code is the taxonomy's, the SQLite code is in `detail` and the
  // statement itself never appears in either.
  noteSourceSqliteError(ctx.tenantKey, ctx.source, ctx.relation, null, code);
  return sourceUnknown('sqlite_error', `the source could not be read (${code})`, { relation: ctx.relation, sqlite: code });
}
