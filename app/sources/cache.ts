/**
 * §6.2's result cache — **keyed per parameter set**, which is the whole point.
 *
 *     key = (tenantKey, sourceKey, specRev, sha256(canonicalParams))
 *
 * A cache keyed per source serves `{limit:3}` rows to a `{limit:50}` request; that
 * is O-10, and `sources.test.ts` renders two sets in both orders inside one TTL
 * and asserts the row counts differ. `specRev` moves when the source is
 * republished, so a stale entry cannot outlive a publish that changed the spec.
 *
 * **Single-flight is structural here.** Resolution is synchronous
 * (`better-sqlite3` never yields), so two resolutions of one key cannot observe a
 * miss at the same time inside this process — there is no `await` between the
 * lookup and the fill. Across processes each has its own cache; the rows are
 * reads and the TTL is the only consistency claim.
 */
import { createHash } from 'node:crypto';

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** JSON with sorted keys: two parameter maps that mean the same thing hash the same. */
export function canonicalParams(params: Record<string, unknown>): string {
  const keys = Object.keys(params).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${JSON.stringify(params[k])}`).join(',')}}`;
}

export function cacheKey(tenantKey: string, sourceKey: string, specRev: string, params: Record<string, unknown>): string {
  return `${tenantKey}\u0000${sourceKey}\u0000${specRev}\u0000${sha256(canonicalParams(params))}`;
}

interface Entry {
  value: unknown;
  expiresAt: number;
}

export interface SourceCacheOptions {
  /** Injected so a gate can advance time without sleeping. */
  now?: () => number;
  /** Bound on entries; expired entries are dropped first. */
  max?: number;
}

export class SourceCache {
  readonly #now: () => number;
  readonly #max: number;
  readonly #entries = new Map<string, Entry>();
  #hits = 0;
  #misses = 0;

  constructor(opts: SourceCacheOptions = {}) {
    this.#now = opts.now ?? (() => Date.now());
    this.#max = opts.max ?? 512;
  }

  get size(): number {
    return this.#entries.size;
  }

  stats(): { size: number; hits: number; misses: number } {
    return { size: this.#entries.size, hits: this.#hits, misses: this.#misses };
  }

  get<T>(key: string): T | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined) {
      this.#misses += 1;
      return undefined;
    }
    if (this.#now() >= entry.expiresAt) {
      this.#entries.delete(key);
      this.#misses += 1;
      return undefined;
    }
    this.#hits += 1;
    return entry.value as T;
  }

  set<T>(key: string, value: T, ttlMs: number): void {
    if (ttlMs <= 0) return;
    this.#entries.delete(key);
    this.#entries.set(key, { value, expiresAt: this.#now() + ttlMs });
    this.#evict();
  }

  clear(): void {
    this.#entries.clear();
  }

  #evict(): void {
    if (this.#entries.size <= this.#max) return;
    const now = this.#now();
    for (const [key, entry] of this.#entries) {
      if (entry.expiresAt <= now) this.#entries.delete(key);
    }
    while (this.#entries.size > this.#max) {
      const oldest = this.#entries.keys().next();
      if (oldest.done === true) return;
      this.#entries.delete(oldest.value);
    }
  }
}
