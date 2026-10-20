/**
 * The in-process load path, the hook surface and the failure model — `L1`–`L9` (§13.3.2,
 * §13.3.4, §13.3.6), replacing the runner gates that were deleted with the runner.
 *
 * What each case is a witness for:
 *
 *   L1  `import()` runs `main`, `activate(ctx)` registers the two hooks and two endpoints the
 *       manifest declared, and the registry holds them per tenant.
 *   L2  a package that exports no `activate` is `SKW_E_PL_LOAD`, the row is `enabled=0`, a
 *       notice names it, **and the site keeps serving** — the registry never received hooks.
 *   L3  a package edited on disk after install refuses to load (`SKW_E_PL_SIGNATURE`), with the
 *       untouched package as the positive control.
 *   L4  `ctx.on()` for a hook that is not one of the twelve, or one the manifest did not
 *       declare, is `SKW_E_PL_REJECTED` at activation.
 *   L5  a filter that throws does not 500 a page: the value passed in is used, the failure is
 *       counted.
 *   L6  a filter that returns the wrong type is a **failure**, not a coercion: original used,
 *       hook skipped, counted.
 *   L7  three failures in 60 s disable the plugin, prune its hooks and raise an admin notice.
 *   L8  disable **removes** the hooks — dispatch after disable runs nothing at all.
 *   L9  disable→enable produces a **new module instance**: the module-level counter reads 1
 *       again, which is the cache-buster's exclusive witness.
 */
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';

import { AppError } from '../app/errors.ts';
import { assertEnabled, installPlugin, uninstallPlugin } from '../app/plugins/install.ts';
import { packageRootHash } from '../app/plugins/manifest.ts';
import { PluginRuntime } from '../app/plugins/runtime.ts';
import { runEndpoint } from '../app/plugins/endpoint.ts';
import { openAdminWrite } from '../app/db/classes.ts';
import { REPO, SCHEMA } from './helpers/fixture.ts';

const TENANT = 'acme';
const DIGEST = 'sha256:s5-load-app';
const NOTES = join(REPO, 'test', 'fixtures', 'plugins', 'notes');
const THROWER = join(REPO, 'test', 'fixtures', 'plugins', 'thrower');
const BADSHAPE = join(REPO, 'test', 'fixtures', 'plugins', 'badshape');
const UNDECLARED = join(REPO, 'test', 'fixtures', 'plugins', 'undeclared');

let dir = '';
let siteDb = '';

function makeSite(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.exec(readFileSync(join(SCHEMA, 'site.sql'), 'utf8'));
  db.close();
}

function report(sourceDir: string, plugin: string): string {
  const { root } = packageRootHash(sourceDir);
  const path = join(dir, `${plugin}-report.json`);
  writeFileSync(
    path,
    `${JSON.stringify({ plugin, version: '1.0.0', root_hash: root, runner_image_digest: DIGEST, ran_at: new Date().toISOString() }, null, 2)}\n`,
  );
  return path;
}

function install(sourceDir: string, plugin: string): void {
  installPlugin({
    siteDb,
    pluginsRoot: join(dir, 'plugins'),
    sourceDir,
    allowUnsigned: true,
    testReportPath: report(sourceDir, plugin),
    runnerImageDigest: DIGEST,
  });
}

function fresh(): PluginRuntime {
  return new PluginRuntime({ dataDir: dir, emailMode: 'off' });
}

function rowOf(plugin: string): { enabled: number } {
  const db = openAdminWrite(siteDb, 5000);
  try {
    return db.prepare('SELECT enabled FROM cms_plugin_installed WHERE plugin_id = ?').get(plugin) as { enabled: number };
  } finally {
    db.close();
  }
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'skw-s5-load-'));
  siteDb = join(dir, 'tenants', TENANT, 'site.db');
  makeSite(siteDb);
  install(NOTES, 'notes');
  install(THROWER, 'thrower');
  install(BADSHAPE, 'badshape');
  install(UNDECLARED, 'undeclared');
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------------------------- L1

test('L1 — activate(ctx) registers the declared hooks and endpoints, per tenant', async () => {
  const runtime = fresh();
  const result = await runtime.enable(TENANT, 'notes');
  assert.equal(result.plugin, 'notes');
  assert.deepEqual(result.hooks.sort(), ['content.render.html', 'page.head']);
  assert.deepEqual(result.endpoints.sort(), ['GET list', 'POST sign']);
  assert.equal(result.activationSeq, 1, 'the first activation is 1, and it is in the URL');

  const described = runtime.describe(TENANT);
  assert.equal(described.length, 1);
  assert.equal(described[0]?.plugin, 'notes');

  // A different tenant's registry does not have it: the map is per tenant (§13.3.3).
  assert.deepEqual(runtime.describe('beta'), []);

  // The filter actually runs, and its return value is the new html.
  const callbacks = runtime.registry.hooksFor(TENANT, 'content.render.html');
  const html = await runtime.hooks.dispatchFilter('content.render.html', TENANT, { tenant: TENANT, path: '/p' }, '<p>x</p>', callbacks);
  assert.match(html, /^<p>x<\/p>\n<!-- notes:acme:act=1:\/p -->$/);
});

// ------------------------------------------------------------------------------- L2

test('L2 — a package with no activate() is SKW_E_PL_LOAD, disabled, noticed, and the site serves', async () => {
  const runtime = fresh();
  let caught: unknown = null;
  try {
    await runtime.enable(TENANT, 'badshape');
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof AppError, `expected an AppError, got ${String(caught)}`);
  assert.equal((caught as AppError).code, 'SKW_E_PL_LOAD');
  assert.equal(rowOf('badshape').enabled, 0, 'the row is disabled');
  const notices = runtime.noticesFor(TENANT).filter((n) => n.plugin === 'badshape');
  assert.equal(notices.length, 1, 'an admin notice names the plugin and the code');
  assert.equal(notices[0]?.code, 'SKW_E_PL_LOAD');
  // The registry never received its hooks, so nothing about the site changed.
  assert.deepEqual(runtime.describe(TENANT), []);

  // The positive control: the same runtime loads a good package immediately afterwards.
  await runtime.enable(TENANT, 'notes');
  assert.deepEqual(runtime.describe(TENANT).map((d) => d.plugin), ['notes']);
});

// ------------------------------------------------------------------------------- L3

test('L3 — a package edited on disk after install refuses to load SKW_E_PL_SIGNATURE', async () => {
  const runtime = fresh();
  const entry = join(dir, 'plugins', 'notes', 'index.mjs');
  const original = readFileSync(entry);
  try {
    writeFileSync(entry, `${original.toString('utf8')}\n// a byte the operator did not sign\n`);
    let caught: unknown = null;
    try {
      await runtime.enable(TENANT, 'notes');
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof AppError, `expected an AppError, got ${String(caught)}`);
    assert.equal((caught as AppError).code, 'SKW_E_PL_SIGNATURE');
    assert.match((caught as AppError).message, /changed on disk/);
    const detail = (caught as AppError).detail as { installed_root_hash: string; package_root_hash: string };
    assert.notEqual(detail.installed_root_hash, detail.package_root_hash);
  } finally {
    writeFileSync(entry, original);
  }
  // The positive control: restored bytes load, which is what makes the refusal above about the
  // edit and not about the package.
  const ok = await runtime.enable(TENANT, 'notes');
  assert.equal(ok.plugin, 'notes');
  assert.equal(runtime.registry.has(TENANT, 'notes'), true);
});

// ------------------------------------------------------------------------------- L4

test('L4 — an undeclared or non-existent hook is SKW_E_PL_REJECTED at activation', async () => {
  const runtime = fresh();
  let caught: unknown = null;
  try {
    await runtime.enable(TENANT, 'undeclared');
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof AppError, `expected an AppError, got ${String(caught)}`);
  assert.equal((caught as AppError).code, 'SKW_E_PL_REJECTED');
  assert.match((caught as AppError).message, /"route\.resolve" is not one of the twelve/);
  assert.equal(rowOf('undeclared').enabled, 0);
  assert.equal(runtime.registry.has(TENANT, 'undeclared'), false);
});

// ------------------------------------------------------------------------------- L5, L6

test('L5 — a filter that throws does not 500 the page: the value passed in is used and counted', async () => {
  const runtime = fresh();
  await runtime.enable(TENANT, 'thrower');
  const callbacks = runtime.registry.hooksFor(TENANT, 'content.render.html');
  assert.equal(callbacks.length, 1);
  const html = await runtime.hooks.dispatchFilter('content.render.html', TENANT, { tenant: TENANT, path: '/p' }, '<p>kept</p>', callbacks);
  assert.equal(html, '<p>kept</p>', 'the request continues with the value handed in');
  assert.equal(runtime.hooks.failuresInWindow(TENANT, 'thrower'), 1, 'the throw is counted toward auto-disable');
});

test('L6 — a wrong-type return is a failure, not a coercion: original used, hook skipped, counted', async () => {
  const runtime = fresh();
  await runtime.enable(TENANT, 'thrower');
  const callbacks = runtime.registry.hooksFor(TENANT, 'page.head');
  assert.equal(callbacks.length, 1);
  const head = await runtime.hooks.dispatchFilter('page.head', TENANT, { tenant: TENANT, path: '/p' }, '<meta name="core">', callbacks);
  assert.equal(head, '<meta name="core">', 'a number is not coerced to a string: the original is used');
  assert.equal(runtime.hooks.failuresInWindow(TENANT, 'thrower'), 1, 'the wrong type is counted as one failure');

  // The positive control: `undefined`/`null` means "no change" and is **not** a failure.
  const noop = [{ pluginId: 'notes', fn: (() => undefined) as never }];
  const before = runtime.hooks.failuresInWindow(TENANT, 'notes');
  const same = await runtime.hooks.dispatchFilter('page.head', TENANT, { tenant: TENANT, path: '/p' }, '<meta name="core">', noop);
  assert.equal(same, '<meta name="core">');
  assert.equal(runtime.hooks.failuresInWindow(TENANT, 'notes'), before, 'undefined is "no change", never a failure');
});

// ------------------------------------------------------------------------------- L7

test('L7 — the third failure in 60 s disables the plugin and prunes its hooks', async () => {
  const runtime = fresh();
  await runtime.enable(TENANT, 'thrower');
  const callbacks = runtime.registry.hooksFor(TENANT, 'content.render.html');
  // Two failures already happened in L5/L6's runtime, which is a different instance. Here the
  // count starts at zero, so three dispatches are needed — and the third is the one that fires.
  for (let i = 0; i < 3; i += 1) {
    await runtime.hooks.dispatchFilter('content.render.html', TENANT, { tenant: TENANT, path: '/p' }, '<p>x</p>', callbacks);
  }
  assert.equal(runtime.registry.has(TENANT, 'thrower'), false, 'the hooks are gone from the registry');
  assert.equal(rowOf('thrower').enabled, 0, 'and the row says enabled=0');
  const notice = runtime.noticesFor(TENANT).find((n) => n.plugin === 'thrower');
  assert.ok(notice !== undefined, 'an admin notice names the plugin');
  assert.match(notice.message, /failed 3 times in 60 s/);
  // The page still renders: nothing in the dispatch threw.
  const after = await runtime.hooks.dispatchFilter('content.render.html', TENANT, { tenant: TENANT, path: '/p' }, '<p>x</p>', []);
  assert.equal(after, '<p>x</p>');
});

// ------------------------------------------------------------------------------- L8, L9

test('L8 — disable removes the hooks; it does not set a flag that a later refactor can invert', async () => {
  const runtime = fresh();
  await runtime.enable(TENANT, 'notes');
  assert.equal(runtime.registry.hooksFor(TENANT, 'content.render.html').length, 1);
  const removed = await runtime.disable(TENANT, 'notes');
  assert.equal(removed, true);
  assert.deepEqual(runtime.registry.hooksFor(TENANT, 'content.render.html'), []);
  assert.equal(runtime.registry.has(TENANT, 'notes'), false);
  assert.equal(rowOf('notes').enabled, 0, 'the row is disabled too');
  // A snapshot taken after the disable has nothing, and a dispatch on an empty snapshot is the
  // identity function — the honest meaning of "the map has no entry".
  const html = await runtime.hooks.dispatchFilter('content.render.html', TENANT, { tenant: TENANT, path: '/p' }, '<p>core</p>', []);
  assert.equal(html, '<p>core</p>');
});

test('L9 — re-enabling produces a new module instance: the module counter reads 1 again', async () => {
  const runtime = fresh();
  const first = await runtime.enable(TENANT, 'notes');
  const firstCallbacks = runtime.registry.hooksFor(TENANT, 'content.render.html');
  const firstHtml = await runtime.hooks.dispatchFilter('content.render.html', TENANT, { tenant: TENANT, path: '/p' }, '', firstCallbacks);
  assert.match(firstHtml, /act=1:/, 'first activation: the module-level counter is 1');

  await runtime.disable(TENANT, 'notes');
  const second = await runtime.enable(TENANT, 'notes');
  assert.ok(
    second.activationSeq > first.activationSeq,
    `the cache-buster must differ between the two loads (${first.activationSeq} then ${second.activationSeq})`,
  );
  const secondCallbacks = runtime.registry.hooksFor(TENANT, 'content.render.html');
  const html = await runtime.hooks.dispatchFilter('content.render.html', TENANT, { tenant: TENANT, path: '/p' }, '', secondCallbacks);
  assert.match(
    html,
    /act=1:/,
    'a NEW module instance: without the ?act= cache-buster Node would return the old namespace and this would read act=2',
  );
  assert.doesNotMatch(html, /act=2/);
});

// ------------------------------------------------------------------------------- endpoints

test('L10 — an endpoint runs in-process against the per-request facade, and a disabled package is 503', async () => {
  const runtime = fresh();
  await runtime.enable(TENANT, 'notes');
  const db = openAdminWrite(siteDb, 5000);
  try {
    const listed = await runEndpoint(runtime, {
      db,
      tenant: TENANT,
      plugin: 'notes',
      endpoint: 'list',
      method: 'GET',
      url: '/_plugin/notes/list',
      body: '',
    });
    assert.deepEqual((listed as { rows: unknown[] }).rows, []);

    const signed = await runEndpoint(runtime, {
      db,
      tenant: TENANT,
      plugin: 'notes',
      endpoint: 'sign',
      method: 'POST',
      url: '/_plugin/notes/sign',
      body: 'Ada',
    });
    assert.deepEqual(signed, { ok: true });
    const stored = db.prepare(`SELECT value_json FROM cms_plugin_setting WHERE plugin_id = 'notes' AND key = 'signature'`).get() as {
      value_json: string;
    };
    assert.equal(stored.value_json, '"Ada"', 'the write landed in the tenant database');

    // An undeclared endpoint is null → the caller's ordinary 404, not an oracle.
    assert.equal(
      await runEndpoint(runtime, { db, tenant: TENANT, plugin: 'notes', endpoint: 'nope', method: 'GET', url: '/_plugin/notes/nope', body: '' }),
      null,
    );
    // A wrong method is the same 404.
    assert.equal(
      await runEndpoint(runtime, { db, tenant: TENANT, plugin: 'notes', endpoint: 'sign', method: 'GET', url: '/_plugin/notes/sign', body: '' }),
      null,
    );

    await runtime.disable(TENANT, 'notes');
    assert.throws(
      () => assertEnabled(db, 'notes'),
      (err: unknown) => err instanceof AppError && err.code === 'SKW_E_PL_UNAVAILABLE',
      'a disabled package is 503 SKW_E_PL_UNAVAILABLE',
    );
  } finally {
    db.close();
  }

  // Uninstalled is a 404: the row is gone, so `runEndpoint` returns null.
  uninstallPlugin({ siteDb, pluginsRoot: join(dir, 'plugins'), pluginId: 'notes' });
  const db2 = openAdminWrite(siteDb, 5000);
  try {
    assert.equal(
      await runEndpoint(runtime, { db: db2, tenant: TENANT, plugin: 'notes', endpoint: 'list', method: 'GET', url: '/_plugin/notes/list', body: '' }),
      null,
    );
  } finally {
    db2.close();
  }
});
