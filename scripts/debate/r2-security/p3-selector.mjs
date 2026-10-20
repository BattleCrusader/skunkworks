// M3 — is a deterministic keyed lookup column necessary? selector/verifier vs HMAC(pepper, code).
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
const req = createRequire(process.env.SK_R2_REQUIRE || 'package.json');
const Database = req('better-sqlite3');
const P = (process.env.SK_R2_BASE || '/tmp/sk-r2sec') + '/sel.db';
fs.rmSync(P, { force: true });
const A = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32, no I L O U
const rnd = (n) => Array.from({ length: n }, () => A[crypto.randomInt(32)]).join('');

const db = new Database(P);
db.pragma('journal_mode = WAL');
db.exec(`CREATE TABLE cms_download_code(
  id INTEGER PRIMARY KEY,
  code_selector TEXT NOT NULL UNIQUE,
  code_hash TEXT NOT NULL,
  issued_to_email TEXT, uses INT NOT NULL DEFAULT 0, max_uses INT);
CREATE INDEX ix_code_selector ON cms_download_code(code_selector);`);

let collisions = 0, issued = 0;
const seen = new Set();
const selStmt = db.prepare('SELECT 1 FROM cms_download_code WHERE code_selector = ?');
for (let i = 0; i < 5000; i++) {
  let sel, tries = 0;
  do { sel = rnd(4); tries++; if (tries > 1) collisions++; } while (seen.has(sel));
  seen.add(sel);
  db.prepare('INSERT INTO cms_download_code(code_selector, code_hash, issued_to_email, max_uses) VALUES(?,?,?,3)')
    .run(sel, `$argon2id$placeholder$${rnd(16)}`, `buyer${i}@example.com`);
  issued++;
}
console.log(`codes issued                     : ${issued}`);
console.log(`4-char selector space            : 32^4 = ${32 ** 4} (20 bits); collisions + retries: ${collisions}`);
console.log(`total code length                : 16 chars = ${16 * 5} bits; secret part 12 chars = ${12 * 5} bits`);

const look = db.prepare('SELECT id, code_hash FROM cms_download_code WHERE code_selector = ?');
const some = [...seen][2500];
let t0 = process.hrtime.bigint();
for (let i = 0; i < 10000; i++) look.get(some);
console.log(`selector lookup over 5,000 rows  : ${(Number(process.hrtime.bigint() - t0) / 1e6 / 10000 * 1000).toFixed(2)} us/query (n=10000)`);
console.log(`EXPLAIN                          : ${JSON.stringify(db.prepare('EXPLAIN QUERY PLAN SELECT id FROM cms_download_code WHERE code_selector = ?').all(some))}`);
db.close();

// keyed-lookup alternative costed: HMAC-SHA256 throughput
const key = crypto.randomBytes(32);
const msg = Buffer.from('7K2M9Q4XB3TVH8WD');
t0 = process.hrtime.bigint();
const N = 200000;
for (let i = 0; i < N; i++) crypto.createHmac('sha256', key).update(msg).digest();
const macPerSec = N / (Number(process.hrtime.bigint() - t0) / 1e9);
console.log(`HMAC-SHA256 (new object)         : ${Math.round(macPerSec).toLocaleString()}/s -> 2^60 = ${(2 ** 60 / macPerSec / 86400 / 365).toExponential(2)} core-years`);

// offline attack on the argon2 verifier at the measured 12.2 ms / 94.4 ms per verify
for (const [label, ms] of [['m=19456,t=2', 12.2], ['m=65536,t=3', 94.4]]) {
  console.log(`offline 2^60 argon2 @ ${label}      : ${(2 ** 60 * ms / 1000 / 86400 / 365).toExponential(2)} core-years`);
}
