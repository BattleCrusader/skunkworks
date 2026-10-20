// M5 child — the minimum a per-tenant process must do: open its own site.db, answer one query, idle.
import { createRequire } from 'node:module';
const req = createRequire(process.env.SK_R2_REQUIRE || 'package.json');
const Database = req('better-sqlite3');
const db = new Database((process.env.SK_R2_BASE || '/tmp/sk-r2sec') + '/ro/app/tenants/acme/site.db', { readonly: true });
db.prepare('SELECT count(*) n FROM cms_pages').get();
console.log('READY');
setTimeout(() => { db.close(); process.exit(0); }, 400);
