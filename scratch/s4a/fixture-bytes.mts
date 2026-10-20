/**
 * The nine fixtures' stored bytes, measured through `savePage()` **with the canvas document
 * as the input** — i.e. `editor.getHtml()`, which is what `window.skwSave` posts.
 *
 * Run once with the F1 fix in place and once with it reverted: the two tables are the
 * before/after the report quotes (same input, same canonicaliser, one line different).
 *
 *   node scratch/s4a/fixture-bytes.mts
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { openAdminWrite } from '../../app/db/classes.ts';
import { loadRegistry } from '../../app/editor/registry.ts';
import { savePage } from '../../app/editor/save.ts';
import { REPO, SCHEMA, makeFixture } from '../../test/helpers/fixture.ts';
import { openEditor } from '../../test/helpers/grapes.ts';

const registry = loadRegistry(SCHEMA);
const SITE = join(REPO, 'test', 'fixtures', 'site');
const PAGES = readdirSync(SITE).filter((n) => n.endsWith('.html')).sort();

const fixture = makeFixture({ specs: [{ key: 'acme', hosts: ['acme.test'], title: 'Acme' }] });
const db = openAdminWrite(fixture.sitePath('acme'));
const editor = await openEditor(registry);
const rows: string[] = [];
try {
  for (const page of PAGES) {
    const authored = readFileSync(join(SITE, page), 'utf8');
    editor.load(authored);
    const canvas = editor.document().html;
    const saved = await savePage({
      db,
      registry,
      path: `/bytes/${page.replace('.html', '')}`,
      slug: page.replace('.html', ''),
      title: page,
      template: 'page',
      html: canvas,
    });
    const bytes = Buffer.byteLength(saved.bodyHtml, 'utf8');
    const body = /<body[\s>]/i.test(saved.bodyHtml);
    const firstLine = saved.bodyHtml.split('\n')[0] ?? '';
    rows.push(
      `| \`${page}\` | ${canvas.length} | ${bytes} | ${body ? '**yes**' : 'no'} | \`${firstLine.slice(0, 44)}\` |`,
    );
  }
} finally {
  editor.destroy();
  db.close();
  fixture.cleanup();
}
console.log('| fixture | canvas doc B | stored B | contains `<body` | first line |');
console.log('|---|---|---|---|---|');
for (const row of rows) console.log(row);
