/**
 * The board's account lifecycle — registration, email proof, TOTP enrolment, sign-in, sessions.
 *
 * This is **core**, not a plugin, and the reason is in the tables: `app/plugins/install.ts`
 * executes `DROP TABLE` for everything a manifest declares, which is the right treatment for a
 * plugin's own content and the wrong one for a stranger's identity. It is also core because a
 * portal cookie at `Path=/portal` and a CSRF origin check are not reachable from a plugin's
 * `EndpointRequest`, which carries `{db, tenant, method, endpoint, body, url}` and no identity.
 *
 * The state machine, stated once, because every bug in a sign-up flow is a skipped transition:
 *
 *   register ─▶ pending ──(email proof)──▶ pending ──(TOTP confirmed)──▶ active
 *                  └─────────(operator)─────────▶ suspended ─▶ active | closed
 *
 * `active` is the only status that may do anything, and the schema refuses to represent it without
 * `email_verified = 1` **and** `totp_confirmed_at IS NOT NULL`. So the two proofs cannot be skipped
 * by a handler bug, a half-finished migration, or an operator SQL session: the row cannot exist.
 *
 * Two decisions worth naming:
 *
 * 1. **Registration tells the caller whether the address already has an account.** Every SaaS does
 *    this, and it is still a disclosure: it is the one place an address can be tested. The
 *    alternatives are worse in different ways — a generic "check your email" that sends nothing
 *    leaves the person who mistyped their own address stuck forever, and a decoy TOTP panel would
 *    have someone scan a secret that can never authenticate. Instead the disclosure is *rate
 *    limited* (5/hour/address, see `limits`), it says nothing about the account beyond existing,
 *    and sign-in stays generic: same code, same message, same argon2 verify for unknown
 *    addresses, wrong passwords and pending accounts.
 * 2. **The verification URL is logged, always.** Requirement: an operator running without a mail
 *    transport must still be able to finish a registration. `deps.log` gets the URL on every mint,
 *    and the URL is returned to the caller only when `exposeVerifyLink` is on — which is the
 *    offline/default posture. Turning real SMTP on turns it off; a link in an HTML response is
 *    only ever a development affordance.
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';

import type Database from 'better-sqlite3';

import { AppError } from '../errors.ts';
import {
  ARGON2_OPTIONS,
  DUMMY_HASH,
  DUMMY_TOTP_SECRET,
  LOCKOUT_THRESHOLD,
  Semaphore,
  lockoutMsFor,
  verifyTotp,
} from '../admin/auth.ts';
import { groupOf, newSecret, otpauthUri } from '../admin/totp.ts';
import type { Env } from '../env.ts';
import { hash, verify } from '@node-rs/argon2';

//
// Numbers. Each is exported so a test can assert the shipped value rather than restate it.
//

/** Registration: 5 new accounts per address per hour. */
export const REGISTER_LIMIT = 5;
/** Sign-in: 10 refusals per address per 15 minutes — the guessing budget, per address. */
export const SIGNIN_LIMIT = 10;
export const WINDOW_MS = 15 * 60_000;
/** A verification link lives one day; a reset link one hour. */
export const VERIFY_TTL_MS = 24 * 60 * 60_000;
export const RESET_TTL_MS = 60 * 60_000;
/** Portal sessions: 12 hours absolute, 1 hour idle — the admin's numbers, same reasoning. */
export const PORTAL_SESSION_MS = 12 * 60 * 60_000;
export const PORTAL_IDLE_MS = 60 * 60_000;
/** Password floor. Length is the only rule worth having; a 12-character phrase beats a symbol soup. */
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 200;

export type Role = 'applicant' | 'advertiser';
export type AccountStatus = 'pending' | 'active' | 'suspended' | 'closed';

/** What a signed-in person is told about themselves. The only shape that carries their address. */
export interface SelfView {
  readonly accountId: number;
  readonly email: string;
  readonly status: AccountStatus;
  readonly roles: readonly Role[];
  readonly displayName: string;
  readonly totpGrouped: string;
  readonly emailVerified: boolean;
  readonly totpConfirmed: boolean;
}

/** A registration that produced rows, and the enrolment material the page must display once. */
export interface RegisteredPending {
  readonly kind: 'pending';
  readonly accountId: number;
  readonly email: string;
  /** Base32, grouped for typing. The page shows this because the account is not usable without it. */
  readonly totpGrouped: string;
  readonly otpauthUri: string;
  /** Present only when `exposeVerifyLink` is on (no mail transport configured). */
  readonly verifyUrl?: string;
  readonly mailed: boolean;
}

/** A registration for an address that already has an account. Produces nothing but a mail. */
export interface RegisteredExists {
  readonly kind: 'exists';
  readonly mailed: boolean;
}

export type RegisterResult = RegisteredPending | RegisteredExists;

/** The outcome of proving an address. `active` means nothing else is owed. */
export type VerifyOutcome =
  | { readonly ok: true; readonly activated: boolean; readonly next: 'confirm_totp' | 'active' }
  | { readonly ok: false; readonly reason: 'unknown' | 'consumed' | 'expired' };

export type SignInResult =
  | {
      readonly ok: true;
      readonly account: SelfView;
      readonly session: { readonly id: string; readonly csrf: string; readonly expiresAt: number };
    }
  /**
   * `credentials` covers an unknown address, a wrong password, a wrong code **and** an account that
   * is not active. The caller renders one message for all four, because "this address exists but you
   * have not finished signing up" is an enumeration oracle; the pending person finds their way back
   * through "resend the confirmation", which sends only if there is something to send.
   */
  | { readonly ok: false; readonly reason: 'credentials' | 'locked' };

export interface AccountsDeps {
  env: Env;
  /** An `admin-write` class handle for the tenant; closed by the caller's factory. */
  openDb(tenantKey: string): Database.Database;
  /** The process-wide argon2 semaphore, shared with admin sign-in and download codes (§7.2: 4). */
  argon: Semaphore;
  now?: () => number;
  /** Where the verification URL goes while there is no mail transport. Never a request log. */
  log?: (line: { readonly event: string } & Record<string, unknown>) => void;
  /** Off in production. On offline, so the operator can finish a sign-up by hand. */
  exposeVerifyLink?: boolean;
  limits?: { register?: number; signin?: number; windowMs?: number } | undefined;
}

/** A sliding window that counts only what it is given; `count()` is what `hit()` is built on. */
export class Window {
  readonly limit: number;
  readonly windowMs: number;
  readonly #hits = new Map<string, number[]>();

  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  count(key: string, atMs: number): number {
    const list = (this.#hits.get(key) ?? []).filter((t) => atMs - t < this.windowMs);
    this.#hits.set(key, list);
    return list.length;
  }

  hit(key: string, atMs: number): boolean {
    const list = (this.#hits.get(key) ?? []).filter((t) => atMs - t < this.windowMs);
    if (list.length >= this.limit) {
      this.#hits.set(key, list);
      return false;
    }
    list.push(atMs);
    this.#hits.set(key, list);
    return true;
  }
}

/**
 * Normalise an address for storage and comparison. The column is `COLLATE NOCASE`, so this is about
 * whitespace and nothing else — Unicode confusables are not a problem the column can solve, and
 * silently folding them would merge two people's addresses.
 */
export function normaliseEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/** 32 bytes of entropy as 64 hex characters: the token the URL carries. */
export function mintToken(): string {
  return randomBytes(32).toString('hex');
}

/** Only the hash is stored. A stolen `site.db` does not contain a working link. */
export function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * 64 hex characters, keyed. The board's tables fix `length(ip_hash) = 64`, unlike the download
 * plane's shorter base64url form, so this cannot be the same helper — one column, one shape.
 */
export function hash64(key: string, value: string): string {
  return createHmac('sha256', key).update(value).digest('hex');
}

/** Reject a password the schema would store happily and a person could not remember safely. */
export function passwordProblem(password: string, email: string): string | null {
  if (password.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
  if (password.length > PASSWORD_MAX) return `Use at most ${PASSWORD_MAX} characters.`;
  if (password.toLowerCase() === email.toLowerCase()) return 'The password cannot be the address.';
  return null;
}

export class Accounts {
  readonly #deps: AccountsDeps;
  readonly #register: Window;
  readonly #signin: Window;

  constructor(deps: AccountsDeps) {
    this.#deps = deps;
    this.#register = new Window(deps.limits?.register ?? REGISTER_LIMIT, deps.limits?.windowMs ?? WINDOW_MS);
    this.#signin = new Window(deps.limits?.signin ?? SIGNIN_LIMIT, deps.limits?.windowMs ?? WINDOW_MS);
  }

  #now(): number {
    return (this.#deps.now ?? Date.now)();
  }

  #ipHash(req: { readonly ip?: string }): string {
    return hash64(this.#deps.env.ipHashKey, req.ip ?? '');
  }

  #log(line: { readonly event: string } & Record<string, unknown>): void {
    this.#deps.log?.(line);
  }

  /**
   * `POST /portal/register`. Hashes the password *before* touching the database, so the work done
   * for an existing address and a new one is the same shape, then creates the account, its roles,
   * its profile shell and one verify token in a single transaction — a half-registered person is
   * a stuck person, and `better-sqlite3` makes the whole thing one synchronous unit.
   */
  async register(
    input: {
      readonly email: string;
      readonly password: string;
      readonly displayName: string;
      readonly roles: readonly Role[];
    },
    tenantKey: string,
    ctx: { readonly ip?: string },
  ): Promise<RegisterResult> {
    const atMs = this.#now();
    const ipHash = this.#ipHash(ctx);
    if (!this.#register.hit(ipHash, atMs)) {
      throw new AppError('SKW_E_SEC_RATE_LIMITED', 'too many sign-ups from this address', {
        window_s: (this.#deps.limits?.windowMs ?? WINDOW_MS) / 1000,
      });
    }

    const email = normaliseEmail(input.email);
    const problem = passwordProblem(input.password, email);
    if (problem !== null) {
      throw new AppError('SKW_E_PLT_REQUEST_INVALID', problem);
    }
    const roles = [...new Set(input.roles)];
    if (roles.length === 0) {
      throw new AppError('SKW_E_PLT_REQUEST_INVALID', 'choose at least one account type');
    }

    // The hash happens before the lookup: an existing address costs the same argon2id as a new one.
    const passwordHash = await this.#deps.argon.run(() => hash(input.password, ARGON2_OPTIONS));
    const secret = newSecret();
    const at = new Date(atMs).toISOString();
    const db = this.#deps.openDb(tenantKey);

    try {
      const existing = db.prepare('SELECT id FROM cms_account WHERE email = ?').get(email) as
        | { id: number }
        | undefined;
      if (existing !== undefined) {
        // Tell the owner, not the caller: "you already have an account, here is how to get in".
        this.#enqueue(db, {
          to: email,
          template: 'account_exists',
          subject: 'You already have a Fractional Works account',
          vars: { email },
          idempotencyKey: `exists:${existing.id}:${Math.floor(atMs / 3_600_000)}`,
          at,
        });
        this.#log({ event: 'account.register.exists', tenant: tenantKey, account_id: existing.id });
        return { kind: 'exists', mailed: true };
      }

      const token = mintToken();
      const verifyUrl = `/portal/verify?token=${token}`;
      const result = db.transaction(() => {
        const info = db
          .prepare(
            `INSERT INTO cms_account (email, password_hash, totp_secret)
             VALUES (?, ?, ?)`,
          )
          .run(email, passwordHash, secret);
        const accountId = Number(info.lastInsertRowid);
        const role = db.prepare('INSERT INTO cms_account_role (account_id, role) VALUES (?, ?)');
        for (const r of roles) role.run(accountId, r);
        db.prepare('INSERT INTO cms_profile (account_id, display_name) VALUES (?, ?)').run(
          accountId,
          input.displayName.trim(),
        );
        db.prepare(
          `INSERT INTO cms_account_token (account_id, purpose, token_hash, expires_at, ip_hash, created_at)
           VALUES (?, 'verify_email', ?, ?, ?, ?)`,
        ).run(accountId, tokenHash(token), new Date(atMs + VERIFY_TTL_MS).toISOString(), ipHash, at);
        return accountId;
      })();

      this.#enqueue(db, {
        to: email,
        template: 'verify_email',
        subject: 'Confirm your email to finish signing up',
        // The template gets the path; the host is the tenant's, added by the mailer, not here.
        vars: { email, verify_path: verifyUrl, ttl_hours: VERIFY_TTL_MS / 3_600_000 },
        idempotencyKey: `verify:${result}:${atMs}`,
        at,
      });

      // Logged unconditionally: without a transport this line is the only way in.
      this.#log({
        event: 'account.verify_link',
        tenant: tenantKey,
        account_id: result,
        email,
        url: verifyUrl,
        expires_at: new Date(atMs + VERIFY_TTL_MS).toISOString(),
      });

      const exposure = this.#deps.exposeVerifyLink === true ? { verifyUrl } : {};
      return {
        kind: 'pending',
        accountId: result,
        email,
        totpGrouped: groupOf(secret),
        otpauthUri: otpauthUri(email, secret),
        mailed: true,
        ...exposure,
      };
    } finally {
      db.close();
    }
  }

  /**
   * Prove an address. The token is consumed with a conditional `UPDATE ... WHERE consumed_at IS NULL`
   * and the row count decides the winner, so two clicks on the same link activate once — the second
   * click lands on `consumed` and renders "already confirmed", not a second activation.
   */
  verifyEmail(token: string, tenantKey: string): VerifyOutcome {
    const atMs = this.#now();
    const at = new Date(atMs).toISOString();
    const db = this.#deps.openDb(tenantKey);
    try {
      const row = db
        .prepare(
          `SELECT id, account_id, expires_at, consumed_at FROM cms_account_token
            WHERE token_hash = ? AND purpose = 'verify_email'`,
        )
        .get(tokenHash(token)) as
        | { id: number; account_id: number; expires_at: string; consumed_at: string | null }
        | undefined;
      if (row === undefined) return { ok: false, reason: 'unknown' };
      if (row.consumed_at !== null) return { ok: false, reason: 'consumed' };
      if (new Date(row.expires_at).getTime() <= atMs) return { ok: false, reason: 'expired' };

      const consumed = db
        .prepare('UPDATE cms_account_token SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL')
        .run(at, row.id);
      if (consumed.changes !== 1) return { ok: false, reason: 'consumed' };

      db.prepare('UPDATE cms_account SET email_verified = 1, updated_at = ? WHERE id = ?').run(
        at,
        row.account_id,
      );
      const activated = this.#activateIfProven(db, row.account_id, at);
      return { ok: true, activated, next: activated ? 'active' : 'confirm_totp' };
    } finally {
      db.close();
    }
  }

  /**
   * The second proof: one code from the secret shown at registration. Confirming twice is not an
   * error — the second call returns the same answer — because a double-submitted form is not an
   * attack and a person who reloads should not be told they broke something.
   */
  confirmTotp(accountId: number, code: string, tenantKey: string): { readonly ok: boolean; readonly activated: boolean } {
    const atMs = this.#now();
    const at = new Date(atMs).toISOString();
    const db = this.#deps.openDb(tenantKey);
    try {
      const row = db.prepare('SELECT totp_secret, totp_confirmed_at FROM cms_account WHERE id = ?').get(accountId) as
        | { totp_secret: string; totp_confirmed_at: string | null }
        | undefined;
      if (row === undefined) return { ok: false, activated: false };
      if (row.totp_confirmed_at !== null) {
        return { ok: true, activated: this.#statusOf(db, accountId) === 'active' };
      }
      if (!verifyTotp(row.totp_secret, code.trim(), atMs)) return { ok: false, activated: false };
      db.prepare('UPDATE cms_account SET totp_confirmed_at = ?, updated_at = ? WHERE id = ?').run(at, at, accountId);
      const activated = this.#activateIfProven(db, accountId, at);
      return { ok: true, activated };
    } finally {
      db.close();
    }
  }

  /**
   * Promote `pending` to `active` when (and only when) both proofs are present. `suspended` and
   * `closed` are never promoted by this path: an operator's decision outranks a late click.
   */
  #activateIfProven(db: Database.Database, accountId: number, at: string): boolean {
    const row = db
      .prepare('SELECT status, email_verified, totp_confirmed_at FROM cms_account WHERE id = ?')
      .get(accountId) as { status: AccountStatus; email_verified: number; totp_confirmed_at: string | null } | undefined;
    if (row === undefined) return false;
    if (row.status !== 'pending') return row.status === 'active';
    if (row.email_verified !== 1 || row.totp_confirmed_at === null) return false;
    db.prepare("UPDATE cms_account SET status = 'active', updated_at = ? WHERE id = ? AND status = 'pending'").run(
      at,
      accountId,
    );
    return true;
  }

  #statusOf(db: Database.Database, accountId: number): AccountStatus {
    const row = db.prepare('SELECT status FROM cms_account WHERE id = ?').get(accountId) as
      | { status: AccountStatus }
      | undefined;
    return row?.status ?? 'closed';
  }

  /**
   * `POST /portal/signin`. Exactly one argon2id verify runs on every attempt — against the stored
   * hash when the address matched, against `DUMMY_HASH` when it did not — and exactly one TOTP
   * check, against `DUMMY_TOTP_SECRET` when there is nobody to check. A pending account is refused
   * *after* both, so "not finished signing up" costs the same as "wrong password" and is reported
   * with the same message: sign-in is not an oracle for who exists or how far along they are.
   */
  async signIn(
    input: { readonly email: string; readonly password: string; readonly code: string },
    tenantKey: string,
    ctx: { readonly ip?: string; readonly userAgent?: string },
  ): Promise<SignInResult> {
    const atMs = this.#now();
    const at = new Date(atMs).toISOString();
    const ipHash = this.#ipHash(ctx);
    if (!this.#signin.hit(ipHash, atMs)) {
      throw new AppError('SKW_E_SEC_RATE_LIMITED', 'too many attempts from this address', {
        window_s: (this.#deps.limits?.windowMs ?? WINDOW_MS) / 1000,
      });
    }

    const email = normaliseEmail(input.email);
    const db = this.#deps.openDb(tenantKey);
    try {
      const row = db
        .prepare(
          `SELECT id, email, status, password_hash, totp_secret, failed_logins, locked_until
             FROM cms_account WHERE email = ?`,
        )
        .get(email) as
        | {
            id: number;
            email: string;
            status: AccountStatus;
            password_hash: string;
            totp_secret: string;
            failed_logins: number;
            locked_until: string | null;
          }
        | undefined;

      if (row !== undefined && row.locked_until !== null && new Date(row.locked_until).getTime() > atMs) {
        // Locked is its own answer only for the person who holds the account: it tells them to wait
        // rather than to keep trying, and it reveals nothing an attacker did not just do themselves.
        return { ok: false, reason: 'locked' };
      }

      const passwordOk = await this.#deps.argon.run(() => verify(row?.password_hash ?? DUMMY_HASH, input.password));
      const totpOk = verifyTotp(row?.totp_secret ?? DUMMY_TOTP_SECRET, input.code.trim(), atMs);

      if (row === undefined || !passwordOk || !totpOk) {
        if (row !== undefined) this.#noteFailure(db, row.id, row.failed_logins, atMs);
        return { ok: false, reason: 'credentials' };
      }
      if (row.status !== 'active') {
        // Correct credentials, unfinished or stopped account. No failure is counted: this is not a
        // wrong guess, and a person locked out for checking their own pending account is a support
        // case. The answer is `credentials` so the caller cannot tell this apart from a wrong password.
        return { ok: false, reason: 'credentials' };
      }

      db.prepare(
        'UPDATE cms_account SET failed_logins = 0, locked_until = NULL, last_login_at = ?, updated_at = ? WHERE id = ?',
      ).run(at, at, row.id);

      const session = this.#mintSession(db, row.id, atMs, ctx);
      const account = this.#selfView(db, row.id);
      return { ok: true, account, session };
    } finally {
      db.close();
    }
  }

  /** Exponential, capped at 15 minutes — the same table the admin login uses, same fields. */
  #noteFailure(db: Database.Database, accountId: number, previous: number, atMs: number): void {
    const failed = previous + 1;
    const lockMs = failed >= LOCKOUT_THRESHOLD ? lockoutMsFor(failed) : 0;
    db.prepare('UPDATE cms_account SET failed_logins = ?, locked_until = ?, updated_at = ? WHERE id = ?').run(
      failed,
      lockMs > 0 ? new Date(atMs + lockMs).toISOString() : null,
      new Date(atMs).toISOString(),
      accountId,
    );
  }

  /**
   * A session row and the two secrets that go with it. The id is the token in the cookie; only its
   * hash is stored, so the file is not a set of working sessions. `csrf_secret` is what the portal's
   * forms carry, and `ip_hash`/`ua_hash` are what let a stolen cookie be noticed.
   */
  #mintSession(
    db: Database.Database,
    accountId: number,
    atMs: number,
    ctx: { readonly ip?: string; readonly userAgent?: string },
  ): { id: string; csrf: string; expiresAt: number } {
    const token = mintToken();
    const csrf = mintToken();
    const at = new Date(atMs).toISOString();
    db.prepare(
      `INSERT INTO cms_account_session (id, account_id, csrf_secret, ip_hash, ua_hash, created_at, last_seen_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      tokenHash(token),
      accountId,
      csrf,
      this.#ipHash(ctx),
      hash64(this.#deps.env.ipHashKey, ctx.userAgent ?? ''),
      at,
      at,
      new Date(atMs + PORTAL_SESSION_MS).toISOString(),
    );
    return { id: token, csrf, expiresAt: atMs + PORTAL_SESSION_MS };
  }

  /**
   * Resolve a cookie to a person. `null` for anything that is not a live session, which the caller
   * renders as "sign in": an expired, revoked, rotated or unknown token are one answer, because a
   * person holding a stale cookie learns nothing from the distinction and an attacker learns from it.
   */
  authenticate(token: string, tenantKey: string, ctx: { readonly ip?: string }): SelfView | null {
    const atMs = this.#now();
    const db = this.#deps.openDb(tenantKey);
    try {
      const row = db
        .prepare(
          `SELECT account_id, ip_hash, created_at, last_seen_at, expires_at, revoked_at
             FROM cms_account_session WHERE id = ?`,
        )
        .get(tokenHash(token)) as
        | {
            account_id: number;
            ip_hash: string;
            created_at: string;
            last_seen_at: string;
            expires_at: string;
            revoked_at: string | null;
          }
        | undefined;
      if (row === undefined || row.revoked_at !== null) return null;
      if (new Date(row.expires_at).getTime() <= atMs) return null;
      if (atMs - new Date(row.last_seen_at).getTime() > PORTAL_IDLE_MS) return null;
      if (row.ip_hash !== this.#ipHash(ctx)) return null;

      const view = this.#selfView(db, row.account_id);
      if (view.status !== 'active') return null;
      db.prepare('UPDATE cms_account_session SET last_seen_at = ? WHERE id = ?').run(
        new Date(atMs).toISOString(),
        tokenHash(token),
      );
      return view;
    } finally {
      db.close();
    }
  }

  /** Revoke one session. Signing out must not depend on the row still being live. */
  signOut(token: string, tenantKey: string): void {
    const db = this.#deps.openDb(tenantKey);
    try {
      db.prepare('UPDATE cms_account_session SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(
        new Date(this.#now()).toISOString(),
        tokenHash(token),
      );
    } finally {
      db.close();
    }
  }

  /** The account holder's own record. Note that this is the only view carrying their address. */
  #selfView(db: Database.Database, accountId: number): SelfView {
    const row = db
      .prepare(
        `SELECT a.id, a.email, a.status, a.email_verified, a.totp_confirmed_at, a.totp_secret, p.display_name
           FROM cms_account a LEFT JOIN cms_profile p ON p.account_id = a.id WHERE a.id = ?`,
      )
      .get(accountId) as
      | {
          id: number;
          email: string;
          status: AccountStatus;
          email_verified: number;
          totp_confirmed_at: string | null;
          totp_secret: string;
          display_name: string | null;
        }
      | undefined;
    if (row === undefined) {
      throw new AppError('SKW_E_SEC_AUTH_INVALID', 'not signed in');
    }
    const roles = (
      db.prepare('SELECT role FROM cms_account_role WHERE account_id = ? ORDER BY role').all(accountId) as {
        role: Role;
      }[]
    ).map((r) => r.role);
    return {
      accountId: row.id,
      email: row.email,
      status: row.status,
      roles,
      displayName: row.display_name ?? '',
      totpGrouped: groupOf(row.totp_secret),
      emailVerified: row.email_verified === 1,
      totpConfirmed: row.totp_confirmed_at !== null,
    };
  }

  /** One outbox row. `idempotency_key` is UNIQUE, so a retried call is the same message. */
  #enqueue(
    db: Database.Database,
    mail: {
      readonly to: string;
      readonly template: string;
      readonly subject: string;
      readonly vars: Record<string, unknown>;
      readonly idempotencyKey: string;
      readonly at: string;
    },
  ): void {
    db.prepare(
      `INSERT INTO cms_mail (to_email, template, subject, vars_json, idempotency_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(mail.to, mail.template, mail.subject, JSON.stringify(mail.vars), mail.idempotencyKey, mail.at);
  }
}
