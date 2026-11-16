/**
 * The analytics read model — every number the dashboard shows, in one pass over the `analytics`
 * package's event table.
 *
 * This file is core, and the table it reads belongs to a plugin. That is the honest split the
 * platform's own architecture forces: a package may own data and may draw no markup (§10.5), and
 * a declarative screen is a list over one table (`app/plugins/registry.ts`). A dashboard is
 * neither — it is nine aggregates, a time series and a retention grid. So the package writes the
 * rows and this file reads them, and the two are coupled by the column names below and by the
 * `ANALYTICS_TABLE` constant, in one place each.
 *
 * Everything is `pageview`-shaped unless a query says otherwise, and every aggregate is
 * **counted from the events themselves**, never from a rollup the writer maintains. A rollup is
 * a second source of truth that drifts the first time a write fails; a `COUNT(DISTINCT …)` over
 * an indexed day column is fast enough for the traffic a site on this box sees, and it cannot be
 * wrong.
 *
 * `day` is the server's UTC day, stamped at collection time — never the visitor's clock. A
 * visitor whose laptop date is 2019 would otherwise write rows into a cohort that never existed.
 */
import type Database from 'better-sqlite3';

/** The one table this file reads. `plugins/analytics/plugin.json` declares it. */
export const ANALYTICS_TABLE = 'p_analytics_event';

/** The ranges the screen offers. Anything else is 30. */
export const ANALYTICS_RANGES = [7, 30, 90] as const;
export type AnalyticsRange = (typeof ANALYTICS_RANGES)[number];

export function parseRange(raw: string | null): AnalyticsRange {
  const n = Number(raw);
  return (ANALYTICS_RANGES as readonly number[]).includes(n) ? (n as AnalyticsRange) : 30;
}

export interface AnalyticsTotals {
  pageviews: number;
  visitors: number;
  sessions: number;
  clicks: number;
  /** Mean `dwell_ms` of an engage event, in seconds. `null` when nothing reported one. */
  secondsPerPage: number | null;
  /** Sessions that saw exactly one page. `null` when there were no sessions. */
  bounceRate: number | null;
  pagesPerSession: number | null;
}

export interface SeriesPoint {
  day: string;
  pageviews: number;
  visitors: number;
}

export interface TopPage {
  path: string;
  pageviews: number;
  visitors: number;
}

export interface SourceRow {
  source: string;
  medium: string | null;
  pageviews: number;
}

export interface ClickRow {
  target: string | null;
  targetUrl: string | null;
  targetKind: string | null;
  clicks: number;
  visitors: number;
}

export interface DeviceRow {
  device: string;
  visitors: number;
  pageviews: number;
}

export interface BrowserRow {
  browser: string;
  visitors: number;
}

export interface DayCohort {
  day: string;
  newVisitors: number;
  returningVisitors: number;
}

export interface RetentionPoint {
  /** Days after the visitor's first day: 1…7. */
  offset: number;
  /** Visitors who came back on that exact day, over the cohort that could. */
  rate: number;
  visitors: number;
  cohort: number;
}

export interface RecentEvent {
  ts: string;
  kind: string;
  path: string;
  target: string | null;
  device: string | null;
}

export interface AnalyticsReport {
  /** False when the package is not installed for this tenant: the tables do not exist. */
  installed: boolean;
  days: number;
  from: string;
  /** The last day in the window, which is today (UTC). */
  to: string;
  totals: AnalyticsTotals;
  series: SeriesPoint[];
  topPages: TopPage[];
  sources: SourceRow[];
  clicks: ClickRow[];
  devices: DeviceRow[];
  browsers: BrowserRow[];
  newReturning: DayCohort[];
  retention: RetentionPoint[];
  recent: RecentEvent[];
}

const EMPTY_TOTALS: AnalyticsTotals = {
  pageviews: 0,
  visitors: 0,
  sessions: 0,
  clicks: 0,
  secondsPerPage: null,
  bounceRate: null,
  pagesPerSession: null,
};

/** `YYYY-MM-DD`, UTC, `back` days before `nowMs` (inclusive of today). */
export function utcDay(nowMs: number, back = 0): string {
  return new Date(nowMs - back * 86_400_000).toISOString().slice(0, 10);
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * The whole dashboard, in one call.
 *
 * Each block is its own prepared statement and its own `try/catch`: a tenant whose table was
 * dropped mid-flight (an uninstall between the install check and the read) gets an empty block
 * rather than a 500 on the operator's screen. `installed` is decided first and short-circuits the
 * rest, because on a site that has never installed the package every query would fail the same
 * way nine times.
 */
export function readAnalytics(db: Database.Database, opts: { days: AnalyticsRange; nowMs: number }): AnalyticsReport {
  const from = utcDay(opts.nowMs, opts.days - 1);
  const to = utcDay(opts.nowMs);
  const empty: AnalyticsReport = {
    installed: false,
    days: opts.days,
    from,
    to,
    totals: { ...EMPTY_TOTALS },
    series: [],
    topPages: [],
    sources: [],
    clicks: [],
    devices: [],
    browsers: [],
    newReturning: [],
    retention: [],
    recent: [],
  };

  const table = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(ANALYTICS_TABLE);
  if (table === undefined) return empty;

  const t = ANALYTICS_TABLE;
  const rows = (sql: string, ...args: unknown[]): Record<string, unknown>[] => {
    try {
      return db.prepare(sql).all(...args) as Record<string, unknown>[];
    } catch {
      return [];
    }
  };
  const one = (sql: string, ...args: unknown[]): Record<string, unknown> | undefined => {
    try {
      return db.prepare(sql).get(...args) as Record<string, unknown> | undefined;
    } catch {
      return undefined;
    }
  };

  // 1. The day series, and the totals as the sum of it — one query, so the headline number and
  //    the chart cannot disagree.
  const series = rows(
    `SELECT day,
            SUM(kind = 'pageview') AS pv,
            COUNT(DISTINCT CASE WHEN kind = 'pageview' THEN visitor END) AS uv,
            COUNT(DISTINCT CASE WHEN kind = 'pageview' THEN session END) AS sess,
            SUM(kind = 'click') AS clicks
       FROM "${t}" WHERE day >= ? AND day <= ? GROUP BY day ORDER BY day`,
    from,
    to,
  ).map((r) => ({ day: String(r.day), pageviews: num(r.pv), visitors: num(r.uv), sessions: num(r.sess), clicks: num(r.clicks) }));

  const pageviews = series.reduce((sum, p) => sum + p.pageviews, 0);
  const clicks = series.reduce((sum, p) => sum + p.clicks, 0);
  // Distinct across the window, not the sum of daily distincts: a visitor who came back on three
  // days is one visitor. The daily numbers are the chart's; this is the KPI's.
  const distinct = one(
    `SELECT COUNT(DISTINCT CASE WHEN kind = 'pageview' THEN visitor END) AS uv,
            COUNT(DISTINCT CASE WHEN kind = 'pageview' THEN session END) AS sess,
            AVG(CASE WHEN kind = 'engage' THEN dwell_ms END) AS dwell
       FROM "${t}" WHERE day >= ? AND day <= ?`,
    from,
    to,
  );
  const visitors = num(distinct?.uv);
  const sessions = num(distinct?.sess);
  const dwell = numOrNull(distinct?.dwell);

  // 2. Bounce: sessions whose pageview count is exactly one. A session that crosses midnight is
  //    counted once per side of the window; the rate is a property of the window, which is what
  //    the operator is looking at.
  const bounceRow = one(
    `SELECT COUNT(*) AS n FROM (SELECT session, COUNT(*) AS c FROM "${t}"
        WHERE kind = 'pageview' AND day >= ? AND day <= ? GROUP BY session) WHERE c = 1`,
    from,
    to,
  );

  const totals: AnalyticsTotals = {
    pageviews,
    visitors,
    sessions,
    clicks,
    secondsPerPage: dwell === null ? null : Math.round(dwell / 100) / 10,
    bounceRate: sessions === 0 ? null : num(bounceRow?.n) / sessions,
    pagesPerSession: sessions === 0 ? null : Math.round((pageviews / sessions) * 100) / 100,
  };

  const topPages = rows(
    `SELECT path, COUNT(*) AS pv, COUNT(DISTINCT visitor) AS uv FROM "${t}"
      WHERE kind = 'pageview' AND day >= ? AND day <= ? GROUP BY path ORDER BY pv DESC, path ASC LIMIT 12`,
    from,
    to,
  ).map((r) => ({ path: String(r.path), pageviews: num(r.pv), visitors: num(r.uv) }));

  const sources = rows(
    `SELECT source, medium, COUNT(*) AS n FROM "${t}"
      WHERE kind = 'pageview' AND day >= ? AND day <= ? AND (source IS NULL OR source <> '(internal)')
      GROUP BY source, medium ORDER BY n DESC LIMIT 12`,
    from,
    to,
  ).map((r) => ({ source: String(r.source ?? '(direct)'), medium: r.medium === null ? null : String(r.medium), pageviews: num(r.n) }));

  const clickRows = rows(
    `SELECT target, target_url, target_kind, COUNT(*) AS n, COUNT(DISTINCT visitor) AS uv FROM "${t}"
      WHERE kind = 'click' AND day >= ? AND day <= ? GROUP BY COALESCE(target_url, target, '(unknown)')
      ORDER BY n DESC LIMIT 15`,
    from,
    to,
  ).map((r) => ({
    target: r.target === null ? null : String(r.target),
    targetUrl: r.target_url === null ? null : String(r.target_url),
    targetKind: r.target_kind === null ? null : String(r.target_kind),
    clicks: num(r.n),
    visitors: num(r.uv),
  }));

  const devices = rows(
    // NULLIF, because a row written before the package stopped coercing an absent field to '' has
    // an empty string there, and COALESCE alone would print a device row with no name.
    `SELECT COALESCE(NULLIF(device, ''), 'unknown') AS device, COUNT(DISTINCT visitor) AS uv, COUNT(*) AS pv FROM "${t}"
      WHERE kind = 'pageview' AND day >= ? AND day <= ? GROUP BY 1 ORDER BY uv DESC`,
    from,
    to,
  ).map((r) => ({ device: String(r.device), visitors: num(r.uv), pageviews: num(r.pv) }));

  const browsers = rows(
    `SELECT COALESCE(NULLIF(browser, ''), 'unknown') AS browser, COUNT(DISTINCT visitor) AS uv FROM "${t}"
      WHERE kind = 'pageview' AND day >= ? AND day <= ? GROUP BY 1 ORDER BY uv DESC LIMIT 6`,
    from,
    to,
  ).map((r) => ({ browser: String(r.browser), visitors: num(r.uv) }));

  // 3. New vs returning, per day. "First day" is over all time, not over the window, or every
  //    visitor in the window would be new on the window's first day.
  const newReturning = rows(
    `SELECT e.day AS day,
            COUNT(DISTINCT CASE WHEN f.first_day = e.day THEN e.visitor END) AS nv,
            COUNT(DISTINCT CASE WHEN f.first_day < e.day THEN e.visitor END) AS rv
       FROM "${t}" e
       JOIN (SELECT visitor, MIN(day) AS first_day FROM "${t}" WHERE kind = 'pageview' GROUP BY visitor) f
         ON f.visitor = e.visitor
      WHERE e.kind = 'pageview' AND e.day >= ? AND e.day <= ?
      GROUP BY e.day ORDER BY e.day`,
    from,
    to,
  ).map((r) => ({ day: String(r.day), newVisitors: num(r.nv), returningVisitors: num(r.rv) }));

  // 4. The day-N curve: of the visitors whose first visit fell inside the window, how many came
  //    back exactly N days later. `cohort` is everyone who could have returned — a visitor whose
  //    first day is today cannot be counted against day 1.
  const retention: RetentionPoint[] = [];
  const cohortRows = rows(
    `SELECT visitor, MIN(day) AS first_day FROM "${t}" WHERE kind = 'pageview' AND day >= ? AND day <= ? GROUP BY visitor`,
    from,
    to,
  );
  const firstDay = new Map<string, string>();
  for (const row of cohortRows) firstDay.set(String(row.visitor), String(row.first_day));
  if (firstDay.size > 0) {
    const seen = new Set<string>();
    // One count per (visitor, day-N): a visitor who read two pages on their second day came back
    // **once**. A `Set` of visitors was the first shape here and it counted the set, not the
    // people, so every day-N rate read "1 visitor" no matter how many returned.
    const returned = new Map<number, number>();
    for (const row of rows(
      `SELECT visitor, day FROM "${t}" WHERE kind = 'pageview' AND day >= ? AND day <= ? GROUP BY visitor, day`,
      from,
      to,
    )) {
      const visitor = String(row.visitor);
      const day = String(row.day);
      const first = firstDay.get(visitor);
      if (first === undefined) continue;
      const offset = Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / 86_400_000);
      if (offset < 1 || offset > 7) continue;
      const key = `${visitor}\u0000${String(offset)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      returned.set(offset, (returned.get(offset) ?? 0) + 1);
    }
    for (let offset = 1; offset <= 7; offset += 1) {
      // The eligible cohort: first day <= today - offset.
      const cutoff = utcDay(opts.nowMs, offset);
      let eligible = 0;
      for (const day of firstDay.values()) if (day <= cutoff) eligible += 1;
      const back = returned.get(offset) ?? 0;
      retention.push({ offset, visitors: back, cohort: eligible, rate: eligible === 0 ? 0 : back / eligible });
    }
  }

  const recent = rows(
    `SELECT ts, kind, path, target, device FROM "${t}" ORDER BY id DESC LIMIT 12`,
  ).map((r) => ({
    ts: String(r.ts),
    kind: String(r.kind),
    path: String(r.path),
    target: r.target === null ? null : String(r.target),
    device: r.device === null ? null : String(r.device),
  }));

  return {
    installed: true,
    days: opts.days,
    from,
    to,
    totals,
    series: series.map((p) => ({ day: p.day, pageviews: p.pageviews, visitors: p.visitors })),
    topPages,
    sources,
    clicks: clickRows,
    devices,
    browsers,
    newReturning,
    retention,
    recent,
  };
}
