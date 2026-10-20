#!/usr/bin/env node
/**
 * S2e report probe — the parameter-set cache and the TTL, as numbers.
 *
 *   node scratch/s2e/cache-ttl.ts
 */
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runDdl } from '../../app/ddl/run.ts';
import { publishSource } from '../../app/sources/publish.ts';
import { resolveSource } from '../../app/sources/resolve.ts';
import { SourceCache } from '../../app/sources/cache.ts';
import { openRenderRead } from '../../app/db/classes.ts';

const dir = mkdtempSync(join(tmpdir(), 'skw-s2e-cache-'));
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
    { op: 'create_index', table: 'u_posts', name: 'ix_posts_status', columns: ['status'], unique: false },
    { op: 'create_index', table: 'u_posts', name: 'ix_posts_published_at', columns: ['published_at'], unique: false },
  ],
  { actor },
);
const admin = new Database(file);
const insert = admin.prepare('INSERT INTO u_posts (title, slug, status, published_at) VALUES (?, ?, ?, ?)');
for (let i = 1; i <= 5; i += 1) insert.run(`P${i}`, `p-${i}`, 'published', `2026-10-0${i}`);
insert.run('D1', 'd-1', 'draft', '2026-09-01');
insert.run('D2', 'd-2', 'draft', '2026-09-02');
admin.close();

publishSource(
  file,
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
    ttlS: 1,
  },
  actor,
);

let clock = 1_000_000;
const db = openRenderRead(file);
const a = new SourceCache({ now: () => clock });
const three = resolveSource(db, 'posts', { tenantKey: 'acme', params: { status: 'published', limit: 3 }, cache: a });
const five = resolveSource(db, 'posts', { tenantKey: 'acme', params: { status: 'published', limit: 5 }, cache: a });
console.log(`order A: {limit:3} -> ${three.rows.length} rows; {limit:5} -> ${five.rows.length} rows; cache size ${a.size}`);
const b = new SourceCache({ now: () => clock });
const fiveFirst = resolveSource(db, 'posts', { tenantKey: 'acme', params: { status: 'published', limit: 5 }, cache: b });
const threeSecond = resolveSource(db, 'posts', { tenantKey: 'acme', params: { status: 'published', limit: 3 }, cache: b });
console.log(`order B: {limit:5} -> ${fiveFirst.rows.length} rows; {limit:3} -> ${threeSecond.rows.length} rows; cache size ${b.size}`);
console.log('row sets differ:', JSON.stringify(three.rows) !== JSON.stringify(five.rows));

const ttl = new SourceCache({ now: () => clock });
const before = resolveSource(db, 'posts', { tenantKey: 'acme', params: { status: 'draft', limit: 10 }, cache: ttl });
const write = new Database(file);
write.prepare("INSERT INTO u_posts (title, slug, status, published_at) VALUES ('D3', 'd-3', 'draft', '2026-09-03')").run();
write.close();
const cached = resolveSource(db, 'posts', { tenantKey: 'acme', params: { status: 'draft', limit: 10 }, cache: ttl });
clock += 1_001;
const fresh = resolveSource(db, 'posts', { tenantKey: 'acme', params: { status: 'draft', limit: 10 }, cache: ttl });
console.log(`ttl_s=1: before ${before.rows.length} rows; row inserted; inside TTL ${cached.rows.length}; after +1001 ms ${fresh.rows.length}`);
db.close();
rmSync(dir, { recursive: true, force: true });
