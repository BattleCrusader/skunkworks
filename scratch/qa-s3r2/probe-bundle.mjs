#!/usr/bin/env node
/**
 * QA S3 round 2 / A.4 — **`bundle_verify`'s three refusals, with a negative control for each**,
 * plus three attempts to get a render past it.
 *
 * Every fixture is built here from scratch, so the result does not depend on the shape the
 * builder's own `B1`–`B5` chose.
 *
 *   B0   a clean bundle verifies (the control: without it every exit 12 below is vacuous)
 *   B-a  a files[] path under content/protected/            must be refused
 *   B-b  the manifest is CLEAN, the protected tree is on disk but omitted  must be refused
 *   B-c  a listed site.db carrying cms_watermark_render rows must be refused
 *   B-c0 the same DB with the table and zero rows           must PASS (the control for B-c)
 *   B-d  a symlink whose target is inside content/protected/ must be refused
 *   X-1  a files[] path written as `./content/protected/…`   must be refused (normalisation)
 *   X-2  an UNLISTED site.db carrying render rows            attack: manifest-scoped check
 *   X-3  a listed DB with render rows under a name that is not *.db/*.sqlite/*.sqlite3
 *                                                            attack: extension-scoped check
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import Database from 'better-sqlite3';

const REPO = join(dirname(new URL(import.meta.url).pathname), '..', '..');
const VERIFIER = join(REPO, 'tools', 'bundle_verify.mjs');
const root = mkdtempSync(join(tmpdir(), 'qa-bundle-'));
const out = (s) => process.stdout.write(`${s}\n`);
const sha = (b) => createHash('sha256').update(b).digest('hex');

function write(path, bytes) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

/** A site.db with the watermark table, and `rows` render rows in it. */
function makeDb(path, rows) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.prepare(
    `CREATE TABLE cms_watermark_render (id INTEGER PRIMARY KEY, asset_id INTEGER, spec_sha TEXT, bytes INTEGER, path TEXT, expires_at TEXT)`,
  ).run();
  for (let i = 0; i < rows; i += 1) {
    db.prepare(`INSERT INTO cms_watermark_render (asset_id, spec_sha, bytes, path, expires_at) VALUES (1,?,?,?,?)`).run(
      `s${i}`,
      10,
      `content/protected/wm/s${i}/x.pdf`,
      '2026-10-21T00:00:00.000Z',
    );
  }
  db.close();
}

function verify(name, dir) {
  const res = spawnSync(process.execPath, [VERIFIER, '--bundle', dir], { encoding: 'utf8' });
  const line = (res.stdout + res.stderr)
    .trim()
    .split('\n')
    .filter((l) => l.trim() !== '')
    .join(' | ');
  out(`${name}: exit ${res.status}  ${line.slice(0, 220)}`);
  return res.status;
}

function bundle(label, build) {
  const dir = join(root, label);
  mkdirSync(dir, { recursive: true });
  const listed = build(dir);
  writeFileSync(join(dir, 'BUNDLE.json'), JSON.stringify({ files: listed }, null, 2));
  return dir;
}

// ---- B0: the control --------------------------------------------------------------
const cleanDir = bundle('B0-clean', (dir) => {
  const a = Buffer.from('public bytes');
  const b = Buffer.from('media bytes');
  write(join(dir, 'content/public/home.txt'), a);
  write(join(dir, 'content/media/aa/deadbeef.bin'), b);
  return [
    { path: 'content/public/home.txt', sha256: sha(a) },
    { path: 'content/media/aa/deadbeef.bin', sha256: sha(b) },
  ];
});
verify('B0  clean bundle                          ', cleanDir);

// ---- B-a: a files[] path under content/protected/ ---------------------------------
const baDir = bundle('Ba-listed-render', (dir) => {
  const r = Buffer.from('%PDF render bytes');
  write(join(dir, 'content/protected/wm/spec1/aa.pdf'), r);
  const a = Buffer.from('public bytes');
  write(join(dir, 'content/public/home.txt'), a);
  return [
    { path: 'content/public/home.txt', sha256: sha(a) },
    { path: 'content/protected/wm/spec1/aa.pdf', sha256: sha(r) },
  ];
});
verify('B-a files[] names content/protected/…   ', baDir);

// ---- B-b: clean manifest, protected tree on disk but omitted ----------------------
const bbDir = bundle('Bb-omitted-tree', (dir) => {
  const a = Buffer.from('public bytes');
  write(join(dir, 'content/public/home.txt'), a);
  write(join(dir, 'content/protected/wm/spec2/bb.pdf'), Buffer.from('%PDF omitted'));
  return [{ path: 'content/public/home.txt', sha256: sha(a) }];
});
verify('B-b clean manifest, protected dir dropped', bbDir);

// ---- B-c and its control ---------------------------------------------------------
const dbRowsDir = bundle('Bc-db-rows', (dir) => {
  makeDb(join(dir, 'tenants/acme/site.db'), 2);
  const a = Buffer.from('public bytes');
  write(join(dir, 'content/public/home.txt'), a);
  return [
    { path: 'content/public/home.txt', sha256: sha(a) },
    { path: 'tenants/acme/site.db', sha256: sha(readFileSync(join(dir, 'tenants/acme/site.db'))) },
  ];
});
verify('B-c listed site.db with 2 render rows    ', dbRowsDir);

const dbEmptyDir = bundle('Bc0-db-empty', (dir) => {
  makeDb(join(dir, 'tenants/acme/site.db'), 0);
  const a = Buffer.from('public bytes');
  write(join(dir, 'content/public/home.txt'), a);
  return [
    { path: 'content/public/home.txt', sha256: sha(a) },
    { path: 'tenants/acme/site.db', sha256: sha(readFileSync(join(dir, 'tenants/acme/site.db'))) },
  ];
});
verify('B-c0 listed site.db, table only, 0 rows  ', dbEmptyDir);

// ---- B-d: a symlink into content/protected/ --------------------------------------
const bdDir = join(root, 'Bd-symlink');
mkdirSync(join(bdDir, 'content/public'), { recursive: true });
mkdirSync(join(bdDir, 'content/protected/wm/spec3'), { recursive: true });
write(join(bdDir, 'content/protected/wm/spec3/cc.pdf'), Buffer.from('%PDF real'));
write(join(bdDir, 'content/public/home.txt'), Buffer.from('public bytes'));
symlinkSync(join(bdDir, 'content/protected/wm/spec3/cc.pdf'), join(bdDir, 'content/public/sneaky.pdf'));
writeFileSync(
  join(bdDir, 'BUNDLE.json'),
  JSON.stringify({
    files: [
      { path: 'content/public/home.txt', sha256: sha(Buffer.from('public bytes')) },
      { path: 'content/public/sneaky.pdf', sha256: sha(Buffer.from('%PDF real')) },
    ],
  }),
);
verify('B-d symlink into content/protected/      ', bdDir);

// ---- X-1: `./content/protected/…` in files[] ------------------------------------
const x1Dir = bundle('X1-dot-slash', (dir) => {
  const r = Buffer.from('%PDF render bytes');
  write(join(dir, 'content/protected/wm/spec4/dd.pdf'), r);
  const a = Buffer.from('public bytes');
  write(join(dir, 'content/public/home.txt'), a);
  return [
    { path: './content/public/home.txt', sha256: sha(a) },
    { path: './content/protected/wm/spec4/dd.pdf', sha256: sha(r) },
  ];
});
verify('X-1 files[] uses ./content/protected/…  ', x1Dir);

// ---- X-2: an UNLISTED database carrying render rows -----------------------------
const x2Dir = join(root, 'X2-unlisted-db');
mkdirSync(join(x2Dir, 'content/public'), { recursive: true });
write(join(x2Dir, 'content/public/home.txt'), Buffer.from('public bytes'));
makeDb(join(x2Dir, 'tenants/acme/site.db'), 3);
writeFileSync(
  join(x2Dir, 'BUNDLE.json'),
  JSON.stringify({ files: [{ path: 'content/public/home.txt', sha256: sha(Buffer.from('public bytes')) }] }),
);
verify('X-2 UNLISTED site.db with 3 render rows ', x2Dir);

// ---- X-3: a listed DB with rows under a non-database name -----------------------
const x3Dir = bundle('X3-other-extension', (dir) => {
  makeDb(join(dir, 'tenants/acme/site'), 2);
  const a = Buffer.from('public bytes');
  write(join(dir, 'content/public/home.txt'), a);
  return [
    { path: 'content/public/home.txt', sha256: sha(a) },
    { path: 'tenants/acme/site', sha256: sha(readFileSync(join(dir, 'tenants/acme/site'))) },
  ];
});
verify('X-3 listed DB with rows named "site"    ', x3Dir);

const x4Dir = bundle('X4-wal-suffix', (dir) => {
  makeDb(join(dir, 'tenants/acme/site.db.bak'), 2);
  const a = Buffer.from('public bytes');
  write(join(dir, 'content/public/home.txt'), a);
  return [
    { path: 'content/public/home.txt', sha256: sha(a) },
    { path: 'tenants/acme/site.db.bak', sha256: sha(readFileSync(join(dir, 'tenants/acme/site.db.bak'))) },
  ];
});
verify('X-4 listed DB with rows named .db.bak    ', x4Dir);

rmSync(root, { recursive: true, force: true });
