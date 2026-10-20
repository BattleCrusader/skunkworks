/**
 * How much headroom the default 1.5 ms publish ceiling has, idle and under CPU load.
 *
 * The point: decide, from a measurement, whether an ordinary publish in `make test` can be
 * flipped to `SKW_E_RT_SOURCE_BUDGET` by contention alone.
 */
import { publishSource } from '../../app/sources/publish.ts';
import { makeFixture } from '../../test/helpers/fixture.ts';
import { runDdl } from '../../app/ddl/run.ts';

const ACTOR = { userId: 7, label: 'probe' };
const SPEC = {
  table: 'u_posts',
  columns: ['title', 'slug'],
  where: [{ col: 'status', op: '=' as const, param: 'status' }],
  order: [{ col: 'published_at', dir: 'desc' as const }],
  limit_default: 3,
  limit_max: 50,
};
const POSTS = {
  key: 'posts',
  kind: 'query',
  spec: SPEC,
  params: [{ name: 'status', kind: 'enum', values: ['published', 'draft'] }],
  isPublic: true,
  ttlS: 60,
};

const fixture = makeFixture({ specs: [{ key: 'acme', hosts: ['acme.test'] }] });
try {
  const file = fixture.sitePath('acme');
  runDdl(
    file,
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
      { op: 'create_index', table: 'u_posts', name: 'ix_posts_slug', columns: ['slug'], unique: true },
      { op: 'create_index', table: 'u_posts', name: 'ix_posts_published_at', columns: ['published_at'], unique: false },
      { op: 'create_index', table: 'u_posts', name: 'ix_posts_status', columns: ['status'], unique: false },
    ],
    { actor: ACTOR },
  );
  const samples: number[] = [];
  for (let i = 0; i < 10; i += 1) {
    const report = publishSource(file, { ...POSTS, key: `probe-${i}` }, ACTOR);
    samples.push(Number(report.cost_ms_max));
  }
  const max = Math.max(...samples);
  console.log(
    `cost_ms_max over 10 publishes: ${samples.map((s) => s.toFixed(4)).join(' ')}  max=${max.toFixed(4)} ms`,
  );
  console.log(`headroom to the 1.5 ms ceiling: ${(1.5 / max).toFixed(1)}x`);
} finally {
  fixture.cleanup();
}
