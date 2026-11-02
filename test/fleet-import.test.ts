/**
 * The fleet's import door: a bundle uploaded through a browser's file chooser becomes a tenant.
 *
 * This is the portal half of `skwctl site import`. The interesting part is not the import itself
 * (that is proved in `test/site-import.test.ts`); it is that the door is a *fleet* door — one
 * tenant's owner cannot create another tenant — that the CSRF field travels in the same multipart
 * body as the file, and that a refusal lands as a page rather than as a half-created tenant.
 *
 * Two boxes, because that is the real shape: the bundle is cut from one fixture and imported into
 * another, which is exactly what "move this site to my other server" means.
 */
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { existsSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { openAdminWrite } from '../app/db/classes.ts';
import { loadEnv } from '../app/env.ts';
import { buildArchive } from '../app/export/archive.ts';
import { runExport } from '../app/export/index.ts';
import { buildApp, type AppHandle } from '../app/main.ts';
import { ADMIN_HOST, TOTP_SECRET, openSession, seedUser, type Sessioned } from './helpers/admin.ts';
import { REPO, SCHEMA, makeFixture, type Fixture } from './helpers/fixture.ts';
import { call } from './helpers/http.ts';
import type { TreeFile } from '../app/export/tree.ts';

const NOW = '2026-10-29T00:00:00.000Z';

let source: Fixture;
let fleetBox: Fixture;
let handle: AppHandle;
let port = 0;
let fleet: Sessioned;
let owner: Sessioned;
let bundle: Buffer;

async function listenApp(app: AppHandle): Promise<number> {
  await app.app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.app.server.address();
  return typeof address === 'object' && address !== null ? address.port : 0;
}

function zipTree(root: string): Buffer {
  const files: TreeFile[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const path = full.slice(root.length + 1).split('\\').join('/');
      if (entry.isSymbolicLink()) files.push({ path, symlink: readlinkSync(full) });
      else if (entry.isDirectory()) walk(full);
      else files.push({ path, bytes: readFileSync(full) });
    }
  };
  walk(root);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return buildArchive('zip', files, Date.parse(NOW));
}

before(async () => {
  // The box the bundle comes from.
  source = makeFixture({ specs: [{ key: 'source', hosts: ['source.test'], title: 'Source' }] });
  const out = join(source.dir, 'cut', 'source');
  const db = openAdminWrite(source.sitePath('source'));
  const result = runExport({
    target: 'cms',
    db,
    tenantKey: 'source',
    out,
    exportNow: NOW,
    contentRoot: join(source.dir, 'content'),
    repoRoot: REPO,
    tmpDir: source.dir,
    tenant: {
      key: 'source',
      mode: 'production',
      status: 'active',
      displayName: 'Acme',
      dbVersion: 3,
      hosts: [{ host: 'source.test', kind: 'primary', isPrimary: 1, certState: 'issued' }],
    },
  });
  db.close();
  assert.equal(result.ok, true, result.ok ? '' : JSON.stringify(result.refusals));
  bundle = zipTree(out);

  // The box it is imported into, with a fleet operator and one tenant owner.
  // The default specs matter: the admin login lives on `acme.test`, which the fixture maps.
  fleetBox = makeFixture();
  await seedUser({
    controlDb: fleetBox.controlDb,
    tenantKey: null,
    email: 'fleet@acme.test',
    role: 'fleet_admin',
    totpSecret: TOTP_SECRET,
  });
  await seedUser({
    controlDb: fleetBox.controlDb,
    tenantKey: 'acme',
    email: 'owner@acme.test',
    totpSecret: TOTP_SECRET,
  });
  handle = await buildApp({
    env: loadEnv({ ...fleetBox.env, SKW_FLEET_MODE: '1' }),
    schemaDir: SCHEMA,
    contentRoot: join(fleetBox.dir, 'content'),
  });
  port = await listenApp(handle);
  fleet = await openSession({ port, email: 'fleet@acme.test' });
  owner = await openSession({ port, key: 'acme', email: 'owner@acme.test' });
});

after(async () => {
  if (handle !== undefined) await handle.close();
});

function multipart(fields: Record<string, string>, file: { name: string; bytes: Buffer } | null): { body: Buffer; boundary: string } {
  const boundary = '----skwfleet';
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`, 'utf8'));
  }
  if (file !== null) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: application/zip\r\n\r\n`,
        'utf8',
      ),
      file.bytes,
      Buffer.from('\r\n', 'utf8'),
    );
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return { body: Buffer.concat(parts), boundary };
}

async function upload(session: Sessioned, fields: Record<string, string>, bytes: Buffer = bundle, csrf = true) {
  const { body, boundary } = multipart({ ...(csrf ? { csrf: session.csrfToken } : {}), ...fields }, { name: 'bundle.zip', bytes });
  return call({
    port,
    method: 'POST',
    path: '/fleet/import',
    host: ADMIN_HOST,
    headers: {
      cookie: session.cookie,
      origin: 'https://acme.test',
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'content-length': String(body.length),
    },
    body,
  });
}

test('F1 — a fleet operator imports a bundle and the tenant appears with its host', async () => {
  const res = await upload(fleet, { tenant: 'imported', hosts: 'imported.test' });
  assert.equal(res.status, 200, res.body.slice(0, 400));
  assert.match(res.body, /Imported <code>imported<\/code>/);
  assert.match(res.body, /imported\.test<\/code> — primary/);

  const control = new Database(fleetBox.controlDb, { readonly: true });
  try {
    const tenant = control.prepare("SELECT key, mode, status, display_name FROM tenant WHERE key = 'imported'").get() as
      | { key: string; mode: string; status: string; display_name: string }
      | undefined;
    assert.ok(tenant !== undefined, 'no tenant row');
    assert.equal(tenant.mode, 'production');
    assert.equal(tenant.status, 'active');
    assert.equal(tenant.display_name, 'Acme');
    const hosts = control
      .prepare("SELECT host, is_primary FROM domain WHERE tenant_id = (SELECT id FROM tenant WHERE key = 'imported')")
      .all() as { host: string; is_primary: number }[];
    assert.deepEqual(hosts, [{ host: 'imported.test', is_primary: 1 }]);
  } finally {
    control.close();
  }

  const siteDb = join(fleetBox.dir, 'tenants', 'imported', 'site.db');
  assert.ok(existsSync(siteDb), 'no site.db');
  const db = new Database(siteDb, { readonly: true });
  try {
    const pages = (db.prepare('SELECT COUNT(*) AS n FROM cms_page').get() as { n: number }).n;
    assert.equal(pages, 1, 'the imported site has the wrong page count');
  } finally {
    db.close();
  }
});

test('F2 — a tenant owner cannot reach the fleet door at all', async () => {
  const res = await upload(owner, { tenant: 'sneaky', hosts: 'sneaky.test' });
  assert.ok(res.status !== 200 || !/Imported/.test(res.body), `an owner reached the fleet import door: ${res.status}`);
  const control = new Database(fleetBox.controlDb, { readonly: true });
  try {
    assert.equal(control.prepare("SELECT 1 FROM tenant WHERE key = 'sneaky'").get(), undefined, 'an owner created a tenant');
  } finally {
    control.close();
  }
});

test('F3 — the CSRF field is required, in the same body as the file', async () => {
  const res = await upload(fleet, { tenant: 'nocsrf', hosts: 'nocsrf.test' }, bundle, false);
  assert.notEqual(res.status, 200, 'a POST without a CSRF field was accepted');
  const control = new Database(fleetBox.controlDb, { readonly: true });
  try {
    assert.equal(control.prepare("SELECT 1 FROM tenant WHERE key = 'nocsrf'").get(), undefined);
  } finally {
    control.close();
  }
});

test('F4 — a tampered bundle is refused and leaves no tenant behind', async () => {
  const mutated = Buffer.from(bundle);
  const at = Math.floor(mutated.length / 2);
  mutated[at] = (mutated[at] ?? 0) ^ 0xff;
  const res = await upload(fleet, { tenant: 'tampered', hosts: 'tampered.test' }, mutated);
  assert.notEqual(res.status, 200, 'a tampered bundle was accepted');
  const control = new Database(fleetBox.controlDb, { readonly: true });
  try {
    assert.equal(control.prepare("SELECT 1 FROM tenant WHERE key = 'tampered'").get(), undefined);
  } finally {
    control.close();
  }
  assert.equal(existsSync(join(fleetBox.dir, 'tenants', 'tampered')), false, 'a refused import wrote files');
});
