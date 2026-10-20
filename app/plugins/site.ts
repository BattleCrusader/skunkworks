/**
 * The **call-site door** for the twelve hooks (§13.3.4).
 *
 * `app/plugins/hooks.ts` dispatches; it does not know that a render, a form intake, a
 * redemption or a login exists. This module is the one place a *host* module reaches the
 * attached `PluginRuntime`, so a call site reads as one line and there is exactly one
 * answer to "what happens when no plugins are attached?" — the value passes through.
 *
 * Why an attach point rather than a constructor argument everywhere: the runtime is built
 * once, in step 6 of `app/main.ts` (§2.3), after the admin surface and the download plane
 * exist. Threading it through every constructor would mean every one of those objects can
 * be constructed with no runtime and would have to carry a `null` branch; instead the
 * branch is here, once, and it is the same branch in every call site.
 *
 * **The one rule this file must not break.** A filter with no callbacks is **not** a
 * dispatch: it is the value, unchanged, with no failure counter, no snapshot and no
 * allocation. A box with no plugins pays one `null` check per call site.
 *
 * `declaredScreens` is the `admin.menu` rule from §13.3.4's row — "an entry pointing
 * anywhere else is dropped". The answer is derived from what is **in the registry right
 * now** (`entry.screens`), not from the manifest's claim, because the registry is where a
 * screen exists and a manifest is where one was requested. A plugin whose activation
 * refused a screen therefore cannot link to it either.
 */
import type Database from 'better-sqlite3';

import type { HookCall } from './registry.ts';
import type { PluginRuntime } from './runtime.ts';

let attached: PluginRuntime | null = null;

/** Called once by `buildApp` after step 6. `null` detaches (a gate that wants no plugins). */
export function attachPluginRuntime(runtime: PluginRuntime | null): void {
  attached = runtime;
}

export function attachedRuntime(): PluginRuntime | null {
  return attached;
}

/**
 * The admin URL a declarative screen answers on. One function, because the menu filter
 * and the screen route must agree or a plugin's own link is dropped by its own rule.
 */
export function screenHref(tenant: string, path: string): string {
  return `/admin/t/${encodeURIComponent(tenant)}${path}`;
}

/** Every screen path the tenant's **loaded** plugins registered. */
export function declaredScreens(runtime: PluginRuntime, tenant: string): Set<string> {
  const out = new Set<string>();
  for (const entry of runtime.registry.plugins(tenant)) {
    for (const screen of entry.screens.values()) out.add(screenHref(tenant, screen.path));
  }
  return out;
}

export interface SiteFilterOptions {
  /**
   * `form.validate`'s core refusal: core's own rules ran first, so `ok:true` from a plugin
   * can be refused but cannot resurrect what core refused (§13.3.4's row).
   */
  coreRefused?: boolean;
}

/**
 * Dispatch one filter at a host call site. Always returns a usable value: the original
 * when nothing is attached, nothing is registered, or every callback failed.
 */
export async function filterSite<T>(
  hook: string,
  tenant: string,
  call: HookCall,
  value: T,
  options: SiteFilterOptions = {},
): Promise<T> {
  const runtime = attached;
  if (runtime === null) return value;
  const callbacks = runtime.registry.hooksFor(tenant, hook);
  if (callbacks.length === 0) return value;
  const screens = hook === 'admin.menu' ? declaredScreens(runtime, tenant) : undefined;
  return runtime.hooks.dispatchFilter<T>(hook, tenant, call, value, callbacks, {
    ...(options.coreRefused === undefined ? {} : { coreRefused: options.coreRefused }),
    ...(screens === undefined ? {} : { declaredScreens: (href: string) => screens.has(href) }),
  });
}

/**
 * Dispatch one action. The return value is discarded by construction — this function
 * returns `void`, so a call site cannot accidentally use a plugin's return as an outcome.
 */
export async function actionSite(hook: string, tenant: string, call: HookCall): Promise<void> {
  const runtime = attached;
  if (runtime === null) return;
  const callbacks = runtime.registry.hooksFor(tenant, hook);
  if (callbacks.length === 0) return;
  await runtime.hooks.dispatchAction(hook, tenant, call, callbacks);
}

/**
 * Reconcile the running registry with the tenant's rows (§13.3.8).
 *
 * Every request-entry call site calls this once **before** its first dispatch, because
 * `skwctl plugin enable|disable` runs in another process: the app cannot be told, it has to
 * look. It is one SELECT per plugin-bearing request (§13.4 item 6's budget, measured in
 * `docs/build/S5-inprocess-report.md` §9).
 */
export async function syncSite(tenant: string): Promise<void> {
  const runtime = attached;
  if (runtime === null) return;
  await runtime.sync(tenant);
}

/** True when at least one plugin is loaded for this tenant — the cheap "is it worth it". */
export function hasPlugins(tenant: string): boolean {
  return attached !== null && attached.registry.plugins(tenant).length > 0;
}

/** A connection for a call site that needs one to build a facade (endpoints, screens). */
export type SiteDb = Database.Database;
