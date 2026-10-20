import Database from 'better-sqlite3';
import { readFileSync, rmSync } from 'node:fs';
import { createRow } from '../../app/admin/crud.ts';
import { runDdl } from '../../app/ddl/run.ts';

const path = '/tmp/skw-wr.db';
for (const s of ['', '-wal', '-shm']) rmSync(path + s, { force: true });
const db0 = new Database(path);
db0.pragma('journal_mode = WAL');
db0.exec(readFileSync('schema/site.sql', 'utf8'));
db0.close();
runDdl(path, [{ op: 'create_table', name: 'u_post', columns: [{ name: 'title', type: 'TEXT' }, { name: 'slug', type: 'TEXT' }, { name: 'body_html', type: 'TEXT' }] }] as never, { actor: { userId: 1, label: 'x' } });
const db = new Database(path);
try {
  const write = db.transaction(() => {
    createRow(db, 'u_post', { slug: 's', title: 't', body_html: '<p>x</p>' }, { userId: 2, label: 'w' });
  });
  write();
  console.log('ok', db.prepare('select count(*) n from u_post').get());
} catch (e) {
  console.log('ERR', (e as Error).message, (e as { code?: string }).code);
  console.log((e as Error).stack?.split('\n').slice(0, 8).join('\n'));
}
