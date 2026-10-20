/**
 * §7.4 (C-14) — the ten-minute download token, and the two hashes that bind it to a client.
 *
 * `v1.<base64url(payload)>.<base64url(HMAC-SHA256(SKW_DOWNLOAD_TOKEN_KEY, "v1." + payload))>`
 *
 * The verification order below is the contract, not an implementation detail, and
 * steps 1–4 run before any JSON is parsed. `timingSafeEqual` throws
 * `ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH` when the two buffers differ in length, and
 * an uncaught throw here is a **500 for a garbage cookie** — which tells an
 * attacker that the cookie was parsed and the MAC was reached. So the MAC is
 * decoded and measured at exactly 32 bytes first; everything that is not a
 * well-formed token is the same 401 from the same place.
 *
 * Nothing about the asset lives in the cookie name or path: the binding is the
 * `aid` claim, because `__Host-` forces `Path=/` and a path-scoped cookie cannot
 * carry the prefix (§7.4).
 *
 * Exclusive witness: test/download-redeem.test.ts R5, R5b
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const TOKEN_VERSION = 'v1';
export const TOKEN_TTL_S = 600;
/** The MAC is SHA-256 and nothing else; a decoded length other than this is a refusal. */
export const MAC_BYTES = 32;
/** A cookie this large is not one of ours. Refused before decoding, so no allocation is attacker-sized. */
export const MAX_TOKEN_CHARS = 2048;
/** The clock-skew allowance on `iat` (§7.4 step 5), in seconds. */
export const IAT_SKEW_S = 30;

export interface Claims {
  /** 128-bit hex; the counted unit (C-7). */
  jti: string;
  /** `cms_download_code.id` */
  cid: number;
  /** `cms_asset.id` */
  aid: number;
  iat: number;
  exp: number;
  /** 22 base64url characters: the first 16 bytes of HMAC(SKW_IP_HASH_KEY, ip). */
  iph: string;
  /** The same, over the User-Agent. */
  uah: string;
}

export type VerifyFailure =
  | 'format' // not three parts, or not `v1`
  | 'mac' // wrong length, or a MAC that does not match
  | 'claims' // exp - iat !== 600, iat in the future, or expired
  | 'client' // iph/uah do not match this request
  | 'binding'; // aid is not the asset this route serves

export type VerifyResult = { ok: true; claims: Claims } | { ok: false; reason: VerifyFailure };

/**
 * 16 bytes → 22 base64url characters, which is the width §7.4 states for `iph`/`uah`.
 * A keyed hash, not a plain one: the IP space is 2^32 and a bare SHA-256 of it is a
 * lookup table, so the key is what makes the column a pseudonym rather than an address.
 */
export function clientHash(key: string, value: string): string {
  return createHmac('sha256', key).update(value).digest().subarray(0, 16).toString('base64url');
}

/** The `__Host-` prefix requires `Path=/`, `Secure`, and no `Domain` (§7.4). */
export function cookieName(tenantKey: string): string {
  return `__Host-sk-dl-${tenantKey}`;
}

export function cookieHeader(tenantKey: string, token: string, maxAge = TOKEN_TTL_S): string {
  return `${cookieName(tenantKey)}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

export function clearCookieHeader(tenantKey: string): string {
  return `${cookieName(tenantKey)}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function mintToken(key: string, claims: Claims): string {
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  const mac = createHmac('sha256', key).update(`${TOKEN_VERSION}.${payload}`).digest('base64url');
  return `${TOKEN_VERSION}.${payload}.${mac}`;
}

/**
 * Steps 1–8 of §7.4, in that order. `aid` is optional: a route that already knows
 * which asset it serves passes it and gets the check here; a route that learns the
 * asset *from* the token (`/d/<key>/file`, whose only binding is the cookie) omits it
 * and checks the claim against the database instead — which is the stronger test,
 * because it also proves the code and the asset are the pair that was issued.
 */
export function verifyToken(
  key: string,
  token: string,
  opts: { aid?: number; iph: string; uah: string; nowMs: number },
): VerifyResult {
  if (token.length === 0 || token.length > MAX_TOKEN_CHARS) return { ok: false, reason: 'format' };

  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'format' };
  const [version, payload, mac] = parts as [string, string, string];
  if (version !== TOKEN_VERSION) return { ok: false, reason: 'format' };
  if (payload.length === 0 || mac.length === 0) return { ok: false, reason: 'format' };

  const given = Buffer.from(mac, 'base64url');
  // Before the compare, and before any JSON: `timingSafeEqual` throws on a length
  // mismatch, and a throw on this path is the 500 this check exists to prevent.
  if (given.length !== MAC_BYTES) return { ok: false, reason: 'mac' };

  const expected = createHmac('sha256', key).update(`${TOKEN_VERSION}.${payload}`).digest();
  if (!timingSafeEqual(given, expected)) return { ok: false, reason: 'mac' };

  // Only now is the payload allowed to become an object.
  let claims: Claims;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Partial<Claims>;
    if (
      typeof parsed.jti !== 'string' ||
      typeof parsed.cid !== 'number' ||
      typeof parsed.aid !== 'number' ||
      typeof parsed.iat !== 'number' ||
      typeof parsed.exp !== 'number' ||
      typeof parsed.iph !== 'string' ||
      typeof parsed.uah !== 'string'
    ) {
      return { ok: false, reason: 'claims' };
    }
    claims = parsed as Claims;
  } catch {
    return { ok: false, reason: 'claims' };
  }

  const nowS = Math.floor(opts.nowMs / 1000);
  if (claims.exp - claims.iat !== TOKEN_TTL_S) return { ok: false, reason: 'claims' };
  if (claims.iat > nowS + IAT_SKEW_S) return { ok: false, reason: 'claims' };
  if (claims.exp < nowS) return { ok: false, reason: 'claims' };

  // Constant-time on the client binding too: `iph`/`uah` are keyed hashes, so a
  // prefix comparison would leak nothing useful, but an equality check here is the
  // same one-line cost as the MAC's and removes the question.
  if (!sameString(claims.iph, opts.iph) || !sameString(claims.uah, opts.uah)) {
    return { ok: false, reason: 'client' };
  }
  if (opts.aid !== undefined && claims.aid !== opts.aid) return { ok: false, reason: 'binding' };

  return { ok: true, claims };
}

function sameString(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
