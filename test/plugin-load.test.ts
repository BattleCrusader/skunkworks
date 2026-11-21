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
 *   L10 an endpoint runs in-process against the per-request facade; a disabled package is a 503.
 *   L11 a failed activation is scoped to the bytes that failed: identical bytes are not re-imported,
 *       and a repair to either the row or the disk reactivates **in the same process**.
 *   L12 the other repair: a row rewritten to bytes already on disk.
 *   L13 an upgrade written by another process re-activates here on the next sync.
 */
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

/**
 * L11 — a failed activation is a **scoped** refusal, not a permanent one.
 *
 * The observed production sequence (dev box, tenant `arnavia`): the package on disk was upgraded
 * from another process while the tenant's row still named the old root, the next request's `sync()`
 * failed with `SKW_E_PL_SIGNATURE`, and the runtime remembered that failure as a bare flag. The row
 * was then repaired by the operator — `skwctl plugin install --enable` — and the tenant stayed dark
 * for as long as the process lived: `enabled = 1` in the database, and every request answering
 * `SKW_E_PL_UNAVAILABLE … did not register it at activation` until a restart. A blacklist that
 * outlives its cause is a bug, not a safety feature.
 *
 * What this witnesses: the same broken bytes are never imported twice on purpose, and a repair to
 * **either** face of the failure — the row the operator rewrote, or the bytes they put back —
 * reactivates on the next request with no new process.
 */
test('L11 — a repaired package reactivates without a restart; the same broken bytes do not', async () => {
  const src = join(dir, 'src-notes-repair');
  cpSync(NOTES, src, { recursive: true });
  try {
    uninstallPlugin({ siteDb, pluginsRoot: join(dir, 'plugins'), pluginId: 'notes' });
  } catch {
    /* first run in this file already uninstalled it */
  }
  install(src, 'notes');

  const runtime = fresh();
  await runtime.enable(TENANT, 'notes');
  assert.equal(runtime.registry.has(TENANT, 'notes'), true, 'the clean package activates');

  // Edit the installed bytes: the row still names the clean root, so the next activation refuses.
  const installed = join(dir, 'plugins', 'notes', 'index.mjs');
  writeFileSync(installed, `${readFileSync(installed, 'utf8')}\n// edited after install\n`);
  await runtime.disable(TENANT, 'notes');

  // Another process turns the row on (`skwctl plugin install --enable`), and the sync that follows
  // is the attempt that fails: row says clean root, disk holds edited bytes.
  const enableRow = (): void => {
    const db = openAdminWrite(siteDb, 5000);
    try {
      db.prepare(`UPDATE cms_plugin_installed SET enabled = 1 WHERE plugin_id = 'notes'`).run();
    } finally {
      db.close();
    }
  };
  enableRow();
  await runtime.sync(TENANT);
  assert.equal(runtime.registry.has(TENANT, 'notes'), false, 'edited bytes do not activate');
  assert.equal(rowOf('notes').enabled, 0, 'the failure disabled the row, as §13.3.6 says');

  // The row turned on again without repairing the bytes: still refused, and not re-imported.
  enableRow();
  await runtime.sync(TENANT);
  await runtime.sync(TENANT);
  assert.equal(runtime.registry.has(TENANT, 'notes'), false, 'identical bytes are not imported again');

  // The repair that matters: the signed bytes are back on disk. Same process, no restart.
  cpSync(join(src, 'index.mjs'), installed);
  enableRow();
  await runtime.sync(TENANT);
  assert.equal(runtime.registry.has(TENANT, 'notes'), true, 'restored bytes activate on the next sync');

  await runtime.disable(TENANT, 'notes');
  runtime.closeSyncHandles?.();
});

/**
 * L12 — the other repair: the row is rewritten to new bytes (an upgrade) while the disk already
 * holds them. This is the dev sequence exactly, and it is the face a fingerprint on the disk alone
 * would miss.
 */
test('L12 — a row rewritten to the bytes already on disk reactivates without a restart', async () => {
  const src = join(dir, 'src-notes-upgrade');
  cpSync(NOTES, src, { recursive: true });
  try {
    uninstallPlugin({ siteDb, pluginsRoot: join(dir, 'plugins'), pluginId: 'notes' });
  } catch {
    /* already gone */
  }
  install(src, 'notes');

  const runtime = fresh();
  await runtime.enable(TENANT, 'notes');
  assert.equal(runtime.registry.has(TENANT, 'notes'), true);

  // New bytes land on disk (the upgrade) while the row still names the old root.
  const version = JSON.parse(readFileSync(join(dir, 'plugins', 'notes', 'plugin.json'), 'utf8')) as { version: string };
  const editedMain = join(dir, 'plugins', 'notes', 'index.mjs');
  const before = readFileSync(editedMain, 'utf8');
  writeFileSync(editedMain, `${before}\n// 2.0.0\n`);
  const newRoot = packageRootHash(join(dir, 'plugins', 'notes')).root;
  await runtime.disable(TENANT, 'notes');
  await runtime.sync(TENANT);
  assert.equal(runtime.registry.has(TENANT, 'notes'), false, 'the mismatch refuses, and marks the failure');

  // The operator finishes the upgrade in another process: the row now names the new root.
  const db = openAdminWrite(siteDb, 5000);
  try {
    db.prepare(`UPDATE cms_plugin_installed SET enabled = 1, root_hash = ?, version = ? WHERE plugin_id = 'notes'`).run(
      newRoot,
      version.version,
    );
  } finally {
    db.close();
  }
  await runtime.sync(TENANT);
  assert.equal(runtime.registry.has(TENANT, 'notes'), true, 'the row repair alone reactivates it');

  await runtime.disable(TENANT, 'notes');
  runtime.closeSyncHandles?.();
});

/**
 * L13 — an upgrade written by **another process** reaches the running one on the next request.
 *
 * `skwctl plugin install` writes the row and the package directory from a second process, and the
 * server keeps serving the module it already imported — `sync()` saw `registry.has()` and returned.
 * The CLI's own words are "live from the site's next request", so the claim was false for an
 * upgrade; the loaded entry now carries the **root hash** it loaded, and a row naming different
 * bytes is re-activated in place. `version` could not witness this: it is a claim the manifest
 * makes, and the old module would keep making it.
 */
test('L13 — a package upgraded by another process re-activates on the next sync', async () => {
  const src = join(dir, 'src-notes-upgraded');
  cpSync(NOTES, src, { recursive: true });
  try {
    uninstallPlugin({ siteDb, pluginsRoot: join(dir, 'plugins'), pluginId: 'notes' });
  } catch {
    /* already gone */
  }
  install(src, 'notes');

  const runtime = fresh();
  await runtime.enable(TENANT, 'notes');
  const first = runtime.registry.get(TENANT, 'notes');
  assert.ok(first !== undefined);
  assert.equal(first.rootHash.length, 64, 'the entry records the root it loaded');

  // A second process replaces the package and rewrites the row (what `plugin install` does), with
  // the running process none the wiser: nothing here calls `enable`.
  const installed = join(dir, 'plugins', 'notes');
  const main = join(installed, 'index.mjs');
  writeFileSync(main, `${readFileSync(main, 'utf8')}\n// 1.1.0: an upgrade from another process\n`);
  // An upgrade moves forward only, so the version moves with the bytes: a same-version reinstall is
  // refused as a downgrade, and that refusal is not what this test is about.
  const manifestPath = join(installed, 'plugin.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version: string };
  manifest.version = '1.1.0';
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const reportPath = join(dir, 'notes-1.1.0-report.json');
  writeFileSync(
    reportPath,
    `${JSON.stringify({ plugin: 'notes', version: '1.1.0', root_hash: packageRootHash(installed).root, runner_image_digest: DIGEST, ran_at: new Date().toISOString() }, null, 2)}\n`,
  );
  installPlugin({
    siteDb,
    pluginsRoot: join(dir, 'plugins'),
    sourceDir: installed,
    allowUnsigned: true,
    testReportPath: reportPath,
    runnerImageDigest: DIGEST,
  });

  await runtime.sync(TENANT);
  const second = runtime.registry.get(TENANT, 'notes');
  assert.ok(second !== undefined, 'the upgraded package is loaded');
  assert.notEqual(second.rootHash, first.rootHash, 'the served module is the new bytes');
  assert.equal(second.rootHash, packageRootHash(installed).root);
  assert.ok(second.activationSeq > first.activationSeq, 'a new module instance, not the cached one');

  await runtime.disable(TENANT, 'notes');
  runtime.closeSyncHandles?.();
});
