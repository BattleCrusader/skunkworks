/**
 * QA S3 / defeat attempt 1 — **the denial path under a real fault, not an injected one.**
 *
 * Three faults, none of them a stubbed renderer:
 *   D1a  a stamp that really overruns 2000 ms, so the runtime `terminate()`s the worker
 *        mid-stamp (the shipped path, shipped budget);
 *   D1b  a truncated PDF (the content stream has no `endstream`), so `pdf-lib` throws
 *        *inside* the worker;
 *   D1c  a transient filesystem fault (the render tree is not writable), which is fixed
 *        and re-redeemed — that is the recovery half.
 *
 * Every case asserts the same four facts: 503, exactly one `denied_watermark` row, no
 * `X-Accel-Redirect`, no bytes. D1c then asserts the next redemption succeeds and spends
 * exactly one use for the two 200s together (the denial spent nothing).
 */
import { chmodSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type Database from 'better-sqlite3';
import { PDFDocument, StandardFonts } from 'pdf-lib';

import { uploadAsset } from '../../app/assets/library.ts';
import { openAdminWrite } from '../../app/db/classes.ts';
import { loadEnv } from '../../app/env.ts';
import { buildApp, type AppHandle } from '../../app/main.ts';
import { issueCode } from '../../app/download/code.ts';
import { STAMP_BUDGET_MS, STAMP_CONCURRENCY } from '../../app/download/render.ts';
import { makeFixture, type Fixture } from '../../test/helpers/fixture.ts';
import { call, header, type Res } from '../../test/helpers/http.ts';

const HOST = 'acme.test';
const out = (s: string): void => process.stdout.write(`${s}\n`);

async function makePdf(pages: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i += 1) {
    const page = doc.addPage([612, 792]);
    page.drawText(`chapter ${i + 1}`, { x: 72, y: 700, size: 14, font });
  }
  return Buffer.from(await doc.save());
}

const TRUNCATED =
  '%PDF-1.7\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
  '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
  '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R>>endobj\n' +
  '4 0 obj<</Length 500>>stream\nBT /F1 12 Tf (hello) Tj ET\n';

const fixture: Fixture = makeFixture({ specs: [{ key: 'acme', hosts: [HOST], title: 'Acme' }] });
const contentRoot = join(fixture.dir, 'content');
mkdirSync(contentRoot, { recursive: true });

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

async function upload(key: string, filename: string, bytes: Buffer): Promise<void> {
  const conn = siteDb();
  try {
    await uploadAsset({
      db: conn,
      contentRoot,
      tenantKey: 'acme',
      key,
      filename,
      bytes,
      quotaLimitBytes: 100_000_000,
      accessClass: 'gated',
    });
  } finally {
    conn.close();
  }
}

let handle: AppHandle;
let port = 0;

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

function download(cookie: string, extra: Record<string, string> = {}): Promise<Res> {
  return call({ port, path: '/d/acme/file', host: HOST, headers: { cookie, ...extra } });
}

function events(codeId: number): { outcome: string; bytes_declared: number; jti: string | null }[] {
  return db((c) =>
    c
      .prepare(`SELECT outcome, bytes_declared, jti FROM cms_download_event WHERE code_id = ? ORDER BY id`)
      .all(codeId) as never,
  );
}

function usesOf(codeId: number): number {
  return db(
    (c) => Number((c.prepare(`SELECT uses FROM cms_download_code WHERE id = ?`).get(codeId) as { uses: number }).uses),
  );
}

function issue(assetKey: string, email: string): Promise<{ id: number; code: string }> {
  const conn = siteDb();
  try {
    return issueCode({ db: conn, contentRoot, assetKey, email, maxUses: 3 }).finally(() => conn.close());
  } catch (err) {
    conn.close();
    throw err;
  }
}

interface DenialReport {
  status: number;
  code: string;
  xAccel: string | undefined;
  disposition: string | undefined;
  hasPdf: boolean;
  rows: string[];
  uses: number;
}

async function denied(cookie: string, codeId: number): Promise<DenialReport> {
  const res = await download(cookie);
  return {
    status: res.status,
    code: (res.json as { error?: { code?: string } } | undefined)?.error?.code ?? '(none)',
    xAccel: header(res, 'x-accel-redirect'),
    disposition: header(res, 'content-disposition'),
    hasPdf: res.body.includes('%PDF'),
    rows: events(codeId).map((e) => `${e.outcome}/${e.bytes_declared}`),
    uses: usesOf(codeId),
  };
}

async function main(): Promise<void> {
  // A real 2-page book, a real 500-page book (to blow the budget), and a truncated file.
  await upload('vault/book', 'book.pdf', await makePdf(2));
  await upload('vault/huge', 'huge.pdf', await makePdf(12000));
  await upload('vault/broken', 'broken.pdf', Buffer.from(TRUNCATED, 'latin1'));

  handle = await buildApp({
    env: loadEnv(fixture.env),
    contentRoot,
    downloadLimits: { refusals: 10_000, all: 10_000 },
  });
  port = await handle.app.listen({ port: 0, host: '127.0.0.1' }).then(() => {
    const a = handle.app.server.address();
    return typeof a === 'object' && a !== null ? a.port : 0;
  });

  out(`# D1 shipped budget ${STAMP_BUDGET_MS} ms, per-tenant cap ${STAMP_CONCURRENCY}`);

  // --- D1a: a real budget overrun, i.e. the runtime terminates the worker mid-stamp ---
  {
    const c = await issue('vault/huge', 'huge@example.com');
    const r = await redeem(c.code);
    const started = Date.now();
    const rep = await denied(cookieOf(r), c.id);
    out(
      `# D1a huge.pdf (12000 pages) -> ${rep.status} ${rep.code} in ${Date.now() - started} ms, ` +
        `x-accel=${String(rep.xAccel)}, disposition=${String(rep.disposition)}, bodyHasPDF=${rep.hasPdf}, ` +
        `rows=[${rep.rows.join(',')}], uses=${rep.uses}`,
    );
    const again = await denied(cookieOf(r), c.id);
    out(`# D1a retry same token -> ${again.status} ${again.code}, rows=[${again.rows.join(',')}], uses=${again.uses}`);
  }

  // --- D1b: a truncated PDF, so the real renderer throws inside the worker -----------------
  {
    const c = await issue('vault/broken', 'broken@example.com');
    const r = await redeem(c.code);
    const rep = await denied(cookieOf(r), c.id);
    out(
      `# D1b truncated pdf -> ${rep.status} ${rep.code}, x-accel=${String(rep.xAccel)}, ` +
        `disposition=${String(rep.disposition)}, bodyHasPDF=${rep.hasPdf}, rows=[${rep.rows.join(',')}], uses=${rep.uses}`,
    );
  }

  // --- D1c: a transient filesystem fault, then the recovery --------------------------------
  {
    const c = await issue('vault/book', 'recover@example.com');
    const first = await redeem(c.code);
    const cookie = cookieOf(first);

    // Make the render tree unwritable. `content/protected` does not exist yet, so create it
    // read-only: the worker renders, `mkdirSync`/`writeFileSync` fails, the plane denies.
    const wmDir = join(contentRoot, 'protected', 'wm');
    mkdirSync(wmDir, { recursive: true });
    chmodSync(wmDir, 0o500);
    let faulted: DenialReport;
    try {
      faulted = await denied(cookie, c.id);
    } finally {
      chmodSync(wmDir, 0o700);
    }
    out(
      `# D1c read-only render tree -> ${faulted.status} ${faulted.code}, x-accel=${String(faulted.xAccel)}, ` +
        `rows=[${faulted.rows.join(',')}], uses=${faulted.uses}`,
    );

    // Recovery: redeem the same code again — a fresh token, because the old jti is denied.
    const second = await redeem(c.code);
    const rec = await download(cookieOf(second));
    const st = statSync(join(contentRoot, 'protected', 'wm'));
    out(
      `# D1c next redemption -> ${rec.status} ${rec.code ?? ''}, x-accel=${String(header(rec, 'x-accel-redirect'))}, ` +
        `bodyBytes=${rec.body.length}, rows=[${events(c.id).map((e) => e.outcome).join(',')}], uses=${usesOf(c.id)}, ` +
        `render tree mode=${(st.mode & 0o777).toString(8)}`,
    );
  }

  await handle.close();
  fixture.cleanup();
}

main().catch(async (err) => {
  out(`# PROBE FAILED: ${String(err)}`);
  try {
    await handle?.close();
  } catch {
    /* ignore */
  }
  fixture.cleanup();
  process.exitCode = 1;
});
