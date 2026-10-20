#!/usr/bin/env node
/**
 * `skw-export` — the operator's entry point to the three targets (§11.1–§11.3).
 *
 *     skw-export --target <cms|astro|static> --tenant <key> --out <dir>
 *                [--data-dir <dir>] [--content <dir>] [--origin <url>]
 *                [--now <ISO 8601>] [--admin-host <host>] [--demos-host <host>]
 *
 * `SKW_EXPORT_NOW` (or `--now`) is the only clock. With neither, the wall clock is used
 * and printed, because an interactive export should say which second it pinned.
 *
 * Exit codes are §11.3's, not 1: 21 for a gated asset / an open graph / a body that cannot
 * be normalised, 22 for a free parameter, 24 for a non-quiescent snapshot, 25 for disk.
 * The CLI exits with the **lowest** code in the list, so a caller checking `$? -eq 21`
 * sees the SKU-changing refusal even when a 22 was also raised — and every refusal is
 * printed, never only the first.
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { openExporter } from '../db/classes.ts';
import { findProjectRoot } from '../db/migrate.ts';
import { runExport, resolveExportNow } from '../export/index.ts';
import type { ExportTarget } from '../export/project.ts';
import type { TenantSpec } from '../export/cms.ts';

interface Args {
  target?: ExportTarget;
  tenant?: string;
  out?: string;
  dataDir: string;
  content?: string;
  origin?: string;
  now?: string;
  adminHost?: string;
  demosHost?: string;
}

function parse(argv: readonly string[]): Args {
  const args: Args = { dataDir: process.env.SKW_DATA_DIR ?? '.' };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    const take = (): string => {
      if (value === undefined) throw new Error(`${flag} needs a value`);
      i += 1;
      return value;
    };
    switch (flag) {
      case '--target': {
        const target = take();
        if (target !== 'cms' && target !== 'astro' && target !== 'static') {
          throw new Error(`--target must be cms, astro or static (got ${JSON.stringify(target)})`);
        }
        args.target = target;
        break;
      }
      case '--tenant':
        args.tenant = take();
        break;
      case '--out':
        args.out = take();
        break;
      case '--data-dir':
        args.dataDir = take();
        break;
      case '--content':
        args.content = take();
        break;
      case '--origin':
        args.origin = take();
        break;
      case '--now':
        args.now = take();
        break;
      case '--admin-host':
        args.adminHost = take();
        break;
      case '--demos-host':
        args.demosHost = take();
        break;
      default:
        throw new Error(`unknown argument ${JSON.stringify(flag)}`);
    }
  }
  if (args.target === undefined || args.tenant === undefined || args.out === undefined) {
    throw new Error('usage: skw-export --target <cms|astro|static> --tenant <key> --out <dir> [--data-dir <dir>]');
  }
  return args;
}

interface TenantRow {
  key: string;
  mode: string;
  status: string;
  display_name: string | null;
  db_version: number;
}

interface HostRow {
  host: string;
  kind: string;
  is_primary: number;
  cert_state: string;
}

/** The tenant's control-plane facts, read once and passed to the bundle writer. */
function tenantSpec(controlDb: string, key: string): TenantSpec {
  const db = new Database(controlDb, { readonly: true, fileMustExist: true });
  try {
    const tenant = db
      .prepare('SELECT key, mode, status, display_name, db_version FROM tenant WHERE key = ?')
      .get(key) as TenantRow | undefined;
    if (tenant === undefined) throw new Error(`SKW_E_EXP_TENANT_NOT_FOUND: no tenant ${JSON.stringify(key)} in control.db`);
    const hosts = db
      .prepare('SELECT host, kind, is_primary, cert_state FROM domain WHERE tenant_id = (SELECT id FROM tenant WHERE key = ?) ORDER BY is_primary DESC, host')
      .all(key) as HostRow[];
    if (hosts.length === 0) throw new Error(`SKW_E_EXP_TENANT_NOT_FOUND: tenant ${key} has no domain rows`);
    return {
      key: tenant.key,
      mode: tenant.mode,
      status: tenant.status,
      displayName: tenant.display_name ?? tenant.key,
      dbVersion: tenant.db_version,
      hosts: hosts.map((h) => ({ host: h.host, kind: h.kind, isPrimary: h.is_primary, certState: h.cert_state })),
    };
  } finally {
    db.close();
  }
}

function main(argv: readonly string[]): number {
  const args = parse(argv);
  const target = args.target as ExportTarget;
  const tenant = args.tenant as string;
  const out = args.out as string;

  const exportNow = args.now !== undefined ? resolveExportNow({ SKW_EXPORT_NOW: args.now }) : resolveExportNow(process.env);
  const siteDb = join(args.dataDir, 'tenants', tenant, 'site.db');
  const contentRoot = args.content ?? join(args.dataDir, 'content');
  mkdirSync(args.dataDir, { recursive: true });

  const db = openExporter(siteDb);
  try {
    const result = runExport({
      target,
      db,
      tenantKey: tenant,
      out,
      exportNow,
      contentRoot,
      repoRoot: findProjectRoot(),
      tmpDir: args.dataDir,
      // Only the bundle needs the control-plane facts (hosts, mode, the seed's tenant). A
      // static or Astro export reads nothing but the tenant's `site.db`, so it must not
      // require a `control.db` that has nothing to say about it.
      ...(target === 'cms' ? { tenant: tenantSpec(join(args.dataDir, 'control.db'), tenant) } : {}),
      ...(args.origin === undefined ? {} : { origin: args.origin }),
      ...(args.adminHost === undefined ? {} : { adminHost: args.adminHost }),
      ...(args.demosHost === undefined ? {} : { demosHost: args.demosHost }),
    });

    if (!result.ok) {
      let exit = 0;
      for (const refusal of result.refusals) {
        process.stderr.write(`REFUSAL: ${refusal.code} ${JSON.stringify(refusal.detail)}\n`);
        if (exit === 0 || refusal.exit < exit) exit = refusal.exit;
      }
      process.stderr.write(`skw-export: refused; nothing was written to ${out}\n`);
      return exit;
    }

    process.stdout.write(
      `export: target=${result.target} tenant=${tenant} out=${out} files=${result.tree.files} bytes=${result.tree.bytes}\n`,
    );
    process.stdout.write(`projection_sha: ${result.projection.projectionSha}\n`);
    process.stdout.write(`tree_sha256: ${result.tree.sha256}\n`);
    process.stdout.write(`export_now: ${exportNow}\n`);
    return 0;
  } finally {
    db.close();
  }
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`skw-export: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
}
