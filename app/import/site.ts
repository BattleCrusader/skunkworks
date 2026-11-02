/**
 * `skwctl site import` — **a bundle becomes a tenant on a running instance** (S12).
 *
 * The round trip is the point. `skw-export --target cms` produces a tree; until now the only
 * thing that could *become a site* from one was `install.sh` on an empty box, which means the
 * answer to "can I move this client's site to another box, or stand up a copy beside the live
 * one" was a reinstall. This is the other half: read the bundle, prove it is the bundle it says
 * it is, and write exactly the state a running instance needs — the tenant's database, its media,
 * its theme packages, its plugin packages, and the control rows that route a host to it.
 *
 * ## The order is the contract
 *
 *   1. **Verify, in memory, before a byte is written.** Every `BUNDLE.json` hash, every symlink
 *      target (inside the bundle, and hashing the file the link resolves to — the same rule
 *      `tools/bundle_verify.mjs` applies), every `source_counts` number, and every plugin
 *      package's root hash against its `cms_plugin_installed` row. A tampered archive leaves no
 *      directory, no `control.db` row and no tenant behind: the first refusal happens while the
 *      bundle is still a Buffer.
 *   2. **Then the two ownership questions**, still before any write: the tenant key must be new
 *      (or `--replace`), and every requested host must be free or already this tenant's.
 *   3. **Then the state**, in an order where a failure leaves nothing routable: the database, the
 *      media, the theme packages, the plugin packages, and the control rows last. A tenant with
 *      no control row cannot be reached by any Host, so a half-finished import is inert rather
 *      than a site that serves a database somebody else owns.
 *
 * ## What it deliberately does not do
 *
 *   - **No signed install of the bundled plugins.** `data/plugins/<id>/` is written verbatim — the
 *     bytes the exporter hashed and `BUNDLE.json` names. The signature was checked when the
 *     package was installed on the source box; re-checking it here would need the source box's
 *     publisher keys, and pretending to check it (accepting whatever signature came along) would
 *     be worse than saying so. The rows in `cms_plugin_installed` travel with the database, which
 *     is what the runtime reads, and `tools/bundle_verify.mjs` refuses an *enabled* row with no
 *     test report — this importer applies the same rule by refusing code that is not the bytes.
 *   - **No `content/protected/`, ever.** A bundle never carries a render, and an importer that
 *     accepted one would be the second door into a promise that has one.
 *   - **No nginx edit** unless `--nginx` names it. In a repository checkout `nginx/conf.d/10-app.conf`
 *     is a committed file; rewriting it as a side effect of an import is a change nobody asked
 *     for, in a file a deploy reviews.
 */
import Database from 'better-sqlite3';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';

import { findProjectRoot, migrateControl, migrateTenant, targetVersion } from '../db/migrate.ts';
import { generateAppConf, readHosts } from '../../tools/nginx_gen.ts';
import { readBundleSource, sha256, type BundleEntry, type BundleSource } from './archive.ts';
import { ImportRefusal, isProtectedPath } from './errors.ts';

/** The tenant-key grammar of `schema/control.sql`, restated where a refusal can name it. */
export const TENANT_KEY_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/**
 * A hostname that passes `domain`'s CHECK: lowercase, digits, dots and hyphens, at least one dot.
 * The column enforces it; refusing here names the host rather than the constraint.
 */
export const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export interface ImportRequest {
  /** A `.zip`, a `.tar.gz`, or an unpacked bundle directory. */
  source: string;
  /** The key the site will live under on **this** instance. */
  tenantKey: string;
  /** One or more hosts. The first is primary unless `primary` says otherwise. */
  hosts: readonly string[];
  primary?: string;
  /**
   * Register `<host>.<parent>` as an alias for every requested host, so one wildcard certificate
   * for `*.<parent>` covers the whole customer without a per-customer certificate.
   */
  wildcard?: string;
  dataDir: string;
  replace?: boolean;
  schemaDir?: string;
  repoRoot?: string;
  /** When known, a host equal to the demos vhost is refused rather than shadowing `/demo/`. */
  demosHost?: string | null;
}

export interface ImportedHost {
  host: string;
  kind: 'primary' | 'alias';
  isPrimary: 0 | 1;
  certState: 'none';
  /** True for a host added by `--wildcard`, so the summary can say why it is there. */
  wildcardAlias: boolean;
}

export interface ImportSummary {
  tenant: string;
  displayName: string;
  hosts: ImportedHost[];
  pages: number;
  assets: number;
  variants: number;
  themeAssets: number;
  plugins: { id: string; version: string; files: number }[];
  dbVersion: number;
  siteDb: string;
  contentRoot: string;
  source: { path: string; kind: BundleSource['kind']; files: number };
  replaced: boolean;
}

interface ManifestFile {
  path: string;
  sha256: string;
}

interface Manifest {
  schema?: unknown;
  tenant?: { key?: unknown; mode?: unknown; db_version?: unknown; display_name?: unknown };
  hosts?: unknown;
  files?: unknown;
  plugins?: unknown;
  source_counts?: unknown;
  created_at?: unknown;
}

interface VerifiedBundle {
  source: BundleSource;
  byPath: Map<string, BundleEntry>;
  manifest: Manifest;
  /** The bundle's own tenant key — where its theme assets are namespaced. */
  bundleKey: string;
  displayName: string;
  dbVersionClaim: number;
  files: number;
  plugins: { id: string; version: string; files: number }[];
}

// --------------------------------------------------------------------------- host plan

/**
 * The hosts this import will register, in the order the summary prints them: the primary first,
 * then the remaining requested hosts, then the wildcard aliases.
 *
 * Deduplicated by name, because `domain.host` is UNIQUE and a duplicate is a constraint error
 * rather than a message. The first occurrence wins, so `--primary` is never demoted to an alias.
 */
export function planHosts(request: Pick<ImportRequest, 'hosts' | 'primary' | 'wildcard'>): ImportedHost[] {
  if (request.hosts.length === 0) {
    throw new ImportRefusal('SKW_E_IMP_USAGE', 'an import needs at least one --host <host>', {}, 2);
  }
  const requested: string[] = [];
  for (const raw of request.hosts) {
    const host = raw.trim();
    if (host !== host.toLowerCase()) {
      throw new ImportRefusal(
        'SKW_E_IMP_HOST_INVALID',
        `host ${JSON.stringify(host)} is not lowercase; domain.host is stored lowercase, so pass ${JSON.stringify(host.toLowerCase())}`,
        { host },
      );
    }
    if (!HOST_RE.test(host)) {
      throw new ImportRefusal(
        'SKW_E_IMP_HOST_INVALID',
        `host ${JSON.stringify(host)} is not a hostname this control plane accepts (lowercase letters, digits, dots and hyphens, at least one dot)`,
        { host },
      );
    }
    if (!requested.includes(host)) requested.push(host);
  }

  const primary = request.primary ?? (requested[0] as string);
  if (request.primary !== undefined && !requested.includes(request.primary)) {
    throw new ImportRefusal(
      'SKW_E_IMP_PRIMARY_UNKNOWN',
      `--primary ${request.primary} is not one of the --host values (${requested.join(', ')})`,
      { primary: request.primary, hosts: requested },
    );
  }

  const out: ImportedHost[] = [];
  const seen = new Set<string>();
  const add = (host: string, wildcardAlias: boolean): void => {
    if (seen.has(host)) return;
    seen.add(host);
    const isPrimary = host === primary;
    out.push({ host, kind: isPrimary ? 'primary' : 'alias', isPrimary: isPrimary ? 1 : 0, certState: 'none', wildcardAlias });
  };
  add(primary, false);
  for (const host of requested) add(host, false);

  if (request.wildcard !== undefined) {
    const parent = request.wildcard.trim().toLowerCase();
    if (!HOST_RE.test(parent)) {
      throw new ImportRefusal(
        'SKW_E_IMP_WILDCARD_INVALID',
        `--wildcard ${JSON.stringify(request.wildcard)} is not a hostname (a wildcard certificate for *.${parent} needs a parent like "example.test")`,
        { wildcard: request.wildcard },
      );
    }
    for (const host of requested) {
      // A wildcard for `*.parent` covers exactly one label under it, so the alias is the tenant's
      // own name sequence placed under that parent: `test.com` + `example.test` is
      // `test.com.example.test`, which `*.example.test` does cover.
      const alias = `${host}.${parent}`;
      if (!HOST_RE.test(alias) || alias.length > 253) {
        throw new ImportRefusal(
          'SKW_E_IMP_WILDCARD_INVALID',
          `--wildcard ${parent} would register ${alias}, which is not a hostname`,
          { wildcard: parent, host, alias },
        );
      }
      add(alias, true);
    }
  }
  return out;
}

/** A DNS name as nginx writes it, or a refusal that names the reserved role it collides with. */
export function assertNotDemosHost(hosts: readonly ImportedHost[], demosHost: string | null): void {
  if (demosHost === null) return;
  const clash = hosts.find((h) => h.host === demosHost);
  if (clash === undefined) return;
  throw new ImportRefusal(
    'SKW_E_IMP_HOST_RESERVED',
    `${demosHost} is the demos vhost (SKW_ADMIN_ORIGIN derives it); a domain row for it would shadow /demo/ with a tenant block`,
    { host: clash.host, demos_host: demosHost },
  );
}

// --------------------------------------------------------------------------- verification

function manifestFiles(manifest: Manifest): ManifestFile[] {
  if (!Array.isArray(manifest.files)) return [];
  return manifest.files.map((raw) => {
    const entry = raw as { path?: unknown; sha256?: unknown };
    if (typeof entry.path !== 'string' || typeof entry.sha256 !== 'string') {
      throw new ImportRefusal('SKW_E_IMP_MANIFEST_INVALID', 'BUNDLE.json has a files[] entry that is not {path, sha256}');
    }
    return { path: entry.path, sha256: entry.sha256 };
  });
}

function normaliseManifestPath(path: string): string {
  const slashed = path.replace(/\\/g, '/');
  if (slashed.startsWith('/') || slashed.split('/').includes('..')) {
    throw new ImportRefusal('SKW_E_IMP_ENTRY_UNSAFE', `BUNDLE.json lists a path that escapes the bundle: ${path}`, { path });
  }
  return posix.normalize(slashed);
}

/**
 * Verify the bundle **from the entries alone**.
 *
 * The two hashes a bundle carries are different questions: `files[].sha256` is the hash of what a
 * reader gets when it follows the file (so a symlink hashes its target, exactly as
 * `bundle_verify` and `tar -h` do), while `hashTree` hashes the link's target **string** so two
 * trees whose links differ cannot compare equal. Both are checked here, in that order, and a
 * failure names the file rather than a count.
 */
export function verifyBundle(source: BundleSource): VerifiedBundle {
  const byPath = new Map<string, BundleEntry>();
  for (const entry of source.entries) byPath.set(entry.path, entry);

  const manifestEntry = byPath.get('BUNDLE.json');
  if (manifestEntry === undefined || manifestEntry.kind !== 'file' || manifestEntry.bytes === undefined) {
    throw new ImportRefusal('SKW_E_IMP_MANIFEST_MISSING', `${source.path} has no BUNDLE.json; it is not a site bundle`, {
      source: source.path,
    });
  }
  let manifest: Manifest;
  try {
    manifest = JSON.parse(manifestEntry.bytes.toString('utf8')) as Manifest;
  } catch (err) {
    throw new ImportRefusal('SKW_E_IMP_MANIFEST_INVALID', `BUNDLE.json is not JSON: ${(err as Error).message}`);
  }
  const files = manifestFiles(manifest);
  if (files.length === 0) {
    throw new ImportRefusal(
      'SKW_E_IMP_MANIFEST_INVALID',
      'BUNDLE.json carries no files[]; a bundle with nothing to verify is not a bundle',
    );
  }

  for (const file of files) {
    const path = normaliseManifestPath(file.path);
    if (isProtectedPath(path)) {
      throw new ImportRefusal('SKW_E_IMP_FORBIDDEN_PATH', `${file.path} is under content/protected/ — a render never travels in a bundle`, {
        path: file.path,
      });
    }
    const entry = byPath.get(path);
    if (entry === undefined) {
      throw new ImportRefusal('SKW_E_IMP_FILE_MISSING', `BUNDLE.json lists ${file.path}, and the bundle does not carry it`, {
        path: file.path,
      });
    }
    const resolved = resolveEntry(byPath, entry, file.path);
    const digest = sha256(resolved.bytes as Buffer);
    if (digest !== file.sha256.toLowerCase()) {
      throw new ImportRefusal(
        'SKW_E_IMP_HASH_MISMATCH',
        `${file.path} hashes to ${digest} but BUNDLE.json recorded ${file.sha256} — the bundle is not the export it claims`,
        { path: file.path, expected: file.sha256, actual: digest },
      );
    }
  }

  const dbEntry = byPath.get('data/site.db');
  if (dbEntry === undefined || dbEntry.kind !== 'file' || dbEntry.bytes === undefined) {
    throw new ImportRefusal('SKW_E_IMP_DB_MISSING', 'the bundle carries no data/site.db; there is no site to import', {
      source: source.path,
    });
  }

  const tenant = manifest.tenant ?? {};
  const bundleKey = typeof tenant.key === 'string' ? tenant.key : guessBundleKey(source.entries);
  if (bundleKey === null) {
    throw new ImportRefusal('SKW_E_IMP_MANIFEST_INVALID', 'BUNDLE.json names no tenant.key and the tree carries no data/tenants/<key>/');
  }
  const seed = readSeed(byPath);
  const displayName =
    (typeof tenant.display_name === 'string' && tenant.display_name !== '' ? tenant.display_name : undefined) ??
    seed?.displayName ??
    bundleKey;

  const plugins = readManifestPlugins(manifest);
  return {
    source,
    byPath,
    manifest,
    bundleKey,
    displayName,
    dbVersionClaim: typeof tenant.db_version === 'number' ? tenant.db_version : 0,
    files: files.length,
    plugins,
  };
}

/** A file entry, or the file a symlink resolves to inside the bundle. */
function resolveEntry(byPath: Map<string, BundleEntry>, entry: BundleEntry, named: string): BundleEntry {
  if (entry.kind === 'file') return entry;
  const target = entry.target ?? '';
  if (target.startsWith('/')) {
    throw new ImportRefusal('SKW_E_IMP_SYMLINK_ESCAPE', `${named} is an absolute symlink (${target}); a bundle's links are relative`, {
      path: named,
      target,
    });
  }
  const resolved = posix.normalize(posix.join(posix.dirname(entry.path), target));
  if (resolved.startsWith('..') || resolved.startsWith('/')) {
    throw new ImportRefusal('SKW_E_IMP_SYMLINK_ESCAPE', `${named} -> ${target} escapes the bundle`, { path: named, target });
  }
  const inside = byPath.get(resolved);
  if (inside === undefined) {
    throw new ImportRefusal('SKW_E_IMP_SYMLINK_ESCAPE', `${named} -> ${target} names ${resolved}, which the bundle does not carry`, {
      path: named,
      target,
      resolved,
    });
  }
  if (inside.kind !== 'file') {
    throw new ImportRefusal('SKW_E_IMP_SYMLINK_ESCAPE', `${named} -> ${target} resolves to another link, not a file`, {
      path: named,
      target,
    });
  }
  return inside;
}

function guessBundleKey(entries: readonly BundleEntry[]): string | null {
  for (const entry of entries) {
    const m = /^data\/tenants\/([^/]+)\/theme-assets\//.exec(entry.path);
    if (m !== null) return m[1] as string;
  }
  return null;
}

function readSeed(byPath: Map<string, BundleEntry>): { displayName: string | null } | null {
  const entry = byPath.get('data/control.seed.json');
  if (entry === undefined || entry.bytes === undefined) return null;
  try {
    const seed = JSON.parse(entry.bytes.toString('utf8')) as { tenants?: { display_name?: unknown }[] };
    const first = seed.tenants?.[0];
    const name = typeof first?.display_name === 'string' ? first.display_name : null;
    return { displayName: name };
  } catch {
    return null;
  }
}

function readManifestPlugins(manifest: Manifest): { id: string; version: string; files: number }[] {
  if (!Array.isArray(manifest.plugins)) return [];
  const out: { id: string; version: string; files: number }[] = [];
  for (const raw of manifest.plugins) {
    const pkg = raw as { id?: unknown; version?: unknown; files?: unknown };
    if (typeof pkg.id !== 'string') continue;
    out.push({
      id: pkg.id,
      version: typeof pkg.version === 'string' ? pkg.version : '',
      files: typeof pkg.files === 'number' ? pkg.files : 0,
    });
  }
  return out;
}

/** The root hash over a package's entries, byte-for-byte the rule `packageRootHash()` applies. */
export function packageRootOfEntries(entries: readonly BundleEntry[], prefix: string): { root: string; files: number } {
  const rows: { path: string; sha256: string }[] = [];
  for (const entry of entries) {
    if (entry.kind !== 'file' || entry.bytes === undefined) continue;
    if (!entry.path.startsWith(`${prefix}/`)) continue;
    rows.push({ path: entry.path.slice(prefix.length + 1), sha256: sha256(entry.bytes) });
  }
  rows.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const root = sha256(Buffer.from(rows.map((r) => `${r.path}\0${r.sha256}`).join('\n'), 'utf8'));
  return { root, files: rows.length };
}

// --------------------------------------------------------------------------- the database facts

interface DbFacts {
  userVersion: number;
  counts: Record<string, number>;
  plugins: { id: string; rootHash: string; enabled: number; testReport: string | null }[];
  pages: number;
  assets: number;
  variants: number;
  themeAssets: number;
}

/**
 * Read the bundle's database **without touching the destination**: the verified bytes go to one
 * temporary file, are opened read-only, and are re-used for the copy. Nothing is written to the
 * data directory until every check below has passed.
 */
function readDbFacts(bytes: Buffer, tmpDir: string, manifest: Manifest): { facts: DbFacts; path: string } {
  const path = join(tmpDir, 'bundle-site.db');
  writeFileSync(path, bytes);
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const userVersion = Number(db.pragma('user_version', { simple: true }));
    const counts: Record<string, number> = {};
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
      .all() as { name: string }[];
    for (const table of tables) {
      counts[table.name] = Number((db.prepare(`SELECT COUNT(*) AS n FROM "${table.name}"`).get() as { n: number }).n);
    }

    // `source_counts` is the producer's count of the snapshot (§11.4). Re-counting it here is what
    // distinguishes a `VACUUM INTO` bundle from a `cp` of a live WAL database: the copy carries
    // `site.db` but not `site.db-wal`, and the counts disagree by exactly the edits since the last
    // checkpoint. A tampered database disagrees too, which is the second reason to keep it.
    const declared = manifest.source_counts;
    if (declared !== null && typeof declared === 'object' && !Array.isArray(declared)) {
      for (const [table, count] of Object.entries(declared as Record<string, unknown>)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
          throw new ImportRefusal('SKW_E_IMP_MANIFEST_INVALID', `BUNDLE.json source_counts names ${JSON.stringify(table)}, which is not a table`);
        }
        const actual = counts[table] ?? -1;
        if (actual !== Number(count)) {
          throw new ImportRefusal(
            'SKW_E_IMP_COUNT_MISMATCH',
            `data/site.db has ${actual} row(s) in ${table} but BUNDLE.json source_counts says ${String(count)}` +
              ' — a copy of a live database is not a snapshot, and an edited one is not the export',
            { table, expected: Number(count), actual },
          );
        }
      }
    }

    const hasPlugins = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cms_plugin_installed'`)
      .get() as { name: string } | undefined;
    const plugins =
      hasPlugins === undefined
        ? []
        : (
            db
              .prepare('SELECT plugin_id, root_hash, enabled, test_report_sha FROM cms_plugin_installed ORDER BY plugin_id')
              .all() as { plugin_id: string; root_hash: string; enabled: number; test_report_sha: string | null }[]
          ).map((row) => ({
            id: row.plugin_id,
            rootHash: row.root_hash,
            enabled: Number(row.enabled),
            testReport: row.test_report_sha,
          }));

    return {
      path,
      facts: {
        userVersion,
        counts,
        plugins,
        pages: counts.cms_page ?? 0,
        assets: counts.cms_asset ?? 0,
        variants: counts.cms_asset_variant ?? 0,
        themeAssets: counts.cms_theme_asset ?? 0,
      },
    };
  } finally {
    db.close();
  }
}

// --------------------------------------------------------------------------- writing

/**
 * A write that failed, as a named refusal.
 *
 * The three "no more bytes" errnos become `SKW_E_IMP_INSUFFICIENT_DISK` — the same distinction
 * `skw-export` makes — and everything else is `SKW_E_IMP_WRITE_FAILED`. A raw stack trace from
 * `writeFileSync` tells an operator nothing they can act on and hides which step of the import
 * stopped.
 */
function writeFailure(err: unknown, what: string): never {
  if (err instanceof ImportRefusal) throw err;
  const code = (err as NodeJS.ErrnoException).code ?? '';
  if (code === 'ENOSPC' || code === 'EDQUOT' || code === 'EFBIG') {
    throw new ImportRefusal('SKW_E_IMP_INSUFFICIENT_DISK', `the filesystem ran out of space ${what} (${code})`, { errno: code });
  }
  throw new ImportRefusal('SKW_E_IMP_WRITE_FAILED', `${what} failed: ${(err as Error).message ?? String(err)}`, {
    errno: code === '' ? null : code,
  });
}

function writeFileEntry(path: string, bytes: Buffer, mode: number): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) rmSync(path, { force: true });
    writeFileSync(path, bytes, { mode });
  } catch (err) {
    writeFailure(err, `writing ${path}`);
  }
}

function writeSymlink(path: string, target: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) rmSync(path, { force: true });
    symlinkSync(target, path);
  } catch (err) {
    writeFailure(err, `linking ${path} -> ${target}`);
  }
}

function removeQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // already absent
  }
}

/** Copy a file's mode as well as its bytes: `install.sh` is the one member that must stay 0755. */
function modeOfEntry(entry: BundleEntry): number {
  return entry.mode === 0o755 ? 0o755 : 0o644;
}

// --------------------------------------------------------------------------- import

export function importSite(request: ImportRequest): ImportSummary {
  const tenantKey = request.tenantKey.trim();
  if (!TENANT_KEY_RE.test(tenantKey)) {
    throw new ImportRefusal(
      'SKW_E_IMP_TENANT_KEY_INVALID',
      `tenant key ${JSON.stringify(request.tenantKey)} is not a tenant key (lowercase letters, digits and hyphens, 2-40 chars, starting with a letter or digit)`,
      { tenant: request.tenantKey },
    );
  }
  const hosts = planHosts(request);
  if (hosts.length === 0) throw new ImportRefusal('SKW_E_IMP_USAGE', 'an import needs at least one host', {}, 2);
  assertNotDemosHost(hosts, request.demosHost ?? null);

  const dataDir = request.dataDir;
  const schemaDir = request.schemaDir ?? join(findProjectRoot(), 'schema');

  // --- 1. read + verify: nothing is written yet ------------------------------------
  const source = readBundleSource(request.source);
  const verified = verifyBundle(source);

  const tmpDir = mkdtempSync(join(tmpdir(), 'skw-import-'));
  let control: Database.Database | null = null;
  try {
    const db = readDbFacts(verified.byPath.get('data/site.db')?.bytes as Buffer, tmpDir, verified.manifest);
    const facts = db.facts;
    assertBundlePluginsMatch(verified, facts.plugins);

    const target = targetVersion(join(schemaDir, 'site.sql'));
    if (facts.userVersion > target) {
      throw new ImportRefusal(
        'SKW_E_IMP_SCHEMA_NEWER',
        `the bundle's site.db is at schema ${facts.userVersion} and this image is at ${target}; upgrade this instance before importing it`,
        { bundle: facts.userVersion, image: target },
      );
    }

    // --- 2. the two ownership questions, still before any write -------------------
    const controlPath = join(dataDir, 'control.db');
    const migrated = migrateControl(controlPath, schemaDir);
    if (!migrated.ok) {
      throw new ImportRefusal('SKW_E_IMP_CONTROL_FAILED', `control.db could not be migrated: ${migrated.error ?? 'unknown'}`, {
        path: controlPath,
        error: migrated.error ?? null,
      });
    }
    control = new Database(controlPath);
    control.pragma('busy_timeout = 8000');
    control.pragma('journal_mode = WAL');

    const existing = control.prepare('SELECT id, key FROM tenant WHERE key = ?').get(tenantKey) as
      | { id: number; key: string }
      | undefined;
    if (existing !== undefined && request.replace !== true) {
      throw new ImportRefusal(
        'SKW_E_IMP_TENANT_EXISTS',
        `tenant ${tenantKey} already exists; pass --replace to bring its database forward from this bundle`,
        { tenant: tenantKey, tenant_id: existing.id },
      );
    }
    const wanted = hosts.map((h) => h.host);
    const placeholders = wanted.map(() => '?').join(', ');
    const taken = control.prepare(`SELECT host, tenant_id FROM domain WHERE host IN (${placeholders})`).all(...wanted) as {
      host: string;
      tenant_id: number;
    }[];
    const foreign = taken.filter((row) => row.tenant_id !== (existing?.id ?? -1));
    if (foreign.length > 0) {
      throw new ImportRefusal(
        'SKW_E_IMP_HOST_TAKEN',
        `${foreign.map((row) => row.host).join(', ')} already belong${foreign.length === 1 ? 's' : ''} to another tenant; domain.host is UNIQUE and this import will not steal it`,
        { hosts: foreign.map((row) => ({ host: row.host, tenant_id: row.tenant_id })), tenant: tenantKey },
      );
    }

    // --- 3. the state -------------------------------------------------------------
    const siteDb = join(dataDir, 'tenants', tenantKey, 'site.db');
    try {
      mkdirSync(dirname(siteDb), { recursive: true });
      for (const suffix of ['', '-wal', '-shm']) removeQuietly(`${siteDb}${suffix}`);
      copyFileSync(db.path, siteDb);
    } catch (err) {
      writeFailure(err, `placing ${siteDb}`);
    }
    const report = migrateTenant(siteDb, tenantKey, schemaDir);
    if (!report.ok) {
      throw new ImportRefusal('SKW_E_IMP_MIGRATION_FAILED', `the imported database could not be migrated: ${report.error ?? 'unknown'}`, {
        tenant: tenantKey,
        from: report.from,
        to: report.to,
        error: report.error ?? null,
      });
    }
    const dbVersion = readUserVersion(siteDb);

    const content = copyContent(verified, dataDir);
    const themeFiles = copyThemeAssets(verified, dataDir, tenantKey);
    const pluginFiles = copyPlugins(verified, dataDir);

    writeControlRows(control, {
      tenantKey,
      displayName: verified.displayName,
      dbVersion,
      hosts,
      existing: existing !== undefined,
    });

    return {
      tenant: tenantKey,
      displayName: verified.displayName,
      hosts,
      pages: facts.pages,
      assets: facts.assets,
      variants: facts.variants,
      themeAssets: Math.max(facts.themeAssets, themeFiles),
      plugins: verified.plugins.map((p) => ({ ...p, files: pluginFiles.get(p.id) ?? p.files })),
      dbVersion,
      siteDb,
      contentRoot: content,
      source: { path: source.path, kind: source.kind, files: source.entries.length },
      replaced: existing !== undefined,
    };
  } finally {
    control?.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

function readUserVersion(path: string): number {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return Number(db.pragma('user_version', { simple: true }));
  } finally {
    db.close();
  }
}

/**
 * Every `cms_plugin_installed` row must be accompanied by the package the exporter shipped and
 * the bytes must still hash to the root the row recorded. A row without code is a site whose
 * widget 500s on first render; code that is not the tested bytes is a different plugin wearing
 * the same id.
 */
function assertBundlePluginsMatch(bundle: VerifiedBundle, rows: readonly { id: string; rootHash: string }[]): void {
  for (const row of rows) {
    const prefix = `data/plugins/${row.id}`;
    const has = bundle.byPath.get(`${prefix}/plugin.json`);
    if (has === undefined) {
      throw new ImportRefusal('SKW_E_IMP_PLUGIN_PACKAGE', `${row.id} has a cms_plugin_installed row but the bundle carries no ${prefix}/plugin.json`, {
        plugin: row.id,
        prefix,
      });
    }
    const root = packageRootOfEntries(bundle.source.entries, prefix).root;
    if (root !== row.rootHash) {
      throw new ImportRefusal(
        'SKW_E_IMP_PLUGIN_PACKAGE',
        `${row.id}: the package root is ${root} but the installed row recorded ${row.rootHash} — the bytes changed after install`,
        { plugin: row.id, expected: row.rootHash, actual: root },
      );
    }
  }
}

/**
 * `content/media/**` and `content/public/**`, with the public tree's **relative symlinks
 * preserved**.
 *
 * The layout is the installed one (§12.2: `./content:/srv/content`), so a link that read
 * `../media/hh/<sha>.jpg` beside the bundle still reads that way beside the site — and the farm
 * keeps one copy of every blob instead of two.
 */
function copyContent(bundle: VerifiedBundle, dataDir: string): string {
  const root = join(dataDir, 'content');
  for (const entry of bundle.source.entries) {
    if (!entry.path.startsWith('content/media/') && !entry.path.startsWith('content/public/')) continue;
    const rel = entry.path.slice('content/'.length);
    const dest = join(root, ...rel.split('/'));
    if (entry.kind === 'symlink') writeSymlink(dest, entry.target ?? '');
    else writeFileEntry(dest, entry.bytes as Buffer, modeOfEntry(entry));
  }
  return root;
}

/** `data/tenants/<bundleKey>/theme-assets/**` → `data/tenants/<newKey>/theme-assets/**`. */
function copyThemeAssets(bundle: VerifiedBundle, dataDir: string, tenantKey: string): number {
  const prefix = `data/tenants/${bundle.bundleKey}/theme-assets/`;
  let written = 0;
  for (const entry of bundle.source.entries) {
    if (!entry.path.startsWith(prefix)) continue;
    const rel = entry.path.slice(prefix.length);
    const dest = join(dataDir, 'tenants', tenantKey, 'theme-assets', ...rel.split('/'));
    if (entry.kind === 'symlink') writeSymlink(dest, entry.target ?? '');
    else writeFileEntry(dest, entry.bytes as Buffer, modeOfEntry(entry));
    written += 1;
  }
  return written;
}

/**
 * `data/plugins/<id>/**` → `<data>/plugins/<id>/**`, verbatim.
 *
 * This is not a signed install and does not pretend to be one: the rows in the imported
 * `site.db` already name the package and its root hash, this copy is the bytes those rows
 * describe, and the check above proved it. What a signed install adds — a publisher key this box
 * trusts — is a decision for the operator on **this** box, made with `skwctl plugin trust import`.
 */
function copyPlugins(bundle: VerifiedBundle, dataDir: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of bundle.source.entries) {
    const m = /^data\/plugins\/([^/]+)\/(.+)$/.exec(entry.path);
    if (m === null) continue;
    const id = m[1] as string;
    const rel = m[2] as string;
    const dest = join(dataDir, 'plugins', id, ...rel.split('/'));
    if (entry.kind === 'symlink') writeSymlink(dest, entry.target ?? '');
    else writeFileEntry(dest, entry.bytes as Buffer, modeOfEntry(entry));
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

interface ControlWrite {
  tenantKey: string;
  displayName: string;
  dbVersion: number;
  hosts: readonly ImportedHost[];
  existing: boolean;
}

/**
 * The control rows: the tenant and one domain row per host.
 *
 * `--replace` keeps the tenant's **id**, so sessions, users and every foreign key that points at
 * the tenant survive the import; it demotes the tenant's existing domain rows to `is_primary = 0`
 * first, because `ux_domain_primary` allows exactly one primary and an old primary left standing
 * would make the new one a constraint error instead of a routing change.
 *
 * `cert_state` is always `none`: `issued` is written only by the ACME service, after it has
 * written a certificate on **this** host. A bundle that says `issued` is describing the source
 * box's filesystem (§4e's first-compose-up failure, verbatim).
 */
function writeControlRows(control: Database.Database, write: ControlWrite): void {
  const tx = control.transaction(() => {
    let tenantId: number;
    if (write.existing) {
      const row = control.prepare('SELECT id FROM tenant WHERE key = ?').get(write.tenantKey) as { id: number };
      tenantId = row.id;
      control
        .prepare(`UPDATE tenant SET mode = 'production', status = 'active', display_name = ?, db_version = ? WHERE id = ?`)
        .run(write.displayName, write.dbVersion, tenantId);
      control.prepare('UPDATE domain SET is_primary = 0 WHERE tenant_id = ? AND is_primary = 1').run(tenantId);
    } else {
      const info = control
        .prepare(
          `INSERT INTO tenant (key, mode, status, display_name, db_version)
           VALUES (?, 'production', 'active', ?, ?)`,
        )
        .run(write.tenantKey, write.displayName, write.dbVersion);
      tenantId = Number(info.lastInsertRowid);
    }

    const findDomain = control.prepare('SELECT id FROM domain WHERE host = ?');
    const insertDomain = control.prepare(
      `INSERT INTO domain (host, tenant_id, kind, is_primary, cert_state) VALUES (?, ?, ?, ?, 'none')`,
    );
    const updateDomain = control.prepare('UPDATE domain SET tenant_id = ?, kind = ?, is_primary = ? WHERE id = ?');
    for (const host of write.hosts) {
      const row = findDomain.get(host.host) as { id: number } | undefined;
      if (row === undefined) insertDomain.run(host.host, tenantId, host.kind, host.isPrimary);
      else updateDomain.run(tenantId, host.kind, host.isPrimary, row.id);
    }
  });
  try {
    tx();
  } catch (err) {
    writeFailure(err, 'writing the control rows (tenant and domain)');
  }
}

// --------------------------------------------------------------------------- nginx

/**
 * Rewrite `nginx/conf.d/10-app.conf` from the control plane — only when asked.
 *
 * In a repository checkout that file is **committed**, and a deploy diffs it; an import that
 * rewrote it as a side effect would be a change nobody asked for in the review of a different
 * change. `--nginx` is the operator saying "this box's edge is mine to regenerate".
 */
export function regenerateAppConf(opts: {
  dataDir: string;
  out: string;
  demosHost: string;
  boxRps?: number;
  adminAllowlist?: readonly string[];
}): { path: string; lines: number } {
  const rows = readHosts(join(opts.dataDir, 'control.db'));
  const text = generateAppConf(rows, {
    demosHost: opts.demosHost,
    ...(opts.boxRps === undefined ? {} : { boxRps: opts.boxRps }),
    adminAllowlist: opts.adminAllowlist ?? [],
  });
  mkdirSync(dirname(opts.out), { recursive: true });
  writeFileSync(opts.out, text);
  return { path: opts.out, lines: text.split('\n').length };
}
