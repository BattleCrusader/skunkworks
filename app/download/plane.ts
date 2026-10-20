/**
 * §7.4 / §16 S3c — the gated download plane: the form, the redemption, and the hand-off.
 *
 * **The app never sees a byte.** It authorises, records what it authorised
 * (`cms_download_event.bytes_declared`), and answers `200` with an empty body and
 * `X-Accel-Redirect: /__protected/<hh>/<sha>.<ext>`; nginx serves the file from
 * `content/media/` under `limit_rate 1m` in its `internal` location. The URI is
 * derived from `cms_asset.storage_path` — the same stored string the store wrote —
 * so there is one naming rule, not two (§7.1, S3b's hand-off).
 *
 * **Order is the contract, and it is chosen so nothing is spent on a failure:**
 *
 *     stat the target  ->  validate the Range  ->  consume one use  ->  200 + redirect
 *
 * A missing blob is `503 SKW_E_RT_ASSET_MISSING` from the app, never a silent nginx
 * 404: the buyer's code stays unspent, and the log says which asset vanished. An
 * unsatisfiable `Range` is `416` with `Content-Range: bytes *\/<len>` and spends
 * nothing (C-7: "answered 416 without writing a first event"). A garbage or
 * oversized cookie is `401`, never `500` — the MAC's length is checked before
 * `timingSafeEqual`, which throws on a length mismatch.
 *
 * **The two hashes.** `iph`/`uah` are HMAC(SKW_IP_HASH_KEY, value) truncated to 16
 * bytes (22 base64url characters, §7.4). They bind the token to the client that
 * redeemed it, so a cookie copied to another machine is `401 SKW_E_SEC_TOKEN_MISMATCH`
 * — which is why the token cannot be a bare "download" URL in an email (§7.6).
 *
 * Exclusive witness: test/perf/download-timing.perf.test.ts P-S3c-1
 */
import type Database from 'better-sqlite3';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { randomBytes } from 'node:crypto';
import { statSync } from 'node:fs';

import { AppError } from '../errors.ts';
import type { Env } from '../env.ts';
import { pathUnder } from '../assets/store.ts';
import { DUMMY_HASH, Semaphore } from '../admin/auth.ts';
import { verify as argonVerify } from '@node-rs/argon2';
import {
  DEFAULT_CONTINUATION_GRACE_S,
  SETTING_CONTINUATION_GRACE,
  SETTING_WEBHOOK_SECRET,
  assetById,
  issueCode,
  normaliseCode,
  selectorOf,
  settingRaw,
  verifyWebhookSignature,
} from './code.ts';
import { consumeUse, type ConsumeResult } from './ledger.ts';
import { actionSite } from '../plugins/site.ts';
import { WatermarkStore, type StampResult, type WatermarkDeps } from './render.ts';
import { stampable } from './watermark.ts';
import {
  MAX_CONTINUATION_S,
  TOKEN_TTL_S,
  clientHash,
  clearCookieHeader,
  cookieHeader,
  cookieName,
  mintToken,
  verifyToken,
} from './token.ts';

/** 5 refusals per 15 minutes, per IP and per selector (§16 S3c). */
export const RATE_LIMIT = 5;
export const RATE_WINDOW_MS = 15 * 60_000;
/** The render tree's prefix, stated once: the row's `path` and the URI both derive from it. */
const WM_PREFIX = 'content/protected/wm/';
/**
 * The per-IP ceiling on *all* attempts, refusals included. The 5/15 min budget above
 * counts refusals, because a buyer behind an office NAT must not be told "too many
 * requests" for typing their sixth code correctly — the thing being limited is
 * guessing, and a guess is a refusal. This second, much larger bucket is the backstop
 * for a flood that is not guessing.
 */
export const RATE_LIMIT_ALL = 60;
/**
 * D34: how many attempts a refused browser makes in total (the navigation, then the page's
 * own retries), and the jitter window that keeps a burst of refused buyers from returning
 * in one wave. The loop is the page's — nothing on the server waits.
 */
export const RETRY_ATTEMPTS = 3;
export const RETRY_JITTER_MS = 250;

export interface PlaneDeps {
  env: Env;
  /** `<root>/media/hh/<sha>.<ext>` is the file; `content/` itself is `contentRoot`. */
  contentRoot: string;
  /** An `admin-write` class handle for the tenant; closed by the caller's factory. */
  openDb(tenantKey: string): Database.Database;
  /** One process-wide argon2 semaphore, shared with the admin login (§7.2: 4). */
  argon: Semaphore;
  now?: () => number;
  /**
   * The watermarker's numbers and, in a test only, its renderer. The shipped values are
   * `STAMP_BUDGET_MS`/`STAMP_CONCURRENCY`; `download-watermark.test.ts` builds an app with
   * a renderer that throws and one that never settles, which is the only way to prove the
   * denial path without corrupting a real PDF.
   */
  watermark?: Omit<WatermarkDeps, 'contentRoot' | 'now'> | undefined;
  /**
   * The limiter's numbers, injectable **only** so the timing gate can measure the
   * verify instead of the limiter: 1,000 trials from one address are 1,000 refusals,
   * and a 429 is not an argon2 measurement. The shipped limits are the defaults, and
   * `download-redeem.test.ts` asserts them against a plane built without this field.
   */
  limits?: { refusals?: number; windowMs?: number; all?: number } | undefined;
}

/** A sliding window that counts only what it is given; `hit()` returns false when over. */
export class SlidingWindow {
  readonly limit: number;
  readonly windowMs: number;
  readonly #hits = new Map<string, number[]>();

  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  count(key: string, atMs: number): number {
    const list = this.#hits.get(key);
    if (list === undefined) return 0;
    const live = list.filter((t) => t > atMs - this.windowMs);
    if (live.length === 0) this.#hits.delete(key);
    else this.#hits.set(key, live);
    return live.length;
  }

  /** Records one event and reports whether it is inside the budget. */
  hit(key: string, atMs: number): boolean {
    const list = this.#hits.get(key) ?? [];
    const live = list.filter((t) => t > atMs - this.windowMs);
    const allowed = live.length < this.limit;
    live.push(atMs);
    this.#hits.set(key, live);
    // A map that never shrinks is a leak; the window already prunes per key, this
    // prunes the keys themselves when a flood creates one per attacker address.
    if (this.#hits.size > 20_000) {
      for (const [k, v] of this.#hits) {
        if (v.every((t) => t <= atMs - this.windowMs)) this.#hits.delete(k);
      }
    }
    return allowed;
  }
}

export type RangeResult =
  | { kind: 'full' }
  | { kind: 'range'; start: number; end: number; length: number }
  | { kind: 'unsatisfiable' };

/**
 * One range, one request. `bytes=0-`, `bytes=1-`, `bytes=0-99`, `bytes=-500`.
 *
 * Multi-range (`bytes=0-1,5-6`) is refused as unsatisfiable rather than accepted:
 * nginx would answer `multipart/byteranges`, and the number of bytes the app
 * authorised would no longer be one number — the column that exists to be true
 * would hold a guess. A browser asking for two ranges gets 416 and retries.
 */
export function parseRange(header: string | undefined, size: number): RangeResult {
  if (header === undefined || header.trim() === '') return { kind: 'full' };
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (m === null) return { kind: 'unsatisfiable' }; // includes multi-range and other units
  const [, rawStart, rawEnd] = m as unknown as [string, string, string];
  if (rawStart === '' && rawEnd === '') return { kind: 'unsatisfiable' };

  let start: number;
  let end: number;
  if (rawStart === '') {
    // suffix: the last N bytes
    const n = Number(rawEnd);
    if (!Number.isSafeInteger(n) || n <= 0) return { kind: 'unsatisfiable' };
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(rawStart);
    if (!Number.isSafeInteger(start) || start < 0) return { kind: 'unsatisfiable' };
    end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
    if (!Number.isSafeInteger(end) || end < start) return { kind: 'unsatisfiable' };
  }
  if (size === 0 || start >= size) return { kind: 'unsatisfiable' };
  return { kind: 'range', start, end, length: end - start + 1 };
}

/** RFC 5987 `attr-char`, minus the four `encodeURIComponent` leaves unescaped. */
function rfc5987(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * `attachment; filename="fallback"; filename*=UTF-8''…`
 *
 * The ASCII fallback is required because a header value is ISO-8859-1 on the wire;
 * `filename*` is what a modern browser actually uses, and it is where `报告.pdf`
 * survives intact. Control characters and the quote/backslash are removed from both
 * — a filename is data, and a header is not a place data can be trusted.
 */
export function contentDisposition(filename: string): string {
  const cleaned = filename.replace(/[\u0000-\u001f\u007f\r\n]/g, '').replace(/["\\]/g, '');
  const ascii = cleaned.replace(/[^\u0020-\u007e]/g, '_');
  const ext = /\.[A-Za-z0-9]{1,8}$/.exec(ascii)?.[0] ?? '';
  const fallback = /[A-Za-z0-9]/.test(ascii.replace(ext, '')) ? ascii : `download${ext}`;
  return `attachment; filename="${fallback}"; filename*=UTF-8''${rfc5987(cleaned === '' ? fallback : cleaned)}`;
}

interface CodeRow {
  id: number;
  asset_id: number | null;
  bundle_id: number | null;
  code_hash: string;
  max_uses: number | null;
  uses: number;
  expires_at: string | null;
  revoked_at: string | null;
}

/** What the watermark text may read: the code row, never the request (§7.5). */
interface StampableCodeRow extends Omit<CodeRow, 'code_hash'> {
  issued_to_email: string | null;
  order_ref: string | null;
  created_at: string;
  code_selector: string;
}

export class DownloadPlane {
  readonly #deps: PlaneDeps;
  readonly #ipFailures: SlidingWindow;
  readonly #selectorFailures: SlidingWindow;
  readonly #ipAll: SlidingWindow;
  /** The render cache. Public so a gate can call `sweep` at a fixed instant. */
  readonly watermark: WatermarkStore;

  constructor(deps: PlaneDeps) {
    this.#deps = deps;
    const refusals = deps.limits?.refusals ?? RATE_LIMIT;
    const windowMs = deps.limits?.windowMs ?? RATE_WINDOW_MS;
    const all = deps.limits?.all ?? RATE_LIMIT_ALL;
    this.#ipFailures = new SlidingWindow(refusals, windowMs);
    this.#selectorFailures = new SlidingWindow(refusals, windowMs);
    this.#ipAll = new SlidingWindow(all, windowMs);
    this.watermark = new WatermarkStore({
      contentRoot: deps.contentRoot,
      ...(deps.watermark ?? {}),
      ...(deps.now === undefined ? {} : { now: deps.now }),
    });
  }

  #now(): number {
    return (this.#deps.now ?? Date.now)();
  }

  /** The form. No JavaScript, one field, and the code is never in a URL (§7.6). */
  form(reply: FastifyReply, tenantKey: string, opts: { error?: string } = {}): void {
    const error = opts.error === undefined ? '' : `<p role="alert" class="error">${escapeHtml(opts.error)}</p>`;
    reply
      .code(opts.error === undefined ? 200 : 401)
      .type('text/html; charset=utf-8')
      .header('cache-control', 'no-store')
      .send(
        `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Download</title></head>
<body data-tenant="${escapeHtml(tenantKey)}">
<h1>Download your file</h1>
${error}
<form method="post" action="/d/${escapeHtml(tenantKey)}" enctype="application/x-www-form-urlencoded">
  <label for="code">Access code</label>
  <input id="code" name="code" inputmode="text" autocomplete="off" autocapitalize="characters"
         spellcheck="false" maxlength="24" required>
  <button type="submit">Download</button>
</form>
<p>Enter the 16-character code from your receipt. Codes are not links: this form is the only way in.</p>
</body></html>`,
      );
  }

  /**
   * `POST /d/<key>` — the redemption. Exactly one argon2id verify runs on every
   * request that reaches it: against the code's hash when the selector matched, and
   * against `DUMMY_HASH` otherwise. The refusal is one status, one code and one
   * message for an unknown selector, a wrong secret, a revoked row, an expired row
   * and a bundle code — the last three are *checked after* the verify, so their cost
   * is the same as a wrong secret's.
   */
  async redeem(req: FastifyRequest, reply: FastifyReply, tenantKey: string): Promise<void> {
    const atMs = this.#now();
    const at = new Date(atMs).toISOString();
    const ip = req.socket.remoteAddress ?? '';
    const iph = clientHash(this.#deps.env.ipHashKey, ip);
    const uah = clientHash(this.#deps.env.ipHashKey, String(req.headers['user-agent'] ?? ''));
    const submitted = readCodeField(req.body);
    const normalised = submitted === null ? null : normaliseCode(submitted);
    // A submission that cannot be a code still burns the same verify, over a fixed
    // 16-character string, so "not even the right shape" is not a faster answer.
    const candidate = normalised ?? '0000000000000000';
    const selector = normalised === null ? null : selectorOf(normalised);

    if (this.#ipFailures.count(iph, atMs) >= this.#ipFailures.limit) {
      throw new AppError('SKW_E_SEC_RATE_LIMITED', 'too many attempts from this address', {
        reason: 'ip',
        window_s: RATE_WINDOW_MS / 1000,
      });
    }
    if (selector !== null && this.#selectorFailures.count(selector, atMs) >= this.#selectorFailures.limit) {
      throw new AppError('SKW_E_SEC_RATE_LIMITED', 'too many attempts for this code', {
        reason: 'selector',
        window_s: RATE_WINDOW_MS / 1000,
      });
    }
    if (!this.#ipAll.hit(iph, atMs)) {
      throw new AppError('SKW_E_SEC_RATE_LIMITED', 'too many requests from this address', {
        reason: 'ip_all',
        window_s: RATE_WINDOW_MS / 1000,
      });
    }

    const db = this.#deps.openDb(tenantKey);
    try {
      const row =
        selector === null
          ? undefined
          : (db
              .prepare(
                `SELECT id, asset_id, bundle_id, code_hash, max_uses, uses, expires_at, revoked_at
                   FROM cms_download_code WHERE code_selector = ?`,
              )
              .get(selector) as CodeRow | undefined);

      const hashToTry = row?.code_hash ?? DUMMY_HASH;
      let matches = false;
      try {
        matches = await this.#deps.argon.run(() => argonVerify(hashToTry, candidate));
      } catch {
        matches = false;
      }

      const live =
        row !== undefined &&
        row.revoked_at === null &&
        row.bundle_id === null &&
        (row.expires_at === null || Date.parse(row.expires_at) > atMs);

      if (!matches || !live || row === undefined) {
        // The denial is a ledger row (C-6: both paths write one event). `jti` is NULL —
        // there is no token — and `bytes_declared` is 0, because nothing was authorised.
        db.prepare(
          `INSERT INTO cms_download_event (code_id, asset_id, jti, kind, bytes_declared, ip_hash, ua_hash, outcome)
           VALUES (?, NULL, NULL, 'denied', 0, ?, ?, 'denied_token')`,
        ).run(row?.id ?? null, iph, uah);
        // The window counts refusals: a buyer behind an office NAT must not lose their
        // sixth correct redemption to somebody else's typos.
        this.#ipFailures.hit(iph, atMs);
        if (selector !== null) this.#selectorFailures.hit(selector, atMs);
        throw new AppError('SKW_E_SEC_CODE_INVALID', 'that code is not valid');
      }

      const nowS = Math.floor(atMs / 1000);
      const grace = this.#graceSeconds(db);
      // E-26: a re-typed code, from the same IP and User-Agent, inside the window returns
      // the *same* `jti`. A row exists exactly when a use was spent, so a resume through
      // `consumeUse` is seen as a continuation and spends nothing. `iat`, `exp` and `cexp`
      // are re-stamped every mint: the authority to mint is the **code**, never the token.
      const jti = this.#reusableJti(db, row.id, row.asset_id as number, iph, uah, atMs, grace);
      const tokenJti = jti ?? randomBytes(16).toString('hex');
      const token = mintToken(this.#deps.env.downloadTokenKey, {
        jti: tokenJti,
        cid: row.id,
        aid: row.asset_id as number,
        iat: nowS,
        exp: nowS + TOKEN_TTL_S,
        // E-26: `cexp ≥ exp` always. A grace below the ten-minute window (including 0)
        // makes the second window empty, which is legal and is what "0" means.
        cexp: nowS + Math.max(grace, TOKEN_TTL_S),
        iph,
        uah,
      });

      // E-26: `Max-Age = cexp − iat`. The cookie lives as long as the *narrower*
      // permission; it is the authorisation inside it that dies in ten minutes.
      //
      // §13.3.4, `download.redeemed` — an **action**, `{tenant, codeId, assetKey, jti}`,
      // dispatched after the code verified and before the redirect. Observe only: there is no
      // `download.authorize` and no return value here that could grant a download, which is
      // the absence that stops a plugin bug becoming a revenue leak.
      const assetKey = (db.prepare('SELECT key FROM cms_asset WHERE id = ?').get(row.asset_id) as { key: string } | undefined)?.key ?? '';
      await actionSite('download.redeemed', tenantKey, {
        tenant: tenantKey,
        codeId: row.id,
        assetKey,
        jti: tokenJti,
      });
      reply.header('set-cookie', cookieHeader(tenantKey, token, Math.max(grace, TOKEN_TTL_S)));
      reply.header('cache-control', 'no-store');
      reply.code(303).header('location', `/d/${encodeURIComponent(tenantKey)}/file`).send();
      return;
    } finally {
      db.close();
    }
  }

  /**
   * `GET /d/<key>/file` — verify, stat, validate the range, consume, hand off.
   *
   * The token is verified before its payload is parsed (§7.4 steps 1–4), and the
   * binding is then checked against the database rather than against the URL: the
   * asset the token names must be the asset the code was issued for. A route that
   * carried an asset id would let the path select the asset, which is the second
   * source of truth §7.2 removed for codes.
   */
  async file(req: FastifyRequest, reply: FastifyReply, tenantKey: string): Promise<void> {
    const atMs = this.#now();
    const at = new Date(atMs).toISOString();
    const ip = req.socket.remoteAddress ?? '';
    const iph = clientHash(this.#deps.env.ipHashKey, ip);
    const uah = clientHash(this.#deps.env.ipHashKey, String(req.headers['user-agent'] ?? ''));
    const name = cookieName(tenantKey);
    const token = readCookie(req.headers.cookie, name);

    if (token === null) {
      // No cookie is not a bad token: it is a browser that has not redeemed yet.
      reply.header('cache-control', 'no-store');
      reply.code(303).header('location', `/d/${encodeURIComponent(tenantKey)}`).send();
      return;
    }

    const verified = verifyToken(this.#deps.env.downloadTokenKey, token, { iph, uah, nowMs: atMs });
    if (!verified.ok) {
      const code =
        verified.reason === 'client' || verified.reason === 'binding'
          ? 'SKW_E_SEC_TOKEN_MISMATCH'
          : 'SKW_E_SEC_TOKEN_INVALID';
      reply.header('set-cookie', clearCookieHeader(tenantKey));
      throw new AppError(code, 'the download token is not valid for this request', { reason: verified.reason });
    }
    const claims = verified.claims;

    const db = this.#deps.openDb(tenantKey);
    try {
      const row = db
        .prepare(
          `SELECT id, asset_id, bundle_id, max_uses, uses, expires_at, revoked_at,
                  issued_to_email, order_ref, created_at, code_selector
             FROM cms_download_code WHERE id = ?`,
        )
        .get(claims.cid) as StampableCodeRow | undefined;
      const asset = assetById(db, claims.aid);
      if (row === undefined || asset === null || row.asset_id !== claims.aid) {
        // A token that names a code/asset pair the database does not have is a
        // mismatch, not a 404: nothing about the asset's existence is revealed.
        throw new AppError('SKW_E_SEC_TOKEN_MISMATCH', 'the download token does not match this asset', {
          reason: 'binding',
        });
      }

      // 1. the source blob, before anything is spent. A missing file is our fault, not
      //    the buyer's, and it must not burn a use (R8).
      try {
        const st = statSync(pathUnder(this.#deps.contentRoot, asset.storage_path));
        if (!st.isFile()) throw new Error('not a file');
      } catch {
        throw new AppError('SKW_E_RT_ASSET_MISSING', 'the stored file for this asset is missing', {
          asset_key: asset.key,
        });
      }

      // 2. **the stamp, before anything is spent and before any range is validated.**
      //    A gated asset of a format the renderer claims is never handed off as the
      //    store's blob: the bytes nginx serves are the buyer's copy or there is no
      //    response at all. The render's own size is what the Range is measured
      //    against, because that is the file the buyer receives.
      //
      //    A format no renderer claims (video, audio, an archive) keeps the S3c path.
      //    That is a *stated* coverage gap — §7.5 says so, and `issueCode` tells the
      //    operator at issue time — not a silent fallback for a stampable asset.
      let handOff: { uri: string; size: number } | null = null;
      const grace = this.#graceSeconds(db);
      if (stampable(asset) !== null) {
        let stamped: StampResult;
        try {
          stamped = await this.watermark.ensure({
            tenantKey,
            db,
            asset,
            code: {
              id: row.id,
              email: row.issued_to_email,
              orderRef: row.order_ref,
              issuedAt: row.created_at,
              selector: row.code_selector,
            },
            // E-26: `cexp + grace`, not `exp + grace`. The last instant this token may be
            // served is `cexp`; a file deleted 40 minutes earlier would vanish under a
            // transfer that started at the last permitted second.
            expiresAt: new Date((claims.cexp + grace) * 1000).toISOString(),
          });
        } catch (err) {
          // Fail closed, and leave the record that says why. The row is written *before*
          // the 503 so a reader never sees a failed redemption with no ledger entry.
          //
          // D34: the row is `kind='denied'`, one per attempt. A refusal is not a
          // redemption — nothing was authorised and nothing was spent — so writing it as
          // `first` made the token's one attempt look spent and turned every retry into a
          // second denial (`consumeUse` treats an existing non-`ok` `first` row as
          // terminal). The retry page depends on this being a denial, not a redemption.
          const reason = err instanceof AppError ? reasonOf(err) : 'renderer';
          this.#denyWatermark(db, claims, iph, uah, reason);
          if (err instanceof AppError) throw err;
          throw new AppError(
            'SKW_E_SEC_WATERMARK_FAILED',
            'the watermark could not be rendered',
            { reason: 'renderer', asset_key: asset.key },
            this.watermark.retryAfterSeconds(),
          );
        }
        let size: number;
        try {
          size = statSync(stamped.absPath).size;
        } catch {
          this.#denyWatermark(db, claims, iph, uah, 'io');
          throw new AppError(
            'SKW_E_SEC_WATERMARK_FAILED',
            'the stamped file vanished before the hand-off',
            { reason: 'io', asset_key: asset.key },
            this.watermark.retryAfterSeconds(),
          );
        }
        // The second tree: `content/protected/wm/…` behind `/__protected/wm/`, whose
        // alias is `/srv/content/protected/wm/`. `storage_path` is content-addressed and
        // shared by every buyer, which is exactly what a watermark must not be.
        handOff = { uri: `/__protected/wm/${stamped.relPath.slice(WM_PREFIX.length)}`, size };
      }

      const size = handOff === null ? statSync(pathUnder(this.#deps.contentRoot, asset.storage_path)).size : handOff.size;

      // 3. the range, before anything is spent. C-7: 416 writes no `first` event.
      const range = parseRange(req.headers.range, size);
      if (range.kind === 'unsatisfiable') {
        reply
          .code(416)
          .header('content-range', `bytes */${size}`)
          .header('accept-ranges', 'bytes')
          .header('cache-control', 'no-store')
          .send();
        return;
      }
      const bytesDeclared = range.kind === 'full' ? size : range.length;

      // 4. the consume: insert-first, then update, in one BEGIN IMMEDIATE (C-7).
      //    E-26: the token's `exp` decides *whether this call may spend*. Past it, the
      //    only thing a request can do is continue a redemption that already exists —
      //    `consumeUse` then performs no insert at all, so a continuation can never
      //    create a purchase.
      const consumed: ConsumeResult = consumeUse(db, {
        jti: claims.jti,
        codeId: claims.cid,
        assetId: claims.aid,
        bytesDeclared,
        ipHash: iph,
        uaHash: uah,
        at,
        nowMs: atMs,
        maySpend: Math.floor(atMs / 1000) <= claims.exp,
      });
      if (!consumed.spent && !consumed.continuation) {
        if (consumed.reason === 'no_redemption') {
          // E-26: authentic, inside `cexp`, and it names a purchase that never happened.
          // It is not a continuation and it cannot become one.
          reply.header('set-cookie', clearCookieHeader(tenantKey));
          throw new AppError('SKW_E_SEC_TOKEN_INVALID', 'the download token names no redemption', {
            reason: 'no_redemption',
          });
        }
        if (consumed.reason === 'denied_quota') {
          throw new AppError('SKW_E_SEC_USES_EXHAUSTED', 'this code has no uses left', {
            reason: consumed.reason,
          });
        }
        reply.header('set-cookie', clearCookieHeader(tenantKey));
        throw new AppError('SKW_E_SEC_CODE_INVALID', 'this code can no longer be used', { reason: consumed.reason });
      }

      // 5. the hand-off. `storage_path` is `content/media/hh/<sha>.<ext>` and the internal
      // location's alias is `/srv/content/media/`; a render is `content/protected/wm/…`
      // and its location is `/__protected/wm/`. There is exactly one rule per tree.
      //
      // `Accept-Ranges` is **not** set here: the app serves no range, nginx does, and a
      // full GET through the edge otherwise carries `bytes, bytes` (the app's header and
      // nginx's). The 416 path above does set it, because that response is the app's own.
      const uri = handOff?.uri ?? `/__protected/${asset.storage_path.slice('content/media/'.length)}`;
      reply
        .code(200)
        .header('content-type', asset.mime)
        .header('content-disposition', contentDisposition(asset.filename))
        .header('cache-control', 'private, no-store')
        .header('x-accel-redirect', uri)
        .header('x-skunkworks-bytes-declared', String(bytesDeclared))
        .send();
    } finally {
      db.close();
    }
  }

  /**
   * **D34 — the refusal a browser can act on.**
   *
   * A JSON 503 is a dead end for a buyer, so a `text/html` navigation gets a page instead:
   * one that says what happened, how long to wait (`Retry-After`, the same number as the
   * header), and then retries itself **three attempts in total** — the third answer is
   * terminal and says the code was not used.
   *
   * The retry loop is the page's, and deliberately not the server's: no request waits
   * longer than E-27's 2 s budget, nothing is queued behind a sleeping response, and a
   * buyer who closes the tab costs nothing. The delay is `Retry-After` plus up to
   * `RETRY_JITTER_MS` of client-side jitter, so a burst of refused browsers does not come
   * back in one wave; the `<noscript>` fallback refreshes once at the header's value.
   *
   * `attempt` is one-based: the attempt that just failed.
   */
  busyPage(reply: FastifyReply, tenantKey: string, err: AppError, attempt: number): void {
    const retryAfter = err.retryAfter ?? this.watermark.retryAfterSeconds();
    const path = `/d/${encodeURIComponent(tenantKey)}/file`;
    const terminal = attempt >= RETRY_ATTEMPTS;
    const reason = reasonOf(err);
    const busy = reason === 'queue' || reason === 'timeout';
    const why = busy
      ? 'The download queue is full. Nothing has been charged and your code has not been used.'
      : 'This file could not be prepared just now. Nothing has been charged and your code has not been used.';

    reply.header('cache-control', 'no-store').header('retry-after', String(retryAfter)).code(503).type('text/html; charset=utf-8');

    if (terminal) {
      reply.send(
        pageHtml(
          tenantKey,
          'Your file could not be prepared',
          `<h1>Your file could not be prepared</h1>
<p role="alert">${escapeHtml(why)}</p>
<p>Tried ${attempt} times, waiting ${retryAfter} s before each. If it keeps happening, the store has been told — try again in a few minutes.</p>
<p><a href="/d/${escapeHtml(tenantKey)}">Enter your code again</a></p>`,
          ` data-terminal="1" data-attempt="${attempt}"`,
        ),
      );
      return;
    }

    const next = attempt + 1;
    const nextUrl = `${path}?retry=${attempt}`;
    reply.send(
      pageHtml(
        tenantKey,
        'Preparing your file',
        `<h1>Preparing your file</h1>
<p role="status">${escapeHtml(why)}</p>
<p>This page will try again automatically — attempt ${next} of ${RETRY_ATTEMPTS}. You can also
<a href="${escapeHtml(nextUrl)}">try now</a>.</p>
<script>
setTimeout(function () { location.assign(${JSON.stringify(nextUrl)}); },
  ${retryAfter * 1000} + Math.floor(Math.random() * ${RETRY_JITTER_MS}));
</script>
<noscript><meta http-equiv="refresh" content="${retryAfter};url=${escapeHtml(nextUrl)}"></noscript>`,
        ` data-attempt="${attempt}" data-retry-ms="${retryAfter * 1000}" data-jitter-ms="${RETRY_JITTER_MS}"`,
      ),
    );
  }

  /**
   * `download.continuation_grace_s`, or the shipped default when the row is missing.
   *
   * A missing `download.default_max_uses` is a refusal at issue time (it decides a quota);
   * a missing *grace* decides nothing about money, and refusing a download over it would
   * be a paying customer denied by a seed that has not run yet. The default is the number
   * §7.5 ships, and the seed is asserted by `download-codes.test.ts`.
   *
   * **Ceiling: 86 400 s (E-26).** Without it the grace is whatever a `cms_settings` row
   * says, and "a leaked token buys one asset for at most six hours" becomes a claim about
   * configuration rather than about the token. A token minted before a grace increase
   * keeps its own `cexp`; the token check is against the claim, never the current setting.
   */
  #graceSeconds(db: Database.Database): number {
    const row = db.prepare(`SELECT value_json FROM cms_settings WHERE key = ?`).get(SETTING_CONTINUATION_GRACE) as
      | { value_json: string }
      | undefined;
    if (row === undefined) return DEFAULT_CONTINUATION_GRACE_S;
    const value = Number(row.value_json);
    if (!Number.isInteger(value) || value < 0) return DEFAULT_CONTINUATION_GRACE_S;
    return Math.min(value, MAX_CONTINUATION_S);
  }

  /**
   * E-26's mint idempotency: the newest `ok` `first` row for this
   * (code, asset, IP, UA) inside the grace window, or `null`.
   *
   * A row exists exactly when a use was spent, so the lookup costs nothing when there is
   * nothing to reuse, and it is a seek on `ix_ev_code_ts` plus a filter over one code's
   * rows (`max_uses ≤ 100`). A re-typed code from the same client inside the window
   * therefore yields the same `jti`, which `consumeUse` sees as a continuation.
   *
   * Recorded, not closed: the key is the *client*, not the code. A buyer who changes
   * network or browser mid-transfer gets a new `jti` and spends a use for the resume.
   * That is D32's own key, and keying on the code alone would let a code shared in a chat
   * be resumed from any client — exactly the leak `iph`/`uah` exist to close.
   */
  #reusableJti(
    db: Database.Database,
    codeId: number,
    assetId: number,
    iph: string,
    uah: string,
    atMs: number,
    graceSeconds: number,
  ): string | null {
    const row = db
      .prepare(
        `SELECT jti, ts FROM cms_download_event
          WHERE kind = 'first' AND outcome = 'ok'
            AND code_id = ? AND asset_id = ? AND ip_hash = ? AND ua_hash = ?
            AND jti IS NOT NULL
          ORDER BY ts DESC, id DESC LIMIT 1`,
      )
      .get(codeId, assetId, iph, uah) as { jti: string; ts: string } | undefined;
    if (row === undefined) return null;
    const ts = Date.parse(row.ts);
    if (!Number.isFinite(ts)) return null;
    if (atMs - ts > graceSeconds * 1000) return null;
    return row.jti;
  }

  /**
   * One `denied` row per refused attempt (D34).
   *
   * `kind='denied'`, not `'first'`: a watermark refusal is not a redemption. Under the old
   * kind the row tripped `ux_ev_jti_first` and `consumeUse` read it back as a spent
   * attempt, so a retry after a 503 could never be served — the buyer's reload was a dead
   * end even when the renderer recovered. `kind='denied'` has no unique index, which is
   * what "each attempt writes its own row" requires.
   *
   * `bytes_declared=0` because nothing was authorised. The row records the **class**
   * (`denied_watermark`); the finer reason (`queue`/`timeout`/`renderer`/`io`) travels in
   * the 503's `detail.reason`, because `cms_download_event` has no reason column — adding
   * one is a v4 data-model change, and it is recorded as S4 work rather than faked into
   * `bytes_sent` or the `jti`.
   */
  #denyWatermark(
    db: Database.Database,
    claims: { jti: string; cid: number; aid: number },
    iph: string,
    uah: string,
    reason: string,
  ): void {
    db.prepare(
      `INSERT INTO cms_download_event (jti, kind, code_id, asset_id, bytes_declared, ip_hash, ua_hash, outcome)
       VALUES (?, 'denied', ?, ?, 0, ?, ?, 'denied_watermark')`,
    ).run(claims.jti, claims.cid, claims.aid, iph, uah);
    // The row is the class; the reason is the log line. S3R2-3 recorded that an operator
    // keyed on `detail.reason='queue'` sees nothing in a one-store deployment — every
    // production refusal is `timeout` — so the reason has to be somewhere a human reads.
    process.stderr.write(
      `download refusal: code=${claims.cid} asset=${claims.aid} reason=${reason} outcome=denied_watermark\n`,
    );
  }

  /**
   * `POST /api/hooks/<tenant>/issue-code` — §7.6's third channel, HMAC-signed.
   *
   * `SKW_EMAIL_MODE=off` (the default) means the store emails the code itself, so the
   * 201 body carries it exactly once; with SMTP on it would be sent and not returned.
   * `order_ref` is the idempotency key: a replay of the same order is `409` and mints
   * nothing, because the plaintext cannot be re-read.
   */
  async webhook(req: FastifyRequest, reply: FastifyReply, tenantKey: string): Promise<void> {
    const atMs = this.#now();
    const raw = typeof req.body === 'string' ? req.body : '';
    const db = this.#deps.openDb(tenantKey);
    try {
      let secret: string;
      try {
        secret = settingRaw(db, SETTING_WEBHOOK_SECRET);
      } catch {
        // No configured secret: the channel does not exist for this tenant. 404 says
        // that without saying whether a secret is merely wrong.
        throw new AppError('SKW_E_PLT_TENANT_UNKNOWN', 'no webhook here');
      }

      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        throw new AppError('SKW_E_PLT_REQUEST_INVALID', 'the webhook body is not JSON');
      }
      const iat = typeof payload.iat === 'number' ? payload.iat * 1000 : Number.NaN;
      const signature = verifyWebhookSignature({
        secret,
        rawBody: raw,
        header: headerValue(req.headers['x-skw-signature']),
        iat,
        nowMs: atMs,
      });
      if (!signature.ok) {
        throw new AppError('SKW_E_SEC_AUTH_INVALID', 'the webhook signature is not valid', {
          reason: signature.reason,
        });
      }

      if (typeof payload.asset_key !== 'string') {
        throw new AppError('SKW_E_PLT_REQUEST_INVALID', 'asset_key is required');
      }
      const issued = await issueCode({
        db,
        contentRoot: this.#deps.contentRoot,
        assetKey: payload.asset_key,
        email: typeof payload.email === 'string' ? payload.email : null,
        orderRef: typeof payload.order_ref === 'string' ? payload.order_ref : null,
        maxUses:
          payload.max_uses === undefined
            ? undefined
            : payload.max_uses === null
              ? null
              : Number(payload.max_uses),
        expiresAt: typeof payload.expires_at === 'string' ? payload.expires_at : null,
        confirmUnlimited: payload.confirm_unlimited === true,
        atMs,
      });

      reply.code(201).send({
        code: issued.code,
        code_id: issued.id,
        selector: issued.selector,
        asset_key: issued.assetKey,
        max_uses: issued.maxUses,
        expires_at: issued.expiresAt,
        stampable: issued.stampable,
        email: this.#deps.env.emailMode === 'smtp' ? 'sent' : 'returned',
      });
    } finally {
      db.close();
    }
  }
}

/** `application/x-www-form-urlencoded` (the form) or JSON (a store's server). */
function readCodeField(body: unknown): string | null {
  if (typeof body === 'string') {
    const value = new URLSearchParams(body).get('code');
    return value === null ? null : value;
  }
  if (body !== null && typeof body === 'object') {
    const value = (body as { code?: unknown }).code;
    return typeof value === 'string' ? value : null;
  }
  return null;
}

/** `name=value` out of a Cookie header, without decoding: a token has no escapes. */
export function readCookie(header: string | undefined, name: string): string | null {
  if (header === undefined) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

function headerValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** One shell, so the retry page and the terminal page cannot drift apart. */
function pageHtml(tenantKey: string, title: string, body: string, attrs: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title></head>
<body data-tenant="${escapeHtml(tenantKey)}"${attrs}>
${body}
</body></html>`;
}

/** `detail.reason`, which is how a watermark refusal says *why* it refused. */
function reasonOf(err: AppError): string {
  const detail = err.detail as { reason?: unknown } | null | undefined;
  return detail !== null && typeof detail === 'object' && typeof detail.reason === 'string' ? detail.reason : 'unknown';
}
