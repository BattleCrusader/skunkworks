/**
 * The admin surface — SDS §9, errata E-16/E-18/E-19 and the frozen CEO decisions
 * D28, D29 and D30.
 *
 * Shapes, exactly as frozen:
 *
 *   GET  /admin                        the fleet console: the tenant list and the
 *                                      switcher (D29). Selection changes the URL;
 *                                      the session's tenant never changes.
 *   GET|POST /admin/login              the only login URL (D29). Not tenant-scoped:
 *                                      the tenant comes from the `user_account` row.
 *   POST /admin/password/reset         consume a reset token (E-19's columns).
 *   ....  /admin/t/<key>/<action>      every tenant-scoped URL (D29, §9.2):
 *                                      `` (home), session, session/rotate, logout,
 *                                      totp/enrol, totp/confirm, password/reset-request,
 *                                      pages, pages/<id>.
 *
 * Rules this file implements, each cited:
 *
 *  - **§9.1 rule 1** — the surface exists only when `listener = 'admin'`. On any
 *    other Host this handler does not parse a cookie and does not answer: it hands
 *    the request to the same page-miss path `setNotFoundHandler` uses.
 *  - **§5.3 row 1** — the admin listener refuses a tenant header that is present
 *    at all, before any route runs.
 *  - **§5.3 row 2** — an untrusted peer may not assert any `X-Skunkworks-*` header.
 *  - **§5.3 row 7** — a tenant-scoped admin request with no session is
 *    `404 SKW_E_PLT_TENANT_UNKNOWN`, never `401` or `403`.
 *  - **§9.2** — `/admin/t/<key>/…`; the tenant comes from `session.tenant_id` and the
 *    URL key must equal that tenant's key. A fleet operator (`tenant_id IS NULL`)
 *    has no tenant URL; the console is its surface.
 *  - **D28** — the CSRF header is `X-CSRF-Token`, one header, and there is no
 *    form-field alternative anywhere in this file.
 *  - **E-16** — a credential failure is `401 SKW_E_SEC_AUTH_INVALID`, with one body
 *    for all three causes; the cause observed goes to `audit_log`, never the wire.
 *
 * Order of checks on a tenant-scoped route: listener → row 1 → row 2 → session
 * (404) → tenant (404) → Origin (403) → CSRF token (403) → the route. The session
 * precedes the CSRF check deliberately: a request with no session has no token to
 * bind and is the row-7 404, not a 403.
 */
import type Database from 'better-sqlite3';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';

import { openAdminWrite, openRenderRead } from '../db/classes.ts';
import type { Env } from '../env.ts';
import { AppError } from '../errors.ts';
import type { TenantMap } from '../tenancy/cache.ts';
import { listenerFor } from '../tenancy/listener.ts';
import {
  TENANT_HEADER,
  anySkunkworksHeader,
  headerPresent,
  peerInCidrs,
  type Tenant,
} from '../tenancy/resolve.ts';
import { Auth, Semaphore, verifyTotp, type LoginFailureReason } from './auth.ts';
import { groupOf, newSecret, otpauthUri } from './totp.ts';
import {
  CSRF_HEADER,
  SESSION_COOKIE,
  SessionStore,
  cookieValue,
  idleMsFor,
  type SessionRecord,
} from './session.ts';

/** `tenant.key`'s CHECK: `^[a-z0-9][a-z0-9-]{0,39}$`. */
const KEY_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const PAGE_ID_RE = /^[0-9]{1,18}$/;

/** What the admin router calls when the request is not the admin surface after all. */
export type NotFoundFallback = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface AdminOptions {
  env: Env;
  controlPath: string;
  tenants: TenantMap;
  adminHost: string | null;
  /** §9.1: opt-in, empty in every exported bundle. Empty ⇒ TOTP mandatory, 15-min idle. */
  allowlist?: string[];
}

interface Headers {
  [key: string]: string | string[] | undefined;
}

function header(req: FastifyRequest, name: string): string | undefined {
  const value = req.headers[name] as string | string[] | undefined;
  return Array.isArray(value) ? (value[0] as string | undefined) : value;
}

function pathnameOf(url: string): string {
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

/** The body as a string map, from JSON or from an HTML form post. */
function fieldsOf(body: unknown): Record<string, string | undefined> {
  if (typeof body === 'string') {
    const out: Record<string, string | undefined> = {};
    for (const [k, v] of new URLSearchParams(body)) out[k] = v;
    return out;
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return {};
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

/** The only escaping in this file: every interpolation into HTML goes through it. */
function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title></head>
<body><main>${body}</main></body></html>`;
}

/** A pending TOTP enrolment: in memory, single-use, ten minutes. */
interface PendingEnrolment {
  secret: string;
  expiresAt: number;
}

const ENROLMENT_TTL_MS = 10 * 60_000;
/** E-19's file says "delete this after enrolling": the password is the only copy. */
const PASSWORD_MIN_LENGTH = 16;
const RESET_TTL_MS = 30 * 60_000;

export class AdminSurface {
  readonly sessions: SessionStore;
  readonly auth: Auth;
  readonly #env: Env;
  readonly #controlPath: string;
  readonly #tenants: TenantMap;
  readonly #adminHost: string | null;
  readonly #allowlist: string[];
  readonly #idleMs: number;

  /**
   * E-19's enrolment is two steps — generate, then confirm — and the schema has no
   * column for "pending". The secret therefore lives here until a code proves the
   * operator's authenticator holds it, and only then is written to
   * `user_account.totp_secret`. Until then the operator's existing secret keeps
   * working, so a mistyped enrolment cannot lock anybody out.
   */
  readonly #pendingTotp = new Map<string, PendingEnrolment>();

  constructor(opts: AdminOptions) {
    this.#env = opts.env;
    this.#controlPath = opts.controlPath;
    this.#tenants = opts.tenants;
    this.#adminHost = opts.adminHost;
    this.#allowlist = opts.allowlist ?? [];
    this.#idleMs = idleMsFor(this.#allowlist);
    this.sessions = new SessionStore(opts.controlPath, opts.env.sessionKey, opts.env.ipHashKey, opts.env.dbBusyTimeoutMs);
    this.auth = new Auth({
      controlPath: opts.controlPath,
      fleetMode: opts.env.fleetMode,
      allowlist: this.#allowlist,
      semaphore: new Semaphore(opts.env.argon2MaxConcurrent),
      busyTimeoutMs: opts.env.dbBusyTimeoutMs,
    });
  }

  get idleMs(): number {
    return this.#idleMs;
  }

  /** §9.1 rule 1: this is the only gate on cookie parsing. */
  sessionFor(cookieHeader: string | undefined, atMs = Date.now()): SessionRecord | null {
    const id = this.sessions.verify(cookieValue(cookieHeader, SESSION_COOKIE));
    if (id === null) return null;
    return this.sessions.readAndTouch(id, atMs, this.#idleMs);
  }

  handles(req: FastifyRequest): boolean {
    const pathname = pathnameOf(req.url);
    return pathname === '/admin' || pathname === '/admin/' || pathname.startsWith('/admin/');
  }

  async handle(req: FastifyRequest, reply: FastifyReply, fallback: NotFoundFallback): Promise<void> {
    const listener = listenerFor(req.headers.host, this.#adminHost);
    if (listener !== 'admin') {
      // §9.1 rule 1: no admin route, no session cookie parse, no admin response
      // on a public listener. The request is an ordinary unmatched path.
      await fallback(req, reply);
      return;
    }

    // §5.3 rows 1 and 2, before any route.
    const headers = req.headers as Headers;
    if (headerPresent(headers, TENANT_HEADER)) {
      throw new AppError('SKW_E_PLT_EDGE_PROOF', 'the admin listener does not accept a tenant header');
    }
    const peer = req.socket.remoteAddress ?? '';
    if (!peerInCidrs(peer, this.#env.edgeTrustedCidrs) && anySkunkworksHeader(headers)) {
      throw new AppError('SKW_E_PLT_EDGE_PROOF', 'edge assertion from an untrusted peer');
    }

    // §5.5: every admin response is `no-store`. Set here, once, so a new route
    // cannot forget it — the console, the login page and the tenant home included.
    reply.header('cache-control', 'no-store');

    const pathname = pathnameOf(req.url);
    const seg = pathname.split('/').filter((s) => s !== '');
    // seg[0] is 'admin' on every path this handler sees.

    if (seg.length === 1) {
      this.#requireMethod(req, 'GET');
      this.#console(req, reply);
      return;
    }

    if (seg.length === 2 && seg[1] === 'login') {
      await this.#loginRoute(req, reply);
      return;
    }

    if (seg.length === 3 && seg[1] === 'password' && seg[2] === 'reset') {
      this.#requireMethod(req, 'POST');
      await this.#passwordReset(req, reply);
      return;
    }

    if (seg[1] === 't' && seg.length >= 3) {
      const key = seg[2] as string;
      if (!KEY_RE.test(key)) throw new AppError('SKW_E_PLT_TENANT_UNKNOWN', 'no admin route at this path');
      const tenant = this.#tenants.lookupKey(key);
      if (tenant === undefined || tenant.status !== 'active') {
        throw new AppError('SKW_E_PLT_TENANT_UNKNOWN', 'no tenant here');
      }
      const action = seg.slice(3).join('/');
      await this.#tenantRoute(req, reply, tenant, action);
      return;
    }

    // §9.2: every admin URL is one of the shapes above; anything else under the
    // admin host is the same "no tenant here" 404 as an unknown path.
    throw new AppError('SKW_E_PLT_TENANT_UNKNOWN', 'no admin route at this path');
  }

  // --- D29: the console, the login page, the reset consumer ---------------

  #console(req: FastifyRequest, reply: FastifyReply): void {
    const session = this.#requireSession(req);
    const user = this.auth.userById(session.userId);
    const all = this.#tenants.all().filter((t) => t.status === 'active');

    // A fleet operator (`tenant_id IS NULL`) sees the fleet. A tenant operator
    // sees the one tenant its session names — not because the URL says so, but
    // because that is the whole of what the session may reach (§9.2). Listing the
    // others would be an inventory leak with no route behind it.
    const visible = session.tenantId === null ? all : all.filter((t) => t.id === session.tenantId);

    const items = visible
      .map((t) => {
        const current = t.id === session.tenantId;
        return `<li${current ? ' aria-current="true"' : ''}><a href="/admin/t/${esc(t.key)}/">${esc(t.key)}</a> <span>${esc(t.mode)}</span>${current ? ' <span>(current)</span>' : ''}</li>`;
      })
      .join('\n');

    const who = user === null ? `user ${session.userId}` : `${esc(user.email)} (${esc(user.role)})`;
    const fleet = session.tenantId === null ? 'fleet operator' : 'tenant operator';
    reply
      .type('text/html; charset=utf-8')
      .send(
        page(
          'Skunkworks — tenants',
          `<h1>Tenants</h1>
<p>${who} — ${fleet}</p>
<ul data-role="tenant-switcher">
${items}
</ul>
<p>Sessions are tenant-bound: choosing a tenant changes the URL, never the session (§9.2).</p>`,
        ),
      );
  }

  async #loginRoute(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (req.method === 'GET') {
      reply.type('text/html; charset=utf-8').send(
        page(
          'Skunkworks — sign in',
          `<h1>Sign in</h1>
<form method="post" action="/admin/login" enctype="application/x-www-form-urlencoded">
  <label>Email <input type="email" name="email" autocomplete="username" required></label>
  <label>Password <input type="password" name="password" autocomplete="current-password" required></label>
  <label>TOTP <input type="text" name="totp" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}"></label>
  <button type="submit">Sign in</button>
</form>`,
        ),
      );
      return;
    }
    if (req.method !== 'POST') throw new AppError('SKW_E_PLT_REQUEST_INVALID', 'login is a GET or a POST');
    await this.#login(req, reply);
  }

  async #login(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    // A non-GET with no session cannot carry a session-bound token, but the Origin
    // check still applies: login CSRF is the attack this closes.
    this.#assertOrigin(req);

    const fields = fieldsOf(req.body);
    const email = fields.email;
    const password = fields.password;
    const totp = fields.totp;
    if (email === undefined || password === undefined) {
      throw new AppError('SKW_E_PLT_REQUEST_INVALID', 'email and password are required');
    }

    const atMs = Date.now();
    const result = await this.auth.authenticate({ email, password, totp, atMs });
    if (!result.ok) {
      // E-16: the cause is recorded where an attacker cannot read it, and the
      // wire answers one code and one body for all three.
      this.#audit({
        tenantId: null,
        userId: null,
        label: 'anonymous',
        action: 'admin.login.failed',
        after: { reason: result.reason },
        ip: req.socket.remoteAddress ?? '',
      });
      throw result.error;
    }

    // The tenant is the row's, never a URL segment (D29). A tenant that is not
    // serving is the same "no tenant here" a suspended tenant gets everywhere
    // (§5.3 row 9), and it refuses the login rather than minting a dead session.
    const tenantId = result.user.tenantId;
    let tenant: Tenant | undefined;
    if (tenantId !== null) {
      tenant = this.#tenants.lookupId(tenantId);
      if (tenant === undefined || tenant.status !== 'active') {
        throw new AppError('SKW_E_PLT_TENANT_UNKNOWN', 'no tenant here');
      }
    }

    const session = this.sessions.create({
      userId: result.user.id,
      tenantId,
      ip: req.socket.remoteAddress ?? '',
      ua: header(req, 'user-agent') ?? '',
      atMs,
      idleMs: this.#idleMs,
    });
    this.#audit({
      tenantId,
      userId: result.user.id,
      label: result.user.email,
      action: 'admin.login',
      targetKind: 'session',
      targetId: session.id,
      ip: req.socket.remoteAddress ?? '',
    });
    reply.header('set-cookie', this.sessions.cookieHeader(this.sessions.sign(session.id)));
    reply.send({
      ok: true,
      tenant: tenant === undefined ? null : { key: tenant.key, mode: tenant.mode },
      user: { email: result.user.email, role: result.user.role },
      csrfToken: this.sessions.csrfToken(session),
      expiresAt: session.expiresAt,
      totpRequired: this.auth.totpRequired,
    });
  }

  /**
   * E-19's `reset_token_hash` / `reset_expires_at`, consumed. No session: the
   * whole point is that the operator cannot authenticate. The Origin check still
   * applies, and the token is single-use, hashed at rest, and 30 minutes long.
   */
  async #passwordReset(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    this.#assertOrigin(req);
    const fields = fieldsOf(req.body);
    const token = fields.token;
    const password = fields.new_password ?? fields.password;
    if (token === undefined || password === undefined) {
      throw new AppError('SKW_E_PLT_REQUEST_INVALID', 'token and new_password are required');
    }
    if ([...password].length < PASSWORD_MIN_LENGTH) {
      throw new AppError('SKW_E_PLT_REQUEST_INVALID', `a password is at least ${PASSWORD_MIN_LENGTH} characters`);
    }

    const atMs = Date.now();
    const row = this.#resetRow(token);
    if (row === null || Date.parse(row.reset_expires_at) <= atMs) {
      // An unknown, spent or expired token is one answer. Nothing is written.
      throw new AppError('SKW_E_PLT_REQUEST_INVALID', 'the reset token is not valid');
    }

    const hash = await this.auth.hashPassword(password);
    const db = openAdminWrite(this.#controlPath, this.#env.dbBusyTimeoutMs);
    try {
      const tx = db.transaction(() => {
        const changed = db
          .prepare(
            `UPDATE user_account
                SET password_hash = ?, reset_token_hash = NULL, reset_expires_at = NULL,
                    must_change = 0, failed_logins = 0, locked_until = NULL
              WHERE id = ? AND reset_token_hash IS NOT NULL`,
          )
          .run(hash, row.id);
        if (changed.changes !== 1) return false;
        // Every live session of the account dies: a password change is the one
        // moment a stolen cookie must stop working, and rotation is the mechanism
        // §9.1 already names for a privilege change.
        db.prepare('UPDATE session SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(
          new Date(atMs).toISOString(),
          row.id,
        );
        return true;
      });
      if (!tx()) throw new AppError('SKW_E_PLT_REQUEST_INVALID', 'the reset token is not valid');
    } finally {
      db.close();
    }

    this.#audit({
      tenantId: row.tenant_id,
      userId: row.id,
      label: row.email,
      action: 'admin.password.reset',
      targetKind: 'user_account',
      targetId: String(row.id),
      ip: req.socket.remoteAddress ?? '',
    });
    reply.header('set-cookie', this.sessions.clearCookieHeader());
    reply.send({ ok: true, sessionsRevoked: true });
  }

  // --- tenant-scoped routes ----------------------------------------------

  async #tenantRoute(req: FastifyRequest, reply: FastifyReply, tenant: Tenant, action: string): Promise<void> {
    if (action === '') {
      this.#requireMethod(req, 'GET');
      const session = this.#requireSession(req);
      this.#assertTenantMatches(session, tenant);
      this.#tenantHome(reply, tenant, session);
      return;
    }

    if (action === 'login') {
      // D29: there is exactly one login URL, and it is not tenant-scoped. A
      // per-tenant login would select a tenant from the URL — the second source
      // of truth §9.2 forbids — so this path is the row-7 404 like any other.
      throw new AppError('SKW_E_PLT_TENANT_UNKNOWN', 'no admin route at this path');
    }

    const session = this.#requireSession(req);
    this.#assertTenantMatches(session, tenant);

    if (action === 'session' && req.method === 'GET') {
      this.#sessionInfo(reply, session, tenant);
      return;
    }
    if (action === 'session/rotate' && req.method === 'POST') {
      this.#assertOrigin(req);
      this.#assertCsrf(req, session);
      this.#rotate(req, reply, session);
      return;
    }
    if (action === 'logout' && req.method === 'POST') {
      this.#assertOrigin(req);
      this.#assertCsrf(req, session);
      this.sessions.revoke(session.id, Date.now());
      reply.header('set-cookie', this.sessions.clearCookieHeader());
      reply.send({ ok: true });
      return;
    }
    if (action === 'totp/enrol' && req.method === 'POST') {
      this.#assertOrigin(req);
      this.#assertCsrf(req, session);
      this.#totpEnrol(reply, session, tenant);
      return;
    }
    if (action === 'totp/confirm' && req.method === 'POST') {
      this.#assertOrigin(req);
      this.#assertCsrf(req, session);
      await this.#totpConfirm(req, reply, session, tenant);
      return;
    }
    if (action === 'password/reset-request' && req.method === 'POST') {
      this.#assertOrigin(req);
      this.#assertCsrf(req, session);
      await this.#resetRequest(req, reply, session, tenant);
      return;
    }
    if (action === 'pages' && req.method === 'GET') {
      this.#pagesList(reply, tenant);
      return;
    }
    if (action.startsWith('pages/') && req.method === 'GET') {
      const id = action.slice('pages/'.length);
      if (!PAGE_ID_RE.test(id)) throw new AppError('SKW_E_PLT_REQUEST_INVALID', 'not a page id');
      this.#pageDetail(reply, tenant, Number(id));
      return;
    }
    throw new AppError('SKW_E_PLT_REQUEST_INVALID', 'no such admin action');
  }

  #tenantHome(reply: FastifyReply, tenant: Tenant, session: SessionRecord): void {
    const user = this.auth.userById(session.userId);
    const who = user === null ? `user ${session.userId}` : `${esc(user.email)} (${esc(user.role)})`;
    reply.type('text/html; charset=utf-8').send(
      page(
        `Skunkworks — ${tenant.key}`,
        `<h1>${esc(tenant.key)}</h1>
<p>${who}</p>
<nav>
  <a href="/admin">All tenants</a>
  <a href="/admin/t/${esc(tenant.key)}/pages">Pages</a>
  <a href="/admin/t/${esc(tenant.key)}/session">Session</a>
</nav>`,
      ),
    );
  }

  // --- session scoping ---------------------------------------------------

  #requireMethod(req: FastifyRequest, method: string): void {
    if (req.method !== method) throw new AppError('SKW_E_PLT_REQUEST_INVALID', `${method} is the method here`);
  }

  #requireSession(req: FastifyRequest): SessionRecord {
    const session = this.sessionFor(header(req, 'cookie'));
    if (session === null) {
      // Row 7: no session on the admin listener is "no tenant here".
      throw new AppError('SKW_E_PLT_TENANT_UNKNOWN', 'no session');
    }
    return session;
  }

  #assertTenantMatches(session: SessionRecord, tenant: Tenant): void {
    // §9.2: the URL is the authority and the session's tenant is the only source.
    // A key that is not the session's tenant must not resolve — that mismatch is
    // the cross-tenant write the rule exists to prevent. A fleet session has no
    // tenant, so every tenant URL is refused for it, which is the true statement.
    if (session.tenantId === null || session.tenantId !== tenant.id) {
      throw new AppError('SKW_E_PLT_TENANT_UNKNOWN', 'no tenant here');
    }
  }

  // --- CSRF --------------------------------------------------------------

  #assertOrigin(req: FastifyRequest): void {
    const origin = header(req, 'origin');
    if (origin === undefined || origin !== this.#env.adminOrigin) {
      throw new AppError('SKW_E_SEC_CSRF', 'origin does not match SKW_ADMIN_ORIGIN');
    }
  }

  #assertCsrf(req: FastifyRequest, session: SessionRecord): void {
    if (!this.sessions.verifyCsrf(session, header(req, CSRF_HEADER) ?? null)) {
      throw new AppError('SKW_E_SEC_CSRF', 'missing or invalid CSRF token');
    }
  }

  // --- E-19: enrolment for a second operator -----------------------------

  #totpEnrol(reply: FastifyReply, session: SessionRecord, tenant: Tenant): void {
    const user = this.auth.userById(session.userId);
    if (user === null || user.tenantId !== tenant.id) {
      throw new AppError('SKW_E_PLT_TENANT_UNKNOWN', 'no session');
    }
    const secret = newSecret();
    this.#pendingTotp.set(session.id, { secret, expiresAt: Date.now() + ENROLMENT_TTL_MS });
    this.#audit({
      tenantId: tenant.id,
      userId: session.userId,
      label: user.email,
      action: 'admin.totp.enrol',
      targetKind: 'user_account',
      targetId: String(session.userId),
      ip: '',
    });
    // The secret is in this response once and is not written to the row until a
    // code proves an authenticator holds it.
    reply.send({ ok: true, secret, otpauthUri: otpauthUri(user.email, secret), groups: groupOf(secret) });
  }

  async #totpConfirm(req: FastifyRequest, reply: FastifyReply, session: SessionRecord, tenant: Tenant): Promise<void> {
    const pending = this.#pendingTotp.get(session.id);
    if (pending === undefined || pending.expiresAt <= Date.now()) {
      this.#pendingTotp.delete(session.id);
      throw new AppError('SKW_E_PLT_REQUEST_INVALID', 'no enrolment is pending for this session');
    }
    const fields = fieldsOf(req.body);
    const code = fields.code ?? '';
    if (!verifyTotp(pending.secret, code, Date.now())) {
      throw new AppError('SKW_E_SEC_AUTH_INVALID', 'invalid credentials');
    }
    const user = this.auth.userById(session.userId);
    if (user === null) throw new AppError('SKW_E_PLT_TENANT_UNKNOWN', 'no session');

    const db = openAdminWrite(this.#controlPath, this.#env.dbBusyTimeoutMs);
    try {
      db.prepare('UPDATE user_account SET totp_secret = ? WHERE id = ?').run(pending.secret, session.userId);
    } finally {
      db.close();
    }
    this.#pendingTotp.delete(session.id);
    this.#audit({
      tenantId: tenant.id,
      userId: session.userId,
      label: user.email,
      action: 'admin.totp.confirm',
      targetKind: 'user_account',
      targetId: String(session.userId),
      ip: req.socket.remoteAddress ?? '',
    });
    // A second factor is a credential change: the session that performed it is
    // rotated (§9.1), so the cookie that existed before the secret did is dead.
    this.#rotate(req, reply, session);
  }

  // --- E-19: password reset, issued --------------------------------------

  async #resetRequest(req: FastifyRequest, reply: FastifyReply, session: SessionRecord, tenant: Tenant): Promise<void> {
    const user = this.auth.userById(session.userId);
    if (user === null || user.tenantId !== tenant.id) {
      throw new AppError('SKW_E_PLT_TENANT_UNKNOWN', 'no session');
    }
    const token = newToken();
    const expiresAt = new Date(Date.now() + RESET_TTL_MS).toISOString();
    const db = openAdminWrite(this.#controlPath, this.#env.dbBusyTimeoutMs);
    try {
      db.prepare('UPDATE user_account SET reset_token_hash = ?, reset_expires_at = ? WHERE id = ?').run(
        sha256Hex(token),
        expiresAt,
        session.userId,
      );
    } finally {
      db.close();
    }
    this.#audit({
      tenantId: tenant.id,
      userId: session.userId,
      label: user.email,
      action: 'admin.password.reset_requested',
      targetKind: 'user_account',
      targetId: String(session.userId),
      ip: req.socket.remoteAddress ?? '',
    });
    // Delivery: every bundle runs with SKW_EMAIL_MODE=off, so there is no channel
    // to mail a link through. The token is returned to the already-authenticated
    // operator over TLS on the admin host — that is the no-email channel, and it is
    // the only one. With smtp configured it would be mailed instead and this field
    // would be absent; v1 has no mailer (reported gap).
    reply.send({ ok: true, token, expiresAt, resetPath: '/admin/password/reset' });
  }

  // --- §9.3: the first CRUD read path, on the render-read class -----------

  #pagesList(reply: FastifyReply, tenant: Tenant): void {
    const db = this.#siteDb(tenant.key);
    try {
      const rows = db
        .prepare(
          `SELECT id, path, slug, title, status, template, rev, updated_at
             FROM cms_page ORDER BY path LIMIT 200`,
        )
        .all() as Record<string, unknown>[];
      reply.send({ tenant: tenant.key, pages: rows });
    } finally {
      db.close();
    }
  }

  #pageDetail(reply: FastifyReply, tenant: Tenant, id: number): void {
    const db = this.#siteDb(tenant.key);
    try {
      const row = db
        .prepare(
          `SELECT id, path, slug, title, status, template, body_html, body_css, rev, body_sha,
                  managed_by, seo_json, published_at, created_at, updated_at
             FROM cms_page WHERE id = ?`,
        )
        .get(id) as Record<string, unknown> | undefined;
      if (row === undefined) throw new AppError('SKW_E_RT_PAGE_NOT_FOUND', 'no such page');
      reply.send({ tenant: tenant.key, page: row });
    } finally {
      db.close();
    }
  }

  /** §2.2's `render-read`: readonly, `query_only=1`, never write-capable. */
  #siteDb(key: string): Database.Database {
    const file = join(this.#env.dataDir, 'tenants', key, 'site.db');
    try {
      return openRenderRead(file, this.#env.dbBusyTimeoutMs);
    } catch {
      throw new AppError('SKW_E_PLT_TENANT_UNAVAILABLE', 'tenant database is not readable');
    }
  }

  // --- session answers ---------------------------------------------------

  #sessionInfo(reply: FastifyReply, session: SessionRecord, tenant: Tenant): void {
    const user = this.auth.userById(session.userId);
    reply.send({
      tenant: { key: tenant.key, mode: tenant.mode },
      user: user === null ? { id: session.userId } : { id: user.id, email: user.email, role: user.role },
      csrfToken: this.sessions.csrfToken(session),
      expiresAt: session.expiresAt,
      createdAt: session.createdAt,
    });
  }

  #rotate(req: FastifyRequest, reply: FastifyReply, session: SessionRecord): void {
    const rotated = this.sessions.rotate(session.id, {
      ip: req.socket.remoteAddress ?? '',
      ua: header(req, 'user-agent') ?? '',
      atMs: Date.now(),
      idleMs: this.#idleMs,
    });
    if (rotated === null) {
      // The row vanished or expired between the read and the rotation.
      throw new AppError('SKW_E_PLT_TENANT_UNKNOWN', 'no session');
    }
    reply.header('set-cookie', this.sessions.cookieHeader(this.sessions.sign(rotated.id)));
    reply.send({
      ok: true,
      csrfToken: this.sessions.csrfToken(rotated),
      expiresAt: rotated.expiresAt,
      rotatedFrom: rotated.rotatedFrom,
    });
  }

  // --- reset token lookup ------------------------------------------------

  #resetRow(token: string): { id: number; tenant_id: number | null; email: string; reset_expires_at: string } | null {
    const db = openAdminWrite(this.#controlPath, this.#env.dbBusyTimeoutMs);
    try {
      const row = db
        .prepare(
          `SELECT id, tenant_id, email, reset_expires_at FROM user_account
            WHERE reset_token_hash = ? AND reset_expires_at IS NOT NULL`,
        )
        .get(sha256Hex(token)) as
        | { id: number; tenant_id: number | null; email: string; reset_expires_at: string }
        | undefined;
      return row ?? null;
    } finally {
      db.close();
    }
  }

  // --- audit (§9.6's control-plane table) --------------------------------

  #audit(input: {
    tenantId: number | null;
    userId: number | null;
    label: string;
    action: string;
    targetKind?: string;
    targetId?: string;
    after?: unknown;
    ip: string;
  }): void {
    const db = openAdminWrite(this.#controlPath, this.#env.dbBusyTimeoutMs);
    try {
      db.prepare(
        `INSERT INTO audit_log (tenant_id, actor_user_id, actor_label, action, target_kind, target_id, after_json, ip_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.tenantId,
        input.userId,
        input.label,
        input.action,
        input.targetKind ?? null,
        input.targetId ?? null,
        input.after === undefined ? null : JSON.stringify(input.after),
        input.ip === '' ? null : this.sessions.ipHash(input.ip),
      );
    } finally {
      db.close();
    }
  }
}

// --- E-19's token material ------------------------------------------------

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export type { LoginFailureReason };
