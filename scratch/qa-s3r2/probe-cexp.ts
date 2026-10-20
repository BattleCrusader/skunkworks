/**
 * QA S3 round 2 / item A.3 — **`cexp`: the continuation performs no INSERT, cannot create a
 * purchase, and the cookie does not outlive the render it authorises.**
 *
 * Five measurements, each against a real `buildApp`, a real `site.db` and real HTTP:
 *
 *   1. a live download: uses 1, one `first:ok` row, one render;
 *   2. the same token in the middle window (`exp < now <= cexp`): 200, uses unchanged, and
 *      **every row count in the tenant unchanged** — the continuation path inserts nothing;
 *   3. a middle-window token whose `jti` has no row: 401 `no_redemption`, row counts
 *      unchanged — a continuation cannot *become* a purchase;
 *   4. a middle-window token whose row is a denial: refused, and the denial is not upgraded;
 *   5. `Max-Age` == `cexp - iat`, and the render's `expires_at` is `cexp + grace` — so the
 *      cookie cannot outlive the file it authorises.
 *
 * Row counting is done on `cms_download_event` (all rows, not just this code's) and on
 * `cms_watermark_render`, before and after each request, so an INSERT anywhere is visible.
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
import { mintToken, type Claims } from '../../app/download/token.ts';
import { makeFixture, type Fixture } from '../../test/helpers/fixture.ts';
import { call, header, type Res } from '../../test/helpers/http.ts';

const HOST = 'acme.test';
const out = (s: string): void => process.stdout.write(`${s}\n`);

async function makePdf(pages: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i += 1) doc.addPage([612, 792]).drawText(`p${i}`, { x: 72, y: 700, size: 12, font });
  return Buffer.from(await doc.save());
}

const fixture: Fixture = makeFixture({ specs: [{ key: 'acme', hosts: [HOST], title: 'Acme' }] });
const contentRoot = join(fixture.dir, 'content');
mkdirSync(contentRoot, { recursive: true });

let handle: AppHandle;
let port = 0;

function db<T>(fn: (conn: Database.Database) => T): T {
  const conn = openAdminWrite(fixture.sitePath('acme'));
  try {
    return fn(conn);
  } finally {
    conn.close();
  }
}

const counts = (): { events: number; first: number; renders: number } =>
  db((c) => ({
    events: Number((c.prepare(`SELECT COUNT(*) AS n FROM cms_download_event`).get() as { n: number }).n),
    first: Number(
      (c.prepare(`SELECT COUNT(*) AS n FROM cms_download_event WHERE kind = 'first'`).get() as { n: number }).n,
    ),
    renders: Number((c.prepare(`SELECT COUNT(*) AS n FROM cms_watermark_render`).get() as { n: number }).n),
  }));

const usesOf = (id: number): number =>
  db((c) => Number((c.prepare(`SELECT uses FROM cms_download_code WHERE id = ?`).get(id) as { uses: number }).uses));

function cookieOf(res: Res): string {
  const raw = String(header(res, 'set-cookie') ?? '');
  return raw.slice(0, raw.indexOf(';'));
}
const maxAgeOf = (res: Res): number => {
  const raw = String(header(res, 'set-cookie') ?? '');
  const m = /Max-Age=(\d+)/.exec(raw);
  return m === null ? -1 : Number(m[1]);
};
const tokenOf = (cookie: string): { raw: string; claims: Claims } => {
  const raw = cookie.slice(cookie.indexOf('=') + 1);
  const payload = raw.split('.')[1] as string;
  return { raw, claims: JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Claims };
};

const redeem = (code: string): Promise<Res> =>
  call({
    port,
    path: '/d/acme',
    method: 'POST',
    host: HOST,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  });
const download = (cookie: string, ua?: string): Promise<Res> =>
  call({
    port,
    path: '/d/acme/file',
    host: HOST,
    headers: { cookie, ...(ua === undefined ? {} : { 'user-agent': ua }) },
  });

const reason = (res: Res): string =>
  String((res.json as { error?: { detail?: { reason?: string } } } | undefined)?.error?.detail?.reason ?? '');

async function issue(email: string, orderRef: string): Promise<{ id: number; code: string }> {
  const conn = openAdminWrite(fixture.sitePath('acme'));
  try {
    const row = await issueCode({ db: conn, contentRoot, assetKey: 'vault/book', email, orderRef });
    return { id: row.id, code: row.code };
  } finally {
    conn.close();
  }
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
  handle = await buildApp({ env: loadEnv(fixture.env), contentRoot, downloadLimits: { refusals: 10_000, all: 10_000 } });
  port = await handle.app.listen({ port: 0, host: '127.0.0.1' }).then(() => {
    const a = handle.app.server.address();
    return typeof a === 'object' && a !== null ? a.port : 0;
  });

  const key = loadEnv(fixture.env).downloadTokenKey;
  const nowS = Math.floor(Date.now() / 1000);

  // ---- 1: a live download, and the numbers everything else is compared against -----
  const code = await issue('q@example.com', 'ORD-QA-1');
  const minted = await redeem(code.code);
  const cookie1 = cookieOf(minted);
  const t1 = tokenOf(cookie1);
  const maxAge = maxAgeOf(minted);
  const live = await download(cookie1);
  const afterLive = counts();
  const renderRow = db((c) =>
    c.prepare(`SELECT expires_at, bytes, path FROM cms_watermark_render`).get() as
      | { expires_at: string; bytes: number; path: string }
      | undefined,
  );
  out(
    `# A1 live download ${live.status} uses=${usesOf(code.id)} events=${afterLive.events} first=${afterLive.first} ` +
      `renders=${afterLive.renders}`,
  );
  out(
    `# A1 cookie Max-Age ${maxAge}; iat ${t1.claims.iat} exp ${t1.claims.exp} cexp ${t1.claims.cexp}; ` +
      `cexp-iat ${t1.claims.cexp - t1.claims.iat} -> Max-Age == cexp-iat: ${maxAge === t1.claims.cexp - t1.claims.iat}`,
  );

  // ---- 2: the same token in the middle window --------------------------------------
  const before2 = counts();
  const mid = mintToken(key, { ...t1.claims, iat: nowS - 1200, exp: nowS - 600, cexp: nowS + 20_400 });
  const resumed = await download(`__Host-sk-dl-acme=${mid}`);
  const after2 = counts();
  out(
    `# A2 middle window (exp ${nowS - 600} < now ${nowS} <= cexp ${nowS + 20_400}): ${resumed.status} ` +
      `x-accel=${String(header(resumed, 'x-accel-redirect') ?? 'ABSENT')} uses ${usesOf(code.id)}`,
  );
  out(
    `# A2 rows before ${JSON.stringify(before2)} after ${JSON.stringify(after2)} — delta ` +
      `events ${after2.events - before2.events}, first ${after2.first - before2.first}, renders ${after2.renders - before2.renders}`,
  );

  // ---- 3: middle window, no row at all --------------------------------------------
  const fresh = await issue('q2@example.com', 'ORD-QA-2');
  const freshMint = await redeem(fresh.code);
  const freshClaims = tokenOf(cookieOf(freshMint)).claims;
  const before3 = counts();
  const orphan = mintToken(key, { ...freshClaims, iat: nowS - 1200, exp: nowS - 600, cexp: nowS + 20_400 });
  const orphanRes = await download(`__Host-sk-dl-acme=${orphan}`);
  const after3 = counts();
  out(
    `# A3 middle window, no first row: ${orphanRes.status} reason=${reason(orphanRes)} uses ${usesOf(fresh.id)} — ` +
      `rows delta events ${after3.events - before3.events}, first ${after3.first - before3.first}, renders ${after3.renders - before3.renders}`,
  );

  // ---- 4: a denial is not a continuation -------------------------------------------
  // A real `denied_watermark` row, written by a store with no time left, then continued.
  const deniedCode = await issue('q3@example.com', 'ORD-QA-3');
  const deniedMint = await redeem(deniedCode.code);
  const deniedClaims = tokenOf(cookieOf(deniedMint)).claims;
  db((c) =>
    c
      .prepare(
        `INSERT INTO cms_download_event (jti, kind, code_id, asset_id, bytes_declared, ip_hash, ua_hash, outcome)
         VALUES (?, 'first', ?, ?, 0, ?, ?, 'denied_watermark')`,
      )
      .run(deniedClaims.jti, deniedCode.id, deniedClaims.aid, deniedClaims.iph, deniedClaims.uah),
  );
  const before4 = counts();
  const denyTok = mintToken(key, { ...deniedClaims, iat: nowS - 1200, exp: nowS - 600, cexp: nowS + 20_400 });
  const denyRes = await download(`__Host-sk-dl-acme=${denyTok}`);
  const after4 = counts();
  out(
    `# A4 middle window, row outcome=denied_watermark: ${denyRes.status} reason=${reason(denyRes)} uses ${usesOf(deniedCode.id)} ` +
      `rows delta events ${after4.events - before4.events}, first ${after4.first - before4.first}`,
  );

  // ---- 5: past cexp reaches no database -------------------------------------------
  const before5 = counts();
  const dead = mintToken(key, { ...t1.claims, iat: nowS - 30_000, exp: nowS - 29_400, cexp: nowS - 20_000 });
  const pastRes = await download(`__Host-sk-dl-acme=${dead}`);
  const after5 = counts();
  out(
    `# A5 past cexp: ${pastRes.status} reason=${reason(pastRes)} rows delta events ${after5.events - before5.events}, ` +
      `first ${after5.first - before5.first}, renders ${after5.renders - before5.renders}`,
  );

  // ---- 6: the cookie against the render it authorises ------------------------------
  const renderExpiry = renderRow === undefined ? Number.NaN : Date.parse(renderRow.expires_at) / 1000;
  const grace = db(
    (c) =>
      Number(
        (
          c.prepare(`SELECT value_json FROM cms_settings WHERE key = 'download.continuation_grace_s'`).get() as
            | { value_json: string }
            | undefined
        )?.value_json ?? '0',
      ),
  );
  out(
    `# A6 render expires_at ${renderRow?.expires_at} = ${renderExpiry} (unix s); cexp + grace = ${t1.claims.cexp + grace}; ` +
      `equal: ${renderExpiry === t1.claims.cexp + grace}`,
  );
  out(
    `# A6 cookie dies at iat + Max-Age = ${t1.claims.iat + maxAge} = cexp ${t1.claims.cexp} (equal: ` +
      `${t1.claims.iat + maxAge === t1.claims.cexp}); render outlives the cookie by ${renderExpiry - t1.claims.cexp} s ` +
      `(must be >= 0)`,
  );

  // ---- 7: can a continuation create a purchase for another asset? -----------------
  const otherConn = openAdminWrite(fixture.sitePath('acme'));
  let otherId = 0;
  try {
    const uploaded = await uploadAsset({
      db: otherConn,
      contentRoot,
      tenantKey: 'acme',
      key: 'vault/second',
      filename: 'second.pdf',
      bytes: pdf,
      quotaLimitBytes: 50_000_000,
      accessClass: 'gated',
    });
    otherId = uploaded.asset.id;
  } finally {
    otherConn.close();
  }
  const stolen = mintToken(key, { ...t1.claims, aid: otherId, iat: nowS - 1200, exp: nowS - 600, cexp: nowS + 20_400 });
  const stolenRes = await download(`__Host-sk-dl-acme=${stolen}`);
  // A token whose jti is an `ok` redemption of code A but whose aid is asset B: the code row
  // is looked up by cid and its asset compared, so this is a binding refusal.
  out(`# A7 mid-window token with aid of another asset: ${stolenRes.status} reason=${reason(stolenRes)}`);

  // ---- 8: another client cannot continue it --------------------------------------
  const otherClient = await download(`__Host-sk-dl-acme=${mid}`, 'other-device/1.0');
  out(`# A8 the same middle-window token from another UA: ${otherClient.status} reason=${reason(otherClient)}`);

  await handle.close();
  fixture.cleanup();
}

await main();
