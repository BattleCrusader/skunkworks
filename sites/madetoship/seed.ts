/**
 * Made to Ship — write the site into a tenant's database.
 *
 *     node --no-warnings --experimental-strip-types sites/madetoship/seed.ts --tenant madetoship
 *
 * One run builds the six pages, the two `cms_nav` menus, the settings and the two rows sets the
 * menu package serves. It is a **build**, not a patch: a rerun rewrites the rows the seed owns and
 * leaves nothing of a previous site behind. The copy lives in `content.ts`, the data in `site.ts`,
 * and this file is only the writer.
 *
 * **Order matters.** `p_menu_item` belongs to the menu package, which creates it when it is
 * installed on this tenant; the seed refuses to run before that rather than writing to a table the
 * host has not made. `deploy.sh` runs the install first for exactly this reason.
 *
 * A seed is a single transaction: a half-written site is worse than none, because the next run has
 * to work out which half it was looking at.
 */
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  FOOTER_NAV,
  FOOTER_TEXT,
  HEADER_NAV,
  MENU_FOOTER,
  MENU_MAIN,
  PAGES,
  RETIRED_PATHS,
  SITE_TITLE,
  type MenuRow,
} from './site.ts';

const SHA = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index === -1 ? undefined : process.argv[index + 1];
  return value === undefined || value === '' ? fallback : value;
}

const dataDir = arg('data', 'data');
const tenant = arg('tenant', 'madetoship');
const siteDb = join(dataDir, 'tenants', tenant, 'site.db');
if (!existsSync(siteDb)) {
  process.stderr.write(`no tenant database at ${siteDb} — add the tenant first (sites/madetoship/deploy.sh)\n`);
  process.exit(1);
}

const db = new Database(siteDb);
db.pragma('busy_timeout = 5000');

/** Every package the site's markup depends on, by the table it owns. Fail before writing, not after. */
const REQUIRED_TABLES: { table: string; why: string }[] = [
  { table: 'p_menu_item', why: "the home page's manifest and the About page's index read the menu package" },
  { table: 'p_contact_message', why: "the contact page's form is drawn by the contact package; without it the marker renders as nothing" },
];

const present = new Set(
  (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map((row) => row.name),
);
const missing = REQUIRED_TABLES.filter((entry) => !present.has(entry.table));
if (missing.length > 0) {
  db.close();
  process.stderr.write(
    `seed: the site needs these packages on ${tenant} first:\n` +
      missing.map((entry) => `  ${entry.table} — ${entry.why}\n`).join('') +
      `run: node --no-warnings --experimental-strip-types sites/madetoship/install-plugins.ts --tenant ${tenant}\n`,
  );
  process.exit(1);
}

// A body that still carries `__TOKEN__` is a price that reads as `__SPRINT_FEE__` on the live page.
// The fillers are supposed to have replaced every one of them; a missing replacement is a build
// failure here, not something a visitor discovers.
const unfilled = PAGES.filter((page) => /__[A-Z][A-Z0-9_]*__/.test(page.body));
if (unfilled.length > 0) {
  db.close();
  process.stderr.write(
    `seed: these pages still carry an unreplaced token: ${unfilled
      .map((page) => `${page.path} (${(/__[A-Z][A-Z0-9_]*__/.exec(page.body)?.[0] ?? '')})`)
      .join(', ')}\n`,
  );
  process.exit(1);
}

const now = new Date().toISOString();

function setting(key: string, value: string | boolean, type: 'string' | 'bool'): void {
  db.prepare(
    `INSERT INTO cms_settings (key, value_json, type, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, type = excluded.type, updated_at = excluded.updated_at`,
  ).run(key, JSON.stringify(value), type, now);
}

function writeMenus(rows: readonly MenuRow[], menus: readonly string[]): number {
  const insert = db.prepare(
    `INSERT INTO p_menu_item (menu, label, href, position, visible, created_at) VALUES (?, ?, ?, ?, 1, ?)`,
  );
  const remove = db.prepare(`DELETE FROM p_menu_item WHERE menu = ?`);
  let written = 0;
  for (const menu of menus) remove.run(menu);
  for (const row of rows) {
    insert.run(row.menu, row.label, row.href, row.position, now);
    written += 1;
  }
  return written;
}

let menuRows = 0;
let retired = 0;

db.transaction(() => {
  setting('site.title', SITE_TITLE, 'string');
  setting('site.footer_text', FOOTER_TEXT, 'string');
  setting('site.header_sticky', true, 'bool');
  setting('site.footer_sticky', false, 'bool');
  // The look is a theme package uploaded and activated on Themes. A site that also carried
  // `site.theme_css` would be two stylesheets disagreeing, so this one is empty on purpose.
  setting('site.theme_css', '', 'string');
  // Per-page descriptions live in `cms_page.seo_json`; the site-wide one stays empty so a page
  // cannot end up with two `<meta name="description">` elements.
  setting('site.description', '', 'string');

  const upsertPage = db.prepare(
    `INSERT INTO cms_page (path, slug, title, status, template, body_html, body_css, rev, body_sha, seo_json, managed_by, published_at, updated_at)
     VALUES (?, ?, ?, 'published', 'page', ?, '', 1, ?, ?, 'editor', ?, ?)
     ON CONFLICT(path) DO UPDATE SET
       slug = excluded.slug, title = excluded.title, status = 'published',
       body_html = excluded.body_html, body_css = excluded.body_css, seo_json = excluded.seo_json,
       rev = cms_page.rev + 1, body_sha = excluded.body_sha,
       published_at = excluded.published_at, updated_at = excluded.updated_at,
       draft_html = '', draft_css = '', draft_sha = ''`,
  );
  for (const page of PAGES) {
    upsertPage.run(page.path, page.slug, page.title, page.body, SHA(page.body), JSON.stringify(page.seo), now, now);
  }

  const findRetired = db.prepare(`SELECT id FROM cms_page WHERE path = ?`);
  for (const path of RETIRED_PATHS) {
    const row = findRetired.get(path) as { id: number } | undefined;
    if (row === undefined) continue;
    db.prepare('DELETE FROM cms_page_revision WHERE page_id = ?').run(row.id);
    db.prepare('DELETE FROM cms_page WHERE id = ?').run(row.id);
    retired += 1;
  }

  db.prepare('DELETE FROM cms_nav').run();
  const addNav = db.prepare(
    `INSERT INTO cms_nav (location, label, href_kind, href_target, position, visible) VALUES (?, ?, ?, ?, ?, 1)`,
  );
  HEADER_NAV.forEach((item, index) => addNav.run('header', item.label, item.kind, item.href, index));
  FOOTER_NAV.forEach((item, index) => addNav.run('footer', item.label, item.kind, item.href, index));

  menuRows = writeMenus(MENU_MAIN, ['main']) + writeMenus(MENU_FOOTER, ['footer']);
})();

const pages = db
  .prepare(`SELECT path, title, length(body_html) AS bytes FROM cms_page WHERE status = 'published' ORDER BY path`)
  .all() as { path: string; title: string; bytes: number }[];
const nav = (db.prepare(`SELECT COUNT(*) AS n FROM cms_nav`).get() as { n: number }).n;
const menuStored = db
  .prepare(`SELECT menu, COUNT(*) AS n FROM p_menu_item WHERE visible = 1 GROUP BY menu ORDER BY menu`)
  .all() as { menu: string; n: number }[];
const seo = db
  .prepare(`SELECT path, json_valid(seo_json) AS ok FROM cms_page WHERE seo_json IS NOT NULL ORDER BY path`)
  .all() as { path: string; ok: number }[];
db.close();

process.stdout.write(
  `seeded ${tenant}: ${String(pages.length)} pages, ${String(nav)} site-menu rows, ${String(menuRows)} package menu rows` +
    `${retired > 0 ? `, ${String(retired)} retired page(s)` : ''}\n` +
    pages.map((page) => `  ${page.path.padEnd(14)} ${String(page.bytes).padStart(6)} B  ${page.title}\n`).join('') +
    `  p_menu_item: ${menuStored.map((row) => `${row.menu}=${String(row.n)}`).join(' ') || 'empty'}\n` +
    `  seo_json valid: ${seo.map((row) => `${row.path}=${row.ok === 1 ? 'yes' : 'NO'}`).join(' ')}\n`,
);
