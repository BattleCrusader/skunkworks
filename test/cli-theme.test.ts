/**
 * `skw-theme` end to end: a real zip in, a real tenant activated, a real package back out.
 *
 * The CLI is exercised as a process (`node --experimental-strip-types`), not imported, because the
 * exit codes and the printed refusals are part of the contract an operator relies on.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { buildThemePackage } from '../app/themes/package.ts';
import { makeFixture, type Fixture } from './helpers/fixture.ts';
import { zipOf } from './helpers/zip-maker.ts';

const REPO = '/Volumes/Backup/Development/skunkworks';
const CLI = join(REPO, 'app', 'cli', 'theme.ts');
const NOW = '2026-10-29T00:00:00.000Z';
const HERO = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"></svg>', 'utf8');
const CSS = 'body{background:url(assets/hero.svg)}\n';

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function skwTheme(args: readonly string[]): Run {
  try {
    const stdout = execFileSync('node', ['--no-warnings', '--experimental-strip-types', CLI, ...args], {
      encoding: 'utf8',
      stdio: 'pipe',
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    const failure = err as { status?: number; stdout?: string; stderr?: string };
    return { code: failure.status ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

function pkgZip(css = CSS): Buffer {
  return zipOf(pkgFiles(css).map((file) => ({ name: file.path, bytes: file.bytes })));
}

/** The package's own canonical sheet — `buildThemePackage` normalises quoting, so the test must
 *  compare against what the format defines rather than against the string it passed in. */
function pkgFiles(css = CSS): { path: string; bytes: Buffer }[] {
  return buildThemePackage({
    key: 'acme-kit',
    name: 'Acme kit',
    css,
    assets: [{ path: 'assets/hero.svg', bytes: HERO }],
    now: NOW,
  }).files;
}

function box(): { fixture: Fixture; dir: string } {
  const fixture = makeFixture({
    specs: [
      { key: 'one', hosts: ['one.test'], title: 'One' },
      { key: 'two', hosts: ['two.test'], title: 'Two' },
    ],
  });
  return { fixture, dir: fixture.dir };
}

test('C1 — import a zip, list it, activate it on one site, export it back to the same package', () => {
  const { dir } = box();
  const zipPath = join(mkdtempSync(join(tmpdir(), 'skw-theme-cli-')), 'acme-kit.zip');
  writeFileSync(zipPath, pkgZip());

  const imported = skwTheme(['import', zipPath, '--data-dir', dir]);
  assert.equal(imported.code, 0, imported.stderr);
  assert.match(imported.stdout, /theme import: acme-kit "Acme kit" v1\.0\.0/);
  assert.ok(existsSync(join(dir, 'themes', 'acme-kit', 'theme.json')), 'the library entry is missing');

  const listed = skwTheme(['list', '--data-dir', dir]);
  assert.equal(listed.code, 0);
  assert.match(listed.stdout, /library {2}acme-kit/);

  const activated = skwTheme(['activate', 'acme-kit', '--tenant', 'one', '--data-dir', dir]);
  assert.equal(activated.code, 0, activated.stderr);
  assert.match(activated.stdout, /theme activate: acme-kit on one .*active\)/);

  const tenantList = skwTheme(['list', '--tenant', 'one', '--data-dir', dir]);
  assert.match(tenantList.stdout, /tenant one {2}acme-kit .*1 asset\(s\).*active/);

  const out = join(mkdtempSync(join(tmpdir(), 'skw-theme-out-')), 'acme-kit');
  const exported = skwTheme(['export', 'acme-kit', '--tenant', 'one', '--out', out, '--now', NOW, '--data-dir', dir]);
  assert.equal(exported.code, 0, exported.stderr);
  const manifest = JSON.parse(readFileSync(join(out, 'theme.json'), 'utf8')) as { key: string; css: { sha256: string } };
  assert.equal(manifest.key, 'acme-kit');
  // The round trip: the exported sheet is the package sheet, byte for byte.
  const expectedCss = pkgFiles()
    .find((file) => file.path === 'theme.css')
    ?.bytes.toString('utf8');
  assert.equal(readFileSync(join(out, 'theme.css'), 'utf8'), expectedCss);
  assert.deepEqual(readFileSync(join(out, 'assets', 'hero.svg')), HERO);
  assert.deepEqual(readdirSync(join(out, 'assets')), ['hero.svg']);
});

test('C2 — importing the same bytes twice is fine; different bytes are refused by name', () => {
  const { dir } = box();
  const work = mkdtempSync(join(tmpdir(), 'skw-theme-cli2-'));
  const first = join(work, 'one.zip');
  writeFileSync(first, pkgZip());
  assert.equal(skwTheme(['import', first, '--data-dir', dir]).code, 0);

  const again = skwTheme(['import', first, '--data-dir', dir]);
  assert.equal(again.code, 0, 'a re-import of identical bytes must not fail');

  const second = join(work, 'two.zip');
  writeFileSync(second, pkgZip('body{color:#000}\n'));
  const refused = skwTheme(['import', second, '--data-dir', dir]);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /REFUSAL: SKW_E_EXP_THEME_DIGEST/);

  const replaced = skwTheme(['import', second, '--replace', '--data-dir', dir]);
  assert.equal(replaced.code, 0, replaced.stderr);
  assert.match(replaced.stdout, /replaced/);
});

test('C3 — a corrupt zip is refused before the library is touched', () => {
  const { dir } = box();
  const work = mkdtempSync(join(tmpdir(), 'skw-theme-cli3-'));
  const good = pkgZip();
  good[good.length - 30] = (good[good.length - 30] ?? 0) ^ 0xff;
  const path = join(work, 'broken.zip');
  writeFileSync(path, good);
  const run = skwTheme(['import', path, '--data-dir', dir]);
  assert.equal(run.code, 1);
  assert.match(run.stderr, /REFUSAL: SKW_E_/);
  assert.equal(existsSync(join(dir, 'themes')), false, 'a refused import must write nothing');
});

test('C4 — the library will not drop a theme a site still wears', () => {
  const { dir } = box();
  const work = mkdtempSync(join(tmpdir(), 'skw-theme-cli4-'));
  const path = join(work, 'acme-kit.zip');
  writeFileSync(path, pkgZip());
  assert.equal(skwTheme(['import', path, '--data-dir', dir]).code, 0);
  assert.equal(skwTheme(['activate', 'acme-kit', '--tenant', 'one', '--data-dir', dir]).code, 0);

  const refused = skwTheme(['remove', 'acme-kit', '--data-dir', dir]);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /REFUSAL: SKW_E_EXP_THEME_REF/);
});

test('C5 — usage errors are exit 2 and name the command that was wrong', () => {
  const unknown = skwTheme(['frobnicate']);
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /unknown command/);
  const missing = skwTheme(['activate', 'acme-kit']);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /activate needs <key> --tenant <key>/);
});
