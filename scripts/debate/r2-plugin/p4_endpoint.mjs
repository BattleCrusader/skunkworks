// R2.5 plugin probe 4 — the public endpoint contract, measured.
//
// One process, one table, the exact controls §7 of r2-plugin.md proposes:
//   payload cap (Content-Length pre-check + streamed count), signed form token with a TTL and a
//   minimum fill time, honeypot, per-IP token bucket, uniform rejection body, bound-parameter insert.
//
// Run: SK_PROBE_DEPS=<dir with better-sqlite3> node scripts/debate/r2-plugin/p4_endpoint.mjs
import { createRequire } from 'node:module';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEPS = process.env.SK_PROBE_DEPS ||
  path.join(os.homedir(), '.hermes/profiles/ceo/cache/scratch/probe/sql');
const require = createRequire(path.join(DEPS, 'package.json'));
const Database = require('better-sqlite3');

const WORK = process.env.SK_PLUGIN_WORK ||
  path.join(os.homedir(), '.hermes/profiles/ceo/cache/scratch/pluginprobe/work');
fs.mkdirSync(WORK, { recursive: true });
const DB = path.join(WORK, 'endpoint.db');
for (const s of ['', '-wal', '-shm']) if (fs.existsSync(DB + s)) fs.rmSync(DB + s);

const db = new Database(DB);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE p_contact_message (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
  email TEXT NOT NULL CHECK(email LIKE '%_@_%.__%' AND length(email) <= 320),
  message TEXT NOT NULL CHECK(length(message) BETWEEN 1 AND 4000),
  ip_hash TEXT NOT NULL CHECK(length(ip_hash) = 64),
  ua_hash TEXT NOT NULL CHECK(length(ua_hash) = 64),
  state TEXT NOT NULL DEFAULT 'new' CHECK(state IN ('new','read','spam')),
  ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
CREATE INDEX ix_p_contact_message_ts ON p_contact_message(ts);`);

const insert = db.prepare(`INSERT INTO p_contact_message(name,email,message,ip_hash,ua_hash)
                           VALUES(?,?,?,?,?)`);

const TOKEN_KEY = randomBytes(32);
const IP_KEY = randomBytes(32);
const CAP = 16 * 1024;              // payload cap, bytes
const TTL_MS = 30 * 60 * 1000;      // token lifetime
const MIN_FILL_MS = 1500;           // a human cannot type a message faster than this
const BUCKET = { capacity: 5, windowMs: 10 * 60 * 1000 };

const hmac = (key, msg) => createHmac('sha256', key).update(msg).digest();
const b64u = (b) => Buffer.from(b).toString('base64url');

function mint(plugin, ts = Date.now()) {
  const body = `${plugin}.${ts}`;
  return `${Buffer.from(body).toString('base64url')}.${b64u(hmac(TOKEN_KEY, body).subarray(0, 16))}`;
}
function verifyToken(tok, plugin) {
  const [p, m] = String(tok || '').split('.');
  if (!p || !m) return { ok: false, why: 'shape' };
  const body = Buffer.from(p, 'base64url').toString();
  const [pl, ts] = body.split('.');
  if (pl !== plugin) return { ok: false, why: 'plugin' };
  const want = hmac(TOKEN_KEY, body).subarray(0, 16);
  const got = Buffer.from(m, 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return { ok: false, why: 'mac' };
  const age = Date.now() - Number(ts);
  if (!Number.isFinite(age) || age < MIN_FILL_MS) return { ok: false, why: 'too_fast' };
  if (age > TTL_MS || age < 0) return { ok: false, why: 'expired' };
  return { ok: true };
}

const buckets = new Map();
function take(ip) {
  const now = Date.now();
  const b = buckets.get(ip) || { n: 0, reset: now + BUCKET.windowMs };
  if (now > b.reset) { b.n = 0; b.reset = now + BUCKET.windowMs; }
  b.n += 1; buckets.set(ip, b);
  return { ok: b.n <= BUCKET.capacity, retry: Math.ceil((b.reset - now) / 1000) };
}

const REJECT = (extra = {}) => JSON.stringify({ ok: false, code: 'PL_E_REJECTED', ...extra });

function readBody(req, cap) {
  return new Promise((resolve) => {
    let n = 0; const chunks = [];
    let over = false;
    req.on('data', (c) => {
      n += c.length;
      if (n > cap && !over) { over = true; chunks.length = 0; resolve({ over, read: n }); return; }
      if (!over) chunks.push(c);
    });
    req.on('end', () => { if (!over) resolve({ over: false, read: n, body: Buffer.concat(chunks).toString('utf8') }); });
    req.on('error', () => resolve({ over, read: n, error: true }));
  });
}

const t0 = process.hrtime.bigint();
const server = http.createServer(async (req, res) => {
  const send = (code, body, headers = {}) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store', ...headers });
    res.end(body);
  };
  if (req.method !== 'POST' || req.url !== '/_p/contact/submit') return send(404, REJECT());

  const ip = req.socket.remoteAddress || '0.0.0.0';
  const rate = take(ip);
  if (!rate.ok) return send(429, REJECT({ retry_s: rate.retry }), { 'retry-after': String(rate.retry) });

  const declared = Number(req.headers['content-length'] || 0);
  // Respond, then drain: destroying the socket first makes the client see ECONNRESET, not 413.
  // The app's job is to stop buffering; nginx's client_max_body_size is what stops the bytes.
  if (declared > CAP) { req.resume(); return send(413, REJECT({ max_bytes: CAP }), { connection: 'close' }); }

  const got = await readBody(req, CAP);
  if (got.over) { req.resume(); return send(413, REJECT({ max_bytes: CAP }), { connection: 'close' }); }

  const ct = String(req.headers['content-type'] || '');
  if (!ct.startsWith('application/x-www-form-urlencoded')) return send(415, REJECT());

  const f = new URLSearchParams(got.body || '');
  const tok = verifyToken(f.get('_pt'), 'contact');
  if (!tok.ok) return send(403, REJECT());          // one body, one status: no oracle
  if ((f.get('_hp') || '').length > 0) return send(202, JSON.stringify({ ok: true })); // silently dropped
  const name = (f.get('name') || '').trim();
  const email = (f.get('email') || '').trim();
  const message = (f.get('message') || '').trim();
  if (!name || name.length > 120 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ||
      email.length > 320 || !message || message.length > 4000) return send(422, REJECT());
  insert.run(name, email, message,
    hmac(IP_KEY, ip).toString('hex'),
    hmac(IP_KEY, String(req.headers['user-agent'] || '')).toString('hex'));
  return send(200, JSON.stringify({ ok: true }));
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
console.log(`endpoint up in ${(Number(process.hrtime.bigint() - t0) / 1e6).toFixed(1)} ms on 127.0.0.1:${port}`);

function call(body, { method = 'POST', ct = 'application/x-www-form-urlencoded', ip = null } = {}) {
  return new Promise((resolve) => {
    const t = process.hrtime.bigint();
    const headers = { 'content-type': ct, 'content-length': Buffer.byteLength(body) };
    if (ip) headers['x-forwarded-for'] = ip;
    const req = http.request({ host: '127.0.0.1', port, method, path: '/_p/contact/submit', headers }, (res) => {
      let out = ''; res.on('data', (c) => (out += c));
      res.on('end', () => resolve({ status: res.statusCode, body: out,
        ms: Number(process.hrtime.bigint() - t) / 1e6, headers: res.headers }));
    });
    req.on('error', (e) => resolve({ status: 0, body: e.code, ms: Number(process.hrtime.bigint() - t) / 1e6 }));
    req.end(body);
  });
}
const form = (o) => new URLSearchParams(o).toString();
const pct = (a, p) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];

console.log('\n1. a valid submission (token minted 2 s ago, human-shaped payload)');
const good = form({ _pt: mint('contact', Date.now() - 2000), name: 'Ada Lovelace',
  email: 'ada@example.com', message: 'Do you build CMSs? '.repeat(6), _hp: '' });
const first = await call(good);
console.log(`   status ${first.status}  body ${first.body}  ${first.ms.toFixed(2)} ms  row bytes ${Buffer.byteLength(good)}`);
console.log(`   rows=${db.prepare('SELECT count(*) n FROM p_contact_message').get().n}`);

console.log('\n2. N=300 valid submissions, sequential (p50 / p95 / max)');
const lat = [];
for (let i = 0; i < 300; i++) {
  buckets.clear();
  const r = await call(form({ _pt: mint('contact', Date.now() - 2000), name: `Person ${i}`,
    email: `p${i}@example.com`, message: 'x'.repeat(300), _hp: '' }));
  if (r.status !== 200) { console.log(`   unexpected ${r.status} at i=${i}`); break; }
  lat.push(r.ms);
}
console.log(`   p50 ${pct(lat, 0.5).toFixed(2)} ms  p95 ${pct(lat, 0.95).toFixed(2)} ms  max ${Math.max(...lat).toFixed(2)} ms`);

console.log('\n3. payload cap = 16 KiB');
buckets.clear();
const big = form({ _pt: mint('contact', Date.now() - 2000), name: 'A', email: 'a@b.co', message: 'y'.repeat(40 * 1024) });
const r413 = await call(big);
console.log(`   40 KiB body, declared length -> ${r413.status} ${r413.body}`);
buckets.clear();
const chunked = await new Promise((resolve) => {
  const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/_p/contact/submit',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'transfer-encoding': 'chunked' } }, (res) => {
    let out = ''; res.on('data', (c) => (out += c)); res.on('end', () => resolve({ status: res.statusCode, body: out }));
  });
  req.on('error', (e) => resolve({ status: 0, body: e.code }));
  let sent = 0; const chunk = Buffer.alloc(4096, 0x61);
  const pump = () => { while (sent < 64 * 1024) { sent += chunk.length; if (!req.write(chunk)) { req.once('drain', pump); return; } } req.end(); };
  pump();
});
console.log(`   64 KiB chunked (no Content-Length) -> ${chunked.status} ${chunked.body}`);

console.log('\n4. per-IP bucket = 5 / 10 min');
buckets.clear();
const seq = [];
for (let i = 0; i < 7; i++) seq.push((await call(good)).status);
const rl = await call(good);
console.log(`   statuses ${seq.join(',')}  7th: ${rl.status} retry-after=${rl.headers['retry-after']} body=${rl.body}`);

console.log('\n5. rejections are one shape and one status (no oracle for a bot)');
const cases = {
  'no token': form({ name: 'A', email: 'a@b.co', message: 'hi' }),
  'bad mac': form({ _pt: 'eyJ4IjoxfQ.AAAAAAAAAAAAAAAAAAAAAA', name: 'A', email: 'a@b.co', message: 'hi' }),
  'expired (31 min)': form({ _pt: mint('contact', Date.now() - 31 * 60 * 1000), name: 'A', email: 'a@b.co', message: 'hi' }),
  'too fast (200 ms)': form({ _pt: mint('contact', Date.now() - 200), name: 'A', email: 'a@b.co', message: 'hi' }),
};
const shapes = new Set();
for (const [label, body] of Object.entries(cases)) {
  buckets.clear();
  const r = await call(body);
  shapes.add(`${r.status} ${r.body}`);
  console.log(`   ${label.padEnd(20)} -> ${r.status} ${r.body}`);
}
console.log(`   distinct response shapes across 4 rejection causes: ${shapes.size}`);

console.log('\n6. honeypot: 202, identical body to success, no row written');
buckets.clear();
const before = db.prepare('SELECT count(*) n FROM p_contact_message').get().n;
const hp = await call(form({ _pt: mint('contact', Date.now() - 2000), name: 'bot', email: 'bot@example.com',
  message: 'buy pills', _hp: 'http://spam.example' }));
const after = db.prepare('SELECT count(*) n FROM p_contact_message').get().n;
console.log(`   status ${hp.status} body ${hp.body} (a stored submission answers 200 ${first.body})  rows ${before} -> ${after}`);

console.log('\n7. content type and method');
buckets.clear();
console.log(`   application/json       -> ${(await call('{"name":"A"}', { ct: 'application/json' })).status}`);
console.log(`   GET /_p/contact/submit -> ${(await call('', { method: 'GET' })).status}`);

console.log('\n8. storage cost per submission, measured as a marginal byte count');
db.pragma('wal_checkpoint(TRUNCATE)');
const s0 = fs.statSync(DB).size;
const n0 = db.prepare('SELECT count(*) n FROM p_contact_message').get().n;
const bulk = db.transaction((k) => {
  for (let i = 0; i < k; i++) insert.run(`Bulk ${i}`, `b${i}@example.com`, 'z'.repeat(300), 'a'.repeat(64), 'b'.repeat(64));
});
bulk(200);
db.pragma('wal_checkpoint(TRUNCATE)');
const s1 = fs.statSync(DB).size;
const n1 = db.prepare('SELECT count(*) n FROM p_contact_message').get().n;
console.log(`   ${n0} -> ${n1} rows, ${s0} -> ${s1} B = ${((s1 - s0) / (n1 - n0)).toFixed(0)} B/row marginal (300-char message + 64-hex ip/ua hash)`);
const wal = fs.existsSync(DB + '-wal') ? fs.statSync(DB + '-wal').size : 0;
console.log(`   ${DB}-wal after checkpoint ${wal} B (a WAL tenant is never read-only: Data M2 / Platform P11)`);

console.log('\n9. 20 concurrent submissions (bucket raised to 100 for this section only)');
BUCKET.capacity = 100;
buckets.clear();
const par = await Promise.all(Array.from({ length: 20 }, (_, i) =>
  call(form({ _pt: mint('contact', Date.now() - 2000), name: `P${i}`, email: `c${i}@example.com`,
    message: 'concurrent '.repeat(10), _hp: '' }))));
const okCount = par.filter((r) => r.status === 200).length;
const pl = par.map((r) => r.ms);
console.log(`   200s ${okCount}/20  p50 ${pct(pl, 0.5).toFixed(1)} ms  p95 ${pct(pl, 0.95).toFixed(1)} ms  max ${Math.max(...pl).toFixed(1)} ms`);
console.log(`   SQLITE_BUSY count ${par.filter((r) => /SQLITE_BUSY/.test(r.body)).length} (one process, one write connection, autocommit per insert)`);

server.close();
db.close();
