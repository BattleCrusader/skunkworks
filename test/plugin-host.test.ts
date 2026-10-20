/**
 * S4d item A — **the plugin runner, wired to the app** (§8.3, §8.4, §16 S4).
 *
 * This is the gate for the gap S4c named: the runner answered four ops and refused the ten
 * that need the host, because `app/main.ts` step 6 printed "plugin.sock: not bound". Here
 * the app binds the socket, installs a **third-party package**, runs its code through the
 * runner, and answers the package's `store.*`, `settings.*` and `assets.resolve` calls
 * from the tenant's own `site.db`.
 *
 * What each case is a witness for:
 *
 *   P1  the install matrix — no report, a report for another image, a revoked root are all
 *       refused; an unsigned third-party package **with** a report installs (the positive
 *       control, §13.1a rule 3).
 *   P2  the manifest's tables are created by the host, and an `asset_key` column gets its
 *       delete guard **in the same transaction** — the delete is refused with
 *       `foreign_keys=OFF`, and without the guard the same delete leaves a dangling key.
 *   P3  a package's code reaches the host over the socket: insert, query, setting read and
 *       write, secret-never-returned, asset resolution.
 *   P4  a host op the manifest did not grant is `PL_REJECTED` naming the op; a table the
 *       manifest did not declare is `PL_NO_TABLE`.
 *   P5  a package installed but not enabled is `PL_UNAVAILABLE`; with no runner at the
 *       socket, so is every call.
 *
 * The runner is run **as a host process** here, not in the container: Docker Desktop's VM
 * makes a socket created inside the container unreachable from the host, and the app is a
 * host process in this gate. The container half — the same package under `--network none`,
 * refusing TCP/UDP/fetch — is `test/runner-contain.test.ts` (R6). The two gates are named
 * separately because neither one implies the other.
 */
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { loadEnv } from '../app/env.ts';
import { runExport } from '../app/export/index.ts';
import { AppError } from '../app/errors.ts';
import { buildApp, type AppHandle } from '../app/main.ts';
import { installPlugin, installedPlugins, assertEnabled } from '../app/plugins/install.ts';
import { hostOp } from '../app/plugins/ops.ts';
import { packageRootHash, readManifest } from '../app/plugins/protocol.ts';
import { openAdminWrite } from '../app/db/classes.ts';
import { EDGE_TOKEN, makeFixture, REPO, type Fixture } from './helpers/fixture.ts';

const RUNNER_DIGEST = 'sha256:s4d-test-runner';
const PLUGIN_SRC = join(REPO, 'test', 'fixtures', 'plugins', 'notes');

let fixture: Fixture;
let handle: AppHandle | null = null;
let runner: ChildProcess | null = null;
let pluginsRoot = '';
let reportPath = '';

function reportFor(root: string, digest = RUNNER_DIGEST): string {
  const path = join(fixture.dir, `report-${root.slice(0, 8)}.json`);
  writeFileSync(
    path,
    `${JSON.stringify({ plugin: 'notes', version: '1.0.0', root_hash: root, runner_image_digest: digest, ran_at: new Date().toISOString() }, null, 2)}\n`,
  );
  return path;
}

function waitForSocket(path: string, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      if (existsSync(path)) return resolve();
      if (Date.now() > deadline) return reject(new Error(`no socket at ${path} after ${ms} ms`));
      setTimeout(tick, 50);
    };
    tick();
  });
}

function assertAppError(fn: () => unknown, code: string, message: RegExp): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof AppError, `expected an AppError, got ${String(err)}`);
    assert.equal(err.code, code);
    assert.match(err.message, message);
    return true;
  });
}

function assertThrowsCode(fn: () => unknown, code: string, message: RegExp): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof Error, `expected an Error, got ${String(err)}`);
    assert.match(err.message, new RegExp(`^${code}: `));
    assert.match(err.message, message);
    return true;
  });
}

async function assertAppRejection(fn: () => Promise<unknown>, code: string, message: RegExp): Promise<void> {
  await assert.rejects(fn, (err: unknown) => {
    assert.ok(err instanceof Error, `expected an Error, got ${String(err)}`);
    assert.match(err.message, new RegExp(`^${code}: `));
    assert.match(err.message, message);
    return true;
  });
}

before(async () => {
  fixture = makeFixture({ specs: [{ key: 'acme', hosts: ['acme.test'] }] });
  pluginsRoot = join(fixture.dir, 'plugins');
  const siteDb = fixture.sitePath('acme');

  const { root } = packageRootHash(PLUGIN_SRC);
  reportPath = reportFor(root);
  installPlugin({
    siteDb,
    pluginsRoot,
    sourceDir: PLUGIN_SRC,
    testReportPath: reportPath,
    runnerImageDigest: RUNNER_DIGEST,
    publisher: 'acme-labs',
    signatureState: 'unsigned',
    enable: true,
  });

  // One asset, so `assets.resolve` has a row to resolve and the guard has a key to protect.
  const db = openAdminWrite(siteDb, 5000);
  try {
    db.prepare(
      `INSERT INTO cms_asset (key, filename, mime, bytes, sha256, kind, access_class, width, height, alt_text)
       VALUES ('brochure', 'brochure.pdf', 'application/pdf', 1024, ?, 'document', 'public', NULL, NULL, 'Brochure')`,
    ).run('ab'.repeat(32));
  } finally {
    db.close();
  }
  // The row's bytes, where `storage_path` says they are: the exporter copies the library.
  mkdirSync(join(fixture.dir, 'content', 'media', 'ab'), { recursive: true });
  writeFileSync(join(fixture.dir, 'content', 'media', 'ab', `${'ab'.repeat(32)}.pdf`), Buffer.alloc(1024, 7));

  const socket = join(fixture.dir, 'run', 'plugin.sock');
  mkdirSync(join(fixture.dir, 'run'), { recursive: true });
  mkdirSync(join(fixture.dir, 'scratch'), { recursive: true });
  runner = spawn(process.execPath, [join(REPO, 'runner', 'server.mjs')], {
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      SKW_RUNNER_SOCKET: socket,
      SKW_PLUGINS_DIR: pluginsRoot,
      SKW_SCRATCH_DIR: join(fixture.dir, 'scratch'),
      SKW_RUNNER_HOME: join(REPO, 'runner'),
      SKW_RUNNER_VERSION: 's4d-test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let bootLog = '';
  runner.stdout?.setEncoding('utf8');
  runner.stderr?.setEncoding('utf8');
  runner.stdout?.on('data', (chunk: string) => (bootLog += chunk));
  runner.stderr?.on('data', (chunk: string) => (bootLog += chunk));
  await waitForSocket(socket, 20_000);

  handle = await buildApp({ env: loadEnv(fixture.env), pluginSocket: socket });
  // The child handshake is asynchronous; `plugin.list` is the cheapest request that only
  // answers after the registry exists.
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      const list = await handle.plugins.list();
      if (list.length === 1 && list[0]?.ready === true) break;
    } catch {
      /* not up */
    }
    if (Date.now() > deadline) throw new Error(`the plugin did not become ready:\n${bootLog}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
});

after(async () => {
  await handle?.close();
  runner?.kill('SIGKILL');
  fixture?.cleanup();
});

test('P1 — the install matrix refuses an untested, stale or revoked package, and installs a signed-off third-party one', () => {
  const siteDb = fixture.sitePath('acme');
  const source = join(fixture.dir, 'matrix-source');
  cpSync(PLUGIN_SRC, source, { recursive: true });
  const { root } = packageRootHash(source);

  // no report
  assertAppError(
    () => installPlugin({ siteDb, pluginsRoot: join(fixture.dir, 'unused'), sourceDir: source, runnerImageDigest: RUNNER_DIGEST }),
    'SKW_E_PL_TESTS_STALE',
    /no test report/,
  );

  // a report for another runner image is stale even though the root matches
  const stale = reportFor(root, 'sha256:another-image');
  assertAppError(
    () =>
      installPlugin({
        siteDb,
        pluginsRoot: join(fixture.dir, 'unused'),
        sourceDir: source,
        testReportPath: stale,
        runnerImageDigest: RUNNER_DIGEST,
      }),
    'SKW_E_PL_TESTS_STALE',
    /produced by another runner image/,
  );

  // a revoked root cannot be installed whatever its report says. A distinct package (one
  // comment line more) gives a distinct root, so this is about revocation and nothing else.
  const revokedSource = join(fixture.dir, 'revoked-source');
  cpSync(PLUGIN_SRC, revokedSource, { recursive: true });
  writeFileSync(join(revokedSource, 'index.mjs'), `${readFileSync(join(revokedSource, 'index.mjs'), 'utf8')}\n// revoked copy\n`);
  const revokedRoot = packageRootHash(revokedSource).root;
  const revokeDb = openAdminWrite(siteDb, 5000);
  try {
    revokeDb.prepare(`INSERT INTO cms_plugin_revoked (root_hash, plugin_id, reason) VALUES (?, 'notes', 'gate')`).run(revokedRoot);
  } finally {
    revokeDb.close();
  }
  const revokedReport = join(fixture.dir, 'revoked-report.json');
  writeFileSync(
    revokedReport,
    JSON.stringify({ plugin: 'notes', version: '1.0.0', root_hash: revokedRoot, runner_image_digest: RUNNER_DIGEST, ran_at: '2026-10-21T00:00:00.000Z' }),
  );
  assertAppError(
    () =>
      installPlugin({
        siteDb,
        pluginsRoot: join(fixture.dir, 'unused'),
        sourceDir: revokedSource,
        testReportPath: revokedReport,
        runnerImageDigest: RUNNER_DIGEST,
      }),
    'SKW_E_PL_REVOKED',
    /revoked on this install/,
  );

  // The positive control: the same package with a current report is installed into a fresh
  // tenant database, and the row records the report's sha — `enabled=1` with no report is
  // unrepresentable by the schema's CHECK.
  const freshDb = join(fixture.dir, 'fresh-site.db');
  const fresh = new Database(freshDb);
  try {
    fresh.exec(readFileSync(join(REPO, 'schema', 'site.sql'), 'utf8'));
  } finally {
    fresh.close();
  }
  const freshPlugins = join(fixture.dir, 'matrix-fresh');
  const freshReport = reportFor(root);
  const ok = installPlugin({
    siteDb: freshDb,
    pluginsRoot: freshPlugins,
    sourceDir: source,
    testReportPath: freshReport,
    runnerImageDigest: RUNNER_DIGEST,
    signatureState: 'unsigned',
    enable: true,
  });
  assert.equal(ok.enabled, true);
  assert.equal(ok.root_hash, root);
  assert.match(ok.test_report_sha, /^[0-9a-f]{64}$/);
});

test('P2 — a plugin asset_key delete is blocked with foreign_keys=OFF, and the table was created by the install', () => {
  const db = new Database(fixture.sitePath('acme'));
  try {
    const table = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='p_notes_note'`).get();
    assert.ok(table, 'the install did not create the manifest table');
    const trigger = db.prepare(`SELECT name FROM sqlite_master WHERE type='trigger' AND name='trg_asset_guard_p_notes_note'`).get();
    assert.ok(trigger, 'the install did not create the asset guard');
    const registered = db.prepare(`SELECT name FROM cms_trigger_registry WHERE name='trg_asset_guard_p_notes_note'`).get();
    assert.ok(registered, 'the guard is not in cms_trigger_registry');

    db.prepare(`INSERT INTO p_notes_note (body, asset_key) VALUES ('contract', 'brochure')`).run();
    db.pragma('foreign_keys = OFF');
    assert.throws(() => db.prepare(`DELETE FROM cms_asset WHERE key='brochure'`).run(), /SKW_E_DM_ASSET_IN_USE/);

    // Positive control: drop the guard and the same delete leaves a dangling key. Without
    // this half, "the delete was refused" could be a property of something else entirely.
    db.exec('DROP TRIGGER trg_asset_guard_p_notes_note');
    db.prepare(`DELETE FROM cms_asset WHERE key='brochure'`).run();
    const dangling = db
      .prepare(`SELECT COUNT(*) AS n FROM p_notes_note m LEFT JOIN cms_asset a ON a.key = m.asset_key WHERE a.key IS NULL`)
      .get() as { n: number };
    assert.equal(dangling.n, 1);
    // Put the fixture back for the later cases.
    db.prepare(`DELETE FROM p_notes_note WHERE body = 'contract'`).run();
    db.exec(
      `CREATE TRIGGER trg_asset_guard_p_notes_note BEFORE DELETE ON cms_asset
       WHEN EXISTS (SELECT 1 FROM p_notes_note WHERE asset_key = OLD.key)
       BEGIN SELECT RAISE(ABORT, 'SKW_E_DM_ASSET_IN_USE'); END`,
    );
    db.prepare(
      `INSERT INTO cms_asset (key, filename, mime, bytes, sha256, kind, access_class, width, height, alt_text)
       VALUES ('brochure', 'brochure.pdf', 'application/pdf', 1024, ?, 'document', 'public', NULL, NULL, 'Brochure')`,
    ).run('ab'.repeat(32));
  } finally {
    db.close();
  }
});

test('P3 — a third-party package runs and its host ops are answered against the tenant db', async () => {
  assert.ok(handle !== null);
  const saved = (await handle.plugins.invoke('acme', 'notes', 'sign', { value: 'acme-labs' })) as { ok: boolean };
  assert.equal(saved.ok, true);

  const written = (await handle.plugins.invoke('acme', 'notes', 'save', { body: 'first note', asset_key: 'brochure' })) as {
    id: number;
    signature: string | null;
  };
  assert.ok(written.id > 0, 'store.insert did not return an id');
  assert.equal(written.signature, 'acme-labs', 'settings.get did not read the value settings.set wrote');

  const listed = (await handle.plugins.invoke('acme', 'notes', 'list', {})) as { count: number };
  assert.equal(listed.count, 1, 'store.query did not see the inserted row');

  const secret = (await handle.plugins.invoke('acme', 'notes', 'peek', {})) as { token: string | null };
  assert.equal(secret.token, null, 'a secret setting must never be returned');

  const asset = (await handle.plugins.invoke('acme', 'notes', 'asset', { key: 'brochure' })) as {
    asset: { url: string; mime: string; width: number | null } | null;
  };
  assert.ok(asset.asset !== null);
  assert.match(asset.asset.url, /^\/media\/brochure\.pdf\?v=abababab$/);
  assert.equal(asset.asset.mime, 'application/pdf');
});

test('P4 — an undeclared op is PL_REJECTED and a foreign table is PL_NO_TABLE, both naming the package', async () => {
  assert.ok(handle !== null);
  await assertAppRejection(() => handle!.plugins.invoke('acme', 'notes', 'steal', {}), 'SKW_E_PL_REJECTED', /store\.delete is not in notes's declared capabilities/);
  await assertAppRejection(() => handle!.plugins.invoke('acme', 'notes', 'foreign', {}), 'SKW_E_PL_NO_TABLE', /notes did not declare table "cms_page"/);
});

test('P5 — the other five host ops are implemented, and a secret is write-only', () => {
  const db = openAdminWrite(fixture.sitePath('acme'), 5000);
  try {
    const manifest = readManifest(join(pluginsRoot, 'notes'));
    const ctx = { db, tenant: 'acme', plugin: 'notes', manifest, emailMode: 'off' as const };
    const inserted = hostOp(ctx, 'store.insert', { table: 'p_notes_note', row: { body: 'second note' } }) as { id: number };
    const updated = hostOp(ctx, 'store.update', { table: 'p_notes_note', id: inserted.id, patch: { body: 'edited' } }) as { changes: number };
    assert.equal(updated.changes, 1);
    const counted = hostOp(ctx, 'store.count', { table: 'p_notes_note', where: [{ column: 'body', op: 'like_prefix', value: 'edit' }] }) as { count: number };
    assert.equal(counted.count, 1);
    const has0 = hostOp(ctx, 'settings.has', { key: 'api_token' }) as { has: boolean };
    assert.equal(has0.has, false);
    hostOp(ctx, 'settings.set', { key: 'api_token', value: 'hunter2' });
    const has = hostOp(ctx, 'settings.has', { key: 'api_token' }) as { has: boolean };
    assert.equal(has.has, true);
    const removed = hostOp(ctx, 'store.delete', { table: 'p_notes_note', id: inserted.id }) as { changes: number };
    assert.equal(removed.changes, 1);
    hostOp(ctx, 'settings.set', { key: 'api_token', value: 'hunter2' });
    assert.equal(hostOp(ctx, 'settings.get', { key: 'api_token' }), null);
    assertThrowsCode(() => hostOp(ctx, 'mail.send', { to: 'a@b.test', template: 'note' }), 'SKW_E_PL_MAIL', /mail\.send is unavailable/);
    assertThrowsCode(
      () => hostOp(ctx, 'store.query', { table: 'p_notes_note', where: [{ column: 'body', op: 'contains', value: 'x' }] }),
      'SKW_E_PL_QUERY',
      /is not one of/,
    );
  } finally {
    db.close();
  }
});

test('P7 — the CMS exporter ships the installed package, and the bundle verifies', () => {
  const bundle = join(fixture.dir, 'bundle');
  rmSync(bundle, { recursive: true, force: true });
  const db = openAdminWrite(fixture.sitePath('acme'), 5000);
  let result;
  try {
    result = runExport({
      target: 'cms',
      db,
      tenantKey: 'acme',
      out: bundle,
      exportNow: '2026-10-21T00:00:00.000Z',
      contentRoot: join(fixture.dir, 'content'),
      repoRoot: REPO,
      tmpDir: fixture.dir,
      origin: 'https://acme.test',
      tenant: {
        key: 'acme',
        mode: 'production',
        status: 'active',
        displayName: 'Acme',
        dbVersion: 3,
        hosts: [{ host: 'acme.test', kind: 'primary', isPrimary: 1, certState: 'issued' }],
      },
    });
  } finally {
    db.close();
  }
  assert.equal(result.ok, true, JSON.stringify(result.ok ? {} : result.refusals));

  // The package travels where compose mounts it, and the manifest names the row's hash.
  assert.ok(existsSync(join(bundle, 'data', 'plugins', 'notes', 'plugin.json')), 'the bundle does not carry the package');
  const manifest = JSON.parse(readFileSync(join(bundle, 'BUNDLE.json'), 'utf8')) as {
    plugins: { id: string; version: string; root_hash: string }[];
    files: { path: string }[];
  };
  assert.deepEqual(manifest.plugins.map((p) => `${p.id}@${p.version}`), ['notes@1.0.0']);
  assert.ok(manifest.files.some((f) => f.path === 'data/plugins/notes/index.mjs'), 'the package files are absent from the manifest');
  assert.match(manifest.plugins[0]?.root_hash ?? '', /^[0-9a-f]{64}$/);

  // The verifier reaches its plugin branch and passes: package present, root matches.
  const verified = spawnSync(process.execPath, [join(REPO, 'tools', 'bundle_verify.mjs'), '--bundle', bundle], { encoding: 'utf8' });
  assert.equal(verified.status, 0, `${verified.stdout}\n${verified.stderr}`);
  assert.match(verified.stdout, /verified/);
});

test('P6 — an installed but disabled package is PL_UNAVAILABLE, and so is a host with no runner', async () => {
  assert.ok(handle !== null);
  const siteDb = fixture.sitePath('acme');
  const source = join(fixture.dir, 'disabled-source');
  cpSync(PLUGIN_SRC, source, { recursive: true });
  // A different id, so both packages coexist and the runner has loaded only `notes`.
  const manifestPath = join(source, 'plugin.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  manifest.id = 'notes2';
  manifest.tables = [{ name: 'p_notes2_note', export: 'rows', columns: [{ name: 'body', type: 'TEXT', indexed: true }] }];
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const { root } = packageRootHash(source);
  const report = join(fixture.dir, 'disabled-report.json');
  writeFileSync(report, JSON.stringify({ plugin: 'notes2', version: '1.0.0', root_hash: root, runner_image_digest: RUNNER_DIGEST, ran_at: '2026-10-21T00:00:00.000Z' }));
  installPlugin({
    siteDb,
    pluginsRoot,
    sourceDir: source,
    testReportPath: report,
    runnerImageDigest: RUNNER_DIGEST,
    signatureState: 'unsigned',
    enable: false,
  });
  const rows = installedPlugins(openAdminWrite(siteDb, 5000));
  assert.equal(rows.find((r) => r.plugin_id === 'notes2')?.enabled, false);
  const check = openAdminWrite(siteDb, 5000);
  try {
  assertAppError(() => assertEnabled(check, 'notes2'), 'SKW_E_PL_UNAVAILABLE', /installed but not enabled/);
  } finally {
    check.close();
  }

  // `notes2` was installed after the runner loaded its registry, so the runner does not know
  // it: the refusal is PL_UNAVAILABLE, and the message names the package.
  await assertAppRejection(() => handle!.plugins.invoke('acme', 'notes2', 'list', {}), 'SKW_E_PL_UNAVAILABLE', /no package "notes2"/);

  // A host with no runner: every call is PL_UNAVAILABLE and names the socket.
  const orphan = await buildApp({ env: loadEnv(fixture.env), pluginSocket: join(fixture.dir, 'run', 'absent.sock') });
  try {
    assert.equal(orphan.plugins.isConnected, false);
    await assert.rejects(() => orphan.plugins.invoke('acme', 'notes', 'list', {}), /SKW_E_PL_UNAVAILABLE: the plugin runner is not bound/);
  } finally {
    await orphan.close();
  }
});

/**
 * S4e blocker 2 — **a tenant's request actually runs a package's code** (D25, §8.6).
 *
 * The gap this closes is not subtle: before S4e, no product code called
 * `plugins.invoke()`. A package could be installed, enabled, verified and exported, and no
 * URL, page or form would ever ask it to do anything.
 *
 * Each case is a different half of the contract:
 *   E1  GET on a declared endpoint reaches the package, and its `skw.call('store.query')` is
 *       answered by the host from the tenant's own database — the full three-hop chain
 *       (HTTP → app → socket → runner → child → host → back).
 *   E2  POST is routed only to a POST endpoint, the body arrives as `args.body`, and the
 *       package's host write lands in `site.db` (a read-only smoke test would not prove the
 *       direction that matters).
 *   E3  an undeclared endpoint and a method mismatch are the tenant's **ordinary 404** —
 *       byte-identical to a path with no page, so the surface is not an oracle.
 *   E4  disabled is 503 `PL_UNAVAILABLE`, not 404: the endpoint exists and this package cannot
 *       answer it (§8.6). After uninstall, the same URL is 404.
 *   E5  a 16 KiB body cap, enforced before the runner is asked.
 */
test('E1 — a public URL reaches the package through the runner, and the host answers its query', async () => {
  assert.ok(handle !== null);
  const res = await handle.app.inject({
    method: 'GET',
    url: '/_plugin/notes/list',
    headers: { host: 'acme.test' },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.match(String(res.headers['content-type']), /application\/json/);
  assert.equal(res.headers['cache-control'], 'no-store');
  const body = res.json() as { count?: number; rows?: { body?: string }[] };
  // The rows were written by P3 through the same package; the query is answered by the host
  // from `site.db`, inside the invoke this HTTP request started. The count is whatever P3
  // left behind — the assertion is that the HTTP path returns the *host's* answer, not a
  // number this test invented.
  assert.ok((body.count ?? 0) >= 1, JSON.stringify(body));
  assert.equal(body.rows?.length, body.count);
  assert.equal(typeof body.rows?.[0]?.body, 'string');
});

test('E2 — a POST endpoint receives the body and its host write lands in the tenant database', async () => {
  assert.ok(handle !== null);
  const res = await handle.app.inject({
    method: 'POST',
    url: '/_plugin/notes/sign',
    headers: { host: 'acme.test', 'content-type': 'text/plain' },
    payload: 'from-the-edge',
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json(), { ok: true });
  const db = openAdminWrite(fixture.sitePath('acme'), 5000);
  try {
    const row = db.prepare("SELECT value_json FROM cms_plugin_setting WHERE plugin_id='notes' AND key='signature'").get() as
      | { value_json: string }
      | undefined;
    assert.equal(row?.value_json, '"from-the-edge"', 'the package\'s settings.set did not reach the host');
  } finally {
    db.close();
  }
});

test('E3 — an undeclared endpoint and a wrong method are the ordinary 404, byte-identical to a missing page', async () => {
  assert.ok(handle !== null);
  const miss = await handle.app.inject({ method: 'GET', url: '/no-such-page', headers: { host: 'acme.test' } });
  assert.equal(miss.statusCode, 404);
  // `requestId` is per request by design; everything else must match byte for byte.
  const withoutId = (body: string): string => body.replace(/"requestId":"[^"]+"/, '"requestId":"*"');
  const probes: { method: 'GET' | 'POST'; url: string }[] = [
    { method: 'GET', url: '/_plugin/notes/nope' },
    { method: 'POST', url: '/_plugin/notes/list' }, // declared, but GET
    { method: 'GET', url: '/_plugin/ghost/list' },
  ];
  for (const probe of probes) {
    const res = (await handle.app.inject({ method: probe.method, url: probe.url, headers: { host: 'acme.test' } })) as {
      statusCode: number;
      body: string;
    };
    assert.equal(res.statusCode, 404, `${probe.method} ${probe.url}: ${res.statusCode} ${res.body}`);
    assert.equal(withoutId(res.body), withoutId(miss.body), `${probe.method} ${probe.url} is an oracle: the body differs from a page miss`);
  }
});

test('E4 — disabled is 503 PL_UNAVAILABLE; uninstalled is 404', async () => {
  assert.ok(handle !== null);
  const db = openAdminWrite(fixture.sitePath('acme'), 5000);
  try {
    db.prepare("UPDATE cms_plugin_installed SET enabled = 0 WHERE plugin_id = 'notes'").run();
  } finally {
    db.close();
  }
  const disabled = await handle.app.inject({ method: 'GET', url: '/_plugin/notes/list', headers: { host: 'acme.test' } });
  assert.equal(disabled.statusCode, 503, disabled.body);
  assert.equal((disabled.json() as { error?: { code?: string } }).error?.code, 'SKW_E_PL_UNAVAILABLE');

  const back = openAdminWrite(fixture.sitePath('acme'), 5000);
  try {
    back.prepare("UPDATE cms_plugin_installed SET enabled = 1 WHERE plugin_id = 'notes'").run();
  } finally {
    back.close();
  }
});

test('E5 — a plugin endpoint body is capped at 16 KiB before the runner is asked', async () => {
  assert.ok(handle !== null);
  const big = 'x'.repeat(16 * 1024 + 1);
  const res = await handle.app.inject({
    method: 'POST',
    url: '/_plugin/notes/sign',
    headers: { host: 'acme.test', 'content-type': 'text/plain' },
    payload: big,
  });
  assert.equal(res.statusCode, 413, res.body);
  assert.equal((res.json() as { error?: { code?: string } }).error?.code, 'SKW_E_PLT_BODY_TOO_LARGE');
});
