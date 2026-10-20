/**
 * QA S3 / D33, second half — **does the 2 000 ms budget cover the queue?**
 *
 * §7.5's number is "a 2000 ms wall-clock budget". In `render.ts` the timer is created
 * *inside* the acquired semaphore slot (`#stamp`, after `.run()`), so a request queued
 * behind a saturated tenant waits for a slot with no deadline, and only then starts its
 * two seconds. E-27 (02-errata.md §12) calls this out and moves the budget to arrival.
 *
 * One tenant, cap 8 (the shipped number), a renderer that holds 700 ms, and 24 concurrent
 * first-downloads: three waves, so the last wave's requests spend ~1 400 ms queueing plus
 * 700 ms rendering — past the 2 000 ms budget, and still 200 if the budget does not cover
 * the wait.
 */
import { mkdirSync } from 'node:fs';
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
const N = 24;
const HOLD_MS = 700;
const out = (s: string): void => process.stdout.write(`${s}\n`);

async function makePdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([612, 792]).drawText('p', { x: 72, y: 700, size: 12, font });
  return Buffer.from(await doc.save());
}

const fixture: Fixture = makeFixture({ specs: [{ key: 'acme', hosts: [HOST], title: 'Acme' }] });
const contentRoot = join(fixture.dir, 'content');
mkdirSync(contentRoot, { recursive: true });

let active = 0;
let peak = 0;
async function renderer(): Promise<Buffer> {
  active += 1;
  peak = Math.max(peak, active);
  await new Promise((r) => setTimeout(r, HOLD_MS));
  active -= 1;
  return makePdf();
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

async function main(): Promise<void> {
  const db: Database.Database = openAdminWrite(fixture.sitePath('acme'));
  await uploadAsset({
    db,
    contentRoot,
    tenantKey: 'acme',
    key: 'vault/book',
    filename: 'book.pdf',
    bytes: await makePdf(),
    quotaLimitBytes: 50_000_000,
    accessClass: 'gated',
  });
  const codes: string[] = [];
  for (let i = 0; i < N; i += 1) {
    const row = await issueCode({ db, contentRoot, assetKey: 'vault/book', email: `q${i}@example.com`, orderRef: `ORD-Q-${i}`, maxUses: 3 });
    codes.push(row.code);
  }
  db.close();

  handle = await buildApp({
    env: loadEnv(fixture.env),
    contentRoot,
    downloadLimits: { refusals: 100_000, all: 100_000 },
    watermark: { render: renderer },
  });
  port = await handle.app.listen({ port: 0, host: '127.0.0.1' }).then(() => {
    const a = handle.app.server.address();
    return typeof a === 'object' && a !== null ? a.port : 0;
  });

  const cookies: string[] = [];
  for (const code of codes) {
    const r = await redeem(code);
    if (r.status !== 303) throw new Error(`redeem -> ${r.status}`);
    cookies.push(String(header(r, 'set-cookie') ?? '').split(';')[0] ?? '');
  }

  const t0 = performance.now();
  const results = await Promise.all(
    cookies.map(async (cookie) => {
      const s = performance.now();
      const r = await call({ port, path: '/d/acme/file', host: HOST, headers: { cookie } });
      return { status: r.status, ms: performance.now() - s };
    }),
  );
  const total = performance.now() - t0;
  const over = results.filter((r) => r.ms > STAMP_BUDGET_MS);
  const ok = results.filter((r) => r.status === 200).length;
  const sorted = [...results].map((r) => r.ms).sort((a, b) => a - b);
  out(
    `# D4b ${N} concurrent first-downloads, cap ${STAMP_CONCURRENCY}, renderer holds ${HOLD_MS} ms, budget ${STAMP_BUDGET_MS} ms`,
  );
  out(
    `# D4b all settled in ${total.toFixed(0)} ms; peak in flight ${peak}; 200s ${ok}/${N}; ` +
      `per-request min ${sorted[0]?.toFixed(0)} / p50 ${sorted[Math.floor(sorted.length / 2)]?.toFixed(0)} / max ${sorted.at(-1)?.toFixed(0)} ms`,
  );
  out(
    `# D4b requests whose TOTAL exceeded the ${STAMP_BUDGET_MS} ms budget: ${over.length}/${N} ` +
      `(statuses ${JSON.stringify([...new Set(over.map((r) => r.status))])}) — ` +
      `each waited for a slot before its timer started`,
  );

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
  process.exit(1);
});
