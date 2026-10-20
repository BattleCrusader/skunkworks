/**
 * path -> cms_page -> shell -> html (SDS §3).
 *
 * Only the render-read class is used here (§2.2): a page read may never be
 * handed a statement built from text, and this module builds none.
 */
import type Database from 'better-sqlite3';
import { AppError } from '../errors.ts';

export interface PageRecord {
  id: number;
  path: string;
  title: string;
  template: string;
  bodyHtml: string;
  bodyCss: string;
  updatedAt: string;
}

interface Row {
  id: number;
  path: string;
  title: string;
  template: string;
  body_html: string;
  body_css: string;
  updated_at: string;
}

/** The request path, decoded; null when it cannot name a page. */
export function normalisePagePath(rawUrl: string): string | null {
  let pathname: string;
  try {
    pathname = new URL(rawUrl, 'http://placeholder.invalid').pathname;
  } catch {
    return null;
  }
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (!pathname.startsWith('/')) return null;
  if (pathname.includes('..') || pathname.includes('//')) return null;
  if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);
  return pathname;
}

/**
 * A published page at `path`, or null. `cms_page.path` is COLLATE NOCASE, so
 * the comparison inherits case-insensitivity from the schema (O-01).
 */
export function loadPage(db: Database.Database, path: string): PageRecord | null {
  const row = db
    .prepare(
      `SELECT id, path, title, template, body_html, body_css, updated_at
         FROM cms_page
        WHERE path = ? AND status = 'published'
        LIMIT 1`,
    )
    .get(path) as Row | undefined;
  if (row === undefined) return null;
  return {
    id: row.id,
    path: row.path,
    title: row.title,
    template: row.template,
    bodyHtml: row.body_html,
    bodyCss: row.body_css,
    updatedAt: row.updated_at,
  };
}

/**
 * SDS §4.3 has no code for "page not found inside a resolved tenant". The only
 * 404 code in the taxonomy is SKW_E_PLT_TENANT_UNKNOWN, so that is what a page
 * miss returns — recorded as a spec defect in docs/build/S1-report.md rather
 * than inventing a new code.
 */
export function pageMiss(): AppError {
  return new AppError('SKW_E_PLT_TENANT_UNKNOWN', 'no such page');
}
