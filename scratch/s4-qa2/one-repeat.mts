import { openAdminWrite } from '../../app/db/classes.ts';
import { loadRegistry } from '../../app/editor/registry.ts';
import { savePage } from '../../app/editor/save.ts';
import { SCHEMA, makeFixture } from '../../test/helpers/fixture.ts';

const registry = loadRegistry(SCHEMA);
const f = makeFixture({ specs: [{ key: 'acme', hosts: ['acme.test'], title: 'Acme' }] });
const db = openAdminWrite(f.sitePath('acme'));
const html = `<div class="list" data-gjs-type="list" data-source="posts" data-limit="3">` +
  `<article class="card" data-repeat><h3 data-bind-title="title">One</h3></article>` +
  `` +
  `</div>`;
try {
  const r = await savePage({ db, registry, path: '/qa-two-repeat', slug: 'qa-two-repeat', title: 'QA', template: 'page', html });
  console.log('ACCEPTED', JSON.stringify({ bodyHtml: r.bodyHtml, items: r.items }));
} catch (e) {
  console.log('REFUSED', (e as Error).message);
}
db.close(); f.cleanup();
