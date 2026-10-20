/**
 * §9.6 (C-21) — the daily seal job.
 *
 * `sealNow` and `verifyAgainstSeal` existed in S2d and were gated; nothing called
 * them on a clock. This module is the clock, and it adds no second seal rule: it
 * opens each tenant's file, calls `sealNow`, and records what happened.
 *
 *   - **one seal per tenant per UTC day** — `audit_seal`'s primary key is
 *     `(tenant_key, day)`, and `writeSeal` is idempotent for the same head;
 *   - **a different head for an already-sealed day is refused** — per tenant, so
 *     one tampered tenant does not stop the others from being sealed;
 *   - **the tick is at UTC midnight and seals the day that just ended** — a seal
 *     written at 00:00:05 UTC on the 21st covers the 20th;
 *   - **the timer is `unref()`d** — a server that is otherwise done must be able to
 *     exit, and a test that builds the app must not hang on a 24-hour timer.
 *
 * A failure is data, not a thrown loop: `sealDay` returns one result per tenant
 * with `error` set. The caller (the scheduler) logs it; `skwctl audit seal` exits
 * non-zero. That is the difference between "one tenant's chain is broken" and "the
 * seal job did not run".
 */
import Database from 'better-sqlite3';

import { sealNow, utcDay } from './chain.ts';
import { openAdminWrite } from '../db/classes.ts';

export interface SealTenantResult {
  key: string;
  rows: number;
  head: string;
  /** False when the row already existed with the same head (a re-run). */
  created: boolean;
  error?: { code: string; message: string };
}

export interface SealDayReport {
  day: string;
  tenants: SealTenantResult[];
}

export interface SealDayOptions {
  dataDir: string;
  day?: string;
  atMs?: number;
  /** Restrict to one tenant (the operator command). */
  tenant?: string;
}

export function sealDay(opts: SealDayOptions): SealDayReport {
  const day = opts.day ?? utcDay(opts.atMs ?? Date.now());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`a seal day is YYYY-MM-DD, got ${JSON.stringify(day)}`);
  const controlPath = `${opts.dataDir}/control.db`;
  const control = new Database(controlPath);
  const results: SealTenantResult[] = [];
  try {
    const keys = (
      control
        .prepare("SELECT key FROM tenant WHERE status = 'active' ORDER BY key")
        .all() as { key: string }[]
    )
      .map((row) => row.key)
      .filter((key) => opts.tenant === undefined || key === opts.tenant);
    if (opts.tenant !== undefined && keys.length === 0) {
      return { day, tenants: [{ key: opts.tenant, rows: 0, head: '', created: false, error: { code: 'SKW_E_PLT_TENANT_UNKNOWN', message: `no active tenant ${opts.tenant}` } }] };
    }
    for (const key of keys) {
      const path = `${opts.dataDir}/tenants/${key}/site.db`;
      let db: Database.Database | undefined;
      try {
        db = openAdminWrite(path);
        const existing = control.prepare('SELECT rows, head FROM audit_seal WHERE tenant_key = ? AND day = ?').get(key, day) as
          | { rows: number; head: string }
          | undefined;
        const seal = sealNow(db, control, key, day, opts.atMs ?? Date.now());
        results.push({
          key,
          rows: seal.rows,
          head: seal.head,
          created: existing === undefined,
        });
      } catch (err) {
        const e = err as { code?: string; message?: string };
        results.push({
          key,
          rows: 0,
          head: '',
          created: false,
          error: {
            code: e.code ?? 'SKW_E_SEC_AUDIT_SEAL',
            message: e.message ?? String(err),
          },
        });
      } finally {
        db?.close();
      }
    }
  } finally {
    control.close();
  }
  return { day, tenants: results };
}

/**
 * Milliseconds until the next UTC midnight strictly after `nowMs`.
 *
 * At exactly midnight the next one is 24 h away: a job that runs at 00:00:00.000
 * must not compute a zero delay and spin.
 */
export function msUntilNextUtcMidnight(nowMs: number): number {
  const sinceMidnight = ((nowMs % 86_400_000) + 86_400_000) % 86_400_000;
  const delta = 86_400_000 - sinceMidnight;
  return delta === 0 ? 86_400_000 : delta;
}

export interface SealSchedulerHandle {
  readonly nextRunAt: number;
  readonly stopped: boolean;
  stop(): void;
  runOnce(): SealDayReport;
}

export interface SealSchedulerOptions {
  dataDir: string;
  /** Injected clock, so the schedule can be asserted without waiting a day. */
  now?: () => number;
  /** Run once at start (the operator command and tests use this). */
  runImmediately?: boolean;
  onRun?: (report: SealDayReport) => void;
}

export function startSealScheduler(opts: SealSchedulerOptions): SealSchedulerHandle {
  const now = opts.now ?? (() => Date.now());
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let nextRunAt = 0;

  const handle: SealSchedulerHandle = {
    get nextRunAt() {
      return nextRunAt;
    },
    get stopped() {
      return stopped;
    },
    stop() {
      stopped = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
    runOnce() {
      // The tick at midnight seals the day that just ended; an explicit `runOnce`
      // (used by tests and by `skwctl audit seal`) seals the current UTC day.
      const at = now();
      const report = sealDay({ dataDir: opts.dataDir, day: utcDay(at), atMs: at });
      opts.onRun?.(report);
      return report;
    },
  };

  const schedule = (): void => {
    if (stopped) return;
    const at = now();
    const delay = msUntilNextUtcMidnight(at);
    nextRunAt = at + delay;
    timer = setTimeout(() => {
      if (stopped) return;
      const tick = now();
      const report = sealDay({ dataDir: opts.dataDir, day: utcDay(tick - 1_000), atMs: tick });
      opts.onRun?.(report);
      schedule();
    }, delay);
    timer.unref();
  };

  if (opts.runImmediately === true) handle.runOnce();
  schedule();
  return handle;
}
