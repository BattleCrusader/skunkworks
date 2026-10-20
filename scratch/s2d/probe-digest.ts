import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { runDdl } from '../../app/ddl/run.ts';
import type { DdlOp } from '../../app/ddl/ops.ts';

const path = '/tmp/skw-digest.db';
mkdirSync(dirname(path), { recursive: true });
for (const s of ['', '-wal', '-shm']) rmSync(path + s, { force: true });
const db0 = new Database(path);
db0.pragma('journal_mode = WAL');
db0.exec(readFileSync('schema/site.sql', 'utf8'));
db0.close();

function digest(): string {
  const db = new Database(path);
  try {
    const objects = db.prepare("SELECT type, name, tbl_name, COALESCE(sql,'') AS sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
    const registry = db.prepare('SELECT table_name, column_count, index_count, columns_json FROM cms_table_registry ORDER BY table_name').all();
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]);
    const rows = tables.map((t) => [t.name, (db.prepare(`SELECT count(*) AS n FROM "${t.name}"`).get() as { n: number }).n]);
    return createHash('sha256').update(JSON.stringify({ objects, registry, rows })).digest('hex');
  } finally { db.close(); }
}

const before = digest();
const ops: DdlOp[] = [
  { op: 'create_table', name: 'u_alpha', columns: [{ name: 'title', type: 'TEXT' }] },
  { op: 'create_index', table: 'u_alpha', name: 'ix_alpha_title', columns: ['title'], unique: false },
  { op: 'create_table', name: 'u_alpha', columns: [{ name: 'other', type: 'TEXT' }] },
];
let error = '';
try { runDdl(path, ops, { actor: { userId: 1, label: 'x' } }); } catch (e) { error = `${(e as { code?: string }).code}: ${(e as Error).message}`; }
const after = digest();
const db = new Database(path);
const uTables = (db.prepare("SELECT name FROM sqlite_master WHERE substr(name,1,2)='u_'").all() as { name: string }[]).length;
const reg = (db.prepare('SELECT count(*) AS n FROM cms_table_registry').get() as { n: number }).n;
const aud = (db.prepare('SELECT count(*) AS n FROM cms_audit').get() as { n: number }).n;
db.close();
console.log('before  ', before);
console.log('error   ', error);
console.log('after   ', after);
console.log('identical', before === after);
console.log('u_ tables', uTables, 'registry rows', reg, 'audit rows', aud);
