/**
 * QA S3 round 2 / B, second half — **where the cliff is, and what a refusal costs the buyer.**
 *
 * The first probe measured N buyers per minute and a 40-buyer burst. This one walks the
 * burst size up to find the largest number of simultaneous legitimate buyers this box
 * serves without a single 503, and then checks the ledger at the refusal: a buyer who is
 * refused must be left with `uses = 0` and exactly one `denied_watermark` row, so the 503
 * costs a retry and not an entitlement.
 *
 * Also prints the **store's** own `peakGlobalInFlight()`, which is the number D33 bounds.
 * (The injected renderer's counter can exceed it once requests start timing out, because an
 * injected renderer cannot be terminated the way the shipped worker can — that is stated in
 * the report rather than reported as a cap breach.)
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import type Database from 'better-sqlite3';
import { PDFDocument, StandardFonts } from 'pdf-lib';

import { uploadAsset } from '../../app/assets/library.ts';
import { openAdminWrite } from '../../app/db/classes.ts';
import { loadEnv } from '../../app/env.ts';
import { buildApp, type AppHandle } from '../../app/main.ts';
import { issueCode, seedSettings } from '../../app/download/code.ts';
import { makeFixture, type Fixture } from '../../test/helpers/fixture.ts';
import { call, header, type Res } from '../../test/helpers/http.ts';

const HOST = 'acme.test';
const out = (s: string): void => process.stdout.write(`${s}\n`);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function makePdf(pages: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i += 1) doc.addPage([612, 792]).drawText(`p${i}`, { x: 72, y: 700, size: 12, font });
  return Buffer.from(await doc.save());
}

interface Issued {
  id: number;
  code: string;
}

const fixture: Fixture = makeFixture({ specs: [{ key: 'acme', hosts: [HOST], title: 'Acme' }] });
const contentRoot = join(fixture.dir, 'content');
mkdirSync(contentRoot, { recursive: true });

let renders = 0;
async function renderer(): Promise<Buffer> {
  const ms = 300 + Math.floor(Math.random() * 501);
  renders += 1;
  await sleep(ms);
  return makePdf(1);
}

let handle: AppHandle;
let port = 0;

const cookieOf = (res: Res): string => {
  const raw = String(header(res, 'set-cookie') ?? '');
  return raw.slice(0, raw.indexOf(';'));
};
const reasonOf = (res: Res): string =>
  String((res.json as { error?: { detail?: { reason?: string } } } | undefined)?.error?.detail?.reason ?? '');

function db<T>(fn: (conn: Database.Database) => T): T {
  const conn = openAdminWrite(fixture.sitePath('acme'));
  try {
    return fn(conn);
  } finally {
    conn.close();
  }
}

async function issue(n: number): Promise<Issued> {
  const conn = openAdminWrite(fixture.sitePath('acme'));
  try {
    const row = await issueCode({ db: conn, contentRoot, assetKey: 'vault/book', email: `burst${n}@example.com`, orderRef: `ORD-BURST-${n}` });
    return { id: row.id, code: row.code };
  } finally {
    conn.close();
  }
}

async function burst(n: number, offset: number): Promise<void> {
  const items: Issued[] = [];
  for (let i = 0; i < n; i += 1) items.push(await issue(offset * 1000 + i));
  // Mint all cookies first so the burst is downloads, not argon2 verifications.
  const cookies: string[] = [];
  for (const item of items) {
    const minted = await call({
      port,
      path: '/d/acme',
      method: 'POST',
      host: HOST,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: item.code }),
    });
    cookies.push(cookieOf(minted));
  }
  renders = 0;
  const started = Date.now();
  const results = await Promise.all(
    items.map((_, i) =>
      call({ port, path: '/d/acme/file', host: HOST, headers: { cookie: cookies[i] as string } }).then((res) => ({
        status: res.status,
        reason: reasonOf(res),
        headers: res.headers,
      })),
    ),
  );
  const wall = Date.now() - started;
  const refusedIdx = results.map((r, i) => (r.status === 503 ? i : -1)).filter((i) => i >= 0);
  const refused = refusedIdx.length;
  const byReason: Record<string, number> = {};
  for (const i of refusedIdx) byReason[(results[i] as { reason: string }).reason] = (byReason[(results[i] as { reason: string }).reason] ?? 0) + 1;

  // What the refusal cost: uses and ledger rows for the refused buyers.
  let usesSum = 0;
  let deniedRows = 0;
  for (const i of refusedIdx) {
    const item = items[i] as Issued;
    usesSum += db((c) => Number((c.prepare(`SELECT uses FROM cms_download_code WHERE id = ?`).get(item.id) as { uses: number }).uses));
    deniedRows += db(
      (c) =>
        Number(
          (c.prepare(`SELECT COUNT(*) AS n FROM cms_download_event WHERE code_id = ? AND outcome = 'denied_watermark'`).get(item.id) as { n: number }).n,
        ),
    );
  }
  out(
    `${String(n).padStart(2)} simultaneous: served ${n - refused}/${n}, refused ${refused}` +
      `${refused === 0 ? '' : ` [${JSON.stringify(byReason)}]`} in ${wall} ms; renders ${renders}; ` +
      `store peakGlobalInFlight ${handle.watermark.peakGlobalInFlight()}; ` +
      `refused buyers: uses sum ${usesSum}, denied_watermark rows ${deniedRows}`,
  );
}

async function main(): Promise<void> {
  const pdf = await makePdf(2);
  const conn = openAdminWrite(fixture.sitePath('acme'));
  try {
    seedSettings(conn);
    await uploadAsset({
      db: conn,
      contentRoot,
      tenantKey: 'acme',
      key: 'vault/book',
      filename: 'book.pdf',
      bytes: pdf,
      quotaLimitBytes: 50_000_000,
      accessClass: 'gated',
    });
  } finally {
    conn.close();
  }
  handle = await buildApp({
    env: loadEnv(fixture.env),
    contentRoot,
    downloadLimits: { refusals: 1_000_000, all: 1_000_000 },
    // The shipped shape: per-tenant 8, process-global max(4, cores) = 8, budget 2000.
    watermark: { budgetMs: 2000, concurrency: 8, render: renderer },
  });
  out(`# global capacity ${handle.watermark.globalCapacity} (max(4, availableParallelism()))`);
  port = await handle.app.listen({ port: 0, host: '127.0.0.1' }).then(() => {
    const a = handle.app.server.address();
    return typeof a === 'object' && a !== null ? a.port : 0;
  });
  for (const [i, n] of [16, 24, 28, 32, 36, 40, 48].entries()) await burst(n, i);
  await handle.close();
  fixture.cleanup();
}

await main();
