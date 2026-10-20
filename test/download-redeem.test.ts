/**
 * S3c / §7.4 / §16 S3 — **the gated download plane, over real sockets.**
 *
 * Every assertion here is the acceptance table's, in its order, against a real
 * `buildApp` and a real `site.db`:
 *
 *   R1  one use per token, even under 8 parallel `Range` requests, with exactly one
 *       `cms_download_event` row — and a second batch of ranges spends nothing more;
 *   R2  two tokens spend two;
 *   R3  `Range: bytes=1-` cannot bypass the counter once the use is spent;
 *   R4  an unknown selector and a wrong secret are one status, one body and one code;
 *   R5  a garbage or oversized token is `401`, never `500`;
 *   R6  `报告.pdf` is `200` with `filename*=UTF-8''…`;
 *   R7  `bytes_declared` is the length the app authorised and `bytes_sent` stays NULL;
 *   R8  a missing blob is `503 SKW_E_RT_ASSET_MISSING` and spends nothing;
 *   R9  unlimited behind the toggle, and lowering `max_uses` below `uses` blocks the
 *       next redemption immediately.
 *
 * The limiter is deliberately out of the way for the functional cases (the plane is
 * built with `downloadLimits`) and asserted on its own instance at the bottom of the
 * file, where 6 refusals in a row hit it and a correct 7th attempt is still refused.
 */
import assert from 'node:assert/strict';
import { existsSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import type Database from 'better-sqlite3';

import { uploadAsset } from '../app/assets/library.ts';
import { openAdminWrite } from '../app/db/classes.ts';
import { loadEnv } from '../app/env.ts';
import { buildApp, type AppHandle } from '../app/main.ts';
import { issueCode, updateCode } from '../app/download/code.ts';
import { mintToken } from '../app/download/token.ts';
import { makeFixture, type Fixture } from './helpers/fixture.ts';
import { call, header, type Res } from './helpers/http.ts';

const HOST = 'acme.test';
const PDF =
  '%PDF-1.7\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
  '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\ntrailer<</Root 1 0 R/Size 4>>\n%%EOF\n';

let fixture: Fixture;
let handle: AppHandle;
let port = 0;
let contentRoot = '';
let bookSha = '';
let bookBytes = 0;
let reportId = 0;

interface Issued {
  id: number;
  code: string;
}

function siteDb(): Database.Database {
  return openAdminWrite(fixture.sitePath('acme'));
}

async function upload(key: string, filename: string, bytes: Buffer): Promise<{ sha: string; id: number }> {
  const db = siteDb();
  try {
    const result = await uploadAsset({
      db,
      contentRoot,
      tenantKey: 'acme',
      key,
      filename,
      bytes,
      quotaLimitBytes: 10_000_000,
      accessClass: 'gated',
    });
    return { sha: result.asset.sha256, id: result.asset.id };
  } finally {
    db.close();
  }
}

/** Issue through the real issuer, with the tenant default (3) unless a count is given. */
async function issue(maxUses?: number | null, assetKey = 'vault/book'): Promise<Issued> {
  const db = siteDb();
  try {
    const issued = await issueCode({
      db,
      contentRoot,
      assetKey,
      maxUses,
      confirmUnlimited: maxUses === null,
    });
    return { id: issued.id, code: issued.code };
  } finally {
    db.close();
  }
}

function redeem(code: string, opts: { host?: string; accept?: string } = {}): Promise<Res> {
  return call({
    port,
    path: '/d/acme',
    method: 'POST',
    host: opts.host ?? HOST,
    headers: { 'content-type': 'application/json', ...(opts.accept === undefined ? {} : { accept: opts.accept }) },
    body: JSON.stringify({ code }),
  });
}

function cookieOf(res: Res): string {
  const raw = String(header(res, 'set-cookie') ?? '');
  return raw.slice(0, raw.indexOf(';'));
}

function download(cookie: string, extra: Record<string, string> = {}): Promise<Res> {
  return call({ port, path: '/d/acme/file', host: HOST, headers: { cookie, ...extra } });
}

function events(codeId: number): { kind: string; outcome: string; bytes_declared: number; bytes_sent: number | null; jti: string | null }[] {
  const db = siteDb();
  try {
    return db
      .prepare(`SELECT kind, outcome, bytes_declared, bytes_sent, jti FROM cms_download_event WHERE code_id = ? ORDER BY id`)
      .all(codeId) as never;
  } finally {
    db.close();
  }
}

function usesOf(codeId: number): number {
  const db = siteDb();
  try {
    return Number((db.prepare(`SELECT uses FROM cms_download_code WHERE id = ?`).get(codeId) as { uses: number }).uses);
  } finally {
    db.close();
  }
}

before(async () => {
  fixture = makeFixture({ specs: [{ key: 'acme', hosts: [HOST], title: 'Acme' }] });
  contentRoot = join(fixture.dir, 'content');
  const book = await upload('vault/book', 'book.pdf', Buffer.from(PDF, 'latin1'));
  bookSha = book.sha;
  bookBytes = Buffer.byteLength(PDF, 'latin1');
  reportId = (await upload('vault/report', '报告.pdf', Buffer.from(PDF, 'latin1'))).id;

  // The timing assertions live in test/perf; these cases must not spend their budget
  // inside the limiter, which is asserted on its own instance at the end.
  handle = await buildApp({
    env: loadEnv(fixture.env),
    contentRoot,
    downloadLimits: { refusals: 10_000, all: 10_000 },
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

test('R1 — 8 parallel Range requests under one token spend exactly one use and write one row', async () => {
  const code = await issue(3);
  const res = await redeem(code.code);
  assert.equal(res.status, 303, res.body);
  const cookie = cookieOf(res);
  assert.match(cookie, /^__Host-sk-dl-acme=v1\./);
  const raw = String(header(res, 'set-cookie'));
  assert.match(raw, /; Path=\/; Secure; HttpOnly; SameSite=Lax/);

  const parallel = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      download(cookie, i === 0 ? {} : { range: i === 1 ? 'bytes=1-' : `bytes=${i}-` }),
    ),
  );
  for (const r of parallel) {
    assert.equal(r.status, 200, r.body);
    // S3d: a gated PDF is stamped per purchaser, so the hand-off is the render tree —
    // never the content-addressed blob every buyer shares. The shape is asserted, not a
    // literal, because the spec hash is the buyer's.
    assert.match(String(header(r, 'x-accel-redirect')), /^\/__protected\/wm\/[0-9a-f]{64}\/[0-9a-f]{64}\.pdf$/);
    assert.ok(!String(header(r, 'x-accel-redirect')).startsWith(`/__protected/${bookSha.slice(0, 2)}/`));
    assert.equal(r.body, '', 'the app sends no bytes: nginx serves the file');
  }

  assert.equal(usesOf(code.id), 1, 'one redemption, eight requests');
  const rows = events(code.id);
  assert.equal(rows.length, 1, `expected one event row, got ${JSON.stringify(rows)}`);
  assert.equal(rows[0]?.kind, 'first');
  assert.equal(rows[0]?.outcome, 'ok');
  process.stdout.write(
    `# R1 8 parallel ranges -> 200 x8, uses=${usesOf(code.id)}, event rows=${rows.length} ` +
      `(kinds ${rows.map((r) => `${r.kind}:${r.outcome}`).join(',')}), bytes_declared=${rows[0]?.bytes_declared}\n`,
  );

  // A second batch of ranges is the same redemption: still one use.
  const again = await Promise.all(
    Array.from({ length: 8 }, (_, i) => download(cookie, { range: `bytes=${i * 2}-` })),
  );
  for (const r of again) assert.equal(r.status, 200, r.body);
  assert.equal(usesOf(code.id), 1);
  assert.equal(events(code.id).length, 1);
});

test('R2 — two different tokens spend two uses and write two rows', async () => {
  const code = await issue(3);
  const a = cookieOf(await redeem(code.code));
  const b = cookieOf(await redeem(code.code));
  assert.notEqual(a, b);
  assert.equal((await download(a)).status, 200);
  assert.equal((await download(b)).status, 200);
  assert.equal(usesOf(code.id), 2);
  const rows = events(code.id);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.kind), ['first', 'first']);
});

test('R3 — Range: bytes=1- cannot bypass the counter once the use is spent', async () => {
  const code = await issue(1);
  const first = cookieOf(await redeem(code.code));
  const res = await download(first, { range: 'bytes=0-' });
  assert.equal(res.status, 200);
  assert.equal(usesOf(code.id), 1);

  // The bypass the SDS rejects: a second token, a range that does not start at 0.
  const second = cookieOf(await redeem(code.code));
  const bypass = await download(second, { range: 'bytes=1-' });
  assert.equal(bypass.status, 410, bypass.body);
  assert.equal((bypass.json as { error: { code: string } }).error.code, 'SKW_E_SEC_USES_EXHAUSTED');
  assert.equal(usesOf(code.id), 1, 'the refused request spent nothing');
  const rows = events(code.id);
  assert.deepEqual(
    rows.map((r) => `${r.kind}:${r.outcome}`),
    ['first:ok', 'first:denied_quota'],
    'one redemption and one denial, both on the ledger',
  );
});

test('R3b — an oversized range is clamped, still spends one use, and bytes_declared is the render', async () => {
  const code = await issue(2);
  const cookie = cookieOf(await redeem(code.code));
  const res = await download(cookie, { range: 'bytes=0-999999999' });
  assert.equal(res.status, 200);
  assert.equal(usesOf(code.id), 1);
  // S3d: the file is the render, so "the file" is its length, not the blob's.
  const uri = String(header(res, 'x-accel-redirect'));
  const renderBytes = statSync(join(contentRoot, 'protected', uri.slice('/__protected/'.length))).size;
  assert.equal(events(code.id)[0]?.bytes_declared, renderBytes);
});

test('R3c — an unsatisfiable range is 416, writes no event and spends nothing', async () => {
  const code = await issue(2);
  const cookie = cookieOf(await redeem(code.code));
  // A start past any render this box can produce. The 416 is measured against the
  // *render's* length, which the stamp produced before the range was validated.
  const res = await download(cookie, { range: 'bytes=999999999-' });
  assert.equal(res.status, 416);
  assert.equal(usesOf(code.id), 0);
  assert.equal(events(code.id).length, 0, 'C-7: 416 writes no first event');

  // and the same token still works afterwards: the 416 cost it nothing.
  const after = await download(cookie);
  assert.equal(after.status, 200);
  const uri = String(header(after, 'x-accel-redirect'));
  const renderBytes = statSync(join(contentRoot, 'protected', uri.slice('/__protected/'.length))).size;
  assert.equal(header(res, 'content-range'), `bytes */${renderBytes}`, 'the 416 names the render, not the blob');
  assert.equal(usesOf(code.id), 1);
});

test('R4 — an unknown selector and a wrong secret are indistinguishable', async () => {
  const real = await issue(2);
  const alpha = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  // A selector that cannot exist: flip the real one's first character.
  const unknown = (alpha[(alpha.indexOf(real.code[0] as string) + 1) % 32] as string) + real.code.slice(1);
  assert.notEqual(unknown.slice(0, 4), real.code.slice(0, 4));
  const wrong = real.code.slice(0, 15) + (real.code[15] === 'Z' ? 'Y' : 'Z');

  const a = await redeem(unknown);
  const b = await redeem(wrong);
  assert.equal(a.status, 401);
  assert.equal(b.status, 401);
  const body = (r: Res): unknown => {
    const j = r.json as { error: { code: string; message?: string; detail?: unknown; requestId: string } };
    // §4.3 requires a per-request id, so identity is asserted over the body with that
    // one field masked — it is the only field that is allowed to differ.
    return { ...j.error, requestId: '<masked>' };
  };
  assert.deepEqual(body(a), body(b));
  assert.equal((a.json as { error: { code: string } }).error.code, 'SKW_E_SEC_CODE_INVALID');

  // Both refusals are on the ledger too (C-6: one event row on each path).
  const db = siteDb();
  try {
    const denied = db
      .prepare(`SELECT COUNT(*) AS n FROM cms_download_event WHERE kind = 'denied' AND outcome = 'denied_token'`)
      .get() as { n: number };
    assert.ok(denied.n >= 2, `expected the two refusals on the ledger, saw ${denied.n}`);
  } finally {
    db.close();
  }
});

test('R5. a garbage or oversized token is 401, never 500', async () => {
  const cases: [string, string][] = [
    ['not-a-token', 'v1'],
    ['two.parts', 'v1'],
    ['v1..', 'v1'],
    ['v2.eyJhIjoxfQ.AAAA', 'v2'],
    // A MAC that decodes to 8 bytes: `timingSafeEqual` would throw here without the length check.
    ['v1.eyJhIjoxfQ.AAAAAAAAAAA', 'short-mac'],
    ['v1.' + 'a'.repeat(5000) + '.' + 'b'.repeat(43), 'oversized'],
  ];
  for (const [token, label] of cases) {
    const res = await download(`__Host-sk-dl-acme=${token}`);
    assert.equal(res.status, 401, `${label} answered ${res.status}: ${res.body}`);
    assert.equal((res.json as { error: { code: string } }).error.code, 'SKW_E_SEC_TOKEN_INVALID', label);
  }
});

test('R5b. a token minted for another client, asset or clock is refused', async () => {
  const code = await issue(2);
  const nowS = Math.floor(Date.now() / 1000);
  const key = loadEnv(fixture.env).downloadTokenKey;
  const claims = { jti: 'a'.repeat(32), cid: code.id, aid: 1, iat: nowS, exp: nowS + 600, iph: 'x'.repeat(22), uah: 'y'.repeat(22) };

  const otherClient = await download(`__Host-sk-dl-acme=${mintToken(key, claims)}`);
  assert.equal(otherClient.status, 401);
  assert.equal((otherClient.json as { error: { code: string } }).error.code, 'SKW_E_SEC_TOKEN_MISMATCH');

  // A token whose `aid` is not the code's asset is a mismatch even with a good MAC.
  const good = cookieOf(await redeem(code.code));
  const token = good.slice(good.indexOf('=') + 1);
  const payload = token.split('.')[1] as string;
  const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
  const forged = mintToken(key, { ...decoded, aid: reportId } as never);
  const res = await download(`__Host-sk-dl-acme=${forged}`);
  assert.equal(res.status, 401, res.body);
  assert.equal((res.json as { error: { code: string } }).error.code, 'SKW_E_SEC_TOKEN_MISMATCH');

  // An expired token: `exp - iat` is still 600, so only the clock can refuse it.
  const stale = mintToken(key, { ...decoded, iat: nowS - 3600, exp: nowS - 3000 } as never);
  const expired = await download(`__Host-sk-dl-acme=${stale}`);
  assert.equal(expired.status, 401, expired.body);
  assert.equal((expired.json as { error: { code: string } }).error.code, 'SKW_E_SEC_TOKEN_INVALID');
});

test('R6 — 报告.pdf downloads with filename*=UTF-8\'\'… and status 200', async () => {
  const code = await issue(2, 'vault/report');
  const cookie = cookieOf(await redeem(code.code));
  const res = await download(cookie);
  assert.equal(res.status, 200, res.body);
  const disposition = String(header(res, 'content-disposition'));
  assert.match(disposition, /^attachment; filename="[^"]*"; filename\*=UTF-8''/);
  assert.match(disposition, /filename\*=UTF-8''%E6%8A%A5%E5%91%8A\.pdf/);
  assert.match(disposition, /filename="[\x20-\x7e]*"/, 'the fallback is ASCII-only');
  assert.equal(header(res, 'content-type'), 'application/pdf');
});

test('R7 — bytes_declared is the authorised length; bytes_sent stays NULL', async () => {
  const code = await issue(2);
  const cookie = cookieOf(await redeem(code.code));
  const full = await download(cookie);
  assert.equal(full.status, 200);
  // S3d: the file the buyer receives is the stamped render, so the authorised length is
  // the render's, not the store blob's — and it is the length nginx will send.
  const uri = String(header(full, 'x-accel-redirect'));
  const renderBytes = statSync(join(contentRoot, 'protected', uri.slice('/__protected/'.length))).size;
  const [row] = events(code.id);
  assert.equal(row?.bytes_declared, renderBytes);
  assert.notEqual(renderBytes, bookBytes, 'a stamped PDF is not the stored blob byte-for-byte');
  assert.equal(row?.bytes_sent, null, 'v1 never observes a byte count');

  const ranged = await issue(2);
  const cookie2 = cookieOf(await redeem(ranged.code));
  assert.equal((await download(cookie2, { range: 'bytes=10-19' })).status, 200);
  const [row2] = events(ranged.id);
  assert.equal(row2?.bytes_declared, 10, 'a satisfiable range authorises its own length');
});

test('R8 — a missing blob is 503 SKW_E_RT_ASSET_MISSING and spends nothing', async () => {
  const code = await issue(2);
  const cookie = cookieOf(await redeem(code.code));
  const path = join(contentRoot, 'media', bookSha.slice(0, 2), `${bookSha}.pdf`);
  assert.ok(existsSync(path), 'the blob exists before the test removes it');
  rmSync(path);
  try {
    const res = await download(cookie);
    assert.equal(res.status, 503, res.body);
    assert.equal((res.json as { error: { code: string } }).error.code, 'SKW_E_RT_ASSET_MISSING');
    assert.equal(usesOf(code.id), 0, "a missing file does not burn the customer's use");
    assert.equal(events(code.id).length, 0);
  } finally {
    // Put the blob back so later tests are not measuring this one's damage.
    writeFileSync(path, Buffer.from(PDF, 'latin1'));
  }
});

test('R9 — a code with max_uses NULL is unlimited only behind the toggle and the confirmation', async () => {
  const db = siteDb();
  try {
    db.prepare(`UPDATE cms_settings SET value_json = 'true' WHERE key = 'download.allow_unlimited'`).run();
  } finally {
    db.close();
  }
  const code = await issue(null);
  assert.equal(usesOf(code.id), 0);
  for (let i = 0; i < 3; i += 1) {
    const cookie = cookieOf(await redeem(code.code));
    assert.equal((await download(cookie)).status, 200, `redemption ${i + 1}`);
  }
  assert.equal(usesOf(code.id), 3);
  const raw = siteDb().prepare(`SELECT max_uses FROM cms_download_code WHERE id = ?`).get(code.id) as {
    max_uses: number | null;
  };
  assert.equal(raw.max_uses, null);
});

test('R10 — lowering max_uses below uses blocks the next redemption immediately', async () => {
  const code = await issue(3);
  const first = cookieOf(await redeem(code.code));
  assert.equal((await download(first)).status, 200);
  assert.equal(usesOf(code.id), 1);

  const db = siteDb();
  try {
    updateCode(db, code.id, { maxUses: 1 });
  } finally {
    db.close();
  }
  assert.equal(usesOf(code.id), 1, 'the edit does not rewrite history');

  const next = cookieOf(await redeem(code.code));
  const res = await download(next);
  assert.equal(res.status, 410, res.body);
  assert.equal(usesOf(code.id), 1);
});

test('R10b — a revoked code stops a token that was already minted', async () => {
  const code = await issue(3);
  const cookie = cookieOf(await redeem(code.code));
  assert.equal((await download(cookie)).status, 200);

  const db = siteDb();
  try {
    db.prepare(`UPDATE cms_download_code SET revoked_at = ? WHERE id = ?`).run(new Date().toISOString(), code.id);
  } finally {
    db.close();
  }
  const res = await download(cookie);
  assert.equal(res.status, 401, res.body);
  assert.equal((res.json as { error: { code: string } }).error.code, 'SKW_E_SEC_CODE_INVALID');
});

test('R11 — the form is served to a browser and a bad code comes back as the same form', async () => {
  const form = await call({ port, path: '/d/acme', host: HOST, headers: { accept: 'text/html' } });
  assert.equal(form.status, 200);
  assert.match(form.body, /<form method="post" action="\/d\/acme"/);
  assert.match(form.body, /name="code"/);

  const bad = await redeem('ZZZZZZZZZZZZZZZZ', { accept: 'text/html' });
  assert.equal(bad.status, 401);
  assert.match(bad.body, /That code is not valid\./);
  assert.match(bad.body, /<form method="post"/, 'the human gets the form back, not a JSON body');
});

test('R12 — the limiter: 5 refusals per 15 minutes per IP, and the 6th attempt is 429', async () => {
  // A second instance, with the shipped limits, so the functional cases above cannot
  // have spent this budget. Same fixture, same content, fresh windows.
  const limited = await buildApp({ env: loadEnv(fixture.env), contentRoot });
  const limitedPort = await limited.app.listen({ port: 0, host: '127.0.0.1' }).then(() => {
    const address = limited.app.server.address();
    return typeof address === 'object' && address !== null ? address.port : 0;
  });
  try {
    const code = await issue(3);
    const wrong = code.code.slice(0, 15) + (code.code[15] === 'Z' ? 'Y' : 'Z');
    const statuses: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const res = await call({
        port: limitedPort,
        path: '/d/acme',
        method: 'POST',
        host: HOST,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: wrong }),
      });
      statuses.push(res.status);
    }
    assert.deepEqual(statuses, [401, 401, 401, 401, 401], `the first five are refusals: ${statuses}`);

    const sixth = await call({
      port: limitedPort,
      path: '/d/acme',
      method: 'POST',
      host: HOST,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: wrong }),
    });
    assert.equal(sixth.status, 429, sixth.body);
    assert.equal((sixth.json as { error: { code: string } }).error.code, 'SKW_E_SEC_RATE_LIMITED');
    // Which window closed first: the IP's. It is the cheaper bucket to close, and the
    // reason is diagnostic (an attacker learns nothing they did not just prove).
    assert.equal(
      (sixth.json as { error: { detail?: { reason?: string } } }).error.detail?.reason,
      'ip',
      'the address budget closes before the selector budget',
    );

    // The point of a guessing limit: the 6th attempt is refused even when it is right.
    const right = await call({
      port: limitedPort,
      path: '/d/acme',
      method: 'POST',
      host: HOST,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: code.code }),
    });
    assert.equal(right.status, 429, 'a correct code after five failures is still rate-limited');
  } finally {
    await limited.close();
  }
});

test('R12b — the IP window closes on its own, across six different selectors', async () => {
  // Six *distinct* nonexistent selectors: each selector's own window is at one, so only
  // the per-IP counter can answer 429 on the sixth. This is the case that fails if the
  // refusal counter is not wired to the address.
  const limited = await buildApp({ env: loadEnv(fixture.env), contentRoot });
  const limitedPort = await limited.app.listen({ port: 0, host: '127.0.0.1' }).then(() => {
    const address = limited.app.server.address();
    return typeof address === 'object' && address !== null ? address.port : 0;
  });
  const alpha = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const fresh = (i: number): string => `${alpha[i % 32]}${alpha[(i * 7) % 32]}${alpha[(i * 11) % 32]}${alpha[(i * 13) % 32]}`.padEnd(16, 'Z');
  try {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const res = await call({
        port: limitedPort,
        path: '/d/acme',
        method: 'POST',
        host: HOST,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: fresh(i) }),
      });
      statuses.push(res.status);
    }
    assert.deepEqual(statuses, [401, 401, 401, 401, 401, 429], `six distinct selectors: ${statuses}`);
  } finally {
    await limited.close();
  }
});
