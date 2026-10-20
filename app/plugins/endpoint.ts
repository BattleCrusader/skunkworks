/**
 * D25's public endpoint surface, host side (S4e).
 *
 * Before this file the product could install a plugin and never call one: `plugins.invoke()`
 * existed, the runner answered it, and `grep -rn 'plugins.invoke' app` found only the class.
 * A customer's first question — "where is my widget?" — had no answer. The answer is one
 * path, and it is deliberately narrow:
 *
 *     GET|POST /_plugin/<id>/<endpoint>
 *
 *   - the **tenant** is the Host's tenant (§5.3), never a path segment, so a package cannot
 *     name another tenant (P4). On the admin host this path is the ordinary "no tenant here".
 *   - the **route** must be declared in the installed manifest's `endpoints[]` and the method
 *     must match. Anything else is the tenant's ordinary 404 — the same bytes as a path that
 *     has no page — so the endpoint surface is not an oracle for what is installed.
 *   - **installed but disabled** is `503 SKW_E_PL_UNAVAILABLE` (§8.6's disable row), and the
 *     runner's own refusals (`PL_OOM`, `PL_UNAVAILABLE`, `PL_REJECTED`) cross unchanged.
 *   - a POST body is capped at **16 KiB**, the same cap the core form intake uses (O-30),
 *     refused `413 SKW_E_PLT_BODY_TOO_LARGE` before the runner is asked.
 *   - the answer is JSON. A package returning HTML would be third-party markup on the
 *     tenant's own origin; v1's CSP (`frame-src 'none'`, no third-party script origin) is not
 *     a sandbox, and pretending it is would be the kind of claim §13.3 exists to avoid.
 *
 * The response is the package's own value, unwrapped: an endpoint's contract belongs to the
 * package, and wrapping it in `{plugin, result}` would put our shape in the middle of it.
 */
import type Database from 'better-sqlite3';

import { AppError, HTTP } from '../errors.ts';
import { assertEnabled } from './install.ts';
import type { PluginHost } from './host.ts';

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
}

/**
 * Resolve, authorise and invoke. Returns `null` when the path names nothing this tenant can
 * reach — the caller serves its ordinary 404 — and throws for the two states §8.6 names:
 * disabled (503) and a runner that cannot answer (503, code from the runner).
 */
export async function runEndpoint(plugins: PluginHost, req: EndpointRequest): Promise<unknown | null> {
  const row = installedRow(req.db, req.plugin);
  if (row === undefined) return null;
  const declared = (row.manifest.endpoints ?? []).find((e) => e.name === req.endpoint);
  if (declared === undefined || declared.method !== req.method) return null;
  // `assertEnabled` refuses a disabled package, a package with no test report and one that is
  // not installed — the same three refusals the host-op path uses, because it is the same row.
  assertEnabled(req.db, req.plugin);
  const body = req.body;
  if (Buffer.byteLength(body, 'utf8') > ENDPOINT_MAX_BODY_BYTES) {
    throw new AppError('SKW_E_PLT_BODY_TOO_LARGE', `a plugin endpoint body is capped at ${ENDPOINT_MAX_BODY_BYTES} bytes`, {
      plugin: req.plugin,
      endpoint: req.endpoint,
      limit: ENDPOINT_MAX_BODY_BYTES,
    });
  }
  const q = req.url.indexOf('?');
  const query: Record<string, string> = {};
  if (q !== -1) for (const [k, v] of new URLSearchParams(req.url.slice(q + 1))) query[k] = v;
  try {
    return await plugins.invoke(
      req.tenant,
      req.plugin,
      req.endpoint,
      {
        method: req.method,
        query,
        body,
      },
      // The grant this request is authorised by: the row `assertEnabled()` just read. The
      // runner refuses anything outside it before the host is asked, so the two layers see
      // one value and the second one does not depend on the first.
      row.manifest.capabilities ?? [],
    );
  } catch (err) {
    // The runner's refusals arrive as `Error("SKW_E_PL_…: detail")` because they cross a
    // socket, and an `Error` that reaches Fastify's handler is a 500. §8.6's contract is
    // 503 `PL_UNAVAILABLE` for a package that cannot answer, and `PL_OOM` for one that was
    // killed — so the code is lifted back into the taxonomy here, at the one boundary where
    // a runner message becomes an HTTP response.
    const text = err instanceof Error ? err.message : String(err);
    const match = /^(SKW_E_[A-Z0-9_]+):\s*([\s\S]*)$/.exec(text);
    if (match !== null && HTTP[match[1] as string] !== undefined) {
      throw new AppError(match[1] as string, match[2] as string, { plugin: req.plugin, endpoint: req.endpoint });
    }
    throw err;
  }
}

/**
 * The installed row without the throwing half of `assertEnabled`: a package that is not
 * installed and one that is installed-but-disabled must NOT look the same on the wire, so
 * the caller needs to tell "no row" (404) from "row, disabled" (503).
 */
function installedRow(
  db: Database.Database,
  plugin: string,
): { manifest: { endpoints?: { name: string; method: string }[]; capabilities?: string[] } } | undefined {
  const table = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cms_plugin_installed'`).get();
  if (table === undefined) return undefined;
  const row = db.prepare('SELECT manifest_json FROM cms_plugin_installed WHERE plugin_id = ?').get(plugin) as
    | { manifest_json: string }
    | undefined;
  if (row === undefined) return undefined;
  return {
    manifest: JSON.parse(row.manifest_json) as { endpoints?: { name: string; method: string }[]; capabilities?: string[] },
  };
}
