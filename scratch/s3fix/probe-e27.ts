/**
 * E-27 / D33 — **QA's D4 and D4b, re-measured on the fixed tree.**
 *
 * QA measured, on the pre-fix tree: 32 renders in flight across 4 tenants against a cap of
 * 8 (D4), and — with 24 concurrent first-downloads, a 700 ms renderer and the 2 000 ms
 * budget — 8 of 24 requests served 200 after more than 2 000 ms, max 2 163 ms (D4b).
 *
 * This probe repeats both shapes against `buildApp` with an injected 700 ms renderer, and
 * prints the four numbers the fix is judged on:
 *
 *   peak in flight globally          (D33: max(4, availableParallelism()) = 8 on this box)
 *   peak in flight per tenant        (D33: 8)
 *   requests SERVED after 2000 ms    (E-27: 0; a refusal at the deadline is not a slow 200)
 *   statuses, and the reason on each refusal
 *
 * **The instrument.** The peak is read from the store (`peakGlobalInFlight`), which counts
 * renders inside both gates — the same place QA's D4 took its count ("the semaphore's job is
 * to bound *entries*, and the count is taken inside it"). A counter in the injected renderer
 * would over-report: when the request's budget expires the store releases the slot and
 * abandons the promise, so a renderer that ignores its `budgetMs` keeps running after the
 * gate has moved on. That is an artefact of the stub, not of the gate — the shipped path
 * terminates the worker. This probe therefore also hands the renderer its budget and
 * respects it, so nothing is left running behind the gate.
 *
 * Evidence, not a gate: it lives in `scratch/` and is never a target. The gates are W6b
 * (two tenants, injected capacity 4) and W14 (the queue deadline) in `make test`.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { PDFDocument, StandardFonts } from 'pdf-lib';

import { uploadAsset } from '../../app/assets/library.ts';
import { openAdminWrite } from '../../app/db/classes.ts';
import { issueCode, seedSettings } from '../../app/download/code.ts';
import { loadEnv } from '../../app/env.ts';
import { buildApp, type AppHandle } from '../../app/main.ts';
import { makeFixture, type Fixture } from '../../test/helpers/fixture.ts';
import { StampGate } from '../../app/download/render.ts';
import { call, header } from '../../test/helpers/http.ts';

const TENANTS = ['t1', 't2', 't3', 't4'] as const;
const RENDER_MS = 700;
const BUDGET_MS = 2000;
/** The non-stamp part of a request (redeem, token, stat, headers); excluded from the budget. */
const OVERHEAD_MS = 250;

let fixture: Fixture;
let handle: AppHandle;
let port = 0;
let contentRoot = '';
let active = 0;
let peakRenderer = 0;

before(async () => {
  fixture = makeFixture({
    specs: TENANTS.map((key) => ({ key, hosts: [`${key}.test`], title: key.toUpperCase() })),
  });
  contentRoot = join(fixture.dir, 'content');
  mkdirSync(join(contentRoot, 'media'), { recursive: true });

  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 2; i += 1) doc.addPage([612, 792]).drawText(`page ${i}`, { x: 72, y: 700, size: 12, font });
  const bytes = Buffer.from(await doc.save());

  for (const key of TENANTS) {
    const db = openAdminWrite(fixture.sitePath(key));
    try {
      seedSettings(db);
      await uploadAsset({
        db,
        contentRoot,
        tenantKey: key,
        key: 'vault/book',
        filename: 'book.pdf',
        bytes,
        quotaLimitBytes: 50_000_000,
        accessClass: 'gated',
      });
    } finally {
      db.close();
    }
  }

  handle = await buildApp({
    env: loadEnv(fixture.env),
    contentRoot,
    downloadLimits: { refusals: 100_000, all: 100_000 },
    watermark: {
      render: async (_job, budgetMs) => {
        active += 1;
        peakRenderer = Math.max(peakRenderer, active);
        // A renderer that respects the budget it is handed, so nothing survives the gate.
        await new Promise((resolve) => setTimeout(resolve, Math.min(RENDER_MS, budgetMs)));
        active -= 1;
        return bytes;
      },
    },
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

interface Sample {
  tenant: string;
  codeId: number;
  status: number;
  ms: number;
  reason?: string | undefined;
}

async function oneDownload(tenant: string, index: number, tag = 'A', targetPort = port): Promise<Sample> {
  const db = openAdminWrite(fixture.sitePath(tenant));
  let code = '';
  let codeId = 0;
  try {
    const issued = await issueCode({
      db,
      contentRoot,
      assetKey: 'vault/book',
      email: `${tenant}-${tag}-${index}@example.com`,
      orderRef: `ORD-${tenant}-${tag}-${index}`,
      maxUses: 3,
    });
    code = issued.code;
    codeId = issued.id;
  } finally {
    db.close();
  }
  const redeemed = await call({
    port: targetPort,
    path: `/d/${tenant}`,
    method: 'POST',
    host: `${tenant}.test`,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  if (redeemed.status !== 303) throw new Error(`${tenant} redeem -> ${redeemed.status}: ${redeemed.body}`);
  const cookie = String(header(redeemed, 'set-cookie') ?? '').split(';')[0] as string;
  const started = Date.now();
  const res = await call({ port: targetPort, path: `/d/${tenant}/file`, host: `${tenant}.test`, headers: { cookie } });
  const ms = Date.now() - started;
  const body = res.json as { error?: { detail?: { reason?: string } } } | undefined;
  return { tenant, codeId, status: res.status, ms, reason: body?.error?.detail?.reason };
}

/** The ledger for one code: one row per refusal, and no use spent. */
function ledgerOf(tenant: string, codeId: number): { rows: number; outcome: string; uses: number } {
  const db = openAdminWrite(fixture.sitePath(tenant));
  try {
    const rows = db
      .prepare(`SELECT outcome FROM cms_download_event WHERE code_id = ? AND kind = 'first'`)
      .all(codeId) as { outcome: string }[];
    const uses = Number((db.prepare(`SELECT uses FROM cms_download_code WHERE id = ?`).get(codeId) as { uses: number }).uses);
    return { rows: rows.length, outcome: rows.map((r) => r.outcome).join(','), uses };
  } finally {
    db.close();
  }
}

function report(label: string, samples: Sample[], peakGlobal: number): void {
  const served = samples.filter((s) => s.status === 200);
  const refused = samples.filter((s) => s.status !== 200);
  const servedOver = served.filter((s) => s.ms > BUDGET_MS);
  const latencies = served.map((s) => s.ms).sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length * 0.5)] ?? 0;
  const max = latencies[latencies.length - 1] ?? 0;
  const reasons = [...new Set(refused.map((s) => s.reason))];
  process.stdout.write(
    `# ${label}: ${samples.length} concurrent -> statuses ${JSON.stringify([...new Set(samples.map((s) => s.status))])}, ` +
      `served ${served.length}, refused ${refused.length} ${JSON.stringify(reasons)}\n` +
      `#   peak in flight globally ${peakGlobal} (cap ${handle.watermark.globalCapacity}); ` +
      `per tenant ${TENANTS.map((t) => `${t}=${handle.watermark.peakInFlight(t)}`).join(' ')}; ` +
      `renderer-observed peak ${peakRenderer}\n` +
      `#   served latency min ${latencies[0] ?? 0} / p50 ${p50} / max ${max} ms; SERVED after ${BUDGET_MS} ms: ${servedOver.length}\n`,
  );
}

test('E-27 D4 — 24 concurrent across 4 tenants: peak is the box cap, and nothing slow is served', async () => {
  const samples = await Promise.all(
    TENANTS.flatMap((tenant) => Array.from({ length: 6 }, (_, i) => oneDownload(tenant, i))),
  );
  const peakGlobal = handle.watermark.peakGlobalInFlight();
  report('D4 4 tenants x 6 (renderer 700 ms, budget 2000 ms)', samples, peakGlobal);
  if (peakGlobal > handle.watermark.globalCapacity) {
    throw new Error(`peak in flight ${peakGlobal} exceeded the global cap ${handle.watermark.globalCapacity}`);
  }
  // The budget covers the *stamp stage* (E-27), not the whole request: the redeem, the
  // token, the stat and the headers all happen outside it. So the assertion allows that
  // fixed overhead and says so, rather than pretending the two clocks are the same one.
  const served = samples.filter((s) => s.status === 200);
  const over = served.filter((s) => s.ms > BUDGET_MS + OVERHEAD_MS);
  if (over.length > 0) {
    throw new Error(
      `${over.length} requests were SERVED at ${over.map((s) => s.ms).join('/')} ms, more than the stamp budget ` +
        `${BUDGET_MS} ms + ${OVERHEAD_MS} ms of non-stamp work`,
    );
  }
  for (const s of samples) {
    if (s.status !== 200 && s.reason !== 'queue' && s.reason !== 'timeout') {
      throw new Error(`a refusal carried reason ${String(s.reason)}`);
    }
  }
});

test('E-27 D4b — 24 on ONE tenant: the queue deadline replaces the 2.1 s tail', async () => {
  const samples = await Promise.all(Array.from({ length: 24 }, (_, i) => oneDownload('t1', i, 'B')));
  const peakGlobal = handle.watermark.peakGlobalInFlight();
  report('D4b 24 on one tenant (renderer 700 ms, budget 2000 ms)', samples, peakGlobal);
  const servedOver = samples.filter((s) => s.status === 200 && s.ms > BUDGET_MS + OVERHEAD_MS);
  if (servedOver.length > 0) throw new Error(`${servedOver.length} requests were SERVED past the budget + overhead`);
  if (handle.watermark.peakInFlight('t1') > 8) throw new Error('per-tenant peak exceeded 8');
});

test('E-27 D4c — the queue branch at scale: 24 waiters refused while 8 renders hold the gate', async () => {
  // With one store every request has the same budget, so a waiter is always granted a slot
  // at the exact instant its own deadline passes — its refusal is `timeout` (it held a slot,
  // briefly). `reason='queue'` needs a holder whose hold outlasts the waiter's budget, which
  // in production is another store on the same box. Same seam as W14, at 24 requests: eight
  // 1 900 ms renders hold all eight slots, twenty-four 500 ms requests queue behind them and
  // are refused, still queued, at 500 ms.
  const gate = new StampGate(8);
  const holder = await buildApp({
    env: loadEnv(fixture.env),
    contentRoot,
    downloadLimits: { refusals: 100_000, all: 100_000 },
    watermark: { budgetMs: 2000, globalGate: gate, render: async () => {
      await new Promise((resolve) => setTimeout(resolve, 1900));
      return Buffer.from('%PDF-1.7\nhold\n%%EOF\n', 'latin1');
    } },
  });
  const waiter = await buildApp({
    env: loadEnv(fixture.env),
    contentRoot,
    downloadLimits: { refusals: 100_000, all: 100_000 },
    watermark: { budgetMs: 500, globalGate: gate, render: () => new Promise<Buffer>(() => {}) },
  });
  const holderPort = await holder.app.listen({ port: 0, host: '127.0.0.1' }).then(() => {
    const address = holder.app.server.address();
    return typeof address === 'object' && address !== null ? address.port : 0;
  });
  const waiterPort = await waiter.app.listen({ port: 0, host: '127.0.0.1' }).then(() => {
    const address = waiter.app.server.address();
    return typeof address === 'object' && address !== null ? address.port : 0;
  });
  try {
    // Eight holders on one tenant take every slot.
    const held = Promise.all(Array.from({ length: 8 }, (_, i) => oneDownload('t1', i, 'H', holderPort)));
    await new Promise((resolve) => setTimeout(resolve, 80));

    const samples = await Promise.all(
      TENANTS.flatMap((tenant) => Array.from({ length: 6 }, (_, i) => oneDownload(tenant, i, 'Q', waiterPort))),
    );
    report('D4c 24 waiters across 4 tenants behind 8 held slots (waiter budget 500 ms)', samples, 8);

    const refused = samples.filter((s) => s.status !== 200);
    const queued = refused.filter((s) => s.reason === 'queue');
    process.stdout.write(`#   refusals by reason: queue ${queued.length}, timeout ${refused.length - queued.length}\n`);
    if (refused.length !== 24 || queued.length !== 24) {
      throw new Error(`expected 24 queue refusals, got ${refused.length} refusals of which ${queued.length} queue`);
    }
    for (const s of refused) {
      const ledger = ledgerOf(s.tenant, s.codeId);
      if (ledger.rows !== 1 || ledger.outcome !== 'denied_watermark') {
        throw new Error(`refused ${s.tenant}/${s.codeId} has ${ledger.rows} rows (${ledger.outcome}), expected one denied_watermark`);
      }
      if (ledger.uses !== 0) throw new Error(`refused ${s.tenant}/${s.codeId} spent ${ledger.uses} use(s)`);
    }
    process.stdout.write(`#   every one of the ${refused.length} queue refusals: one first:denied_watermark row, uses 0\n`);
    await held;
  } finally {
    await waiter.close();
    await holder.close();
  }
});
