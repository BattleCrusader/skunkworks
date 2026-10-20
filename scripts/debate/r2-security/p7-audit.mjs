// M7 — is a tenant-plane audit table evidence? hash chain + a daily seal in control.db.
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
const req = createRequire(process.env.SK_R2_REQUIRE || 'package.json');
const Database = req('better-sqlite3');
const D = (process.env.SK_R2_BASE || '/tmp/sk-r2sec');
const canon = (o) => JSON.stringify(o, Object.keys(o).sort());
const h = (prev, row) => crypto.createHash('sha256').update(prev + canon(row)).digest('hex');

function build(tag) {
  const p = `${D}/audit-${tag}.db`;
  fs.rmSync(p, { force: true });
  const db = new Database(p);
  db.exec(`CREATE TABLE cms_audit(id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL,
    actor TEXT NOT NULL, prev_hash TEXT NOT NULL, hash TEXT NOT NULL);`);
  const ins = db.prepare('INSERT INTO cms_audit(action, actor, prev_hash, hash) VALUES(?,?,?,?)');
  let prev = '0'.repeat(64);
  const t0 = process.hrtime.bigint();
  db.transaction((n) => {
    for (let i = 0; i < n; i++) {
      const row = { action: 'page.update', actor: `user${i % 7}` };
      const hash = h(prev, { ...row, id: i + 1 });
      ins.run(row.action, row.actor, prev, hash);
      prev = hash;
    }
  })(10000);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { db, head: prev, ms };
}
const verify = (db) => {
  let p = '0'.repeat(64), mismatch = null, n = 0;
  for (const r of db.prepare('SELECT id, action, actor, prev_hash, hash FROM cms_audit ORDER BY id').iterate()) {
    n++;
    if (r.prev_hash !== p && !mismatch) mismatch = { id: r.id, why: 'prev_hash' };
    if (h(p, { action: r.action, actor: r.actor, id: r.id }) !== r.hash && !mismatch) mismatch = { id: r.id, why: 'hash' };
    p = r.hash;
  }
  return { n, head: p, mismatch };
};

let { db, head, ms } = build('a');
console.log(`append 10,000 audit rows (chain+txn): ${ms.toFixed(0)} ms`);
let t0 = process.hrtime.bigint();
let v = verify(db);
console.log(`verify the chain                    : ${(Number(process.hrtime.bigint() - t0) / 1e6).toFixed(0)} ms, rows=${v.n}, mismatch=${JSON.stringify(v.mismatch)}`);
console.log(`head hash                            : ${head.slice(0, 24)}…`);
const SEAL = { tenant: 'acme', day: '2026-10-20', rows: v.n, head };
fs.rmSync(`${D}/audit-control.db`, { force: true });
const ctl = new Database(`${D}/audit-control.db`);
ctl.exec('CREATE TABLE audit_seal(tenant TEXT, day TEXT, rows INT, head TEXT, PRIMARY KEY(tenant, day));');
t0 = process.hrtime.bigint();
ctl.prepare('INSERT INTO audit_seal VALUES(?,?,?,?)').run(SEAL.tenant, SEAL.day, SEAL.rows, SEAL.head);
console.log(`daily seal write                     : ${(Number(process.hrtime.bigint() - t0) / 1e3).toFixed(0)} us (one row per tenant per day)`);

// attack 1: edit one row in place
db.prepare("UPDATE cms_audit SET action='page.delete' WHERE id=5000").run();
console.log(`A1 edit row 5000                    : ${JSON.stringify(verify(db).mismatch)} -> detected by the chain`);
db.close();

// attack 2: truncate the tail (the classic "delete my mistake")
({ db } = build('b'));
db.prepare('DELETE FROM cms_audit WHERE id > 9990').run();
v = verify(db);
console.log(`A2 delete the last 10 rows           : chain=${JSON.stringify(v.mismatch)}, rows=${v.n} vs seal.rows=${SEAL.rows} -> ${v.n === SEAL.rows && !v.mismatch ? 'UNDETECTED' : 'detected by the seal'}`);
db.close();

// attack 3: delete everything -> the chain is vacuously valid
({ db } = build('c'));
db.prepare('DELETE FROM cms_audit').run();
v = verify(db);
console.log(`A3 delete every row                  : chain valid=${v.mismatch === null} (vacuous), rows=${v.n} vs seal.rows=${SEAL.rows} -> ${v.n === SEAL.rows ? 'UNDETECTED' : 'detected by the seal'}`);
db.close();
ctl.close();
console.log(`seal storage                         : 365 rows/year/tenant x ~90 B = ${(365 * 90 / 1024).toFixed(1)} KB`);
