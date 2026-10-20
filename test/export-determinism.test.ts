/**
 * S4b — **two exports at one `SKW_EXPORT_NOW` are byte-identical; at two clocks they differ
 * only where the timestamp is declared** (§6.4, §11.5, §16 S4 row "two exports at one
 * SKW_EXPORT_NOW are byte-identical; at two clocks they are not").
 *
 * "Byte-identical" is asserted over the **whole tree**: `hashTree()` hashes every path, its
 * kind and its content (and a symlink's target string), so a file that changed, appeared,
 * vanished, or turned from a link into a regular file all move the number. That is stronger
 * than comparing the pages, and it is the property a client can check with `sha256sum` or
 * `tar`.
 *
 * The second half is the interesting one. A clock that leaks into a page body, a sitemap's
 * `lastmod` or a `created_at` in the manifest would make "deterministic" false without
 * making the first half fail loudly — so the gate diffs two trees made an hour apart and
 * requires the difference to be **exactly** the declared lines.
 */
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';

import { openAdminWrite } from '../app/db/classes.ts';
import { mtimeOf, resolveExportNow, runExport } from '../app/export/index.ts';
import { hashTree, type TreeHash } from '../app/export/tree.ts';
import { REPO, makeFixture, type Fixture } from '../test/helpers/fixture.ts';

const NOW = '2026-10-20T12:00:00.000Z';
const LATER = '2026-10-20T13:00:00.000Z';
const cleanups: (() => void)[] = [];
after(() => {
  for (const cleanup of cleanups) cleanup();
});

function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** One fixture, two assets (one nested key), three pages, real bytes. */
function world(): Fixture {
  const fixture = makeFixture({ specs: [{ key: 'acme', hosts: ['acme.test'], title: 'Acme' }] });
  cleanups.push(() => fixture.cleanup());
  const db = openAdminWrite(fixture.sitePath('acme'));
  for (const key of ['work/one', 'team/studio']) {
    db.prepare(
      `INSERT INTO cms_asset (key, filename, mime, bytes, sha256, kind, width, height, access_class)
       VALUES (?, ?, 'image/jpeg', 12, ?, 'image', 1200, 800, 'public')`,
    ).run(key, key.split('/').pop() ?? key, sha(`bytes:${key}`));
  }
  db.prepare(
    `INSERT INTO cms_page (path, slug, title, status, template, body_html, body_css, published_at)
     VALUES ('/about','about','About','published','page',?,'.a{color:red}','2026-01-01T00:00:00.000Z')`,
  ).run('<section data-gjs-type="hero"><h1>About</h1><img data-asset-key="work/one" alt=""><a data-asset-key="team/studio" href="#">x</a></section>');
  db.close();
  const rows = (() => {
    const read = new Database(fixture.sitePath('acme'), { readonly: true });
    try {
      return read.prepare('SELECT key, storage_path FROM cms_asset').all() as { key: string; storage_path: string }[];
    } finally {
      read.close();
    }
  })();
  for (const row of rows) {
    const file = join(fixture.dir, row.storage_path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `bytes:${row.key}`);
  }
  return fixture;
}

const fixture = world();
const work = mkdtempSync(join(tmpdir(), 'skw-s4b-det-'));
cleanups.push(() => rmSync(work, { recursive: true, force: true }));

let seq = 0;
function exportAt(target: 'cms' | 'astro' | 'static', now: string): { out: string; tree: TreeHash } {
  seq += 1;
  const out = join(work, `${target}-${seq}`);
  const db = openAdminWrite(fixture.sitePath('acme'));
  const result = runExport({
    target,
    db,
    tenantKey: 'acme',
    out,
    exportNow: now,
    contentRoot: join(fixture.dir, 'content'),
    repoRoot: REPO,
    tmpDir: work,
    origin: 'https://acme.test',
    tenant: {
      key: 'acme',
      mode: 'production',
      status: 'active',
      displayName: 'Acme',
      dbVersion: 3,
      hosts: [{ host: 'acme.test', kind: 'primary', isPrimary: 1, certState: 'issued' }],
    },
  });
  db.close();
  assert.equal(result.ok, true, `${target} refused: ${result.ok ? '' : JSON.stringify(result.refusals)}`);
  if (!result.ok) throw new Error('unreachable');
  return { out, tree: result.tree };
}

// --- D1 --------------------------------------------------------------------------------

for (const target of ['cms', 'astro', 'static'] as const) {
  test(`D1/${target} — two exports at one SKW_EXPORT_NOW are byte-identical tree-wide`, () => {
    const first = exportAt(target, NOW);
    const second = exportAt(target, NOW);
    assert.equal(
      second.tree.sha256,
      first.tree.sha256,
      `${target}: the tree hash moved\n${diffLines(first.tree, second.tree).join('\n')}`,
    );
    assert.ok(first.tree.files > 0);
  });
}

// --- D2 --------------------------------------------------------------------------------

function diffLines(a: TreeHash, b: TreeHash): string[] {
  const map = new Map(a.entries.map((e) => [e.path, e]));
  const out: string[] = [];
  for (const entry of b.entries) {
    const before = map.get(entry.path);
    if (before === undefined) out.push(`+ ${entry.path}`);
    else if (before.sha256 !== entry.sha256 || before.kind !== entry.kind) out.push(`~ ${entry.path}`);
    map.delete(entry.path);
  }
  for (const path of map.keys()) out.push(`- ${path}`);
  return out;
}

for (const target of ['cms', 'astro', 'static'] as const) {
  test(`D2/${target} — an export an hour later differs only in the declared timestamp lines`, () => {
    const first = exportAt(target, NOW);
    const later = exportAt(target, LATER);

    const changed = diffLines(first.tree, later.tree).sort();
    const expected = target === 'cms' ? ['~ BUNDLE.json', '~ EXPORT-NOTES.md'] : ['~ EXPORT-NOTES.md'];
    assert.deepEqual(changed, expected, `${target}: files changed outside the declared timestamp`);

    // And the difference *inside* those files is the timestamp, nothing else.
    const before = readFileSync(join(first.out, 'EXPORT-NOTES.md'), 'utf8');
    const after = readFileSync(join(later.out, 'EXPORT-NOTES.md'), 'utf8');
    assert.equal(after.replace(`exported_at: ${LATER}`, `exported_at: ${NOW}`), before);
    if (target === 'cms') {
      const a = JSON.parse(readFileSync(join(first.out, 'BUNDLE.json'), 'utf8')) as Record<string, unknown>;
      const b = JSON.parse(readFileSync(join(later.out, 'BUNDLE.json'), 'utf8')) as Record<string, unknown>;
      assert.equal(a.export_now, NOW);
      assert.equal(b.export_now, LATER);
      assert.equal(b.created_at, LATER);
      // Everything else in the manifest — every file hash, every count — is identical.
      assert.equal(a.projection_sha, b.projection_sha);
      assert.deepEqual(a.source_counts, b.source_counts);
      // Every file in the manifest hashes the same in both, except the notes file — which
      // is itself declared, because its `exported_at:` line is the timestamp.
      const filesOf = (m: Record<string, unknown>): { path: string; sha256: string }[] =>
        m.files as { path: string; sha256: string }[];
      const differing = filesOf(a)
        .filter((f, i) => f.sha256 !== filesOf(b)[i]?.sha256)
        .map((f) => f.path);
      assert.deepEqual(differing, ['EXPORT-NOTES.md']);
      assert.equal(new Set(filesOf(a).map((f) => `${f.path}:${f.sha256}`)).size, filesOf(a).length);
    }
  });
}

// --- D3 --------------------------------------------------------------------------------

test('D3 — every file and directory in a tree carries the pinned mtime', () => {
  assert.equal(mtimeOf(NOW), 1792497600000);
  const { out } = exportAt('static', NOW);
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (statSync(full).mtimeMs !== mtimeOf(NOW)) offenders.push(`${full.slice(out.length + 1)} @ ${statSync(full).mtime.toISOString()}`);
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(out);
  assert.deepEqual(offenders, [], 'a tree whose mtimes drift is not byte-identical under tar or rsync -a');
});

// --- D4 --------------------------------------------------------------------------------

test('D4 — SKW_EXPORT_NOW is the only clock, and a value that is not UTC ISO 8601 is refused', () => {
  assert.equal(resolveExportNow({ SKW_EXPORT_NOW: NOW }), NOW);
  assert.throws(() => resolveExportNow({ SKW_EXPORT_NOW: '2026-10-20 12:00:00' }), /not UTC ISO 8601/);
  assert.throws(() => resolveExportNow({ SKW_EXPORT_NOW: '2026-10-20T12:00:00+11:00' }), /not UTC ISO 8601/);
  // Unset is the interactive case: the wall clock, pinned once and passed down.
  assert.equal(resolveExportNow({}, Date.parse(NOW)), NOW);
});

test('D4b — a destination with anything in it is refused, so a stale page cannot survive', () => {
  const out = join(work, 'not-empty');
  const first = exportAt('static', NOW);
  rmSync(out, { recursive: true, force: true });
  // Start from a real tree, then re-point the second export at it.
  const db = openAdminWrite(fixture.sitePath('acme'));
  try {
    const result = runExport({
      target: 'static',
      db,
      tenantKey: 'acme',
      out: first.out,
      exportNow: NOW,
      contentRoot: join(fixture.dir, 'content'),
      repoRoot: REPO,
      tmpDir: work,
    });
    assert.equal(result.ok, true);
    assert.fail('an export into a non-empty destination must refuse');
  } catch (err) {
    assert.match(String(err), /not empty/);
  } finally {
    db.close();
  }
  utimesSync(join(first.out, 'about', 'index.html'), 1, 1);
});
