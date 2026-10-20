/**
 * S4 QA round 2 — the trust surface, attacked through the operator CLI.
 *
 * This is QA's own harness: it signs with the shipped packager, installs with the shipped
 * `skwctl`, and reads the resulting state out of the real databases. Nothing here is a
 * re-implementation of the verifier.
 */
import { generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';
import Database from 'better-sqlite3';

import { makeFixture, REPO } from '../../test/helpers/fixture.ts';
import { packageRootHash } from '../../app/plugins/protocol.ts';
import { fingerprintOf } from '../../app/plugins/trust.ts';

const OUT = join(REPO, 'scratch', 's4-qa2', 'trust');
const RUNNER = 'sha256:qa2-runner';
const results: Record<string, unknown>[] = [];

function sh(cmd: string, args: string[], env: Record<string, string> = {}) {
  const res = spawnSync(cmd, args, { cwd: REPO, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 180_000 });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

const skwctl = (args: string[], env: Record<string, string>) => sh(process.execPath, ['app/cli/skwctl.ts', ...args], env);
const signTool = (args: string[]) => sh(process.execPath, ['tools/plugin_sign.ts', ...args]);

function sha256File(p: string): string {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

/** Content hash of a tree: relpath\0sha256\n, sorted. Independent of the product's hashTree. */
function treeHash(dir: string): string {
  const rows: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const st = statSync(p);
      const rel = relative(dir, p);
      if (st.isDirectory()) {
        rows.push(`d\0${rel}`);
        walk(p);
      } else {
        rows.push(`f\0${rel}\0${sha256File(p)}`);
      }
    }
  };
  if (existsSync(dir)) walk(dir);
  return createHash('sha256').update(`${rows.sort().join('\n')}\n`).digest('hex');
}

/** The logical state a refused install must not move. */
function snapshot(dataDir: string, tenant = 'acme'): Record<string, unknown> {
  const siteDb = join(dataDir, 'tenants', tenant, 'site.db');
  const db = new Database(siteDb, { readonly: true });
  let state: Record<string, unknown>;
  try {
    const installed = db.prepare('SELECT plugin_id, version, root_hash, publisher, publisher_key_fingerprint, signature_state, enabled FROM cms_plugin_installed ORDER BY plugin_id').all();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'p_%' ORDER BY name").all();
    const audit = db.prepare('SELECT COUNT(*) AS n FROM cms_audit').get() as { n: number };
    const pluginAudit = db.prepare("SELECT action, target_kind, target_id, after_json FROM cms_audit WHERE action LIKE 'plugin.%' ORDER BY id").all();
    state = { installed, tables, audit_n: audit.n, plugin_audit: pluginAudit };
  } finally {
    db.close();
  }
  const trustFile = join(dataDir, 'trust', 'publishers.json');
  return {
    ...state,
    trust_sha: existsSync(trustFile) ? sha256File(trustFile) : null,
    plugins_tree: treeHash(join(dataDir, 'plugins')),
  };
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function record(name: string, payload: Record<string, unknown>): void {
  results.push({ attack: name, ...payload });
  process.stdout.write(`\n### ${name}\n${JSON.stringify({ attack: name, ...payload }, null, 2)}\n`);
}

// --- setup -------------------------------------------------------------------------------
const fixture = makeFixture({ specs: [{ key: 'acme', hosts: ['acme.test'] }] });
const dataDir = fixture.dir;
const env = fixture.env;
const work = join(OUT, 'work');
mkdirSync(work, { recursive: true });

interface Pair { key: string; pub: string; fingerprint: string }

/** Generate in memory; write only the pair that is kept (the collision loop calls this a lot). */
function pairInMemory(): { priv: string; pub: string; fingerprint: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  return {
    priv: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    pub,
    fingerprint: fingerprintOf(pub),
  };
}

function pair(prefix: string): Pair {
  const p = pairInMemory();
  mkdirSync(join(work, 'keys'), { recursive: true });
  const keyPath = join(work, 'keys', `${prefix}.key`);
  writeFileSync(keyPath, p.priv, { mode: 0o600 });
  const pubPath = join(work, 'keys', `${prefix}.pub`);
  writeFileSync(pubPath, p.pub);
  return { key: keyPath, pub: pubPath, fingerprint: p.fingerprint };
}

function pkg(name: string, mutate?: (dir: string) => void): string {
  const dir = join(work, 'packages', name);
  cpSync(join(REPO, 'test', 'fixtures', 'plugins', 'notes'), dir, { recursive: true });
  mutate?.(dir);
  return dir;
}

function reportFor(dir: string, out?: string): string {
  const root = packageRootHash(dir).root;
  const manifest = JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8')) as { id: string; version: string };
  const path = out ?? join(work, 'reports', `${root.slice(0, 12)}.json`);
  mkdirSync(join(work, 'reports'), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ plugin: manifest.id, version: manifest.version, root_hash: root, runner_image_digest: RUNNER, ran_at: '2026-10-21T00:00:00.000Z' }, null, 2)}\n`);
  return path;
}

const A = pair('A');
const B = pair('B');

// baseline: import A, install a signed package
const impA = skwctl(['plugin', 'trust', 'import', A.pub, '--publisher', 'acme-labs', '--tenant', 'acme'], env);
const base = pkg('base');
const baseReport = reportFor(base);
const baseSig = join(base, '..', 'base.sig.json');
const signBase = signTool(['--dir', base, '--key', A.key, '--publisher', 'acme-labs', '--out', baseSig]);
const installBase = skwctl(['plugin', 'install', base, '--tenant', 'acme', '--test-report', baseReport, '--signature', baseSig, '--runner-digest', RUNNER, '--enable'], env);

record('setup', {
  import_status: impA.status,
  import_stdout: impA.stdout.trim(),
  a_fingerprint: A.fingerprint,
  sign_status: signBase.status,
  install_status: installBase.status,
  install_stdout: installBase.stdout.trim().split('\n').slice(0, 4).join('\n'),
  install_stderr: installBase.stderr.trim().slice(0, 700),
  install_exit_ok: installBase.status === 0,
});

// --- (i) edit a file after signing --------------------------------------------------------
{
  const before = snapshot(dataDir);
  const dir = pkg('edited');
  const rep = reportFor(dir);
  const sig = join(dir, '..', 'edited.sig.json');
  signTool(['--dir', dir, '--key', A.key, '--publisher', 'acme-labs', '--out', sig]);
  // one byte more, appended to a file that is not the manifest
  writeFileSync(join(dir, 'index.mjs'), `${readFileSync(join(dir, 'index.mjs'), 'utf8')}\n// one byte more\n`);
  // the report must be for the *new* bytes, else the refusal would be the stale-report one
  const rep2 = reportFor(dir, join(work, 'reports', 'edited-post.json'));
  const run = skwctl(['plugin', 'install', dir, '--tenant', 'acme', '--test-report', rep2, '--signature', sig, '--runner-digest', RUNNER, '--enable'], env);
  const after = snapshot(dataDir);
  record('i. edit a file', {
    exit: run.status,
    refusal: `${run.stdout}${run.stderr}`.trim().split('\n').filter((l) => l.includes('SKW_E_') || l.includes('REFUSAL')).join('\n'),
    state_unchanged: same(before, after),
  });
}

// --- (ii) edit plugin.json after signing ---------------------------------------------------
{
  const before = snapshot(dataDir);
  const dir = pkg('manifest-edited');
  const rep = reportFor(dir);
  const sig = join(dir, '..', 'manifest-edited.sig.json');
  signTool(['--dir', dir, '--key', A.key, '--publisher', 'acme-labs', '--out', sig]);
  const mf = JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8')) as Record<string, unknown>;
  mf.description = `${String(mf.description)} (widened)`;
  writeFileSync(join(dir, 'plugin.json'), `${JSON.stringify(mf, null, 2)}\n`);
  const rep2 = reportFor(dir, join(work, 'reports', 'manifest-post.json'));
  const run = skwctl(['plugin', 'install', dir, '--tenant', 'acme', '--test-report', rep2, '--signature', sig, '--runner-digest', RUNNER, '--enable'], env);
  const after = snapshot(dataDir);
  record('ii. edit plugin.json', {
    exit: run.status,
    refusal: `${run.stdout}${run.stderr}`.trim().split('\n').filter((l) => l.includes('SKW_E_') || l.includes('REFUSAL')).join('\n'),
    state_unchanged: same(before, after),
  });
}

// --- (ii-b) WIDEN the manifest: add a capability, re-report, keep the old signature --------
{
  const before = snapshot(dataDir);
  const dir = pkg('manifest-widened');
  const rep = reportFor(dir);
  const sig = join(dir, '..', 'manifest-widened.sig.json');
  signTool(['--dir', dir, '--key', A.key, '--publisher', 'acme-labs', '--out', sig]);
  const mf = JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8')) as { capabilities: string[] };
  mf.capabilities.push('store.delete');
  writeFileSync(join(dir, 'plugin.json'), `${JSON.stringify(mf, null, 2)}\n`);
  const rep2 = reportFor(dir, join(work, 'reports', 'widened-post.json'));
  const run = skwctl(['plugin', 'install', dir, '--tenant', 'acme', '--test-report', rep2, '--signature', sig, '--runner-digest', RUNNER, '--enable'], env);
  const after = snapshot(dataDir);
  record('ii-b. widen the grant in plugin.json', {
    exit: run.status,
    refusal: `${run.stdout}${run.stderr}`.trim().split('\n').filter((l) => l.includes('SKW_E_') || l.includes('REFUSAL')).join('\n'),
    state_unchanged: same(before, after),
  });
}

// --- (iii) ADD a file after signing --------------------------------------------------------
{
  const before = snapshot(dataDir);
  const dir = pkg('added');
  const rep = reportFor(dir);
  const sig = join(dir, '..', 'added.sig.json');
  signTool(['--dir', dir, '--key', A.key, '--publisher', 'acme-labs', '--out', sig]);
  writeFileSync(join(dir, 'extra.mjs'), 'export const x = 1;\n');
  const rep2 = reportFor(dir, join(work, 'reports', 'added-post.json'));
  const run = skwctl(['plugin', 'install', dir, '--tenant', 'acme', '--test-report', rep2, '--signature', sig, '--runner-digest', RUNNER, '--enable'], env);
  const after = snapshot(dataDir);
  record('iii. add a file', {
    exit: run.status,
    refusal: `${run.stdout}${run.stderr}`.trim().split('\n').filter((l) => l.includes('SKW_E_') || l.includes('REFUSAL')).join('\n'),
    state_unchanged: same(before, after),
  });
}

// --- (iv) swap the signature between two packages ------------------------------------------
// (a) same id@version, different bytes: sig from package X presented with package Y
{
  const before = snapshot(dataDir);
  const x = pkg('swap-x', (d) => {
    const m = JSON.parse(readFileSync(join(d, 'plugin.json'), 'utf8')) as Record<string, unknown>;
    m.description = `${String(m.description)} — build X`;
    writeFileSync(join(d, 'plugin.json'), `${JSON.stringify(m, null, 2)}\n`);
  });
  const y = pkg('swap-y', (d) => {
    const m = JSON.parse(readFileSync(join(d, 'plugin.json'), 'utf8')) as Record<string, unknown>;
    m.description = `${String(m.description)} — build Y`;
    writeFileSync(join(d, 'plugin.json'), `${JSON.stringify(m, null, 2)}\n`);
  });
  const sigX = join(x, '..', 'swap-x.sig.json');
  signTool(['--dir', x, '--key', A.key, '--publisher', 'acme-labs', '--out', sigX]);
  const repY = reportFor(y);
  const run = skwctl(['plugin', 'install', y, '--tenant', 'acme', '--test-report', repY, '--signature', sigX, '--runner-digest', RUNNER, '--enable'], env);
  const after = snapshot(dataDir);
  record('iv-a. signature swapped between two builds of one id', {
    exit: run.status,
    refusal: `${run.stdout}${run.stderr}`.trim().split('\n').filter((l) => l.includes('SKW_E_') || l.includes('REFUSAL')).join('\n'),
    state_unchanged: same(before, after),
  });
}
// (b) a signature for a different plugin entirely (echo) presented with notes
{
  const before = snapshot(dataDir);
  const echoDir = join(work, 'packages', 'echo-copy');
  cpSync(join(REPO, 'test', 'fixtures', 'plugins', 'echo'), echoDir, { recursive: true });
  const echoRep = reportFor(echoDir);
  const echoSig = join(echoDir, '..', 'echo-copy.sig.json');
  signTool(['--dir', echoDir, '--key', A.key, '--publisher', 'acme-labs', '--out', echoSig]);
  const notesDir = pkg('swap-other-id');
  const notesRep = reportFor(notesDir);
  const run = skwctl(['plugin', 'install', notesDir, '--tenant', 'acme', '--test-report', notesRep, '--signature', echoSig, '--runner-digest', RUNNER, '--enable'], env);
  const after = snapshot(dataDir);
  record('iv-b. signature swapped between two plugin ids', {
    exit: run.status,
    refusal: `${run.stdout}${run.stderr}`.trim().split('\n').filter((l) => l.includes('SKW_E_') || l.includes('REFUSAL')).join('\n'),
    state_unchanged: same(before, after),
  });
}

// --- (v) --allow-unsigned, and the audit row ----------------------------------------------
{
  const dir = pkg('unsigned-install');
  const rep = reportFor(dir);
  const refusedRun = skwctl(['plugin', 'install', dir, '--tenant', 'acme', '--test-report', rep, '--runner-digest', RUNNER, '--enable'], env);
  const beforeAllow = snapshot(dataDir);
  const allowed = skwctl(['plugin', 'install', dir, '--tenant', 'acme', '--test-report', rep, '--runner-digest', RUNNER, '--enable', '--allow-unsigned'], env);
  const afterAllow = snapshot(dataDir);
  const audit = (afterAllow.plugin_audit as Record<string, unknown>[]).filter((r) => JSON.stringify(r).includes('allow_unsigned'));
  const rowNow = (afterAllow.installed as Record<string, unknown>[]);
  record('v. --allow-unsigned and its audit row', {
    refused_without_flag_exit: refusedRun.status,
    refused_text: `${refusedRun.stdout}${refusedRun.stderr}`.trim().split('\n').filter((l) => l.includes('SKW_E_') || l.includes('REFUSAL')).join('\n'),
    with_flag_exit: allowed.status,
    with_flag_stdout: allowed.stdout.trim().split('\n').filter((l) => l.includes('UNSIGNED') || l.includes('installed')).join('\n'),
    audit_rows: audit,
    rows: rowNow,
  });
}

// --- (vi) silently replace a trusted publisher key ----------------------------------------
{
  const trustFile = join(dataDir, 'trust', 'publishers.json');
  const beforeSha = sha256File(trustFile);
  const silent = skwctl(['plugin', 'trust', 'import', B.pub, '--publisher', 'acme-labs', '--tenant', 'acme'], env);
  const afterSha = sha256File(trustFile);
  const replace = skwctl(['plugin', 'trust', 'import', B.pub, '--publisher', 'acme-labs', '--tenant', 'acme', '--replace'], env);
  const replacedSha = sha256File(trustFile);
  record('vi. replace a trusted publisher key', {
    silent_exit: silent.status,
    silent_text: `${silent.stdout}${silent.stderr}`.trim().split('\n').filter((l) => l.includes('SKW_E_') || l.includes('REFUSAL') || l.includes('already imported')).join('\n'),
    trust_unchanged: beforeSha === afterSha,
    trust_sha_before: beforeSha.slice(0, 16),
    trust_sha_after: afterSha.slice(0, 16),
    with_replace_exit: replace.status,
    with_replace_text: `${replace.stdout}${replace.stderr}`.trim().split('\n').filter((l) => l.includes('imported publisher')).join('\n'),
    trust_changed_by_replace: replacedSha !== afterSha,
  });
  // restore A so later cases are not confused
  skwctl(['plugin', 'trust', 'import', A.pub, '--publisher', 'acme-labs', '--tenant', 'acme', '--replace'], env);
}

// --- (vii) a publisher key that collides in fingerprint PREFIX only -----------------------
{
  const trustedHex = A.fingerprint.replace('spki-sha256:', '');
  const prefixLen = 4; // 16 bits: a real prefix collision, cheap to find and unambiguous
  const target = trustedHex.slice(0, prefixLen);
  let found: Pair | null = null;
  let attempts = 0;
  const started = Date.now();
  while (found === null && attempts < 3_000_000) {
    attempts += 1;
    const cand = pairInMemory();
    if (cand.fingerprint.replace('spki-sha256:', '').startsWith(target)) {
      mkdirSync(join(work, 'keys'), { recursive: true });
      const keyPath = join(work, 'keys', 'collide.key');
      writeFileSync(keyPath, cand.priv, { mode: 0o600 });
      const pubPath = join(work, 'keys', 'collide.pub');
      writeFileSync(pubPath, cand.pub);
      found = { key: keyPath, pub: pubPath, fingerprint: cand.fingerprint };
    }
  }
  const collide = found;
  if (collide === null) {
    record('vii. fingerprint prefix collision', { error: 'no collision found', attempts });
  } else {
    const before = snapshot(dataDir);
    const dir = pkg('prefix-collision');
    const rep = reportFor(dir);
    const sig = join(dir, '..', 'prefix-collision.sig.json');
    signTool(['--dir', dir, '--key', collide.key, '--publisher', 'acme-labs', '--out', sig]);
    const run = skwctl(['plugin', 'install', dir, '--tenant', 'acme', '--test-report', rep, '--signature', sig, '--runner-digest', RUNNER, '--enable'], env);
    const after = snapshot(dataDir);
    // and the harsher form: claim the trusted key_id verbatim, sign with the colliding key
    const sigJson = JSON.parse(readFileSync(sig, 'utf8')) as Record<string, unknown>;
    sigJson.key_id = A.fingerprint;
    writeFileSync(sig, `${JSON.stringify(sigJson, null, 2)}\n`);
    const forged = skwctl(['plugin', 'install', dir, '--tenant', 'acme', '--test-report', rep, '--signature', sig, '--runner-digest', RUNNER, '--enable'], env);
    const afterForged = snapshot(dataDir);
    record('vii. fingerprint prefix collision', {
      trusted_prefix: `${target}… (${prefixLen} hex / ${prefixLen * 4} bits)`,
      trusted_fingerprint: A.fingerprint,
      colliding_fingerprint: collide.fingerprint,
      attempts,
      seconds: ((Date.now() - started) / 1000).toFixed(1),
      exit: run.status,
      refusal: `${run.stdout}${run.stderr}`.trim().split('\n').filter((l) => l.includes('SKW_E_') || l.includes('REFUSAL')).join('\n'),
      state_unchanged: same(before, after),
      forged_key_id_exit: forged.status,
      forged_key_id_refusal: `${forged.stdout}${forged.stderr}`.trim().split('\n').filter((l) => l.includes('SKW_E_') || l.includes('REFUSAL')).join('\n'),
      forged_state_unchanged: same(after, afterForged),
    });
  }
}

// --- extra: an unsigned package that self-declares a trusted publisher --------------------
{
  const dir = pkg('spoof-publisher', (d) => {
    const m = JSON.parse(readFileSync(join(d, 'plugin.json'), 'utf8')) as Record<string, unknown>;
    m.publisher = { id: 'acme-labs' };
    writeFileSync(join(d, 'plugin.json'), `${JSON.stringify(m, null, 2)}\n`);
  });
  const rep = reportFor(dir);
  const run = skwctl(['plugin', 'install', dir, '--tenant', 'acme', '--test-report', rep, '--runner-digest', RUNNER, '--enable', '--allow-unsigned'], env);
  const snap = snapshot(dataDir);
  const row = (snap.installed as Record<string, unknown>[]).find((r) => r.plugin_id === 'notes');
  record('extra: unsigned package self-declaring a publisher', {
    exit: run.status,
    screen_lines: run.stdout.split('\n').filter((l) => /publisher|fingerprint|UNSIGNED|signature/.test(l)).join('\n'),
    row,
  });
}

writeFileSync(join(OUT, 'attacks.json'), `${JSON.stringify(results, null, 2)}\n`);
process.stdout.write(`\nWROTE ${join(OUT, 'attacks.json')}\n`);
process.stdout.write(`fixture: ${fixture.dir}\n`);
