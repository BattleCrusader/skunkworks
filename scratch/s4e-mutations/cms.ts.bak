/**
 * Target 1 — **the CMS bundle** (§11.1–§11.6, O-19/O-20/O-22).
 *
 * `docker compose up` on the client's box, with their content, their media library, their
 * editor and their download plane. The tree is:
 *
 *     docker-compose.yml  install.sh  nginx/**  snippets/**  schema/**  tools/**
 *     data/site.db  data/control.seed.json
 *     content/media/**  content/public/** (relative symlinks)
 *     BUNDLE.json  EXPORT-NOTES.md
 *
 * Three things here are not file copies:
 *
 * **`data/site.db` is `VACUUM INTO`, then projected.** A `cp` copy of a live database is
 * the fixture §16 S4 says must fail `--verify`: it carries the `-wal`, a torn page or a
 * hot journal, and it copies tables the projection classifies `empty` (purchaser emails,
 * watermark renders, audit rows). `VACUUM INTO` writes one consistent file, and the
 * projection's `empty`/`filtered` classes are applied to that copy inside a transaction
 * with `foreign_keys=OFF`, then `PRAGMA foreign_key_check` must be silent.
 *
 * **The counts are the producer's.** §11.4's lesson is that a verifier reading the same
 * broken file cannot see a loss the copy introduced: a `cp` bundle passed 27/27 checks and
 * served 201 pages where the source had 241. So every table is counted on the source
 * before the snapshot, on the source after it, and inside the snapshot, and a disagreement
 * is `SKW_E_EXP_NOT_QUIESCENT` (exit 24), not a warning.
 *
 * **The seed is a claim marker, not a credential** (§11.6). Its `password_hash` is the
 * frozen `schema/control.seed.json` value — a real argon2id hash of 32 bytes nobody holds.
 * A fresh random salt per export would make two exports of one database differ, and it
 * would be no stronger: the bytes are discarded either way. `totp_secret` stays NULL, so a
 * bundle can never ship a working second factor.
 */
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { dirname, join, normalize, sep } from 'node:path';

import { generateAppConf } from '../../tools/nginx_gen.ts';
import { renderNotes } from './notes.ts';
import { cspConf } from '../render/csp.ts';
import { assetFile, symlinkTarget, type Projection } from './project.ts';
import type { TreeFile } from './tree.ts';

export interface HostSpec {
  host: string;
  kind: string;
  isPrimary: number;
  certState: string;
}

export interface TenantSpec {
  key: string;
  mode: string;
  status: string;
  displayName: string;
  dbVersion: number;
  hosts: HostSpec[];
}

export interface CmsOptions {
  projection: Projection;
  sourceDb: Database.Database;
  contentRoot: string;
  repoRoot: string;
  tenant: TenantSpec;
  /** A directory this writer may use for the one temporary file (`VACUUM INTO`). */
  tmpDir: string;
  /**
   * The installed packages, each already hashed and compared with its
   * `cms_plugin_installed.root_hash` by the caller (S4d). The bundle ships them under
   * `data/plugins/<id>/`, which is exactly where compose mounts `/srv/plugins:ro`.
   */
  pluginPackages?: PluginPackage[];
  adminHost?: string;
  demosHost?: string;
  /** `{app_digest, runner_digest}`; read from the compose file when absent. */
  image?: { appDigest: string; runnerDigest: string };
  origin?: string;
}

/** One installed package, as the exporter received it. */
export interface PluginPackage {
  /** `cms_plugin_installed.id`, so a refusal can name the row and not only the plugin. */
  row: number;
  id: string;
  version: string;
  root_hash: string;
  dir: string;
  files: { path: string; bytes: number; sha256: string }[];
  error?: string;
}

interface ProjectionTable {
  mode: 'rows' | 'empty' | 'filtered';
  filter?: string;
}

interface ProjectionFile {
  version: number;
  schema_version: number;
  tables: Record<string, ProjectionTable>;
}

const INFRA = new Set([
  'docker-compose.yml',
  'install.sh',
  'BUNDLE.json',
  'EXPORT-NOTES.md',
]);

function fileClass(path: string): string {
  if (path === 'data/site.db') return 'db';
  if (path.startsWith('content/media/')) return 'media';
  if (path.startsWith('content/public/')) return 'media';
  if (path.startsWith('data/')) return 'content';
  if (INFRA.has(path)) return 'infra';
  return 'infra';
}

/** Every table in a database, sorted. */
export function tableNames(db: Database.Database): string[] {
  return (
    db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all() as {
      name: string;
    }[]
  )
    .map((r) => r.name)
    .sort();
}

export function tableCounts(db: Database.Database): Record<string, number> {
  const out: Record<string, number> = {};
  for (const name of tableNames(db)) {
    out[name] = Number((db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }).n);
  }
  return out;
}

/**
 * The C-5 check, on the database the bundle actually contains: every table is in
 * `schema/export-projection.json`, or has a `u_` / `p_` prefix. A table the projection has
 * never classified is a build failure — it would ship rows nobody decided to ship.
 */
export function assertClassified(db: Database.Database, projection: ProjectionFile): void {
  const missing = tableNames(db).filter(
    (name) => projection.tables[name] === undefined && !name.startsWith('u_') && !name.startsWith('p_'),
  );
  if (missing.length > 0) {
    throw new Error(`export projection is incomplete: ${missing.join(', ')} (C-5: a table without a class is a build failure)`);
  }
}

/** Apply `empty` and `filtered` to the bundle's own copy. Returns the tables it touched. */
export function applyProjection(db: Database.Database, projection: ProjectionFile): string[] {
  assertClassified(db, projection);
  const present = new Set(tableNames(db));
  const touched: string[] = [];
  db.pragma('foreign_keys = OFF');
  db.exec('BEGIN');
  /**
   * `cms_audit` has a `BEFORE DELETE` trigger that raises `SKW_E_DM_COLUMN_IMMUTABLE`, and
   * the projection says the table ships **empty**. A real tenant has audit rows (our
   * operators worked on the site), so the naive `DELETE` aborts the whole export — a
   * defect that would first appear on the first client with a working install, which is
   * the second customer. The trigger is dropped **inside the transaction**, the rows go,
   * and the trigger is re-created from its own `sqlite_master.sql` before COMMIT: the
   * bundle's schema is the tenant's schema, not a weakened one. The empty-fixture case
   * (T4) passes either way; P8 is the case that has rows.
   */
  const guards: { name: string; sql: string }[] = [];
  try {
    for (const table of Object.entries(projection.tables)) {
      if (table[1].mode !== 'empty' || !present.has(table[0])) continue;
      const triggers = db
        .prepare(
          `SELECT name, sql FROM sqlite_master
            WHERE type = 'trigger' AND tbl_name = ? AND sql LIKE '%BEFORE DELETE%'`,
        )
        .all(table[0]) as { name: string; sql: string }[];
      for (const trigger of triggers) {
        guards.push(trigger);
        db.prepare(`DROP TRIGGER "${trigger.name}"`).run();
      }
    }
    for (const [name, table] of Object.entries(projection.tables)) {
      if (!present.has(name)) continue;
      if (table.mode === 'empty') {
        db.prepare(`DELETE FROM "${name}"`).run();
        touched.push(name);
      } else if (table.mode === 'filtered') {
        if (table.filter === undefined) throw new Error(`export projection: ${name} is filtered with no predicate`);
        db.prepare(`DELETE FROM "${name}" WHERE NOT (${table.filter})`).run();
        touched.push(name);
      }
    }
    for (const guard of guards) db.exec(guard.sql);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  db.pragma('foreign_keys = ON');
  const broken = db.prepare('PRAGMA foreign_key_check').all() as unknown[];
  if (broken.length > 0) throw new Error(`the projected snapshot has ${broken.length} dangling foreign key(s)`);
  return touched;
}

/**
 * §11.4's comparison, as a pure function so the refusal can be tested without a second
 * writer: source before, source after, and the snapshot must agree on every table whose
 * class is `rows` (the only class where the source and the bundle hold the same rows).
 */
export function countsAgree(
  before: Record<string, number>,
  after: Record<string, number>,
  snapshot: Record<string, number>,
  rowsTables: readonly string[],
): { ok: true } | { ok: false; disagree: { table: string; before: number; after: number; snapshot: number }[] } {
  const disagree: { table: string; before: number; after: number; snapshot: number }[] = [];
  for (const table of rowsTables) {
    const b = before[table] ?? 0;
    const a = after[table] ?? 0;
    const s = snapshot[table] ?? 0;
    if (b !== a || b !== s) disagree.push({ table, before: b, after: a, snapshot: s });
  }
  return disagree.length === 0 ? { ok: true } : { ok: false, disagree };
}

function seedFor(tenant: TenantSpec, repoRoot: string): string {
  // The frozen seed, re-pointed at this tenant. Its `$comment`, its hash and its
  // `schema_version` are the shipped ones — the seed is a file the install path already
  // proves, not a new format invented by the exporter.
  const template = JSON.parse(readFileSync(join(repoRoot, 'schema', 'control.seed.json'), 'utf8')) as {
    tenants: { key: string; display_name?: string; mode: string; status: string; hosts: unknown[] }[];
    users: { tenant: string; email: string }[];
  } & Record<string, unknown>;
  const first = template.tenants[0];
  const user = template.users[0];
  if (first === undefined || user === undefined) throw new Error('schema/control.seed.json is not the shape the exporter expects');
  first.key = tenant.key;
  first.display_name = tenant.displayName;
  first.mode = tenant.mode;
  first.status = tenant.status;
  first.hosts = tenant.hosts.map((h) => ({
    host: h.host,
    kind: h.kind,
    is_primary: h.isPrimary,
    // S4e: a bundle **never** carries a certificate. A private key is per-host state (its
    // absence is why compose mounts `./certs` rather than shipping one), so a seed that said
    // `issued` was a claim about the *source* box's filesystem travelling to a box that has
    // none of it — the S4 QA's first-compose-up failure, verbatim: nginx refused to start
    // because `acme.test.crt` did not exist. `issued` is written only by the `acme` service,
    // after it has written the file on *this* host; the exporter's claim is `none`.
    cert_state: 'none',
  }));
  user.tenant = tenant.key;
  user.email = `owner@${tenant.hosts[0]?.host ?? `${tenant.key}.invalid`}`;
  return `${JSON.stringify(template, null, 2)}\n`;
}

/**
 * The compose file, with the image digests this bundle was cut from. The repo's file
 * carries a placeholder digest (`sha256:000…`) because a source tree has no release; a
 * bundle's does, and shipping the placeholder would be a bundle that pulls nothing.
 */
function composeFor(repoRoot: string, image: { appDigest: string; runnerDigest: string }): string {
  const source = readFileSync(join(repoRoot, 'docker-compose.yml'), 'utf8');
  return source
    .replace(/(ghcr\.io\/skunkworks\/app@sha256:)[0-9a-f]{64}/, `$1${image.appDigest}`)
    .replace(/(ghcr\.io\/skunkworks\/runner@sha256:)[0-9a-f]{64}/, `$1${image.runnerDigest}`);
}

function digestFromCompose(repoRoot: string, service: 'app' | 'runner'): string {
  const text = readFileSync(join(repoRoot, 'docker-compose.yml'), 'utf8');
  const match = new RegExp(`ghcr\\.io/skunkworks/${service}@sha256:([0-9a-f]{64})`).exec(text);
  if (match?.[1] === undefined) throw new Error(`docker-compose.yml names no ${service} digest`);
  return match[1];
}

export interface CmsPlan {
  files: TreeFile[];
  /** `BUNDLE.json` as written, for a gate that reads it back. */
  manifest: Record<string, unknown>;
  touched: string[];
}

export function planCms(options: CmsOptions): CmsPlan {
  const { projection, tenant } = options;
  const repoRoot = options.repoRoot;
  const adminHost = options.adminHost ?? 'admin.skw.test';
  const demosHost = options.demosHost ?? 'demos.skw.test';
  const image = options.image ?? {
    appDigest: digestFromCompose(repoRoot, 'app'),
    runnerDigest: digestFromCompose(repoRoot, 'runner'),
  };
  const files: TreeFile[] = [];

  // --- 1. the snapshot ------------------------------------------------------------
  const projectionFile = JSON.parse(readFileSync(join(repoRoot, 'schema', 'export-projection.json'), 'utf8')) as ProjectionFile;
  const before = tableCounts(options.sourceDb);
  // A **unique** name, not `site.db` (S4c, found while re-exporting from an installed
  // bundle): `tmpDir` is the data directory, and in a bundle `data/site.db` is the tenant's
  // shipped database. A temp called `site.db` therefore overwrote the bundle's own source of
  // truth and then deleted it — visible only when the operator re-cuts a bundle from an
  // installed tree, which is the normal way to ship an edit. The pid keeps two writers from
  // sharing it; the export lock already serialises them per tenant.
  const tmp = join(options.tmpDir, `.export-${tenant.key}-${process.pid}.snapshot.db`);
  rmSync(tmp, { force: true });
  rmSync(`${tmp}-wal`, { force: true });
  rmSync(`${tmp}-shm`, { force: true });
  options.sourceDb.prepare('VACUUM INTO ?').run(tmp);
  const after = tableCounts(options.sourceDb);

  const snapshot = new Database(tmp);
  let touched: string[] = [];
  let inside: Record<string, number> = {};
  try {
    touched = applyProjection(snapshot, projectionFile);
    inside = tableCounts(snapshot);
  } finally {
    snapshot.close();
  }

  const rowsTables = Object.entries(projectionFile.tables)
    .filter(([, table]) => table.mode === 'rows')
    .map(([name]) => name);
  const agreement = countsAgree(before, after, inside, rowsTables);
  if (!agreement.ok) {
    const first = agreement.disagree[0];
    throw new Error(
      `SKW_E_EXP_NOT_QUIESCENT: ${agreement.disagree.length} table(s) disagree; ${first?.table}: source ${first?.before}/${first?.after}, snapshot ${first?.snapshot}`,
    );
  }

  files.push({ path: 'data/site.db', bytes: readFileSync(tmp) });
  rmSync(tmp, { force: true });

  // --- 2. the seed and the infra --------------------------------------------------
  files.push({ path: 'data/control.seed.json', bytes: seedFor(tenant, repoRoot) });
  files.push({ path: 'docker-compose.yml', bytes: composeFor(repoRoot, image) });
  files.push({ path: 'install.sh', bytes: readFileSync(join(repoRoot, 'install.sh')), mode: 0o755 });
  for (const path of [
    'nginx/nginx.conf',
    'nginx/conf.d/00-default.conf',
    'snippets/skunk-proxy.conf',
    'schema/control.sql',
    'schema/site.sql',
    'tools/bundle_verify.mjs',
    'tools/seed_control.mjs',
    'tools/control_db.mjs',
    // S4e: the install mints a self-signed pair per host before nginx starts (§12.5).
    'tools/install_certs.mjs',
  ]) {
    files.push({ path, bytes: readFileSync(join(repoRoot, path)) });
  }

  // The edge config is generated for **this tenant only** ($tenant map, one server block
  // per host, the demos and admin vhosts). Copying the platform's `nginx/conf.d` would
  // carry every other client's server_name into a bundle handed to one of them.
  const conf = generateAppConf(
    tenant.hosts.map((h) => ({ host: h.host, key: tenant.key, cert_state: h.certState })),
    { adminHost, demosHost, boxRps: 192, adminAllowlist: [] },
  );
  files.push({ path: 'nginx/conf.d/10-app.conf', bytes: conf });
  // §10.5 (C-12, S4c): the same one line the live site sends and the other two targets ship.
  // `10-app.conf` includes it inside the locations nginx serves itself (`/media/`, the
  // protected tree); documents proxied from the app already carry the header, and a second
  // copy on the same response would be two policies where the SDS promises one.
  files.push({ path: 'snippets/skunk-csp.conf', bytes: cspConf() });

  // --- 2b. the packages (S4d) ------------------------------------------------------
  // `data/plugins/<id>/…` is the layout compose mounts read-only at `/srv/plugins`, so a
  // bundle that is installed (or re-cut from an installed tree) is already the tree the
  // runner loads. Every byte was hashed by the caller against the install row.
  const pluginPackages = options.pluginPackages ?? [];
  for (const pkg of pluginPackages) {
    for (const file of pkg.files) {
      files.push({ path: `data/plugins/${pkg.id}/${file.path}`, bytes: readFileSync(join(pkg.dir, file.path)) });
    }
  }

  // --- 3. the bytes ---------------------------------------------------------------
  // The bundle ships the whole library (it is the CMS: the client edits it), so every
  // non-gated row and every gated row travels. The public farm carries one relative
  // symlink per **non-gated** row and nothing else (§7.1): a gated asset has no link, and
  // the link-absence test is what proves it.
  for (const asset of [...projection.library, ...projection.gated]) {
    files.push({ path: asset.storagePath, bytes: readFileSync(assetFile(options.contentRoot, asset)) });
  }
  for (const asset of projection.library) {
    const link = symlinkTarget(asset);
    files.push({ path: `content/public/${link.name}`, symlink: link.target });
  }

  // --- 4. the manifest ------------------------------------------------------------
  // `EXPORT-NOTES.md` is written before the manifest so it can be listed like any other
  // file; `BUNDLE.json` cannot list itself, and `bundle_verify` does not ask it to.
  const notes = renderNotes({
    target: 'cms',
    projection,
    ...(options.origin === undefined ? {} : { origin: options.origin }),
    lines: [
      '- **Run:** `tar xf`, then `./install.sh` (verify, `control.sql`, seed, `.env`, bootstrap, compose up).',
      `- **Files:** ${files.length + 2} (this manifest lists every one that ships).`,
      '- **Projection:** `data/site.db` is `VACUUM INTO`, then the export projection applied: the',
      '  `empty` tables carry no rows and the `filtered` ones carry no operator-only row.',
      '- **No download plane of ours:** `cms_download_code`, `cms_download_event`, `cms_form_submission`,',
      '  `cms_watermark_render`, `cms_audit` and `cms_plugin_revoked` ship empty, by class.',
      '- **No `content/protected/`, no `content/sources/`, no `control.db`, no `-wal`, no `-shm`.**',
      '- **First login:** `./install.sh --generate-password` writes an enrolment file; delete it after enrolling.',
    ],
  });
  files.push({ path: 'EXPORT-NOTES.md', bytes: notes });

  const entries = files.map((file) => manifestEntry(file, files));

  const manifest: Record<string, unknown> = {
    schema: 'skunkworks/site-bundle/v3',
    created_at: projection.exportNow,
    export_now: projection.exportNow,
    tenant: { key: tenant.key, mode: tenant.mode, db_version: tenant.dbVersion },
    hosts: tenant.hosts.map((h) => h.host),
    image: { app_digest: image.appDigest, runner_digest: image.runnerDigest },
    projection_version: projection.version,
    projection_sha: projection.projectionSha,
    source_counts: inside,
    files: entries,
    plugins: pluginPackages.map((pkg) => ({
      id: pkg.id,
      version: pkg.version,
      root_hash: pkg.root_hash,
      package: `data/plugins/${pkg.id}`,
      files: pkg.files.length,
    })),
    refusals: [],
    notes: [],
  };
  files.push({ path: 'BUNDLE.json', bytes: `${JSON.stringify(manifest, null, 2)}\n` });

  return { files, manifest, touched };
}

function sha256Of(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * One `files[]` entry.
 *
 * A symlink's entry records what a verifier **reads through it**, not the link text:
 * `bundle_verify` (and `sha256sum`, and `tar -h`) follow the link, so hashing the target
 * string would make every nested farm link a "sha256 mismatch". The link's own identity
 * is still checked — by `hashTree`, which hashes the target string so two trees whose
 * links differ cannot hash equal.
 */
function manifestEntry(
  file: TreeFile,
  all: readonly TreeFile[],
): { path: string; bytes: number; sha256: string; class: string } {
  if (file.symlink === undefined) {
    const bytes = file.bytes ?? '';
    return { path: file.path, bytes: Buffer.byteLength(bytes), sha256: sha256Of(bytes), class: fileClass(file.path) };
  }
  const resolved = normalize(join(dirname(file.path), file.symlink)).split(sep).join('/');
  const target = all.find((candidate) => candidate.path === resolved);
  if (target === undefined || target.bytes === undefined) {
    throw new Error(`the bundle's link ${file.path} -> ${file.symlink} points at a file this export does not write`);
  }
  return {
    path: file.path,
    bytes: Buffer.byteLength(target.bytes),
    sha256: sha256Of(target.bytes),
    class: fileClass(file.path),
  };
}
