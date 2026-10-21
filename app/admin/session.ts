/**
 * Sessions — SDS §9.1's control table, §9.2's tenant rule, and the `session` table
 * in `schema/control.sql` (unchanged: this module fills it, it does not redesign it).
 *
 * The wire contract, **as amended by D37** (the user overruled D9: admin is
 * `/admin` on each tenant host, WordPress-style, and the fleet console is
 * `/fleet`). The hostname no longer separates anything, so the cookie does the
 * separating — in this order, and each one is load-bearing:
 *
 *   | Session cookie | `__Secure-sk-sess-<tenantKey>`; `Path=/admin`; `Secure`; `HttpOnly`; `SameSite=Strict` |
 *   | Fleet cookie   | `__Secure-sk-fleet`;             `Path=/fleet`; `Secure`; `HttpOnly`; `SameSite=Strict` |
 *   | Session id     | 32-byte random hex, stored as a row in `control.db.session`, rotated on privilege change |
 *   | CSRF           | session-bound token on every non-GET, plus an exact `Origin` check against the request's own host |
 *   | IP allowlist   | opt-in, empty in every exported bundle; **when empty, TOTP is mandatory and idle drops to 15 min** |
 *
 * Three things the old `__Host-sk-sess; Path=/; SameSite=Lax` could not say, and
 * why each replaced something that D9 got from a separate hostname:
 *
 * a. **`__Host-` is unavailable, and that is arithmetic.** `__Host-` requires
 *    `Path=/` and no `Domain`. The whole isolation story now lives in the path and
 *    the name, so the cookie must be `Path=/admin` — the same erratum §7.4.3
 *    records for `__Host-dl-<key>`. `__Secure-` is the strongest prefix that
 *    permits a path, and it still forbids `Domain` (any `Domain=` would let one
 *    tenant host set a cookie another could read; there is none, and a test says so).
 * b. **The name carries the tenant key.** `abc123.com` and `123abc.com` are two
 *    tenants on one box; a shared name plus one `SKW_SESSION_KEY` would mean a
 *    browser or a proxy that mixes hosts up hands tenant A's session to tenant B,
 *    to be caught only by the row check. The name makes the mix-up a non-event:
 *    host B never looks at name A. The row check stays as the second gate, because
 *    a caller can rewrite a name.
 * c. **`SameSite=Strict` replaces the origin separation D9 used.** The old model's
 *    defence was that tenant HTML could not reach the admin origin. That defence is
 *    gone by decision, so the cookie must not ride along on any cross-site request:
 *    a link in an email to `abc123.com/admin` arrives cookieless and is answered by
 *    the same 404 an unknown admin path gets. Cost, stated rather than discovered:
 *    an operator who follows a link into the admin signs in again.
 *
 * Four decisions this file makes, each because the SDS names the control and not
 * its mechanism (reported as gaps in `docs/build/S2a-report.md` §6):
 *
 * 1. **Cookie value = `<id>.<hmac>`**, HMAC-SHA256 over the id with
 *    `SKW_SESSION_KEY` ("session-id signing", §4.3). The signature is checked
 *    before the row is read, so a forged or truncated cookie costs one HMAC and
 *    never reaches SQLite.
 * 2. **Idle timeout is implemented by sliding `expires_at`.** The `session` table
 *    has no `last_seen_at` column and this slice may not add one, so the row's
 *    `expires_at` *is* "last activity + window". 15 min when the allowlist is
 *    empty (§9.1, fixed); 60 min when it is populated (E-18 fixes that value, so
 *    it is no longer an implementation choice).
 *
 *    **E-18 adds the cap the sliding window could not express.** `created_at` is
 *    the start of the session *lineage* and `expires_at` is the idle deadline; a
 *    session is live only while `revoked_at IS NULL`, `expires_at > now` **and**
 *    `created_at + SESSION_ABSOLUTE_MS > now`. The slide is clamped to the cap, so
 *    a session in continuous use dies at 12 h instead of never; rotation gives the
 *    child the parent's `created_at`, so rotating every few hours cannot launder
 *    the cap away. No column is added and no migration exists: the cap is a pure
 *    function of a column already present.
 * 3. **CSRF token = HMAC-SHA256(csrf_secret, session id)**, so the token is bound
 *    to the row and rotates with it. The secret never leaves the server; the
 *    token is handed out by `GET /admin/t/<key>/session`.
 * 4. **The CSRF header is `X-CSRF-Token`.** §9.1 names no header. It is
 *    deliberately *not* an `X-Skunkworks-*` name: row 2 of §5.3 refuses any
 *    `X-Skunkworks-*` header from an untrusted peer, and the admin form must not
 *    trip a tenancy rule by carrying its own CSRF token.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { openAdminWrite } from '../db/classes.ts';

/** D37: one namespace per tenant, so a host mix-up cannot even find the wrong cookie. */
export const SESSION_COOKIE_PREFIX = '__Secure-sk-sess-';
/** D37: the fleet console's own cookie, scoped to `/fleet` so `/admin` never sees it. */
export const FLEET_COOKIE = '__Secure-sk-fleet';
export const ADMIN_COOKIE_PATH = '/admin';
export const FLEET_COOKIE_PATH = '/fleet';
/** `tenant.key`'s CHECK (`^[a-z0-9][a-z0-9-]{0,39}$`), restated here so a name cannot be smuggled. */
const COOKIE_KEY_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/**
 * D37: the session cookie's name is a function of the tenant the **Host** maps to.
 *
 * A tenant key is `[a-z0-9-]`, which is a legal cookie-name token, so the name is
 * the key and not a hash of it: an operator debugging a box can read the name and
 * know which tenant's admin they are looking at, and a hash would hide exactly the
 * fact that matters when three hosts share one box. A key that does not match the
 * schema's CHECK is a programming error and throws here rather than reaching a
 * header, because this string is written into `Set-Cookie` unescaped.
 */
export function sessionCookieName(tenantKey: string): string {
  if (!COOKIE_KEY_RE.test(tenantKey)) {
    throw new Error(`sessionCookieName: not a tenant key: ${JSON.stringify(tenantKey)}`);
  }
  return `${SESSION_COOKIE_PREFIX}${tenantKey}`;
}

/**
 * D37's attribute list, in the order the decision names it: `HttpOnly` then
 * `Secure` then `SameSite=Strict` then `Path`. No `Domain` — ever. A `Domain=`
 * attribute is the one way a cookie set by one tenant host becomes readable by
 * another, and the `__Secure-` prefix forbids it structurally as well.
 */
export function cookieAttrs(path: string): string {
  if (!path.startsWith('/') || /[;,]/.test(path)) {
    throw new Error(`cookieAttrs: not a cookie path: ${JSON.stringify(path)}`);
  }
  return `HttpOnly; Secure; SameSite=Strict; Path=${path}`;
}

/** The CSRF header is `X-CSRF-Token` (§9.1 names no header). */
export const CSRF_HEADER = 'x-csrf-token';


/** §9.1: "when [the allowlist is] empty, TOTP is mandatory and idle drops to 15 min". */
export const IDLE_MS_NO_ALLOWLIST = 15 * 60_000;
/** E-18: the populated-allowlist window, frozen at 60 min (it was a gap in S2a). */
export const IDLE_MS_WITH_ALLOWLIST = 60 * 60_000;
/**
 * E-18: the absolute cap, measured from `session.created_at` — the start of the
 * lineage, never moved by a request and never reset by a rotation.
 */
export const SESSION_ABSOLUTE_MS = 12 * 60 * 60_000;

export interface SessionRecord {
  id: string;
  userId: number;
  tenantId: number | null;
  csrfSecret: string;
  createdAt: string;
  expiresAt: string;
  rotatedFrom: string | null;
}

interface SessionRow {
  id: string;
  user_id: number;
  tenant_id: number | null;
  csrf_secret: string;
  created_at: string;
  expires_at: string;
  rotated_from: string | null;
  revoked_at: string | null;
}

export function idleMsFor(allowlist: readonly string[]): number {
  return allowlist.length === 0 ? IDLE_MS_NO_ALLOWLIST : IDLE_MS_WITH_ALLOWLIST;
}

/** `Cookie: a=1; __Secure-sk-sess-acme=<v>` → the raw value, or null. */
export function cookieValue(header: string | undefined, name: string): string | null {
  if (header === undefined) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    return value === '' ? null : value;
  }
  return null;
}

/** A 32-byte hex id is 64 characters; anything else is not an id we minted. */
const ID_RE = /^[0-9a-f]{64}$/;

export class SessionStore {
  readonly #controlPath: string;
  readonly #busyTimeoutMs: number;
  readonly #key: string;
  readonly #ipHashKey: string;

  constructor(controlPath: string, key: string, ipHashKey: string, busyTimeoutMs = 5000) {
    this.#controlPath = controlPath;
    this.#key = key;
    this.#ipHashKey = ipHashKey;
    this.#busyTimeoutMs = busyTimeoutMs;
  }

  #hmac(message: string, secret: string): string {
    return createHmac('sha256', secret).update(message).digest('base64url');
  }

  /** `<id>.<mac>`; the mac binds the id to `SKW_SESSION_KEY`. */
  sign(id: string): string {
    return `${id}.${this.#hmac(id, this.#key)}`;
  }

  /** The id inside a cookie value, or null when the signature does not verify. */
  verify(value: string | null): string | null {
    if (value === null) return null;
    const dot = value.lastIndexOf('.');
    if (dot === -1) return null;
    const id = value.slice(0, dot);
    const mac = value.slice(dot + 1);
    if (!ID_RE.test(id)) return null;
    const want = this.#hmac(id, this.#key);
    const a = Buffer.from(mac);
    const b = Buffer.from(want);
    if (a.length !== b.length) return null;
    return timingSafeEqual(a, b) ? id : null;
  }

  /** D37: `Set-Cookie` for one tenant's session, in that tenant's own namespace. */
  cookieHeader(name: string, value: string, path: string): string {
    return `${name}=${value}; ${cookieAttrs(path)}`;
  }

  /**
   * The clearing cookie. A deletion needs `Max-Age=0`, and it must name the same
   * path the cookie was set with or the browser keeps the original.
   */
  clearCookieHeader(name: string, path: string): string {
    return `${name}=; ${cookieAttrs(path)}; Max-Age=0`;
  }

  /** Session-bound CSRF token (§9.1). */
  csrfToken(session: Pick<SessionRecord, 'id' | 'csrfSecret'>): string {
    return this.#hmac(session.id, session.csrfSecret);
  }

  verifyCsrf(session: Pick<SessionRecord, 'id' | 'csrfSecret'>, presented: string | null): boolean {
    if (presented === null || presented === '') return false;
    const want = Buffer.from(this.csrfToken(session));
    const got = Buffer.from(presented);
    if (want.length !== got.length) return false;
    return timingSafeEqual(want, got);
  }

  /** `ip_hash` / `ua_hash` are stored, not enforced: the SDS names the columns and no rule. */
  ipHash(ip: string): string {
    return createHmac('sha256', this.#ipHashKey).update(ip).digest('hex');
  }

  uaHash(ua: string): string {
    return createHmac('sha256', this.#ipHashKey).update(ua).digest('hex');
  }

  create(input: {
    userId: number;
    tenantId: number | null;
    ip: string;
    ua: string;
    atMs: number;
    idleMs: number;
    rotatedFrom?: string | null;
  }): SessionRecord {
    const id = randomBytes(32).toString('hex');
    const csrfSecret = randomBytes(32).toString('hex');
    const createdAt = new Date(input.atMs).toISOString();
    // E-18: the idle deadline is clamped by the cap even at creation, so a session
    // cannot be born with an expiry the cap would refuse.
    const expiresAt = new Date(Math.min(input.atMs + input.idleMs, input.atMs + SESSION_ABSOLUTE_MS)).toISOString();
    const db = openAdminWrite(this.#controlPath, this.#busyTimeoutMs);
    try {
      db.prepare(
        `INSERT INTO session (id, user_id, tenant_id, csrf_secret, ip_hash, ua_hash, created_at, expires_at, rotated_from)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.userId,
        input.tenantId,
        csrfSecret,
        this.ipHash(input.ip),
        this.uaHash(input.ua),
        createdAt,
        expiresAt,
        input.rotatedFrom ?? null,
      );
    } finally {
      db.close();
    }
    return {
      id,
      userId: input.userId,
      tenantId: input.tenantId,
      csrfSecret,
      createdAt,
      expiresAt,
      rotatedFrom: input.rotatedFrom ?? null,
    };
  }

  /** The row for `id`, or null when it is absent, revoked or past `expires_at`. */
  read(id: string, atMs: number): SessionRecord | null {
    const db = openAdminWrite(this.#controlPath, this.#busyTimeoutMs);
    try {
      const row = db
        .prepare(
          `SELECT id, user_id, tenant_id, csrf_secret, created_at, expires_at, rotated_from, revoked_at
             FROM session WHERE id = ?`,
        )
        .get(id) as SessionRow | undefined;
      if (row === undefined) return null;
      if (row.revoked_at !== null) return null;
      // E-18: two deadlines, both in `Date.parse` — `datetime()` reformats an ISO
      // string and a comparison against the reformatted value is silently wrong.
      if (Date.parse(row.expires_at) <= atMs) return null;
      if (Date.parse(row.created_at) + SESSION_ABSOLUTE_MS <= atMs) return null;
      return {
        id: row.id,
        userId: row.user_id,
        tenantId: row.tenant_id,
        csrfSecret: row.csrf_secret,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        rotatedFrom: row.rotated_from,
      };
    } finally {
      db.close();
    }
  }

  /**
   * Reads, and slides the idle window forward. `expires_at` is the only place the
   * table can hold "last seen", so a read that is allowed to count as activity
   * must write.
   */
  readAndTouch(id: string, atMs: number, idleMs: number): SessionRecord | null {
    const session = this.read(id, atMs);
    // A refused request must not extend anything: the read returned null before
    // any write, so a dead row is left exactly as it was (E-18).
    if (session === null) return null;
    // E-18: `expires_at := min(now + idle, created_at + SESSION_ABSOLUTE_MS)`.
    const capAt = Date.parse(session.createdAt) + SESSION_ABSOLUTE_MS;
    const expiresAt = new Date(Math.min(atMs + idleMs, capAt)).toISOString();
    if (expiresAt !== session.expiresAt) {
      const db = openAdminWrite(this.#controlPath, this.#busyTimeoutMs);
      try {
        db.prepare('UPDATE session SET expires_at = ? WHERE id = ? AND revoked_at IS NULL').run(expiresAt, id);
      } finally {
        db.close();
      }
    }
    return { ...session, expiresAt };
  }

  /**
   * Rotation on privilege change (§9.1): a new id, a new CSRF secret, and the old
   * row revoked in the same transaction, with `rotated_from` recording the link.
   */
  rotate(
    oldId: string,
    input: { ip: string; ua: string; atMs: number; idleMs: number },
  ): SessionRecord | null {
    const db = openAdminWrite(this.#controlPath, this.#busyTimeoutMs);
    const id = randomBytes(32).toString('hex');
    const csrfSecret = randomBytes(32).toString('hex');
    const rotatedAt = new Date(input.atMs).toISOString();
    try {
      const tx = db.transaction(() => {
        const old = db
          .prepare('SELECT user_id, tenant_id, revoked_at, expires_at, created_at FROM session WHERE id = ?')
          .get(oldId) as
          | { user_id: number; tenant_id: number | null; revoked_at: string | null; expires_at: string; created_at: string }
          | undefined;
        if (old === undefined || old.revoked_at !== null) return null;
        if (Date.parse(old.expires_at) <= input.atMs) return null;
        // E-18: rotation inherits the lineage. Without this, an operator or a
        // stolen cookie that rotates every few hours resets the cap, which is the
        // same hole as having none.
        const capAt = Date.parse(old.created_at) + SESSION_ABSOLUTE_MS;
        if (capAt <= input.atMs) return null;
        const createdAt = old.created_at;
        const expiresAt = new Date(Math.min(input.atMs + input.idleMs, capAt)).toISOString();
        db.prepare('UPDATE session SET revoked_at = ? WHERE id = ?').run(rotatedAt, oldId);
        db.prepare(
          `INSERT INTO session (id, user_id, tenant_id, csrf_secret, ip_hash, ua_hash, created_at, expires_at, rotated_from)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id,
          old.user_id,
          old.tenant_id,
          csrfSecret,
          this.ipHash(input.ip),
          this.uaHash(input.ua),
          createdAt,
          expiresAt,
          oldId,
        );
        return {
          id,
          userId: old.user_id,
          tenantId: old.tenant_id,
          csrfSecret,
          createdAt,
          expiresAt,
          rotatedFrom: oldId,
        } satisfies SessionRecord;
      });
      return tx();
    } finally {
      db.close();
    }
  }

  revoke(id: string, atMs: number): void {
    const db = openAdminWrite(this.#controlPath, this.#busyTimeoutMs);
    try {
      db.prepare('UPDATE session SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(
        new Date(atMs).toISOString(),
        id,
      );
    } finally {
      db.close();
    }
  }
}
