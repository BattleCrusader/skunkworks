/**
 * The box's package library, and the one thing it exists to make impossible.
 *
 * Before this, a package was either installed for *this* tenant or invisible to it: dropping a
 * `.tar.gz` on the box did nothing until somebody ran `skwctl plugin install --tenant …`, which
 * made every new tenant a fresh shell session. The library is the box's own shelf — every tenant
 * sees every archive on it, and installing one is a per-tenant act that writes into that tenant's
 * database and nowhere else.
 *
 * The tests below are the boundary as much as the button:
 *
 *   L1  a package on the shelf is visible to a tenant that has not installed it
 *   L2  installing without the acknowledgement writes nothing and says why
 *   L3  a file name that is not a library name is refused as a request, not resolved as a path
 *   L4  an unsigned package is refused by name until the operator says so
 *   L5  the install lands: the row, the tables, and the flash that says "for this tenant only"
 *   L6  the other tenant has the package on its shelf and none of its schema or rows
 *   L7  a second install of one id is refused: uninstall is the only way round, as §8.2 says
 */
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import Database from 'better-sqlite3';

import { openAdminWrite } from '../app/db/classes.ts';
import { loadEnv } from '../app/env.ts';
import { buildApp, type AppHandle } from '../app/main.ts';
import { packPackage } from '../app/plugins/archive.ts';
import { packageRootHash } from '../app/plugins/manifest.ts';
import { TOTP_SECRET, codeOf, openSession, seedUser, type Sessioned } from './helpers/admin.ts';
import { REPO, makeFixture, type Fixture } from './helpers/fixture.ts';
import { call, header, type Res } from './helpers/http.ts';

const CONTACT = join(REPO, 'plugins', 'contact');
const DIGEST = 'sha256:library-gate';
const ACME_HOST = 'acme.test';
const BETA_HOST = 'beta.test';

let fixture: Fixture;
let handle: AppHandle;
let port = 0;
let acme: Sessioned;
let beta: Sessioned;
let libraryRoot = '';
let archiveName = '';

/** A report bound to the package's own root, written **outside** the package — that is the rule. */
function reportFor(packageDir: string, plugin: string, name: string): string {
  const { root } = packageRootHash(packageDir);
  const path = join(fixture.dir, name);
  writeFileSync(
    path,
    `${JSON.stringify({ plugin, version: '1.1.0', root_hash: root, runner_image_digest: DIGEST, ran_at: new Date().toISOString() }, null, 2)}\n`,
  );
  return path;
}

function urlencoded(fields: Record<string, string>): { body: string; contentType: string } {
  return {
    body: Object.entries(fields)
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
      .join('&'),
    contentType: 'application/x-www-form-urlencoded',
  };
}

/** POST the install form the way a browser with no JavaScript would: fields, csrf in the body. */
async function install(
  who: Sessioned,
  tenantKey: string,
  host: string,
  fields: Record<string, string>,
): Promise<Res> {
  const form = urlencoded({ csrf: who.csrfToken, ...fields });
  return call({
    port,
    path: `/admin/t/${tenantKey}/plugins/install`,
    method: 'POST',
    host,
    headers: { origin: `https://${host}`, 'content-type': form.contentType, cookie: who.cookie },
    body: form.body,
  });
}

function screen(who: Sessioned, tenantKey: string, host: string): Promise<Res> {
  return call({ port, path: `/admin/t/${tenantKey}/plugins`, host, headers: { cookie: who.cookie } });
}

function tables(tenantKey: string): string[] {
  const db = openAdminWrite(fixture.sitePath(tenantKey));
  try {
    return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map(
      (row) => row.name,
    );
  } finally {
    db.close();
  }
}

function installedRow(tenantKey: string, plugin: string): { version: string; enabled: number; signature_state: string } | undefined {
  const db = openAdminWrite(fixture.sitePath(tenantKey));
  try {
    return db
      .prepare('SELECT version, enabled, signature_state FROM cms_plugin_installed WHERE plugin_id = ?')
      .get(plugin) as { version: string; enabled: number; signature_state: string } | undefined;
  } finally {
    db.close();
  }
}

before(async () => {
  fixture = makeFixture({
    specs: [
      { key: 'acme', hosts: [ACME_HOST], title: 'Acme' },
      { key: 'beta', hosts: [BETA_HOST], title: 'Beta' },
    ],
  });
  await seedUser({ controlDb: fixture.controlDb, tenantKey: 'acme', email: 'owner@acme.test', totpSecret: TOTP_SECRET });
  await seedUser({ controlDb: fixture.controlDb, tenantKey: 'beta', email: 'owner@beta.test', totpSecret: TOTP_SECRET });

  // The shelf is the box's, not a tenant's: one directory under the data dir, and a package
  // placed there is what "installed on the system" means from here on.
  libraryRoot = join(fixture.env.SKW_DATA_DIR as string, 'plugin-library');
  mkdirSync(libraryRoot, { recursive: true });
  const report = reportFor(CONTACT, 'contact', 'contact-report.json');
  archiveName = 'contact-1.1.0.tar.gz';
  writeFileSync(join(libraryRoot, archiveName), packPackage(CONTACT, { reportPath: report }));

  handle = await buildApp({ env: loadEnv(fixture.env) });
  port = await handle.app
    .listen({ port: 0, host: '127.0.0.1' })
    .then(() => (handle.app.server.address() as { port: number }).port);
  // D37: the login belongs on the tenant's own host, and the CSRF origin must be that host —
  // a session opened with one tenant's origin and sent to another's host is refused by name.
  acme = await openSession({ port, key: 'acme', email: 'owner@acme.test', host: ACME_HOST, origin: `https://${ACME_HOST}` });
  beta = await openSession({ port, key: 'beta', email: 'owner@beta.test', host: BETA_HOST, origin: `https://${BETA_HOST}` });
});

after(async () => {
  await handle.close();
  fixture.cleanup();
});

test('L1. a package on the shelf is visible to a tenant that has not installed it', async () => {
  for (const [who, key, host] of [
    [acme, 'acme', ACME_HOST],
    [beta, 'beta', BETA_HOST],
  ] as const) {
    const res = await screen(who, key, host);
    assert.equal(res.status, 200, res.body);
    assert.match(res.body, /Available on this box/, 'the shelf section must be on the screen');
    assert.ok(res.body.includes(`data-library="${archiveName}"`), `the shelf must list ${archiveName}`);
    assert.match(res.body, /available/, 'not installed here is the state a new tenant starts in');
    // The install button is a form that works with JS off, and it names this tenant's path.
    assert.ok(res.body.includes(`/admin/t/${key}/plugins/install`), 'the button posts to this tenant');
    assert.ok(res.body.includes(`value="${archiveName}"`), 'the button names the file it will install');
  }
});

test('L2. installing without the acknowledgement writes nothing, and says why', async () => {
  const res = await install(acme, 'acme', ACME_HOST, { package: archiveName });
  assert.equal(res.status, 200, res.body);
  assert.match(res.body, /Not installed/);
  assert.match(res.body, /acknowledgement box/);
  assert.equal(installedRow('acme', 'contact'), undefined, 'a refused install must not write the row');
  assert.equal(tables('acme').includes('p_contact_message'), false, 'and must not create the table');
});

test('L3. a name that is not a library name is refused as a request, not resolved as a path', async () => {
  for (const name of ['../control.db', '/etc/passwd', 'contact.tar', 'CONTACT-1.1.0.tar.gz']) {
    const res = await install(acme, 'acme', ACME_HOST, { package: name, understand: '1', allow_unsigned: '1' });
    assert.equal(res.status, 400, `${name} → ${res.status} ${res.body}`);
    assert.equal(codeOf(res), 'SKW_E_PLT_REQUEST_INVALID', `${name} must be refused by name`);
  }
  assert.equal(installedRow('acme', 'contact'), undefined);
});

test('L4. an unsigned package is refused by name until the operator says so', async () => {
  const res = await install(acme, 'acme', ACME_HOST, { package: archiveName, understand: '1' });
  assert.equal(res.status, 200, res.body);
  assert.match(res.body, /SKW_E_PL_SIGNATURE/, 'the refusal names the code the CLI would have printed');
  assert.equal(installedRow('acme', 'contact'), undefined);
});

test('L5. the acknowledged install lands: a row for this tenant, its tables in its own database', async () => {
  const res = await install(acme, 'acme', ACME_HOST, { package: archiveName, understand: '1', allow_unsigned: '1' });
  assert.equal(res.status, 303, res.body);
  const location = decodeURIComponent(String(header(res, 'location')));
  assert.match(location, /installed contact@1\.1\.0 for acme only/);
  assert.match(location, /this tenant's database/);
  assert.match(location, /UNSIGNED/);
  assert.match(location, /press Enable/, 'installing is not running: enable stays a separate press');

  const row = installedRow('acme', 'contact');
  assert.equal(row?.enabled, 0, 'an install must not start anything');
  assert.equal(row?.signature_state, 'unsigned');
  assert.ok(tables('acme').includes('p_contact_message'), 'the package owns a table in this tenant database');
});

test('L6. the other tenant keeps the package on its shelf and none of its schema', async () => {
  assert.equal(installedRow('beta', 'contact'), undefined, 'beta installed nothing');
  assert.equal(tables('beta').includes('p_contact_message'), false, 'beta has no p_contact_message');
  const res = await screen(beta, 'beta', BETA_HOST);
  assert.equal(res.status, 200);
  assert.ok(res.body.includes(`data-library="${archiveName}"`), 'the shelf is the box: beta still sees it');
  assert.doesNotMatch(res.body, /data-plugin="contact"/, 'and beta has no installed row for it');
  assert.match(res.body, /available/, 'beta is still being offered it');
});

test('L7. the same bytes install idempotently; different bytes under one id are refused', async () => {
  // Same root twice is not an error: the row is the identity, so a second press changes nothing.
  const again = await install(acme, 'acme', ACME_HOST, { package: archiveName, understand: '1', allow_unsigned: '1' });
  assert.equal(again.status, 303, again.body);
  assert.equal(installedRow('acme', 'contact')?.version, '1.1.0');
  const rows = (() => {
    const db = openAdminWrite(fixture.sitePath('acme'));
    try {
      return db.prepare("SELECT count(*) AS n FROM cms_plugin_installed WHERE plugin_id = 'contact'").get() as { n: number };
    } finally {
      db.close();
    }
  })();
  assert.equal(rows.n, 1, 'one package, one row');

  // A different root under the same id is the case §8.2 refuses: two roots for one id would make
  // the installed row a lie. Uninstall is the only way round it, so the refusal has to be a refusal.
  const changed = mkdtempSync(join(fixture.dir, 'changed-'));
  cpSync(CONTACT, changed, { recursive: true });
  writeFileSync(join(changed, 'index.mjs'), `${readFileSync(join(changed, 'index.mjs'), 'utf8')}\n// a later build\n`);
  const changedReport = reportFor(changed, 'contact', 'contact-changed-report.json');
  const changedName = 'contact-1.2.0.tar.gz';
  writeFileSync(join(libraryRoot, changedName), packPackage(changed, { reportPath: changedReport }));
  const refused = await install(acme, 'acme', ACME_HOST, { package: changedName, understand: '1', allow_unsigned: '1' });
  assert.equal(refused.status, 200, refused.body);
  assert.match(refused.body, /SKW_E_PL_/, 'a refusal with a code, not a 500');
  assert.equal(installedRow('acme', 'contact')?.version, '1.1.0', 'the installed row is untouched');
});

test('L8. an unreadable archive is listed on the shelf with its error, not silently hidden', async () => {
  const broken = join(libraryRoot, 'broken-0.0.1.tar.gz');
  writeFileSync(broken, Buffer.from('not an archive at all'));
  try {
    const res = await screen(acme, 'acme', ACME_HOST);
    assert.equal(res.status, 200);
    assert.ok(res.body.includes('data-library="broken-0.0.1.tar.gz"'), 'a broken package is visible');
    assert.match(res.body, /unreadable/, 'and named as unreadable rather than shown as available');
  } finally {
    writeFileSync(broken, '');
    // Remove it so the listing assertions above stay the only ones that see it.
    const { rmSync } = await import('node:fs');
    rmSync(broken, { force: true });
  }
  assert.equal(existsSync(broken), false);
});
