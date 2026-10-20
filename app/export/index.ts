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
import { existsSync, readdirSync } from 'node:fs';

import { planAstro } from './astro.ts';
import { planCms, type TenantSpec } from './cms.ts';
import { buildProjection, type ExportTarget, type Projection, type Refusal } from './project.ts';
import { planStatic } from './static.ts';
import { hashTree, writeTree, type TreeFile, type TreeHash } from './tree.ts';

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
  const common = {
    projection,
    contentRoot: request.contentRoot,
    ...(request.origin === undefined ? {} : { origin: request.origin }),
  };

  let files: TreeFile[];
  switch (request.target) {
    case 'static':
      files = planStatic(common);
      break;
    case 'astro':
      files = planAstro({ ...common, repoRoot: request.repoRoot });
      break;
    case 'cms': {
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
      break;
    }
  }

  writeTree(request.out, files, mtimeOf(request.exportNow));
  return { ok: true, target: request.target, out: request.out, projection, tree: hashTree(request.out) };
}
