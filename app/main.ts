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
 *   6. bind run/plugin.sock and spawn one child per package  <- NOT S1 (S4)
 */
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
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
import { createRenderData } from './render/data.ts';
import { PREVIEW_PARAM, loadPageForRender } from './render/preview.ts';
import { SourceCache } from './sources/cache.ts';
import { startSealScheduler, type SealSchedulerHandle } from './audit/scheduler.ts';
import { TenantMap } from './tenancy/cache.ts';
import { listenerFor } from './tenancy/listener.ts';
import { normaliseHost } from './tenancy/normalise-host.ts';
import { resolveTenant, TENANT_HEADER, type Listener, type Tenant } from './tenancy/resolve.ts';

// §9.1 (E-2) lives in tenancy/listener.ts so the admin router shares one rule;
// re-exported here because that is the import path the S1 gate uses.
export { listenerFor };

type AstroHandler = (
  req: FastifyRequest['raw'],
  res: FastifyReply['raw'],
  next?: (err?: unknown) => void,
  locals?: object,
) => void | Promise<void>;

export interface AppHandle {
  app: FastifyInstance;
  env: Env;
  /** The live tenant map, so a gate can assert §5.4a's one-read-per-request. */
  tenants: TenantMap;
  /** The admin surface (S2a), so a gate can inspect a session row without a socket. */
  admin: AdminSurface;
  /** The per-process source cache (§6.2), so a gate can assert a hit. */
  sources: SourceCache;
  /** The daily seal job (§9.6); stopped by `close()`. */
  seals: SealSchedulerHandle;
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
   * Where the app records one line per request it *received*.
   *
   * Not a product feature and not an environment name (§4.3 stays at 23): the
   * E-17 gate has to assert that a peer denied by nginx never reached the app,
   * and the only honest witness to "reached the app" is the app's own log.
   */
  accessLogPath?: string;
}

/**
 * §9.1 (E-2): the listener is the admin **hostname**, and that hostname is the
 * only thing that makes a request an admin request. The path never selects the
 * listener: `/admin`, `/admin/…`, `/adminish` and `/demo/<key>/admin/…` are
 * ordinary paths on a public listener. The rule itself is in
 * `tenancy/listener.ts` and is re-exported above.
 */

/** §9.1 rule 2: the admin host serves the admin surface and nothing else. */
function isAdminPath(pathname: string): boolean {
  return pathname === '/admin' || pathname.startsWith('/admin/');
}

interface RequestContext {
  listener: Listener;
  tenant: Tenant;
  via: 'header' | 'host' | 'session';
  prefix: string;
  pathname: string;
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
  const adminHost = adminHostOf(env.adminOrigin);

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
  const admin = new AdminSurface({ env, controlPath, tenants, adminHost });

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
  }

  // --- step 6 is S4: no plugin socket in S1 ---------------------------------
  process.stdout.write('plugin.sock: not bound (S4 owns the plugin runner; SDS \u00a72.3 step 6)\n');

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

  // §9.1: the admin surface is mounted on the admin hostname only. The route is
  // registered for every `/admin…` path — including on a public listener, where
  // the handler immediately hands the request to the page-miss path, which is how
  // "no admin route is mounted on a public listener" stays literally true and
  // byte-identical to any unmatched path.
  app.all('/admin', async (req: FastifyRequest, reply: FastifyReply) => {
    await admin.handle(req, reply, serveNotFound);
  });
  app.all('/admin/*', async (req: FastifyRequest, reply: FastifyReply) => {
    await admin.handle(req, reply, serveNotFound);
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
    const page = loaded.page;
    // §6: templates receive resolved data through one accessor and never a handle.
    const data = createRenderData(db, { tenantKey: ctx.tenant.key, cache: sources, audience: loaded.preview ? 'preview' : 'render' });
    const handler = await astroHandler();
    reply.raw.setHeader('cache-control', 'no-store');
    reply.hijack();
    await handler(req.raw, reply.raw, undefined, { tenantKey: ctx.tenant.key, path, page, preview: loaded.preview, data });
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
    const host = normaliseHost(req.headers.host);
    const listener = listenerFor(host, adminHost);

    const headers: Record<string, string | string[] | undefined> = {};
    for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = v;

    // §9.1 rule 1: on a public listener there is no session cookie parse at all —
    // the admin surface does not exist there, so neither does its session.
    const session = listener === 'admin' ? admin.sessionFor(req.headers.cookie) : null;

    const result = resolveTenant(
      {
        peer: req.socket.remoteAddress ?? '',
        host: req.headers.host,
        headers,
        listener,
        // Row 7 needs a tenant id; a fleet_admin session has none and resolves to
        // the 404 that "no tenant here" is (§9.2).
        session: session === null ? null : { tenantId: session.tenantId ?? -1 },
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
    // §9.1 rule 2: the admin host maps to no tenant, so any path outside
    // `/admin…` is SKW_E_PLT_TENANT_UNKNOWN — "there is no tenant here" is the
    // true statement. `/healthz` and `/readyz` are answered before this (§9.5).
    if (listener === 'admin' && !isAdminPath(pathname)) {
      throw new AppError('SKW_E_PLT_TENANT_UNKNOWN', 'the admin host serves the admin surface only');
    }
    return { listener, tenant: result.tenant, via: result.via, prefix: result.prefix, pathname };
  }

  async function close(): Promise<void> {
    seals.stop();
    pool.close();
    tenants.close();
    await app.close();
  }

  return { app, env, tenants, admin, sources, seals, close };
}

function pathnameOf(url: string): string {
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
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
  // Never a stack, never a path, never a key, never a detail (§4.3).
  reply.code(HTTP[code] ?? 500).type('application/json; charset=utf-8');
  void reply.send({ error: { code, requestId } });
}

function describe(err: unknown): string {
  const e = err as { code?: string; message?: string };
  return e.code ?? e.message ?? 'unknown error';
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
