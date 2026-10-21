/**
 * Admin credentials — SDS §9.1's control table, and §16 S2's "auth (argon2id,
 * TOTP when the allowlist is empty)".
 *
 *   | Password hash | argon2id, `m=19456, t=2, p=1`, through the same 4-slot semaphore as codes |
 *   | TOTP          | mandatory when the IP allowlist is empty |
 *   | Lockout       | 5 failures → `locked_until`, exponential to 15 min |
 *   | `fleet_admin` | with `SKW_FLEET_MODE=0` the app refuses to create **or authenticate** that role (`403 SKW_E_SEC_ROLE_DISABLED`) |
 *
 * Two things the SDS does not fix, decided here and reported as gaps:
 *
 * 1. **The credential-login code is `SKW_E_SEC_AUTH_INVALID` (401), per E-16.**
 *    One status, one code, one body for "wrong password", "unknown email" and
 *    "wrong TOTP". `SKW_E_SEC_CODE_INVALID` stays §7.2's decision about a redeemed
 *    download access code and is not borrowed here (S2a did borrow it; E-16
 *    corrects that, because one counter that mixes the two cannot be alerted on).
 *    The observed cause is recorded in `audit_log.after_json.reason`, which an
 *    attacker cannot read; the wire distinguishes nothing.
 * 2. **TOTP parameters are RFC 6238 defaults** — SHA-1, 6 digits, 30 s step, one
 *    step of clock tolerance each way. Only `user_account.totp_secret` exists in
 *    the schema (a base32 secret), so the parameters have to be a convention.
 * 3. **"Exponential to 15 min"** is `60 s × 2^(n−5)` for the n-th consecutive
 *    failure, capped at 900 s: 1, 2, 4, 8, 15 minutes. The table carries
 *    `failed_logins` and `locked_until` and nothing else, so the exponent is the
 *    failure count rather than a separate lock counter.
 * 4. **A global `fleet_admin` row can authenticate from a tenant login URL.**
 *    `user_account`'s CHECK forces `tenant_id IS NULL` for that role, and there is
 *    one login URL (D29) at `/admin/login` on whichever tenant host the operator
 *    is looking at, so the tenant scope admits a global row as a fallback (a
 *    tenant-scoped row with the same email wins). Since D37 that session is not
 *    homeless: it gets the `__Secure-sk-fleet` cookie and `/fleet` is its surface,
 *    while every `/admin` route refuses it (a fleet session has no tenant, and the
 *    tenant on `/admin` now comes from the Host). With `SKW_FLEET_MODE=0` the role
 *    is refused here, before the password, `403 SKW_E_SEC_ROLE_DISABLED`.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

import { hash, verify } from '@node-rs/argon2';

import { openAdminWrite } from '../db/classes.ts';
import { AppError } from '../errors.ts';

/** C-6 / §9.1: `m=19456, t=2, p=1`, argon2id. */
export const ARGON2_OPTIONS = { algorithm: 2, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export const LOCKOUT_THRESHOLD = 5;
export const LOCKOUT_MAX_MS = 15 * 60_000;
export const TOTP_STEP_MS = 30_000;
export const TOTP_DIGITS = 6;

/**
 * A verifier for a user that does not exist. `authenticate()` always performs
 * exactly one argon2id verify — against this hash when the lookup missed — so an
 * unknown email and a wrong password cost the same wall clock. The value is a
 * real PHC string for a published dummy password; nothing authenticates with it
 * because no row points at it.
 */
export const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$GE2gealfzOO+9CmpJBDThA$iD8YCgPH+gGN2M8ubdV8hvmsNMTSvJEl7JBDDocHHDo';
const DUMMY_PASSWORD = 'skw-dummy-password-for-timing-equalisation';

/**
 * E-16: the secret a TOTP verification runs against when the row has none, so the
 * work an attempt performs does not announce whether the account exists. 20 random
 * bytes rendered as unpadded base32 (32 characters) — the same shape as a real
 * secret; no row points at it, so nothing authenticates with it.
 */
export const DUMMY_TOTP_SECRET = 'MFRGGZDFMZTWQ2LKNNWG23TPOBYXE43U';

/** The 4-slot argon2 semaphore (§9.1, `SKW_ARGON2_MAX_CONCURRENT=4`). */
export class Semaphore {
  readonly #size: number;
  #active = 0;
  readonly #queue: (() => void)[] = [];

  constructor(size: number) {
    if (!Number.isInteger(size) || size < 1) throw new Error('semaphore size must be a positive integer');
    this.#size = size;
  }

  get active(): number {
    return this.#active;
  }

  get waiting(): number {
    return this.#queue.length;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#active >= this.#size) {
      await new Promise<void>((resolve) => this.#queue.push(resolve));
    }
    this.#active += 1;
    try {
      return await fn();
    } finally {
      this.#active -= 1;
      const next = this.#queue.shift();
      if (next !== undefined) next();
    }
  }
}

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32, no padding required (a `user_account.totp_secret` is stored as text). */
export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '');
  if (clean === '') throw new Error('empty base32 secret');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const index = B32.indexOf(ch);
    if (index === -1) throw new Error('not a base32 secret');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** RFC 6238 with the RFC 4226 truncation. */
export function totpCode(secret: string, atMs: number, stepMs = TOTP_STEP_MS): string {
  const counter = Math.floor(atMs / stepMs);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', base32Decode(secret)).update(message).digest();
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  const binary =
    (((mac[offset] ?? 0) & 0x7f) << 24) |
    ((mac[offset + 1] ?? 0) << 16) |
    ((mac[offset + 2] ?? 0) << 8) |
    (mac[offset + 3] ?? 0);
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

/** One step of tolerance each way, compared in constant time. */
export function verifyTotp(secret: string, code: string, atMs: number, window = 1): boolean {
  if (!new RegExp(`^\\d{${TOTP_DIGITS}}$`).test(code)) return false;
  for (let step = -window; step <= window; step += 1) {
    const want = Buffer.from(totpCode(secret, atMs + step * TOTP_STEP_MS));
    const got = Buffer.from(code);
    if (want.length === got.length && timingSafeEqual(want, got)) return true;
  }
  return false;
}

/** 1, 2, 4, 8, 15 minutes for the 5th, 6th, … consecutive failure (§9.1). */
export function lockoutMsFor(failedLogins: number): number {
  if (failedLogins < LOCKOUT_THRESHOLD) return 0;
  const exponent = failedLogins - LOCKOUT_THRESHOLD;
  return Math.min(60_000 * 2 ** exponent, LOCKOUT_MAX_MS);
}

export interface AuthUser {
  id: number;
  tenantId: number | null;
  email: string;
  role: 'fleet_admin' | 'owner' | 'editor' | 'viewer';
}

interface UserRow {
  id: number;
  tenant_id: number | null;
  email: string;
  password_hash: string;
  role: AuthUser['role'];
  totp_secret: string | null;
  failed_logins: number;
  locked_until: string | null;
}

export interface AuthenticateInput {
  /**
   * D37: the host the login arrived on has already picked the tenant, so the
   * lookup is scoped to it. Before D37 (D29) the URL had no tenant and the row
   * did, which made an email that exists in two tenants *ambiguous* — and it is
   * still ambiguous inside a scope, but a tenant host now supplies the scope, so
   * `owner@abc123.com` on `abc123.com` and `owner@123abc.com` on `123abc.com` are
   * two operators rather than one 401. `null` is the fleet scope (`/fleet`).
   */
  scope: number | null;
  email: string;
  password: string;
  totp: string | undefined;
  atMs: number;
}

/**
 * E-16: the cause the *server* observed. It never reaches the wire — the three
 * credential causes are one status, one code and one body — and it exists so
 * `audit_log.after_json.reason` can answer the operator's question after a
 * break-in attempt, which an attacker cannot read.
 */
export type LoginFailureReason = 'unknown_user' | 'ambiguous' | 'password' | 'totp' | 'locked' | 'role_disabled';

export type AuthenticateResult =
  | { ok: true; user: AuthUser }
  | { ok: false; error: AppError; reason: LoginFailureReason };

export class Auth {
  readonly #controlPath: string;
  readonly #busyTimeoutMs: number;
  readonly #fleetMode: boolean;
  readonly #totpRequired: boolean;
  readonly #semaphore: Semaphore;
  /**
   * E-16's work-shape witness: one increment per TOTP verification performed. The
   * count must depend on `totpRequired` only — never on the credentials submitted.
   * A gate reads it; nothing in production does.
   */
  #totpComputations = 0;

  constructor(opts: {
    controlPath: string;
    fleetMode: boolean;
    allowlist: readonly string[];
    semaphore?: Semaphore;
    busyTimeoutMs?: number;
  }) {
    this.#controlPath = opts.controlPath;
    this.#fleetMode = opts.fleetMode;
    this.#totpRequired = opts.allowlist.length === 0;
    this.#semaphore = opts.semaphore ?? new Semaphore(4);
    this.#busyTimeoutMs = opts.busyTimeoutMs ?? 5000;
  }

  get totpRequired(): boolean {
    return this.#totpRequired;
  }

  get totpComputations(): number {
    return this.#totpComputations;
  }

  /** The row behind a session, for the `GET /session` answer. No secret leaves here. */
  userById(id: number): AuthUser | null {
    const db = openAdminWrite(this.#controlPath, this.#busyTimeoutMs);
    try {
      const row = db
        .prepare('SELECT id, tenant_id, email, role FROM user_account WHERE id = ?')
        .get(id) as Pick<UserRow, 'id' | 'tenant_id' | 'email' | 'role'> | undefined;
      if (row === undefined) return null;
      return { id: row.id, tenantId: row.tenant_id, email: row.email, role: row.role };
    } finally {
      db.close();
    }
  }

  hashPassword(password: string): Promise<string> {
    return this.#semaphore.run(() => hash(password, ARGON2_OPTIONS));
  }

  /**
   * Re-verify the password on the account this session already owns.
   *
   * Deliberately *not* `authenticate()`: that path needs an email (which the operator may
   * be in the middle of changing) and, when the allowlist is empty, a TOTP code. Both
   * belong to signing in, not to confirming that the person at the keyboard is the person
   * the session belongs to. One argon2 verify through the same semaphore, and — E-16's
   * rule, kept here for its own reason — the verify runs even when the row is missing, so
   * the work does not say whether the account exists.
   */
  async verifyPassword(userId: number, password: string): Promise<boolean> {
    const db = openAdminWrite(this.#controlPath, this.#busyTimeoutMs);
    let stored: string | undefined;
    try {
      const row = db.prepare('SELECT password_hash FROM user_account WHERE id = ?').get(userId) as
        | { password_hash: string }
        | undefined;
      stored = row?.password_hash;
    } finally {
      db.close();
    }
    let ok = false;
    try {
      ok = await this.#semaphore.run(() => verify(stored ?? DUMMY_HASH, password));
    } catch {
      ok = false;
    }
    return stored !== undefined && ok;
  }

  /**
   * One lookup, exactly one argon2id verify, and the same 401 for a wrong
   * password, an unknown email and a wrong TOTP. The failure counters are written
   * in one statement so two concurrent attempts cannot each read the old count.
   */
  async authenticate(input: AuthenticateInput): Promise<AuthenticateResult> {
    const db = openAdminWrite(this.#controlPath, this.#busyTimeoutMs);
    let rows: UserRow[];
    try {
      rows = db
        .prepare(
          `SELECT id, tenant_id, email, password_hash, role, totp_secret, failed_logins, locked_until
             FROM user_account
            WHERE email = ?`,
        )
        .all(input.email) as UserRow[];
    } finally {
      db.close();
    }

    // D37: `WHERE email = ?` stays the statement — `ix_user_email` is the index the
    // login path is fast because of (`test/index-audit.test.ts`), and the scope is a
    // filter over a handful of rows rather than a second index decision. A tenant
    // scope also admits the fleet rows: `/admin/login` on any host is the one login
    // URL (D29), so a fleet operator signs in there and gets the `/fleet` cookie.
    const scoped = rows.filter((r) =>
      input.scope === null ? r.tenant_id === null : r.tenant_id === input.scope || r.tenant_id === null,
    );

    // One row is the identity. Two rows **inside one scope** with the same email are
    // two operands with one password field: the request is ambiguous, and the answer
    // is the same 401 as a wrong password (no oracle that says "this email exists
    // twice"). `UNIQUE(tenant_id, email)` makes that unreachable today; it stays as
    // the defence it was written as, and the tenant/fleet pair is reachable.
    const row = scoped.length === 1 ? scoped[0] : undefined;

    // §9.1: with SKW_FLEET_MODE=0 the app refuses to *authenticate* this role.
    // Checked before the password so the refusal is the same whether or not the
    // password is right — a bundle has no fleet_admin row to begin with.
    if (row !== undefined && row.role === 'fleet_admin' && !this.#fleetMode) {
      return {
        ok: false,
        error: new AppError('SKW_E_SEC_ROLE_DISABLED', 'fleet_admin is disabled in this build'),
        reason: 'role_disabled',
      };
    }

    if (row !== undefined && row.locked_until !== null && Date.parse(row.locked_until) > input.atMs) {
      return { ok: false, error: new AppError('SKW_E_SEC_RATE_LIMITED', 'too many failed logins'), reason: 'locked' };
    }

    // E-16: the work an attempt performs is a function of the configuration and
    // never of the credentials submitted. Exactly one argon2id verify, and — when
    // TOTP is mandatory — exactly one TOTP verification, against the row's secret
    // or against a fixed dummy secret when there is no row (or the row has none).
    // The TOTP step runs before the password verdict is used, so "the password was
    // right, because a TOTP step ran" is not observable.
    const passwordHash = row?.password_hash ?? DUMMY_HASH;
    const totpSecret = row?.totp_secret ?? DUMMY_TOTP_SECRET;

    let passwordOk = false;
    try {
      passwordOk = await this.#semaphore.run(() => verify(passwordHash, input.password));
    } catch {
      passwordOk = false;
    }

    let totpOk = false;
    if (this.#totpRequired) {
      this.#totpComputations += 1;
      try {
        totpOk = verifyTotp(totpSecret, input.totp ?? '', input.atMs);
      } catch {
        totpOk = false;
      }
    }

    if (row === undefined || !passwordOk || (this.#totpRequired && !totpOk)) {
      if (row !== undefined) this.#recordFailure(row.id, row.failed_logins, input.atMs);
      const reason: LoginFailureReason =
        scoped.length > 1 ? 'ambiguous' : row === undefined ? 'unknown_user' : !passwordOk ? 'password' : 'totp';

      return { ok: false, error: new AppError('SKW_E_SEC_AUTH_INVALID', 'invalid credentials'), reason };
    }

    const db2 = openAdminWrite(this.#controlPath, this.#busyTimeoutMs);
    try {
      db2
        .prepare(
          `UPDATE user_account SET failed_logins = 0, locked_until = NULL, last_login_at = ? WHERE id = ?`,
        )
        .run(new Date(input.atMs).toISOString(), row.id);
    } finally {
      db2.close();
    }

    return {
      ok: true,
      user: { id: row.id, tenantId: row.tenant_id, email: row.email, role: row.role },
    };
  }

  #recordFailure(userId: number, previousFailures: number, atMs: number): void {
    const next = previousFailures + 1;
    const lockMs = lockoutMsFor(next);
    const lockedUntil = lockMs === 0 ? null : new Date(atMs + lockMs).toISOString();
    const db = openAdminWrite(this.#controlPath, this.#busyTimeoutMs);
    try {
      db.prepare(
        `UPDATE user_account
            SET failed_logins = failed_logins + 1,
                locked_until = COALESCE(?, locked_until)
          WHERE id = ?`,
      ).run(lockedUntil, userId);
    } finally {
      db.close();
    }
  }
}
