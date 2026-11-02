/**
 * A theme as a portable package — `skunkworks/theme/v1`, in and out.
 *
 * ## Why this exists
 *
 * A theme has always been a package on the way *in* (`readThemeBundle`: a `.css`, or a `.zip` of a
 * stylesheet plus the files it names, rewritten so every relative `url(assets/hero.woff2)` becomes
 * the absolute `/_theme/<key>/assets/hero.woff2?v=<sha8>`). There was no way out: a look could only
 * leave a box inside a whole site bundle, and two sites that wanted the same look carried two
 * copies that drifted.
 *
 * This module is the other direction, and it is deliberately the *same* artefact both ways:
 *
 *     theme.json   the manifest — the only file the importer trusts
 *     theme.css    the stylesheet, with relative references
 *     assets/…     every file the stylesheet or the manifest names
 *
 * **Relative on disk, absolute at rest.** A package names no host and no tenant, so it can move
 * between boxes. The importer runs the same rewrite the upload door runs, so the *stored* blob is
 * still content-addressed and its URL still immutable. `relativiseCss()` is that rewrite's inverse,
 * which is what makes `export(import(pkg)) == pkg` true by construction rather than by luck.
 *
 * **The manifest is checked, not believed.** Every sha256 is recomputed, every path is validated,
 * and every reference in the stylesheet must name a declared asset. A package that disagrees with
 * itself is refused by name before a byte reaches a library or a tenant. A theme that 404s its own
 * font but carries a checksum saying it is fine is the exact failure this is for.
 */
import { createHash } from 'node:crypto';

import { AppError } from '../errors.ts';
import {
  ASSETS_TOTAL_MAX_BYTES,
  ASSET_MAX_BYTES,
  THEME_MAX_BYTES,
  contentTypeFor,
  rewriteAssetUrls,
  type ThemeAsset,
} from '../render/theme-bundle.ts';
import { readZip } from '../render/zip.ts';

export const THEME_PACKAGE_SCHEMA = 'skunkworks/theme/v1';
export const THEME_MANIFEST_FILE = 'theme.json';
export const THEME_SHEET_FILE = 'theme.css';
/** The version this exporter writes. Read-side accepts this only; a newer one is its own refusal. */
export const THEME_PACKAGE_VERSION = '1.0.0';

const KEY = /^[a-z0-9][a-z0-9-]{1,63}$/;
const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

export interface PackageAsset {
  /** POSIX-relative to the package root: `assets/hero.svg`. */
  path: string;
  bytes: Buffer;
  contentType: string;
  sha256: string;
}

export interface ThemeManifest {
  schema: string;
  key: string;
  name: string;
  version: string;
  created_at: string;
  css: { path: string; sha256: string; bytes: number };
  assets: { path: string; sha256: string; bytes: number; content_type: string }[];
}

export interface ThemePackage {
  manifest: ThemeManifest;
  /** The stylesheet, with relative references — what a human edits. */
  css: string;
  assets: PackageAsset[];
  /** Everything that ships, sorted: `theme.json`, the sheet, then the assets. */
  files: { path: string; bytes: Buffer }[];
}

function refuse(code: string, message: string, detail: Record<string, unknown> = {}): never {
  throw new AppError(code, message, detail);
}

export function sha256Of(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** A package path: relative, no `..`, no leading slash, no backslashes, no control characters. */
export function packagePathProblem(path: string): string | null {
  if (path === '') return 'an empty path';
  if (path.startsWith('/')) return 'an absolute path';
  if (path.includes('\\')) return 'a backslash (zip paths are POSIX)';
  if (path.split('/').some((segment) => segment === '..' || segment === '.' || segment === '')) {
    return 'a path with an empty or relative segment';
  }
  if (/[\u0000-\u001f]/.test(path)) return 'a control character';
  if (path.length > 200) return 'a path longer than 200 characters';
  return null;
}

/**
 * Every relative reference in the sheet must name a declared asset.
 *
 * Absolute URLs, `data:`, protocol-relative and `#fragment` references are not this package's
 * business and are left alone — the same rule `rewriteAssetUrls` applies on the way in, so the two
 * cannot disagree about what a package owns.
 */
function assertRefsResolve(css: string, paths: ReadonlySet<string>): void {
  const refs = new Set<string>();
  const urlPattern = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
  const importPattern = /@import\s+(?:url\(\s*(['"]?)([^'")]+)\1\s*\)|(['"])([^'"]+)\3)/g;
  for (const match of css.matchAll(urlPattern)) refs.add(match[2] ?? '');
  for (const match of css.matchAll(importPattern)) refs.add(match[2] ?? match[4] ?? '');
  for (const raw of refs) {
    const ref = raw.trim();
    if (ref === '') continue;
    if (/^(?:data:|https?:|\/\/|#)/i.test(ref)) continue;
    if (ref.startsWith('/')) continue;
    const cut = ref.search(/[?#]/);
    const bare = (cut < 0 ? ref : ref.slice(0, cut)).replace(/^\.\//, '');
    if (bare === '') continue;
    if (!paths.has(bare)) {
      refuse('SKW_E_EXP_THEME_REF', `the stylesheet references ${bare}, which this package does not carry`, {
        path: bare,
      });
    }
  }
}

/** The absolute URLs a stored sheet holds, turned back into package-relative references. */
export function relativiseCss(css: string, themeKey: string): string {
  const prefix = `/_theme/${encodeURIComponent(themeKey)}/`;
  const restore = (raw: string): string | null => {
    const ref = raw.trim();
    if (!ref.startsWith(prefix)) return null;
    const cut = ref.indexOf('?');
    const encoded = (cut < 0 ? ref.slice(prefix.length) : ref.slice(prefix.length, cut)).split('/');
    const decoded = encoded.map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
    const suffix = cut < 0 ? '' : ref.slice(cut).replace(/^\?v=[0-9a-f]{8}/, '');
    return `${decoded.join('/')}${suffix}`;
  };

  const withUrls = css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (whole, _quote: string, ref: string) => {
    const next = restore(ref);
    return next === null ? whole : `url("${next}")`;
  });
  return withUrls.replace(
    /@import\s+(?:url\(\s*(['"]?)([^'")]+)\1\s*\)|(['"])([^'"]+)\3)/g,
    (whole, _q1: string, ref1: string | undefined, _q2: string, ref2: string | undefined) => {
      const next = restore(ref1 ?? ref2 ?? '');
      return next === null ? whole : `@import url("${next}")`;
    },
  );
}

export interface BuildInput {
  key: string;
  name: string;
  version?: string;
  /** The stylesheet **as stored** (absolute `/_theme/…` URLs) or already relative; both accepted. */
  css: string;
  assets: readonly { path: string; bytes: Buffer; contentType?: string }[];
  /** The clock. One run, one timestamp, so two exports compare equal. */
  now: string;
}

export function buildThemePackage(input: BuildInput): ThemePackage {
  if (!KEY.test(input.key)) {
    refuse('SKW_E_EXP_THEME_KEY', `"${input.key}" is not a theme key (lowercase letters, digits and dashes)`, {
      key: input.key,
    });
  }
  if (input.name.trim() === '' || input.name.length > 120) {
    refuse('SKW_E_EXP_THEME_KEY', 'a theme needs a name of 1 to 120 characters', { name: input.name });
  }
  const version = input.version ?? THEME_PACKAGE_VERSION;
  if (!VERSION.test(version)) refuse('SKW_E_EXP_THEME_KEY', `"${version}" is not a version`, { version });

  const assets: PackageAsset[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const asset of input.assets) {
    const problem = packagePathProblem(asset.path);
    if (problem !== null) refuse('SKW_E_EXP_THEME_PATH', `${asset.path} is ${problem}`, { path: asset.path });
    if (seen.has(asset.path)) refuse('SKW_E_EXP_THEME_PATH', `${asset.path} appears twice`, { path: asset.path });
    seen.add(asset.path);
    const contentType = asset.contentType ?? contentTypeFor(asset.path);
    if (contentType === undefined) {
      refuse('SKW_E_EXP_THEME_PATH', `${asset.path} is not something a theme may carry`, { path: asset.path });
    }
    if (asset.bytes.length > ASSET_MAX_BYTES) {
      refuse(
        'SKW_E_EXP_THEME_LIMIT',
        `${asset.path} is ${asset.bytes.length} bytes; one asset may be ${ASSET_MAX_BYTES}`,
        { path: asset.path },
      );
    }
    total += asset.bytes.length;
    if (total > ASSETS_TOTAL_MAX_BYTES) {
      refuse('SKW_E_EXP_THEME_LIMIT', `that package's assets total more than ${ASSETS_TOTAL_MAX_BYTES} bytes`);
    }
    assets.push({ path: asset.path, bytes: asset.bytes, contentType, sha256: sha256Of(asset.bytes) });
  }
  assets.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  // One canonical form. A tenant stores the absolute rewrite, a package stores the relative one,
  // and this is the composition of the two — so a sheet that has been through storage comes back
  // as the same bytes it left as, and quoting style cannot drift between the two directions.
  const canonicalCss = relativiseCss(
    rewriteAssetUrls(input.css, input.key, assets as readonly ThemeAsset[]),
    input.key,
  );
  const cssBytes = Buffer.from(canonicalCss, 'utf8');
  if (cssBytes.length > THEME_MAX_BYTES) {
    refuse('SKW_E_EXP_THEME_LIMIT', `the stylesheet is ${cssBytes.length} bytes; the limit is ${THEME_MAX_BYTES}`);
  }
  if (cssBytes.includes(0)) refuse('SKW_E_EXP_THEME_CSS', 'the stylesheet is not text');

  assertRefsResolve(cssBytes.toString('utf8'), seen);

  const manifest: ThemeManifest = {
    schema: THEME_PACKAGE_SCHEMA,
    key: input.key,
    name: input.name,
    version,
    created_at: input.now,
    css: { path: THEME_SHEET_FILE, sha256: sha256Of(cssBytes), bytes: cssBytes.length },
    assets: assets.map((asset) => ({
      path: asset.path,
      sha256: asset.sha256,
      bytes: asset.bytes.length,
      content_type: asset.contentType,
    })),
  };

  const files = [
    { path: THEME_MANIFEST_FILE, bytes: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8') },
    { path: THEME_SHEET_FILE, bytes: cssBytes },
    ...assets.map((asset) => ({ path: asset.path, bytes: asset.bytes })),
  ];
  return { manifest, css: cssBytes.toString('utf8'), assets, files };
}

function parseManifest(bytes: Buffer): ThemeManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    refuse('SKW_E_EXP_THEME_SCHEMA', `${THEME_MANIFEST_FILE} is not JSON`);
  }
  const manifest = parsed as Partial<ThemeManifest>;
  if (manifest.schema !== THEME_PACKAGE_SCHEMA) {
    refuse('SKW_E_EXP_THEME_SCHEMA', `that package's schema is ${String(manifest.schema)}, not ${THEME_PACKAGE_SCHEMA}`, {
      schema: manifest.schema,
    });
  }
  if (typeof manifest.key !== 'string' || !KEY.test(manifest.key)) {
    refuse('SKW_E_EXP_THEME_KEY', 'the manifest has no usable theme key', { key: manifest.key });
  }
  if (typeof manifest.name !== 'string' || manifest.name.trim() === '') {
    refuse('SKW_E_EXP_THEME_KEY', 'the manifest has no theme name');
  }
  if (typeof manifest.version !== 'string' || !VERSION.test(manifest.version)) {
    refuse('SKW_E_EXP_THEME_KEY', 'the manifest has no usable version', { version: manifest.version });
  }
  if (manifest.css === undefined || typeof manifest.css.path !== 'string') {
    refuse('SKW_E_EXP_THEME_REF', 'the manifest names no stylesheet');
  }
  if (!Array.isArray(manifest.assets)) refuse('SKW_E_EXP_THEME_SCHEMA', 'the manifest has no assets list');
  return manifest as ThemeManifest;
}

/** A package read from a directory's worth of members (a zip's entries, or files on disk). */
export function readThemePackage(members: readonly { path: string; bytes: Buffer }[]): ThemePackage {
  const byPath = new Map<string, Buffer>();
  for (const member of members) {
    const problem = packagePathProblem(member.path);
    if (problem !== null) refuse('SKW_E_EXP_THEME_PATH', `${member.path} is ${problem}`, { path: member.path });
    if (byPath.has(member.path)) refuse('SKW_E_EXP_THEME_PATH', `${member.path} appears twice`, { path: member.path });
    byPath.set(member.path, member.bytes);
  }

  const manifestBytes = byPath.get(THEME_MANIFEST_FILE);
  if (manifestBytes === undefined) {
    refuse('SKW_E_EXP_THEME_SCHEMA', `that package has no ${THEME_MANIFEST_FILE} at its root`);
  }
  const manifest = parseManifest(manifestBytes);

  const sheetPath = manifest.css.path;
  if (packagePathProblem(sheetPath) !== null || sheetPath.includes('/')) {
    refuse('SKW_E_EXP_THEME_REF', `the stylesheet must sit at the package root, not ${sheetPath}`, { path: sheetPath });
  }
  const sheet = byPath.get(sheetPath);
  if (sheet === undefined) {
    refuse('SKW_E_EXP_THEME_REF', `the manifest names ${sheetPath}, which the package does not carry`, { path: sheetPath });
  }
  if (sheet.length > THEME_MAX_BYTES) {
    refuse('SKW_E_EXP_THEME_LIMIT', `the stylesheet is ${sheet.length} bytes; the limit is ${THEME_MAX_BYTES}`);
  }
  if (sheet.includes(0)) refuse('SKW_E_EXP_THEME_CSS', 'the stylesheet is not text');
  if (sha256Of(sheet) !== manifest.css.sha256 || sheet.length !== manifest.css.bytes) {
    refuse('SKW_E_EXP_THEME_DIGEST', `${sheetPath} does not match the manifest`, {
      path: sheetPath,
      expected: manifest.css.sha256,
      actual: sha256Of(sheet),
    });
  }

  const declared = new Set<string>();
  const assets: PackageAsset[] = [];
  let total = 0;
  for (const entry of manifest.assets) {
    const problem = packagePathProblem(entry.path);
    if (problem !== null) refuse('SKW_E_EXP_THEME_PATH', `${entry.path} is ${problem}`, { path: entry.path });
    if (declared.has(entry.path)) refuse('SKW_E_EXP_THEME_PATH', `${entry.path} is declared twice`, { path: entry.path });
    declared.add(entry.path);
    const bytes = byPath.get(entry.path);
    if (bytes === undefined) {
      refuse('SKW_E_EXP_THEME_REF', `the manifest names ${entry.path}, which the package does not carry`, {
        path: entry.path,
      });
    }
    if (sha256Of(bytes) !== entry.sha256 || bytes.length !== entry.bytes) {
      refuse('SKW_E_EXP_THEME_DIGEST', `${entry.path} does not match the manifest`, {
        path: entry.path,
        expected: entry.sha256,
        actual: sha256Of(bytes),
      });
    }
    const contentType = contentTypeFor(entry.path);
    if (contentType === undefined) {
      refuse('SKW_E_EXP_THEME_PATH', `${entry.path} is not something a theme may carry`, { path: entry.path });
    }
    if (bytes.length > ASSET_MAX_BYTES) {
      refuse('SKW_E_EXP_THEME_LIMIT', `${entry.path} is ${bytes.length} bytes; one asset may be ${ASSET_MAX_BYTES}`, {
        path: entry.path,
      });
    }
    total += bytes.length;
    if (total > ASSETS_TOTAL_MAX_BYTES) {
      refuse('SKW_E_EXP_THEME_LIMIT', `that package's assets total more than ${ASSETS_TOTAL_MAX_BYTES} bytes`);
    }
    assets.push({ path: entry.path, bytes, contentType, sha256: entry.sha256 });
  }

  for (const path of byPath.keys()) {
    if (path === THEME_MANIFEST_FILE || path === sheetPath) continue;
    if (!declared.has(path)) {
      refuse('SKW_E_EXP_THEME_EXTRA', `${path} is in the package but not in its manifest`, { path });
    }
  }

  const css = sheet.toString('utf8');
  assertRefsResolve(css, declared);
  assets.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { manifest, css, assets, files: members.map((m) => ({ path: m.path, bytes: m.bytes })) };
}

/** A package read from a `.zip`, through the same reader the upload door uses. */
export function readThemePackageZip(bytes: Buffer): ThemePackage {
  return readThemePackage(readZip(bytes).map((entry) => ({ path: entry.path, bytes: entry.bytes })));
}

/** The sheet as a tenant stores it: absolute, content-addressed URLs the browser will fetch. */
export function absolutiseCss(pkg: ThemePackage): string {
  return rewriteAssetUrls(pkg.css, pkg.manifest.key, pkg.assets as readonly ThemeAsset[]);
}
