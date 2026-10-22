/**
 * Site chrome: the identity, the sticky switches and the footer sentence (`cms_settings`).
 *
 * ## Why this is settings and not a page
 *
 * A header is on every page at once. If it were a `cms_page` row, editing it would be
 * editing one page and hoping the rest of the site noticed, and a blog post — which is a
 * row in a package's table, not a page at all — could never carry it. So identity lives
 * in `cms_settings`, which every render reads, and it therefore reaches a post page for
 * the same reason it reaches `/`.
 *
 * The menus stay in `cms_nav` (`app/render/nav.ts`), because a menu is a list of rows and
 * a settings blob is not: `ux_nav_pos` orders them and the adjacency list nests them.
 *
 * ## The five keys
 *
 *   site.title          string     the site's name, rendered as a link to `/`
 *   site.logo_key       asset_key  a media-library key, rendered before the name
 *   site.header_sticky  bool       header pins to the top of the viewport
 *   site.footer_sticky  bool       footer pins to the bottom of the viewport
 *   site.footer_text    string     one sentence, under the footer menu
 *   site.theme_css      string     the site's own stylesheet, emitted on every page
 *
 * `theme_css` is the sixth key and the reason a site can look like a site: without it every
 * page is unstyled HTML unless the editor pastes the same `<style>` into each one. It is
 * emitted by the shell for every tenant page — including a page a package serves, which no
 * per-page body could reach. Two rules keep it from becoming a way out of the document: the
 * value may not contain `<` (so `</style>` cannot appear), and the render strips the closing
 * tag again on the way out. CSS, not markup.
 *
 * `cms_settings.type` is the schema's own vocabulary (`string | asset_key | bool | int |
 * json`), so a key written with the wrong type is a bug this module refuses by name
 * rather than a page that renders `undefined`.
 *
 * ## Seeding
 *
 * `seedChromeSettings` runs at boot next to the download settings and uses
 * `ON CONFLICT DO NOTHING`, so it fills in a tenant that has never opened the screen and
 * never overwrites an operator's value. Reading tolerates a missing row (`DEFAULTS`):
 * a tenant seeded by an older image has no `site.*` row and must still render.
 */
import type Database from 'better-sqlite3';

import { assetByKey } from '../assets/library.ts';
import { assetUrl } from '../assets/url.ts';
import { AppError } from '../errors.ts';

export const CHROME_KEYS = {
  title: 'site.title',
  logo: 'site.logo_key',
  headerSticky: 'site.header_sticky',
  footerSticky: 'site.footer_sticky',
  footerText: 'site.footer_text',
  theme: 'site.theme_css',
} as const;

export type ChromeKey = (typeof CHROME_KEYS)[keyof typeof CHROME_KEYS];

export interface SiteChrome {
  title: string;
  /** The media-library key, as stored. `''` when no logo is set. */
  logoKey: string;
  headerSticky: boolean;
  footerSticky: boolean;
  footerText: string;
  /** The site's own CSS, emitted inside `<style>` on every page. `''` = none. */
  themeCss: string;
}

/** What a tenant that has never opened the Site screen renders. */
export const CHROME_DEFAULTS: SiteChrome = {
  title: '',
  logoKey: '',
  headerSticky: true,
  footerSticky: false,
  footerText: '',
  themeCss: '',
};

/**
 * The declared types. `cms_settings` is an EAV table, so this is the only place the
 * meaning of a `site.*` row is written down; the Site screen validates against it and
 * `loadChrome` refuses a row whose `type` disagrees.
 */
export const CHROME_TYPES: Record<ChromeKey, 'string' | 'bool' | 'asset_key'> = {
  [CHROME_KEYS.title]: 'string',
  [CHROME_KEYS.logo]: 'asset_key',
  [CHROME_KEYS.headerSticky]: 'bool',
  [CHROME_KEYS.footerSticky]: 'bool',
  [CHROME_KEYS.footerText]: 'string',
  [CHROME_KEYS.theme]: 'string',
};

export function seedChromeSettings(db: Database.Database): string[] {
  const insert = db.prepare(
    `INSERT INTO cms_settings (key, value_json, type) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING`,
  );
  const written: string[] = [];
  for (const [key, type] of Object.entries(CHROME_TYPES) as [ChromeKey, 'string' | 'bool' | 'asset_key'][]) {
    const value =
      type === 'bool'
        ? CHROME_DEFAULTS[fieldOf(key)] === true
        : String(CHROME_DEFAULTS[fieldOf(key)] ?? '');
    const result = insert.run(key, JSON.stringify(value), type);
    if (result.changes > 0) written.push(key);
  }
  return written;
}

/** `site.header_sticky` -> `headerSticky`. The one place the naming rule lives. */
export function fieldOf(key: ChromeKey): keyof SiteChrome {
  switch (key) {
    case CHROME_KEYS.title:
      return 'title';
    case CHROME_KEYS.logo:
      return 'logoKey';
    case CHROME_KEYS.headerSticky:
      return 'headerSticky';
    case CHROME_KEYS.footerSticky:
      return 'footerSticky';
    case CHROME_KEYS.footerText:
      return 'footerText';
    case CHROME_KEYS.theme:
      return 'themeCss';
  }
}

interface Row {
  key: string;
  value_json: string;
  type: string;
}

function parseValue(row: Row, expected: 'string' | 'bool' | 'asset_key'): string | boolean {
  if (row.type !== expected) {
    throw new AppError('SKW_E_PLT_INTERNAL', `cms_settings.${row.key} is ${row.type}, not ${expected}`, {
      key: row.key,
    });
  }
  let value: unknown;
  try {
    value = JSON.parse(row.value_json);
  } catch {
    throw new AppError('SKW_E_PLT_INTERNAL', `cms_settings.${row.key} is not JSON`, { key: row.key });
  }
  if (expected === 'bool') {
    if (typeof value !== 'boolean') {
      throw new AppError('SKW_E_PLT_INTERNAL', `cms_settings.${row.key} is not a boolean`, { key: row.key });
    }
    return value;
  }
  if (typeof value !== 'string') {
    throw new AppError('SKW_E_PLT_INTERNAL', `cms_settings.${row.key} is not a string`, { key: row.key });
  }
  return value;
}

export function loadChrome(db: Database.Database): SiteChrome {
  const rows = db
    .prepare(`SELECT key, value_json, type FROM cms_settings WHERE key LIKE 'site.%'`)
    .all() as Row[];
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const read = (key: ChromeKey, type: 'string' | 'bool' | 'asset_key'): string | boolean => {
    const row = byKey.get(key);
    if (row === undefined) return type === 'bool' ? (CHROME_DEFAULTS[fieldOf(key)] as boolean) : (CHROME_DEFAULTS[fieldOf(key)] as string);
    return parseValue(row, type);
  };
  return {
    title: read(CHROME_KEYS.title, 'string') as string,
    logoKey: read(CHROME_KEYS.logo, 'asset_key') as string,
    headerSticky: read(CHROME_KEYS.headerSticky, 'bool') as boolean,
    footerSticky: read(CHROME_KEYS.footerSticky, 'bool') as boolean,
    footerText: read(CHROME_KEYS.footerText, 'string') as string,
    themeCss: read(CHROME_KEYS.theme, 'string') as string,
  };
}

/** The logo's public URL, or null when no key is set or the key names no asset. */
export function logoUrl(db: Database.Database, chrome: SiteChrome): string | null {
  if (chrome.logoKey === '') return null;
  const asset = assetByKey(db, chrome.logoKey);
  if (asset === undefined) return null;
  if (asset.access_class === 'gated') return null;
  return assetUrl(asset);
}

/**
 * True when there is anything at all to draw. A tenant with no title, no logo, no menus
 * and no footer text renders exactly the document it rendered before this module existed
 * — which is what keeps the exported static shell (`app/export/document.ts`, which never
 * receives chrome) byte-identical for a site that has not used the screen yet.
 */
export function hasChrome(chrome: SiteChrome, nav: { header: unknown[]; footer: unknown[] }): boolean {
  return (
    chrome.title !== '' ||
    chrome.logoKey !== '' ||
    chrome.footerText !== '' ||
    chrome.themeCss !== '' ||
    nav.header.length > 0 ||
    nav.footer.length > 0
  );
}

/**
 * The stylesheet the shell emits for the chrome. Kept here, not in the shell template, so
 * the sticky rules are testable as a string and the same rules can be read by the Site
 * screen's preview note.
 *
 * `position: sticky` and not `fixed`: a fixed header leaves the page's own content
 * underneath it with no offset, so the first heading of every page would sit behind the
 * bar. Sticky keeps the element in flow and pins it only while its container scrolls.
 * The `z-index` is what stops a page's own positioned content from sliding over the bar.
 */
/**
 * The site's own stylesheet, safe to interpolate inside `<style>`.
 *
 * A `<` is stripped rather than escaped: CSS has no legitimate use for one, and the only
 * sequence that could end the element early is `</style`. The save path refuses the value
 * outright; this is the second lock, because a settings row can also be written by a
 * migration or by hand.
 */
export function themeCss(chrome: SiteChrome): string {
  if (chrome.themeCss === '') return '';
  return chrome.themeCss.replace(/</g, '');
}

export function chromeCss(chrome: SiteChrome): string {
  return [
    '.site-header{display:flex;align-items:center;gap:1rem;padding:.75rem 1rem;border-bottom:1px solid rgba(0,0,0,.12);background:Canvas}',
    '.site-header--sticky{position:sticky;top:0;z-index:20}',
    '.site-id{display:inline-flex;align-items:center;gap:.5rem;font-weight:600;text-decoration:none;color:inherit}',
    '.site-id img{height:1.75rem;width:auto}',
    '.site-menu{display:flex;flex-wrap:wrap;gap:.75rem;margin:0;padding:0;list-style:none}',
    '.site-menu a{color:inherit}',
    '.site-footer{padding:1rem;border-top:1px solid rgba(0,0,0,.12);background:Canvas}',
    '.site-footer--sticky{position:sticky;bottom:0;z-index:20}',
    '.site-footer__text{margin:.5rem 0 0;opacity:.75}',
    chrome.headerSticky || chrome.footerSticky ? '' : '',
  ]
    .filter((line) => line !== '')
    .join('\n');
}
