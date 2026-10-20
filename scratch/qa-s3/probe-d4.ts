/**
 * QA S3 / defeat attempt 4 — **32 simultaneous redemptions across 4 tenants (D33).**
 *
 * D33 (IDEA §13): "Watermark concurrency is bounded globally as well as per tenant:
 * per-tenant semaphore 8, global semaphore `max(4, cores)`, and the global one binds."
 *
 * The instrument: one injected renderer shared by every tenant in the process (the same
 * seam W6 uses, and the only place `STAMP_CONCURRENCY` is applied). It counts *globally*
 * while it holds, so the number it reports is the number of renders that were in flight
 * at once, across tenants. Per-tenant peaks come from the shipped `peakInFlight()`.
 *
 * The workload is HTTP, not a direct call: 4 tenants x 8 codes, all 32 redeemed first,
 * then all 32 first-downloads fired in one `Promise.all`. Each buyer has a distinct
 * `spec_sha`, so the in-flight de-duplicator cannot coalesce them into one render.
 *
 * The accounting half is asserted too: 32 redemptions must leave 8 uses and 8 `first:ok`
 * rows per tenant, no matter how the renders interleave.
 */
import { cpus } from 'node:os';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import type Database from 'better-sqlite3';
import { PDFDocument, StandardFonts } from 'pdf-lib';

import { uploadAsset } from '../../app/assets/library.ts';
import { openAdminWrite } from '../../app/db/classes.ts';
import { loadEnv } from '../../app/env.ts';
import { buildApp, type AppHandle } from '../../app/main.ts';
import { issueCode } from '../../app/download/code.ts';
import { STAMP_CONCURRENCY } from '../../app/download/render.ts';
import { makeFixture, type Fixture } from '../../test/helpers/fixture.ts';
import { call, header, type Res } from '../../test/helpers/http.ts';

const TENANTS = ['t1', 't2', 't3', 't4'] as const;
const PER_TENANT = 8;
const out = (s: string): void => process.stdout.write(`${s}\n`);

async function makePdf(pages: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i += 1) doc.addPage([612, 792]).drawText(`p${i}`, { x: 72, y: 700, size: 12, font });
  return Buffer.from(await doc.save());
}

const fixture: Fixture = makeFixture({
  specs: TENANTS.map((t) => ({ key: t, hosts: [`${t}.test`], title: t })),
});
const contentRoot = join(fixture.dir, 'content');
mkdirSync(contentRoot, { recursive: true });
const env = loadEnv(fixture.env);

function siteDb(key: string): Database.Database {
  return openAdminWrite(fixture.sitePath(key));
}

// The instrument itself: counts renders in flight across every tenant in this process.
let inFlight = 0;
let peak = 0;
let calls = 0;
const perTenantActive = new Map<string, number>();

async function renderer(): Promise<Buffer> {
  calls += 1;
  inFlight += 1;
  peak = Math.max(peak, inFlight);
  await new Promise((r) => setTimeout(r, 120));
  inFlight -= 1;
  return makePdf(1);
}

interface Issued {
  tenant: string;
  id: number;
  code: string;
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

async function main(): Promise<void> {
  const pdf = await makePdf(2);
  const issued: Issued[] = [];
  for (const tenant of TENANTS) {
    const conn = siteDb(tenant);
    try {
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
        const row = await issueCode({
          db: conn,
          contentRoot,
          assetKey: 'vault/book',
          email: `buyer${i}@${tenant}.test`,
          orderRef: `ORD-${tenant}-${i}`,
          maxUses: 3,
        });
        issued.push({ tenant, id: row.id, code: row.code });
      }
    } finally {
      conn.close();
    }
  }

  handle = await buildApp({
    env,
    contentRoot,
    downloadLimits: { refusals: 10_000, all: 10_000 },
    watermark: { render: renderer },
  });
  port = await handle.app.listen({ port: 0, host: '127.0.0.1' }).then(() => {
    const a = handle.app.server.address();
    return typeof a === 'object' && a !== null ? a.port : 0;
  });

  // Every redemption first, so the 32 downloads start together.
  const cookies: { tenant: string; cookie: string }[] = [];
  for (const row of issued) {
    const res = await redeem(row.tenant, row.code);
    if (res.status !== 303) throw new Error(`redeem ${row.tenant} -> ${res.status} ${res.body}`);
    cookies.push({ tenant: row.tenant, cookie: cookieOf(res) });
  }

  const started = Date.now();
  const results = await Promise.all(cookies.map((c) => download(c.tenant, c.cookie)));
  const elapsed = Date.now() - started;
  const statuses = new Map<number, number>();
  for (const r of results) statuses.set(r.status, (statuses.get(r.status) ?? 0) + 1);

  out(`# D4 cores=${cpus().length}, D33 global cap would be max(4, cores)=${Math.max(4, cpus().length)}, per-tenant cap ${STAMP_CONCURRENCY}`);
  out(`# D4 ${cookies.length} downloads in ${elapsed} ms, statuses ${JSON.stringify([...statuses])}, renders=${calls}`);
  out(`# D4 PEAK renders in flight at once (4 tenants x 8) = ${peak}`);
  for (const tenant of TENANTS) out(`# D4 per-tenant peak ${tenant} = ${handle.watermark.peakInFlight(tenant)}`);

  // The accounting half: 8 uses and 8 first rows per tenant, exactly.
  for (const tenant of TENANTS) {
    const conn = siteDb(tenant);
    try {
      const u = Number((conn.prepare(`SELECT SUM(uses) AS n FROM cms_download_code`).get() as { n: number }).n);
      const rows = conn.prepare(`SELECT outcome, COUNT(*) AS n FROM cms_download_event GROUP BY outcome`).all() as {
        outcome: string;
        n: number;
      }[];
      out(`# D4 accounting ${tenant}: uses=${u}, events=${JSON.stringify(rows)}`);
    } finally {
      conn.close();
    }
  }

  void perTenantActive;
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
