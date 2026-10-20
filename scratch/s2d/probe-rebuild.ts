import Database from 'better-sqlite3';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { context, runDdl } from '../../app/ddl/run.ts';
import { emit, type DdlOp } from '../../app/ddl/ops.ts';

const path = '/tmp/skw-rebuild.db';
mkdirSync(dirname(path), { recursive: true });
for (const s of ['', '-wal', '-shm']) rmSync(path + s, { force: true });
const db = new Database(path);
db.pragma('journal_mode = WAL');
db.exec(readFileSync(join('schema', 'site.sql'), 'utf8'));
db.close();

runDdl(path, [
  { op: 'create_table', name: 'u_post', columns: [{ name: 'title', type: 'TEXT' }, { name: 'slug', type: 'TEXT' }] },
  { op: 'create_index', table: 'u_post', name: 'ix_post_slug', columns: ['slug'], unique: true },
] as DdlOp[], { actor: { userId: 1, label: 'x' } });

const conn = new Database(path);
const plans = emit({ op: 'drop_column', table: 'u_post', column: 'slug', rebuild: true }, context(conn, 8));
for (const s of plans.statements) console.log('---\n' + s);
console.log('=== executing in a transaction with fk off');
conn.pragma('foreign_keys = 0');
conn.exec('BEGIN IMMEDIATE');
for (const s of plans.statements) {
  try { conn.exec(s); console.log('OK   ', s.split('\n')[0]!.slice(0, 80)); }
  catch (e) { console.log('FAIL ', s.split('\n')[0]!.slice(0, 80), '->', (e as Error).message); break; }
}
conn.exec('ROLLBACK');
conn.close();
