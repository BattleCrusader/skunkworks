/**
 * §7.6's admin channel — issue one code, issue a CSV, revoke, reissue, edit.
 *
 * The screen exists to make two facts visible at the moment a human acts:
 *
 *   - **the plaintext code is shown once**, on the response that minted it, because
 *     nothing can read it back. "Reissue" is a revoke plus a mint, never a re-send;
 *   - **`max_uses` NULL is labelled as shareable** wherever a code with it appears,
 *     and choosing it needs the toggle and the confirmation (§7.6).
 *
 * Every POST here runs through the caller's origin + CSRF checks before it reaches
 * this module; nothing in this file reads a cookie or a session.
 */
import type Database from 'better-sqlite3';
import { join } from 'node:path';

import { AppError } from '../errors.ts';
import {
  SETTING_ALLOW_UNLIMITED,
  issueCode,
  issueFromCsv,
  revokeCode,
  reissueCode,
  settingBool,
  settingInt,
  updateCode,
  type IssuedCode,
} from './code.ts';

export interface CodesContext {
  db: Database.Database;
  tenantKey: string;
  /** `content/` — the issue path reads the bytes to refuse an encrypted PDF (§7.5). */
  contentRoot: string;
  csrf: string;
  atMs: number;
}

interface CodeListRow {
  id: number;
  code_selector: string;
  asset_key: string | null;
  filename: string | null;
  issued_to_email: string | null;
  order_ref: string | null;
  max_uses: number | null;
  uses: number;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
  created_at: string;
}

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function shell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title></head>
<body><main>${body}</main></body></html>`;
}

function listCodes(db: Database.Database, limit = 100): CodeListRow[] {
  return db
    .prepare(
      `SELECT c.id, c.code_selector, a.key AS asset_key, a.filename, c.issued_to_email, c.order_ref,
              c.max_uses, c.uses, c.expires_at, c.revoked_at, c.last_used_at, c.created_at
         FROM cms_download_code c LEFT JOIN cms_asset a ON a.id = c.asset_id
        ORDER BY c.id DESC LIMIT ?`,
    )
    .all(limit) as CodeListRow[];
}

export function codesPage(ctx: CodesContext, opts: { flash?: string; error?: string } = {}): string {
  const rows = listCodes(ctx.db);
  const unlimited = (() => {
    try {
      return settingBool(ctx.db, SETTING_ALLOW_UNLIMITED);
    } catch {
      return false;
    }
  })();
  const defaultMax = (() => {
    try {
      return settingInt(ctx.db, 'download.default_max_uses');
    } catch {
      return null;
    }
  })();

  const table =
    rows.length === 0
      ? '<p class="empty">No codes issued yet.</p>'
      : `<table data-role="codes">
<thead><tr><th>selector</th><th>asset</th><th>email</th><th>order</th><th>uses</th><th>expires</th><th>state</th><th></th></tr></thead>
<tbody>
${rows
  .map((r) => {
    const state =
      r.revoked_at !== null
        ? `revoked ${esc(r.revoked_at)}`
        : r.expires_at !== null && Date.parse(r.expires_at) <= Date.now()
          ? `expired ${esc(r.expires_at)}`
          : r.max_uses === null
            ? 'live — unlimited (shareable)'
            : r.uses >= r.max_uses
              ? 'live — spent'
              : 'live';
    const uses = `${r.uses}/${r.max_uses === null ? '∞' : r.max_uses}`;
    return `<tr data-code-id="${r.id}" data-selector="${esc(r.code_selector)}" data-unlimited="${r.max_uses === null ? '1' : '0'}">
  <td><code>${esc(r.code_selector)}…</code></td>
  <td>${esc(r.asset_key ?? '')} <span class="filename">${esc(r.filename ?? '')}</span></td>
  <td>${esc(r.issued_to_email ?? '')}</td>
  <td>${esc(r.order_ref ?? '')}</td>
  <td>${uses}</td>
  <td>${esc(r.expires_at ?? 'never')}</td>
  <td>${state}</td>
  <td>
    <form method="post" action="/admin/t/${esc(ctx.tenantKey)}/codes/${r.id}/revoke" data-csrf-token="${esc(ctx.csrf)}">
      <button type="submit">Revoke</button>
    </form>
    <form method="post" action="/admin/t/${esc(ctx.tenantKey)}/codes/${r.id}/reissue" data-csrf-token="${esc(ctx.csrf)}">
      <button type="submit">Reissue</button>
    </form>
    <form method="post" action="/admin/t/${esc(ctx.tenantKey)}/codes/${r.id}/update" data-csrf-token="${esc(ctx.csrf)}">
      <input name="max_uses" value="${r.max_uses === null ? '' : r.max_uses}" size="3" aria-label="max uses">
      <input name="expires_at" value="${esc(r.expires_at ?? '')}" size="18" aria-label="expires at">
      <button type="submit">Save</button>
    </form>
  </td>
</tr>`;
  })
  .join('\n')}
</tbody></table>`;

  const flash = opts.flash === undefined ? '' : `<p role="status" class="flash">${esc(opts.flash)}</p>`;
  const error = opts.error === undefined ? '' : `<p role="alert" class="error">${esc(opts.error)}</p>`;

  return shell(
    'Skunkworks — access codes',
    `<h1>Access codes — ${esc(ctx.tenantKey)}</h1>
<p><a href="/admin/t/${esc(ctx.tenantKey)}/">Back</a></p>
${flash}${error}
<section data-role="issue">
<h2>Issue one code</h2>
<form method="post" action="/admin/t/${esc(ctx.tenantKey)}/codes/new" data-csrf-token="${esc(ctx.csrf)}">
  <label>Asset key <input name="asset_key" required></label>
  <label>Email <input name="email" type="email"></label>
  <label>Max uses <input name="max_uses" inputmode="numeric" placeholder="${defaultMax === null ? '' : String(defaultMax)}"></label>
  <label>Expires at <input name="expires_at" placeholder="2026-12-31T00:00:00Z"></label>
  ${
    unlimited
      ? `<label><input type="checkbox" name="confirm_unlimited" value="1"> This code is effectively shareable (unlimited uses)</label>
  <p>Leave <em>max uses</em> blank for the tenant default; tick the box with a blank max for unlimited.</p>`
      : `<p>Unlimited codes are switched off for this tenant (<code>${esc(SETTING_ALLOW_UNLIMITED)}</code>).</p>`
  }
  <button type="submit">Issue</button>
</form>
</section>
<section data-role="bulk">
<h2>Issue from CSV</h2>
<form method="post" action="/admin/t/${esc(ctx.tenantKey)}/codes/csv" data-csrf-token="${esc(ctx.csrf)}">
  <p><code>email, asset_key, max_uses, expires_at</code> — a blank <code>max_uses</code> uses the tenant default.</p>
  <textarea name="csv" rows="6" cols="60" required></textarea>
  <button type="submit">Issue the file</button>
</form>
</section>
${table}`,
  );
}

/** The one page that shows a plaintext code. It says so, because there is no second chance. */
export function issuedPage(ctx: CodesContext, issued: IssuedCode[]): string {
  const rows = issued
    .map(
      (c) => `<tr data-code-id="${c.id}" data-selector="${esc(c.selector)}">
  <td><code class="code">${esc(c.code)}</code></td>
  <td>${esc(c.assetKey)}</td>
  <td>${c.maxUses === null ? 'unlimited (shareable)' : c.maxUses}</td>
  <td>${esc(c.expiresAt ?? 'never')}</td>
  <td>${c.stampable ? 'watermarkable' : 'not watermarkable in v1 (video/audio)'}</td>
</tr>`,
    )
    .join('\n');
  return shell(
    'Skunkworks — codes issued',
    `<h1>${issued.length === 1 ? 'Code issued' : `${issued.length} codes issued`}</h1>
<p role="status"><strong>This is the only time these codes are shown.</strong> They are stored as argon2id hashes;
reissue mints a new one rather than re-sending this one.</p>
<table data-role="issued"><thead><tr><th>code</th><th>asset</th><th>max uses</th><th>expires</th><th>watermark</th></tr></thead>
<tbody>
${rows}
</tbody></table>
<p><a href="/admin/t/${esc(ctx.tenantKey)}/codes">Back to codes</a></p>`,
  );
}

export interface CodesOutcome {
  status: number;
  html: string;
}

/**
 * One action, already authenticated and CSRF-checked. `fields` is the form map.
 * Returns the page to send; a refusal propagates as an `AppError` with its taxonomy
 * code, so the operator sees `422 SKW_E_DM_ASSET_UNSTAMPABLE` and the asset's name
 * rather than a generic failure.
 */
export async function handleCodes(
  ctx: CodesContext,
  action: string,
  fields: Record<string, string | undefined>,
): Promise<CodesOutcome> {
  if (action === 'codes') return { status: 200, html: codesPage(ctx) };

  if (action === 'codes/new') {
    const issued = await issueCode({
      db: ctx.db,
      contentRoot: ctx.contentRoot,
      assetKey: (fields.asset_key ?? '').trim(),
      email: fields.email ?? null,
      // Blank is `undefined` (the tenant default) and blank-plus-confirmation is
      // `null` (unlimited): the three states are distinct all the way down.
      maxUses: (fields.max_uses ?? '').trim() === '' ? (fields.confirm_unlimited === '1' ? null : undefined) : Number(fields.max_uses),
      expiresAt: (fields.expires_at ?? '').trim() === '' ? null : (fields.expires_at as string),
      confirmUnlimited: fields.confirm_unlimited === '1',
      atMs: ctx.atMs,
    });
    return { status: 201, html: issuedPage(ctx, [issued]) };
  }

  if (action === 'codes/csv') {
    const text = fields.csv ?? '';
    const { issued } = await issueFromCsv(ctx.db, ctx.contentRoot, text, ctx.atMs);
    return { status: 201, html: issuedPage(ctx, issued) };
  }

  const m = /^codes\/(\d+)\/(revoke|reissue|update)$/.exec(action);
  if (m !== null) {
    const id = Number(m[1]);
    const verb = m[2] as 'revoke' | 'reissue' | 'update';
    if (verb === 'revoke') {
      const changed = revokeCode(ctx.db, id, ctx.atMs);
      return {
        status: 200,
        html: codesPage(ctx, {
          flash: changed ? `Code ${id} revoked.` : `Code ${id} was already revoked.`,
        }),
      };
    }
    if (verb === 'reissue') {
      const issued = await reissueCode(ctx.db, ctx.contentRoot, id, ctx.atMs);
      return { status: 201, html: issuedPage(ctx, [issued]) };
    }
    const patch: { maxUses?: number | null; expiresAt?: string | null; confirmUnlimited?: boolean } = {};
    if (fields.max_uses !== undefined) {
      const raw = fields.max_uses.trim();
      patch.maxUses = raw === '' ? null : Number(raw);
      patch.confirmUnlimited = fields.confirm_unlimited === '1';
    }
    if (fields.expires_at !== undefined) {
      const raw = fields.expires_at.trim();
      patch.expiresAt = raw === '' ? null : raw;
    }
    updateCode(ctx.db, id, patch, ctx.atMs);
    return { status: 200, html: codesPage(ctx, { flash: `Code ${id} updated.` }) };
  }

  throw new AppError('SKW_E_PLT_TENANT_UNKNOWN', 'no admin route at this path');
}

/** Where the tenant's site.db is, for the caller that has to open it. */
export function sitePathOf(dataDir: string, tenantKey: string): string {
  return join(dataDir, 'tenants', tenantKey, 'site.db');
}
