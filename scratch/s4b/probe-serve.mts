/**
 * S4b probe 1 — what the site serves today, byte for byte.
 *
 * Boots the real app against a real fixture, inserts a page whose body names an
 * asset key (D17), and dumps the response body as base64 + a readable form.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { openAdminWrite } from '../../app/db/classes.ts';
import { loadEnv } from '../../app/env.ts';
import { buildApp } from '../../app/main.ts';
import { call } from '../../test/helpers/http.ts';
import { REPO, SCHEMA, makeFixture } from '../../test/helpers/fixture.ts';

const fixture = makeFixture({ specs: [{ key: 'acme', hosts: ['acme.test'], title: 'Acme' }] });
const db = openAdminWrite(fixture.sitePath('acme'));
db.prepare(
  `INSERT INTO cms_asset (key, filename, mime, bytes, sha256, kind, width, height, access_class)
   VALUES ('work/one', 'one.jpg', 'image/jpeg', 10, ?, 'image', 1200, 800, 'public')`,
).run('ab'.repeat(32));
db.prepare(
  `INSERT INTO cms_page (path, slug, title, status, template, body_html, body_css, published_at)
   VALUES ('/about', 'about', 'About us', 'published', 'page', ?, '.a{color:red}', '2026-01-01T00:00:00.000Z')`,
).run('<section data-gjs-type="hero"><h1>About</h1><img data-asset-key="work/one" alt="One"></section>');
db.close();

const handle = await buildApp({ env: loadEnv(fixture.env), schemaDir: SCHEMA, contentRoot: `${fixture.dir}/content` });
await handle.app.listen({ port: 0, host: '127.0.0.1' });
const addr = handle.app.server.address();
const port = typeof addr === 'object' && addr !== null ? addr.port : 0;

const res = await call({ port, path: '/about', host: 'acme.test' });
const text = res.body;
process.stdout.write(`status ${res.status} bytes ${Buffer.byteLength(text)}\n---\n${JSON.stringify(text)}\n---\n`);
writeFileSync(join(REPO, 'scratch', 's4b', 'served-about.html'), text);

await handle.close();
fixture.cleanup();
