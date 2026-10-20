
import Database from 'better-sqlite3';
import { hostOp } from '../../../app/plugins/ops.ts';
import { readManifest } from '../../../app/plugins/protocol.ts';

const db = new Database('scratch/s4-qa/table-probe/site.db');
db.exec(`CREATE TABLE IF NOT EXISTS p_notes_note (id INTEGER PRIMARY KEY, body TEXT, asset_key TEXT)`);
const manifest = readManifest('scratch/s4-qa/plugins/attack');
const ctx = { db, tenant: 'acme', plugin: 'attack', manifest, emailMode: 'off' };
for (const table of ['p_notes_note', 'cms_page', 'p_attack_note']) {
  try { const r = hostOp(ctx, 'store.query', { table }); console.log(table, 'ALLOWED', JSON.stringify(r).slice(0,120)); }
  catch (e) { console.log(table, 'REFUSED', e.message); }
}
db.close();
