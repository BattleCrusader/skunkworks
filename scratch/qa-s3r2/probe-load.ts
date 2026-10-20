/**
 * QA S3 round 2 / item B — **the queue deadline's false-refusal rate at a realistic load.**
 *
 * The builder proved the fail-closed direction: 8 slots held, 24/24 refused with
 * `reason='queue'`. That is correct and it is also the shape of a product defect if a
 * legitimate burst of buyers meets it, because the buyer's observable is a 503.
 *
 * This probe measures the *other* direction on the shipped path: how many **legitimate**
 * first-downloads are refused with `503 SKW_E_SEC_WATERMARK_FAILED` at N buyers per minute,
 * for N in {10, 20, 40}, with a render that takes 300–800 ms — a realistic stamped PDF —
 * and the shipped 2 000 ms budget.
 *
 * Three arrival models, because "per minute" hides the one that matters:
 *   poisson      — independent exponential inter-arrivals at N/60 per second (the generous
 *                  reading of "N buyers per minute");
 *   cluster      — N buyers per minute, all of one minute's buyers arriving inside `windowS`
 *                  seconds (a campaign email landing: the shape a launch actually has);
 *   burst        — N buyers at the same instant (the worst case, and the only one the
 *                  builder measured).
 *
 * Every refusal is counted by `detail.reason`, so `queue` and `timeout` are reported
 * separately. A 200 is a download; a 503 is a buyer who saw an error page.
 *
 * The renderer is injected (`sleep`) so the service time is controlled. That is
 * **optimistic**: it holds a slot without burning a core, while a real `pdf-lib` worker
 * under eight-way concurrency does burn one (calibrated separately in
 * `probe-render-cost.ts`). The refusal rate here is therefore a floor, not a ceiling.
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

interface BuyerResult {
  status: number;
  reason: string;
  ms: number;
  arrivalOffsetMs: number;
}

const fixture: Fixture = makeFixture({ specs: [{ key: 'acme', hosts: [HOST], title: 'Acme' }] });
const contentRoot = join(fixture.dir, 'content');
mkdirSync(contentRoot, { recursive: true });

let handle: AppHandle;
let port = 0;

// --- the renderer: uniform 300–800 ms, and an instrument ---------------------------
const RENDER_MIN = 300;
const RENDER_MAX = 800;
let rendersStarted = 0;
let inFlight = 0;
let peakInFlight = 0;
const serviceTimes: number[] = [];

async function renderer(): Promise<Buffer> {
  const ms = RENDER_MIN + Math.floor(Math.random() * (RENDER_MAX - RENDER_MIN + 1));
  rendersStarted += 1;
  inFlight += 1;
  peakInFlight = Math.max(peakInFlight, inFlight);
  const t = Date.now();
  await sleep(ms);
  serviceTimes.push(Date.now() - t);
  inFlight -= 1;
  return makePdf(1);
}

function cookieOf(res: Res): string {
  const raw = String(header(res, 'set-cookie') ?? '');
  return raw.slice(0, raw.indexOf(';'));
}
const reason = (res: Res): string =>
  String((res.json as { error?: { detail?: { reason?: string } } } | undefined)?.error?.detail?.reason ?? '');

async function issue(email: string, orderRef: string): Promise<Issued> {
  const conn = openAdminWrite(fixture.sitePath('acme'));
  try {
    const row = await issueCode({ db: conn, contentRoot, assetKey: 'vault/book', email, orderRef });
    return { id: row.id, code: row.code };
  } finally {
    conn.close();
  }
}

/** One shopper: type the code, then download. The clock starts at the click. */
async function buyer(item: Issued, watchdogMs: number): Promise<BuyerResult> {
  const started = Date.now();
  const res = await Promise.race([
    (async (): Promise<Res> => {
      const minted = await call({
        port,
        path: '/d/acme',
        method: 'POST',
        host: HOST,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: item.code }),
      });
      if (minted.status !== 303) return minted;
      return call({ port, path: '/d/acme/file', host: HOST, headers: { cookie: cookieOf(minted) } });
    })(),
    sleep(watchdogMs).then(() => null),
  ]);
  const ms = Date.now() - started;
  if (res === null) return { status: -1, reason: 'HUNG', ms, arrivalOffsetMs: 0 };
  return { status: res.status, reason: reason(res), ms, arrivalOffsetMs: 0 };
}

interface Scenario {
  name: string;
  shape: 'poisson' | 'cluster' | 'burst';
  perMin?: number;
  seconds?: number;
  count?: number;
  windowS?: number;
}

function poissonGaps(count: number, perSecond: number): number[] {
  const gaps: number[] = [];
  let t = 0;
  for (let i = 0; i < count; i += 1) {
    t += -Math.log(1 - Math.random()) / perSecond;
    gaps.push(t);
  }
  return gaps;
}

async function run(scenario: Scenario, offset: number): Promise<void> {
  const budget = 2000;
  let items: Issued[];
  let offsetsMs: number[];

  if (scenario.shape === 'poisson') {
    const seconds = scenario.seconds as number;
    const perSecond = (scenario.perMin as number) / 60;
    // Draw a fixed count so the run length is deterministic; the count is what N/min means
    // over `seconds`, and the inter-arrivals are the model.
    const count = Math.round(perSecond * seconds);
    offsetsMs = poissonGaps(count, perSecond).map((s) => s * 1000);
    items = [];
    for (let i = 0; i < count; i += 1) items.push(await issue(`p${offset}_${i}@example.com`, `ORD-P-${offset}-${i}`));
  } else if (scenario.shape === 'cluster') {
    const count = scenario.count as number;
    const window = (scenario.windowS as number) * 1000;
    offsetsMs = Array.from({ length: count }, () => Math.random() * window).sort((a, b) => a - b);
    items = [];
    for (let i = 0; i < count; i += 1) items.push(await issue(`c${offset}_${i}@example.com`, `ORD-C-${offset}-${i}`));
  } else {
    const count = scenario.count as number;
    offsetsMs = Array.from({ length: count }, () => 0);
    items = [];
    for (let i = 0; i < count; i += 1) items.push(await issue(`b${offset}_${i}@example.com`, `ORD-B-${offset}-${i}`));
  }

  rendersStarted = 0;
  inFlight = 0;
  peakInFlight = 0;
  serviceTimes.length = 0;
  const startedAt = Date.now();
  const results = await Promise.all(
    items.map((item, i) =>
      (async (): Promise<BuyerResult> => {
        const wait = offsetsMs[i] as number;
        if (wait > 0) await sleep(wait);
        const r = await buyer(item, budget + 8000);
        return { ...r, arrivalOffsetMs: Math.round(wait) };
      })(),
    ),
  );
  const wall = Date.now() - startedAt;

  const served = results.filter((r) => r.status === 200);
  const refused = results.filter((r) => r.status === 503);
  const other = results.filter((r) => r.status !== 200 && r.status !== 503);
  const byReason: Record<string, number> = {};
  for (const r of refused) byReason[r.reason] = (byReason[r.reason] ?? 0) + 1;
  const lat = results.map((r) => r.ms).sort((a, b) => a - b);
  const pick = (p: number): number => lat[Math.min(lat.length - 1, Math.ceil((p / 100) * lat.length) - 1)] as number;
  const svc = [...serviceTimes].sort((a, b) => a - b);

  out(
    `# ${scenario.name}: ${items.length} buyers, wall ${wall} ms, served ${served.length}, refused ${refused.length} ` +
      `[${JSON.stringify(byReason)}], other ${other.length}${other.length > 0 ? ' ' + JSON.stringify(other.slice(0, 3)) : ''}`,
  );
  out(
    `# ${scenario.name}: REFUSED reason=queue ${byReason.queue ?? 0}/${items.length} = ` +
      `${(((byReason.queue ?? 0) / items.length) * 100).toFixed(1)}% ; reason=timeout ${byReason.timeout ?? 0}/${items.length} = ` +
      `${(((byReason.timeout ?? 0) / items.length) * 100).toFixed(1)}%`,
  );
  out(
    `# ${scenario.name}: renders started ${rendersStarted}, peak in flight ${peakInFlight}; service p50 ${pick2(svc, 50)} ` +
      `p95 ${pick2(svc, 95)} ms; buyer latency p50 ${pick(50)} p95 ${pick(95)} max ${lat[lat.length - 1]} ms`,
  );
}

function pick2(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] as number;
}

async function main(): Promise<void> {
  const pdf = await makePdf(2);
  const conn = openAdminWrite(fixture.sitePath('acme'));
  try {
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
    watermark: { budgetMs: 2000, concurrency: 8, globalConcurrency: 8, render: renderer },
  });
  port = await handle.app.listen({ port: 0, host: '127.0.0.1' }).then(() => {
    const a = handle.app.server.address();
    return typeof a === 'object' && a !== null ? a.port : 0;
  });

  const scenarios: Scenario[] = [
    { name: 'poisson 10/min over 180 s', shape: 'poisson', perMin: 10, seconds: 180 },
    { name: 'poisson 20/min over 180 s', shape: 'poisson', perMin: 20, seconds: 180 },
    { name: 'poisson 40/min over 180 s', shape: 'poisson', perMin: 40, seconds: 180 },
    // The same 40/min, but arriving as a 40-buyer cluster in 10 s: the shape of a campaign
    // email landing (40 clicks in the first ten seconds of a send).
    { name: '40 buyers in 10 s (40/min, clustered)', shape: 'cluster', count: 40, windowS: 10 },
    { name: '40 buyers in 30 s (80/min instantaneous)', shape: 'cluster', count: 40, windowS: 30 },
    { name: '24 buyers at once', shape: 'burst', count: 24 },
    { name: '40 buyers at once', shape: 'burst', count: 40 },
  ];

  let i = 0;
  for (const scenario of scenarios) {
    await run(scenario, i);
    i += 1;
    await sleep(500);
  }

  await handle.close();
  fixture.cleanup();
}

await main();
