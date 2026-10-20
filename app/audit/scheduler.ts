/**
 * §9.6 (C-21) / §9.6a (E-20) — the daily seal job, the gap scan, and the operator's summary.
 *
 * `sealNow` and `verifyAgainstSeal` seal and verify **one day's segment**; this module is the
 * clock, the series scan and the record of what happened. It adds no second seal rule.
 *
 *   - **one seal per tenant per UTC day** — `audit_seal`'s primary key is `(tenant_key, day)`,
 *     and a second write is refused `already_sealed`; a re-run therefore reports what is stored
 *     instead of writing (E-20 rule (a));
 *   - **a refused or failed seal is per tenant** — one broken tenant does not stop the others;
 *   - **the tick is at UTC midnight and seals the day that just ended** — a seal written at
 *     00:00:05 UTC on the 21st covers the 20th, and that is what makes `late = 0` true;
 *   - **a missed day is visibly unsealed** — before sealing the day it owns, `sealDay` scans the
 *     series from the tenant's first audit day through the last ended day: a day with rows and no
 *     seal is `UNSEALED`, is printed, and writes one `control.db` `audit_log` row
 *     (`action = 'audit.seal_gap'`). **The tick does not heal its own gap**: a job that silently
 *     repairs makes `late = 1` indistinguishable in the operator's memory from a normal seal;
 *   - **the timer is `unref()`d** — a server that is otherwise done must be able to exit, and a
 *     test that builds the app must not hang on a 24-hour timer.
 *
 * A failure is data, not a thrown loop: `sealDay` returns one result per tenant with `error` set.
 * The caller (the scheduler) logs it; `skwctl audit seal` exits non-zero. That is the difference
 * between "one tenant's chain is broken" and "the seal job did not run".
 */
import Database from 'better-sqlite3';

import { addUtcDays, readSeal, rowsOnDay, sealNow, utcDay, verifyChain, type ChainReport } from './chain.ts';
import { openAdminWrite } from '../db/classes.ts';

export type SealState = 'sealed' | 'UNSEALED' | 'empty';

/** One day of the series, as the operator sees it. */
export interface SealDayStatus {
  day: string;
  state: SealState;
  rows_in_day: number;
  first_id?: number;
  last_id?: number;
  late?: number;
  sealed_at?: string;
}

export interface SealGap {
  day: string;
  rows: number;
  state: 'UNSEALED' | 'empty';
}

export interface SealTenantResult {
  key: string;
  day: string;
  status: 'sealed' | 'already_sealed' | 'empty' | 'error';
  rows_in_day: number;
  first_id: number | null;
  last_id: number | null;
  head: string;
  late: number | null;
  sealed_at: string | null;
  /** True only when this run wrote the row; false for `already_sealed`, `empty` and `error`. */
  created: boolean;
  /** Days between the tenant's first audit day and the last ended day that carry no seal. */
  gaps: SealGap[];
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

/** The last day that has ended at `atMs`: the newest day that can be sealed on time. */
export function lastEndedDay(atMs: number = Date.now()): string {
  return addUtcDays(utcDay(atMs), -1);
}

/**
 * Every day in `[firstAuditDay, throughDay]` that has no seal row, with its row count.
 *
 * The series is bounded by the data: a tenant's first audit day is the earliest `ts` in its own
 * file, and the newest day that can have an answer is the one that just ended. A day with rows and
 * no seal is `UNSEALED`; a day with no rows needs no seal and is `empty`.
 *
 * `fromDay` bounds the walk from below, and it is what makes the health field's cost a constant
 * instead of a function of the tenant's age (§9.6a(d)). The tick and `--heal` pass nothing, so
 * they still see the whole series; the CLI's `--days` window is its own read of the same rule.
 */
export function scanGaps(
  db: Database.Database,
  control: Database.Database,
  tenantKey: string,
  throughDay: string,
  fromDay?: string,
): SealGap[] {
  const first = db.prepare('SELECT min(substr(ts, 1, 10)) AS d FROM cms_audit').get() as { d: string | null };
  if (first.d === null) return [];
  const sealed = new Set(
    (
      control.prepare('SELECT day FROM audit_seal WHERE tenant_key = ? AND day <= ?').all(tenantKey, throughDay) as {
        day: string;
      }[]
    ).map((row) => row.day),
  );
  const gaps: SealGap[] = [];
  // A corrupt `ts` could otherwise make this loop unbounded. The cap is a refusal to hang on bad
  // data, and it is visible: the scan starts at `throughDay - (MAX_SCAN_DAYS - 1)` at the earliest.
  const MAX_SCAN_DAYS = 4000;
  let floor = addUtcDays(throughDay, -(MAX_SCAN_DAYS - 1));
  if (fromDay !== undefined && fromDay > floor) floor = fromDay;
  for (let day = first.d > floor ? first.d : floor; day <= throughDay; day = addUtcDays(day, 1)) {
    if (sealed.has(day)) continue;
    const rows = rowsOnDay(db, day);
    gaps.push({ day, rows, state: rows === 0 ? 'empty' : 'UNSEALED' });
  }
  return gaps;
}

/** One `control.db` row per tenant-day gap, written by the first tick that can see it. */
function recordGap(control: Database.Database, tenantKey: string, gap: SealGap, atMs: number): void {
  const tenant = control.prepare('SELECT id FROM tenant WHERE key = ?').get(tenantKey) as { id: number } | undefined;
  control
    .prepare(
      `INSERT INTO audit_log (tenant_id, actor_user_id, actor_label, action, target_kind, target_id, before_json, after_json, ts)
       VALUES (?, NULL, 'scheduler', 'audit.seal_gap', 'audit_seal', ?, NULL, ?, ?)`,
    )
    .run(
      tenant?.id ?? null,
      `${tenantKey}/${gap.day}`,
      JSON.stringify({ rows_on_day: gap.rows, state: gap.state }),
      new Date(atMs).toISOString(),
    );
}

export function sealDay(opts: SealDayOptions): SealDayReport {
  const atMs = opts.atMs ?? Date.now();
  const day = opts.day ?? lastEndedDay(atMs);
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
      return {
        day,
        tenants: [
          {
            key: opts.tenant,
            day,
            status: 'error',
            rows_in_day: 0,
            first_id: null,
            last_id: null,
            head: '',
            late: null,
            sealed_at: null,
            created: false,
            gaps: [],
            error: { code: 'SKW_E_PLT_TENANT_UNKNOWN', message: `no active tenant ${opts.tenant}` },
          },
        ],
      };
    }
    for (const key of keys) {
      const path = `${opts.dataDir}/tenants/${key}/site.db`;
      let db: Database.Database | undefined;
      let gaps: SealGap[] = [];
      try {
        db = openAdminWrite(path);
        // Rule (c): the series first, so a gap is recorded by the first tick that can see it and
        // is *not* healed by the tick that reports it.
        gaps = scanGaps(db, control, key, addUtcDays(day, -1));
        for (const gap of gaps) if (gap.state === 'UNSEALED') recordGap(control, key, gap, atMs);
        const outcome = sealNow(db, control, key, day, atMs);
        if (outcome.status === 'empty') {
          results.push({
            key,
            day,
            status: 'empty',
            rows_in_day: 0,
            first_id: null,
            last_id: null,
            head: '',
            late: null,
            sealed_at: null,
            created: false,
            gaps,
          });
          continue;
        }
        const seal = outcome.seal;
        results.push({
          key,
          day,
          status: outcome.status,
          rows_in_day: seal.rows_in_day,
          first_id: seal.first_id,
          last_id: seal.last_id,
          head: seal.head,
          late: seal.late,
          sealed_at: seal.sealed_at,
          created: outcome.status === 'sealed',
          gaps,
        });
      } catch (err) {
        const e = err as { code?: string; message?: string };
        results.push({
          key,
          day,
          status: 'error',
          rows_in_day: 0,
          first_id: null,
          last_id: null,
          head: '',
          late: null,
          sealed_at: null,
          created: false,
          gaps,
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
 * The operator's series: the last `days` **ended** days, plus today when today is already sealed.
 *
 * `audit status` exits 0 only when `chain=ok` and no day is `UNSEALED`; that decision is the CLI's,
 * made on this data, so the same read serves the health field.
 */
export interface SealStatusReport {
  tenant: string;
  chain: ChainReport;
  days: SealDayStatus[];
  last_sealed_day: string | null;
  unsealed: string[];
  late_days: number;
}

export function sealStatus(opts: { dataDir: string; tenantKey: string; days?: number; atMs?: number }): SealStatusReport {
  const atMs = opts.atMs ?? Date.now();
  const window = Math.max(1, opts.days ?? 5);
  const control = new Database(`${opts.dataDir}/control.db`);
  const db = openAdminWrite(`${opts.dataDir}/tenants/${opts.tenantKey}/site.db`);
  try {
    const chain = verifyChain(db);
    const lastEnded = lastEndedDay(atMs);
    const days: SealDayStatus[] = [];
    for (let i = window - 1; i >= 0; i -= 1) days.push(dayStatus(db, control, opts.tenantKey, addUtcDays(lastEnded, -i)));
    const today = utcDay(atMs);
    if (readSeal(control, opts.tenantKey, today) !== undefined) days.push(dayStatus(db, control, opts.tenantKey, today));
    const summary = control
      .prepare(
        `SELECT max(day) AS last_day, sum(CASE WHEN late = 1 THEN 1 ELSE 0 END) AS late
           FROM audit_seal WHERE tenant_key = ?`,
      )
      .get(opts.tenantKey) as { last_day: string | null; late: number | null };
    return {
      tenant: opts.tenantKey,
      chain,
      days,
      last_sealed_day: summary.last_day,
      unsealed: days.filter((d) => d.state === 'UNSEALED').map((d) => d.day),
      late_days: Number(summary.late ?? 0),
    };
  } finally {
    db.close();
    control.close();
  }
}

function dayStatus(db: Database.Database, control: Database.Database, tenantKey: string, day: string): SealDayStatus {
  const seal = readSeal(control, tenantKey, day);
  if (seal === undefined) {
    const rows = rowsOnDay(db, day);
    return { day, state: rows === 0 ? 'empty' : 'UNSEALED', rows_in_day: rows };
  }
  return {
    day,
    state: 'sealed',
    rows_in_day: seal.rows_in_day,
    first_id: seal.first_id,
    last_id: seal.last_id,
    late: seal.late,
    sealed_at: seal.sealed_at,
  };
}

/** `"seal": {"last_sealed_day": …, "unsealed": […], "late_days": n}` — §9.5's health field. */
export interface SealSummary {
  last_sealed_day: string | null;
  unsealed: string[];
  late_days: number;
}

/**
 * The health field's lookback, in days — and it is a decision, not a loop bound.
 *
 * `sealSummary` used to call `sealStatus({days: 1})`, so `unsealed` was structurally at most
 * yesterday and E-20(d)'s own example was unreachable (`S2-qa.md` M6). A gap three days back — the
 * ordinary shape of a deploy or a paused VM straddling midnight — read as a green series.
 *
 * **400 days, because that is the widest window the operator's CLI accepts** (`skwctl audit status
 * --days` is `1..400`). The field must not be narrower than the surface next to it, and a second
 * number would be a second answer to "which days exist". The bound itself is required because this
 * field is served from a 30 s cache on an admin route: "since the tenant's first audit row" grows
 * without limit with the age of the box, and a dashboard poll must not get slower every month. A
 * gap older than 400 days is outside every surface the product offers; `--days 400` is the widest
 * read by design, and widening it is a CLI change, not a hidden scan.
 */
export const SEAL_HEALTH_LOOKBACK_DAYS = 400;

/**
 * The health payload: every day that should have been sealed and was not, inside the lookback.
 *
 * The rule for "should have been sealed" is `scanGaps`' — the same one the tick and `--heal` use —
 * so this is one answer to that question, not a second one. What differs is only the window: from
 * `min(a tenant's first audit day, lastEnded - (lookback - 1))` through the last day that ended.
 * Today is deliberately not in it: it has not ended and cannot be sealed (§9.6a step 1).
 */
export function sealSummary(dataDir: string, tenantKey: string, atMs: number = Date.now()): SealSummary {
  const lastEnded = lastEndedDay(atMs);
  const from = addUtcDays(lastEnded, -(SEAL_HEALTH_LOOKBACK_DAYS - 1));
  const control = new Database(`${dataDir}/control.db`);
  const db = openAdminWrite(`${dataDir}/tenants/${tenantKey}/site.db`);
  try {
    const gaps = scanGaps(db, control, tenantKey, lastEnded, from);
    const summary = control
      .prepare(
        `SELECT max(day) AS last_day, sum(CASE WHEN late = 1 THEN 1 ELSE 0 END) AS late
           FROM audit_seal WHERE tenant_key = ?`,
      )
      .get(tenantKey) as { last_day: string | null; late: number | null };
    return {
      last_sealed_day: summary.last_day,
      unsealed: gaps.filter((gap) => gap.state === 'UNSEALED').map((gap) => gap.day),
      late_days: Number(summary.late ?? 0),
    };
  } finally {
    db.close();
    control.close();
  }
}

export interface HealDay {
  day: string;
  late: number;
  rows_in_day: number;
  sealed_at: string;
}

export interface HealTenantResult {
  key: string;
  healed: HealDay[];
  error?: { code: string; message: string };
}

export interface HealReport {
  throughDay: string;
  tenants: HealTenantResult[];
}

/**
 * `skwctl audit seal --heal`: seal every **unsealed** day from `fromDay` through the last ended
 * day, one seal and one `audit_log` row (`action = 'audit.seal_backfill'`) per day.
 *
 * This is the only path that backfills, and it is the operator's — the tick deliberately does not
 * (rule (c)). A backfilled seal is a correct seal of a **late** day: `sealNow` computes that day's
 * own segment and its real `sealed_at`, so it is never a snapshot of today wearing yesterday's date.
 */
export function healGaps(opts: { dataDir: string; tenant?: string; fromDay?: string; atMs?: number }): HealReport {
  const atMs = opts.atMs ?? Date.now();
  const throughDay = lastEndedDay(atMs);
  const control = new Database(`${opts.dataDir}/control.db`);
  const tenants: HealTenantResult[] = [];
  try {
    const keys = (control.prepare("SELECT key FROM tenant WHERE status = 'active' ORDER BY key").all() as { key: string }[])
      .map((row) => row.key)
      .filter((key) => opts.tenant === undefined || key === opts.tenant);
    for (const key of keys) {
      let db: Database.Database | undefined;
      try {
        db = openAdminWrite(`${opts.dataDir}/tenants/${key}/site.db`);
        const gaps = scanGaps(db, control, key, throughDay).filter(
          (gap) => gap.state === 'UNSEALED' && (opts.fromDay === undefined || gap.day >= opts.fromDay),
        );
        const healed: HealDay[] = [];
        for (const gap of gaps) {
          const outcome = sealNow(db, control, key, gap.day, atMs);
          if (outcome.status !== 'sealed') continue;
          const seal = outcome.seal;
          const tenant = control.prepare('SELECT id FROM tenant WHERE key = ?').get(key) as { id: number } | undefined;
          control
            .prepare(
              `INSERT INTO audit_log (tenant_id, actor_user_id, actor_label, action, target_kind, target_id, before_json, after_json, ts)
               VALUES (?, NULL, 'operator', 'audit.seal_backfill', 'audit_seal', ?, NULL, ?, ?)`,
            )
            .run(
              tenant?.id ?? null,
              `${key}/${gap.day}`,
              JSON.stringify({ late: seal.late, first_id: seal.first_id, last_id: seal.last_id, rows_in_day: seal.rows_in_day }),
              seal.sealed_at,
            );
          healed.push({ day: gap.day, late: seal.late, rows_in_day: seal.rows_in_day, sealed_at: seal.sealed_at });
        }
        tenants.push({ key, healed });
      } catch (err) {
        const e = err as { code?: string; message?: string };
        tenants.push({ key, healed: [], error: { code: e.code ?? 'SKW_E_SEC_AUDIT_SEAL', message: e.message ?? String(err) } });
      } finally {
        db?.close();
      }
    }
  } finally {
    control.close();
  }
  return { throughDay, tenants };
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
      // The tick at midnight seals the day that just ended, and so does an explicit `runOnce`
      // (used by tests and by `skwctl audit seal`): a day that has not ended has no segment.
      const at = now();
      const report = sealDay({ dataDir: opts.dataDir, day: lastEndedDay(at), atMs: at });
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
      // The tick fires at 00:00 on D+1 and seals D (`utcDay(tick - 1000)`), which is what makes
      // `late = 0` true for the day it covers.
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
