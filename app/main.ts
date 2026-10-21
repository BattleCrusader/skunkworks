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
import { randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BootRefusal, adminHostOf, loadEnv, type Env } from './env.ts';
import { AppError, errorBody, frameworkCode, HTTP } from './errors.ts';
import { RenderPool, openAdminWrite } from './db/classes.ts';
import { AdminSurface } from './admin/routes.ts';
import {
  EXIT_CONTROL_FAILED,
  findProjectRoot,
  migrateControl,
  migrateTenant,
  runMigrations,
  targetVersion,
} from './db/migrate.ts';
import { normalisePagePath, pageMiss } from './render/page.ts';
import { renderStoredBody } from './render/body.ts';
import { loadNav } from './render/nav.ts';
import { CSP_HEADER, cspPolicy, cspPolicyWithNonce } from './render/csp.ts';
import { createRenderData } from './render/data.ts';
import { PREVIEW_PARAM, loadPageForRender } from './render/preview.ts';
import { SourceCache } from './sources/cache.ts';
import { startSealScheduler, sealSummary, type SealSchedulerHandle, type SealSummary } from './audit/scheduler.ts';
import { TenantMap } from './tenancy/cache.ts';
import { normaliseHost } from './tenancy/normalise-host.ts';
import { resolveTenant, TENANT_HEADER, type Tenant } from './tenancy/resolve.ts';
import { DEFAULT_CONTENT_ROOT } from './assets/store.ts';
import { Semaphore } from './admin/auth.ts';
import { seedSettings } from './download/code.ts';
import { DownloadPlane, RETRY_ATTEMPTS } from './download/plane.ts';
import { PluginRuntime } from './plugins/runtime.ts';
import { matchEndpoint, runEndpoint } from './plugins/endpoint.ts';
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
export function isAdminDocument(url: string): boolean {
  const q = url.indexOf('?');
  const pathname = q === -1 ? url : url.slice(0, q);
  return pathname === '/admin' || pathname.startsWith('/admin/') || pathname === '/fleet' || pathname.startsWith('/fleet/');
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
  const admin = new AdminSurface({ env, controlPath, tenants, semaphore: argon, contentRoot, schemaDir });

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

  /** The key in the URL is a claim; the host (or edge header) is the resolution. Both must agree. */
  function downloadTenant(req: FastifyRequest): string {
    const ctx = resolveRequest(req);
    const key = String((req.params as { key?: string }).key ?? '');
    if (key !== ctx.tenant.key) throw new AppError('SKW_E_PLT_TENANT_UNKNOWN', 'no tenant here');
    return key;
  }

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
  async function serveNotFound(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const ctx = resolveRequest(req);
    const path = normalisePagePath(req.url);
    // §4.3 (E-4): a URL that cannot name a path is refused before a route runs.
    if (path === null) throw new AppError('SKW_E_PLT_REQUEST_INVALID', 'the request path is not a page path');
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
    if (loaded.page === null) throw pageMiss();
    const stored = loaded.page;
    // §3/§4.4: the header and footer menus are `cms_nav` rows, read here because the
    // Astro layer never opens a database (§2.2). `loadNav()` resolves every href and
    // refuses a row it cannot resolve — a menu entry pointing at a page that does not
    // exist is a dead link the CMS created itself, and the refusal names the row. It
    // runs before the body render so no response carries an unresolvable menu.
    const nav = loadNav(db);
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
    let page = { ...stored, bodyHtml: stored.bodyHtml };
    const assetUrls = new Map<string, string>();
    try {
      await plugins.sync(ctx.tenant.key);
      // §13.3.4, `asset.url`: one dispatch per asset this page names, **before** the render,
      // because the filter is async and the render is not. `assetUrlsIn` is the export
      // pre-flight's own view of the body, so the set of keys the hook sees is the set of
      // keys the render will emit — no second parser and no drift.
      for (const asset of assetUrlsIn(db, stored.bodyHtml)) {
        if (asset.url === null) continue; // gated: there is no URL to hand a filter
        const hooked = await filterSite<string>('asset.url', ctx.tenant.key, { tenant: ctx.tenant.key, key: asset.key, url: asset.url }, asset.url);
        if (hooked !== asset.url) assetUrls.set(asset.key, hooked);
      }
      page = {
        ...stored,
        bodyHtml: renderStoredBody(db, stored.bodyHtml, {
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
      // §13.3.4, `page.head`: extra `<meta>`/`<link>` markup in `<head>`, ≤ 4 KiB, and
      // nothing else — the shell interpolates the returned string inside `<head>` and the
      // filter has no parameter for the body, the status or a header.
      head = await filterSite<string>('page.head', ctx.tenant.key, { tenant: ctx.tenant.key, path }, '');
    } finally {
      plugins.leave(ctx.tenant.key);
    }
    // §6: templates receive resolved data through one accessor and never a handle.
    const data = createRenderData(db, {
      tenantKey: ctx.tenant.key,
      cache: sources,
      audience: loaded.preview ? 'preview' : 'render',
      assetUrls,
    });
    const handler = await astroHandler();
    reply.raw.setHeader('cache-control', 'no-store');
    // §10.5 (C-12): the page path hands the socket to Astro, so the policy has to be on the
    // raw response before the hijack — the `onSend` hook above never sees this reply.
    reply.raw.setHeader(CSP_HEADER, cspPolicy());
    reply.hijack();
    await handler(req.raw, reply.raw, undefined, { tenantKey: ctx.tenant.key, path, page, preview: loaded.preview, data, head, nav });
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

  async function close(): Promise<void> {
    clearInterval(sweepTimer);
    seals.stop();
    // No `plugins.close()`: there is no socket to end and no child to reap. The registry and
    // its closures die with the process, which is the whole shape of D36. The one handle the
    // runtime does own is the per-tenant read connection `sync()` caches, and that is closed.
    plugins.closeSyncHandles();
    pool.close();
    tenants.close();
    await app.close();
  }

  return { app, env, tenants, admin, sources, seals, plugins, watermark: plane.watermark, close };
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
