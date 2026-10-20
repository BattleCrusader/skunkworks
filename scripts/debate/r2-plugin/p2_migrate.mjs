// R2.5 plugin probe 2 — migration lifecycle and what a "plugin handle" can actually reach.
//
//   A. ledger-based idempotence   B. `IF NOT EXISTS` hides drift   C. failure atomicity
//   D. checksum on an edited migration   E. a statement-class gate sound for DDL
//   F. no pragma can express "may write p_*, may not write cms_*"   G. the cost of E
//
// Run: SK_PROBE_DEPS=<dir with better-sqlite3> node scripts/debate/r2-plugin/p2_migrate.mjs
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEPS = process.env.SK_PROBE_DEPS ||
  path.join(os.homedir(), '.hermes/profiles/ceo/cache/scratch/probe/sql');
const require = createRequire(path.join(DEPS, 'package.json'));
const Database = require('better-sqlite3');

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
const WORK = process.env.SK_PLUGIN_WORK ||
  path.join(os.homedir(), '.hermes/profiles/ceo/cache/scratch/pluginprobe/work');
fs.mkdirSync(WORK, { recursive: true });
const sha = (s) => createHash('sha256').update(s).digest('hex');

function fresh(name, schema = true) {
  const p = path.join(WORK, name);
  for (const s of ['', '-wal', '-shm']) if (fs.existsSync(p + s)) fs.rmSync(p + s);
  const db = new Database(p);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  if (schema) db.exec(fs.readFileSync(path.join(ROOT, 'schema/site.sql'), 'utf8'));
  return db;
}

// ---------------------------------------------------------------- the gate (E)
function stripAndSplit(sql) {
  const out = [];
  let cur = '', i = 0;
  let sq = false, dq = false, bt = false, br = false;
  while (i < sql.length) {
    const c = sql[i], n = sql[i + 1];
    if (!sq && !dq && !bt && !br) {
      if (c === '-' && n === '-') { while (i < sql.length && sql[i] !== '\n') i++; continue; }
      if (c === '/' && n === '*') { i += 2; while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i++; i += 2; continue; }
      if (c === ';') { if (cur.trim()) out.push(cur.trim()); cur = ''; i++; continue; }
    }
    if (c === "'" && !dq && !bt && !br) sq = !sq;
    else if (c === '"' && !sq && !bt && !br) dq = !dq;
    else if (c === '`' && !sq && !dq && !br) bt = !bt;
    else if (c === '[' && !sq && !dq && !bt) br = true;
    else if (c === ']' && br) br = false;
    cur += c; i++;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const unquote = (s) => s.replace(/^["`[]|["`\]]$/g, '');

/** Returns null when the statement is legal for this plugin, else a refusal reason. */
function checkStatement(stmt, pluginId) {
  const own = new RegExp(`^p_${pluginId}_[a-z0-9_]+$`);
  const s = stmt.replace(/\s+/g, ' ').trim();
  const head = s.match(/^([A-Za-z]+)\s+([A-Za-z]+)?/);
  if (!head) return 'unparseable';
  const verb = head[1].toUpperCase();
  const second = (head[2] || '').toUpperCase();

  if (verb === 'CREATE' && second === 'TABLE') {
    const m = s.match(/^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?("[^"]+"|`[^`]+`|\[[^\]]+\]|[A-Za-z_][\w]*)/i);
    if (!m) return 'unparseable_create_table';
    const t = unquote(m[1]);
    return own.test(t) ? null : `create_outside_namespace:${t}`;
  }
  if (verb === 'CREATE' && (second === 'INDEX' || second === 'UNIQUE')) {
    const m = s.match(/\bON\s+("[^"]+"|`[^`]+`|\[[^\]]+\]|[A-Za-z_][\w]*)\s*\(/i);
    if (!m) return 'unparseable_create_index';
    const t = unquote(m[1]);
    return own.test(t) ? null : `index_on_foreign_table:${t}`;
  }
  if (verb === 'ALTER') {
    if (!/^ALTER\s+TABLE\s+/i.test(s)) return 'alter_not_table';
    const m = s.match(/^ALTER\s+TABLE\s+("[^"]+"|`[^`]+`|\[[^\]]+\]|[A-Za-z_][\w]*)\s+(ADD\s+COLUMN|RENAME\s+TO|RENAME\s+COLUMN|DROP\s+COLUMN)\b/i);
    if (!m) return 'unparseable_alter';
    const t = unquote(m[1]);
    const op = m[2].toUpperCase().replace(/\s+/g, ' ');
    if (!own.test(t)) return `alter_outside_namespace:${t}`;
    if (!/^ADD COLUMN$/.test(op)) return `alter_op_not_additive:${op}`;
    return null;
  }
  if (verb === 'INSERT' || verb === 'UPDATE') {
    const m = s.match(/^(?:INSERT\s+INTO|UPDATE)\s+("[^"]+"|`[^`]+`|\[[^\]]+\]|[A-Za-z_][\w]*)/i);
    const t = unquote(m ? m[1] : '');
    return own.test(t) ? null : `dml_outside_namespace:${t || '?'}`;
  }
  if (verb === 'DELETE') {
    const m = s.match(/^DELETE\s+FROM\s+("[^"]+"|`[^`]+`|\[[^\]]+\]|[A-Za-z_][\w]*)/i);
    const t = unquote(m ? m[1] : '');
    return own.test(t) ? null : `dml_outside_namespace:${t || '?'}`;
  }
  if (verb === 'CREATE' && ['TRIGGER', 'VIEW', 'VIRTUAL'].includes(second)) return `forbidden_statement:${second}`;
  return `forbidden_verb:${verb}`;
}

// ---------------------------------------------------------------- A–D, F, G
const line = (s) => console.log(s);
line('A. idempotence by ledger, not by IF NOT EXISTS');
let db = fresh('mig.db');
db.exec(`CREATE TABLE p_plugin_migration (
  plugin_id TEXT NOT NULL CHECK(plugin_id GLOB '[a-z][a-z0-9-]*'),
  version INTEGER NOT NULL CHECK(version > 0),
  checksum TEXT NOT NULL CHECK(length(checksum) = 64),
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(plugin_id, version))`);

const M1 = `CREATE TABLE p_contact_message (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL CHECK(length(email) <= 320),
  message TEXT NOT NULL CHECK(length(message) <= 1000));
CREATE INDEX ix_p_contact_message_email ON p_contact_message(email);`;

function apply(db, pluginId, version, sql) {
  const applied = db.prepare('SELECT checksum FROM p_plugin_migration WHERE plugin_id=? AND version=?')
    .get(pluginId, version);
  if (applied) return applied.checksum === sha(sql) ? 'skip' : 'checksum_mismatch';
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const stmt of stripAndSplit(sql)) {
      const bad = checkStatement(stmt, pluginId);
      if (bad) throw new Error('PL_E_MIGRATION_REFUSED ' + bad);
      db.exec(stmt);
    }
    db.prepare('INSERT INTO p_plugin_migration(plugin_id,version,checksum) VALUES(?,?,?)')
      .run(pluginId, version, sha(sql));
    db.exec('COMMIT');
    return 'applied';
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw e;
  }
}

const t0 = process.hrtime.bigint();
const r1 = apply(db, 'contact', 1, M1);
const t1 = process.hrtime.bigint();
const r2 = apply(db, 'contact', 1, M1);
const t2 = process.hrtime.bigint();
line(`   install #1 -> ${r1}  (${Number(t1 - t0) / 1e6} ms, ${stripAndSplit(M1).length} statements)`);
line(`   install #2 -> ${r2}  (${Number(t2 - t1) / 1e3} us: one indexed SELECT on the ledger PK)`);
line(`   ledger rows: ${JSON.stringify(db.prepare('SELECT plugin_id,version FROM p_plugin_migration').all())}`);

line('\nB. `CREATE TABLE IF NOT EXISTS` is not idempotence: it hides a changed definition');
db.exec(`CREATE TABLE IF NOT EXISTS p_contact_message (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL CHECK(length(email) <= 5),
  message TEXT NOT NULL CHECK(length(message) <= 1000))`);
const stored = db.prepare("SELECT sql FROM sqlite_master WHERE name='p_contact_message'").get().sql;
line(`   after a "v2" that only changed the CHECK: ${/<= 5/.test(stored) ? 'CHECK updated' : 'CHECK unchanged'}`);
db.prepare('INSERT INTO p_contact_message(email,message) VALUES(?,?)')
  .run('a@b.co', 'x'.repeat(50));
line(`   a 50-char message still inserts under the "new" 5-char rule: ${db.prepare('SELECT count(*) n FROM p_contact_message').get().n} row(s)`);
line(`   => drift is invisible unless the migration text is checksummed (D)`);

line('\nC. failure atomicity: the table and the ledger row appear together or not at all');
const BAD = `CREATE TABLE p_contact_note (id INTEGER PRIMARY KEY, body TEXT);
INSERT INTO p_contact_nothing(body) VALUES('x');`;
let err = null;
try { apply(db, 'contact', 2, BAD); } catch (e) { err = e.message; }
const hasNote = db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='p_contact_note'").get().n;
const ledger2 = db.prepare('SELECT count(*) n FROM p_plugin_migration WHERE version=2').get().n;
line(`   refused with: ${err}`);
line(`   p_contact_note exists=${hasNote}  ledger v2 rows=${ledger2}  (no half-installed plugin)`);

line('\nD. an edited migration is detected, not re-run');
const M1_EDITED = M1.replace('<= 320', '<= 254');
line(`   same version, edited text -> ${apply(db, 'contact', 1, M1_EDITED)}`);

line('\nF. the engine does not protect cms_* — only the code path does');
const probe = fresh('cap.db');
let cap = [];
try { probe.exec('ALTER TABLE cms_page ADD COLUMN injected TEXT'); cap.push('ALTER cms_page: OK'); }
catch (e) { cap.push('ALTER cms_page: ' + e.code); }
try { probe.exec('DROP TABLE cms_redirect'); cap.push('DROP cms_redirect: OK'); }
catch (e) { cap.push('DROP cms_redirect: ' + e.code); }
probe.pragma('query_only = 1');
try { probe.prepare("INSERT INTO cms_settings(key,value_json,type) VALUES('a','1','int')").run(); cap.push('insert cms_settings under query_only: OK'); }
catch (e) { cap.push('insert cms_settings under query_only: ' + e.code); }
try { probe.exec('CREATE TABLE p_x (a TEXT)'); cap.push('create p_x under query_only: OK'); }
catch (e) { cap.push('create p_x under query_only: ' + e.code); }
cap.forEach((c) => line('   ' + c));
probe.close();
line('   => query_only denies the plugin its own table; a write handle grants it cms_page. No pragma splits them.');

line('\nE. a statement-class gate over the exact corpus a plugin migration could carry');
const corpus = [
  ['CREATE TABLE p_contact_message (id INTEGER PRIMARY KEY)', true],
  ['CREATE TABLE IF NOT EXISTS p_contact_tag (id INTEGER PRIMARY KEY)', true],
  ['CREATE UNIQUE INDEX ix_p_contact_tag_key ON p_contact_tag(id)', true],
  ['ALTER TABLE p_contact_message ADD COLUMN phone TEXT', true],
  ["INSERT INTO p_contact_setting(key,value_json) VALUES('notify','\"a@b.c\"')", true],
  ['DROP TABLE cms_page', false],
  ['drop table if exists cms_redirect', false],
  ['/* housekeeping */ DROP TABLE cms_asset', false],
  ['-- tidy\nDROP TABLE cms_nav', false],
  ['ALTER TABLE cms_page ADD COLUMN injected TEXT', false],
  ['ALTER TABLE p_contact_message RENAME TO cms_page_x', false],
  ['CREATE INDEX ix_p_contact_bad ON cms_page(path)', false],
  ['CREATE TRIGGER p_contact_trg AFTER INSERT ON p_contact_message BEGIN DELETE FROM cms_page; END', false],
  ['CREATE VIEW p_contact_v AS SELECT * FROM cms_download_code', false],
  ['ATTACH DATABASE \'../beta/site.db\' AS beta', false],
  ['PRAGMA writable_schema = ON', false],
  ['CREATE TABLE p_contact_a (x TEXT); DROP TABLE cms_audit', false],
  ['CREATE TABLE "cms_page_shadow" (x TEXT)', false],
  ['CREATE TABLE p_contact_ok (x TEXT); CREATE TABLE u_sneaky (y TEXT)', false],
];
let caught = 0, missed = [];
for (const [stmt, legal] of corpus) {
  const verdicts = stripAndSplit(stmt).map((s) => checkStatement(s, 'contact'));
  const refused = verdicts.some((v) => v !== null);
  const ok = refused === !legal;
  if (ok) caught++; else missed.push([stmt.slice(0, 60), legal, verdicts]);
  line(`   ${legal ? 'allow' : 'deny '} -> ${refused ? 'REFUSED ' + verdicts.filter(Boolean)[0] : 'accepted'}   ${stmt.replace(/\s+/g, ' ').slice(0, 72)}`);
}
line(`   correct verdicts: ${caught}/${corpus.length}${missed.length ? '  MISSES=' + JSON.stringify(missed) : ''}`);

const G = M1;
const N = 2000;
const ts = process.hrtime.bigint();
for (let i = 0; i < N; i++) for (const s of stripAndSplit(G)) checkStatement(s, 'contact');
const te = process.hrtime.bigint();
line(`\nG. gate cost: ${N} x 2-statement migration in ${(Number(te - ts) / 1e6).toFixed(1)} ms ` +
     `= ${(Number(te - ts) / N / 1000).toFixed(1)} us per migration`);
db.close();
