// M1 — what a readonly handle can still do; what query_only does; whether ROLLBACK undoes ATTACH.
import { createRequire } from 'node:module';
import fs from 'node:fs';
const req = createRequire(process.env.SK_R2_REQUIRE || 'package.json');
const Database = req('better-sqlite3');
const R = (process.env.SK_R2_BASE || '/tmp/sk-r2sec') + '/ro';
const out = (...a) => console.log(...a);
const throws = (fn) => { try { fn(); return null; } catch (e) { return `${e.code ?? ''} ${e.message}`.trim(); } };

fs.rmSync(R, { recursive: true, force: true });
for (const d of ['app/data', 'app/tenants/acme', 'app/tenants/beta']) fs.mkdirSync(`${R}/${d}`, { recursive: true });

let db = new Database(`${R}/app/data/control.db`);
db.exec("CREATE TABLE sessions(id TEXT PRIMARY KEY, tenant TEXT); INSERT INTO sessions VALUES('s0','beta')");
db.close();
db = new Database(`${R}/app/tenants/acme/site.db`);
db.exec("CREATE TABLE cms_pages(id INTEGER PRIMARY KEY, body TEXT); CREATE TABLE cms_asset(key TEXT PRIMARY KEY);");
for (let i = 0; i < 10; i++) db.prepare('INSERT INTO cms_pages VALUES(?,?)').run(i, 'acme-body');
db.close();
db = new Database(`${R}/app/tenants/beta/site.db`);
db.exec("CREATE TABLE cms_download_code(id INTEGER PRIMARY KEY, code_hash TEXT, issued_to_email TEXT);");
db.exec("INSERT INTO cms_download_code VALUES(1,'argon2id$abc','buyer@beta.example')");
db.close();

process.chdir(`${R}/app`);
out('=== A. readonly handle (render path) ===');
const ro = new Database('tenants/acme/site.db', { readonly: true });
out('  ATTACH beta site.db     :', throws(() => ro.exec("ATTACH DATABASE 'tenants/beta/site.db' AS v")) ?? 'OK attached');
out('  read v.cms_download_code:', JSON.stringify(ro.prepare('SELECT issued_to_email FROM v.cms_download_code').all()));
out('  ATTACH data/control.db  :', throws(() => ro.exec("ATTACH DATABASE 'data/control.db' AS ctl")) ?? 'OK attached');
out('  read ctl.sessions       :', JSON.stringify(ro.prepare('SELECT * FROM ctl.sessions').all()));
out('  INSERT ctl.sessions     :', throws(() => ro.prepare("INSERT INTO ctl.sessions VALUES('s1','acme')").run()) ?? 'WROTE');
const vPath = 'tenants/beta/planted.db';
out('  VACUUM INTO other tnt  :', throws(() => ro.exec(`VACUUM INTO '${vPath}'`)) ?? `OK wrote ${vPath} (${fs.existsSync(vPath) ? fs.statSync(vPath).size + ' B' : 'missing'})`);
fs.mkdirSync('content/public', { recursive: true });
out('  VACUUM INTO public tree :', throws(() => ro.exec(`VACUUM INTO 'content/public/backup.db'`)) ?? `OK wrote content/public/backup.db (${fs.existsSync('content/public/backup.db') ? fs.statSync('content/public/backup.db').size + ' B' : 'missing'})`);
out('  CREATE TEMP TABLE       :', throws(() => ro.exec('CREATE TEMP TABLE t(x)')) ?? 'OK');
out('  CREATE TEMP TRIGGER     :', throws(() => ro.exec("CREATE TEMP TRIGGER tr AFTER INSERT ON cms_pages BEGIN INSERT INTO t VALUES(1); END")) ?? 'OK');
out('  write main table        :', throws(() => ro.prepare("INSERT INTO cms_pages VALUES(99,'x')").run()) ?? 'WROTE');
ro.close();

out('\n=== B. PRAGMA query_only=1 on a read-write handle (the proposed substitute) ===');
const qo = new Database('tenants/acme/site.db');
qo.pragma('query_only = 1');
out('  INSERT main             :', throws(() => qo.prepare("INSERT INTO cms_pages VALUES(100,'x')").run()) ?? 'WROTE');
out('  ATTACH data/control.db  :', throws(() => qo.exec("ATTACH DATABASE 'data/control.db' AS ctl2")) ?? 'OK attached');
out('  read ctl2.sessions      :', JSON.stringify(throws(() => qo.prepare('SELECT count(*) n FROM ctl2.sessions').get()) ?? 'read ok'));
const qPath = 'tenants/beta/planted2.db';
out('  VACUUM INTO other tnt  :', throws(() => qo.exec(`VACUUM INTO '${qPath}'`)) ?? `OK wrote ${qPath} (${fs.existsSync(qPath) ? fs.statSync(qPath).size + ' B' : 'missing'})`);
let dbs = qo.prepare('SELECT name FROM pragma_database_list').all().map((r) => r.name);
out('  database_list now       :', JSON.stringify(dbs));
qo.close();

out('\n=== C. ROLLBACK does not undo ATTACH; the in-transaction postcondition does catch it ===');
const c = new Database('tenants/acme/site.db');
c.pragma('busy_timeout = 2000');
c.exec('BEGIN IMMEDIATE');
c.exec("ATTACH DATABASE 'tenants/beta/site.db' AS v2");
const post = c.prepare('SELECT count(*) n FROM pragma_database_list').get().n;
out('  postcondition inside txn:', `count(pragma_database_list)=${post} (must be 1) -> ${post === 1 ? 'PASS' : 'REJECT'}`);
out('  reads attacker rows     :', JSON.stringify(c.prepare('SELECT issued_to_email FROM v2.cms_download_code').all()));
c.exec('ROLLBACK');
dbs = c.prepare('SELECT name FROM pragma_database_list').all().map((r) => r.name);
out('  database_list after ROLLBACK:', JSON.stringify(dbs), '<- ATTACH survived the rollback');
out('  same handle reads again :', JSON.stringify(c.prepare('SELECT issued_to_email FROM v2.cms_download_code').all()));
out('  DETACH                  :', throws(() => c.exec('DETACH DATABASE v2')) ?? 'detached');
out('  after DETACH            :', throws(() => c.prepare('SELECT 1 FROM v2.cms_download_code').get()) ?? 'still reachable');
c.close();

out('\n=== D. a TEMP TRIGGER outlives the request that created it (pooled connection) ===');
const t = new Database('tenants/acme/site.db');
t.pragma('busy_timeout = 2000');
t.exec('CREATE TEMP TABLE sink(x)');
t.exec("CREATE TEMP TRIGGER tr2 AFTER INSERT ON cms_pages BEGIN INSERT INTO sink VALUES(NEW.id); END");
t.prepare("INSERT INTO cms_pages VALUES(101,'req-1')").run();
out('  request 2 insert fires trigger left by request 1:', JSON.stringify(t.prepare('SELECT * FROM sink').all()));
t.close();

out('\n=== E. readonly + PRAGMA query_only=1 on the RENDER handle (the proposed control set) ===');
const rq = new Database('tenants/acme/site.db', { readonly: true });
rq.pragma('query_only = 1');
out('  SELECT (must still work) :', JSON.stringify(rq.prepare('SELECT count(*) n FROM cms_pages').get()));
out('  ATTACH beta site.db      :', throws(() => rq.exec("ATTACH DATABASE 'tenants/beta/site.db' AS rv")) ?? 'OK attached');
out('  CREATE TEMP TABLE        :', throws(() => rq.exec('CREATE TEMP TABLE t2(x)')) ?? 'OK');
out('  CREATE TEMP TRIGGER      :', throws(() => rq.exec("CREATE TEMP TRIGGER tr3 AFTER INSERT ON cms_pages BEGIN SELECT 1; END")) ?? 'OK');
const ePath = 'content/public/backup2.db';
out('  VACUUM INTO public tree  :', throws(() => rq.exec(`VACUUM INTO '${ePath}'`)) ?? `OK wrote ${ePath}`);
out('  INSERT main              :', throws(() => rq.prepare("INSERT INTO cms_pages VALUES(102,'x')").run()) ?? 'WROTE');
rq.close();

out('\nfiles now inside tenants/beta:', JSON.stringify(fs.readdirSync('tenants/beta')));
