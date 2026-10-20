import Database from 'better-sqlite3';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runDdl, context } from '../../app/ddl/run.ts';
import { emit } from '../../app/ddl/ops.ts';
import { AppError } from '../../app/errors.ts';

const path = '/tmp/skw-c2-probe.db';
mkdirSync(dirname(path), { recursive: true });
for (const s of ['', '-wal', '-shm']) { try { require('node:fs').rmSync(path + s); } catch {} }
const db = new Database(path);
db.pragma('journal_mode = WAL');
db.exec(readFileSync(join('schema', 'site.sql'), 'utf8'));
db.close();

const ops = [
  { op: 'create_table', name: 'u_alpha', columns: [{ name: 'title', type: 'TEXT' }] },
  { op: 'create_index', table: 'u_alpha', name: 'ix_alpha_title', columns: ['title'], unique: false },
  { op: 'create_table', name: 'u_alpha', columns: [{ name: 'other', type: 'TEXT' }] },
] as never;
try {
  runDdl(path, ops, { actor: { userId: 1, label: 'x' } });
  console.log('unexpected success');
} catch (e) {
  console.log('code', (e as AppError).code, 'status', (e as AppError).status, 'msg', (e as Error).message, 'detail', JSON.stringify((e as AppError).detail));
}
