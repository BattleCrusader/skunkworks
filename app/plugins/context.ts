/**
 * The per-request scope: which handle, bound to what (§13.3.5), and **the one capability
 * check** that is left (§13.3.7 / §13.1a).
 *
 * A context is built **per request**, frozen, and contains no `Database`, no `control` handle,
 * no filesystem path and no `process.env`. It closes over a tenant-bound connection and a
 * `closed` flag; both are released on response end. A plugin that stashes the object and calls
 * it later gets `SKW_E_PL_CONTEXT_ENDED` rather than a handle into a reused connection — the
 * one failure mode that would otherwise turn a cache into a cross-tenant read.
 *
 * ## The layer, and why it is written the way it is
 *
 * The runner used to refuse an operation outside `binding.granted` *before* the host was
 * asked, and the host validated the operation against the manifest. Two layers, one value,
 * and the second not depending on the first. **There is one layer now** (§13.3.7), so it has
 * to be worth two:
 *
 *   - Every capability crossing is a facade method.
 *   - Its **first act** is to read the grant from `cms_plugin_installed.manifest_json` **inside
 *     the current request** — not from a manifest object the plugin holds, not from a value the
 *     plugin passes — and compare it to the operation being performed.
 *   - A miss is `SKW_E_PL_REJECTED`, raised before the operation's connection work begins, and
 *     audited, because the attempt is the signal.
 *
 * `grant` is deliberately **not** a field of `PluginContextDeps`: if it were, a caller could
 * hand the facade a grant it did not read, and the check would be a check of the caller's
 * honesty. The only grant this file can see is the row's.
 *
 * ## What the facade cannot express
 *
 * `ATTACH` is refused **structurally**: there is no method that takes SQL, so `ATTACH`,
 * `DETACH` and `PRAGMA` are not expressible through it. On top of that, the connection a call
 * runs on is asserted to have exactly one attached database (`PRAGMA database_list` = `main`)
 * before the statement is issued; a second entry refuses the call with `SKW_E_PL_REJECTED` and
 * disables the plugin, because the only way it can appear is a path we did not write.
 *
 * ## Exclusive witness
 *
 * Exclusive witness: test/plugin-scope.test.ts S3. Delete the `grant.includes` comparison in
 * `assertCapability` and S3 goes red naming the undeclared table, while S1–S2 (the tenant
 * binding, which never consults the grant) stay green. That mutation is recorded in
 * `docs/build/S5-inprocess-report.md` §4 with the file's SHA-256 before and after. A single
 * layer with an exclusive witness is a gate; a single layer with a test that would pass either
 * way is a comment.
 */
import { createHash, randomBytes } from 'node:crypto';

import type Database from 'better-sqlite3';

import { AppError } from '../errors.ts';
import { hostOp } from './ops.ts';
import { filterSite } from './site.ts';
import type { Manifest } from './manifest.ts';
import type { HookCall } from './registry.ts';

/** §13.3.5's four contexts. The mode decides which methods exist at all. */
export type ContextMode = 'render' | 'endpoint' | 'admin' | 'activation';

/**
 * Facade method → the capability the manifest must declare (§13.3.1: capabilities are
 * disclosure **and** the list of facade methods the host will answer).
 */
export const METHOD_CAPABILITY: Readonly<Record<string, string>> = Object.freeze({
  'store.read': 'store.query',
  'store.count': 'store.count',
  'store.write': 'store.insert',
  'store.update': 'store.update',
  'store.delete': 'store.delete',
  'settings.get': 'settings.get',
  'settings.has': 'settings.has',
  'settings.set': 'settings.set',
  'assets.resolve': 'assets.resolve',
  'mail.send': 'mail.send',
  'log.write': 'log.write',
  'util.now': 'util.now',
  'util.random': 'util.random',
  'util.hash': 'util.hash',
});

/** What every context gets: read-only against the tenant, plus the four local facilities. */
const READ_METHODS = [
  'store.read',
  'store.count',
  'settings.get',
  'settings.has',
  'assets.resolve',
  'mail.send',
  'log.write',
  'util.now',
  'util.random',
  'util.hash',
] as const;

/** What `endpoint` and `admin` add. `render` does not have these keys at all. */
const WRITE_METHODS = ['store.write', 'store.update', 'store.delete', 'settings.set'] as const;

export type FacadeMethod = (typeof READ_METHODS)[number] | (typeof WRITE_METHODS)[number];

export interface PluginFacade {
  readonly 'store.read': (table: string, args?: Record<string, unknown>) => unknown;
  readonly 'store.count': (table: string, args?: Record<string, unknown>) => unknown;
  readonly 'store.write': (table: string, row: Record<string, unknown>) => unknown;
  readonly 'store.update': (table: string, id: number, patch: Record<string, unknown>) => unknown;
  readonly 'store.delete': (table: string, id: number) => unknown;
  readonly 'settings.get': (key: string) => unknown;
  readonly 'settings.has': (key: string) => unknown;
  readonly 'settings.set': (key: string, value: unknown) => unknown;
  readonly 'assets.resolve': (key: string) => unknown;
  readonly 'mail.send': (args: Record<string, unknown>) => unknown;
  readonly 'log.write': (line: unknown) => void;
  readonly 'util.now': () => string;
  readonly 'util.random': (bytes?: number) => string;
  readonly 'util.hash': (value: unknown) => string;
}

/** A refusable call: the code is one §4.3 already maps, never a new one invented here. */
function refuse(code: string, message: string, detail: Record<string, unknown> = {}): never {
  throw new AppError(code, message, detail);
}

export interface PluginContextDeps {
  /** The request's connection: `render-read` for render, `admin-write` for endpoints/screens. */
  db: Database.Database;
  /** The tenant this request resolved. Closed over; there is no tenant parameter anywhere. */
  tenant: string;
  plugin: string;
  mode: ContextMode;
  emailMode: 'off' | 'smtp';
  /** One line per refusal and per call, for the operator. Off by default. */
  log?: ((line: string) => void) | undefined;
  /** The audit row the refusal is written to (§13.3.5: "refused and audited"). */
  audit?: ((action: string, detail: Record<string, unknown>) => void) | undefined;
  /** `Date.now`, injectable so a gate can pin it. */
  now?: (() => number) | undefined;
}

export interface PluginContext {
  readonly tenant: string;
  readonly plugin: string;
  readonly mode: ContextMode;
  readonly facade: PluginFacade;
  /** The hook-call base: `{tenant}` plus whatever the dispatch adds. Never a facade. */
  hookCall(extra: Record<string, unknown>): HookCall;
  /** Release: every later call refuses `SKW_E_PL_CONTEXT_ENDED`. Called on response end. */
  close(): void;
  readonly closed: boolean;
}

interface GrantRow {
  manifest_json: string;
  enabled: number;
  signature_state: string;
}

/**
 * The grant, read from **this tenant's row**, inside this call.
 *
 * A row that is absent, disabled or `failed` is not "an empty grant": it is
 * `SKW_E_PL_UNAVAILABLE`, because a package whose code is somehow still holding a context
 * after being disabled must be told that, not told "you lack a capability".
 */
function readGrant(db: Database.Database, plugin: string): string[] {
  const table = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cms_plugin_installed'`).get();
  if (table === undefined) {
    refuse('SKW_E_PL_UNAVAILABLE', `this tenant has no plugin table, so ${plugin} cannot be running`, { plugin });
  }
  const row = db
    .prepare('SELECT manifest_json, enabled, signature_state FROM cms_plugin_installed WHERE plugin_id = ?')
    .get(plugin) as GrantRow | undefined;
  if (row === undefined) {
    refuse('SKW_E_PL_UNAVAILABLE', `no plugin ${JSON.stringify(plugin)} is installed for this tenant`, { plugin });
  }
  if (row.enabled !== 1) {
    refuse('SKW_E_PL_UNAVAILABLE', `plugin ${plugin} is installed but not enabled`, { plugin });
  }
  const manifest = JSON.parse(row.manifest_json) as { capabilities?: unknown };
  return Array.isArray(manifest.capabilities) ? manifest.capabilities.map(String) : [];
}

/**
 * §13.3.5: the connection a plugin call runs on has exactly one attached database.
 *
 * Not a defence against a hostile plugin — it can open its own handle (§13.3.7) — but the only
 * way a second entry can appear on *this* connection is a path we did not write, so it is
 * treated as a fault of the facade and the package is disabled by the caller.
 */
function assertOneDatabase(db: Database.Database, plugin: string): void {
  const rows = db.pragma('database_list') as { name: string }[];
  const names = rows.map((r) => String(r.name));
  if (names.length !== 1 || names[0] !== 'main') {
    throw new AppError(
      'SKW_E_PL_REJECTED',
      `${plugin}: the plugin connection has ${names.join(', ') || 'no'} attached databases, not exactly main — refusing the call and disabling the plugin`,
      { plugin, attached: names, disable_plugin: true },
    );
  }
}

/** A tenant argument is refused, and the attempt is the signal (§13.3.5). */
function noTenantArgument(args: Record<string, unknown> | undefined, method: string, plugin: string, audit: PluginContextDeps['audit']): void {
  if (args === undefined || args === null) return;
  if (!Object.prototype.hasOwnProperty.call(args, 'tenant')) return;
  audit?.('plugin.tenant_argument', { plugin, method, tenant: String(args.tenant), argument: String(args.tenant) });
  refuse('SKW_E_PL_REJECTED', `${plugin} passed a tenant to ${method}; the tenant is bound by the request and there is no parameter for it`, {
    plugin,
    method,
  });
}

export function makePluginContext(deps: PluginContextDeps): PluginContext {
  const now = deps.now ?? Date.now;
  let closed = false;

  /**
   * **The capability crossing.** Every facade method starts here. Order is the contract:
   * closed → grant read from the row (inside this request) → comparison → `database_list`
   * → the operation. Nothing touches the connection for the operation before the verdict.
   */
  function assertCapability(method: string): string {
    if (closed) {
      throw new Error(
        `SKW_E_PL_CONTEXT_ENDED: ${deps.plugin} called ${method} after the request that built its context ended`,
      );
    }
    const capability = METHOD_CAPABILITY[method];
    if (capability === undefined) {
      // A method with no capability is a method the facade does not have. Reaching this is a
      // programming error in *this* file, so it refuses rather than guessing a grant.
      refuse('SKW_E_PL_REJECTED', `${method} is not a facade method`, { plugin: deps.plugin, method });
    }
    const grant = readGrant(deps.db, deps.plugin);
    // Exclusive witness: test/plugin-scope.test.ts S3 — delete this comparison and S3 goes red
    // naming the undeclared table, while S1–S2 (tenant binding) stay green (§13.1a).
    if (!grant.includes(capability)) {
      deps.audit?.('plugin.capability_rejected', { plugin: deps.plugin, method, capability });
      deps.log?.(`capability rejected plugin=${deps.plugin} tenant=${deps.tenant} method=${method} capability=${capability}`);
      refuse('SKW_E_PL_REJECTED', `${method} needs capability ${capability}, which ${deps.plugin} did not declare`, {
        plugin: deps.plugin,
        method,
        capability,
        declared: grant,
      });
    }
    assertOneDatabase(deps.db, deps.plugin);
    return capability;
  }

  function manifestOf(): Manifest {
    const row = deps.db.prepare('SELECT manifest_json FROM cms_plugin_installed WHERE plugin_id = ?').get(deps.plugin) as
      | { manifest_json: string }
      | undefined;
    if (row === undefined) refuse('SKW_E_PL_UNAVAILABLE', `no plugin ${JSON.stringify(deps.plugin)} is installed for this tenant`, { plugin: deps.plugin });
    return JSON.parse(row.manifest_json) as Manifest;
  }

  function op(name: string, args: Record<string, unknown>): unknown {
    const manifest = manifestOf();
    return hostOp({ db: deps.db, tenant: deps.tenant, plugin: deps.plugin, manifest, emailMode: deps.emailMode }, name, args);
  }

  const facade: Record<string, unknown> = {};

  facade['store.read'] = (table: string, args: Record<string, unknown> = {}): unknown => {
    assertCapability('store.read');
    noTenantArgument(args, 'store.read', deps.plugin, deps.audit);
    return op('store.query', { ...args, table });
  };
  facade['store.count'] = (table: string, args: Record<string, unknown> = {}): unknown => {
    assertCapability('store.count');
    noTenantArgument(args, 'store.count', deps.plugin, deps.audit);
    return op('store.count', { ...args, table });
  };
  facade['settings.get'] = (key: string): unknown => {
    assertCapability('settings.get');
    return op('settings.get', { key });
  };
  facade['settings.has'] = (key: string): unknown => {
    assertCapability('settings.has');
    return op('settings.has', { key });
  };
  facade['assets.resolve'] = (key: string): unknown => {
    assertCapability('assets.resolve');
    return op('assets.resolve', { key });
  };
  facade['mail.send'] = async (args: Record<string, unknown> = {}): Promise<unknown> => {
    assertCapability('mail.send');
    noTenantArgument(args, 'mail.send', deps.plugin, deps.audit);
    // §13.3.4, `mail.template`: `{tenant, template, vars} → vars`, dispatched **inside** the
    // host's own send path — the only mail path this product has — so a plugin may add or
    // change template variables and cannot address the message: `to` is checked by
    // `hostOp('mail.send')` after this returns and is not in the filter's signature.
    const template = typeof args.template === 'string' ? args.template : '';
    const vars = args.vars;
    if (template !== '' && typeof vars === 'object' && vars !== null && !Array.isArray(vars)) {
      const hooked = await filterSite<Record<string, unknown>>(
        'mail.template',
        deps.tenant,
        { tenant: deps.tenant, template, vars: { ...(vars as Record<string, unknown>) } },
        vars as Record<string, unknown>,
      );
      return op('mail.send', { ...args, vars: hooked });
    }
    return op('mail.send', args);
  };
  facade['log.write'] = (line: unknown): void => {
    assertCapability('log.write');
    deps.log?.(`plugin=${deps.plugin} tenant=${deps.tenant} ${String(line).slice(0, 500)}`);
  };
  facade['util.now'] = (): string => {
    assertCapability('util.now');
    return new Date(now()).toISOString();
  };
  facade['util.random'] = (bytes = 16): string => {
    assertCapability('util.random');
    const size = Number(bytes);
    if (!Number.isInteger(size) || size < 1 || size > 64) refuse('SKW_E_PL_REJECTED', 'util.random takes 1..64 bytes', { plugin: deps.plugin });
    return randomBytes(size).toString('hex') as string;
  };
  facade['util.hash'] = (value: unknown): string => {
    assertCapability('util.hash');
    return createHash('sha256').update(String(value)).digest('hex');
  };

  // The write half exists on the object **only** for endpoint and admin contexts. `render`
  // does not have the keys — not a method that refuses, an absent property (§13.3.5's
  // "`store.write` is absent from the object, not disabled on it").
  if (deps.mode === 'endpoint' || deps.mode === 'admin') {
    facade['store.write'] = (table: string, row: Record<string, unknown> = {}): unknown => {
      assertCapability('store.write');
      noTenantArgument(row, 'store.write', deps.plugin, deps.audit);
      return op('store.insert', { table, row });
    };
    facade['store.update'] = (table: string, id: number, patch: Record<string, unknown> = {}): unknown => {
      assertCapability('store.update');
      noTenantArgument(patch, 'store.update', deps.plugin, deps.audit);
      return op('store.update', { table, id, patch });
    };
    facade['store.delete'] = (table: string, id: number): unknown => {
      assertCapability('store.delete');
      return op('store.delete', { table, id });
    };
    facade['settings.set'] = (key: string, value: unknown): unknown => {
      assertCapability('settings.set');
      return op('settings.set', { key, value });
    };
  }

  const frozen = Object.freeze(facade) as unknown as PluginFacade;

  return Object.freeze({
    tenant: deps.tenant,
    plugin: deps.plugin,
    mode: deps.mode,
    facade: frozen,
    hookCall(extra: Record<string, unknown>): HookCall {
      return { ...extra, tenant: deps.tenant };
    },
    close(): void {
      closed = true;
    },
    get closed(): boolean {
      return closed;
    },
  });
}

/** The methods a mode has, for the gate that asserts `render` has no write key at all. */
export function facadeMethods(mode: ContextMode): string[] {
  return mode === 'render' || mode === 'activation' ? [...READ_METHODS] : [...READ_METHODS, ...WRITE_METHODS];
}
