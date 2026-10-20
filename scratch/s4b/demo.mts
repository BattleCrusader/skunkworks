/**
 * S4b — build a real exportable site under `scratch/s4b/demo/`, so the three targets can be
 * produced by the actual CLI (`app/cli/export.ts`) rather than by a test helper.
 *
 * Layout, exactly the image's:
 *
 *     demo/data/control.db           schema/control.sql + the seed's tenant and hosts
 *     demo/data/tenants/acme/site.db schema/site.sql + four pages + two assets
 *     demo/data/content/media/hh/…   the bytes the generated `storage_path` column names
 */
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { REPO } from '../../test/helpers/fixture.ts';

const root = join(REPO, 'scratch', 's4b', 'demo');
rmSync(root, { recursive: true, force: true });
mkdirSync(join(root, 'data', 'tenants', 'acme'), { recursive: true });

// --- control.db: the shipped DDL, the shipped seed, one tenant -------------------------
const control = new Database(join(root, 'data', 'control.db'));
control.exec(readFileSync(join(REPO, 'schema', 'control.sql'), 'utf8'));
const tenant = control
  .prepare(`INSERT INTO tenant (key, mode, status, display_name, db_version) VALUES ('acme', 'production', 'active', 'Acme', 3)`)
  .run();
for (const [host, kind, primary, cert] of [
  ['acme.test', 'primary', 1, 'issued'],
  ['www.acme.test', 'alias', 0, 'issued'],
] as const) {
  control
    .prepare('INSERT INTO domain (host, tenant_id, kind, is_primary, cert_state) VALUES (?, ?, ?, ?, ?)')
    .run(host, Number(tenant.lastInsertRowid), kind, primary, cert);
}
control.close();

// --- site.db: four pages, two assets ---------------------------------------------------
const site = new Database(join(root, 'data', 'tenants', 'acme', 'site.db'));
site.pragma('journal_mode = WAL');
site.exec(readFileSync(join(REPO, 'schema', 'site.sql'), 'utf8'));

const asset = (key: string, mime: string, access: string): void => {
  site
    .prepare(
      `INSERT INTO cms_asset (key, filename, mime, bytes, sha256, kind, width, height, alt_text, access_class)
       VALUES (?, ?, ?, ?, ?, 'image', 1600, 900, ?, ?)`,
    )
    .run(key, key.split('/').pop() ?? key, mime, 24, createHash('sha256').update(`bytes:${key}`).digest('hex'), key, access);
};
asset('work/one', 'image/jpeg', 'public');
asset('team/studio', 'image/jpeg', 'public');

const page = (path: string, slug: string, title: string, body: string, css = ''): void => {
  site
    .prepare(
      `INSERT INTO cms_page (path, slug, title, status, template, body_html, body_css, published_at)
       VALUES (?, ?, ?, 'published', 'page', ?, ?, '2026-01-01T00:00:00.000Z')`,
    )
    .run(path, slug, title, body, css);
};
page(
  '/',
  'home',
  'Acme — the best widgets',
  '<section data-gjs-type="hero" class="hero" data-title="Home"><h1>Widgets, made well</h1><p>Since 1998.</p><img data-asset-key="work/one" alt="A widget"></section>',
  '.hero{padding:2rem}',
);
page(
  '/about',
  'about',
  'About & Co <ltd>',
  '<div data-gjs-type="prose" class="prose"><p>We are a <a data-asset-key="team/studio" href="#">small team</a>.</p></div>',
);
page('/pricing', 'pricing', 'Pricing', '<div data-gjs-type="prose" class="prose"><p>Cheap.</p></div>');
// The legacy shape: a row written before 436d913, still carrying the canvas <body>.
page('/legacy', 'legacy', 'Legacy', '<body><div data-gjs-type="prose" class="prose"><p>old</p></div></body>');

const rows = site.prepare('SELECT key, storage_path FROM cms_asset').all() as { key: string; storage_path: string }[];
site.close();

for (const row of rows) {
  const file = join(root, 'data', row.storage_path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `bytes:${row.key}`);
}

process.stdout.write(`demo: ${root}\n`);
