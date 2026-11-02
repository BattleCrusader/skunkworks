/**
 * S12 — **the round trip**: a bundle becomes a tenant on a running instance, and the Host it was
 * given serves the bytes the source served.
 *
 * The fixture is a real export of a real tenant: pages, navigation, settings, a media library with
 * renditions, a theme package with a file beside it, and an installed plugin. Both archive formats
 * are produced from **one** `SKW_EXPORT_NOW` and imported into fresh data directories under new
 * tenant keys, so nothing here can pass by reading the source tree.
 *
 * What each assertion is for:
 *
 *   (i)   the counts and the active theme travel — a bundle that lost its navigation or shipped a
 *         theme row without its stylesheet passes every hash check and renders a broken site;
 *   (ii)  every `storage_path` the database names exists under the **imported** data dir — the
 *         rows are the index of which files exist, so a row without a file is a 404 the client
 *         finds;
 *   (iii) the plugin package is present, byte for byte;
 *   (iv)  the control plane routes the host: one tenant row, one domain row per host, exactly one
 *         `is_primary = 1`, `cert_state = 'none'`;
 *   (v)   the imported site **serves its home page** over the real app with `Host:` the imported
 *         host, and the body is the source's;
 *   (vi)  a second import without `--replace` refuses by name and changes nothing;
 *   (vii) a tampered archive is refused by name **before anything is written**;
 *   (viii) two archives at one `--now` are byte-identical.
 */
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';

import { openAdminWrite } from '../app/db/classes.ts';
import { loadEnv } from '../app/env.ts';
import { runExport } from '../app/export/index.ts';
import { ImportRefusal } from '../app/import/errors.ts';
import { importSite, type ImportSummary } from '../app/import/site.ts';
import { buildApp, type AppHandle } from '../app/main.ts';
import { packageRootHash } from '../app/plugins/manifest.ts';
import { THEME_KEY_SETTING, activeTheme } from '../app/render/themes.ts';
import { REPO, SCHEMA, makeFixture, type Fixture } from './helpers/fixture.ts';
import { call } from './helpers/http.ts';

const NOW = '2026-11-01T09:00:00.000Z';
const SOURCE_KEY = 'fractional';
const ZIP_KEY = 'fractional-copy';
const TAR_KEY = 'fractional-tar';
const THEME_KEY = 'fractional-kit';
const THEME_ASSET = 'assets/mark.svg';
const THEME_MARK = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8"/></svg>';
const THEME_CSS = ':root{--ink:#123}';
const PLUGIN_ID = 'notes';

const sha = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex');

let fixture: Fixture;
let zipPath: string;
let zip2Path: string;
let tgzPath: string;
let tgz2Path: string;
let zipSha: string;
let tgzSha: string;
let dataZip: string;
let dataTar: string;
let zipSummary: ImportSummary;
let tarSummary: ImportSummary;
const cleanups: (() => void)[] = [];

/** The source site, populated the way a real tenant is: rows, files, and a plugin package. */
function populate(fx: Fixture): void {
  const db = openAdminWrite(fx.sitePath(SOURCE_KEY));
  try {
    const page = (path: string, title: string, body: string): void => {
      const slug = path === '/' ? 'home' : path.replace(/^\//, '').replace(/\//g, '-');
      db.prepare(
        `INSERT INTO cms_page (path, slug, title, status, template, body_html, published_at)
         VALUES (?, ?, ?, 'published', 'page', ?, '2026-01-01T00:00:00.000Z')`,
      ).run(path, slug, title, body);
    };
    page('/', 'Fractional home', '<section data-gjs-type="hero"><h1>Fractional Works</h1><img data-asset-key="work/thumb" alt="A thumb"></section>');
    page('/about', 'About Fractional', '<div data-gjs-type="prose" class="prose"><p>We are fractional.</p></div>');

    const nav = db.prepare('INSERT INTO cms_nav (location, label, href_kind, href_target, position) VALUES (?, ?, ?, ?, ?)');
    nav.run('header', 'Home', 'page', '/', 0);
    nav.run('header', 'About', 'page', '/about', 1);
    // `page` and not a `mailto:` — the renderer refuses a scheme a menu may not carry, which is a
    // product rule this fixture has no reason to trip over.
    nav.run('footer', 'About again', 'page', '/about', 0);

    const asset = (key: string, filename: string, mime: string, kind: string): void => {
      db.prepare(
        `INSERT INTO cms_asset (key, filename, mime, bytes, sha256, kind, width, height, access_class)
         VALUES (?, ?, ?, 12, ?, ?, 1200, 800, 'public')`,
      ).run(key, filename, mime, sha(`bytes:${key}`), kind);
    };
    asset('work/thumb', 'thumb.jpg', 'image/jpeg', 'image');
    asset('team/studio', 'studio.png', 'image/png', 'image');
    const thumbId = (db.prepare("SELECT id FROM cms_asset WHERE key = 'work/thumb'").get() as { id: number }).id;
    const variant = (label: string, format: string, width: number): void => {
      const digest = sha(`variant:${label}:${format}`);
      db.prepare(
        `INSERT INTO cms_asset_variant (asset_id, label, format, width, height, bytes, sha256, storage_path)
         VALUES (?, ?, ?, ?, ?, 3, ?, ?)`,
      ).run(thumbId, label, format, width, Math.round((width * 2) / 3), digest, `content/media/${digest.slice(0, 2)}/${digest}.${format}`);
    };
    variant('thumb', 'webp', 320);
    variant('md', 'avif', 768);

    db.prepare('INSERT INTO cms_css_blob (sha256, css, bytes) VALUES (?, ?, ?)').run(
      sha(THEME_CSS),
      THEME_CSS,
      Buffer.byteLength(THEME_CSS),
    );
    db.prepare("INSERT INTO cms_theme (theme_key, name, css_sha256) VALUES (?, 'Fractional kit', ?)").run(THEME_KEY, sha(THEME_CSS));
    const themeId = (db.prepare('SELECT id FROM cms_theme WHERE theme_key = ?').get(THEME_KEY) as { id: number }).id;
    db.prepare('INSERT INTO cms_theme_asset (theme_id, path, sha256, bytes, content_type) VALUES (?, ?, ?, ?, ?)').run(
      themeId,
      THEME_ASSET,
      sha(THEME_MARK),
      Buffer.byteLength(THEME_MARK),
      'image/svg+xml',
    );
    // The active-theme setting travels with the site (it is filtered only for demo.*/billing.*).
    db.prepare('INSERT INTO cms_settings (key, value_json, type) VALUES (?, ?, ?)').run(
      THEME_KEY_SETTING,
      JSON.stringify(THEME_KEY),
      'string',
    );

    const pluginDir = join(fx.dir, 'plugins', PLUGIN_ID);
    mkdirSync(pluginDir, { recursive: true });
    const manifest = { id: PLUGIN_ID, version: '1.2.0', entry: 'index.mjs', capabilities: [], tables: [], settings: [] };
    writeFileSync(join(pluginDir, 'plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(join(pluginDir, 'index.mjs'), 'export default {};\n');
    db.prepare(
      `INSERT INTO cms_plugin_installed
         (plugin_id, version, manifest_json, root_hash, publisher, signature_state, enabled, test_report_sha)
       VALUES (?, '1.2.0', ?, ?, 'fractional-publisher', 'unsigned', 1, ?)`,
    ).run(PLUGIN_ID, JSON.stringify(manifest), packageRootHash(pluginDir).root, 'c'.repeat(64));
  } finally {
    db.close();
  }

  // Real bytes at every path the rows name: the exporter refuses a row whose file is gone, which
  // is the point — a bundle is checked against the disk it was cut from.
  const read = new Database(fx.sitePath(SOURCE_KEY), { readonly: true });
  try {
    const paths: string[] = [];
    for (const row of read.prepare('SELECT key, storage_path FROM cms_asset').all() as { key: string; storage_path: string }[]) {
      paths.push(row.storage_path);
      const file = join(fx.dir, row.storage_path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `bytes:${row.key}`);
    }
    for (const row of read.prepare('SELECT label, format, storage_path FROM cms_asset_variant').all() as {
      label: string;
      format: string;
      storage_path: string;
    }[]) {
      const file = join(fx.dir, row.storage_path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `variant:${row.label}:${row.format}`);
    }
  } finally {
    read.close();
  }
  const themeFile = join(fx.dir, 'tenants', SOURCE_KEY, 'theme-assets', THEME_KEY, THEME_ASSET);
  mkdirSync(dirname(themeFile), { recursive: true });
  writeFileSync(themeFile, THEME_MARK);
}

before(() => {
  fixture = makeFixture({ specs: [{ key: SOURCE_KEY, hosts: ['fractional.test'], title: 'Fractional pricing' }] });
  cleanups.push(() => fixture.cleanup());
  populate(fixture);

  const outRoot = mkdtempSync(join(tmpdir(), 'skw-s12-exports-'));
  cleanups.push(() => rmSync(outRoot, { recursive: true, force: true }));
  zipPath = join(outRoot, 'fractional.zip');
  zip2Path = join(outRoot, 'fractional-again.zip');
  tgzPath = join(outRoot, 'fractional.tar.gz');
  tgz2Path = join(outRoot, 'fractional-again.tar.gz');

  const exportOnce = (out: string, archive: string): { archive: { sha256: string } } => {
    const db = openAdminWrite(fixture.sitePath(SOURCE_KEY));
    try {
      const result = runExport({
        target: 'cms',
        db,
        tenantKey: SOURCE_KEY,
        out,
        exportNow: NOW,
        contentRoot: join(fixture.dir, 'content'),
        repoRoot: REPO,
        tmpDir: fixture.dir,
        origin: 'https://fractional.test',
        archive,
        tenant: {
          key: SOURCE_KEY,
          mode: 'production',
          status: 'active',
          displayName: 'Fractional Works',
          dbVersion: 3,
          hosts: [{ host: 'fractional.test', kind: 'primary', isPrimary: 1, certState: 'issued' }],
        },
      });
      assert.equal(result.ok, true, `the fixture export was refused: ${result.ok ? '' : JSON.stringify(result.refusals)}`);
      if (!result.ok) throw new Error('unreachable');
      assert.ok(result.archive !== undefined, 'the export wrote no archive');
      return { archive: result.archive };
    } finally {
      db.close();
    }
  };

  zipSha = exportOnce(join(outRoot, 'tree-zip'), zipPath).archive.sha256;
  const zipAgain = exportOnce(join(outRoot, 'tree-zip-2'), zip2Path).archive.sha256;
  tgzSha = exportOnce(join(outRoot, 'tree-tar'), tgzPath).archive.sha256;
  const tgzAgain = exportOnce(join(outRoot, 'tree-tar-2'), tgz2Path).archive.sha256;
  assert.equal(zipSha, zipAgain, 'two zips at one --now differ (fixture setup)');
  assert.equal(tgzSha, tgzAgain, 'two tar.gz files at one --now differ (fixture setup)');

  dataZip = mkdtempSync(join(tmpdir(), 'skw-s12-import-zip-'));
  dataTar = mkdtempSync(join(tmpdir(), 'skw-s12-import-tar-'));
  cleanups.push(() => rmSync(dataZip, { recursive: true, force: true }));
  cleanups.push(() => rmSync(dataTar, { recursive: true, force: true }));

  zipSummary = importSite({
    source: zipPath,
    tenantKey: ZIP_KEY,
    hosts: ['copy.example.test', 'www.copy.example.test'],
    primary: 'copy.example.test',
    dataDir: dataZip,
    schemaDir: SCHEMA,
  });
  tarSummary = importSite({
    source: tgzPath,
    tenantKey: TAR_KEY,
    hosts: ['tar.example.test'],
    wildcard: 'example.net',
    dataDir: dataTar,
    schemaDir: SCHEMA,
  });
});

after(() => {
  for (const cleanup of cleanups.reverse()) cleanup();
});

function counts(path: string): Record<string, number> {
  const db = new Database(path, { readonly: true });
  try {
    const out: Record<string, number> = {};
    for (const table of [
      'cms_page',
      'cms_nav',
      'cms_settings',
      'cms_asset',
      'cms_asset_variant',
      'cms_theme',
      'cms_theme_asset',
      'cms_plugin_installed',
    ]) {
      out[table] = Number((db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n);
    }
    return out;
  } finally {
    db.close();
  }
}

// --- (i) the counts and the theme travel -------------------------------------------------

test('I1 — the imported database has the source row counts and the same active theme', () => {
  const source = counts(fixture.sitePath(SOURCE_KEY));
  for (const [label, dataDir, key] of [
    ['zip', dataZip, ZIP_KEY],
    ['tar.gz', dataTar, TAR_KEY],
  ] as const) {
    const imported = counts(join(dataDir, 'tenants', key, 'site.db'));
    assert.deepEqual(imported, source, `${label}: the imported row counts differ from the source`);
    assert.ok(source.cms_page !== undefined && source.cms_page > 0, 'the fixture has no pages to compare');
    assert.ok((source.cms_asset_variant ?? 0) > 0, 'the fixture has no renditions to compare');
    assert.ok((source.cms_theme_asset ?? 0) > 0, 'the fixture has no theme assets to compare');
  }

  const src = new Database(fixture.sitePath(SOURCE_KEY), { readonly: true });
  const zipDb = new Database(join(dataZip, 'tenants', ZIP_KEY, 'site.db'), { readonly: true });
  try {
    assert.equal(activeTheme(zipDb)?.key, THEME_KEY, 'the imported site lost its active theme');
    assert.equal(activeTheme(zipDb)?.key, activeTheme(src)?.key, 'the imported site has a different theme from the source');
    const css = zipDb.prepare('SELECT css FROM cms_css_blob WHERE sha256 = ?').get(sha(THEME_CSS)) as { css: string } | undefined;
    assert.equal(css?.css, THEME_CSS, 'the theme stylesheet did not travel');
  } finally {
    src.close();
    zipDb.close();
  }
});

// --- (ii) every storage_path named by the imported database exists ----------------------

test('I2 — every storage_path cms_asset, cms_asset_variant and cms_theme_asset names exists under the imported data dir', () => {
  for (const [label, dataDir, key] of [
    ['zip', dataZip, ZIP_KEY],
    ['tar.gz', dataTar, TAR_KEY],
  ] as const) {
    const db = new Database(join(dataDir, 'tenants', key, 'site.db'), { readonly: true });
    const named: { table: string; path: string }[] = [];
    try {
      for (const row of db.prepare('SELECT key, storage_path FROM cms_asset ORDER BY key').all() as {
        key: string;
        storage_path: string;
      }[]) {
        named.push({ table: `cms_asset(${row.key})`, path: join(dataDir, row.storage_path) });
      }
      for (const row of db.prepare('SELECT label, format, storage_path FROM cms_asset_variant ORDER BY id').all() as {
        label: string;
        format: string;
        storage_path: string;
      }[]) {
        named.push({ table: `cms_asset_variant(${row.label}.${row.format})`, path: join(dataDir, row.storage_path) });
      }
      const themes = db.prepare('SELECT id, theme_key FROM cms_theme').all() as { id: number; theme_key: string }[];
      for (const theme of themes) {
        for (const row of db
          .prepare('SELECT path FROM cms_theme_asset WHERE theme_id = ? ORDER BY path')
          .all(theme.id) as { path: string }[]) {
          named.push({
            table: `cms_theme_asset(${theme.theme_key}/${row.path})`,
            path: join(dataDir, 'tenants', key, 'theme-assets', theme.theme_key, row.path),
          });
        }
      }
    } finally {
      db.close();
    }
    assert.ok(named.length >= 5, `${label}: expected assets, renditions and a theme file; got ${named.length}`);
    for (const entry of named) {
      assert.ok(existsSync(entry.path), `${label}: ${entry.table} names ${entry.path}, and the import did not write it`);
    }
    // A relative farm link is still a link, not a copy — and it resolves to the media file.
    const link = join(dataDir, 'content', 'public', 'work', 'thumb.jpg');
    assert.equal(existsSync(link), true, `${label}: the farm link was not written`);
    assert.equal(readFileSync(link, 'utf8'), 'bytes:work/thumb', `${label}: the farm link does not resolve to the media bytes`);
  }
});

// --- (iii) the plugin package is present ------------------------------------------------

test('I3 — the bundled plugin package is written into data/plugins/<id>/ without a signed install', () => {
  for (const [label, dataDir] of [
    ['zip', dataZip],
    ['tar.gz', dataTar],
  ] as const) {
    const dir = join(dataDir, 'plugins', PLUGIN_ID);
    assert.equal(existsSync(join(dir, 'plugin.json')), true, `${label}: no plugin.json`);
    assert.equal(existsSync(join(dir, 'index.mjs')), true, `${label}: no index.mjs`);
    const root = packageRootHash(dir).root;
    const db = new Database(join(dataDir, 'tenants', label === 'zip' ? ZIP_KEY : TAR_KEY, 'site.db'), { readonly: true });
    try {
      const row = db.prepare('SELECT root_hash FROM cms_plugin_installed WHERE plugin_id = ?').get(PLUGIN_ID) as {
        root_hash: string;
      };
      assert.equal(root, row.root_hash, `${label}: the copied package is not the bytes the install row records`);
    } finally {
      db.close();
    }
  }
});

// --- (iv) the control plane routes the hosts -------------------------------------------

function controlRows(dataDir: string, key: string): {
  tenant: { mode: string; status: string; display_name: string; db_version: number };
  domains: { host: string; kind: string; is_primary: number; cert_state: string }[];
} {
  const db = new Database(join(dataDir, 'control.db'), { readonly: true });
  try {
    const tenant = db.prepare('SELECT mode, status, display_name, db_version FROM tenant WHERE key = ?').get(key) as
      | { mode: string; status: string; display_name: string; db_version: number }
      | undefined;
    assert.ok(tenant !== undefined, `control.db has no tenant ${key}`);
    const domains = db
      .prepare(
        `SELECT host, kind, is_primary, cert_state FROM domain
          WHERE tenant_id = (SELECT id FROM tenant WHERE key = ?) ORDER BY is_primary DESC, host`,
      )
      .all(key) as { host: string; kind: string; is_primary: number; cert_state: string }[];
    return { tenant, domains };
  } finally {
    db.close();
  }
}

test('I4 — control.db holds the tenant and one domain row per host, exactly one primary, cert_state none', () => {
  const zip = controlRows(dataZip, ZIP_KEY);
  assert.equal(zip.tenant.mode, 'production');
  assert.equal(zip.tenant.status, 'active');
  assert.equal(zip.tenant.display_name, 'Fractional Works', 'the display name must come from the bundle');
  assert.equal(zip.tenant.db_version, 11, 'db_version is the migrated file\'s, not the manifest claim');
  assert.deepEqual(
    zip.domains.map((d) => `${d.host}:${d.kind}:${d.is_primary}:${d.cert_state}`),
    ['copy.example.test:primary:1:none', 'www.copy.example.test:alias:0:none'],
    'the zip import registered the wrong domain rows',
  );
  assert.equal(zip.domains.filter((d) => d.is_primary === 1).length, 1, 'exactly one host is primary');

  // `--wildcard example.net` adds `<host>.example.net` as an alias: one wildcard certificate for
  // *.example.net covers it, so the customer needs no per-name certificate.
  const tar = controlRows(dataTar, TAR_KEY);
  assert.equal(tar.tenant.db_version, 11);
  assert.deepEqual(
    tar.domains.map((d) => `${d.host}:${d.kind}`),
    ['tar.example.test:primary', 'tar.example.test.example.net:alias'],
    'the wildcard alias was not registered as an alias beside the primary',
  );
  assert.equal(tar.domains.filter((d) => d.is_primary === 1).length, 1);
  assert.equal(
    tarSummary.hosts.find((h) => h.wildcardAlias)?.host,
    'tar.example.test.example.net',
    'the summary must say which alias came from --wildcard',
  );
});

// --- (v) the imported site serves --------------------------------------------------------

test('I5 — the imported site serves its home page with Host: the imported host, and the body is the source', async () => {
  let source: AppHandle | undefined;
  let imported: AppHandle | undefined;
  try {
    source = await buildApp({
      env: loadEnv(fixture.env),
      schemaDir: SCHEMA,
      contentRoot: join(fixture.dir, 'content'),
    });
    await source.app.listen({ port: 0, host: '127.0.0.1' });
    const sourceAddress = source.app.server.address();
    const sourcePort = typeof sourceAddress === 'object' && sourceAddress !== null ? sourceAddress.port : 0;

    imported = await buildApp({
      env: loadEnv({ ...fixture.env, SKW_DATA_DIR: dataZip }),
      schemaDir: SCHEMA,
      contentRoot: join(dataZip, 'content'),
    });
    await imported.app.listen({ port: 0, host: '127.0.0.1' });
    const importedAddress = imported.app.server.address();
    const importedPort = typeof importedAddress === 'object' && importedAddress !== null ? importedAddress.port : 0;

    const original = await call({ port: sourcePort, path: '/', host: 'fractional.test' });
    assert.equal(original.status, 200, `the source site did not serve its home page: ${original.body.slice(0, 400)}`);
    assert.match(original.body, /Fractional Works/, 'the source home page is not the fixture\'s');

    const copy = await call({ port: importedPort, path: '/', host: 'copy.example.test' });
    assert.equal(copy.status, 200, `the imported site did not serve / on its own host: ${copy.body.slice(0, 200)}`);
    // The **only** difference is the tenant key the document carries, which is the import's own
    // answer to "whose site is this" and is meant to change. Everything the source rendered — the
    // title, the stylesheet link the theme produces, the media URL with its derived `?v=` — is
    // byte-identical, which is what "the body matches the source" has to mean across two tenants.
    const withoutTenant = (html: string): string => html.replace(/<html lang="en" data-tenant="[^"]+">/, '<html lang="en">');
    assert.match(copy.body, /data-tenant="fractional-copy"/, 'the imported page still says it belongs to the source tenant');
    assert.equal(withoutTenant(copy.body), withoutTenant(original.body), 'the imported home page is not the body the source served');
    assert.match(copy.body, /<link rel="stylesheet" href="\/theme\.css\?v=[0-9a-f]{12}">/, 'the imported page lost its theme sheet');
    assert.match(copy.body, /src="\/media\/work\/thumb\.jpg\?v=[0-9a-f]{8}"/, 'the imported page lost the derived media URL');

    // The alias is routed too, by the same domain row count: one tenant, two names.
    const alias = await call({ port: importedPort, path: '/about', host: 'www.copy.example.test' });
    assert.equal(alias.status, 200, 'the imported alias host does not route');
    assert.match(alias.body, /We are fractional/);

    // A host nobody registered is still a 404: the import did not invent a default tenant.
    const stranger = await call({ port: importedPort, path: '/', host: 'not-registered.example.test' });
    assert.equal(stranger.status, 404, 'an unregistered host must not serve the imported site');
  } finally {
    await source?.close();
    await imported?.close();
  }
});

// --- (v-b) the path form redirects to the primary host ---------------------------------

test('I5b — GET /sites/<key-or-host>/ 302s to the tenant\'s primary host and 404s for an unknown key', async () => {
  const app = await buildApp({
    env: loadEnv({ ...fixture.env, SKW_DATA_DIR: dataZip }),
    schemaDir: SCHEMA,
    contentRoot: join(dataZip, 'content'),
  });
  await app.app.listen({ port: 0, host: '127.0.0.1' });
  try {
    const address = app.app.server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    // The finder is public and does not resolve a tenant from the Host: any Host will do, because
    // the key in the path is the whole question.
    for (const path of ['/sites/fractional-copy/', '/sites/fractional-copy', '/sites/copy.example.test/', '/sites/www.copy.example.test/']) {
      const res = await call({ port, path, host: 'localhost' });
      assert.equal(res.status, 302, `${path} did not redirect (got ${res.status})`);
      assert.equal(res.headers.location, 'https://copy.example.test/', `${path} did not redirect to the primary host`);
    }
    for (const path of ['/sites/nobody/', '/sites/not-a-tenant.example.test/']) {
      const res = await call({ port, path, host: 'localhost' });
      assert.equal(res.status, 404, `${path} must be the same 404 a missing page is (got ${res.status})`);
    }
  } finally {
    await app.close();
  }
});

// --- (vi) a second import without --replace refuses --------------------------------------

test('I6 — importing twice without --replace refuses by name and changes nothing', () => {
  const before = controlRows(dataZip, ZIP_KEY);
  assert.throws(
    () =>
      importSite({
        source: zipPath,
        tenantKey: ZIP_KEY,
        hosts: ['copy.example.test', 'www.copy.example.test'],
        dataDir: dataZip,
        schemaDir: SCHEMA,
      }),
    (err: unknown) => {
      assert.ok(err instanceof ImportRefusal, `expected an ImportRefusal, got ${String(err)}`);
      assert.equal((err as ImportRefusal).code, 'SKW_E_IMP_TENANT_EXISTS');
      return true;
    },
  );
  const after = controlRows(dataZip, ZIP_KEY);
  assert.deepEqual(after, before, 'a refused import changed the control rows');
  assert.equal(after.domains.length, 2, 'a refused import added a domain row');
});

test('I6b — a host that belongs to another tenant is refused rather than stolen', () => {
  // `tar.example.test` is registered to fractional-tar in this data dir.
  assert.throws(
    () =>
      importSite({
        source: zipPath,
        tenantKey: 'fractional-thief',
        hosts: ['tar.example.test'],
        dataDir: dataTar,
        schemaDir: SCHEMA,
      }),
    (err: unknown) => {
      assert.ok(err instanceof ImportRefusal, `expected an ImportRefusal, got ${String(err)}`);
      assert.equal((err as ImportRefusal).code, 'SKW_E_IMP_HOST_TAKEN');
      return true;
    },
  );
  assert.equal(existsSync(join(dataTar, 'tenants', 'fractional-thief')), false, 'a refused import wrote a tenant directory');
});

test('I6c — --replace brings the existing tenant forward without a second primary', () => {
  const before = controlRows(dataZip, ZIP_KEY);
  const summary = importSite({
    source: zipPath,
    tenantKey: ZIP_KEY,
    hosts: ['copy.example.test', 'www.copy.example.test'],
    dataDir: dataZip,
    schemaDir: SCHEMA,
    replace: true,
  });
  assert.equal(summary.replaced, true);
  const after = controlRows(dataZip, ZIP_KEY);
  assert.equal(after.domains.length, before.domains.length, '--replace duplicated a domain row');
  assert.equal(after.domains.filter((d) => d.is_primary === 1).length, 1, '--replace left two primaries');
  assert.equal(after.tenant.db_version, 11);
});

// --- (vii) a tampered archive is refused before anything is written ---------------------

test('I7 — a tampered archive is refused by name before anything is written', () => {
  const original = readFileSync(zipPath);
  const tampered = Buffer.from(original);
  // One byte, in the middle: inside a member's deflate stream or a header, either way a refusal.
  tampered[Math.floor(tampered.length / 2)] = (tampered[Math.floor(tampered.length / 2)] as number) ^ 0x40;
  const tamperedPath = join(dirname(zipPath), 'tampered.zip');
  writeFileSync(tamperedPath, tampered);
  const fresh = mkdtempSync(join(tmpdir(), 'skw-s12-tampered-'));
  cleanups.push(() => rmSync(fresh, { recursive: true, force: true }));

  let code = '';
  assert.throws(
    () => importSite({ source: tamperedPath, tenantKey: 'tampered', hosts: ['tampered.example.test'], dataDir: fresh, schemaDir: SCHEMA }),
    (err: unknown) => {
      assert.ok(err instanceof ImportRefusal, `expected an ImportRefusal, got ${String(err)}`);
      code = (err as ImportRefusal).code;
      assert.match(code, /^SKW_E_IMP_/, `the refusal is not a named import code: ${code}`);
      return true;
    },
  );
  assert.ok(['SKW_E_IMP_ARCHIVE_FAILED', 'SKW_E_IMP_HASH_MISMATCH', 'SKW_E_IMP_COUNT_MISMATCH'].includes(code), `unexpected refusal code ${code}`);
  assert.equal(existsSync(join(fresh, 'control.db')), false, 'a tampered archive created a control.db');
  assert.equal(existsSync(join(fresh, 'tenants')), false, 'a tampered archive wrote a tenant');
});

// --- (viii) two archives at one --now are byte-identical --------------------------------

test('I8 — two archives exported at one --now are byte-identical', () => {
  assert.equal(sha(readFileSync(zipPath)), zipSha, 'the zip on disk is not the bytes the export reported');
  assert.equal(sha(readFileSync(zip2Path)), zipSha, 'the second zip differs from the first');
  assert.equal(sha(readFileSync(tgzPath)), tgzSha, 'the tar.gz on disk is not the bytes the export reported');
  assert.equal(sha(readFileSync(tgz2Path)), tgzSha, 'the second tar.gz differs from the first');
  assert.equal(zipSummary.source.path, zipPath);
  assert.equal(tarSummary.source.path, tgzPath);
  assert.equal(tarSummary.source.kind, 'tar.gz');
  assert.equal(zipSummary.source.kind, 'zip');
});
