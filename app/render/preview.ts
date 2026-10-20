/**
 * O-29 (D-82) — the preview token.
 *
 *     GET <path>?preview=<token>
 *     token = "<exp>.<hex HMAC-SHA256(SKW_SESSION_KEY, tenant|path|exp)>"
 *
 * The four rules the record fixes, and where each lives:
 *
 *   - **minted in admin, 30-minute TTL** — `mintPreviewToken` takes the clock, so
 *     the TTL is arithmetic and a gate can prove it without waiting;
 *   - **accepted only for `status='draft'`** — `loadPageForRender` refuses the token
 *     on a published page (it is not a way to see a published page early, and it is
 *     not a way to see a hidden one);
 *   - **`Cache-Control: no-store`** — `main.ts` sets it on every render already; the
 *     preview path adds nothing that could be cached;
 *   - **logged once per render** — the log is written only after the page and the
 *     token both pass, so a refused token is not an accepted render.
 *
 * The token is bound to **one tenant and one path**. `main.ts` passes the resolved
 * tenant and the normalised path, never the raw URL, so a `..` or a re-encoded path
 * cannot re-point a token at another page.
 *
 * Verification order mirrors §7.4's token discipline: split, parse `exp`, require a
 * **64-hex MAC before comparing** (a length mismatch makes `timingSafeEqual` throw
 * and turn a 404 into a 500), compare, then check the window.
 */
import type Database from 'better-sqlite3';
import { createHmac, timingSafeEqual } from 'node:crypto';

import { AppError } from '../errors.ts';
import { loadPage, type PageRecord } from './page.ts';

export const PREVIEW_TTL_MS = 30 * 60 * 1000;
export const PREVIEW_PARAM = 'preview';
const MAC_RE = /^[0-9a-f]{64}$/;
const EXP_RE = /^[0-9]{1,12}$/;

function mac(tenantKey: string, path: string, exp: number, sessionKey: string): string {
  return createHmac('sha256', sessionKey).update(`${tenantKey}|${path}|${exp}`).digest('hex');
}

/** Mint a token for one tenant and one path. */
export function mintPreviewToken(tenantKey: string, path: string, sessionKey: string, nowMs: number = Date.now()): string {
  if (sessionKey === '') throw new AppError('SKW_E_PLT_INTERNAL', 'SKW_SESSION_KEY is not set');
  const exp = Math.floor(nowMs / 1000) + PREVIEW_TTL_MS / 1000;
  return `${exp}.${mac(tenantKey, path, exp, sessionKey)}`;
}

export function verifyPreviewToken(
  token: string | null | undefined,
  tenantKey: string,
  path: string,
  sessionKey: string,
  nowMs: number = Date.now(),
): boolean {
  if (typeof token !== 'string' || token === '' || sessionKey === '') return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [expText, supplied] = parts as [string, string];
  if (!EXP_RE.test(expText) || !MAC_RE.test(supplied)) return false;
  const exp = Number(expText);
  const expected = Buffer.from(mac(tenantKey, path, exp, sessionKey), 'hex');
  const given = Buffer.from(supplied, 'hex');
  // Both are 32 bytes by the regex above; the length check stays explicit because
  // a future format change must not turn `timingSafeEqual` into a 500.
  if (expected.length !== 32 || given.length !== 32) return false;
  if (!timingSafeEqual(expected, given)) return false;
  const nowSeconds = Math.floor(nowMs / 1000);
  const remaining = exp - nowSeconds;
  return remaining >= 0 && remaining <= PREVIEW_TTL_MS / 1000;
}

export type PreviewLog = (line: string) => void;

export interface LoadPageOptions {
  tenantKey: string;
  path: string;
  token?: string | null;
  sessionKey: string;
  nowMs?: number;
  log?: PreviewLog;
}

export interface LoadedPage {
  page: PageRecord | null;
  preview: boolean;
}

interface Row {
  id: number;
  path: string;
  title: string;
  status: string;
  template: string;
  body_html: string;
  body_css: string;
  updated_at: string;
}

function toRecord(row: Row): PageRecord {
  return {
    id: row.id,
    path: row.path,
    title: row.title,
    status: row.status,
    template: row.template,
    bodyHtml: row.body_html,
    bodyCss: row.body_css,
    updatedAt: row.updated_at,
  };
}

/**
 * The render path's one page lookup. Without a valid token it is the published
 * lookup S1 shipped; with one it can see a **draft** and nothing else.
 */
export function loadPageForRender(db: Database.Database, opts: LoadPageOptions): LoadedPage {
  const token = opts.token;
  if (token !== undefined && token !== null && token !== '') {
    const ok = verifyPreviewToken(token, opts.tenantKey, opts.path, opts.sessionKey, opts.nowMs ?? Date.now());
    if (!ok) return { page: null, preview: false };
    const row = db
      .prepare(
        `SELECT id, path, title, status, template, body_html, body_css, updated_at
           FROM cms_page WHERE path = ? LIMIT 1`,
      )
      .get(opts.path) as Row | undefined;
    if (row === undefined || row.status !== 'draft') return { page: null, preview: false };
    const log = opts.log ?? ((line: string) => process.stdout.write(`${line}\n`));
    log(`preview tenant=${opts.tenantKey} path=${opts.path} ts=${new Date(opts.nowMs ?? Date.now()).toISOString()}`);
    return { page: toRecord(row), preview: true };
  }
  return { page: loadPage(db, opts.path), preview: false };
}
