import Database from '/Volumes/Backup/Development/skunkworks/node_modules/better-sqlite3/lib/index.js';
import { readFileSync } from 'node:fs';

const NOW = '/Volumes/Backup/Development/skunkworks/schema/control.sql';
const BEFORE = '/tmp/control.head.sql';

const LOGIN = `SELECT id, tenant_id, email, password_hash, role, totp_secret, failed_logins, locked_until
                 FROM user_account WHERE email = ?`;
const DOMAINS = `SELECT host, kind, is_primary, cert_state FROM domain
                  WHERE tenant_id = (SELECT id FROM tenant WHERE key = ?)
                  ORDER BY is_primary DESC, host`;

function build(path) {
  const db = new Database(':memory:');
  db.exec(readFileSync(path, 'utf8'));
  return db;
}

function plan(db, sql, arg) {
  return db.prepare('EXPLAIN QUERY PLAN ' + sql).all(arg).map((r) => r.detail).join(' | ');
}

function seed(db) {
  db.pragma('journal_mode = MEMORY');
  const tx = db.transaction(() => {
    const t = db.prepare("INSERT INTO tenant (key, mode, status, display_name) VALUES (?, 'production', 'active', ?)");
    const d = db.prepare('INSERT INTO domain (host, tenant_id, kind, is_primary) VALUES (?, ?, ?, ?)');
    const u = db.prepare(
      "INSERT INTO user_account (tenant_id, email, password_hash, role) VALUES (?, ?, '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$hash', 'owner')",
    );
    for (let i = 0; i < 2000; i += 1) {
      const id = Number(t.run(`tenant-${i}`, `Tenant ${i}`).lastInsertRowid);
      for (let j = 0; j < 4; j += 1) d.run(`t${i}-${j}.test`, id, j === 0 ? 'primary' : 'alias', j === 0 ? 1 : 0);
      for (let j = 0; j < 10; j += 1) u.run(id, `user${i}-${j}@tenant.test`);
    }
  });
  tx();
}

function timeLookups(db, sql, makeArg, n) {
  const stmt = db.prepare(sql);
  // Warm the statement cache and the page cache before measuring.
  for (let i = 0; i < 50; i += 1) stmt.all(makeArg(i));
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < n; i += 1) stmt.all(makeArg(i));
  const t1 = process.hrtime.bigint();
  return Number(t1 - t0) / 1e6 / n;
}

const rows = 2000 * 10;
for (const [label, path] of [['before (HEAD)', BEFORE], ['after (working copy)', NOW]]) {
  const db = build(path);
  seed(db);
  const loginMs = timeLookups(db, LOGIN, (i) => `user${i % 2000}-0@tenant.test`, 200);
  const domainMs = timeLookups(db, DOMAINS, (i) => `tenant-${i % 2000}`, 1000);
  console.log(`=== ${label}`);
  console.log(`user_account rows: ${rows}, domain rows: 8000, tenant rows: 2000`);
  console.log(`users  index_set: ${db.prepare("PRAGMA index_list('user_account')").all().map((r) => r.name).join(', ')}`);
  console.log(`domain index_set: ${db.prepare("PRAGMA index_list('domain')").all().map((r) => r.name).join(', ')}`);
  console.log(`login      plan: ${plan(db, LOGIN, 'user0-0@tenant.test')}`);
  console.log(`login      time: ${loginMs.toFixed(4)} ms/lookup (200 lookups)`);
  console.log(`domain     plan: ${plan(db, DOMAINS, 'tenant-0')}`);
  console.log(`domain     time: ${domainMs.toFixed(4)} ms/listing (1000 listings)`);
  console.log('');
  db.close();
}
console.log('node:', process.version, 'sqlite:', build(BEFORE).prepare('select sqlite_version() v').get().v);
