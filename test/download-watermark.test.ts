/**
 * S3d / §7.5 / §16 S3 — **per-purchaser watermarking, fail-closed.**
 *
 * Every case is one line of the acceptance table, over a real `buildApp` and a real
 * `site.db`:
 *
 *   W1  one asset, two buyers: two files, two spec hashes, each footer carries its own
 *       `order_ref` (drawn into the content stream, not written to /Subject);
 *   W2  one buyer, twice: one render, one row, one path, identical bytes;
 *   W3  the hand-off is `/__protected/wm/…` — never `/__protected/<hh>/<sha>` and never
 *       anything under `content/media/`;
 *   W4  a renderer that throws is `503 SKW_E_SEC_WATERMARK_FAILED`, writes
 *       `denied_watermark`, and emits **no** `X-Accel-Redirect`;
 *   W5  a render that overruns the 2 s budget takes the identical path (and the budget
 *       in the shipped build is asserted to be 2,000 ms);
 *   W6  sixteen concurrent stamps on one tenant never exceed eight in flight;
 *   W7  a render past `expires_at` is deleted by the sweep, and the next request
 *       re-stamps instead of 404ing;
 *   W8  a CJK buyer name is `?` in a cp1252 footer while the ASCII `order_ref` survives;
 *   W9  the sanitiser itself: cp1252 preserved, transliterated, or `?` — one function.
 *
 * The two failure cases (W4/W5) build their own app with an injected renderer. That is
 * the same kind of seam as `downloadLimits`: the shipped path is asserted separately by
 * W1 (a real pdf-lib render) and by the constant asserted in W3.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';

import type Database from 'better-sqlite3';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import sharp from 'sharp';

import { uploadAsset } from '../app/assets/library.ts';
import { openAdminWrite } from '../app/db/classes.ts';
import { loadEnv } from '../app/env.ts';
import { buildApp, type AppHandle } from '../app/main.ts';
import { assetById, issueCode } from '../app/download/code.ts';
import { isCp1252, sanitiseCp1252 } from '../app/download/cp1252.ts';
import { STAMP_BUDGET_MS, STAMP_CONCURRENCY, StampGate, globalStampConcurrency, stampWorkerUrl, type WatermarkStore } from '../app/download/render.ts';
import { stampable } from '../app/download/watermark.ts';
import { cookieName, mintToken } from '../app/download/token.ts';
import { makeFixture, type Fixture } from './helpers/fixture.ts';
import { call, header, type Res } from './helpers/http.ts';
import { pdfDrawnText } from './helpers/pdftext.ts';

const HOST = 'acme.test';

let fixture: Fixture;
let handle: AppHandle;
let port = 0;
let contentRoot = '';
let bookSha = '';
let picSha = '';
let bookId = 0;
let betaBookId = 0;

interface Issued {
  id: number;
  code: string;
}

interface RenderRow {
  asset_id: number;
  spec_sha: string;
  source_sha: string;
  bytes: number;
  path: string;
  expires_at: string;
}

function siteDb(): Database.Database {
  return openAdminWrite(fixture.sitePath('acme'));
}

function db<T>(fn: (conn: Database.Database) => T): T {
  const conn = siteDb();
  try {
    return fn(conn);
  } finally {
    conn.close();
  }
}

/** A real, parseable PDF — pdf-lib is the renderer, so the fixture is its own output. */
async function makePdf(pages: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i += 1) {
    const page = doc.addPage([612, 792]);
    page.drawText(`chapter ${i + 1}`, { x: 72, y: 700, size: 14, font });
  }
  return Buffer.from(await doc.save());
}

async function makePng(): Promise<Buffer> {
  return sharp({ create: { width: 320, height: 240, channels: 3, background: { r: 30, g: 60, b: 120 } } })
    .png()
    .toBuffer();
}

async function uploadFor(
  tenantKey: string,
  key: string,
  filename: string,
  bytes: Buffer,
): Promise<{ sha: string; id: number }> {
  const conn = openAdminWrite(fixture.sitePath(tenantKey));
  try {
    const result = await uploadAsset({
      db: conn,
      contentRoot,
      tenantKey,
      key,
      filename,
      bytes,
      quotaLimitBytes: 50_000_000,
      accessClass: 'gated',
    });
    return { sha: result.asset.sha256, id: result.asset.id };
  } finally {
    conn.close();
  }
}

async function upload(key: string, filename: string, bytes: Buffer): Promise<{ sha: string; id: number }> {
  return uploadFor('acme', key, filename, bytes);
}

async function issueFor(tenantKey: string, email: string | null, orderRef: string | null, assetKey: string): Promise<Issued> {
  const conn = openAdminWrite(fixture.sitePath(tenantKey));
  try {
    const issued = await issueCode({ db: conn, contentRoot, assetKey, email, orderRef });
    return { id: issued.id, code: issued.code };
  } finally {
    conn.close();
  }
}

async function issue(email: string | null, orderRef: string | null, assetKey = 'vault/book'): Promise<Issued> {
  return issueFor('acme', email, orderRef, assetKey);
}

function redeem(code: string): Promise<Res> {
  return call({
    port,
    path: '/d/acme',
    method: 'POST',
    host: HOST,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  });
}

function cookieOf(res: Res): string {
  const raw = String(header(res, 'set-cookie') ?? '');
  return raw.slice(0, raw.indexOf(';'));
}

async function download(code: string, extra: Record<string, string> = {}): Promise<Res> {
  const res = await redeem(code);
  assert.equal(res.status, 303, res.body);
  return call({ port, path: '/d/acme/file', host: HOST, headers: { cookie: cookieOf(res), ...extra } });
}

function renders(codeId?: number): RenderRow[] {
  return db((conn) =>
    codeId === undefined
      ? (conn.prepare(`SELECT * FROM cms_watermark_render ORDER BY id`).all() as RenderRow[])
      : (conn
          .prepare(
            `SELECT r.* FROM cms_watermark_render r
               JOIN cms_download_code c ON c.asset_id = r.asset_id
              WHERE c.id = ?`,
          )
          .all(codeId) as RenderRow[]),
  );
}

function events(codeId: number): { kind: string; outcome: string; bytes_declared: number }[] {
  return db(
    (conn) =>
      conn
        .prepare(`SELECT kind, outcome, bytes_declared FROM cms_download_event WHERE code_id = ? ORDER BY id`)
        .all(codeId) as never,
  );
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** `content/protected/wm/<spec>/<asset>.<ext>` → an absolute path. */
function abs(relPath: string): string {
  return join(contentRoot, relPath.slice('content/'.length));
}

function uriOf(res: Res): string {
  const uri = header(res, 'x-accel-redirect');
  assert.equal(typeof uri, 'string', 'the app must hand off a file');
  return String(uri);
}

before(async () => {
  fixture = makeFixture({
    specs: [
      { key: 'acme', hosts: [HOST], title: 'Acme' },
      // E-27's second tenant: the global cap only means something across tenants.
      { key: 'beta', hosts: ['beta.test'], title: 'Beta' },
    ],
  });
  contentRoot = join(fixture.dir, 'content');
  mkdirSync(join(contentRoot, 'media'), { recursive: true });

  const book = await upload('vault/book', 'book.pdf', await makePdf(2));
  bookSha = book.sha;
  bookId = book.id;
  picSha = (await upload('vault/pic', 'plate.png', await makePng())).sha;
  betaBookId = (await uploadFor('beta', 'vault/book', 'book.pdf', await makePdf(2))).id;

  handle = await buildApp({
    env: loadEnv(fixture.env),
    contentRoot,
    downloadLimits: { refusals: 10_000, all: 10_000 },
  });
  port = await handle.app.listen({ port: 0, host: '127.0.0.1' }).then(() => {
    const address = handle.app.server.address();
    return typeof address === 'object' && address !== null ? address.port : 0;
  });
});

after(async () => {
  await handle.close();
  fixture.cleanup();
});

// ---------------------------------------------------------------------------------
// W1 — the criterion this slice exists for
// ---------------------------------------------------------------------------------

test('W1. two buyers of one asset get two files, two spec hashes, and their own order_ref', async () => {
  const alice = await issue('alice@example.com', 'ORD-ALICE-1001');
  const bob = await issue('bob@example.com', 'ORD-BOB-2002');

  const first = await download(alice.code);
  const second = await download(bob.code);
  assert.equal(first.status, 200, first.body);
  assert.equal(second.status, 200, second.body);

  const uriA = uriOf(first);
  const uriB = uriOf(second);
  assert.match(uriA, /^\/__protected\/wm\/[0-9a-f]{64}\/[0-9a-f]{64}\.pdf$/, uriA);
  assert.match(uriB, /^\/__protected\/wm\/[0-9a-f]{64}\/[0-9a-f]{64}\.pdf$/, uriB);
  assert.notEqual(uriA, uriB, 'two purchasers must never share bytes');

  const fileA = join(contentRoot, 'protected', uriA.slice('/__protected/'.length));
  const fileB = join(contentRoot, 'protected', uriB.slice('/__protected/'.length));
  const bytesA = readFileSync(fileA);
  const bytesB = readFileSync(fileB);
  assert.notEqual(sha256(bytesA), sha256(bytesB), 'the per-purchaser text forks the output');

  const textA = pdfDrawnText(bytesA);
  const textB = pdfDrawnText(bytesB);
  assert.ok(textA.includes('ORD-ALICE-1001'), `alice's footer is missing her order_ref:\n${textA}`);
  assert.ok(textB.includes('ORD-BOB-2002'), `bob's footer is missing his order_ref:\n${textB}`);
  assert.ok(!textA.includes('ORD-BOB-2002'), 'alice carries bob\'s order_ref');
  assert.ok(!textB.includes('ORD-ALICE-1001'), 'bob carries alice\'s order_ref');
  assert.ok(textA.includes('alice@example.com'), `alice's email is not in her footer:\n${textA}`);

  // Both renders are valid PDFs, not truncated streams.
  for (const bytes of [bytesA, bytesB]) {
    const doc = await PDFDocument.load(bytes);
    assert.equal(doc.getPageCount(), 2, 'every page survives the stamp');
  }

  const rows = renders();
  assert.equal(rows.length, 2, `expected one render per purchaser, got ${JSON.stringify(rows)}`);
  assert.notEqual(rows[0]?.spec_sha, rows[1]?.spec_sha);
  assert.equal(rows[0]?.source_sha, bookSha);
  assert.equal(rows[0]?.asset_id, bookId);

  process.stdout.write(
    `# W1 2 buyers -> 2 files, spec_sha ${rows[0]?.spec_sha.slice(0, 12)}… vs ` +
      `${rows[1]?.spec_sha.slice(0, 12)}…, bytes ${bytesA.length}/${bytesB.length}, ` +
      `own order_ref: ${textA.includes('ORD-ALICE-1001')}/${textB.includes('ORD-BOB-2002')}\n`,
  );
});

// ---------------------------------------------------------------------------------
// W2 — the cache is keyed on the rendered spec, so a repeat is free
// ---------------------------------------------------------------------------------

test('W2. the same buyer twice reuses one render: one row, one path, identical bytes', async () => {
  const buyer = await issue('carol@example.com', 'ORD-CAROL-3003');

  const one = await download(buyer.code);
  assert.equal(one.status, 200, one.body);
  const uri = uriOf(one);
  const file = join(contentRoot, 'protected', uri.slice('/__protected/'.length));
  const before = readFileSync(file);
  const beforeStat = statSync(file);
  const rowsBefore = renders().length;

  const two = await download(buyer.code);
  assert.equal(two.status, 200, two.body);
  assert.equal(uriOf(two), uri, 'the second request hands off the same render');
  const afterBytes = readFileSync(file);
  assert.equal(sha256(afterBytes), sha256(before), 'the bytes are identical');
  assert.equal(statSync(file).mtimeMs, beforeStat.mtimeMs, 'the file was reused, not rewritten');
  assert.equal(renders().length, rowsBefore, 'no second row for the same spec');

  const mine = renders().filter((r) => r.asset_id === bookId && r.path === `content/protected${uri.slice('/__protected'.length)}`);
  assert.equal(mine.length, 1, 'exactly one row names this render');

  process.stdout.write(
    `# W2 2 downloads -> 1 render, 1 row, sha256 ${sha256(before).slice(0, 12)}…, mtime unchanged\n`,
  );
});

// ---------------------------------------------------------------------------------
// W3 — the hand-off, and the two constants the shipped build uses
// ---------------------------------------------------------------------------------

test('W3 — the handed-off path is under content/protected/, never content/media/', async () => {
  assert.equal(STAMP_BUDGET_MS, 2000, '§7.5: the wall-clock budget is 2000 ms');
  assert.equal(STAMP_CONCURRENCY, 8, '§7.5: the per-tenant semaphore is 8');

  // The worker the shipped path loads must exist in both worlds: `.ts` under the runner
  // and `.js` from `dist/`. A hard-coded `.ts` would 503 every download in production,
  // and that is not a failure a functional test on the source tree can see.
  const fromTs = stampWorkerUrl(new URL('../app/download/render.ts', import.meta.url).href);
  assert.match(fromTs.pathname, /\/app\/download\/stamp-worker\.ts$/);
  assert.ok(existsSync(fileURLToPath(fromTs)), `the worker does not exist: ${fromTs.pathname}`);
  const fromDist = stampWorkerUrl(new URL('../dist/app/download/render.js', import.meta.url).href);
  assert.match(fromDist.pathname, /\/dist\/app\/download\/stamp-worker\.js$/);

  const buyer = await issue('dave@example.com', 'ORD-DAVE-4004');
  const res = await download(buyer.code);
  assert.equal(res.status, 200, res.body);
  const uri = uriOf(res);

  assert.match(uri, /^\/__protected\/wm\//, `hand-off is not the wm location: ${uri}`);
  assert.ok(!uri.includes('content/media'), 'the media tree must never be the hand-off');
  assert.notEqual(uri, `/__protected/${bookSha.slice(0, 2)}/${bookSha}.pdf`, 'the store blob was handed off');
  assert.ok(uri.endsWith('.pdf'));

  const onDisk = join(contentRoot, 'protected', uri.slice('/__protected/'.length));
  assert.ok(existsSync(onDisk), `the hand-off names a file that is not there: ${onDisk}`);
  assert.notEqual(
    onDisk,
    join(contentRoot, 'media', bookSha.slice(0, 2), `${bookSha}.pdf`),
    'the hand-off resolves to the media tree',
  );
  assert.ok(statSync(onDisk).size > 0);

  // The source blob is still the store's file, untouched: a render is a second location,
  // not a rewrite of the asset.
  assert.equal(
    sha256(readFileSync(join(contentRoot, 'media', bookSha.slice(0, 2), `${bookSha}.pdf`))),
    bookSha,
    'the stored blob is unchanged',
  );
  process.stdout.write(`# W3 x-accel ${uri.slice(0, 40)}… -> ${statSync(onDisk).size} B under content/protected/\n`);
});

// ---------------------------------------------------------------------------------
// W4/W5 — the fail-closed pair
// ---------------------------------------------------------------------------------

async function appWith(watermark: {
  budgetMs?: number;
  render?: () => Promise<Buffer>;
  globalConcurrency?: number;
  globalGate?: StampGate;
}): Promise<{
  appPort: number;
  handle: AppHandle;
  close: () => Promise<void>;
}> {
  const extra = await buildApp({
    env: loadEnv(fixture.env),
    contentRoot,
    downloadLimits: { refusals: 10_000, all: 10_000 },
    watermark: {
      budgetMs: watermark.budgetMs ?? STAMP_BUDGET_MS,
      ...(watermark.render === undefined ? {} : { render: watermark.render }),
      ...(watermark.globalConcurrency === undefined ? {} : { globalConcurrency: watermark.globalConcurrency }),
      ...(watermark.globalGate === undefined ? {} : { globalGate: watermark.globalGate }),
    },
  });
  const p = await extra.app.listen({ port: 0, host: '127.0.0.1' }).then(() => {
    const address = extra.app.server.address();
    return typeof address === 'object' && address !== null ? address.port : 0;
  });
  return { appPort: p, handle: extra, close: () => extra.close() };
}

test('W4 — a stamp failure is 503, writes denied_watermark, and emits no X-Accel-Redirect', async () => {
  const broken = await appWith({
    render: async () => {
      throw new Error('renderer exploded');
    },
  });
  try {
    const buyer = await issue('erin@example.com', 'ORD-ERIN-5005');
    const before = renders().length;
    const redeemed = await call({
      port: broken.appPort,
      path: '/d/acme',
      method: 'POST',
      host: HOST,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: buyer.code }),
    });
    assert.equal(redeemed.status, 303, redeemed.body);
    const res = await call({
      port: broken.appPort,
      path: '/d/acme/file',
      host: HOST,
      headers: { cookie: cookieOf(redeemed) },
    });

    assert.equal(res.status, 503, res.body);
    assert.equal((res.json as { error: { code: string } }).error.code, 'SKW_E_SEC_WATERMARK_FAILED');
    assert.equal(header(res, 'x-accel-redirect'), undefined, 'a failed stamp must not hand off anything');
    assert.equal(header(res, 'content-disposition'), undefined);
    assert.ok(!res.body.includes('chapter'), 'the JSON body carries no file bytes');
    assert.ok(!res.body.includes('%PDF'));

    const rows = events(buyer.id);
    assert.equal(rows.length, 1, `expected one ledger row, got ${JSON.stringify(rows)}`);
    assert.equal(rows[0]?.kind, 'first');
    assert.equal(rows[0]?.outcome, 'denied_watermark');
    assert.equal(rows[0]?.bytes_declared, 0, 'nothing was authorised');

    assert.equal(db((c) => Number((c.prepare(`SELECT uses FROM cms_download_code WHERE id = ?`).get(buyer.id) as { uses: number }).uses)), 0, 'a failure does not burn the use');
    assert.equal(renders().length, before, 'no render row was written');

    // The media blob is still not reachable by URL through this app: there is no route.
    const direct = await call({ port: broken.appPort, path: `/__protected/${bookSha.slice(0, 2)}/${bookSha}.pdf`, host: HOST });
    assert.equal(direct.status, 404, 'the media tree is nginx-internal, not an app route');

    // A retry under the same token is still a denial, not a second chance: a denial is
    // not a continuation (C4).
    const retry = await call({
      port: broken.appPort,
      path: '/d/acme/file',
      host: HOST,
      headers: { cookie: cookieOf(redeemed) },
    });
    assert.equal(retry.status, 503, retry.body);
    assert.equal(header(retry, 'x-accel-redirect'), undefined);
    assert.equal(events(buyer.id).length, 1, 'the denial row is not duplicated');

    process.stdout.write(
      `# W4 forced renderer error -> ${res.status} ${(res.json as { error: { code: string } }).error.code}, ` +
        `x-accel ${String(header(res, 'x-accel-redirect'))}, outcome ${rows[0]?.outcome}, uses 0\n`,
    );
  } finally {
    await broken.close();
  }
});

test('W5 — a render that overruns the budget takes the same denial path', async () => {
  const stuck = await appWith({ budgetMs: 40, render: () => new Promise<Buffer>(() => {}) });
  try {
    const buyer = await issue('frank@example.com', 'ORD-FRANK-6006');
    const started = Date.now();
    const redeemed = await call({
      port: stuck.appPort,
      path: '/d/acme',
      method: 'POST',
      host: HOST,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: buyer.code }),
    });
    const res = await call({
      port: stuck.appPort,
      path: '/d/acme/file',
      host: HOST,
      headers: { cookie: cookieOf(redeemed) },
    });
    const elapsed = Date.now() - started;

    assert.equal(res.status, 503, res.body);
    assert.equal((res.json as { error: { code: string } }).error.code, 'SKW_E_SEC_WATERMARK_FAILED');
    assert.equal(header(res, 'x-accel-redirect'), undefined, 'a timed-out stamp must not hand off');
    const rows = events(buyer.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.outcome, 'denied_watermark');
    assert.ok(elapsed < 3000, `the budget did not bound the response: ${elapsed} ms`);
    process.stdout.write(
      `# W5 budget 40 ms (shipped ${STAMP_BUDGET_MS}) -> 503 ${(res.json as { error: { code: string } }).error.code} ` +
        `in ${elapsed} ms, x-accel ${String(header(res, 'x-accel-redirect'))}, outcome ${rows[0]?.outcome}\n`,
    );
  } finally {
    await stuck.close();
  }
});

// ---------------------------------------------------------------------------------
// W6 — the semaphore
// ---------------------------------------------------------------------------------

test('W6. 16 concurrent stamps never exceed 8 in flight', async () => {
  let active = 0;
  let peak = 0;
  const capped = await appWith({
    render: async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active -= 1;
      return makePdf(1);
    },
  });
  try {
    const codes = [];
    for (let i = 0; i < 16; i += 1) codes.push(await issue(`buyer${i}@example.com`, `ORD-SEM-${i}`));

    const results = await Promise.all(
      codes.map(async (c) => {
        const conn = siteDb();
        try {
          const asset = assetById(conn, bookId);
          assert.ok(asset !== null);
          return await capped.handle.watermark.ensure({
            tenantKey: 'acme',
            db: conn,
            asset,
            code: {
              id: c.id,
              email: `buyer${c.id}@example.com`,
              orderRef: `ORD-SEM-${c.id}`,
              issuedAt: new Date().toISOString(),
              selector: c.code.slice(0, 4),
            },
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          });
        } finally {
          conn.close();
        }
      }),
    );

    assert.equal(results.length, 16);
    assert.ok(peak <= STAMP_CONCURRENCY, `peak in-flight was ${peak}, above the cap of ${STAMP_CONCURRENCY}`);
    assert.equal(peak, STAMP_CONCURRENCY, `the cap was never reached (peak ${peak}); the test proves nothing`);
    // E-27: the box's ceiling is min(8, max(4, availableParallelism())), and the shipped
    // app must be running under exactly that number.
    const shipped = Math.min(STAMP_CONCURRENCY, globalStampConcurrency());
    assert.equal(capped.handle.watermark.globalCapacity, globalStampConcurrency(), 'the process cap is max(4, cores)');
    process.stdout.write(
      `# W6 16 concurrent stamps -> peak in flight ${peak} (tenant cap ${STAMP_CONCURRENCY}, ` +
        `global cap ${capped.handle.watermark.globalCapacity}, effective ${shipped})\n`,
    );
  } finally {
    await capped.close();
  }
});

test('W6b. E-27: two tenants of 8, injected global capacity 4, peak across both is 4', async () => {
  // D33's number on a small box, made deterministic: the global cap binds before either
  // tenant's eight does, so no request from either tenant can be the fifth worker.
  let active = 0;
  let peak = 0;
  const capped = await appWith({
    globalConcurrency: 4,
    render: async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return makePdf(1);
    },
  });
  try {
    const acme = [];
    const beta = [];
    for (let i = 0; i < 8; i += 1) {
      acme.push(await issue(`a${i}@example.com`, `ORD-A-${i}`));
      beta.push(await issueFor('beta', `b${i}@example.com`, `ORD-B-${i}`, 'vault/book'));
    }

    const one = async (tenantKey: string, code: Issued, assetId: number): Promise<unknown> => {
      const conn = openAdminWrite(fixture.sitePath(tenantKey));
      try {
        const asset = assetById(conn, assetId);
        assert.ok(asset !== null, `${tenantKey} has no asset ${assetId}`);
        return await capped.handle.watermark.ensure({
          tenantKey,
          db: conn,
          asset,
          code: {
            id: code.id,
            email: `${tenantKey}-${code.id}@example.com`,
            orderRef: `ORD-${tenantKey}-${code.id}`,
            issuedAt: new Date().toISOString(),
            selector: code.code.slice(0, 4),
          },
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        });
      } finally {
        conn.close();
      }
    };

    const results = await Promise.all([
      ...acme.map((c) => one('acme', c, bookId)),
      ...beta.map((c) => one('beta', c, betaBookId)),
    ]);
    assert.equal(results.length, 16, 'all sixteen requests settle');
    assert.ok(peak <= 4, `peak in flight across two tenants was ${peak}, above the injected global cap of 4`);
    assert.equal(peak, 4, `the global cap was never reached (peak ${peak}); the test proves nothing`);
    assert.equal(capped.handle.watermark.peakGlobalInFlight(), 4);
    assert.ok(capped.handle.watermark.peakInFlight('acme') <= 4);
    assert.ok(capped.handle.watermark.peakInFlight('beta') <= 4);
    process.stdout.write(
      `# W6b two tenants x 8 -> global peak ${peak} (cap 4); per tenant acme ` +
        `${capped.handle.watermark.peakInFlight('acme')} beta ${capped.handle.watermark.peakInFlight('beta')}\n`,
    );
  } finally {
    await capped.close();
  }
});

test('W14. a request still queued at the deadline is refused with reason=queue and no worker', async () => {
  // One process-global slot shared by two stores. The holder's budget is 300 ms and the
  // waiter's is 40: with a *uniform* budget a waiter is always granted a slot at the exact
  // instant its own deadline passes, so `reason='queue'` needs a holder that outlasts it —
  // which is what a second store with a different budget is, and what D33's shared box cap
  // is in production.
  const gate = new StampGate(1);
  const never = (): Promise<Buffer> => new Promise<Buffer>(() => {});
  const holder = await appWith({ budgetMs: 300, globalGate: gate, render: never });
  const waiter = await appWith({ budgetMs: 40, globalGate: gate, render: never });
  try {
    const rendersBefore = db((conn) => Number((conn.prepare(`SELECT COUNT(*) AS n FROM cms_watermark_render`).get() as { n: number }).n));

    const a = await issue('holder@example.com', 'ORD-QUEUE-A');
    const heldRedeem = await call({
      port: holder.appPort,
      path: '/d/acme',
      method: 'POST',
      host: HOST,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: a.code }),
    });
    assert.equal(heldRedeem.status, 303, heldRedeem.body);
    // Start the holder and give it time to take the only slot.
    const held = call({
      port: holder.appPort,
      path: '/d/acme/file',
      host: HOST,
      headers: { cookie: cookieOf(heldRedeem) },
    });
    await new Promise((resolve) => setTimeout(resolve, 60));

    const b = await issue('queued@example.com', 'ORD-QUEUE-B');
    const queuedRedeem = await call({
      port: waiter.appPort,
      path: '/d/acme',
      method: 'POST',
      host: HOST,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: b.code }),
    });
    assert.equal(queuedRedeem.status, 303, queuedRedeem.body);

    const started = Date.now();
    const refused = await call({
      port: waiter.appPort,
      path: '/d/acme/file',
      host: HOST,
      headers: { cookie: cookieOf(queuedRedeem) },
    });
    const waited = Date.now() - started;

    assert.equal(refused.status, 503, refused.body);
    const body = refused.json as { error: { code: string; detail?: Record<string, unknown> } };
    assert.equal(body.error.code, 'SKW_E_SEC_WATERMARK_FAILED');
    assert.equal(body.error.detail?.reason, 'queue', 'a refusal consumed by queueing must say so');
    assert.equal(body.error.detail?.budget_ms, 40);
    assert.ok(Number(body.error.detail?.queued_ms) >= 30, `queued_ms ${String(body.error.detail?.queued_ms)}`);
    assert.equal(header(refused, 'x-accel-redirect'), undefined, 'no worker, no hand-off');
    assert.equal(header(refused, 'content-disposition'), undefined);

    const rows = events(b.id);
    assert.equal(rows.length, 1, `expected exactly one ledger row, got ${JSON.stringify(rows)}`);
    assert.equal(rows[0]?.kind, 'first');
    assert.equal(rows[0]?.outcome, 'denied_watermark');
    assert.equal(rows[0]?.bytes_declared, 0);
    assert.equal(
      db((c) => Number((c.prepare(`SELECT uses FROM cms_download_code WHERE id = ?`).get(b.id) as { uses: number }).uses)),
      0,
      'a queued refusal spends nothing',
    );
    const rendersAfter = db((conn) => Number((conn.prepare(`SELECT COUNT(*) AS n FROM cms_watermark_render`).get() as { n: number }).n));
    assert.equal(rendersAfter, rendersBefore, 'no render row, because no worker started');

    // A retry under the same jti is still a denial: C-4, a denial is not a continuation.
    const retry = await call({
      port: waiter.appPort,
      path: '/d/acme/file',
      host: HOST,
      headers: { cookie: cookieOf(queuedRedeem) },
    });
    assert.equal(retry.status, 503, retry.body);
    assert.equal(events(b.id).length, 1, 'the denial row is not duplicated');
    assert.ok(waited < 400, `the queue deadline did not bound the response: ${waited} ms (budget 40)`);

    // The holder, on the same gate with eight times the budget, is a *timeout*, not a queue
    // refusal: it got the slot and ran out of time. One code path, two honest reasons.
    const holderRes = await held;
    const holderBody = holderRes.json as { error: { code: string; detail?: Record<string, unknown> } };
    assert.equal(holderRes.status, 503);
    assert.equal(holderBody.error.code, 'SKW_E_SEC_WATERMARK_FAILED');
    assert.equal(holderBody.error.detail?.reason, 'timeout');

    process.stdout.write(
      `# W14 global cap 1; holder budget 300 ms -> 503 timeout; waiter budget 40 ms -> 503 ` +
        `reason=queue after ${waited} ms (queued_ms ${String(body.error.detail?.queued_ms)}), one denied_watermark row, uses 0, no render\n`,
    );
  } finally {
    await waiter.close();
    await holder.close();
  }
});

// ---------------------------------------------------------------------------------
// W7 — expiry, the sweep, and re-stamping
// ---------------------------------------------------------------------------------

test('W7. a render past expires_at is swept, and the next request re-stamps rather than 404ing', async () => {
  const buyer = await issue('gina@example.com', 'ORD-GINA-7007');
  const first = await download(buyer.code);
  assert.equal(first.status, 200, first.body);
  const uri = uriOf(first);
  const file = join(contentRoot, 'protected', uri.slice('/__protected/'.length));
  assert.ok(existsSync(file));

  const past = new Date(Date.now() - 60_000).toISOString();
  db((conn) => conn.prepare(`UPDATE cms_watermark_render SET expires_at = ? WHERE path = ?`).run(past, `content/protected${uri.slice('/__protected'.length)}`));

  const swept = db((conn) => handle.watermark.sweep(conn, Date.now()));
  assert.equal(swept.rows, 1, `the sweep deleted ${swept.rows} rows`);
  assert.equal(swept.files, 1, `the sweep deleted ${swept.files} files`);
  assert.ok(!existsSync(file), 'the expired render file is still on disk');

  // The row that produced it is gone; a fresh redemption stamps again rather than
  // handing off a path that no longer exists.
  const again = await download(buyer.code);
  assert.equal(again.status, 200, again.body);
  const uri2 = uriOf(again);
  assert.equal(uri2, uri, 'same spec, same path — the cache is the spec hash, not a counter');
  assert.ok(existsSync(file), 'the re-stamp did not write the file back');
  assert.equal(renders().filter((r) => r.path === `content/protected${uri.slice('/__protected'.length)}`).length, 1);

  process.stdout.write(
    `# W7 sweep -> rows ${swept.rows}, files ${swept.files}; next request re-stamped ${uri2.slice(0, 34)}… -> 200\n`,
  );
});
// ---------------------------------------------------------------------------------
// W13 — the render's lifetime follows cexp, not exp (E-26)
// ---------------------------------------------------------------------------------

test('W13. a render expires at cexp + grace, and a request past cexp writes no render', async () => {
  const buyer = await issue('hana@example.com', 'ORD-HANA-1313');
  const redeemed = await redeem(buyer.code);
  assert.equal(redeemed.status, 303, redeemed.body);
  const cookie = cookieOf(redeemed);
  const token = cookie.slice(cookie.indexOf('=') + 1);
  const claims = JSON.parse(Buffer.from(token.split('.')[1] as string, 'base64url').toString('utf8')) as {
    jti: string;
    iat: number;
    exp: number;
    cexp: number;
  };
  // The two expiries are what the arithmetic below is about: 600 s and 21 600 s.
  assert.equal(claims.exp - claims.iat, 600);
  assert.equal(claims.cexp - claims.iat, 21_600);

  const res = await call({ port, path: '/d/acme/file', host: HOST, headers: { cookie } });
  assert.equal(res.status, 200, res.body);
  const uri = uriOf(res);
  const relPath = `content/protected${uri.slice('/__protected'.length)}`;

  const row = db(
    (conn) =>
      conn.prepare(`SELECT expires_at FROM cms_watermark_render WHERE path = ?`).get(relPath) as
        | { expires_at: string }
        | undefined,
  );
  assert.ok(row !== undefined, 'the download wrote no render row');

  // The assertion row 9 never had: the value written at stamp time, against the token's
  // own claims. E-26 makes it `cexp + grace`; `exp + grace` is six hours *earlier*, and a
  // sweep at that instant would delete the file under a transfer that started at cexp.
  assert.equal(Date.parse(row.expires_at), (claims.cexp + 21_600) * 1000, 'expires_at must be cexp + grace');
  assert.notEqual(
    Date.parse(row.expires_at),
    (claims.exp + 21_600) * 1000,
    'expires_at must not be exp + grace — that is the bug E-26 closes',
  );

  // A request past `cexp` never reaches the stamp: verifyToken refuses before the database
  // is opened, so no render row and no ledger row can be written for it.
  const rendersBefore = db((conn) => Number((conn.prepare(`SELECT COUNT(*) AS n FROM cms_watermark_render`).get() as { n: number }).n));
  const eventsBefore = db((conn) => Number((conn.prepare(`SELECT COUNT(*) AS n FROM cms_download_event`).get() as { n: number }).n));
  const key = loadEnv(fixture.env).downloadTokenKey;
  const nowS = Math.floor(Date.now() / 1000);
  const dead = mintToken(key, {
    ...claims,
    iat: nowS - 30_000,
    exp: nowS - 29_400,
    cexp: nowS - 20_000,
  } as never);
  const past = await call({
    port,
    path: '/d/acme/file',
    host: HOST,
    headers: { cookie: `${cookieName('acme')}=${dead}` },
  });
  assert.equal(past.status, 401, past.body);
  assert.equal(
    (past.json as { error: { detail?: { reason?: string } } }).error.detail?.reason,
    'continuation_expired',
  );
  assert.equal(
    db((conn) => Number((conn.prepare(`SELECT COUNT(*) AS n FROM cms_watermark_render`).get() as { n: number }).n)),
    rendersBefore,
    'a request past cexp wrote a render row',
  );
  assert.equal(
    db((conn) => Number((conn.prepare(`SELECT COUNT(*) AS n FROM cms_download_event`).get() as { n: number }).n)),
    eventsBefore,
    'a request past cexp reached the database',
  );

  process.stdout.write(
    `# W13 exp=iat+600 cexp=iat+21600; expires_at - cexp = ${(Date.parse(row.expires_at) / 1000 - claims.cexp)} s ` +
      `(and cexp - exp = ${claims.cexp - claims.exp} s, so exp+grace would be 6 h early); past-cexp 401 writes no row\n`,
  );
});

// ---------------------------------------------------------------------------------
// W8 — cp1252, and why the order_ref is the thing that survives
// ---------------------------------------------------------------------------------

test('W8. a CJK name is sanitised to cp1252 in the footer while order_ref stays intact', async () => {
  const buyer = await issue('张三@例え.jp', 'ORD-8123-XYZ');
  const res = await download(buyer.code);
  assert.equal(res.status, 200, res.body);
  const file = join(contentRoot, 'protected', uriOf(res).slice('/__protected/'.length));
  const bytes = readFileSync(file);
  const text = pdfDrawnText(bytes);

  assert.ok(text.includes('ORD-8123-XYZ'), `the ASCII order_ref did not survive:\n${text}`);
  assert.ok(text.includes('??@??.jp'), `the CJK address was not sanitised to '?':\n${text}`);
  assert.ok(!/[\u4e00-\u9fff]/.test(text), 'a CJK character reached the footer');
  assert.ok(isCp1252(text), 'a character outside cp1252 reached the footer');

  const doc = await PDFDocument.load(bytes);
  assert.equal(doc.getPageCount(), 2);

  process.stdout.write(`# W8 footer "${text.trim().split('\n').slice(-1)[0]}" — order_ref intact, isCp1252=${isCp1252(text)}\n`);
});

// ---------------------------------------------------------------------------------
// W9 — one sanitiser
// ---------------------------------------------------------------------------------

test('W9. the cp1252 sanitiser preserves, transliterates, and only then substitutes', () => {
  assert.equal(sanitiseCp1252('München · Øyvind Ærø'), 'München · Øyvind Ærø');
  assert.equal(sanitiseCp1252('€ “quoted” – dash … ¥ £ © ° ÷'), '€ “quoted” – dash … ¥ £ © ° ÷');
  assert.equal(sanitiseCp1252('a → b'), 'a -> b');
  assert.equal(sanitiseCp1252('done ✓'), 'done [ok]');
  assert.equal(sanitiseCp1252('张三'), '??');
  assert.equal(sanitiseCp1252('buyer😀@example.com'), 'buyer?@example.com');
  assert.equal(sanitiseCp1252('line\r\nbreak'), 'line break');
  for (const input of ['München', '张三', '😀', '→', 'Œuvre', 'ﬁ']) {
    assert.ok(isCp1252(sanitiseCp1252(input)), `sanitised(${input}) is not cp1252`);
  }
  process.stdout.write('# W9 sanitiser: "München · Øyvind Ærø" preserved, "→" -> "->", "张三" -> "??"\n');
});

// ---------------------------------------------------------------------------------
// W10 — the second tree, and the bundle invariant
// ---------------------------------------------------------------------------------

test('W10 — no render is reachable from content/public, and every render lives under content/protected', async () => {
  const pub = join(contentRoot, 'public');
  if (existsSync(pub)) {
    for (const entry of readdirSync(pub)) {
      const full = join(pub, entry);
      let target = '';
      try {
        target = readlinkSync(full);
      } catch {
        continue;
      }
      assert.ok(!target.includes('protected/wm'), `a public link points at a render: ${entry} -> ${target}`);
    }
  }

  for (const row of renders()) {
    assert.ok(row.path.startsWith('content/protected/wm/'), `a render escaped the wm tree: ${row.path}`);
    assert.ok(!row.path.startsWith('content/media/'), 'a render was written into the store');
  }
  assert.ok(picSha.length === 64);
  process.stdout.write(`# W10 ${renders().length} renders, all under content/protected/wm/, no public link to one\n`);
});

test('W11 — a format no renderer claims keeps the S3c hand-off, and the boundary is named', async () => {
  // §7.5's coverage list is PDF and images. An archive is **not** stamped in v1, and this
  // case exists so that boundary is asserted rather than assumed: a gated zip is handed
  // off from `content/media/`, exactly as S3c did, because no renderer claims it. The
  // issue screen already marks it not watermarkable, so the operator was told; the
  // alternative (503 for every video) would deny paying customers for a product gap.
  // Flagged for S3-QA: this is the one path where a gated byte is served un-stamped.
  const zip = Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    Buffer.alloc(26, 0),
    Buffer.from('PK\x05\x06', 'latin1'),
    Buffer.alloc(18, 0),
  ]);
  const uploaded = await upload('vault/pack', 'pack.zip', zip);
  assert.equal(stampable({ sha256: uploaded.sha, kind: 'archive', mime: 'application/zip', filename: 'pack.zip' }), null);

  const buyer = await issue('jules@example.com', 'ORD-ZIP-9009', 'vault/pack');
  const res = await download(buyer.code);
  assert.equal(res.status, 200, res.body);
  const uri = uriOf(res);
  assert.equal(uri, `/__protected/${uploaded.sha.slice(0, 2)}/${uploaded.sha}.zip`, 'the archive path is S3c\'s');
  assert.ok(!uri.includes('/wm/'), 'an archive has no render to hand off');
  assert.equal(renders().filter((r) => r.source_sha === uploaded.sha).length, 0, 'no render row for an archive');
  process.stdout.write(`# W11 archive -> ${uri.slice(0, 44)}… (not stampable in v1, no render row)\n`);
});

test('W12 — an image is stamped with sharp and handed off from the wm tree', async () => {
  const a = await issue('hana@example.com', 'ORD-IMG-A', 'vault/pic');
  const b = await issue('ivan@example.com', 'ORD-IMG-B', 'vault/pic');
  for (const issued of [a, b]) {
    const res = await download(issued.code);
    assert.equal(res.status, 200, res.body);
    assert.match(uriOf(res), /^\/__protected\/wm\/[0-9a-f]{64}\/[0-9a-f]{64}\.png$/);
  }
  const rows = renders().filter((r) => r.source_sha === picSha);
  assert.equal(rows.length, 2, 'two buyers, two image renders');
  const one = readFileSync(abs(rows[0]!.path));
  const two = readFileSync(abs(rows[1]!.path));
  assert.notEqual(sha256(one), sha256(two), 'the two image renders differ');
  const meta = await sharp(one).metadata();
  assert.equal(meta.width, 320);
  assert.equal(meta.format, 'png');
  process.stdout.write(`# W12 image renders ${one.length}/${two.length} B, png 320x240, 2 spec hashes\n`);
});
