/**
 * §9.3 — "Row data in `cms_*` is editable through generated forms" — and §9.6 —
 * "`cms_audit` rows … written in the same transaction as the change they record".
 *
 * This module is the data half of the CRUD surface; `routes.ts` renders the HTML
 * and owns the request order (session → tenant → Origin → CSRF). Three rules are
 * implemented here and nowhere else:
 *
 *   1. **The connection class is `admin-write`.** The functions take an open
 *      handle and never open one, so a caller cannot accidentally hand them a
 *      `render-read` handle and have it work: that handle is `readonly` with
 *      `query_only=1` and refuses the write itself (§2.2). Nothing here catches
 *      and re-runs a failed statement — a refusal is reported, never retried.
 *   2. **Every change writes exactly one `cms_audit` row in the same
 *      transaction**, carrying the actor and the before/after images. A refused
 *      write therefore writes no audit row: the rollback takes it.
 *   3. **The three columns §9.3 names are not editable** — not by the form and not
 *      by this writer, which never emits them in an UPDATE. The database is still
 *      the control (`storage_path` is generated; two triggers raise
 *      `SKW_E_DM_COLUMN_IMMUTABLE`), so a driver that bypasses this module is
 *      refused too.
 *
 * The audit chain: `hash = sha256(prev_hash + canonical(row))` where the
 * canonical row is the JSON of the row's own fields with keys sorted. The SDS
 * says "hash over the canonical row" and does not define the canonicalisation;
 * this is the definition, and a verifier that checks these rows must use it
 * (reported as a gap in `S2c-report.md`). `prev_hash` is the hash of the last row
 * of the same table, so the chain is per-file and append-only.
 */
import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';

import { AppError } from '../errors.ts';

export interface Actor {
  userId: number;
  label: string;
}

export interface ColumnInfo {
  name: string;
  /** The declared type, upper-cased (`TEXT`, `INTEGER`, …). */
  type: string;
  notNull: boolean;
  hasDefault: boolean;
  pk: boolean;
  /** The rowid alias: SQLite assigns it, so the form must not ask for it. */
  auto: boolean;
  editable: boolean;
  /** Why a column is not editable, in the words of the SDS section that says so. */
  reason?: string;
  input: 'text' | 'textarea' | 'number';
}

export interface TableInfo {
  name: string;
  columns: ColumnInfo[];
  /** The column used in `WHERE` for edit and delete: the primary key. */
  pk: string;
}

/** `tenant.key`-style discipline for identifiers; a table name is never interpolated unchecked. */
const IDENT = /^[a-z][a-z0-9_]{0,63}$/;
const TABLE = /^cms_[a-z][a-z0-9_]{0,63}$/;

/** Long text gets a textarea; everything else an input. */
const LONG_TEXT = new Set([
  'body_html',
  'body_css',
  'fields_json',
  'spec_json',
  'payload_json',
  'columns_json',
  'bindings_json',
  'props_schema_json',
  'seo_json',
  'value_json',
  'manifest_json',
  'watermark_spec_json',
  'aggregate_json',
  'group_by_json',
  'params_json',
  'cost_plan',
  'notes',
]);

/** §9.3's table: three columns the form must not write. */
export const NOT_EDITABLE: Record<string, Record<string, string>> = {
  cms_asset: {
    sha256: 'trg_cms_asset_sha_immutable (§9.3)',
  },
  cms_download_code: {
    code_hash: 'trg_cms_download_code_hash_immutable (§9.3)',
    code_selector: 'trg_cms_download_code_hash_immutable (§9.3)',
  },
};

/**
 * `cms_audit` is not a CRUD table: it is the record of the CRUD. Letting an
 * operator insert a row by hand would forge the chain, and §9.3 excludes it by
 * naming its two append-only triggers as controls.
 */
const RESERVED = new Set(['cms_audit']);

export function isEditableTable(name: string): boolean {
  return TABLE.test(name) && !RESERVED.has(name);
}

export function listTables(db: Database.Database): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB 'cms_*' ORDER BY name")
    .all() as { name: string }[];
  return rows.map((r) => r.name).filter(isEditableTable);
}

interface XInfo {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
  hidden: number;
}

export function describeTable(db: Database.Database, table: string): TableInfo {
  if (!isEditableTable(table)) {
    throw new AppError('SKW_E_PLT_REQUEST_INVALID', 'not an editable table');
  }
  const exists = db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  if (exists === undefined) throw new AppError('SKW_E_PLT_REQUEST_INVALID', 'not an editable table');

  const raw = db.prepare(`PRAGMA table_xinfo("${table}")`).all() as XInfo[];
  const columns: ColumnInfo[] = raw.map((c) => {
    const type = c.type === '' ? 'TEXT' : c.type.toUpperCase();
    const auto = c.pk > 0 && type === 'INTEGER';
    // hidden: 0 = ordinary, 1 = hidden (virtual-table plumbing), 2/3 = generated.
    const generated = c.hidden === 2 || c.hidden === 3;
    const reserved = NOT_EDITABLE[table]?.[c.name];
    const reason = generated
      ? 'generated column — no statement can write it (§9.3, check 11)'
      : auto
        ? 'assigned by SQLite'
        : reserved;
    return {
      name: c.name,
      type,
      notNull: c.notnull === 1,
      hasDefault: c.dflt_value !== null,
      pk: c.pk > 0,
      auto,
      editable: reason === undefined,
      ...(reason === undefined ? {} : { reason }),
      input: type === 'INTEGER' || type === 'REAL' || type === 'NUMERIC' ? 'number' : LONG_TEXT.has(c.name) || type === 'BLOB' ? 'textarea' : 'text',
    };
  });

  const pkColumn = columns.find((c) => c.pk);
  if (pkColumn === undefined) throw new AppError('SKW_E_PLT_REQUEST_INVALID', 'the table has no primary key');
  return { name: table, columns, pk: pkColumn.name };
}

export function listRows(db: Database.Database, table: string, limit = 100): Record<string, unknown>[] {
  const info = describeTable(db, table);
  const order = info.pk;
  return db.prepare(`SELECT * FROM "${info.name}" ORDER BY "${order}" LIMIT ${Math.max(1, Math.min(500, limit))}`).all() as Record<string, unknown>[];
}

export function selectRow(db: Database.Database, table: string, id: string): Record<string, unknown> | undefined {
  const info = describeTable(db, table);
  return db.prepare(`SELECT * FROM "${info.name}" WHERE "${info.pk}" = ?`).get(bindable(info, id)) as Record<string, unknown> | undefined;
}

export interface WriteResult {
  id: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

export function createRow(db: Database.Database, table: string, input: Values, actor: Actor): WriteResult {
  const info = describeTable(db, table);
  const { columns, values } = collected(info, input, 'insert');
  const names = columns.map((c) => `"${c}"`).join(', ');
  const marks = columns.map(() => '?').join(', ');

  const id = inTransaction(db, () => {
    run(db, `INSERT INTO "${info.name}" (${names}) VALUES (${marks})`, values);
    const rowid = db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number | bigint };
    const after = db.prepare(`SELECT * FROM "${info.name}" WHERE rowid = ?`).get(rowid.id) as Record<string, unknown> | undefined;
    if (after === undefined) throw new AppError('SKW_E_PLT_INTERNAL', 'the inserted row could not be read back');
    const idText = String(after[info.pk]);
    appendAudit(db, actor, `${info.name}.create`, info.name, idText, null, after);
    return idText;
  });
  return { id, before: null, after: selectRow(db, table, id) ?? null };
}

export function updateRow(db: Database.Database, table: string, id: string, input: Values, actor: Actor): WriteResult {
  const info = describeTable(db, table);
  const before = selectRow(db, table, id);
  if (before === undefined) throw new AppError('SKW_E_RT_PAGE_NOT_FOUND', 'no such row');

  const { columns, values } = collected(info, input, 'update');
  // §9.3's three columns are never in this list: `collected` drops them, so no
  // UPDATE can carry one even when the form is hand-posted.
  const sets = columns.map((c) => `"${c}" = ?`).join(', ');
  const stamp = hasUpdatedAt(info);
  const sql = stamp
    ? `UPDATE "${info.name}" SET ${sets}, "updated_at" = ? WHERE "${info.pk}" = ?`
    : `UPDATE "${info.name}" SET ${sets} WHERE "${info.pk}" = ?`;
  const params = stamp ? [...values, new Date().toISOString(), bindable(info, id)] : [...values, bindable(info, id)];

  inTransaction(db, () => {
    run(db, sql, params);
    const after = selectRow(db, table, id);
    if (after === undefined) throw new AppError('SKW_E_PLT_INTERNAL', 'the updated row could not be read back');
    appendAudit(db, actor, `${info.name}.update`, info.name, id, before, after);
  });
  return { id, before, after: selectRow(db, table, id) ?? null };
}

export function deleteRow(db: Database.Database, table: string, id: string, actor: Actor): WriteResult {
  const info = describeTable(db, table);
  const before = selectRow(db, table, id);
  if (before === undefined) throw new AppError('SKW_E_RT_PAGE_NOT_FOUND', 'no such row');

  inTransaction(db, () => {
    run(db, `DELETE FROM "${info.name}" WHERE "${info.pk}" = ?`, [bindable(info, id)]);
    appendAudit(db, actor, `${info.name}.delete`, info.name, id, before, null);
  });
  return { id, before, after: null };
}

// --- values ---------------------------------------------------------------

export type Values = Record<string, string | undefined>;

function hasUpdatedAt(info: TableInfo): boolean {
  return info.columns.some((c) => c.name === 'updated_at' && c.editable);
}

/**
 * Form fields -> (column, value) pairs, for the columns this writer may set.
 *
 * `insert` sends every editable column; `update` sends only the ones the form
 * posted, so a partial form cannot blank a column it never showed.
 */
function collected(info: TableInfo, input: Values, mode: 'insert' | 'update'): { columns: string[]; values: unknown[] } {
  const columns: string[] = [];
  const values: unknown[] = [];
  for (const column of info.columns) {
    if (!column.editable) continue;
    const present = Object.prototype.hasOwnProperty.call(input, column.name);
    if (mode === 'update' && !present) continue;
    // `updated_at` is stamped by the writer, not by the form (§10.1's "the
    // registry is the contract" does not make a timestamp a human decision).
    if (column.name === 'updated_at' && mode === 'update') continue;
    if (!present) {
      // A column the form did not show keeps its DEFAULT (or NULL): an INSERT
      // must not spell a value the schema already decides (§9.3's `rev`,
      // `body_sha`, `created_at` are all defaults for exactly this reason).
      if (mode === 'insert' && column.notNull && !column.hasDefault) {
        throw new AppError('SKW_E_PLT_REQUEST_INVALID', `${column.name} is required`);
      }
      continue;
    }
    columns.push(column.name);
    values.push(coerce(column, input[column.name] as string));
  }
  if (columns.length === 0) throw new AppError('SKW_E_PLT_REQUEST_INVALID', 'no editable column was posted');
  return { columns, values };
}

function coerce(column: ColumnInfo, raw: string): unknown {
  if (raw === '') {
    if (!column.notNull) return null;
    if (column.type === 'TEXT' || column.type === 'BLOB') return '';
    throw new AppError('SKW_E_PLT_REQUEST_INVALID', `${column.name} is required`);
  }
  if (column.input !== 'number') return raw;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new AppError('SKW_E_PLT_REQUEST_INVALID', `${column.name} must be a number`);
  if (column.type === 'INTEGER' && !Number.isInteger(n)) {
    throw new AppError('SKW_E_PLT_REQUEST_INVALID', `${column.name} must be an integer`);
  }
  return n;
}

/** A TEXT primary key stays text; an INTEGER one is bound as a number. */
function bindable(info: TableInfo, id: string): string | number {
  const column = info.columns.find((c) => c.name === info.pk) as ColumnInfo;
  if (column.type === 'INTEGER') {
    if (!/^-?\d{1,18}$/.test(id)) throw new AppError('SKW_E_PLT_REQUEST_INVALID', 'not a row id');
    return Number(id);
  }
  if (id.length === 0 || id.length > 200) throw new AppError('SKW_E_PLT_REQUEST_INVALID', 'not a row id');
  return id;
}

// --- SQLite -> taxonomy ---------------------------------------------------

/**
 * A failed statement becomes the code the schema or driver already named, never a
 * blanket 500. The trigger codes are the two §4.3 says are raised from inside the
 * database; the constraint classes map to the DM codes that exist for them.
 */
export function taxonomy(err: unknown): AppError {
  if (err instanceof AppError) return err;
  const message = err instanceof Error ? err.message : String(err);
  const named = /SKW_E_[A-Z0-9_]+/.exec(message);
  if (named !== null) {
    try {
      return new AppError(named[0], undefined);
    } catch {
      /* a code the taxonomy does not carry falls through to the classes below */
    }
  }
  if (/UNIQUE constraint failed/i.test(message)) return new AppError('SKW_E_DM_KEY_IN_USE', 'that key is already used');
  if (/FOREIGN KEY constraint failed/i.test(message)) return new AppError('SKW_E_DM_FK_VIOLATION', 'a referenced row does not exist');
  if (/CHECK constraint failed|NOT NULL constraint failed|datatype mismatch/i.test(message)) {
    return new AppError('SKW_E_PLT_REQUEST_INVALID', 'the schema refused that value');
  }
  if (/attempt to write a readonly database|query_only/i.test(message)) {
    // This is the render-read ban firing (§2.2). It is a programming error in the
    // caller, so it is reported as an internal failure — and never retried.
    return new AppError('SKW_E_PLT_INTERNAL', 'a write was attempted on a read-only connection');
  }
  return new AppError('SKW_E_PLT_INTERNAL');
}

function run(db: Database.Database, sql: string, params: readonly unknown[]): void {
  try {
    db.prepare(sql).run(...params);
  } catch (err) {
    throw taxonomy(err);
  }
}

function inTransaction<T>(db: Database.Database, fn: () => T): T {
  const tx = db.transaction(fn);
  try {
    return tx();
  } catch (err) {
    throw taxonomy(err);
  }
}

// --- §9.6: the audit row, in the same transaction -------------------------

function appendAudit(
  db: Database.Database,
  actor: Actor,
  action: string,
  table: string,
  targetId: string,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): void {
  const previous = db.prepare('SELECT hash FROM cms_audit ORDER BY id DESC LIMIT 1').get() as { hash: string } | undefined;
  const prev = previous?.hash ?? '';
  const ts = new Date().toISOString();
  const beforeJson = before === null ? null : JSON.stringify(before);
  const afterJson = after === null ? null : JSON.stringify(after);
  // The canonical row: every column this row carries, keys sorted.
  const hash = createHash('sha256')
    .update(
      prev +
        stable({
          actor_user_id: actor.userId,
          actor_label: actor.label,
          action,
          target_kind: table,
          target_id: targetId,
          before_json: beforeJson,
          after_json: afterJson,
          ts,
        }),
    )
    .digest('hex');

  db.prepare(
    `INSERT INTO cms_audit
       (actor_user_id, actor_label, action, target_kind, target_id, before_json, after_json, prev_hash, hash, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(actor.userId, actor.label, action, table, targetId, beforeJson, afterJson, prev, hash, ts);
}

function stable(value: Record<string, unknown>): string {
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${JSON.stringify(value[k])}`).join(',')}}`;
}

/** Exported so a verifier can check the chain with the writer's own definition. */
export function auditHash(prev: string, row: Record<string, unknown>): string {
  return createHash('sha256').update(prev + stable(row)).digest('hex');
}

/** The identifier rule, exported for the router's path parsing. */
export function isIdentifier(value: string): boolean {
  return IDENT.test(value);
}
