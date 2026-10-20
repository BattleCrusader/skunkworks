/**
 * §13.4 item 6's two numbers, measured — **not a gate**. Nothing in `make test` runs this file:
 * it measures memory and time, and a value that moves with the box does not belong in a
 * correctness gate (`make test-perf` is where the timing assertions live).
 *
 * What it answers, in the spec's own words:
 *
 *   1. **"the cost is one module instance per enabled (tenant, plugin) pair."** Twelve tenants
 *      each enable the same package, which produces twelve module instances (the tenant is in
 *      the import URL, §13.3.2). The script reports the delta heap/RSS across the eleventh
 *      activation, after a forced GC, so the number is instances and not activation noise.
 *   2. **`runtime.sync`'s one SELECT per plugin-bearing request** (§13.3.8) — the price the
 *      restart-free lifecycle pays. Reported per call, with the SELECT's own cost so it is
 *      clear which half is the query and which half is the bookkeeping.
 *
 * Usage: node --expose-gc scripts/measure/plugin-budget.ts
 * Prints one JSON object. Quote it with `os.loadavg()` beside it (included).
 */
import Database from 'better-sqlite3';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { installPlugin } from '../../app/plugins/install.ts';
import { packageRootHash } from '../../app/plugins/manifest.ts';
import { PluginRuntime } from '../../app/plugins/runtime.ts';

const REPO = join(import.meta.dirname ?? '.', '..', '..');
const SCHEMA = join(REPO, 'schema');
const NOTES = join(REPO, 'test', 'fixtures', 'plugins', 'notes');
const DIGEST = 'sha256:plugin-budget';
const TENANTS = 12;

function gc(): void {
  const g = (globalThis as { gc?: () => void }).gc;
  g?.();
  g?.();
}

function mem(): { heapUsed: number; rss: number } {
  gc();
  const m = process.memoryUsage();
  return { heapUsed: m.heapUsed, rss: m.rss };
}

function siteDb(dir: string, tenant: string): string {
  const path = join(dir, 'tenants', tenant, 'site.db');
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.exec(readFileSync(join(SCHEMA, 'site.sql'), 'utf8'));
  db.close();
  return path;
}

/** Copy one installed row into another tenant, as `skwctl plugin install --tenant <t>` does. */
function cloneRow(from: string, to: string): void {
  const src = new Database(from, { readonly: true });
  const dst = new Database(to);
  try {
    const row = src.prepare('SELECT * FROM cms_plugin_installed').get() as Record<string, unknown>;
    const cols = Object.keys(row);
    dst
      .prepare(`INSERT INTO cms_plugin_installed (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
      .run(...(cols.map((c) => row[c]) as never[]));
  } finally {
    src.close();
    dst.close();
  }
}

const dir = mkdtempSync(join(tmpdir(), 'skw-plugin-budget-'));
try {
  const first = siteDb(dir, 't01');
  const report = join(dir, 'notes-report.json');
  writeFileSync(
    report,
    `${JSON.stringify({ plugin: 'notes', version: '1.0.0', root_hash: packageRootHash(NOTES).root, runner_image_digest: DIGEST, ran_at: new Date().toISOString() }, null, 2)}\n`,
  );
  installPlugin({
    siteDb: first,
    pluginsRoot: join(dir, 'plugins'),
    sourceDir: NOTES,
    allowUnsigned: true,
    testReportPath: report,
    runnerImageDigest: DIGEST,
  });

  const paths: string[] = [first];
  for (let i = 2; i <= TENANTS; i += 1) {
    const key = `t${String(i).padStart(2, '0')}`;
    const path = siteDb(dir, key);
    cloneRow(first, path);
    paths.push(path);
  }

  const runtime = new PluginRuntime({ dataDir: dir, emailMode: 'off' });
  const before = mem();
  const perInstance: number[] = [];
  let last = before;
  for (let i = 0; i < paths.length; i += 1) {
    const key = `t${String(i + 1).padStart(2, '0')}`;
    await runtime.enable(key, 'notes');
    if (i >= 1) {
      const now = mem();
      perInstance.push(now.heapUsed - last.heapUsed);
      last = now;
    }
  }
  const after = mem();

  // (b) one `sync` per plugin-bearing request: the SELECT plus the reconciliation bookkeeping.
  const tenant = 't01';
  const rounds = 2000;
  const started = process.hrtime.bigint();
  for (let i = 0; i < rounds; i += 1) await runtime.sync(tenant);
  const perSync = Number(process.hrtime.bigint() - started) / rounds / 1000;

  const db = new Database(paths[0] as string, { readonly: true });
  let perSelect = 0;
  try {
    const stmt = db.prepare(
      `SELECT plugin_id, version, manifest_json, root_hash, enabled, signature_state, test_report_sha, activation_seq
         FROM cms_plugin_installed WHERE enabled = 1 ORDER BY id`,
    );
    const s = process.hrtime.bigint();
    for (let i = 0; i < rounds; i += 1) stmt.all();
    perSelect = Number(process.hrtime.bigint() - s) / rounds / 1000;
  } finally {
    db.close();
  }

  const sorted = [...perInstance].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  process.stdout.write(
    `${JSON.stringify(
      {
        instances: paths.length,
        heap_delta_bytes_total: after.heapUsed - before.heapUsed,
        heap_per_instance_bytes_median: Math.round(median),
        heap_per_instance_bytes: perInstance.map((n) => Math.round(n)),
        rss_bytes_total: after.rss,
        rss_delta_bytes_total: after.rss - before.rss,
        sync_us_per_call: Number(perSync.toFixed(2)),
        enabled_rows_select_us_per_call: Number(perSelect.toFixed(2)),
        plugin_rows_per_tenant: 1,
        loadavg: (await import('node:os')).loadavg(),
        node: process.version,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
