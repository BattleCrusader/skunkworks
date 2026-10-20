/**
 * S4b — the projection and its refusals (§11.2, §11.3, D22, D35).
 *
 * Every case here is a **behaviour of the exporter against a real database and a real
 * content tree**, not a mock: the fixture writes `cms_page`, `cms_asset`, `cms_asset_link`
 * and `cms_datasource` rows into the shipped `site.sql`, and the assets have real bytes on
 * disk because the gated refusal is only interesting when the alternative (shipping the
 * file) is possible.
 *
 * The two body cases are the S4a-fix §3.2 pair: a row written before `436d913` carries the
 * canvas `<body>` wrapper and must normalise through `canon.unwrapBody()`, and a row that is
 * still a document after that must be **refused by name** — never silently skipped, never
 * written by a second unwrapper.
 */
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';

import { openAdminWrite } from '../app/db/classes.ts';
import { runExport } from '../app/export/index.ts';
import { readNotes } from '../app/export/notes.ts';
import { buildProjection, type Refusal } from '../app/export/project.ts';
import { REPO, SCHEMA, makeFixture, type Fixture } from './helpers/fixture.ts';

const NOW = '2026-10-20T12:00:00.000Z';
const cleanups: (() => void)[] = [];
after(() => {
  for (const cleanup of cleanups) cleanup();
});

interface AssetSpec {
  key: string;
  mime?: string;
  access?: 'public' | 'linked-private' | 'gated';
  kind?: string;
}

interface SiteSpec {
  pages: { path: string; title: string; body: string; css?: string }[];
  assets?: AssetSpec[];
  links?: { key: string; ownerKind: 'page' | 'settings' | 'bundle' | 'datasource'; ownerId: number }[];
  datasources?: { key: string; params: { name: string; kind: string; values?: string[] }[] }[];
}

interface Site {
  fixture: Fixture;
  contentRoot: string;
  dbPath: string;
  open(): Database.Database;
}

/** A real fixture, real rows, real bytes on disk. The default `/pricing` page stays. */
function site(spec: SiteSpec): Site {
  const fixture = makeFixture({ specs: [{ key: 'acme', hosts: ['acme.test'], title: 'Acme' }] });
  cleanups.push(() => fixture.cleanup());
  const contentRoot = join(fixture.dir, 'content');
  const db = openAdminWrite(fixture.sitePath('acme'));
  try {
    for (const asset of spec.assets ?? []) {
      const sha = createHash('sha256').update(`bytes:${asset.key}`).digest('hex');
      const mime = asset.mime ?? 'image/jpeg';
      const kind = asset.kind ?? (mime === 'application/pdf' ? 'document' : 'image');
      db.prepare(
        `INSERT INTO cms_asset (key, filename, mime, bytes, sha256, kind, width, height, access_class)
         VALUES (?, ?, ?, 12, ?, ?, 1200, 800, ?)`,
      ).run(asset.key, asset.key.split('/').pop() ?? asset.key, mime, sha, kind, asset.access ?? 'public');
      const row = db.prepare('SELECT id, storage_path FROM cms_asset WHERE key = ?').get(asset.key) as {
        id: number;
        storage_path: string;
      };
      const file = join(fixture.dir, row.storage_path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `bytes:${asset.key}`);
      for (const link of (spec.links ?? []).filter((l) => l.key === asset.key)) {
        db.prepare(`INSERT INTO cms_asset_link (asset_id, owner_kind, owner_id) VALUES (?, ?, ?)`).run(
          row.id,
          link.ownerKind,
          link.ownerId,
        );
      }
    }
    for (const source of spec.datasources ?? []) {
      db.prepare(`INSERT INTO cms_datasource (key, kind, spec_json, params_json, is_public) VALUES (?, 'query', ?, ?, 1)`).run(
        source.key,
        JSON.stringify({ relation: 'u_post', columns: ['title'] }),
        JSON.stringify(source.params),
      );
    }
    for (const page of spec.pages) {
      const slug = page.path === '/' ? 'home' : page.path.replace(/^\//, '').replace(/\//g, '-');
      db.prepare(
        `INSERT INTO cms_page (path, slug, title, status, template, body_html, body_css, published_at)
         VALUES (?, ?, ?, 'published', 'page', ?, ?, '2026-01-01T00:00:00.000Z')`,
      ).run(page.path, slug, page.title, page.body, page.css ?? '');
    }
  } finally {
    db.close();
  }
  return {
    fixture,
    contentRoot,
    dbPath: fixture.sitePath('acme'),
    open: () => new Database(fixture.sitePath('acme'), { readonly: true, fileMustExist: true }),
  };
}

function outDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'skw-s4b-out-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'tree');
}

function projectionOf(s: Site, target: 'cms' | 'astro' | 'static' = 'static') {
  const db = s.open();
  try {
    return buildProjection({ db, tenantKey: 'acme', target, exportNow: NOW, contentRoot: s.contentRoot });
  } finally {
    db.close();
  }
}

function codes(refusals: readonly Refusal[]): string[] {
  return refusals.map((r) => r.code).sort();
}

// --- P1: a legacy wrapped row normalises, and the exported page is the served page ----

test('P1 — a `<body>`-wrapped row from before 436d913 normalises through the one unwrapper', () => {
  const s = site({
    pages: [{ path: '/legacy', title: 'Legacy', body: '<body>\n  <div data-gjs-type="prose" class="prose"><p>old</p></div>\n</body>' }],
  });
  const result = projectionOf(s);
  assert.equal(result.ok, true, 'a wrapped row must normalise, not refuse');
  if (!result.ok) return;
  const page = result.projection.pages.find((p) => p.path === '/legacy');
  assert.ok(page !== undefined, '/legacy is missing from the projection');
  assert.equal(page.bodyHtml, '<div data-gjs-type="prose" class="prose"><p>old</p></div>');
  assert.doesNotMatch(page.bodyHtml, /<body/i, 'the wrapper survived the projection');
});

// --- P2: a row that cannot be normalised is refused, by name --------------------------

test('P2 — a row that is still a document after unwrap is refused as BODY_UNNORMALISABLE, naming the page', () => {
  const s = site({
    pages: [
      { path: '/good', title: 'Good', body: '<p>fine</p>' },
      { path: '/double', title: 'Double', body: '<body><body><p>two</p></body></body>' },
    ],
  });
  const result = projectionOf(s);
  assert.equal(result.ok, false, 'a body that is still a document must refuse');
  if (result.ok) return;
  assert.deepEqual(codes(result.refusals), ['SKW_E_EXP_BODY_UNNORMALISABLE']);
  const refusal = result.refusals[0];
  assert.equal(refusal?.exit, 21, '§11.3 exit for a body that cannot be normalised');
  assert.equal(refusal?.detail.page, '/double');
  assert.equal(refusal?.detail.rule, 'body-document');
  // The refusal is all-or-nothing: no partial projection is returned, so no page is
  // silently dropped from a bundle.
  assert.equal('projection' in result, false);
});

// --- P3: a gated asset in a static export is refused, naming key and page -------------

test('P3 — a gated asset in a static export is REFUSED naming the key and the page; the CMS bundle ships it', () => {
  const s = site({
    pages: [
      { path: '/rates', title: 'Rates', body: '<p>Buy the <a data-asset-key="vault/rate-card" href="#">rate card</a>.</p>' },
      { path: '/more', title: 'More', body: '<p><a data-asset-key="vault/rate-card" href="#">again</a></p>' },
    ],
    assets: [{ key: 'vault/rate-card', mime: 'application/pdf', access: 'gated' }],
  });

  for (const target of ['static', 'astro'] as const) {
    const result = projectionOf(s, target);
    assert.equal(result.ok, false, `${target} must refuse a gated asset`);
    if (result.ok) continue;
    assert.deepEqual(codes(result.refusals), ['SKW_E_EXP_GATED_ASSETS']);
    const refusal = result.refusals[0];
    assert.equal(refusal?.exit, 21);
    assert.deepEqual(refusal?.detail.keys, ['vault/rate-card'], 'the refusal must name the asset');
    assert.deepEqual(refusal?.detail.pages, ['/more', '/rates'], 'the refusal must name every page');
  }

  // The same database, as a bundle: gated bytes are what the download plane sells.
  const cms = projectionOf(s, 'cms');
  assert.equal(cms.ok, true, 'the CMS bundle carries gated rows; §11.1 says gated downloads are "yes"');
  if (!cms.ok) return;
  assert.deepEqual(cms.projection.gated.map((a) => a.key), ['vault/rate-card']);
});

// --- P4: a free parameter in a link is refused, naming the source and the link --------

test('P4 — a `free` parameter in a link refuses with PARAMETERISED, naming the source and the link', () => {
  const s = site({
    datasources: [{ key: 'posts', params: [{ name: 'q', kind: 'free' }, { name: 'tag', kind: 'enum', values: ['a'] }] }],
    pages: [{ path: '/search', title: 'Search', body: '<p><a href="/blog?q=hello&amp;tag=a">Search</a></p>' }],
  });
  const result = projectionOf(s);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.deepEqual(codes(result.refusals), ['SKW_E_EXP_PARAMETERISED']);
  const refusal = result.refusals[0];
  assert.equal(refusal?.exit, 22, '§11.3 gives a free parameter its own exit');
  assert.equal(refusal?.detail.param, 'q');
  assert.deepEqual(refusal?.detail.sources, ['posts']);
  assert.match(String(refusal?.detail.link), /\/blog\?q=hello/);
  assert.equal(refusal?.detail.page, '/search');
});

// --- P5: an open media graph is refused ------------------------------------------------

test('P5 — a gated asset linked from a carried owner refuses as MEDIA_GRAPH_OPEN', () => {
  const s = site({
    pages: [{ path: '/', title: 'Home', body: '<p>nothing gated here</p>' }],
    assets: [{ key: 'vault/handbook', mime: 'application/pdf', access: 'gated' }],
    // A settings owner survives every export, and the gated row does not: the graph the
    // client would receive points at bytes the tree does not carry.
    links: [{ key: 'vault/handbook', ownerKind: 'settings', ownerId: 1 }],
  });
  const result = projectionOf(s, 'static');
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.deepEqual(codes(result.refusals), ['SKW_E_EXP_MEDIA_GRAPH_OPEN']);
  const refusal = result.refusals[0];
  assert.equal(refusal?.exit, 21);
  assert.deepEqual(refusal?.detail.keys, ['vault/handbook']);
  assert.deepEqual(refusal?.detail.links, [{ key: 'vault/handbook', owner_kind: 'settings', owner_id: 1 }]);
});

// --- P6: an empty body is a page, not an error ----------------------------------------

test('P6 — an empty body exports as an empty <main>, and an asset with no bytes refuses as ASSET_UNRESOLVED', () => {
  const s = site({ pages: [{ path: '/blank', title: 'Blank', body: '' }] });
  const result = projectionOf(s);
  assert.equal(result.ok, true, 'empty bodies exist (S4a-fix §3.3) and must not refuse');
  if (!result.ok) return;
  assert.equal(result.projection.pages.find((p) => p.path === '/blank')?.bodyHtml, '');

  const missing = site({
    pages: [{ path: '/gone', title: 'Gone', body: '<p><img data-asset-key="work/gone" alt=""></p>' }],
    assets: [{ key: 'work/gone' }],
  });
  // The bytes are written by `site()`; remove them to model an asset row whose file the
  // farm never published — the case a bundle must not paper over.
  const db = missing.open();
  const row = db.prepare(`SELECT storage_path FROM cms_asset WHERE key = 'work/gone'`).get() as { storage_path: string };
  db.close();
  rmSync(join(missing.fixture.dir, row.storage_path));
  const refused = projectionOf(missing);
  assert.equal(refused.ok, false);
  if (refused.ok) return;
  assert.deepEqual(codes(refused.refusals), ['SKW_E_EXP_ASSET_UNRESOLVED']);
  assert.equal(refused.refusals[0]?.detail.key, 'work/gone');
});

// --- P8: the audit table ships empty even though it has rows and cannot be deleted -----

test('P8 — a tenant with audit rows exports: the table ships empty and its no-delete trigger is still there', () => {
  const s = site({ pages: [{ path: '/', title: 'Home', body: '<p>home</p>' }] });
  const write = openAdminWrite(s.dbPath);
  try {
    write
      .prepare(`INSERT INTO cms_audit (actor_label, action, target_kind, target_id) VALUES ('owner', 'page.save', 'page', '1')`)
      .run();
    for (const [key, value] of [
      ['demo.banner', '"a demo"'],
      ['site.title', '"Acme"'],
    ] as const) {
      write.prepare(`INSERT INTO cms_settings (key, value_json, type) VALUES (?, ?, 'string')`).run(key, value);
    }
  } finally {
    write.close();
  }

  const out = outDir();
  const db = s.open();
  const result = runExport({
    target: 'cms',
    db,
    tenantKey: 'acme',
    out,
    exportNow: NOW,
    contentRoot: s.contentRoot,
    repoRoot: REPO,
    tmpDir: dirname(out),
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
  assert.equal(result.ok, true, result.ok ? '' : JSON.stringify(result.refusals));

  const bundle = new Database(join(out, 'data', 'site.db'), { readonly: true });
  try {
    assert.equal(Number((bundle.prepare('SELECT COUNT(*) AS n FROM cms_audit').get() as { n: number }).n), 0, 'our audit rows must not ship');
    const trigger = bundle
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_cms_audit_no_delete'`)
      .get() as { sql: string } | undefined;
    assert.ok(trigger !== undefined, 'the bundle must keep the append-only trigger it was exported from');
    // The demo furniture is filtered, the client's own setting travels (§11.2).
    const keys = (bundle.prepare('SELECT key FROM cms_settings ORDER BY key').all() as { key: string }[]).map((r) => r.key);
    assert.deepEqual(keys, ['site.title']);
  } finally {
    bundle.close();
  }
});

// --- P7: one projection, three serialisers --------------------------------------------

test('P7 — the three targets carry one projection_sha, and it is the same number in all three trees', () => {
  const s = site({
    pages: [
      { path: '/', title: 'Home', body: '<p>home</p>', css: '.a{color:red}' },
      { path: '/about', title: 'About & Co <ltd>', body: '<p>about</p>' },
    ],
    assets: [{ key: 'work/one' }],
  });
  const shas: string[] = [];
  for (const target of ['cms', 'astro', 'static'] as const) {
    const db = s.open();
    const out = outDir();
    const result = runExport({
      target,
      db,
      tenantKey: 'acme',
      out,
      exportNow: NOW,
      contentRoot: s.contentRoot,
      repoRoot: REPO,
      tmpDir: dirname(out),
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
    if (!result.ok) continue;
    shas.push(result.projection.projectionSha);
    const notes = readNotes(readFileSync(join(out, 'EXPORT-NOTES.md'), 'utf8'));
    assert.equal(notes.projectionSha, result.projection.projectionSha, `${target}: EXPORT-NOTES.md disagrees`);
    if (target === 'cms') {
      const manifest = JSON.parse(readFileSync(join(out, 'BUNDLE.json'), 'utf8')) as { projection_sha: string };
      assert.equal(manifest.projection_sha, result.projection.projectionSha);
    }
  }
  assert.equal(new Set(shas).size, 1, `the three targets disagree: ${shas.join(' ')}`);
});
