/**
 * S3d / §7.5 (C-16) — **the render cache, the budget, the two gates, and the sweep.**
 *
 * A render is a *bounded transient*, not a store: `spec_sha` includes the buyer's
 * resolved text, so the hit rate is ≈1 and every redemption leaves a file. The row's
 * `expires_at` is the token's **continuation** expiry (`cexp`, E-26) plus
 * `download.continuation_grace_s`, so a transfer that is still running when its token's
 * last permitted instant passes does not have the file deleted underneath it, and the
 * sweep is what keeps the tree from growing without bound.
 *
 * **The render runs off the event loop, in a worker, with a hard deadline.** `pdf-lib`
 * is synchronous JavaScript: an in-process `Promise.race` against a 2 s timer cannot
 * fire until the render has already returned, which is the exact failure §7.5 measured
 * (a 600 ms block made 20/20 unrelated requests wait 510–514 ms). A worker can be
 * `terminate()`d, so the budget is real.
 *
 * **Two gates, and the global one binds (E-27 / D33).** One `StampGate` per tenant
 * (eight slots) and one per **process** (`max(4, availableParallelism())`). Acquisition
 * order is fixed — tenant, then global — and release is the reverse, so there is no
 * deadlock to reason about and no request holds a scarce box slot while waiting for a
 * tenant that is already full. **The 2 000 ms budget is the request's, not the
 * renderer's**: it starts when the request reaches the stamp stage, *before* either
 * acquisition, and a request still queued at the deadline is refused with
 * `detail.reason='queue'` and **no worker started**. The timer used to start inside the
 * acquired slot, which is why QA measured 8 of 24 requests served 200 after 2 163 ms.
 *
 * **Order on disk, and why it is this order:** render → write `<path>.tmp-…` → insert the
 * row → rename into place. A crash before the insert leaves a temp file (swept by age);
 * a crash after the insert but before the rename leaves a row whose file is missing,
 * which `ensure` detects and re-renders. The one thing that must never happen is a row
 * that names a file nobody wrote and a hand-off that trusts it.
 *
 * Exclusive witness: test/download-watermark.test.ts W2, W6, W6b, W7, W13, W14
 */
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, join } from 'node:path';
import { Worker } from 'node:worker_threads';

import type Database from 'better-sqlite3';

import { AppError } from '../errors.ts';
import { SETTING_DEFAULT_WATERMARK, type AssetRow } from './code.ts';
import {
  buildSpec,
  parseSpecJson,
  specSha,
  stampable,
  type SpecOptions,
  type StampJob,
  type WatermarkCode,
  type WatermarkSpec,
} from './watermark.ts';

/** §7.5: the wall-clock budget. A render slower than this is a denial, not a slow page. */
export const STAMP_BUDGET_MS = 2000;
/** §7.5: the per-tenant concurrency cap. Each in-flight stamp is a worker of its own. */
export const STAMP_CONCURRENCY = 8;
/** The second tree. Not `content/media`, and not reachable from `content/public`. */
export const WM_ROOT = 'content/protected/wm';

/**
 * D33/E-27: the **process-global** cap. `availableParallelism()` is the CPUs this
 * process may actually use — not `os.cpus().length`, which reports the host inside a
 * container with a CPU quota and would size the cap at 16 × 50 MB on a two-core box.
 * The floor of 4 is D33's: a two-core box may run four renders (~200 MB) because a cap
 * of one turns two simultaneous buyers into a queue that fails both.
 */
export function globalStampConcurrency(): number {
  return Math.max(4, availableParallelism());
}

/**
 * One queued acquirer. `done` is set by whichever wins — the deadline timer or a
 * release — so the loser is a no-op rather than a double resolve.
 */
interface Waiter {
  done: boolean;
  resolve: (ok: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * A counting gate whose `acquire` can **expire**.
 *
 * `Semaphore.run` (the argon2 one) has no deadline, and adding one there would change a
 * different contract. This is the same counting idea with the one thing E-27 needs: a
 * waiter that is past its deadline is removed from the queue and answers `false`
 * *before* running anything, so "queued too long" can never start a worker.
 */
export class StampGate {
  readonly #size: number;
  readonly #now: () => number;
  #active = 0;
  #peak = 0;
  readonly #queue: Waiter[] = [];

  constructor(size: number, now: () => number = Date.now) {
    if (!Number.isInteger(size) || size < 1) throw new Error('a stamp gate needs a positive integer size');
    this.#size = size;
    this.#now = now;
  }

  get size(): number {
    return this.#size;
  }

  /** Renders in flight, not requests queued. `peak` is what W6/W14 read. */
  get active(): number {
    return this.#active;
  }

  get peak(): number {
    return this.#peak;
  }

  get waiting(): number {
    return this.#queue.length;
  }

  /** `true` when a slot was taken before `deadlineMs`; `false` when the deadline won. */
  acquire(deadlineMs: number): Promise<boolean> {
    const at = this.#now();
    if (at >= deadlineMs) return Promise.resolve(false);
    if (this.#active < this.#size && this.#queue.length === 0) {
      this.#enter();
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      const entry = {
        done: false,
        resolve,
        timer: setTimeout(() => {
          if (entry.done) return;
          entry.done = true;
          const i = this.#queue.indexOf(entry);
          if (i !== -1) this.#queue.splice(i, 1);
          resolve(false);
        }, Math.max(0, deadlineMs - at)),
      };
      entry.timer.unref?.();
      this.#queue.push(entry);
    });
  }

  release(): void {
    this.#active = Math.max(0, this.#active - 1);
    while (this.#queue.length > 0) {
      const next = this.#queue.shift() as Waiter;
      if (next.done) continue;
      next.done = true;
      clearTimeout(next.timer);
      this.#enter();
      next.resolve(true);
      return;
    }
  }

  #enter(): void {
    this.#active += 1;
    this.#peak = Math.max(this.#peak, this.#active);
  }
}

/**
 * One gate per process for the box's ceiling, created on first use.
 *
 * E-27: "production has no option that creates a second one — two stores in one process
 * would be two global caps". A test that passes `globalConcurrency` gets its own gate so
 * it can size the ceiling deterministically; nothing else ever does.
 */
let processGlobalGate: StampGate | undefined;

export interface RenderRow {
  id: number;
  asset_id: number;
  spec_sha: string;
  source_sha: string;
  bytes: number;
  path: string;
  expires_at: string;
}

export interface StampResult {
  specSha: string;
  /** Relative to `contentRoot`, e.g. `content/protected/wm/<spec>/<sha>.pdf`. */
  relPath: string;
  absPath: string;
  bytes: number;
  /** True when an existing render was handed back without drawing anything. */
  reused: boolean;
}

export interface LogoRef {
  path: string;
  sha: string;
}

export interface EnsureInput {
  tenantKey: string;
  db: Database.Database;
  asset: AssetRow;
  code: WatermarkCode;
  /**
   * The token's **continuation** expiry (`cexp`) + `download.continuation_grace_s`,
   * ISO 8601. E-26: the last instant a request against this token may be served is
   * `cexp`, so the file outlives *that*, not `exp` — otherwise the sweep deletes a
   * render 6 h 10 min after mint while a transfer it started may still be running.
   */
  expiresAt: string;
  /** Overrides from `cms_asset.watermark_spec_json`; loaded from the row when omitted. */
  options?: SpecOptions | undefined;
  /** The logo file, already resolved. `undefined` means "read the row"; `null` means none. */
  logo?: LogoRef | null | undefined;
}

/** The renderer is handed the time it has left, not the store's full budget. */
export type Renderer = (job: StampJob, budgetMs: number) => Promise<Buffer>;

export interface WatermarkDeps {
  /** `content/`. */
  contentRoot: string;
  /** 2000 in the shipped build; a test may shrink it to prove the denial path. */
  budgetMs?: number | undefined;
  /** Per-tenant slots; 8 in the shipped build. */
  concurrency?: number | undefined;
  /**
   * The **process-global** slots. Absent in production, where the value is
   * `globalStampConcurrency()` and the gate is the process singleton; present only in a
   * gate that needs a deterministic ceiling (E-27's `W6`).
   */
  globalConcurrency?: number | undefined;
  /**
   * An explicit process-global gate. Present **only** in `W14`, which needs a request to
   * be refused *while queued*: that requires a holder whose budget outlasts the waiter's,
   * and in one store every request has the same budget — so the test hands two stores the
   * same gate, which is what "one per process" means when a process has more than one
   * store. Nothing in production passes this.
   */
  globalGate?: StampGate | undefined;
  /** Injectable **only** for the failure and concurrency gates; the default is the worker. */
  render?: Renderer | undefined;
  now?: (() => number) | undefined;
}

/** Thrown by the worker path when the deadline wins; distinguished so the reason is honest. */
export class StampTimeout extends Error {
  constructor(budgetMs: number) {
    super(`the watermark render exceeded its ${budgetMs} ms budget`);
    this.name = 'StampTimeout';
  }
}

/**
 * The worker's URL, and **why the extension is computed**.
 *
 * `import.meta.url` is `…/stamp-worker.ts` under the test runner (Node's type stripping)
 * and `…/stamp-worker.js` from `dist/` after `tsc`. A hard-coded `.ts` would make every
 * stamp fail closed in production — a 503 for every paying customer, discovered at the
 * worst moment — so the suffix follows the module's own. It is exported so a gate can
 * assert both shapes and that the file it names exists.
 */
export function stampWorkerUrl(metaUrl: string): URL {
  const suffix = metaUrl.endsWith('.ts') ? '.ts' : '.js';
  return new URL(`./stamp-worker${suffix}`, metaUrl);
}

/**
 * One worker per stamp. The module URL is `import.meta.url`-relative, so the same code
 * loads `stamp-worker.ts` under the test runner and `stamp-worker.js` from `dist/`.
 */
function renderInWorker(job: StampJob, budgetMs: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const worker = new Worker(stampWorkerUrl(import.meta.url));
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new StampTimeout(budgetMs))), budgetMs);
    worker.once('message', (message: { ok: boolean; bytes?: Uint8Array; error?: string }) => {
      finish(() => {
        if (message.ok && message.bytes !== undefined) resolve(Buffer.from(message.bytes));
        else reject(new Error(message.error ?? 'the stamp worker returned no bytes'));
      });
    });
    worker.once('error', (err: Error) => finish(() => reject(err)));
    worker.once('exit', (code: number) => finish(() => reject(new Error(`the stamp worker exited with ${code}`))));
    worker.postMessage(job);
  });
}

function extOf(storagePath: string): string {
  const dot = storagePath.lastIndexOf('.');
  return dot === -1 ? 'bin' : storagePath.slice(dot + 1);
}

function absOf(contentRoot: string, relPath: string): string {
  // Every `relPath` is built here from a hex hash and the store's own extension, never
  // from a request; the prefix check keeps that a property of the code, not the reader.
  if (!relPath.startsWith('content/')) throw new Error(`a render path must start with content/: ${relPath}`);
  return join(contentRoot, relPath.slice('content/'.length));
}

export class WatermarkStore {
  readonly #contentRoot: string;
  readonly #budgetMs: number;
  readonly #concurrency: number;
  readonly #global: StampGate;
  readonly #render: Renderer;
  readonly #now: () => number;
  readonly #gates = new Map<string, StampGate>();
  /**
   * Renders actually in flight, not requests holding a slot. A request granted a tenant
   * slot and still waiting on the global one has started no worker, and E-27 requires
   * "peak 8" to keep meaning eight workers.
   */
  readonly #active = new Map<string, number>();
  readonly #peak = new Map<string, number>();
  #activeGlobal = 0;
  #peakGlobal = 0;
  /** Keyed by `spec:source`: two tabs of one buyer must not draw the same page twice. */
  readonly #inFlight = new Map<string, Promise<StampResult>>();

  constructor(deps: WatermarkDeps) {
    this.#contentRoot = deps.contentRoot;
    this.#budgetMs = deps.budgetMs ?? STAMP_BUDGET_MS;
    this.#concurrency = deps.concurrency ?? STAMP_CONCURRENCY;
    this.#now = deps.now ?? Date.now;
    this.#render = deps.render ?? ((job, budgetMs) => renderInWorker(job, budgetMs));
    if (!Number.isInteger(this.#concurrency) || this.#concurrency < 1) {
      throw new Error('the watermark concurrency must be a positive integer');
    }
    if (deps.globalGate !== undefined) {
      this.#global = deps.globalGate;
    } else if (deps.globalConcurrency === undefined) {
      processGlobalGate ??= new StampGate(globalStampConcurrency(), this.#now);
      this.#global = processGlobalGate;
    } else {
      this.#global = new StampGate(deps.globalConcurrency, this.#now);
    }
  }

  get budgetMs(): number {
    return this.#budgetMs;
  }

  /** The process cap the shipped build uses; `W6`/`P-S3d-1` state the number they ran under. */
  get globalCapacity(): number {
    return this.#global.size;
  }

  /** The high-water mark of in-flight stamps for one tenant — what W6 measures. */
  peakInFlight(tenantKey: string): number {
    return this.#peak.get(tenantKey) ?? 0;
  }

  /** The high-water mark **across every tenant** — the number D33 bounds. */
  peakGlobalInFlight(): number {
    return this.#peakGlobal;
  }

  #gate(tenantKey: string): StampGate {
    let gate = this.#gates.get(tenantKey);
    if (gate === undefined) {
      gate = new StampGate(this.#concurrency, this.#now);
      this.#gates.set(tenantKey, gate);
    }
    return gate;
  }

  /**
   * Return the render for this (spec, source), drawing it if it is not there.
   *
   * Throws `AppError('SKW_E_SEC_WATERMARK_FAILED')` for every failure — timeout,
   * renderer error, unwritable tree. The caller writes the `denied_watermark` ledger row
   * and answers 503; there is no branch here that returns an un-stamped path.
   */
  async ensure(input: EnsureInput): Promise<StampResult> {
    if (stampable(input.asset) === null) {
      throw new AppError('SKW_E_SEC_WATERMARK_FAILED', 'this format cannot be watermarked in v1', {
        reason: 'unstampable',
        mime: input.asset.mime,
      });
    }

    const planned = this.#plan(input);
    const { sha, relPath, absPath } = planned;

    const hit = this.#read(input.db, sha, input.asset.sha256, absPath, input.expiresAt);
    if (hit !== null) return { specSha: sha, relPath, absPath, bytes: hit, reused: true };

    const key = `${sha}:${input.asset.sha256}`;
    const running = this.#inFlight.get(key);
    if (running !== undefined) {
      const shared = await running;
      return { ...shared, reused: true };
    }

    const work = this.#stamp(input, planned);
    this.#inFlight.set(key, work);
    try {
      return await work;
    } finally {
      this.#inFlight.delete(key);
    }
  }

  /** Spec, hash and path — the three things the cache and the hand-off both need. */
  #plan(input: EnsureInput): { spec: WatermarkSpec; sha: string; relPath: string; absPath: string; logo: LogoRef | null } {
    const config = loadWatermarkConfig(input.db, input.asset.id);
    let options: SpecOptions;
    if (input.options !== undefined) {
      options = input.options;
    } else {
      try {
        options = parseSpecJson(config.specJson);
      } catch (err) {
        throw new AppError('SKW_E_SEC_WATERMARK_FAILED', `the watermark spec on this asset is invalid: ${(err as Error).message}`, {
          reason: 'spec_invalid',
          asset_key: input.asset.key,
        });
      }
    }
    const logo = input.logo === undefined ? config.logo : input.logo;
    options = { ...options, logo: logo === null ? null : logo.sha };

    let spec: WatermarkSpec;
    try {
      spec = buildSpec(input.asset, input.code, options);
    } catch (err) {
      throw new AppError('SKW_E_SEC_WATERMARK_FAILED', (err as Error).message, {
        reason: 'spec_invalid',
        asset_key: input.asset.key,
      });
    }
    const sha = specSha(spec);
    const relPath = `${WM_ROOT}/${sha}/${input.asset.sha256}.${extOf(input.asset.storage_path)}`;
    return { spec, sha, relPath, absPath: absOf(this.#contentRoot, relPath), logo };
  }

  /** A live row whose file is present and the right size. Missing file → `null` (re-render). */
  #read(db: Database.Database, sha: string, source: string, absPath: string, expiresAt: string): number | null {
    const row = db
      .prepare(`SELECT id, bytes FROM cms_watermark_render WHERE spec_sha = ? AND source_sha = ?`)
      .get(sha, source) as { id: number; bytes: number } | undefined;
    if (row === undefined) return null;
    let size = -1;
    try {
      size = statSync(absPath).size;
    } catch {
      return null;
    }
    if (size !== row.bytes) return null;
    // A later token extends the life of the same bytes; an earlier one never shortens it,
    // or a slow retry would delete a file a running transfer is still reading.
    db.prepare(
      `UPDATE cms_watermark_render
          SET expires_at = CASE WHEN expires_at < ? THEN ? ELSE expires_at END
        WHERE id = ?`,
    ).run(expiresAt, expiresAt, row.id);
    return row.bytes;
  }

  async #stamp(
    input: EnsureInput,
    planned: { spec: WatermarkSpec; sha: string; relPath: string; absPath: string; logo: LogoRef | null },
  ): Promise<StampResult> {
    const { spec, sha, relPath, absPath, logo } = planned;
    const job: StampJob = {
      kind: spec.kind,
      sourcePath: absOf(this.#contentRoot, input.asset.storage_path),
      logoPath: logo === null ? null : absOf(this.#contentRoot, logo.path),
      specSha: sha,
      text: spec.text,
      position: spec.position,
      opacity: spec.opacity,
      scale: spec.scale,
      rotation: spec.rotation,
      pages: spec.pages,
      format: extOf(input.asset.storage_path),
    };

    let bytes: Buffer;
    // E-27: the budget is the *request's*. It starts here — at the stamp stage, before
    // either acquisition — so the queue is inside it, not in front of it.
    const arrival = this.#now();
    const deadline = arrival + this.#budgetMs;
    const tenantGate = this.#gate(input.tenantKey);
    // Fixed order: tenant, then global. Release is the reverse, in the `finally` below.
    if (!(await tenantGate.acquire(deadline))) {
      throw this.#queueDenial(input, arrival);
    }
    let holdsGlobal = false;
    try {
      if (!(await this.#global.acquire(deadline))) {
        throw this.#queueDenial(input, arrival);
      }
      holdsGlobal = true;
      const remaining = deadline - this.#now();
      if (remaining <= 0) {
        // Acquired with nothing left: the same budget doing its job, not a second one.
        throw this.#timeoutDenial(input, arrival);
      }
      // The budget is enforced here as well as inside the worker. In the shipped path
      // the worker's own deadline is what makes the cap real (`terminate()` is the only
      // way to stop synchronous pdf-lib work); this race is what makes an *injected*
      // renderer — the gate's, never production's — obey the same contract.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const tenantActive = (this.#active.get(input.tenantKey) ?? 0) + 1;
      this.#active.set(input.tenantKey, tenantActive);
      this.#peak.set(input.tenantKey, Math.max(this.#peak.get(input.tenantKey) ?? 0, tenantActive));
      this.#activeGlobal += 1;
      this.#peakGlobal = Math.max(this.#peakGlobal, this.#activeGlobal);
      try {
        bytes = await new Promise<Buffer>((resolve, reject) => {
          timer = setTimeout(() => reject(new StampTimeout(remaining)), remaining);
          this.#render(job, remaining).then(resolve, reject);
        });
      } catch (err) {
        if (err instanceof AppError) throw err;
        const reason = err instanceof StampTimeout ? 'timeout' : 'renderer';
        throw new AppError('SKW_E_SEC_WATERMARK_FAILED', `the watermark could not be rendered: ${(err as Error).message}`, {
          reason,
          asset_key: input.asset.key,
          budget_ms: this.#budgetMs,
        });
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        this.#active.set(input.tenantKey, Math.max(0, (this.#active.get(input.tenantKey) ?? 1) - 1));
        this.#activeGlobal = Math.max(0, this.#activeGlobal - 1);
      }
    } finally {
      if (holdsGlobal) this.#global.release();
      tenantGate.release();
    }
    if (bytes.length === 0) {
      throw new AppError('SKW_E_SEC_WATERMARK_FAILED', 'the renderer produced no bytes', {
        reason: 'renderer',
        asset_key: input.asset.key,
      });
    }

    // The row before the rename: a reader can find a row whose file is missing (and
    // re-render), but can never find a file with no row and hand it off as if it were
    // accounted for.
    const tmp = `${absPath}.tmp-${randomBytes(6).toString('hex')}`;
    try {
      mkdirSync(dirname(absPath), { recursive: true });
      writeFileSync(tmp, bytes, { mode: 0o640 });
      input.db
        .prepare(
          `INSERT INTO cms_watermark_render (asset_id, spec_sha, source_sha, bytes, path, expires_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(spec_sha, source_sha) DO UPDATE SET
             bytes = excluded.bytes,
             path = excluded.path,
             expires_at = CASE
               WHEN cms_watermark_render.expires_at < excluded.expires_at THEN excluded.expires_at
               ELSE cms_watermark_render.expires_at END`,
        )
        .run(input.asset.id, sha, input.asset.sha256, bytes.length, relPath, input.expiresAt);
      renameSync(tmp, absPath);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw new AppError('SKW_E_SEC_WATERMARK_FAILED', `the render could not be stored: ${(err as Error).message}`, {
        reason: 'io',
        asset_key: input.asset.key,
      });
    }

    return { specSha: sha, relPath, absPath, bytes: bytes.length, reused: false };
  }

  /**
   * A request refused while still **queued** (E-27): `detail.reason='queue'`, the budget
   * it was given and the time it waited. No worker was started, so there is nothing to
   * terminate and no render row to remove — the plane writes the one `denied_watermark`
   * row and answers 503.
   */
  #queueDenial(input: EnsureInput, arrival: number): AppError {
    const queuedMs = this.#now() - arrival;
    return new AppError('SKW_E_SEC_WATERMARK_FAILED', 'the watermark queue released no renderer within the budget', {
      reason: 'queue',
      asset_key: input.asset.key,
      budget_ms: this.#budgetMs,
      queued_ms: queuedMs,
    });
  }

  /** A slot taken with no time left: the same budget doing its job, not a second one. */
  #timeoutDenial(input: EnsureInput, arrival: number): AppError {
    return new AppError('SKW_E_SEC_WATERMARK_FAILED', `the watermark exceeded its ${this.#budgetMs} ms budget while queueing`, {
      reason: 'timeout',
      asset_key: input.asset.key,
      budget_ms: this.#budgetMs,
      queued_ms: this.#now() - arrival,
    });
  }

  /**
   * Delete every render past `expires_at`, file and row, then prune empty spec
   * directories and stale temp files. Called on a tick and directly by the gate. Never
   * throws for a missing file: an already-deleted render is the state the sweep wants.
   */
  sweep(db: Database.Database, nowMs: number): { rows: number; files: number } {
    const nowIso = new Date(nowMs).toISOString();
    const expired = db
      .prepare(`SELECT id, path FROM cms_watermark_render WHERE expires_at <= ?`)
      .all(nowIso) as { id: number; path: string }[];
    let files = 0;
    const del = db.prepare(`DELETE FROM cms_watermark_render WHERE id = ?`);
    for (const row of expired) {
      try {
        unlinkSync(absOf(this.#contentRoot, row.path));
        files += 1;
      } catch {
        // Already gone is the postcondition, not a failure.
      }
      del.run(row.id);
    }
    this.#pruneDirs(nowMs);
    return { rows: expired.length, files };
  }

  /**
   * Temp files from a crash, and empty spec directories. A temp file is only removed
   * after an hour: a render that is being renamed right now must not be swept from
   * under its own `renameSync`.
   */
  #pruneDirs(nowMs: number): void {
    const root = join(this.#contentRoot, 'protected', 'wm');
    if (!existsSync(root)) return;
    const cutoff = nowMs - 3_600_000;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(root, entry.name);
      let remaining = 0;
      for (const file of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, file.name);
        if (file.name.includes('.tmp-')) {
          try {
            if (statSync(full).mtimeMs < cutoff) unlinkSync(full);
            else remaining += 1;
          } catch {
            // raced with another sweep; not a failure
          }
          continue;
        }
        remaining += 1;
      }
      if (remaining === 0) rmSync(dir, { recursive: true, force: true });
    }
  }
}

/** `cms_asset.watermark_spec_json` plus the logo, resolved to a path and a hash. */
export function loadWatermarkConfig(
  db: Database.Database,
  assetId: number,
): { specJson: string | null; logo: LogoRef | null } {
  const row = db
    .prepare(`SELECT watermark_spec_json, watermark_asset_id FROM cms_asset WHERE id = ?`)
    .get(assetId) as { watermark_spec_json: string | null; watermark_asset_id: number | null } | undefined;
  if (row === undefined) return { specJson: null, logo: null };

  let logoId = row.watermark_asset_id;
  if (logoId === null) {
    // D20's tenant default: a setting naming an asset key, empty when unset.
    const setting = db.prepare(`SELECT value_json FROM cms_settings WHERE key = ?`).get(SETTING_DEFAULT_WATERMARK) as
      | { value_json: string }
      | undefined;
    const key = setting === undefined ? '' : parseSettingString(setting.value_json);
    if (key !== '') {
      const byKey = db.prepare(`SELECT id FROM cms_asset WHERE key = ?`).get(key) as { id: number } | undefined;
      logoId = byKey?.id ?? null;
    }
  }
  if (logoId === null) return { specJson: row.watermark_spec_json, logo: null };

  const logo = db.prepare(`SELECT sha256, storage_path FROM cms_asset WHERE id = ?`).get(logoId) as
    | { sha256: string; storage_path: string }
    | undefined;
  if (logo === undefined) return { specJson: row.watermark_spec_json, logo: null };
  return { specJson: row.watermark_spec_json, logo: { path: logo.storage_path, sha: logo.sha256 } };
}

/** `cms_settings.value_json` holds JSON; a bare string is accepted for a hand-edited row. */
function parseSettingString(raw: string): string {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'string' ? parsed : '';
  } catch {
    return raw;
  }
}
