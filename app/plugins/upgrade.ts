/**
 * Upgrading a package in place: the schema half.
 *
 * Installing a new version used to mean uninstalling the old one, and uninstall **drops** every
 * table the manifest declares — so "upgrade the contact package" and "delete every message a
 * customer ever sent" were the same instruction. That is not a trade an operator should be asked
 * to make, and on a live site it is not one they can make safely.
 *
 * So an install over an existing root is now an upgrade, and the rule is the one a database
 * migration has always had:
 *
 *   **additive changes are applied; destructive ones are refused by name.**
 *
 * A new column, a new table, a new index: applied with `ALTER TABLE … ADD COLUMN` and the existing
 * `CREATE … IF NOT EXISTS` statements, leaving every row where it is. A dropped column, a dropped
 * table, a changed column type: refused with `SKW_E_PL_DESTRUCTIVE_UPGRADE` and a sentence that says
 * which column and which version, because a package cannot delete a tenant's data by being
 * installed. The one way through is the manifest's own `migrations` block — an explicit, versioned
 * list of statements the package author wrote for exactly this transition.
 *
 * What is deliberately *not* here: backfills, data transforms, and rollback. A migration that moves
 * data belongs in the package's declared `ops`, written by the person who knows what the data
 * means; and a schema that went wrong is restored from the backup the operator took before running
 * this, not from something this file invents.
 */
import type Database from 'better-sqlite3';
import type { ColumnSpec, Manifest, TableSpec } from './manifest.ts';

/** A statement the upgrade runs, and the sentence an operator can read about why. */
export interface UpgradeStep {
  sql: string;
  why: string;
}

export class DestructiveUpgrade extends Error {
  readonly code = 'SKW_E_PL_DESTRUCTIVE_UPGRADE';
  readonly details: Record<string, unknown>;
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.details = details;
  }
}

/**
 * Compare two `x.y.z` versions. Returns < 0 when `a` precedes `b`.
 *
 * Not a full semver: a plugin version is `major.minor.patch` of integers, which is what the manifest
 * validator already enforces. Prerelease tags are out of scope because the installer has no channel
 * concept — an upgrade is an upgrade.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): number[] => v.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

const LIVE_TYPES = new Map<string, string>([
  ['TEXT', 'TEXT'],
  ['INTEGER', 'INTEGER'],
  ['REAL', 'REAL'],
  ['BLOB', 'BLOB'],
]);

/** The columns a table actually has. `[]` for a table that does not exist yet. */
function liveColumns(db: Database.Database, table: string): { name: string; type: string; notNull: number }[] {
  const exists = db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  if (exists === undefined) return [];
  return db.prepare(`PRAGMA table_xinfo("${table}")`).all() as { name: string; type: string; notNull: number }[];
}

function literal(value: string | number | boolean | null): string {
  if (value === null) return 'NULL';
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'number') return String(value);
  return `'${value.replace(/'/g, "''")}'`;
}

/** `ALTER TABLE … ADD COLUMN`, with SQLite's own restriction honoured rather than tripped over. */
function addColumn(table: string, column: ColumnSpec, version: string): UpgradeStep {
  const sqlType = column.type === 'ASSET' || column.type === 'JSON' ? 'TEXT' : column.type;
  const parts = [`"${column.name}"`, sqlType];
  // SQLite refuses ADD COLUMN … NOT NULL without a non-NULL default. Refusing here, by name, is
  // better than letting the ALTER fail inside a transaction the operator cannot read.
  if (column.notNull === true) {
    if (column.default === undefined || column.default === null) {
      throw new DestructiveUpgrade(
        `${table}.${column.name} is new in ${version} and is NOT NULL with no default: SQLite cannot add that column to a table that already has rows. Declare a default, or add it nullable and backfill in \`migrations\`.`,
        { table, column: column.name, version },
      );
    }
    parts.push('NOT NULL');
  }
  if (column.default !== undefined) parts.push(`DEFAULT ${literal(column.default)}`);
  return { sql: `ALTER TABLE "${table}" ADD COLUMN ${parts.join(' ')}`, why: `${table}.${column.name} is new in ${version}` };
}

/**
 * Diff two manifests against the live schema and say what the upgrade will run.
 *
 * Throws `DestructiveUpgrade` for anything that would lose a row or a column. The caller turns that
 * into `SKW_E_PL_DESTRUCTIVE_UPGRADE`; nothing is written before this returns.
 */
export function planUpgrade(db: Database.Database, previous: Manifest, next: Manifest): UpgradeStep[] {
  const steps: UpgradeStep[] = [];
  const before = new Map(previous.tables.map((t) => [t.name, t]));
  const after = new Map(next.tables.map((t) => [t.name, t]));

  // A package may declare the statements that retire what it no longer needs. That is the only
  // route from a destructive change, and it is written by the author, in the manifest, on the
  // record — not inferred here.
  const declared = (next.migrations ?? []).filter((m) => m.version === next.version).flatMap((m) => m.ops ?? []);

  for (const name of before.keys()) {
    if (after.has(name)) continue;
    if (declared.length > 0) continue;
    throw new DestructiveUpgrade(
      `${next.id} ${next.version} no longer declares the table ${name}. Removing a table deletes its rows; declare the statements that retire it in \`migrations\`, or keep the table.`,
      { table: name, version: next.version },
    );
  }

  for (const [name, table] of after) {
    const live = liveColumns(db, name);
    if (live.length === 0) continue; // a new table: `CREATE TABLE IF NOT EXISTS` handles it
    const wanted = new Map((table.columns ?? []).map((c) => [c.name, c]));
    const have = new Map(live.map((c) => [c.name, c]));

    for (const [column, spec] of wanted) {
      const existing = have.get(column);
      if (existing === undefined) {
        steps.push(addColumn(name, spec, next.version));
        continue;
      }
      // A type change is a rewrite of every value; SQLite's ALTER cannot express it, and guessing
      // at a conversion is how a phone number becomes a number.
      const expected = LIVE_TYPES.get(spec.type === 'ASSET' || spec.type === 'JSON' ? 'TEXT' : spec.type) ?? spec.type;
      const actual = (existing.type === '' ? 'TEXT' : existing.type).toUpperCase();
      if (actual !== expected && declared.length === 0) {
        throw new DestructiveUpgrade(
          `${name}.${column} changes type from ${actual} to ${expected} in ${next.version}. That rewrites every value; declare the conversion in \`migrations\`.`,
          { table: name, column, from: actual, to: expected, version: next.version },
        );
      }
    }

    for (const column of have.keys()) {
      if (column === 'id' || wanted.has(column)) continue;
      if (declared.length > 0) continue;
      throw new DestructiveUpgrade(
        `${next.id} ${next.version} drops ${name}.${column}. Dropping a column deletes what it held; declare the statements that retire it in \`migrations\`, or keep the column.`,
        { table: name, column, version: next.version },
      );
    }
  }

  // The declared ops are **permissions, not statements.** They exist so the three guards above can
  // be satisfied on the record by an author who means the change; the DDL itself comes from
  // `tableStatements` (a new table, a new index) and `addColumn` (a new column), which every upgrade
  // already runs. Pushing a declared op into `steps` made it `db.exec()`-able text: `ops:
  // ["create_table"]` reached SQLite as the literal `create_table` and the install died on
  // `near "create_table": syntax error`. A manifest string must never be a statement (§8.2).
  return steps;
}

/** The tables a manifest owns, for a caller that wants to say so in a message. */
export function ownedTables(manifest: Manifest): string[] {
  return manifest.tables.map((table: TableSpec) => table.name);
}
