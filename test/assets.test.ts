/**
 * S3a — content-addressed storage, upload hardening, `cms_asset` rows, the link graph,
 * and D6's error surface (SDS §7.1/§7.5, D13/D17/D18, §16 S3).
 *
 * Every test runs against a real `site.db` built from `schema/site.sql` and a real
 * content tree under the fixture's data dir. Nothing is mocked: the assertions are on
 * bytes on disk, rows in SQLite and the taxonomy code on the AppError.
 *
 * The five proofs this file exists for, in the order the slice states them:
 *
 *   A1/A2  the same bytes twice → one file; identity is the key, not the checksum
 *   A3     a GPS EXIF block goes in and does not come out (bytes, not the API)
 *   A4     `payload.php` renamed `.png` is refused and **nothing is written**
 *   A5     an SVG is refused, with its code
 *   A6     the quota is enforced before the write: the store is byte-identical after
 *   A7/A8  immutability, the alias row on rename, the link that blocks a delete
 */
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { after, before, describe, test } from 'node:test';

import sharp from 'sharp';

import { openAdminWrite } from '../app/db/classes.ts';
import { AppError } from '../app/errors.ts';
import {
  assetByKey,
  deleteAsset,
  renameAsset,
  storageQuotaFor,
  uploadAsset,
  type UploadResult,
} from '../app/assets/library.ts';
import {
  assetRefsInHtml,
  linksForAsset,
  linkAsset,
  syncDatasourceLinks,
  syncPageLinks,
  unlinkAsset,
} from '../app/assets/links.ts';
import { mediaRelPath, putBytes, quotaState, usedBytes } from '../app/assets/store.ts';
import { MAX_UPLOAD_BYTES, sniffAndNormalise, sniffMagic } from '../app/assets/sniff.ts';
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

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Every file under the content root, as `relpath:size:sha256`, sorted. The byte-identity proof. */
function tree(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else out.push(`${relative(root, abs)}:${statSync(abs).size}:${sha256(readFileSync(abs))}`);
    }
  };
  walk(root);
  return out.sort();
}

async function png(width = 8, height = 8): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 12, g: 200, b: 90 } } })
    .png()
    .toBuffer();
}

/**
 * A hand-built APP1 EXIF segment carrying a real GPS IFD (tag 0x8825 → 0x0001..0x0004).
 *
 * Hand-built rather than `sharp(…).withMetadata({exif:{GPS:…}})`, which in this libvips
 * build writes the tags under the Exif IFD and **drops the GPS pointer**, so a fixture
 * made that way would prove nothing about GPS. The segment is spliced after SOI.
 */
function gpsExifApp1(): Buffer {
  const be32 = (v: number): Buffer => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(v >>> 0);
    return b;
  };
  const be16 = (v: number): Buffer => {
    const b = Buffer.alloc(2);
    b.writeUInt16BE(v);
    return b;
  };
  const rationals = (nums: number[]): Buffer => Buffer.concat(nums.map((n) => Buffer.concat([be32(n), be32(1)])));
  // IFD0: one entry, the GPS IFD pointer, at offset 26 from the TIFF header.
  const ifd0 = Buffer.concat([be16(1), Buffer.concat([be16(0x8825), be16(4), be32(1), be32(26)]), be32(0)]);
  const latOff = 26 + 2 + 4 * 12 + 4;
  const lonOff = latOff + 24;
  const gps = Buffer.concat([
    be16(4),
    Buffer.concat([be16(0x0001), be16(2), be32(2), Buffer.from([0x53, 0, 0, 0])]), // GPSLatitudeRef 'S'
    Buffer.concat([be16(0x0002), be16(5), be32(3), be32(latOff)]), // GPSLatitude
    Buffer.concat([be16(0x0003), be16(2), be32(2), Buffer.from([0x45, 0, 0, 0])]), // GPSLongitudeRef 'E'
    Buffer.concat([be16(0x0004), be16(5), be32(3), be32(lonOff)]), // GPSLongitude
    be32(0),
    rationals([33, 51, 0]),
    rationals([151, 12, 0]),
  ]);
  const tiff = Buffer.concat([Buffer.from('MM'), be16(0x2a), be32(8), ifd0, gps]);
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const len = Buffer.alloc(2);
  len.writeUInt16BE(body.length + 2);
  return Buffer.concat([Buffer.from([0xff, 0xe1]), len, body]);
}

async function jpegWithGps(): Promise<Buffer> {
  const base = await sharp({ create: { width: 32, height: 32, channels: 3, background: { r: 200, g: 40, b: 40 } } })
    .jpeg({ quality: 95 })
    .toBuffer();
  return Buffer.concat([base.subarray(0, 2), gpsExifApp1(), base.subarray(2)]);
}

/** The GPS IFD tags a TIFF blob actually carries, read back from the bytes. */
function gpsTags(exif: Buffer | undefined): number[] {
  if (exif === undefined || exif.length < 14) return [];
  const tiff = exif.subarray(6);
  const ifd0 = tiff.readUInt32BE(4);
  const count = tiff.readUInt16BE(ifd0);
  for (let i = 0; i < count; i += 1) {
    const at = ifd0 + 2 + i * 12;
    if (tiff.readUInt16BE(at) === 0x8825) {
      const gps = tiff.readUInt32BE(at + 8);
      const n = tiff.readUInt16BE(gps);
      const tags: number[] = [];
      for (let j = 0; j < n; j += 1) tags.push(tiff.readUInt16BE(gps + 2 + j * 12));
      return tags;
    }
  }
  return [];
}

const LIMIT = 8 * 1024 * 1024;

// --- A1/A2: one file, and identity is the key ---------------------------------------

describe('A1 — the same bytes twice produce one file', () => {
  test('two uploads of one PNG: ONE file, ONE row, and the second says it reused', async () => {
    const bytes = await png(10, 6);
    const first = await uploadAsset({
      db: db(),
      contentRoot,
      tenantKey: 'acme',
      key: 'banner-home',
      filename: 'banner-home.png',
      bytes,
      quotaLimitBytes: LIMIT,
    });
    assert.equal(first.reused, false);
    assert.equal(first.wroteFile, true);
    const before = tree(contentRoot);
    assert.equal(before.filter((e) => e.includes(first.asset.sha256)).length, 1, 'the blob is not in the store');
    assert.equal(before.length, 1, `one blob expected in a fresh store, got ${JSON.stringify(before)}`);

    const second = await uploadAsset({
      db: db(),
      contentRoot,
      tenantKey: 'acme',
      key: 'banner-home',
      filename: 'banner-home.png',
      bytes,
      quotaLimitBytes: LIMIT,
    });
    // The explicit reuse response: same key, same bytes → the row and the file are the
    // existing ones, and the caller is told so rather than getting a silent no-op or a
    // second row that only differs by id.
    assert.equal(second.reused, true);
    assert.equal(second.wroteFile, false);
    assert.equal(second.asset.id, first.asset.id);
    assert.deepEqual(tree(contentRoot), before, 'the store changed on a deduplicated upload');

    const check = db();
    try {
      const rows = check.prepare('SELECT COUNT(*) AS n FROM cms_asset').get() as { n: number };
      assert.equal(rows.n, 1);
    } finally {
      check.close();
    }
  });
});

describe('A2 — dedupe is physical, identity is the key (D13 + D17)', () => {
  test('one blob, two keys: the bytes are shared and neither row is a lie', async () => {
    const bytes = await png(12, 12);
    const a = await uploadAsset({
      db: db(), contentRoot, tenantKey: 'acme', key: 'logo-square', filename: 'logo.png', bytes, quotaLimitBytes: LIMIT,
    });
    const afterA = tree(contentRoot);
    const b = await uploadAsset({
      db: db(), contentRoot, tenantKey: 'acme', key: 'logo-footer', filename: 'logo-copy.png', bytes, quotaLimitBytes: LIMIT,
    });
    assert.equal(a.wroteFile, true);
    assert.equal(b.wroteFile, false, 'the second key must reuse the blob');
    assert.equal(b.reused, false, 'a different key is a different asset, not a reuse');
    assert.notEqual(a.asset.id, b.asset.id);
    assert.equal(a.asset.sha256, b.asset.sha256);
    assert.equal(a.asset.storage_path, b.asset.storage_path);

    // The second key added no blob: the store is byte-identical to the state after the first.
    assert.deepEqual(tree(contentRoot), afterA, `dedupe failed: ${JSON.stringify(tree(contentRoot))}`);
    // The quota counts physical bytes, so the ledger equals what is actually on disk — not the
    // sum of the rows, which would charge this tenant twice for one blob.
    const check = db();
    try {
      const disk = tree(contentRoot).reduce((n, entry) => n + Number(entry.split(':')[1] ?? 0), 0);
      assert.equal(usedBytes(check), disk, 'the quota ledger disagrees with the store');
    } finally {
      check.close();
    }
  });
});

// --- A3: EXIF, asserted on bytes ----------------------------------------------------

describe('A3 — an image with GPS EXIF comes out without it', () => {
  test('the input carries a GPS IFD; the stored file carries no EXIF at all', async () => {
    const input = await jpegWithGps();
    const meta = await sharp(input).metadata();
    assert.deepEqual(gpsTags(meta.exif), [0x0001, 0x0002, 0x0003, 0x0004], 'the fixture has no GPS IFD to strip');
    assert.ok(input.includes(Buffer.from('Exif\0\0')), 'the fixture has no EXIF segment');

    const result = await uploadAsset({
      db: db(), contentRoot, tenantKey: 'acme', key: 'photo-gps', filename: 'photo.jpg', bytes: input, quotaLimitBytes: LIMIT,
    });
    const stored = readFileSync(join(contentRoot, result.asset.storage_path.replace(/^content\//, '')));
    assert.ok(stored.length > 0);

    // (1) no EXIF segment marker in the bytes that were written
    assert.equal(stored.includes(Buffer.from('Exif\0\0')), false, 'the stored JPEG still carries an EXIF segment');
    // (2) libvips agrees: no exif payload, so no GPS IFD to read
    const storedMeta = await sharp(stored).metadata();
    assert.equal(storedMeta.exif, undefined);
    assert.deepEqual(gpsTags(storedMeta.exif), []);
    // (3) the strongest form: re-encoding the GPS original and the plain original give the
    //     same bytes, so nothing of the EXIF block survived the pipeline.
    const plain = await sharp({ create: { width: 32, height: 32, channels: 3, background: { r: 200, g: 40, b: 40 } } })
      .jpeg({ quality: 95 })
      .toBuffer();
    const plainStored = await uploadAsset({
      db: db(), contentRoot, tenantKey: 'acme', key: 'photo-plain', filename: 'plain.jpg', bytes: plain, quotaLimitBytes: LIMIT,
    });
    const plainBytes = readFileSync(join(contentRoot, plainStored.asset.storage_path.replace(/^content\//, '')));
    assert.equal(sha256(stored), sha256(plainBytes), 'the GPS block changed the stored bytes');
  });
});

// --- A4: magic bytes, not the extension ---------------------------------------------

describe('A4 — a PHP payload renamed .png is refused and nothing is written', () => {
  test('magic-byte sniff refuses it, and the content tree is untouched', async () => {
    const before = tree(contentRoot);
    const payload = Buffer.from('<?php system($_GET["c"]); ?>\n', 'utf8');
    assert.equal(sniffMagic(payload), null, 'the sniff must not recognise a PHP payload');

    await assert.rejects(
      () =>
        uploadAsset({
          db: db(), contentRoot, tenantKey: 'acme', key: 'evil', filename: 'evil.png', bytes: payload, quotaLimitBytes: LIMIT,
        }),
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'SKW_E_SEC_UPLOAD_REJECTED');
        assert.equal(err.status, 415);
        assert.equal((err.detail as { reason?: string }).reason, 'magic_mismatch');
        return true;
      },
    );
    assert.deepEqual(tree(contentRoot), before, 'a refused upload wrote to the store');
    const check = db();
    try {
      const row = check.prepare("SELECT COUNT(*) AS n FROM cms_asset WHERE key = 'evil'").get() as { n: number };
      assert.equal(row.n, 0, 'a refused upload wrote a row');
    } finally {
      check.close();
    }
  });

  test('an HTML document renamed .png is refused by the same rule', async () => {
    const html = Buffer.from('<!doctype html><html><body>hi</body></html>', 'utf8');
    await assert.rejects(
      () =>
        uploadAsset({
          db: db(), contentRoot, tenantKey: 'acme', key: 'evil-html', filename: 'evil.png', bytes: html, quotaLimitBytes: LIMIT,
        }),
      (err: unknown) => err instanceof AppError && err.code === 'SKW_E_SEC_UPLOAD_REJECTED',
    );
  });
});

// --- A5: SVG is refused in v1 -------------------------------------------------------

describe('A5 — an SVG is refused with its code', () => {
  test('an .svg upload is 415 SKW_E_SEC_UPLOAD_REJECTED, reason svg_forbidden', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', 'utf8');
    const before = tree(contentRoot);
    await assert.rejects(
      () =>
        uploadAsset({
          db: db(), contentRoot, tenantKey: 'acme', key: 'icon', filename: 'icon.svg', bytes: svg, quotaLimitBytes: LIMIT,
        }),
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'SKW_E_SEC_UPLOAD_REJECTED');
        assert.equal(err.status, 415);
        assert.equal((err.detail as { reason?: string }).reason, 'svg_forbidden');
        return true;
      },
    );
    assert.deepEqual(tree(contentRoot), before);
  });

  test('an SVG payload named .png is refused too (extension is not the rule)', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'utf8');
    await assert.rejects(
      () =>
        uploadAsset({
          db: db(), contentRoot, tenantKey: 'acme', key: 'icon2', filename: 'icon.png', bytes: svg, quotaLimitBytes: LIMIT,
        }),
      (err: unknown) =>
        err instanceof AppError && (err.detail as { reason?: string }).reason === 'svg_forbidden',
    );
  });
});

// --- A6: the quota is enforced BEFORE the write -------------------------------------

describe('A6 — the quota is enforced before the write', () => {
  test('1 byte of headroom, a 2-byte write: refused, and the store is byte-identical', () => {
    const root = join(fixture.dir, 'quota-store');
    const bytes = Buffer.from('hi', 'utf8');
    const first = putBytes({ contentRoot: root, sha256: sha256(bytes), bytes, ext: 'bin' });
    assert.equal(first.wrote, true);
    const before = tree(root);

    const used = bytes.length;
    assert.throws(
      () =>
        putBytes({
          contentRoot: root,
          sha256: sha256(Buffer.from('ho', 'utf8')),
          bytes: Buffer.from('ho', 'utf8'),
          ext: 'bin',
          quota: { limitBytes: used + 1, usedBytes: used },
        }),
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'SKW_E_DM_QUOTA');
        assert.equal(err.status, 507);
        return true;
      },
    );
    assert.deepEqual(tree(root), before, 'a refused write changed the store');
  });

  test('an upload over quota leaves no file, no row, and no temp file', async () => {
    const bytes = await png(14, 14);
    // The stored bytes are the re-encode, so the headroom is stated against *those* bytes:
    // one byte short of what the store will actually be asked to write.
    const stored = await sniffAndNormalise({ filename: 'big.png', bytes });
    const check = db();
    let used = 0;
    let quota = 0;
    try {
      used = usedBytes(check);
      quota = used + stored.bytes.length - 1;
      const state = quotaState(check, quota);
      assert.equal(state.usedBytes, used);
      const before = tree(contentRoot);
      await assert.rejects(
        () =>
          uploadAsset({
            db: check,
            contentRoot,
            tenantKey: 'acme',
            key: 'over-quota',
            filename: 'big.png',
            bytes,
            quotaLimitBytes: quota,
          }),
        (err: unknown) => err instanceof AppError && err.code === 'SKW_E_DM_QUOTA',
      );
      assert.deepEqual(tree(contentRoot), before, 'a refused upload wrote a blob or left a temp file');
      const row = check.prepare("SELECT COUNT(*) AS n FROM cms_asset WHERE key = 'over-quota'").get() as { n: number };
      assert.equal(row.n, 0);
    } finally {
      check.close();
    }
  });

  test('the limit is the tenant’s own storage_quota_bytes, not a constant', () => {
    const control = new Database(fixture.controlDb);
    try {
      assert.equal(storageQuotaFor(control, 'acme'), 1073741824, 'the schema default is 1 GiB');
      control.prepare("UPDATE tenant SET storage_quota_bytes = 4096 WHERE key = 'acme'").run();
      assert.equal(storageQuotaFor(control, 'acme'), 4096);
      assert.throws(
        () => storageQuotaFor(control, 'nobody'),
        (err: unknown) => err instanceof AppError && err.code === 'SKW_E_PLT_TENANT_UNKNOWN',
      );
      control.prepare("UPDATE tenant SET storage_quota_bytes = 1073741824 WHERE key = 'acme'").run();
    } finally {
      control.close();
    }
  });

  test('a deduplicated upload is allowed at exactly the quota: it costs no bytes', async () => {
    const bytes = await png(11, 11);
    const check = db();
    try {
      await uploadAsset({
        db: check, contentRoot, tenantKey: 'acme', key: 'quota-dedupe', filename: 'q.png', bytes, quotaLimitBytes: LIMIT,
      });
      const existing = check.prepare("SELECT key, sha256, bytes FROM cms_asset WHERE key = 'quota-dedupe'").get() as {
        key: string;
        sha256: string;
        bytes: number;
      };
      const at = quotaState(check, usedBytes(check));
      assert.equal(at.usedBytes, at.limitBytes);
      const stored = readFileSync(join(contentRoot, `media/${existing.sha256.slice(0, 2)}/${existing.sha256}.png`));
      assert.equal(stored.length, existing.bytes);
      const again = await uploadAsset({
        db: check, contentRoot, tenantKey: 'acme', key: existing.key, filename: 'x.png', bytes: stored, quotaLimitBytes: at.limitBytes,
      });
      assert.equal(again.reused, true);
      assert.equal(again.wroteFile, false);
    } finally {
      check.close();
    }
  });
});

// --- A7: immutability ---------------------------------------------------------------

describe('A7 — a key’s bytes never change', () => {
  test('re-uploading different bytes under an existing key is refused', async () => {
    const first = await png(15, 15);
    const check = db();
    try {
      await uploadAsset({
        db: check, contentRoot, tenantKey: 'acme', key: 'immutable-key', filename: 'i.png', bytes: first, quotaLimitBytes: LIMIT,
      });
      const before = check.prepare("SELECT id, sha256, bytes FROM cms_asset WHERE key = 'immutable-key'").get() as {
        id: number;
        sha256: string;
        bytes: number;
      };
      const treeBefore = tree(contentRoot);
      const different = await png(9, 9);
      await assert.rejects(
        () =>
          uploadAsset({
            db: check,
            contentRoot,
            tenantKey: 'acme',
            key: 'immutable-key',
            filename: 'i.png',
            bytes: different,
            quotaLimitBytes: LIMIT,
          }),
        (err: unknown) => {
          assert.ok(err instanceof AppError);
          assert.equal(err.code, 'SKW_E_DM_COLUMN_IMMUTABLE');
          assert.equal(err.status, 409);
          return true;
        },
      );
      const after = check.prepare("SELECT id, sha256, bytes FROM cms_asset WHERE key = 'immutable-key'").get() as {
        id: number;
        sha256: string;
        bytes: number;
      };
      assert.deepEqual(after, before);
      assert.deepEqual(tree(contentRoot), treeBefore, 'a refused re-upload changed the store');
    } finally {
      check.close();
    }
  });

  test('the same bytes under a new key while a store file exists does not overwrite it', async () => {
    const bytes = await png(13, 13);
    const check = db();
    try {
      await uploadAsset({
        db: check, contentRoot, tenantKey: 'acme', key: 'overwrite-check', filename: 'o.png', bytes, quotaLimitBytes: LIMIT,
      });
      const row = check.prepare("SELECT sha256, bytes FROM cms_asset WHERE key = 'overwrite-check'").get() as {
        sha256: string;
        bytes: number;
      };
      const abs = join(contentRoot, `media/${row.sha256.slice(0, 2)}/${row.sha256}.png`);
      const before = { size: statSync(abs).size, mtime: statSync(abs).mtimeMs, sha: sha256(readFileSync(abs)) };
      const stored = readFileSync(abs);
      putBytes({ contentRoot, sha256: row.sha256, bytes: stored, ext: 'png' });
      const after = { size: statSync(abs).size, mtime: statSync(abs).mtimeMs, sha: sha256(readFileSync(abs)) };
      assert.deepEqual(after, before);
    } finally {
      check.close();
    }
  });
});

// --- A8: rename, alias, delete, links ------------------------------------------------

describe('A8 — the alias row, the link graph, and the delete that is refused', () => {
  test('an unreferenced rename writes the alias row and moves no bytes', async () => {
    const bytes = await png(7, 7);
    const uploaded = await uploadAsset({
      db: db(), contentRoot, tenantKey: 'acme', key: 'old-name', filename: 'old.png', bytes, quotaLimitBytes: LIMIT,
    });
    const treeBefore = tree(contentRoot);
    const check = db();
    try {
      const result = renameAsset(check, { from: 'old-name', to: 'new-name' });
      assert.equal(result.alias, true);
      const alias = check.prepare("SELECT key, asset_id FROM cms_asset_alias WHERE key = 'old-name'").get() as
        | { key: string; asset_id: number }
        | undefined;
      assert.equal(alias?.asset_id, uploaded.asset.id);
      assert.equal(assetByKey(check, 'old-name'), undefined);
      assert.equal(assetByKey(check, 'new-name')?.sha256, uploaded.asset.sha256);
    } finally {
      check.close();
    }
    assert.deepEqual(tree(contentRoot), treeBefore, 'a rename moved bytes');
  });

  test('a link refuses the rename, and the delete names the code until it is unlinked', async () => {
    const bytes = await png(5, 5);
    const uploaded = await uploadAsset({
      db: db(), contentRoot, tenantKey: 'acme', key: 'linked-asset', filename: 'l.png', bytes, quotaLimitBytes: LIMIT,
    });
    const check = db();
    try {
      const page = check.prepare("SELECT id FROM cms_page WHERE path = '/pricing'").get() as { id: number };
      assert.equal(linkAsset(check, { assetId: uploaded.asset.id, ownerKind: 'page', ownerId: page.id }), true);
      assert.equal(linkAsset(check, { assetId: uploaded.asset.id, ownerKind: 'page', ownerId: page.id }), false);

      // §7.1: a referenced key cannot be renamed (409), and the refusal names the count.
      assert.throws(
        () => renameAsset(check, { from: 'linked-asset', to: 'linked-renamed' }),
        (err: unknown) => {
          assert.ok(err instanceof AppError);
          assert.equal(err.code, 'SKW_E_DM_KEY_IN_USE');
          assert.equal((err.detail as { references?: number }).references, 1);
          return true;
        },
      );

      assert.throws(
        () => deleteAsset(check, 'linked-asset'),
        (err: unknown) => {
          assert.ok(err instanceof AppError);
          assert.equal(err.code, 'SKW_E_DM_ASSET_IN_USE');
          assert.equal((err.detail as { references?: number }).references, 1);
          return true;
        },
      );
      // The trigger is the backstop, not a comment: a raw DELETE is refused by the schema.
      assert.throws(
        () => check.prepare('DELETE FROM cms_asset WHERE id = ?').run(uploaded.asset.id),
        /SKW_E_DM_ASSET_IN_USE/,
      );

      assert.equal(unlinkAsset(check, { assetId: uploaded.asset.id, ownerKind: 'page', ownerId: page.id }), 1);
      assert.deepEqual(linksForAsset(check, uploaded.asset.id), []);
      assert.equal(deleteAsset(check, 'linked-asset').deleted, true);
      assert.equal(assetByKey(check, 'linked-asset'), undefined);
    } finally {
      check.close();
    }
  });

  test('the alias cascades when the asset is deleted', async () => {
    const bytes = await png(6, 6);
    const uploaded = await uploadAsset({
      db: db(), contentRoot, tenantKey: 'acme', key: 'cascade-src', filename: 'c.png', bytes, quotaLimitBytes: LIMIT,
    });
    const check = db();
    try {
      renameAsset(check, { from: 'cascade-src', to: 'cascade-dst' });
      const n1 = check.prepare('SELECT COUNT(*) AS n FROM cms_asset_alias WHERE asset_id = ?').get(uploaded.asset.id) as {
        n: number;
      };
      assert.equal(n1.n, 1);
      deleteAsset(check, 'cascade-dst');
      const n2 = check.prepare('SELECT COUNT(*) AS n FROM cms_asset_alias WHERE asset_id = ?').get(uploaded.asset.id) as {
        n: number;
      };
      assert.equal(n2.n, 0, 'the alias row outlived its asset');
    } finally {
      check.close();
    }
  });

  test('a page reference writes the link row when the page is scanned', async () => {
    const bytes = await png(4, 4);
    const uploaded = await uploadAsset({
      db: db(), contentRoot, tenantKey: 'acme', key: 'body-image', filename: 'b.png', bytes, quotaLimitBytes: LIMIT,
    });
    const check = db();
    try {
      const page = check.prepare("SELECT id FROM cms_page WHERE path = '/pricing'").get() as { id: number };
      check
        .prepare('UPDATE cms_page SET body_html = ? WHERE id = ?')
        .run('<main><img src="/media/body-image.png" alt="x"><a href="/media/body-image.png?v=1">dl</a></main>', page.id);
      const body = check.prepare('SELECT body_html FROM cms_page WHERE id = ?').get(page.id) as { body_html: string };
      assert.deepEqual(assetRefsInHtml(body.body_html), ['body-image']);
      const synced = syncPageLinks(check, page.id);
      assert.equal(synced.linked, 1);
      assert.deepEqual(linksForAsset(check, uploaded.asset.id), [{ owner_kind: 'page', owner_id: page.id }]);
      // Idempotent: a second scan writes nothing.
      assert.equal(syncPageLinks(check, page.id).linked, 0);
      // Removing the reference removes the link, and only then is the delete allowed.
      check.prepare('UPDATE cms_page SET body_html = ? WHERE id = ?').run('<main>no image</main>', page.id);
      assert.equal(syncPageLinks(check, page.id).removed, 1);
      assert.equal(deleteAsset(check, 'body-image').deleted, true);
    } finally {
      check.close();
    }
  });
});

// --- the store's own contract --------------------------------------------------------

describe('the store’s path is generated, never a filename', () => {
  test('a filename that is a path is refused, not sanitised', async () => {
    const bytes = await png(3, 3);
    const before = tree(contentRoot);
    await assert.rejects(
      () =>
        uploadAsset({
          db: db(), contentRoot, tenantKey: 'acme', key: 'path-evil', filename: '../../etc/passwd.png', bytes,
          quotaLimitBytes: LIMIT,
        }),
      (err: unknown) =>
        err instanceof AppError &&
        err.code === 'SKW_E_SEC_UPLOAD_REJECTED' &&
        (err.detail as { reason?: string }).reason === 'filename_invalid',
    );
    assert.deepEqual(tree(contentRoot), before);
  });

  test('the stored path is content/media/<hh>/<sha>.<ext> and the sha is over the stored bytes', async () => {
    const bytes = await png(3, 3);
    const uploaded: UploadResult = await uploadAsset({
      db: db(), contentRoot, tenantKey: 'acme', key: 'path-check', filename: 'passwd.png', bytes, quotaLimitBytes: LIMIT,
    });
    const row = uploaded.asset;
    assert.equal(row.storage_path, mediaRelPath(row.sha256, 'png'));
    assert.match(row.storage_path, /^content\/media\/[0-9a-f]{2}\/[0-9a-f]{64}\.png$/);
    // The name is display data: it is in `filename`, never in the path.
    assert.equal(row.filename, 'passwd.png');
    assert.equal(row.storage_path.includes('passwd'), false, 'the filename became a path segment');
    assert.equal(row.storage_path.includes('..'), false);
    const abs = join(contentRoot, row.storage_path.replace(/^content\//, ''));
    assert.equal(sha256(readFileSync(abs)), row.sha256, 'the sha does not describe the bytes on disk');
    assert.equal(statSync(abs).size, row.bytes);
    // Not in an executable path, and not reachable as a module: the only extensions the
    // store can produce are the eight in the DDL's generated column.
    assert.equal(/\.(m?[jt]s|php|html?|cjs|css|so|dylib|sh)$/.test(row.storage_path), false);
    assert.equal(existsSync(join(contentRoot, 'media', '..', 'etc')), false);
  });

  test('the file cap refuses before the sniff, with 413', async () => {
    const bytes = await png(2, 2);
    await assert.rejects(
      () =>
        sniffAndNormalise({ filename: 'x.png', bytes, maxBytes: 10 }),
      (err: unknown) => err instanceof AppError && err.code === 'SKW_E_PLT_BODY_TOO_LARGE',
    );
    assert.ok(MAX_UPLOAD_BYTES >= 1024 * 1024);
  });
});

// --- the datasource half of the link graph ------------------------------------------

describe('a datasource that selects an asset column links the values it can see', () => {
  test('one link per distinct asset value, and none for NULL', async () => {
    const bytes = await png(6, 9);
    const check = db();
    try {
      await uploadAsset({
        db: check, contentRoot, tenantKey: 'acme', key: 'product-photo', filename: 'p.png', bytes, quotaLimitBytes: LIMIT,
      });
      check.exec(`
        CREATE TABLE u_products (
          id INTEGER PRIMARY KEY,
          title TEXT NOT NULL,
          photo TEXT REFERENCES cms_asset(key) ON DELETE RESTRICT
        );
        INSERT INTO u_products (title, photo) VALUES ('a', 'product-photo'), ('b', 'product-photo'), ('c', NULL);
        INSERT INTO cms_table_registry (table_name, table_class, column_count, index_count, columns_json, created_at, created_by)
          VALUES ('u_products', 'user', 2, 1,
                  '[{"name":"title","type":"TEXT","notNull":1},{"name":"photo","type":"ASSET","notNull":0}]',
                  '2026-01-01T00:00:00.000Z', 1);
        INSERT INTO cms_datasource (key, kind, spec_json, params_json, is_public, ttl_s, published_at)
          VALUES ('products', 'query', '{"table":"u_products","columns":["title","photo"],"where":[],"order":[],"limit_default":10,"limit_max":50}', '[]', 1, 60, '2026-01-01T00:00:00.000Z');
      `);
      const ds = check.prepare("SELECT id FROM cms_datasource WHERE key = 'products'").get() as { id: number };
      const asset = check.prepare("SELECT id FROM cms_asset WHERE key = 'product-photo'").get() as { id: number };
      const synced = syncDatasourceLinks(check, ds.id);
      assert.equal(synced.linked, 1);
      assert.deepEqual(linksForAsset(check, asset.id), [{ owner_kind: 'datasource', owner_id: ds.id }]);
    } finally {
      check.close();
    }
  });
});
