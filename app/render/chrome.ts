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
 *   site.description    string     one sentence for `<meta name="description">` and the sitemap
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

import type { NavItem } from './nav.ts';

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
  description: 'site.description',
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
  /**
   * One sentence about the site, for `<meta name="description">`, `robots.txt`'s neighbour
   * (`/sitemap.xml` does not read it) and nothing else. `''` = no tag, which is what a tenant
   * that never opened the Site screen emits — and what keeps the exported shell identical.
   */
  description: string;
}

/** What a tenant that has never opened the Site screen renders. */
export const CHROME_DEFAULTS: SiteChrome = {
  title: '',
  logoKey: '',
  headerSticky: true,
  footerSticky: false,
  footerText: '',
  themeCss: '',
  description: '',
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
  [CHROME_KEYS.description]: 'string',
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
    case CHROME_KEYS.description:
      return 'description';
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
    description: read(CHROME_KEYS.description, 'string') as string,
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
    chrome.description !== '' ||
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

/**
 * The description as it may be interpolated into `<meta content="…">`.
 *
 * Astro escapes `&` and `"` in an attribute, which is what actually keeps the value inside it —
 * but it leaves `<` alone, so a description typed as `Widgets <script>` reaches the head with a
 * `<script>` in it. Inside a quoted attribute that is inert text and not an element, and yet a
 * sentence does not need a `<` at all. Stripping it is the same lock `themeCss` applies, for the
 * same reason: the value is data, and it should not look like markup even in a place where it
 * cannot run.
 */
export function descriptionText(chrome: SiteChrome): string {
  return chrome.description.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();
}

/** The five characters Astro escapes, as one function — the editor's chrome is compared with the shell's. */
function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * S8s: the header and footer as the shell writes them, for the editor's canvas.
 *
 * The canvas is an iframe holding the page body; without the bar above it and the sentence below
 * it, an operator cannot see what the page will look like in place — they see a document floating
 * in an editor. This is the same markup the shell emits, built from the same `SiteChrome` and the
 * same `cms_nav` tree, and `test/admin-editor-frame.test.ts` compares the menu and identity it
 * produces with the live page's, so the two cannot drift apart quietly.
 *
 * Returns `null` when the shell would draw neither bar (no identity, no menu, no footer text).
 */
export function chromeHtml(
  chrome: SiteChrome,
  nav: { header: NavItem[]; footer: NavItem[] },
  logoUrl: string | null,
  menu: (items: readonly NavItem[], className: string, current?: string) => string,
  /** The path being drawn, so the menu can mark itself with `aria-current="page"`. */
  current?: string,
): { header: string; footer: string } | null {
  const identity = chrome.title !== '' || logoUrl !== null;
  const headerBar = identity || nav.header.length > 0;
  const footerBar = nav.footer.length > 0 || chrome.footerText !== '';
  if (!headerBar && !footerBar) return null;
  const header = headerBar
    ? `<header class="site-header${chrome.headerSticky ? ' site-header--sticky' : ''}">` +
      (identity
        ? `<a class="site-id" href="/">${logoUrl === null ? '' : `<img src="${esc(logoUrl)}" alt="">`}<span>${esc(chrome.title)}</span></a>`
        : '') +
      (nav.header.length > 0 ? `<nav aria-label="Main">${menu(nav.header, 'site-menu', current)}</nav>` : '') +
      `</header>`
    : '';
  const footer = footerBar
    ? `<footer class="site-footer${chrome.footerSticky ? ' site-footer--sticky' : ''}">` +
      (nav.footer.length > 0 ? `<nav aria-label="Footer">${menu(nav.footer, 'site-menu site-menu--footer', current)}</nav>` : '') +
      (chrome.footerText !== '' ? `<p class="site-footer__text">${esc(chrome.footerText)}</p>` : '') +
      `</footer>`
    : '';
  return { header, footer };
}

export function chromeCss(chrome: SiteChrome): string {
  return [
    '.site-header{display:flex;align-items:center;gap:1rem;padding:.75rem 1rem;border-bottom:1px solid rgba(0,0,0,.12);background:Canvas}',
    '.site-header--sticky{position:sticky;top:0;z-index:20}',
    '.site-id{display:inline-flex;align-items:center;gap:.5rem;font-weight:600;text-decoration:none;color:inherit}',
    '.site-id img{height:1.75rem;width:auto}',
    '.site-menu{display:flex;flex-wrap:wrap;gap:.75rem;margin:0;padding:0;list-style:none}',
    '.site-menu a{color:inherit}',
    // A menu says which page you are on. The shell marks the matching link with aria-current, so
    // any theme can style it without enumerating its own paths — and a page added after the theme
    // was written is styled the day it is added.
    //
    // Weight only, no `text-decoration`: a theme that draws its own rule under the current item
    // (madetoship draws a border) would then show two lines, one under the other. Weight is a
    // default a theme can override without leaving a mark on the page.
    '.site-menu a[aria-current="page"]{font-weight:600}',
    '.site-footer{padding:1rem;border-top:1px solid rgba(0,0,0,.12);background:Canvas}',
    '.site-footer--sticky{position:sticky;bottom:0;z-index:20}',
    // No `opacity` here. It was `.75`, and Lighthouse's only accessibility finding on the live
    // site was the footer sentence failing colour contrast: a translucent grey over paper is a
    // lighter grey, and 4.97:1 became 3.6:1. A default that fails AA in the theme nobody edited
    // is a defect in the default.
    '.site-footer__text{margin:.5rem 0 0}',
    // Site search (`/search`). Base styles, so the shell's own page is legible in a theme that has
    // never heard of it; a theme that wants its own look overrides these by name.
    '.skw-search{max-width:46rem}',
    '.skw-search__lede{margin:.5rem 0 1.5rem}',
    '.skw-search__form{margin:0 0 1.5rem}',
    '.skw-search__label{display:block;font-size:.8rem;text-transform:uppercase;letter-spacing:.08em;margin:0 0 .4rem}',
    '.skw-search__row{display:flex;gap:.5rem;flex-wrap:wrap}',
    '.skw-search__input{flex:1 1 14rem;min-width:0;padding:.6rem .7rem;font:inherit;border:1px solid rgba(0,0,0,.35);border-radius:.2rem;background:Canvas;color:CanvasText}',
    '.skw-search__submit{padding:.6rem 1.1rem;font:inherit;border:1px solid currentColor;border-radius:.2rem;background:transparent;color:inherit;cursor:pointer}',
    '.skw-search__hits{list-style:none;margin:0;padding:0}',
    '.skw-search__hit{padding:.9rem 0;border-top:1px solid rgba(0,0,0,.14)}',
    '.skw-search__link{font-weight:600}',
    '.skw-search__where{margin-left:.5rem;font-size:.78rem;opacity:.7}',
    '.skw-search__snippet{margin:.35rem 0 0}',
    chrome.headerSticky || chrome.footerSticky ? '' : '',
  ]
    .filter((line) => line !== '')
    .join('\n');
}
