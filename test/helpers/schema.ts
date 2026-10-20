/**
 * Schema convergence comparison (§4.5 as amended by 02-errata E-14).
 *
 * Check 20 used to compare `(type, name)` — a table that lost a CHECK passed it.
 * This compares, on both planes and in both directions: the table set, the index
 * set, the trigger set, `PRAGMA table_info` per table as `(name, type, notnull)`,
 * the `sqlite_master.sql` text of every table (where CHECK constraints live) and
 * the `sqlite_master.sql` text of every trigger, and it names the differing
 * object.
 *
 * Normalised, and only this: identifier quoting (`"x"` and `x` are the same
 * identifier), runs of whitespace, and — because §4.5 explicitly does **not**
 * compare column order or defaults — the order of the definitions inside a
 * CREATE TABLE and any DEFAULT clause. A CHECK expression is compared as text.
 */
import type Database from 'better-sqlite3';

export interface PlaneShape {
  tables: Set<string>;
  indexes: Set<string>;
  triggers: Set<string>;
  cols: Map<string, Set<string>>;
  tableSql: Map<string, string>;
  triggerSql: Map<string, string>;
}

const IDENT_RE = /"([A-Za-z_][A-Za-z0-9_]*)"/g;
const DEFAULT_RE = /\s*\bDEFAULT\s+(?:\((?:[^()]|\([^()]*\))*\)|'(?:[^']|'')*'|[^\s,]+)/;

/** Split a CREATE TABLE body on the commas that are not inside parentheses. */
export function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of body) {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim() !== '') parts.push(cur);
  return parts;
}

function unquote(sql: string): string {
  return sql.replace(IDENT_RE, '$1');
}

function tighten(sql: string): string {
  return sql.replace(/\s*([(),])\s*/g, '$1');
}

export function canonTable(sql: string): string {
  const s = unquote(sql).replace(/\s+/g, ' ').trim();
  const open = s.indexOf('(');
  const close = s.lastIndexOf(')');
  const head = s.slice(0, open);
  const body = s.slice(open + 1, close);
  const parts = splitTopLevel(body)
    .map((p) => tighten(p.replace(DEFAULT_RE, '')).trim())
    .sort();
  return `${head}(${parts.join('|')})`;
}

export function canonTrigger(sql: string): string {
  return tighten(unquote(sql).replace(/\s+/g, ' ').trim());
}

export function planeShape(db: Database.Database): PlaneShape {
  const names = (type: string, filter = ''): string[] =>
    (
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%'${filter}`)
        .all(type) as { name: string }[]
    ).map((r) => r.name);

  const tables = new Set(names('table'));
  const indexes = new Set(names('index'));
  const triggers = new Set(names('trigger'));

  const cols = new Map<string, Set<string>>();
  const tableSql = new Map<string, string>();
  for (const t of tables) {
    const info = db.prepare(`PRAGMA table_info('${t}')`).all() as { name: string; type: string; notnull: number }[];
    cols.set(t, new Set(info.map((c) => `${c.name}|${c.type.toUpperCase()}|${c.notnull}`)));
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(t) as
      | { sql: string }
      | undefined;
    tableSql.set(t, canonTable(row?.sql ?? ''));
  }

  const triggerSql = new Map<string, string>();
  for (const t of triggers) {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(t) as
      | { sql: string }
      | undefined;
    triggerSql.set(t, canonTrigger(row?.sql ?? ''));
  }

  return { tables, indexes, triggers, cols, tableSql, triggerSql };
}

function diff(a: Set<string>, b: Set<string>): string {
  return `chain-only=[${[...a].filter((x) => !b.has(x)).sort()}] fresh-only=[${[...b].filter((x) => !a.has(x)).sort()}]`;
}

/**
 * Assert the migrated file and the shipped DDL are the same schema. Throws naming
 * the differing object, which is what a red run has to report.
 */
export function comparePlanes(migrated: Database.Database, fresh: Database.Database, label: string): void {
  const a = planeShape(migrated);
  const b = planeShape(fresh);
  if (diff(a.tables, b.tables) !== 'chain-only=[] fresh-only=[]') {
    throw new Error(`${label}: table drift ${diff(a.tables, b.tables)}`);
  }
  if (diff(a.indexes, b.indexes) !== 'chain-only=[] fresh-only=[]') {
    throw new Error(`${label}: index drift ${diff(a.indexes, b.indexes)}`);
  }
  if (diff(a.triggers, b.triggers) !== 'chain-only=[] fresh-only=[]') {
    throw new Error(`${label}: trigger drift ${diff(a.triggers, b.triggers)}`);
  }
  for (const t of a.tables) {
    const ca = a.cols.get(t) ?? new Set<string>();
    const cb = b.cols.get(t) ?? new Set<string>();
    const drift = [...ca].filter((x) => !cb.has(x)).concat([...cb].filter((x) => !ca.has(x)));
    if (drift.length > 0) throw new Error(`${label}: column drift in ${t}: ${drift.join(', ')}`);
  }
  for (const t of a.tables) {
    if (a.tableSql.get(t) !== b.tableSql.get(t)) {
      throw new Error(`${label}: table text drift (CHECK constraints live here): ${t}`);
    }
  }
  for (const t of a.triggers) {
    if (a.triggerSql.get(t) !== b.triggerSql.get(t)) {
      throw new Error(`${label}: trigger body drift: ${t}`);
    }
  }
}
