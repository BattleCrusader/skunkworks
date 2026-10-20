import Database from 'better-sqlite3';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { runDdl, context } from '../../app/ddl/run.ts';
import { emit, type DdlOp } from '../../app/ddl/ops.ts';

const path = '/tmp/skw-o7.db';
mkdirSync(dirname(path), { recursive: true });
for (const s of ['', '-wal', '-shm']) rmSync(path + s, { force: true });
const db0 = new Database(path); db0.pragma('journal_mode = WAL'); db0.exec(readFileSync('schema/site.sql', 'utf8')); db0.close();
runDdl(path, [{ op: 'create_table', name: 'u_post', columns: [{ name: 'title', type: 'TEXT' }, { name: 'cover', type: 'ASSET' }, { name: 'hero', type: 'ASSET' }] }] as DdlOp[], { actor: { userId: 1, label: 'x' } });
const db = new Database(path);
const facts = context(db, 8).table('u_post');
console.log('triggers seen:', facts.triggers.map((t) => ({ name: t.name, table: t.tableName, purpose: t.purpose })));
db.close();
const plan = emit({ op: 'drop_column', table: 'u_post', column: 'cover', rebuild: true } as DdlOp, context(new Database(path), 8));
for (const s of plan.statements) console.log('---\n' + s);
