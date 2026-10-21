/**
 * Test helpers for the admin surface. Nothing is mocked: users are real
 * `user_account` rows with real argon2id hashes at the frozen cost, and logins go
 * over a socket to the real `buildApp` instance.
 */
import Database from 'better-sqlite3';
import { hash } from '@node-rs/argon2';

import { ARGON2_OPTIONS, totpCode } from '../../app/admin/auth.ts';
import { call, header, type Res } from './http.ts';

/**
 * D37: there is no admin host. `ADMIN_HOST` is now the *tenant* host the fixture's
 * `acme` tenant is served on — the name is kept so that a test that says "this is
 * where an operator works" still reads, but the address is a tenant's. The origin is
 * the same host, because the CSRF check compares `Origin` with the Host it arrived on.
 */
export const ADMIN_HOST = 'acme.test';
export const ADMIN_ORIGIN = 'https://acme.test';

/** D37: the host each fixture tenant is served on. The first host of each tenant. */
export const TENANT_HOST: Record<string, string> = {
  acme: 'acme.test',
  beta: 'beta.test',
  'demo-acme': 'acme-demo.test',
};

/** The host a tenant key is administered on; a key the fixture does not know is `acme`. */
export function hostForKey(key: string | undefined): string {
  return key === undefined ? ADMIN_HOST : TENANT_HOST[key] ?? ADMIN_HOST;
}
export const PASSWORD = 'correct-horse-battery-staple';
/** A base32 secret with the length RFC 4226 recommends (160 bits). */
export const TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

export interface SeedOptions {
  controlDb: string;
  tenantKey: string | null;
  email: string;
  password?: string;
  role?: 'fleet_admin' | 'owner' | 'editor' | 'viewer';
  totpSecret?: string | null;
}

/** Inserts an operator and returns its id. `tenantKey: null` makes a fleet_admin. */
export async function seedUser(opts: SeedOptions): Promise<number> {
  const passwordHash = await hash(opts.password ?? PASSWORD, ARGON2_OPTIONS);
  const db = new Database(opts.controlDb);
  try {
    db.pragma('foreign_keys = ON');
    let tenantId: number | null = null;
    if (opts.tenantKey !== null) {
      const row = db.prepare('SELECT id FROM tenant WHERE key = ?').get(opts.tenantKey) as { id: number } | undefined;
      if (row === undefined) throw new Error(`no tenant ${opts.tenantKey} in the fixture`);
      tenantId = row.id;
    }
    const info = db
      .prepare(
        `INSERT INTO user_account (tenant_id, email, password_hash, role, totp_secret)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(tenantId, opts.email, passwordHash, opts.role ?? 'owner', opts.totpSecret ?? null);
    return Number(info.lastInsertRowid);
  } finally {
    db.close();
  }
}

export interface LoginInput {
  port: number;
  /**
   * D29: the login URL is `/admin/login` and is **not** tenant-scoped, so `key` is
   * not part of the request. When it is given, the helper asserts that the tenant
   * the server derived from the `user_account` row is the one the test meant —
   * which is the stronger check the old per-tenant URL used to imply.
   */
  key?: string;
  email: string;
  password?: string;
  totp?: string;
  origin?: string | null;
  host?: string;
}

export async function login(opts: LoginInput): Promise<Res> {
  const headers: Record<string, string> = {};
  if (opts.origin !== null) headers.origin = opts.origin ?? ADMIN_ORIGIN;
  const body: Record<string, string> = { email: opts.email, password: opts.password ?? PASSWORD };
  if (opts.totp !== undefined) body.totp = opts.totp;
  const res = await call({
    port: opts.port,
    path: '/admin/login',
    method: 'POST',
    // D37: the login belongs on the tenant's own host, so a test that names a key gets
    // that key's host and the Host scopes the credential lookup.
    host: opts.host ?? hostForKey(opts.key),
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (opts.key !== undefined) {
    const derived = (res.json as { tenant?: { key?: string } } | undefined)?.tenant?.key;
    if (derived !== undefined && derived !== opts.key) {
      throw new Error(`login resolved tenant ${derived}, expected ${opts.key} (D29: the row decides, not the URL)`);
    }
  }
  return res;
}

/** The current TOTP for a secret, so a test can log in without a clock seam. */
export function currentTotp(secret: string = TOTP_SECRET): string {
  return totpCode(secret, Date.now());
}

export function setCookie(res: Res): string | undefined {
  return header(res, 'set-cookie');
}

export function cookiePair(res: Res): string | undefined {
  const raw = setCookie(res);
  if (raw === undefined) return undefined;
  const semi = raw.indexOf(';');
  return semi === -1 ? raw : raw.slice(0, semi);
}

export interface Sessioned {
  cookie: string;
  csrfToken: string;
  email: string;
}

/** Logs in with a valid TOTP and returns what a browser would hold. */
export async function openSession(opts: Omit<LoginInput, 'totp'>): Promise<Sessioned> {
  const res = await login({ ...opts, totp: currentTotp() });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${res.body}`);
  const pair = cookiePair(res);
  const json = res.json as { csrfToken?: string };
  if (pair === undefined || json.csrfToken === undefined) throw new Error('login returned no cookie/token');
  return { cookie: pair, csrfToken: json.csrfToken, email: opts.email };
}

/** The body with the per-request id removed, so two responses can be compared. */
export function scrubBody(res: Res): string {
  const parsed = res.json as { error?: { requestId?: string } } | undefined;
  if (parsed?.error !== undefined && parsed.error.requestId !== undefined) {
    return JSON.stringify({ ...parsed, error: { ...parsed.error, requestId: '<request-id>' } });
  }
  return res.body;
}

export function codeOf(res: Res): string | undefined {
  return (res.json as { error?: { code?: string } } | undefined)?.error?.code;
}

export function median(samples: readonly number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2 : (sorted[mid] ?? 0);
}

/**
 * The sample at `p` per cent, nearest-rank. Used to describe a timing distribution
 * beside its median: a gate whose median moved and whose p10/p90 did not is a real
 * asymmetry, and one where the whole spread moved is the box (E-16).
 */
export function percentile(samples: readonly number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[index] as number;
}
