/**
 * S4b probe 2 — the two document shapes Astro emits that `renderDocument` has to match:
 * a page with no body_css (does the `<style>` line vanish, or leave four spaces?) and a
 * title carrying `&` and `<`.
 */
import { openAdminWrite } from '../../app/db/classes.ts';
import { loadEnv } from '../../app/env.ts';
import { buildApp } from '../../app/main.ts';
import { SCHEMA, makeFixture } from '../../test/helpers/fixture.ts';
import { call } from '../../test/helpers/http.ts';

const fixture = makeFixture({ specs: [{ key: 'acme', hosts: ['acme.test'], title: 'Acme' }] });
const db = openAdminWrite(fixture.sitePath('acme'));
db.prepare(
  `INSERT INTO cms_page (path, slug, title, status, template, body_html, body_css, published_at)
   VALUES ('/plain', 'plain', 'Fish & Chips <Co>', 'published', 'page', '<p>plain</p>', '', '2026-01-01T00:00:00.000Z')`,
).run();
db.close();

const handle = await buildApp({ env: loadEnv(fixture.env), schemaDir: SCHEMA, contentRoot: `${fixture.dir}/content` });
await handle.app.listen({ port: 0, host: '127.0.0.1' });
const addr = handle.app.server.address();
const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
const res = await call({ port, path: '/plain', host: 'acme.test' });
process.stdout.write(`${JSON.stringify(res.body)}\n`);
await handle.close();
fixture.cleanup();
