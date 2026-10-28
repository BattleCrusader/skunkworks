/**
 * Fractional Works — the site, built from one script.
 *
 * The copy lives in `scripts/content/fractionalworks.ts`; the settings, pages, menus, form and
 * per-page search metadata live in `scripts/content/fractionalworks-site.ts`. This file is only the
 * writer: it opens the tenant's database and applies that definition.
 *
 *   node --no-warnings --experimental-strip-types scripts/seed-fractionalworks.ts --tenant fractional
 *
 * ## When to use this and when to use the update script
 *
 * This script **builds** the site: it upserts all six pages, clears the header and footer menus and
 * rewrites them, and writes the settings and the form row. That is right for a fresh tenant and
 * wrong for a live one, because `DELETE FROM cms_nav` takes any menu row an operator added with it.
 *
 * To change the copy on a site that is already live, run `scripts/update-fractionalworks.ts`
 * instead: it touches only the six seeded paths, the settings it owns, the enquiry form, and the
 * header/footer rows it recognises as its own.
 */
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  CONFIG,
  FOOTER_NAV,
  FOOTER_TEXT,
  FORM_FIELDS,
  FORM_KEY,
  FORM_TITLE,
  HEADER_NAV,
  PAGES,
  RETIRED_PATHS,
  SITE_TITLE,
} from './content/fractionalworks-site.ts';

const SHA = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/* ------------------------------------------------------------------ writing it */

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 || process.argv[index + 1] === undefined ? fallback : (process.argv[index + 1] as string);
}

const dataDir = arg('data', 'data');
const tenant = arg('tenant', 'fractional');
const siteDb = join(dataDir, 'tenants', tenant, 'site.db');
if (!existsSync(siteDb)) {
  process.stderr.write(`no tenant database at ${siteDb}\n`);
  process.exit(1);
}

const db = new Database(siteDb);
db.pragma('busy_timeout = 5000');
const now = new Date().toISOString();

function setting(key: string, value: string | boolean, type: 'string' | 'bool'): void {
  db.prepare(
    `INSERT INTO cms_settings (key, value_json, type, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, type = excluded.type, updated_at = excluded.updated_at`,
  ).run(key, JSON.stringify(value), type, now);
}

db.transaction(() => {
  setting('site.title', SITE_TITLE, 'string');
  setting('site.footer_text', FOOTER_TEXT, 'string');
  setting('site.header_sticky', true, 'bool');
  setting('site.footer_sticky', false, 'bool');
  // The look is a theme package the operator uploads and activates; a site that also carried
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

  // A site built over an older one must not keep the brochure's retired page: the six rows above
  // are the site, and a leftover `/careers` would be a seventh page nothing links to.
  const findRetired = db.prepare(`SELECT id FROM cms_page WHERE path = ?`);
  for (const path of RETIRED_PATHS) {
    const row = findRetired.get(path) as { id: number } | undefined;
    if (row === undefined) continue;
    db.prepare('DELETE FROM cms_page_revision WHERE page_id = ?').run(row.id);
    db.prepare('DELETE FROM cms_page WHERE id = ?').run(row.id);
  }

  db.prepare('DELETE FROM cms_nav').run();
  const addNav = db.prepare(
    `INSERT INTO cms_nav (location, label, href_kind, href_target, position, visible) VALUES (?, ?, ?, ?, ?, 1)`,
  );
  HEADER_NAV.forEach((item, index) => addNav.run('header', item.label, item.kind, item.href, index));
  FOOTER_NAV.forEach((item, index) => addNav.run('footer', item.label, item.kind, item.href, index));

  db.prepare(
    `INSERT INTO cms_form (key, title, fields_json, mode, notify_email, created_at)
     VALUES (?, ?, ?, 'store', ?, ?)
     ON CONFLICT(key) DO UPDATE SET title = excluded.title, fields_json = excluded.fields_json,
       mode = excluded.mode, notify_email = excluded.notify_email`,
  ).run(FORM_KEY, FORM_TITLE, JSON.stringify(FORM_FIELDS), CONFIG.BUSINESS_EMAIL, now);
})();

const pages = db.prepare(`SELECT path, title, length(body_html) AS bytes FROM cms_page WHERE status = 'published' ORDER BY path`).all() as {
  path: string;
  title: string;
  bytes: number;
}[];
const nav = (db.prepare(`SELECT COUNT(*) AS n FROM cms_nav`).get() as { n: number }).n;
const form = db.prepare(`SELECT key, mode FROM cms_form WHERE key = ?`).get(FORM_KEY) as
  | { key: string; mode: string }
  | undefined;
const seo = db.prepare(`SELECT path, json_valid(seo_json) AS ok FROM cms_page WHERE seo_json IS NOT NULL`).all() as {
  path: string;
  ok: number;
}[];
db.close();

process.stdout.write(
  `seeded ${tenant}: ${String(pages.length)} pages, ${String(nav)} menu rows, form ${form?.key ?? 'MISSING'} (${form?.mode ?? '-'})\n` +
    pages.map((page) => `  ${page.path.padEnd(18)} ${String(page.bytes).padStart(6)} B  ${page.title}\n`).join('') +
    `  seo_json valid: ${seo.map((row) => `${row.path}=${row.ok === 1 ? 'yes' : 'NO'}`).join(' ')}\n`,
);
