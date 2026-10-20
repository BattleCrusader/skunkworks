/**
 * QA S3 / defeat attempt 2 — **continuation (D32, IDEA §13).**
 *
 * D32: "A download token carries two expiries: authorisation (10 min) and continuation
 * (mint + `continuation_grace_s`, default 6 h). A mint is idempotent per (code, asset, IP,
 * UA) inside the grace window, returning the **same jti**."
 *
 * §7.4 says the same thing in prose. The gate `R5b` pins an *expired* token to 401, and
 * `S3d-report.md` §8.5 says the grace is "still not implemented". This probe measures
 * which of the three D32 clauses the shipped build actually has:
 *
 *   (a) an expired token resumed inside the grace window: must be 200, must spend nothing;
 *   (b) an expired token past the grace window: must refuse;
 *   (c) re-minting after expiry: must return the same jti, i.e. must not be a free extra use.
 *
 * The token is a pure function of its claims and the clock, so an expired one is minted
 * with `mintToken` from the shipped module — the verifier is untouched, and nothing here
 * stubs the plane.
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
import { TOKEN_TTL_S, clientHash, cookieName, mintToken } from '../../app/download/token.ts';
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
const env = loadEnv(fixture.env);

function siteDb(): Database.Database {
  return openAdminWrite(fixture.sitePath('acme'));
}
function db<T>(fn: (c: Database.Database) => T): T {
  const c = siteDb();
  try {
    return fn(c);
  } finally {
    c.close();
  }
}

let handle: AppHandle;
let port = 0;
let assetId = 0;
let codeId = 0;
let code = '';

function redeem(c: string): Promise<Res> {
  return call({
    port,
    path: '/d/acme',
    method: 'POST',
    host: HOST,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: c }),
  });
}
function cookieOf(res: Res): string {
  const raw = String(header(res, 'set-cookie') ?? '');
  return raw.slice(0, raw.indexOf(';'));
}
function download(cookie: string, extra: Record<string, string> = {}): Promise<Res> {
  return call({ port, path: '/d/acme/file', host: HOST, headers: { cookie, ...extra } });
}
function uses(): number {
  return db((c) => Number((c.prepare(`SELECT uses FROM cms_download_code WHERE id = ?`).get(codeId) as { uses: number }).uses));
}
function rows(): { kind: string; outcome: string; jti: string | null }[] {
  return db((c) =>
    c.prepare(`SELECT kind, outcome, jti FROM cms_download_event WHERE code_id = ? ORDER BY id`).all(codeId) as never,
  );
}
function jtiOf(token: string): string {
  const payload = token.split('.')[1] ?? '';
  return (JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { jti: string }).jti;
}

/** An expired token for the *same* redemption: identical claims, `iat` moved back. */
function expiredToken(live: string, secondsAgo: number): string {
  const payload = JSON.parse(Buffer.from(live.split('.')[1] ?? '', 'base64url').toString('utf8')) as {
    jti: string;
    cid: number;
    aid: number;
    iat: number;
    exp: number;
    iph: string;
    uah: string;
  };
  const iat = payload.iat - secondsAgo;
  return mintToken(env.downloadTokenKey, { ...payload, iat, exp: iat + TOKEN_TTL_S });
}

async function main(): Promise<void> {
  const conn = siteDb();
  const uploaded = await uploadAsset({
    db: conn,
    contentRoot,
    tenantKey: 'acme',
    key: 'vault/book',
    filename: 'book.pdf',
    bytes: await makePdf(2),
    quotaLimitBytes: 50_000_000,
    accessClass: 'gated',
  });
  assetId = uploaded.asset.id;
  const issued = await issueCode({ db: conn, contentRoot, assetKey: 'vault/book', email: 'cont@example.com', maxUses: 3 });
  codeId = issued.id;
  code = issued.code;
  conn.close();

  handle = await buildApp({ env, contentRoot, downloadLimits: { refusals: 10_000, all: 10_000 } });
  port = await handle.app.listen({ port: 0, host: '127.0.0.1' }).then(() => {
    const a = handle.app.server.address();
    return typeof a === 'object' && a !== null ? a.port : 0;
  });

  // A real redemption: one use, one `first` row, one jti.
  const first = await redeem(code);
  const liveToken = cookieOf(first).slice(cookieName('acme').length + 1);
  const jti = jtiOf(liveToken);
  const live = await download(cookieOf(first));
  out(
    `# D2 mint+download -> ${live.status}, jti ${jti.slice(0, 8)}…, uses=${uses()}, rows=[${rows().map((r) => `${r.kind}:${r.outcome}`).join(',')}]`,
  );

  // (a) inside the grace window: iat 700 s ago, exp 100 s ago (exp-iat is still 600).
  const inGrace = expiredToken(liveToken, 700);
  const a1 = await download(`${cookieName('acme')}=${inGrace}`, { range: 'bytes=100-199' });
  out(
    `# D2a expired 100 s ago (inside the 21600 s grace), Range resumed -> ${a1.status} ` +
      `${(a1.json as { error?: { code?: string } } | undefined)?.error?.code ?? ''}, uses=${uses()}, ` +
      `rows=${rows().length}, x-accel=${String(header(a1, 'x-accel-redirect'))}`,
  );

  // (b) past the grace window: iat 25,000 s ago.
  const pastGrace = expiredToken(liveToken, 25_000);
  const b1 = await download(`${cookieName('acme')}=${pastGrace}`, { range: 'bytes=100-199' });
  out(
    `# D2b expired 24,400 s ago (past the 21600 s grace) -> ${b1.status} ` +
      `${(b1.json as { error?: { code?: string } } | undefined)?.error?.code ?? ''}, uses=${uses()}, rows=${rows().length}`,
  );

  // (c) re-minting after expiry: D32 says the same (code, asset, IP, UA) inside the grace
  //     window returns the same jti. Measure it, then measure what a second download costs.
  const again = await redeem(code);
  const againToken = again.status === 303 ? cookieOf(again).slice(cookieName('acme').length + 1) : '';
  const sameJti = againToken !== '' && jtiOf(againToken) === jti;
  const c1 = againToken === '' ? undefined : await download(cookieOf(again));
  out(
    `# D2c re-mint -> ${again.status}, same jti as the first mint: ${sameJti}, ` +
      `download -> ${c1?.status}, uses=${uses()}, rows=[${rows().map((r) => `${r.kind}:${r.outcome}`).join(',')}]`,
  );

  out(
    `# D2 grace setting: ${JSON.stringify(
      db((c) => c.prepare(`SELECT key, value_json FROM cms_settings WHERE key='download.continuation_grace_s'`).get()),
    )}`,
  );

  await handle.close();
  fixture.cleanup();
  void assetId;
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
