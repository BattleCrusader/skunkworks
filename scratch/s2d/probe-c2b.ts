import Database from 'better-sqlite3';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { context } from '../../app/ddl/run.ts';
import { emit } from '../../app/ddl/ops.ts';
import type { DdlOp } from '../../app/ddl/ops.ts';

const path = '/tmp/skw-c2b.db';
mkdirSync(dirname(path), { recursive: true });
for (const s of ['', '-wal', '-shm']) rmSync(path + s, { force: true });
const db = new Database(path);
db.pragma('journal_mode = WAL');
db.exec(readFileSync(join('schema', 'site.sql'), 'utf8'));

const ops: DdlOp[] = [
  { op: 'create_table', name: 'u_alpha', columns: [{ name: 'title', type: 'TEXT' }] },
  { op: 'create_index', table: 'u_alpha', name: 'ix_alpha_title', columns: ['title'], unique: false },
];
db.exec('BEGIN IMMEDIATE');
for (const op of ops) {
  const plan = emit(op, context(db, 8));
  console.log('--- plan', op.op, plan.statements.length);
  for (const s of plan.statements) {
    try { db.exec(s); console.log('OK  ', s.slice(0, 90).replace(/\n/g, ' ')); }
    catch (e) { console.log('FAIL', s.slice(0, 200).replace(/\n/g, ' '), '\n   ->', (e as Error).message); }
  }
}
db.exec('ROLLBACK');
db.close();
