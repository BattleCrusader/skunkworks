/**
 * The app: boot order of SDS §2.3, then one Fastify process with the Astro SSR
 * shell mounted in middleware mode (§2, §16 S1).
 *
 * Boot order, in order:
 *   1. read the environment; refuse ^SK_|^SKUNK_; refuse without the six keys
 *   2. assert SKW_ARGON2_MAX_CONCURRENT=4 and UV_THREADPOOL_SIZE=8
 *   3. open control.db; if it cannot be opened or migrated, exit 15 naming it
 *   4. run `migrate --tenant all`; app starts regardless (C-10)
 *   5. upsert the component registry into each tenant's cms_component_registry
 *   6. load the plugins the tenant rows say are enabled, in this process (D36, §13.3.2)
 *
 * Step 6 is not a socket and not a child: since D36 a plugin is a module `import()`ed into this
 * process, and there is nothing to bind. A package whose code throws or whose `activate` fails is
 * marked failed and disabled, and the site keeps serving (§13.3.6).
 */
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type Database from 'better-sqlite3';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import multipart from '@fastify/multipart';

import { BootRefusal, adminHostOf, loadEnv, type Env } from './env.ts';
import { AppError, errorBody, frameworkCode, HTTP } from './errors.ts';
import { RenderPool, openAdminWrite, openRenderRead } from './db/classes.ts';
import { AdminSurface } from './admin/routes.ts';
import {
  EXIT_CONTROL_FAILED,
  findProjectRoot,
  migrateControl,
  migrateTenant,
  runMigrations,
  targetVersion,
} from './db/migrate.ts';
import { loadPage, normalisePagePath, pageMiss, type PageRecord } from './render/page.ts';
import { SEARCH_PATH, searchBody, searchDescription, searchPages, searchTitle } from './render/search.ts';
import { renderStoredBody } from './render/body.ts';
import { resolveSourceBlocks } from './render/blocks.ts';
import sharp from 'sharp';

import { loadPluginPage, matchPluginPage, pluginPageBody, resolveFormMarkers } from './render/plugin-pages.ts';
import { loadNav, menuPluginEnabled, type NavTree } from './render/nav.ts';
import { hasChrome, loadChrome, logoUrl as chromeLogoUrl, seedChromeSettings, type SiteChrome } from './render/chrome.ts';
import { ADMIN_ROBOTS_VALUE, isAdminPath, isPortalPath, PAGE_ROBOTS_VALUE, ROBOTS_HEADER } from './render/robots.ts';
import { originFromHost, pageSeoHead, parsePageSeo } from './render/seo.ts';
import { matchesEtag, sheetEtag, sheetVersion, siteSheet } from './render/theme.ts';
import { NAV_PILOT_JS } from './render/nav-pilot.ts';
import {
  THEME_KEY_SETTING,
  activeTheme,
  palettePrelude,
  activeThemeKey,
  cssBlob,
  listThemes,
  themeAsset,
  themeAssetsRoot,
  sha256 as cssSha256,
  themeByKey,
  verifyPreviewToken,

  brandPrelude,} from './render/themes.ts';
import { faviconSvg, robotsTxt, sitemapXml, type SitemapEntry } from './render/delivery.ts';
import { CSP_HEADER, cspPolicy, cspPolicyForEditor, cspPolicyWithNonce } from './render/csp.ts';
import { createRenderData } from './render/data.ts';
import { PREVIEW_PARAM, loadPageForRender } from './render/preview.ts';
import { SourceCache } from './sources/cache.ts';
import { startSealScheduler, sealSummary, type SealSchedulerHandle, type SealSummary } from './audit/scheduler.ts';
import { TenantMap } from './tenancy/cache.ts';
import { normaliseHost } from './tenancy/normalise-host.ts';
import { resolveTenant, TENANT_HEADER, type Tenant } from './tenancy/resolve.ts';
import { DEFAULT_CONTENT_ROOT, UPLOAD_MAX_BYTES } from './assets/store.ts';
import { Semaphore } from './admin/auth.ts';
import { Accounts } from './accounts/service.ts';
import { registerPortal } from './accounts/routes.ts';
import { advertReader } from './accounts/jobs.ts';
import {
  JOBS_PAGE_SIZE,
  JOBS_PATH,
  isPublicJobsPath,
  jobDetailBody,
  jobDetailDescription,
  jobDetailTitle,
  jobsListBody,
  jobsListDescription,
  jobsListTitle,
  pageNumber,
} from './render/public-jobs.ts';
import { CORE_PUBLIC_ROUTES, jobsBoardEnabled } from './render/public-routes.ts';
import { collectSitemapEntries } from './render/sitemap.ts';
import { IndexNow } from './indexnow/indexnow.ts';
import { NULL_TRANSPORT, Outbox } from './mail/outbox.ts';
import { PluginJobRunner } from './plugins/jobs.ts';
import { smtpTransport } from './mail/transport.ts';
import type { MailTransport } from './mail/outbox.ts';
import { resolveMailFrom } from './mail/sender.ts';
import { seedSettings } from './download/code.ts';
import { DownloadPlane, RETRY_ATTEMPTS } from './download/plane.ts';
import { PluginRuntime } from './plugins/runtime.ts';
import { matchEndpoint, runEndpoint } from './plugins/endpoint.ts';
import { readStaticFile } from './plugins/static.ts';
import type { Manifest } from './plugins/manifest.ts';
import { attachPluginRuntime, filterSite, actionSite } from './plugins/site.ts';
import { FormLimiter, submitCoreForm } from './forms/intake.ts';
import { clientHash } from './download/token.ts';
import { assetUrlsIn } from './editor/render.ts';
import type { WatermarkDeps, WatermarkStore } from './download/render.ts';

type AstroHandler = (
  req: FastifyRequest['raw'],
  res: FastifyReply['raw'],
  next?: (err?: unknown) => void,
  locals?: object,
) => void | Promise<void>;

/** `GET /admin/api/tenants/<key>/health` — §9.5's payload plus E-20's one new field. */
export interface SealHealthPayload {
  tenant: string;
  seal: SealSummary;
  cache_seconds: number;
}

/** §9.5: the tenant health endpoint is cached for 30 s, so this one is too. */
export const SEAL_HEALTH_TTL_MS = 30_000;

export interface AppHandle {
  app: FastifyInstance;
  env: Env;
  /** The live tenant map, so a gate can assert §5.4a's one-read-per-request. */
  tenants: TenantMap;
  /** The admin surface (S2a), so a gate can inspect a session row without a socket. */
  admin: AdminSurface;
  /**
   * The per-process source cache (§6.2), so a gate can assert a hit. */
  sources: SourceCache;
  /**
   * The daily seal job (§9.6); stopped by `close()`. */
  seals: SealSchedulerHandle;
  /**
   * The in-process plugin runtime (D36 §13.3.2–§13.3.8): the registry, the load path, the hook
   * bus and the failure counter. There is no socket, no runner and no second process.
   */
  plugins: PluginRuntime;
  /**
   * The watermark render cache (§7.5), so a gate can sweep at a fixed instant without
   * waiting for the tick. Nothing outside the download plane writes to it.
   */
  watermark: WatermarkStore;
  /**
   * IndexNow (per-host key + fire-and-forget submissions). Exposed so a gate can wait for the
   * POST a publish started (`whenIdle()`) without that wait existing in the request path.
   */
  indexNow: IndexNow;
  close(): Promise<void>;
}

export interface BuildAppOptions {
  env: Env;
  schemaDir?: string;
  astroEntry?: string;
  logger?: boolean;
  /** Skip the boot migration fan-out (tests that want a corrupt fixture untouched). */
  migrateOnBoot?: boolean;
  /**
   * `content/` itself — `<root>/media/hh/<sha>.<ext>` is where the store writes and
   * where `X-Accel-Redirect` reads. Not an environment name: §4.3 fixes 23 of them,
   * and the deploy layout (§12.2: `./content:/srv/content`) is the same fact as a
   * constant. A gate passes a temp dir; production takes the default.
   */
  contentRoot?: string;
  /**
   * The redemption limiter's numbers (§16 S3c: 5 per 15 min per IP and per selector).
   * Present only for the timing gate, which measures the argon2 verify and would
   * otherwise spend its 1,000 trials inside the limiter; the default is the spec.
   */
  downloadLimits?: { refusals?: number; windowMs?: number; all?: number } | undefined;
  /**
   * The watermarker's budget, concurrency and (in a gate only) its renderer. §7.5's
   * shipped values are `STAMP_BUDGET_MS`/`STAMP_CONCURRENCY`; present here so
   * `download-watermark.test.ts` can force the renderer to throw and to overrun, which
   * are the two branches this slice exists to make un-servable.
   */
  watermark?: Omit<WatermarkDeps, 'contentRoot' | 'now'> | undefined;
  /**
   * Where the app records one line per request it *received*.
   *
   * Not a product feature and not an environment name (§4.3 stays at 23): the
   * E-17 gate has to assert that a peer denied by nginx never reached the app,
   * and the only honest witness to "reached the app" is the app's own log.
   */
  accessLogPath?: string;
  /**
   * Where the IndexNow submitter writes its one outcome line. Default: stdout, like every other
   * process-level report. Present so a gate can assert that a failing engine was *logged* rather
   * than swallowing a publish — without a gate having to intercept the process's own stdout.
   */
  indexNowLog?: (line: string) => void;
}

/**
 * **D37 replaces §9.1's listener rule.** There is no admin hostname: `/admin` is a
 * path on every tenant host, the tenant comes from the Host, and the fleet console
 * is `/fleet`. `listenerFor` and `isAdminPath` are deleted rather than left returning
 * a constant — a function that cannot say "admin" is a function nobody should call,
 * and leaving it exported is how the old rule comes back.
 */

interface RequestContext {
  tenant: Tenant;
  via: 'header' | 'host' | 'session';
  prefix: string;
  pathname: string;
}

/**
 * Is this URL one of the documents this process generates (rather than a tenant page)?
 *
 * `/admin` and `/fleet` are the two surfaces whose HTML is built by `app/admin/ui`, and
 * they are the only ones that carry an inline `<style>`. A tenant page is rendered from
 * a stored body that may not contain `<style>` at all (C-12's CHECK), so it keeps the
 * frozen policy untouched.
 */
/** `/admin/t/<key>/editor` — the one admin document whose canvas must run its own CSS. */
export function isEditorDocument(url: string): boolean {
  const q = url.indexOf('?');
  const pathname = q === -1 ? url : url.slice(0, q);
  return /^\/admin\/t\/[^/]+\/editor\/?$/.test(pathname);
}

export function isAdminDocument(url: string): boolean {
  return isAdminPath(url);
}

/**
 * Put this response's nonce on the two **bare** inline elements the header allows it for.
 *
 * Only a bare `<style>` / `<script>` is stamped: the editor's `<script type="application/json"
 * id="skw-editor-boot">` is a data block (not executed, so CSP does not apply to it) and its
 * exact tag is part of that screen's contract, and `<script src=…>` is already allowed by
 * `'self'`. The document is app-generated: every tenant value in it was escaped by `esc()`
 * before it was interpolated, so the only bare `<style>` and `<script>` are the ones this
 * codebase wrote.
 */
export function withNonce(html: string, nonce: string): string {
  return html
    .replace(/<style(?=>)/gi, `<style nonce="${nonce}"`)
    .replace(/<script(?=>)/gi, `<script nonce="${nonce}"`);
}

export function schemaDirFrom(metaUrl: string): string {
  return join(findProjectRoot(dirname(fileURLToPath(metaUrl))), 'schema');
}

export async function buildApp(opts: BuildAppOptions): Promise<AppHandle> {
  const env = opts.env;
  const schemaDir = opts.schemaDir ?? schemaDirFrom(import.meta.url);
  const dataDir = env.dataDir;
  const controlPath = join(dataDir, 'control.db');
  const tenantsDir = join(dataDir, 'tenants');

  // --- step 3: control.db is a boot gate (C-10) -----------------------------
  const control = migrateControl(controlPath, schemaDir);
  if (!control.ok) {
    throw new BootRefusal(
      `control.db could not be migrated: ${control.error ?? 'unknown'} (SDS \u00a72.3 step 3, C-10)`,
      EXIT_CONTROL_FAILED,
    );
  }

  // --- step 4: per-tenant fan-out; never a boot gate ------------------------
  let migrationReport = null;
  if (opts.migrateOnBoot !== false) {
    migrationReport = runMigrations({ dataDir, tenant: 'all', schemaDir });
    for (const t of migrationReport.tenants) {
      if (!t.ok) {
        process.stderr.write(`migrate: tenant ${t.key} failed (${t.error ?? 'unknown'}) — serving 503 alone\n`);
      }
    }
    for (const key of migrationReport.migrated) {
      process.stdout.write(`migrate: tenant ${key} ${migrationReport.tenants.find((t) => t.key === key)?.action}\n`);
    }
  }

  const tenants = new TenantMap(controlPath, { busyTimeoutMs: env.dbBusyTimeoutMs });
  const pool = new RenderPool(env.dbPoolMax, env.dbBusyTimeoutMs);
  // §6.2's result cache: one per process, keyed by tenant+source+specRev+params.
  const sources = new SourceCache();
  const sitePath = (key: string): string => join(tenantsDir, key, 'site.db');

  // --- S2a: the admin surface (§9.1, §9.2) --------------------------------
  // One argon2 semaphore for the process: the admin login and the code redemption share
  // the four slots, because `SKW_ARGON2_MAX_CONCURRENT=4` is a memory ceiling, not a
  // per-surface one (4 × 19 MiB ≈ 76 MiB against the 1 GB container).
  const contentRoot = opts.contentRoot ?? DEFAULT_CONTENT_ROOT;
  const argon = new Semaphore(env.argon2MaxConcurrent);
  // IndexNow: one submitter for the process. It owns the secret (never printed), the
  // `SKW_INDEXNOW=off` switch and the in-flight set a gate waits on; the admin surface is
  // handed it so a publish can announce without knowing the endpoint.
  const indexNow = new IndexNow({
    secret: env.indexNowSecret,
    enabled: env.indexNowEnabled,
    ...(opts.indexNowLog === undefined ? {} : { log: opts.indexNowLog }),
  });
  const admin = new AdminSurface({ env, controlPath, tenants, semaphore: argon, contentRoot, schemaDir, indexNow });

  // --- S2e: one seal per tenant per UTC day (§9.6) -------------------------
  // The timer is unref'd, so it never keeps the process alive; `close()` stops it.
  const seals = startSealScheduler({ dataDir });

  // --- step 5: component registry, one transaction per tenant --------------
  const registry = readComponentRegistry(schemaDir);
  const siteTarget = targetVersion(join(schemaDir, 'site.sql'));
  for (const tenant of tenants.all()) {
    const file = sitePath(tenant.key);
    try {
      upsertRegistry(file, registry, siteTarget);
    } catch (err) {
      process.stderr.write(`registry: tenant ${tenant.key} skipped (${describe(err)})\n`);
    }
    // §7.6's shipped settings (`download.default_max_uses` = 3, unlimited off). Seeded
    // here rather than hard-coded in the resolver: `resolveMaxUses` refuses a tenant
    // whose setting is missing instead of inventing a number.
    try {
      const db = openAdminWrite(file, env.dbBusyTimeoutMs);
      try {
        seedSettings(db);
        // S8l: the chrome keys, so the Site screen has rows to update instead of
        // inserting into an EAV table from a form handler. A tenant seeded by an older
        // image simply has none, and `loadChrome` falls back to its defaults.
        seedChromeSettings(db);
      } finally {
        db.close();
      }
    } catch (err) {
      process.stderr.write(`settings: tenant ${tenant.key} skipped (${describe(err)})\n`);
    }
  }

  // --- step 6: the plugins this box already had enabled (§2.3 step 6, §13.3.2) -----
  // Nothing is bound and nothing is spawned. Each tenant's `cms_plugin_installed` rows are the
  // only statement of what runs; a row that says `enabled=0` is never imported, which is the
  // recovery path §13.3.6 item 3 depends on. A package that throws at import is marked failed
  // and disabled here, and boot continues: a bad plugin costs its own hooks, not the site.
  const plugins = new PluginRuntime({
    dataDir,
    emailMode: env.emailMode,
    log: opts.logger === true ? (line: string) => process.stdout.write(`plugins: ${line}\n`) : undefined,
  });
  const booted = await plugins.boot();
  // The call-site door (app/plugins/site.ts): from here every host module that dispatches a
  // hook finds the same runtime, and a box with no plugins pays one `null` check.
  attachPluginRuntime(plugins);
  // The admin surface was built before step 6 (it needs the control plane, not the registry),
  // so it is handed the runtime here rather than constructed with it.
  admin.attachPlugins(plugins);
  const loadedOk = booted.filter((b) => b.ok);
  process.stdout.write(
    `plugins: in-process, ${loadedOk.length} package(s) activated` +
      `${loadedOk.length === 0 ? '' : `: ${loadedOk.map((b) => `${b.plugin}@${b.tenant}`).join(', ')}`}` +
      `${booted.length === loadedOk.length ? '' : `; ${booted.length - loadedOk.length} failed (see the admin notice)`}\n`,
  );

  const app = Fastify({
    logger: opts.logger ?? false,
    genReqId: () => randomUUID(),
    trustProxy: false,
    bodyLimit: 16 * 1024 * 1024,
  });

  // E-17's gate needs a witness that a request did — or did not — reach the app.
  // One line per request, before routing, so a 404 or a 403 from the app is still
  // recorded. Off unless a caller names a file.
  if (opts.accessLogPath !== undefined) {
    const target = opts.accessLogPath;
    app.addHook('onRequest', (req, _reply, done) => {
      appendFileSync(target, `${new Date().toISOString()} ${req.method} ${req.url}\n`);
      done();
    });
  }

  /**
   * **No admin answer is indexable — enforced once, for every route that exists or ever will.**
   *
   * The rule is central on purpose. `/admin/login` answers 200 on every tenant host, the admin API
   * answers JSON, and most admin writes answer 303 redirects; a header written per-route would be
   * forgotten by the next route someone adds, and the omission would be invisible until a search
   * engine listed a sign-in page. So it is an `onRequest` hook on the root instance: it runs before
   * routing, therefore it covers a route that does not exist yet, a 404, a 500 from the error
   * handler, a `reply.send()` and a `reply.redirect()` alike.
   *
   * `/fleet` is the same surface's console, so it gets the same header. The three mechanisms are
   * independent and all three are kept: this header, the `<meta name="robots" content="noindex,
   * nofollow">` the admin shell writes into every document (`app/admin/ui/layout.ts`), and
   * `Disallow: /admin` / `Disallow: /fleet` in `/robots.txt`.
   *
   * `nofollow` here and not on a page an operator hid from search: the admin has no page a crawler
   * should follow out of, while a hidden *page* is a normal document whose links are normal links.
   */
  app.addHook('onRequest', (req, reply, done) => {
    if (isAdminPath(req.url)) reply.header(ROBOTS_HEADER, ADMIN_ROBOTS_VALUE);
    // The job board's account surface is the same claim for the same reason: a
    // signup form is not a page to be found in a search result. See
    // `isPortalPath` for the measured Search Console report that put it here.
    if (isPortalPath(req.url)) reply.header(ROBOTS_HEADER, ADMIN_ROBOTS_VALUE);
    done();
  });

  /**
   * ── The job board's surfaces belong to the tenant that has the board ──────────────────────
   *
   * `/jobs`, `/jobs/<id>` and the whole `/portal/**` account surface are **code, not content**, so
   * nothing in a tenant's database keeps them off that tenant's host. On a site that never
   * installed the `jobboard` package they were served anyway: arnavia.com answered 200 on `/jobs`
   * carrying another product's copy ("companies post fractional roles…", the advertiser and
   * applicant sign-up links) and 200 on `/portal/register` with a registration form for a board it
   * does not have. That is one tenant's product surface appearing inside another tenant's site —
   * not a row leak (the facade is tenant-scoped and answered `null` throughout), but a leak of a
   * capability and its copy, which is the same class of defect in the eyes of the customer.
   *
   * One hook, before routing, for the same reason the robots header is: a portal route added next
   * month is covered without anyone remembering. The predicate is the facade's own
   * (`jobsBoardEnabled`), so the page, the sitemap (`coreSitemapPaths`), the nav item and this gate
   * cannot disagree about whether a tenant has a board.
   */
  app.addHook('onRequest', (req, _reply, done) => {
    const path = pathnameOf(req.url);
    const onPortal = path === '/portal' || path === '/portal.css' || path.startsWith('/portal/');
    if (!onPortal) {
      done();
      return;
    }
    try {
      const ctx = resolveRequest(req);
      if (!jobsBoardEnabled(getSiteDb(ctx.tenant), ctx.tenant.key, env.emailMode)) {
        done(pageMiss());
        return;
      }
      done();
    } catch (err) {
      done(err as Error);
    }
  });

  // §10.5 (C-12, S4c): the CSP is a property of the document, and the document is this
  // process's reply. `onSend` is after the payload is produced and before it is written, so
  // a 404, a 500 and a 200 all carry the same policy — which is the point: the error page is
  // the page a reflected payload would use. `text/html` only: a JSON body has no scripts to
  // constrain and a CSP on it is noise in a support bundle.
  //
  // S7: the admin's own documents carry one inline `<style>` (the Guided Cards tokens) and
  // the media library one small inline `<script>`. The frozen policy has no inline
  // allowance, so those documents get the same policy plus a per-response nonce — minted
  // here, written into the header and into the two elements — and nothing else changes.
  // The public site, the error pages and the exported trees still get `cspPolicy()`.
  app.addHook('onSend', async (req, reply, payload) => {
    const type = reply.getHeader('content-type');
    if (typeof type === 'string' && type.startsWith('text/html')) {
      if (typeof payload === 'string' && isAdminDocument(req.url)) {
        // The editor's canvas applies style rules by inserting a <style> into an iframe that
        // inherits this document's policy, so it needs 'unsafe-inline' and, because a nonce
        // voids it, no nonce. One screen; the public site is untouched.
        if (isEditorDocument(req.url)) {
          reply.header(CSP_HEADER, cspPolicyForEditor());
          return payload;
        }
        const nonce = randomBytes(16).toString('base64');
        reply.header(CSP_HEADER, cspPolicyWithNonce(nonce));
        return withNonce(payload, nonce);
      }
      reply.header(CSP_HEADER, cspPolicy());
    }
    return payload;
  });

  // D29's login page is a plain HTML form (`enctype=application/x-www-form-urlencoded`)
  // so the surface works with no JavaScript and no extra dependency. The body is
  // parsed as a string and read by `fieldsOf()` in the admin router, which is the
  // one place a body becomes a field map.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) =>
    done(null, body),
  );

  // S8c: file upload. A no-JS form must be `multipart/form-data`, and hand-rolling that parser
  // is how upload bugs become security bugs — boundaries, nested parts and a 25 MB body are not
  // a place to be clever. The limits are the app's, not the caller's: one file per request and
  // 25 MiB, which `uploadAsset` then enforces again on its own.
  await app.register(multipart, {
    limits: { fileSize: UPLOAD_MAX_BYTES, files: 1, fields: 8, parts: 12 },
  });

  const started = Date.now();

  app.get('/healthz', async () => ({ build: env.buildId, uptime: Math.round((Date.now() - started) / 1000) }));

  app.get('/readyz', async (_req, reply) => {
    // "opens control.db, reads a revision, performs one scratch write" (§9.5) —
    // a read-only filesystem must fail here, which a read-only probe cannot detect.
    const probe = openAdminWrite(controlPath, env.dbBusyTimeoutMs);
    let revision: number;
    try {
      revision = Number(probe.pragma('user_version', { simple: true }));
    } finally {
      probe.close();
    }
    const scratch = join(dataDir, 'logs', '.readyz');
    mkdirSync(dirname(scratch), { recursive: true });
    writeFileSync(scratch, `${Date.now()}\n`);
    unlinkSync(scratch);
    reply.header('cache-control', 'no-store');
    return { ready: true, revision };
  });

  // /whoami is the probe the SDS itself measures (§5.5, C-2 T24). It is the only
  // route that echoes the resolution, and it is what the prefix gate reads.
  app.register(async (scope) => {
    scope.addContentTypeParser('*', { parseAs: 'string' }, (_req, body, done) => done(null, body));
    const whoami = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
      const ctx = resolveRequest(req);
      const raw = req.headers[TENANT_HEADER];
      const url = req.url;
      const q = url.indexOf('?');
      const body = typeof req.body === 'string' ? req.body : '';
      reply.header('cache-control', 'no-store');
      reply.send({
        path: ctx.pathname,
        tenant_header: raw === undefined ? null : Array.isArray(raw) ? raw.join(',') : raw,
        tenant: ctx.tenant.key,
        via: ctx.via,
        prefix: ctx.prefix,
        method: req.method,
        query: q === -1 ? '' : url.slice(q + 1),
        url,
        body_bytes: Buffer.byteLength(body),
      });
    };
    scope.get('/whoami', whoami);
    scope.post('/whoami', whoami);
  });

  /**
   * `GET /sites/<key-or-host>/` — the path-shaped way in, and it **redirects rather than serves**.
   *
   * Two reasons, and the second is the one that cannot be worked around:
   *
   *  1. The tenant is resolved from the Host (§5.3, D37). Serving a site under a path would give
   *     every request two answers to "which site is this" — the Host and the first path segment —
   *     and the resolver's whole design is that there is exactly one.
   *  2. **The content's own URLs are absolute.** `cms_asset` renders as `/media/<key>.<ext>`, a
   *     page's link is `/about`, and the canonical/OG URLs the seo builder emits name the host.
   *     Served at `/sites/acme/`, every one of those would point at the *outer* host's root or
   *     another tenant's — a page that loads its own stylesheet and none of its images, with no
   *     code able to fix it without rewriting the body of every page. A redirect keeps one
   *     canonical address per site and puts the visitor on it.
   *
   * `<key>` is a tenant key **or** a host registered to that tenant, because the two things a
   * person has when they ask "where is this site" are the name they know it by and the name in
   * the control plane. An unknown one is the same 404 a missing page is — there is no list of
   * tenants here, and a different body would be one.
   */
  const siteFinder = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const raw = (req.params as { key?: string }).key ?? '';
    let key: string;
    try {
      key = decodeURIComponent(raw).toLowerCase();
    } catch {
      throw pageMiss();
    }
    const tenant = tenants.lookupKey(key) ?? tenants.lookupHost(normaliseHost(key) ?? key);
    if (tenant === undefined) throw pageMiss();
    const primary = tenants.primaryHost(tenant.id);
    // A tenant with no domain row cannot be reached by Host at all, so there is nowhere to send
    // a visitor: that is the same 404, not a redirect to a name nobody serves.
    if (primary === undefined) throw pageMiss();
    reply.header('cache-control', 'no-store');
    reply.code(302).header('location', `https://${primary}/`);
    reply.send('');
  };
  app.get('/sites/:key', siteFinder);
  app.get('/sites/:key/', siteFinder);

  // §9.5's tenant health, and E-20(d)'s one new field: the seal series. Served from a 30 s
  // cache, because the alternative is a `control.db` read and a whole-file chain walk per poll.
  // D37: the tenant is the Host's and the key in the URL must agree with it — the path is a
  // claim, the Host is the resolution. With no session for that tenant it is the same
  // `SKW_E_PLT_TENANT_UNKNOWN` 404 every other admin route answers.
  const sealHealthCache = new Map<string, { at: number; payload: SealHealthPayload }>();
  app.get('/admin/api/tenants/:key/health', async (req: FastifyRequest, reply: FastifyReply) => {
    const key = (req.params as { key: string }).key;
    const hostTenant = admin.hostTenant(req.headers.host);
    const session = hostTenant === undefined ? null : admin.sessionFor(req.headers.cookie, hostTenant);
    const tenant = tenants.lookupKey(key);
    if (
      hostTenant === undefined ||
      tenant === undefined ||
      tenant.id !== hostTenant.id ||
      session === null ||
      session.tenantId !== tenant.id
    ) {
      throw new AppError('SKW_E_PLT_TENANT_UNKNOWN', 'no tenant here');
    }
    const at = Date.now();
    const hit = sealHealthCache.get(key);
    reply.header('cache-control', 'no-store');
    if (hit !== undefined && at - hit.at < SEAL_HEALTH_TTL_MS) return hit.payload;
    const payload: SealHealthPayload = { tenant: key, seal: sealSummary(dataDir, key, at), cache_seconds: 30 };
    sealHealthCache.set(key, { at, payload });
    return payload;
  });

  // D37: `/admin` is a path on **every** tenant host, and that host's tenant is the one
  // it administers. The handler resolves the tenant from `Host` itself (never from a
  // header, never from a URL segment, never from the session) and answers the same
  // `SKW_E_PLT_TENANT_UNKNOWN` 404 as any other path when the Host maps to nothing.
  app.all('/admin', async (req: FastifyRequest, reply: FastifyReply) => {
    await admin.handle(req, reply, serveNotFound);
  });
  app.all('/admin/*', async (req: FastifyRequest, reply: FastifyReply) => {
    await admin.handle(req, reply, serveNotFound);
  });

  // D37: the fleet console, `/fleet` on any host, operator role only. Registered before
  // the astro catch-all so a tenant page at `/fleet` can never shadow it — and a tenant
  // owner who asks for it gets `serveNotFound`, byte-identical to a missing page,
  // because "there is a fleet console here" is a sentence a tenant does not need.
  app.all('/fleet', async (req: FastifyRequest, reply: FastifyReply) => {
    await admin.handleFleet(req, reply, serveNotFound);
  });
  app.all('/fleet/*', async (req: FastifyRequest, reply: FastifyReply) => {
    await admin.handleFleet(req, reply, serveNotFound);
  });

  // --- S3c: the gated download plane (§7.4, §7.6) -------------------------
  // Mounted on a public listener only: on the admin host `resolveRequest` refuses every
  // path outside `/admin…` with `SKW_E_PLT_TENANT_UNKNOWN`, which is the true statement
  // about an admin host that has no download plane.
  const plane = new DownloadPlane({
    env,
    contentRoot,
    argon,
    limits: opts.downloadLimits,
    watermark: opts.watermark,
    openDb: (key: string) => {
      try {
        return openAdminWrite(sitePath(key), env.dbBusyTimeoutMs);
      } catch {
        throw new AppError('SKW_E_PLT_TENANT_UNAVAILABLE', 'tenant database is not writable');
      }
    },
  });

  /**
   * Is this path a page a menu entry may name without a `cms_page` row?
   *
   * Two sources answer: a core board (`isPublicJobsPath` — a Fastify route, not a package page),
   * and a path a loaded package declares (`/blog/<slug>` is a row in the package's table). The CMS
   * render and the portal's header must ask the same question, so this is one function, used by
   * both; a second answer would let a "Jobs" link render on a marketing page and take the portal's
   * header away.
   *
   * `/jobs` is not a page on every site: the board is a package a tenant installs, so a site
   * without it serves a 404 there (`GET /jobs`) and must not carry a menu item pointing at one.
   * The handle is passed in rather than opened here — both callers already hold the tenant's own
   * read connection for the nav they are about to load.
   */
  function sitePageExists(db: Database.Database | null, tenantKey: string, candidate: string): boolean {
    if (isPublicJobsPath(candidate)) {
      // No handle, no proof the tenant has a board: the menu item is dropped rather than pointed at
      // a 404. Every render path holds a handle; the portal adapter opens one for the question.
      return db === null ? false : jobsBoardEnabled(db, tenantKey, env.emailMode);
    }
    for (const entry of plugins.registry.plugins(tenantKey)) {
      if (matchPluginPage([...entry.pages.values()], candidate) !== undefined) return true;
    }
    return false;
  }

  // --- S9: the job board's portal — accounts and roles live in the tenant's own file ---------
  // Core, not a plugin (see `app/accounts/service.ts`), and mounted here rather than in the route
  // table because the tenant comes from the Host exactly as it does for the download plane.
  // `exposeVerifyLink` is on only while there is no transport: offline, the page must show the link
  // and the log records it, or nobody can finish signing up.
  const accounts = new Accounts({
    env,
    argon,
    exposeVerifyLink: env.emailMode === 'off',
    log: (line) => {
      // The verification URL is the one line an operator needs; it goes to the process log, never
      // to a request log that a tenant could read.
      app.log.warn(line, 'account');
    },
    openDb: (key: string) => {
      try {
        return openAdminWrite(sitePath(key), env.dbBusyTimeoutMs);
      } catch {
        throw new AppError('SKW_E_PLT_TENANT_UNAVAILABLE', 'tenant database is not writable');
      }
    },
  });
  registerPortal(app, {
    accounts,
    env,
    exposeVerifyLink: env.emailMode === 'off',
    emailMode: env.emailMode,
    // The portal's own two pages read `cms_profile` and `cms_application`; the same factory the
    // account lifecycle uses, so one place decides what a tenant handle is.
    openDb: (key: string) => {
      try {
        return openAdminWrite(sitePath(key), env.dbBusyTimeoutMs);
      } catch {
        throw new AppError('SKW_E_PLT_TENANT_UNAVAILABLE', 'tenant database is not writable');
      }
    },
    tenantOf: (req: FastifyRequest) => resolveRequest(req).tenant.key,
    // The header the portal draws is the site's header, and its menu may name `/jobs` (a core
    // route) or a package page. This is the same predicate the CMS render passes to `loadNav`,
    // so both draw the same menu or neither — including the board existing only on a tenant that
    // installed it. The handle is opened here because `registerPortal` answers per tenant, not per
    // page render, and a nav resolve is one question.
    pageExists: (tenantKey: string, path: string) => {
      const db = openRenderRead(sitePath(tenantKey), env.dbBusyTimeoutMs);
      try {
        return sitePageExists(db, tenantKey, path);
      } finally {
        db.close();
      }
    },
  });

  /**
   * S8s: the chrome record with the theme's CSS in it.
   *
   * The shell and `siteSheet()` already know how to emit a site's stylesheet — the theme is one of
   * its two halves (`site.theme_css` is the other, the pasted fallback). Putting the active row's
   * bytes into that field means the theme reaches every page through the path that already works,
   * including the chrome's own default rules, its order in the cascade and its hash in the URL.
   */
  function withTheme(chrome: SiteChrome, theme: { css: string } | null): SiteChrome {
    return theme === null ? chrome : { ...chrome, themeCss: theme.css };
  }

  /**
   * The stylesheet a page's own CSS is served from: content-addressed, so the link never needs a
   * validator and two pages that share a sheet share a file. `null` when the page has none, which
   * is what keeps a CSS-less document byte-identical to the one the exporters write.
   */
  function pageCssHref(css: string): string | null {
    return css === '' ? null : `/_css/${cssSha256(css)}.css`;
  }

  /** The key in the URL is a claim; the host (or edge header) is the resolution. Both must agree. */
  function downloadTenant(req: FastifyRequest): string {
    const ctx = resolveRequest(req);
    const key = String((req.params as { key?: string }).key ?? '');
    if (key !== ctx.tenant.key) throw new AppError('SKW_E_PLT_TENANT_UNKNOWN', 'no tenant here');
    return key;
  }

  /**
   * S8o: the tenant's stylesheet.
   *
   * The chrome's rules, the site theme (`site.theme_css`) and the page's own `cms_page.body_css`
   * used to be interpolated into the document as `<style>`, and the site's CSP — `style-src
   * 'self'`, no inline allowance — made a browser block every one of them. In a browser the
   * chrome had no layout and a page's CSS never applied; `curl` and the tests read the markup, so
   * both looked fine. Serving the same bytes from this origin is allowed by the policy as it
   * stands, needs no `'unsafe-inline'`, and gives the browser one cacheable file per page.
   *
   * `?path=` names the page whose `body_css` to append. An unknown or absent path is a sheet with
   * no page CSS, not a 404: the stylesheet is a dependency, and failing it would 404 the look of
   * an otherwise valid page.
   */
  app.get('/theme.css', async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = resolveRequest(req);
    let sheet = '';
    const db = openRenderRead(sitePath(ctx.tenant.key), env.dbBusyTimeoutMs);
    try {
      // The menu bar is dynamic only while the `menu` package is enabled for this tenant, and the
      // board counts as a page only while the `jobboard` package is — the same predicate `GET /jobs`
      // and the sitemap answer with.
      const nav = loadNav(db, {
        pageExists: (candidate) => sitePageExists(db, ctx.tenant.key, candidate),
        enabled: menuPluginEnabled(db),
      });
      // S8s: the active theme is a row, not the `site.theme_css` string. `?theme=<key>` names an
      // uploaded theme that is *not* active, which is how the preview page shows a look before
      // anyone commits to it — the key is unguessable only in the sense that it is a slug the
      // operator chose, and the CSS it selects is the site's own content either way.
      const asked = typeof req.query === 'object' && req.query !== null ? (req.query as { theme?: string }).theme : undefined;
      const preview = typeof asked === 'string' ? themeByKey(db, asked) : undefined;
      const theme = preview ?? activeTheme(db);
      const chrome = withTheme(loadChrome(db), theme);
      // Two preludes, in cascade order, after the theme:
      //
      //   palette   the ground and ink this look is worn in — the theme's own business
      //   brand     the tenant's accent, applied over everything, whatever the look
      //
      // Both are `html:root`, so they beat the theme's `:root` by specificity; brand comes last so it
      // wins over a palette accent at equal specificity. They ride inside the sheet bytes, so the
      // version token and the ETag follow them and either change busts the browser cache.
      const themed = siteSheet({ chrome, showChrome: hasChrome(chrome, nav) });
      const prelude = theme === null ? '' : palettePrelude(db, theme.key);
      const brand = brandPrelude(db);
      sheet = [themed, prelude, brand].filter((part) => part !== '').join('\n');
    } finally {
      db.close();
    }
    if (sheet === '') {
      // Nothing to send, and nothing that could ever become something at this URL: an empty
      // stylesheet is the truthful answer, and it is cacheable for longer than a page.
      reply.header('cache-control', 'public, max-age=0, must-revalidate').type('text/css; charset=utf-8').send('');
      return;
    }
    const etag = sheetEtag(sheet);
    const ifNoneMatch = req.headers['if-none-match'];
    // S8r: a versioned URL names the bytes it wants, so the answer can be cached hard. An
    // unversioned request (an older document, a hand-written link) keeps revalidating — and
    // both forms serve the same file, so a stale URL cannot pin stale CSS: a theme edit
    // changes the version the documents emit.
    const asked = typeof req.query === 'object' && req.query !== null ? (req.query as { v?: string }).v : undefined;
    const versioned = typeof asked === 'string' && asked === sheetVersion(sheet);
    reply
      .header('etag', etag)
      .header('cache-control', versioned ? 'public, max-age=31536000, immutable' : 'public, max-age=0, must-revalidate')
      .type('text/css; charset=utf-8');
    if (matchesEtag(typeof ifNoneMatch === 'string' ? ifNoneMatch : undefined, etag)) {
      reply.code(304).send('');
      return;
    }
    reply.send(sheet);
  });

  /**
   * S8s: a stylesheet by its own hash. `/_css/<sha256>.css` is immutable by construction — the
   * name is the bytes — so this is the one URL on the site a browser may cache for a year
   * without a validator, and the one an export can write as a plain file that the same document
   * points at in both trees.
   *
   * It carries no tenant in the URL: the Host resolves the tenant, exactly like `/theme.css`,
   * so a hash stolen from one tenant's page resolves to nothing on another's origin.
   */
  app.get('/_css/:file', async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = resolveRequest(req);
    const file = String((req.params as { file?: string }).file ?? '');
    const match = /^([0-9a-f]{64})\.css$/.exec(file);
    const sha = match === null ? '' : String(match[1] ?? '');
    if (sha === '') throw new AppError('SKW_E_PLT_REQUEST_INVALID', 'a stylesheet is /_css/<sha256>.css');
    const db = openRenderRead(sitePath(ctx.tenant.key), env.dbBusyTimeoutMs);
    try {
      const css = cssBlob(db, sha);
      if (css === undefined) {
        // Not an error the operator caused and not one they can act on: a document naming a
        // stylesheet this tenant does not have is a stale page or a hand-edited link.
        reply.code(404).header('cache-control', 'no-store').type('text/plain; charset=utf-8').send('');
        return;
      }
      reply
        .type('text/css; charset=utf-8')
        .header('cache-control', 'public, max-age=31536000, immutable')
        .header('etag', `"${sha.slice(0, 32)}"`)
        .send(css);
    } finally {
      db.close();
    }
  });

  /**
   * The navigation pilot: one file, both surfaces.
   *
   * A separate route rather than an inline `<script>` because the site's policy is
   * `script-src 'self'` with no inline allowance and no nonce — an inline pilot would be dead bytes
   * in every real browser. It is tenant-agnostic (it holds no data, only behaviour), so the URL is
   * not scoped by Host and a cached copy is correct for every tenant.
   *
   * Served with an ETag and `must-revalidate` rather than a year-long immutable cache: the URL
   * cannot carry its own hash the way `/_css/<sha>.css` does, and a pilot that cannot be updated
   * without renaming a file is a pilot the next change has to work around. A 304 on revalidation
   * costs one round trip per document load, which is what the document costs anyway.
   */
  app.get('/_js/nav.js', async (_req: FastifyRequest, reply: FastifyReply) => {
    const tag = `"${createHash('sha256').update(NAV_PILOT_JS).digest('hex').slice(0, 32)}"`;
    reply
      .type('text/javascript; charset=utf-8')
      .header('cache-control', 'public, max-age=0, must-revalidate')
      .header('etag', tag)
      .send(NAV_PILOT_JS);
  });

  /**
   * S8x: the files a theme's stylesheet names.
   *
   * A theme is a package, so its pictures and fonts have to be reachable at a URL the rewritten
   * stylesheet already points at — `/_theme/<key>/assets/hero.jpg?v=<sha8>`. Three properties make
   * this the right shape:
   *
   *  1. **The URL names the tenant by Host, not by path.** Same rule as `/_css/<sha>.css`: an asset
   *     URL copied from one tenant's page resolves to nothing on another's origin.
   *  2. **The row decides, not the path.** The path in the request is looked up in `cms_theme_asset`
   *     joined to the theme key, so a request cannot name a file the database does not say exists —
   *     `../../control.db` finds no row and answers 404 without the filesystem ever being consulted
   *     for a name the operator chose.
   *  3. **Immutable, because the URL carries the hash.** The sheet is only ever stored with `?v=`
   *     baked in, so a year-long cache cannot serve the previous image after a re-upload: a
   *     re-upload is a new theme key, and a new key is a new URL.
   *
   * An SVG is served with a policy of its own. It is an image the browser will also happily execute
   * as a document if someone opens it directly, and this is the tenant's own origin, so the
   * response gets `default-src 'none'` and `nosniff` — the file renders as a picture and does
   * nothing else.
   */
  app.get('/_theme/:key/*', async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = resolveRequest(req);
    const params = req.params as { key?: string; '*': string };
    const key = String(params.key ?? '');
    const path = String(params['*'] ?? '');
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(key) || path === '') {
      throw new AppError('SKW_E_PLT_REQUEST_INVALID', 'a theme file is /_theme/<key>/<path>');
    }
    const db = openRenderRead(sitePath(ctx.tenant.key), env.dbBusyTimeoutMs);
    try {
      const row = themeAsset(db, key, path);
      if (row === undefined) {
        reply.code(404).header('cache-control', 'no-store').type('text/plain; charset=utf-8').send('');
        return;
      }
      const file = join(themeAssetsRoot(env.dataDir, ctx.tenant.key), key, row.path);
      let bytes: Buffer;
      try {
        bytes = readFileSync(file);
      } catch {
        // A row without its file is a broken install, not a bad request: say 404 (the URL is
        // correct and the bytes are not) rather than 500 on every page that shows the image.
        reply.code(404).header('cache-control', 'no-store').type('text/plain; charset=utf-8').send('');
        return;
      }
      reply
        .type(row.contentType)
        .header('cache-control', 'public, max-age=31536000, immutable')
        .header('etag', `"${row.sha256.slice(0, 32)}"`)
        .header('x-content-type-options', 'nosniff');
      if (row.contentType === 'image/svg+xml') {
        reply.header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:");
      }
      reply.send(bytes);
    } finally {
      db.close();
    }
  });

  /**
   * S8s: see a look before wearing it.
   *
   * `GET /preview-theme?t=<token>&path=/about` renders the real page with a theme that is not
   * active. The token is an HMAC over tenant + theme + expiry minted by the Themes screen
   * (`app/render/themes.ts`), so the page is shareable with a colleague for fifteen minutes and
   * is not an open door afterwards; no cookie is involved, which matters because the admin's
   * session cookie is scoped to `Path=/admin` and would never reach a page URL.
   *
   * The render is `no-store` and `noindex`: it is a preview, not a second copy of the site.
   */
  app.get('/preview-theme', async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = resolveRequest(req);
    const url = new URL(req.url, 'http://preview.invalid');
    const token = url.searchParams.get('t') ?? '';
    const claimed = url.searchParams.get('path') ?? '/';
    const db = openRenderRead(sitePath(ctx.tenant.key), env.dbBusyTimeoutMs);
    let keys: string[] = [];
    try {
      keys = listThemes(db).map((theme) => theme.key);
    } finally {
      db.close();
    }
    const themeKey = verifyPreviewToken(env.sessionKey, token, ctx.tenant.key, keys);
    if (themeKey === null) {
      reply.code(404).header('cache-control', 'no-store').type('text/plain; charset=utf-8').send('');
      return;
    }
    // `serveNotFound` hijacks the reply and hands the socket to Astro, so a header set on `reply`
    // here would never reach the wire. `noindex` travels as an option and is written on the raw
    // response before the hijack, the same way the CSP is.
    await serveNotFound(req, reply, { themeOverride: themeKey, pathOverride: claimed, noindex: true });
  });

  /**
   * S8r: the files a browser and a crawler ask for first.
   *
   * All five are derived from the same rows the pages are: the tenant comes from `Host` like
   * every other site request, the sitemap is `cms_page` plus whatever a loaded package declares
   * as a detail page, and the icon is the site's own initial. A missing one used to be a 404
   * with a JSON body — `/favicon.ico` on every single page load.
   */
  const iconCache = new Map<string, Buffer>();

  /**
   * The glyph in the site's icon: the first character of its title, else of its key.
   *
   * Read per request from `cms_settings` rather than cached in the process, because the title is
   * something an operator changes and an icon that keeps the old letter until a restart is a
   * small lie. One indexed row; the browser then caches the answer for a day.
   */
  function faviconLetter(tenantKey: string): string {
    const db = openRenderRead(sitePath(tenantKey), env.dbBusyTimeoutMs);
    try {
      const row = db.prepare(`SELECT value_json FROM cms_settings WHERE key = ?`).get('site.title') as
        | { value_json: string }
        | undefined;
      if (row !== undefined) {
        try {
          const title = JSON.parse(row.value_json) as unknown;
          if (typeof title === 'string' && title.trim() !== '') return title.trim();
        } catch {
          /* a damaged row is not a reason to fail a favicon */
        }
      }
    } finally {
      db.close();
    }
    return tenantKey;
  }

  /** An artwork over this is a mistake, not a theme's icon. */
  const FAVICON_MAX_BYTES = 64 * 1024;

  /**
   * The mark the tenant's own theme ships: `<theme-assets>/<themeKey>/assets/favicon.svg`.
   *
   * The generated letter tile is a fallback that **cannot render on this box**: `faviconSvg()`
   * draws a `<text>` element, the container has no font installed, and the PNG that came out was a
   * blank rounded square — the same 291 bytes for every tenant on the platform, which is what a
   * browser showed in two different tabs. A theme that carries its own artwork is paths and
   * shapes, so it rasterises where the letter does not.
   *
   * `version` is the file's own mtime and size: the raster cache is keyed by it, so replacing the
   * artwork is picked up by the next request instead of at the next restart.
   */
  function themeFavicon(tenantKey: string): { bytes: Buffer; version: string } | null {
    const db = openRenderRead(sitePath(tenantKey), env.dbBusyTimeoutMs);
    let themeKey = '';
    try {
      themeKey = activeThemeKey(db);
    } finally {
      db.close();
    }
    if (themeKey === '') return null;
    // The path is the theme's own, not the request's: `assets/favicon.svg` is a fixed name and no
    // part of a URL reaches `join()`.
    const file = join(themeAssetsRoot(env.dataDir, tenantKey), themeKey, 'assets', 'favicon.svg');
    try {
      const stat = statSync(file);
      if (!stat.isFile() || stat.size === 0 || stat.size > FAVICON_MAX_BYTES) return null;
      return { bytes: readFileSync(file), version: `${stat.mtimeMs}:${stat.size}` };
    } catch {
      // A theme without a mark is the ordinary case for a tenant nobody has drawn one for, and the
      // letter tile is what it gets — not a 404 on every page load.
      return null;
    }
  }

  /**
   * One raster of an SVG at `size`, for the two PNG URLs.
   *
   * `density` is derived from the target because librsvg honours it for the initial render: a
   * 32-unit `viewBox` at the default 72 dpi is 32 px, and upscaling that to 180 would be a blur
   * of the mark rather than the mark.
   */
  function rasterise(svg: Buffer, size: number): Promise<Buffer> {
    return sharp(svg, { density: Math.max(72, Math.round((size * 72) / 32)) })
      .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();
  }

  /**
   * The PNG one of the icon URLs answers: the theme's mark when there is one, the letter tile
   * otherwise, cached by tenant, size and the source's version.
   *
   * An artwork `sharp` refuses is not a reason to fail a favicon: the letter tile answers instead,
   * exactly as it does for a tenant with no artwork at all.
   */
  async function iconPng(tenantKey: string, size: number): Promise<Buffer> {
    const mark = themeFavicon(tenantKey);
    const letter = mark === null ? faviconLetter(tenantKey) : '';
    const cacheKey = `${tenantKey}:${size}:${mark === null ? `letter:${letter}` : mark.version}`;
    const cached = iconCache.get(cacheKey);
    if (cached !== undefined) return cached;
    let png: Buffer | null = null;
    if (mark !== null) {
      try {
        png = await rasterise(mark.bytes, size);
      } catch {
        png = null;
      }
    }
    if (png === null) png = await rasterise(Buffer.from(faviconSvg(letter === '' ? faviconLetter(tenantKey) : letter)), size);
    // A versioned key adds an entry on an artwork change instead of replacing one, so the map is
    // bounded: a long-lived process must not collect a raster per edit.
    if (iconCache.size >= 64) iconCache.clear();
    iconCache.set(cacheKey, png);
    return png;
  }

  app.get('/robots.txt', async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = resolveRequest(req);
    const host = normaliseHost(req.headers.host ?? null) ?? ctx.tenant.key;
    const origin = `https://${host}`;
    reply
      .type('text/plain; charset=utf-8')
      .header('cache-control', 'public, max-age=3600')
      .send(robotsTxt(origin));
  });

  /**
   * The sitemap — and the one enumeration IndexNow submits from.
   *
   * The loop that used to live here is `collectSitemapEntries()` (`app/render/sitemap.ts`) because
   * a submission must announce exactly what this file lists and nothing else. Keeping one copy is
   * what makes "the submitter's URL set equals the sitemap's URL set" a fact rather than a promise.
   */
  app.get('/sitemap.xml', async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = resolveRequest(req);
    const host = normaliseHost(req.headers.host ?? null) ?? ctx.tenant.key;
    const origin = `https://${host}`;
    const db = openRenderRead(sitePath(ctx.tenant.key), env.dbBusyTimeoutMs);
    let entries: SitemapEntry[];
    try {
      entries = await collectSitemapEntries({
        db,
        tenantKey: ctx.tenant.key,
        origin,
        emailMode: env.emailMode,
        plugins,
      });
    } finally {
      db.close();
    }
    reply
      .type('application/xml; charset=utf-8')
      .header('cache-control', 'public, max-age=600')
      .send(sitemapXml(entries));
  });

  /**
   * `GET /<key>.txt` — the IndexNow key file, for this host's key and no other.
   *
   * The route is `/:key.txt`, which find-my-way matches only on a **single** segment ending in
   * `.txt`; every static route (`/robots.txt`, `/sitemap.xml`, a page path) wins over a parametric
   * one, so this cannot shadow a real surface. Anything else shaped like a key — a wrong key, a
   * key derived for a different host, `/some/deeper.txt` — is the tenant's ordinary 404.
   *
   * Cached for a day: the key is a function of the secret and the host and changes only when one
   * of those does, and a crawler should not have to fetch it on every submission. It answers even
   * with `SKW_INDEXNOW=off`: a key that 404s tells an engine the site does not control its host.
   */
  app.get('/:key.txt', async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = resolveRequest(req);
    const host = normaliseHost(req.headers.host ?? null) ?? ctx.tenant.key;
    const wanted = indexNow.keyFor(host);
    const got = String((req.params as { key?: string }).key ?? '');
    if (got !== wanted) throw pageMiss();
    reply.type('text/plain; charset=utf-8').header('cache-control', 'public, max-age=86400').send(wanted);
  });

  /**
   * The site's mark, as an image.
   *
   * The theme's own artwork when the tenant's active theme ships one, **byte for byte** and with no
   * re-encoding — a designer's `favicon.svg` is what the browser gets — and the generated letter
   * tile otherwise, so a tenant nobody has drawn a mark for still answers 200 here rather than
   * 404ing on every page load.
   */
  app.get('/favicon.svg', async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = resolveRequest(req);
    const mark = themeFavicon(ctx.tenant.key);
    reply.type('image/svg+xml; charset=utf-8').header('cache-control', 'public, max-age=86400');
    reply.send(mark === null ? faviconSvg(faviconLetter(ctx.tenant.key)) : mark.bytes);
  });

  /**
   * iOS's home-screen icon: 180×180, rasterised from the same source as `/favicon.ico`.
   *
   * One artwork to replace when the brand changes, and two URLs that cannot disagree about what
   * the site looks like — which is the property the letter tile never had.
   */
  app.get('/apple-touch-icon.png', async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = resolveRequest(req);
    const png = await iconPng(ctx.tenant.key, 180);
    reply.type('image/png').header('cache-control', 'public, max-age=86400').send(png);
  });

  /**
   * Chrome decodes the bytes and does not trust the extension, so a real PNG at the `.ico` URL is
   * what ends the 404 every page load was making.
   *
   * One 32×32 image, not a multi-size `.ico` container: the two URLs above already name the sizes
   * the platforms ask for (32 for a tab, 180 for a home screen), so a container would buy a second
   * encoder and a second raster for a frame no current browser asks this URL for.
   */
  app.get('/favicon.ico', async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = resolveRequest(req);
    const png = await iconPng(ctx.tenant.key, 32);
    reply.type('image/png').header('cache-control', 'public, max-age=86400').send(png);
  });

  app.get('/d/:key', async (req: FastifyRequest, reply: FastifyReply) => {
    plane.form(reply, downloadTenant(req));
  });

  app.post('/d/:key', async (req: FastifyRequest, reply: FastifyReply) => {
    const key = downloadTenant(req);
    try {
      await plane.redeem(req, reply, key);
    } catch (err) {
      // A human in a browser gets the form back with one message; the JSON path (a
      // store, a test) gets the taxonomy body. Both are identical for an unknown
      // selector and a wrong secret, which is the property that matters.
      if (err instanceof AppError && wantsHtml(req)) {
        plane.form(reply, key, { error: 'That code is not valid.' });
        return;
      }
      throw err;
    }
  });

  app.get('/d/:key/file', async (req: FastifyRequest, reply: FastifyReply) => {
    const key = downloadTenant(req);
    try {
      await plane.file(req, reply, key);
    } catch (err) {
      // D34: a browser that is refused gets a page it can act on — the retry loop lives in
      // the client, never as a request parked on the server. A store or a test, which does
      // not ask for HTML, keeps the taxonomy body.
      if (err instanceof AppError && err.code === 'SKW_E_SEC_WATERMARK_FAILED' && wantsHtml(req)) {
        plane.busyPage(reply, key, err, retryAttempt(req.url));
        return;
      }
      throw err;
    }
  });

  // --- S4e/D36: the declared public endpoint surface (D25) ------------------
  // `/_plugin/<id>/<endpoint>` on the tenant's own host. The tenant comes from the Host
  // (§5.3), the endpoint must be declared in the installed manifest **and** registered at
  // activation, and anything else is the tenant's ordinary 404 — byte-identical to a path with
  // no page, so the surface does not tell a scanner which packages a site has.
  app.register(async (scope) => {
    scope.addContentTypeParser('*', { parseAs: 'string' }, (_req, body, done) => done(null, body));
    /**
     * `GET /_plugin/<id>/f/<name>` — a package's own script, from its own root, on this origin.
     *
     * The one non-JSON answer the plugin surface has, and it is deliberately not an endpoint: an
     * endpoint is a function the package registered and this is a file the package shipped, so
     * the URL space keeps them apart (`/f/`) and no manifest endpoint name can shadow a file.
     * `readStaticFile()` owns the four refusals — undeclared, outside the root, absent, too large
     * — and every one of them becomes the tenant's ordinary 404 (§13.3.5: the surface is not an
     * oracle for what is installed).
     *
     * Cache: the URL the `page.head` markup writes carries `?v=<version>`, so a year is honest
     * for one version's bytes, and the ETag makes a revalidated hit free. `nosniff` because the
     * content type is the point — a browser must not decide this file is something else.
     */
    scope.get('/_plugin/:plugin/f/:name', async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = resolveRequest(req);
      const params = req.params as { plugin: string; name: string };
      const db = openRenderRead(sitePath(ctx.tenant.key), env.dbBusyTimeoutMs);
      let file: ReturnType<typeof readStaticFile> = null;
      try {
        const row = db
          .prepare(`SELECT manifest_json FROM cms_plugin_installed WHERE plugin_id = ? AND enabled = 1`)
          .get(params.plugin) as { manifest_json: string } | undefined;
        if (row !== undefined) {
          const manifest = JSON.parse(row.manifest_json) as Manifest;
          file = readStaticFile({
            pluginsRoot: plugins.pluginsDirectory(),
            plugin: params.plugin,
            name: params.name,
            manifest,
          });
        }
      } catch {
        // A manifest row that will not parse is a package that cannot be loaded either; the file
        // it would have served is a 404, not a 500 on a page that is otherwise fine.
        file = null;
      } finally {
        db.close();
      }
      if (file === null) {
        await serveNotFound(req, reply);
        return;
      }
      reply.header('x-content-type-options', 'nosniff');
      reply.header('cache-control', 'public, max-age=31536000, immutable');
      reply.header('etag', file.etag);
      if (req.headers['if-none-match'] === file.etag) {
        reply.code(304).send('');
        return;
      }
      reply.type(`${file.mime}; charset=utf-8`).send(file.bytes);
    });
    scope.all('/_plugin/*', async (req: FastifyRequest, reply: FastifyReply) => {
      const match = matchEndpoint(req.url);
      const ctx = resolveRequest(req);
      if (match === null || (req.method !== 'GET' && req.method !== 'POST')) {
        await serveNotFound(req, reply);
        return;
      }
      // §13.3.8: `skwctl plugin enable|disable` runs in another process, so this one looks at
      // the rows once per plugin request. It is also where a package enabled since the last
      // request is *imported* — which is the moment revocation and the byte check run again.
      plugins.enter(ctx.tenant.key);
      let result: unknown;
      const db = openAdminWrite(sitePath(ctx.tenant.key), env.dbBusyTimeoutMs);
      try {
        await plugins.sync(ctx.tenant.key);
        result = await runEndpoint(plugins, {
          db,
          tenant: ctx.tenant.key,
          plugin: match.plugin,
          endpoint: match.endpoint,
          method: req.method,
          url: req.url,
          body: typeof req.body === 'string' ? req.body : '',
        });
      } catch (err) {
        // S4e: `skwctl plugin install|uninstall` writes the same `site.db` while the app is
        // serving — that is the supported operator shape (§8.6), not a test artefact. Across
        // the two processes' WAL handles, the first open after a DDL transaction can lose the
        // race and fail with SQLITE_CANTOPEN/SQLITE_SCHEMA (measured through the composed gate:
        // one 500 at the moment of an uninstall). One retry on the transient codes is the
        // difference between "the operator's uninstall 500s the site for one request" and
        // "the next request is the 404 it should be"; a genuine failure still surfaces.
        if (!isTransientSqlite(err)) throw err;
        await new Promise((resolve) => setTimeout(resolve, 50));
        result = await runEndpoint(plugins, {
          db,
          tenant: ctx.tenant.key,
          plugin: match.plugin,
          endpoint: match.endpoint,
          method: req.method,
          url: req.url,
          body: typeof req.body === 'string' ? req.body : '',
        });
      } finally {
        db.close();
        plugins.leave(ctx.tenant.key);
      }
      if (result === null) {
        await serveNotFound(req, reply);
        return;
      }
      reply.header('cache-control', 'no-store').type('application/json; charset=utf-8');
      reply.send(result);
    });
  });

  // --- core form intake (§8.6 O-30) ----------------------------------------
  // `POST /f/<key>` on the tenant's own host. The tenant comes from the Host (§5.3), never
  // from the path; the form key names a `cms_form` row in that tenant's own database. This
  // is the call site of `form.validate` and `form.submitted` (§13.3.4) — a hook with no
  // intake to run inside would be a hook the spec claims and the product never calls.
  const formLimiter = new FormLimiter();
  app.register(async (scope) => {
    scope.addContentTypeParser('*', { parseAs: 'string' }, (_req, body, done) => done(null, body));
    scope.post('/f/:key', async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = resolveRequest(req);
      // D37: the `listener !== 'public'` guard that used to live here was the admin
      // host's exclusion, and there is no admin host any more. Nothing replaces it:
      // a `/demo/` form post was allowed before (the demos host was a public
      // listener) and is allowed still — the tenant is the header's, as it always was.
      const key = String((req.params as { key?: string }).key ?? '');
      const raw = typeof req.body === 'string' ? req.body : '';
      const fields: Record<string, string> = {};
      for (const [k, v] of new URLSearchParams(raw)) fields[k] = v;
      const db = openAdminWrite(sitePath(ctx.tenant.key), env.dbBusyTimeoutMs);
      try {
        // §13.3.8: `skwctl plugin enable|disable` writes the row in another process, and this
        // request is where the app notices — one SELECT, before the first dispatch.
        await plugins.sync(ctx.tenant.key);
        plugins.enter(ctx.tenant.key);
        try {
          const result = await submitCoreForm({
            db,
            tenant: ctx.tenant.key,
            key,
            raw: fields,
            ipHash: clientHash(env.ipHashKey, req.socket.remoteAddress ?? ''),
            sessionKey: env.sessionKey,
            atMs: Date.now(),
            limiter: formLimiter,
          });
          reply.header('cache-control', 'no-store').code(result.status).type('application/json; charset=utf-8');
          reply.send(result.body);
        } finally {
          plugins.leave(ctx.tenant.key);
        }
      } finally {
        db.close();
      }
    });
  });

  // §7.6's third channel. The JSON body is kept as the raw string because the HMAC is
  // over the bytes the store signed, not over a re-serialisation of them.
  app.register(async (scope) => {
    scope.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) =>
      done(null, body),
    );
    scope.post('/api/hooks/:tenant/issue-code', async (req: FastifyRequest, reply: FastifyReply) => {
      const key = String((req.params as { tenant: string }).tenant);
      const tenant = tenants.lookupKey(key);
      if (tenant === undefined || tenant.status !== 'active') {
        throw new AppError('SKW_E_PLT_TENANT_UNKNOWN', 'no tenant here');
      }
      await plane.webhook(req, reply, key);
    });
  });

  app.setErrorHandler((err, req, reply) => {
    sendError(reply, err, String(req.id));
  });
  /**
   * S8k: a browser posting one of a package's declared forms.
   *
   * The form posts to the page's own URL (a form with no `action` does exactly that), so this is
   * where it lands. The host forwards the declared fields to the package's endpoint as JSON — the
   * endpoint contract stays JSON-only — and answers the browser with a redirect, because a person
   * who pressed Send is owed a page, not a JSON body (the same rule the admin login learned).
   */
  async function handleDeclaredFormPost(
    req: FastifyRequest,
    reply: FastifyReply,
    ctx: { tenant: { key: string } },
    path: string,
  ): Promise<boolean> {
    // The urlencoded parser hands this route a string (the same one the admin login reads), so the
    // body becomes a field map here. A cap first: a public form is not a place to receive megabytes.
    const raw = typeof req.body === 'string' ? req.body : '';
    if (raw === '' || raw.length > 64 * 1024) return false;
    const fields: Record<string, string> = {};
    for (const [key, value] of new URLSearchParams(raw)) {
      if (key !== '') fields[key] = value;
    }
    const formId = fields._skw_form ?? '';
    if (formId === '') return false;

    plugins.enter(ctx.tenant.key);
    let writeDb: ReturnType<typeof openAdminWrite> | null = null;
    try {
      await plugins.sync(ctx.tenant.key);
      const owner = plugins.registry.plugins(ctx.tenant.key).find((entry) => entry.forms.has(formId));
      const form = owner?.forms.get(formId);
      if (owner === undefined || form === undefined) return false;
      const payload: Record<string, string> = {};
      for (const field of form.fields) payload[field.name] = String(fields[field.name] ?? '');
      writeDb = openAdminWrite(sitePath(ctx.tenant.key), env.dbBusyTimeoutMs);
      const result = await runEndpoint(plugins, {
        db: writeDb,
        tenant: ctx.tenant.key,
        plugin: owner.pluginId,
        endpoint: form.endpoint,
        method: 'POST',
        url: req.url,
        body: JSON.stringify(payload),
      });
      const ok = typeof result === 'object' && result !== null && (result as { ok?: unknown }).ok === true;
      reply
        .header('cache-control', 'no-store')
        .code(303)
        .header('location', `${path}?${ok ? 'sent' : 'form_error'}=1`)
        .send('');
      return true;
    } finally {
      writeDb?.close();
      plugins.leave(ctx.tenant.key);
    }
  }

  interface ServeOptions {
    /** S8s: render with this theme instead of the active one. Only the preview route sets it. */
    themeOverride?: string;
    /** The path to render, when the URL's own path is not the page's (a preview URL). */
    pathOverride?: string;
    /** S8s: a preview is not part of the site. Set before the render hijacks the reply. */
    noindex?: boolean;
  }

  async function serveNotFound(req: FastifyRequest, reply: FastifyReply, opts: ServeOptions = {}): Promise<void> {
    const ctx = resolveRequest(req);
    const path = normalisePagePath(opts.pathOverride ?? req.url);
    // §4.3 (E-4): a URL that cannot name a path is refused before a route runs.
    if (path === null) throw new AppError('SKW_E_PLT_REQUEST_INVALID', 'the request path is not a page path');
    if (req.method === 'POST' && (await handleDeclaredFormPost(req, reply, ctx, path))) return;
    const db = getSiteDb(ctx.tenant);
    // O-29: `?preview=<token>` is the one way a draft reaches a browser. The token
    // is bound to this tenant and this normalised path, and `loadPageForRender`
    // accepts it only for `status='draft'`.
    const previewToken = queryParam(req.url, PREVIEW_PARAM);
    const loaded = loadPageForRender(db, {
      tenantKey: ctx.tenant.key,
      path,
      token: previewToken ?? null,
      sessionKey: env.sessionKey,
    });
    // S8k: a post is a row, not a `cms_page`. Before answering "no such page", ask the loaded
    // packages whether a declared detail pattern owns this path — and if it does, hand the rest of
    // the render the same PageRecord shape every other page arrives in. The host builds the body;
    // the package only named the table and the columns.
    let stored = loaded.page;
    if (stored === null) {
      plugins.enter(ctx.tenant.key);
      try {
        await plugins.sync(ctx.tenant.key);
        const declared = [...plugins.registry.plugins(ctx.tenant.key)].flatMap((entry) => [...entry.pages.values()]);
        const match = matchPluginPage(declared, path);
        if (match !== undefined) {
          const row = loadPluginPage(db, match.page, match.slug);
          if (row !== undefined) {
            stored = {
              id: 0,
              path,
              title: String(row[match.page.titleColumn] ?? ''),
              status: 'published',
              template: 'page',
              bodyHtml: pluginPageBody(row, match.page),
              bodyCss: '',
              // A package's detail page has no `cms_page` row and therefore no `seo_json`; its
              // metadata belongs to the package's own columns, not to this record.
              seoJson: null,
              updatedAt: new Date().toISOString(),
            };
          }
        }
      } finally {
        plugins.leave(ctx.tenant.key);
      }
    }
    if (stored === null) throw pageMiss();
    await renderPage(req, reply, ctx, db, stored, {
      preview: loaded.preview,
      ...(opts.themeOverride === undefined ? {} : { themeOverride: opts.themeOverride }),
      ...(opts.noindex === undefined ? {} : { noindex: opts.noindex }),
    });
  }

  interface RenderOptions extends ServeOptions {
    /** O-29: a preview reads a draft and is `noindex`; nothing else about the document differs. */
    preview: boolean;
  }

  /**
   * **One page, one document** — the shell every path shares.
   *
   * A `cms_page` row, a package's declared detail page (`/blog/<slug>`) and the board's own two
   * pages (`/jobs`, `/jobs/<id>`) all arrive here as the same `PageRecord`, and this is the only
   * function that loads the menus, the chrome, the theme's sheet and the Astro middleware. That is
   * deliberate: the header, the sticky rules, `theme.css`, `<main>` and the footer are the site's,
   * and a second renderer that reproduced them would drift the first time the nav changed. The
   * only difference between the three callers is how the record was produced.
   *
   * Everything a page body could carry that needs the request is resolved here: asset URLs (one
   * `asset.url` dispatch per key, before the render), `data-skw-block` markers, declared forms and
   * their per-response state, the `content.render.html` and `page.head` filters, and the per-page
   * search metadata from `seo_json`. A synthesized page supplies its own `seoJson`, so it gets the
   * same `<meta name="description">` and canonical tag a CMS page gets — not a second code path.
   */
  async function renderPage(
    req: FastifyRequest,
    reply: FastifyReply,
    ctx: RequestContext,
    db: ReturnType<RenderPool['get']>,
    stored: PageRecord,
    opts: RenderOptions,
  ): Promise<void> {
    // The path the document says it is. For a CMS page that is the row's own path; for a package's
    // page and the board's, it is the path the route matched — which is the same string the request
    // was normalised to, so a filter or a canonical cannot disagree with the URL.
    const path = stored.path;
    // S8l: the menus are read **after** `plugins.sync` below, because a menu entry may point at a
    // path a package serves (`/blog/<slug>`) and only a synced registry knows those. The
    // variables are declared here so the render call after the `finally` still sees them.
    let nav: NavTree = { header: [], footer: [] };
    let chrome: (SiteChrome & { logoUrl: string | null; sheetVersion?: string; previewTheme?: string }) | null = null;
    // §10.3/§11.2: the stored bytes are a fragment that names **keys**; `renderStoredBody`
    // unwraps a legacy row and derives every asset URL. It is the same function the three
    // exporters call, so a page cannot render one way here and another way in a bundle —
    // and an export gate that breaks this line breaks the served page too (S4b's mutation
    // proof). Before S4b the serve path never called it, and a live page shipped
    // `<img data-asset-key="work/one">` with no `src` (D17).
    // §13.3.4: `content.render.html` is a **filter that runs inside the render call**. Its
    // return value replaces the body html and nothing else — there is no response object in the
    // dispatch and no parameter for status, headers, cookies or the route. A throw is caught at
    // the dispatch site, so a page never 500s because a plugin filter did (§13.3.6).
    //
    // `sync` first: `skwctl plugin enable|disable` writes the row in another process, and this
    // is the request that notices (§13.3.8 — no restart).
    const startedAt = Date.now();
    plugins.enter(ctx.tenant.key);
    let head = '';
    /** Criterion C: a page nobody has hidden renders exactly the bytes, and headers, it did before. */
    let pageNoindex = false;
    let page = { ...stored, bodyHtml: stored.bodyHtml };
    const assetUrls = new Map<string, string>();
    try {
      await plugins.sync(ctx.tenant.key);
      // §3/§4.4: `loadNav()` resolves every href and refuses a row it cannot resolve — a menu
      // entry pointing at a page that does not exist is a dead link the CMS created itself. A
      // path a loaded package serves counts as a page: `/blog/<slug>` is a row in the package's
      // table, and a header link to it is not a dead link.
      const pageExists = (candidate: string): boolean => sitePageExists(db, ctx.tenant.key, candidate);
      // Dynamic only while the `menu` package is on: the rows live in `cms_nav`, but the bar is
      // the package's feature. Off means no menu, not a stale one.
      nav = loadNav(db, { pageExists, enabled: menuPluginEnabled(db) });
      // S8l: the identity bar and footer, from `cms_settings`. `null` when the tenant has set
      // none of it, so a site that has never opened the Site screen renders exactly the bytes
      // it rendered before this feature existed (and the exported tree stays byte-identical).
      const siteChrome = withTheme(
        loadChrome(db),
        opts.themeOverride === undefined ? activeTheme(db) : (themeByKey(db, opts.themeOverride) ?? null),
      );
      chrome = hasChrome(siteChrome, nav)
        ? {
            ...siteChrome,
            logoUrl: chromeLogoUrl(db, siteChrome),
            // S8r: the sheet's own hash, so the link can name its bytes and the browser can
            // cache it for a year. Same bytes the `/theme.css` route hashes.
            //
            // S8s: `&theme=` is only present on a preview render, and only for the theme being
            // previewed — the same URL still answers unversioned for an old document.
            sheetVersion: sheetVersion(siteSheet({ chrome: siteChrome, showChrome: true })),
            ...(opts.themeOverride === undefined ? {} : { previewTheme: opts.themeOverride }),
          }
        : null;
      // §13.3.4, `asset.url`: one dispatch per asset this page names, **before** the render,
      // because the filter is async and the render is not. `assetUrlsIn` is the export
      // pre-flight's own view of the body, so the set of keys the hook sees is the set of
      // keys the render will emit — no second parser and no drift.
      for (const asset of assetUrlsIn(db, stored.bodyHtml)) {
        if (asset.url === null) continue; // gated: there is no URL to hand a filter
        const hooked = await filterSite<string>('asset.url', ctx.tenant.key, { tenant: ctx.tenant.key, key: asset.key, url: asset.url }, asset.url);
        if (hooked !== asset.url) assetUrls.set(asset.key, hooked);
      }
      // S8h: a page may carry `data-skw-block` markers, which name a *view* a package declared
      // over its own table. They are resolved here — after the stored body is unwrapped and
      // before any filter sees it — because the host draws those views (§10.5: no plugin markup
      // on a tenant's origin). A marker whose package is disabled renders nothing.
      const withBlocks = resolveSourceBlocks(db, ctx.tenant.key, stored.bodyHtml, (tenant, id) => {
        for (const entry of plugins.registry.plugins(tenant)) {
          const block = entry.blocks.get(id);
          if (block !== undefined) return block;
        }
        return undefined;
      });

      // S8k: a declared form is a marker until render time — `sent` and an error sentence are
      // per-response facts, so they cannot live in the saved page.
      const sent = new URL(req.url, 'http://page.invalid').searchParams.get('sent') === '1';
      const formError = new URL(req.url, 'http://page.invalid').searchParams.get('form_error') === '1';
      const withForms = resolveFormMarkers(
        withBlocks,
        (id) => {
          for (const entry of plugins.registry.plugins(ctx.tenant.key)) {
            const form = entry.forms.get(id);
            if (form !== undefined) return form;
          }
          return undefined;
        },
        { sent, ...(formError ? { error: 'That did not send. Check the fields and try again.' } : {}) },
      );

      page = {
        ...stored,
        bodyHtml: renderStoredBody(db, withForms, {
          urlFor: (key) => assetUrls.get(key) ?? null,
          // §8.6 O-30: a core form rendered for a browser gets its `_pt` minted here, at the one
          // instant the page is produced. The tenant is the Host's (§5.3), never the body's.
          forms: { tenant: ctx.tenant.key, sessionKey: env.sessionKey, atMs: Date.now() },
        }),
      };
      page.bodyHtml = await filterSite<string>(
        'content.render.html',
        ctx.tenant.key,
        { tenant: ctx.tenant.key, path, page: { title: page.title, template: page.template } },
        page.bodyHtml,
      );
      // The page's own search metadata, from `cms_page.seo_json`. Composed first so a package's
      // `page.head` markup is appended after it rather than replacing it; with no `seo_json` the
      // string stays empty and the document is byte-for-byte what it was before this existed.
      const seo = parsePageSeo(stored.seoJson);
      if (seo !== null) {
        pageNoindex = seo.robots === 'noindex';
        head = pageSeoHead({
          seo,
          path,
          documentTitle: page.title,
          siteName: chrome === null ? '' : chrome.title,
          origin: originFromHost(req.headers.host),
        });
      }
      // §13.3.4, `page.head`: extra `<meta>`/`<link>` markup in `<head>`, ≤ 4 KiB, and
      // nothing else — the shell interpolates the returned string inside `<head>` and the
      // filter has no parameter for the body, the status or a header.
      head += await filterSite<string>('page.head', ctx.tenant.key, { tenant: ctx.tenant.key, path }, '');
    } finally {
      plugins.leave(ctx.tenant.key);
    }
    // §6: templates receive resolved data through one accessor and never a handle.
    const data = createRenderData(db, {
      tenantKey: ctx.tenant.key,
      cache: sources,
      audience: opts.preview ? 'preview' : 'render',
      assetUrls,
    });
    const handler = await astroHandler();
    reply.raw.setHeader('cache-control', 'no-store');
    // §10.5 (C-12): the page path hands the socket to Astro, so the policy has to be on the
    // raw response before the hijack — the `onSend` hook above never sees this reply.
    reply.raw.setHeader(CSP_HEADER, cspPolicy());
    if (opts.noindex === true) reply.raw.setHeader(ROBOTS_HEADER, ADMIN_ROBOTS_VALUE);
    // A page an operator hid from search: the same header a crawler already understands, without
    // `nofollow` — its links are ordinary links (see `app/render/robots.ts`). Set here rather than
    // in the Astro shell because the shell owns the document and not the response, and because a
    // crawler that reads only headers must still be told.
    else if (pageNoindex) reply.raw.setHeader(ROBOTS_HEADER, PAGE_ROBOTS_VALUE);
    reply.hijack();
    // S8s: the page's own CSS is a file, named by its bytes. The shell links it after the site
    // sheet, so a page's rules win at equal specificity and nothing is inlined — the policy's
    // `style-src 'self'` blocks an inline `<style>` and always did (E-41).
    const cssHref = pageCssHref(page.bodyCss ?? '');
    await handler(req.raw, reply.raw, undefined, {
      tenantKey: ctx.tenant.key,
      path,
      page,
      preview: opts.preview,
      data,
      head,
      nav,
      chrome,
      cssHref,
    });
    // `page.rendered` is an **action**: the return value is discarded and the payload is
    // observation only — `{tenant, path, status, ms}`. A throw here is caught by the dispatch
    // and counted; the response has already been written either way.
    await actionSite('page.rendered', ctx.tenant.key, {
      tenant: ctx.tenant.key,
      path,
      status: 200,
      ms: Date.now() - startedAt,
    });
  }

  // --- S9: the public board -----------------------------------------------------------------
  //
  // `GET /jobs` and `GET /jobs/<ref>`, on the tenant's own host, drawn by the site's own shell.
  //
  // Why a Fastify route and not a package page: the board's list is not a row in any table (it is
  // a page of published adverts, with a count, an empty state and pagination), and its detail page
  // has to state the rate, the days, the location, the remote flag and the posted date — facts the
  // package's declarative detail page (`/jobs/{slug}`, still served) has no vocabulary for. The
  // read itself is the portal's: `advertReader` goes through the plugin facade, so no SQL against
  // `p_*` appears here and a tenant without the package gets an empty board rather than a 500.
  //
  // Both routes hand `renderPage` a `PageRecord` and nothing else, which is what makes the header,
  // the footer and `/theme.css` the marketing pages' own rather than a copy of them.
  app.get('/jobs', async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = resolveRequest(req);
    const page = pageNumber(req.url);
    if (page === null) throw pageMiss();
    const db = getSiteDb(ctx.tenant);
    const reader = advertReader(db, ctx.tenant.key, env.emailMode);
    // No `jobboard` package (or one that is disabled) means this site has no job board, so `/jobs`
    // is the site's ordinary 404 — not an empty board. The board is a feature a tenant installs;
    // a marketing site that never bought one must not answer a page about hiring, and must not
    // appear in its sitemap (`coreSitemapPaths` asks the same question through the same
    // `jobsBoardEnabled`). An installed board with no adverts still gets a page: that one is "no
    // roles open yet", which is true and useful.
    const listing = reader.listPublished({ limit: JOBS_PAGE_SIZE, offset: (page - 1) * JOBS_PAGE_SIZE });
    if (listing === null) throw pageMiss();
    const total = listing.total;
    const rows = listing.rows;
    const pages = Math.max(1, Math.ceil(total / JOBS_PAGE_SIZE));
    // A page past the end names no adverts. 404 rather than an empty page 9 999, so the URL space
    // the board answers is bounded by the rows it has.
    if (page > pages) throw pageMiss();
    const siteName = loadChrome(db).title;
    const record: PageRecord = {
      // No `cms_page` row exists: this page is built from adverts, so it has no id and no revision.
      id: 0,
      path: JOBS_PATH,
      title: jobsListTitle(siteName),
      status: 'published',
      template: 'page',
      bodyHtml: jobsListBody(rows, { page, pages, total }),
      bodyCss: '',
      seoJson: JSON.stringify({ description: jobsListDescription(total, siteName) }),
      updatedAt: new Date().toISOString(),
    };
    await renderPage(req, reply, ctx, db, record, { preview: false });
  });

  app.get('/jobs/:ref', async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = resolveRequest(req);
    const ref = String((req.params as { ref?: string }).ref ?? '');
    // A numeric ref is an id; anything else is the slug the home page's block links to. Both
    // resolve through the same published-only read, so neither can reach a draft.
    const id = /^[0-9]{1,9}$/.test(ref) ? Number(ref) : null;
    const db = getSiteDb(ctx.tenant);
    const reader = advertReader(db, ctx.tenant.key, env.emailMode);
    const advert = id === null ? reader.publishedBySlug(ref) : reader.published(id);
    // Unknown, draft, closed and another tenant's advert are one answer here: the site's 404. The
    // read is scoped to this tenant's file and filtered on `status = 'published'`, so the only way
    // to tell those cases apart is to already know the row.
    if (advert === null) throw pageMiss();
    const siteName = loadChrome(db).title;
    const origin = originFromHost(req.headers.host);
    const record: PageRecord = {
      id: 0,
      path: `${JOBS_PATH}/${String(advert.id)}`,
      title: jobDetailTitle(advert, siteName),
      status: 'published',
      template: 'page',
      bodyHtml: jobDetailBody(advert),
      bodyCss: '',
      // Both addresses (`/jobs/12` and `/jobs/fractional-cto`) are the same advert, so the id URL
      // is the canonical one — the address the list and the sitemap name.
      seoJson: JSON.stringify({
        description: jobDetailDescription(advert),
        ...(origin === null ? {} : { canonical: `${origin}${JOBS_PATH}/${String(advert.id)}` }),
      }),
      updatedAt: new Date().toISOString(),
    };
    await renderPage(req, reply, ctx, db, record, { preview: false });
  });

  // --- site search ---------------------------------------------------------------------------
  //
  // `GET /search?q=…`, drawn by the site's own shell exactly as `/jobs` is: a synthesized
  // `PageRecord` handed to `renderPage`, so the header, the footer, `theme.css` and the CSP are
  // the site's, not a second renderer's copy. The results come from `app/render/search.ts`, whose
  // visibility predicate is the same one the page lookup and the sitemap use, so a draft, a hidden
  // page and a page scheduled for later cannot appear in results.
  //
  // `noindex`: a results page is a derivative of the site's own pages. Letting a crawler index it
  // would put a second, stale copy of every page title in the index.
  app.get(SEARCH_PATH, async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = resolveRequest(req);
    const raw = (req.query as { q?: unknown } | undefined)?.q;
    const db = getSiteDb(ctx.tenant);
    const result = searchPages(db, typeof raw === 'string' ? raw : '');
    const siteName = loadChrome(db).title;
    const record: PageRecord = {
      id: 0,
      path: SEARCH_PATH,
      title: searchTitle(result, siteName),
      status: 'published',
      template: 'page',
      bodyHtml: searchBody(result),
      bodyCss: '',
      seoJson: JSON.stringify({ description: searchDescription(result, siteName) }),
      updatedAt: new Date().toISOString(),
    };
    await renderPage(req, reply, ctx, db, record, { preview: false, noindex: true });
  });

  app.setNotFoundHandler(async (req, reply) => {
    await serveNotFound(req, reply);
  });

  let cachedHandler: AstroHandler | undefined;
  async function astroHandler(): Promise<AstroHandler> {
    if (cachedHandler !== undefined) return cachedHandler;
    const entry = opts.astroEntry ?? join(findProjectRoot(), 'build', 'astro', 'server', 'entry.mjs');
    // A build artifact inside the image, never a tenant-writable path (§13).
    const mod = (await import(entry)) as { handler: AstroHandler };
    cachedHandler = mod.handler;
    return cachedHandler;
  }

  function getSiteDb(tenant: Tenant): ReturnType<RenderPool['get']> {
    const file = sitePath(tenant.key);
    try {
      return pool.get(file);
    } catch (err) {
      throw new AppError('SKW_E_PLT_TENANT_UNAVAILABLE', 'tenant database is not readable', describe(err));
    }
  }

  function probe(tenant: Tenant): 'ok' | 'stale' | 'busy' | 'unavailable' {
    const file = sitePath(tenant.key);
    try {
      const db = pool.get(file);
      const version = Number(db.pragma('user_version', { simple: true }));
      if (version < tenant.dbVersion) {
        // §2.3 step 4: repaired lazily on the tenant's next request.
        const repaired = migrateTenant(file, tenant.key, schemaDir);
        pool.discard(file);
        if (repaired.ok) {
          const again = pool.get(file);
          const v2 = Number(again.pragma('user_version', { simple: true }));
          if (v2 >= tenant.dbVersion) return 'ok';
        }
        return 'stale';
      }
      return 'ok';
    } catch (err) {
      const code = (err as { code?: string }).code;
      pool.discard(file);
      if (code === 'SQLITE_BUSY' || code === 'SQLITE_BUSY_SNAPSHOT') return 'busy';
      return 'unavailable';
    }
  }

  function resolveRequest(req: FastifyRequest): RequestContext {
    const pathname = pathnameOf(req.url);

    const headers: Record<string, string | string[] | undefined> = {};
    for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = v;

    // D37: no listener, no session parse, no admin-host rule. The tenant is the
    // Host's (or the edge's header, inside `/demo/`), on every path including
    // `/admin` and `/fleet` — `AdminSurface` never reads a tenant out of a URL
    // segment and never out of a session.
    const result = resolveTenant(
      {
        peer: req.socket.remoteAddress ?? '',
        host: req.headers.host,
        headers,
      },
      {
        edgeToken: env.edgeToken,
        trustedCidrs: env.edgeTrustedCidrs,
        lookupHost: (h) => tenants.lookupHost(h),
        lookupKey: (k) => tenants.lookupKey(k),
        lookupId: (id) => tenants.lookupId(id),
        probe,
      },
    );
    if (!result.ok) throw result.error;
    return { tenant: result.tenant, via: result.via, prefix: result.prefix, pathname };
  }

  // §7.5: the render tree is a bounded transient. Every minute, delete the renders whose
  // token expired more than `continuation_grace_s` ago. Unref'd, so it never keeps the
  // process alive; `close()` stops it. A tenant whose database is unreadable is skipped
  // (the next tick tries again) — a sweep must never take the app down.
  const sweepTimer = setInterval(() => {
    for (const tenant of tenants.all()) {
      let db: Database.Database | null = null;
      try {
        db = openAdminWrite(sitePath(tenant.key), env.dbBusyTimeoutMs);
        const swept = plane.watermark.sweep(db, Date.now());
        if (swept.rows > 0) {
          process.stdout.write(`watermark sweep: ${tenant.key} rows=${swept.rows} files=${swept.files}\n`);
        }
      } catch (err) {
        process.stderr.write(`watermark sweep: ${tenant.key} skipped (${describe(err)})\n`);
      } finally {
        db?.close();
      }
    }
  }, 60_000);
  sweepTimer.unref();

  // --- S9: the outbox drain ----------------------------------------------------------------
  // With `SKW_EMAIL_MODE=off` there is no transport and nothing is claimed: the rows stay queued
  // and an operator can read them, which is the honest state of an install that cannot send. With
  // `smtp`, every tenant's queue is drained here — one tenant's mail server being down must not
  // stop another tenant's mail, so each is caught on its own.
  // One transport per sender, cached: the pool is the point, and a box with three sites must not
  // open three pools for three addresses that never change between drains. The sender itself is the
  // tenant's (`site.mail_from`), because an envelope sender has to name a domain the mail server
  // sends for — one global `SKW_MAIL_FROM` on a multi-tenant box sends one customer's enquiries
  // under another customer's domain, which is both wrong and, once DMARC is on, undeliverable.
  const mailTransports = new Map<string, MailTransport>();
  const transportFor = (from: string): MailTransport => {
    const cached = mailTransports.get(from);
    if (cached !== undefined) return cached;
    const made =
      env.emailMode === 'smtp' && env.smtpUrl !== undefined && from !== ''
        ? smtpTransport({ url: env.smtpUrl, from })
        : NULL_TRANSPORT;
    mailTransports.set(from, made);
    return made;
  };
  const drainOnce = async (): Promise<void> => {
    if (env.emailMode !== 'smtp') return;
    for (const tenant of tenants.all()) {
      let db: Database.Database | null = null;
      try {
        db = openAdminWrite(sitePath(tenant.key), env.dbBusyTimeoutMs);
        const report = await new Outbox(db, transportFor(resolveMailFrom(db, env.smtpFrom))).drain();
        if (report.claimed > 0) {
          process.stdout.write(
            `mail drain: ${tenant.key} sent=${report.sent} failed=${report.failed} suppressed=${report.suppressed} retry=${report.skipped}\n`,
          );
        }
      } catch (err) {
        process.stderr.write(`mail drain: ${tenant.key} skipped (${describe(err)})\n`);
      } finally {
        db?.close();
      }
    }
  };
  const mailTimer = setInterval(() => {
    void drainOnce();
  }, 30_000);
  mailTimer.unref();

  // --- v12: the plugin job tick --------------------------------------------------------------
  // The clock a package cannot own (app/plugins/jobs.ts). It ticks every minute and asks each
  // enabled package to decide whether its own scheduled work is due — the schedule, the cursor and
  // the copy are the package's settings, so this loop never learns what a "digest" is. It does not
  // run at boot: the first tick is a minute in, so a restart does not fan package work across every
  // tenant at once.
  const pluginJobs = new PluginJobRunner({
    runtime: plugins,
    tenants: () => tenants.all().map((tenant) => tenant.key),
    open: (tenant) => openAdminWrite(sitePath(tenant), env.dbBusyTimeoutMs),
    log: (line) => process.stdout.write(`${line}\n`),
  }).start();

  async function close(): Promise<void> {
    clearInterval(sweepTimer);
    clearInterval(mailTimer);
    pluginJobs.stop();
    seals.stop();
    // No `plugins.close()`: there is no socket to end and no child to reap. The registry and
    // its closures die with the process, which is the whole shape of D36. The one handle the
    // runtime does own is the per-tenant read connection `sync()` caches, and that is closed.
    plugins.closeSyncHandles();
    pool.close();
    tenants.close();
    await app.close();
  }

  // The sitemap names every core public route (`/jobs` and each advert), and a `<loc>` is an
  // explicit invitation to crawl. Inviting a crawler to a URL this box does not answer is the one
  // failure a sitemap test can miss and a customer finds, so the declaration and the router are
  // checked against each other at boot: a declared route that was never registered — or was
  // renamed — stops the process instead of publishing a crawlable 404.
  for (const route of CORE_PUBLIC_ROUTES) {
    if (!app.hasRoute({ method: 'GET', url: route.path })) {
      throw new Error(
        `core public route ${route.path} is declared in app/render/public-routes.ts but no GET route serves it`,
      );
    }
  }

  return { app, env, tenants, admin, sources, seals, plugins, watermark: plane.watermark, indexNow, close };
}

function pathnameOf(url: string): string {
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

/**
 * D34: which attempt this is, one-based, from `?retry=N`.
 *
 * The counter is the page's, and the server only uses it to decide whether this answer is a
 * retry page or the terminal one. It is not an authorisation: a request that omits it is
 * the first attempt, and one that lies about it only changes which page it is shown — the
 * render and the ledger are the same either way.
 */
function retryAttempt(url: string): number {
  const raw = queryParam(url, 'retry');
  const n = raw === undefined ? 0 : Number(raw);
  if (!Number.isInteger(n) || n < 0) return 1;
  return Math.min(n, RETRY_ATTEMPTS - 1) + 1;
}

/** One query value, decoded; `undefined` when absent or malformed. */
function queryParam(url: string, name: string): string | undefined {
  const q = url.indexOf('?');
  if (q === -1) return undefined;
  const value = new URLSearchParams(url.slice(q + 1)).get(name);
  return value === null || value === '' ? undefined : value;
}

function sendError(reply: FastifyReply, err: unknown, requestId: string): void {
  // §5.5: every response carrying a taxonomy body is no-store. The four
  // exceptions in §4.3 (E-13) are not emitted by the app.
  reply.header('cache-control', 'no-store');
  if (err instanceof AppError) {
    if (err.retryAfter !== undefined) reply.header('retry-after', String(err.retryAfter));
    reply.code(err.status).type('application/json; charset=utf-8');
    void reply.send(errorBody(err, requestId));
    return;
  }
  // §4.3 (E-4): a framework failure becomes the code its status class owns, and
  // the status on the wire is that code's mapping — one decision, not two.
  const e = err as { statusCode?: number };
  const raw = typeof e.statusCode === 'number' && e.statusCode >= 400 && e.statusCode < 600 ? e.statusCode : 500;
  const code = frameworkCode(raw);
  // The wire carries no stack, no path, no key (§4.3). The operator's log does: a framework
  // failure that is only ever `SKW_E_PLT_INTERNAL` is a bug nobody can find — this line is
  // why the S4a editor's 500 named its own cause on the first run.
  process.stderr.write(`unhandled: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  reply.code(HTTP[code] ?? 500).type('application/json; charset=utf-8');
  void reply.send({ error: { code, requestId } });
}

function describe(err: unknown): string {
  const e = err as { code?: string; message?: string };
  return e.code ?? e.message ?? 'unknown error';
}

/**
 * S4e: the SQLite errors a second process writing the same file can produce for one request.
 * Narrow on purpose — a `SQLITE_CORRUPT` is not retried, and neither is a refusal we raised.
 */
function isTransientSqlite(err: unknown): boolean {
  const code = (err as { code?: string }).code;
  return code === 'SQLITE_CANTOPEN' || code === 'SQLITE_BUSY' || code === 'SQLITE_BUSY_SNAPSHOT' || code === 'SQLITE_SCHEMA';
}

/** One `Accept` decision, in the one place that has to make it. */
function wantsHtml(req: FastifyRequest): boolean {
  const accept = req.headers.accept;
  return typeof accept === 'string' && accept.includes('text/html');
}

interface RegistryFile {
  components: {
    name: string;
    kind: string;
    renderer: string;
    version: string;
    bindings?: unknown;
    props?: unknown;
    repeat_child?: string;
    limit_max?: number;
  }[];
}

function readComponentRegistry(schemaDir: string): RegistryFile {
  return JSON.parse(readFileSync(join(schemaDir, 'component-registry.json'), 'utf8')) as RegistryFile;
}

/** §2.3 step 5: upsert the image's registry inside one transaction. */
function upsertRegistry(file: string, registry: RegistryFile, expectedVersion: number): void {
  const db = openAdminWrite(file);
  try {
    const version = Number(db.pragma('user_version', { simple: true }));
    if (version !== expectedVersion) return;
    const insert = db.prepare(
      `INSERT INTO cms_component_registry
         (name, kind, renderer, repeat_child, bindings_json, props_schema_json, limit_max, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         kind = excluded.kind, renderer = excluded.renderer, repeat_child = excluded.repeat_child,
         bindings_json = excluded.bindings_json, props_schema_json = excluded.props_schema_json,
         limit_max = excluded.limit_max, version = excluded.version`,
    );
    const tx = db.transaction(() => {
      for (const c of registry.components) {
        insert.run(
          c.name,
          c.kind,
          c.renderer,
          c.repeat_child ?? null,
          JSON.stringify(c.bindings ?? []),
          JSON.stringify(c.props ?? {}),
          c.limit_max ?? null,
          c.version,
        );
      }
    });
    tx();
  } finally {
    db.close();
  }
}

export async function start(): Promise<void> {
  const env = loadEnv();
  const handle = await buildApp({ env });
  await handle.app.listen({ port: env.port, host: '0.0.0.0' });
  process.stdout.write(`skunkworks app listening on :${env.port} build=${env.buildId}\n`);

  const shutdown = async (signal: string): Promise<void> => {
    process.stdout.write(`shutting down on ${signal}\n`);
    await handle.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

function isMain(metaUrl: string): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return fileURLToPath(metaUrl) === entry;
}

if (isMain(import.meta.url)) {
  start().catch((err: unknown) => {
    if (err instanceof BootRefusal) {
      process.stderr.write(`${err.message}\n`);
      process.exit(err.exitCode);
    }
    process.stderr.write(`refusing to start: ${describe(err)}\n`);
    process.exit(1);
  });
}
