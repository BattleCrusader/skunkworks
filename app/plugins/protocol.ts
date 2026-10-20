/**
 * The plugin contract, host side (§8.1–§8.3, C-5, C-9).
 *
 * A package is a directory with `plugin.json` and one entry module. The manifest is the
 * only statement of what a package may do: it names the 14-op subset it is granted, the
 * `p_<id>_*` tables it owns, and (optionally) those tables' columns. Nothing in the
 * package is read by the app except through this validator, and nothing the package
 * sends is SQL — the host emits every statement from the validated manifest.
 *
 * The same file is the exporter's source of truth too: `BUNDLE.json.plugins[]` and
 * `tools/bundle_verify.mjs` compare the row's `root_hash` with the bytes on disk, so a
 * package edited after install is refused at the next install rather than on a form.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** §8.3's 14 operations, frozen. The runner answers four; the host answers ten. */
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

export interface TableSpec {
  name: string;
  /** §11.2's export class. A table with no class cannot be sold and is refused. */
  export: 'rows' | 'empty' | 'filtered' | 'secret';
  columns?: ColumnSpec[];
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
  entry: string;
  description?: string;
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

function bad(id: string, message: string): never {
  throw new Error(`${id}: ${message}`);
}

/** Validate a parsed `plugin.json`. Every refusal names the package and the field. */
export function parseManifest(raw: unknown): Manifest {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('plugin.json is not an object');
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' ? r.id : '';
  if (!PLUGIN_ID.test(id)) bad(JSON.stringify(id), `plugin id is not ${PLUGIN_ID}`);
  if (typeof r.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(r.version)) bad(id, 'version is not semver');
  if (typeof r.entry !== 'string' || r.entry === '' || r.entry.includes('..') || r.entry.startsWith('/')) {
    bad(id, `entry ${JSON.stringify(r.entry)} is not a relative path inside the package`);
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
    tables.push({ name, export: t.export as TableSpec['export'], columns });
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

  const manifest: Manifest = { id, version: r.version, entry: r.entry, capabilities, tables, settings };
  if (typeof r.description === 'string') manifest.description = r.description;
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
