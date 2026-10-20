/**
 * `runExport()` — the one entry point every target shares (§11.1, D22).
 *
 * The order is the whole design:
 *
 *   1. `buildProjection()` reads the content **once** and either returns a projection or a
 *      list of named refusals. Nothing is written before this returns, so a refused export
 *      leaves no half-tree for a client to install.
 *   2. `plan*()` turns that one projection into a list of `{path, bytes}` / `{path, symlink}`.
 *      No planner re-derives a URL, re-renders a body or reads `cms_page` — the projection
 *      is the only reader, and the three planners differ only in layout.
 *   3. `writeTree()` writes them sorted with pinned mtimes, and `hashTree()` hashes what is
 *      on disk. The hash is the export's receipt: two runs at one `SKW_EXPORT_NOW` must
 *      print the same number, and the gate asserts that rather than this comment.
 *
 * `SKW_EXPORT_NOW` is the only clock (§6.4). It is resolved once, here, and passed down —
 * a planner that called `Date.now()` would be a second clock, and two exports a second
 * apart would differ in a way the report would have to explain.
 */
import type Database from 'better-sqlite3';
import { closeSync, existsSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { planAstro } from './astro.ts';
import { planCms, type TenantSpec } from './cms.ts';
import { buildProjection, type ExportTarget, type Projection, type Refusal } from './project.ts';
import { planStatic } from './static.ts';
import { DiskFullError, freeBytes, hashTree, writeTree, type TreeFile, type TreeHash } from './tree.ts';

export interface ExportRequest {
  target: ExportTarget;
  /** The tenant's `site.db`, opened read-only by the caller. */
  db: Database.Database;
  tenantKey: string;
  /** Destination; must be absent or empty (a stale tree is not a second export). */
  out: string;
  /** `SKW_EXPORT_NOW`. */
  exportNow: string;
  /** The live `content/` root. */
  contentRoot: string;
  /** The platform's repository root (templates, lockfile, schema, tools). */
  repoRoot: string;
  /** A directory the CMS writer may use for its one temporary file. */
  tmpDir: string;
  origin?: string;
  /** Required for `cms`: the tenant's control-plane facts. */
  tenant?: TenantSpec;
  adminHost?: string;
  demosHost?: string;
}

export type ExportResult =
  | { ok: true; target: ExportTarget; out: string; projection: Projection; tree: TreeHash }
  | { ok: false; target: ExportTarget; refusals: Refusal[] };

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/**
 * `SKW_EXPORT_NOW`, or the wall clock when it is unset (the interactive CLI case).
 *
 * A value that is not UTC ISO 8601 is refused here rather than silently normalised: the
 * string is written into `BUNDLE.json` and is what two exports are compared at, so an
 * unparseable one is a gate that compares nothing.
 */
export function resolveExportNow(env: Record<string, string | undefined>, nowMs: number = Date.now()): string {
  const raw = env.SKW_EXPORT_NOW;
  if (raw === undefined || raw === '') return new Date(nowMs).toISOString();
  if (!ISO_UTC.test(raw)) throw new Error(`SKW_EXPORT_NOW is not UTC ISO 8601: ${JSON.stringify(raw)}`);
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) throw new Error(`SKW_EXPORT_NOW does not parse: ${JSON.stringify(raw)}`);
  return raw;
}

/** The mtime every file in the tree carries. One clock, one number. */
export function mtimeOf(exportNow: string): number {
  const ms = Date.parse(exportNow);
  if (Number.isNaN(ms)) throw new Error(`exportNow does not parse: ${JSON.stringify(exportNow)}`);
  return ms;
}

export function runExport(request: ExportRequest): ExportResult {
  if (existsSync(request.out)) {
    // A non-empty destination is the caller's mistake, and it is the one mistake that
    // reads as non-determinism afterwards (a stale page nobody regenerated).
    if (readdirSync(request.out).length > 0) {
      throw new Error(`export destination is not empty: ${request.out}`);
    }
  }

  const built = buildProjection({
    db: request.db,
    tenantKey: request.tenantKey,
    target: request.target,
    exportNow: request.exportNow,
    contentRoot: request.contentRoot,
  });
  if (!built.ok) return { ok: false, target: request.target, refusals: built.refusals };

  const projection = built.projection;

  // --- S4c: a plugin row is a claim the bundle must be able to honour -----------------
  // `planCms()` shipped `plugins: []` unconditionally, so a tenant with a row in
  // `cms_plugin_installed` produced a bundle whose `p_*` tables exist and whose code does
  // not — a site that 500s the first time the widget renders. Refused here, at the
  // producer, naming the plugin and the row; `tools/bundle_verify.mjs` refuses the same
  // shape at install, because a bundle can also be hand-edited.
  if (request.target === 'cms') {
    const rows = pluginRows(request.db);
    if (rows.length > 0) {
      return {
        ok: false,
        target: request.target,
        refusals: [
          {
            code: 'SKW_E_PL_EXPORT_PACKAGE_MISSING',
            message: `the tenant has ${rows.length} installed plugin(s) and this exporter carries no plugin package`,
            detail: { plugins: rows, missing: 'plugins/: this export ships no plugin code yet' },
            exit: 20,
          },
        ],
      };
    }
  }

  const common = {
    projection,
    contentRoot: request.contentRoot,
    ...(request.origin === undefined ? {} : { origin: request.origin }),
  };

  // --- S4c: one writer per tenant ----------------------------------------------------
  // Two exports of one tenant interleave: each `VACUUM INTO`s a snapshot at a different
  // moment, each counts "before/after" rows the other is changing, or two writers write
  // the same output directory. §11.4's quiescence check catches a *writer on the tenant's
  // database*; it cannot catch a second exporter, because the exporter writes the snapshot,
  // not the live file. So the export takes a lock per tenant, and the loser gets a named
  // refusal instead of a tree that is half one export and half the other.
  const release = acquireWriterLock(request.tenantKey, request.tmpDir);
  if (release === null) {
    return {
      ok: false,
      target: request.target,
      refusals: [
        {
          code: 'SKW_E_EXP_WRITER_ACTIVE',
          message: `another export of tenant ${request.tenantKey} is running`,
          detail: { tenant: request.tenantKey, lock: join(request.tmpDir, `.export-${request.tenantKey}.lock`) },
          exit: 26,
        },
      ],
    };
  }

  try {
    let files: TreeFile[];
    if (request.target === 'static') files = planStatic(common);
    else if (request.target === 'astro') files = planAstro({ ...common, repoRoot: request.repoRoot });
    else {
      if (request.tenant === undefined) throw new Error('a CMS export needs the tenant spec (control-plane facts)');
      files = planCms({
        ...common,
        sourceDb: request.db,
        repoRoot: request.repoRoot,
        tenant: request.tenant,
        tmpDir: request.tmpDir,
        ...(request.adminHost === undefined ? {} : { adminHost: request.adminHost }),
        ...(request.demosHost === undefined ? {} : { demosHost: request.demosHost }),
      }).files;
    }

    // §15.3: a bundle is refused at **2×** its projected size before the first byte is
    // written. The precheck is not the only defence — `writeTree` turns a real ENOSPC into
    // the same refusal — but it is the one that refuses before a half-tree exists.
    const projected = files.reduce((n, file) => n + (file.symlink === undefined ? Buffer.byteLength(file.bytes ?? '') : 0), 0);
    const free = freeBytes(existsSync(request.out) ? request.out : dirname(request.out));
    if (free !== null && free < projected * 2) {
      return {
        ok: false,
        target: request.target,
        refusals: [
          {
            code: 'SKW_E_EXP_INSUFFICIENT_DISK',
            message: `this target needs ${projected * 2} bytes free (2× ${projected}) and the filesystem has ${free}`,
            detail: { projected_bytes: projected, free_bytes: free, out: request.out },
            exit: 25,
          },
        ],
      };
    }

    try {
      writeTree(request.out, files, mtimeOf(request.exportNow));
    } catch (err) {
      if (!(err instanceof DiskFullError)) throw err;
      // The refusal is only honest if the failed attempt leaves nothing behind: a partial
      // tree would be installed by an operator who reads the exit code as "try again later".
      rmSync(request.out, { recursive: true, force: true });
      return {
        ok: false,
        target: request.target,
        refusals: [
          {
            code: 'SKW_E_EXP_INSUFFICIENT_DISK',
            message: `the filesystem ran out of space writing ${err.path} (${err.code}); the partial tree was removed`,
            detail: { path: err.path, errno: err.code, projected_bytes: projected },
            exit: 25,
          },
        ],
      };
    }

    return { ok: true, target: request.target, out: request.out, projection, tree: hashTree(request.out) };
  } finally {
    release();
  }
}

/**
 * `cms_plugin_installed` rows, or `[]`. The id is included because the refusal names the
 * row: "plugin contact" and "row 1" are two different claims, and an operator editing a
 * bundle needs both.
 */
function pluginRows(db: Database.Database): { id: number; plugin: string; version: string }[] {
  const table = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cms_plugin_installed'`).get();
  if (table === undefined) return [];
  const rows = db.prepare('SELECT id, plugin_id, version FROM cms_plugin_installed ORDER BY id').all() as {
    id: number;
    plugin_id: string;
    version: string;
  }[];
  return rows.map((row) => ({ id: Number(row.id), plugin: String(row.plugin_id), version: String(row.version) }));
}

/** True when `pid` names a live process on this host. */
function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists and belongs to someone else — still a live holder.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * The tenant's export lock: `O_EXCL`, the holder's pid, and one takeover of a **stale**
 * lock (a crash leaves the file behind; a lock nobody can clear is an outage).
 *
 * Returns the release function, or `null` when a live writer holds it.
 */
function acquireWriterLock(tenantKey: string, dir: string): (() => void) | null {
  const path = join(dir, `.export-${tenantKey}.lock`);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      try {
        writeFileSync(fd, `${process.pid}\n`);
      } finally {
        closeSync(fd);
      }
      return () => rmSync(path, { force: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const holder = Number.parseInt(readFileSync(path, 'utf8').trim(), 10);
      if (alive(holder)) return null;
      // Stale: the holder is gone. Removing it and retrying is a race between two
      // newcomers, and `O_EXCL` decides that race — exactly one of them creates the file.
      rmSync(path, { force: true });
    }
  }
  return null;
}
