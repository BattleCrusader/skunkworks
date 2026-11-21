/**
 * v12 — **the clock a package cannot own**: the tick that invokes declared plugin jobs.
 *
 * ## Why this file exists
 *
 * A package cannot schedule itself. Its context is built per request, frozen, and `close()`d on
 * response end (`SKW_E_PL_CONTEXT_ENDED` on any later call), and §13.3.4's hook list excludes
 * `cron`/`worker` on purpose, because an in-process timer in a package would be a second,
 * unobservable scheduler inside a process whose whole scheduling story is these three timers. So
 * the things an operator asks a package for that are *not* answers to a request — a digest, a
 * reminder, a nightly sweep — need the one facility only the host has.
 *
 * ## The split, and why it is drawn here
 *
 *   - **The host owns the tick.** One interval, one place to stop it, one place that logs what ran.
 *     It does not know what a job means, what time the operator chose, or what a message says.
 *   - **The package decides whether it is due.** The schedule is one of the package's own settings
 *     (`plugin.json.settings`, per tenant), the cursor is another, and the copy is the package's.
 *     The handler reads them, decides, and returns. A tick that is not due costs one settings read
 *     and writes nothing — which is why a 60 s tick is honest even for a daily digest.
 *
 * The alternative — teaching the host "digest" — would put one package's copy and one package's
 * cursor inside the platform, and the next package would need the same surgery.
 *
 * ## The four properties this file is written for
 *
 *  - **Isolated per tenant and per job.** A job that throws, or hangs, is one entry in the report;
 *     the next job still runs and the next tenant still runs. This is the drain's rule
 *     (`app/mail/outbox.ts`) applied to jobs.
 *  - **Never two at once.** A key (`tenant\0plugin\0job`) is held while its handler is awaited, so
 *     a slow job cannot stack up behind a 60 s tick. A hung handler that outlives `JOB_TIMEOUT_MS`
 *     is reported and its key is released; the handler itself cannot be cancelled (it is awaited
 *     in-process), so the bound is on the *tick*, not on arbitrary package code.
 *  - **Reads the declaration, not the truth.** The list of jobs comes from
 *     `cms_plugin_installed.manifest_json` — the manifest this tenant actually installed — and a
 *     declared-but-unregistered job is reported as such rather than silently skipped, because
 *     that is a package whose activation half-failed.
 *  - **Stoppable and unref'd.** A test that builds the app must not hang on a 60 s timer, and
 *     `close()` must be able to end it, exactly as the seal scheduler does.
 *
 * ## What this file deliberately does not do
 *
 * It does not run a job at boot. The first tick is one `tickMs` after `start()`, so a boot does not
 * fan out package work across every tenant at once, and a test drives `runOnce()` itself. It also
 * does not retry: the package's own state decides what happens next tick, and a retry policy here
 * would fight it.
 */
import type Database from 'better-sqlite3';

import type { PluginRuntime } from './runtime.ts';

/**
 * The tenant's clock, from `cms_settings`. `''` when nothing is stored or the stored value is not a
 * zone `Intl` accepts — the caller sends `''` and the package says "no zone" rather than inventing
 * UTC and silently shifting every schedule by hours.
 */
function siteTimezoneOf(db: Database.Database): string {
  try {
    const row = db.prepare(`SELECT value_json FROM cms_settings WHERE key = 'timezone'`).get() as
      | { value_json: string }
      | undefined;
    if (row === undefined) return '';
    const parsed: unknown = JSON.parse(row.value_json);
    if (typeof parsed !== 'string' || parsed === '') return '';
    new Intl.DateTimeFormat('en-AU', { timeZone: parsed });
    return parsed;
  } catch {
    return '';
  }
}

/** One minute. A daily digest does not need better, and a minute is cheap: one settings read. */
export const JOB_TICK_MS = 60_000;

/**
 * How long the tick waits on one handler before it stops waiting for it. Five seconds: the same
 * bound `DRAIN_TIMEOUT_MS` uses for a request, because a job is doing the same kind of work —
 * reading a tenant's file and writing to its queue.
 */
export const JOB_TIMEOUT_MS = 5_000;

export type JobStatus = 'ran' | 'error' | 'timeout' | 'not-registered' | 'busy';

export interface JobOutcome {
  tenant: string;
  plugin: string;
  job: string;
  status: JobStatus;
  ms: number;
  /** What the handler returned — the package's own report (`{sent:true, count:3}`). */
  result?: unknown;
  error?: { code: string; message: string };
}

export interface JobTickReport {
  atMs: number;
  jobs: JobOutcome[];
}

export interface PluginJobRunnerOptions {
  runtime: PluginRuntime;
  /** The tenants to tick. Injected so a test can tick one and the app can pass `tenants.all()`. */
  tenants: () => readonly string[];
  /** The tenant's `site.db`, opened by the caller — one handle per tenant per tick, closed again. */
  open: (tenant: string) => Database.Database;
  now?: (() => number) | undefined;
  log?: ((line: string) => void) | undefined;
  timeoutMs?: number | undefined;
  tickMs?: number | undefined;
}

interface InstalledRow {
  plugin_id: string;
  manifest_json: string;
}

/** A host error's code and message, without a stack, so a log line stays one line. */
function reason(err: unknown): { code: string; message: string } {
  if (err === null || typeof err !== 'object') return { code: 'SKW_E_PL_JOB', message: String(err) };
  const e = err as { code?: unknown; message?: unknown };
  const code = typeof e.code === 'string' ? e.code : 'SKW_E_PL_JOB';
  const message = typeof e.message === 'string' ? e.message : String(err);
  return { code, message };
}

export class PluginJobRunner {
  readonly #options: PluginJobRunnerOptions;
  readonly #now: () => number;
  readonly #inFlight = new Set<string>();
  #timer: NodeJS.Timeout | undefined;
  #stopped = false;
  #report: JobTickReport = { atMs: 0, jobs: [] };

  constructor(options: PluginJobRunnerOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  /** The last tick's report. Kept for a health field and for a test that asserts after the fact. */
  get lastReport(): JobTickReport {
    return this.#report;
  }

  get stopped(): boolean {
    return this.#stopped;
  }

  /**
   * One pass over every tenant. Each (tenant, plugin, job) is its own try/catch and its own
   * timeout, so the report is a full account of the tick rather than the first thing that broke.
   */
  async runOnce(): Promise<JobTickReport> {
    const atMs = this.#now();
    const jobs: JobOutcome[] = [];

    for (const tenant of this.#options.tenants()) {
      let db: Database.Database | undefined;
      let installed: InstalledRow[] = [];
      try {
        db = this.#options.open(tenant);
        // The declaration this tenant actually installed — not the file on disk, which may since
        // have been replaced. A job list read from anywhere else could name a handler the running
        // code never registered.
        installed = db
          .prepare('SELECT plugin_id, manifest_json FROM cms_plugin_installed WHERE enabled = 1 ORDER BY plugin_id')
          .all() as InstalledRow[];
      } catch (err) {
        // A tenant whose file cannot be opened is skipped, not fatal: the next tick tries again.
        const r = reason(err);
        this.#options.log?.(`plugin job tick: ${tenant} skipped (${r.code}: ${r.message})`);
        continue;
      }

      try {
        for (const row of installed) {
          let declared: { name?: unknown }[] = [];
          try {
            const manifest = JSON.parse(row.manifest_json) as { jobs?: unknown };
            declared = Array.isArray(manifest.jobs) ? (manifest.jobs as { name?: unknown }[]) : [];
          } catch {
            // An unparseable row is the install path's problem and already visible there; a tick
            // must not throw over it.
            continue;
          }
          for (const entry of declared) {
            const name = typeof entry.name === 'string' ? entry.name : '';
            if (name === '') continue;
            jobs.push(await this.#invoke(db, tenant, row.plugin_id, name));
          }
        }
      } finally {
        db?.close();
      }
    }

    this.#report = { atMs, jobs };
    for (const outcome of jobs) {
      if (outcome.status === 'ran') continue;
      const detail = outcome.error === undefined ? '' : ` ${outcome.error.code}: ${outcome.error.message}`;
      this.#options.log?.(`plugin job: ${outcome.tenant}/${outcome.plugin}/${outcome.job} ${outcome.status} in ${outcome.ms}ms${detail}`);
    }
    return this.#report;
  }

  /** Start the interval. No immediate run — see the header. */
  start(): this {
    if (this.#timer !== undefined || this.#stopped) return this;
    const tickMs = this.#options.tickMs ?? JOB_TICK_MS;
    this.#timer = setInterval(() => {
      if (this.#stopped) return;
      void this.runOnce().catch((err: unknown) => {
        // `runOnce` catches per job; this is the belt for a bug in *this* file.
        const r = reason(err);
        this.#options.log?.(`plugin job tick failed (${r.code}: ${r.message})`);
      });
    }, tickMs);
    this.#timer.unref();
    return this;
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }

  /**
   * One job, bounded. The key is held across the await so the next tick cannot re-enter it; a
   * timeout releases the key and reports, because a tick that waits forever is a tick that stops
   * ticking for every other tenant.
   */
  async #invoke(db: Database.Database, tenant: string, plugin: string, job: string): Promise<JobOutcome> {
    const key = `${tenant}\u0000${plugin}\u0000${job}`;
    const startedAt = this.#now();
    if (this.#inFlight.has(key)) {
      return { tenant, plugin, job, status: 'busy', ms: 0 };
    }
    const registered = this.#options.runtime.job(tenant, plugin, job);
    if (registered === undefined) {
      // Same distinction the endpoint path draws: a package that never activated in this process
      // is not a package whose `activate()` forgot the job, and the difference is the operator's
      // next move (sync/enable it) rather than the author's.
      const active = this.#options.runtime.registry.has(tenant, plugin);
      return {
        tenant,
        plugin,
        job,
        status: 'not-registered',
        ms: 0,
        error: {
          code: 'SKW_E_PL_UNAVAILABLE',
          message: active
            ? `${plugin} declares job ${job} but did not register it at activation`
            : `${plugin} is installed but not active in this process, so job ${job} cannot run (activation failed, or it was enabled by another process and this one has not synced yet)`,
        },
      };
    }

    this.#inFlight.add(key);
    // The context is `endpoint`-mode: a job writes state and queues mail, which is exactly what an
    // endpoint may do, and the same one capability check guards every call.
    //
    // The site's clock travels with it: a job is the one caller with a *schedule*, and a schedule is
    // a time in a zone. Read once per tick from `cms_settings` (one indexed row) rather than per
    // request, and never from a package setting — the zone is the tenant's fact, and two copies of
    // it are two truths.
    const ctx = this.#options.runtime.makeContext(tenant, plugin, 'endpoint', db, undefined, siteTimezoneOf(db));
    const timeoutMs = this.#options.timeoutMs ?? JOB_TIMEOUT_MS;
    let timer: NodeJS.Timeout | undefined;
    try {
      const work = Promise.resolve(
        registered.handler({
          job,
          facade: ctx.facade,
          ctx,
        }),
      );
      const bounded = await Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(Object.assign(new Error(`job ${job} did not finish within ${timeoutMs}ms`), { code: 'SKW_E_PL_JOB_TIMEOUT' }));
          }, timeoutMs);
          timer.unref();
        }),
      ]);
      return { tenant, plugin, job, status: 'ran', ms: this.#now() - startedAt, result: bounded };
    } catch (err) {
      const r = reason(err);
      return {
        tenant,
        plugin,
        job,
        status: r.code === 'SKW_E_PL_JOB_TIMEOUT' ? 'timeout' : 'error',
        ms: this.#now() - startedAt,
        error: r,
      };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      ctx.close();
      this.#inFlight.delete(key);
    }
  }
}
