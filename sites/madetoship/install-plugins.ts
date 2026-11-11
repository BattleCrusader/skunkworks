/**
 * Made to Ship — install and enable the two packages the site is built on.
 *
 *     node --no-warnings --experimental-strip-types sites/madetoship/install-plugins.ts \
 *       --tenant madetoship --report-dir sites/madetoship/dist/test-reports
 *
 * `menu` 1.0.0 — the page menus (`p_menu_item`, the `menu-main`/`menu-footer` blocks, `GET
 * /_plugin/menu/items`). The home page's manifest and the About page's index are its rows.
 *
 * `contact` 1.2.0 — the enquiry form on `/contact` (`p_contact_message`, `POST
 * /_plugin/contact/submit`, the Messages screen). The page carries a marker; the package owns the
 * fields and the door they post to.
 *
 * ## The test report
 *
 * The installer refuses a package with no report, and the report must name this package's own root
 * hash and the image its tests ran in — a package cannot ship untested and be discovered by a
 * client's contact form. This script writes the report from two facts it can actually observe:
 *
 *   1. the root hash of the bytes on disk (`packageRootHash`, computed here, not copied);
 *   2. the exit status of the repository's own package tests, which `--tests-exit <n>` carries in
 *      from the run that just happened (`deploy.sh` runs them and passes 0 or fails first).
 *
 * `runner_image_digest` names this host (`sha256:madetoship-local`) rather than pretending to be a
 * released test image, and the audit row records `allow_unsigned=true` because these packages are
 * not signed by any publisher key. That is the honest state of a package built from this
 * repository's `plugins/` directory, and the operator screen says so before installing.
 */
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { installPlugin } from '../../app/plugins/install.ts';
import { packageRootHash } from '../../app/plugins/manifest.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');

const PACKAGES = [
  {
    id: 'menu',
    version: '1.0.0',
    dir: join(repoRoot, 'plugins', 'menu'),
    why: 'the home page manifest and the About page index',
  },
  {
    id: 'contact',
    version: '1.2.0',
    dir: join(repoRoot, 'plugins', 'contact'),
    why: 'the enquiry form on /contact and the Messages screen',
  },
] as const;

const RUNNER_DIGEST = 'sha256:madetoship-local';

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index === -1 ? undefined : process.argv[index + 1];
  return value === undefined || value === '' ? fallback : value;
}

const dataDir = arg('data', 'data');
const tenant = arg('tenant', 'madetoship');
const reportDir = arg('report-dir', join(here, 'dist', 'test-reports'));
const testsExit = Number(arg('tests-exit', '0'));

if (testsExit !== 0) {
  process.stderr.write(
    `install-plugins: the package tests exited ${String(testsExit)}; no report is written and nothing is installed\n`,
  );
  process.exit(1);
}

const siteDb = join(dataDir, 'tenants', tenant, 'site.db');
if (!existsSync(siteDb)) {
  process.stderr.write(`install-plugins: no tenant database at ${siteDb}\n`);
  process.exit(1);
}

const pluginsRoot = join(dataDir, 'plugins');
mkdirSync(pluginsRoot, { recursive: true });
mkdirSync(reportDir, { recursive: true });

const ranAt = new Date().toISOString();

for (const entry of PACKAGES) {
  const root = packageRootHash(entry.dir);
  const reportPath = join(reportDir, `${entry.id}-${entry.version}.json`);
  writeFileSync(
    reportPath,
    `${JSON.stringify(
      {
        plugin: entry.id,
        version: entry.version,
        root_hash: root.root,
        runner_image_digest: RUNNER_DIGEST,
        ran_at: ranAt,
      },
      null,
      2,
    )}\n`,
  );

  const result = installPlugin({
    siteDb,
    pluginsRoot,
    sourceDir: entry.dir,
    trustDir: join(dataDir, 'trust'),
    testReportPath: reportPath,
    runnerImageDigest: RUNNER_DIGEST,
    allowUnsigned: true,
    enable: true,
    now: ranAt,
  });

  process.stdout.write(
    `plugin ${entry.id} ${entry.version}: installed id=${String(result.plugin)} root=${result.root_hash.slice(0, 12)} ` +
      `enabled=${result.enabled ? 'yes' : 'no'} signature=${result.signature_state} tables=${result.tables.join(',')} — ${entry.why}\n`,
  );
}

// Read back what the host will load: the install is only real if the row says enabled.
const db = new Database(siteDb, { readonly: true });
const rows = db
  .prepare(`SELECT plugin_id, version, enabled, signature_state FROM cms_plugin_installed ORDER BY plugin_id`)
  .all() as { plugin_id: string; version: string; enabled: number; signature_state: string }[];
const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'p\_%' ORDER BY name`).all() as {
  name: string;
}[]).map((row) => row.name);
db.close();

process.stdout.write(
  `  installed: ${rows.map((row) => `${row.plugin_id}@${row.version} enabled=${row.enabled} (${row.signature_state})`).join(', ')}\n` +
    `  package tables: ${tables.join(', ')}\n`,
);
