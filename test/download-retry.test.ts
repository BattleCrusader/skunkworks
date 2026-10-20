/**
 * D34 / S3R2-2 — **a watermark refusal is retryable by contract**.
 *
 * QA measured 0 % refusals at 10/20/40 buyers per minute but 22–42 % at 32+ simultaneous
 * (`S3-qa.md` §B). The refusal is fail-closed and costs no entitlement, but it used to be
 * a dead end: `Retry-After` was absent, a browser got a JSON body instead of a page, and
 * the denial was written as `kind='first'`, which made every retry under the same token a
 * *second* denial (`consumeUse` treats an existing non-`ok` `first` row as terminal). So
 * the buyer's reload bought them nothing.
 *
 * The three claims this file exists to prove:
 *
 *   R1  `Retry-After` is a number derived from the measured render p50 and the live queue
 *       depth — not a constant — and it is bounded;
 *   R2  the p50 is measured, from completed renders, and a store's answer changes when it
 *       changes;
 *   R3  a refusal that clears on attempt 2 ends in a served, stamped file with `uses` spent
 *       **once**, and each attempt has its own ledger row;
 *   R4  three failed attempts end in a clear terminal page, three ledger rows, `uses` still 0.
 *
 * The retry loop is the page's, not the server's: there is no blocking queue here and
 * nothing waits inside a request beyond the 2 s budget E-27 already bounds.
 */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import type Database from 'better-sqlite3';

import { uploadAsset } from '../app/assets/library.ts';
import { openAdminWrite } from '../app/db/classes.ts';
import { loadEnv } from '../app/env.ts';
import { buildApp, type AppHandle } from '../app/main.ts';
import { assetById, issueCode, seedSettings } from '../app/download/code.ts';
import { WatermarkStore, MAX_RETRY_AFTER_S, STAMP_BUDGET_MS, retryAfterSeconds, type Renderer } from '../app/download/render.ts';
import { RETRY_ATTEMPTS } from '../app/download/plane.ts';
import { TOKEN_TTL_S } from '../app/download/token.ts';
import { makeFixture, type Fixture } from './helpers/fixture.ts';
import { call, header, type Res } from './helpers/http.ts';

const HOST = 'acme.test';
/** The rendered bytes are a marker, not a PDF: this gate asserts the hand-off, not pdf-lib. */
const RENDERED = Buffer.from('%PDF-1.4\n% the stamped copy, drawn for this redemption\n');

let fixture: Fixture;
let contentRoot = '';
let port = 0;
let assetId = 0;

interface Issued {
  id: number;
  code: string;
}

function db<T>(fn: (conn: Database.Database) => T): T {
  const conn = openAdminWrite(fixture.sitePath('acme'));
  try {
    return fn(conn);
  } finally {
    conn.close();
  }
}

async function issue(orderRef: string): Promise<Issued> {
  const conn = openAdminWrite(fixture.sitePath('acme'));
  try {
    const issued = await issueCode({ db: conn, contentRoot, assetKey: 'vault/book', email: null, orderRef });
    return { id: issued.id, code: issued.code };
  } finally {
    conn.close();
  }
}

/** The form's POST, which is how a browser gets its token. */
async function redeemOn(target: number, code: string): Promise<Res> {
  return call({
    port: target,
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

/** A browser navigation: `Accept: text/html`, which is what selects the retry page. */
function page(target: number, cookie: string, path = '/d/acme/file'): Promise<Res> {
  return call({ port: target, path, host: HOST, headers: { cookie, accept: 'text/html,application/xhtml+xml' } });
}

function events(codeId: number): { kind: string; outcome: string; bytes_declared: number }[] {
  return db(
    (conn) =>
      conn
        .prepare(`SELECT kind, outcome, bytes_declared FROM cms_download_event WHERE code_id = ? ORDER BY id`)
        .all(codeId) as never,
  );
}

function uses(codeId: number): number {
  return db(
    (conn) =>
      Number((conn.prepare(`SELECT uses FROM cms_download_code WHERE id = ?`).get(codeId) as { uses: number }).uses),
  );
}

/** `data-retry-ms` and the next URL, read out of the page the buyer would act on. */
function retryPage(body: string): { retryMs: number; jitterMs: number; next: string | undefined; attempt: number } {
  const retryMs = /data-retry-ms="(\d+)"/.exec(body);
  const jitterMs = /data-jitter-ms="(\d+)"/.exec(body);
  const attempt = /data-attempt="(\d+)"/.exec(body);
  const next = /location\.assign\("([^"]+)"/.exec(body);
  assert.ok(retryMs !== null, `the page carries no retry delay:\n${body}`);
  assert.ok(jitterMs !== null, `the page carries no jitter window:\n${body}`);
  assert.ok(attempt !== null, `the page carries no attempt number:\n${body}`);
  return {
    retryMs: Number(retryMs[1]),
    jitterMs: Number(jitterMs[1]),
    next: next === null ? undefined : (next[1] as string),
    attempt: Number(attempt[1]),
  };
}

before(async () => {
  fixture = makeFixture({ specs: [{ key: 'acme', hosts: [HOST], title: 'Acme' }] });
  contentRoot = join(fixture.dir, 'content');
  mkdirSync(join(contentRoot, 'media'), { recursive: true });
  const conn = openAdminWrite(fixture.sitePath('acme'));
  try {
    const uploaded = await uploadAsset({
      db: conn,
      contentRoot,
      tenantKey: 'acme',
      key: 'vault/book',
      filename: 'book.pdf',
      bytes: RENDERED,
      quotaLimitBytes: 50_000_000,
      accessClass: 'gated',
    });
    assetId = uploaded.asset.id;
    // `buildApp` seeds these at boot; R2 issues before any app exists, so do it here.
    seedSettings(conn);
  } finally {
    conn.close();
  }
  port = 0;
});

after(() => {
  fixture.cleanup();
});

// ---------------------------------------------------------------------------------
// R1 — the number in the header, not merely its presence
// ---------------------------------------------------------------------------------

test('R1 — Retry-After is a function of the measured p50 and the queue depth, bounded to 1..10 s', () => {
  // waves = 1 + ceil(backlog / capacity); ms = p50 * waves; seconds = ceil(ms / 1000), 1..10.
  assert.equal(retryAfterSeconds({ p50Ms: 500, backlog: 0, capacity: 8 }), 1, 'an idle queue: one render');
  assert.equal(retryAfterSeconds({ p50Ms: 500, backlog: 1, capacity: 1 }), 1, 'one render ahead on a one-slot box: 1000 ms');
  assert.equal(retryAfterSeconds({ p50Ms: 500, backlog: 9, capacity: 8 }), 2, 'two waves ahead: 1500 ms -> 2 s');
  assert.equal(retryAfterSeconds({ p50Ms: 1800, backlog: 0, capacity: 8 }), 2, 'the p50 alone: 1800 ms -> 2 s');
  assert.equal(retryAfterSeconds({ p50Ms: 1800, backlog: 32, capacity: 8 }), 9, 'a 40-buyer burst: 5 waves -> 9 s');
  assert.equal(retryAfterSeconds({ p50Ms: 60_000, backlog: 0, capacity: 8 }), 10, 'bounded: a page that retries is not a promise');

  // Not a constant: each term moves the answer, and it never goes below one second.
  const idle = retryAfterSeconds({ p50Ms: 500, backlog: 0, capacity: 8 });
  const busy = retryAfterSeconds({ p50Ms: 500, backlog: 16, capacity: 8 });
  const slow = retryAfterSeconds({ p50Ms: 1800, backlog: 0, capacity: 8 });
  assert.ok(busy > idle, `queue depth did not move the answer: ${idle} vs ${busy}`);
  assert.ok(slow > idle, `the measured p50 did not move the answer: ${idle} vs ${slow}`);
  for (const p of [0, 1, 7, 250, 2000, 1e9]) {
    const s = retryAfterSeconds({ p50Ms: p, backlog: 0, capacity: 8 });
    assert.ok(Number.isInteger(s) && s >= 1 && s <= 10, `p50 ${p} -> ${s}`);
  }

  // "…inside the continuation window" is arithmetic, not a promise: the whole retry chain
  // — three attempts, each bounded by the stamp budget, each waiting at most the cap —
  // has to fit in the token's first ten minutes, or the third attempt could be answered
  // `continuation_expired` instead of a page.
  const worstCaseS = RETRY_ATTEMPTS * (MAX_RETRY_AFTER_S + STAMP_BUDGET_MS / 1000);
  assert.equal(RETRY_ATTEMPTS, 3, 'D34: three attempts in total');
  assert.ok(worstCaseS < TOKEN_TTL_S, `three attempts can take ${worstCaseS} s; the window is ${TOKEN_TTL_S} s`);

  process.stdout.write(
    `# R1 retry-after s: idle ${idle}, backlog 16 ${busy}, p50 1800 ${slow}, capped 10; ` +
      `3 attempts worst case ${worstCaseS} s < window ${TOKEN_TTL_S} s\n`,
  );
});

// ---------------------------------------------------------------------------------
// R2 — the p50 is measured from completed renders, with an injected clock
// ---------------------------------------------------------------------------------

test('R2 — the store measures its own p50, and its Retry-After follows the measurement', async () => {
  let clock = 1_700_000_000_000;
  let mode: 'ok' | 'throw' = 'ok';
  const slow = new WatermarkStore({
    contentRoot,
    budgetMs: 5000,
    concurrency: 8,
    globalConcurrency: 8,
    now: () => clock,
    render: async () => {
      clock += 1800; // a measured 1.8 s render, without sleeping
      if (mode === 'throw') throw new Error('the renderer broke after the measurement');
      return RENDERED;
    },
  });
  const instant = new WatermarkStore({
    contentRoot,
    budgetMs: 5000,
    concurrency: 8,
    globalConcurrency: 8,
    now: () => 1_700_000_000_000, // a clock that does not advance: a 0 ms render
    render: async () => RENDERED,
  });

  const buyer = await issue('ORD-R2-MEASURE');
  const code = { id: buyer.id, email: null, orderRef: 'ORD-R2-MEASURE', issuedAt: new Date().toISOString(), selector: 'R2AA' };
  const conn = openAdminWrite(fixture.sitePath('acme'));
  try {
    const asset = assetById(conn, assetId);
    assert.ok(asset !== null);
    const expiresAt = new Date(Date.now() + 6 * 3600_000).toISOString();
    await slow.ensure({ tenantKey: 'acme', db: conn, asset, code, expiresAt });
    assert.equal(slow.pressure().p50Ms, 1800, 'the p50 is the render it just measured');
    assert.equal(slow.retryAfterSeconds(), 2, 'p50 1800 ms with an idle queue is 2 s');

    // The same store, now refusing: the number is the measured one, not a second constant.
    mode = 'throw';
    const other = { ...code, id: buyer.id, orderRef: 'ORD-R2-MEASURE-2', selector: 'R2AB' };
    await assert.rejects(
      slow.ensure({ tenantKey: 'acme', db: conn, asset, code: other, expiresAt }),
      (err: { retryAfter?: number; detail?: { reason?: string } }) => {
        assert.equal(err.detail?.reason, 'renderer');
        assert.equal(err.retryAfter, 2, 'the refusal carries the measured wait');
        return true;
      },
    );

    const third = { ...code, orderRef: 'ORD-R2-INSTANT', selector: 'R2AC' };
    await instant.ensure({ tenantKey: 'acme', db: conn, asset, code: third, expiresAt });
    assert.equal(instant.pressure().p50Ms, 0, 'no time passed between the clock reads');
    assert.equal(instant.retryAfterSeconds(), 1, 'a 0 ms p50 is still a one-second floor');
  } finally {
    conn.close();
  }

  process.stdout.write(
    `# R2 measured p50 1800 ms -> Retry-After ${slow.retryAfterSeconds()} s; ` +
      `p50 0 ms -> ${instant.retryAfterSeconds()} s (prior ${500} ms until one render completes)\n`,
  );
});

// ---------------------------------------------------------------------------------
// R3 — a refusal that clears on attempt 2
// ---------------------------------------------------------------------------------

test('R3 — a refusal that clears on attempt 2 serves the stamped file and spends exactly one use', async () => {
  let attempt = 0;
  const flaky = await appWith({
    render: async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('the renderer failed on the first attempt');
      return RENDERED;
    },
  });
  const buyer = await issue('ORD-R3-RETRY');
  try {
    const redeemed = await redeemOn(flaky.appPort, buyer.code);
    assert.equal(redeemed.status, 303, redeemed.body);
    const cookie = cookieOf(redeemed);

    // Attempt 1: refused, retryable, and it says so three ways — the header, the page, the row.
    const first = await page(flaky.appPort, cookie);
    assert.equal(first.status, 503, first.body);
    assert.equal((first.json as { error?: { code?: string } } | undefined)?.error?.code, undefined, 'a browser gets a page, not JSON');
    const retryAfter = Number(header(first, 'retry-after'));
    assert.ok(Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= 10, `retry-after ${String(header(first, 'retry-after'))}`);
    const p1 = retryPage(first.body);
    assert.equal(p1.attempt, 1, 'attempts are numbered from one');
    assert.equal(p1.retryMs, retryAfter * 1000, 'the page waits exactly what the header says');
    assert.ok(p1.jitterMs > 0 && p1.jitterMs <= 1000, `jitter ${p1.jitterMs}`);
    assert.ok(p1.next !== undefined && p1.next.includes('/d/acme/file?retry=1'), `next ${String(p1.next)}`);
    assert.equal(header(first, 'x-accel-redirect'), undefined, 'a refusal hands off nothing');
    assert.equal(events(buyer.id).length, 1, 'the first attempt has its own row');
    assert.equal(events(buyer.id)[0]?.outcome, 'denied_watermark');

    // Attempt 2 — the page's retry, and the same cookie.
    const second = await page(flaky.appPort, cookie, '/d/acme/file?retry=1');
    assert.equal(second.status, 200, second.body);
    const uri = String(header(second, 'x-accel-redirect'));
    assert.match(uri, /^\/__protected\/wm\/[0-9a-f]{64}\/[0-9a-f]{64}\.pdf$/, uri);
    const file = join(contentRoot, 'protected', uri.slice('/__protected/'.length));
    assert.equal(header(second, 'x-skunkworks-bytes-declared'), String(RENDERED.length));

    const rows = events(buyer.id);
    assert.deepEqual(
      rows.map((r) => `${r.kind}:${r.outcome}:${r.bytes_declared}`),
      [`denied:denied_watermark:0`, `first:ok:${RENDERED.length}`],
      `each attempt writes its own row, and only the serving one is a redemption: ${JSON.stringify(rows)}`,
    );
    assert.equal(uses(buyer.id), 1, 'one redemption, however many attempts it took');

    // The file the header names is the render, not the store's blob.
    const served = await import('node:fs').then((fs) => fs.readFileSync(file));
    assert.equal(served.toString('utf8'), RENDERED.toString('utf8'));

    process.stdout.write(
      `# R3 attempt 1 -> 503 retry-after ${retryAfter} s (page waits ${p1.retryMs} ms + ${p1.jitterMs} ms jitter); ` +
        `attempt 2 -> 200 ${uri}, uses ${uses(buyer.id)}, rows ${rows.map((r) => r.kind).join(',')}\n`,
    );
  } finally {
    await flaky.close();
  }
});

// ---------------------------------------------------------------------------------
// R4 — three failed attempts end somewhere, and say where
// ---------------------------------------------------------------------------------

test('R4 — three failed attempts end in a terminal page, three ledger rows, and uses still 0', async () => {
  const dead = await appWith({
    render: async () => {
      throw new Error('the renderer is down');
    },
  });
  const buyer = await issue('ORD-R4-TERMINAL');
  try {
    const redeemed = await redeemOn(dead.appPort, buyer.code);
    assert.equal(redeemed.status, 303, redeemed.body);
    const cookie = cookieOf(redeemed);

    const pages: Res[] = [];
    pages.push(await page(dead.appPort, cookie));
    pages.push(await page(dead.appPort, cookie, '/d/acme/file?retry=1'));
    pages.push(await page(dead.appPort, cookie, '/d/acme/file?retry=2'));

    for (const [i, res] of pages.entries()) {
      assert.equal(res.status, 503, `attempt ${i + 1}: ${res.body}`);
      const s = Number(header(res, 'retry-after'));
      assert.ok(Number.isInteger(s) && s >= 1 && s <= 10, `attempt ${i + 1} retry-after ${String(header(res, 'retry-after'))}`);
      assert.equal(header(res, 'x-accel-redirect'), undefined, `attempt ${i + 1} hands off nothing`);
    }
    assert.equal(retryPage(pages[0]?.body as string).attempt, 1);
    assert.equal(retryPage(pages[1]?.body as string).attempt, 2);
    assert.ok(
      (retryPage(pages[1]?.body as string).next as string).includes('?retry=2'),
      'the second page offers the third attempt',
    );

    // The third is terminal: no fourth attempt, and it says what happened to the code.
    assert.equal(pages[2]?.body.includes('?retry=3'), false, 'a fourth attempt was offered');
    assert.equal(pages[2]?.body.includes('data-terminal="1"'), true, `no terminal marker:\n${pages[2]?.body as string}`);
    assert.match(pages[2]?.body as string, /has not been used/i);

    const rows = events(buyer.id);
    assert.deepEqual(
      rows.map((r) => `${r.kind}:${r.outcome}:${r.bytes_declared}`),
      ['denied:denied_watermark:0', 'denied:denied_watermark:0', 'denied:denied_watermark:0'],
      `three attempts, three rows, and none of them a redemption: ${JSON.stringify(rows)}`,
    );
    assert.equal(uses(buyer.id), 0, 'three refusals spend nothing');
    assert.equal(
      db((conn) => Number((conn.prepare(`SELECT COUNT(*) AS n FROM cms_download_event WHERE code_id = ? AND kind = 'first'`).get(buyer.id) as { n: number }).n)),
      0,
      'a refusal is not a redemption: no first row exists until one is served',
    );

    // The refusal is not a dead end even after the page stops: a later attempt can still
    // spend the single use, because nothing was spent.
    const late = await page(dead.appPort, cookie, '/d/acme/file?retry=3');
    assert.equal(late.status, 503, 'the renderer is still down');
    assert.equal(uses(buyer.id), 0);

    process.stdout.write(
      `# R4 3 attempts -> 3 x 503, rows ${rows.map((r) => `${r.kind}:${r.outcome}`).join(', ')}, ` +
        `uses ${uses(buyer.id)}, terminal page on attempt 3\n`,
    );
  } finally {
    await dead.close();
  }
});

// ---------------------------------------------------------------------------------
// the harness
// ---------------------------------------------------------------------------------

async function appWith(opts: { render: Renderer; budgetMs?: number }): Promise<{
  appPort: number;
  handle: AppHandle;
  close: () => Promise<void>;
}> {
  const extra = await buildApp({
    env: loadEnv(fixture.env),
    contentRoot,
    downloadLimits: { refusals: 10_000, all: 10_000 },
    watermark: {
      budgetMs: opts.budgetMs ?? 2000,
      render: opts.render,
    },
  });
  const appPort = await extra.app.listen({ port: 0, host: '127.0.0.1' }).then(() => {
    const address = extra.app.server.address();
    return typeof address === 'object' && address !== null ? address.port : 0;
  });
  return { appPort, handle: extra, close: () => extra.close() };
}
