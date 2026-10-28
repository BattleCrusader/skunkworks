/**
 * The ten **host** operations (§8.3), implemented once, against the tenant's own
 * `site.db` with an `admin-write` connection.
 *
 * Why the host and not the runner: `store.insert` is a *host* operation. The plugin
 * describes a row; the host validates the table against the installed manifest and
 * writes it. A plugin that cannot name a table it did not declare cannot name a tenant
 * either, and no package string ever becomes SQL — every table and column is checked
 * against `cms_plugin_installed.manifest_json` and `PRAGMA table_info` before emission.
 *
 * The response ceiling is §8.3's 256 KiB; the row ceiling is 32 KiB and 24 columns.
 */
import type Database from 'better-sqlite3';

import { randomBytes } from 'node:crypto';

import { assetUrl } from '../assets/url.ts';
import { isTemplate as isCoreTemplate, renderMail } from '../mail/templates.ts';
import type { HostOp, Manifest, SettingSpec, TableSpec } from './manifest.ts';

export interface HostCall {
  tenant: string;
  plugin: string;
  op: string;
  args: Record<string, unknown>;
}

export interface HostContext {
  db: Database.Database;
  tenant: string;
  plugin: string;
  manifest: Manifest;
  /** §4.3's `SKW_EMAIL_MODE`; `off` makes `mail.send` a named refusal, not a silent drop. */
  emailMode: 'off' | 'smtp';
}

const COMPARATORS = new Set(['=', '!=', '<', '<=', '>', '>=', 'in', 'like_prefix']);
const ROW_BYTES_MAX = 32 * 1024;
const ROW_COLUMNS_MAX = 24;
const RESPONSE_BYTES_MAX = 256 * 1024;

function refuse(code: string, message: string, _detail?: Record<string, unknown>): never {
  // A plain Error, not an `AppError`: these refusals travel the **plugin protocol** (they
  // are the `PL_*` codes §8.3 freezes) and never become an HTTP response of their own. The
  // app forwards the code to the plugin and the package sees a rejection; an AppError here
  // would demand an HTTP mapping the taxonomy does not have, which is the wrong layer.
  throw new Error(`${code}: ${message}`);
}

function tableOf(ctx: HostContext, name: unknown): TableSpec {
  if (typeof name !== 'string') refuse('SKW_E_PL_NO_TABLE', 'the store op names no table');
  const table = ctx.manifest.tables.find((t) => t.name === name);
  if (table === undefined) {
    // §8.3: a plugin that names a table it did not declare is PL_NO_TABLE, and the message
    // names both the package and the table — an operator cannot act on "denied".
    refuse('SKW_E_PL_NO_TABLE', `${ctx.plugin} did not declare table ${JSON.stringify(name)}`, {
      plugin: ctx.plugin,
      table: name,
      declared: ctx.manifest.tables.map((t) => t.name),
    });
  }
  return table;
}

/** The columns the *database* actually has, which is the second half of "declared". */
function columnsOf(db: Database.Database, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[];
  return new Set(rows.map((r) => String(r.name)));
}

/** §8.3: `where`/`order` may only name declared **and indexed** columns. */
function assertIndexed(db: Database.Database, table: string, column: string, role: string): void {
  if (column === 'id') return;
  const indexed = (db.prepare(`PRAGMA index_list("${table}")`).all() as { name: string }[]).some((index) =>
    (db.prepare(`PRAGMA index_info("${index.name}")`).all() as { name: string }[]).some((c) => c.name === column),
  );
  if (!indexed) {
    refuse('SKW_E_PL_QUERY', `${table}.${column} is not indexed; ${role} may only use declared and indexed columns`, {
      table,
      column,
      role,
    });
  }
}

interface Cond {
  sql: string;
  values: unknown[];
}

function whereOf(ctx: HostContext, table: string, where: unknown): Cond {
  if (where === undefined || where === null) return { sql: '', values: [] };
  if (!Array.isArray(where)) refuse('SKW_E_PL_QUERY', 'where must be an array of {column, op, value}');
  const columns = columnsOf(ctx.db, table);
  const parts: string[] = [];
  const values: unknown[] = [];
  for (const entry of where) {
    if (typeof entry !== 'object' || entry === null) refuse('SKW_E_PL_QUERY', 'a where clause is not an object');
    const c = entry as Record<string, unknown>;
    const column = typeof c.column === 'string' ? c.column : '';
    const op = typeof c.op === 'string' ? c.op : '';
    if (!columns.has(column)) refuse('SKW_E_PL_QUERY', `${table} has no column ${JSON.stringify(column)}`);
    if (!COMPARATORS.has(op)) refuse('SKW_E_PL_QUERY', `${JSON.stringify(op)} is not one of ${[...COMPARATORS].join(', ')}`);
    assertIndexed(ctx.db, table, column, 'where');
    if (op === 'in') {
      if (!Array.isArray(c.value) || c.value.length === 0 || c.value.length > 500) {
        refuse('SKW_E_PL_QUERY', 'in needs an array of 1..500 values');
      }
      parts.push(`"${column}" IN (${c.value.map(() => '?').join(', ')})`);
      values.push(...(c.value as unknown[]));
    } else if (op === 'like_prefix') {
      parts.push(`"${column}" LIKE ? || '%'`);
      values.push(String(c.value ?? ''));
    } else {
      parts.push(`"${column}" ${op} ?`);
      values.push(c.value ?? null);
    }
  }
  return { sql: parts.length === 0 ? '' : ` WHERE ${parts.join(' AND ')}`, values };
}

function scalar(value: unknown, column: string): string | number | null {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  refuse('SKW_E_PL_ROW', `${column} is not a primitive`);
}

function rowOf(ctx: HostContext, table: string, raw: unknown): { columns: string[]; values: (string | number | null)[] } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) refuse('SKW_E_PL_ROW', 'row must be an object');
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length === 0) refuse('SKW_E_PL_ROW', 'row is empty');
  if (entries.length > ROW_COLUMNS_MAX) refuse('SKW_E_PL_ROW', `row has ${entries.length} columns; the cap is ${ROW_COLUMNS_MAX}`);
  const bytes = Buffer.byteLength(JSON.stringify(raw));
  if (bytes > ROW_BYTES_MAX) refuse('SKW_E_PL_ROW', `row is ${bytes} B; the cap is ${ROW_BYTES_MAX} B`);
  const declared = columnsOf(ctx.db, table);
  const columns: string[] = [];
  const values: (string | number | null)[] = [];
  for (const [column, value] of entries) {
    if (!declared.has(column)) refuse('SKW_E_PL_ROW', `${table} has no column ${JSON.stringify(column)}`);
    if (column === 'id') refuse('SKW_E_PL_ROW', 'id is assigned by the host');
    columns.push(column);
    values.push(scalar(value, column));
  }
  return { columns, values };
}

function idOf(raw: unknown): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id < 1) refuse('SKW_E_PL_ROW', 'id must be a positive integer');
  return id;
}

function settingOf(ctx: HostContext, key: unknown): SettingSpec {
  if (typeof key !== 'string') refuse('SKW_E_PL_NO_SETTING', 'the setting op names no key');
  const spec = ctx.manifest.settings.find((s) => s.key === key);
  if (spec === undefined) {
    refuse('SKW_E_PL_NO_SETTING', `${ctx.plugin} did not declare setting ${JSON.stringify(key)}`, { plugin: ctx.plugin, key });
  }
  return spec;
}

function parseSetting(spec: SettingSpec, raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    refuse('SKW_E_PL_SETTING_INVALID', `setting ${spec.key} is not valid JSON`);
  }
}

function settingValue(spec: SettingSpec, value: unknown): string {
  switch (spec.type) {
    case 'string':
      if (typeof value !== 'string') refuse('SKW_E_PL_SETTING_INVALID', `${spec.key} is a string`);
      return JSON.stringify(value);
    case 'int':
      if (!Number.isInteger(value)) refuse('SKW_E_PL_SETTING_INVALID', `${spec.key} is an integer`);
      return JSON.stringify(value);
    case 'bool':
      if (typeof value !== 'boolean') refuse('SKW_E_PL_SETTING_INVALID', `${spec.key} is a boolean`);
      return JSON.stringify(value);
    case 'json':
      return JSON.stringify(value ?? null);
    case 'secret':
      // Write-only: a secret can be set and can never be read back (§8.3).
      if (typeof value !== 'string') refuse('SKW_E_PL_SETTING_INVALID', `${spec.key} is a string`);
      return JSON.stringify(value);
  }
}

/** `assets.resolve` — a key, five public facts, and never a path, checksum or byte. */
function resolveAsset(ctx: HostContext, key: unknown): Record<string, unknown> | null {
  if (typeof key !== 'string') refuse('SKW_E_PL_ROW', 'assets.resolve needs a key');
  const row = ctx.db
    .prepare(`SELECT key, filename, mime, bytes, sha256, access_class, width, height, alt_text FROM cms_asset WHERE key = ?`)
    .get(key) as
    | { key: string; filename: string; mime: string; bytes: number; sha256: string; access_class: string; width: number | null; height: number | null; alt_text: string | null }
    | undefined;
  if (row === undefined) return null;
  const gated = row.access_class === 'gated';
  return {
    key: row.key,
    url: gated ? null : assetUrl({ key: row.key, mime: row.mime, sha256: row.sha256 }),
    width: row.width,
    height: row.height,
    alt: row.alt_text,
    mime: row.mime,
    bytes: row.bytes,
  };
}

const MAIL_TEMPLATE = /^[a-z][a-z0-9-]{0,40}$/;
const EMAIL = /^[^\s@<>]{1,64}@[^\s@<>]{1,190}\.[^\s@<>]{2,24}$/;

export function hostOp(ctx: HostContext, op: string, args: Record<string, unknown>): unknown {
  switch (op satisfies HostOp | string) {
    case 'store.insert': {
      const table = tableOf(ctx, args.table).name;
      const row = rowOf(ctx, table, args.row);
      const info = ctx.db
        .prepare(`INSERT INTO "${table}" (${row.columns.map((c) => `"${c}"`).join(', ')}) VALUES (${row.columns.map(() => '?').join(', ')})`)
        .run(...row.values);
      return { id: Number(info.lastInsertRowid), changes: info.changes };
    }
    case 'store.update': {
      const table = tableOf(ctx, args.table).name;
      const patch = rowOf(ctx, table, args.patch);
      const info = ctx.db
        .prepare(`UPDATE "${table}" SET ${patch.columns.map((c) => `"${c}" = ?`).join(', ')} WHERE id = ?`)
        .run(...patch.values, idOf(args.id));
      if (info.changes !== 1) refuse('SKW_E_PL_ROW', `update touched ${info.changes} rows; exactly one is required`);
      return { changes: info.changes };
    }
    case 'store.delete': {
      const table = tableOf(ctx, args.table).name;
      const info = ctx.db.prepare(`DELETE FROM "${table}" WHERE id = ?`).run(idOf(args.id));
      if (info.changes !== 1) refuse('SKW_E_PL_ROW', `delete touched ${info.changes} rows; exactly one is required`);
      return { changes: info.changes };
    }
    case 'store.query': {
      const table = tableOf(ctx, args.table).name;
      const limit = args.limit === undefined ? 100 : Number(args.limit);
      const offset = args.offset === undefined ? 0 : Number(args.offset);
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) refuse('SKW_E_PL_QUERY', 'limit must be 1..500');
      if (!Number.isInteger(offset) || offset < 0 || offset > 10_000) refuse('SKW_E_PL_QUERY', 'offset must be 0..10000');
      const where = whereOf(ctx, table, args.where);
      let order = '';
      if (args.order !== undefined) {
        if (typeof args.order !== 'object' || args.order === null) refuse('SKW_E_PL_QUERY', 'order must be {column, dir}');
        const o = args.order as Record<string, unknown>;
        const column = typeof o.column === 'string' ? o.column : '';
        const dir = String(o.dir ?? 'asc').toLowerCase();
        if (!['asc', 'desc'].includes(dir)) refuse('SKW_E_PL_QUERY', 'order.dir must be asc or desc');
        if (!columnsOf(ctx.db, table).has(column)) refuse('SKW_E_PL_QUERY', `${table} has no column ${JSON.stringify(column)}`);
        assertIndexed(ctx.db, table, column, 'order');
        order = ` ORDER BY "${column}" ${dir.toUpperCase()}`;
      }
      const rows = ctx.db
        .prepare(`SELECT * FROM "${table}"${where.sql}${order} LIMIT ? OFFSET ?`)
        .all(...where.values, limit, offset);
      const body = JSON.stringify({ rows });
      if (Buffer.byteLength(body) > RESPONSE_BYTES_MAX) {
        refuse('SKW_E_PL_TOO_MANY', `the response is ${Buffer.byteLength(body)} B; the cap is ${RESPONSE_BYTES_MAX} B`, { limit });
      }
      return { rows, limit, offset };
    }
    case 'store.count': {
      const table = tableOf(ctx, args.table).name;
      const where = whereOf(ctx, table, args.where);
      const row = ctx.db.prepare(`SELECT COUNT(*) AS n FROM "${table}"${where.sql}`).get(...where.values) as { n: number };
      return { count: Number(row.n) };
    }
    case 'settings.get': {
      const spec = settingOf(ctx, args.key);
      if (spec.type === 'secret') return null;
      const row = ctx.db.prepare('SELECT value_json FROM cms_plugin_setting WHERE plugin_id = ? AND key = ?').get(ctx.plugin, spec.key) as
        | { value_json: string }
        | undefined;
      return row === undefined ? null : parseSetting(spec, row.value_json);
    }
    case 'settings.has': {
      const spec = settingOf(ctx, args.key);
      const row = ctx.db.prepare('SELECT 1 AS one FROM cms_plugin_setting WHERE plugin_id = ? AND key = ?').get(ctx.plugin, spec.key);
      return { has: row !== undefined };
    }
    case 'settings.set': {
      const spec = settingOf(ctx, args.key);
      const value = settingValue(spec, args.value);
      if (spec.max !== undefined && typeof args.value === 'string' && args.value.length > spec.max) {
        refuse('SKW_E_PL_SETTING_INVALID', `${spec.key} is capped at ${spec.max} characters`);
      }
      ctx.db
        .prepare(
          `INSERT INTO cms_plugin_setting (plugin_id, key, value_json, type, secret, updated_at)
           VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
           ON CONFLICT(plugin_id, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
        )
        .run(ctx.plugin, spec.key, value, spec.type, spec.type === 'secret' ? 1 : 0);
      return { ok: true };
    }
    case 'assets.resolve':
      return resolveAsset(ctx, args.key);
    case 'mail.send': {
      if (ctx.emailMode === 'off') {
        // §4.3: every shipped box runs with email off. A plugin that calls `mail.send`
        // gets a named refusal rather than a message dropped into a queue nobody drains.
        refuse('SKW_E_PL_MAIL', 'mail.send is unavailable: SKW_EMAIL_MODE=off on this install', { plugin: ctx.plugin });
      }
      const to = typeof args.to === 'string' ? args.to : '';
      if (!EMAIL.test(to)) refuse('SKW_E_PL_MAIL', `to ${JSON.stringify(args.to)} is not an address`);
      const template = typeof args.template === 'string' ? args.template : '';
      if (!MAIL_TEMPLATE.test(template)) refuse('SKW_E_PL_MAIL', `template ${JSON.stringify(args.template)} is not a template name`);
      const vars = (args.vars ?? {}) as Record<string, unknown>;
      const rendered = JSON.stringify(vars);
      if (Buffer.byteLength(rendered) > 32 * 1024) refuse('SKW_E_PL_MAIL', 'vars exceed 32 KiB');
      // A core template's words are the host's, so a name this build does not know is refused here:
      // that is a bug in the plugin, and it should learn now rather than from a dead letter. A
      // plugin's own template carries the words in `vars` (or names its subject); the host does not
      // write a plugin's copy, and the drain is where an unrenderable one becomes visible.
      let subject = typeof args.subject === 'string' ? args.subject.slice(0, 200) : '';
      if (isCoreTemplate(template)) {
        try {
          subject = renderMail(template, vars).subject;
        } catch (err) {
          refuse('SKW_E_PL_MAIL', (err as Error).message.slice(0, 200));
        }
      } else if (subject === '') {
        subject = `Notification from ${ctx.plugin}`;
      }
      const now = new Date().toISOString();
      const info = ctx.db
        .prepare(
          `INSERT INTO cms_mail (to_email, template, subject, vars_json, idempotency_key, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(to, template, subject, rendered, `plugin:${ctx.plugin}:${Date.now().toString(36)}:${randomBytes(8).toString('hex')}`, now);
      // Queued, not sent: the drain owns delivery, retries and suppression, so a plugin is never
      // told a message went out when it only reached a table.
      return { queued: true, id: Number(info.lastInsertRowid), to, template };
    }
    default:
      refuse('SKW_E_PL_REJECTED', `${op} is not a host op`);
  }
}
