/**
 * §6 — what the render path receives. **Resolved rows, never a handle.**
 *
 * The page shell, the `list` component and every future binding get a
 * `RenderData` whose surface is exactly one method:
 *
 *     data.source('posts', { status: 'published', limit: 3 })
 *       -> { key, rows, truncated, limit }
 *
 * There is no `db`, no `prepare`, no `handle` and no SQL on the object. The
 * `render-read` handle is captured in this closure and used by the resolver; a
 * template that wants data it was not given has to ask for a named source, which
 * is the registry's contract (§6.1) rather than a new query.
 *
 * The cache is per process and per tenant key (the key includes the tenant), so a
 * page rendered twice in one TTL pays for one read, and two parameter sets get two
 * entries (O-10).
 */
import type Database from 'better-sqlite3';

import { SourceCache } from '../sources/cache.ts';
import { resolveSource, type ResolvedSource, type ResolveAudience } from '../sources/resolve.ts';

export interface RenderDataOptions {
  tenantKey: string;
  audience?: ResolveAudience;
  cache?: SourceCache;
}

export interface RenderData {
  source(key: string, params?: Record<string, unknown>): ResolvedSource;
}

export function createRenderData(db: Database.Database, opts: RenderDataOptions): RenderData {
  const cache = opts.cache ?? new SourceCache();
  const audience: ResolveAudience = opts.audience ?? 'render';
  return {
    source(key: string, params: Record<string, unknown> = {}): ResolvedSource {
      return resolveSource(db, key, { tenantKey: opts.tenantKey, params, audience, cache });
    },
  };
}
