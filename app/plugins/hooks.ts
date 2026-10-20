/**
 * The hook surface — six filters, six actions, and what a return value may change (§13.3.4).
 *
 * A filter's return value replaces **only the named value**. Status, headers, `Set-Cookie`,
 * redirects and the route are not in the signature and cannot be produced by returning
 * something clever — which is why `download.authorize` is absent: a hook that could grant a
 * paid download is a hook that turns a plugin bug into a revenue leak.
 *
 * The five rules, and where each one lives:
 *
 *  1. **Only the named value.** `dispatchFilter` returns the value; the caller writes it into
 *     the one place it came from. There is no response object in this file to mutate.
 *  2. **`undefined`/`null` means "no change"** — pass the original through. It never means
 *     "delete" and never means "empty string": a plugin that wants to empty a value returns `''`.
 *  3. **A wrong type is a failure, not a coercion.** The original is used, the hook is skipped
 *     for this dispatch, and the failure counts toward auto-disable. A `Promise` of the wrong
 *     type is the same failure — the race below resolves it first and then the type check runs.
 *  4. **A throw is caught here.** The request continues with the value passed in; a page never
 *     500s because a plugin filter did.
 *  5. **Registration order, one after another, awaited.** A hook may not call another hook
 *     re-entrantly (same tenant, same hook, already on the stack): the inner call is refused
 *     and counted, so a filter cannot recurse the render path into a stack overflow.
 *
 * ## The timeout, said out loud
 *
 * Every dispatch is `await Promise.race` against `SKW_PLUGIN_HOOK_TIMEOUT_MS` (default 2000).
 * That race catches **a promise that never settles**: an async hang costs one request and the
 * timeout reclaims it. It does **not** catch a synchronous infinite loop, because the timer
 * needs the event loop that the loop is blocking. There is no watchdog, no worker thread, no
 * `vm.Script` timeout and no signal that can interrupt a running function in the same thread.
 * This is the accepted cost of the model and nothing in this file mitigates it (§13.3.6); a
 * document that implies otherwise is lying to the operator who has to explain the outage.
 */
import { hookKind, FILTER_HOOKS, ACTION_HOOKS, HOOK_HTML_MAX, type HookName } from './manifest.ts';
import type { HookCall, HookFn } from './registry.ts';

export const HOOK_TIMEOUT_MS = Number(process.env.SKW_PLUGIN_HOOK_TIMEOUT_MS ?? 2000);

/** Three failures within 60 s for one (tenant, plugin) is auto-disable (§13.3.6). */
export const FAILURE_THRESHOLD = 3;
export const FAILURE_WINDOW_MS = 60_000;

export type FailureReason = 'throw' | 'wrong_type' | 'timeout' | 'reentrant' | 'undeclared_capability' | 'bad_value' | 'undeclared_table';

export interface HookFailure {
  tenant: string;
  plugin: string;
  hook: string;
  reason: FailureReason;
  detail: Record<string, unknown>;
  atMs: number;
}

export interface HookBusOptions {
  /** Failures, after the counter has decided. The runtime marks a failed plugin disabled here. */
  onFailure: (failure: HookFailure) => void;
  /** One line per dispatch outcome. Off by default. */
  log?: ((line: string) => void) | undefined;
  now?: (() => number) | undefined;
  timeoutMs?: number | undefined;
}

/** The value types each filter may hand back. A filter not listed accepts its own shape only. */
const STRING_FILTERS = new Set<string>(['content.render.html', 'page.head', 'asset.url']);

interface CallbackOnStack {
  tenant: string;
  hook: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `asset.url`: the URL emitted for one asset must be root-relative or `https://` absolute.
 * Anything else — `javascript:`, `//evil`, a relative `x.png` that resolves against the
 * current path — is the original used and the hook counted as failed (§13.3.4's row).
 */
export function acceptedAssetUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value === '') return false;
  if (value.length > 2048) return false;
  if (value.startsWith('/') && !value.startsWith('//')) return true;
  if (/^https:\/\/[a-z0-9]/i.test(value)) return true;
  return false;
}

export class HookBus {
  private readonly options: HookBusOptions;
  /** Failure timestamps, keyed `tenant\0plugin`, pruned to the window on read. */
  private readonly failures = new Map<string, number[]>();
  /** (tenant, hook) pairs currently on the stack — rule 5's guard. */
  private readonly stack: CallbackOnStack[] = [];

  constructor(options: HookBusOptions) {
    this.options = options;
  }

  /** How many failures this (tenant, plugin) has inside the window. */
  failuresInWindow(tenant: string, plugin: string): number {
    const key = `${tenant}\u0000${plugin}`;
    const now = (this.options.now ?? Date.now)();
    const kept = (this.failures.get(key) ?? []).filter((at) => now - at <= FAILURE_WINDOW_MS);
    this.failures.set(key, kept);
    return kept.length;
  }

  /** Record one failure and tell the runtime — which owns "mark failed, disable, notice". */
  private fail(tenant: string, plugin: string, hook: string, reason: FailureReason, detail: Record<string, unknown>): void {
    const now = (this.options.now ?? Date.now)();
    const key = `${tenant}\u0000${plugin}`;
    const list = [...(this.failures.get(key) ?? []), now];
    this.failures.set(key, list);
    this.options.log?.(`hook failure plugin=${plugin} tenant=${tenant} hook=${hook} reason=${reason} count=${list.length}`);
    this.options.onFailure({ tenant, plugin, hook, reason, detail, atMs: now });
  }

  /** Clear a (tenant, plugin)'s history: a successful activation is entitled to a fresh count. */
  reset(tenant: string, plugin: string): void {
    this.failures.delete(`${tenant}\u0000${plugin}`);
  }

  /**
   * One filter. `callbacks` is the frozen snapshot the dispatch took at the top; `value` is
   * what the caller is prepared to receive back. The return is always a usable value: the
   * original when anything went wrong.
   */
  async dispatchFilter<T>(
    hook: string,
    tenant: string,
    call: HookCall,
    value: T,
    callbacks: readonly { pluginId: string; fn: HookFn }[],
    /** `form.validate`'s core refusal: `ok:true` from a plugin cannot resurrect it. */
    context?: { coreRefused?: boolean; declaredScreens?: (screen: string) => boolean },
  ): Promise<T> {
    if (hookKind(hook) !== 'filter') {
      throw new Error(`SKW_E_PL_REJECTED: ${hook} is not a filter`);
    }
    let current: unknown = value;
    for (const { pluginId, fn } of callbacks) {
      if (this.stack.some((frame) => frame.tenant === tenant && frame.hook === hook)) {
        // Rule 5: refused and counted, and the value keeps flowing unchanged.
        this.fail(tenant, pluginId, hook, 'reentrant', { value: '<on stack>' });
        continue;
      }
      this.stack.push({ tenant, hook });
      let result: unknown;
      let threw = false;
      let throwDetail: unknown;
      try {
        result = await this.withTimeout(() => fn(call as unknown as HookCall, current), hook, tenant, pluginId);
      } catch (err) {
        threw = true;
        result = undefined;
        throwDetail = err instanceof Error ? err.message : String(err);
      } finally {
        this.stack.pop();
      }
      if (threw) {
        const timedOut = typeof throwDetail === 'string' && throwDetail.includes('SKW_E_PL_HOOK_TIMEOUT');
        this.fail(tenant, pluginId, hook, timedOut ? 'timeout' : 'throw', { error: String(throwDetail).slice(0, 300) });
        continue;
      }
      // Rule 2: no change.
      if (result === undefined || result === null) continue;
      const accepted = this.accept(hook, result, current, pluginId, tenant, context);
      if (accepted === REJECTED) continue;
      current = accepted;
    }
    return current as T;
  }

  /**
   * One action. The return value is discarded — always; `void` in the signature, `void` here.
   * Runs in registration order, awaited, one try/catch per callback.
   */
  async dispatchAction(hook: string, tenant: string, call: HookCall, callbacks: readonly { pluginId: string; fn: HookFn }[]): Promise<void> {
    if (hookKind(hook) !== 'action') throw new Error(`SKW_E_PL_REJECTED: ${hook} is not an action`);
    for (const { pluginId, fn } of callbacks) {
      if (this.stack.some((frame) => frame.tenant === tenant && frame.hook === hook)) {
        this.fail(tenant, pluginId, hook, 'reentrant', {});
        continue;
      }
      this.stack.push({ tenant, hook });
      try {
        await this.withTimeout(() => fn(call as unknown as HookCall), hook, tenant, pluginId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.fail(tenant, pluginId, hook, message.includes('SKW_E_PL_HOOK_TIMEOUT') ? 'timeout' : 'throw', {
          error: message.slice(0, 300),
        });
      } finally {
        this.stack.pop();
      }
    }
  }

  /**
   * Rule 3, per hook: a wrong type is a failure, not a coercion. Each branch returns either the
   * value to carry forward, or `REJECTED` — a sentinel meaning "keep `current` and count it".
   */
  private accept(
    hook: string,
    result: unknown,
    current: unknown,
    pluginId: string,
    tenant: string,
    context?: { coreRefused?: boolean; declaredScreens?: (screen: string) => boolean },
  ): unknown {
    if (STRING_FILTERS.has(hook)) {
      if (typeof result !== 'string') {
        this.fail(tenant, pluginId, hook, 'wrong_type', { expected: 'string', got: typeof result });
        return REJECTED;
      }
      if (hook === 'page.head' && Buffer.byteLength(result, 'utf8') > HOOK_HTML_MAX) {
        this.fail(tenant, pluginId, hook, 'bad_value', { bytes: Buffer.byteLength(result, 'utf8'), limit: HOOK_HTML_MAX });
        return REJECTED;
      }
      if (hook === 'asset.url' && !acceptedAssetUrl(result)) {
        // §13.3.4's own words: "else the original is used and the hook counts as failed".
        this.fail(tenant, pluginId, hook, 'bad_value', { url: String(result).slice(0, 120) });
        return REJECTED;
      }
      return result;
    }
    if (hook === 'form.validate') {
      if (!isPlainObject(result) || typeof result.ok !== 'boolean') {
        this.fail(tenant, pluginId, hook, 'wrong_type', { expected: '{ok:boolean}', got: typeof result });
        return REJECTED;
      }
      if (result.ok === true && context?.coreRefused === true) {
        // "May not accept one core refused: core's own rules run first and `ok:true` cannot
        // resurrect them." The refusal stands and the attempt is a failure.
        this.fail(tenant, pluginId, hook, 'bad_value', { reason: 'ok_true_after_core_refusal' });
        return REJECTED;
      }
      if (result.ok === false && !Array.isArray(result.errors)) {
        this.fail(tenant, pluginId, hook, 'wrong_type', { expected: 'errors[] on ok:false' });
        return REJECTED;
      }
      return result;
    }
    if (hook === 'admin.menu') {
      if (!Array.isArray(result)) {
        this.fail(tenant, pluginId, hook, 'wrong_type', { expected: 'array', got: typeof result });
        return REJECTED;
      }
      // "An entry pointing anywhere else is dropped." Dropped, not a failure: the plugin may
      // legitimately build a menu for screens it declared, and a stray entry is not an attack.
      //
      // The rule applies to what the filter **added**. Core's own entries were not the filter's
      // to justify and are kept by identity (an href it was handed), or the first plugin to
      // implement `admin.menu` would silently delete the operator's whole menu — which is the
      // failure mode this row exists to prevent, not to cause.
      const wasHanded = new Set<string>(
        Array.isArray(current) ? (current as unknown[]).flatMap((e) => (isPlainObject(e) && typeof e.href === 'string' ? [e.href] : [])) : [],
      );
      const kept = result.filter((entry) => {
        if (!isPlainObject(entry)) return false;
        const href = typeof entry.href === 'string' ? entry.href : '';
        if (wasHanded.has(href)) return true;
        if (context?.declaredScreens === undefined) return false;
        return context.declaredScreens(href);
      });
      return kept;
    }
    if (hook === 'mail.template') {
      if (!isPlainObject(result)) {
        this.fail(tenant, pluginId, hook, 'wrong_type', { expected: 'vars object', got: typeof result });
        return REJECTED;
      }
      return result;
    }
    // A filter name with no rule is a filter this file does not know. Refuse to pass a value
    // through a rule nobody wrote.
    this.fail(tenant, pluginId, hook, 'wrong_type', { expected: 'known filter', got: hook });
    return REJECTED;
  }

  /**
   * The race. It reclaims a promise that never settles, and it cannot reclaim a synchronous
   * loop — see the block at the top of this file, which is the sentence that matters.
   */
  private async withTimeout(fn: () => unknown, hook: string, tenant: string, pluginId: string): Promise<unknown> {
    const timeout = this.options.timeoutMs ?? HOOK_TIMEOUT_MS;
    let timer: NodeJS.Timeout | undefined;
    const guard = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`SKW_E_PL_HOOK_TIMEOUT: ${pluginId}'s ${hook} did not settle within ${timeout} ms on ${tenant}`));
      }, timeout);
      timer.unref?.();
    });
    try {
      return await Promise.race([Promise.resolve().then(fn), guard]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

const REJECTED = Symbol('rejected');

/** The twelve, exposed for the gate that asserts the surface is frozen and exactly twelve. */
export const HOOKS = { filters: FILTER_HOOKS, actions: ACTION_HOOKS } as const;

export type { HookName };
