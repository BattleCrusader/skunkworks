/**
 * S4b — **each of the three trees renders, and all three serve the site's own bytes**
 * (§11.1, §16 S4 "the three targets come from one generator and one projection", D24).
 *
 * The expected value in every comparison below is **one live response**: the same page
 * fetched from the real Fastify + Astro process, rendering the same `cms_page` row. That
 * is deliberate. Comparing the three trees to each other would pass if all three were
 * wrong in the same way (three copies of one bug is exactly what a fork produces), and
 * comparing to a string literal would pass if the site changed. The gate compares each
 * tree to the product.
 *
 *   - **static** — served from the tree by a plain file server (`node:http`, no Node in
 *     the product's path), fetched and compared;
 *   - **astro** — copied out, `npx astro build`, `dist/` served, fetched and compared;
 *   - **cms** — `tools/bundle_verify.mjs --bundle` first, then the product booted against
 *     the bundle's own `data/site.db` and `content/`, fetched and compared.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { after, before, test } from 'node:test';

import { openAdminWrite } from '../app/db/classes.ts';
import { loadEnv } from '../app/env.ts';
import { runExport } from '../app/export/index.ts';
import { buildApp, type AppHandle } from '../app/main.ts';
import { REPO, SCHEMA, makeFixture, type Fixture } from '../test/helpers/fixture.ts';
import { call } from '../test/helpers/http.ts';

const NOW = '2026-10-20T12:00:00.000Z';
const SHA = (text: string): string => createHash('sha256').update(text).digest('hex');
const THEME_CSS = ':root{--ink:#111}';
const THEME_ASSET_PATH = 'assets/mark.svg';
const THEME_MARK = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"></svg>';

let fixture: Fixture;
let handle: AppHandle;
let port = 0;
let work: string;
const trees: Record<'static' | 'astro' | 'cms', string> = { static: '', astro: '', cms: '' };
const cleanups: (() => void)[] = [];

before(async () => {
  fixture = makeFixture({ specs: [{ key: 'acme', hosts: ['acme.test'], title: 'Acme' }] });
  const db = openAdminWrite(fixture.sitePath('acme'));
  const asset = (key: string, mime: string, kind: string, access: string): void => {
    db.prepare(
      `INSERT INTO cms_asset (key, filename, mime, bytes, sha256, kind, width, height, access_class)
       VALUES (?, ?, ?, 12, ?, ?, 1200, 800, ?)`,
    ).run(key, key.split('/').pop() ?? key, mime, SHA(`bytes:${key}`), kind, access);
  };
  asset('work/one', 'image/jpeg', 'image', 'public');
  asset('team/studio', 'image/jpeg', 'image', 'public');
  // E-60: a theme is a package — a stylesheet row plus files beside the tenant. The bundle
  // used to ship the rows without the bytes, so an exported themed site 404'd every
  // `/_theme/…` URL and rendered a font nobody had.
  db.prepare('INSERT INTO cms_css_blob (sha256, css, bytes) VALUES (?, ?, ?)').run(
    SHA(THEME_CSS),
    THEME_CSS,
    Buffer.byteLength(THEME_CSS),
  );
  db.prepare("INSERT INTO cms_theme (theme_key, name, css_sha256) VALUES ('acme-kit', 'Acme kit', ?)").run(SHA(THEME_CSS));
  const themeId = (
    db.prepare("SELECT id FROM cms_theme WHERE theme_key = 'acme-kit'").get() as { id: number }
  ).id;
  db.prepare(
    'INSERT INTO cms_theme_asset (theme_id, path, sha256, bytes, content_type) VALUES (?, ?, ?, ?, ?)',
  ).run(themeId, THEME_ASSET_PATH, SHA(THEME_MARK), Buffer.byteLength(THEME_MARK), 'image/svg+xml');
  const page = (path: string, title: string, body: string, css: string): void => {
    const slug = path === '/' ? 'home' : path.replace(/^\//, '').replace(/\//g, '-');
    db.prepare(
      `INSERT INTO cms_page (path, slug, title, status, template, body_html, body_css, published_at)
       VALUES (?, ?, ?, 'published', 'page', ?, ?, '2026-01-01T00:00:00.000Z')`,
    ).run(path, slug, title, body, css);
  };
  page(
    '/about',
    'About & Co <ltd>',
    '<section data-gjs-type="hero"><h1>About</h1><img data-asset-key="work/one" alt="One"><a data-asset-key="team/studio" href="#">team</a></section>',
    '.hero{color:red}',
  );
  page('/plain', 'Plain', '<div data-gjs-type="prose" class="prose"><p>plain</p></div>', '');
  page('/empty', 'Empty', '', '');
  // The legacy shape: a row written before 436d913, still wrapped.
  page('/legacy', 'Legacy', '<body><div data-gjs-type="prose" class="prose"><p>old</p></div></body>', '');
  db.close();

  // Real bytes for every asset row, at the generated `storage_path`.
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

  work = mkdtempSync(join(tmpdir(), 'skw-s4b-targets-'));
  // The theme asset lives beside the tenant database, which is what `tmpDir` is for an
  // export (`--data-dir`): `<data>/tenants/<key>/theme-assets/<theme_key>/<path>`.
  const themeAssetFile = join(work, 'tenants', 'acme', 'theme-assets', 'acme-kit', THEME_ASSET_PATH);
  mkdirSync(dirname(themeAssetFile), { recursive: true });
  writeFileSync(themeAssetFile, THEME_MARK);
  cleanups.push(() => rmSync(work, { recursive: true, force: true }));
  for (const target of ['static', 'astro', 'cms'] as const) {
    const out = join(work, target);
    trees[target] = out;
    const db2 = openAdminWrite(fixture.sitePath('acme'));
    const result = runExport({
      target,
      db: db2,
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
        dbVersion: 3,
        hosts: [{ host: 'acme.test', kind: 'primary', isPrimary: 1, certState: 'issued' }],
      },
    });
    db2.close();
    assert.equal(result.ok, true, `${target} refused: ${result.ok ? '' : JSON.stringify(result.refusals)}`);
  }

  handle = await buildApp({ env: loadEnv(fixture.env), schemaDir: SCHEMA, contentRoot: join(fixture.dir, 'content') });
  await handle.app.listen({ port: 0, host: '127.0.0.1' });
  const address = handle.app.server.address();
  port = typeof address === 'object' && address !== null ? address.port : 0;
});

after(async () => {
  if (handle !== undefined) await handle.close();
  if (fixture !== undefined) fixture.cleanup();
  for (const cleanup of cleanups) cleanup();
});

/** The page as the product serves it — the expected value for all three trees. */
async function served(path: string): Promise<string> {
  const res = await call({ port, path, host: 'acme.test' });
  assert.equal(res.status, 200, `the product did not serve ${path}`);
  return res.body;
}

/** A plain static server: no rewrite rules, no SPA fallback, no Node in the product. */
function serveTree(root: string): Promise<{ port: number; close(): Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    let path = decodeURIComponent(url.pathname);
    if (path.endsWith('/')) path += 'index.html';
    let file = join(root, path);
    // `try_files $uri $uri/index.html` — the one rewrite "one directory per path" needs.
    if (existsSync(file) && lstatSync(file).isDirectory()) file = join(file, 'index.html');
    if (!file.startsWith(root) || !existsSync(file) || lstatSync(file).isDirectory()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const bound = typeof address === 'object' && address !== null ? address.port : 0;
      resolve({
        port: bound,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

async function fetchTree(treePort: number, path: string): Promise<string> {
  const res = await call({ port: treePort, path, host: 'localhost' });
  assert.equal(res.status, 200, `the exported tree did not serve ${path}`);
  return res.body;
}

/**
 * The content half of "the tree renders", shared by every target: an element that names a
 * key must carry the URL the row implies.
 *
 * Equality with the product is **not** sufficient on its own. The site and the exporters
 * call the same function, so a mutation inside it degrades both identically and every
 * byte-equality assertion still passes (measured — see the mutation table in
 * `docs/build/S4b-report.md`, where T2 and T3 stayed green until this assertion was added).
 * Each target therefore asserts the content on the bytes *it* served.
 */
function assertRendered(html: string, where: string): void {
  // The key stays in the markup — it is the author's identity for the asset, and D17 keeps
  // it so a later rename can cascade. What must be there is the URL the row implies.
  assert.match(html, /<img [^>]*src="\/media\/work\/one\.jpg\?v=[0-9a-f]{8}"/, `${where}: the image lost its derived URL`);
  assert.match(html, /<a [^>]*href="\/media\/team\/studio\.jpg\?v=[0-9a-f]{8}">team<\/a>/, `${where}: a public link is not the farm URL`);
  // An element naming a key with no URL is the defect: `<img data-asset-key="…">` with no src.
  assert.doesNotMatch(html, /<img(?![^>]*\bsrc=)[^>]*>/, `${where}: an image reached the browser with no src`);
}

// --- 0. the product's own bytes --------------------------------------------------------

test('T0 — the served page already carries the derived URLs (the site render is the shared path)', async () => {
  // This is the half the three comparisons below cannot see: if `renderStoredBody()` stopped
  // calling `renderBody()`, the site and the exports would degrade *identically* and still
  // match each other. The gate on the content is here, on the product, and the mutation
  // proof in `docs/build/S4b-report.md` shows it goes red with the export gates.
  assertRendered(await served('/about'), 'the product');
});

// --- 1. static -------------------------------------------------------------------------

test('T1 — the static tree serves every page byte-identically to the product', async () => {
  const tree = await serveTree(trees.static);
  try {
    for (const path of ['/about', '/plain', '/empty', '/legacy', '/pricing']) {
      assert.equal(await fetchTree(tree.port, path), await served(path), `static ${path} differs from the served page`);
    }
    // The bytes the render derived are in the tree, at the URL the page names.
    const about = await fetchTree(tree.port, '/about');
    assertRendered(about, 'static');
    const image = await fetchTree(tree.port, '/media/work/one.jpg');
    assert.equal(image, 'bytes:work/one', 'the media file is not at the URL the page names');
  } finally {
    await tree.close();
  }
});

// --- 2. astro -------------------------------------------------------------------------

test('T2 — the Astro project builds with npx astro build and dist/ serves the same bytes', async () => {
  // Built in a copy: the deliverable is the source tree, and a `node_modules` symlink or a
  // `dist/` inside it would change the tree hash the determinism gate compares.
  const build = join(work, 'astro-build');
  cpSync(trees.astro, build, { recursive: true });
  symlinkSync(join(REPO, 'node_modules'), join(build, 'node_modules'), 'dir');

  const output = execFileSync('npx', ['astro', 'build'], { cwd: build, encoding: 'utf8', stdio: 'pipe' });
  assert.match(output, /Complete!/, `astro build did not complete:\n${output}`);
  assert.ok(existsSync(join(build, 'dist', 'about', 'index.html')), 'astro build wrote no about/index.html');

  // The tree is editable source, not a dump: the page's body lives in a file a human edits.
  assert.equal(readFileSync(join(trees.astro, 'src/content/pages/about.html'), 'utf8'), (await served('/about')).match(/<main>([\s\S]*)<\/main>/)?.[1] ?? '');

  const tree = await serveTree(join(build, 'dist'));
  try {
    for (const path of ['/about', '/plain', '/empty', '/legacy', '/pricing']) {
      assert.equal(await fetchTree(tree.port, path), await served(path), `astro ${path} differs from the served page`);
    }
    assertRendered(await fetchTree(tree.port, '/about'), 'astro');
    await fetchTree(tree.port, '/media/work/one.jpg');
  } finally {
    await tree.close();
  }
});

// --- 3. cms bundle --------------------------------------------------------------------

test('T3 — the CMS bundle verifies, boots against its own site.db, and serves the same bytes', async () => {
  const verify = execFileSync('node', [join(REPO, 'tools', 'bundle_verify.mjs'), '--bundle', trees.cms], {
    encoding: 'utf8',
    stdio: 'pipe',
  });
  assert.match(verify, /file\(s\) verified, no render tree, no render rows/);

  // E-60: the theme package's files travel with the theme's rows. A bundle that carried
  // `cms_theme_asset` and not the bytes installed cleanly and served a page whose
  // stylesheet named a font nobody had — measured on fractionalworks.com.au's export.
  const shippedThemeAsset = join(trees.cms, 'data', 'tenants', 'acme', 'theme-assets', 'acme-kit', THEME_ASSET_PATH);
  assert.equal(existsSync(shippedThemeAsset), true, 'the bundle must carry the theme package\u2019s files');
  assert.equal(readFileSync(shippedThemeAsset, 'utf8'), THEME_MARK);
  const manifest = JSON.parse(readFileSync(join(trees.cms, 'BUNDLE.json'), 'utf8')) as { files: { path: string }[] };
  assert.equal(
    manifest.files.some((f) => f.path === 'data/tenants/acme/theme-assets/acme-kit/assets/mark.svg'),
    true,
    'BUNDLE.json must list the theme file, or verification cannot notice its loss',
  );

  // Boot the product against the bundle: a fresh control.db (the seed's job is S4c), the
  // bundle's own `data/site.db` as the tenant, the bundle's own `content/`.
  const boot = makeFixture({ specs: [{ key: 'acme', hosts: ['acme.test'], title: 'Acme' }] });
  cleanups.push(() => boot.cleanup());
  const target = boot.sitePath('acme');
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${target}${suffix}`, { force: true });
  cpSync(join(trees.cms, 'data', 'site.db'), target);

  const app = await buildApp({ env: loadEnv(boot.env), schemaDir: SCHEMA, contentRoot: join(trees.cms, 'content') });
  await app.app.listen({ port: 0, host: '127.0.0.1' });
  try {
    const address = app.app.server.address();
    const bound = typeof address === 'object' && address !== null ? address.port : 0;
    for (const path of ['/about', '/plain', '/empty', '/legacy', '/pricing']) {
      const res = await call({ port: bound, path, host: 'acme.test' });
      assert.equal(res.status, 200, `the bundle did not serve ${path}`);
      assert.equal(res.body, await served(path), `bundle ${path} differs from the served page`);
    }
    const about = await call({ port: bound, path: '/about', host: 'acme.test' });
    assertRendered(about.body, 'bundle');
  } finally {
    await app.close();
  }
});

// --- 4. bundle hygiene ----------------------------------------------------------------

test('T4 — the bundle carries no control.db, no -wal/-shm, no sources, no protected tree, and no farm link to a gated asset', () => {
  const all: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      all.push(relative(trees.cms, full).split('\\').join('/'));
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(trees.cms);

  assert.equal(all.some((p) => /(^|\/)control\.db$/.test(p)), false, 'a bundle must never carry control.db');
  assert.equal(all.some((p) => /\.db-(wal|shm)$/.test(p)), false, 'a bundle must never carry a WAL sidecar');
  assert.equal(all.some((p) => p.startsWith('content/sources/')), false, 'content/sources/ never ships');
  assert.equal(all.some((p) => p.startsWith('content/protected')), false, 'content/protected never ships');
  assert.equal(all.some((p) => p.startsWith('content/edge/')), false, 'the edge alias map is generated on the box, not shipped');

  // §7.1 / C-17's link-absence test, on the bundle's own farm: the gated asset has bytes
  // and no link, and no link resolves through it.
  const db = new Database(join(trees.cms, 'data', 'site.db'), { readonly: true });
  try {
    const gated = db.prepare(`SELECT key, sha256, access_class FROM cms_asset WHERE access_class = 'gated'`).all() as {
      key: string;
      sha256: string;
      access_class: string;
    }[];
    assert.equal(gated.length, 0, 'the fixture has no gated asset; a gated one would have refused the other two targets');
    // The empty class is real: the tables §11.2 names carry no rows in the bundle.
    for (const table of ['cms_download_code', 'cms_download_event', 'cms_form_submission', 'cms_watermark_render', 'cms_audit']) {
      const n = Number((db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n);
      assert.equal(n, 0, `${table} must ship empty (§11.2)`);
    }
    const pages = Number((db.prepare('SELECT COUNT(*) AS n FROM cms_page').get() as { n: number }).n);
    assert.equal(pages, 5, 'every published page travels');
  } finally {
    db.close();
  }
});
