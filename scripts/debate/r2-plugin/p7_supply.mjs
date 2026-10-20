// R2.5 plugin probe 7 — the supply-chain cost: sign, verify, hash a package, refuse a bad one.
//
// Run: node scripts/debate/r2-plugin/p7_supply.mjs
import { generateKeyPairSync, sign, verify, createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WORK = process.env.SK_PLUGIN_WORK ||
  path.join(os.homedir(), '.hermes/profiles/ceo/cache/scratch/pluginprobe/work');
const PKG = path.join(WORK, 'pkg');
fs.rmSync(PKG, { recursive: true, force: true });
fs.mkdirSync(path.join(PKG, 'dist'), { recursive: true });

// a realistic-ish package: 200 files, 600 KB total
for (let i = 0; i < 200; i++) {
  fs.writeFileSync(path.join(PKG, 'dist', `m${i}.mjs`),
    `export const n=${i};\n` + `// ${'x'.repeat(2800)}\n`);
}
const files = [];
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
  const p = path.join(d, e.name);
  if (e.isDirectory()) walk(p); else files.push(path.relative(PKG, p));
});
walk(PKG);

const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const t0 = process.hrtime.bigint();
const hashes = files.map((f) => [f, sha(fs.readFileSync(path.join(PKG, f)))]);
const t1 = process.hrtime.bigint();
console.log(`hash ${files.length} files (${files.reduce((n, f) => n + fs.statSync(path.join(PKG, f)).size, 0)} B): ${(Number(t1 - t0) / 1e6).toFixed(1)} ms`);

// Merkle-ish root: sorted path\0hash lines, hashed once
const root = sha(Buffer.from(hashes.sort(([a], [b]) => (a < b ? -1 : 1)).map(([f, h]) => `${f}\0${h}`).join('\n')));
console.log(`package root ${root.slice(0, 16)}…`);

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const sigOf = (msg) => sign(null, Buffer.from(msg), privateKey);
const t2 = process.hrtime.bigint();
let sig;
for (let i = 0; i < 1000; i++) sig = sign(null, Buffer.from(root), privateKey);
const t3 = process.hrtime.bigint();
console.log(`ed25519 sign: ${(Number(t3 - t2) / 1000 / 1000).toFixed(1)} us per signature`);
const t4 = process.hrtime.bigint();
let ok;
for (let i = 0; i < 1000; i++) ok = verify(null, Buffer.from(root), publicKey, sig);
const t5 = process.hrtime.bigint();
console.log(`ed25519 verify: ${(Number(t5 - t4) / 1000 / 1000).toFixed(1)} us per signature, accepted=${ok}`);

console.log(`signature ${sig.length} B, public key ${publicKey.export({ type: 'spki', format: 'der' }).length} B (SPKI DER)`);

// tamper: one byte in one file
const victim = path.join(PKG, 'dist', 'm7.mjs');
const before = fs.readFileSync(victim);
fs.writeFileSync(victim, Buffer.concat([before, Buffer.from('// backdoor\n')]));
const t6 = process.hrtime.bigint();
const reHashes = files.map((f) => [f, sha(fs.readFileSync(path.join(PKG, f)))]);
const reRoot = sha(Buffer.from(reHashes.sort(([a], [b]) => (a < b ? -1 : 1)).map(([f, h]) => `${f}\0${h}`).join('\n')));
const t7 = process.hrtime.bigint();
const stillValid = verify(null, Buffer.from(reRoot), publicKey, sig);
console.log(`tamper one file: root changed=${reRoot !== root}, signature still valid=${stillValid}, rehash ${(Number(t7 - t6) / 1e6).toFixed(1)} ms`);

// per-file check catches it without the root: which file
const tampered = files.filter((f, i) => hashes[i] && hashes[i][1] !== sha(fs.readFileSync(path.join(PKG, f))));
console.log(`per-file diff names the tampered path: ${JSON.stringify(tampered)}`);

// revocation: a signed list of roots
const revoked = [root.replace(/.$/, '0')];
console.log(`revocation lookup over ${revoked.length} root(s): ${revoked.includes(reRoot) ? 'revoked' : 'not revoked'} (exact-match set, O(1))`);
