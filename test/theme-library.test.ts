/**
 * The library and activation, against a real tenant database.
 *
 * The claims: a package installed once can be activated by more than one site; activation stores
 * exactly what the upload door stores (same blob sha, same rows, same files); a tenant can export
 * its own theme back to the same package; and the two ways to get two looks under one key — a
 * library collision and a tenant collision — are refused unless `--replace` says otherwise.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import Database from 'better-sqlite3';

import { AppError } from '../app/errors.ts';
import { openAdminWrite } from '../app/db/classes.ts';
import { themeAssetDir, themeAssetsRoot } from '../app/render/themes.ts';
import {
  activatePackage,
  exportTenantTheme,
  installPackage,
  libraryEntryDir,
  libraryRoot,
  listLibrary,
  readLibraryTheme,
  removeLibraryTheme,
} from '../app/themes/library.ts';
import { absolutiseCss, buildThemePackage, sha256Of } from '../app/themes/package.ts';
import { makeFixture, type Fixture } from './helpers/fixture.ts';

const NOW = '2026-10-29T00:00:00.000Z';
const HERO = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"></svg>', 'utf8');
const FACE = Buffer.from('wOF2-not-a-real-font', 'latin1');
const CSS = 'body{background:url(assets/hero.svg)}\n@font-face{font-family:x;src:url("assets/face.woff2")}\n';

function packageFor(key: string, css = CSS): ReturnType<typeof buildThemePackage> {
  return buildThemePackage({
    key,
    name: `Kit ${key}`,
    css,
    assets: [
      { path: 'assets/hero.svg', bytes: HERO },
      { path: 'assets/face.woff2', bytes: FACE },
    ],
    now: NOW,
  });
}

function fixture(): { fixture: Fixture; db: Database.Database } {
  const built = makeFixture({
    specs: [
      { key: 'one', hosts: ['one.test'], title: 'One' },
      { key: 'two', hosts: ['two.test'], title: 'Two' },
    ],
  });
  return { fixture: built, db: openAdminWrite(built.sitePath('one')) };
}

function refusal(fn: () => unknown): AppError {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof AppError, `expected an AppError, got ${String(err)}`);
    return err as AppError;
  }
  assert.fail('expected a refusal, and nothing was thrown');
}

test('L1 — a package installed in the library is the package on disk, unchanged', () => {
  const { fixture: fx } = fixture();
  const pkg = packageFor('acme-kit');
  const installed = installPackage(fx.dir, pkg);
  assert.equal(installed.key, 'acme-kit');
  assert.equal(installed.dir, libraryEntryDir(fx.dir, 'acme-kit'));
  assert.ok(existsSync(join(libraryRoot(fx.dir), 'acme-kit', 'theme.json')));
  assert.equal(
    readFileSync(join(libraryEntryDir(fx.dir, 'acme-kit'), 'theme.css'), 'utf8'),
    pkg.css,
    'the stored sheet must be the package sheet, not a reserialised one',
  );
  assert.deepEqual(readLibraryTheme(fx.dir, 'acme-kit').manifest, pkg.manifest);
  assert.deepEqual(
    listLibrary(fx.dir).map((entry) => entry.key),
    ['acme-kit'],
  );
});

test('L2 — activation stores what the upload door stores: same blob, same rows, same files', () => {
  const { fixture: fx, db } = fixture();
  const pkg = packageFor('acme-kit');
  installPackage(fx.dir, pkg);
  const result = activatePackage({ dataDir: fx.dir, db, tenantKey: 'one', key: 'acme-kit', actorId: null });

  assert.equal(result.assets, 2);
  const theme = db.prepare('SELECT theme_key, name, css_sha256 FROM cms_theme WHERE theme_key = ?').get('acme-kit') as {
    theme_key: string;
    name: string;
    css_sha256: string;
  };
  assert.equal(theme.name, 'Kit acme-kit');
  // The stored blob is the absolute rewrite, and its sha is the key's address.
  const blob = db.prepare('SELECT css FROM cms_css_blob WHERE sha256 = ?').get(theme.css_sha256) as { css: string };
  assert.match(blob.css, /url\("\/_theme\/acme-kit\/assets\/hero\.svg\?v=[0-9a-f]{8}"\)/);
  const assets = db
    .prepare('SELECT path, sha256, content_type FROM cms_theme_asset ORDER BY path')
    .all() as { path: string; sha256: string; content_type: string }[];
  assert.deepEqual(
    assets.map((asset) => asset.path),
    ['assets/face.woff2', 'assets/hero.svg'],
  );
  const dir = themeAssetDir(themeAssetsRoot(fx.dir, 'one'), 'acme-kit');
  assert.deepEqual(readFileSync(join(dir, 'assets/hero.svg')), HERO);
  // With no active theme yet, the first activation claims the site.
  assert.equal(result.active, true);
  db.close();
});

test('L3 — one library entry serves a second site, and the export comes back as the package', () => {
  const { fixture: fx, db } = fixture();
  const pkg = packageFor('acme-kit');
  installPackage(fx.dir, pkg);
  activatePackage({ dataDir: fx.dir, db, tenantKey: 'one', key: 'acme-kit', actorId: null });
  db.close();

  const two = openAdminWrite(fx.sitePath('two'));
  activatePackage({ dataDir: fx.dir, db: two, tenantKey: 'two', key: 'acme-kit', actorId: null });
  const one = openAdminWrite(fx.sitePath('one'));

  const exported = exportTenantTheme({ dataDir: fx.dir, db: one, tenantKey: 'one', key: 'acme-kit', now: NOW });
  assert.equal(exported.manifest.css.sha256, pkg.manifest.css.sha256, 'the sheet came back different');
  assert.deepEqual(exported.manifest.assets, pkg.manifest.assets, 'an asset came back different');
  assert.equal(exported.css, pkg.css);
  assert.equal(sha256Of(Buffer.from(exported.css)), pkg.manifest.css.sha256);

  // Both tenants wear the same key and the same *stored* bytes. The stored sheet is the absolute
  // rewrite, so its sha is not the package sheet's sha — it is the sha of the rewrite, and that is
  // what `/_theme/<key>/…` was built against. Two sites must agree on it exactly.
  const storedSha = sha256Of(Buffer.from(absolutiseCss(pkg)));
  const rowOne = one.prepare('SELECT css_sha256 FROM cms_theme WHERE theme_key = ?').get('acme-kit') as {
    css_sha256: string;
  };
  const rowTwo = two.prepare('SELECT css_sha256 FROM cms_theme WHERE theme_key = ?').get('acme-kit') as {
    css_sha256: string;
  };
  assert.equal(rowOne.css_sha256, storedSha, 'the first site stores something other than the rewrite');
  assert.equal(rowTwo.css_sha256, storedSha, 'the second site stores something other than the first');
  assert.notEqual(storedSha, pkg.manifest.css.sha256, 'the stored sheet must not be the portable one');
  one.close();
  two.close();
});

test('L4 — activating the same key twice is idempotent', () => {
  const { fixture: fx, db } = fixture();
  installPackage(fx.dir, packageFor('acme-kit'));
  const first = activatePackage({ dataDir: fx.dir, db, tenantKey: 'one', key: 'acme-kit', actorId: null });
  const second = activatePackage({ dataDir: fx.dir, db, tenantKey: 'one', key: 'acme-kit', actorId: null });
  assert.equal(second.themeId, first.themeId);
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS n FROM cms_theme').get() as { n: number }).n,
    1,
    'a second activation must not create a second row',
  );
  db.close();
});

test('L5 — a library collision with different bytes is refused, and --replace is explicit', () => {
  const { fixture: fx } = fixture();
  installPackage(fx.dir, packageFor('acme-kit'));
  const other = buildThemePackage({
    key: 'acme-kit',
    name: 'Kit acme-kit',
    css: 'body{color:#000}\n',
    assets: [],
    now: NOW,
  });
  const err = refusal(() => installPackage(fx.dir, other));
  assert.equal(err.code, 'SKW_E_EXP_THEME_DIGEST');
  const replaced = installPackage(fx.dir, other, { replace: true });
  assert.equal(replaced.replaced, true);
  assert.equal(readLibraryTheme(fx.dir, 'acme-kit').manifest.css.sha256, other.manifest.css.sha256);
});

test('L6 — a tenant that already has the key with different bytes is refused unless replaced', () => {
  const { fixture: fx, db } = fixture();
  installPackage(fx.dir, packageFor('acme-kit'));
  activatePackage({ dataDir: fx.dir, db, tenantKey: 'one', key: 'acme-kit', actorId: null });

  const other = buildThemePackage({ key: 'acme-kit', name: 'Other', css: 'p{color:#111}\n', assets: [], now: NOW });
  installPackage(fx.dir, other, { replace: true });

  const err = refusal(() => activatePackage({ dataDir: fx.dir, db, tenantKey: 'one', key: 'acme-kit', actorId: null }));
  assert.equal(err.code, 'SKW_E_EXP_THEME_DIGEST');

  const replaced = activatePackage({
    dataDir: fx.dir,
    db,
    tenantKey: 'one',
    key: 'acme-kit',
    actorId: null,
    replace: true,
  });
  assert.equal(replaced.cssSha256, other.manifest.css.sha256);
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS n FROM cms_theme WHERE theme_key = ?').get('acme-kit') as { n: number }).n,
    1,
  );
  db.close();
});

test('L7 — the library will not drop a theme a tenant still wears', () => {
  const { fixture: fx, db } = fixture();
  installPackage(fx.dir, packageFor('acme-kit'));
  activatePackage({ dataDir: fx.dir, db, tenantKey: 'one', key: 'acme-kit', actorId: null });
  const err = refusal(() => removeLibraryTheme(fx.dir, 'acme-kit', [db]));
  assert.equal(err.code, 'SKW_E_EXP_THEME_REF');
  db.close();
  // With no tenant holding it, the entry goes.
  removeLibraryTheme(fx.dir, 'acme-kit', []);
  assert.equal(existsSync(libraryEntryDir(fx.dir, 'acme-kit')), false);
});

test('L8 — an export names a file that is missing or changed', () => {
  const { fixture: fx, db } = fixture();
  installPackage(fx.dir, packageFor('acme-kit'));
  activatePackage({ dataDir: fx.dir, db, tenantKey: 'one', key: 'acme-kit', actorId: null });
  const dir = themeAssetDir(themeAssetsRoot(fx.dir, 'one'), 'acme-kit');
  const heroPath = join(dir, 'assets/hero.svg');
  const good = readFileSync(heroPath);

  // Changed bytes: the row still holds the old sha, so the export refuses rather than shipping a
  // package whose manifest would lie about it.
  writeFileSync(heroPath, Buffer.from('<svg>changed</svg>'));
  const changed = refusal(() =>
    exportTenantTheme({ dataDir: fx.dir, db, tenantKey: 'one', key: 'acme-kit', now: NOW }),
  );
  assert.equal(changed.code, 'SKW_E_EXP_THEME_DIGEST');
  assert.equal((changed.detail as { path?: string }).path, 'assets/hero.svg');
  writeFileSync(heroPath, good);

  // Missing file: a different refusal, because the fix is different (restore, not reconcile).
  const facePath = join(dir, 'assets/face.woff2');
  const face = readFileSync(facePath);
  rmSync(facePath);
  const missing = refusal(() =>
    exportTenantTheme({ dataDir: fx.dir, db, tenantKey: 'one', key: 'acme-kit', now: NOW }),
  );
  assert.equal(missing.code, 'SKW_E_EXP_THEME_REF');
  writeFileSync(facePath, face);
  db.close();
});

test('L9 — a tenant with no such theme is refused by name', () => {
  const { fixture: fx, db } = fixture();
  const err = refusal(() => exportTenantTheme({ dataDir: fx.dir, db, tenantKey: 'one', key: 'nope', now: NOW }));
  assert.equal(err.code, 'SKW_E_EXP_THEME_KEY');
  db.close();
});
