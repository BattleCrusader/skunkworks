/**
 * A package's own script, served from the tenant's origin: `GET /_plugin/<id>/f/<name>`.
 *
 * Why this exists at all: `page.head` is the only hook that can put markup in a document, and the
 * CSP for every tenant page is `script-src 'self'` with no nonce and no hash (C-12). So a package
 * that needs to run code in the visitor's browser — analytics, a cookie-free counter, a form
 * enhancer — has exactly one legal shape: a `<script src>` on this origin, whose bytes the host
 * serves. `text/html` is not on the list and never will be (§10.5); `text/javascript` is, because
 * a package is already imported into this process and this is not a new privilege for it.
 *
 * Four things are true of every response this module produces, and each is a line below:
 *
 *   1. **The bytes are inside the installation.** `realpath` of the declared path must stay under
 *      `realpath(<data>/plugins/<id>)` — the same check `runtime.load()` makes on the entry, for
 *      the same reason: the manifest was validated at install, but a symlink is data, not a
 *      manifest field.
 *   2. **The file is declared.** Not a directory listing, not "any file in the package": the
 *      manifest's `files[]` names the exact set, and a name that is not in it is a 404 that is
 *      byte-identical to a tenant that has no such path.
 *   3. **Size is capped** (`FILE_BYTES_MAX`), because a response this app reads from disk is read
 *      whole into memory and a 40 MB "script" would be a denial of service on a render.
 *   4. **The cache key is content.** `etag` is the sha256 of the bytes, so a package that ships a
 *      new script under the same name still gets a new ETag; the URL additionally carries the
 *      version (`?v=`), which is what the calling package's `page.head` markup writes.
 *
 * A disabled or uninstalled package answers `null`, and the route turns that into the tenant's
 * ordinary 404. Deliberately not 503 the way an endpoint does: a script that fails to load leaves
 * a working page, and telling a prober which packages are installed but switched off is a fact
 * with no upside for the operator.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';

import { packageDir, type Manifest } from './manifest.ts';

/** One script, read whole. 512 KiB is ~20× the largest first-party tracker and a hard ceiling. */
export const FILE_BYTES_MAX = 512 * 1024;

export interface StaticFileDeps {
  /** `<data>/plugins` — the directory the runtime installs into and loads from. */
  pluginsRoot: string;
  plugin: string;
  /** The last URL segment, e.g. `t.js`. */
  name: string;
  /** The installed row's validated manifest. */
  manifest: Manifest;
}

export interface StaticFile {
  bytes: Buffer;
  mime: string;
  etag: string;
}

/**
 * The bytes, or `null` for every "this tenant does not serve that" — undeclared, absent, outside
 * the root, too large. The caller serves its 404; it never learns which of those it was, and
 * neither does the visitor.
 */
export function readStaticFile(deps: StaticFileDeps): StaticFile | null {
  const declared = (deps.manifest.files ?? []).find((file) => file.name === deps.name);
  if (declared === undefined) return null;

  const root = packageDir(deps.pluginsRoot, deps.plugin);
  const candidate = join(root, declared.path);
  let real: string;
  try {
    // `realpath` first: a package can ship a symlink, and a symlink is not a manifest field.
    real = realpathSync(candidate);
  } catch {
    return null;
  }
  let rootReal: string;
  try {
    rootReal = realpathSync(root);
  } catch {
    return null;
  }
  if (real !== rootReal && !real.startsWith(rootReal + sep)) return null;
  if (!existsSync(real)) return null;

  let bytes: Buffer;
  try {
    const stat = statSync(real);
    if (!stat.isFile() || stat.size > FILE_BYTES_MAX) return null;
    bytes = readFileSync(real);
  } catch {
    return null;
  }
  if (bytes.length > FILE_BYTES_MAX) return null;
  return {
    bytes,
    mime: declared.mime,
    etag: `"${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}"`,
  };
}
