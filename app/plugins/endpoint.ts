/**
 * D25's public endpoint surface — now **in-process** (§13.3.5, §13.3.8; D36).
 *
 * The path is unchanged and deliberately narrow:
 *
 *     GET|POST /_plugin/<id>/<endpoint>
 *
 *   - the **tenant** is the Host's tenant (§5.3), never a path segment, so a package cannot
 *     name another tenant (P4). On the admin host this path is the ordinary "no tenant here".
 *   - the **route** must be declared in the installed manifest's `endpoints[]` **and**
 *     registered by `activate()` with the same method. Anything else is the tenant's ordinary
 *     404 — the same bytes as a path that has no page — so the endpoint surface is not an
 *     oracle for what is installed.
 *   - **installed but disabled** is `503 SKW_E_PL_UNAVAILABLE`; **uninstalled** is `404`.
 *   - a POST body is capped at **16 KiB**, the same cap the core form intake uses (O-30).
 *   - the answer is JSON. A package returning HTML would be third-party markup on the tenant's
 *     own origin, and v1's CSP is not a sandbox.
 *
 * What is different from the runner version, and why it matters: the handler is called with the
 * **per-request facade**, built here, on the request's own connection. There is no `grant`
 * parameter and no wire: a package cannot pass itself a wider capability than the row carries,
 * because the row is read inside the facade on every call (§13.3.7). The old `Error("SKW_E_PL_…")`
 * lifting block is gone with the socket — nothing crosses a process, so nothing needs lifting.
 */
import type Database from 'better-sqlite3';

import { AppError } from '../errors.ts';
import { assertEnabled } from './install.ts';
import type { PluginRuntime } from './runtime.ts';

/** The same 16 KiB the core form intake accepts (O-30). */
export const ENDPOINT_MAX_BODY_BYTES = 16 * 1024;

export interface EndpointMatch {
  plugin: string;
  endpoint: string;
}

const PATH = /^\/_plugin\/([a-z][a-z0-9]{1,19})\/([a-z][a-z0-9-]{0,31})\/?$/;

/** `/_plugin/<id>/<name>` or null. A query string is not part of the match. */
export function matchEndpoint(url: string): EndpointMatch | null {
  const q = url.indexOf('?');
  const path = q === -1 ? url : url.slice(0, q);
  const match = PATH.exec(path);
  if (match === null) return null;
  return { plugin: match[1] as string, endpoint: match[2] as string };
}

export interface EndpointRequest {
  /** The tenant's `site.db`, opened by the caller (read-write: host ops write). */
  db: Database.Database;
  tenant: string;
  plugin: string;
  endpoint: string;
  method: string;
  url: string;
  body: string;
  /** The audit row for a capability refusal, when the caller has one. */
  audit?: ((action: string, detail: Record<string, unknown>) => void) | undefined;
}

/**
 * Resolve, authorise and invoke. Returns `null` when the path names nothing this tenant can
 * reach — the caller serves its ordinary 404 — and throws for the two states §13.3.8 names:
 * disabled (503) and a package whose activation failed (503).
 */
export async function runEndpoint(runtime: PluginRuntime, req: EndpointRequest): Promise<unknown | null> {
  const manifest = installedManifest(req.db, req.plugin);
  if (manifest === undefined) return null;
  const declared = (manifest.endpoints ?? []).find((e) => e.name === req.endpoint);
  if (declared === undefined || declared.method !== req.method) return null;
  // `assertEnabled` refuses a disabled package, a package with no test report and one that is
  // not installed — the same three refusals the activation path uses, because it is the same row.
  assertEnabled(req.db, req.plugin);
  const body = req.body;
  if (Buffer.byteLength(body, 'utf8') > ENDPOINT_MAX_BODY_BYTES) {
    throw new AppError('SKW_E_PLT_BODY_TOO_LARGE', `a plugin endpoint body is capped at ${ENDPOINT_MAX_BODY_BYTES} bytes`, {
      plugin: req.plugin,
      endpoint: req.endpoint,
      limit: ENDPOINT_MAX_BODY_BYTES,
    });
  }
  const registered = runtime.endpoint(req.tenant, req.plugin, req.method, req.endpoint);
  if (registered === undefined) {
    // Declared in the manifest and not registered by `activate()`: the package is installed but
    // its code did not claim the route, which is a 503 for the same reason a failed activation
    // is — the endpoint exists and cannot be answered. Never a 404, which would say the tenant
    // does not have the package.
    throw new AppError(
      'SKW_E_PL_UNAVAILABLE',
      `${req.plugin} declares ${req.method} ${req.endpoint} but did not register it at activation`,
      { plugin: req.plugin, endpoint: req.endpoint },
    );
  }
  const q = req.url.indexOf('?');
  const query: Record<string, string> = {};
  if (q !== -1) for (const [k, v] of new URLSearchParams(req.url.slice(q + 1))) query[k] = v;

  const ctx = runtime.makeContext(req.tenant, req.plugin, 'endpoint', req.db, req.audit);
  try {
    return await registered.handler({
      method: req.method,
      query,
      body,
      // The per-request facade. A package that ignores it can still `import('better-sqlite3')`
      // — that is §13.3.7, stated on the install screen, not a gap in this file.
      facade: ctx.facade,
      ctx,
    });
  } finally {
    ctx.close();
  }
}

/**
 * The installed manifest without the throwing half of `assertEnabled`: a package that is not
 * installed and one that is installed-but-disabled must NOT look the same on the wire, so the
 * caller needs to tell "no row" (404) from "row, disabled" (503).
 */
function installedManifest(
  db: Database.Database,
  plugin: string,
): { endpoints?: { name: string; method: string }[] } | undefined {
  const table = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cms_plugin_installed'`).get();
  if (table === undefined) return undefined;
  const row = db.prepare('SELECT manifest_json FROM cms_plugin_installed WHERE plugin_id = ?').get(plugin) as
    | { manifest_json: string }
    | undefined;
  if (row === undefined) return undefined;
  return JSON.parse(row.manifest_json) as { endpoints?: { name: string; method: string }[] };
}
