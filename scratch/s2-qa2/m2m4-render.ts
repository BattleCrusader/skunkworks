/**
 * QA round 2 — M4 / E-23: does §6.2's new render-time sentence match what the resolver re-checks?
 *
 *   node scratch/s2-qa2/m2m4-render.ts
 *
 * §6.2 now says exactly two rules run at both publish and render: the column allowlist and a `view`
 * source's checksum. Everything else is publish-only. This probe asks the resolver the same
 * questions the table answers, for a `query` source:
 *
 *   a. a column dropped out of band  -> the allowlist should refuse with the taxonomy code
 *   b. `limit: '5'` (an HTML attribute is a string) -> §6.2 says param_invalid, never ignored
 *   c. `limit: 2.7` -> floors to 2
 *   d. `limit: 1000` over limit_max 5 -> clamped, data-truncated
 */
import Database from 'better-sqlite3';
import { join } from 'node:path';

import { runDdl } from '../../app/ddl/run.ts';
import { publishSource } from '../../app/sources/publish.ts';
import { resolveSource } from '../../app/sources/resolve.ts';
import { openRenderRead } from '../../app/db/classes.ts';
import { makeFixture, REPO } from '../../test/helpers/fixture.ts';

const ACTOR = { userId: 1, label: 'qa2' };
const fixture = makeFixture({ specs: [{ key: 'acme', hosts: ['acme.test'] }] });
const FILE = fixture.sitePath('acme');

runDdl(
  FILE,
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
{
  const d = new Database(FILE);
  try {
    for (let i = 1; i <= 4; i += 1) {
      d.prepare('INSERT INTO u_posts (title, slug, status, published_at) VALUES (?,?,?,?)').run(
        `Post ${i}`,
        `post-${i}`,
        i <= 3 ? 'published' : 'draft',
        `2026-10-0${i}T00:00:00Z`,
      );
    }
  } finally {
    d.close();
  }
}

publishSource(
  FILE,
  {
    key: 'posts',
    kind: 'query',
    spec: {
      table: 'u_posts',
      columns: ['title', 'slug'],
      where: [{ col: 'status', op: '=', param: 'status' }],
      order: [{ col: 'published_at', dir: 'desc' }],
      limit_default: 3,
      limit_max: 5,
    },
    params: [{ name: 'status', kind: 'enum', values: ['published', 'draft'] }],
    isPublic: true,
    ttlS: 0,
  },
  ACTOR,
);
console.log('published query source `posts` over u_posts (columns title,slug; where status; limit_max 5)');

function ask(label: string, params: Record<string, unknown>): void {
  const d = openRenderRead(FILE);
  try {
    const r = resolveSource(d, 'posts', { tenantKey: 'acme', params });
    console.log(`  ${label.padEnd(46)} RESOLVED rows=${r.rows.length} limit=${r.limit} truncated=${String(r.truncated)}`);
  } catch (err) {
    const e = err as { code?: string; detail?: { reason?: string; column?: string; param?: string }; message?: string };
    console.log(
      `  ${label.padEnd(46)} REFUSED code=${String(e.code)} reason=${String(e.detail?.reason)} column=${String(e.detail?.column)} param=${String(e.detail?.param)} msg=${String(e.message).slice(0, 90)}`,
    );
  } finally {
    d.close();
  }
}

ask('a0. resolve before any drift', { status: 'published' });
ask('b. limit: "5" (string, as an attribute)', { status: 'published', limit: '5' });
ask('c. limit: 2.7', { status: 'published', limit: 2.7 });
ask('d. limit: 1000 (limit_max 5)', { status: 'published', limit: 1000 });

// a: the table loses a column out of band, exactly S2-qa.md §4 A5b
{
  const d = new Database(FILE);
  try {
    d.exec('ALTER TABLE u_posts DROP COLUMN slug');
    console.log('\ndropped u_posts.slug out of band (not through the DDL runner)');
    const allow = d.prepare('PRAGMA table_xinfo(u_posts)').all() as { name: string }[];
    console.log('  live columns now:', allow.map((c) => c.name).join(', '));
  } finally {
    d.close();
  }
}
ask('a1. resolve after the drop (allowlist re-check)', { status: 'published' });

console.log('\nsource `posts` spec still names slug; §6.2 row 1 says the allowlist is re-checked at render');

// The same question IN BAND: a rebuild through the DDL runner updates cms_table_registry in the
// same transaction, so the render-time allowlist read should now refuse with the taxonomy code.
runDdl(
  FILE,
  [
    {
      op: 'create_table',
      name: 'u_notes',
      columns: [
        { name: 'title', type: 'TEXT', notNull: true },
        { name: 'body', type: 'TEXT', notNull: true },
        { name: 'status', type: 'TEXT', notNull: true },
      ],
    },
    { op: 'create_index', table: 'u_notes', name: 'ix_notes_status', columns: ['status'], unique: false },
  ],
  { actor: ACTOR },
);
{
  const d = new Database(FILE);
  try {
    d.prepare("INSERT INTO u_notes (title, body, status) VALUES ('n1','b1','ok')").run();
  } finally {
    d.close();
  }
}
publishSource(
  FILE,
  {
    key: 'notes',
    kind: 'query',
    spec: {
      table: 'u_notes',
      columns: ['title', 'body'],
      where: [{ col: 'status', op: '=', param: 'status' }],
      limit_default: 2,
      limit_max: 5,
    },
    params: [{ name: 'status', kind: 'enum', values: ['ok'] }],
    isPublic: true,
    ttlS: 0,
  },
  ACTOR,
);
{
  const d = openRenderRead(FILE);
  try {
    const r = resolveSource(d, 'notes', { tenantKey: 'acme', params: { status: 'ok' } });
    console.log(`\n  e0. resolve notes before the in-band drop   RESOLVED rows=${r.rows.length}`);
  } finally {
    d.close();
  }
}
runDdl(FILE, [{ op: 'drop_column', table: 'u_notes', column: 'body' }], { actor: ACTOR });
{
  const d = openRenderRead(FILE);
  try {
    const r = resolveSource(d, 'notes', { tenantKey: 'acme', params: { status: 'ok' } });
    console.log(`  e1. resolve notes after the in-band drop    RESOLVED rows=${r.rows.length} (the allowlist did not notice)`);
  } catch (err) {
    const e = err as { code?: string; detail?: { reason?: string; column?: string }; message?: string };
    console.log(`  e1. resolve notes after the in-band drop    REFUSED code=${String(e.code)} reason=${String(e.detail?.reason)} column=${String(e.detail?.column)}`);
  } finally {
    d.close();
  }
}

fixture.cleanup();
