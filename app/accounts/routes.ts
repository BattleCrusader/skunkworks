/**
 * The portal's HTTP surface — the transport around `Accounts`, and nothing else.
 *
 * Server-rendered, no JavaScript, like the admin: a form that posts and a page that answers. The
 * three rules every POST here obeys, in this order, because each one closes a different hole:
 *
 *   1. **Origin.** `Origin` must equal `https://<Host>`; a cleartext `X-Forwarded-Proto` is refused
 *      by name. A cookie is sent by the browser on a cross-site form post; this header is what makes
 *      that post useless to an attacker. `SameSite=Strict` on the cookie is the second lock on the
 *      same door, not a substitute for the first.
 *   2. **CSRF.** A signed-in POST carries the session's own `csrf_secret` in a body field or the
 *      `X-CSRF-Token` header. Registration and sign-in have no session to bind to, so they rely on
 *      origin + rate limiting — and they cannot do anything a stranger could not do anyway.
 *   3. **Tenant.** The cookie is named for the tenant (`__Secure-sk-portal-<key>`) and the path is
 *      `/portal`, so a cookie minted on one host is not even sent to another, and the row it names
 *      lives in that tenant's own `site.db`. The name is the check, not a comment about one.
 *
 * The enrolment cookie is the one piece of state that exists between "address proved" and "TOTP
 * confirmed": the person is not signed in yet, but they must be able to submit a code. It carries
 * the account id and an HMAC over it under `env.sessionKey`, lives 30 minutes, and is worth nothing
 * without a valid code — the code is still the second factor.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { CSRF_HEADER, cookieAttrs, cookieValue } from '../admin/session.ts';
import { escapeHtml } from '../admin/ui/html.ts';
import { normaliseHost } from '../tenancy/normalise-host.ts';
import { AppError } from '../errors.ts';
import type { Env } from '../env.ts';
import type { Accounts, Role, SelfView } from './service.ts';
import { PASSWORD_MIN } from './service.ts';

/** 30 minutes to finish a sign-up after clicking the link. */
export const ENROL_TTL_S = 30 * 60;

export function portalCookieName(tenantKey: string): string {
  return `__Secure-sk-portal-${tenantKey}`;
}

export function enrolCookieName(tenantKey: string): string {
  return `__Secure-sk-enrol-${tenantKey}`;
}

export const PORTAL_COOKIE_PATH = '/portal';

export interface PortalDeps {
  accounts: Accounts;
  env: Env;
  /**
   * The tenant this request belongs to, resolved from the Host by the caller (`resolveRequest`).
   * Passed as a function rather than a value so the router never invents a tenant of its own.
   */
  tenantOf(req: FastifyRequest): string;
  /** Off when real SMTP is configured; on offline, so the page can show the operator's link. */
  exposeVerifyLink?: boolean;
}

/**
 * A body, as fields. The app's urlencoded parser hands this route the raw string (the same choice
 * the admin login makes — no extra dependency), while a JSON client hands an object, and a browser
 * with two checked boxes hands the same key twice. All three are read here, once.
 */
type Fields = Record<string, string[]>;

function fieldsOf(body: unknown): Fields {
  const out: Record<string, string[]> = {};
  const push = (key: string, value: string): void => {
    (out[key] ??= []).push(value);
  };
  if (typeof body === 'string') {
    for (const [key, value] of new URLSearchParams(body)) push(key, value);
    return out;
  }
  if (typeof body !== 'object' || body === null) return out;
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (typeof value === 'string') push(key, value);
    else if (Array.isArray(value)) for (const item of value) if (typeof item === 'string') push(key, item);
  }
  return out;
}

/** The first value of a field, or `''`. A single-valued field is the only kind most routes read. */
function field(fields: Fields, name: string): string {
  return fields[name]?.[0] ?? '';
}

function header(req: FastifyRequest, name: string): string | undefined {
  const raw = req.headers[name];
  return typeof raw === 'string' ? raw : undefined;
}

/** The page shell. `theme.css` is the site's own stylesheet and is allowed by `style-src 'self'`. */
function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="/theme.css">
</head>
<body class="portal">
<main class="portal-main">
${body}
</main>
</body></html>`;
}

class Portal {
  readonly #deps: PortalDeps;

  constructor(deps: PortalDeps) {
    this.#deps = deps;
  }

  #tenant(req: FastifyRequest): string {
    return this.#deps.tenantOf(req);
  }

  #ip(req: FastifyRequest): string {
    return req.socket.remoteAddress ?? '';
  }

  /**
   * Origin first, then CSRF when there is a session. Both refusals are the same code, because the
   * difference between them is the attacker's business and not the browser's.
   */
  #assertOrigin(req: FastifyRequest): void {
    const proto = header(req, 'x-forwarded-proto');
    if (proto !== undefined && proto.toLowerCase() !== 'https') {
      throw new AppError('SKW_E_SEC_CSRF', `the portal requires https: this request arrived over ${proto}`);
    }
    const origin = header(req, 'origin');
    const host = normaliseHost(req.headers.host ?? null);
    const expected = host === null ? null : `https://${host}`;
    if (origin === undefined || expected === null || origin !== expected) {
      throw new AppError('SKW_E_SEC_CSRF', 'origin does not match the host this request was sent to');
    }
  }

  #assertCsrf(req: FastifyRequest, csrf: string | null): void {
    if (csrf === null) throw new AppError('SKW_E_SEC_CSRF', 'not signed in');
    const submitted = header(req, CSRF_HEADER) ?? field(fieldsOf(req.body), 'csrf');
    if (submitted === undefined || submitted.length !== csrf.length) {
      throw new AppError('SKW_E_SEC_CSRF', 'missing or wrong csrf token');
    }
    if (!timingSafeEqual(Buffer.from(submitted), Buffer.from(csrf))) {
      throw new AppError('SKW_E_SEC_CSRF', 'missing or wrong csrf token');
    }
  }

  /** The session token from the per-tenant cookie, or `null`. */
  #sessionToken(req: FastifyRequest, tenantKey: string): string | null {
    return cookieValue(header(req, 'cookie'), portalCookieName(tenantKey));
  }

  #view(req: FastifyRequest, tenantKey: string): SelfView | null {
    const token = this.#sessionToken(req, tenantKey);
    return token === null ? null : this.#deps.accounts.authenticate(token, tenantKey, { ip: this.#ip(req) });
  }

  #setSession(reply: FastifyReply, tenantKey: string, session: { id: string; expiresAt: number }): void {
    const maxAge = Math.max(0, Math.floor((session.expiresAt - Date.now()) / 1000));
    reply.header(
      'set-cookie',
      `${portalCookieName(tenantKey)}=${session.id}; ${cookieAttrs(PORTAL_COOKIE_PATH)}; Max-Age=${maxAge}`,
    );
  }

  #clearSession(reply: FastifyReply, tenantKey: string): void {
    reply.header('set-cookie', `${portalCookieName(tenantKey)}=; ${cookieAttrs(PORTAL_COOKIE_PATH)}; Max-Age=0`);
  }

  #enrolSignature(accountId: number): string {
    return createHmac('sha256', this.#deps.env.sessionKey)
      .update(`enrol:${accountId}`)
      .digest('base64url');
  }

  #setEnrol(reply: FastifyReply, tenantKey: string, accountId: number): void {
    const value = `${accountId}.${this.#enrolSignature(accountId)}`;
    reply.header(
      'set-cookie',
      `${enrolCookieName(tenantKey)}=${value}; ${cookieAttrs(PORTAL_COOKIE_PATH)}; Max-Age=${ENROL_TTL_S}`,
    );
  }

  #enrolAccount(req: FastifyRequest, tenantKey: string): number | null {
    const raw = cookieValue(header(req, 'cookie'), enrolCookieName(tenantKey));
    if (raw === null) return null;
    const dot = raw.indexOf('.');
    if (dot <= 0) return null;
    const id = Number(raw.slice(0, dot));
    const signature = raw.slice(dot + 1);
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    const expected = this.#enrolSignature(id);
    if (signature.length !== expected.length) return null;
    if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
    return id;
  }

  register(app: FastifyInstance): void {
    app.get('/portal', async (req: FastifyRequest, reply: FastifyReply) => {
      const tenantKey = this.#tenant(req);
      const view = this.#view(req, tenantKey);
      if (view === null) {
        reply.code(303).header('location', '/portal/signin').send();
        return;
      }
      const token = this.#sessionToken(req, tenantKey) ?? '';
      const csrf = this.#deps.accounts.csrfFor(token, tenantKey, { ip: this.#ip(req) }) ?? '';
      reply
        .code(200)
        .type('text/html; charset=utf-8')
        .header('cache-control', 'no-store')
        .send(
          page(
            'Your account',
            `<h1>Your account</h1>
<p>Signed in as <strong>${escapeHtml(view.email)}</strong>.</p>
<p>Account type: ${view.roles.map((r) => `<span class="role">${escapeHtml(r)}</span>`).join(', ')}</p>
${view.roles.includes('applicant') ? '<p><a href="/portal/applicant">Your applications and profile</a></p>' : ''}
${view.roles.includes('advertiser') ? '<p><a href="/portal/advertiser">Your company and adverts</a></p>' : ''}
<form method="post" action="/portal/signout">
  <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
  <button type="submit">Sign out</button>
</form>`,
          ),
        );
    });

    app.get('/portal/register', async (req: FastifyRequest, reply: FastifyReply) => {
      reply
        .code(200)
        .type('text/html; charset=utf-8')
        .header('cache-control', 'no-store')
        .send(
          page(
            'Create an account',
            `<h1>Create an account</h1>
<form method="post" action="/portal/register">
  <p><label for="email">Email</label>
     <input id="email" name="email" type="email" autocomplete="email" required></p>
  <p><label for="display">Name shown on your profile</label>
     <input id="display" name="display_name" autocomplete="name" maxlength="120" required></p>
  <p><label for="password">Password (at least ${PASSWORD_MIN} characters)</label>
     <input id="password" name="password" type="password" autocomplete="new-password" minlength="${PASSWORD_MIN}" required></p>
  <fieldset>
    <legend>What do you want to do?</legend>
    <label><input type="checkbox" name="role" value="applicant"> Find fractional work</label>
    <label><input type="checkbox" name="role" value="advertiser"> Advertise a role</label>
  </fieldset>
  <button type="submit">Create account</button>
</form>
<p>Already have one? <a href="/portal/signin">Sign in</a>.</p>`,
          ),
        );
    });

    app.post('/portal/register', async (req: FastifyRequest, reply: FastifyReply) => {
      this.#assertOrigin(req);
      const tenantKey = this.#tenant(req);
      const fields = fieldsOf(req.body);
      const email = field(fields, 'email');
      const password = field(fields, 'password');
      const displayName = field(fields, 'display_name').trim();
      const roles = (fields.role ?? []).filter((r): r is Role => r === 'applicant' || r === 'advertiser');

      const result = await this.#deps.accounts.register(
        { email, password, displayName, roles },
        tenantKey,
        { ip: this.#ip(req) },
      );

      if (result.kind === 'exists') {
        reply
          .code(200)
          .type('text/html; charset=utf-8')
          .header('cache-control', 'no-store')
          .send(
            page(
              'Check your email',
              `<h1>That address already has an account</h1>
<p>We have emailed ${escapeHtml(email)} a reminder of how to get in. If it does not arrive, sign in and use “forgot password”.</p>
<p><a href="/portal/signin">Sign in</a></p>`,
            ),
          );
        return;
      }

      // The secret is shown exactly once, here. There is no second chance to see it, and the
      // account cannot become active until a code from it has been entered.
      const link =
        result.verifyUrl === undefined
          ? '<p>We have emailed you a link to confirm your address.</p>'
          : `<p>Confirm your address: <a href="${escapeHtml(result.verifyUrl)}">${escapeHtml(result.verifyUrl)}</a></p>`;
      reply
        .code(200)
        .type('text/html; charset=utf-8')
        .header('cache-control', 'no-store')
        .send(
          page(
            'Set up your authenticator',
            `<h1>Set up your authenticator</h1>
<p>Add this account to an authenticator app (1Password, Authy, Google Authenticator). Type the key in by hand if you cannot scan.</p>
<p class="totp-secret"><code>${escapeHtml(result.totpGrouped)}</code></p>
<p><a href="${escapeHtml(result.otpauthUri)}">Open in your authenticator app</a></p>
${link}
<p>Your account stays inactive until you have confirmed the email and entered a code from the app.</p>`,
          ),
        );
    });

    app.get('/portal/verify', async (req: FastifyRequest, reply: FastifyReply) => {
      const tenantKey = this.#tenant(req);
      const token = String((req.query as { token?: unknown }).token ?? '');
      const outcome = token === '' ? ({ ok: false, reason: 'unknown' } as const) : this.#deps.accounts.verifyEmail(token, tenantKey);
      if (outcome.ok === false) {
        const why =
          outcome.reason === 'expired'
            ? 'That link has expired. Sign in and ask for a new one.'
            : outcome.reason === 'consumed'
              ? 'That link has already been used.'
              : 'That link is not valid.';
        reply
          .code(400)
          .type('text/html; charset=utf-8')
          .header('cache-control', 'no-store')
          .send(page('Link not valid', `<h1>Link not valid</h1><p>${escapeHtml(why)}</p>`));
        return;
      }
      if (outcome.next === 'active') {
        this.#clearEnrol(reply, tenantKey);
        reply
          .code(200)
          .type('text/html; charset=utf-8')
          .header('cache-control', 'no-store')
          .send(page('Address confirmed', `<h1>Address confirmed</h1><p><a href="/portal/signin">Sign in</a></p>`));
        return;
      }
      // Address proved, TOTP still owed: the person is not signed in, and the enrolment cookie is
      // what lets them submit the code without pretending to be.
      this.#setEnrol(reply, tenantKey, outcome.accountId);
      reply
        .code(200)
        .type('text/html; charset=utf-8')
        .header('cache-control', 'no-store')
        .send(
          page(
            'Enter a code',
            `<h1>One more step</h1>
<p>Enter the six-digit code from your authenticator app.</p>
<form method="post" action="/portal/enrol">
  <p><label for="code">Code</label>
     <input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required></p>
  <button type="submit">Confirm</button>
</form>`,
          ),
        );
    });

    app.post('/portal/enrol', async (req: FastifyRequest, reply: FastifyReply) => {
      this.#assertOrigin(req);
      const tenantKey = this.#tenant(req);
      const accountId = this.#enrolAccount(req, tenantKey);
      if (accountId === null) {
        throw new AppError('SKW_E_SEC_TOKEN_INVALID', 'start again from the link in your email');
      }
      const code = field(fieldsOf(req.body), 'code');
      const result = this.#deps.accounts.confirmTotp(accountId, code, tenantKey);
      if (!result.ok) {
        reply
          .code(401)
          .type('text/html; charset=utf-8')
          .header('cache-control', 'no-store')
          .send(
            page(
              'Wrong code',
              `<h1>That code is not right</h1>
<form method="post" action="/portal/enrol">
  <p><label for="code">Code</label>
     <input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required></p>
  <button type="submit">Try again</button>
</form>`,
            ),
          );
        return;
      }
      this.#clearEnrol(reply, tenantKey);
      reply.code(303).header('location', '/portal/signin').send();
    });

    app.get('/portal/signin', async (req: FastifyRequest, reply: FastifyReply) => {
      reply
        .code(200)
        .type('text/html; charset=utf-8')
        .header('cache-control', 'no-store')
        .send(
          page(
            'Sign in',
            `<h1>Sign in</h1>
<form method="post" action="/portal/signin">
  <p><label for="email">Email</label>
     <input id="email" name="email" type="email" autocomplete="email" required></p>
  <p><label for="password">Password</label>
     <input id="password" name="password" type="password" autocomplete="current-password" required></p>
  <p><label for="code">Authenticator code</label>
     <input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required></p>
  <button type="submit">Sign in</button>
</form>
<p><a href="/portal/register">Create an account</a></p>`,
          ),
        );
    });

    app.post('/portal/signin', async (req: FastifyRequest, reply: FastifyReply) => {
      this.#assertOrigin(req);
      const tenantKey = this.#tenant(req);
      const fields = fieldsOf(req.body);
      const result = await this.#deps.accounts.signIn(
        { email: field(fields, 'email'), password: field(fields, 'password'), code: field(fields, 'code') },
        tenantKey,
        { ip: this.#ip(req), userAgent: header(req, 'user-agent') ?? '' },
      );
      if (result.ok === false) {
        // One page and one sentence for every refusal. The resend link is the way back for a person
        // who is pending, and it sends only when there is something to send.
        const message =
          result.reason === 'locked'
            ? 'Too many attempts. Wait a few minutes and try again.'
            : 'That email, password or code is not right.';
        reply
          .code(result.reason === 'locked' ? 429 : 401)
          .type('text/html; charset=utf-8')
          .header('cache-control', 'no-store')
          .send(
            page(
              'Sign in',
              `<h1>Sign in</h1>
<p role="alert">${escapeHtml(message)}</p>
<form method="post" action="/portal/signin">
  <p><label for="email">Email</label>
     <input id="email" name="email" type="email" autocomplete="email" required></p>
  <p><label for="password">Password</label>
     <input id="password" name="password" type="password" autocomplete="current-password" required></p>
  <p><label for="code">Authenticator code</label>
     <input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required></p>
  <button type="submit">Sign in</button>
</form>
<p><a href="/portal/register">Create an account</a></p>`,
            ),
          );
        return;
      }
      this.#setSession(reply, tenantKey, result.session);
      reply.code(303).header('location', '/portal').send();
    });

    app.post('/portal/signout', async (req: FastifyRequest, reply: FastifyReply) => {
      this.#assertOrigin(req);
      const tenantKey = this.#tenant(req);
      const token = this.#sessionToken(req, tenantKey);
      if (token === null) {
        this.#clearSession(reply, tenantKey);
        reply.code(303).header('location', '/portal/signin').send();
        return;
      }
      this.#assertCsrf(req, this.#deps.accounts.csrfFor(token, tenantKey, { ip: this.#ip(req) }));
      this.#deps.accounts.signOut(token, tenantKey);
      this.#clearSession(reply, tenantKey);
      reply.code(303).header('location', '/portal/signin').send();
    });
  }

  #clearEnrol(reply: FastifyReply, tenantKey: string): void {
    reply.header('set-cookie', `${enrolCookieName(tenantKey)}=; ${cookieAttrs(PORTAL_COOKIE_PATH)}; Max-Age=0`);
  }
}

export function registerPortal(app: FastifyInstance, deps: PortalDeps): Portal {
  const portal = new Portal(deps);
  portal.register(app);
  return portal;
}
