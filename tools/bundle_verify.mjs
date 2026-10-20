#!/usr/bin/env node
/**
 * Bundle verification — SDS §11.3/§11.6: every file's sha256, and every symlink
 * target inside the bundle. A bundle without `BUNDLE.json`, or with a file whose
 * sha256 does not match, is refused by `install.sh --verify` with exit 12.
 *
 * Two shapes are accepted for `files`, because the export writer (S4) is not the
 * authority here: an array of `{path, sha256}` or a map of `path -> sha256`.
 * Anything else is a refusal, not a guess.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readlinkSync, statSync } from 'node:fs';
import { join, normalize, sep } from 'node:path';

const args = process.argv.slice(2);
const i = args.indexOf('--bundle');
const bundle = i === -1 ? '.' : (args[i + 1] ?? '.');
const manifestPath = join(bundle, 'BUNDLE.json');

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

let checked = 0;
for (const file of files) {
  if (typeof file.path !== 'string' || typeof file.sha256 !== 'string') refuse('a files[] entry is not {path, sha256}');
  // A path that escapes the bundle is the one thing a manifest must never do.
  const normalised = normalize(file.path);
  if (normalised.startsWith('..') || normalised.includes(`..${sep}`)) refuse(`path escapes the bundle: ${file.path}`);
  const full = join(bundle, normalised);
  if (!existsSync(full)) refuse(`missing file: ${file.path}`);
  const stat = statSync(full);
  if (stat.isSymbolicLink()) {
    const target = readlinkSync(full);
    const resolved = normalize(join(normalised, '..', target));
    if (resolved.startsWith('..')) refuse(`symlink escapes the bundle: ${file.path} -> ${target}`);
  }
  const digest = createHash('sha256').update(readFileSync(full)).digest('hex');
  if (digest !== file.sha256.toLowerCase()) refuse(`sha256 mismatch: ${file.path}`);
  checked += 1;
}

process.stdout.write(`bundle_verify: ${checked} file(s) verified\n`);
