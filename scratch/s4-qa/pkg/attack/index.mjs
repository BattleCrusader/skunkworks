
import { readFileSync, readdirSync } from 'node:fs';
import { connect } from 'node:net';
import { spawnSync } from 'node:child_process';

const HOARD = [];

function attempt(fn) {
  try { const v = fn(); return `OK:${String(v).slice(0, 80)}`; }
  catch (e) { return `ERR:${e.code ?? e.name}: ${String(e.message).slice(0,120)}`; }
}

function tcp(host, port) {
  return new Promise((resolve) => {
    const s = connect({ host, port });
    let done = false;
    const fin = (m) => { if (!done) { done = true; s.destroy(); resolve(m); } };
    s.setTimeout(500, () => fin('TIMEOUT'));
    s.on('connect', () => fin('CONNECTED'));
    s.on('error', (e) => fin(String(e.code ?? e.name)));
  });
}

export async function handle(op, args = {}) {
  if (op === 'fs') {
    const paths = ['/etc/passwd', '/srv/runner/server.mjs', '/srv/plugins/echo/plugin.json',
                   '/proc/self/environ', '/srv/data/tenants/acme/site.db'];
    const out = {};
    for (const p of paths) out[p] = attempt(() => readFileSync(p, 'utf8').length);
    out.cwd = attempt(() => process.cwd());
    out.readdir_root = attempt(() => readdirSync('/').slice(0, 12).join(','));
    out.permission_fs_read = typeof process.permission?.has === 'function' ? process.permission.has('fs.read') : 'none';
    out.binding_fs_keys = attempt(() => Object.keys(process.binding('fs')).join(','));
    out.spawn_cat = attempt(() => {
      const r = spawnSync('/bin/cat', ['/etc/passwd'], { encoding: 'utf8', timeout: 3000 });
      return `${String(r.status)}|${String(r.stdout).slice(0, 24)}|${String(r.stderr).slice(0, 60)}`;
    });
    out.dlopen = attempt(() => process.dlopen({ exports: {} }, '/srv/plugins/attack/none.node'));
    return out;
  }
  if (op === 'hoard') {
    const mb = Math.max(16, Math.min(384, Number(args.mb ?? 256)));
    for (let i = 0; i < mb / 16; i += 1) HOARD.push(Buffer.alloc(16 * 1024 * 1024, 0x42));
    return { requested_mb: mb, held_mb: HOARD.length * 16, rss_mb: Math.round(process.memoryUsage().rss / 1048576) };
  }
  if (op === 'free') {
    const held = HOARD.length * 16;
    HOARD.length = 0;
    return { released_mb: held, rss_mb: Math.round(process.memoryUsage().rss / 1048576) };
  }
  if (op === 'mem') {
    const mb = Math.max(16, Math.min(512, Number(args.mb ?? 256)));
    const chunks = [];
    for (let i = 0; i < mb / 16; i += 1) chunks.push(Buffer.alloc(16 * 1024 * 1024, 0x41));
    return { requested_mb: mb, allocated_mb: chunks.length * 16,
             rss_mb: Math.round(process.memoryUsage().rss / 1048576) };
  }
  if (op === 'net') {
    return { tcp: await tcp('1.1.1.1', 53) };
  }
  if (op === 'undeclared') {
    try { return { call: await skw.call('mail.send', { to: 'x@y.test' }) }; }
    catch (e) { return { refusal: String(e.message) }; }
  }
  if (op === 'foreign') {
    const out = {};
    try { out.notes_table = await skw.call('store.query', { table: 'p_notes_note' }); }
    catch (e) { out.notes_table = String(e.message); }
    try { out.core_table = await skw.call('store.query', { table: 'cms_page' }); }
    catch (e) { out.core_table = String(e.message); }
    try { out.tenant_field = await skw.call('store.query', { table: 'p_attack_note', tenant: 'other' }); }
    catch (e) { out.tenant_field = String(e.message); }
    return out;
  }
  throw new Error(`attack: unknown op ${JSON.stringify(op)}`);
}
export default handle;
