/**
 * QA S3 round 2 / item A.2 — **the two-gate design: is there a deadlock, and does anything
 * wait forever?**
 *
 * The claim under test: acquisition is *tenant, then global*; release is the reverse; and no
 * request can wait without a deadline. The deadlock the design introduces is the one the
 * fixed order is supposed to remove: a request that holds a tenant slot and waits on the
 * global gate, while another holds the global gate and waits on that tenant's gate.
 *
 * What is measured, on the shipped `WatermarkStore` over HTTP:
 *   G1  4 tenants x 8, global cap 4, 120 ms renders  — the queue exercises "holds tenant,
 *       waits global" (sampled `gate.waiting > 0` while renders are in flight) and every
 *       request must still settle inside its budget.
 *   G2  3 tenants x 8, global cap 1, 200 ms renders  — the tail must run out of budget and
 *       refuse; refusals must be `queue`/`timeout`, no worker started, and *every* request
 *       must settle (a deadlock shows as a promise that never settles).
 *   G3  a post-run request on the same gate must be served immediately: no slot was leaked
 *       by either refusal path, which is the leak that would turn a bounded wait into a
 *       permanent one on the next request.
 *
 * A watchdog turns "never settles" into a reported number rather than a hung probe: each
 * request is raced against (budget + 8 s) and a loser is counted as a hang.
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
import { StampGate } from '../../app/download/render.ts';
import { makeFixture, type Fixture } from '../../test/helpers/fixture.ts';
import { call, header, type Res } from '../../test/helpers/http.ts';

const out = (s: string): void => process.stdout.write(`${s}\n`);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function makePdf(pages: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i += 1) doc.addPage([612, 792]).drawText(`p${i}`, { x: 72, y: 700, size: 12, font });
  return Buffer.from(await doc.save());
}

interface Issued {
  tenant: string;
  id: number;
  code: string;
}

const TENANTS = ['t1', 't2', 't3', 't4'] as const;
const PER_TENANT = 8;

const fixture: Fixture = makeFixture({ specs: TENANTS.map((t) => ({ key: t, hosts: [`${t}.test`], title: t })) });
const contentRoot = join(fixture.dir, 'content');
mkdirSync(contentRoot, { recursive: true });

// --- the instrument --------------------------------------------------------------
let inFlight = 0;
let peak = 0;
let renderCalls = 0;
let renderMs = 120;

async function renderer(): Promise<Buffer> {
  renderCalls += 1;
  inFlight += 1;
  peak = Math.max(peak, inFlight);
  await sleep(renderMs);
  inFlight -= 1;
  return makePdf(1);
}

let handle: AppHandle;
let port = 0;

function redeem(tenant: string, code: string): Promise<Res> {
  return call({
    port,
    path: `/d/${tenant}`,
    method: 'POST',
    host: `${tenant}.test`,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  });
}
function cookieOf(res: Res): string {
  const raw = String(header(res, 'set-cookie') ?? '');
  return raw.slice(0, raw.indexOf(';'));
}
function download(tenant: string, cookie: string): Promise<Res> {
  return call({ port, path: `/d/${tenant}/file`, host: `${tenant}.test`, headers: { cookie } });
}

interface Outcome {
  tenant: string;
  status: number;
  reason: string;
  ms: number;
  hung: boolean;
}

async function one(tenant: string, cookie: string, watchdogMs: number): Promise<Outcome> {
  const started = Date.now();
  const res = await Promise.race([
    download(tenant, cookie),
    sleep(watchdogMs).then(() => null),
  ]);
  const ms = Date.now() - started;
  if (res === null) return { tenant, status: -1, reason: 'HUNG', ms, hung: true };
  const detail = (res.json as { error?: { detail?: { reason?: string } } } | undefined)?.error?.detail;
  return { tenant, status: res.status, reason: detail?.reason ?? '', ms, hung: false };
}

/** Sample the shared gate while the burst runs: `waiting > 0` is the "holds tenant, waits global" state. */
async function sampleDuring<T>(run: Promise<T>, gate: StampGate, stop: { done: boolean }): Promise<{ maxWaiting: number; maxActive: number; samples: number }> {
  let maxWaiting = 0;
  let maxActive = 0;
  let samples = 0;
  void run.then(() => {
    stop.done = true;
  });
  while (!stop.done) {
    maxWaiting = Math.max(maxWaiting, gate.waiting);
    maxActive = Math.max(maxActive, gate.active);
    samples += 1;
    await sleep(5);
  }
  return { maxWaiting, maxActive, samples };
}

async function main(): Promise<void> {
  const pdf = await makePdf(2);
  const issued: Issued[] = [];
  for (const tenant of TENANTS) {
    const conn = openAdminWrite(fixture.sitePath(tenant));
    try {
      seedSettings(conn);
      await uploadAsset({
        db: conn,
        contentRoot,
        tenantKey: tenant,
        key: 'vault/book',
        filename: 'book.pdf',
        bytes: pdf,
        quotaLimitBytes: 50_000_000,
        accessClass: 'gated',
      });
      for (let i = 0; i < PER_TENANT; i += 1) {
        const row = await issueCode({ db: conn, contentRoot, assetKey: 'vault/book', email: `b${i}@${tenant}.test`, orderRef: `ORD-${tenant}-${i}` });
        issued.push({ tenant, id: row.id, code: row.code });
      }
    } finally {
      conn.close();
    }
  }

  const budget = 2000;
  const gate = new StampGate(4);
  handle = await buildApp({
    env: loadEnv(fixture.env),
    contentRoot,
    downloadLimits: { refusals: 100_000, all: 100_000 },
    watermark: { budgetMs: budget, concurrency: 8, globalGate: gate, render: renderer },
  });
  port = await handle.app.listen({ port: 0, host: '127.0.0.1' }).then(() => {
    const a = handle.app.server.address();
    return typeof a === 'object' && a !== null ? a.port : 0;
  });

  // ---- G1: 32 requests, global cap 4, 120 ms renders -------------------------------
  renderMs = 120;
  peak = 0;
  inFlight = 0;
  renderCalls = 0;
  const cookies = new Map<string, string>();
  for (const item of issued) cookies.set(`${item.tenant}:${item.id}`, cookieOf(await redeem(item.tenant, item.code)));

  const t0 = Date.now();
  const stop = { done: false };
  const g1run = Promise.all(
    issued.map((item) => one(item.tenant, cookies.get(`${item.tenant}:${item.id}`) as string, budget + 8000)),
  );
  const samples = await sampleDuring(g1run, gate, stop);
  const g1 = await g1run;
  const g1ms = Date.now() - t0;
  const g1served = g1.filter((o) => o.status === 200).length;
  const g1refused = g1.filter((o) => o.status === 503);
  const g1hung = g1.filter((o) => o.hung).length;
  out(
    `# G1 4 tenants x 8 = ${g1.length} requests, global cap 4, concurrency 8, render 120 ms, budget ${budget} ms`,
  );
  out(
    `# G1 all settled in ${g1ms} ms; 200s ${g1served}; 503s ${g1refused.length} ` +
      `[${JSON.stringify(countBy(g1refused.map((o) => o.reason)))}]; hung ${g1hung}`,
  );
  out(`# G1 renderer-observed peak ${peak}; store peakGlobal ${handle.watermark.peakGlobalInFlight()}`);
  out(
    `# G1 gate sampled ${samples.samples}x: max active ${samples.maxActive}, max WAITING (holding a tenant slot, ` +
      `blocked on the global gate) ${samples.maxWaiting}`,
  );
  out(
    `# G1 latency min ${Math.min(...g1.map((o) => o.ms))} / p50 ${pct(g1.map((o) => o.ms), 50)} / ` +
      `p95 ${pct(g1.map((o) => o.ms), 95)} / max ${Math.max(...g1.map((o) => o.ms))} ms`,
  );
  out(`# G1 slots after: active ${gate.active}, waiting ${gate.waiting} (a leak here is the next request's hang)`);

  // ---- G2: 24 requests, global cap 1, 200 ms renders -------------------------------
  const gate2 = new StampGate(1);
  await handle.close();
  renderMs = 200;
  peak = 0;
  inFlight = 0;
  renderCalls = 0;
  // Fresh codes with fresh order refs: the spec includes the order_ref, so these cannot be
  // cache hits of G1's renders (a cache hit measures nothing about the gate).
  const issued24: Issued[] = [];
  for (let i = 0; i < 24; i += 1) {
    const tenant = TENANTS[i % 3] as string;
    const conn = openAdminWrite(fixture.sitePath(tenant));
    try {
      const row = await issueCode({ db: conn, contentRoot, assetKey: 'vault/book', email: `g2-${i}@${tenant}.test`, orderRef: `ORD-G2-${i}` });
      issued24.push({ tenant, id: row.id, code: row.code });
    } finally {
      conn.close();
    }
  }
  handle = await buildApp({
    env: loadEnv(fixture.env),
    contentRoot,
    downloadLimits: { refusals: 100_000, all: 100_000 },
    watermark: { budgetMs: budget, concurrency: 8, globalGate: gate2, render: renderer },
  });
  port = await handle.app.listen({ port: 0, host: '127.0.0.1' }).then(() => {
    const a = handle.app.server.address();
    return typeof a === 'object' && a !== null ? a.port : 0;
  });
  const cookies2 = new Map<string, string>();
  for (const item of issued24) cookies2.set(`${item.tenant}:${item.id}`, cookieOf(await redeem(item.tenant, item.code)));
  const t1 = Date.now();
  const g2 = await Promise.all(
    issued24.map((item) => one(item.tenant, cookies2.get(`${item.tenant}:${item.id}`) as string, budget + 8000)),
  );
  const g2ms = Date.now() - t1;
  const g2refused = g2.filter((o) => o.status === 503);
  out(`# G2 3 tenants x 8 = ${g2.length}, global cap 1, render 200 ms, budget ${budget} ms`);
  out(
    `# G2 all settled in ${g2ms} ms; 200s ${g2.filter((o) => o.status === 200).length}; ` +
      `503s ${g2refused.length} [${JSON.stringify(countBy(g2refused.map((o) => o.reason)))}]; ` +
      `hung ${g2.filter((o) => o.hung).length}`,
  );
  out(`# G2 renderer-observed peak ${peak} (cap 1); renders actually started ${renderCalls}`);
  const perTenant = countBy(g2.map((o) => `${o.tenant}:${o.status}`));
  out(`# G2 per tenant x status ${JSON.stringify(perTenant)}   <- fairness of one FIFO queue`);
  out(`# G2 slots after: active ${gate2.active}, waiting ${gate2.waiting}`);
  // A refusal must not start a worker: every 503 must be accounted for by renders < requests.
  out(`# G2 workers started ${renderCalls} for ${g2.length} requests (a refused request starts none)`);

  // ---- G3: no leaked slot — the next request is immediate -------------------------
  const lateConn = openAdminWrite(fixture.sitePath('t1'));
  const late = await issueCode({ db: lateConn, contentRoot, assetKey: 'vault/book', email: 'late@t1.test', orderRef: 'ORD-LATE' });
  lateConn.close();
  const lateCookie = cookieOf(await redeem('t1', late.code));
  const started = Date.now();
  const lateRes = await one('t1', lateCookie, budget + 8000);
  out(`# G3 post-run request on the same gate -> ${lateRes.status} in ${lateRes.ms} ms (slots free: active ${gate2.active})`);

  await handle.close();
  fixture.cleanup();
  void started;
}

function countBy(values: string[]): Record<string, number> {
  const m: Record<string, number> = {};
  for (const v of values) m[v] = (m[v] ?? 0) + 1;
  return m;
}
function pct(values: number[], p: number): number {
  const s = [...values].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[i] as number;
}

await main();
