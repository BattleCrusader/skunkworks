/**
 * Made to Ship — build the theme package from `theme/`.
 *
 * `theme/` is the source a person edits: `theme.css` plus `assets/`. This script runs the product's
 * own package builder over it, which does the two things a hand-written manifest gets wrong:
 *
 *   - it rewrites every relative `url(assets/…)` into the canonical form the uploader stores, and
 *     refuses a reference to a file the package does not carry;
 *   - it computes the manifest's sha256 for the sheet and every asset, so `skw-theme import` can
 *     prove the bytes on disk are the bytes that were built.
 *
 * The result is written to `dist/theme/` — **not** back into `theme/`. The builder's canonical
 * sheet differs from the source by quote style and URL normalisation, so writing the manifest
 * beside the un-canonicalised source is a package that disagrees with itself, and the importer
 * refuses it by name (`SKW_E_EXP_THEME_DIGEST`). Editing stays in `theme/`; the package is output.
 *
 *     node --no-warnings --experimental-strip-types sites/madetoship/build.ts
 *     node --no-warnings --experimental-strip-types app/cli/theme.ts import sites/madetoship/dist/theme \
 *       --data-dir data --replace
 *     node --no-warnings --experimental-strip-types app/cli/theme.ts activate madetoship \
 *       --tenant madetoship --data-dir data --replace --force
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildThemePackage } from '../../app/themes/package.ts';

const here = dirname(fileURLToPath(import.meta.url));
const themeDir = join(here, 'theme');
const assetsDir = join(themeDir, 'assets');
const outDir = join(here, 'dist', 'theme');

const assets: { path: string; bytes: Buffer }[] = [];
for (const name of readdirSync(assetsDir).sort()) {
  const path = join(assetsDir, name);
  if (!statSync(path).isFile()) continue;
  assets.push({ path: `assets/${name}`, bytes: readFileSync(path) });
}

const pkg = buildThemePackage({
  key: 'madetoship',
  name: 'Made to Ship',
  version: '1.0.0',
  css: readFileSync(join(themeDir, 'theme.css'), 'utf8'),
  assets,
  now: new Date().toISOString(),
});

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
for (const file of pkg.files) {
  const target = join(outDir, file.path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, file.bytes);
}

const bytes = pkg.files.reduce((sum, file) => sum + file.bytes.length, 0);
process.stdout.write(
  `theme package: ${pkg.manifest.key} v${pkg.manifest.version} -> ${outDir} — ${String(pkg.assets.length)} asset(s), ` +
    `${String(bytes)} B, css ${pkg.manifest.css.sha256.slice(0, 12)} (${String(pkg.manifest.css.bytes)} B), ` +
    `${String(pkg.files.length)} file(s)\n`,
);
