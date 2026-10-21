/**
 * S3b / §9 — the admin media library: the thumbnail grid, the search, and the picker.
 *
 * The library is the one place a human chooses an asset, so the two things it must not do are
 * (a) offer a gated asset as if it had a public URL and (b) hand back a URL instead of a key.
 * Both are asserted on the rendered page, not on a helper: the picker's field is the HTML
 * input a form will submit.
 */
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import sharp from 'sharp';

import { totpCode } from '../app/admin/auth.ts';
import { uploadAsset } from '../app/assets/library.ts';
import { ensureVariants } from '../app/assets/renditions.ts';
import { openAdminWrite } from '../app/db/classes.ts';
import { loadEnv } from '../app/env.ts';
import { buildApp, type AppHandle } from '../app/main.ts';
import { ADMIN_HOST, TOTP_SECRET, login, seedUser, type Sessioned } from './helpers/admin.ts';
import { makeFixture, type Fixture } from './helpers/fixture.ts';
import { call, header, type Res } from './helpers/http.ts';

let fixture: Fixture;
let handle: AppHandle;
let port = 0;
let session: Sessioned;
let contentRoot = '';

interface MediaJson {
  tenant: string;
  q: string;
  assets: {
    key: string;
    kind: string;
    alt: string | null;
    access_class: string;
    url: string | null;
    thumb_url: string | null;
    thumb: { width: number; height: number } | null;
  }[];
}

async function png(r: number, g: number, b: number): Promise<Buffer> {
  return sharp({ create: { width: 120, height: 90, channels: 3, background: { r, g, b } } }).png().toBuffer();
}

async function upload(
  key: string,
  opts: { accessClass?: 'public' | 'gated'; alt?: string; bytes?: Buffer } = {},
): Promise<void> {
  const db = openAdminWrite(fixture.sitePath('acme'));
  try {
    const result = await uploadAsset({
      db,
      contentRoot,
      tenantKey: 'acme',
      key,
      filename: `${key.split('/').pop() ?? key}.png`,
      bytes: opts.bytes ?? (await png(30, 60, 90)),
      quotaLimitBytes: 10_000_000,
      ...(opts.accessClass === undefined ? {} : { accessClass: opts.accessClass }),
      ...(opts.alt === undefined ? {} : { altText: opts.alt }),
    });
    await ensureVariants({ db, contentRoot, assetId: result.asset.id });
  } finally {
    db.close();
  }
}

async function get(path: string): Promise<Res> {
  return call({ port, path, host: ADMIN_HOST, headers: { cookie: session.cookie } });
}

before(async () => {
  fixture = makeFixture({ specs: [{ key: 'acme', hosts: ['acme.test'], title: 'Acme' }] });
  contentRoot = join(fixture.dir, 'content');
  await seedUser({ controlDb: fixture.controlDb, tenantKey: 'acme', email: 'owner@acme.test', totpSecret: TOTP_SECRET });
  handle = await buildApp({ env: loadEnv(fixture.env) });
  port = await handle.app.listen({ port: 0, host: '127.0.0.1' }).then(() => {
    const address = handle.app.server.address();
    return typeof address === 'object' && address !== null ? address.port : 0;
  });
  const res = await login({ port, key: 'acme', email: 'owner@acme.test', totp: totpCode(TOTP_SECRET, Date.now()) });
  assert.equal(res.status, 200, res.body);
  const raw = String(header(res, 'set-cookie'));
  session = {
    cookie: raw.slice(0, raw.indexOf(';')),
    csrfToken: (res.json as { csrfToken: string }).csrfToken,
    email: 'owner@acme.test',
  };

  await upload('brand/logo', { alt: 'the acme logo' });
  await upload('hero/wide', { alt: 'a wide hero' });
  await upload('vault/paid', { accessClass: 'gated', alt: 'paid download' });
  const pdf = Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n', 'latin1');
  const db = openAdminWrite(fixture.sitePath('acme'));
  try {
    await uploadAsset({
      db,
      contentRoot,
      tenantKey: 'acme',
      key: 'docs/terms',
      filename: 'terms.pdf',
      bytes: pdf,
      quotaLimitBytes: 10_000_000,
      altText: 'terms and conditions',
    });
  } finally {
    db.close();
  }
});

after(async () => {
  await handle.close();
  fixture.cleanup();
});

function json(res: Res): MediaJson {
  assert.equal(res.status, 200, res.body);
  return res.json as MediaJson;
}

test('M1 — the grid renders a thumbnail per image, linked to the farm URL the variant row names', async () => {
  const res = await get('/admin/t/acme/media');
  assert.equal(res.status, 200, res.body);
  assert.match(String(header(res, 'content-type')), /text\/html/);
  // S7 NOTE — RE-POINTED, not deleted. Direction 03 (Guided Cards) replaced the grid's
  // markup: a tile now also carries `data-search` (the string the filter-as-you-type
  // matches) and the caption is a `figcaption.asset__body`. The contract this test exists
  // for is unchanged — the farm's key and kind, per figure, as data attributes — so the
  // assertion now pins that prefix and the attribute values rather than the old literal.
  assert.match(res.body, /<figure class="asset" data-asset-key="brand\/logo" data-kind="image" data-access="public"/);
  assert.match(res.body, /<img loading="lazy" src="\/media\/brand\/logo@thumb\.webp\?v=[0-9a-f]{8}"/);
  assert.match(res.body, /alt="the acme logo"/);
  // A document has no rendition, and the page says so instead of rendering a broken image.
  assert.match(res.body, /docs\/terms[\s\S]{0,200}no rendition|no rendition[\s\S]{0,200}docs\/terms/);
});

test('M2 — a gated asset is listed but offers no public URL, and the picker refuses it', async () => {
  const res = await get('/admin/t/acme/media');
  assert.match(res.body, /data-asset-key="vault\/paid" data-kind="image" data-access="gated"/);
  // S7 NOTE — RE-POINTED, not deleted. The design replaced the machine phrase
  // "gated — no public URL" with the Guided Cards lock panel, which states the same fact
  // in the words a site owner reads: "No preview" and "Needs a code". The property under
  // test — the page says why there is no image, instead of rendering a broken one — is the
  // one being asserted; the string it is said with is the thing the design changed.
  assert.match(res.body, /No preview/);
  assert.match(res.body, /Needs a code/);
  assert.doesNotMatch(res.body, /src="\/media\/vault\/paid/, 'the grid published a gated asset URL');

  // Picking it writes nothing: a key that renders a 404 is not a pick.
  const pick = await get('/admin/t/acme/media?pick=cover&key=vault%2Fpaid');
  assert.equal(pick.status, 200, pick.body);
  assert.doesNotMatch(pick.body, /name="cover"/, 'the picker wrote a gated key into a form field');

  // The positive control, same request shape, public asset: the field carries the key.
  const ok = await get('/admin/t/acme/media?pick=cover&key=brand%2Flogo');
  assert.equal(ok.status, 200, ok.body);
  assert.match(ok.body, /<input id="picked_value" type="text" name="cover" value="brand\/logo" readonly>/);
  assert.doesNotMatch(ok.body, /value="\/media\//, 'the picker wrote a URL rather than a key');
});

test('M3 — search matches key, filename, alt text and kind, and nothing else', async () => {
  // by key fragment
  let found = json(await get('/admin/t/acme/media.json?q=hero')).assets.map((a) => a.key);
  assert.deepEqual(found, ['hero/wide']);
  // by alt text
  found = json(await get('/admin/t/acme/media.json?q=acme%20logo')).assets.map((a) => a.key);
  assert.deepEqual(found, ['brand/logo']);
  // by kind
  found = json(await get('/admin/t/acme/media.json?q=document')).assets.map((a) => a.key);
  assert.deepEqual(found, ['docs/terms']);
  found = json(await get('/admin/t/acme/media.json?q=image')).assets.map((a) => a.key);
  assert.deepEqual(found.sort(), ['brand/logo', 'hero/wide', 'vault/paid']);
  // by filename
  found = json(await get('/admin/t/acme/media.json?q=terms.png')).assets.map((a) => a.key);
  assert.deepEqual(found, [], 'a filename search matched a different filename');
  found = json(await get('/admin/t/acme/media.json?q=terms.pdf')).assets.map((a) => a.key);
  assert.deepEqual(found, ['docs/terms']);
  // no match is zero rows, not every row
  assert.equal(json(await get('/admin/t/acme/media.json?q=zzz-nothing')).assets.length, 0);
  // A wildcard typed by a human is a character, not a wildcard.
  assert.equal(json(await get('/admin/t/acme/media.json?q=%25')).assets.length, 0);
});

test('M4 — media.json reports the farm URL for a public asset and null for a gated one', async () => {
  const body = json(await get('/admin/t/acme/media.json?q=logo'));
  const row = body.assets[0];
  assert.ok(row !== undefined);
  assert.match(String(row.url), /^\/media\/brand\/logo\.png\?v=[0-9a-f]{8}$/);
  assert.match(String(row.thumb_url), /^\/media\/brand\/logo@thumb\.webp\?v=[0-9a-f]{8}$/);
  assert.equal(row.thumb?.width, 120);

  const gated = json(await get('/admin/t/acme/media.json?q=vault')).assets[0];
  assert.equal(gated?.url, null);
  assert.equal(gated?.thumb_url, null);
});

test('M5 — the library is a read surface: no route writes, and no session means no library', async () => {
  // §9.1 / §5.3 row 7: no session on the admin host is the same 404 as no tenant here.
  const anon = await call({ port, path: '/admin/t/acme/media', host: ADMIN_HOST });
  assert.equal(anon.status, 404, anon.body);
  assert.equal((anon.json as { error?: { code?: string } }).error?.code, 'SKW_E_PLT_TENANT_UNKNOWN');

  // A POST is not a library action — the surface is GET-only, so it is refused as a bad action.
  const post = await call({
    port,
    path: '/admin/t/acme/media',
    method: 'POST',
    host: ADMIN_HOST,
    headers: { cookie: session.cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: 'key=brand/logo',
  });
  assert.equal(post.status, 400, post.body);
  const db = new Database(fixture.sitePath('acme'));
  try {
    const row = db.prepare('SELECT key FROM cms_asset ORDER BY key').all() as { key: string }[];
    assert.equal(row.length, 4, 'the library route changed the asset table');
  } finally {
    db.close();
  }
});