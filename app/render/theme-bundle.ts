/**
 * A theme package: one stylesheet, the files its rules name, and (optionally) a name.
 *
 * ## Why the package is the unit, and not the stylesheet
 *
 * A stylesheet is the *rules*; a theme is how the site looks, and looks have pictures. The first
 * version of this feature took one `.css` file, which meant a theme that wanted a display face or a
 * background image could only point at a URL somewhere else — and a URL somewhere else is a theme
 * that breaks when the other site moves. So a theme is a package: `theme.css` plus whatever it
 * references, uploaded as a `.zip` (what a right-click on a folder produces) or as a bare `.css`
 * (what a quick override is).
 *
 * ## Why the CSS is rewritten on the way *in*
 *
 * The sheet is served from `/_css/<sha256>.css`, a URL whose directory is not the theme's, so a
 * relative `url(assets/hero.jpg)` in it would resolve to `/_css/assets/hero.jpg` — a 404 that looks
 * like a broken image rather than a broken package. So every relative reference is resolved at
 * upload time against the package it came from, and written as the absolute URL the browser will
 * actually fetch: `/_theme/<key>/assets/hero.jpg?v=<sha8>`.
 *
 * Rewriting at upload time — not at serve time — is what keeps the sheet content-addressed: the blob
 * is the exact bytes the browser gets, so its sha is its name, so the URL can be immutable. It also
 * means the export writes the same bytes the live site served.
 *
 * ## What is not rewritten
 *
 * `data:` URIs, absolute `http(s)` URLs, protocol-relative URLs and same-document `#fragment`
 * references are left alone: the first is already inline, the second is the operator's deliberate
 * reference to something this package does not own, and the last two are not fetches of a package
 * file. A relative reference to a member the package does not contain is left alone too — it will
 * 404, which is the honest outcome of a broken package, and the test for the upload names it.
 */
import { createHash } from 'node:crypto';

import { AppError } from '../errors.ts';
import { readZip } from './zip.ts';

/** The stylesheet in a package. The same ceiling a bare `.css` upload has. */
export const THEME_MAX_BYTES = 512 * 1024;
/** One asset. */
export const ASSET_MAX_BYTES = 8 * 1024 * 1024;
/** Every asset in one package. */
export const ASSETS_TOTAL_MAX_BYTES = 32 * 1024 * 1024;

/** Where a package's files are served from, on the tenant's own origin. */
export function themeAssetUrl(themeKey: string, path: string, sha: string): string {
  return `/_theme/${encodeURIComponent(themeKey)}/${path.split('/').map(encodeURIComponent).join('/')}?v=${sha.slice(0, 8)}`;
}

/**
 * What a theme may carry.
 *
 * A whitelist and not a blacklist: the point of a theme is styling and the images and faces its
 * rules name. An `.html` or a `.js` in the package is not styling — it is a second, unmanaged site
 * living under the theme's URL — so it is refused by name rather than served with a `nosniff`
 * header and a hope.
 */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  eot: 'application/vnd.ms-fontobject',
  css: 'text/css; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  json: 'application/json',
};

export function contentTypeFor(path: string): string | undefined {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return undefined;
  return CONTENT_TYPES[path.slice(dot + 1).toLowerCase()];
}

export interface ThemeAsset {
  /** POSIX-relative, as it appears in the package: `assets/hero.jpg`. */
  path: string;
  bytes: Buffer;
  contentType: string;
  sha256: string;
}

export interface ThemeBundle {
  /** From `theme.json`, when the package has one. `null` means "use the file name". */
  name: string | null;
  css: string;
  assets: ThemeAsset[];
}

function refuse(message: string, detail?: Record<string, unknown>): never {
  throw new AppError('SKW_E_PL_REJECTED', message, detail ?? {});
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** A stylesheet is text; a NUL byte means this is not one, whatever the extension says. */
function asCssText(bytes: Buffer, name: string): string {
  if (bytes.length === 0) refuse(`${name} is empty`);
  if (bytes.length > THEME_MAX_BYTES) {
    refuse(`${name} is ${bytes.length} bytes; the limit is ${THEME_MAX_BYTES}`, { bytes: bytes.length });
  }
  const css = bytes.toString('utf8');
  if (css.includes('\u0000')) refuse(`${name} is not text; a stylesheet is text`);
  return css;
}

/** `theme.json` may rename the upload; everything else in it is the package's own business. */
function nameFromManifest(bytes: Buffer, name: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    refuse(`${name} is not valid JSON`);
  }
  if (parsed === null || typeof parsed !== 'object') refuse(`${name} must hold a JSON object`);
  const name_ = (parsed as { name?: unknown }).name;
  if (name_ === undefined) return null;
  if (typeof name_ !== 'string') refuse(`${name}: "name" must be a string`);
  const trimmed = name_.trim();
  if (trimmed === '') return null;
  if (trimmed.length > 120) refuse(`${name}: "name" is longer than 120 characters`);
  return trimmed;
}

/** The package's stylesheet: `theme.css` if it exists, else the only stylesheet at the root. */
function pickSheet(entries: readonly { path: string; bytes: Buffer }[]): { path: string; bytes: Buffer } {
  const rootSheets = entries.filter((entry) => !entry.path.includes('/') && /\.css$/i.test(entry.path));
  const named = rootSheets.find((entry) => entry.path.toLowerCase() === 'theme.css');
  if (named !== undefined) return named;
  if (rootSheets.length === 1) return rootSheets[0] as { path: string; bytes: Buffer };
  if (rootSheets.length === 0) {
    refuse('that package has no stylesheet at its root; a theme needs a theme.css');
  }
  refuse('that package has more than one stylesheet at its root; name the one to use theme.css');
}

/**
 * Read `.css` or `.zip` into a bundle.
 *
 * The filename decides, not the magic bytes: an operator who renamed a zip to `.css` gets a refusal
 * that names the file, which is more useful than a parser guessing.
 */
export function readThemeBundle(input: { filename: string; bytes: Buffer }): ThemeBundle {
  const filename = input.filename;
  if (/\.css$/i.test(filename)) {
    return { name: null, css: asCssText(input.bytes, filename), assets: [] };
  }

  const entries = readZip(input.bytes);
  const sheetEntry = pickSheet(entries);
  const assets: ThemeAsset[] = [];
  let total = 0;
  let manifest: Buffer | null = null;

  for (const entry of entries) {
    if (entry.path === sheetEntry.path) continue;
    if (entry.path.toLowerCase() === 'theme.json' && !entry.path.includes('/')) {
      manifest = entry.bytes;
      continue;
    }
    const contentType = contentTypeFor(entry.path);
    if (contentType === undefined) {
      refuse(
        `${entry.path} is not something a theme may carry (a theme holds pictures, fonts and stylesheets)`,
        { path: entry.path },
      );
    }
    if (entry.bytes.length > ASSET_MAX_BYTES) {
      refuse(`${entry.path} is ${entry.bytes.length} bytes; one asset may be ${ASSET_MAX_BYTES}`, { path: entry.path });
    }
    total += entry.bytes.length;
    if (total > ASSETS_TOTAL_MAX_BYTES) {
      refuse(`that package's assets total more than ${ASSETS_TOTAL_MAX_BYTES} bytes`);
    }
    if (entry.path.toLowerCase().endsWith('.css')) {
      // A nested stylesheet can be imported by the sheet; it is text, so it has to be text.
      asCssText(entry.bytes, entry.path);
    }
    assets.push({ path: entry.path, bytes: entry.bytes, contentType, sha256: sha256(entry.bytes) });
  }

  const css = asCssText(sheetEntry.bytes, sheetEntry.path);
  return { name: manifest === null ? null : nameFromManifest(manifest, 'theme.json'), css, assets };
}

/**
 * Point every relative reference in `css` at the file the package actually carries.
 *
 * `themeKey` is known before the CSS is stored (it is allocated from the theme's name), which is
 * what lets the rewrite happen once, at upload, rather than on every request.
 */
export function rewriteAssetUrls(css: string, themeKey: string, assets: readonly ThemeAsset[]): string {
  if (assets.length === 0) return css;
  const byPath = new Map(assets.map((asset) => [asset.path, asset]));

  const resolve = (raw: string): string | null => {
    const ref = raw.trim();
    if (ref === '') return null;
    if (/^(?:data:|https?:|\/\/|#)/i.test(ref)) return null;
    if (ref.startsWith('/')) return null;
    const cut = ref.search(/[?#]/);
    const bare = (cut < 0 ? ref : ref.slice(0, cut)).replace(/^\.\/+/, '');
    const suffix = cut < 0 ? '' : ref.slice(cut);
    const hash = suffix.startsWith('#') ? suffix : suffix.includes('#') ? `#${suffix.split('#')[1] ?? ''}` : '';
    const asset = byPath.get(bare);
    if (asset === undefined) return null;
    return `${themeAssetUrl(themeKey, asset.path, asset.sha256)}${hash}`;
  };

  // `url(...)` with an optional quote pair. The body may not contain an unescaped close paren or a
  // quote that does not match its opener — which is exactly the set of CSS URLs this must handle.
  const withUrls = css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (whole, _quote: string, ref: string) => {
    const next = resolve(ref);
    return next === null ? whole : `url("${next}")`;
  });

  // `@import "sheet.css"` / `@import url(sheet.css)` — a nested stylesheet is an asset too.
  return withUrls.replace(/@import\s+(?:url\(\s*(['"]?)([^'")]+)\1\s*\)|(['"])([^'"]+)\3)/g, (whole, _q1: string, ref1: string | undefined, _q2: string, ref2: string | undefined) => {
    const ref = ref1 ?? ref2 ?? '';
    const next = resolve(ref);
    return next === null ? whole : `@import url("${next}")`;
  });
}
