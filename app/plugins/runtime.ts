/**
 * The load path (§13.3.2) and the lifecycle without a restart (§13.3.8). D36, in one file.
 *
 * `enable(tenant, id)` is ten steps and they are the same ten the spec numbers:
 *
 *   1. read the installed row; refuse if `status='failed'` without an operator ack
 *   2. **revocation**, both sources — a root revoked after it was installed is refused here,
 *      because under in-process loading `enable` is the moment code starts running
 *   3. re-verify the package root against `root_hash`; refuse `SKW_E_PL_SIGNATURE` if the bytes moved
 *   4. check the manifest's declared schema range against the tenant; refuse `SKW_E_PL_SCHEMA`
 *   5. `entry = realpath(<data>/plugins/<id>/<main>)`; refuse unless it is under the package root
 *   6. `import(pathToFileURL(entry).href + '?tenant=…&act=' + n)` — **the cache-buster**
 *   7. assert `typeof namespace.activate === 'function'`; refuse `SKW_E_PL_LOAD` otherwise
 *   8. `ctx = makeContext(…, {activationOpen: true})`, `await namespace.activate(ctx)`
 *   9. `ctx.closeActivation()`, `registry.commit(…)`
 *  10. `status='enabled'`, counter += 1, audit row
 *
 * **Why the cache-buster is not optional.** Node's ESM cache is keyed by URL. Without `?act=`,
 * a disable→enable cycle returns the *previous* module namespace: module-level state survives,
 * a top-level `setInterval` from the first activation still runs, and "not loaded" is a lie the
 * admin UI tells. The counter is monotonic per (tenant, plugin) and is the only thing that
 * changes between loads.
 *
 * **Why the tenant is in the URL.** One module instance per (tenant, plugin, activation) means
 * a module-level variable cannot carry a value from tenant A to tenant B by accident. The cost
 * is one module instance per enabled pair. A plugin can still reach `globalThis` deliberately,
 * so this is an accident-preventer, not a boundary.
 *
 * **Where the counter lives, and what is not done.** It is held in the registry, in this
 * process. The ESM cache it guards is also in this process, so the witness (L8/L9: re-enable
 * gives a module whose counter starts at 0) holds; a restart empties the cache and the counter
 * together, which is consistent rather than lucky. E-31's builder item 5 asked for a
 * `cms_plugin_installed.activation_seq` column as well; that migration is **not** in this pass
 * and is recorded as owed in `docs/build/S5-inprocess-report.md` §7. The sentence above about
 * *why* the cache key must change is unaffected by where the number is stored.
 *
 * **A failed load never takes the site down.** Steps 2–9 run inside one `try/catch`: a package
 * that throws at import, whose `activate` throws, or whose export shape is wrong is marked
 * `status='failed'`, `enabled=0`, and an admin notice names the code and the plugin. The site
 * keeps serving, because the registry never received its hooks.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import type Database from 'better-sqlite3';

import { AppError } from '../errors.ts';
import { openAdminWrite } from '../db/classes.ts';
import { makePluginContext, type PluginContext } from './context.ts';
import { HookBus, type HookFailure } from './hooks.ts';
import { HOOK_NAMES, packageDir, packageRootHash, parseManifest, type Manifest } from './manifest.ts';
import { revokedRoot } from './revocation.ts';
import { ActivationRecorder, PluginRegistry, type RegistryEntry } from './registry.ts';
import { trustDirFor, verifyPackageSignature } from './trust.ts';

/** 5 s, then `SKW_E_PL_BUSY` rather than drop a table under a live request (§13.3.8). */
export const DRAIN_TIMEOUT_MS = 5000;

export interface PluginRow {
  plugin_id: string;
  version: string;
  manifest_json: string;
  root_hash: string;
  enabled: number;
  status: string | null;
  signature_state: string;
  test_report_sha: string | null;
}

export interface PluginNotice {
  plugin: string;
  tenant: string;
  code: string;
  message: string;
  at: string;
}

export interface PluginRuntimeOptions {
  /** `<data>`: tenant databases at `<data>/tenants/<key>/site.db`, packages at `<data>/plugins`. */
  dataDir: string;
  emailMode: 'off' | 'smtp';
  log?: ((line: string) => void) | undefined;
  /** The audit chain. Absent in a gate that does not have a control.db. */
  audit?: ((action: string, target: string, detail: Record<string, unknown>) => void) | undefined;
  now?: (() => number) | undefined;
  hookTimeoutMs?: number | undefined;
}

export interface ActivationResult {
  plugin: string;
  version: string;
  alreadyActive: boolean;
  activationSeq: number;
  hooks: string[];
  endpoints: string[];
}

function code(message: string): string {
  return /^(SKW_E_[A-Z0-9_]+)/.exec(message)?.[1] ?? 'SKW_E_PL_LOAD';
}

export class PluginRuntime {
  readonly registry = new PluginRegistry();
  readonly hooks: HookBus;
  private readonly options: PluginRuntimeOptions;
  /** `tenant\0plugin` → the module namespace, so a disable can drop the reference (§13.3.8). */
  private readonly namespaces = new Map<string, unknown>();
  /** Admin notices: what an operator sees after a failed load or an auto-disable. */
  private readonly notices: PluginNotice[] = [];
  /** In-flight requests per tenant, for the uninstall drain. */
  private readonly inFlight = new Map<string, number>();
  /** Tenant keys whose rows say `failed`, so `enable` can refuse without an ack. */
  private readonly failed = new Set<string>();

  constructor(options: PluginRuntimeOptions) {
    this.options = options;
    this.hooks = new HookBus({
      onFailure: (failure) => this.onHookFailure(failure),
      log: options.log,
      now: options.now,
      timeoutMs: options.hookTimeoutMs,
    });
  }

  get emailMode(): 'off' | 'smtp' {
    return this.options.emailMode;
  }

  noticesFor(tenant: string): PluginNotice[] {
    return this.notices.filter((n) => n.tenant === tenant);
  }

  allNotices(): readonly PluginNotice[] {
    return this.notices;
  }

  sitePath(tenant: string): string {
    return join(this.options.dataDir, 'tenants', tenant, 'site.db');
  }

  private pluginsRoot(): string {
    return join(this.options.dataDir, 'plugins');
  }

  private nowIso(): string {
    return new Date((this.options.now ?? Date.now)()).toISOString();
  }

  // ---------------------------------------------------------------- in-flight, for the drain

  /** A request that may call a plugin has begun. Paired with `leave()` in a `finally`. */
  enter(tenant: string): void {
    this.inFlight.set(tenant, (this.inFlight.get(tenant) ?? 0) + 1);
  }

  leave(tenant: string): void {
    const next = (this.inFlight.get(tenant) ?? 1) - 1;
    if (next <= 0) this.inFlight.delete(tenant);
    else this.inFlight.set(tenant, next);
  }

  inFlightCount(tenant: string): number {
    return this.inFlight.get(tenant) ?? 0;
  }

  /** §13.3.8: wait for the tenant's in-flight count to reach 0, bounded at 5 s. */
  async drain(tenant: string, timeoutMs = DRAIN_TIMEOUT_MS): Promise<void> {
    const deadline = (this.options.now ?? Date.now)() + timeoutMs;
    while (this.inFlightCount(tenant) > 0) {
      if ((this.options.now ?? Date.now)() >= deadline) {
        throw new AppError('SKW_E_PL_BUSY', `tenant ${tenant} still has ${this.inFlightCount(tenant)} request(s) in flight`, {
          tenant,
          in_flight: this.inFlightCount(tenant),
          waited_ms: timeoutMs,
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  // ---------------------------------------------------------------- enable / disable / boot

  /** The row, plus the columns this pass added a reader for. `status` may be absent. */
  row(db: Database.Database, pluginId: string): PluginRow | undefined {
    const table = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cms_plugin_installed'`).get();
    if (table === undefined) return undefined;
    const columns = (db.pragma('table_info(cms_plugin_installed)') as { name: string }[]).map((c) => c.name);
    const status = columns.includes('status') ? 'status' : `'enabled' AS status`;
    return db
      .prepare(
        `SELECT plugin_id, version, manifest_json, root_hash, enabled, signature_state, test_report_sha, ${status}
         FROM cms_plugin_installed WHERE plugin_id = ?`,
      )
      .get(pluginId) as PluginRow | undefined;
  }

  /**
   * Enable one package for one tenant (§13.3.2). All-or-nothing: any failure before
   * `registry.commit` leaves the registry without an entry and the row `status='failed'`.
   */
  async enable(tenant: string, pluginId: string, opts: { ackFailed?: boolean } = {}): Promise<ActivationResult> {
    const db = openAdminWrite(this.sitePath(tenant), 5000);
    try {
      const row = this.row(db, pluginId);
      if (row === undefined) {
        throw new AppError('SKW_E_PL_UNAVAILABLE', `no plugin ${JSON.stringify(pluginId)} is installed for tenant ${tenant}`, {
          plugin: pluginId,
          tenant,
        });
      }
      if (row.status === 'failed' && opts.ackFailed !== true) {
        throw new AppError('SKW_E_PL_UNAVAILABLE', `plugin ${pluginId} is marked failed; an operator must acknowledge before it is retried`, {
          plugin: pluginId,
          status: 'failed',
        });
      }
      if (this.registry.has(tenant, pluginId)) {
        const entry = this.registry.get(tenant, pluginId) as RegistryEntry;
        return {
          plugin: pluginId,
          version: entry.version,
          alreadyActive: true,
          activationSeq: entry.activationSeq,
          hooks: [...entry.hooks.keys()],
          endpoints: [...entry.endpoints.keys()],
        };
      }

      const activationSeq = this.registry.nextActivation(tenant, pluginId);
      const result = await this.load(db, tenant, row, activationSeq);
      this.failed.delete(`${tenant}\u0000${pluginId}`);
      return result;
    } finally {
      db.close();
    }
  }

  /** Steps 2–9 of §13.3.2, inside one `try/catch` (§13.3.6's load-time failure model). */
  private async load(db: Database.Database, tenant: string, row: PluginRow, activationSeq: number): Promise<ActivationResult> {
    const pluginId = row.plugin_id;
    const dir = packageDir(this.pluginsRoot(), pluginId);
    let manifest: Manifest | null = null;
    try {
      // 2. revocation, **both sources**, read at the moment code would start running.
      const revoked = revokedRoot(trustDirFor(this.sitePath(tenant)), db, row.root_hash);
      if (revoked !== null) {
        throw new AppError(
          'SKW_E_PL_REVOKED',
          `${pluginId} (package root ${row.root_hash}) is revoked on this install (${revoked.source}${revoked.reason === null ? '' : `: ${revoked.reason}`})`,
          { plugin: revoked.plugin_id === '(unnamed)' ? pluginId : revoked.plugin_id, root_hash: row.root_hash, source: revoked.source },
        );
      }

      // 3. the bytes are the bytes that were signed: root hash from the row, recomputed here.
      if (!existsSync(join(dir, 'plugin.json'))) {
        throw new AppError('SKW_E_PL_SIGNATURE', `the package for ${pluginId} is not on disk at ${dir}`, { plugin: pluginId, dir });
      }
      manifest = parseManifest(JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8')) as unknown);
      const { root } = packageRootHash(dir);
      if (root !== row.root_hash) {
        throw new AppError('SKW_E_PL_SIGNATURE', `${pluginId} changed on disk after it was installed and signed (${row.root_hash} → ${root})`, {
          plugin: pluginId,
          installed_root_hash: row.root_hash,
          package_root_hash: root,
        });
      }
      // …and the signature itself, when the package still carries one. A root hash proves the
      // bytes did not move; only the signature says whose bytes they are.
      const sigPath = join(dir, 'plugin.sig.json');
      if (existsSync(sigPath)) {
        verifyPackageSignature({
          dir,
          signaturePath: sigPath,
          trustDir: trustDirFor(this.sitePath(tenant)),
          manifest,
        });
      }

      // 4. the declared schema range against the row's tenant, not against a global build id.
      const siteVersion = Number(db.pragma('user_version', { simple: true }));
      if (manifest.requires?.site_db_min !== undefined && siteVersion < manifest.requires.site_db_min) {
        throw new AppError('SKW_E_PL_SCHEMA', `${pluginId} needs site.db >= ${manifest.requires.site_db_min}; this tenant is ${siteVersion}`, {
          plugin: pluginId,
          site_db: siteVersion,
          site_db_min: manifest.requires.site_db_min,
        });
      }
      if (manifest.requires?.site_db_max !== undefined && siteVersion > manifest.requires.site_db_max) {
        throw new AppError('SKW_E_PL_SCHEMA', `${pluginId} supports site.db <= ${manifest.requires.site_db_max}; this tenant is ${siteVersion}`, {
          plugin: pluginId,
          site_db: siteVersion,
          site_db_max: manifest.requires.site_db_max,
        });
      }

      // 5. the entry, and the realpath must stay under the package root.
      const entry = realpathSync(join(dir, manifest.main));
      const rootDir = realpathSync(dir);
      if (entry !== rootDir && !entry.startsWith(rootDir + sep)) {
        throw new AppError('SKW_E_PL_LOAD', `${pluginId}'s main resolves outside its package root (${entry})`, { plugin: pluginId, entry, root: rootDir });
      }

      // 6. the import, with the cache-buster. The number is in the URL *and* on the entry.
      const url =
        `${pathToFileURL(entry).href}?tenant=${encodeURIComponent(tenant)}&act=${String(activationSeq)}`;
      const namespace = (await import(url)) as { activate?: unknown; default?: unknown };

      // 7. the export shape.
      const activate = (namespace as { activate?: unknown }).activate ?? (namespace as { default?: unknown }).default;
      if (typeof activate !== 'function') {
        throw new AppError('SKW_E_PL_LOAD', `${pluginId} does not export activate(ctx); the manifest's main is not a plugin`, {
          plugin: pluginId,
          entry,
        });
      }

      // 8. the recorder closes when activation returns: a hook cannot be added later.
      const recorder = new ActivationRecorder(
        pluginId,
        manifest.hooks,
        manifest.tables.map((t) => t.name),
      );
      if (!manifest.hooks.every((hook) => HOOK_NAMES.includes(hook))) {
        throw new AppError('SKW_E_PL_REJECTED', `${pluginId} declares a hook that is not one of the twelve`, { plugin: pluginId });
      }
      const ctx = makePluginContext({
        db,
        tenant,
        plugin: pluginId,
        mode: 'activation',
        emailMode: this.options.emailMode,
        log: this.options.log,
        now: this.options.now,
      });
      await activate.call(namespace, {
        tenant,
        plugin: pluginId,
        mode: 'activation',
        facade: ctx.facade,
        on: (hook: string, fn: unknown) => recorder.on(hook, fn),
        endpoint: (method: string, name: string, handler: unknown) => recorder.endpoint(method, name, handler),
        screen: (screen: unknown) => recorder.screen(screen),
        log: (line: unknown) => ctx.facade['log.write'](line),
      });

      // 9. commit — after activation, never during it.
      recorder.closeActivation();
      ctx.close();
      this.registry.commit(tenant, pluginId, manifest.version, activationSeq, recorder.registrations, (this.options.now ?? Date.now)());
      this.namespaces.set(`${tenant}\u0000${pluginId}`, namespace);
      this.hooks.reset(tenant, pluginId);

      // 10. the row, and an audit line that names the activation (not just the enable).
      db.prepare(`UPDATE cms_plugin_installed SET enabled = 1, enabled_at = COALESCE(enabled_at, ?) WHERE plugin_id = ?`).run(
        this.nowIso(),
        pluginId,
      );
      this.options.audit?.('plugin.enable', pluginId, { tenant, version: manifest.version, activation_seq: activationSeq });

      const entryRegs = this.registry.get(tenant, pluginId) as RegistryEntry;
      return {
        plugin: pluginId,
        version: manifest.version,
        alreadyActive: false,
        activationSeq,
        hooks: [...entryRegs.hooks.keys()],
        endpoints: [...entryRegs.endpoints.keys()],
      };
    } catch (err) {
      // §13.3.6: mark it, disable it, notice it, and keep serving. The registry never received
      // its hooks, so there is nothing to prune — but `remove` is called anyway, because a
      // half-activated entry is exactly the state this branch must not be able to leave behind.
      this.registry.remove(tenant, pluginId);
      this.namespaces.delete(`${tenant}\u0000${pluginId}`);
      const message = err instanceof Error ? err.message : String(err);
      const failureCode = code(message);
      this.markFailed(db, pluginId, failureCode, message, tenant);
      const e = err instanceof AppError ? err : new AppError(failureCode, message, { plugin: pluginId });
      throw e;
    }
  }

  /** `status='failed'`, `enabled=0`, an admin notice naming the code and the plugin. */
  private markFailed(db: Database.Database, pluginId: string, failureCode: string, message: string, tenant?: string): void {
    try {
      db.prepare(`UPDATE cms_plugin_installed SET enabled = 0 WHERE plugin_id = ?`).run(pluginId);
    } catch {
      /* the row is gone, which is also "not enabled" */
    }
    const key = `${tenant ?? ''}\u0000${pluginId}`;
    this.failed.add(key);
    this.notices.push({
      plugin: pluginId,
      tenant: tenant ?? '',
      code: failureCode,
      message: message.slice(0, 500),
      at: this.nowIso(),
    });
    this.options.log?.(`plugin failed plugin=${pluginId} code=${failureCode} ${message.slice(0, 200)}`);
    this.options.audit?.('plugin.failed', pluginId, { code: failureCode, message: message.slice(0, 300) });
  }

  /**
   * Disable (§13.3.8): the `plugin.disabled` action (bounded, `try/catch`) → `registry.delete`
   * → drop the namespace → `enabled=0`. The hooks are **removed**, not skipped: there is no
   * branch that checks `enabled` and returns early.
   */
  async disable(tenant: string, pluginId: string, opts: { audit?: boolean } = {}): Promise<boolean> {
    const entry = this.registry.get(tenant, pluginId);
    if (entry !== undefined) {
      const callbacks = entry.hooks.get('plugin.disabled') ?? [];
      await this.hooks.dispatchAction('plugin.disabled', tenant, { tenant, plugin: pluginId }, callbacks.map((fn) => ({ pluginId, fn })));
    }
    const removed = this.registry.remove(tenant, pluginId);
    this.namespaces.delete(`${tenant}\u0000${pluginId}`);
    const db = openAdminWrite(this.sitePath(tenant), 5000);
    try {
      db.prepare('UPDATE cms_plugin_installed SET enabled = 0 WHERE plugin_id = ?').run(pluginId);
    } finally {
      db.close();
    }
    if (opts.audit !== false) this.options.audit?.('plugin.disable', pluginId, { tenant, was_active: removed !== undefined });
    return removed !== undefined;
  }

  /** The hook-failure half of §13.3.6: three failures in 60 s disables, and says so. */
  private onHookFailure(failure: HookFailure): void {
    const count = this.hooks.failuresInWindow(failure.tenant, failure.plugin);
    if (count < 3) return;
    this.registry.remove(failure.tenant, failure.plugin);
    this.namespaces.delete(`${failure.tenant}\u0000${failure.plugin}`);
    const db = openAdminWrite(this.sitePath(failure.tenant), 5000);
    try {
      this.markFailed(
        db,
        failure.plugin,
        `SKW_E_PL_${failure.reason.toUpperCase()}`,
        `${failure.plugin} failed ${count} times in 60 s (last: ${failure.hook}) and was disabled`,
        failure.tenant,
      );
    } finally {
      db.close();
    }
  }

  /**
   * Boot: activate what the rows say is enabled, and **never import what they say is not**.
   *
   * This is the recovery path (§13.3.6 item 3): `skwctl plugin disable <id> --tenant <key>`
   * writes the flag, and a box that will not finish booting is recoverable from a shell without
   * a working app. That is the only reason the flag is read from the database at load time
   * rather than from memory.
   */
  async boot(): Promise<{ tenant: string; plugin: string; ok: boolean; error?: string }[]> {
    const out: { tenant: string; plugin: string; ok: boolean; error?: string }[] = [];
    const tenantsDir = join(this.options.dataDir, 'tenants');
    if (!existsSync(tenantsDir)) return out;
    const { readdirSync } = await import('node:fs');
    for (const tenant of readdirSync(tenantsDir)) {
      const site = this.sitePath(tenant);
      if (!existsSync(site)) continue;
      for (const row of this.enabledRows(tenant)) {
        try {
          await this.enable(tenant, row.plugin_id);
          out.push({ tenant, plugin: row.plugin_id, ok: true });
        } catch (err) {
          out.push({ tenant, plugin: row.plugin_id, ok: false, error: err instanceof Error ? err.message : String(err) });
        }
      }
    }
    return out;
  }

  private enabledRows(tenant: string): PluginRow[] {
    let db: Database.Database | null = null;
    try {
      db = openAdminWrite(this.sitePath(tenant), 5000);
      const table = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cms_plugin_installed'`).get();
      if (table === undefined) return [];
      const columns = (db.pragma('table_info(cms_plugin_installed)') as { name: string }[]).map((c) => c.name);
      const status = columns.includes('status') ? 'status' : `'enabled' AS status`;
      return db
        .prepare(
          `SELECT plugin_id, version, manifest_json, root_hash, enabled, signature_state, test_report_sha, ${status}
           FROM cms_plugin_installed WHERE enabled = 1 ORDER BY id`,
        )
        .all() as PluginRow[];
    } catch {
      return [];
    } finally {
      db?.close();
    }
  }

  /**
   * Reconcile the running registry with the tenant's rows — **one SELECT, then work only if it
   * is needed**. This is what makes `skwctl plugin enable|disable` take effect on the next
   * request with no restart: `skwctl` runs in another process, so the app cannot be told; it
   * has to look.
   *
   * It is also where "enable is when code starts running" is literally true: a row that became
   * `enabled=1` since the last request is imported *here*, which means the revocation check in
   * `load()` runs at that moment and not only at install.
   */
  async sync(tenant: string): Promise<void> {
    let rows: PluginRow[];
    try {
      rows = this.enabledRows(tenant);
    } catch {
      return;
    }
    const seen = new Set<string>();
    for (const row of rows) {
      seen.add(row.plugin_id);
      if (this.registry.has(tenant, row.plugin_id)) continue;
      if (this.failed.has(`${tenant}\u0000${row.plugin_id}`)) continue;
      try {
        await this.enable(tenant, row.plugin_id);
      } catch {
        /* markFailed already recorded the notice; the request continues without the hooks */
      }
    }
    for (const entry of this.registry.plugins(tenant)) {
      if (seen.has(entry.pluginId)) continue;
      // The row went away or was disabled by another process. Prune, quietly: the operator's
      // command is the audit event, not this process noticing it.
      await this.disable(tenant, entry.pluginId, { audit: false });
    }
  }

  /** A render's per-request facade. The context is closed by the caller on response end. */
  makeContext(tenant: string, pluginId: string, mode: 'render' | 'endpoint' | 'admin', db: Database.Database, audit?: (action: string, detail: Record<string, unknown>) => void): PluginContext {
    return makePluginContext({
      db,
      tenant,
      plugin: pluginId,
      mode,
      emailMode: this.options.emailMode,
      log: this.options.log,
      audit,
      now: this.options.now,
    });
  }

  /** For the admin list and for a gate: what is loaded right now. */
  describe(tenant: string): ReturnType<PluginRegistry['describe']> {
    return this.registry.describe(tenant);
  }

  /** The endpoint handler for one (tenant, plugin, method, name), or undefined. */
  endpoint(tenant: string, pluginId: string, method: string, name: string) {
    return this.registry.endpoint(tenant, pluginId, name, method);
  }

  /** Uninstall's first act: drain, then the caller does the archive-and-drop (§13.3.8). */
  async uninstallBegin(tenant: string, pluginId: string): Promise<void> {
    await this.drain(tenant);
    await this.disable(tenant, pluginId, { audit: false });
  }

  /** A digest of the package on disk, for a report that wants to name the bytes it loaded. */
  rootOf(tenant: string, pluginId: string): string | null {
    try {
      return packageRootHash(packageDir(this.pluginsRoot(), pluginId)).root;
    } catch {
      return null;
    }
  }

  /** Stable identity for a loaded namespace, so a gate can prove re-enable made a new module. */
  namespaceDigest(tenant: string, pluginId: string): string | null {
    const ns = this.namespaces.get(`${tenant}\u0000${pluginId}`);
    if (ns === undefined) return null;
    return createHash('sha256').update(String(Object.keys(ns as object).sort().join(','))).digest('hex').slice(0, 16);
  }
}
