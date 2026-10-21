/**
 * The admin surface — **as re-homed by D37**: `/admin` on every tenant host, the
 * fleet console at `/fleet`. SDS §9, errata E-16/E-18/E-19 and the frozen CEO
 * decisions D28, D29 and D30 still govern everything below the routing.
 *
 * Shapes, exactly as D37 leaves them:
 *
 *   GET  /admin                        this Host's tenant admin home (was D29's
 *                                      fleet console; the console is `/fleet` now).
 *   GET|POST /admin/login              the only login URL (D29, kept). The tenant is
 *                                      the Host's; a fleet row signs in here too and
 *                                      gets the `/fleet` cookie.
 *   POST /admin/password/reset         consume a reset token (E-19's columns).
 *   ....  /admin/t/<key>/<action>      every tenant-scoped URL (D29, §9.2), where
 *                                      `<key>` must equal the Host's tenant:
 *                                      `` (home), session, session/rotate, logout,
 *                                      totp/enrol, totp/confirm, password/reset-request,
 *                                      pages, pages/<id>, tables, tables/<table>[/<id>][/delete],
 *                                      builder, builder/preview (S2c).
 *   GET  /fleet                        the fleet console: every active tenant and the
 *                                      host each one is administered on. Fleet session
 *                                      only, any host, 404 for everyone else.
 *   POST /fleet/logout                 end the fleet session.
 *
 * Rules this file implements, each cited:
 *
 *  - **D37 — the tenant comes from `Host`, and only from `Host`.** Not from a header
 *    (a non-empty `X-Skunkworks-Tenant` on an admin path is 421, which is row 1's
 *    rule relocated to the only place where it still means something), not from a
 *    URL segment (`/admin/t/beta/…` on acme's host is 404), not from the session
 *    (`session.tenant_id` must equal the Host's tenant, else 404). §9.2's "one
 *    source of truth" survives the change; only *which* source changed.
 *  - **§5.3 row 2** — an untrusted peer may not assert any `X-Skunkworks-*` header.
 *  - **§5.3 row 7 (as relocated)** — an admin request with no session for this Host's
 *    tenant is `404 SKW_E_PLT_TENANT_UNKNOWN`, never `401` or `403`.
 *  - **§9.2** — `/admin/t/<key>/…`; the key must equal the Host's tenant key.
 *  - **D28** — the CSRF header is `X-CSRF-Token`, one header, and there is no
 *    form-field alternative anywhere in this file (the `csrf` body field that the
 *    no-JS forms carry is a session-bound token, not a substitute header).
 *  - **E-16** — a credential failure is `401 SKW_E_SEC_AUTH_INVALID`, with one body
 *    for all three causes; the cause observed goes to `audit_log`, never the wire.
 *  - **§9.3** — `cms_*` rows are editable through generated forms. The forms carry
 *    the token in `data-csrf-token` and submit through `fetch`, because D28 leaves
 *    no form-field alternative: a no-JS form post is refused `403 SKW_E_SEC_CSRF`
 *    by design, and the page says so in a `<noscript>`.
 *  - **§9.4 / §4.4** — the table builder is a form and a preview of the DDL
 *    `app/ddl/emit.ts` would emit. No executor runs here; `SKW_SCHEMA_EDIT=off`
 *    makes the two paths unknown paths.
 *  - **E-17** — the allowlist is read from `env.adminAllowlist`, the one parser's
 *    output; this file does not enforce it (nginx terminates the connection).
 *  - **D37 — the Origin check is the request's own origin.** `Origin` must equal
 *    `https://` + the normalised `Host`. `SKW_ADMIN_ORIGIN` is no longer the answer
 *    to "what origin may POST here", because there is no single origin any more:
 *    three hosts on one box are three origins, and the honest comparison is the one
 *    the browser already made.
 *  - **D37 — C-25 is gone, and the cookie is what is left.** Tenant-authored HTML and
 *    the admin are now same-origin by decision. `SameSite=Strict` plus the per-host
 *    cookie name plus the session-row tenant check are the three things that keep a
 *    cross-site request and a confused host from being an authenticated one.
 *
 * Order of checks on a tenant-scoped route: Host tenant → row 2 → header refusal →
 * session (404) → tenant match (404) → Origin (403) → CSRF token (403) → the route.
 * The session precedes the CSRF check deliberately: a request with no session has no
 * token to bind and is the 404, not a 403.
 */
import type Database from 'better-sqlite3';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';

import { extOfMime } from '../assets/farm.ts';
import { applyPick, mediaChoices, pickAsset } from '../editor/media.ts';
import { loadRegistry, registryCss } from '../editor/registry.ts';
import { publishPage } from '../editor/publish.ts';
import { loadForEditor, savePage } from '../editor/save.ts';
import {
  EDITOR_BOOT_JS,
  grapesJsBundle,
  grapesJsCss,
  renderEditorPage,
} from './editor.ts';
import { emitCreateTable, registryRow, type CreateTableOp } from '../ddl/emit.ts';
import { normaliseTableName, parseColumnLines } from '../ddl/form.ts';
import { runDdl } from '../ddl/run.ts';
import {
  createRow,
  deleteRow,
  describeTable,
  listTables as listTablesOf,
  listRows,
  selectRow,
  taxonomy,
  updateRow,
  type Actor,
  type TableInfo,
} from './crud.ts';
import { openAdminWrite, openRenderRead } from '../db/classes.ts';
import { actionSite, filterSite, screenHref } from '../plugins/site.ts';
import type { PluginRuntime } from '../plugins/runtime.ts';
import { ensureVariants } from '../assets/renditions.ts';
import { storageQuotaFor, uploadAsset } from '../assets/library.ts';
import { DEFAULT_CONTENT_ROOT, UPLOAD_MAX_BYTES } from '../assets/store.ts';
import { handleCodes } from '../download/adminCodes.ts';
import type { Env } from '../env.ts';
import { AppError } from '../errors.ts';
import { PREVIEW_PARAM, PREVIEW_TTL_MS, mintPreviewToken } from '../render/preview.ts';
import { listSources } from '../sources/registry.ts';
import { publishSource, saveSourceDraft, type SourceInput } from '../sources/publish.ts';
import type { TenantMap } from '../tenancy/cache.ts';
import { normaliseHost } from '../tenancy/normalise-host.ts';
import {
  TENANT_HEADER,
  anySkunkworksHeader,
  peerInCidrs,
  type Tenant,
} from '../tenancy/resolve.ts';
import { Auth, Semaphore, verifyTotp, type LoginFailureReason } from './auth.ts';
import { groupOf, newSecret, otpauthUri } from './totp.ts';
import { accountScreen } from './ui/account.ts';
import { layout, type NavKey, type NavItem } from './ui/layout.ts';
import { pageListScreen, type PageRow } from './ui/pageList.ts';
import { mediaLibraryScreen, type MediaAsset } from './ui/mediaLibrary.ts';
import { signInScreen } from './ui/signIn.ts';
import {
  ADMIN_COOKIE_PATH,
  CSRF_HEADER,
  FLEET_COOKIE,
  FLEET_COOKIE_PATH,
  SessionStore,
  cookieValue,
  idleMsFor,
  sessionCookieName,
  type SessionRecord,
} from './session.ts';

/** `tenant.key`'s CHECK: `^[a-z0-9][a-z0-9-]{0,39}$`. */
const KEY_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const PAGE_ID_RE = /^[0-9]{1,18}$/;

/**
 * `cms_page.slug`'s CHECK is `^[a-z0-9][a-z0-9-]*$`: a slash is not a slug, so `/blog/post`
 * becomes `blog-post` and `/` becomes `home`. The editor sends a slug when the operator
 * set one; this is the derivation for the case where it did not.
 */
export function slugOf(path: string): string {
  const trimmed = path.replace(/^\/+|\/+$/g, '');
  const slug = trimmed === '' ? 'home' : trimmed.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug === '' ? 'home' : slug;
}

/** What the admin router calls when the request is not the admin surface after all. */
export type NotFoundFallback = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface AdminOptions {
  env: Env;
  controlPath: string;
  tenants: TenantMap;
  /**
   * The process-wide argon2 semaphore (§7.2: `SKW_ARGON2_MAX_CONCURRENT=4`). Shared
   * with the download plane so the two verifiers cannot add up to 8 concurrent
   * 19 MiB hashes — 4 is a memory budget, not a per-surface one.
   */
  semaphore?: Semaphore;
  /** `content/` — passed to the code issuer so an encrypted PDF is refused at issue. */
  contentRoot?: string;
  /**
   * `schema/` — S4a's editor reads `component-registry.json` from here at request time
   * (once per page open) rather than at boot, so the palette and the types a document is
   * validated against are the ones the image ships *now*.
   *
   * Required, not defaulted: a cwd fallback is a second way to find the schema directory,
   * and E28-2 refuses a new runtime path site for exactly that reason.
   */
  schemaDir: string;
}

interface Headers {
  [key: string]: string | string[] | undefined;
}

/** One row of the media library: the asset plus its `thumb` webp, when it has one. */
interface MediaRow {
  id: number;
  key: string;
  filename: string;
  alt_text: string | null;
  kind: string;
  mime: string;
  width: number | null;
  height: number | null;
  bytes: number;
  sha256: string;
  access_class: string;
  storage_path: string;
  thumb_sha: string | null;
  thumb_width: number | null;
  thumb_height: number | null;
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

/** A browser form sends `Accept: text/html`; a JSON client does not. */
function wantsHtml(req: FastifyRequest): boolean {
  const accept = header(req, 'accept') ?? '';
  return accept.includes('text/html') && !accept.includes('application/json');
}

/**
 * Where a browser goes after signing in, when the form carried `next`.
 *
 * A query parameter is attacker-controlled, so the only values accepted are paths inside
 * this console: no scheme, no host, no protocol-relative `//`, no backslash (some browsers
 * treat `\` as `/`), and nothing that leaves `/admin` or `/fleet`. The login screen itself
 * is excluded — landing back on the form that was just answered reads as a failure. An
 * unacceptable value is discarded rather than corrected: the operator lands on their portal,
 * which is where they were going anyway.
 */
function safeNext(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (!raw.startsWith('/') || raw.startsWith('//')) return undefined;
  if (raw.includes('\\') || raw.includes('\n') || raw.includes('\r')) return undefined;
  const inConsole = raw === '/admin' || raw.startsWith('/admin/') || raw === '/fleet' || raw.startsWith('/fleet/');
  if (!inConsole || raw === '/admin/login' || raw.startsWith('/admin/login?')) return undefined;
  return raw;
}

/**
 * The one sentence a person gets for a failed attempt. It says what to do, never which
 * factor was wrong: E-16 already decided the wire must not distinguish an unknown account
 * from a wrong password from a wrong code, and a screen that did would hand back exactly
 * what that decision removed. Locked and role-disabled are different questions — one is
 * "wait", the other is "this build does not accept your role" — so they say so.
 */
function loginFailureMessage(reason: LoginFailureReason): string {
  if (reason === 'locked') return 'Too many failed tries. Wait a minute and try again.';
  if (reason === 'role_disabled') return 'This build does not accept that kind of account.';
  return 'That email, password or code did not match. Try again.';
}

/** Good enough to refuse a typo, and the only thing this screen has to get right. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** The only escaping in this file: every interpolation into HTML goes through it. */
function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The document for every screen that has not been rebuilt yet (plugins, tables, sources,
 * the builder, the fleet console). Since S7 it renders the Guided Cards *shell* — head,
 * inline style, skip link, app bar — while the body stays the markup those screens
 * already had, wrapped in `.legacy` so a bare `<table>` is still readable inside a card
 * layout. Phase 2 gives them their own bodies; nothing here is thrown away.
 */
interface PageChrome {
  tenant: Tenant;
  user: { email: string; role: string } | null;
  active: NavKey;
  notices?: number;
}

function page(title: string, body: string, chrome?: PageChrome): string {
  return layout({
    title,
    body: `<div class="legacy">\n${body}\n</div>`,
    chrome: 'app',
    tenant: chrome === undefined ? null : { key: chrome.tenant.key, label: chrome.tenant.key },
    user: chrome === undefined ? null : chrome.user,
    active: chrome === undefined ? 'none' : chrome.active,
    ...(chrome === undefined || chrome.notices === undefined ? {} : { notices: chrome.notices }),
  });
}

/**
 * A breadcrumb trail: `Pages / Tables / cms_page / 12`. The last crumb is the page you are on
 * and is marked `aria-current="page"` — colour alone is not a position (S7's rule).
 *
 * Added in S8d because the table screens were the only admin pages with no chrome and no way
 * back: the row form, the deepest screen in the admin, linked to nothing at all.
 */
function crumbs(items: readonly { label: string; href?: string }[]): string {
  const parts = items.map((item, at) => {
    const last = at === items.length - 1;
    const body = last
      ? `<span aria-current="page">${esc(item.label)}</span>`
      : `<a href="${esc(item.href ?? '#')}">${esc(item.label)}</a>`;
    return `<li>${body}</li>`;
  });
  return `    <nav class="crumbs" aria-label="Breadcrumb">
      <ol>${parts.join('<li class="sep" aria-hidden="true">/</li>')}</ol>
    </nav>
`;
}

/** A query value, decoded; `undefined` when absent or empty. */
function queryValue(url: string, name: string): string | undefined {
  const q = url.indexOf('?');
  if (q === -1) return undefined;
  const value = new URLSearchParams(url.slice(q + 1)).get(name);
  return value === null || value === '' ? undefined : value;
}

/** The screens the tenant's loaded plugins registered: `href → title`, for the menu and the screen. */
function declaredScreenLinks(runtime: PluginRuntime, tenant: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of runtime.registry.plugins(tenant)) {
    for (const screen of entry.screens.values()) out.set(screenHref(tenant, screen.path), screen.title);
  }
  return out;
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
  /** Where `content/` is; the code issuer reads a PDF's trailer through it (§7.5). */
  readonly #contentRoot: string;
  /** Where `schema/` is; the editor reads the component registry from it (S4a). */
  readonly #schemaDir: string;
  /**
   * The plugin runtime (§13.3), attached by `buildApp` after step 6 — the surface was
   * constructed before the registry existed. `null` means "this box has no plugin model in
   * this process", and every plugin row below then renders as "unknown" rather than as an
   * empty list that would read as "nothing installed".
   */
  #plugins: PluginRuntime | null = null;

  constructor(opts: AdminOptions) {
    this.#env = opts.env;
    this.#controlPath = opts.controlPath;
    this.#tenants = opts.tenants;
    // E-17: the one parser's output, read from the environment — there is no
    // second way to set this value, so the app cannot disagree with the edge
    // about what the list is.
    this.#allowlist = opts.env.adminAllowlist;
    this.#contentRoot = opts.contentRoot ?? DEFAULT_CONTENT_ROOT;
    // `schema/` sits beside `app/` in the repo and beside `dist/` in the image; main.ts
    // resolves it through `findProjectRoot` and passes it, so this class never guesses.
    this.#schemaDir = opts.schemaDir;
    this.#idleMs = idleMsFor(this.#allowlist);
    this.sessions = new SessionStore(opts.controlPath, opts.env.sessionKey, opts.env.ipHashKey, opts.env.dbBusyTimeoutMs);
    this.auth = new Auth({
      controlPath: opts.controlPath,
      fleetMode: opts.env.fleetMode,
      allowlist: this.#allowlist,
      semaphore: opts.semaphore ?? new Semaphore(opts.env.argon2MaxConcurrent),
      busyTimeoutMs: opts.env.dbBusyTimeoutMs,
    });
  }

  get idleMs(): number {
    return this.#idleMs;
  }

  /** `buildApp`'s step 6 finishes after this surface exists; this is how it tells us. */
  attachPlugins(runtime: PluginRuntime): void {
    this.#plugins = runtime;
  }

  /**
   * D37: the tenant an admin request is about is the tenant its `Host` maps to.
   *
   * This is the whole of the replacement for §9.1's `listener` rule, and it is
   * deliberately narrow: it accepts a raw `Host` header, normalises it once with the
   * same function the resolver uses, and looks it up. It never consults
   * `X-Skunkworks-Tenant` (a demo prefix is not an admin host), never a session and
   * never the URL. `undefined` is "this Host is nobody's", which every caller turns
   * into the same 404 an unknown path gets.
   */
  hostTenant(host: string | null | undefined): Tenant | undefined {
    const normalised = normaliseHost(host ?? null);
    if (normalised === null) return undefined;
    const tenant = this.#tenants.lookupHost(normalised);
    if (tenant === undefined || tenant.status !== 'active') return undefined;
    return tenant;
  }

  /** D37: the only gate on parsing a tenant's cookie — and it needs the tenant first. */
  sessionFor(cookieHeader: string | undefined, tenant: Pick<Tenant, 'key'>, atMs = Date.now()): SessionRecord | null {
    const id = this.sessions.verify(cookieValue(cookieHeader, sessionCookieName(tenant.key)));
    if (id === null) return null;
    return this.sessions.readAndTouch(id, atMs, this.#idleMs);
  }

  /** D37: the fleet session lives in its own namespace, at its own path. */
  fleetSessionFor(cookieHeader: string | undefined, atMs = Date.now()): SessionRecord | null {
    const session = this.#readSession(cookieHeader, FLEET_COOKIE, atMs);
    // A fleet session has no tenant (`user_account`'s CHECK says so). A row that has
    // one is not a fleet session, whatever cookie it arrived under.
    if (session === null || session.tenantId !== null) return null;
    return session;
  }

  #readSession(cookieHeader: string | undefined, name: string, atMs = Date.now()): SessionRecord | null {
    const id = this.sessions.verify(cookieValue(cookieHeader, name));
    if (id === null) return null;
    return this.sessions.readAndTouch(id, atMs, this.#idleMs);
  }

  handles(req: FastifyRequest): boolean {
    const pathname = pathnameOf(req.url);
    return pathname === '/admin' || pathname === '/admin/' || pathname.startsWith('/admin/');
  }

  async handle(req: FastifyRequest, reply: FastifyReply, fallback: NotFoundFallback): Promise<void> {
    // D37: row 2 is a general gate on the box, not an admin one — an untrusted peer
    // may not assert any `X-Skunkworks-*` header.
    const headers = req.headers as Headers;
    const peer = req.socket.remoteAddress ?? '';
    if (!peerInCidrs(peer, this.#env.edgeTrustedCidrs) && anySkunkworksHeader(headers)) {
      throw new AppError('SKW_E_PLT_EDGE_PROOF', 'edge assertion from an untrusted peer');
    }

    // Row 1, relocated: the admin surface never takes a tenant from a header. A
    // **non-empty** one is an assertion and is refused; an empty one is the edge's
    // own `proxy_set_header … ""` and asserts nothing (SDS §5.3 says nginx does not
    // forward it at all, and this is what happens when it does).
    const claimed = header(req, TENANT_HEADER);
    if (claimed !== undefined && claimed !== '') {
      throw new AppError('SKW_E_PLT_EDGE_PROOF', 'the admin surface does not accept a tenant header');
    }

    const tenant = this.hostTenant(req.headers.host);
    if (tenant === undefined) {
      // The Host maps to no tenant: "there is no tenant here" is the true statement,
      // and it is the same 404 any other path on this Host gets.
      throw new AppError('SKW_E_PLT_TENANT_UNKNOWN', 'no tenant here');
    }

    // §5.5: every admin response is `no-store`. Set here, once, so a new route
    // cannot forget it — the tenant home, the login page and the reset form included.
    reply.header('cache-control', 'no-store');

    const pathname = pathnameOf(req.url);
    const seg = pathname.split('/').filter((s) => s !== '');
    // seg[0] is 'admin' on every path this handler sees.

    if (seg.length === 1) {
      this.#requireMethod(req, 'GET');
      // S8a: `/admin` is where every operator is told to go, so it answers a person with
      // no session by sending them to the form that fixes that. It used to be the same
      // `404 SKW_E_PLT_TENANT_UNKNOWN` as a missing page (§5.3 row 7, whose concern is that
      // an unauthenticated *API* answer must not report 401/403) — but a redirect to a
      // 200 login page is neither of those, and `/admin/login` is already publicly served
      // on this very Host, so nothing about the tenant's existence is newly revealed.
      const session = this.sessionFor(header(req, 'cookie'), tenant);
      if (session === null || session.tenantId !== tenant.id) {
        // 302: this is a GET and the answer is another GET. 303 would say "what you just
        // POSTed was accepted", which nothing was.
        this.#seeOther(reply, '/admin/login', 302);
        return;
      }
      await this.#tenantHome(reply, tenant, session);
      return;
    }

    if (seg.length === 2 && seg[1] === 'login') {
      await this.#loginRoute(req, reply, tenant);
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
      // §9.2 with D37's source: the key is a claim and the Host is the resolution.
      // A key that is not this Host's tenant is the same 404 as a missing one — not a
      // 403, because "tenant beta exists somewhere else" is not a fact this Host owes
      // the caller.
      if (key !== tenant.key) throw new AppError('SKW_E_PLT_TENANT_UNKNOWN', 'no tenant here');
      const action = seg.slice(3).join('/');
      await this.#tenantRoute(req, reply, tenant, action);
      return;
    }

    // Every admin URL is one of the shapes above; anything else under `/admin` is the
    // same "no tenant here" 404 as an unknown path.
    throw new AppError('SKW_E_PLT_TENANT_UNKNOWN', 'no admin route at this path');
  }

  /**
   * D37: the fleet console at `/fleet`, on any Host, for a fleet session only.
   *
   * A tenant owner who asks for it gets `serveNotFound` — the page-miss path — so the
   * answer is byte-identical to a path with no `cms_page` row: same 404, same code,
   * same headers. There is no "you are not allowed" and no login redirect, because
   * both would confirm that something is there.
   */
  async handleFleet(req: FastifyRequest, reply: FastifyReply, fallback: NotFoundFallback): Promise<void> {
    const headers = req.headers as Headers;
    const peer = req.socket.remoteAddress ?? '';
    if (!peerInCidrs(peer, this.#env.edgeTrustedCidrs) && anySkunkworksHeader(headers)) {
      throw new AppError('SKW_E_PLT_EDGE_PROOF', 'edge assertion from an untrusted peer');
    }
    const claimed = header(req, TENANT_HEADER);
    if (claimed !== undefined && claimed !== '') {
      throw new AppError('SKW_E_PLT_EDGE_PROOF', 'the fleet console does not accept a tenant header');
    }

    const session = this.fleetSessionFor(req.headers.cookie);
    if (session === null) {
      await fallback(req, reply);
      return;
    }

    const pathname = pathnameOf(req.url);
    const seg = pathname.split('/').filter((s) => s !== '');
    reply.header('cache-control', 'no-store');

    if (seg.length === 1) {
      this.#requireMethod(req, 'GET');
      this.#fleetConsole(req, reply, session);
      return;
    }
    if (seg.length === 2 && seg[1] === 'logout') {
      this.#requireMethod(req, 'POST');
      this.#assertOrigin(req);
      this.#assertCsrf(req, session);
      this.sessions.revoke(session.id, Date.now());
      reply.header('set-cookie', this.sessions.clearCookieHeader(FLEET_COOKIE, FLEET_COOKIE_PATH));
      reply.send({ ok: true });
      return;
    }
    // Anything else under `/fleet` for a real fleet session is a 404, not a page miss:
    // the console has exactly the two routes above.
    throw new AppError('SKW_E_PLT_TENANT_UNKNOWN', 'no fleet route at this path');
  }

  // --- D37: the console, the login page, the reset consumer -----------------

  #fleetConsole(req: FastifyRequest, reply: FastifyReply, session: SessionRecord): void {
    const user = this.auth.userById(session.userId);
    const all = this.#tenants.all().filter((t) => t.status === 'active');

    // A fleet operator sees every tenant, and each entry links to that tenant's own
    // admin on that tenant's **primary host** — with `/admin` on a tenant host there is
    // no single admin address left, so the console has to say where each tenant lives.
    // The link is absolute and host-qualified because a fleet session has no tenant:
    // `/admin/t/<key>/` on the console's own host would be the 404 this very route
    // answers for everyone else.
    const items = all
      .map((t) => {
        const host = this.#primaryHost(t.id);
        const label = `${esc(t.key)} <span>${esc(t.mode)}</span>`;
        const link =
          host === null
            ? `<span data-tenant="${esc(t.key)}">${label}</span> <span>(no host mapped)</span>`
            : `<a href="https://${esc(host)}/admin" data-tenant="${esc(t.key)}">${label}</a> <code>https://${esc(host)}/admin</code>`;
        return `<li>${link}</li>`;
      })
      .join('\n');

    const who = user === null ? `user ${session.userId}` : `${esc(user.email)} (${esc(user.role)})`;
    reply
      .type('text/html; charset=utf-8')
      .send(
        page(
          'Skunkworks — fleet',
          `<h1>Fleet</h1>
<p>${who} — fleet operator</p>
<ul data-role="tenant-switcher">
${items}
</ul>
<p>Each tenant is administered on its own hosts at <code>/admin</code>; this console has no tenant of its own (D37).</p>
<form method="post" action="/fleet/logout">
  <input type="hidden" name="csrf" value="${esc(this.sessions.csrfToken(session))}">
  <button type="submit">Sign out</button>
</form>`,
        ),
      );
  }

  /**
   * The host a tenant is administered on: its primary `domain` row, else its first
   * host. `control.db` is read directly because `TenantMap` is keyed the other way
   * round (host → tenant) and this is one row per tenant on a screen an operator sees.
   */
  #primaryHost(tenantId: number): string | null {
    const db = openAdminWrite(this.#controlPath, this.#env.dbBusyTimeoutMs);
    try {
      const row = db
        .prepare(
          `SELECT host FROM domain WHERE tenant_id = ?
            ORDER BY is_primary DESC, host LIMIT 1`,
        )
        .get(tenantId) as { host: string } | undefined;
      return row?.host ?? null;
    } finally {
      db.close();
    }
  }

  async #loginRoute(req: FastifyRequest, reply: FastifyReply, tenant: Tenant): Promise<void> {
    if (req.method === 'GET') {
      // S7: the Guided Cards sign-in. The form is the same contract as before — POST
      // `/admin/login`, urlencoded, no CSRF field (there is no session to bind one to).
      // A `?next=` from a bounce keeps the operator's destination across the form post. Only
      // a path inside this console survives `safeNext`; anything else is dropped.
      const next = safeNext((req.query as { next?: string } | undefined)?.next);
      reply
        .type('text/html; charset=utf-8')
        .send(signInScreen({ tenant: { key: tenant.key, label: tenant.key }, ...(next === undefined ? {} : { next }) }));
      return;
    }
    if (req.method !== 'POST') throw new AppError('SKW_E_PLT_REQUEST_INVALID', 'login is a GET or a POST');
    await this.#login(req, reply, tenant);
  }

  async #login(req: FastifyRequest, reply: FastifyReply, hostTenant: Tenant): Promise<void> {
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
    // D37: the Host scopes the lookup. Two tenants may hold one email address
    // (`UNIQUE(tenant_id, email)`), and before this the second one could not sign in
    // at all — the 401 that said "ambiguous" was the old single-admin-surface promise
    // showing through. The fleet rows stay reachable from here (§9.1's "one login URL").
    const result = await this.auth.authenticate({ scope: hostTenant.id, email, password, totp, atMs });
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
      // S8f: a form post that fails is still a form post. A person gets the screen back with
      // one sentence and the status the taxonomy gives the code; a JSON client keeps E-16's
      // single body, unchanged.
      if (wantsHtml(req)) {
        const back = safeNext(fields.next);
        reply
          .code(result.error.status)
          .type('text/html; charset=utf-8')
          .send(
            signInScreen({
              tenant: { key: hostTenant.key, label: hostTenant.key },
              ...(back === undefined ? {} : { next: back }),
              error: loginFailureMessage(result.reason),
            }),
          );
        return;
      }
      throw result.error;
    }

    const tenantId = result.user.tenantId;
    let tenant: Tenant | undefined;
    if (tenantId !== null) {
      tenant = this.#tenants.lookupId(tenantId);
      if (tenant === undefined || tenant.status !== 'active') {
        throw new AppError('SKW_E_PLT_TENANT_UNKNOWN', 'no tenant here');
      }
      // D37: credentials for tenant B presented on tenant A's host. The row is right
      // and this Host does not serve that tenant, so the answer is the same 404 a
      // missing tenant gets — and no cookie, because there is nothing here to be.
      if (tenant.id !== hostTenant.id) {
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
    // §13.3.4, `admin.login` — an **action**, post-authentication, `{tenant, operatorId}`.
    // The return value is discarded by `actionSite`'s signature: a hook that could change
    // an authentication outcome would be a hook that changes who is signed in, which is why this
    // is the action and `admin.session` is absent by decision.
    if (tenant !== undefined) {
      await actionSite('admin.login', tenant.key, { tenant: tenant.key, operatorId: result.user.id });
    }
    // D37: the cookie's name and path follow the session's *kind*. A tenant session is
    // named for its tenant and scoped to `/admin`; a fleet session has no tenant to be
    // named for and is scoped to `/fleet`, so the console's cookie is never sent to a
    // tenant's admin surface.
    const name = tenant === undefined ? FLEET_COOKIE : sessionCookieName(tenant.key);
    const path = tenant === undefined ? FLEET_COOKIE_PATH : ADMIN_COOKIE_PATH;
    reply.header('set-cookie', this.sessions.cookieHeader(name, this.sessions.sign(session.id), path));
    if (wantsHtml(req)) {
      // A browser form POST ends in a document, never in a body it would render as text: 303
      // says "that was accepted, now GET this", and the Set-Cookie above rides on this reply.
      // A fleet session has no tenant portal, so it lands on the console it belongs to.
      const portal = tenant === undefined ? '/fleet' : '/admin';
      this.#seeOther(reply, safeNext(fields.next) ?? portal);
      return;
    }
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
    // D37: the cleared cookie is the one this user could have had. A tenant row's
    // session lives under that tenant's name at `/admin`; a fleet row's under the
    // fleet name at `/fleet`. Clearing the wrong one leaves a live-looking cookie in
    // the browser that the server refuses — confusing, and one bug report waiting.
    const resetTenant = row.tenant_id === null ? undefined : this.#tenants.lookupId(row.tenant_id);
    const resetName = resetTenant === undefined ? FLEET_COOKIE : sessionCookieName(resetTenant.key);
    const resetPath = resetTenant === undefined ? FLEET_COOKIE_PATH : ADMIN_COOKIE_PATH;
    reply.header('set-cookie', this.sessions.clearCookieHeader(resetName, resetPath));
    reply.send({ ok: true, sessionsRevoked: true });
  }

  // --- tenant-scoped routes ----------------------------------------------

  async #tenantRoute(req: FastifyRequest, reply: FastifyReply, tenant: Tenant, action: string): Promise<void> {
    if (action === '') {
      this.#requireMethod(req, 'GET');
      const session = this.#requireSession(req, tenant);
      this.#assertTenantMatches(session, tenant);
      await this.#tenantHome(reply, tenant, session);
      return;
    }

    if (action === 'login') {
      // D29: there is exactly one login URL, and it is not tenant-scoped. A
      // per-tenant login would select a tenant from the URL — the second source
      // of truth §9.2 forbids — so this path is the row-7 404 like any other.
      throw new AppError('SKW_E_PLT_TENANT_UNKNOWN', 'no admin route at this path');
    }

    const session = this.#requireSession(req, tenant);
    this.#assertTenantMatches(session, tenant);

    if (action === 'plugins' && req.method === 'GET') {
      this.#pluginsScreen(reply, tenant, session, queryValue(req.url, 'result'));
      return;
    }
    if (action === 'plugins/enable' && req.method === 'POST') {
      this.#assertOrigin(req);
      this.#assertCsrf(req, session);
      await this.#pluginEnable(req, reply, tenant);
      return;
    }
    // S8e: the other half of the plugin switch. `enable` existed; `disable` did not, so a
    // package could be switched on from the screen and only off from a shell.
    if (action === 'plugins/disable' && req.method === 'POST') {
      this.#assertOrigin(req);
      this.#assertCsrf(req, session);
      await this.#pluginDisable(req, reply, tenant, session);
      return;
    }
    if (action === 'plugins/uninstall' && req.method === 'POST') {
      this.#assertOrigin(req);
      this.#assertCsrf(req, session);
      await this.#pluginUninstall(req, reply, tenant, session);
      return;
    }
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
      reply.header('set-cookie', this.sessions.clearCookieHeader(sessionCookieName(tenant.key), ADMIN_COOKIE_PATH));
      // A form posts here with no `Accept: application/json`; a browser that is handed a
      // JSON body after signing out has no way back to the login page.
      if (wantsHtml(req)) {
        this.#seeOther(reply, '/admin/login');
        return;
      }
      reply.send({ ok: true });
      return;
    }
    if (action === 'account' && req.method === 'GET') {
      this.#account(reply, req, tenant, session);
      return;
    }
    if (action === 'account/password' && req.method === 'POST') {
      this.#assertOrigin(req);
      this.#assertCsrf(req, session);
      await this.#accountPassword(req, reply, tenant, session);
      return;
    }
    if (action === 'account/email' && req.method === 'POST') {
      this.#assertOrigin(req);
      this.#assertCsrf(req, session);
      this.#accountEmail(req, reply, tenant, session);
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
    // §10.1–§10.3 (S4a): the editor. The page is a GET; every write is origin- and
    // CSRF-checked before the editor module sees a field, and the three static assets are
    // served from this origin (a CDN would be a script the image does not ship).
    if (action === 'editor' && req.method === 'GET') {
      this.#editorPage(req, reply, tenant, session);
      return;
    }
    if (action === 'editor/save' && req.method === 'POST') {
      this.#assertOrigin(req);
      this.#assertCsrf(req, session);
      await this.#editorSave(req, reply, tenant, session);
      return;
    }
    // S8b (E-35): the publish step the page list's copy has always promised and no route
    // implemented. Origin and CSRF first, like every other write.
    if (action === 'editor/publish' && req.method === 'POST') {
      this.#assertOrigin(req);
      this.#assertCsrf(req, session);
      this.#editorPublish(req, reply, tenant, session);
      return;
    }
    if (action === 'editor/pick' && req.method === 'POST') {
      this.#assertOrigin(req);
      this.#assertCsrf(req, session);
      this.#editorPick(req, reply, tenant);
      return;
    }
    if (action === 'editor/media.json' && req.method === 'GET') {
      this.#editorMedia(reply, tenant);
      return;
    }
    if (action === 'editor/grapesjs.js' || action === 'editor/grapesjs.css' || action === 'editor/editor.js') {
      this.#editorAsset(reply, action);
      return;
    }
    // §7.1 / §9: the media library — the thumbnail grid, the search, and the picker that
    // writes a key into a field. A picker writes a **key**, never a URL: content that stored
    // a URL would have to be rewritten by every rename (§7.3).
    if (action === 'media' && req.method === 'GET') {
      this.#mediaLibrary(req, reply, tenant, session);
      return;
    }
    if (action === 'media.json' && req.method === 'GET') {
      this.#mediaJson(req, reply, tenant);
      return;
    }
    // S8c: the upload door. Origin first (a cross-site form post is the attack), then the
    // multipart body — which is also where the CSRF field lives, so the token is checked after
    // the parts are read and before a single byte reaches the disk.
    if (action === 'media/upload' && req.method === 'POST') {
      this.#assertOrigin(req);
      await this.#mediaUpload(req, reply, tenant, session);
      return;
    }
    // §7.6 (S3c): the access-code screen. A POST is origin- and CSRF-checked here, before
    // the module that mints a code sees a field.
    if (action === 'codes' || action.startsWith('codes/')) {
      if (req.method !== 'GET' && req.method !== 'POST') {
        throw new AppError('SKW_E_PLT_REQUEST_INVALID', 'codes is a GET or a POST');
      }
      if (req.method === 'POST') {
        this.#assertOrigin(req);
        this.#assertCsrf(req, session);
      }
      await this.#codesRoute(req, reply, tenant, action);
      return;
    }
    if (action.startsWith('pages/') && req.method === 'GET') {
      const id = action.slice('pages/'.length);
      if (!PAGE_ID_RE.test(id)) throw new AppError('SKW_E_PLT_REQUEST_INVALID', 'not a page id');
      this.#pageDetail(reply, tenant, Number(id));
      return;
    }
    // §9.4 — the table builder. Off means absent, not disabled: with
    // SKW_SCHEMA_EDIT=off these paths are unknown admin paths.
    if (action === 'builder' || action === 'builder/preview' || action === 'builder/apply') {
      // §9.4: `off` hides it entirely. A hidden surface is an absent route — not a
      // refusal that would tell a prober the feature exists on another box.
      if (this.#env.schemaEdit !== 'on') {
        throw new AppError('SKW_E_PLT_TENANT_UNKNOWN', 'no admin route at this path');
      }
      if (action === 'builder') {
        this.#requireMethod(req, 'GET');
        this.#builderForm(reply, tenant, session);
        return;
      }
      this.#requireMethod(req, 'POST');
      this.#assertOrigin(req);
      this.#assertCsrf(req, session);
      if (action === 'builder/apply') {
        this.#builderApply(req, reply, tenant, session);
        return;
      }
      this.#builderPreview(req, reply, tenant, session);
      return;
    }

    // §6.1 — the Data Source registry. Listing is a read; publish and draft are
    // the gate's only callers in the app, and both run through `app/sources/publish.ts`.
    if (action === 'sources') {
      this.#requireMethod(req, 'GET');
      this.#sourcesList(reply, tenant);
      return;
    }
    if (action === 'sources/publish' || action === 'sources/draft') {
      this.#requireMethod(req, 'POST');
      this.#assertOrigin(req);
      this.#assertCsrf(req, session);
      this.#sourceWrite(req, reply, tenant, session, action === 'sources/draft');
      return;
    }

    // §9.3 — the CRUD write path, on `admin-write`.
    if (action === 'tables' && req.method === 'GET') {
      this.#tablesIndex(reply, tenant, session);
      return;
    }
    if (action.startsWith('tables/')) {
      await this.#tableRoute(req, reply, session, tenant, action.slice('tables/'.length));
      return;
    }
    // S8e: a screen a loaded plugin declared. Until this existed the registry held the screen,
    // the menu listed it, and the URL answered "no such admin action" — a dead link the admin
    // generated itself. The screen is DECLARATIVE over one owned table, so the host draws it
    // with the same generated list/form the core tables use; the package supplies no markup
    // and therefore cannot put a second SQL surface or its own HTML on the admin origin.
    const screen = this.#pluginScreen(tenant, action);
    if (screen !== undefined) {
      const rest = action.slice(screen.path.replace(/^\/+/, '').length).replace(/^\/+/, '');
      await this.#pluginScreenRoute(req, reply, session, tenant, screen, rest);
      return;
    }
    throw new AppError('SKW_E_PLT_REQUEST_INVALID', 'no such admin action');
  }

  async #tenantHome(reply: FastifyReply, tenant: Tenant, session: SessionRecord): Promise<void> {
    const actor = this.#actorOf(session);
    // §13.3.4, `admin.menu`: `{tenant, items} → items`. Core's menu is built first and the
    // filter may **add** an entry; an entry pointing anywhere but a screen a loaded plugin
    // actually registered is dropped by the dispatch (the bus's `declaredScreens` rule), so
    // a plugin cannot link to a route that does not exist or to core's own pages.
    const core: { href: string; label: string }[] = [
      { href: `/admin/t/${tenant.key}/pages`, label: 'Pages' },
      { href: `/admin/t/${tenant.key}/media`, label: 'Media' },
      { href: `/admin/t/${tenant.key}/tables`, label: 'Tables' },
      { href: `/admin/t/${tenant.key}/sources`, label: 'Data sources' },
      ...(this.#env.schemaEdit === 'on' ? [{ href: `/admin/t/${tenant.key}/builder`, label: 'Table builder' }] : []),
      { href: `/admin/t/${tenant.key}/account`, label: 'Account' },
      { href: `/admin/t/${tenant.key}/session`, label: 'Session' },
    ];
    const items = await filterSite<{ href: string; label: string }[]>(
      'admin.menu',
      tenant.key,
      { tenant: tenant.key, items: core.map((i) => ({ ...i })) },
      core,
    );
    // Notices are a core entry, always, and not a plugin's: an operator who cannot see that a
    // plugin was disabled is the defect this screen exists for (§13.3.6).
    const notices = this.#plugins === null ? 0 : this.#plugins.noticesFor(tenant.key).length;
    // The app bar carries the three screens a site owner uses; everything else — Tables,
    // Data sources, Session, the builder and any plugin screen — is listed under the page
    // list, so the menu filter's additions still reach the page they point at.
    // `/pages` is the JSON read (S3's contract); the human screen is this one, so it is not
    // offered as a link beside it.
    const primary = new Set([
      `/admin/t/${tenant.key}/`,
      `/admin/t/${tenant.key}/pages`,
      `/admin/t/${tenant.key}/media`,
      `/admin/t/${tenant.key}/plugins`,
    ]);
    const more: NavItem[] = items
      .filter((item) => typeof item.href === 'string' && typeof item.label === 'string')
      .filter((item) => !primary.has(item.href))
      .map((item) => ({ href: item.href, label: item.label }));

    const rows = this.#pageRows(tenant.key);
    reply.type('text/html; charset=utf-8').send(
      pageListScreen({
        tenant: { key: tenant.key, label: tenant.key },
        user: actor,
        pages: rows ?? [],
        nowMs: Date.now(),
        notices,
        more,
        ...(rows === null ? { unavailable: true } : {}),
      }),
    );
  }

  // --- S8a: the operator's own account -----------------------------------

  /**
   * One POST, one 303. No write in this file renders its result: a refresh after a
   * password change must not repeat it, and a form that answers with JSON leaves the
   * operator looking at `{"ok":true}`.
   */
  #seeOther(reply: FastifyReply, location: string, code: 302 | 303 = 303): void {
    reply.header('cache-control', 'no-store').code(code).header('location', location).send('');
  }

  #account(reply: FastifyReply, req: FastifyRequest, tenant: Tenant, session: SessionRecord): void {
    const user = this.auth.userById(session.userId);
    // A session whose row is gone is not an account screen: the same 404 every other
    // tenant route answers when the identity behind it has disappeared.
    if (user === null) throw new AppError('SKW_E_PLT_TENANT_UNKNOWN', 'no such account');

    const changed = queryValue(req.url, 'changed');
    const emailOk = queryValue(req.url, 'email');
    const err = queryValue(req.url, 'e');
    const flash =
      changed === '1' ? 'changed' : emailOk === '1' ? 'email' : err === 'email' ? 'format' : err;

    reply.type('text/html; charset=utf-8').send(
      accountScreen({
        tenant: { key: tenant.key, label: tenant.key },
        user: { email: user.email, role: user.role },
        csrf: this.sessions.csrfToken(session),
        flash,
        notices: this.#plugins === null ? 0 : this.#plugins.noticesFor(tenant.key).length,
        minPasswordLength: PASSWORD_MIN_LENGTH,
      }),
    );
  }

  /**
   * Change the password from a session that already authenticated.
   *
   * The current password is re-verified (one argon2 verify via `Auth.verifyPassword`) and
   * every *other* session of the account is revoked in the same transaction — a password
   * change is the one moment a stolen cookie must stop working, which is the same rule
   * E-19's reset consumer follows. This session is deliberately spared: it is where the
   * operator just proved they are the operator.
   */
  async #accountPassword(req: FastifyRequest, reply: FastifyReply, tenant: Tenant, session: SessionRecord): Promise<void> {
    const base = `/admin/t/${tenant.key}/account`;
    const fields = fieldsOf(req.body);
    const current = fields.current_password;
    const next = fields.new_password;
    if (current === undefined || next === undefined) {
      throw new AppError('SKW_E_PLT_REQUEST_INVALID', 'current_password and new_password are required');
    }
    if ([...next].length < PASSWORD_MIN_LENGTH) {
      this.#seeOther(reply, `${base}?e=short`);
      return;
    }
    if (next === current) {
      this.#seeOther(reply, `${base}?e=same`);
      return;
    }
    const ok = await this.auth.verifyPassword(session.userId, current);
    if (!ok) {
      this.#audit({
        tenantId: tenant.id,
        userId: session.userId,
        label: this.auth.userById(session.userId)?.email ?? 'unknown',
        action: 'admin.password.change.failed',
        targetKind: 'user_account',
        targetId: String(session.userId),
        ip: req.socket.remoteAddress ?? '',
      });
      this.#seeOther(reply, `${base}?e=current`);
      return;
    }

    const hash = await this.auth.hashPassword(next);
    const atMs = Date.now();
    const db = openAdminWrite(this.#controlPath, this.#env.dbBusyTimeoutMs);
    try {
      const tx = db.transaction(() => {
        const changed = db
          .prepare(
            `UPDATE user_account
                SET password_hash = ?, must_change = 0, failed_logins = 0, locked_until = NULL
              WHERE id = ?`,
          )
          .run(hash, session.userId);
        if (changed.changes !== 1) return false;
        db.prepare('UPDATE session SET revoked_at = ? WHERE user_id = ? AND id <> ? AND revoked_at IS NULL').run(
          new Date(atMs).toISOString(),
          session.userId,
          session.id,
        );
        return true;
      });
      if (!tx()) throw new AppError('SKW_E_PLT_REQUEST_INVALID', 'no such account');
    } finally {
      db.close();
    }

    this.#audit({
      tenantId: tenant.id,
      userId: session.userId,
      label: this.auth.userById(session.userId)?.email ?? 'unknown',
      action: 'admin.password.change',
      targetKind: 'user_account',
      targetId: String(session.userId),
      ip: req.socket.remoteAddress ?? '',
    });
    this.#seeOther(reply, `${base}?changed=1`);
  }

  #accountEmail(req: FastifyRequest, reply: FastifyReply, tenant: Tenant, session: SessionRecord): void {
    const base = `/admin/t/${tenant.key}/account`;
    const fields = fieldsOf(req.body);
    const email = (fields.email ?? '').trim();
    // 254 is the only length the transport actually promises (RFC 5321 §4.5.3.1.3).
    if (email === '' || email.length > 254 || !EMAIL_SHAPE.test(email)) {
      this.#seeOther(reply, `${base}?e=email`);
      return;
    }
    const db = openAdminWrite(this.#controlPath, this.#env.dbBusyTimeoutMs);
    try {
      try {
        const changed = db.prepare('UPDATE user_account SET email = ? WHERE id = ?').run(email, session.userId);
        if (changed.changes !== 1) throw new AppError('SKW_E_PLT_REQUEST_INVALID', 'no such account');
      } catch (err) {
        // `UNIQUE(tenant_id, email)`: two accounts here cannot share an address, and that
        // is a sentence for the operator rather than a 500.
        if (err instanceof Error && /UNIQUE|constraint/i.test(err.message)) {
          this.#seeOther(reply, `${base}?e=taken`);
          return;
        }
        throw err;
      }
    } finally {
      db.close();
    }
    this.#audit({
      tenantId: tenant.id,
      userId: session.userId,
      label: email,
      action: 'admin.email.change',
      targetKind: 'user_account',
      targetId: String(session.userId),
      ip: req.socket.remoteAddress ?? '',
    });
    this.#seeOther(reply, `${base}?email=1`);
  }

  /**
   * The page list's rows: `cms_page` plus its revision count, which is the "versions
   * kept safely" number and the row's "12 versions" line.
   *
   * `null` means the site database could not be opened or read. The caller turns that
   * into a sentence on the screen rather than a 500 — the operator can do nothing about
   * a broken file, and a blank error page invites them to try a write instead.
   */
  #pageRows(key: string): PageRow[] | null {
    let db: Database.Database;
    try {
      db = this.#siteDb(key);
    } catch {
      return null;
    }
    try {
      const rows = db
        .prepare(
          `SELECT p.id, p.path, p.title, p.status, p.updated_at,
                  (p.draft_sha <> '') AS draft,
                  (SELECT COUNT(*) FROM cms_page_revision r WHERE r.page_id = p.id) AS versions
             FROM cms_page p
            ORDER BY p.path
            LIMIT 200`,
        )
        .all() as { id: number; path: string; title: string; status: string; updated_at: string; draft: number; versions: number }[];
      return rows.map((row) => ({
        id: Number(row.id),
        path: String(row.path),
        title: String(row.title),
        status: String(row.status),
        draft: Number(row.draft) === 1,
        versions: Number(row.versions),
        updatedAt: String(row.updated_at),
      }));
    } catch {
      return null;
    } finally {
      db.close();
    }
  }

  /**
   * §13.3.6's notice surface. Until this screen existed the data was asserted and invisible:
   * a plugin could be marked `failed`, auto-disabled after three failures in 60 s, or refused
   * at enable because its root was revoked, and the only witness was a log line an operator
   * needed shell access to read.
   *
   * It shows three things side by side, because they answer three different questions:
   *
   *   - **notices** — what went wrong, with the code and the message the runtime recorded;
   *   - **loaded** — what is in the registry in *this* process right now;
   *   - **installed** — what the rows say, including `activation_seq`, so "the row says
   *     enabled but nothing is loaded" (a failed enable since boot) is visible as a difference
   *     rather than as a mystery.
   *
   * The re-enable form is a POST with the session's CSRF token, never a link: an action that
   * starts code running is not something a prefetcher gets to do.
   */
  /**
   * S8e: `disable` is the hot-unload half of §13.3.8, driven from the screen. The runtime drains
   * in-flight requests, drops the module and unregisters the package's hooks, endpoints and
   * screens; the row keeps `enabled = 0` so a restart does not bring it back.
   */
  async #pluginDisable(req: FastifyRequest, reply: FastifyReply, tenant: Tenant, session: SessionRecord): Promise<void> {
    const fields = fieldsOf(req.body);
    const plugin = (fields.plugin ?? '').trim();
    if (!/^[a-z][a-z0-9]{1,19}$/.test(plugin)) {
      throw new AppError('SKW_E_PLT_REQUEST_INVALID', 'a plugin id is required');
    }
    const runtime = this.#plugins;
    if (runtime === null) throw new AppError('SKW_E_PLT_REQUEST_INVALID', 'plugins are not available in this build');
    const disabled = await runtime.disable(tenant.key, plugin);
    const user = this.auth.userById(session.userId);
    this.#audit({
      tenantId: tenant.id,
      userId: user?.id ?? null,
      label: user?.email ?? 'operator',
      action: 'plugin.disable',
      targetKind: 'cms_plugin_installed',
      targetId: plugin,
      after: { disabled },
      ip: req.socket.remoteAddress ?? '',
    });
    this.#seeOther(reply, `/admin/t/${tenant.key}/plugins?result=${encodeURIComponent(`disabled ${plugin}`)}`);
  }

  #pluginsScreen(reply: FastifyReply, tenant: Tenant, session: SessionRecord, flash?: string): void {
    const runtime = this.#plugins;
    const db = this.#siteDb(tenant.key);
    let installed: { plugin_id: string; version: string; enabled: number; activation_seq: number }[] = [];
    try {
      const table = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cms_plugin_installed'`).get();
      if (table !== undefined) {
        const columns = (db.pragma('table_info(cms_plugin_installed)') as { name: string }[]).map((c) => c.name);
        const seq = columns.includes('activation_seq') ? 'activation_seq' : '0 AS activation_seq';
        installed = db
          .prepare(`SELECT plugin_id, version, enabled, ${seq} FROM cms_plugin_installed ORDER BY plugin_id`)
          .all() as typeof installed;
      }
    } finally {
      db.close();
    }

    const notices = runtime === null ? [] : runtime.noticesFor(tenant.key);
    const loaded = runtime === null ? [] : runtime.registry.plugins(tenant.key);
    const loadedIds = new Set(loaded.map((entry) => entry.pluginId));
    const csrf = this.sessions.csrfToken(session);

    const noticeRows =
      notices.length === 0
        ? '<tr><td colspan="4">No notices: nothing has failed and nothing has been disabled since boot.</td></tr>'
        : notices
            .map(
              (n) =>
                `<tr data-notice="${esc(n.plugin)}"><td>${esc(n.plugin)}</td><td><code>${esc(n.code)}</code></td><td>${esc(n.message)}</td><td>${esc(n.at)}</td></tr>`,
            )
            .join('\n');

    const installedRows =
      installed.length === 0
        ? '<tr><td colspan="5">Nothing installed for this tenant.</td></tr>'
        : installed
            .map((row) => {
              const isLoaded = loadedIds.has(row.plugin_id);
              const state = row.enabled === 1 && isLoaded ? 'enabled, loaded' : row.enabled === 1 ? 'enabled, NOT loaded — failed since boot' : 'disabled';
              // S8e: enable had a button; disable had only `skwctl plugin disable` and a shell.
              // A screen that can start code but cannot stop it is half a switch.
              const off =
                row.enabled === 1
                  ? `<form method="post" action="/admin/t/${esc(tenant.key)}/plugins/disable">
  <input type="hidden" name="plugin" value="${esc(row.plugin_id)}">
  <input type="hidden" name="csrf" value="${esc(csrf)}">
  <button type="submit" title="stop running this package now; its data is kept">Disable</button>
</form>`
                  : '';
              const action =
                row.enabled === 1 && isLoaded
                  ? ''
                  : `<form method="post" action="/admin/t/${esc(tenant.key)}/plugins/enable">
  <input type="hidden" name="plugin" value="${esc(row.plugin_id)}">
  <input type="hidden" name="csrf" value="${esc(csrf)}">
  <button type="submit">Retry and enable</button>
</form>`;
              // §13.3.8's uninstall, on the surface that can see this process's in-flight
              // requests. The archive is written before anything is dropped
              // (`uninstallPlugin`), so a mis-click is recoverable by hand.
              const uninstall = `<form method="post" action="/admin/t/${esc(tenant.key)}/plugins/uninstall">
  <input type="hidden" name="plugin" value="${esc(row.plugin_id)}">
  <input type="hidden" name="csrf" value="${esc(csrf)}">
  <button type="submit" title="archive this package's rows first, then drop its tables">Uninstall</button>
</form>`;
              return `<tr data-plugin="${esc(row.plugin_id)}"><td>${esc(row.plugin_id)}</td><td>${esc(row.version)}</td><td>${esc(state)}</td><td>${row.activation_seq}</td><td>${action}${off}${uninstall}</td></tr>`;
            })
            .join('\n');

    const loadedLine =
      loaded.length === 0
        ? '<p>No plugin is loaded in this process for this tenant.</p>'
        : `<ul>${loaded
            .map((entry) => `<li>${esc(entry.pluginId)}@${esc(entry.version)} — act ${entry.activationSeq} — hooks: ${esc([...entry.hooks.keys()].sort().join(', ') || 'none')}</li>`)
            .join('')}</ul>`;

    const pluginHrefs =
      runtime === null
        ? ''
        : [...declaredScreenLinks(runtime, tenant.key)]
            .map(([path, title]) => `<li><a href="${esc(path)}">${esc(title)}</a></li>`)
            .join('');

    reply.type('text/html; charset=utf-8').send(
      page(
        `Skunkworks — ${tenant.key} — plugins`,
        `<h1>Plugins — ${esc(tenant.key)}</h1>
${flash === undefined ? '' : `<p role="status">${esc(flash)}</p>`}
<h2>Notices</h2>
<p>A notice is recorded when a package fails to load, fails three times in 60 s and is disabled, or is refused because its root is revoked. A notice is not a warning: the plugin is not running.</p>
<table>
<thead><tr><th>Plugin</th><th>Code</th><th>What happened</th><th>When</th></tr></thead>
<tbody>
${noticeRows}
</tbody>
</table>
<h2>Loaded now</h2>
${loadedLine}
<h2>Installed</h2>
<table>
<thead><tr><th>Plugin</th><th>Version</th><th>State</th><th>activation_seq</th><th>Action</th></tr></thead>
<tbody>
${installedRows}
</tbody>
</table>
<h2>Plugin screens</h2>
${pluginHrefs === '' ? '<p>No declarative screen is registered.</p>' : `<ul>${pluginHrefs}</ul>`}
<p><a href="/admin/t/${esc(tenant.key)}/">Back</a></p>`,
        { tenant, user: this.#actorOf(session), active: 'plugins', notices: notices.length },
      ),
    );
  }

  /** The signed-in operator, for the app bar's name — `null` when the row is gone. */
  #actorOf(session: SessionRecord): { email: string; role: string } | null {
    const user = this.auth.userById(session.userId);
    return user === null ? null : { email: user.email, role: user.role };
  }

  /** `POST /admin/t/<key>/plugins/enable` — the operator's ack, then a normal activation. */
  async #pluginEnable(req: FastifyRequest, reply: FastifyReply, tenant: Tenant): Promise<void> {
    const runtime = this.#plugins;
    if (runtime === null) throw new AppError('SKW_E_PLT_TENANT_UNAVAILABLE', 'the plugin runtime is not attached to this process');
    const id = fieldsOf(req.body).plugin;
    if (id === undefined || !/^[a-z][a-z0-9]{1,19}$/.test(id)) {
      throw new AppError('SKW_E_PLT_REQUEST_INVALID', 'name a plugin id');
    }
    let flash: string;
    try {
      // `ackFailed`: the operator has read the notice and asked for the retry, which is the
      // one thing §13.3.6 says is required before a `failed` row may be retried.
      const result = await runtime.enable(tenant.key, id, { ackFailed: true });
      flash = `${id} enabled (activation ${result.activationSeq}, hooks: ${result.hooks.join(', ') || 'none'}).`;
    } catch (err) {
      flash = `${id} was not enabled: ${err instanceof Error ? err.message : String(err)}`;
    }
    reply.code(303).header('location', `/admin/t/${encodeURIComponent(tenant.key)}/plugins?result=${encodeURIComponent(flash)}`);
    reply.send();
  }

  /**
   * `POST /admin/t/<key>/plugins/uninstall` — §13.3.8's uninstall, on the one surface that can
   * see the site's in-flight requests.
   *
   * `skwctl plugin uninstall` runs in a **different process** and cannot: it archives and drops
   * without a drain, and says so. This route calls `runtime.uninstall()`, which drains first
   * (bounded at 5 s), disables, then archives and drops — the order §13.3.8 states — so a table
   * is never dropped under a request that is mid-dispatch.
   *
   * The busy refusal is re-thrown, not flashed: it is `SKW_E_PL_BUSY` with the plugin's name,
   * `sendError` maps it to 409, and a 303 with a sentence would let a scripted caller read
   * "uninstalled" out of a status code. Every other failure is a flash, because the screen is
   * where the operator is standing.
   */
  async #pluginUninstall(req: FastifyRequest, reply: FastifyReply, tenant: Tenant, session: SessionRecord): Promise<void> {
    const runtime = this.#plugins;
    if (runtime === null) throw new AppError('SKW_E_PLT_TENANT_UNAVAILABLE', 'the plugin runtime is not attached to this process');
    const id = fieldsOf(req.body).plugin;
    if (id === undefined || !/^[a-z][a-z0-9]{1,19}$/.test(id)) {
      throw new AppError('SKW_E_PLT_REQUEST_INVALID', 'name a plugin id');
    }
    let flash: string;
    try {
      const result = await runtime.uninstall(tenant.key, id);
      const user = this.auth.userById(session.userId);
      this.#audit({
        tenantId: tenant.id,
        userId: session.userId,
        label: user?.email ?? `user:${String(session.userId)}`,
        action: 'plugin.uninstall',
        targetKind: 'cms_plugin_installed',
        targetId: id,
        after: { tables: result.tables.map((t) => t.name), archive: result.archive_path, settings: result.settings },
        ip: req.socket.remoteAddress ?? '',
      });
      flash = `${id} uninstalled (tables: ${result.tables.map((t) => `${t.name}(${t.rows})`).join(',') || 'none'}; archive ${result.archive_path}).`;
    } catch (err) {
      if (err instanceof AppError && err.code === 'SKW_E_PL_BUSY') throw err;
      // The code is part of the message: an operator who mistypes an id must read
      // `SKW_E_PL_UNAVAILABLE`, not a sentence whose classification they have to guess.
      const detail = err instanceof AppError ? `${err.code}: ${err.message}` : String(err);
      flash = `${id} was not uninstalled: ${detail}`;
    }
    reply.code(303).header('location', `/admin/t/${encodeURIComponent(tenant.key)}/plugins?result=${encodeURIComponent(flash)}`);
    reply.send();
  }

  // --- session scoping ---------------------------------------------------

  #requireMethod(req: FastifyRequest, method: string): void {
    if (req.method !== method) throw new AppError('SKW_E_PLT_REQUEST_INVALID', `${method} is the method here`);
  }

  /**
   * D37: the session is looked for under **this Host's tenant's name**, and nowhere
   * else. A cookie minted for another tenant is not in this namespace, so it is not
   * a session here — before any row is read, before any tenant comparison runs.
   */
  #requireSession(req: FastifyRequest, tenant: Pick<Tenant, 'key'>): SessionRecord {
    const session = this.sessionFor(header(req, 'cookie'), tenant);
    if (session === null) {
      // Row 7, relocated: no session for this Host's tenant is "no tenant here".
      throw new AppError('SKW_E_PLT_TENANT_UNKNOWN', 'no session');
    }
    return session;
  }

  #assertTenantMatches(session: SessionRecord, tenant: Tenant): void {
    // D37: the Host chose the tenant and the session row must agree with it. This is
    // the gate that replaced §9.1 rule 1 — a session for acme presented on beta's
    // host is a valid session for the wrong surface, and the honest answer is the
    // same 404 a missing tenant gets. A fleet session (`tenant_id IS NULL`) is
    // refused here too: it has no tenant, and `/fleet` is its surface.
    if (session.tenantId === null || session.tenantId !== tenant.id) {
      throw new AppError('SKW_E_PLT_TENANT_UNKNOWN', 'no tenant here');
    }
  }

  // --- CSRF --------------------------------------------------------------

  /**
   * D37: the expected origin is the **request's own** origin — `https://` plus the
   * normalised `Host`.
   *
   * `SKW_ADMIN_ORIGIN` was the right answer while there was one admin hostname. There
   * are now as many admin origins as there are tenant hosts, so a single configured
   * string would either refuse every host but one or accept a host it does not serve.
   * The scheme is fixed at `https` and that is not a guess: the session cookie is
   * `Secure`, so a browser does not attach it to an `http` request at all — an
   * http-origin POST carries no session and cannot be an authenticated action. A
   * plain-http deployment therefore cannot log in, which is the correct answer for a
   * product whose every host has a certificate.
   *
   * Absent and mismatched are both `403 SKW_E_SEC_CSRF`, unchanged: the check never
   * accepted a missing Origin and does not start now.
   */
  #assertOrigin(req: FastifyRequest): void {
    // Cleartext is refused by name. The edge 301s http to https for everything except the
    // http-01 challenge, but a request that reaches the app over http anyway — a direct
    // proxy, a hand-written config — must be told what is actually wrong. It used to be
    // reported as 'origin does not match the host', which sent an operator hunting a CSRF
    // bug when the real answer was 'this page was served over http'.
    const proto = header(req, 'x-forwarded-proto');
    if (proto !== undefined && proto.toLowerCase() !== 'https') {
      throw new AppError('SKW_E_SEC_CSRF', `admin requires https: this request arrived over ${proto}`);
    }
    const origin = header(req, 'origin');
    const host = normaliseHost(req.headers.host ?? null);
    const expected = host === null ? null : `https://${host}`;
    if (origin === undefined || expected === null || origin !== expected) {
      throw new AppError('SKW_E_SEC_CSRF', 'origin does not match the host this request was sent to');
    }
  }

  #assertCsrf(req: FastifyRequest, session: SessionRecord, fromBody?: string | undefined): void {
    // The header is the mechanism (§9.1 names no header; `session.ts` fixes `X-CSRF-Token`).
    // A plain HTML form cannot set one, and the admin surface is JS-free by design, so the
    // same session-bound token is also accepted from the `csrf` body field. The token is
    // still an HMAC of this session id and the request still has to pass `#assertOrigin`.
    //
    // `fromBody` exists for the one body that is not a field map: a multipart request has no
    // `req.body` to read, and its `csrf` part is only available once the parts are consumed.
    const token = header(req, CSRF_HEADER) ?? fieldsOf(req.body).csrf ?? fromBody;
    if (!this.sessions.verifyCsrf(session, token ?? null)) {
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
      // O-29: the token is minted here, in admin, and bound to this tenant and this
      // normalised path. A published page has no preview URL — there is nothing to
      // preview, and the render path refuses the token for it anyway.
      const preview =
        row.status === 'draft'
          ? {
              url: `${String(row.path)}?${PREVIEW_PARAM}=${mintPreviewToken(tenant.key, String(row.path), this.#env.sessionKey)}`,
              expires_in_s: PREVIEW_TTL_MS / 1000,
            }
          : null;
      reply.header('cache-control', 'no-store');
      reply.send({ tenant: tenant.key, page: row, preview });
    } finally {
      db.close();
    }
  }

  // --- §7.1: the media library ---------------------------------------------

  /**
   * The search behind both the grid and `media.json`, on the render-read class.
   *
   * `q` is matched against the four strings a human might remember — the key, the filename,
   * the alt text and the kind — because "the logo" is not always a key. Every value is a bound
   * parameter (`LIKE ? ESCAPE '\'` with the wildcards in the query escaped), so a search box
   * is not a second SQL surface.
   */
  /**
   * Upload one file: the form on the media screen posts here.
   *
   * Everything that decides whether the bytes are acceptable already lives in
   * `app/assets/library.ts` — sniffing, the sha256 address, the quota, the immutable key. This
   * handler's job is the HTTP half: read the parts under the parser's limits, check the CSRF
   * token the form carried, name a bad key as a bad key, and answer with a redirect so a
   * refresh does not repost a 4 MB photo.
   */
  async #mediaUpload(req: FastifyRequest, reply: FastifyReply, tenant: Tenant, session: SessionRecord): Promise<void> {
    const fields: Record<string, string> = {};
    let file: { filename: string; mime: string; bytes: Buffer } | null = null;
    try {
      for await (const part of req.parts()) {
        if (part.type === 'file') {
          const filename = part.filename ?? '';
          const mime = part.mimetype ?? '';
          const bytes = await part.toBuffer();
          // The parser allows one file; a second would be a client bug, and taking the first
          // is the only choice that cannot surprise the operator.
          if (file === null) file = { filename, mime, bytes };
        } else {
          fields[part.fieldname] = String(part.value ?? '');
        }
      }
    } catch (err) {
      // `toBuffer()` throws when `fileSize` is exceeded; the answer names the limit rather
      // than surfacing a framework error as a 500.
      if (err instanceof Error && /file too large|exceeds the limit/i.test(err.message)) {
        throw new AppError('SKW_E_PLT_BODY_TOO_LARGE', `the upload is larger than ${UPLOAD_MAX_BYTES} bytes`, {
          limit: UPLOAD_MAX_BYTES,
        });
      }
      throw err;
    }

    // D28: the header, or the form field the no-JS form carries. Same token, same session.
    this.#assertCsrf(req, session, fields.csrf);

    if (file === null) throw new AppError('SKW_E_PLT_REQUEST_INVALID', 'choose a file to upload');
    const key = (fields.key ?? '').trim();
    // One rule, and the schema's CHECK is the same shape: lowercase, no leading separator, no
    // `..`. A key becomes a path segment in the public farm, so this is a path question.
    if (!/^[a-z0-9][a-z0-9._/-]{0,120}$/.test(key) || key.includes('..') || key.includes('//')) {
      throw new AppError('SKW_E_PLT_REQUEST_INVALID', 'the key must be lowercase letters, digits, dot, dash or slash', { key });
    }
    // The three classes the schema has: public, linked-private (reachable only through a page
    // that links it) and gated (needs a download code). Anything else is public.
    const access = fields.access === 'gated' ? 'gated' : fields.access === 'linked-private' ? 'linked-private' : 'public';

    const db = this.#siteWrite(tenant.key);
    try {
      const control = openAdminWrite(this.#controlPath, this.#env.dbBusyTimeoutMs);
      let quotaLimitBytes = 0;
      try {
        quotaLimitBytes = storageQuotaFor(control, tenant.key);
      } finally {
        control.close();
      }
      const result = await uploadAsset({
        db,
        contentRoot: this.#contentRoot,
        tenantKey: tenant.key,
        key,
        filename: file.filename,
        bytes: file.bytes,
        declaredMime: file.mime,
        accessClass: access,
        ...(fields.alt === undefined || fields.alt === '' ? {} : { altText: fields.alt }),
        ...(fields.caption === undefined || fields.caption === '' ? {} : { caption: fields.caption }),
        quotaLimitBytes,
        maxBytes: UPLOAD_MAX_BYTES,
        createdBy: session.userId,
      });
      // The thumbnail the library's grid draws. Best-effort by design: a file that sniffs as
      // something sharp cannot decode (an odd PDF, an SVG) is still a valid asset.
      try {
        await ensureVariants({ db, contentRoot: this.#contentRoot, assetId: result.asset.id });
      } catch {
        /* no thumbnail; the tile falls back to its kind icon */
      }
      const user = this.auth.userById(session.userId);
      this.#audit({
        tenantId: tenant.id,
        userId: session.userId,
        label: user?.email ?? `user ${session.userId}`,
        action: 'asset.upload',
        targetKind: 'cms_asset',
        targetId: String(result.asset.id),
        after: { key, bytes: result.asset.bytes, mime: result.asset.mime, reused: result.reused },
        ip: req.socket.remoteAddress ?? '',
      });
      reply.header('cache-control', 'no-store');
      this.#seeOther(reply, `/admin/t/${tenant.key}/media?uploaded=${encodeURIComponent(key)}`);
    } finally {
      db.close();
    }
  }

  #mediaRows(db: Database.Database, q: string): MediaRow[] {
    const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    return db
      .prepare(
        `SELECT a.id, a.key, a.filename, a.alt_text, a.kind, a.mime, a.width, a.height, a.bytes,
                a.sha256, a.access_class, a.storage_path,
                v.sha256 AS thumb_sha, v.width AS thumb_width, v.height AS thumb_height
           FROM cms_asset a
           LEFT JOIN cms_asset_variant v
                  ON v.asset_id = a.id AND v.label = 'thumb' AND v.format = 'webp'
          WHERE (@q = '' OR a.key LIKE @like ESCAPE '\\' OR a.filename LIKE @like ESCAPE '\\'
                 OR ifnull(a.alt_text, '') LIKE @like ESCAPE '\\' OR a.kind = @q)
          ORDER BY a.created_at DESC, a.key
          LIMIT 200`,
      )
      .all({ q, like }) as MediaRow[];
  }

  /** The picker's targets: a column name, and nothing else. */
  static readonly PICK_TARGET = /^[a-z][a-z0-9_]{0,39}$/;

  #mediaLibrary(req: FastifyRequest, reply: FastifyReply, tenant: Tenant, session: SessionRecord): void {
    const params = new URL(req.url, 'http://admin.invalid').searchParams;
    const q = (params.get('q') ?? '').slice(0, 100);
    const pick = params.get('pick') ?? '';
    // S8c: the key the upload route just accepted, echoed once. It is a query parameter rather
    // than a flash cookie because the answer to "did that upload work?" must survive a refresh.
    const uploadedKey = params.get('uploaded');
    const uploaded = uploadedKey === null ? undefined : uploadedKey.slice(0, 121);
    const picked = params.get('key') ?? '';
    const pickTarget = AdminSurface.PICK_TARGET.test(pick) ? pick : '';
    const db = this.#siteDb(tenant.key);
    let rows: MediaRow[];
    let assets: MediaAsset[];
    let counts: { total: number; public: number; gated: number; unused: number; totalBytes: number };
    try {
      rows = this.#mediaRows(db, q);
      const ids = rows.map((row) => Number(row.id));
      const usage = this.#assetUsage(db, ids);
      const blocked = this.#assetBlockers(db, ids);
      assets = rows.map((row) => {
        const usedOn = usage.get(Number(row.id)) ?? [];
        const blocker = blocked.get(Number(row.id)) ?? null;
        // The delete trigger's own condition: a page link, a bundle item or a code.
        const deletable = usedOn.length === 0 && blocker === null;
        const thumb =
          row.thumb_sha === null || row.access_class === 'gated'
            ? null
            : `/media/${row.key}@thumb.webp?v=${String(row.thumb_sha).slice(0, 8)}`;
        return {
          id: Number(row.id),
          key: String(row.key),
          filename: String(row.filename),
          alt: row.alt_text === null ? null : String(row.alt_text),
          kind: String(row.kind),
          mime: String(row.mime),
          width: row.width === null ? null : Number(row.width),
          height: row.height === null ? null : Number(row.height),
          bytes: Number(row.bytes),
          access: String(row.access_class),
          thumb:
            row.thumb_sha === null
              ? null
              : { width: Number(row.thumb_width ?? 0), height: Number(row.thumb_height ?? 0) },
          thumbUrl: thumb,
          usedOn,
          deletable,
          blockedBy: usedOn.length > 0 ? 'pages' : blocker,
        };
      });
      counts = this.#assetCounts(db);
    } finally {
      db.close();
    }

    // The picker writes the key into a field. A gated asset is refused here for the same
    // reason `site.asset()` returns no URL for one: a key that renders a 404 is not a pick.
    const pickedRow = picked === '' ? undefined : rows.find((r) => r.key === picked);
    const field =
      pickTarget !== '' && pickedRow !== undefined && pickedRow.access_class !== 'gated'
        ? { column: pickTarget, key: String(pickedRow.key) }
        : undefined;
    const notices = this.#plugins === null ? 0 : this.#plugins.noticesFor(tenant.key).length;
    reply.header('cache-control', 'no-store');
    reply.type('text/html; charset=utf-8').send(
      mediaLibraryScreen({
        tenant: { key: tenant.key, label: tenant.key },
        user: this.#actorOf(session),
        assets,
        counts,
        q,
        ...(field === undefined ? {} : { pick: field }),
        notices,
        csrf: this.sessions.csrfToken(session),
        uploaded,
      }),
    );
  }

  /**
   * Which pages use each asset, from `cms_asset_link` — the usage graph, not a scan of
   * `body_html` at render time, so the tile and the delete guard cannot disagree.
   */
  #assetUsage(db: Database.Database, ids: readonly number[]): Map<number, { id: number; title: string }[]> {
    const out = new Map<number, { id: number; title: string }[]>();
    if (ids.length === 0) return out;
    const holes = ids.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT l.asset_id, p.id AS page_id, p.title
           FROM cms_asset_link l
           JOIN cms_page p ON p.id = l.owner_id
          WHERE l.owner_kind = 'page' AND l.asset_id IN (${holes})
          ORDER BY p.path`,
      )
      .all(...ids) as { asset_id: number; page_id: number; title: string }[];
    for (const row of rows) {
      const list = out.get(Number(row.asset_id)) ?? [];
      list.push({ id: Number(row.page_id), title: String(row.title) });
      out.set(Number(row.asset_id), list);
    }
    return out;
  }

  /** The other two arms of `trg_cms_asset_delete_guard`: a bundle item, or a code. */
  #assetBlockers(db: Database.Database, ids: readonly number[]): Map<number, 'bundle' | 'codes'> {
    const out = new Map<number, 'bundle' | 'codes'>();
    if (ids.length === 0) return out;
    const holes = ids.map(() => '?').join(',');
    const bundles = db
      .prepare(`SELECT DISTINCT asset_id FROM cms_asset_bundle_item WHERE asset_id IN (${holes})`)
      .all(...ids) as { asset_id: number }[];
    for (const row of bundles) out.set(Number(row.asset_id), 'bundle');
    const codes = db
      .prepare(`SELECT DISTINCT asset_id FROM cms_download_code WHERE asset_id IN (${holes})`)
      .all(...ids) as { asset_id: number }[];
    for (const row of codes) if (!out.has(Number(row.asset_id))) out.set(Number(row.asset_id), 'codes');
    return out;
  }

  /** The header's counts, over every asset rather than the current search. */
  #assetCounts(db: Database.Database): { total: number; public: number; gated: number; unused: number; totalBytes: number } {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(CASE WHEN access_class = 'public' THEN 1 ELSE 0 END), 0) AS public,
                COALESCE(SUM(CASE WHEN access_class = 'gated' THEN 1 ELSE 0 END), 0) AS gated,
                COALESCE(SUM(CASE WHEN NOT EXISTS (SELECT 1 FROM cms_asset_link l WHERE l.asset_id = a.id)
                                  THEN 1 ELSE 0 END), 0) AS unused,
                COALESCE(SUM(bytes), 0) AS totalBytes
           FROM cms_asset a`,
      )
      .get() as { total: number; public: number; gated: number; unused: number; totalBytes: number };
    return {
      total: Number(row.total),
      public: Number(row.public),
      gated: Number(row.gated),
      unused: Number(row.unused),
      totalBytes: Number(row.totalBytes),
    };
  }

  // --- §10.1–§10.3 (S4a): the editor ----------------------------------------

  /**
   * Publish one page: draft -> live. The refusal for "nothing to publish" is a 400 with a code,
   * not a silent `ok`, because an operator who presses Publish on a page with no pending changes
   * has either lost their work or misread the screen, and both deserve to be told.
   */
  #editorPublish(req: FastifyRequest, reply: FastifyReply, tenant: Tenant, session: SessionRecord): void {
    const body = (req.body ?? {}) as { id?: unknown };
    const raw = fieldsOf(req.body).id ?? (typeof body.id === 'number' ? String(body.id) : undefined);
    const id = Number(raw);
    if (raw === undefined || !Number.isInteger(id) || id <= 0) {
      throw new AppError('SKW_E_PLT_REQUEST_INVALID', 'a page id is required');
    }
    const db = this.#siteWrite(tenant.key);
    try {
      const actor = this.#actor(session);
      const result = publishPage({ db, registry: loadRegistry(this.#schemaDir), pageId: id, actorId: actor.userId });
      // `no-store` is already set for every admin response, but this one answers with the state a
      // browser will now show; a cached copy would say "draft" on a page that is live.
      reply.header('cache-control', 'no-store');
      reply.send({ ok: true, page: result });
    } finally {
      db.close();
    }
  }

  /**
   * The editor page. `?page=<id>` opens a stored document; no id opens a blank one.
   *
   * The refusal happens **here**, before GrapesJS is handed the body: `loadForEditor()`
   * runs the same validator the save path runs, so a page that names an unregistered
   * `data-gjs-type` is `422 SKW_E_RT_COMPONENT_UNKNOWN` with the type in `detail` — and
   * not a canvas in which the block has already degraded to a div.
   */
  #editorPage(req: FastifyRequest, reply: FastifyReply, tenant: Tenant, session: SessionRecord): void {
    const registry = loadRegistry(this.#schemaDir);
    const raw = new URL(req.url, 'http://admin.invalid').searchParams.get('page');
    const db = this.#siteDb(tenant.key);
    try {
      const pageRow =
        raw === null
          ? null
          : ((): { record: ReturnType<typeof loadForEditor>; css: string } => {
              if (!PAGE_ID_RE.test(raw)) throw new AppError('SKW_E_PLT_REQUEST_INVALID', 'not a page id');
              const record = loadForEditor(db, registry, Number(raw));
              return { record, css: record.bodyCss };
            })();
      const body = renderEditorPage({
        tenant: tenant.key,
        page:
          pageRow === null
            ? null
            : {
                id: pageRow.record.id,
                path: pageRow.record.path,
                title: pageRow.record.title,
                status: pageRow.record.status,
                template: pageRow.record.template,
                managedBy: pageRow.record.managedBy,
                bodyHtml: pageRow.record.bodyHtml,
                rev: pageRow.record.rev,
                draft: pageRow.record.draft,
              },
        registry,
        csrf: this.sessions.csrfToken(session),
        bodyCss: pageRow?.css ?? registryCss(registry),
      });
      reply.header('cache-control', 'no-store');
      reply.type('text/html; charset=utf-8').send(body);
    } finally {
      db.close();
    }
  }

  /**
   * Save. The body is JSON (`{id?, path, title, template, html, css}`); `cms_page` is
   * written through `savePage()`, which validates, canonicalises, validates the canonical
   * bytes and writes the revision row in one transaction.
   */
  async #editorSave(req: FastifyRequest, reply: FastifyReply, tenant: Tenant, session: SessionRecord): Promise<void> {
    const registry = loadRegistry(this.#schemaDir);
    const fields = fieldsOf(req.body);
    // `html` and `id` are read from the body rather than `fieldsOf`: that helper keeps only
    // strings, and the boot script sends `id` as a number. Reading it as a string silently
    // turned every re-save into a create, which the UNIQUE on `cms_page.path` then refused.
    const body = (req.body ?? {}) as { html?: unknown; id?: unknown; components?: unknown };
    const html = body.html;
    if (typeof html !== 'string') throw new AppError('SKW_E_PLT_REQUEST_INVALID', 'html is required');
    // F2(b): the component inventory the canvas held. Absent is allowed (a client that does
    // not run the canvas is not asked to invent one); present it must be type names, because
    // the save path compares it with the locks in the bytes.
    const components = body.components;
    if (
      components !== undefined &&
      (!Array.isArray(components) || components.some((entry) => typeof entry !== 'string'))
    ) {
      throw new AppError('SKW_E_PLT_REQUEST_INVALID', 'components must be an array of component type names');
    }
    const path = fields.path ?? '/';
    const title = fields.title ?? 'Untitled';
    const rawId = typeof body.id === 'number' ? String(body.id) : body.id;
    const id = rawId === undefined || rawId === '' || rawId === null ? null : Number(rawId);
    if (id !== null && !Number.isInteger(id)) throw new AppError('SKW_E_PLT_REQUEST_INVALID', 'id must be an integer');

    const db = this.#siteWrite(tenant.key);
    try {
      const result = await savePage({
        db,
        registry,
        pageId: id,
        path,
        slug: fields.slug ?? slugOf(path),
        title,
        template: fields.template ?? 'page',
        status: fields.status ?? 'draft',
        html,
        ...(Array.isArray(components) ? { components: components as string[] } : {}),
        css: fields.css ?? '',
        actorId: session.userId,
      });
      const user = this.auth.userById(session.userId);
      this.#audit({
        tenantId: tenant.id,
        userId: session.userId,
        label: user?.email ?? `user ${session.userId}`,
        action: result.created ? 'page.create' : 'page.update',
        targetKind: 'cms_page',
        targetId: String(result.id),
        ip: req.socket.remoteAddress ?? '',
      });
      reply.header('cache-control', 'no-store');
      reply.send({
        tenant: tenant.key,
        id: result.id,
        created: result.created,
        rev: result.rev,
        bodyHtml: result.bodyHtml,
        bodySha: result.bodySha,
        items: result.items,
      });
    } finally {
      db.close();
    }
  }

  /** The picker: `{html, type, prop, field, key}` -> the document with `data-asset-key` set. */
  #editorPick(req: FastifyRequest, reply: FastifyReply, tenant: Tenant): void {
    const fields = fieldsOf(req.body);
    const html = (req.body as { html?: unknown } | undefined)?.html;
    if (typeof html !== 'string') throw new AppError('SKW_E_PLT_REQUEST_INVALID', 'html is required');
    const type = fields.type;
    const key = fields.key;
    if (type === undefined || key === undefined) {
      throw new AppError('SKW_E_PLT_REQUEST_INVALID', 'type and key are required');
    }
    const db = this.#siteDb(tenant.key);
    try {
      // The key must name a row: a picker that accepted an arbitrary string would let a
      // body name an asset that does not exist, and the render would fail at 503.
      const chosen = pickAsset(db, key);
      const field = fields.field === 'asset' || fields.field === 'href' ? fields.field : 'text';
      const target: { type: string; field: 'asset' | 'text' | 'href'; prop?: string } = { type, field };
      if (fields.prop !== undefined) target.prop = fields.prop;
      const next = applyPick(html, target, chosen.key);
      reply.header('cache-control', 'no-store');
      reply.send({ tenant: tenant.key, key: chosen.key, previewUrl: chosen.previewUrl, html: next });
    } finally {
      db.close();
    }
  }

  /** The picker's list — keys and canvas-only thumbnails; never a URL a body may store. */
  #editorMedia(reply: FastifyReply, tenant: Tenant): void {
    const db = this.#siteDb(tenant.key);
    try {
      reply.header('cache-control', 'no-store');
      reply.send({ tenant: tenant.key, assets: mediaChoices(db) });
    } finally {
      db.close();
    }
  }

  /** The vendored editor bundle, its stylesheet, and the boot script (a constant). */
  #editorAsset(reply: FastifyReply, action: string): void {
    const repoRoot = dirname(this.#schemaDir);
    if (action === 'editor/editor.js') {
      reply.header('cache-control', 'no-store');
      reply.type('text/javascript; charset=utf-8').send(EDITOR_BOOT_JS);
      return;
    }
    if (action === 'editor/grapesjs.css') {
      reply.header('cache-control', 'public, max-age=86400');
      reply.type('text/css; charset=utf-8').send(grapesJsCss(repoRoot));
      return;
    }
    reply.header('cache-control', 'public, max-age=86400');
    reply.type('text/javascript; charset=utf-8').send(grapesJsBundle(repoRoot));
  }

  #mediaJson(req: FastifyRequest, reply: FastifyReply, tenant: Tenant): void {
    const q = (new URL(req.url, 'http://admin.invalid').searchParams.get('q') ?? '').slice(0, 100);
    const db = this.#siteDb(tenant.key);
    try {
      const rows = this.#mediaRows(db, q).map((row) => ({
        key: row.key,
        filename: row.filename,
        kind: row.kind,
        alt: row.alt_text,
        access_class: row.access_class,
        width: row.width,
        height: row.height,
        bytes: row.bytes,
        sha256: row.sha256,
        url: row.access_class === 'gated' ? null : `/media/${row.key}.${extOfMime(row.mime)}?v=${row.sha256.slice(0, 8)}`,
        thumb_url:
          row.access_class === 'gated' || row.thumb_sha === null
            ? null
            : `/media/${row.key}@thumb.webp?v=${row.thumb_sha.slice(0, 8)}`,
        thumb: row.thumb_sha === null ? null : { sha256: row.thumb_sha, width: row.thumb_width, height: row.thumb_height },
      }));
      reply.header('cache-control', 'no-store');
      reply.send({ tenant: tenant.key, q, assets: rows });
    } finally {
      db.close();
    }
  }

  /**
   * §7.6's screen, and the audit rows it writes. The audit is in `control.db` (the
   * same table the rest of the admin surface writes): "who issued a code for which
   * asset, and when" is exactly the question a dispute asks.
   */
  async #codesRoute(
    req: FastifyRequest,
    reply: FastifyReply,
    tenant: Tenant,
    action: string,
  ): Promise<void> {
    const session = this.#requireSession(req, tenant);
    const db = this.#siteWrite(tenant.key);
    try {
      const out = await handleCodes(
        {
          db,
          tenantKey: tenant.key,
          contentRoot: this.#contentRoot,
          csrf: this.sessions.csrfToken(session),
          atMs: Date.now(),
        },
        action,
        fieldsOf(req.body),
      );
      if (req.method === 'POST') {
        const user = this.auth.userById(session.userId);
        this.#audit({
          tenantId: tenant.id,
          userId: session.userId,
          label: user?.email ?? `user ${session.userId}`,
          action: action.startsWith('codes/new') || action.startsWith('codes/csv') ? 'code.issue' : `code.${action.split('/').pop() ?? 'update'}`,
          targetKind: 'cms_download_code',
          targetId: /^codes\/(\d+)\//.exec(action)?.[1] ?? 'batch',
          ip: req.socket.remoteAddress ?? '',
        });
      }
      reply.header('cache-control', 'no-store');
      reply.code(out.status).type('text/html; charset=utf-8').send(out.html);
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

  /** §2.2's `admin-write`: the only class this file writes through. */
  #siteWrite(key: string): Database.Database {
    const file = join(this.#env.dataDir, 'tenants', key, 'site.db');
    try {
      return openAdminWrite(file, this.#env.dbBusyTimeoutMs);
    } catch {
      throw new AppError('SKW_E_PLT_TENANT_UNAVAILABLE', 'tenant database is not writable');
    }
  }

  // --- §9.3: the CRUD write path ------------------------------------------

  #actor(session: SessionRecord): Actor {
    const user = this.auth.userById(session.userId);
    if (user === null) throw new AppError('SKW_E_PLT_TENANT_UNKNOWN', 'no session');
    return { userId: user.id, label: user.email };
  }

  // --- S2e: the Data Source registry (§6.1) -------------------------------

  /**
   * The registry as the operator sees it: what is published, at what cost, by
   * whom. `cost_plan` is not returned — it can be long and the publish response
   * already carries it once.
   */
  #sourcesList(reply: FastifyReply, tenant: Tenant): void {
    const db = this.#siteDb(tenant.key);
    try {
      reply.header('cache-control', 'no-store');
      reply.send({
        tenant: tenant.key,
        sources: listSources(db).map((row) => ({
          key: row.key,
          kind: row.kind,
          is_public: row.is_public === 1,
          ttl_s: row.ttl_s,
          published_at: row.published_at,
          published_by: row.published_by,
          cost_ms_max: row.cost_ms_max,
          cost_rows: row.cost_rows,
        })),
      });
    } finally {
      db.close();
    }
  }

  /**
   * The only caller of the publish gate in the app. The route does no validation
   * of its own: `publishSource` refuses a `function` kind before a connection
   * exists, and the refusals propagate as §4.3's taxonomy body, exactly like the
   * builder's apply.
   */
  #sourceWrite(req: FastifyRequest, reply: FastifyReply, tenant: Tenant, session: SessionRecord, draft: boolean): void {
    const body = req.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new AppError('SKW_E_PLT_REQUEST_INVALID', 'a source request is a JSON object');
    }
    const raw = body as Record<string, unknown>;
    const input: SourceInput = {
      key: typeof raw.key === 'string' ? raw.key : '',
      kind: typeof raw.kind === 'string' ? raw.kind : '',
      spec: raw.spec ?? {},
      isPublic: raw.is_public === true,
      ...(Array.isArray(raw.params) ? { params: raw.params as NonNullable<SourceInput['params']> } : {}),
      ...(typeof raw.ttl_s === 'number' ? { ttlS: raw.ttl_s } : {}),
      ...(raw.aggregate === undefined || raw.aggregate === null ? {} : { aggregate: raw.aggregate as NonNullable<SourceInput['aggregate']> }),
      ...(Array.isArray(raw.group_by) ? { groupBy: raw.group_by as string[] } : {}),
    };
    const file = join(this.#env.dataDir, 'tenants', tenant.key, 'site.db');
    const actor = this.#actor(session);
    const report = draft ? saveSourceDraft(file, input, actor) : publishSource(file, input, actor);
    reply.header('cache-control', 'no-store');
    reply.send(draft ? { tenant: tenant.key, draft: report } : { tenant: tenant.key, published: report });
  }

  #tablesIndex(reply: FastifyReply, tenant: Tenant, session: SessionRecord): void {
    const db = this.#siteDb(tenant.key);
    try {
      // `listTables` is a read, so it runs on the render-read class; every write
      // below opens its own `admin-write` handle and closes it.
      const tables = listTablesOf(db);
      const items = tables
        .map((t) => `<li><a href="/admin/t/${esc(tenant.key)}/tables/${esc(t)}">${esc(t)}</a></li>`)
        .join('\n');
      reply.type('text/html; charset=utf-8').send(
        page(
          `Skunkworks — ${tenant.key} — tables`,
          `${crumbs([
            { label: 'Pages', href: `/admin/t/${tenant.key}/` },
            { label: 'Tables' },
          ])}<h1>${esc(tenant.key)} — tables</h1>
<p>§9.3: row data in <code>cms_*</code> is editable through generated forms; <code>cms_audit</code> is the record of those writes and is not one of them.</p>
<ul data-role="tables">
${items}
</ul>`,
          this.#chrome(tenant, session),
        ),
      );
    } finally {
      db.close();
    }
  }

  /**
   * The screen a loaded plugin declared for this path, if any. Looked up in the registry — the
   * one source of truth `declaredScreenLinks()` also reads, so a screen in the menu and a screen
   * that answers are the same object.
   */
  #pluginScreen(tenant: Tenant, action: string): { path: string; table: string; title: string } | undefined {
    const runtime = this.#plugins;
    if (runtime === null) return undefined;
    for (const entry of runtime.registry.plugins(tenant.key)) {
      for (const screen of entry.screens.values()) {
        const path = screen.path.replace(/^\/+/, '');
        if (action === path || action.startsWith(`${path}/`)) return screen;
      }
    }
    return undefined;
  }

  async #pluginScreenRoute(
    req: FastifyRequest,
    reply: FastifyReply,
    session: SessionRecord,
    tenant: Tenant,
    screen: { path: string; table: string; title: string },
    rest: string,
  ): Promise<void> {
    const parts = rest === '' ? [] : rest.split('/').filter((p) => p !== '');
    // Writes go through the same guard as every other admin write: Origin, then CSRF.
    if (req.method !== 'GET') this.#writeGuard(req, session);
    if (parts.length === 0) {
      if (req.method === 'POST') {
        const created = this.#write(tenant, (db) => createRow(db, screen.table, fieldsOf(req.body), this.#actor(session)));
        reply.code(303).header('location', `/admin/t/${tenant.key}/${screen.path.replace(/^\/+/, '')}/${encodeURIComponent(created.id)}`).send('');
        return;
      }
      this.#rowsPage(reply, tenant, screen.table, session, screen.title, `/admin/t/${tenant.key}/${screen.path.replace(/^\/+/, '')}`);
      return;
    }
    if (parts.length === 1 && parts[0] === 'new') {
      this.#requireMethod(req, 'GET');
      this.#formPage(reply, tenant, screen.table, null, session, screen.title);
      return;
    }
    if (parts.length === 1) {
      const id = parts[0] as string;
      if (req.method === 'POST') {
        this.#write(tenant, (db) => updateRow(db, screen.table, id, fieldsOf(req.body), this.#actor(session)));
        reply.code(303).header('location', `/admin/t/${tenant.key}/${screen.path.replace(/^\/+/, '')}/${encodeURIComponent(id)}`).send('');
        return;
      }
      this.#formPage(reply, tenant, screen.table, id, session, screen.title);
      return;
    }
    throw new AppError('SKW_E_PLT_REQUEST_INVALID', 'no such admin action');
  }

  /** The shell's chrome, for the screens that pass it explicitly. */
  #chrome(tenant: Tenant, session: SessionRecord): { tenant: Tenant; user: { email: string; role: string } | null; active: 'none'; notices: number } {
    return {
      tenant,
      user: this.#actorOf(session),
      active: 'none',
      notices: this.#plugins === null ? 0 : this.#plugins.noticesFor(tenant.key).length,
    };
  }

  async #tableRoute(req: FastifyRequest, reply: FastifyReply, session: SessionRecord, tenant: Tenant, rest: string): Promise<void> {
    let parts: string[];
    try {
      parts = rest.split('/').map((s) => decodeURIComponent(s));
    } catch {
      // A malformed percent-escape is a bad request, not a 500.
      throw new AppError('SKW_E_PLT_REQUEST_INVALID', 'no such admin action');
    }
    if (parts.length === 0 || parts.length > 3 || parts.some((p) => p === '')) {
      throw new AppError('SKW_E_PLT_REQUEST_INVALID', 'no such admin action');
    }
    const table = parts[0] as string;
    const second = parts[1];
    const third = parts[2];
    const base = `/admin/t/${tenant.key}/tables/${table}`;

    if (parts.length === 1) {
      if (req.method === 'GET') {
        this.#rowsPage(reply, tenant, table, session);
        return;
      }
      if (req.method === 'POST') {
        this.#writeGuard(req, session);
        const result = this.#write(tenant, (db) => createRow(db, table, fieldsOf(req.body), this.#actor(session)));
        reply.code(303).header('location', `${base}/${encodeURIComponent(result.id)}`).send('');
        return;
      }
      throw new AppError('SKW_E_PLT_REQUEST_INVALID', 'GET or POST is the method here');
    }

    if (parts.length === 2 && second === 'new') {
      this.#requireMethod(req, 'GET');
      this.#formPage(reply, tenant, table, null, session);
      return;
    }

    if (parts.length === 2 && second !== undefined) {
      if (req.method === 'GET') {
        this.#formPage(reply, tenant, table, second, session);
        return;
      }
      if (req.method === 'POST') {
        this.#writeGuard(req, session);
        this.#write(tenant, (db) => updateRow(db, table, second, fieldsOf(req.body), this.#actor(session)));
        reply.code(303).header('location', `${base}/${encodeURIComponent(second)}`).send('');
        return;
      }
      throw new AppError('SKW_E_PLT_REQUEST_INVALID', 'GET or POST is the method here');
    }

    if (parts.length === 3 && third === 'delete') {
      this.#requireMethod(req, 'POST');
      this.#writeGuard(req, session);
      this.#write(tenant, (db) => deleteRow(db, table, second as string, this.#actor(session)));
      reply.code(303).header('location', base).send('');
      return;
    }

    throw new AppError('SKW_E_PLT_REQUEST_INVALID', 'no such admin action');
  }

  /** Origin then CSRF — the order every other non-GET in this file uses. */
  #writeGuard(req: FastifyRequest, session: SessionRecord): void {
    this.#assertOrigin(req);
    this.#assertCsrf(req, session);
  }

  /**
   * One write, one `admin-write` handle, closed in a `finally`. The handle is
   * never pooled and never reused: §9.4's "discarded, not returned to the pool"
   * is the same rule for DDL, and a write handle that outlived its statement is
   * state a permission boundary cannot afford.
   */
  #write<T>(tenant: Tenant, fn: (db: Database.Database) => T): T {
    const db = this.#siteWrite(tenant.key);
    try {
      return fn(db);
    } catch (err) {
      // A refused write is reported with its taxonomy code — never a 500, and
      // never retried.
      throw taxonomy(err);
    } finally {
      db.close();
    }
  }

  #rowsPage(reply: FastifyReply, tenant: Tenant, table: string, session: SessionRecord, label?: string, pathBase?: string): void {
    const db = this.#siteDb(tenant.key);
    try {
      const info = describeTable(db, table);
      const rows = listRows(db, table, 100);
      // Where this table's rows live. A core table is under `/tables/`; a plugin's screen is at
      // its own path, and linking a plugin's rows back into the Tables section would move the
      // operator into a section that does not list them.
      const base = pathBase ?? `/admin/t/${tenant.key}/tables/${table}`;
      const shown = info.columns.filter((c) => c.editable).slice(0, 6).map((c) => c.name);
      const head = [info.pk, ...shown.filter((c) => c !== info.pk)].map((c) => `<th>${esc(c)}</th>`).join('');
      const body = rows
        .map((row) => {
          const cells = [String(row[info.pk]), ...shown.filter((c) => c !== info.pk)].map((c) => `<td>${esc(String(row[c] ?? ''))}</td>`).join('');
          return `<tr data-id="${esc(String(row[info.pk]))}">${cells}<td><a href="${esc(base)}/${encodeURIComponent(String(row[info.pk]))}">edit</a></td></tr>`;
        })
        .join('\n');
      reply.type('text/html; charset=utf-8').send(
        page(
          `Skunkworks — ${tenant.key} — ${table}`,
          `${crumbs([
            { label: 'Pages', href: `/admin/t/${tenant.key}/` },
            // A plugin's screen is not under Tables: its trail names the package's own screen
            // instead of a section it does not belong to.
            ...(label === undefined
              ? [{ label: 'Tables', href: `/admin/t/${tenant.key}/tables` }, { label: table }]
              : [{ label }]),
          ])}<h1>${esc(label ?? `${tenant.key} — ${table}`)}</h1>
<p><a class="btn btn--sm" href="${esc(base)}/new">New row</a></p>
<table data-role="rows"><thead><tr>${head}<th></th></tr></thead><tbody>
${body}
</tbody></table>`,
          this.#chrome(tenant, session),
        ),
      );
    } finally {
      db.close();
    }
  }

  #formPage(reply: FastifyReply, tenant: Tenant, table: string, id: string | null, session: SessionRecord, label?: string): void {
    const db = this.#siteDb(tenant.key);
    try {
      const info = describeTable(db, table);
      const row = id === null ? undefined : selectRow(db, table, id);
      if (id !== null && row === undefined) throw new AppError('SKW_E_RT_PAGE_NOT_FOUND', 'no such row');
      reply.type('text/html; charset=utf-8').send(
        page(
          `Skunkworks — ${tenant.key} — ${table}${id === null ? ' — new' : ` — ${id}`}`,
          `${crumbs([
            { label: 'Pages', href: `/admin/t/${tenant.key}/` },
            ...(label === undefined
              ? [{ label: 'Tables', href: `/admin/t/${tenant.key}/tables` }]
              : []),
            { label: label ?? info.name, href: `/admin/t/${tenant.key}/tables/${encodeURIComponent(info.name)}` },
            { label: id === null ? 'New row' : `Row ${id}` },
          ])}${this.#formHtml(tenant, info, row ?? null, id, session)}`,
          this.#chrome(tenant, session),
        ),
      );
    } finally {
      db.close();
    }
  }

  #formHtml(tenant: Tenant, info: TableInfo, row: Record<string, unknown> | null, id: string | null, session: SessionRecord): string {
    const back = `<p class="formback"><a class="btn btn--sm" href="/admin/t/${esc(tenant.key)}/tables/${esc(info.name)}">← Back to ${esc(info.name)}</a></p>`;
    const action = id === null
      ? `/admin/t/${esc(tenant.key)}/tables/${esc(info.name)}`
      : `/admin/t/${esc(tenant.key)}/tables/${esc(info.name)}/${encodeURIComponent(id)}`;
    const controls = info.columns
      .filter((c) => c.editable)
      .map((c) => {
        const value = row === null ? '' : row[c.name] === null || row[c.name] === undefined ? '' : String(row[c.name]);
        const required = c.notNull && !c.hasDefault ? ' required' : '';
        const label = `<label for="f_${esc(c.name)}">${esc(c.name)} <small>${esc(c.type)}${c.notNull ? ' NOT NULL' : ''}</small></label>`;
        if (c.input === 'textarea') {
          return `${label}<textarea id="f_${esc(c.name)}" name="${esc(c.name)}" rows="6"${required}>${esc(value)}</textarea>`;
        }
        return `${label}<input id="f_${esc(c.name)}" name="${esc(c.name)}" type="${c.input === 'number' ? 'number' : 'text'}" value="${esc(value)}"${required}>`;
      })
      .join('\n');

    const readonly = info.columns
      .filter((c) => !c.editable)
      .map((c) => `<dt>${esc(c.name)}</dt><dd>${row === null ? '' : esc(String(row[c.name] ?? ''))} <small>${esc(c.reason ?? '')}</small></dd>`)
      .join('\n');

    const csrf = this.sessions.csrfToken(session);
    const deletes = id === null
      ? ''
      : `<form method="post" action="${action}/delete" data-csrf-token="${esc(csrf)}"><button type="submit">Delete</button></form>`;

    return `${back}<h1>${esc(tenant.key)} — ${esc(info.name)}${id === null ? ' — new' : ` — ${esc(id)}`}</h1>
<form method="post" action="${action}" data-csrf-token="${esc(csrf)}">
${controls}
<button type="submit">Save</button>
</form>
${deletes}
<dl data-role="readonly">
${readonly}
</dl>
<noscript><p>A write needs the <code>X-CSRF-Token</code> header (D28), so this form submits with JavaScript on.</p></noscript>
<script>
// D28: the CSRF token is a header and there is no form-field alternative. The
// form therefore posts through fetch, which is the only way a browser can set it.
for (const form of document.querySelectorAll('form[data-csrf-token]')) {
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    fetch(form.action, {
      method: 'POST',
      headers: { 'X-CSRF-Token': form.dataset.csrfToken, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(new FormData(form)),
      redirect: 'follow',
    }).then((res) => { window.location.href = res.url; });
  });
}
</script>`;
  }

  // --- §9.4: the table builder, scaffold only ------------------------------

  /**
   * The form. §9.4's `SKW_SCHEMA_EDIT=off` is handled by the router: the paths do
   * not exist, so there is nothing to disable and no link to hide.
   */
  #builderForm(reply: FastifyReply, tenant: Tenant, session: SessionRecord): void {
    const csrf = this.sessions.csrfToken(session);
    reply.type('text/html; charset=utf-8').send(
      page(
        `Skunkworks — ${tenant.key} — table builder`,
        `<h1>${esc(tenant.key)} — table builder</h1>
<p>§4.4: the AST is the only input; <code>create_table</code> names a <code>u_*</code> table and its columns.
The foreign key is derived from the column type, never supplied.</p>
<form method="post" action="/admin/t/${esc(tenant.key)}/builder/preview" data-csrf-token="${esc(csrf)}">
  <label for="table">Table <small>u_&lt;name&gt;</small></label>
  <input id="table" name="table" type="text" value="people" required>
  <label for="columns">Columns <small>one per line: &lt;name&gt; &lt;TYPE&gt; [NOT NULL] [DEFAULT &lt;literal&gt;] [RELATION=u_&lt;table&gt;]</small></label>
  <textarea id="columns" name="columns" rows="10" required>full_name TEXT NOT NULL
age INTEGER
active BOOLEAN NOT NULL DEFAULT true</textarea>
  <button type="submit">Preview DDL</button>
</form>
<p>Types: TEXT, INTEGER, REAL, BLOB, NUMERIC, BOOLEAN, DATE, ASSET, PAGE, RELATION.</p>
<p><a href="/admin/t/${esc(tenant.key)}/">Back</a></p>
<script>
for (const form of document.querySelectorAll('form[data-csrf-token]')) {
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    fetch(form.action, {
      method: 'POST',
      headers: { 'X-CSRF-Token': form.dataset.csrfToken, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(new FormData(form)),
      redirect: 'follow',
    }).then((res) => { window.location.href = res.url; });
  });
}
</script>`,
      ),
    );
  }

  /**
   * The preview: the emitter's own statements, the registry row they would be
   * written beside, and nothing executed. S2d owns `BEGIN IMMEDIATE`, the ≤8
   * statement cap, the postcondition and the discarded connection; this route has
   * no handle open at all, which is what makes "not executed" a fact rather than a
   * promise.
   */
  #builderPreview(req: FastifyRequest, reply: FastifyReply, tenant: Tenant, session: SessionRecord): void {
    const fields = fieldsOf(req.body);
    const op: CreateTableOp = {
      op: 'create_table',
      name: normaliseTableName(fields.table),
      columns: parseColumnLines(fields.columns),
    };
    const statements = emitCreateTable(op);
    const registry = registryRow(op);
    const csrf = this.sessions.csrfToken(session);
    reply.type('text/html; charset=utf-8').send(
      page(
        `Skunkworks — ${tenant.key} — preview`,
        `<h1>${esc(tenant.key)} — preview</h1>
<p data-role="not-executed">Not executed. This is the exact SQL the runner will execute — one emitter, so the preview cannot describe SQL nobody runs. Applying it is one transaction: the statement, the <code>cms_table_registry</code> row and the <code>cms_audit</code> row, the postcondition, then COMMIT.</p>
<h2>Statement</h2>
<pre data-role="ddl">${esc(statements.join(';\n\n'))};</pre>
<h2>cms_table_registry row</h2>
<pre data-role="registry">${esc(JSON.stringify(registry, null, 2))}</pre>
<form method="post" action="/admin/t/${esc(tenant.key)}/builder/apply" data-csrf-token="${esc(csrf)}">
  <input type="hidden" name="table" value="${esc(op.name)}">
  <textarea name="columns" rows="10" hidden>${esc(fields.columns ?? '')}</textarea>
  <button type="submit">Apply</button>
</form>
<form method="post" action="/admin/t/${esc(tenant.key)}/builder/preview" data-csrf-token="${esc(csrf)}">
  <input type="hidden" name="table" value="${esc(op.name)}">
  <textarea name="columns" rows="10">${esc(fields.columns ?? '')}</textarea>
  <button type="submit">Preview again</button>
</form>
<p><a href="/admin/t/${esc(tenant.key)}/builder">Back to the form</a></p>
<script>
for (const form of document.querySelectorAll('form[data-csrf-token]')) {
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    fetch(form.action, {
      method: 'POST',
      headers: { 'X-CSRF-Token': form.dataset.csrfToken, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(new FormData(form)),
      redirect: 'follow',
    }).then((res) => { window.location.href = res.url; });
  });
}
</script>`,
      ),
    );
  }

  /**
   * §9.4's apply: the runner, called from the form that previewed the same statement.
   *
   * The route does no SQL of its own — `runDdl` owns `BEGIN IMMEDIATE`, the registry row,
   * the audit row, the postcondition and the discarded connection. A refusal propagates
   * as the taxonomy body §4.3 requires (422 `SKW_E_DM_DDL_REJECTED` with its `reason`),
   * and the client's `fetch` shows it rather than a rendered guess.
   */
  #builderApply(req: FastifyRequest, reply: FastifyReply, tenant: Tenant, session: SessionRecord): void {
    const fields = fieldsOf(req.body);
    const op: CreateTableOp = {
      op: 'create_table',
      name: normaliseTableName(fields.table),
      columns: parseColumnLines(fields.columns),
    };
    const file = join(this.#env.dataDir, 'tenants', tenant.key, 'site.db');
    const actor = this.#actor(session);
    const report = runDdl(file, [op], {
      actor,
      maxStatements: this.#env.ddlMaxStatements,
      busyTimeoutMs: this.#env.dbBusyTimeoutMs,
    });
    reply.type('text/html; charset=utf-8').send(
      page(
        `Skunkworks — ${tenant.key} — applied`,
        `<h1>${esc(tenant.key)} — applied</h1>
<p data-role="applied">One transaction: ${report.ops} operation, ${report.statements} statement(s), the registry row and the audit row, the postcondition, COMMIT.</p>
<table data-role="report">
  <tr><th>table</th><td>${esc(report.tables.join(', '))}</td></tr>
  <tr><th>statements</th><td>${String(report.statements)}</td></tr>
  <tr><th>lock attempts</th><td>${String(report.lockAttempts)} (waited ${String(report.lockWaitMs)} ms)</td></tr>
  <tr><th>rebuilt</th><td>${esc(report.rebuilt.join(', ') || '—')}</td></tr>
  <tr><th>audit</th><td>${esc(report.audit.map((a) => `${a.from} ${a.to}`).join(', '))}</td></tr>
</table>
<p><a href="/admin/t/${esc(tenant.key)}/builder">Another table</a> · <a href="/admin/t/${esc(tenant.key)}/tables/${esc(op.name)}">Edit its rows</a></p>`,
      ),
    );
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
    const rotatedTenant = rotated.tenantId === null ? undefined : this.#tenants.lookupId(rotated.tenantId);
    const rotatedName = rotatedTenant === undefined ? FLEET_COOKIE : sessionCookieName(rotatedTenant.key);
    const rotatedPath = rotatedTenant === undefined ? FLEET_COOKIE_PATH : ADMIN_COOKIE_PATH;
    reply.header('set-cookie', this.sessions.cookieHeader(rotatedName, this.sessions.sign(rotated.id), rotatedPath));
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
