/**
 * Fractional Works — apply the board's copy to a tenant that is already live.
 *
 * ## Why this exists
 *
 * `seed-fractionalworks.ts` builds a site: it upserts the pages, **deletes every `cms_nav` row** and
 * rewrites both menus, and rewrites each page's byte columns unconditionally. That is correct for a
 * fresh tenant and unsafe for a live one — the delete takes any menu row an operator added, and the
 * unconditional upsert bumps `rev` and discards a draft even when the bytes are already right.
 *
 * This script changes only what it owns, and only when it differs:
 *
 *   - the six page rows at the paths in `PAGES` (and no other page), keyed on `path`;
 *   - the six `cms_settings` keys the seed writes, keyed on `key`;
 *   - the `enquiry` form row, keyed on `key`;
 *   - the header and footer rows whose label/target this script knows — rows added by an operator
 *     with another target are left alone, and a position they occupy is skipped rather than reused;
 *   - the retired `/careers` page named in `RETIRED_PATHS`, with its revisions.
 *
 * A page whose `body_sha`, title, slug and `seo_json` already match is not written at all, so a
 * second run reports every row `unchanged` and leaves every `rev` where it was. That is the
 * idempotency the seed does not have.
 *
 *   node --no-warnings --experimental-strip-types scripts/update-fractionalworks.ts --tenant fractional --dry-run
 *   node --no-warnings --experimental-strip-types scripts/update-fractionalworks.ts --tenant fractional
 *
 * Stop the app before a real run (`docker compose stop app`), then start it again: the CMS is the
 * writer of its own database and the host is a guest (docs/sites/fractionalworks/README.md).
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
  type NavItem,
  type SeededPage,
} from './content/fractionalworks-site.ts';

const SHA = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * The words the brochure used. A body that still contains one is refused **before** the transaction
 * opens, so a half-edited copy module cannot reach a live database.
 */
const FORBIDDEN = ['fractional software engineering', 'consultancy', 'consulting', 'we build your product'];

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 || process.argv[index + 1] === undefined ? fallback : (process.argv[index + 1] as string);
}

const dataDir = arg('data', 'data');
const tenant = arg('tenant', 'fractional');
const dryRun = process.argv.includes('--dry-run');
const siteDb = join(dataDir, 'tenants', tenant, 'site.db');

if (!existsSync(siteDb)) {
  process.stderr.write(`no tenant database at ${siteDb}\n`);
  process.exit(1);
}

for (const page of PAGES) {
  const surfaces: [string, string][] = [
    [`${page.path} body`, page.body],
    [`${page.path} title`, page.title],
    [`${page.path} seo_json`, JSON.stringify(page.seo)],
  ];
  for (const [where, value] of surfaces) {
    const lower = value.toLowerCase();
    for (const term of FORBIDDEN) {
      if (lower.includes(term)) {
        process.stderr.write(`refused: ${where} still contains "${term}"\n`);
        process.exit(1);
      }
    }
  }
}
for (const [where, value] of [
  ['site.footer_text', FOOTER_TEXT],
  ['site.title', SITE_TITLE],
  ...[...HEADER_NAV, ...FOOTER_NAV].map((item): [string, string] => [`nav "${item.label}"`, item.label]),
] as [string, string][]) {
  const lower = value.toLowerCase();
  for (const term of FORBIDDEN) {
    if (lower.includes(term)) {
      process.stderr.write(`refused: ${where} still contains "${term}"\n`);
      process.exit(1);
    }
  }
}

/* --------------------------------------------------------------------------- the rows */

interface PageRow {
  id: number;
  path: string;
  slug: string;
  title: string;
  status: string;
  rev: number;
  body_sha: string;
  body_html: string;
  seo_json: string | null;
}

interface SettingRow {
  key: string;
  value_json: string;
  type: string;
}

interface NavRow {
  id: number;
  label: string;
  href_kind: string;
  href_target: string;
  position: number;
  visible: number;
}

interface FormRow {
  key: string;
  title: string;
  fields_json: string;
  mode: string;
  notify_email: string | null;
}

const SETTINGS: { key: string; value: string | boolean; type: 'string' | 'bool' }[] = [
  { key: 'site.title', value: SITE_TITLE, type: 'string' },
  { key: 'site.footer_text', value: FOOTER_TEXT, type: 'string' },
  { key: 'site.header_sticky', value: true, type: 'bool' },
  { key: 'site.footer_sticky', value: false, type: 'bool' },
  { key: 'site.theme_css', value: '', type: 'string' },
  { key: 'site.description', value: '', type: 'string' },
];

/** Targets the seed wrote before this copy existed. The update is allowed to replace them. */
const PREVIOUS_NAV_TARGETS = ['/contact', '/careers'];

const db = new Database(siteDb);
db.pragma('busy_timeout = 5000');

const changes: string[] = [];
const unchanged: string[] = [];
const now = new Date().toISOString();

function pageReasons(row: PageRow | undefined, page: SeededPage, sha: string, seo: string): string[] {
  if (row === undefined) return ['created'];
  const reasons: string[] = [];
  if (row.status !== 'published') reasons.push(`status ${row.status} -> published`);
  if (row.slug !== page.slug) reasons.push('slug');
  if (row.title !== page.title) reasons.push('title');
  if (row.body_sha !== sha) reasons.push('body');
  if ((row.seo_json ?? '') !== seo) reasons.push('seo');
  return reasons;
}

function syncNav(location: 'header' | 'footer', items: NavItem[]): void {
  const rows = db
    .prepare(`SELECT id, label, href_kind, href_target, position, visible FROM cms_nav WHERE location = ? AND parent_id IS NULL ORDER BY position`)
    .all(location) as NavRow[];
  const owned = new Set([...items.map((item) => item.href), ...PREVIOUS_NAV_TARGETS]);
  const current = rows.filter((row) => owned.has(row.href_target));

  const sorted = [...current].sort((a, b) => a.position - b.position);
  const matches =
    sorted.length === items.length &&
    items.every((item, index) => {
      const row = sorted[index];
      return (
        row !== undefined &&
        row.label === item.label &&
        row.href_kind === item.kind &&
        row.href_target === item.href &&
        row.visible === 1
      );
    });
  if (matches) {
    unchanged.push(`nav ${location} (${String(items.length)} rows)`);
    return;
  }

  const remove = db.prepare('DELETE FROM cms_nav WHERE id = ?');
  for (const row of current) remove.run(row.id);

  // A position an operator's own row occupies is skipped, never reused.
  const taken = new Set(rows.filter((row) => !owned.has(row.href_target)).map((row) => row.position));
  const insert = db.prepare(
    `INSERT INTO cms_nav (location, label, href_kind, href_target, position, visible) VALUES (?, ?, ?, ?, ?, 1)`,
  );
  let position = 0;
  for (const item of items) {
    while (taken.has(position)) position += 1;
    insert.run(location, item.label, item.kind, item.href, position);
    taken.add(position);
    position += 1;
  }
  changes.push(`nav ${location}: ${current.length} row(s) replaced with ${items.length}`);
}

db.exec('BEGIN IMMEDIATE');
try {
  /* --- pages ------------------------------------------------------------------------- */
  const findPage = db.prepare(
    `SELECT id, path, slug, title, status, rev, body_sha, body_html, seo_json FROM cms_page WHERE path = ?`,
  );
  const updatePage = db.prepare(
    `UPDATE cms_page
        SET slug = ?, title = ?, status = 'published', body_html = ?, body_css = '', body_sha = ?,
            seo_json = ?, rev = rev + 1, published_at = COALESCE(published_at, ?), updated_at = ?,
            draft_html = '', draft_css = '', draft_sha = '', draft_updated_at = NULL
      WHERE id = ?`,
  );
  const insertPage = db.prepare(
    `INSERT INTO cms_page (path, slug, title, status, template, body_html, body_css, rev, body_sha, seo_json, managed_by, published_at, created_at, updated_at)
     VALUES (?, ?, ?, 'published', 'page', ?, '', 1, ?, ?, 'editor', ?, ?, ?)`,
  );

  for (const page of PAGES) {
    const row = findPage.get(page.path) as PageRow | undefined;
    const sha = SHA(page.body);
    const seo = JSON.stringify(page.seo);
    const reasons = pageReasons(row, page, sha, seo);
    if (reasons.length === 0 && row !== undefined) {
      unchanged.push(`page ${page.path.padEnd(18)} rev ${String(row.rev)}`);
      continue;
    }
    if (row === undefined) {
      insertPage.run(page.path, page.slug, page.title, page.body, sha, seo, now, now, now);
      changes.push(`page ${page.path.padEnd(18)} created                (${String(page.body.length)} B)`);
    } else {
      updatePage.run(page.slug, page.title, page.body, sha, seo, now, now, row.id);
      changes.push(
        `page ${page.path.padEnd(18)} rev ${String(row.rev)} -> ${String(row.rev + 1)}  ` +
          `(${String(row.body_html.length)} -> ${String(page.body.length)} B)  ${reasons.join(', ')}`,
      );
    }
  }

  /* --- retired pages ----------------------------------------------------------------- */
  const findRetired = db.prepare(`SELECT id, title, status FROM cms_page WHERE path = ?`);
  for (const path of RETIRED_PATHS) {
    const row = findRetired.get(path) as { id: number; title: string; status: string } | undefined;
    if (row === undefined) continue;
    db.prepare('DELETE FROM cms_page_revision WHERE page_id = ?').run(row.id);
    db.prepare('DELETE FROM cms_page WHERE id = ?').run(row.id);
    changes.push(`page ${path.padEnd(18)} retired (was ${row.status}: "${row.title}")`);
  }

  /* --- settings ---------------------------------------------------------------------- */
  const findSetting = db.prepare(`SELECT key, value_json, type FROM cms_settings WHERE key = ?`);
  const writeSetting = db.prepare(
    `INSERT INTO cms_settings (key, value_json, type, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, type = excluded.type, updated_at = excluded.updated_at`,
  );
  for (const setting of SETTINGS) {
    const row = findSetting.get(setting.key) as SettingRow | undefined;
    const value = JSON.stringify(setting.value);
    if (row !== undefined && row.value_json === value && row.type === setting.type) {
      unchanged.push(`setting ${setting.key}`);
      continue;
    }
    writeSetting.run(setting.key, value, setting.type, now);
    changes.push(`setting ${setting.key.padEnd(22)} ${row?.value_json ?? '(absent)'} -> ${value}`);
  }

  /* --- menus ------------------------------------------------------------------------- */
  syncNav('header', HEADER_NAV);
  syncNav('footer', FOOTER_NAV);

  /* --- enquiry form ------------------------------------------------------------------ */
  const form = db.prepare(`SELECT key, title, fields_json, mode, notify_email FROM cms_form WHERE key = ?`).get(FORM_KEY) as
    | FormRow
    | undefined;
  const fields = JSON.stringify(FORM_FIELDS);
  if (
    form !== undefined &&
    form.title === FORM_TITLE &&
    form.fields_json === fields &&
    form.mode === 'store' &&
    form.notify_email === CONFIG.BUSINESS_EMAIL
  ) {
    unchanged.push(`form ${FORM_KEY}`);
  } else {
    db.prepare(
      `INSERT INTO cms_form (key, title, fields_json, mode, notify_email, created_at)
       VALUES (?, ?, ?, 'store', ?, ?)
       ON CONFLICT(key) DO UPDATE SET title = excluded.title, fields_json = excluded.fields_json,
         mode = excluded.mode, notify_email = excluded.notify_email`,
    ).run(FORM_KEY, FORM_TITLE, fields, CONFIG.BUSINESS_EMAIL, now);
    changes.push(`form ${FORM_KEY} updated`);
  }

  if (dryRun) db.exec('ROLLBACK');
  else db.exec('COMMIT');
} catch (error) {
  db.exec('ROLLBACK');
  db.close();
  throw error;
}

const pagesAfter = db
  .prepare(`SELECT path, title, rev, length(body_html) AS bytes FROM cms_page WHERE status = 'published' ORDER BY path`)
  .all() as { path: string; title: string; rev: number; bytes: number }[];
const navAfter = (db.prepare(`SELECT COUNT(*) AS n FROM cms_nav`).get() as { n: number }).n;
db.close();

process.stdout.write(
  `update-fractionalworks: tenant ${tenant}${dryRun ? ' (dry run — rolled back)' : ''}\n` +
    `  ${String(changes.length)} change(s), ${String(unchanged.length)} already correct\n` +
    changes.map((line) => `  + ${line}\n`).join('') +
    `  published pages after: ${pagesAfter.map((page) => `${page.path}(rev ${String(page.rev)}, ${String(page.bytes)} B)`).join(' ')}\n` +
    `  menu rows: ${String(navAfter)}\n`,
);
