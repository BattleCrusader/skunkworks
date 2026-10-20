/**
 * QA S3 round 2 — **the render cost the load probe assumes.**
 *
 * The false-refusal probe injects a 300–800 ms renderer, which holds a slot without burning
 * a core. A real `pdf-lib` worker does burn one, and eight of them on an eight-core box
 * share the machine with the event loop. If the real service time under concurrency is far
 * above the injected range, the load probe's refusal rate is optimistic and the note says so
 * with a number instead of an adjective.
 *
 * Measured through the shipped `WatermarkStore.ensure` with the **default** renderer (a real
 * `worker_threads` worker running `stamp-worker.js`/`.ts`) — no injection anywhere.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { PDFDocument, StandardFonts } from 'pdf-lib';

import { uploadAsset } from '../../app/assets/library.ts';
import { openAdminWrite } from '../../app/db/classes.ts';
import { assetById, issueCode, seedSettings } from '../../app/download/code.ts';
import { WatermarkStore } from '../../app/download/render.ts';
import { makeFixture, type Fixture } from '../../test/helpers/fixture.ts';

const out = (s: string): void => process.stdout.write(`${s}\n`);

async function makePdf(pages: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i += 1) {
    doc.addPage([612, 792]).drawText(`chapter ${i + 1} — a line of body text for the renderer`, {
      x: 72,
      y: 700,
      size: 11,
      font,
    });
  }
  return Buffer.from(await doc.save());
}

const fixture: Fixture = makeFixture({ specs: [{ key: 'acme', hosts: ['acme.test'], title: 'Acme' }] });
const contentRoot = join(fixture.dir, 'content');
mkdirSync(join(contentRoot, 'media'), { recursive: true });

const conn = openAdminWrite(fixture.sitePath('acme'));
seedSettings(conn);
const pages = 40;
const uploaded = await uploadAsset({
  db: conn,
  contentRoot,
  tenantKey: 'acme',
  key: 'vault/big',
  filename: 'big.pdf',
  bytes: await makePdf(pages),
  quotaLimitBytes: 50_000_000,
  accessClass: 'gated',
});
const asset = assetById(conn, uploaded.asset.id);
if (asset === null) throw new Error('no asset');
conn.close();

const store = new WatermarkStore({ contentRoot, budgetMs: 20_000, concurrency: 32, globalConcurrency: 32 });

async function one(index: number): Promise<number> {
  const db = openAdminWrite(fixture.sitePath('acme'));
  try {
    const code = await issueCode({ db, contentRoot, assetKey: 'vault/big', email: `c${index}@example.com`, orderRef: `ORD-CAL-${index}` });
    const started = Date.now();
    await store.ensure({
      tenantKey: 'acme',
      db,
      asset,
      code: { id: code.id, email: `c${index}@example.com`, orderRef: `ORD-CAL-${index}`, issuedAt: new Date().toISOString(), selector: code.code.slice(0, 4) },
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    return Date.now() - started;
  } finally {
    db.close();
  }
}

const solo: number[] = [];
for (let i = 0; i < 3; i += 1) solo.push(await one(1000 + i));
out(`# CAL ${pages}-page PDF, one render at a time: ${solo.join(' / ')} ms`);

const started = Date.now();
const eight = await Promise.all(Array.from({ length: 8 }, (_, i) => one(i)));
const wall = Date.now() - started;
const sorted = [...eight].sort((a, b) => a - b);
out(`# CAL 8 concurrent renders, same ${pages}-page asset, distinct specs: ${eight.join(' / ')} ms`);
out(`# CAL wall ${wall} ms; per-render p50 ${sorted[4]} p95 ${sorted[7]} max ${sorted[7]}`);
out(`# CAL store: peakGlobalInFlight ${store.peakGlobalInFlight()}`);

fixture.cleanup();
