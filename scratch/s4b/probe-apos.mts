/** Does Astro escape an apostrophe in a title the same way `escapeHtml` does? */
import { openAdminWrite } from '../../app/db/classes.ts';
import { loadEnv } from '../../app/env.ts';
import { buildApp } from '../../app/main.ts';
import { SCHEMA, makeFixture } from '../../test/helpers/fixture.ts';
import { call } from '../../test/helpers/http.ts';
import { renderDocument } from '../../app/export/document.ts';

const fixture = makeFixture({ specs: [{ key: 'acme', hosts: ['acme.test'] }] });
const db = openAdminWrite(fixture.sitePath('acme'));
const title = "It's a \"quoted\" <title> & more";
db.prepare(`INSERT INTO cms_page (path, slug, title, status, template, body_html, body_css, published_at)
  VALUES ('/apos','apos',?,'published','page','<p>x</p>','','2026-01-01T00:00:00.000Z')`).run(title);
db.close();
const handle = await buildApp({ env: loadEnv(fixture.env), schemaDir: SCHEMA, contentRoot: `${fixture.dir}/content` });
await handle.app.listen({ port: 0, host: '127.0.0.1' });
const a = handle.app.server.address();
const port = typeof a === 'object' && a !== null ? a.port : 0;
const served = (await call({ port, path: '/apos', host: 'acme.test' })).body;
const mine = renderDocument({ tenantKey: 'acme', path: '/apos', title, bodyHtml: '<p>x</p>', bodyCss: '' });
console.log('astro :', served.split('\n')[5]);
console.log('mine  :', mine.split('\n')[5]);
console.log('equal :', served === mine);
await handle.close();
fixture.cleanup();
