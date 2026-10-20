/**
 * P-S3d-1 / §7.5 — **the per-tenant semaphore saturates at eight, and not at sixteen.**
 *
 * `download-watermark.test.ts` W6 asserts the ceiling (peak ≤ 8) with a renderer that
 * sleeps, which cannot flake. This file asserts the *floor* as well: sixteen concurrent
 * stamps must reach exactly eight in flight. The renderer blocks on a gate that opens
 * only when the eighth has started, so
 *
 *   - a cap of 16 (no semaphore) drives `started` to 16 before any returns → peak 16 → red;
 *   - a cap of 4 never reaches the gate → the safety timer fires and peak is 4 → red;
 *   - a cap of `min(8, max(4, availableParallelism()))` opens the gate, all eight return,
 *     the next eight run → peak exactly the cap.
 *
 * E-27: the cap this asserts is now the **effective** one — `min(STAMP_CONCURRENCY,
 * globalStampConcurrency())` — because the per-tenant eight is bounded by the box's
 * `max(4, availableParallelism())`. On this eight-core box both numbers are 8 and the case
 * is unchanged; on a two-core box the old literal `8` would have been red for the wrong
 * reason. Both numbers are printed, so a reader can see which one bound.
 *
 * It is in `test/perf` because a *deadlock* is a wall-clock event: the safety timer is the
 * thing that turns a wrong cap into a named failure instead of a hung job (E-8). The
 * second case measures the shipped renderer — 40 pages through `pdf-lib` in a worker —
 * so the 2 s budget is quoted against something rather than asserted against nothing.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';

import { PDFDocument, StandardFonts } from 'pdf-lib';

import { uploadAsset } from '../../app/assets/library.ts';
import { openAdminWrite } from '../../app/db/classes.ts';
import { assetById } from '../../app/download/code.ts';
import { STAMP_CONCURRENCY, WatermarkStore, globalStampConcurrency } from '../../app/download/render.ts';
import { makeFixture } from '../helpers/fixture.ts';

test('P-S3d-1. sixteen concurrent stamps reach exactly the cap of eight, then drain', async () => {
  const fixture = makeFixture({ specs: [{ key: 'acme', hosts: ['acme.test'] }] });
  try {
    const contentRoot = join(fixture.dir, 'content');
    mkdirSync(join(contentRoot, 'media'), { recursive: true });

    const doc = await PDFDocument.create();
    doc.addPage([612, 792]).drawText('x', { x: 72, y: 72, size: 10, font: await doc.embedFont(StandardFonts.Helvetica) });
    const bytes = Buffer.from(await doc.save());

    const db = openAdminWrite(fixture.sitePath('acme'));
    await uploadAsset({
      db,
      contentRoot,
      tenantKey: 'acme',
      key: 'vault/book',
      filename: 'book.pdf',
      bytes,
      quotaLimitBytes: 10_000_000,
      accessClass: 'gated',
    });
    const asset = assetById(db, 1);
    assert.ok(asset !== null);

    let started = 0;
    let active = 0;
    let peak = 0;
    // E-27: min(8, max(4, cores)). The gate opens when the cap is reached, so a cap that is
    // too high peaks above it and a cap that is too low never opens the gate at all.
    const cap = Math.min(STAMP_CONCURRENCY, globalStampConcurrency());
    let openGate: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });

    const store = new WatermarkStore({
      contentRoot,
      // No `budgetMs` override: this is the shipped 2,000 ms, and no render here is slow.
      render: async () => {
        started += 1;
        active += 1;
        peak = Math.max(peak, active);
        if (started === cap) openGate?.();
        await Promise.race([gate, new Promise((resolve) => setTimeout(resolve, 4_000))]);
        active -= 1;
        return Buffer.from('%PDF-1.7\nstub\n%%EOF\n', 'latin1');
      },
    });

    const codes = Array.from({ length: 16 }, (_, i) => ({
      id: i + 1,
      email: `buyer${i}@example.com`,
      orderRef: `ORD-CONC-${i}`,
      issuedAt: '2026-10-20T00:00:00.000Z',
      selector: 'AAAA',
    }));

    const results = await Promise.all(
      codes.map((code) =>
        store.ensure({
          tenantKey: 'acme',
          db,
          asset,
          code,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
      ),
    );
    db.close();

    assert.equal(results.length, 16, 'every stamp returned');
    assert.equal(started, 16, `the renderer ran ${started} times, not 16`);
    assert.equal(peak, cap, `peak in flight was ${peak}; the effective cap is ${cap}`);
    assert.equal(store.peakInFlight('acme'), cap, 'the store agrees with the renderer');
    process.stdout.write(
      `# P-S3d-1 16 stamps -> ${started} renders, peak in flight ${peak}, ` +
        `per-tenant cap ${STAMP_CONCURRENCY}, global cap ${globalStampConcurrency()}, effective ${cap}\n`,
    );
  } finally {
    fixture.cleanup();
  }
});

test('P-S3d-2. a 40-page PDF stamps in the worker well inside the 2 s budget', async () => {
  const fixture = makeFixture({ specs: [{ key: 'acme', hosts: ['acme.test'] }] });
  try {
    const contentRoot = join(fixture.dir, 'content');
    mkdirSync(join(contentRoot, 'media'), { recursive: true });

    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (let i = 0; i < 40; i += 1) {
      doc.addPage([612, 792]).drawText(`page ${i + 1} of the licence terms`, { x: 72, y: 700, size: 11, font });
    }
    const bytes = Buffer.from(await doc.save());

    const db = openAdminWrite(fixture.sitePath('acme'));
    await uploadAsset({
      db,
      contentRoot,
      tenantKey: 'acme',
      key: 'vault/book',
      filename: 'book.pdf',
      bytes,
      quotaLimitBytes: 50_000_000,
      accessClass: 'gated',
    });
    const asset = assetById(db, 1);
    assert.ok(asset !== null);

    // The shipped path: no injected renderer, so every stamp is a worker thread running
    // pdf-lib, and the 2,000 ms budget is the one production uses.
    const store = new WatermarkStore({ contentRoot });
    const cold = Date.now();
    const first = await store.ensure({
      tenantKey: 'acme',
      db,
      asset,
      code: { id: 1, email: 'a@example.com', orderRef: 'ORD-40-A', issuedAt: '2026-10-20T00:00:00.000Z', selector: 'AAAA' },
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const coldMs = Date.now() - cold;

    const warmStart = Date.now();
    const second = await store.ensure({
      tenantKey: 'acme',
      db,
      asset,
      code: { id: 2, email: 'b@example.com', orderRef: 'ORD-40-B', issuedAt: '2026-10-20T00:00:00.000Z', selector: 'BBBB' },
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const warmMs = Date.now() - warmStart;

    const hitStart = Date.now();
    const hit = await store.ensure({
      tenantKey: 'acme',
      db,
      asset,
      code: { id: 1, email: 'a@example.com', orderRef: 'ORD-40-A', issuedAt: '2026-10-20T00:00:00.000Z', selector: 'AAAA' },
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const hitMs = Date.now() - hitStart;
    db.close();

    assert.equal(first.reused, false);
    assert.equal(second.reused, false);
    assert.equal(hit.reused, true, 'the third request is a cache hit');
    assert.equal(hit.bytes, first.bytes);
    assert.notEqual(first.specSha, second.specSha);
    assert.ok(coldMs < 2_000, `a cold 40-page stamp took ${coldMs} ms, over the 2,000 ms budget`);
    assert.ok(warmMs < 2_000, `a warm 40-page stamp took ${warmMs} ms, over the 2,000 ms budget`);
    process.stdout.write(
      `# P-S3d-2 40 pages: cold ${coldMs} ms, second purchaser ${warmMs} ms, cache hit ${hitMs} ms ` +
        `(budget 2000 ms), bytes ${first.bytes}/${second.bytes}\n`,
    );
  } finally {
    fixture.cleanup();
  }
});
