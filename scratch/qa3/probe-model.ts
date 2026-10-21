/**
 * QA3 — three probes the suite does not contain.
 *
 *   1. the capability refusal's own message and detail: does it name the *table*?
 *   2. the drain primitive, and the fact that nothing in the product calls it;
 *   3. the operator install screen for a zero-capability package, and for one with capabilities.
 */
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { makePluginContext } from '../../app/plugins/context.ts';
import { packageRootHash } from '../../app/plugins/manifest.ts';
import { PluginRuntime } from '../../app/plugins/runtime.ts';
import { REPO, SCHEMA, makeFixture } from '../../test/helpers/fixture.ts';

const dir = mkdtempSync(join(tmpdir(), 'skw-qa3-probe-'));
const siteDb = join(dir, 'acme', 'site.db');
mkdirSync(dirname(siteDb), { recursive: true });
{
  const db = new Database(siteDb);
  db.exec(readFileSync(join(SCHEMA, 'site.sql'), 'utf8'));
  // An installed, enabled package that declares store.query and nothing else.
  db.prepare(
    `INSERT INTO cms_plugin_installed (plugin_id, version, manifest_json, root_hash, publisher, signature_state, enabled, test_report_sha)
     VALUES ('probe', '1.0.0', ?, ?, 'unsigned', 'unsigned', 1, 'x')`,
  ).run(
    JSON.stringify({ id: 'probe', version: '1.0.0', capabilities: ['store.query'], tables: [{ name: 'p_probe_note', export: 'rows' }] }),
    'a'.repeat(64),
  );
  db.close();
}

console.log('=== P1: an undeclared capability on a table the package owns ===');
{
  const db = new Database(siteDb);
  const ctx = makePluginContext({ db, tenant: 'acme', plugin: 'probe', mode: 'admin', emailMode: 'off' });
  try {
    ctx.facade['store.delete']('p_probe_note', 1);
    console.log('NOT REFUSED');
  } catch (err) {
    const e = err as { code?: string; message?: string; detail?: Record<string, unknown> };
    console.log('code   :', e.code);
    console.log('message:', e.message);
    console.log('detail :', JSON.stringify(e.detail));
    console.log('names the table?', /p_probe_note/.test(`${e.message ?? ''} ${JSON.stringify(e.detail ?? {})}`));
  }
  // The same context after the request ends.
  ctx.close();
  try {
    ctx.facade['store.read']('p_probe_note');
  } catch (err) {
    const e = err as { code?: string; message?: string };
    console.log('after close: code=', e.code, '| class=', (err as Error).constructor.name, '| message=', String(e.message).slice(0, 90));
  }
  // A second attached database.
  const ctx2 = makePluginContext({ db, tenant: 'acme', plugin: 'probe', mode: 'admin', emailMode: 'off' });
  db.prepare('ATTACH DATABASE ? AS other').run(siteDb);
  try {
    ctx2.facade['store.read']('p_probe_note');
  } catch (err) {
    const e = err as { code?: string; message?: string; detail?: Record<string, unknown> };
    console.log('attach: code=', e.code, '| detail=', JSON.stringify(e.detail));
  }
  db.prepare('DETACH DATABASE other').run();
  db.close();
}

console.log('=== P2: the uninstall drain primitive ===');
{
  const runtime = new PluginRuntime({ dataDir: dir, emailMode: 'off' });
  runtime.enter('acme');
  const started = Date.now();
  try {
    await runtime.drain('acme', 120);
  } catch (err) {
    console.log('drain with one in-flight request:', (err as { code?: string }).code, `after ${Date.now() - started} ms`);
  }
  runtime.leave('acme');
  await runtime.drain('acme', 120);
  console.log('drain with none: returned');
  console.log('uninstallBegin has a caller in app/:', hasCaller());
}

function hasCaller(): string {
  const out = spawnSync('grep', ['-rn', 'uninstallBegin', 'app/', 'test/', 'scripts/', '--include=*.ts', '--include=*.mjs'], {
    cwd: REPO,
    encoding: 'utf8',
  });
  const lines = (out.stdout ?? '').split('\n').filter((l) => l !== '' && !l.includes('runtime.ts:'));
  return lines.length === 0 ? 'NO — only its definition in app/plugins/runtime.ts' : lines.join(' | ');
}

console.log('=== P3: the operator install screen (skwctl) ===');
{
  const fixture = makeFixture({ specs: [{ key: 'acme', hosts: ['acme.test'] }] });
  try {
    for (const [id, caps] of [
      ['nothing', []],
      ['reader', ['store.query']],
    ] as [string, string[]][]) {
      const pkg = join(fixture.dir, 'packages', id);
      mkdirSync(pkg, { recursive: true });
      writeFileSync(
        join(pkg, 'plugin.json'),
        `${JSON.stringify({ id, version: '1.0.0', entry: 'index.mjs', main: 'index.mjs', capabilities: caps, tables: [], settings: [] }, null, 2)}\n`,
      );
      writeFileSync(join(pkg, 'index.mjs'), 'export function activate() {}\n');
      const { root } = packageRootHash(pkg);
      const report = join(fixture.dir, `${id}-report.json`);
      writeFileSync(
        report,
        `${JSON.stringify({ plugin: id, version: '1.0.0', root_hash: root, runner_image_digest: 'sha256:qa3', ran_at: '2026-10-21T00:00:00.000Z' }, null, 2)}\n`,
      );
      const res = spawnSync(
        process.execPath,
        ['app/cli/skwctl.ts', 'plugin', 'install', pkg, '--tenant', 'acme', '--allow-unsigned', '--test-report', report, '--runner-digest', 'sha256:qa3'],
        { cwd: REPO, env: { ...process.env, ...fixture.env }, encoding: 'utf8', timeout: 120_000 },
      );
      console.log(`--- ${id} (capabilities: ${JSON.stringify(caps)}) exit=${res.status}`);
      console.log((res.stdout ?? '').trim());
      if ((res.stderr ?? '').trim() !== '') console.log('stderr:', (res.stderr ?? '').trim().slice(0, 300));
      console.log('mentions "does not limit" / "not a sandbox":', /does not limit|not a sandbox|inside the site's process/.test(res.stdout ?? ''));
    }
  } finally {
    fixture.cleanup();
  }
}

rmSync(dir, { recursive: true, force: true });