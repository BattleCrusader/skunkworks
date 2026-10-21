/**
 * U1–U3 — §13.3.8's **uninstall drain**, on the operator path (defect D3).
 *
 * The drain primitive existed and had no caller: `runtime.uninstallBegin()` was the only code
 * that waited for in-flight requests, nothing in `app/`, `test/` or `scripts/` called it,
 * `SKW_E_PL_BUSY` could not be raised from any operator surface, and E-32's U1–U3 did not exist.
 * "Drain waits for the tenant's in-flight count to reach 0, bounded at 5 s, then refuses
 * `SKW_E_PL_BUSY` rather than drop a table under a live request" was a sentence about behaviour
 * no code path performed.
 *
 * These three cases are the behaviour, driven through the admin surface that can see the
 * in-flight count (`POST /admin/t/<key>/plugins/uninstall` → `runtime.uninstall()`):
 *
 *   U1  a **real** in-flight page request, held inside a plugin hook, makes the uninstall wait
 *       the full bounded 5 s and then refuse `SKW_E_PL_BUSY` naming the plugin — with the row,
 *       the package and the registry entry all untouched; once the request finishes, the same
 *       uninstall succeeds and the tables are gone.
 *   U2  an idle uninstall drains at once and removes: archive written, tables dropped, row gone,
 *       package tree gone.
 *   U3  a second uninstall refuses `SKW_E_PL_UNAVAILABLE` — an operator who mistypes an id is
 *       never told the box is clean.
 *
 * Why the timing assertions are real: U1 fails if the drain returns early (the refusal would
 * arrive in milliseconds and the assertion names the elapsed time), and U2 fails if the drain
 * ignores the zero count and sleeps. The lower bound is 4.5 s against a 5 s budget, so a busy
 * box can only make it longer.
 */
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { loadEnv } from '../app/env.ts';
import { buildApp, type AppHandle } from '../app/main.ts';
import { installPlugin, installedPlugins } from '../app/plugins/install.ts';
import { packageRootHash } from '../app/plugins/manifest.ts';
import { ADMIN_HOST, ADMIN_ORIGIN, PASSWORD, TOTP_SECRET, openSession, seedUser } from './helpers/admin.ts';
import { REPO, makeFixture, type Fixture } from './helpers/fixture.ts';
import { call, type Res } from './helpers/http.ts';

const TENANT = 'acme';
const HOST = 'acme.test';
const DIGEST = 'sha256:s5-lifecycle';
const GATEHOOK = join(REPO, 'test', 'fixtures', 'plugins', 'gatehook');
const NOTES = join(REPO, 'test', 'fixtures', 'plugins', 'notes');

let fixture: Fixture;
let handle: AppHandle;
let port = 0;
let session: { cookie: string; csrfToken: string };
let holdDir = '';

function siteDbFile(): string {
  return fixture.sitePath(TENANT);
}

function install(sourceDir: string, plugin: string): void {
  const { root } = packageRootHash(sourceDir);
  const report = join(fixture.dir, `${plugin}-report.json`);
  writeFileSync(
    report,
    `${JSON.stringify({ plugin, version: '1.0.0', root_hash: root, runner_image_digest: DIGEST, ran_at: new Date().toISOString() }, null, 2)}\n`,
  );
  installPlugin({
    siteDb: siteDbFile(),
    pluginsRoot: join(fixture.dir, 'plugins'),
    sourceDir,
    allowUnsigned: true,
    testReportPath: report,
    runnerImageDigest: DIGEST,
  });
}

/** The row, read from the file the app and the CLI both write. */
function rows(plugin: string): number {
  const db = new Database(siteDbFile(), { readonly: true });
  try {
    return (db.prepare('SELECT COUNT(*) AS n FROM cms_plugin_installed WHERE plugin_id = ?').get(plugin) as { n: number }).n;
  } finally {
    db.close();
  }
}

function tables(): string[] {
  const db = new Database(siteDbFile(), { readonly: true });
  try {
    return (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as { name: string }[]).map((r) => r.name);
  } finally {
    db.close();
  }
}

function uninstallRequest(plugin: string): Promise<Res> {
  return call({
    port,
    path: `/admin/t/${TENANT}/plugins/uninstall`,
    method: 'POST',
    host: ADMIN_HOST,
    headers: {
      cookie: session.cookie,
      origin: ADMIN_ORIGIN,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ plugin, csrf: session.csrfToken }).toString(),
  });
}

async function waitFor(path: string, label: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label} (${path})`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

before(async () => {
  fixture = makeFixture({ specs: [{ key: TENANT, hosts: [HOST], title: 'Acme', body: '<h1>Lifecycle</h1>' }] });
  install(GATEHOOK, 'gatehook');
  install(NOTES, 'notes');

  handle = await buildApp({ env: loadEnv(fixture.env) });
  await handle.app.listen({ port: 0, host: '127.0.0.1' });
  const address = handle.app.server.address();
  port = typeof address === 'object' && address !== null ? address.port : 0;

  const email = 'owner@acme.test';
  await seedUser({ controlDb: fixture.controlDb, tenantKey: TENANT, email, totpSecret: TOTP_SECRET });
  session = await openSession({ port, key: TENANT, email, password: PASSWORD });
});

after(async () => {
  delete process.env.SKW_GATE_HOLD_DIR;
  await handle.close();
  fixture.cleanup();
});

test('U1 — an in-flight request drains for the full 5 s, refuses SKW_E_PL_BUSY naming the plugin, and removes nothing', async () => {
  holdDir = join(fixture.dir, 'gate');
  mkdirSync(holdDir, { recursive: true });
  process.env.SKW_GATE_HOLD_DIR = holdDir;

  // Declared in the manifest, so `runEndpoint` resolves it, and registered at activation.
  const activation = await handle.plugins.enable(TENANT, 'gatehook');
  assert.equal(activation.alreadyActive, false, 'the fixture must activate here, or the endpoint is not registered');
  assert.deepEqual(activation.endpoints, ['GET hold'], `the fixture must have registered its endpoint: ${JSON.stringify(activation)}`);

  // A real request, held inside the package's endpoint handler. Not awaited: the assertion is
  // about what the *server* does while it is still in flight.
  const held = call({ port, path: '/_plugin/gatehook/hold', host: HOST });
  await waitFor(join(holdDir, 'entered'), 'the request to enter the plugin endpoint');
  assert.equal(handle.plugins.inFlightCount(TENANT), 1, 'the app must have counted the request it is holding');

  const startedAt = Date.now();
  const refused = await uninstallRequest('gatehook');
  const waitedMs = Date.now() - startedAt;

  assert.equal(refused.status, 409, `expected the drain's refusal, got ${refused.status}: ${refused.body}`);
  assert.equal(
    (refused.json as { error?: { code?: string } } | undefined)?.error?.code,
    'SKW_E_PL_BUSY',
    `the refusal must carry SKW_E_PL_BUSY: ${refused.body}`,
  );
  assert.match(refused.body, /gatehook/, 'the refusal must name the plugin, not only the tenant');
  assert.match(refused.body, /in flight/, `the refusal must say what it waited for: ${refused.body}`);
  assert.ok(
    waitedMs >= 4_500,
    `the drain returned after ${waitedMs} ms — it did not wait for the in-flight request (budget 5000 ms)`,
  );

  // Nothing was removed, and nothing was even disabled: a refusal is not a partial uninstall.
  assert.equal(rows('gatehook'), 1, 'the refused uninstall must leave the row');
  assert.ok(existsSync(join(fixture.dir, 'plugins', 'gatehook')), 'the refused uninstall must leave the package tree');
  assert.equal(handle.plugins.registry.has(TENANT, 'gatehook'), true, 'the refused uninstall must leave the endpoint registered');

  // Release the request: it completes normally, through the package it still has.
  writeFileSync(join(holdDir, 'release'), '1');
  const answered = await held;
  assert.equal(answered.status, 200, answered.body);
  assert.match(answered.body, /"held":true/, 'the in-flight request must finish against the live package');

  // …and now the same uninstall drains at once and does the whole job.
  const done = await uninstallRequest('gatehook');
  assert.equal(done.status, 303, `the idle retry must be an operator result, not a refusal: ${done.status} ${done.body}`);
  assert.match(decodeURIComponent(String(done.headers.location ?? '')), /gatehook uninstalled/, String(done.headers.location));
  assert.equal(rows('gatehook'), 0, 'the successful uninstall must remove the row');
  assert.equal(existsSync(join(fixture.dir, 'plugins', 'gatehook')), false, 'the successful uninstall must remove the package tree');
});

test('U2 — an idle uninstall drains immediately and removes: archive, tables, row, package', async () => {
  assert.ok(tables().includes('p_notes_note'), 'the fixture must have created the plugin table');

  const startedAt = Date.now();
  const done = await uninstallRequest('notes');
  const elapsed = Date.now() - startedAt;

  assert.equal(done.status, 303, done.body);
  const flash = decodeURIComponent(String(done.headers.location ?? ''));
  assert.match(flash, /notes uninstalled \(tables: p_notes_note\(0\); archive /, flash);
  assert.ok(elapsed < 2_000, `an idle uninstall took ${elapsed} ms: the drain must not sleep when the count is 0`);
  assert.equal(rows('notes'), 0);
  assert.equal(tables().includes('p_notes_note'), false, 'the plugin table must be dropped');
  assert.equal(existsSync(join(fixture.dir, 'plugins', 'notes')), false, 'the package tree must be removed');

  const archiveDir = join(fixture.dir, 'plugin-archive');
  const archives = readdirSync(archiveDir).filter((name) => name.startsWith('notes-1.0.0-'));
  assert.equal(archives.length, 1, `expected one archive for notes, got ${JSON.stringify(readdirSync(archiveDir))}`);
});

test('U3 — a second uninstall refuses SKW_E_PL_UNAVAILABLE, and says so on both surfaces', async () => {
  // The runtime's own refusal: a code a caller can switch on, not a sentence.
  await assert.rejects(
    () => handle.plugins.uninstall(TENANT, 'notes'),
    (err: unknown) => (err as { code?: string }).code === 'SKW_E_PL_UNAVAILABLE',
    'a package that is not installed must be a refusal',
  );

  const again = await uninstallRequest('notes');
  assert.equal(again.status, 303, again.body);
  const flash = decodeURIComponent(String(again.headers.location ?? ''));
  assert.match(flash, /notes was not uninstalled: SKW_E_PL_UNAVAILABLE/, flash);
  assert.equal(rows('notes'), 0, 'the refusal must not invent a row');
});

test('U0 — the installed-package list the route acts on is the runtime’s, not a second source', () => {
  const db = new Database(siteDbFile(), { readonly: true });
  try {
    const installed = installedPlugins(db).map((row) => row.plugin_id);
    assert.deepEqual(installed, [], `both fixtures are uninstalled by U1–U3; the rows say ${JSON.stringify(installed)}`);
  } finally {
    db.close();
  }
});
