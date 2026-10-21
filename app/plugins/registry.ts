/**
 * The registry — one map per tenant, prunable in one operation (§13.3.3, D36).
 *
 *     registry: Map<tenantKey, Map<pluginId, {
 *       hooks: Map<hookName, HookFn[]>, endpoints: Map<'METHOD /path', Handler>,
 *       screens: Map<screenPath, DeclarativeScreen>, activationSeq: number
 *     }>>
 *
 * Four properties, each of which is a sentence in the spec and a line here:
 *
 *  - **Per tenant**, because a plugin is enabled per tenant (§8.6). Tenant A enabling
 *    `contact` must not make it run on tenant B, and a dispatch must never have to ask
 *    "which tenant is this for" — the key already answered.
 *  - **Prunable**, because disable is `delete(tenant, id)` in one operation. There is no
 *    partial unregistration and no path where a disabled plugin's hook still fires: dispatch
 *    reads the map, and a map that has no entry has no callbacks. This is why disable does
 *    not set a flag — a flag is one refactor away from being inverted.
 *  - **Snapshotted on dispatch**: a render takes `snapshot(tenant)` once, at the top, and
 *    iterates a frozen array, so a disable that lands mid-render cannot mutate the array
 *    being iterated. The request finishes on the callbacks it started with, which is the
 *    honest boundary of "disable takes effect immediately" (§13.3.8).
 *  - **Closed to registration after activation**: `closeActivation()` flips a flag on the
 *    recorder, so a hook cannot be added later from a timer or a promise callback. That is
 *    what makes pruning complete rather than best-effort.
 *
 * Nothing here imports a package or touches a database. `runtime.ts` decides *when* an entry
 * exists; this file only holds what exists now.
 */
import { HOOK_NAMES, hookKind, type FieldSpec, type HookName, type TableSpec } from './manifest.ts';

/** The context a plugin's hook callback is called with; `ctx` in §13.3.4's signatures. */
export interface HookCall {
  tenant: string;
  /** The hook's own payload: `{path, page}`, `{form, values}`, `{codeId, assetKey, jti}`, … */
  [key: string]: unknown;
}

export type HookFn = (call: HookCall, value?: unknown) => unknown | Promise<unknown>;

/** An endpoint as the package registered it: the HTTP method, the handler, the declared name. */
export interface RegisteredEndpoint {
  method: 'GET' | 'POST';
  name: string;
  handler: (args: {
    query: Record<string, string>;
    body: string;
    method: string;
    /** The per-request facade (§13.3.5). Every capability crossing starts here. */
    facade: import('./context.ts').PluginFacade;
    ctx: import('./context.ts').PluginContext;
  }) => unknown | Promise<unknown>;
}

export interface DeclarativeScreen {
  /** The admin path, already constrained to a declared table by the activation check. */
  path: string;
  table: string;
  title: string;
  /**
   * S8g: the edit form the package declared for this table, and the columns its list shows.
   * Both are copied from the manifest's `tables` entry, so a screen cannot claim a field the
   * package did not declare — the manifest validator already refused that at install time.
   */
  fields?: FieldSpec[];
  list?: string[];
}

/**
 * S8h: a **block** a package contributes to the page builder.
 *
 * The builder's palette has always been the host's component registry — shipped HTML the host
 * owns (§10.1). A package cannot add markup to it: §10.5 keeps plugin HTML off the tenant's
 * origin, which is why an endpoint answers JSON. What a package *can* do is own data, so a block
 * is a **view over its own declared table** and the host draws it: the package names the table,
 * the columns, the order, the filter and the link shape, and supplies no HTML at all.
 *
 * The editor inserts a marker (`<div data-skw-block="blog/recent-posts">`); the render call
 * replaces that marker with host-generated markup before any plugin filter sees the body.
 */
export interface DeclarativeBlock {
  /** `<plugin>/<name>`, the value in the marker's `data-skw-block` attribute. */
  id: string;
  /** What the palette button says. */
  label: string;
  /** A table the package owns, checked at activation. */
  table: string;
  /** Columns to read, in order. Each must be a column the package declared. */
  columns: string[];
  /** How many rows: 1–20. */
  limit: number;
  /** `desc` (default) or `asc`, on `orderBy`. */
  order?: 'asc' | 'desc';
  /** The column to order by; defaults to the table's primary key. */
  orderBy?: string;
  /** One equality filter, so a block can show published rows only. */
  filter?: { column: string; equals: string };
  /** S8m: up to three equality conditions, ANDed. A menu needs `visible` *and* `menu`. */
  filters?: { column: string; equals: string }[];
  /**
   * `list` (default) is a `<ul>` of titles; `cards` is a wrapper of `<article>`s.
   * Both are drawn by the host, from the same rows.
   */
  layout?: 'list' | 'cards';
  /** A link template, e.g. `/blog/{slug}`. `{column}` is replaced per row, escaped. */
  href?: string;
  /** The column whose value is the link's visible text. Defaults to the first column. */
  labelColumn?: string;
}

/**
 * S8k: a **page** a package can serve, without shipping markup.
 *
 * A blog post is a row, and this CMS serves `cms_page` rows by path — so `/blog/test` was a dead
 * link with a live row behind it. A package now declares the *shape* of a detail page (a pattern,
 * the table, which columns are the slug, the title and the body) and the host renders it through
 * the same shell, nav and filters as any other page. The package still supplies no HTML.
 */
export interface DeclarativePage {
  /** `/blog/{slug}` — one `{column}` placeholder, filled from the row. */
  pattern: string;
  table: string;
  /** The column matched against the placeholder. */
  slugColumn: string;
  titleColumn: string;
  /** The row's body, rendered as text (never parsed as markup). */
  bodyColumn: string;
  /** One equality filter, so only published rows answer. */
  filter?: { column: string; equals: string };
  /** Shown above the body; defaults to the package's own screen title. */
  layout?: 'article';
}

/**
 * S8k: a **form** a package owns, drawn by the host.
 *
 * `/_plugin/<id>/<name>` is JSON by contract (§10.5), so a browser form cannot post to it and then
 * expect a page back. The host therefore draws the form, posts it to **the page's own path**, and
 * forwards the fields to the package's endpoint as JSON — the same split the admin login uses.
 */
export interface DeclarativeForm {
  /** `<plugin>/<name>`; the value the host puts in the form's hidden marker. */
  id: string;
  label: string;
  /** The endpoint the host forwards to: `POST`, and one this package declared. */
  endpoint: string;
  /** What the visitor fills in. The host draws labels, inputs and errors from this. */
  fields: { name: string; label: string; type: 'text' | 'email' | 'textarea'; required?: boolean; maxLength?: number }[];
  /** The sentence a visitor sees after a successful submit. */
  thanks: string;
}

export interface RegistrationSet {
  hooks: Map<string, HookFn[]>;
  endpoints: Map<string, RegisteredEndpoint>;
  screens: Map<string, DeclarativeScreen>;
  blocks: Map<string, DeclarativeBlock>;
  pages: Map<string, DeclarativePage>;
  forms: Map<string, DeclarativeForm>;
}

export interface RegistryEntry extends RegistrationSet {
  pluginId: string;
  version: string;
  /** Monotonic per (tenant, plugin); the cache-buster is derived from it (§13.3.2). */
  activationSeq: number;
  /** Set on the entry so a failure counter and a prune cannot disagree about which load it named. */
  loadedAtMs: number;
}

/** A frozen view of one tenant's hooks: `hook → frozen array of callbacks`. */
export type TenantSnapshot = ReadonlyMap<string, readonly { pluginId: string; fn: HookFn }[]>;

export function emptyRegistrations(): RegistrationSet {
  return {
    hooks: new Map(),
    endpoints: new Map(),
    screens: new Map(),
    blocks: new Map(),
    pages: new Map(),
    forms: new Map(),
  };
}

/**
 * Activation counters, **process-wide**.
 *
 * They outlive an entry (disable→enable must get a new number, §13.3.2) and they are deliberately
 * not an instance field: Node's ESM cache is process-wide, so a counter that resets with a new
 * `PluginRegistry` would hand the next activation the *same* URL and get the cached namespace
 * back — the exact failure the cache-buster exists to prevent. A gate that builds two runtimes
 * in one process found this; production has one, and the fix costs nothing there.
 */
const SEQUENCES = new Map<string, number>();

export class PluginRegistry {
  private readonly tenants = new Map<string, Map<string, RegistryEntry>>();
  /** Activation counters: see `SEQUENCES` above — process-wide, not per registry. */

  /** The entry for one (tenant, plugin), or undefined — the only question dispatch asks. */
  get(tenant: string, pluginId: string): RegistryEntry | undefined {
    return this.tenants.get(tenant)?.get(pluginId);
  }

  has(tenant: string, pluginId: string): boolean {
    return this.tenants.get(tenant)?.has(pluginId) === true;
  }

  /** Every plugin enabled for one tenant, in activation order. */
  plugins(tenant: string): RegistryEntry[] {
    return [...(this.tenants.get(tenant)?.values() ?? [])];
  }

  tenantsWithPlugins(): string[] {
    return [...this.tenants.keys()];
  }

  /**
   * The next activation number for a (tenant, plugin). Read *before* the import so the URL
   * carries the number the entry will be stored with: the cache key and the row must agree,
   * or "re-enable got a new module instance" would be a claim about two different counters.
   *
   * `floor` is the durable half (E-31 item 5 — `cms_plugin_installed.activation_seq`). A new
   * process starts with an empty map; without the floor it would hand `import()` the URL the
   * previous process used and get the already-evaluated namespace back. The number is
   * `max(process, row) + 1`, so two facts can never disagree: the row is never behind the
   * process, and a restart never repeats a number.
   */
  nextActivation(tenant: string, pluginId: string, floor = 0): number {
    const key = `${tenant}\u0000${pluginId}`;
    const next = Math.max(SEQUENCES.get(key) ?? 0, floor) + 1;
    SEQUENCES.set(key, next);
    return next;
  }

  /** The number the last successful activation used. `0` means "never activated here". */
  activationSeq(tenant: string, pluginId: string): number {
    return SEQUENCES.get(`${tenant}\u0000${pluginId}`) ?? 0;
  }

  /** Install (or replace) one entry. Called only by `runtime.ts`, only after activation returned. */
  commit(tenant: string, pluginId: string, version: string, activationSeq: number, registrations: RegistrationSet, nowMs: number): RegistryEntry {
    let perTenant = this.tenants.get(tenant);
    if (perTenant === undefined) {
      perTenant = new Map();
      this.tenants.set(tenant, perTenant);
    }
    const entry: RegistryEntry = { pluginId, version, activationSeq, loadedAtMs: nowMs, ...registrations };
    perTenant.set(pluginId, entry);
    SEQUENCES.set(`${tenant}\u0000${pluginId}`, activationSeq);
    return entry;
  }

  /**
   * Disable: **remove**, in one operation. Returns the entry that was removed, so the caller
   * can fire `plugin.disabled` on the callbacks it had — after the map no longer has them, so
   * a hook that throws in its own teardown cannot resurrect the entry.
   */
  remove(tenant: string, pluginId: string): RegistryEntry | undefined {
    const perTenant = this.tenants.get(tenant);
    if (perTenant === undefined) return undefined;
    const entry = perTenant.get(pluginId);
    perTenant.delete(pluginId);
    if (perTenant.size === 0) this.tenants.delete(tenant);
    return entry;
  }

  /** Uninstall of a tenant: every package of one tenant, gone. */
  pruneTenant(tenant: string): number {
    const perTenant = this.tenants.get(tenant);
    if (perTenant === undefined) return 0;
    const count = perTenant.size;
    this.tenants.delete(tenant);
    return count;
  }

  /**
   * The snapshot a dispatch iterates. One `Map.get` and one array copy per hook that has
   * callbacks; hooks with none allocate nothing, which is the common case on a box with two
   * plugins.
   */
  snapshot(tenant: string): TenantSnapshot {
    const perTenant = this.tenants.get(tenant);
    const out = new Map<string, readonly { pluginId: string; fn: HookFn }[]>();
    if (perTenant === undefined) return out;
    for (const entry of perTenant.values()) {
      for (const [hook, fns] of entry.hooks) {
        if (fns.length === 0) continue;
        const list = out.get(hook) ?? [];
        const next = [...list, ...fns.map((fn) => ({ pluginId: entry.pluginId, fn }))];
        out.set(hook, Object.freeze(next));
      }
    }
    return out;
  }

  /** One hook's callbacks for one tenant, frozen. `[]` when nothing is registered. */
  hooksFor(tenant: string, hook: string): readonly { pluginId: string; fn: HookFn }[] {
    return this.snapshot(tenant).get(hook) ?? Object.freeze([]);
  }

  /** `METHOD /path` → the endpoint, for one tenant. */
  endpoint(tenant: string, pluginId: string, name: string, method: string): RegisteredEndpoint | undefined {
    return this.get(tenant, pluginId)?.endpoints.get(`${method} ${name}`);
  }

  /** For a gate and the admin list: what one tenant has registered, without the closures. */
  describe(tenant: string): { plugin: string; version: string; activation_seq: number; hooks: string[]; endpoints: string[] }[] {
    return this.plugins(tenant).map((entry) => ({
      plugin: entry.pluginId,
      version: entry.version,
      activation_seq: entry.activationSeq,
      hooks: [...entry.hooks.keys()].sort(),
      endpoints: [...entry.endpoints.keys()].sort(),
    }));
  }
}

/**
 * The recorder handed to `activate(ctx)` as part of the context. It is the only way a package
 * can put something in the registry, and it closes when activation returns.
 *
 * `declared` is the manifest's `hooks` list and `declaredTables` the manifest's tables: a
 * registration outside either is refused `SKW_E_PL_REJECTED` naming the hook and the package.
 * That is a **contract check, not containment** (§13.3.1): it makes the install screen able to
 * list what a plugin touches, and it stops an accident. A plugin that wants to do something
 * else does not need this door.
 */
export class ActivationRecorder {
  readonly registrations: RegistrationSet = emptyRegistrations();
  private open = true;
  private readonly declared: Set<string>;
  private readonly declaredTables: Map<string, TableSpec>;
  private readonly pluginId: string;

  constructor(pluginId: string, declared: readonly string[], declaredTables: readonly TableSpec[]) {
    this.pluginId = pluginId;
    this.declared = new Set(declared);
    // S8g: the table spec, not just its name — a screen needs the fields the package declared
    // for that table, and the manifest is where they live.
    this.declaredTables = new Map(declaredTables.map((table) => [table.name, table]));
  }

  get isOpen(): boolean {
    return this.open;
  }

  /** §13.3.3: registration is closed after `closeActivation()`. It never reopens. */
  closeActivation(): void {
    this.open = false;
  }

  on(hook: string, fn: unknown): void {
    if (!this.open) {
      throw new Error(`SKW_E_PL_REJECTED: ${this.pluginId} registered ${hook} after activation closed; a hook cannot be added from a timer or a callback`);
    }
    if (hookKind(hook) === null) {
      throw new Error(`SKW_E_PL_REJECTED: ${JSON.stringify(hook)} is not one of the twelve hooks (§13.3.4)`);
    }
    if (!this.declared.has(hook)) {
      throw new Error(`SKW_E_PL_REJECTED: ${this.pluginId} did not declare hook ${hook} in plugin.json.hooks`);
    }
    if (typeof fn !== 'function') {
      throw new Error(`SKW_E_PL_REJECTED: ${this.pluginId} registered a non-function for ${hook}`);
    }
    const existing = this.registrations.hooks.get(hook) ?? [];
    this.registrations.hooks.set(hook, [...existing, fn as HookFn]);
  }

  endpoint(method: string, name: string, handler: unknown): void {
    if (!this.open) {
      throw new Error(`SKW_E_PL_REJECTED: ${this.pluginId} registered endpoint ${name} after activation closed`);
    }
    const verb = method.toUpperCase();
    if (verb !== 'GET' && verb !== 'POST') {
      throw new Error(`SKW_E_PL_REJECTED: endpoint ${name} names method ${JSON.stringify(method)}; only GET and POST exist (§13.3.1)`);
    }
    if (typeof handler !== 'function') {
      throw new Error(`SKW_E_PL_REJECTED: endpoint ${name} has no handler`);
    }
    this.registrations.endpoints.set(`${verb} ${name}`, {
      method: verb,
      name,
      handler: handler as RegisteredEndpoint['handler'],
    });
  }

  screen(screen: unknown): void {
    if (!this.open) {
      throw new Error(`SKW_E_PL_REJECTED: ${this.pluginId} registered a screen after activation closed`);
    }
    if (typeof screen !== 'object' || screen === null) {
      throw new Error(`SKW_E_PL_REJECTED: ${this.pluginId} registered a screen that is not an object`);
    }
    const s = screen as Record<string, unknown>;
    const path = typeof s.path === 'string' ? s.path : '';
    const table = typeof s.table === 'string' ? s.table : '';
    // §13.3.1: admin screens are **declarative only** — a list/form against a declared table.
    // A screen naming a table the package does not own is refused here, because that is the
    // one thing a declarative screen could otherwise do that a data hook could not.
    if (!this.declaredTables.has(table)) {
      throw new Error(`SKW_E_PL_REJECTED: ${this.pluginId} declared a screen on ${JSON.stringify(table)}, which it does not own`);
    }
    if (!/^\/[a-z0-9][a-z0-9/-]{0,80}$/.test(path)) {
      throw new Error(`SKW_E_PL_REJECTED: screen path ${JSON.stringify(path)} is not /[a-z0-9-/]`);
    }
    const spec = this.declaredTables.get(table) as TableSpec;
    this.registrations.screens.set(path, {
      path,
      table,
      title: typeof s.title === 'string' ? s.title : this.pluginId,
      ...(spec.fields === undefined ? {} : { fields: spec.fields }),
      ...(spec.list === undefined ? {} : { list: spec.list }),
    });
  }

  /**
   * S8k: a detail page. One `{column}` placeholder, a table the package owns, and three columns it
   * declared — the host builds the page, so a package cannot introduce a template or a script.
   */
  page(spec: unknown): void {
    if (!this.open) throw new Error(`SKW_E_PL_REJECTED: ${this.pluginId} registered a page after activation closed`);
    if (typeof spec !== 'object' || spec === null) throw new Error(`SKW_E_PL_REJECTED: ${this.pluginId} registered a page that is not an object`);
    const p = spec as Record<string, unknown>;
    const table = typeof p.table === 'string' ? p.table : '';
    const declaredTable = this.declaredTables.get(table);
    if (declaredTable === undefined) {
      throw new Error(`SKW_E_PL_REJECTED: ${this.pluginId} declared a page on ${JSON.stringify(table)}, which it does not own`);
    }
    const columnsOf = new Set((declaredTable.columns ?? []).map((c) => c.name));
    const pattern = typeof p.pattern === 'string' ? p.pattern : '';
    const placeholders = [...pattern.matchAll(/\{([a-z][a-z0-9_]*)\}/g)].map((m) => m[1] as string);
    if (!pattern.startsWith('/') || pattern.includes('//') || placeholders.length !== 1) {
      throw new Error(`SKW_E_PL_REJECTED: ${this.pluginId} page pattern ${JSON.stringify(pattern)} is not /path/{column}`);
    }
    for (const key of ['slug_column', 'title_column', 'body_column'] as const) {
      if (typeof p[key] !== 'string' || !columnsOf.has(p[key] as string)) {
        throw new Error(`SKW_E_PL_REJECTED: ${this.pluginId} page ${pattern} names ${key}=${JSON.stringify(p[key])}, which ${table} does not declare`);
      }
    }
    if (!columnsOf.has(placeholders[0] as string)) {
      throw new Error(`SKW_E_PL_REJECTED: ${this.pluginId} page ${pattern} binds {${placeholders[0]}} , which ${table} does not declare`);
    }
    if (p.filter !== undefined) {
      const filter = p.filter as Record<string, unknown>;
      if (typeof filter !== 'object' || filter === null || typeof filter.column !== 'string' || !columnsOf.has(filter.column) || typeof filter.equals !== 'string') {
        throw new Error(`SKW_E_PL_REJECTED: ${this.pluginId} page ${pattern} has a filter that is not {column, equals} over its own columns`);
      }
    }
    if (this.registrations.pages.has(pattern)) throw new Error(`SKW_E_PL_REJECTED: ${this.pluginId} registered page ${pattern} twice`);
    this.registrations.pages.set(pattern, {
      pattern,
      table,
      slugColumn: p.slug_column as string,
      titleColumn: p.title_column as string,
      bodyColumn: p.body_column as string,
      ...(p.filter === undefined ? {} : { filter: p.filter as { column: string; equals: string } }),
    });
  }

  /**
   * S8k: a form the host draws and the package receives as JSON. The endpoint must be one this
   * package declared, or the host would be posting a visitor's words to a door it does not own.
   */
  form(spec: unknown): void {
    if (!this.open) throw new Error(`SKW_E_PL_REJECTED: ${this.pluginId} registered a form after activation closed`);
    if (typeof spec !== 'object' || spec === null) throw new Error(`SKW_E_PL_REJECTED: ${this.pluginId} registered a form that is not an object`);
    const f = spec as Record<string, unknown>;
    const name = typeof f.name === 'string' ? f.name : '';
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(name)) throw new Error(`SKW_E_PL_REJECTED: ${this.pluginId} named a form ${JSON.stringify(name)}`);
    const endpoint = typeof f.endpoint === 'string' ? f.endpoint : '';
    if (!this.registrations.endpoints.has(`POST ${endpoint}`)) {
      throw new Error(`SKW_E_PL_REJECTED: ${this.pluginId} form ${name} posts to ${JSON.stringify(endpoint)}, which it did not declare`);
    }
    const fieldsRaw = Array.isArray(f.fields) ? f.fields : [];
    if (fieldsRaw.length === 0 || fieldsRaw.length > 12) throw new Error(`SKW_E_PL_REJECTED: ${this.pluginId} form ${name} has ${fieldsRaw.length} fields; 1–12`);
    const fields: DeclarativeForm['fields'] = [];
    for (const raw of fieldsRaw) {
      if (typeof raw !== 'object' || raw === null) throw new Error(`SKW_E_PL_REJECTED: ${this.pluginId} form ${name}: a field is not an object`);
      const field = raw as Record<string, unknown>;
      const fieldName = typeof field.name === 'string' ? field.name : '';
      if (!/^[a-z][a-z0-9_]{0,40}$/.test(fieldName)) throw new Error(`SKW_E_PL_REJECTED: ${this.pluginId} form ${name}: field name ${JSON.stringify(fieldName)}`);
      const type = String(field.type ?? 'text');
      if (!['text', 'email', 'textarea'].includes(type)) throw new Error(`SKW_E_PL_REJECTED: ${this.pluginId} form ${name}.${fieldName}: type ${JSON.stringify(field.type)}`);
      fields.push({
        name: fieldName,
        label: typeof field.label === 'string' && field.label !== '' ? field.label : fieldName,
        type: type as 'text' | 'email' | 'textarea',
        ...(field.required === true ? { required: true } : {}),
        ...(typeof field.maxLength === 'number' ? { maxLength: field.maxLength } : {}),
      });
    }
    if (new Set(fields.map((f2) => f2.name)).size !== fields.length) throw new Error(`SKW_E_PL_REJECTED: ${this.pluginId} form ${name}: a field is declared twice`);
    const id = `${this.pluginId}/${name}`;
    if (this.registrations.forms.has(id)) throw new Error(`SKW_E_PL_REJECTED: ${this.pluginId} registered form ${name} twice`);
    this.registrations.forms.set(id, {
      id,
      label: typeof f.label === 'string' && f.label !== '' ? f.label : name,
      endpoint,
      fields,
      thanks: typeof f.thanks === 'string' && f.thanks !== '' ? f.thanks : 'Thank you — your message was sent.',
    });
  }

  /**
   * S8h: register a builder block. The rules are the screen rules plus one: every column a block
   * names must be a column the package declared for that table, so a block cannot read a `cms_*`
   * column by guessing its name.
   */
  block(spec: unknown): void {
    if (!this.open) {
      throw new Error(`SKW_E_PL_REJECTED: ${this.pluginId} registered a block after activation closed`);
    }
    if (typeof spec !== 'object' || spec === null) {
      throw new Error(`SKW_E_PL_REJECTED: ${this.pluginId} registered a block that is not an object`);
    }
    const b = spec as Record<string, unknown>;
    const table = typeof b.table === 'string' ? b.table : '';
    const declaredTable = this.declaredTables.get(table);
    if (declaredTable === undefined) {
      throw new Error(`SKW_E_PL_REJECTED: ${this.pluginId} declared a block on ${JSON.stringify(table)}, which it does not own`);
    }
    const columnsOf = new Set((declaredTable.columns ?? []).map((c) => c.name));
    const name = typeof b.name === 'string' ? b.name : '';
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(name)) {
      throw new Error(`SKW_E_PL_REJECTED: ${this.pluginId} named a block ${JSON.stringify(name)}, which is not [a-z][a-z0-9-]{0,39}`);
    }
    const id = `${this.pluginId}/${name}`;
    if (this.registrations.blocks.has(id)) {
      throw new Error(`SKW_E_PL_REJECTED: ${this.pluginId} registered block ${name} twice`);
    }
    const columns = Array.isArray(b.columns) ? b.columns : [];
    if (columns.length === 0 || columns.length > 6) {
      throw new Error(`SKW_E_PL_REJECTED: ${this.pluginId} block ${name} names ${columns.length} columns; 1–6 are allowed`);
    }
    for (const column of columns) {
      if (typeof column !== 'string' || !columnsOf.has(column)) {
        throw new Error(`SKW_E_PL_REJECTED: ${this.pluginId} block ${name} names column ${JSON.stringify(column)}, which ${table} does not declare`);
      }
    }
    const limit = typeof b.limit === 'number' ? b.limit : 5;
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
      throw new Error(`SKW_E_PL_REJECTED: ${this.pluginId} block ${name} asks for ${String(b.limit)} rows; 1–20 is allowed`);
    }
    if (b.orderBy !== undefined && (typeof b.orderBy !== 'string' || !columnsOf.has(b.orderBy))) {
      throw new Error(`SKW_E_PL_REJECTED: ${this.pluginId} block ${name} orders by ${JSON.stringify(b.orderBy)}, which ${table} does not declare`);
    }
    if (b.labelColumn !== undefined && (typeof b.labelColumn !== 'string' || !columnsOf.has(b.labelColumn))) {
      throw new Error(`SKW_E_PL_REJECTED: ${this.pluginId} block ${name} labels rows with ${JSON.stringify(b.labelColumn)}, which ${table} does not declare`);
    }
    // S8m: `filters` is the same idea as `filter`, one to three of them. A menu needs two
    // conditions that both have to hold — `visible = 1` **and** `menu = 'main'` — and a single
    // `filter` could only say one, so a hidden row or another menu's rows would leak into the
    // block. `filter` stays as the singular alias every existing package uses.
    const declaredFilters: { column: string; equals: string }[] = [];
    if (b.filter !== undefined) {
      const filter = b.filter as Record<string, unknown>;
      if (typeof filter !== 'object' || filter === null || typeof filter.column !== 'string' || !columnsOf.has(filter.column) || typeof filter.equals !== 'string') {
        throw new Error(`SKW_E_PL_REJECTED: ${this.pluginId} block ${name} has a filter that is not {column, equals} over its own columns`);
      }
      declaredFilters.push({ column: filter.column, equals: filter.equals });
    }
    if (b.filters !== undefined) {
      if (!Array.isArray(b.filters) || b.filters.length === 0 || b.filters.length > 3) {
        throw new Error(`SKW_E_PL_REJECTED: ${this.pluginId} block ${name} declared filters that are not an array of 1–3 conditions`);
      }
      for (const raw of b.filters) {
        const filter = raw as Record<string, unknown>;
        if (typeof filter !== 'object' || filter === null || typeof filter.column !== 'string' || !columnsOf.has(filter.column) || typeof filter.equals !== 'string') {
          throw new Error(`SKW_E_PL_REJECTED: ${this.pluginId} block ${name} has a filter in filters that is not {column, equals} over its own columns`);
        }
        declaredFilters.push({ column: filter.column, equals: filter.equals });
      }
    }
    if (b.layout !== undefined && b.layout !== 'list' && b.layout !== 'cards') {
      throw new Error(`SKW_E_PL_REJECTED: ${this.pluginId} block ${name} has layout ${JSON.stringify(b.layout)}; list or cards`);
    }
    if (b.href !== undefined) {
      // S8m: two legitimate shapes. A **path template** (`/blog/{slug}`) is a path on this site
      // with columns interpolated as path segments. A **whole-cell template** (`{href}`) is a
      // URL the row itself carries — the menu case, where the cell holds `/about` or an
      // `https://` address and `app/render/blocks.ts`'s `safeHref` is what refuses the rest.
      const wholeCell = typeof b.href === 'string' && /^\{[a-z][a-z0-9_]*\}$/.test(b.href);
      if (
        typeof b.href !== 'string' ||
        b.href.length > 200 ||
        (!wholeCell && (!b.href.startsWith('/') || b.href.includes('//')))
      ) {
        throw new Error(`SKW_E_PL_REJECTED: ${this.pluginId} block ${name} href ${JSON.stringify(b.href)} is neither a path on this site nor a single {column} holding a URL`);
      }
      for (const token of b.href.matchAll(/\{([a-z][a-z0-9_]*)\}/g)) {
        if (!columnsOf.has(token[1] as string)) {
          throw new Error(`SKW_E_PL_REJECTED: ${this.pluginId} block ${name} href names {${token[1]}} , which ${table} does not declare`);
        }
      }
    }
    this.registrations.blocks.set(id, {
      id,
      label: typeof b.label === 'string' && b.label !== '' ? b.label : name,
      table,
      columns: columns as string[],
      limit,
      ...(b.order === 'asc' ? { order: 'asc' as const } : {}),
      ...(typeof b.orderBy === 'string' ? { orderBy: b.orderBy } : {}),
      ...(declaredFilters.length === 0 ? {} : { filters: declaredFilters }),
      ...(b.layout === 'cards' ? { layout: 'cards' as const } : {}),
      ...(typeof b.href === 'string' ? { href: b.href } : {}),
      ...(typeof b.labelColumn === 'string' ? { labelColumn: b.labelColumn } : {}),
    });
  }
}

/** Every hook name, for the gate that asserts the surface is exactly twelve. */
export const ALL_HOOKS: readonly string[] = HOOK_NAMES;

export type { HookName };
