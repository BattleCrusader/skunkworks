
/**
 * S4a ITEM 1/2 harness: a real `buildApp` on a real socket, an operator with a real
 * argon2id password and a real TOTP secret, and the admin origin moved to
 * `http://localhost:<port>` so a headless Chrome can hold the `__Host-` cookie
 * (Chrome treats http://localhost as a trustworthy origin for `Secure` cookies).
 *
 * Nothing about the app is stubbed: this is `buildApp`, `loadRegistry` from `schema/`,
 * the vendored GrapesJS bundle, and the real save route. The only thing the script does
 * is choose the data directory and the port and stay alive.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';

import { loadEnv } from '../../app/env.ts';
import { buildApp } from '../../app/main.ts';
import { loadRegistry } from '../../app/editor/registry.ts';
import { TOTP_SECRET, seedUser, openSession } from '../../test/helpers/admin.ts';
import { SCHEMA, makeFixture } from '../../test/helpers/fixture.ts';
import { openAdminWrite } from '../../app/db/classes.ts';

const OUT = '/Volumes/Backup/Development/skunkworks/scratch/s4a/run';
mkdirSync(OUT, { recursive: true });

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

const port = await freePort();
const fixture = makeFixture({ specs: [{ key: 'acme', hosts: ['acme.test'], title: 'Acme' }] });
await seedUser({ controlDb: fixture.controlDb, tenantKey: 'acme', email: 'owner@acme.test', totpSecret: TOTP_SECRET });

const env = {
  ...fixture.env,
  SKW_ADMIN_ORIGIN: `http://localhost:${port}`,
};

// A public image asset for the picker, and one page whose body names a type the image
// does not ship (the ITEM 2a fixture — the refusal has to happen at load).
const site = openAdminWrite(fixture.sitePath('acme'));
try {
  site
    .prepare(
      `INSERT INTO cms_asset (key, filename, mime, bytes, sha256, kind, width, height)
       VALUES ('banner/home', 'b.jpg', 'image/jpeg', 10, ?, 'image', 1200, 800)`,
    )
    .run('ab'.repeat(32));
  // A second key, so the picker test can prove it *wrote* a new key rather than
  // echoing the one the registry's default block already carried.
  site
    .prepare(
      `INSERT INTO cms_asset (key, filename, mime, bytes, sha256, kind, width, height)
       VALUES ('gallery/one', 'g1.jpg', 'image/jpeg', 11, ?, 'image', 800, 800)`,
    )
    .run('cd'.repeat(32));
  site
    .prepare(
      `INSERT INTO cms_page (path, slug, title, status, template, body_html, body_css, rev, body_sha, managed_by)
       VALUES ('/legacy', 'legacy', 'Legacy', 'draft', 'page', '<div data-gjs-type="carousel"><p>slides</p></div>', '', 0, '', 'editor')`,
    )
    .run();
} finally {
  site.close();
}

const registry = loadRegistry(SCHEMA);
const handle = await buildApp({
  env: loadEnv(env as Record<string, string>),
  schemaDir: SCHEMA,
  contentRoot: `${fixture.dir}/content`,
});
await handle.app.listen({ port, host: '127.0.0.1' });

const session = await openSession({ port, host: `localhost:${port}`, origin: `http://localhost:${port}`, email: 'owner@acme.test' });

writeFileSync(
  join(OUT, 'state.json'),
  JSON.stringify(
    {
      port,
      base: `http://localhost:${port}`,
      dir: fixture.dir,
      siteDb: fixture.sitePath('acme'),
      controlDb: fixture.controlDb,
      email: 'owner@acme.test',
      password: 'correct-horse-battery-staple',
      totpSecret: TOTP_SECRET,
      csrf: session.csrfToken,
      palette: registry.entries.filter((e) => e.kind !== 'shell').map((e) => ({ type: e.type, label: e.label, kind: e.kind })),
    },
    null,
    2,
  ),
);

// Keep the process alive; the browser is driven from outside.
process.on('SIGTERM', async () => {
  await handle.close();
  process.exit(0);
});
console.log(`listening on http://localhost:${port} (data ${fixture.dir})`);
setInterval(() => {}, 1 << 30);
