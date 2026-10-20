/**
 * The table builder's form grammar (§9.4), parsed into §4.4's `ColumnSpec`.
 *
 * One column per line:
 *
 *   full_name TEXT NOT NULL
 *   age       INTEGER
 *   active    BOOLEAN NOT NULL DEFAULT true
 *   photo     ASSET
 *   team      RELATION=u_teams
 *   born_on   DATE
 *
 * The grammar exists so the form is usable without JSON; it is not a second DDL
 * language. It produces the same `ColumnSpec` the AST carries, and every refusal
 * §4.4 names is raised by `emit.ts`, not here — this module only rejects a line it
 * cannot read, and says which line.
 */
import { AppError } from '../errors.ts';
import type { ColumnSpec, ColumnType } from './emit.ts';

const TYPES: readonly ColumnType[] = ['TEXT', 'INTEGER', 'REAL', 'BLOB', 'NUMERIC', 'BOOLEAN', 'DATE', 'ASSET', 'PAGE', 'RELATION'];

const TOKENS = /(?:[^\s']+|'[^']*')+/g;

/** `people` and `u_people` are the same table; the AST only ever sees `u_people`. */
export function normaliseTableName(raw: string | undefined): string {
  const name = (raw ?? '').trim();
  if (name === '') throw new AppError('SKW_E_PLT_REQUEST_INVALID', 'the table needs a name');
  if (name.startsWith('u_')) return name;
  // A `cms_*`/`p_*` name is refused by `emitCreateTable` with §4.4's reason, not
  // quietly renamed into a `u_` table the operator did not ask for.
  if (/^(cms_|p_)/.test(name)) return name;
  if (/^[a-z0-9_]+$/.test(name)) return `u_${name}`;
  return name;
}

export function parseColumnLines(text: string | undefined): ColumnSpec[] {
  if (text === undefined || text.trim() === '') {
    throw new AppError('SKW_E_PLT_REQUEST_INVALID', 'at least one column is required');
  }
  const columns: ColumnSpec[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = (lines[i] as string).trim();
    if (line === '' || line.startsWith('#')) continue;
    columns.push(parseLine(line, i + 1));
  }
  if (columns.length === 0) throw new AppError('SKW_E_PLT_REQUEST_INVALID', 'at least one column is required');
  return columns;
}

function parseLine(line: string, lineNumber: number): ColumnSpec {
  const tokens = line.match(TOKENS) ?? [];
  const bad = (why: string): AppError => new AppError('SKW_E_PLT_REQUEST_INVALID', `line ${lineNumber}: ${why}`);
  if (tokens.length < 2) throw bad('expected <name> <TYPE>');
  const name = tokens[0] as string;
  const type = (tokens[1] as string).toUpperCase() as ColumnType;
  if (!TYPES.includes(type)) throw bad(`${tokens[1]} is not one of ${TYPES.join(', ')}`);

  const column: ColumnSpec = { name, type };
  for (let i = 2; i < tokens.length; i += 1) {
    const token = tokens[i] as string;
    const upper = token.toUpperCase();
    if (upper === 'NOT' && (tokens[i + 1] ?? '').toUpperCase() === 'NULL') {
      column.notNull = true;
      i += 1;
      continue;
    }
    if (upper === 'NULL') {
      column.notNull = false;
      continue;
    }
    if (upper === 'DEFAULT') {
      const literal = tokens[i + 1];
      if (literal === undefined) throw bad('DEFAULT needs a literal');
      column.default = literalOf(literal);
      i += 1;
      continue;
    }
    if (upper.startsWith('RELATION=')) {
      column.relation = token.slice('RELATION='.length);
      continue;
    }
    if (upper === 'RELATION') {
      const target = tokens[i + 1];
      if (target === undefined) throw bad('RELATION needs a u_<table> target');
      column.relation = target;
      i += 1;
      continue;
    }
    throw bad(`unexpected ${JSON.stringify(token)}`);
  }
  return column;
}

function literalOf(token: string): string | number | boolean {
  if (token === 'true') return true;
  if (token === 'false') return false;
  if (token === 'null') return ''; // a DEFAULT NULL is the absence of a default
  if (/^-?\d+(\.\d+)?$/.test(token)) return Number(token);
  if (token.startsWith("'") && token.endsWith("'")) return token.slice(1, -1).replace(/''/g, "'");
  return token;
}
