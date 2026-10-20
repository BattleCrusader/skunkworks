/**
 * §16 S3 row 9, second half / S3-6 — **a bundle that carries a render is refused.**
 *
 * Before this gate, `tools/bundle_verify.mjs` checked hashes and had no notion of an
 * excluded tree: QA's D5 built a bundle containing a live render under
 * `content/protected/wm/…` and the verifier answered `exit 0, "1 file(s) verified"`. The
 * reader is now three signals (protected path, protected directory in the tree, rows in
 * `cms_watermark_render`), and this file is the fixture that proves each of them red —
 * including the two shapes a manifest-only check cannot see.
 *
 * **Stated plainly: the bundle *writer* is S4.** Nothing in this tree produces a bundle, so
 * this closes the verifier half only. The row's first sentence ("a render is deleted at
 * token expiry + grace") is `W7`'s sweep; its arithmetic is `W13`'s.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';

import Database from 'better-sqlite3';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const VERIFY = join(REPO, 'tools', 'bundle_verify.mjs');
const SPEC = 'a'.repeat(64);
const SOURCE = 'b'.repeat(64);
/** The shape a render actually has: `content/protected/wm/<spec_sha>/<source_sha>.pdf`. */
const RENDER = `content/protected/wm/${SPEC}/${SOURCE}.pdf`;

let scratch = '';

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

interface Bundle {
  dir: string;
  /** Relative paths, as written. */
  files: string[];
  /** The manifest omits these (the omission case). */
  omitted?: string[];
}

/** Write a bundle: `files` gets real bytes, hashes and a BUNDLE.json entry. */
function makeBundle(name: string, files: { path: string; bytes: Buffer }[], opts: { omit?: string[] } = {}): Bundle {
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });
  const manifest: { path: string; sha256: string }[] = [];
  for (const file of files) {
    const full = join(dir, file.path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, file.bytes);
    if ((opts.omit ?? []).includes(file.path)) continue;
    manifest.push({ path: file.path, sha256: sha256(file.bytes) });
  }
  writeFileSync(join(dir, 'BUNDLE.json'), JSON.stringify({ version: 1, files: manifest }, null, 2));
  return { dir, files: files.map((f) => f.path), ...(opts.omit === undefined ? {} : { omitted: opts.omit }) };
}

function verify(dir: string): { status: number; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [VERIFY, '--bundle', dir], { cwd: REPO, encoding: 'utf8' });
  return { status: res.status ?? -1, stdout: res.stdout, stderr: res.stderr };
}

function siteDbWithRenderRows(rows: number): Buffer {
  const path = join(scratch, `site-${String(rows)}.db`);
  const db = new Database(path);
  try {
    db.exec(
      `CREATE TABLE cms_watermark_render (
         id INTEGER PRIMARY KEY,
         spec_sha TEXT NOT NULL,
         source_sha TEXT NOT NULL,
         bytes INTEGER NOT NULL,
         path TEXT NOT NULL,
         expires_at TEXT NOT NULL
       )`,
    );
    for (let i = 0; i < rows; i += 1) {
      db.prepare(
        `INSERT INTO cms_watermark_render (spec_sha, source_sha, bytes, path, expires_at)
         VALUES (?, ?, 1, ?, '2026-01-01T00:00:00.000Z')`,
      ).run(`${i}`.repeat(64).slice(0, 64), SOURCE, RENDER);
    }
  } finally {
    db.close();
  }
  return readFileSync(path);
}

before(() => {
  scratch = mkdtempSync(join(tmpdir(), 'skw-bundle-'));
});

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

test('B1 — a clean bundle verifies, and says what it checked', () => {
  const bundle = makeBundle('clean', [
    { path: 'app/main.js', bytes: Buffer.from('console.log("hello")\n') },
    { path: 'schema/site.sql', bytes: Buffer.from('CREATE TABLE t (id INTEGER);\n') },
  ]);
  const res = verify(bundle.dir);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /2 file\(s\) verified/);
  assert.match(res.stdout, /no render tree, no render rows/);
});

test('B2 — a bundle that CONTAINS a render is refused, exit 12 (the negative control QA measured as exit 0)', () => {
  const bundle = makeBundle('with-render', [
    { path: 'app/main.js', bytes: Buffer.from('console.log("hello")\n') },
    { path: RENDER, bytes: Buffer.from('%PDF-1.7 stamped for one buyer\n') },
  ]);
  const res = verify(bundle.dir);
  assert.equal(res.status, 12, `expected the refusal exit code, got ${res.status}:\n${res.stdout}`);
  assert.match(res.stderr, /REFUSAL/);
  assert.match(res.stderr, /must never contain a render/);
  assert.match(res.stderr, new RegExp(RENDER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('B3 — the render present but OMITTED from the manifest is still refused (the tree, not the claim)', () => {
  const bundle = makeBundle(
    'omitted',
    [
      { path: 'app/main.js', bytes: Buffer.from('console.log("hello")\n') },
      { path: RENDER, bytes: Buffer.from('%PDF-1.7 stamped\n') },
    ],
    { omit: [RENDER] },
  );
  const res = verify(bundle.dir);
  assert.equal(res.status, 12, `expected 12, got ${res.status}:\n${res.stdout}`);
  assert.match(res.stderr, /the bundle tree contains content\/protected/);
});

test('B4 — a symlink into content/protected/ is a render in the bundle', () => {
  // The render tree lives outside the bundle, so the tree walk cannot see it: the only
  // signal is the link's target, and that is the shape a manifest hash check never looks at.
  const outside = join(scratch, 'outside', 'content', 'protected', 'wm', SPEC);
  mkdirSync(outside, { recursive: true });
  const target = join(outside, `${SOURCE}.pdf`);
  writeFileSync(target, '%PDF-1.7 stamped\n');

  const dir = join(scratch, 'symlink');
  mkdirSync(join(dir, 'app'), { recursive: true });
  symlinkSync(target, join(dir, 'app', 'leak.pdf'));
  writeFileSync(
    join(dir, 'BUNDLE.json'),
    JSON.stringify({ files: [{ path: 'app/leak.pdf', sha256: sha256(Buffer.from('%PDF-1.7 stamped\n')) }] }),
  );
  const res = verify(dir);
  assert.equal(res.status, 12, `expected 12, got ${res.status}:\n${res.stdout}`);
  assert.match(res.stderr, /symlink into content\/protected/);
});

test('B5 — a site.db carrying render ROWS is refused; one carrying only the table is not', () => {
  const withRows = makeBundle('db-rows', [
    { path: 'app/main.js', bytes: Buffer.from('x\n') },
    { path: 'tenants/acme/site.db', bytes: siteDbWithRenderRows(1) },
  ]);
  const rows = verify(withRows.dir);
  assert.equal(rows.status, 12, `expected 12, got ${rows.status}:\n${rows.stdout}`);
  assert.match(rows.stderr, /1 cms_watermark_render row\(s\)/);

  // The table is in every site.db's schema. A verifier that refused the schema would refuse
  // every real bundle, which is why the rule is about rows.
  const empty = makeBundle('db-empty', [
    { path: 'app/main.js', bytes: Buffer.from('x\n') },
    { path: 'tenants/acme/site.db', bytes: siteDbWithRenderRows(0) },
  ]);
  const clean = verify(empty.dir);
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stdout, /2 file\(s\) verified, no render tree, no render rows/);
});
