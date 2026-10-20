/**
 * S3a — the proofs that are about bytes rather than about an API.
 *
 *   node scratch/s3a/proofs.ts
 *
 * Prints, in order: the EXIF block going in and the absence of it coming out; the magic-byte
 * refusal of a PHP payload renamed `.png` with the store listing before and after; the quota
 * refusal with the store byte-identical; and the generated path with the checksum over the
 * stored bytes.
 */
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import sharp from 'sharp';

import { AppError } from '../../app/errors.ts';
import { uploadAsset } from '../../app/assets/library.ts';
import { assetByKey } from '../../app/assets/library.ts';
import { mediaRelPath, putBytes, usedBytes } from '../../app/assets/store.ts';
import { sniffAndNormalise } from '../../app/assets/sniff.ts';
import { makeFixture } from '../../test/helpers/fixture.ts';

const LIMIT = 8 * 1024 * 1024;
const fixture = makeFixture({ specs: [{ key: 'acme', hosts: ['acme.test'] }] });
const contentRoot = join(fixture.dir, 'content');
const file = fixture.sitePath('acme');

function tree(root: string): string[] {
  try {
    const out: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const abs = join(dir, e.name);
        if (e.isDirectory()) walk(abs);
        else out.push(`${abs.slice(root.length + 1)}  ${statSync(abs).size} B  ${createHash('sha256').update(readFileSync(abs)).digest('hex')}`);
      }
    };
    walk(root);
    return out.sort();
  } catch {
    return [];
  }
}

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
  const rat = (nums: number[]): Buffer => Buffer.concat(nums.map((n) => Buffer.concat([be32(n), be32(1)])));
  const ifd0 = Buffer.concat([be16(1), Buffer.concat([be16(0x8825), be16(4), be32(1), be32(26)]), be32(0)]);
  const latOff = 26 + 2 + 4 * 12 + 4;
  const lonOff = latOff + 24;
  const gps = Buffer.concat([
    be16(4),
    Buffer.concat([be16(0x0001), be16(2), be32(2), Buffer.from([0x53, 0, 0, 0])]),
    Buffer.concat([be16(0x0002), be16(5), be32(3), be32(latOff)]),
    Buffer.concat([be16(0x0003), be16(2), be32(2), Buffer.from([0x45, 0, 0, 0])]),
    Buffer.concat([be16(0x0004), be16(5), be32(3), be32(lonOff)]),
    be32(0),
    rat([33, 51, 0]),
    rat([151, 12, 0]),
  ]);
  const tiff = Buffer.concat([Buffer.from('MM'), be16(0x2a), be32(8), ifd0, gps]);
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const len = Buffer.alloc(2);
  len.writeUInt16BE(body.length + 2);
  return Buffer.concat([Buffer.from([0xff, 0xe1]), len, body]);
}

function gpsTags(exif: Buffer | undefined): string {
  if (exif === undefined) return 'none';
  const t = exif.subarray(6);
  const ifd0 = t.readUInt32BE(4);
  const n = t.readUInt16BE(ifd0);
  for (let i = 0; i < n; i += 1) {
    const at = ifd0 + 2 + i * 12;
    if (t.readUInt16BE(at) === 0x8825) {
      const gps = t.readUInt32BE(at + 8);
      const count = t.readUInt16BE(gps);
      const tags: string[] = [];
      for (let j = 0; j < count; j += 1) tags.push(`0x${t.readUInt16BE(gps + 2 + j * 12).toString(16).padStart(4, '0')}`);
      // the latitude rationals, read back
      const latAt = t.readUInt32BE(gps + 2 + 12 + 8);
      const lat = [0, 1, 2].map((k) => `${t.readUInt32BE(latAt + k * 8)}/${t.readUInt32BE(latAt + k * 8 + 4)}`);
      return `${count} tags [${tags.join(', ')}] GPSLatitude=${lat.join(' ')}`;
    }
  }
  return 'no GPS IFD pointer';
}

async function main(): Promise<void> {
  console.log('=== P1. EXIF with GPS: in, then out ===');
  const base = await sharp({ create: { width: 32, height: 32, channels: 3, background: { r: 200, g: 40, b: 40 } } })
    .jpeg({ quality: 95 })
    .toBuffer();
  const withGps = Buffer.concat([base.subarray(0, 2), gpsExifApp1(), base.subarray(2)]);
  const inMeta = await sharp(withGps).metadata();
  console.log(`  upload bytes          ${withGps.length} B  sha256=${createHash('sha256').update(withGps).digest('hex').slice(0, 16)}…`);
  console.log(`  upload has 'Exif\\0\\0' ${withGps.includes(Buffer.from('Exif\0\0'))}`);
  console.log(`  upload metadata.exif  ${inMeta.exif?.length ?? 'undefined'} B`);
  console.log(`  upload GPS IFD        ${gpsTags(inMeta.exif)}`);

  const uploaded = await uploadAsset({
    db: new Database(file), contentRoot, tenantKey: 'acme', key: 'photo-gps', filename: 'photo.jpg', bytes: withGps, quotaLimitBytes: LIMIT,
  });
  const stored = readFileSync(join(contentRoot, uploaded.asset.storage_path.replace(/^content\//, '')));
  const outMeta = await sharp(stored).metadata();
  console.log(`  stored path           ${uploaded.asset.storage_path}`);
  console.log(`  stored bytes          ${stored.length} B  sha256=${createHash('sha256').update(stored).digest('hex')}`);
  console.log(`  stored has 'Exif\\0\\0' ${stored.includes(Buffer.from('Exif\0\0'))}`);
  console.log(`  stored metadata.exif  ${outMeta.exif === undefined ? 'undefined' : `${outMeta.exif.length} B`}`);
  console.log(`  stored GPS IFD        ${gpsTags(outMeta.exif)}`);
  console.log(`  row.sha256 == sha256(stored)  ${uploaded.asset.sha256 === createHash('sha256').update(stored).digest('hex')}`);
  console.log(`  row.storage_path == generated  ${uploaded.asset.storage_path === mediaRelPath(uploaded.asset.sha256, 'jpg')}`);

  console.log('\n=== P2. a PHP payload renamed .png ===');
  const before = tree(contentRoot);
  const payload = Buffer.from('<?php system($_GET["c"]); ?>\n', 'utf8');
  try {
    await uploadAsset({
      db: new Database(file), contentRoot, tenantKey: 'acme', key: 'evil', filename: 'evil.png', bytes: payload, quotaLimitBytes: LIMIT,
    });
    console.log('  NOT REFUSED — the gate is broken');
  } catch (err) {
    const e = err as AppError & { detail?: { reason?: string; claimed?: string; sniffed?: string | null } };
    console.log(`  refused               ${e.code} (${e.status}) reason=${e.detail?.reason} claimed=${e.detail?.claimed} sniffed=${String(e.detail?.sniffed)}`);
  }
  const after = tree(contentRoot);
  console.log(`  store before          ${before.length} file(s)`);
  console.log(`  store after           ${after.length} file(s)`);
  console.log(`  byte-identical        ${JSON.stringify(before) === JSON.stringify(after)}`);
  const db2 = new Database(file);
  try {
    console.log(`  cms_asset rows        ${(db2.prepare('SELECT COUNT(*) AS n FROM cms_asset').get() as { n: number }).n} (the refused upload wrote none)`);
  } finally {
    db2.close();
  }

  console.log('\n=== P3. the quota, before the write ===');
  const root = join(fixture.dir, 'quota-store');
  const two = Buffer.from('hi', 'utf8');
  putBytes({ contentRoot: root, sha256: createHash('sha256').update(two).digest('hex'), bytes: two, ext: 'bin' });
  const qBefore = tree(root);
  console.log(`  store                 ${JSON.stringify(qBefore.map((l) => l.split('  ')[0]))}`);
  try {
    putBytes({
      contentRoot: root,
      sha256: createHash('sha256').update(Buffer.from('ho')).digest('hex'),
      bytes: Buffer.from('ho'),
      ext: 'bin',
      quota: { limitBytes: two.length + 1, usedBytes: two.length },
    });
    console.log('  NOT REFUSED — the gate is broken');
  } catch (err) {
    const e = err as AppError & { detail?: { limit_bytes?: number; used_bytes?: number; needed_bytes?: number } };
    console.log(`  refused               ${e.code} (${e.status}) limit=${e.detail?.limit_bytes} used=${e.detail?.used_bytes} needed=${e.detail?.needed_bytes}`);
  }
  console.log(`  store byte-identical  ${JSON.stringify(tree(root)) === JSON.stringify(qBefore)}`);

  console.log('\n=== P4. dedupe, identity and the ledger ===');
  const png = await sharp({ create: { width: 10, height: 6, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toBuffer();
  const db3 = new Database(file);
  const one = await uploadAsset({ db: db3, contentRoot, tenantKey: 'acme', key: 'banner-home', filename: 'b.png', bytes: png, quotaLimitBytes: LIMIT });
  const two2 = await uploadAsset({ db: db3, contentRoot, tenantKey: 'acme', key: 'banner-home', filename: 'b.png', bytes: png, quotaLimitBytes: LIMIT });
  const three = await uploadAsset({ db: db3, contentRoot, tenantKey: 'acme', key: 'banner-footer', filename: 'b2.png', bytes: png, quotaLimitBytes: LIMIT });
  console.log(`  1st upload            reused=${one.reused} wroteFile=${one.wroteFile} id=${one.asset.id}`);
  console.log(`  2nd (same key, bytes) reused=${two2.reused} wroteFile=${two2.wroteFile} id=${two2.asset.id}`);
  console.log(`  3rd (new key, bytes)  reused=${three.reused} wroteFile=${three.wroteFile} id=${three.asset.id} same sha=${three.asset.sha256 === one.asset.sha256}`);
  const files = tree(contentRoot).filter((l) => l.includes(one.asset.sha256));
  console.log(`  blobs for that sha    ${files.length}`);
  console.log(`  sqlite ledger         ${usedBytes(db3)} B  disk ${tree(contentRoot).reduce((n, l) => n + Number(l.split('  ')[1]?.replace(' B', '') ?? 0), 0)} B`);
  db3.close();

  console.log('\n=== P5. the store, as it is on disk ===');
  for (const line of tree(contentRoot)) console.log(`  ${line}`);
  console.log(`\n  content root          ${contentRoot}`);
  console.log(`  cms_asset keys        ${JSON.stringify(new Database(file).prepare('SELECT key FROM cms_asset ORDER BY key').all())}`);

  fixture.cleanup();
}

await main();
