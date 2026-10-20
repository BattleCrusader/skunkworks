/**
 * C-13 — Kysely types generated from `cms_table_registry.columns_json`.
 *
 * The registry is the **closed-type column inventory**: the DDL runner writes it
 * from the same `ColumnSpec` union the emitter uses, and the 12-step rebuild
 * regenerates a table from it. A second description of a table (an `information_
 * schema` read, a hand-written interface) would disagree with the rebuild at the
 * first column someone forgot, so the generator reads the registry and nothing
 * else.
 *
 * Output is deterministic — tables ordered by name, columns in registry order, no
 * timestamp in the header — because `test/kysely-types.test.ts` regenerates twice
 * and compares bytes. The committed `kysely.generated.ts` is the base schema's
 * output (a fresh `site.db` has no runtime tables); a tenant's file is regenerated
 * from that tenant's registry.
 *
 * The type mapping is the one SQLite actually stores:
 *
 *   TEXT / DATE / ASSET / PAGE / RELATION -> string
 *   INTEGER / REAL / NUMERIC              -> number
 *   BOOLEAN                               -> number   (SQLite stores 0/1; the CHECK is in the DDL)
 *   BLOB                                  -> Uint8Array
 *
 * The integer primary key `id` is `number` and never nullable.
 */
import type Database from 'better-sqlite3';
import { writeFileSync } from 'node:fs';

import type { ColumnSpec, ColumnType } from '../ddl/emit.ts';

export interface GeneratedTable {
  table: string;
  interfaceName: string;
  columns: { name: string; type: string; notNull: boolean }[];
}

const TYPE_MAP: Record<ColumnType, string> = {
  TEXT: 'string',
  DATE: 'string',
  ASSET: 'string',
  PAGE: 'string',
  RELATION: 'string',
  INTEGER: 'number',
  REAL: 'number',
  NUMERIC: 'number',
  BOOLEAN: 'number',
  BLOB: 'Uint8Array',
};

export function interfaceNameFor(table: string): string {
  const pascal = table
    .split('_')
    .filter((part) => part.length > 0)
    .map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`)
    .join('');
  return `${pascal}Table`;
}

/** Read the registry, in a stable order, with the closed type map applied. */
export function tablesFromRegistry(db: Database.Database): GeneratedTable[] {
  const rows = db
    .prepare('SELECT table_name, columns_json FROM cms_table_registry ORDER BY table_name')
    .all() as { table_name: string; columns_json: string }[];
  return rows.map((row) => {
    const specs = JSON.parse(row.columns_json) as ColumnSpec[];
    return {
      table: row.table_name,
      interfaceName: interfaceNameFor(row.table_name),
      columns: specs.map((spec) => ({
        name: spec.name,
        type: TYPE_MAP[spec.type] ?? 'string',
        notNull: spec.name === 'id' ? true : spec.notNull === true,
      })),
    };
  });
}

const HEADER = `/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Source: cms_table_registry.columns_json (C-13's closed-type column inventory).
 * Regenerate: node app/cli/gen-kysely.ts --db <site.db> --out <this file>
 */`;

export function generateKyselyTypes(db: Database.Database): string {
  const tables = tablesFromRegistry(db);
  const blocks: string[] = [HEADER, ''];
  for (const table of tables) {
    blocks.push(`export interface ${table.interfaceName} {`);
    for (const column of table.columns) {
      blocks.push(`  ${column.name}: ${column.type}${column.notNull ? '' : ' | null'};`);
    }
    blocks.push('}', '');
  }
  blocks.push('export interface Database {');
  for (const table of tables) blocks.push(`  ${table.table}: ${table.interfaceName};`);
  blocks.push('}', '');
  return blocks.join('\n');
}

export function writeKyselyTypes(db: Database.Database, outPath: string): { bytes: number; tables: number } {
  const text = generateKyselyTypes(db);
  writeFileSync(outPath, text);
  return { bytes: Buffer.byteLength(text), tables: tablesFromRegistry(db).length };
}
