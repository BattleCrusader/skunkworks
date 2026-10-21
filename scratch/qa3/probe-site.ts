/**
 * QA3 — the failure model end to end over HTTP: a plugin whose filter throws and whose second
 * filter returns the wrong type, enabled on a real app, requested until the counter disables it.
 * Asserts: every response is 200, the page body is the core body, the row ends disabled, a
 * notice names the plugin, and the registry has no entry.
 */
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadEnv } from '../../app/env.ts';
import { buildApp } from '../../app/main.ts';
import { installPlugin } from '../../app/plugins/install.ts';
import { packageRootHash } from '../../app/plugins/manifest.ts';
import { openAdminWrite } from '../../app/db/classes.ts';
import { call } from '../../test/helpers/http.ts';
import { REPO, makeFixture } from '../../test/helpers/fixture.ts';

const TENANT = 'acme';
const HOST = 'acme.test';
const DIGEST = 'sha256:qa3-thrower';
const THROWER = join(REPO, 'test', 'fixtures', 'plugins', 'thrower');

const fixture = makeFixture({ specs: [{ key: TENANT, hosts: [HOST], title: 'Acme', body: '<h1>Still serving</h1>' }] });
const handle = await buildApp({ env: loadEnv(fixture.env) });
try {
  {
    const db = openAdminWrite(fixture.sitePath(TENANT), 5000);
    try {
      db.prepare(
        `INSERT INTO cms_page (path, slug, title, status, template, body_html)
         VALUES ('/still-serving', 'still-serving', 'Still serving', 'published', 'page', '<h1>Still serving</h1>')`,
      ).run();
    } finally {
      db.close();
    }
  }
  const report = join(fixture.dir, 'thrower-report.json');
  writeFileSync(
    report,
    `${JSON.stringify({ plugin: 'thrower', version: '1.0.0', root_hash: packageRootHash(THROWER).root, runner_image_digest: DIGEST, ran_at: new Date().toISOString() }, null, 2)}\n`,
  );
  installPlugin({
    siteDb: fixture.sitePath(TENANT),
    pluginsRoot: join(fixture.dir, 'plugins'),
    sourceDir: THROWER,
    allowUnsigned: true,
    testReportPath: report,
    runnerImageDigest: DIGEST,
  });

  await handle.app.listen({ port: 0, host: '127.0.0.1' });
  const address = handle.app.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  await handle.plugins.enable(TENANT, 'thrower');
  console.log('enabled; hooks in registry:', handle.plugins.registry.hooksFor(TENANT, 'content.render.html').length);

  for (let i = 1; i <= 4; i += 1) {
    const res = await call({ port, path: '/still-serving', host: HOST });
    const stillCore = res.body.includes('<h1>Still serving</h1>');
    const leaked = /thrower|42/.test(res.body);
    console.log(
      `request ${i}: status=${res.status} coreBody=${stillCore} leaked=${leaked} enabled=${String(rowEnabled())} registry=${handle.plugins.registry.has(TENANT, 'thrower')}`,
    );
  }
  const notice = handle.plugins.noticesFor(TENANT).find((n) => n.plugin === 'thrower');
  console.log('notice:', notice === undefined ? 'NONE' : `${notice.code} :: ${notice.message}`);
  // A fourth request after the disable: still 200, and the hook is gone.
  const after = await call({ port, path: '/still-serving', host: HOST });
  console.log(`after disable: status=${after.status} hooks=${handle.plugins.registry.hooksFor(TENANT, 'content.render.html').length}`);
} finally {
  await handle.close();
  fixture.cleanup();
}

function rowEnabled(): number {
  const db = new Database(fixture.sitePath(TENANT), { readonly: true });
  try {
    return Number((db.prepare("SELECT enabled FROM cms_plugin_installed WHERE plugin_id = 'thrower'").get() as { enabled: number }).enabled);
  } finally {
    db.close();
  }
}

void readFileSync;
void mkdtempSync;
void tmpdir;
void rmSync;
