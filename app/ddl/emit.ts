/**
 * §4.4 (C-13) — the DDL AST's only string builder.
 *
 * `DdlOp` is the frozen union: no strings, no reference objects, and the FK target
 * is **derived from `ColumnSpec.type`**, never supplied. This module turns the one
 * operation S2c's builder scaffold previews (`create_table`) into the exact
 * statements the executor will run in S2d. That is the whole reason it exists as a
 * separate file: the preview and the execution must not be two string builders, or
 * the preview is a claim about SQL nobody will run.
 *
 * §4.4 fixes the AST and the five refusals, not the text of each column. The text
 * decided here, and therefore the contract S2d inherits:
 *
 *   TEXT    -> TEXT          INTEGER -> INTEGER        REAL -> REAL
 *   BLOB    -> BLOB          NUMERIC -> NUMERIC
 *   BOOLEAN -> INTEGER + CHECK ("c" IN (0,1))          (SQLite has no boolean type)
 *   DATE    -> TEXT                                    (ISO-8601; §4.4 rejects a
 *                                                       `datetime` type for exactly
 *                                                       this reason — the choice of
 *                                                       TEXT is the contract)
 *   ASSET   -> TEXT REFERENCES "cms_asset"("key")       ON DELETE RESTRICT
 *   PAGE    -> TEXT REFERENCES "cms_page"("path")       ON DELETE RESTRICT
 *   RELATION-> INTEGER REFERENCES "u_<relation>"("id")  ON DELETE RESTRICT
 *
 * No `STRICT`: §4.4 lists NUMERIC, which a STRICT table cannot declare, and the
 * frozen `cms_*` schema is not STRICT either. A `u_*` table must behave like the
 * tables it sits beside.
 */
import { AppError } from '../errors.ts';
import { refuse } from './refuse.ts';

export type ColumnType =
  | 'TEXT'
  | 'INTEGER'
  | 'REAL'
  | 'BLOB'
  | 'NUMERIC'
  | 'BOOLEAN'
  | 'DATE'
  | 'ASSET'
  | 'PAGE'
  | 'RELATION';

export interface ColumnSpec {
  name: string;
  type: ColumnType;
  notNull?: boolean;
  default?: string | number | boolean;
  /** The `u_*` table a RELATION points at. Never a table/column pair. */
  relation?: string;
}

export interface CreateTableOp {
  op: 'create_table';
  name: string;
  columns: ColumnSpec[];
}

/** §4.4's refusal lives in `refuse.ts` so the AST and the emitter raise one shape. */
export { refuse };
export type { RefusalReason } from './refuse.ts';

const TABLE_NAME = /^u_[a-z0-9_]+$/;
const COLUMN_NAME = /^[a-z][a-z0-9_]{0,39}$/;
const MAX_COLUMNS = 40;

/**
 * `create_table` -> one statement.
 *
 * The statement is the preview *and* the execution: S2d's runner must call this
 * function rather than re-spell the SQL (§9.4's "emitted from templates only").
 */
export function emitCreateTable(op: CreateTableOp): string[] {
  if (!TABLE_NAME.test(op.name)) throw refuse('reserved_prefix');
  if (op.columns.length === 0 || op.columns.length > MAX_COLUMNS) throw refuse('limit');

  const seen = new Set<string>(['id']);
  // S2c emitted this statement without an `id` column while still declaring
  // `PRIMARY KEY ("id")`, so the preview was SQL that SQLite refuses ("no such column:
  // id"). It was invisible because nothing executed the preview; S2d runs it, and
  // `ddl-runner.test.ts` C5 compares the two statement for statement.
  const parts: string[] = ['"id" INTEGER'];
  for (const column of op.columns) {
    if (!COLUMN_NAME.test(column.name)) {
      // A column name is not a §4.4 refusal class; it is a malformed form.
      throw new AppError('SKW_E_PLT_REQUEST_INVALID', `${JSON.stringify(column.name)} is not a column name`);
    }
    if (seen.has(column.name)) {
      // `id` is the runner's: a column named id would shadow the primary key.
      throw new AppError('SKW_E_PLT_REQUEST_INVALID', `${column.name} is declared twice`);
    }
    seen.add(column.name);
    parts.push(emitColumn(column));
  }

  parts.push(`PRIMARY KEY ("id")`);
  return [`CREATE TABLE "${op.name}" (\n  ${parts.join(',\n  ')}\n)`];
}

export function emitColumn(column: ColumnSpec): string {
  const name = `"${column.name}"`;
  switch (column.type) {
    case 'BOOLEAN':
      return `${name} INTEGER${notNull(column)}${defaultSql(column)} CHECK (${name} IN (0,1))`;
    case 'DATE':
      return `${name} TEXT${notNull(column)}${defaultSql(column)}`;
    case 'ASSET':
      return `${name} TEXT${notNull(column)} REFERENCES "cms_asset"("key") ON DELETE RESTRICT`;
    case 'PAGE':
      return `${name} TEXT${notNull(column)} REFERENCES "cms_page"("path") ON DELETE RESTRICT`;
    case 'RELATION': {
      if (column.relation === undefined || !TABLE_NAME.test(column.relation)) {
        throw new AppError('SKW_E_PLT_REQUEST_INVALID', `${column.name} is a RELATION without a u_<table> target`);
      }
      return `${name} INTEGER${notNull(column)} REFERENCES "${column.relation}"("id") ON DELETE RESTRICT`;
    }
    default:
      return `${name} ${column.type}${notNull(column)}${defaultSql(column)}`;
  }
}

function notNull(column: ColumnSpec): string {
  return column.notNull === true ? ' NOT NULL' : '';
}

/** §4.4's `default` is a literal. A boolean is 1/0 because the column is INTEGER. */
function defaultSql(column: ColumnSpec): string {
  const value = column.default;
  if (value === undefined) return '';
  if (typeof value === 'boolean') return ` DEFAULT ${value ? 1 : 0}`;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new AppError('SKW_E_PLT_REQUEST_INVALID', `${column.name} has a non-finite default`);
    return ` DEFAULT ${String(value)}`;
  }
  return ` DEFAULT '${value.replace(/'/g, "''")}'`;
}

/**
 * The registry row the executor will write beside the statement, rendered for the
 * preview. `cms_table_registry` is the only place a `u_*` table's shape is
 * recorded (§4.1), so the preview shows it: an operator who sees the columns_json
 * is looking at what the postcondition will assert.
 */
export interface RegistryPreview {
  table_name: string;
  table_class: 'user';
  plugin_id: null;
  ddl_version: 1;
  column_count: number;
  index_count: 0;
  columns_json: string;
}

export function registryRow(op: CreateTableOp): RegistryPreview {
  return {
    table_name: op.name,
    table_class: 'user',
    plugin_id: null,
    ddl_version: 1,
    column_count: op.columns.length + 1, // + the `id` primary key
    index_count: 0,
    columns_json: JSON.stringify(
      [{ name: 'id', type: 'INTEGER', notNull: true, pk: true }, ...op.columns].map((c) => ({
        name: c.name,
        type: c.type,
        notNull: c.notNull === true,
        ...('default' in c && c.default !== undefined ? { default: c.default } : {}),
        ...('relation' in c && c.relation !== undefined ? { relation: c.relation } : {}),
      })),
    ),
  };
}
