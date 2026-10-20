/**
 * §4.4 (C-13) — the `DdlOp` union, the five refusals, and the one place a DDL request
 * becomes a list of statements.
 *
 * The union is Data Model's seven operations, frozen:
 *
 *     create_table  add_column  drop_column  rename_table  create_index  drop_index  drop_table
 *
 * and `ColumnSpec.type` is a closed set of ten. **The FK target is derived from the
 * type** — `ASSET -> cms_asset(key)`, `PAGE -> cms_page(path)`, `RELATION ->
 * u_<relation>(id)` — and there is no field anywhere in this module through which a
 * caller can name an FK target. That is the half of C-13 that makes the bad statement
 * unrepresentable rather than rejected: a caller-supplied `{table:'cms_page',
 * column:'path'}` is one forgotten allowlist away from a page reference on a column
 * that is supposed to be an asset.
 *
 * The other half is the capability check. SQLite refuses two operations the naive AST
 * can express, and both refusals have to happen **here, before a statement exists**,
 * or the operator sees raw SQLite text in a modal after describing the change:
 *
 *   1. `ALTER TABLE … ADD COLUMN … NOT NULL` with no default
 *      → "Cannot add a NOT NULL column with default value NULL"  (reason=default_required)
 *   2. `ALTER TABLE … DROP COLUMN` on an indexed or FK-referenced column
 *      → "error in index ix_… after drop column"                 (reason=rebuild_required)
 *
 * Three of the five refusals are pure (no schema read: they are decided by the AST
 * alone, so `plan()` runs them before a connection is even opened); `rebuild_required`
 * and the index-count half of `limit` need the schema, and they run before
 * `BEGIN IMMEDIATE` as read-only checks.
 */
import { AppError } from '../errors.ts';
import { emitCreateTable, emitColumn, type ColumnSpec, type ColumnType } from './emit.ts';

export type { ColumnSpec, ColumnType } from './emit.ts';

export interface CreateTableOp {
  op: 'create_table';
  name: string;
  columns: ColumnSpec[];
}
export interface AddColumnOp {
  op: 'add_column';
  table: string;
  column: ColumnSpec;
}
export interface DropColumnOp {
  op: 'drop_column';
  table: string;
  column: string;
  rebuild?: true;
}
export interface RenameTableOp {
  op: 'rename_table';
  from: string;
  to: string;
}
export interface CreateIndexOp {
  op: 'create_index';
  table: string;
  name: string;
  columns: string[];
  unique: boolean;
}
export interface DropIndexOp {
  op: 'drop_index';
  name: string;
}
export interface DropTableOp {
  op: 'drop_table';
  name: string;
}

export type DdlOp =
  | CreateTableOp
  | AddColumnOp
  | DropColumnOp
  | RenameTableOp
  | CreateIndexOp
  | DropIndexOp
  | DropTableOp;

/** §4.4's five reasons, verbatim and closed. */
export type RefusalReason = 'default_required' | 'rebuild_required' | 'limit' | 'reserved_prefix' | 'too_many_statements';

export const TABLE_NAME = /^u_[a-z0-9_]+$/;
export const INDEX_NAME = /^ix_[a-z0-9_]+$/;
export const COLUMN_NAME = /^[a-z][a-z0-9_]{0,39}$/;
export const MAX_COLUMNS = 40;
export const MAX_INDEXES = 8;

/** §4.4: 422 `SKW_E_DM_DDL_REJECTED` with the reason on the wire. */
export function refuse(reason: RefusalReason, message?: string): AppError {
  return new AppError('SKW_E_DM_DDL_REJECTED', message, { reason });
}

// --- what the planner may read -------------------------------------------

export interface ColumnFacts {
  name: string;
  type: string;
  notNull: boolean;
  pk: boolean;
}

export interface IndexFacts {
  name: string;
  columns: string[];
  unique: boolean;
}

export interface TriggerFacts {
  name: string;
  tableName: string;
  sql: string;
  purpose: string;
  checksum: string;
}

export interface TableFacts {
  exists: boolean;
  columns: ColumnFacts[];
  indexes: IndexFacts[];
  /** Columns that appear in a REFERENCES clause anywhere in this table's SQL. */
  fkColumns: string[];
  /** Triggers whose `ON` clause names this table, plus guards that read it. */
  triggers: TriggerFacts[];
  /** `cms_table_registry.columns_json`, parsed. The AST's own record of the shape. */
  registryColumns: ColumnSpec[] | null;
}

export interface DdlContext {
  table(name: string): TableFacts;
  /** Which `u_*` table owns an index, or null. `drop_index` names no table. */
  indexOwner(name: string): { table: string } | null;
  /** `SKW_DDL_MAX_STATEMENTS`, default 8. */
  maxStatements: number;
}

// --- the plan -------------------------------------------------------------

export type RegistryEffect =
  | { kind: 'insert'; row: RegistryRow }
  | { kind: 'update'; table: string; column_count: number; index_count: number; columns_json: string; table_name: string }
  | { kind: 'delete'; table: string };

export interface RegistryRow {
  table_name: string;
  table_class: 'user';
  plugin_id: null;
  ddl_version: 1;
  column_count: number;
  index_count: number;
  columns_json: string;
}

export interface DdlPlan {
  op: DdlOp;
  /** The exact statements, in order. The preview and the execution are this array. */
  statements: string[];
  /** Set when the 12-step procedure is used: `foreign_keys=OFF` outside the transaction. */
  rebuild?: {
    table: string;
    /** Statements to run inside the transaction, after `foreign_keys=OFF`. */
    sequence: RebuildSequence;
  };
  registry: RegistryEffect;
  audit: { action: string; targetKind: string; targetId: string; before: unknown; after: unknown };
}

export interface RebuildSequence {
  /** `CREATE TABLE <tmp> (…)` — byte-identical to what `create_table` would emit. */
  create: string;
  insertSelect: string;
  dropTriggers: string[];
  dropTable: string;
  rename: string;
  createIndexes: string[];
  restoreSequence: string[];
  recreateTriggers: string[];
  triggerRegistryRows: string[];
}

// --- the pure half: decided by the AST alone ------------------------------

/**
 * §4.4's refusals that need no schema. Runs before a connection exists, so a request
 * that is refused here provably executed nothing (`ddl-runner.test.ts` instruments the
 * handle factory and asserts it was never called).
 */
export function assertPure(op: DdlOp, index: number): void {
  switch (op.op) {
    case 'create_table':
      if (!TABLE_NAME.test(op.name)) {
        throw refuse('reserved_prefix', `a table name must match ^u_[a-z0-9_]+$ (got ${JSON.stringify(op.name)})`);
      }
      if (op.columns.length === 0 || op.columns.length > MAX_COLUMNS) {
        throw refuse('limit', `a table carries 1..${MAX_COLUMNS} columns besides id (got ${op.columns.length})`);
      }
      for (const column of op.columns) assertColumn(column);
      break;
    case 'add_column':
      if (!TABLE_NAME.test(op.table)) throw refuse('reserved_prefix', `not a u_* table: ${JSON.stringify(op.table)}`);
      assertColumn(op.column);
      // C-13's capability check #1: SQLite refuses this ALTER, so the AST must.
      if (op.column.notNull === true && op.column.default === undefined) {
        throw refuse(
          'default_required',
          `${op.column.name} is NOT NULL with no default: SQLite refuses "Cannot add a NOT NULL column with default value NULL"`,
        );
      }
      break;
    case 'drop_column':
      if (!TABLE_NAME.test(op.table)) throw refuse('reserved_prefix', `not a u_* table: ${JSON.stringify(op.table)}`);
      if (!COLUMN_NAME.test(op.column)) {
        throw refuse('reserved_prefix', `${JSON.stringify(op.column)} is not a column name`);
      }
      break;
    case 'rename_table':
      if (!TABLE_NAME.test(op.from) || !TABLE_NAME.test(op.to)) {
        throw refuse('reserved_prefix', 'both names must match ^u_[a-z0-9_]+$');
      }
      if (op.from === op.to) throw new AppError('SKW_E_PLT_REQUEST_INVALID', 'a rename needs two different names');
      break;
    case 'create_index':
      if (!TABLE_NAME.test(op.table)) throw refuse('reserved_prefix', `not a u_* table: ${JSON.stringify(op.table)}`);
      if (!INDEX_NAME.test(op.name)) throw refuse('reserved_prefix', `an index name must match ^ix_[a-z0-9_]+$ (got ${JSON.stringify(op.name)})`);
      if (op.columns.length === 0) throw new AppError('SKW_E_PLT_REQUEST_INVALID', 'an index needs at least one column');
      for (const column of op.columns) {
        if (!COLUMN_NAME.test(column)) throw refuse('reserved_prefix', `${JSON.stringify(column)} is not a column name`);
      }
      break;
    case 'drop_index':
      if (!INDEX_NAME.test(op.name)) throw refuse('reserved_prefix', `an index name must match ^ix_[a-z0-9_]+$ (got ${JSON.stringify(op.name)})`);
      break;
    case 'drop_table':
      if (!TABLE_NAME.test(op.name)) {
        throw refuse('reserved_prefix', `a table name must match ^u_[a-z0-9_]+$ (got ${JSON.stringify(op.name)})`);
      }
      break;
    default: {
      const never: never = op;
      throw new AppError('SKW_E_PLT_REQUEST_INVALID', `not a DdlOp: ${JSON.stringify(never)}`);
    }
  }
  void index;
}

function assertColumn(column: ColumnSpec): void {
  if (!COLUMN_NAME.test(column.name)) {
    throw new AppError('SKW_E_PLT_REQUEST_INVALID', `${JSON.stringify(column.name)} is not a column name`);
  }
  if (column.type === 'RELATION' && (column.relation === undefined || !TABLE_NAME.test(column.relation))) {
    throw new AppError('SKW_E_PLT_REQUEST_INVALID', `${column.name} is a RELATION without a u_<table> target`);
  }
}

/** §4.4's `too_many_statements`, plus the per-request repeat of `assertPure`. */
export function assertBatch(ops: readonly DdlOp[], maxStatements: number): void {
  if (!Array.isArray(ops) || ops.length === 0) {
    throw new AppError('SKW_E_PLT_REQUEST_INVALID', 'a DDL request carries at least one operation');
  }
  if (ops.length > maxStatements) {
    throw refuse('too_many_statements', `${ops.length} operations, and SKW_DDL_MAX_STATEMENTS is ${maxStatements}`);
  }
  ops.forEach((op, i) => {
    assertPure(op, i);
  });
}

// --- the context half -----------------------------------------------------

/**
 * The refusals that need the schema, run after the handle is open and **before**
 * `BEGIN IMMEDIATE`. Reading `sqlite_master` and `pragma table_info` is not a schema
 * change: a request refused here has emitted no DDL.
 */
export function assertContextual(op: DdlOp, ctx: DdlContext): void {
  switch (op.op) {
    case 'add_column': {
      const facts = mustExist(op.table, ctx);
      if (facts.columns.length + 1 > MAX_COLUMNS) {
        throw refuse('limit', `${op.table} would carry ${facts.columns.length + 1} columns (max ${MAX_COLUMNS})`);
      }
      if (facts.columns.some((c) => c.name === op.column.name)) {
        throw new AppError('SKW_E_DM_KEY_IN_USE', `${op.column.name} already exists on ${op.table}`);
      }
      // A NOT NULL REFERENCE column cannot be added in place: with foreign_keys=ON
      // SQLite refuses a REFERENCES clause whose default is not NULL, and the default
      // is what a NOT NULL column needs. The 12-step rebuild runs with
      // foreign_keys=OFF and is the only route.
      if (op.column.notNull === true && isReferenceType(op.column.type) && op.column.default === undefined) {
        throw refuse('rebuild_required', `a NOT NULL ${op.column.type} column cannot be added in place; it needs the rebuild`);
      }
      break;
    }
    case 'drop_column': {
      const facts = mustExist(op.table, ctx);
      if (!facts.columns.some((c) => c.name === op.column)) {
        throw new AppError('SKW_E_PLT_REQUEST_INVALID', `${op.table} has no column ${op.column}`);
      }
      if (facts.columns.filter((c) => !c.pk).length <= 1) {
        throw refuse('limit', `${op.table} would be left with no column besides id`);
      }
      // C-13's capability check #2: an indexed or FK-referenced column needs the
      // rebuild, and the caller has to ask for it.
      const indexed = facts.indexes.find((ix) => ix.columns.includes(op.column));
      const referenced = facts.fkColumns.includes(op.column);
      if (op.rebuild !== true && (indexed !== undefined || referenced)) {
        const why = indexed !== undefined ? `indexed by ${indexed.name}` : 'referenced by a foreign key';
        throw refuse('rebuild_required', `${op.table}.${op.column} is ${why}; pass rebuild: true`);
      }
      break;
    }
    case 'rename_table': {
      mustExist(op.from, ctx);
      if (ctx.table(op.to).exists) throw new AppError('SKW_E_DM_KEY_IN_USE', `${op.to} already exists`);
      break;
    }
    case 'create_index': {
      const facts = mustExist(op.table, ctx);
      if (facts.indexes.length + 1 > MAX_INDEXES) {
        throw refuse('limit', `${op.table} would carry ${facts.indexes.length + 1} indexes (max ${MAX_INDEXES})`);
      }
      for (const column of op.columns) {
        if (!facts.columns.some((c) => c.name === column)) {
          throw new AppError('SKW_E_PLT_REQUEST_INVALID', `${op.table} has no column ${column}`);
        }
      }
      if (facts.indexes.some((ix) => ix.name === op.name)) {
        throw new AppError('SKW_E_DM_KEY_IN_USE', `${op.name} already exists`);
      }
      break;
    }
    case 'drop_index': {
      const found = ctx.indexOwner(op.name);
      if (found === null) throw new AppError('SKW_E_PLT_REQUEST_INVALID', `no index ${op.name}`);
      break;
    }
    case 'drop_table': {
      mustExist(op.name, ctx);
      break;
    }
    case 'create_table': {
      if (ctx.table(op.name).exists) throw new AppError('SKW_E_DM_KEY_IN_USE', `${op.name} already exists`);
      break;
    }
    default: {
      const never: never = op;
      throw new AppError('SKW_E_PLT_REQUEST_INVALID', `not a DdlOp: ${JSON.stringify(never)}`);
    }
  }
}

function mustExist(name: string, ctx: DdlContext): TableFacts {
  const facts = ctx.table(name);
  if (!facts.exists) throw new AppError('SKW_E_PLT_REQUEST_INVALID', `no table ${name}`);
  if (facts.registryColumns === null) {
    // A u_* table with no registry row is a schema the postcondition would have
    // refused; it cannot be edited, because the rebuild regenerates from the registry.
    throw new AppError('SKW_E_DM_DDL_POSTCONDITION', `${name} has no cms_table_registry row`);
  }
  return facts;
}

/**
 * The AST's columns, without the `id` primary key the runner owns.
 *
 * `cms_table_registry.columns_json` carries `id` as its first entry (the registry is the
 * Kysely generator's inventory, so it needs the whole shape), while `DdlOp`'s
 * `columns` is only the operator's. Every registry update here works from this list and
 * lets `withId()` put the primary key back exactly once.
 */
export function astColumns(facts: TableFacts): ColumnSpec[] {
  return (facts.registryColumns ?? []).filter((c) => c.name !== 'id' && (c as { pk?: boolean }).pk !== true);
}

export function isReferenceType(type: ColumnType): boolean {
  return type === 'ASSET' || type === 'PAGE' || type === 'RELATION';
}

// --- emission -------------------------------------------------------------

/**
 * `emit(op, ctx)` — the statements, the registry effect and the audit images.
 *
 * The runner executes `plan.statements` in order and nothing else; the preview route
 * shows the same array. There is no second string builder in the tree, which is the
 * only way "the preview is the SQL that runs" can be true.
 */
export function emit(op: DdlOp, ctx: DdlContext): DdlPlan {
  assertPure(op, 0);
  assertContextual(op, ctx);

  switch (op.op) {
    case 'create_table': {
      const statements = emitCreateTable(op);
      const row = registryRowOf(op.name, op.columns, 0);
      // §16 S2: a `u_*` table with an asset column gets its delete guard in the same
      // transaction. One trigger per table, whatever the number of asset columns.
      const guard = assetGuard(op.name, op.columns);
      if (guard !== null) statements.push(guard.trigger, guard.registry);
      return {
        op,
        statements,
        registry: { kind: 'insert', row },
        audit: {
          action: 'ddl.create_table',
          targetKind: 'u_table',
          targetId: op.name,
          before: null,
          after: { table: op.name, columns: row.columns_json },
        },
      };
    }
    case 'add_column': {
      const facts = mustExist(op.table, ctx);
      const columns = [...astColumns(facts), op.column];
      if (op.column.notNull === true && isReferenceType(op.column.type)) {
        return rebuildPlan(op, facts, columns, 'ddl.add_column', {
          table: op.table,
          column: op.column.name,
        });
      }
      const statements = [`ALTER TABLE "${op.table}" ADD COLUMN ${emitColumn(op.column)}`];
      const guard = assetGuard(op.table, columns);
      if (guard !== null && !facts.triggers.some((t) => t.name === guard.name)) statements.push(guard.trigger, guard.registry);
      return {
        op,
        statements,
        registry: {
          kind: 'update',
          table: op.table,
          table_name: op.table,
          column_count: columns.length + 1,
          index_count: facts.indexes.length,
          columns_json: JSON.stringify(withId(columns)),
        },
        audit: {
          action: 'ddl.add_column',
          targetKind: 'u_table',
          targetId: op.table,
          before: { columns: facts.registryColumns },
          after: { column: op.column, columns },
        },
      };
    }
    case 'drop_column': {
      const facts = mustExist(op.table, ctx);
      const kept = astColumns(facts).filter((c) => c.name !== op.column);
      return rebuildPlan(op, facts, kept, 'ddl.drop_column', { table: op.table, column: op.column });
    }
    case 'rename_table': {
      const facts = mustExist(op.from, ctx);
      return {
        op,
        statements: [`ALTER TABLE "${op.from}" RENAME TO "${op.to}"`],
        registry: {
          kind: 'update',
          table: op.from,
          table_name: op.to,
          column_count: facts.columns.length,
          index_count: facts.indexes.length,
          columns_json: JSON.stringify(withId(astColumns(facts))),
        },
        audit: { action: 'ddl.rename_table', targetKind: 'u_table', targetId: op.to, before: { table: op.from }, after: { table: op.to } },
      };
    }
    case 'create_index': {
      const facts = mustExist(op.table, ctx);
      const columns = op.columns.map((c) => `"${c}"`).join(', ');
      return {
        op,
        statements: [`CREATE ${op.unique ? 'UNIQUE ' : ''}INDEX "${op.name}" ON "${op.table}" (${columns})`],
        registry: {
          kind: 'update',
          table: op.table,
          table_name: op.table,
          column_count: facts.columns.length,
          index_count: facts.indexes.length + 1,
          columns_json: JSON.stringify(withId(astColumns(facts))),
        },
        audit: {
          action: 'ddl.create_index',
          targetKind: 'u_table',
          targetId: op.table,
          before: { indexes: facts.indexes },
          after: { name: op.name, columns: op.columns, unique: op.unique },
        },
      };
    }
    case 'drop_index': {
      const owner = ctx.indexOwner(op.name);
      if (owner === null) throw new AppError('SKW_E_PLT_REQUEST_INVALID', `no index ${op.name}`);
      const facts = mustExist(owner.table, ctx);
      return {
        op,
        statements: [`DROP INDEX "${op.name}"`],
        registry: {
          kind: 'update',
          table: owner.table,
          table_name: owner.table,
          column_count: facts.columns.length,
          index_count: Math.max(0, facts.indexes.length - 1),
          columns_json: JSON.stringify(withId(astColumns(facts))),
        },
        audit: { action: 'ddl.drop_index', targetKind: 'u_table', targetId: owner.table, before: { name: op.name }, after: null },
      };
    }
    case 'drop_table': {
      const facts = mustExist(op.name, ctx);
      const statements = [`DROP TABLE "${op.name}"`];
      for (const trigger of facts.triggers) statements.push(`DROP TRIGGER IF EXISTS "${trigger.name}"`);
      // Exact names, not a LIKE pattern: `_` is a wildcard in LIKE, so
      // `trg_asset_guard_u_a_b` would also match `trg_asset_guard_u_axb` and delete a
      // neighbour's registry row.
      statements.push(
        `DELETE FROM cms_trigger_registry WHERE table_name = '${op.name}' OR name = 'trg_asset_guard_${op.name}'`,
      );
      return {
        op,
        statements,
        registry: { kind: 'delete', table: op.name },
        audit: { action: 'ddl.drop_table', targetKind: 'u_table', targetId: op.name, before: { table: op.name }, after: null },
      };
    }
    default: {
      const never: never = op;
      throw new AppError('SKW_E_PLT_REQUEST_INVALID', `not a DdlOp: ${JSON.stringify(never)}`);
    }
  }
}

function rebuildPlan(
  op: AddColumnOp | DropColumnOp,
  facts: TableFacts,
  columns: ColumnSpec[],
  action: string,
  images: Record<string, unknown>,
): DdlPlan {
  const table = op.table;
  const tmp = `${table}__rebuild`;
  // The rebuilt table is byte-for-byte what `create_table` would have produced: one
  // emitter, so a rebuild cannot drift from a create.
  const create = emitCreateTable({ op: 'create_table', name: tmp, columns })[0] as string;
  // Only the columns the old table actually has: a column this rebuild *adds* has no
  // source, and takes its DEFAULT (or NULL) for the rows carried over.
  const carried = columns.filter((c) => facts.columns.some((old) => old.name === c.name));
  const names = ['"id"', ...carried.map((c) => `"${c.name}"`)].join(', ');
  const guards = facts.triggers.filter((t) => t.purpose === 'asset_delete_guard' || t.name.startsWith('trg_asset_guard_'));
  const others = facts.triggers.filter((t) => !guards.includes(t));
  // "Recreate every index" (§4.5) means every index the rebuilt table can still carry:
  // an index on a dropped column is dropped with it, by SQLite's own `DROP COLUMN`
  // semantics and by this rebuild.
  const keptIndexes = facts.indexes.filter((ix) => ix.columns.every((c) => columns.some((col) => col.name === c)));
  // The guard the *rebuilt* table needs: one per table, over whatever asset columns
  // remain (none, if the rebuild dropped the last one).
  const guard = assetGuard(table, columns);

  const sequence: RebuildSequence = {
    create,
    insertSelect: `INSERT INTO "${tmp}" (${names}) SELECT ${names} FROM "${table}"`,
    dropTriggers: [...guards, ...others].map((t) => `DROP TRIGGER IF EXISTS "${t.name}"`),
    dropTable: `DROP TABLE "${table}"`,
    rename: `ALTER TABLE "${tmp}" RENAME TO "${table}"`,
    createIndexes: keptIndexes.map(
      (ix) => `CREATE ${ix.unique ? 'UNIQUE ' : ''}INDEX "${ix.name}" ON "${table}" (${ix.columns.map((c) => `"${c}"`).join(', ')})`,
    ),
    // §4.5: restore `sqlite_sequence` from a temp copy. A `u_*` table's id is an
    // `INTEGER PRIMARY KEY`, which is a rowid alias and carries no sequence row —
    // but the procedure is the same one the `cms_*` rebuilds use, and a table that
    // gains AUTOINCREMENT later must not lose its high-water mark.
    restoreSequence: restoreSequenceSql(table, tmp),
    // A guard trigger is **regenerated** from the rebuilt column list, never replayed
    // verbatim: its `WHEN` clause names the asset columns, and dropping one of them
    // leaves a trigger SQLite will accept (it does not resolve the name at CREATE time)
    // that then fails at runtime on every `DELETE FROM cms_asset`. Measured before the
    // fix: `drop_column u_post.cover` left `trg_asset_guard_u_post` pointing at a column
    // that no longer existed. Other triggers are replayed verbatim, which is what §4.5
    // asks for.
    recreateTriggers: [...others.map((t) => t.sql), ...(guard === null ? [] : [guard.trigger])],
    triggerRegistryRows: [
      // The old guard's registry row is deleted before the regenerated one is written: if
      // the rebuild dropped the last asset column there is no new guard, and a row for a
      // trigger that no longer exists is exactly what the postcondition refuses.
      ...guards.map((t) => `DELETE FROM cms_trigger_registry WHERE name = '${t.name}'`),
      ...others.map(
        (t) =>
          `INSERT OR REPLACE INTO cms_trigger_registry(name, table_name, purpose, checksum) VALUES ` +
          `('${t.name}', '${t.tableName}', '${t.purpose}', '${t.checksum}')`,
      ),
      ...(guard === null ? [] : [guard.registry]),
    ],
  };

  return {
    op,
    statements: [sequence.create, sequence.insertSelect, ...sequence.dropTriggers, sequence.dropTable, sequence.rename, ...sequence.createIndexes, ...sequence.restoreSequence, ...sequence.recreateTriggers, ...sequence.triggerRegistryRows],
    rebuild: { table, sequence },
    registry: {
      kind: 'update',
      table,
      table_name: table,
      column_count: columns.length + 1,
      index_count: keptIndexes.length,
      columns_json: JSON.stringify(withId(columns)),
    },
    audit: { action, targetKind: 'u_table', targetId: table, before: { columns: facts.registryColumns }, after: { ...images, columns } },
  };
}

/**
 * `sqlite_sequence` has no unique constraint to upsert on, so the restore is
 * `UPDATE`-then-`INSERT`. Both statements are no-ops on a table without one.
 */
function restoreSequenceSql(table: string, tmp: string): string[] {
  return [
    `UPDATE sqlite_sequence SET seq = COALESCE((SELECT seq FROM sqlite_sequence WHERE name = '${tmp}'), seq) WHERE name = '${table}'`,
    `INSERT INTO sqlite_sequence(name, seq) SELECT '${table}', seq FROM sqlite_sequence WHERE name = '${tmp}' AND NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = '${table}')`,
  ];
}

/** §4.4's registry row: `id` first, then the AST's columns. */
export function registryRowOf(name: string, columns: ColumnSpec[], indexCount: number): RegistryRow {
  return {
    table_name: name,
    table_class: 'user',
    plugin_id: null,
    ddl_version: 1,
    column_count: columns.length + 1,
    index_count: indexCount,
    columns_json: JSON.stringify(withId(columns)),
  };
}

export function withId(columns: ColumnSpec[]): Record<string, unknown>[] {
  return [
    { name: 'id', type: 'INTEGER', notNull: true, pk: true },
    ...columns.map((c) => ({
      name: c.name,
      type: c.type,
      notNull: c.notNull === true,
      ...(c.default !== undefined ? { default: c.default } : {}),
      ...(c.relation !== undefined ? { relation: c.relation } : {}),
    })),
  ];
}

/**
 * §8.2 / O-36 / §16 S2: one guard per table that carries an asset column.
 *
 * The guard is a trigger **on `cms_asset`** that refuses the delete when this table
 * still references the key, and it is registered in `cms_trigger_registry` in the same
 * transaction — the registry is what the postcondition reads, so a guard that is not
 * registered fails the postcondition rather than surviving unregistered.
 */
export function assetGuard(table: string, columns: ColumnSpec[]): { name: string; trigger: string; registry: string } | null {
  const assetColumns = columns.filter((c) => c.type === 'ASSET').map((c) => c.name);
  if (assetColumns.length === 0) return null;
  const name = `trg_asset_guard_${table}`;
  const when = assetColumns.map((c) => `EXISTS (SELECT 1 FROM "${table}" WHERE "${c}" = OLD."key")`).join(' OR ');
  return {
    name,
    trigger: `CREATE TRIGGER "${name}" BEFORE DELETE ON cms_asset\nWHEN ${when}\nBEGIN\n  SELECT RAISE(ABORT, 'SKW_E_DM_ASSET_IN_USE');\nEND`,
    // `OR REPLACE`, because the row outlives a dropped trigger: a rebuild drops the
    // trigger, keeps its registry row until the regenerated one is written, and a plain
    // INSERT would collide with the row it is about to replace.
    registry: `INSERT OR REPLACE INTO cms_trigger_registry(name, table_name, purpose, checksum) VALUES ('${name}', 'cms_asset', 'asset_delete_guard', 'v3')`,
  };
}
