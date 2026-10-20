/**
 * QA S3 round 2 / A.3b — **the reuse window is bounded in time, so a continuation cannot be
 * renewed forever, and a token keeps the `cexp` it was minted with.**
 *
 * Two attacks on E-26's mint idempotency:
 *
 *   1. shrink `download.continuation_grace_s` to 2 s, download, wait past it, re-type the
 *      code: the mint must take a **new** `jti` and the next download must spend a second
 *      use. If it reused the old one, one use would buy unlimited downloads forever.
 *   2. mint under the default 21 600 s, then *lower* the setting to 5 s and continue with
 *      the token already in the browser: the check is against the claim, so the continuation
 *      must still be served (a settings edit may not retroactively shorten a token).
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
import { mintToken, type Claims } from '../../app/download/token.ts';
import { makeFixture, type Fixture } from '../../test/helpers/fixture.ts';
import { call, header, type Res } from '../../test/helpers/http.ts';

const HOST = 'acme.test';
const out = (s: string): void => process.stdout.write(`${s}\n`);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function makePdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([612, 792]).drawText('x', { x: 72, y: 700, size: 12, font });
  return Buffer.from(await doc.save());
}

const fixture: Fixture = makeFixture({ specs: [{ key: 'acme', hosts: [HOST], title: 'Acme' }] });
const contentRoot = join(fixture.dir, 'content');
mkdirSync(contentRoot, { recursive: true });

let port = 0;
let handle: AppHandle;

const cookieOf = (res: Res): string => {
  const raw = String(header(res, 'set-cookie') ?? '');
  return raw.slice(0, raw.indexOf(';'));
};
const claimsOf = (cookie: string): Claims => {
  const raw = cookie.slice(cookie.indexOf('=') + 1);
  return JSON.parse(Buffer.from(raw.split('.')[1] as string, 'base64url').toString('utf8')) as Claims;
};
function db<T>(fn: (conn: Database.Database) => T): T {
  const conn = openAdminWrite(fixture.sitePath('acme'));
  try {
    return fn(conn);
  } finally {
    conn.close();
  }
}
const redeem = (code: string): Promise<Res> =>
  call({ port, path: '/d/acme', method: 'POST', host: HOST, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
const download = (cookie: string): Promise<Res> => call({ port, path: '/d/acme/file', host: HOST, headers: { cookie } });
const usesOf = (id: number): number =>
  db((c) => Number((c.prepare(`SELECT uses FROM cms_download_code WHERE id = ?`).get(id) as { uses: number }).uses));
const setGrace = (s: number): void => {
  // `value_json` for an `int` setting is the bare number, exactly as SHIPPED_SETTINGS writes
  // '21600'; `JSON.stringify(String(s))` would be a JSON *string* and `Number('"2"')` is NaN.
  db((c) => c.prepare(`UPDATE cms_settings SET value_json = ? WHERE key = 'download.continuation_grace_s'`).run(String(s)));
};

const conn = openAdminWrite(fixture.sitePath('acme'));
try {
  seedSettings(conn);
  await uploadAsset({
    db: conn,
    contentRoot,
    tenantKey: 'acme',
    key: 'vault/book',
    filename: 'book.pdf',
    bytes: await makePdf(),
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

// ---- 1: past the reuse window, a re-mint is a new purchase -----------------------
setGrace(2);
const code = await (async () => {
  const c = openAdminWrite(fixture.sitePath('acme'));
  try {
    return await issueCode({ db: c, contentRoot, assetKey: 'vault/book', email: 'w@example.com', orderRef: 'ORD-WIN-1' });
  } finally {
    c.close();
  }
})();
const first = claimsOf(cookieOf(await redeem(code.code)));
const oneCookie = cookieOf(await redeem(code.code));
const one = await download(oneCookie);
out(`# B1 grace 2 s: first download ${one.status} ${one.body.slice(0, 160)}`);
out(`# B1 first token iat ${claimsOf(oneCookie).iat} cexp ${claimsOf(oneCookie).cexp} now ${Math.floor(Date.now() / 1000)}`);
await sleep(2600);
const later = claimsOf(cookieOf(await redeem(code.code)));
out(`# B1 after 2.6 s (> grace): re-mint jti ${later.jti.slice(0, 8)}… reused: ${later.jti === first.jti}`);
const twoCookie = cookieOf(await redeem(code.code));
const two = await download(twoCookie);
out(`# B1 second download ${two.status} ${two.body.slice(0, 200)}`);
out(`# B1 second token jti ${claimsOf(twoCookie).jti.slice(0, 8)}… uses now ${usesOf(code.id)}`);

// ---- 2: a token keeps the cexp it was minted with --------------------------------
setGrace(21_600);
const code2 = await (async () => {
  const c = openAdminWrite(fixture.sitePath('acme'));
  try {
    return await issueCode({ db: c, contentRoot, assetKey: 'vault/book', email: 'w2@example.com', orderRef: 'ORD-WIN-2' });
  } finally {
    c.close();
  }
})();
const minted = await redeem(code2.code);
out(`# B2 redeem status ${minted.status}`);
const live = claimsOf(cookieOf(minted));
out(`# B2 claims iat ${live.iat} exp ${live.exp} now ${Math.floor(Date.now() / 1000)} jti ${live.jti.slice(0, 8)}…`);
const liveRes = await download(cookieOf(minted));
out(`# B2 first download ${liveRes.status} (cexp-iat ${live.cexp - live.iat})`);
out(`# B2 body ${liveRes.body}`);
out(
  `# B2 ledger: uses ${usesOf(code2.id)} events ${JSON.stringify(
    db((c) => c.prepare(`SELECT kind, outcome, jti FROM cms_download_event WHERE code_id = ?`).all(code2.id)),
  )}`,
);
out(`# B2 token jti ${live.jti}`);
setGrace(5); // a settings edit AFTER the token was minted must not shorten it
const nowS = Math.floor(Date.now() / 1000);
const key = loadEnv(fixture.env).downloadTokenKey;
const carried = mintToken(key, { ...live, iat: nowS - 1200, exp: nowS - 600, cexp: nowS + 20_400 });
const continued = await download(`__Host-sk-dl-acme=${carried}`);
out(`# B2 body ${continued.status} ${continued.body.slice(0, 160)}`);
out(
  `# B2 token minted at grace 21 600, setting then lowered to 5 s: middle-window download ${continued.status} ` +
    `uses ${usesOf(code2.id)} (the claim decides, not the setting)`,
);

await handle.close();
fixture.cleanup();
