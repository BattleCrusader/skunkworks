/**
 * path -> cms_page -> shell -> html (SDS §3).
 *
 * Only the render-read class is used here (§2.2): a page read may never be
 * handed a statement built from text, and this module builds none.
 */
import type Database from 'better-sqlite3';

import { PAGE_VISIBLE, visibleBefore } from './visibility.ts';
import { AppError } from '../errors.ts';

export interface PageRecord {
  id: number;
  path: string;
  title: string;
  /** `draft` | `published` | `hidden`. Only O-29's preview may read a draft. */
  status: string;
  template: string;
  bodyHtml: string;
  bodyCss: string;
  /** `cms_page.seo_json`, raw. Parsed by `parsePageSeo` at the call site. */
  seoJson: string | null;
  updatedAt: string;
}

interface Row {
  id: number;
  path: string;
  title: string;
  status: string;
  template: string;
  body_html: string;
  body_css: string;
  seo_json: string | null;
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
 * A published, *due* page at `path`, or null. `cms_page.path` is COLLATE NOCASE, so
 * the comparison inherits case-insensitivity from the schema (O-01).
 *
 * `now` is injected for the same reason every other clock here is: a scheduled page is a
 * statement about a moment, and a test that had to sleep to observe it would be a test that
 * measures the box. Production passes nothing.
 */
export function loadPage(db: Database.Database, path: string, now: Date = new Date()): PageRecord | null {
  const row = db
    .prepare(
      `SELECT id, path, title, status, template, body_html, body_css, seo_json, updated_at
         FROM cms_page
        WHERE path = ? AND ${PAGE_VISIBLE}
        LIMIT 1`,
    )
    .get(path, visibleBefore(now)) as Row | undefined;
  if (row === undefined) return null;
  return {
    id: row.id,
    path: row.path,
    title: row.title,
    status: row.status,
    template: row.template,
    bodyHtml: row.body_html,
    bodyCss: row.body_css,
    seoJson: row.seo_json ?? null,
    updatedAt: row.updated_at,
  };
}

/**
 * The tenant resolved and there is no `cms_page` row for the path (§4.3, E-4).
 * `SKW_E_RT_PAGE_NOT_FOUND` is deliberately the least cacheable 404 in the
 * taxonomy: a page published a second later must not be shadowed by a stored miss.
 */
export function pageMiss(): AppError {
  return new AppError('SKW_E_RT_PAGE_NOT_FOUND', 'no such page');
}
