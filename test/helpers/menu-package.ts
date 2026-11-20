/**
 * Install the real `menu` package into a test tenant.
 *
 * The site's header and footer menus are drawn only while the `menu` package is enabled
 * (`menuPluginEnabled` in `app/render/nav.ts`), so any test that asserts a rendered menu has to
 * install it. A `cms_plugin_installed` row alone is not enough: `plugins.sync` loads each enabled
 * package from `<data>/plugins/<id>` and **disables** a row whose package it cannot load — the right
 * behaviour, and the trap that makes a row-only fixture look like a broken gate.
 *
 * Copy the package in, then write the row with the package's own root hash.
 */
import { cpSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type Database from 'better-sqlite3';

import { packageRootHash } from '../../app/plugins/manifest.ts';
import { REPO } from './fixture.ts';

export function installMenuPackage(site: Database.Database, dataDir: string): void {
  const to = join(dataDir, 'plugins', 'menu');
  cpSync(join(REPO, 'plugins', 'menu'), to, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(to, 'plugin.json'), 'utf8')) as {
    id: string;
    version: string;
  };
  const { root } = packageRootHash(to);
  site.prepare("DELETE FROM cms_plugin_installed WHERE plugin_id = 'menu'").run();
  site
    .prepare(
      `INSERT INTO cms_plugin_installed
         (plugin_id, version, manifest_json, root_hash, publisher, signature_state, enabled, test_report_sha)
       VALUES ('menu', ?, ?, ?, 'skunkworks', 'first_party', 1, 'sha256:test')`,
    )
    .run(manifest.version, JSON.stringify(manifest), root);
}
