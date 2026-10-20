/**
 * The admin surface — SDS §9 in the subset S2a owns: session, login/logout,
 * rotation, CSRF and the `/admin/t/<key>/…` namespace.
 *
 * Rules this file implements, each cited:
 *
 *  - **§9.1 rule 1** — the surface exists only when `listener = 'admin'`. On any
 *    other Host this handler does not parse a cookie and does not answer: it
 *    hands the request to the same page-miss path `setNotFoundHandler` uses, so
 *    `/admin/...` on a tenant host stays byte-identical to any unmatched path.
 *  - **§5.3 row 1** — the admin listener refuses a tenant header that is present
 *    at all, before any route runs.
 *  - **§5.3 row 2** — an untrusted peer may not assert any `X-Skunkworks-*` header.
 *  - **§5.3 row 7** — a tenant-scoped admin request with no session is
 *    `404 SKW_E_PLT_TENANT_UNKNOWN`, never `401` or `403`: the admin host maps to
 *    no tenant, so "there is no tenant here" is the true statement and the only
 *    one that is not an oracle.
 *  - **§9.2** — every admin URL is `/admin/t/<key>/…`; the tenant comes from
 *    `session.tenant_id` and the URL key must equal that tenant's key.
 *  - **§9.1 CSRF** — every non-GET carries a session-bound token *and* an exact
 *    `Origin` match against `SKW_ADMIN_ORIGIN`.
 *
 * Order of checks on a tenant-scoped route: listener → row 1 → row 2 → session
 * (404) → tenant (404) → Origin (403) → CSRF token (403) → the route. The
 * session precedes the CSRF check deliberately: a request with no session has no
 * token to bind and is the row-7 404, not a 403 — otherwise an unauthenticated
 * caller could tell `/admin/t/acme/...` from `/admin/t/nope/...` by status alone.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';

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
import { Auth, Semaphore } from './auth.ts';
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
const ROUTE_RE = /^\/admin\/t\/([^/]+)\/(login|logout|session|session\/rotate)$/;

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

export class AdminSurface {
  readonly sessions: SessionStore;
  readonly auth: Auth;
  readonly #env: Env;
  readonly #tenants: TenantMap;
  readonly #adminHost: string | null;
  readonly #allowlist: string[];
  readonly #idleMs: number;

  constructor(opts: AdminOptions) {
    this.#env = opts.env;
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

    const pathname = pathnameOf(req.url);
    const route = ROUTE_RE.exec(pathname);
    if (route === null) {
      // §9.2: every admin URL is /admin/t/<key>/…; anything else under the admin
      // host is the same "no tenant here" 404 as an unknown path.
      throw new AppError('SKW_E_PLT_TENANT_UNKNOWN', 'no admin route at this path');
    }
    const key = route[1] as string;
    const action = route[2] as string;
    if (!KEY_RE.test(key)) throw new AppError('SKW_E_PLT_TENANT_UNKNOWN', 'no admin route at this path');

    const tenant = this.#tenants.lookupKey(key);
    if (tenant === undefined || tenant.status !== 'active') {
      throw new AppError('SKW_E_PLT_TENANT_UNKNOWN', 'no tenant here');
    }

    reply.header('cache-control', 'no-store');

    if (action === 'login') {
      if (req.method !== 'POST') throw new AppError('SKW_E_PLT_REQUEST_INVALID', 'login is a POST');
      await this.#login(req, reply, tenant);
      return;
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
    throw new AppError('SKW_E_PLT_REQUEST_INVALID', 'method not allowed on this admin route');
  }

  // --- session scoping ---------------------------------------------------

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
    // the cross-tenant write the rule exists to prevent.
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

  // --- routes ------------------------------------------------------------

  async #login(req: FastifyRequest, reply: FastifyReply, tenant: Tenant): Promise<void> {
    // A non-GET with no session cannot carry a session-bound token, but the
    // Origin check still applies: login CSRF is the attack this closes.
    this.#assertOrigin(req);

    const body = req.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new AppError('SKW_E_PLT_REQUEST_INVALID', 'a JSON object body is required');
    }
    const fields = body as Record<string, unknown>;
    const email = fields.email;
    const password = fields.password;
    const totp = fields.totp;
    if (typeof email !== 'string' || typeof password !== 'string') {
      throw new AppError('SKW_E_PLT_REQUEST_INVALID', 'email and password are required strings');
    }
    if (totp !== undefined && typeof totp !== 'string') {
      throw new AppError('SKW_E_PLT_REQUEST_INVALID', 'totp must be a string when present');
    }

    const atMs = Date.now();
    const result = await this.auth.authenticate({
      tenantId: tenant.id,
      email,
      password,
      totp,
      atMs,
    });
    if (!result.ok) throw result.error;

    const session = this.sessions.create({
      userId: result.user.id,
      tenantId: result.user.tenantId,
      ip: req.socket.remoteAddress ?? '',
      ua: header(req, 'user-agent') ?? '',
      atMs,
      idleMs: this.#idleMs,
    });
    reply.header('set-cookie', this.sessions.cookieHeader(this.sessions.sign(session.id)));
    reply.send({
      ok: true,
      tenant: { key: tenant.key, mode: tenant.mode },
      user: { email: result.user.email, role: result.user.role },
      csrfToken: this.sessions.csrfToken(session),
      expiresAt: session.expiresAt,
      totpRequired: this.auth.totpRequired,
    });
  }

  #sessionInfo(reply: FastifyReply, session: SessionRecord, tenant: Tenant): void {
    const user = this.auth.userById(session.userId);
    reply.send({
      tenant: { key: tenant.key, mode: tenant.mode },
      user: user === null ? { id: session.userId } : { id: user.id, email: user.email, role: user.role },
      csrfToken: this.sessions.csrfToken(session),
      expiresAt: session.expiresAt,
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
}
