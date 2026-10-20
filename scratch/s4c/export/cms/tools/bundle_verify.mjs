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
import { dirname, isAbsolute, join, normalize, relative, sep } from 'node:path';

/**
 * SQLite, through `node:sqlite` — the SQLite **inside the Node the bundle already
 * requires**. Before S4c this file lazy-required `better-sqlite3`, which meant the
 * verifier refused every bundle on a host without a compiler (or silently had no notion
 * of the render table at all). A verifier that runs only where the product's native
 * module was built is a verifier that never runs on the host that matters.
 */
let SQLite;
try {
  ({ DatabaseSync: SQLite } = await import('node:sqlite'));
} catch (err) {
  process.stderr.write(`bundle_verify: REFUSAL: node:sqlite is not available (${String(err)})\n`);
  process.exit(12);
}

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
 * Rows in `cms_watermark_render`, or a refusal. A database we cannot read is not a pass:
 * the check is the reason this file exists.
 */
function renderRows(path) {
  let db;
  try {
    db = new SQLite(path, { readOnly: true });
  } catch (err) {
    refuse(`cannot open ${path}: ${String(err)}`);
  }
  try {
    const table = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cms_watermark_render'`).get();
    if (table === undefined) return 0;
    return Number(db.prepare(`SELECT COUNT(*) AS n FROM cms_watermark_render`).get().n);
  } finally {
    db.close();
  }
}

/**
 * S4c: every `cms_plugin_installed` row needs its package under `plugins/<id>/`.
 *
 * The row is the claim; the package is the code. A bundle that ships one without the
 * other installs a site whose plugin tables exist and whose widget 500s on first render.
 * All violations are returned so one install names all of them.
 */
function pluginsWithoutPackages(path) {
  let db;
  try {
    db = new SQLite(path, { readOnly: true });
  } catch (err) {
    refuse(`cannot open ${path}: ${String(err)}`);
  }
  try {
    const table = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cms_plugin_installed'`)
      .get();
    if (table === undefined) return [];
    const rows = db.prepare('SELECT id, plugin_id FROM cms_plugin_installed ORDER BY id').all();
    const missing = [];
    for (const row of rows) {
      const pkg = join(bundle, 'plugins', String(row.plugin_id), 'plugin.json');
      if (!existsSync(pkg)) missing.push({ id: Number(row.id), plugin: String(row.plugin_id) });
    }
    return missing;
  } finally {
    db.close();
  }
}

// --- 0. the seed describes the schema it will be applied to (S4c) ----------------
// `data/control.seed.json` said `schema_version: 3` while `schema/control.sql` declared
// `PRAGMA user_version = 4`, and nothing read either (S4b report §9.1). A verifier is the
// one place where two files that disagree can be compared *before* anything is created.
const seedPath = join(bundle, 'data', 'control.seed.json');
const controlSql = join(bundle, 'schema', 'control.sql');
if (existsSync(seedPath)) {
  if (!existsSync(controlSql)) refuse('data/control.seed.json is present but schema/control.sql is not; the seed cannot be checked');
  const seed = JSON.parse(readFileSync(seedPath, 'utf8'));
  const declared = /PRAGMA\s+user_version\s*=\s*(\d+)/i.exec(readFileSync(controlSql, 'utf8'));
  if (declared === null) refuse('schema/control.sql declares no PRAGMA user_version');
  const schemaVersion = Number(declared[1]);
  if (seed.schema_version !== schemaVersion) {
    refuse(
      `data/control.seed.json says schema_version ${String(seed.schema_version)} but schema/control.sql declares ${String(schemaVersion)}` +
        ' — a bundle whose seed and schema disagree seeds a database it cannot describe',
    );
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
    const rows = renderRows(full);
    if (rows > 0) refuse(`${file.path} carries ${rows} cms_watermark_render row(s); a render never appears in a bundle`);
    const missing = pluginsWithoutPackages(full);
    if (missing.length > 0) {
      refuse(
        `${file.path}: ${missing
          .map((m) => `plugin ${m.plugin} (cms_plugin_installed row ${m.id}) has no package at plugins/${m.plugin}/`)
          .join('; ')} — a plugin row without its code is a site that fails on first render`,
      );
    }
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
