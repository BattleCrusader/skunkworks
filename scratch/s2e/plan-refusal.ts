#!/usr/bin/env node
/**
 * S2e report probe — the plan refusal, verbatim.
 *
 *   node --experimental-strip-types scratch/s2e/plan-refusal.ts
 *
 * Builds a real site.db with the real DDL runner, publishes a source whose filter
 * column has no index, prints the `EXPLAIN QUERY PLAN` rows and the refusal, then
 * adds the index the refusal named and publishes the same source.
 */
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runDdl } from '../../app/ddl/run.ts';
import { publishSource } from '../../app/sources/publish.ts';
import { bindParams, compile, measurementParams } from '../../app/sources/compile.ts';
import { allowlistFor } from '../../app/sources/registry.ts';
import { parseSpec } from '../../app/sources/spec.ts';
import { explain } from '../../app/sources/plan.ts';

const dir = mkdtempSync(join(tmpdir(), 'skw-s2e-'));
const file = join(dir, 'site.db');
const seed = new Database(file);
seed.pragma('journal_mode = WAL');
seed.exec(readFileSync(new URL('../../schema/site.sql', import.meta.url), 'utf8'));
seed.close();

const actor = { userId: 1, label: 'probe' };
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
  ],
  { actor },
);
const db = new Database(file);
for (let i = 1; i <= 5; i += 1) {
  db.prepare("INSERT INTO u_posts (title, slug, status, published_at) VALUES (?, ?, 'published', ?)").run(`P${i}`, `p-${i}`, `2026-10-0${i}`);
}
db.prepare("INSERT INTO u_posts (title, slug, status, published_at) VALUES ('D', 'd-1', 'draft', '2026-09-01')").run();

const spec = parseSpec(
  'query',
  {
    table: 'u_posts',
    columns: ['title', 'slug'],
    where: [{ col: 'status', op: '=', param: 'status' }],
    order: [{ col: 'published_at', dir: 'desc' }],
    limit_default: 3,
    limit_max: 50,
  },
  [{ name: 'status', kind: 'enum', values: ['published', 'draft'] }],
);
const allowed = allowlistFor(db, 'query', 'u_posts');
const compiled = compile(spec, allowed, bindParams(spec, measurementParams(spec)));
console.log('SQL:', compiled.sql);
console.log('EXPLAIN QUERY PLAN (before the index):');
for (const row of explain(db, compiled.sql, compiled.bind)) console.log(`  id=${row.id} parent=${row.parent}  ${row.detail}`);

const input = {
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
  ttlS: 60,
} as const;

try {
  publishSource(file, input, actor);
  console.log('UNEXPECTED: the unindexed source published');
} catch (err) {
  const e = err as { code?: string; message?: string; detail?: { column?: string; plan?: string[] } };
  console.log('REFUSED:', e.code);
  console.log('MESSAGE:', e.message);
  console.log('DETAIL.column:', e.detail?.column);
  console.log('DETAIL.plan:', JSON.stringify(e.detail?.plan));
}

runDdl(file, [{ op: 'create_index', table: 'u_posts', name: 'ix_posts_status', columns: ['status'], unique: false }], { actor });
console.log('EXPLAIN QUERY PLAN (after ix_posts_status):');
const allowed2 = allowlistFor(db, 'query', 'u_posts');
const compiled2 = compile(spec, allowed2, bindParams(spec, measurementParams(spec)));
for (const row of explain(db, compiled2.sql, compiled2.bind)) console.log(`  id=${row.id} parent=${row.parent}  ${row.detail}`);

const report = publishSource(file, input, actor);
console.log('PUBLISHED:', JSON.stringify({ kind: report.kind, cost_ms_max: report.cost_ms_max, cost_ms_p95: report.cost_ms_p95, cost_rows: report.cost_rows }));
db.close();
rmSync(dir, { recursive: true, force: true });
