/**
 * Install the real `jobboard` package into a test tenant, the way the CLI does it.
 *
 * A `cms_plugin_installed` row alone is **not** an installed package: `plugins.sync` loads each
 * enabled package from `<data>/plugins/<id>` and disables a row whose bytes it cannot load. So a
 * row-only fixture produces a tenant that looks like it has the board in SQL and behaves like it
 * does not in the app — which is how the portal tests came to assert a portal rendering on a site
 * with no board at all (`/portal/**` is now gated on the tenant actually having one).
 *
 * Copying the tree, writing a test report bound to the package's own root hash, and enabling the
 * row is what `installPlugin()` needs; the digest is a local constant because the runner image is
 * not part of what these tests prove.
 */
import Database from 'better-sqlite3';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { installPlugin } from '../../app/plugins/install.ts';
import { packageRootHash } from '../../app/plugins/manifest.ts';
import { REPO } from './fixture.ts';

const JOBBOARD = join(REPO, 'plugins', 'jobboard');
const DIGEST = 'sha256:jobboard-fixture';

/** Install (and enable) the job board for the tenant whose `site.db` is `siteDbPath`. */
export function installJobboardPackage(siteDbPath: string, fixtureDir: string): void {
  const { root } = packageRootHash(JOBBOARD);
  const report = join(fixtureDir, `jobboard-report-${join(siteDbPath).replace(/[^a-z0-9]/gi, '_')}.json`);
  writeFileSync(
    report,
    `${JSON.stringify({
      plugin: 'jobboard',
      version: '1.0.0',
      root_hash: root,
      runner_image_digest: DIGEST,
      ran_at: '2026-10-28T00:00:00.000Z',
      passed: 1,
      failed: 0,
    })}\n`,
  );
  installPlugin({
    siteDb: siteDbPath,
    pluginsRoot: join(fixtureDir, 'plugins'),
    sourceDir: JOBBOARD,
    allowUnsigned: true,
    testReportPath: report,
    runnerImageDigest: DIGEST,
    enable: true,
  });
}

/** True when the tenant's own file grants the board — the same row `jobsBoardEnabled` reads. */
export function jobboardRowEnabled(siteDbPath: string): boolean {
  const db = new Database(siteDbPath, { readonly: true });
  try {
    const row = db.prepare("SELECT enabled FROM cms_plugin_installed WHERE plugin_id = 'jobboard'").get() as
      | { enabled: number }
      | undefined;
    return row !== undefined && Number(row.enabled) === 1;
  } finally {
    db.close();
  }
}
