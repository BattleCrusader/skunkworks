/**
 * A row whose bytes are gone is debris or it is a broken site — and the export must tell the two
 * apart.
 *
 * The live `fractional` tenant proved why this matters: one asset row (`sweep-pixel`, eight
 * renditions) had no bytes anywhere, nothing referenced it, and every export of that site failed
 * with `SKW_E_EXP_ASSET_UNRESOLVED` — forever, because the refusal was correct but useless. The
 * operator could not export their own site and had no way to see why.
 *
 * The rule these two tests pin:
 *
 *   - nothing points at it (no page body, no `cms_asset_link`, no bundle item) → **drop** it,
 *     delete the row from the bundle's own `site.db` copy, and name it in `BUNDLE.json` under
 *     `derived`. The shipped rows and the shipped files agree, and the export runs.
 *   - a page names it → **refuse**, because that site really would render a 404 and a bundle
 *     that quietly loses an image a page shows is the failure this code exists for.
 */
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { openAdminWrite } from '../app/db/classes.ts';
import { runExport } from '../app/export/index.ts';
import { REPO, makeFixture, type Fixture } from '../test/helpers/fixture.ts';

const NOW = '2026-11-03T00:00:00.000Z';

let fixture: Fixture;
let work: string;

before(() => {
  fixture = makeFixture({ specs: [{ key: 'acme', hosts: ['acme.test'], title: 'Acme' }] });
  work = mkdtempSync(join(tmpdir(), 'skw-dead-asset-'));
  const db = openAdminWrite(fixture.sitePath('acme'));
  db.prepare(
    `INSERT INTO cms_page (path, slug, title, status, template, body_html, body_css, published_at)
     VALUES ('/about', 'about', 'About', 'published', 'page', '<p>No images here.</p>', '', '2026-01-01T00:00:00.000Z')`,
  ).run();
  // The row exists; the file never will. Nothing links it, nothing bundles it.
  db.prepare(
    `INSERT INTO cms_asset (key, filename, mime, bytes, sha256, kind, width, height, access_class)
     VALUES ('dead/pixel', 'pixel.png', 'image/png', 12, ?, 'image', 8, 8, 'public')`,
  ).run('a'.repeat(64));
  db.prepare(
    `INSERT INTO cms_asset_variant (asset_id, label, format, width, height, bytes, sha256, storage_path)
     VALUES ((SELECT id FROM cms_asset WHERE key = 'dead/pixel'), 'thumb', 'webp', 4, 4, 3, ?, ?)`,
  ).run('b'.repeat(64), 'content/media/de/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.webp');
  db.close();
});

after(() => {
  fixture.cleanup();
  rmSync(work, { recursive: true, force: true });
});

function exportCms(out: string) {
  const db = openAdminWrite(fixture.sitePath('acme'));
  try {
    return runExport({
      target: 'cms',
      db,
      tenantKey: 'acme',
      out,
      exportNow: NOW,
      contentRoot: join(fixture.dir, 'content'),
      repoRoot: REPO,
      tmpDir: work,
      origin: 'https://acme.test',
      tenant: {
        key: 'acme',
        mode: 'production',
        status: 'active',
        displayName: 'Acme',
        dbVersion: 0,
        hosts: [{ host: 'acme.test', kind: 'primary', isPrimary: 1, certState: 'none' }],
      },
    });
  } finally {
    db.close();
  }
}

test('D1 — an asset nobody points at is dropped, not a permanent export blocker', () => {
  const out = join(work, 'd1');
  mkdirSync(out, { recursive: true });
  const result = exportCms(out);
  assert.equal(result.ok, true, result.ok ? '' : JSON.stringify(result.refusals));
  assert.deepEqual(
    result.projection.dropped.map((d) => d.key),
    ['dead/pixel'],
  );

  const shipped = new Database(join(out, 'data', 'site.db'), { readonly: true });
  try {
    assert.equal(shipped.prepare("SELECT 1 FROM cms_asset WHERE key = 'dead/pixel'").get(), undefined, 'the row was shipped');
    const variants = shipped.prepare('SELECT COUNT(*) AS n FROM cms_asset_variant').get() as { n: number };
    assert.equal(variants.n, 0, 'an orphan rendition row was shipped without bytes');
  } finally {
    shipped.close();
  }

  const manifest = JSON.parse(readFileSync(join(out, 'BUNDLE.json'), 'utf8')) as {
    derived: { path: string; reason: string }[];
  };
  const droppedPath = result.projection.dropped[0]?.path ?? '';
  const noted = manifest.derived.find((entry) => entry.path === droppedPath);
  assert.ok(noted !== undefined, 'BUNDLE.json does not name the dropped asset');
  assert.match(noted.reason, /dropped/);
});

test('D2 — an asset a page names is still refused by name', () => {
  const db = openAdminWrite(fixture.sitePath('acme'));
  db.prepare("UPDATE cms_page SET body_html = ? WHERE path = '/about'").run(
    '<p><img src="/media/dead/pixel.png" alt=""></p>',
  );
  db.close();

  const out = join(work, 'd2');
  mkdirSync(out, { recursive: true });
  const result = exportCms(out);
  assert.equal(result.ok, false, 'a bundle that silently loses an image a page shows was produced');
  if (result.ok) return;
  const codes = result.refusals.map((r) => r.code);
  assert.ok(codes.includes('SKW_E_EXP_ASSET_UNRESOLVED'), `refused for the wrong reason: ${JSON.stringify(result.refusals)}`);
  const detail = result.refusals.find((r) => r.code === 'SKW_E_EXP_ASSET_UNRESOLVED')?.detail as { key?: string };
  assert.equal(detail.key, 'dead/pixel');
});
