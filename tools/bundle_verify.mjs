#!/usr/bin/env node
/**
 * Bundle verification — SDS §11.3/§11.6 and §16 S3 row 9: every file's sha256, every
 * symlink target inside the bundle, and **no render, ever**.
 *
 * A bundle without `BUNDLE.json`, or with a file whose sha256 does not match, is refused
 * with exit 12.
 *
 * **Row 9's second half (E-26/E-28; S3-6).** "a render … never appears in a bundle" was
 * nobody's job: this verifier checked hashes and had no notion of an excluded tree, so a
 * bundle carrying `content/protected/wm/…` verified clean (exit 0, "1 file(s) verified").
 * It now refuses, on three independent signals, because a manifest is a claim and the three
 * can disagree:
 *
 *   1. a `files[]` path that is or is under `content/protected/`;
 *   2. a `content/protected/` directory anywhere in the bundle tree, even when the manifest
 *      omits it — an omission is the more likely shape of the mistake;
 *   3. a SQLite database inside the bundle with **rows** in `cms_watermark_render`. The table
 *      existing is not a refusal: every `site.db` has the table in its schema and most have
 *      no rows. A verifier that refused the schema would refuse every real bundle.
 *
 * **The bundle writer is S4.** This closes the verifier half only: nothing in this tree
 * produces a bundle, so the exclusion is still a rule with no author. What is now true is
 * that a bundle which breaks the rule cannot pass `install.sh --verify`.
 *
 * Two shapes are accepted for `files`, because the export writer (S4) is not the authority
 * here: an array of `{path, sha256}` or a map of `path -> sha256`. Anything else is a
 * refusal, not a guess.
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, normalize, relative, sep } from 'node:path';

const require = createRequire(import.meta.url);

const args = process.argv.slice(2);
const i = args.indexOf('--bundle');
const bundle = i === -1 ? '.' : (args[i + 1] ?? '.');
const manifestPath = join(bundle, 'BUNDLE.json');

/** The excluded tree, stated once. `content/protected` is the whole second root, not only `wm/`. */
const PROTECTED = 'content/protected';

function refuse(message) {
  process.stderr.write(`bundle_verify: REFUSAL: ${message}\n`);
  process.exit(12);
}

if (!existsSync(manifestPath)) refuse(`no BUNDLE.json at ${manifestPath}`);

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
} catch (err) {
  refuse(`BUNDLE.json is not JSON: ${String(err)}`);
}

function entries(raw) {
  if (Array.isArray(raw)) {
    return raw.map((f) => ({ path: f.path, sha256: f.sha256 }));
  }
  if (raw !== null && typeof raw === 'object') {
    return Object.entries(raw).map(([path, sha256]) => ({ path, sha256 }));
  }
  return [];
}

const files = entries(manifest.files);
if (files.length === 0) refuse('BUNDLE.json carries no files[]; a bundle with nothing to verify is not a bundle');

/** `content/protected` and everything under it. Windows separators are normalised first. */
function isProtected(relPath) {
  const posix = relPath.split(sep).join('/');
  return posix === PROTECTED || posix.startsWith(`${PROTECTED}/`);
}

/**
 * Rows in `cms_watermark_render`, or 0. `null` means the file is not a database we could
 * open — and a database we cannot read is a refusal, not a pass: the check is the reason
 * this file exists.
 */
function renderRows(path) {
  let Database;
  try {
    // Lazy, because a bundle with no database in it must verify on a box where the native
    // module has not been built yet.
    Database = require('better-sqlite3');
  } catch (err) {
    return { rows: null, why: `better-sqlite3 is not installed, so the render table cannot be read (${String(err)})` };
  }
  try {
    const db = new Database(path, { readonly: true, fileMustExist: true });
    try {
      const table = db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cms_watermark_render'`)
        .get();
      if (table === undefined) return { rows: 0, why: '' };
      const n = Number(db.prepare(`SELECT COUNT(*) AS n FROM cms_watermark_render`).get().n);
      return { rows: n, why: '' };
    } finally {
      db.close();
    }
  } catch (err) {
    return { rows: null, why: `the database could not be read: ${String(err)}` };
  }
}

let checked = 0;
for (const file of files) {
  if (typeof file.path !== 'string' || typeof file.sha256 !== 'string') refuse('a files[] entry is not {path, sha256}');
  // A path that escapes the bundle is the one thing a manifest must never do.
  const normalised = normalize(file.path);
  if (normalised.startsWith('..') || normalised.includes(`..${sep}`)) refuse(`path escapes the bundle: ${file.path}`);
  // Row 9: a render has no business in a bundle, and its path says so before its bytes do.
  if (isProtected(normalised.split(sep).join('/'))) {
    refuse(`a bundle must never contain a render: ${file.path} is under ${PROTECTED}/ (§16 S3 row 9)`);
  }
  const full = join(bundle, normalised);
  if (!existsSync(full)) refuse(`missing file: ${file.path}`);
  // `lstatSync`, not `statSync`: the latter follows the link and would report the target's
  // type, so the symlink branch below could never run — which is why this file's symlink
  // check was dead code until row 9 gave it a reason to fire.
  const stat = lstatSync(full);
  if (stat.isSymbolicLink()) {
    const target = readlinkSync(full);
    // Resolved properly, because `readlinkSync` returns the target as written and an
    // absolute target would otherwise normalise into nonsense.
    const resolved = isAbsolute(target) ? normalize(target) : normalize(join(dirname(full), target));
    const posix = resolved.split(sep).join('/');
    if (posix.includes(`/${PROTECTED}/`) || posix.endsWith(`/${PROTECTED}`)) {
      refuse(`a symlink into ${PROTECTED}/ is a render in the bundle: ${file.path} -> ${target}`);
    }
    const rel = relative(bundle, resolved);
    if (rel.startsWith('..') || isAbsolute(rel)) refuse(`symlink escapes the bundle: ${file.path} -> ${target}`);
  }
  const bytes = readFileSync(full);
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== file.sha256.toLowerCase()) refuse(`sha256 mismatch: ${file.path}`);
  if (/\.(db|sqlite|sqlite3)$/i.test(normalised)) {
    const { rows, why } = renderRows(full);
    if (rows === null) refuse(`cannot prove ${file.path} carries no render rows: ${why}`);
    if (rows > 0) refuse(`${file.path} carries ${rows} cms_watermark_render row(s); a render never appears in a bundle`);
  }
  checked += 1;
}

/**
 * The tree, not only the manifest. A writer whose manifest is built from a walk will include
 * a render; a writer that names its files explicitly will not, and a stray directory is the
 * shape of the mistake that gets past a manifest-only check.
 */
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (isProtected(relative(bundle, full).split(sep).join('/'))) {
        refuse(`the bundle tree contains ${relative(bundle, full)}/ — a render tree is never exported (§16 S3 row 9)`);
      }
      walk(full);
    }
  }
}
walk(bundle);

process.stdout.write(`bundle_verify: ${checked} file(s) verified, no render tree, no render rows\n`);
