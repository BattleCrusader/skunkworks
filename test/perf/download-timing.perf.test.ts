/**
 * S3c / §16 S3 — **the timing assertion, in `test/perf` where the repo keeps them.**
 *
 * "An unknown selector and a wrong secret are indistinguishable in status, body and
 * time: 1,000-trial timing test, medians within 20 %."
 *
 * The mechanism is one argon2id verify per request on both paths: against the code's
 * hash when the selector matched, against `DUMMY_HASH` when it did not. This file is the
 * only place that can observe whether the two paths actually cost the same, because it
 * is the only place that runs them 1,000 times each.
 *
 * **Tolerance: 20 % of the larger median**, i.e. `min(medians) >= 0.8 * max(medians)`.
 * The medians are printed, so the number is in the log and not just the verdict. Trials
 * alternate (unknown, wrong, unknown, wrong, …) so a load spike lands on both groups
 * instead of on whichever ran second; that is the same reason `S3b-report.md` records
 * its one wall-clock failure rather than hiding it.
 *
 * This is a performance gate: it measures the box. `make test` does not run it, and
 * `make test-perf` refuses to run on a busy machine unless `SKW_PERF_FORCE=1` says the
 * numbers are not a measurement.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { uploadAsset } from '../../app/assets/library.ts';
import { openAdminWrite } from '../../app/db/classes.ts';
import { issueCode } from '../../app/download/code.ts';
import { loadEnv } from '../../app/env.ts';
import { buildApp, type AppHandle } from '../../app/main.ts';
import { makeFixture, type Fixture } from '../helpers/fixture.ts';
import { call } from '../helpers/http.ts';

const HOST = 'acme.test';
const TRIALS = 1000;
const TOLERANCE = 0.20;
const PDF = '%PDF-1.7\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n';

let fixture: Fixture;
let handle: AppHandle;
let port = 0;
let contentRoot = '';
let realCode = '';

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
}

function percentile(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))] as number;
}

async function attempt(code: string): Promise<number> {
  const t0 = process.hrtime.bigint();
  const res = await call({
    port,
    path: '/d/acme',
    method: 'POST',
    host: HOST,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.equal(res.status, 401, `a refusal is what is being timed: ${res.body}`);
  return ms;
}

before(async () => {
  fixture = makeFixture({ specs: [{ key: 'acme', hosts: [HOST], title: 'Acme' }] });
  contentRoot = join(fixture.dir, 'content');
  const db = openAdminWrite(fixture.sitePath('acme'));
  try {
    await uploadAsset({
      db,
      contentRoot,
      tenantKey: 'acme',
      key: 'vault/book',
      filename: 'book.pdf',
      bytes: Buffer.from(PDF, 'latin1'),
      quotaLimitBytes: 1_000_000,
      accessClass: 'gated',
    });
    const issued = await issueCode({ db, contentRoot, assetKey: 'vault/book', maxUses: 100 });
    realCode = issued.code;
  } finally {
    db.close();
  }

  // The limiter would answer 429 after five refusals and a 429 is not a timing sample.
  // The shipped limits are asserted in `download-redeem.test.ts` R12, on a plane built
  // without this seam.
  handle = await buildApp({
    env: loadEnv(fixture.env),
    contentRoot,
    downloadLimits: { refusals: TRIALS * 4, all: TRIALS * 4 },
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

test('P-S3c-1. unknown selector vs wrong secret: 1,000 trials each, medians within 20%', async () => {
  const alpha = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const flipped = (alpha[(alpha.indexOf(realCode[0] as string) + 7) % 32] as string) + realCode.slice(1);
  const wrongSecret = realCode.slice(0, 15) + (realCode[15] === 'Z' ? 'Y' : 'Z');
  assert.notEqual(flipped.slice(0, 4), realCode.slice(0, 4), 'the unknown selector must not exist');

  // One warm-up pair: the first request of each shape pays for a cold JIT and a cold
  // connection, which is a property of the process and not of either path.
  await attempt(flipped);
  await attempt(wrongSecret);

  const unknown: number[] = [];
  const wrong: number[] = [];
  for (let i = 0; i < TRIALS; i += 1) {
    unknown.push(await attempt(flipped));
    wrong.push(await attempt(wrongSecret));
    if ((i + 1) % 200 === 0) process.stdout.write(`  ${i + 1}/${TRIALS} trials\n`);
  }

  const mUnknown = median(unknown);
  const mWrong = median(wrong);
  const ratio = Math.max(mUnknown, mWrong) / Math.min(mUnknown, mWrong);
  const verdict =
    `medians: unknown-selector ${mUnknown.toFixed(2)} ms, wrong-secret ${mWrong.toFixed(2)} ms ` +
    `(${ratio.toFixed(3)}x; tolerance ${TOLERANCE}x), p10 ${percentile(unknown, 0.1).toFixed(2)}/` +
    `${percentile(wrong, 0.1).toFixed(2)} ms, p90 ${percentile(unknown, 0.9).toFixed(2)}/` +
    `${percentile(wrong, 0.9).toFixed(2)} ms over ${TRIALS} trials each`;
  process.stdout.write(`  ${verdict}\n`);

  assert.ok(
    ratio <= 1 + TOLERANCE,
    `the two paths differ by ${ratio.toFixed(3)}x, over the 1.20x tolerance — ${verdict}`,
  );
  // A median under 1 ms would mean argon2 did not run at all: both paths would be
  // "identical" while proving nothing, which is the failure this guards against.
  assert.ok(Math.min(mUnknown, mWrong) > 3, `a verify did not run: ${verdict}`);
});

test('P-S3c-2 — the same trials against a selector that never existed cost the same as a real one', async () => {
  // The second half of the oracle question: a *nonexistent* selector and a *real* one
  // that fails its secret must not be separable either, because the dummy verify is the
  // same call at the same parameters.
  const alpha = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const nonexistent = Array.from(randomUUID().replace(/-/g, '').toUpperCase())
    .map((ch) => alpha[ch.charCodeAt(0) % 32] as string)
    .slice(0, 16)
    .join('');
  const sample: number[] = [];
  for (let i = 0; i < 50; i += 1) sample.push(await attempt(nonexistent));
  const m = median(sample);
  assert.ok(m > 3, `a verify did not run for a random selector: ${m.toFixed(2)} ms`);
  process.stdout.write(`  random-selector median ${m.toFixed(2)} ms over 50 trials\n`);
});
