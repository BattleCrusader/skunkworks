/** D6 — concurrent publish + resolve of the same source, two processes. */
import { spawn } from 'node:child_process';
import Database from 'better-sqlite3';

import { runDdl } from '../../app/ddl/run.ts';
import { openRenderRead } from '../../app/db/classes.ts';
import { createRenderData } from '../../app/render/data.ts';
import { SourceCache } from '../../app/sources/cache.ts';
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
  for (let i = 1; i <= 6; i += 1) {
    seed.prepare('INSERT INTO u_posts (title, slug, status, published_at) VALUES (?, ?, ?, ?)').run(`Post ${i}`, `post-${i}`, i % 2 === 0 ? 'draft' : 'published', `2026-10-0${i}T00:00:00Z`);
  }
  seed
    .prepare(
      `INSERT INTO cms_datasource (key, kind, spec_json, params_json, is_public, ttl_s, published_at, published_by)
       VALUES ('race', 'query',
               '{"table":"u_posts","columns":["title"],"where":[{"col":"status","op":"=","param":"status"}],"order":[{"col":"published_at","dir":"desc"}],"limit_default":3,"limit_max":50}',
               '[{"name":"status","kind":"enum","values":["published","draft"]}]', 1, 60, '2026-10-20T00:00:00.000Z', 1)`,
    )
    .run();
} finally {
  seed.close();
}

const child = spawn(process.execPath, ['scratch/s2-qa/pub-loop.ts', fixture.sitePath('acme'), '25'], { stdio: ['ignore', 'pipe', 'pipe'] });
let childOut = '';
let childErr = '';
child.stdout.on('data', (c: Buffer) => (childOut += c.toString()));
child.stderr.on('data', (c: Buffer) => (childErr += c.toString()));

const db = openRenderRead(fixture.sitePath('acme'));
const cache = new SourceCache();
const data = createRenderData(db, { tenantKey: 'acme', cache });
let resolves = 0;
const signatures = new Map<string, number>();
const errors: string[] = [];
let cacheCleared = 0;

while (child.exitCode === null && resolves < 20000) {
  try {
    const r = data.source('race', { status: 'published', limit: 6 });
    resolves += 1;
    const cols = Object.keys(r.rows[0] ?? {}).sort().join(',');
    signatures.set(`${r.rows.length} rows [${cols}]`, (signatures.get(`${r.rows.length} rows [${cols}]`) ?? 0) + 1);
    // The cache key includes specRev, so a republish must never be served the old shape.
    if (resolves % 50 === 0) {
      cache.clear();
      cacheCleared += 1;
    }
  } catch (err) {
    const e = err as { code?: string; message?: string };
    errors.push(`${String(e.code)}: ${String(e.message)}`);
  }
  await new Promise((r) => setImmediate(r));
}
db.close();

const finished = await new Promise<number>((resolve) => child.on('close', (code) => resolve(code ?? -1)));

console.log('child exit:', finished);
console.log('child stdout:', childOut.trim() || '(none)');
console.log('child stderr:', childErr.trim() ? childErr.trim().slice(0, 600) : '(none)');
console.log('resolutions during the publish loop:', resolves);
console.log('distinct result shapes:', JSON.stringify(Object.fromEntries(signatures)));
console.log('cache clears during the race:', cacheCleared);
console.log('errors:', errors.length === 0 ? 'none' : JSON.stringify(errors.slice(0, 5)));
fixture.cleanup();
