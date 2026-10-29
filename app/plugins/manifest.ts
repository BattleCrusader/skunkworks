/**
 * The plugin contract — **the manifest grammar** (§8.1–§8.3, C-5, C-9; D36 §13.3.1).
 *
 * This file used to be `protocol.ts`, and it was named for a wire: JSON lines over
 * `run/plugin.sock`, `{id, op, plugin, tenant, args}` out and `{type:'host.call'}` back. That
 * wire is deleted with the runner (§13.3.9), and the name went with it — a file called
 * `protocol.ts` in a tree that has no protocol is an invitation to build one. What survives
 * verbatim is everything below: the manifest grammar, the 14 operations, the package root
 * hash, and the host-emitted DDL.
 *
 * A package is a directory with `plugin.json` and one entry module. The manifest is the only
 * statement of what a package may do: it names the operations it is granted, the
 * `p_<id>_*` tables it owns, the hooks it may register, and the entry file `import()` loads.
 * Nothing in the package is read by the app except through this validator, and nothing the
 * package sends is SQL — the host emits every statement from the validated manifest.
 *
 * Two fields are D36's addition (§13.3.1): `main` (what to `import()`) and `hooks` (what the
 * package may register). `main` defaults to `entry` — every package built before D36 names
 * its entry that way — and `hooks` defaults to `[]`: a package that registers nothing is a
 * package with no hooks, not a malformed one. An undeclared `ctx.on()` is refused at
 * activation with `SKW_E_PL_REJECTED`, which is a contract check and not containment.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { AppError } from '../errors.ts';

/** §8.3's 14 operations, frozen. Under D36 they are facade methods, not socket ops. */
export const LOCAL_OPS = ['util.now', 'util.random', 'util.hash', 'log.write'] as const;
export const HOST_OPS = [
  'store.insert',
  'store.update',
  'store.delete',
  'store.query',
  'store.count',
  'settings.get',
  'settings.has',
  'settings.set',
  'assets.resolve',
  'mail.send',
] as const;
export type HostOp = (typeof HOST_OPS)[number];
export const ALL_OPS: readonly string[] = [...LOCAL_OPS, ...HOST_OPS];

/**
 * §13.3.4 — **the twelve hooks, frozen.** Six filters, whose return value replaces only the
 * value they were handed, and six actions, whose return value is discarded. A hook not on
 * this list does not exist: `ctx.on()` refuses it and `parseManifest` refuses a manifest that
 * declares it, so the install screen can list what a package touches and be right.
 *
 * The absences are decisions, not omissions (§13.3.4): `download.authorize`, `download.issue`
 * and `route.resolve` are absent because each would change an outcome the host owns;
 * `admin.render.html` because no plugin markup reaches the admin origin; `db.*`, `fs.*`,
 * `net.*`, `http.*`, `fetch`, `env`, `cron`, `worker`, `spawn`, `stream` because in-process
 * they would be theatre — a plugin can `import('node:fs')` itself (§13.3.7).
 */
export const FILTER_HOOKS = [
  'content.render.html',
  'page.head',
  'asset.url',
  'form.validate',
  'admin.menu',
  'mail.template',
] as const;

export const ACTION_HOOKS = [
  'page.rendered',
  'form.submitted',
  'download.redeemed',
  'admin.login',
  'plugin.enabled',
  'plugin.disabled',
] as const;

export const HOOK_NAMES: readonly string[] = [...FILTER_HOOKS, ...ACTION_HOOKS];
export type FilterHook = (typeof FILTER_HOOKS)[number];
export type ActionHook = (typeof ACTION_HOOKS)[number];
export type HookName = FilterHook | ActionHook;
export type HookKind = 'filter' | 'action';

/** `null` for a name that is not one of the twelve: the caller refuses it by that fact. */
export function hookKind(name: string): HookKind | null {
  if ((FILTER_HOOKS as readonly string[]).includes(name)) return 'filter';
  if ((ACTION_HOOKS as readonly string[]).includes(name)) return 'action';
  return null;
}

/** The largest value a filter may hand back for the two string hooks with a stated cap. */
export const HOOK_HTML_MAX = 4 * 1024;


export const PLUGIN_ID = /^[a-z][a-z0-9]{1,19}$/;
/** §8.2: `p_<id>_<name>`, and the id prefix must be the package's own. */
export const PLUGIN_TABLE = /^p_([a-z][a-z0-9]{1,19})_([a-z][a-z0-9_]{0,40})$/;
const COLUMN = /^[a-z][a-z0-9_]{0,40}$/;
const INDEX = /^ix_p_[a-z0-9_]{1,50}$/;

export type ColumnType = 'TEXT' | 'INTEGER' | 'REAL' | 'BLOB' | 'ASSET' | 'JSON';

export interface ColumnSpec {
  name: string;
  /** `ASSET` is TEXT plus a guard trigger; `JSON` is TEXT plus `json_valid`. */
  type: ColumnType;
  notNull?: boolean;
  /** SQL literal, validated as a primitive — never an expression. */
  default?: string | number | boolean | null;
  indexed?: boolean;
}

/**
 * What a package says about **editing** its own data — not what it stores (S8g).
 *
 * A column is not a form field. `p_blog_post.created_at` is `TEXT NOT NULL`; the person writing
 * a post has no business typing an ISO timestamp into it, and a 4,000-word body deserves a
 * textarea, not a one-line input. Before this block existed the admin could only guess from the
 * column's SQL type and its name, so every plugin's screen was a property sheet of raw columns.
 *
 * Declarative, as §13.3.1 requires: a field names a **widget** the host already knows how to
 * draw, never markup. The host renders it; the package supplies no HTML.
 */
export const WIDGETS = [
  'text',
  'textarea',
  'markdown',
  'select',
  'number',
  /**
   * v10: **dollars in the form, cents in the column.** The only money this product stores is an
   * hourly rate, and a person types `95.50`, not `9550` — a package that declared a cents column
   * with a `number` widget would ship a form that silently divided every rate by a hundred. The
   * host divides on the way in and multiplies on the way out (`app/admin/routes.ts`), through the
   * same parser the applicant's profile form uses (`app/accounts/money.ts`).
   */
  'money',
  'date',
  'slug',
  'hidden',
  'auto',
] as const;
export type Widget = (typeof WIDGETS)[number];

export interface FieldSpec {
  /** A column this table declares. A field for an undeclared column is refused. */
  name: string;
  /** What a person reads. Defaults to the column name. */
  label?: string;
  /** How the host draws it. Defaults to the type's own guess (`text`, `number`, `textarea`). */
  widget?: Widget;
  /** One line under the input. */
  help?: string;
  placeholder?: string;
  /** Overrides the column's NOT NULL rule for the purposes of the asterisk. */
  required?: boolean;
  /** `select` only: the values the operator may choose. */
  options?: string[];
  /** `slug` only: the column to derive from when this one is left empty. */
  from?: string;
  /** `textarea`/`markdown`: how many rows to draw. */
  rows?: number;
  /**
   * `date`/`hidden`/`auto`: `now` is the only accepted value, and it means the host stamps an
   * ISO timestamp when the row is written. It is the one default a package cannot express as a
   * SQL `DEFAULT` (§11.6 keeps `DEFAULT` a primitive), and every table needs it.
   */
  default?: 'now';
}

export interface TableSpec {
  name: string;
  /** §11.2's export class. A table with no class cannot be sold and is refused. */
  export: 'rows' | 'empty' | 'filtered' | 'secret';
  columns?: ColumnSpec[];
  /** S8g: the edit form, in the order it should be drawn. */
  fields?: FieldSpec[];
  /** S8g: the columns the list screen shows, in order. Defaults to the first six editable ones. */
  list?: string[];
}

export interface SettingSpec {
  key: string;
  type: 'string' | 'int' | 'bool' | 'json' | 'secret';
  max?: number;
}

/**
 * D25's *declared public endpoints*, frozen at the shape the product serves (S4e).
 *
 * An endpoint is a name the package answers plus the HTTP method the edge will route to it.
 * The name is the `op` the package's own `handle()` receives, so a package declares one
 * function per URL and nothing else; the app owns the path (`/_plugin/<id>/<name>`), the
 * tenant is resolved from the Host and never from the URL (§5.3, P4), and an endpoint that
 * is not in this list is a 404 — the same body as any path the tenant does not have.
 *
 * `response` is deliberately absent: every endpoint answers JSON. A package returning HTML
 * would be third-party markup on the tenant's own origin, and the CSP that makes that safe
 * is a v2 decision (frame-src is `none` for every tenant in v1, §10.5).
 */
export interface EndpointSpec {
  /** `[a-z][a-z0-9-]{0,31}`; the op name the package's handle() receives. */
  name: string;
  method: 'GET' | 'POST';
}

const ENDPOINT_NAME = /^[a-z][a-z0-9-]{0,31}$/;

export interface Manifest {
  id: string;
  version: string;
  /** The pre-D36 name for the entry file. Kept so existing packages parse; `main` wins. */
  entry: string;
  /** §13.3.1 (D36): the file `import()` loads, relative to the package root. */
  main: string;
  /** §13.3.1 (D36): the hooks this package may register. Registration of anything else is refused. */
  hooks: HookName[];
  description?: string;
  /**
   * §8.1's `publisher` block, *if the package makes one*. It is a claim, not a grant: the
   * signature file is what binds a package to a key (§8.5), and when both exist they must
   * agree or the install is refused.
   */
  publisher?: { id: string; key_id?: string };
  capabilities: string[];
  tables: TableSpec[];
  settings: SettingSpec[];
  /** D25 (S4e): the public URLs this package answers, and with which method. */
  endpoints?: EndpointSpec[];
  /** §8.5's `tests` block: the packager's report is bound to the image digest. */
  tests?: { entry: string; timeout_s: number };
  /** Optional declared site.db version range. */
  requires?: { site_db_min?: number; site_db_max?: number };
  migrations?: { version: string; seq: number; ops: string[] }[] | undefined;
}

const TYPES = new Set<ColumnType>(['TEXT', 'INTEGER', 'REAL', 'BLOB', 'ASSET', 'JSON']);

/**
 * A manifest refusal, as the taxonomy's own code.
 *
 * This used to be a plain `Error`, which meant a package with a bad manifest reached the operator
 * as a **500 with no code** on the upload door and as a stack trace from `skwctl`. A refusal that
 * names the package and the field is the entire value of manifest validation; throwing it as an
 * anonymous error threw that away at the one place a person reads it. `SKW_E_PL_REJECTED` is the
 * frozen PL code for "this package will not be accepted", and it is a 403 — the file is not
 * malformed (that is `ARCHIVE_FAILED`, 409), it is unacceptable.
 */
function bad(id: string, message: string): never {
  throw new AppError('SKW_E_PL_REJECTED', `${id}: ${message}`, { plugin: id });
}

/** Validate a parsed `plugin.json`. Every refusal names the package and the field. */
export function parseManifest(raw: unknown): Manifest {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('plugin.json is not an object');
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' ? r.id : '';
  if (!PLUGIN_ID.test(id)) bad(JSON.stringify(id), `plugin id is not ${PLUGIN_ID}`);
  if (typeof r.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(r.version)) bad(id, 'version is not semver');
  // §13.3.1 (D36): `main` is the field a package must name; `entry` is what every package built
  // before D36 calls it. Either one satisfies the "there is an entry file inside the package"
  // rule, and the rule itself is unchanged — a path outside the root is refused.
  const entryRaw = r.entry ?? r.main;
  if (typeof entryRaw !== 'string' || entryRaw === '' || entryRaw.includes('..') || entryRaw.startsWith('/')) {
    bad(id, `entry ${JSON.stringify(entryRaw)} is not a relative path inside the package`);
  }
  const capabilities = Array.isArray(r.capabilities) ? r.capabilities.map(String) : [];
  for (const op of capabilities) {
    if (!ALL_OPS.includes(op)) bad(id, `capability ${JSON.stringify(op)} is not one of the 14 operations`);
  }
  if (new Set(capabilities).size !== capabilities.length) bad(id, 'a capability is declared twice');

  const tablesRaw = Array.isArray(r.tables) ? r.tables : [];
  const tables: TableSpec[] = [];
  for (const entry of tablesRaw) {
    if (typeof entry !== 'object' || entry === null) bad(id, 'a table entry is not an object');
    const t = entry as Record<string, unknown>;
    const name = typeof t.name === 'string' ? t.name : '';
    const match = PLUGIN_TABLE.exec(name);
    if (match === null) bad(id, `table ${JSON.stringify(name)} is not p_<id>_<name>`);
    if (match[1] !== id) bad(id, `table ${name} is not in this plugin's namespace (p_${id}_…)`);
    if (typeof t.export !== 'string' || !['rows', 'empty', 'filtered', 'secret'].includes(t.export)) {
      bad(id, `table ${name} has no export class (§11.2; SKW_E_PL_NO_EXPORT_CLASS)`);
    }
    const columnsRaw = Array.isArray(t.columns) ? t.columns : [];
    const columns: ColumnSpec[] = [];
    for (const c of columnsRaw) {
      if (typeof c !== 'object' || c === null) bad(id, `table ${name}: a column is not an object`);
      const col = c as Record<string, unknown>;
      const column = typeof col.name === 'string' ? col.name : '';
      if (!COLUMN.test(column)) bad(id, `table ${name}: column ${JSON.stringify(column)} is not a name`);
      if (column === 'id') bad(id, `table ${name}: id is implicit and may not be declared`);
      const type = String(col.type ?? '').toUpperCase() as ColumnType;
      if (!TYPES.has(type)) bad(id, `table ${name}.${column}: type ${JSON.stringify(col.type)} is not one of ${[...TYPES].join(',')}`);
      const spec: ColumnSpec = { name: column, type };
      if (col.notNull === true) spec.notNull = true;
      if (col.indexed === true) spec.indexed = true;
      if ('default' in col) {
        const value = col.default;
        if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) {
          bad(id, `table ${name}.${column}: default must be a primitive`);
        }
        spec.default = value as string | number | boolean | null;
      }
      columns.push(spec);
    }
    if (new Set(columns.map((c) => c.name)).size !== columns.length) bad(id, `table ${name}: a column is declared twice`);

    // S8g: the edit form. Validated here, at install time, so a field naming a column the table
    // does not have is a refused package rather than a control that silently does nothing.
    const columnNames = new Set(columns.map((c) => c.name));
    const fieldsRaw = Array.isArray(t.fields) ? t.fields : [];
    const fields: FieldSpec[] = [];
    for (const entry of fieldsRaw) {
      if (typeof entry !== 'object' || entry === null) bad(id, `table ${name}: a field is not an object`);
      const f = entry as Record<string, unknown>;
      const fieldName = typeof f.name === 'string' ? f.name : '';
      if (!columnNames.has(fieldName)) {
        bad(id, `table ${name}: field ${JSON.stringify(fieldName)} is not a declared column (${[...columnNames].join(', ')})`);
      }
      const spec: FieldSpec = { name: fieldName };
      if (f.label !== undefined) {
        if (typeof f.label !== 'string' || f.label === '' || f.label.length > 80) bad(id, `table ${name}.${fieldName}: label is not a string ≤ 80`);
        spec.label = f.label;
      }
      if (f.widget !== undefined) {
        const widget = String(f.widget);
        if (!(WIDGETS as readonly string[]).includes(widget)) {
          bad(id, `table ${name}.${fieldName}: widget ${JSON.stringify(f.widget)} is not one of ${WIDGETS.join(', ')}`);
        }
        spec.widget = widget as Widget;
      }
      if (f.help !== undefined) {
        if (typeof f.help !== 'string' || f.help.length > 200) bad(id, `table ${name}.${fieldName}: help is not a string ≤ 200`);
        spec.help = f.help;
      }
      if (f.placeholder !== undefined) {
        if (typeof f.placeholder !== 'string' || f.placeholder.length > 120) bad(id, `table ${name}.${fieldName}: placeholder is not a string ≤ 120`);
        spec.placeholder = f.placeholder;
      }
      if (f.required !== undefined) {
        if (typeof f.required !== 'boolean') bad(id, `table ${name}.${fieldName}: required is not a boolean`);
        spec.required = f.required;
      }
      if (f.options !== undefined) {
        if (spec.widget !== 'select') bad(id, `table ${name}.${fieldName}: options belong to a select widget`);
        if (!Array.isArray(f.options) || f.options.length === 0 || f.options.length > 40) {
          bad(id, `table ${name}.${fieldName}: options is not a non-empty array ≤ 40`);
        }
        const options: string[] = [];
        for (const option of f.options) {
          if (typeof option !== 'string' || option === '' || option.length > 80) {
            bad(id, `table ${name}.${fieldName}: an option is not a non-empty string ≤ 80`);
          }
          options.push(option);
        }
        if (new Set(options).size !== options.length) bad(id, `table ${name}.${fieldName}: an option is listed twice`);
        spec.options = options;
      }
      if (f.from !== undefined) {
        if (spec.widget !== 'slug') bad(id, `table ${name}.${fieldName}: from belongs to a slug widget`);
        if (typeof f.from !== 'string' || !columnNames.has(f.from)) {
          bad(id, `table ${name}.${fieldName}: from ${JSON.stringify(f.from)} is not a declared column`);
        }
        spec.from = f.from;
      }
      if (f.rows !== undefined) {
        if (!Number.isInteger(f.rows) || (f.rows as number) < 2 || (f.rows as number) > 40) {
          bad(id, `table ${name}.${fieldName}: rows is not an integer in 2..40`);
        }
        spec.rows = f.rows as number;
      }
      if (f.default !== undefined) {
        if (f.default !== 'now') bad(id, `table ${name}.${fieldName}: default is only 'now'`);
        spec.default = 'now';
      }
      fields.push(spec);
    }
    if (new Set(fields.map((f) => f.name)).size !== fields.length) bad(id, `table ${name}: a field is declared twice`);

    const listRaw = t.list === undefined ? undefined : t.list;
    const list: string[] = [];
    if (listRaw !== undefined) {
      if (!Array.isArray(listRaw) || listRaw.length === 0 || listRaw.length > 8) bad(id, `table ${name}: list is not an array of 1..8 columns`);
      for (const column of listRaw) {
        if (typeof column !== 'string' || !columnNames.has(column)) {
          bad(id, `table ${name}: list names ${JSON.stringify(column)}, which is not a declared column`);
        }
        list.push(column);
      }
    }

    tables.push({
      name,
      export: t.export as TableSpec['export'],
      columns,
      ...(fields.length > 0 ? { fields } : {}),
      ...(list.length > 0 ? { list } : {}),
    });
  }
  if (new Set(tables.map((t) => t.name)).size !== tables.length) bad(id, 'a table is declared twice');

  const settingsRaw = Array.isArray(r.settings) ? r.settings : [];
  const settings: SettingSpec[] = [];
  for (const entry of settingsRaw) {
    if (typeof entry !== 'object' || entry === null) bad(id, 'a setting entry is not an object');
    const s = entry as Record<string, unknown>;
    const key = typeof s.key === 'string' ? s.key : '';
    if (!/^[a-z][a-z0-9._-]{0,60}$/.test(key)) bad(id, `setting ${JSON.stringify(key)} is not a key`);
    const type = String(s.type ?? '');
    if (!['string', 'int', 'bool', 'json', 'secret'].includes(type)) bad(id, `setting ${key}: type ${JSON.stringify(s.type)} is not valid`);
    settings.push({ key, type: type as SettingSpec['type'], ...(typeof s.max === 'number' ? { max: s.max } : {}) });
  }

  const manifest: Manifest = { id, version: r.version, entry: entryRaw, main: '', hooks: [], capabilities, tables, settings };
  // §13.3.1 (D36): `main` is what `import()` loads. A package that predates D36 names its
  // entry `entry`; the value is validated with the same rule either way, because the one
  // thing that must not happen is a package naming a path outside its own root.
  const mainRaw = r.main ?? r.entry;
  if (typeof mainRaw !== 'string' || mainRaw === '' || mainRaw.includes('..') || mainRaw.startsWith('/')) {
    bad(id, `main ${JSON.stringify(mainRaw)} is not a relative path inside the package`);
  }
  manifest.main = mainRaw;
  // §13.3.4: a declared hook that is not one of the twelve is a refused package, not a
  // registration that silently does nothing. `ctx.on()` refuses it at activation too — this
  // is the half an operator can read before installing.
  if (r.hooks !== undefined) {
    if (!Array.isArray(r.hooks)) bad(id, 'hooks must be an array of hook names');
    const hooks: HookName[] = [];
    for (const raw of r.hooks) {
      const name = typeof raw === 'string' ? raw : '';
      if (hookKind(name) === null) bad(id, `hook ${JSON.stringify(raw)} is not one of the twelve (§13.3.4)`);
      hooks.push(name as HookName);
    }
    if (new Set(hooks).size !== hooks.length) bad(id, 'a hook is declared twice');
    manifest.hooks = hooks;
  }
  if (typeof r.description === 'string') manifest.description = r.description;
  // §8.1's publisher block. Optional — a package that makes no claim is unsigned — but a
  // malformed one is a refused package rather than a field nobody validated.
  if (r.publisher !== undefined) {
    if (typeof r.publisher !== 'object' || r.publisher === null) bad(id, 'publisher must be {id, key_id}');
    const p = r.publisher as Record<string, unknown>;
    if (typeof p.id !== 'string' || !/^[a-z][a-z0-9-]{1,39}$/.test(p.id)) bad(id, `publisher id ${JSON.stringify(p.id)} is not [a-z][a-z0-9-]{1,39}`);
    const block: { id: string; key_id?: string } = { id: p.id };
    if (p.key_id !== undefined) {
      if (typeof p.key_id !== 'string' || !/^spki-sha256:[0-9a-f]{64}$/.test(p.key_id)) {
        bad(id, `publisher key_id ${JSON.stringify(p.key_id)} is not spki-sha256:<64 hex>`);
      }
      block.key_id = p.key_id;
    }
    manifest.publisher = block;
  }
  // D25 (S4e): the public surface. Validated here, before an install writes anything, so a
  // malformed endpoint is a refused package and not a 500 on the tenant's site.
  if (r.endpoints !== undefined) {
    if (!Array.isArray(r.endpoints)) bad(id, 'endpoints must be an array');
    const endpoints: EndpointSpec[] = [];
    for (const entry of r.endpoints) {
      if (typeof entry !== 'object' || entry === null) bad(id, 'an endpoint is not an object');
      const e = entry as Record<string, unknown>;
      const name = typeof e.name === 'string' ? e.name : '';
      if (!ENDPOINT_NAME.test(name)) bad(id, `endpoint ${JSON.stringify(name)} is not ${ENDPOINT_NAME}`);
      if (e.method !== 'GET' && e.method !== 'POST') bad(id, `endpoint ${name}: method must be GET or POST`);
      endpoints.push({ name, method: e.method });
    }
    if (new Set(endpoints.map((e) => e.name)).size !== endpoints.length) bad(id, 'an endpoint is declared twice');
    manifest.endpoints = endpoints;
  }
  if (typeof r.tests === 'object' && r.tests !== null) {
    const t = r.tests as Record<string, unknown>;
    if (typeof t.entry !== 'string' || typeof t.timeout_s !== 'number') bad(id, 'tests must be {entry, timeout_s}');
    manifest.tests = { entry: t.entry, timeout_s: t.timeout_s };
  }
  if (typeof r.requires === 'object' && r.requires !== null) {
    const q = r.requires as Record<string, unknown>;
    manifest.requires = {
      ...(typeof q.site_db_min === 'number' ? { site_db_min: q.site_db_min } : {}),
      ...(typeof q.site_db_max === 'number' ? { site_db_max: q.site_db_max } : {}),
    };
  }
  const migrationsRaw = Array.isArray(r.migrations) ? r.migrations : [];
  for (const m of migrationsRaw) {
    if (typeof m !== 'object' || m === null) bad(id, 'a migration is not an object');
    const mig = m as Record<string, unknown>;
    const ops = Array.isArray(mig.ops) ? mig.ops.map(String) : [];
    for (const op of ops) {
      // §8.2: forward-only. `drop_table`, `rename_table`, `drop_column` are not expressible.
      if (!['create_table', 'add_column', 'create_index', 'drop_index'].includes(op)) {
        bad(id, `migration ${String(mig.version)}: ${op} is destructive or unknown (SKW_E_PL_DESTRUCTIVE_UPGRADE)`);
      }
    }
    if (typeof mig.version !== 'string' || typeof mig.seq !== 'number') bad(id, 'a migration needs {version, seq}');
  }
  if (migrationsRaw.length > 0) manifest.migrations = migrationsRaw as Manifest['migrations'];
  return manifest;
}

export function readManifest(dir: string): Manifest {
  return parseManifest(JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8')) as unknown);
}

/**
 * The package root hash: sha256 over the sorted list of `path\0sha256` lines, excluding
 * nothing. `data/trust/revoked.json` and `cms_plugin_revoked` name this value, so a
 * single edited byte is a different package with the same id — which is the point.
 */
export function packageRootHash(dir: string): { root: string; files: { path: string; bytes: number; sha256: string }[] } {
  const files: { path: string; bytes: number; sha256: string }[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const bytes = readFileSync(full);
      files.push({ path: relative(dir, full).split(sep).join('/'), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
  };
  walk(dir);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const root = createHash('sha256').update(files.map((f) => `${f.path}\0${f.sha256}`).join('\n')).digest('hex');
  return { root, files };
}

export function packageDir(pluginsRoot: string, id: string): string {
  return join(pluginsRoot, id);
}

export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * §8.2's table creation, emitted by the host from the validated manifest.
 *
 * Every statement is built from identifiers the parser already constrained to
 * `[a-z][a-z0-9_]*`; no manifest string reaches SQL unquoted. The asset guard is a
 * trigger **on `cms_asset`** and a `cms_trigger_registry` row in the same transaction,
 * so a delete is refused with `foreign_keys=OFF` (check 24, §16 S4).
 */
export function tableStatements(manifest: Manifest): string[] {
  const statements: string[] = [];
  for (const table of manifest.tables) {
    const columns = table.columns ?? [];
    const defs = [
      'id INTEGER PRIMARY KEY AUTOINCREMENT',
      ...columns.map((c) => {
        const sqlType = c.type === 'ASSET' || c.type === 'JSON' ? 'TEXT' : c.type;
        const parts = [`"${c.name}"`, sqlType];
        if (c.notNull === true) parts.push('NOT NULL');
        if (c.default !== undefined) parts.push(`DEFAULT ${literal(c.default)}`);
        if (c.type === 'JSON') parts.push('CHECK(json_valid("' + c.name + '"))');
        return parts.join(' ');
      }),
    ];
    statements.push(`CREATE TABLE IF NOT EXISTS "${table.name}" (${defs.join(', ')})`);
    for (const c of columns) {
      if (c.indexed === true) statements.push(`CREATE INDEX IF NOT EXISTS "ix_${table.name}_${c.name}" ON "${table.name}" ("${c.name}")`);
    }
    const assetColumns = columns.filter((c) => c.type === 'ASSET').map((c) => c.name);
    if (assetColumns.length > 0) {
      const name = `trg_asset_guard_${table.name}`;
      const when = assetColumns.map((c) => `EXISTS (SELECT 1 FROM "${table.name}" WHERE "${c}" = OLD."key")`).join(' OR ');
      statements.push(`DROP TRIGGER IF EXISTS "${name}"`);
      statements.push(`CREATE TRIGGER "${name}" BEFORE DELETE ON cms_asset WHEN ${when} BEGIN SELECT RAISE(ABORT, 'SKW_E_DM_ASSET_IN_USE'); END`);
      statements.push(
        `INSERT OR REPLACE INTO cms_trigger_registry(name, table_name, purpose, checksum) VALUES ('${name}', 'cms_asset', 'asset_delete_guard', 'v3')`,
      );
    }
  }
  return statements;
}

function literal(value: string | number | boolean | null): string {
  if (value === null) return 'NULL';
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('a default is not a finite number');
    return String(value);
  }
  return `'${value.replace(/'/g, "''")}'`;
}
