/**
 * S5 item 4 — **the runtime-notice screen** (§13.3.6).
 *
 * The data existed before this screen did: `runtime.noticesFor(tenant)` returns a `failed`
 * load, a three-in-60-s auto-disable and a revocation refusal, and `plugin-revocation.test.ts`
 * asserts each one. Nothing rendered it, so "an admin notice names the code and the plugin" was
 * true of the data and false of the product: an operator whose plugin had been disabled had no
 * way to see it without a shell.
 *
 *   N1  a failed load and a revocation refusal are both visible, with their codes and messages
 *   N2  each disabled package offers a re-enable form (POST + session CSRF, never a link)
 *   N3  the re-enable path works: un-revoke, submit the form, the row enables, the package
 *       runs (its hook fires on a page), and the screen says so
 *   N4  the tenant home counts the notices, so a disabled plugin is visible from the menu
 */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { loadEnv } from '../app/env.ts';
import { buildApp, type AppHandle } from '../app/main.ts';
import { installPlugin } from '../app/plugins/install.ts';
import { packageRootHash } from '../app/plugins/manifest.ts';
import { revokeRoot, revocationPath, REVOCATION_FORMAT } from '../app/plugins/revocation.ts';
import { trustDirFor } from '../app/plugins/trust.ts';
import { openAdminWrite } from '../app/db/classes.ts';
import { ADMIN_HOST, PASSWORD, TOTP_SECRET, openSession, seedUser } from './helpers/admin.ts';
import { REPO, makeFixture, type Fixture } from './helpers/fixture.ts';
import { call, type Res } from './helpers/http.ts';

const TENANT = 'acme';
const HOST = 'acme.test';
const DIGEST = 'sha256:s5-notices-app';
/**
 * The load-failure fixture: a package whose module exports no `activate`, which is
 * `SKW_E_PL_LOAD` at step 7 of §13.3.2. (`thrower` is a *dispatch* failure — it activates
 * fine and throws inside its hooks — which is a different row of the failure table.)
 */
const BADSHAPE = join(REPO, 'test', 'fixtures', 'plugins', 'badshape');
const ACTSEQ = join(REPO, 'test', 'fixtures', 'plugins', 'actseq');

let fixture: Fixture;
let handle: AppHandle;
let port = 0;
let session: { cookie: string; csrfToken: string };

function siteDbFile(): string {
  return fixture.sitePath(TENANT);
}

function install(sourceDir: string, plugin: string): string {
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
  return root;
}

function screen(): Promise<Res> {
  return call({ port, path: `/admin/t/${TENANT}/plugins`, host: ADMIN_HOST, headers: { cookie: session.cookie } });
}

function home(): Promise<Res> {
  return call({ port, path: `/admin/t/${TENANT}/`, host: ADMIN_HOST, headers: { cookie: session.cookie } });
}

before(async () => {
  fixture = makeFixture({ specs: [{ key: TENANT, hosts: [HOST], title: 'Acme', body: '<h1>Notice page</h1>' }] });
  install(BADSHAPE, 'badshape');
  const actseqRoot = install(ACTSEQ, 'actseq');

  handle = await buildApp({ env: loadEnv(fixture.env) });
  await handle.app.listen({ port: 0, host: '127.0.0.1' });
  const address = handle.app.server.address();
  port = typeof address === 'object' && address !== null ? address.port : 0;

  // 1. A package whose activation throws: `failed`, `enabled=0`, a notice naming the code.
  await assert.rejects(async () => handle.plugins.enable(TENANT, 'badshape'));

  // 2. A package whose root is revoked after install: the refusal is a notice too, and it is
  //    the one an operator can fix without a shell — which is what N3 does.
  const db = openAdminWrite(siteDbFile(), 5000);
  try {
    revokeRoot({
      trustDir: trustDirFor(siteDbFile()),
      db,
      rootHash: actseqRoot,
      pluginId: 'actseq',
      reason: 'S5 notices gate',
      now: new Date().toISOString(),
    });
  } finally {
    db.close();
  }
  await assert.rejects(async () => handle.plugins.enable(TENANT, 'actseq'));

  const email = 'owner@acme.test';
  await seedUser({ controlDb: fixture.controlDb, tenantKey: TENANT, email, totpSecret: TOTP_SECRET });
  session = await openSession({ port, key: TENANT, email, password: PASSWORD });
});

after(async () => {
  await handle.close();
  fixture.cleanup();
});

test('N1. a failed load and a revocation are visible, with the code and the reason', async () => {
  const res = await screen();
  assert.equal(res.status, 200, res.body);
  assert.match(res.body, /data-notice="badshape"/);
  assert.match(res.body, /SKW_E_PL_LOAD/);
  assert.match(res.body, /does not export activate/, 'the notice must carry the runtime message');
  assert.match(res.body, /data-notice="actseq"/);
  assert.match(res.body, /SKW_E_PL_REVOKED/);
  assert.match(res.body, /S5 notices gate/, 'the revocation reason is part of the message');
  // The state column: a package that failed to load is not "enabled" however the row reads.
  assert.match(res.body, /disabled/);
});

test('N2. every disabled package offers a re-enable form, not a link', async () => {
  const res = await screen();
  assert.equal(res.status, 200);
  const forms = res.body.match(/<form method="post" action="\/admin\/t\/acme\/plugins\/enable">/g) ?? [];
  assert.equal(forms.length, 2, 'one form per installable row that is not running');
  assert.match(res.body, /name="plugin" value="actseq"/);
  assert.match(res.body, new RegExp(`name="csrf" value="${session.csrfToken}"`));
});

test('N4. the tenant home counts the notices, so a disabled plugin is visible from the menu', async () => {
  const res = await home();
  assert.equal(res.status, 200, res.body);
  assert.match(res.body, /href="\/admin\/t\/acme\/plugins">Plugins \(2\)</);
});

test('N3. the re-enable path: un-revoke, submit the form, the row enables and the package runs', async () => {
  // The operator's other half of revocation: remove the entry from both sources.
  const db = openAdminWrite(siteDbFile(), 5000);
  try {
    db.prepare('DELETE FROM cms_plugin_revoked').run();
  } finally {
    db.close();
  }
  writeFileSync(revocationPath(trustDirFor(siteDbFile())), `${JSON.stringify({ format: REVOCATION_FORMAT, revoked: [] }, null, 2)}\n`);

  const res = await call({
    port,
    path: `/admin/t/${TENANT}/plugins/enable`,
    method: 'POST',
    host: ADMIN_HOST,
    headers: {
      cookie: session.cookie,
      origin: 'https://admin.skw.test',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ plugin: 'actseq', csrf: session.csrfToken }).toString(),
  });
  assert.equal(res.status, 303, res.body);
  const location = String(res.headers.location ?? '');
  assert.match(location, /\/admin\/t\/acme\/plugins\?result=/);
  const flash = decodeURIComponent(location);
  assert.match(flash, /actseq enabled \(activation \d+, hooks: page\.head\)/);
  // The refused enable before the un-revoke consumed a number: the counter is a cache key, not
  // a success count, and re-issuing a URL the ESM cache has seen is the one thing it must not
  // do. The number in the flash is the number the module's URL must carry.
  const activation = Number(/activation (\d+)/.exec(flash)?.[1]);
  assert.ok(activation >= 2, `expected a continuation, got activation ${activation}`);

  const after = await screen();
  assert.match(after.body, /enabled, loaded/);
  assert.match(after.body, /actseq@1\.0\.0/);

  // …and it is really running: its only hook is `page.head`, and the page carries the act.
  const page = await call({ port, path: '/pricing', host: HOST });
  assert.equal(page.status, 200, page.body);
  assert.match(page.body, new RegExp(`<!--act:${activation}-->`));
});

test('N3b. the CSRF field is not a bypass: no token, no enable', async () => {
  const res = await call({
    port,
    path: `/admin/t/${TENANT}/plugins/enable`,
    method: 'POST',
    host: ADMIN_HOST,
    headers: { cookie: session.cookie, origin: 'https://admin.skw.test', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ plugin: 'actseq' }).toString(),
  });
  assert.equal(res.status, 403, res.body);
  assert.match(res.body, /SKW_E_SEC_CSRF/);
});
