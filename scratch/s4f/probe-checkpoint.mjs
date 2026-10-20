// Does `wal_checkpoint(TRUNCATE)` report busy while another connection is idle, and does the
// retry loop clear it? Same engine (better-sqlite3), same file, two connections.
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'skw-ckpt-'));
const file = join(dir, 'site.db');
const a = new Database(file);
a.pragma('journal_mode = WAL');
a.exec(readFileSync('schema/site.sql', 'utf8'));
a.prepare("INSERT INTO cms_page (path, slug, title, status, template, body_html, published_at) VALUES ('/p','p','P','published','page','<p>x</p>','2026-01-01T00:00:00.000Z')").run();

// The other process: opened before the change, idle, never closed.
const b = new Database(file);
b.prepare('SELECT COUNT(*) AS n FROM cms_page').get();

const rows = () => a.pragma('wal_checkpoint(TRUNCATE)');
console.log('before any write :', JSON.stringify(rows()));

a.exec('BEGIN IMMEDIATE');
a.exec('DROP TABLE IF EXISTS cms_redirect');
a.exec('COMMIT');

const first = rows();
console.log('after the drop   :', JSON.stringify(first));
let attempt = 0;
let last = first;
while (last[0]?.busy !== 0 && attempt < 25) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  last = rows();
  attempt += 1;
}
console.log(`cleared after    : ${attempt} pause(s) -> ${JSON.stringify(last)}`);

// What the second connection sees after the checkpoint.
console.log('other sees table :', JSON.stringify(b.prepare("SELECT name FROM sqlite_master WHERE name='cms_redirect'").get() ?? null));
b.close();
a.close();
rmSync(dir, { recursive: true, force: true });
