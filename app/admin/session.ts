/**
 * Sessions — SDS §9.1's control table, §9.2's tenant rule, and the `session` table
 * in `schema/control.sql` (unchanged: this module fills it, it does not redesign it).
 *
 * The frozen wire contract (§9.1):
 *
 *   | Session cookie | `__Host-sk-sess`; `Path=/`; `Secure`; `HttpOnly`; `SameSite=Lax` |
 *   | Session id     | 32-byte random hex, stored as a row in `control.db.session`, rotated on privilege change |
 *   | CSRF           | session-bound token on every non-GET, plus an exact `Origin` check against `SKW_ADMIN_ORIGIN` |
 *   | IP allowlist   | opt-in, empty in every exported bundle; **when empty, TOTP is mandatory and idle drops to 15 min** |
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
 *    empty (§9.1, fixed); 60 min when it is populated — the SDS fixes only the
 *    15-minute case, so the other value is stated here rather than implied.
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

export const SESSION_COOKIE = '__Host-sk-sess';
/** §9.1 verbatim: `Path=/`; `Secure`; `HttpOnly`; `SameSite=Lax`. */
export const SESSION_COOKIE_ATTRS = 'Path=/; Secure; HttpOnly; SameSite=Lax';
export const CSRF_HEADER = 'x-csrf-token';

/** §9.1: "when [the allowlist is] empty, TOTP is mandatory and idle drops to 15 min". */
export const IDLE_MS_NO_ALLOWLIST = 15 * 60_000;
/** Not fixed by the SDS (gap); 60 min is the value this implementation ships. */
export const IDLE_MS_WITH_ALLOWLIST = 60 * 60_000;

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

/** `Cookie: a=1; __Host-sk-sess=<v>` → the raw value, or null. */
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

  /** §9.1: the exact attribute list, and nothing else on the cookie. */
  cookieHeader(value: string): string {
    return `${SESSION_COOKIE}=${value}; ${SESSION_COOKIE_ATTRS}`;
  }

  /** The clearing cookie. A deletion needs `Max-Age=0`; the session cookie never has one. */
  clearCookieHeader(): string {
    return `${SESSION_COOKIE}=; ${SESSION_COOKIE_ATTRS}; Max-Age=0`;
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
    const expiresAt = new Date(input.atMs + input.idleMs).toISOString();
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
      if (Date.parse(row.expires_at) <= atMs) return null;
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
    if (session === null) return null;
    const expiresAt = new Date(atMs + idleMs).toISOString();
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
    const createdAt = new Date(input.atMs).toISOString();
    const expiresAt = new Date(input.atMs + input.idleMs).toISOString();
    try {
      const tx = db.transaction(() => {
        const old = db
          .prepare('SELECT user_id, tenant_id, revoked_at, expires_at FROM session WHERE id = ?')
          .get(oldId) as { user_id: number; tenant_id: number | null; revoked_at: string | null; expires_at: string } | undefined;
        if (old === undefined || old.revoked_at !== null) return null;
        if (Date.parse(old.expires_at) <= input.atMs) return null;
        db.prepare('UPDATE session SET revoked_at = ? WHERE id = ?').run(createdAt, oldId);
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
