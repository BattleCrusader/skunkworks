/**
 * QA S3 / defeat attempt 5 — **a live render must not be reachable from a bundle.**
 *
 * §16 S3: "a render file is deleted at token expiry + grace and never appears in a bundle
 * | sweep test + bundle grep". §7.1: "every bundle runs the link-absence test".
 *
 * There is **no bundle writer in this tree** (`tools/bundle_verify.mjs` verifies a manifest;
 * nothing produces one — S4 owns it). So the honest instrument is:
 *
 *   1. mint a *real, live* render through the shipped plane;
 *   2. enumerate the two trees an exporter can walk (`content/public`, `content/media`) and
 *      assert no path in them is the render or names it;
 *   3. assert no symlink under `content/public` resolves into `content/protected`;
 *   4. build a bundle that *does* contain the render, with a correct manifest, and run the
 *      shipped verifier on it — to find out whether anything refuses it.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import type Database from 'better-sqlite3';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import sharp from 'sharp';

import { uploadAsset } from '../../app/assets/library.ts';
import { openAdminWrite } from '../../app/db/classes.ts';
import { loadEnv } from '../../app/env.ts';
import { buildApp, type AppHandle } from '../../app/main.ts';
import { issueCode } from '../../app/download/code.ts';
import { makeFixture, REPO, type Fixture } from '../../test/helpers/fixture.ts';
import { call, header, type Res } from '../../test/helpers/http.ts';

const HOST = 'acme.test';
const out = (s: string): void => process.stdout.write(`${s}\n`);
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

async function makePdf(pages: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i += 1) doc.addPage([612, 792]).drawText(`p${i}`, { x: 72, y: 700, size: 12, font });
  return Buffer.from(await doc.save());
}

/** Every path under `dir`, as paths relative to `dir`; does not follow symlinks. */
function walk(dir: string): string[] {
  const found: string[] = [];
  const rec = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const abs = join(d, e.name);
      found.push(relative(dir, abs));
      if (e.isDirectory()) rec(abs);
    }
  };
  rec(dir);
  return found;
}

async function main(): Promise<void> {
  const fixture: Fixture = makeFixture({ specs: [{ key: 'acme', hosts: [HOST], title: 'Acme' }] });
  const contentRoot = join(fixture.dir, 'content');
  mkdirSync(contentRoot, { recursive: true });
  const db: Database.Database = openAdminWrite(fixture.sitePath('acme'));
  await uploadAsset({
    db,
    contentRoot,
    tenantKey: 'acme',
    key: 'vault/book',
    filename: 'book.pdf',
    bytes: await makePdf(2),
    quotaLimitBytes: 50_000_000,
    accessClass: 'gated',
  });
  // A public asset too, so `content/public` exists and the export walk has something in it.
  await uploadAsset({
    db,
    contentRoot,
    tenantKey: 'acme',
    key: 'brand/logo',
    filename: 'logo.png',
    bytes: await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 10, g: 90, b: 160 } } })
      .png()
      .toBuffer(),
    quotaLimitBytes: 50_000_000,
    accessClass: 'public',
  });
  const issued = await issueCode({ db, contentRoot, assetKey: 'vault/book', email: 'bundle@example.com', maxUses: 3 });
  db.close();

  const handle: AppHandle = await buildApp({ env: loadEnv(fixture.env), contentRoot, downloadLimits: { refusals: 9e9, all: 9e9 } });
  const port = await handle.app.listen({ port: 0, host: '127.0.0.1' }).then(() => {
    const a = handle.app.server.address();
    return typeof a === 'object' && a !== null ? a.port : 0;
  });
  const redeemed = await call({
    port,
    path: '/d/acme',
    method: 'POST',
    host: HOST,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: issued.code }),
  });
  const cookie = String(header(redeemed, 'set-cookie') ?? '').split(';')[0] ?? '';
  const dl: Res = await call({ port, path: '/d/acme/file', host: HOST, headers: { cookie } });
  const uri = String(header(dl, 'x-accel-redirect') ?? '');
  out(`# D5 download -> ${dl.status}, hand-off ${uri.slice(0, 60)}…`);

  // The render on disk, exactly where the header says.
  const relInContent = uri.replace(/^\/__protected\/wm\//, 'protected/wm/');
  const renderAbs = join(contentRoot, relInContent);
  const renderSha = sha(readFileSync(renderAbs));
  const renderBytes = readFileSync(renderAbs).length;
  out(`# D5 live render: ${relInContent.slice(0, 80)}… (${renderBytes} B, sha256 ${renderSha.slice(0, 8)})`);

  // 1. the two export trees
  const publicTree = walk(join(contentRoot, 'public'));
  const mediaTree = walk(join(contentRoot, 'media'));
  const exportTree = [...publicTree, ...mediaTree];
  const leaked = exportTree.filter((p) => p.includes('protected') || p.includes(relInContent.split('/').at(-2) ?? '\u0000'));
  out(`# D5 export trees: content/public ${publicTree.length} entries, content/media ${mediaTree.length} entries, ` +
    `entries naming the render or 'protected': ${leaked.length}${leaked.length > 0 ? ` ${JSON.stringify(leaked)}` : ''}`);

  // 2. every symlink under content/public, resolved
  const intoProtected = publicTree.filter((p) => {
    try {
      return realpathSync(join(contentRoot, 'public', p)).includes(`${contentRoot}/protected`);
    } catch {
      return false;
    }
  });
  out(`# D5 symlinks under content/public that resolve into content/protected: ${intoProtected.length}`);

  // 3. a bundle that *does* contain the render — does anything refuse it?
  const bundle = join(fixture.dir, 'bundle');
  mkdirSync(join(bundle, 'content', 'protected', 'wm'), { recursive: true });
  const inside = join(bundle, relInContent);
  mkdirSync(join(inside, '..'), { recursive: true });
  copyFileSync(renderAbs, inside);
  const manifest = {
    tenant: 'acme',
    files: [{ path: relInContent, sha256: renderSha }],
  };
  writeFileSync(join(bundle, 'BUNDLE.json'), JSON.stringify(manifest, null, 2));
  const verify = spawnSync(process.execPath, [join(REPO, 'tools', 'bundle_verify.mjs'), '--bundle', bundle], {
    encoding: 'utf8',
  });
  out(
    `# D5 bundle_verify on a bundle that CONTAINS the render -> exit ${verify.status}: ` +
      `${(verify.stdout + verify.stderr).trim().split('\n').slice(0, 3).join(' | ').slice(0, 220)}`,
  );

  await handle.close();
  fixture.cleanup();
}

main().catch((err) => {
  out(`# PROBE FAILED: ${String(err)}`);
  process.exit(1);
});
