/** D5b — a `query` source whose underlying table lost a column after publish. */
import Database from 'better-sqlite3';

import { runDdl } from '../../app/ddl/run.ts';
import { openRenderRead } from '../../app/db/classes.ts';
import { createRenderData } from '../../app/render/data.ts';
import { publishSource } from '../../app/sources/publish.ts';
import { makeFixture } from '../../test/helpers/fixture.ts';

const ACTOR = { userId: 1, label: 'qa@acme.test' };
const fixture = makeFixture({ specs: [{ key: 'acme', hosts: ['acme.test'] }] });
runDdl(
  fixture.sitePath('acme'),
  [
    {
      op: 'create_table',
      name: 'u_posts',
      columns: [
        { name: 'title', type: 'TEXT', notNull: true },
        { name: 'slug', type: 'TEXT', notNull: true },
        { name: 'status', type: 'TEXT', notNull: true },
        { name: 'published_at', type: 'DATE' },
      ],
    },
    { op: 'create_index', table: 'u_posts', name: 'ix_posts_status', columns: ['status'], unique: false },
    { op: 'create_index', table: 'u_posts', name: 'ix_posts_published_at', columns: ['published_at'], unique: false },
  ],
  { actor: ACTOR },
);
const seed = new Database(fixture.sitePath('acme'));
try {
  seed.prepare("INSERT INTO u_posts (title, slug, status, published_at) VALUES ('One','one','published','2026-10-01T00:00:00Z')").run();
} finally {
  seed.close();
}

publishSource(
  fixture.sitePath('acme'),
  {
    key: 'posts',
    kind: 'query',
    spec: {
      table: 'u_posts',
      columns: ['title', 'slug'],
      where: [{ col: 'status', op: '=', param: 'status' }],
      order: [{ col: 'published_at', dir: 'desc' }],
      limit_default: 3,
      limit_max: 50,
    },
    params: [{ name: 'status', kind: 'enum', values: ['published', 'draft'] }],
    isPublic: true,
    ttlS: 0,
  },
  ACTOR,
);

const db = openRenderRead(fixture.sitePath('acme'));
const data = createRenderData(db, { tenantKey: 'acme' });
console.log('before the drop:', JSON.stringify(data.source('posts', { status: 'published', limit: 5 }).rows));
db.close();

const mutate = new Database(fixture.sitePath('acme'));
try {
  mutate.exec('ALTER TABLE u_posts DROP COLUMN slug');
  const reg = mutate.prepare("SELECT columns_json FROM cms_table_registry WHERE table_name = 'u_posts'").get() as { columns_json: string };
  console.log('registry still lists:', JSON.parse(reg.columns_json).map((c: { name: string }) => c.name).join(','));
} finally {
  mutate.close();
}

const db2 = openRenderRead(fixture.sitePath('acme'));
const data2 = createRenderData(db2, { tenantKey: 'acme' });
try {
  console.log('after the drop:', JSON.stringify(data2.source('posts', { status: 'published', limit: 5 }).rows));
} catch (err) {
  const e = err as { code?: string; message?: string; detail?: unknown };
  console.log('after the drop: THREW', String(e.code), '/', String(e.message), '/', JSON.stringify(e.detail));
} finally {
  db2.close();
}
fixture.cleanup();
