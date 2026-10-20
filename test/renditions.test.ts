/**
 * S3b / §7.1 / §7.3 — renditions and `site.asset()`.
 *
 * The properties, each asserted against the database or the bytes rather than against a
 * constant in this file:
 *
 *   R1  the same image uploaded twice produces **identical rendition bytes**, and the sha in
 *       `cms_asset_variant` is the sha256 of the file the row names
 *   R2  regeneration is deterministic — a second derive writes nothing new and changes no row
 *   R3  `srcset` contains exactly the labels and widths the variant rows hold (compared to the
 *       DB, because a hard-coded table would drift from the pixels)
 *   R4  `?v=` changes when the bytes change and does **not** change when only the key is renamed
 *   R5  a gated asset resolves to `url: null` — there is no public URL to hand a template
 *   R6  a small image is not upscaled; the recorded width is the width the encoder produced
 */
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import sharp from 'sharp';

import { deleteAsset, renameAsset, uploadAsset } from '../app/assets/library.ts';
import { ensureVariants, planVariants, variantsForAsset, LABELS, FORMATS } from '../app/assets/renditions.ts';
import { siteAsset } from '../app/assets/url.ts';
import { openAdminWrite } from '../app/db/classes.ts';
import { createRenderData } from '../app/render/data.ts';
import { makeFixture, type Fixture } from './helpers/fixture.ts';

let fixture: Fixture;
let file: string;
let contentRoot: string;

before(() => {
  fixture = makeFixture({ specs: [{ key: 'acme', hosts: ['acme.test'], title: 'Acme' }] });
  file = fixture.sitePath('acme');
  contentRoot = join(fixture.dir, 'content');
});

after(() => fixture.cleanup());

function db(): Database.Database {
  return openAdminWrite(file);
}

const PUBLIC = 10_000_000;

/** A real photograph-like image: a gradient, so the encoders have something to compress. */
async function gradient(width = 900, height = 600): Promise<Buffer> {
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 3;
      pixels[i] = (x * 255) / width;
      pixels[i + 1] = (y * 255) / height;
      pixels[i + 2] = ((x + y) * 255) / (width + height);
    }
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
}

async function upload(key: string, bytes: Buffer, accessClass: 'public' | 'gated' = 'public'): Promise<number> {
  const database = db();
  try {
    const result = await uploadAsset({
      db: database,
      contentRoot,
      tenantKey: 'acme',
      key,
      filename: `${key.split('/').pop() ?? key}.jpg`,
      bytes,
      quotaLimitBytes: PUBLIC,
      accessClass,
      altText: `alt for ${key}`,
    });
    return result.asset.id;
  } finally {
    database.close();
  }
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// --- R1 ----------------------------------------------------------------------------------

test('R1 — the same image uploaded twice yields identical rendition bytes, and each sha is the file', async () => {
  const bytes = await gradient();
  const first = await upload('photo/one', bytes);
  const second = await upload('photo/two', bytes);

  const database = db();
  let a: ReturnType<typeof variantsForAsset> = [];
  let b: ReturnType<typeof variantsForAsset> = [];
  try {
    a = await ensureVariants({ db: database, contentRoot, assetId: first });
    b = await ensureVariants({ db: database, contentRoot, assetId: second });
  } finally {
    database.close();
  }

  assert.equal(a.length, LABELS.length * FORMATS.length, 'one row per (label, format)');
  assert.deepEqual(
    a.map((v) => `${v.label}/${v.format}:${v.sha256}:${v.width}x${v.height}`),
    b.map((v) => `${v.label}/${v.format}:${v.sha256}:${v.width}x${v.height}`),
    'two assets over the same bytes produced different renditions',
  );

  // The row is the file: sha256(bytes on disk) === row.sha256, and the path is where it is.
  for (const variant of a) {
    const onDisk = readFileSync(join(contentRoot, variant.storage_path.replace(/^content\//, '')));
    assert.equal(onDisk.length, variant.bytes, `${variant.label}/${variant.format} byte count disagrees with the row`);
    assert.equal(sha256(onDisk), variant.sha256, `${variant.label}/${variant.format} sha disagrees with the row`);
    const meta = await sharp(onDisk).metadata();
    assert.equal(meta.width, variant.width);
    assert.equal(meta.height, variant.height);
  }
  // Dedupe: the path is a function of the sha, and two assets over one image share every
  // path. (Not every *row* has a distinct path — at this source size `lg` and `og` encode the
  // same pixels and are legitimately one blob; that is D13 working, not a collision.)
  const pathOf = (v: { sha256: string; format: string }): string =>
    `content/media/${v.sha256.slice(0, 2)}/${v.sha256}.${v.format}`;
  for (const variant of a) assert.equal(variant.storage_path, pathOf(variant));
  assert.deepEqual(
    [...new Set(a.map((v) => v.storage_path))].sort(),
    [...new Set(b.map((v) => v.storage_path))].sort(),
    'the two assets did not share their rendition blobs',
  );
});

// --- R2 ----------------------------------------------------------------------------------

test('R2 — regeneration is deterministic: a second derive changes neither bytes nor rows', async () => {
  const bytes = await gradient(320, 240);
  const id = await upload('photo/three', bytes);
  const database = db();
  try {
    const first = await ensureVariants({ db: database, contentRoot, assetId: id });
    const second = await ensureVariants({ db: database, contentRoot, assetId: id });
    assert.deepEqual(second, first, 'the second derive produced different rows');
    // And the encoder itself: planning twice from the same bytes is byte-identical.
    const stored = readFileSync(join(contentRoot, first[0]?.storage_path.replace(/^content\//, '') ?? ''));
    assert.ok(stored.length > 0);
    const planA = await planVariants(stored);
    const planB = await planVariants(stored);
    assert.deepEqual(
      planA.map((v) => v.sha256),
      planB.map((v) => v.sha256),
    );
  } finally {
    database.close();
  }
});

// --- R3 ----------------------------------------------------------------------------------

test('R3 — srcset carries the labels and widths the variant rows hold, not a constant table', async () => {
  const bytes = await gradient(1600, 1000);
  const id = await upload('hero/wide', bytes);
  const database = db();
  let variants: ReturnType<typeof variantsForAsset> = [];
  let site: ReturnType<typeof siteAsset>;
  try {
    variants = await ensureVariants({ db: database, contentRoot, assetId: id });
    site = siteAsset(database, 'hero/wide');
  } finally {
    database.close();
  }

  const candidates = site.srcset.split(', ').filter((s) => s !== '');
  assert.equal(candidates.length, variants.length, 'srcset has a different number of candidates than there are rows');
  for (const candidate of candidates) {
    const match = /^(\/media\/(.+)\?v=([0-9a-f]{8})) (\d+)w$/.exec(candidate);
    assert.ok(match !== null, `not a srcset candidate: ${candidate}`);
    const [, , link, version, width] = match as unknown as [string, string, string, string, string];
    const row = variants.find((v) => link === `hero/wide@${v.label}.${v.format}`);
    assert.ok(row !== undefined, `no variant row for ${link}`);
    assert.equal(Number(width), row.width, `${link} advertises ${width}w, the row says ${row.width}`);
    assert.equal(version, row.sha256.slice(0, 8), `${link} has a stale ?v=`);
  }
  // Ascending width, which is what a browser wants and what a sorted map gives.
  const widths = candidates.map((c) => Number(/ (\d+)w$/.exec(c)?.[1] ?? '0'));
  assert.deepEqual(widths, [...widths].sort((x, y) => x - y));
  // A real image at 1600px produces the three "inside" widths and the og crop.
  assert.deepEqual(
    [...new Set(widths)].sort((x, y) => x - y),
    [320, 768, 1200, 1280],
    'the labels in the rows are not the labels site.asset advertised',
  );
});

// --- R4 ----------------------------------------------------------------------------------

test('R4 — ?v= changes when the bytes change, and survives a rename unchanged', async () => {
  const one = await upload('card/a', await gradient(400, 300));
  const dbA = db();
  let before: ReturnType<typeof siteAsset>;
  try {
    await ensureVariants({ db: dbA, contentRoot, assetId: one });
    before = siteAsset(dbA, 'card/a');
  } finally {
    dbA.close();
  }
  assert.match(String(before.url), /^\/media\/card\/a\.jpg\?v=[0-9a-f]{8}$/);

  // Rename: the URL's key changes, its `?v=` does not — the checksum is the address and the
  // key is identity (§7.3). This is the assertion that a URL is derived, not stored.
  const dbB = db();
  try {
    renameAsset(dbB, { from: 'card/a', to: 'card/b', contentRoot });
    const after = siteAsset(dbB, 'card/b');
    assert.match(String(after.url), /^\/media\/card\/b\.jpg\?v=[0-9a-f]{8}$/);
    assert.equal(String(after.url).split('?v=')[1], String(before.url).split('?v=')[1], 'a rename changed the version');
    // The old key still resolves — through the alias — and to the new URL.
    const throughAlias = siteAsset(dbB, 'card/a');
    assert.equal(throughAlias.url, after.url);
  } finally {
    dbB.close();
  }

  // Different bytes under a different key: a different version.
  const two = await upload('card/c', await gradient(400, 301));
  const dbC = db();
  try {
    await ensureVariants({ db: dbC, contentRoot, assetId: two });
    const other = siteAsset(dbC, 'card/c');
    assert.notEqual(String(other.url).split('?v=')[1], String(before.url).split('?v=')[1]);
  } finally {
    dbC.close();
  }
});

// --- R5 ----------------------------------------------------------------------------------

test('R5 — a gated asset resolves to url: null and an empty srcset', async () => {
  const bytes = await gradient(200, 200);
  const id = await upload('vault/secret', bytes, 'gated');
  const database = db();
  try {
    await ensureVariants({ db: database, contentRoot, assetId: id });
    const site = siteAsset(database, 'vault/secret');
    assert.equal(site.url, null, 'a gated asset must not have a public URL');
    assert.equal(site.srcset, '');
    assert.equal(site.width, 200);
    assert.equal(site.alt, 'alt for vault/secret');
  } finally {
    database.close();
  }
});

// --- R6 ----------------------------------------------------------------------------------

test('R6 — a small image is not upscaled; the recorded width is the width produced', async () => {
  const id = await upload('icon/small', await gradient(200, 120));
  const database = db();
  let variants: ReturnType<typeof variantsForAsset> = [];
  try {
    variants = await ensureVariants({ db: database, contentRoot, assetId: id });
  } finally {
    database.close();
  }
  const byLabel = new Map(variants.map((v) => [`${v.label}/${v.format}`, v]));
  for (const label of ['thumb', 'md', 'lg'] as const) {
    const row = byLabel.get(`${label}/webp`);
    assert.ok(row !== undefined);
    assert.equal(row.width, 200, `${label} was upscaled to ${row.width}`);
    assert.equal(row.height, 120);
  }
  // ...and `og` crops to the card ratio rather than stretching a 200px source.
  const og = byLabel.get('og/webp');
  assert.ok(og !== undefined);
  assert.equal(og.width, 200);
  assert.equal(og.height, 120);
});

// --- the render accessor ---------------------------------------------------------------

test('R7 — data.asset() is the same resolver the render path hands a template', async () => {
  const id = await upload('rendered/one', await gradient(640, 480));
  const database = db();
  try {
    await ensureVariants({ db: database, contentRoot, assetId: id });
    const data = createRenderData(database, { tenantKey: 'acme' });
    const asset = data.asset('rendered/one');
    assert.equal(asset.url, `/media/rendered/one.jpg?v=${(database.prepare('SELECT sha256 FROM cms_asset WHERE id = ?').get(id) as { sha256: string }).sha256.slice(0, 8)}`);
    assert.ok(asset.srcset.includes('/media/rendered/one@thumb.webp'));
    // The surface has exactly two methods and no handle.
    assert.deepEqual(Object.keys(data).sort(), ['asset', 'source']);
    assert.equal((data as unknown as { db?: unknown }).db, undefined);
  } finally {
    database.close();
  }
});

test('R8 — a document has no renditions and a url with no srcset', async () => {
  const pdf = Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n', 'latin1');
  const database = db();
  let site: ReturnType<typeof siteAsset>;
  let variants: ReturnType<typeof variantsForAsset>;
  try {
    const result = await uploadAsset({
      db: database,
      contentRoot,
      tenantKey: 'acme',
      key: 'docs/terms',
      filename: 'terms.pdf',
      bytes: pdf,
      quotaLimitBytes: PUBLIC,
    });
    variants = await ensureVariants({ db: database, contentRoot, assetId: result.asset.id });
    site = siteAsset(database, 'docs/terms');
  } finally {
    database.close();
  }
  assert.deepEqual(variants, []);
  assert.match(String(site.url), /^\/media\/docs\/terms\.pdf\?v=[0-9a-f]{8}$/);
  assert.equal(site.srcset, '');
  // Cleanup keeps this file's fixture small; the delete path is F4's subject, not this test's.
  const cleanup = db();
  try {
    deleteAsset(cleanup, 'docs/terms', { contentRoot });
  } finally {
    cleanup.close();
  }
});
