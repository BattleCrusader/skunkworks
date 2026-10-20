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

import { bindParams, compile } from './compile.ts';
import { SourceCache, cacheKey, sha256 } from './cache.ts';
import { allowlistFor, assertViewChecksum, noteViewChecksumRefusal, readSource, viewAnchor } from './registry.ts';
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
  const allowed = allowlistFor(db, kind, spec.relation);
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

  const rows = db.prepare(compiled.sql).all(...(compiled.bind as never[])) as Record<string, unknown>[];
  const resolved: ResolvedSource = { key, rows, truncated: compiled.truncated, limit: compiled.limit };
  if (cache !== undefined) cache.set(keyOf, resolved, row.ttl_s * 1000);
  return resolved;
}
