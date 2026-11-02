/**
 * The theme package, proved by round trip.
 *
 * The three claims that matter are behavioural, not structural: a package this code writes is one
 * it reads back to the same bytes; a package that lies about itself is refused by name; and the
 * stored (absolute) sheet and the package (relative) sheet are inverses of each other, so a theme
 * can leave a tenant and come back without drifting.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AppError } from '../app/errors.ts';
import { rewriteAssetUrls } from '../app/render/theme-bundle.ts';
import {
  THEME_MANIFEST_FILE,
  THEME_PACKAGE_SCHEMA,
  THEME_SHEET_FILE,
  absolutiseCss,
  buildThemePackage,
  packagePathProblem,
  readThemePackage,
  readThemePackageZip,
  relativiseCss,
  sha256Of,
  type ThemePackage,
} from '../app/themes/package.ts';
import { zipOf } from './helpers/zip-maker.ts';

const NOW = '2026-10-29T00:00:00.000Z';
const HERO = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#a8451c"/></svg>',
  'utf8',
);
const FACE = Buffer.from('wOF2-not-really-a-font-but-binary', 'latin1');
const RELATIVE_CSS = [
  'body{background:url(assets/hero.svg)}',
  '@font-face{font-family:x;src:url("assets/face.woff2") format("woff2")}',
  '.s-probe{color:#123456}',
  '',
].join('\n');

function build(): ThemePackage {
  return buildThemePackage({
    key: 'acme-kit',
    name: 'Acme kit',
    css: RELATIVE_CSS,
    assets: [
      { path: 'assets/hero.svg', bytes: HERO },
      { path: 'assets/face.woff2', bytes: FACE },
    ].reverse(),
    now: NOW,
  });
}

function refusal(fn: () => unknown): AppError {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof AppError, `expected an AppError, got ${String(err)}`);
    return err;
  }
  assert.fail('expected a refusal, and nothing was thrown');
}

test('T1 — the package is the three files a person would unzip, with a manifest that matches them', () => {
  const pkg = build();
  assert.deepEqual(
    pkg.files.map((file) => file.path),
    ['theme.json', THEME_SHEET_FILE, 'assets/face.woff2', 'assets/hero.svg'],
    'the package must be the manifest, the sheet, then the assets in a stable order',
  );
  assert.equal(pkg.manifest.schema, THEME_PACKAGE_SCHEMA);
  assert.equal(pkg.manifest.key, 'acme-kit');
  const sheet = pkg.files.find((file) => file.path === THEME_SHEET_FILE);
  assert.ok(sheet !== undefined, 'the package has no theme.css');
  assert.equal(pkg.manifest.css.sha256, sha256Of(sheet.bytes));
  assert.deepEqual(
    pkg.manifest.assets.map((asset) => asset.path),
    ['assets/face.woff2', 'assets/hero.svg'],
  );
  const hero = pkg.manifest.assets.find((asset) => asset.path === 'assets/hero.svg');
  assert.equal(hero?.sha256, sha256Of(HERO));
  assert.equal(hero?.bytes, HERO.length);
  assert.equal(hero?.content_type, 'image/svg+xml');
});

test('T2 — a package read back is the package written: same manifest, same bytes', () => {
  const written = build();
  const read = readThemePackage(written.files);
  assert.deepEqual(read.manifest, written.manifest);
  assert.equal(read.css, written.css);
  for (const file of written.files) {
    const again = read.files.find((candidate) => candidate.path === file.path);
    assert.ok(again !== undefined, `${file.path} vanished on the way back`);
    assert.equal(sha256Of(again.bytes), sha256Of(file.bytes), `${file.path} changed on the way back`);
  }
});

test('T3 — the same package inside a zip reads identically (deflated and stored)', () => {
  const written = build();
  for (const deflate of [false, true]) {
    const zip = zipOf(written.files.map((file) => ({ name: file.path, bytes: file.bytes, deflate })));
    const read = readThemePackageZip(zip);
    assert.deepEqual(read.manifest, written.manifest, `deflate=${String(deflate)}`);
    assert.equal(read.css, written.css);
  }
});

test('T4 — the stored sheet and the package sheet are inverses, in both directions', () => {
  const pkg = build();
  const stored = absolutiseCss(pkg);
  // What a tenant stores names the theme key and the checksum, and every asset it carries.
  assert.match(stored, /url\("\/_theme\/acme-kit\/assets\/hero\.svg\?v=[0-9a-f]{8}"\)/);
  assert.match(stored, /url\("\/_theme\/acme-kit\/assets\/face\.woff2\?v=[0-9a-f]{8}"\)/);
  // …and relativising it gives back exactly the bytes the package shipped.
  assert.equal(relativiseCss(stored, 'acme-kit'), pkg.css);
  // A second pass changes nothing: the rewrite is idempotent once relative.
  assert.equal(relativiseCss(pkg.css, 'acme-kit'), pkg.css);
});

test('T5 — a byte flipped in an asset is refused by name, and names the file', () => {
  const written = build();
  const tampered = written.files.map((file) =>
    file.path === 'assets/hero.svg' ? { path: file.path, bytes: Buffer.from('tampered', 'utf8') } : file,
  );
  const err = refusal(() => readThemePackage(tampered));
  assert.equal(err.code, 'SKW_E_EXP_THEME_DIGEST');
  assert.equal((err.detail as { path?: string }).path, 'assets/hero.svg');
});

test('T5b — a byte flipped in the sheet is refused too', () => {
  const written = build();
  const tampered = written.files.map((file) =>
    file.path === THEME_SHEET_FILE
      ? { path: file.path, bytes: Buffer.from(`${file.bytes.toString('utf8')}.extra{color:red}\n`, 'utf8') }
      : file,
  );
  const err = refusal(() => readThemePackage(tampered));
  assert.equal(err.code, 'SKW_E_EXP_THEME_DIGEST');
  assert.equal((err.detail as { path?: string }).path, THEME_SHEET_FILE);
});

test('T6 — a path that climbs out of the package is refused before anything is written', () => {
  assert.equal(packagePathProblem('../etc/passwd'), 'a path with an empty or relative segment');
  assert.equal(packagePathProblem('/etc/passwd'), 'an absolute path');
  assert.equal(packagePathProblem('assets\\hero.svg'), 'a backslash (zip paths are POSIX)');
  assert.equal(packagePathProblem('assets/./hero.svg'), 'a path with an empty or relative segment');
  assert.equal(packagePathProblem('assets/hero.svg'), null);

  const written = build();
  const withEscape = [...written.files, { path: 'assets/../../escape.txt', bytes: Buffer.from('x') }];
  const err = refusal(() => readThemePackage(withEscape));
  assert.equal(err.code, 'SKW_E_EXP_THEME_PATH');
});

test('T7 — an unknown schema is its own refusal, not a parse error', () => {
  const written = build();
  const manifestFile = written.files.find((file) => file.path === THEME_MANIFEST_FILE);
  assert.ok(manifestFile !== undefined, 'the package has no theme.json');
  const manifest = JSON.parse(manifestFile.bytes.toString('utf8')) as Record<string, unknown>;
  manifest.schema = 'skunkworks/theme/v2';
  const files = written.files.map((file, index) =>
    index === 0 ? { path: file.path, bytes: Buffer.from(JSON.stringify(manifest), 'utf8') } : file,
  );
  const err = refusal(() => readThemePackage(files));
  assert.equal(err.code, 'SKW_E_EXP_THEME_SCHEMA');
});

test('T8 — a stylesheet that references a file the package does not carry is refused', () => {
  const err = refusal(() =>
    buildThemePackage({
      key: 'acme-kit',
      name: 'Acme kit',
      css: 'body{background:url(assets/missing.png)}\n',
      assets: [{ path: 'assets/hero.svg', bytes: HERO }],
      now: NOW,
    }),
  );
  assert.equal(err.code, 'SKW_E_EXP_THEME_REF');
  assert.equal((err.detail as { path?: string }).path, 'assets/missing.png');
});

test('T8b — absolute, data and fragment references are not the package\'s business', () => {
  const pkg = buildThemePackage({
    key: 'acme-kit',
    name: 'Acme kit',
    css: [
      'body{background:url(https://cdn.example/x.png)}',
      '.a{background:url(data:image/gif;base64,R0lGOD)}',
      '.b{background:url(#gradient)}',
      '.c{background:url(//other.example/y.png)}',
      '',
    ].join('\n'),
    assets: [],
    now: NOW,
  });
  assert.equal(pkg.assets.length, 0);
});

test('T9 — a file in the package that the manifest never declared is refused', () => {
  const written = build();
  const extra = [...written.files, { path: 'assets/smuggled.svg', bytes: HERO }];
  const err = refusal(() => readThemePackage(extra));
  assert.equal(err.code, 'SKW_E_EXP_THEME_EXTRA');
  assert.equal((err.detail as { path?: string }).path, 'assets/smuggled.svg');
});

test('T10 — a theme may not carry code: an html file is refused by name', () => {
  const err = refusal(() =>
    buildThemePackage({
      key: 'acme-kit',
      name: 'Acme kit',
      css: 'body{color:red}\n',
      assets: [{ path: 'assets/evil.html', bytes: Buffer.from('<script>alert(1)</script>') }],
      now: NOW,
    }),
  );
  assert.equal(err.code, 'SKW_E_EXP_THEME_PATH');
  assert.equal((err.detail as { path?: string }).path, 'assets/evil.html');
});

test('T11 — a key that is not a key, or a name with nothing in it, is refused', () => {
  const bad = refusal(() =>
    buildThemePackage({ key: 'Acme Kit', name: 'x', css: '', assets: [], now: NOW }),
  );
  assert.equal(bad.code, 'SKW_E_EXP_THEME_KEY');
  const nameless = refusal(() => buildThemePackage({ key: 'acme-kit', name: '   ', css: '', assets: [], now: NOW }));
  assert.equal(nameless.code, 'SKW_E_EXP_THEME_KEY');
});

test('T12 — building from a stored sheet relativises it, so a tenant can export what it serves', () => {
  const pkg = build();
  const stored = absolutiseCss(pkg);
  const fromStored = buildThemePackage({
    key: 'acme-kit',
    name: 'Acme kit',
    css: stored,
    assets: pkg.assets.map((asset) => ({ path: asset.path, bytes: asset.bytes })),
    now: NOW,
  });
  assert.equal(fromStored.css, pkg.css, 'a tenant exporting its own stored sheet must reproduce the package sheet');
  assert.deepEqual(fromStored.manifest.assets, pkg.manifest.assets);
});

test('T13 — the manifest is a function of the bytes only: two builds at one clock are identical', () => {
  const a = build();
  const b = build();
  assert.equal(
    a.files.map((file) => `${file.path}:${sha256Of(file.bytes)}`).join('|'),
    b.files.map((file) => `${file.path}:${sha256Of(file.bytes)}`).join('|'),
  );
});

test('T14 — rewriteAssetUrls and relativiseCss agree about what a package owns', () => {
  // The upload door's rewrite and this module's inverse share one definition of a package
  // reference. If they ever disagree, an exported theme would grow a `/_theme/…` URL and stop
  // being portable; this pins them to each other.
  const assets = [
    { path: 'assets/hero.svg', bytes: HERO, contentType: 'image/svg+xml', sha256: sha256Of(HERO) },
  ];
  const stored = rewriteAssetUrls(RELATIVE_CSS, 'acme-kit', assets);
  assert.match(stored, /\/_theme\/acme-kit\/assets\/hero\.svg\?v=/);
  assert.equal(relativiseCss(stored, 'acme-kit').includes('/_theme/'), false);
});
