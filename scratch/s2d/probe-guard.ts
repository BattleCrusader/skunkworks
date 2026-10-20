import Database from 'better-sqlite3';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { runDdl } from '../../app/ddl/run.ts';
import type { DdlOp } from '../../app/ddl/ops.ts';

const path = '/tmp/skw-guard.db';
mkdirSync(dirname(path), { recursive: true });
for (const s of ['', '-wal', '-shm']) rmSync(path + s, { force: true });
const db0 = new Database(path); db0.pragma('journal_mode = WAL'); db0.exec(readFileSync('schema/site.sql', 'utf8')); db0.close();

runDdl(path, [{ op: 'create_table', name: 'u_post', columns: [{ name: 'title', type: 'TEXT' }, { name: 'cover', type: 'ASSET' }] }] as DdlOp[], { actor: { userId: 1, label: 'x' } });
try {
  const r = runDdl(path, [{ op: 'drop_column', table: 'u_post', column: 'cover', rebuild: true }] as DdlOp[], { actor: { userId: 1, label: 'x' } });
  console.log('OK', r.statements, 'statements');
} catch (e) {
  console.log('ERR', (e as { code?: string }).code, (e as Error).message, JSON.stringify((e as { detail?: unknown }).detail));
}
const db = new Database(path);
console.log('triggers:', (db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE '%u_post%'").all() as { name: string }[]).map((r) => r.name));
console.log('columns:', (db.prepare('PRAGMA table_info("u_post")').all() as { name: string }[]).map((c) => c.name));
db.close();
