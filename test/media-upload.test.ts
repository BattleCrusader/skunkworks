/**
 * S8c — the upload surface for photos and files.
 *
 * The media screen was honest about the gap: "This is the library, not an uploader". Every
 * piece below the screen already existed — `uploadAsset` sniffs the bytes, refuses a lying
 * content type, dedupes by sha256, enforces the tenant quota, writes `cms_asset`, and refuses
 * to let one key hold two different files. What was missing was an HTTP door and a form.
 *
 * These tests drive the real route over a socket with a real multipart body, then look at the
 * disk: the bytes are stored content-addressed, the library lists the file, and the refusals
 * refuse rather than half-write.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import Database from 'better-sqlite3';
import sharp from 'sharp';

import { openAdminWrite } from '../app/db/classes.ts';
import { loadEnv } from '../app/env.ts';
import { buildApp, type AppHandle } from '../app/main.ts';
import { ADMIN_HOST, ADMIN_ORIGIN, TOTP_SECRET, openSession, seedUser, type Sessioned } from './helpers/admin.ts';
import { makeFixture, type Fixture } from './helpers/fixture.ts';
import { call, header, type Res } from './helpers/http.ts';

let fixture: Fixture;
let handle: AppHandle;
let port = 0;
let session: Sessioned;
let contentRoot = '';

/** A real multipart body: one file part plus the text fields a no-JS form posts. */
function multipart(fields: Record<string, string>, file: { name: string; type: string; bytes: Buffer }): { body: Buffer; contentType: string } {
  const boundary = '----skwtest' + Math.random().toString(16).slice(2);
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  chunks.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`,
    ),
  );
  chunks.push(file.bytes);
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

async function png(): Promise<Buffer> {
  return sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 10, g: 90, b: 160 } } }).png().toBuffer();
}

async function upload(
  fields: Record<string, string>,
  file: { name: string; type: string; bytes: Buffer },
  opts: { csrf?: string | null; cookie?: string } = {},
): Promise<Res> {
  const { body, contentType } = multipart(fields, file);
  const headers: Record<string, string> = {
    origin: ADMIN_ORIGIN,
    'content-type': contentType,
    cookie: opts.cookie ?? session.cookie,
  };
  if (opts.csrf !== null) headers['x-csrf-token'] = opts.csrf ?? session.csrfToken;
  return call({ port, path: '/admin/t/acme/media/upload', method: 'POST', host: ADMIN_HOST, headers, body });
}

function siteDb(): Database.Database {
  return openAdminWrite(fixture.sitePath('acme'));
}

function assetRow(key: string): { sha256: string; bytes: number; mime: string; kind: string; access_class: string; storage_path: string } | undefined {
  const db = siteDb();
  try {
    return db
      .prepare('SELECT sha256, bytes, mime, kind, access_class, storage_path FROM cms_asset WHERE key = ?')
      .get(key) as { sha256: string; bytes: number; mime: string; kind: string; access_class: string; storage_path: string } | undefined;
  } finally {
    db.close();
  }
}

before(async () => {
  fixture = makeFixture({ specs: [{ key: 'acme', hosts: [ADMIN_HOST], title: 'Acme' }] });
  contentRoot = join(fixture.dir, 'content');
  await seedUser({ controlDb: fixture.controlDb, tenantKey: 'acme', email: 'owner@acme.test', totpSecret: TOTP_SECRET });
  // The content root is a build option, not a fixture default: without it the app falls back to
  // /srv/content and every write lands outside the test's temporary directory.
  handle = await buildApp({ env: loadEnv(fixture.env), contentRoot });
  port = await handle.app
    .listen({ port: 0, host: '127.0.0.1' })
    .then(() => (handle.app.server.address() as { port: number }).port);
  session = await openSession({ port, key: 'acme', email: 'owner@acme.test' });
});

after(async () => {
  await handle.close();
  fixture.cleanup();
});

test('S8c-1. a photo uploaded through the form is stored, indexed, and listed', async () => {
  const bytes = await png();
  const res = await upload({ key: 'hero/sunrise', alt: 'A sunrise', access: 'public' }, { name: 'sunrise.png', type: 'image/png', bytes });
  assert.equal(res.status, 303, res.body);
  assert.match(String(header(res, 'location')), /\/admin\/t\/acme\/media\?uploaded=hero(%2F|\/)sunrise/);

  const row = assetRow('hero/sunrise');
  assert.ok(row !== undefined, 'the asset row must exist');
  assert.equal(row.kind, 'image');
  assert.equal(row.mime, 'image/png');
  // NOT `bytes.length`: `sniffAndNormalise` re-encodes a raster image through sharp, which is
  // how EXIF (a camera's GPS coordinates, most of the time) never reaches a public URL. What
  // must be true is that the row describes the file that was actually stored.
  assert.ok(row.bytes > 0, 'the stored size must be recorded');
  assert.equal(row.access_class, 'public');

  // Content-addressed on disk, not under the key: the key is an identity, the sha is an address.
  const hh = row.sha256.slice(0, 2);
  assert.equal(row.storage_path, `content/media/${hh}/${row.sha256}.png`);
  const onDisk = join(fixture.dir, row.storage_path);
  assert.equal(existsSync(onDisk), true, `missing stored bytes at ${onDisk}`);
  assert.equal(readFileSync(onDisk).length, row.bytes, 'the row and the file on disk must agree');

  // The public farm entry exists, so the file has a URL a page can use.
  assert.equal(existsSync(join(contentRoot, 'public', 'hero', 'sunrise.png')), true, 'no farm entry under content/public');

  const page = await call({ port, path: '/admin/t/acme/media', host: ADMIN_HOST, headers: { cookie: session.cookie } });
  assert.equal(page.status, 200, page.body);
  assert.match(page.body, /data-asset-key="hero\/sunrise"/);
});

test('S8c-2. the same bytes under the same key are reused, not duplicated', async () => {
  const bytes = await png();
  const first = await upload({ key: 'hero/twice', access: 'public' }, { name: 'twice.png', type: 'image/png', bytes });
  assert.equal(first.status, 303, first.body);
  const before = assetRow('hero/twice');
  const again = await upload({ key: 'hero/twice', access: 'public' }, { name: 'twice.png', type: 'image/png', bytes });
  assert.equal(again.status, 303, again.body);
  const after = assetRow('hero/twice');
  assert.deepEqual(after, before, 'a re-upload of identical bytes changes nothing');
});

test('S8c-3. a key that already holds other bytes is refused rather than overwritten', async () => {
  // A key is an identity: pages, links and download codes point at it. Silently swapping the
  // bytes behind one is how a live page starts showing a different picture.
  const other = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 200, g: 0, b: 0 } } }).png().toBuffer();
  const res = await upload({ key: 'hero/twice', access: 'public' }, { name: 'other.png', type: 'image/png', bytes: other });
  assert.equal(res.status, 409, res.body);
  assert.equal((res.json as { error?: { code?: string } }).error?.code, 'SKW_E_DM_COLUMN_IMMUTABLE');
  assert.equal(assetRow('hero/twice')?.bytes !== other.length, true, 'the stored row must be untouched');
});

test('S8c-4. a file whose bytes are not what its type claims is refused by the sniffer', async () => {
  const res = await upload(
    { key: 'evil/pretend', access: 'public' },
    { name: 'pretend.png', type: 'image/png', bytes: Buffer.from('<svg onload="alert(1)"></svg>', 'utf8') },
  );
  assert.equal(res.status, 415, res.body);
  assert.equal((res.json as { error?: { code?: string } }).error?.code, 'SKW_E_SEC_UPLOAD_REJECTED');
  assert.equal(assetRow('evil/pretend'), undefined, 'a refused upload writes nothing');
});

test('S8c-5. an upload with no CSRF token is refused before a byte reaches the disk', async () => {
  const bytes = await png();
  const res = await upload({ key: 'hero/nocsrf', access: 'public' }, { name: 'x.png', type: 'image/png', bytes }, { csrf: null });
  assert.equal(res.status, 403, res.body);
  assert.equal(assetRow('hero/nocsrf'), undefined);
});

test('S8c-6. a key that is not a key is refused', async () => {
  const bytes = await png();
  const res = await upload({ key: '../escape', access: 'public' }, { name: 'x.png', type: 'image/png', bytes });
  assert.ok(res.status === 400 || res.status === 422, `answered ${res.status}: ${res.body}`);
  assert.equal((res.json as { error?: { code?: string } }).error?.code !== undefined, true, 'a code, not a stack trace');
});

test('S8c-7. a gated upload is private: no public farm entry, and the library says so', async () => {
  const bytes = await sharp({ create: { width: 40, height: 40, channels: 3, background: { r: 0, g: 0, b: 0 } } })
    .png()
    .toBuffer();
  const res = await upload({ key: 'vault/secret', access: 'gated' }, { name: 'secret.png', type: 'image/png', bytes });
  assert.equal(res.status, 303, res.body);
  assert.equal(assetRow('vault/secret')?.access_class, 'gated');
  assert.equal(existsSync(join(contentRoot, 'public', 'vault', 'secret.png')), false, 'a gated file must have no public address');
});
