/**
 * The portal's own export and import doors.
 *
 * Three promises, each checked over a socket against a real `buildApp` and a real tenant database:
 *
 *   1. `GET …/export/site` hands back one `.zip` that holds the bundle the CLI would have written —
 *      `BUNDLE.json`, `data/site.db`, `EXPORT-NOTES.md`, `install.sh` — and nothing identity-bearing
 *      (`cms_account` has no rows in the bundled database).
 *   2. `GET …/export?theme=<key>` hands back a theme package the theme importer accepts.
 *   3. `POST …/themes/upload` with a multipart body stores the theme *and* adds it to the box
 *      library, so the look is available to every site — and a browser's file chooser is exactly
 *      this: `enctype="multipart/form-data"` with one file part and the CSRF field in the same body.
 *
 * The unauthenticated case is checked too: both downloads are session-gated, so the zip cannot be
 * fetched by anyone who cannot already see the screen.
 */
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { loadEnv } from '../app/env.ts';
import { buildApp, type AppHandle } from '../app/main.ts';
import { readZip } from '../app/render/zip.ts';
import { readThemePackageZip } from '../app/themes/package.ts';
import { SCHEMA, makeFixture, type Fixture } from './helpers/fixture.ts';
import { ADMIN_HOST, TOTP_SECRET, openSession, seedUser, type Sessioned } from './helpers/admin.ts';
import { call } from './helpers/http.ts';
import { zipOf } from './helpers/zip-maker.ts';

let fixture: Fixture;
let handle: AppHandle;
let port = 0;
let session: Sessioned;

const THEME_CSS = 'body{background:url("assets/hero.svg")}\n';
const HERO = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"></svg>', 'utf8');

before(async () => {
  fixture = makeFixture({ specs: [{ key: 'acme', hosts: ['acme.test'], title: 'Acme' }] });
  await seedUser({ controlDb: fixture.controlDb, tenantKey: 'acme', email: 'owner@acme.test', totpSecret: TOTP_SECRET });
  handle = await buildApp({ env: loadEnv(fixture.env), schemaDir: SCHEMA, contentRoot: join(fixture.dir, 'content') });
  await handle.app.listen({ port: 0, host: '127.0.0.1' });
  const address = handle.app.server.address();
  port = typeof address === 'object' && address !== null ? address.port : 0;
  session = await openSession({ port, key: 'acme', email: 'owner@acme.test' });

  // A real theme on the tenant, with one asset: the export must carry both files.
  const db = new Database(fixture.sitePath('acme'));
  try {
    db.pragma('foreign_keys = ON');
    const cssSha = createHash('sha256').update(THEME_CSS).digest('hex');
    const heroSha = createHash('sha256').update(HERO).digest('hex');
    db.prepare('INSERT INTO cms_css_blob (sha256, css, bytes) VALUES (?, ?, ?)').run(
      cssSha,
      THEME_CSS,
      Buffer.byteLength(THEME_CSS),
    );
    const themeId = Number(
      db
        .prepare("INSERT INTO cms_theme (theme_key, name, css_sha256) VALUES ('acme-kit', 'Acme kit', ?)")
        .run(cssSha).lastInsertRowid,
    );
    db.prepare(
      'INSERT INTO cms_theme_asset (theme_id, path, sha256, bytes, content_type) VALUES (?, ?, ?, ?, ?)',
    ).run(themeId, 'assets/hero.svg', heroSha, HERO.length, 'image/svg+xml');
  } finally {
    db.close();
  }
  const assetsDir = join(fixture.dir, 'tenants', 'acme', 'theme-assets', 'acme-kit', 'assets');
  await import('node:fs').then(({ mkdirSync, writeFileSync }) => {
    mkdirSync(assetsDir, { recursive: true });
    writeFileSync(join(assetsDir, 'hero.svg'), HERO);
  });
});

after(async () => {
  if (handle !== undefined) await handle.close();
});

test('P1 — the site download is one zip holding the bundle, with no identity rows in its database', async () => {
  const res = await call({
    port,
    method: 'GET',
    path: '/admin/t/acme/export/site',
    host: ADMIN_HOST,
    headers: { cookie: session.cookie },
  });
  assert.equal(res.status, 200, res.body.slice(0, 200));
  assert.match(String(res.headers['content-type']), /application\/zip/);
  assert.match(String(res.headers['content-disposition']), /attachment; filename="acme-site-\d{4}-\d{2}-\d{2}\.zip"/);

  const bytes = res.bytes;
  assert.ok(bytes !== undefined, 'the helper returned no raw bytes');
  assert.equal(bytes.subarray(0, 2).toString('latin1'), 'PK', 'not a zip');
  const entries = readZip(bytes);
  const paths = entries.map((entry) => entry.path);
  for (const required of ['BUNDLE.json', 'EXPORT-NOTES.md', 'data/site.db', 'install.sh', 'schema/site.sql']) {
    assert.ok(paths.includes(required), `the bundle is missing ${required}`);
  }
  const manifest = JSON.parse(entries.find((entry) => entry.path === 'BUNDLE.json')?.bytes.toString('utf8') ?? '{}') as {
    schema?: string;
    files?: { path: string; sha256: string }[];
  };
  assert.equal(manifest.schema, 'skunkworks/site-bundle/v3');
  assert.ok((manifest.files ?? []).length > 10, 'the manifest lists almost nothing');

  // The bundled database is the projection: the people are not in it.
  const dbBytes = entries.find((entry) => entry.path === 'data/site.db')?.bytes;
  assert.ok(dbBytes !== undefined);
  // eslint-disable-next-line no-restricted-syntax -- a test may read the bundle it just received
  const { writeFileSync } = await import('node:fs');
  const probe = mkdtempSync(join(tmpdir(), 'skw-portal-export-'));
  const probePath = join(probe, 'site.db');
  writeFileSync(probePath, dbBytes);
  const db = new Database(probePath, { readonly: true });
  try {
    for (const table of ['cms_account', 'cms_account_role', 'cms_profile', 'cms_mail']) {
      const count = (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
      assert.equal(count, 0, `${table} shipped rows in a site bundle`);
    }
  } finally {
    db.close();
  }
});

test('P2 — a theme downloads as a package the importer accepts', async () => {
  const res = await call({
    port,
    method: 'GET',
    path: '/admin/t/acme/export/theme?theme=acme-kit',
    host: ADMIN_HOST,
    headers: { cookie: session.cookie },
  });
  assert.equal(res.status, 200, res.body.slice(0, 200));
  assert.match(String(res.headers['content-type']), /application\/zip/);
  const pkg = readThemePackageZip(res.bytes ?? Buffer.alloc(0));
  assert.equal(pkg.manifest.key, 'acme-kit');
  assert.equal(pkg.manifest.name, 'Acme kit');
  assert.deepEqual(
    pkg.assets.map((asset) => asset.path),
    ['assets/hero.svg'],
  );
  assert.equal(pkg.css, THEME_CSS);
});

test('P3 — both downloads are session-gated', async () => {
  for (const path of ['/admin/t/acme/export/site', '/admin/t/acme/export/theme?theme=acme-kit']) {
    const res = await call({ port, method: 'GET', path, host: ADMIN_HOST });
    assert.ok(res.status === 302 || res.status === 303 || res.status === 404, `${path} answered ${res.status} without a session`);
    assert.equal((res.bytes ?? Buffer.alloc(0)).subarray(0, 2).toString('latin1') === 'PK', false, `${path} served a zip to nobody`);
  }
});

test('P4 — the upload door takes a multipart file and adds it to the box library', async () => {
  const pkg = zipOf([
    { name: 'theme.json', bytes: Buffer.from('{"schema":"skunkworks/theme/v1"}', 'utf8') },
    { name: 'theme.css', bytes: Buffer.from('h1{color:#123}\n', 'utf8') },
  ]);
  // A browser sends this shape: one file part and the CSRF field, in one body.
  const boundary = '----skwportal';
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="csrf"\r\n\r\n${session.csrfToken}\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\nPortal kit\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="portal-kit.zip"\r\n` +
        'Content-Type: application/zip\r\n\r\n',
      'utf8',
    ),
    pkg,
    Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
  ]);
  const res = await call({
    port,
    method: 'POST',
    path: '/admin/t/acme/themes/upload',
    host: ADMIN_HOST,
    headers: {
      cookie: session.cookie,
      origin: 'https://acme.test',
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'content-length': String(body.length),
    },
    body,
  });
  assert.ok(res.status === 303 || res.status === 200, `upload answered ${res.status}: ${res.body.slice(0, 200)}`);

  const db = new Database(fixture.sitePath('acme'), { readonly: true });
  try {
    const row = db.prepare("SELECT theme_key, name FROM cms_theme WHERE name = 'Portal kit'").get() as
      | { theme_key: string; name: string }
      | undefined;
    assert.ok(row !== undefined, 'the upload did not create a theme row');
    assert.ok(
      existsSync(join(fixture.env.SKW_DATA_DIR ?? fixture.dir, 'themes', row.theme_key, 'theme.json')),
      'the upload did not reach the box library',
    );
  } finally {
    db.close();
  }
});
