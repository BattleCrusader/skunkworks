/**
 * A real CMS bundle, built by the product's own exporter, for the S4c gates.
 *
 * Nothing here is hand-assembled: `runExport({target:'cms'})` is the writer the operator
 * runs, so a gate that installs this bundle is testing the artefact the exporter produces
 * (S4b §3) and not a fixture that happens to look like one.
 *
 * The fixture site carries a `/` page, because the five-minute promise is "an empty host
 * directory to a **served page**" and a bundle whose only page is `/pricing` cannot answer
 * `GET /` — the install's own smoke test would then be measuring a 404.
 */
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openAdminWrite } from '../../app/db/classes.ts';
import { runExport } from '../../app/export/index.ts';
import { REPO, makeFixture, type Fixture } from './fixture.ts';

export const BUNDLE_NOW = '2026-10-20T12:00:00.000Z';

export interface Bundle {
  fixture: Fixture;
  /** The bundle root — `BUNDLE.json` lives here. */
  dir: string;
  cleanup(): void;
}

export interface BundleOptions {
  /** Extra pages, `path -> body`. `/pricing` always exists (the fixture's own page). */
  pages?: Record<string, string>;
  /** Insert one `cms_plugin_installed` row and ship no package (S4c's install refusal). */
  pluginRow?: { pluginId: string; version?: string };
}

export function makeBundle(opts: BundleOptions = {}): Bundle {
  const fixture = makeFixture({ specs: [{ key: 'acme', hosts: ['acme.test', 'www.acme.test'], title: 'Acme' }] });
  const db = openAdminWrite(fixture.sitePath('acme'));
  try {
    db.prepare(
      `INSERT INTO cms_page (path, slug, title, status, template, body_html, published_at)
       VALUES ('/', 'home', 'Acme home', 'published', 'page', '<h1>Acme home</h1><p>The served page.</p>',
               '2026-01-01T00:00:00.000Z')`,
    ).run();
    for (const [path, body] of Object.entries(opts.pages ?? {})) {
      const slug = path === '/' ? 'home' : path.replace(/^\//, '').replace(/\//g, '-');
      db.prepare(
        `INSERT INTO cms_page (path, slug, title, status, template, body_html, published_at)
         VALUES (?, ?, ?, 'published', 'page', ?, '2026-01-01T00:00:00.000Z')`,
      ).run(path, slug, path, body);
    }
    if (opts.pluginRow !== undefined) {
      db.prepare(
        `INSERT INTO cms_plugin_installed
           (plugin_id, version, manifest_json, root_hash, publisher, signature_state, enabled, test_report_sha)
         VALUES (?, ?, ?, ?, 'acme-publisher', 'unsigned', 1, ?)`,
      ).run(
        opts.pluginRow.pluginId,
        opts.pluginRow.version ?? '1.4.0',
        JSON.stringify({ id: opts.pluginRow.pluginId, version: opts.pluginRow.version ?? '1.4.0', capabilities: [] }),
        'a'.repeat(64),
        'b'.repeat(64),
      );
    }
  } finally {
    db.close();
  }

  const out = mkdtempSync(join(tmpdir(), 'skw-bundle-'));
  const result = runExport({
    target: 'cms',
    db: new Database(fixture.sitePath('acme'), { readonly: true }),
    tenantKey: 'acme',
    out,
    exportNow: BUNDLE_NOW,
    contentRoot: join(fixture.dir, 'content'),
    repoRoot: REPO,
    tmpDir: fixture.dir,
    origin: 'https://acme.test',
    tenant: {
      key: 'acme',
      mode: 'production',
      status: 'active',
      displayName: 'Acme',
      dbVersion: 3,
      hosts: [
        { host: 'acme.test', kind: 'primary', isPrimary: 1, certState: 'issued' },
        { host: 'www.acme.test', kind: 'alias', isPrimary: 0, certState: 'issued' },
      ],
    },
  });
  if (!result.ok) {
    throw new Error(`the fixture bundle was refused: ${JSON.stringify(result.refusals)}`);
  }
  return {
    fixture,
    dir: out,
    cleanup(): void {
      rmSync(out, { recursive: true, force: true });
      fixture.cleanup();
    },
  };
}
