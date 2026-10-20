/**
 * QA round 2 — M1 / E-21 re-attempt, against the real publish gate, the real resolver and the real
 * DDL runner.
 *
 *   node scratch/s2-qa2/m1-view.ts
 *
 * Part 1 is round 1's A5 repeated: publish a `view` source, then re-point the view out of band so
 * that it serves `cms_page` rows through a source published over `u_posts`. It must refuse, and it
 * must refuse with `reason='view_checksum'` and zero rows — not with the allowlist, which is why the
 * re-pointed view keeps the same column NAMES (`path AS title`).
 *
 * Part 2 runs a DDL op that changes a published view's body (`ALTER TABLE ... RENAME`, which SQLite
 * rewrites into the view): the checksum must move, the source must be un-published in the same
 * transaction, one `cms_audit` row must carry both digests, the next resolve must refuse
 * `not_published`, and a republish must resolve.
 */
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { runDdl } from '../../app/ddl/run.ts';
import { publishSource } from '../../app/sources/publish.ts';
import { resolveSource } from '../../app/sources/resolve.ts';
import { viewChecksumStats } from '../../app/sources/registry.ts';
import { openRenderRead } from '../../app/db/classes.ts';
import { makeFixture, SCHEMA } from '../../test/helpers/fixture.ts';

const ACTOR = { userId: 1, label: 'qa2' };

const fixture = makeFixture({ specs: [{ key: 'acme', hosts: ['acme.test'] }] });
const FILE = fixture.sitePath('acme');

function db(): Database.Database {
  return new Database(FILE);
}

function storedSql(relation: string): string {
  const d = db();
  try {
    const row = d.prepare("SELECT sql FROM sqlite_master WHERE type = 'view' AND name = ?").get(relation) as
      | { sql: string }
      | undefined;
    if (row === undefined) throw new Error(`no view ${relation}`);
    return row.sql;
  } finally {
    d.close();
  }
}

function registerView(relation: string, sql: string): string {
  const sum = createHash('sha256').update(sql).digest('hex');
  const d = db();
  try {
    d.prepare('INSERT INTO cms_view_registry (name, checksum) VALUES (?, ?)').run(relation, sum);
  } finally {
    d.close();
  }
  return sum;
}

/** The render path's own resolver, on a render-read connection. */
function resolve(key: string): string {
  const d = openRenderRead(FILE);
  try {
    const r = resolveSource(d, key, { tenantKey: 'acme', params: { limit: 10 } });
    return `RESOLVED rows=${JSON.stringify(r.rows)}`;
  } catch (err) {
    const e = err as { code?: string; detail?: { reason?: string; registered?: string; found?: string } };
    return `REFUSED ${String(e.code)} reason=${String(e.detail?.reason)} registered=${String(e.detail?.registered)} found=${String(e.detail?.found)}`;
  } finally {
    d.close();
  }
}

function show(label: string, value: string): void {
  console.log(`  ${label.padEnd(44)} ${value}`);
}

// --- the fixture's data -------------------------------------------------------------------------
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
  ],
  { actor: ACTOR },
);
{
  const d = db();
  try {
    for (let i = 1; i <= 5; i += 1) {
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

// =================================================================================================
console.log('M1 part 1 — a published `view` source, re-pointed out of band\n');

{
  const d = db();
  try {
    d.exec("CREATE VIEW cms_v_posts_public AS SELECT title FROM u_posts WHERE status = 'published'");
  } finally {
    d.close();
  }
}
const firstSql = storedSql('cms_v_posts_public');
const firstSum = registerView('cms_v_posts_public', firstSql);
show('sqlite_master.sql at publish', JSON.stringify(firstSql));
show('registry checksum', firstSum.slice(0, 16) + '…');

const pub = publishSource(
  FILE,
  {
    key: 'view-posts',
    kind: 'view',
    spec: { view: 'cms_v_posts_public', columns: ['title'], order: [{ col: 'title', dir: 'asc' }], limit_max: 10 },
    isPublic: true,
    ttlS: 0,
  },
  ACTOR,
);
show('publish view source', `ok published_at=${String(pub.published_at)} plan=${JSON.stringify(pub.plan)} cost_rows=${String(pub.cost_rows)}`);
show('resolve before the re-point', resolve('view-posts'));

// The attack: same column names, different table.
{
  const d = db();
  try {
    d.exec('DROP VIEW cms_v_posts_public');
    d.exec('CREATE VIEW cms_v_posts_public AS SELECT path AS title FROM cms_page');
  } finally {
    d.close();
  }
}
show('sqlite_master.sql after re-point', JSON.stringify(storedSql('cms_v_posts_public')));
show('registry checksum (unchanged)', firstSum.slice(0, 16) + '…');
show('cms_page rows that must NOT be served', JSON.stringify(
  (() => {
    const d = db();
    try {
      return d.prepare('SELECT path AS title FROM cms_page').all();
    } finally {
      d.close();
    }
  })(),
));
show('resolve after the re-point', resolve('view-posts'));
show('cms_datasource untouched?', JSON.stringify(
  (() => {
    const d = db();
    try {
      return d.prepare("SELECT key, published_at IS NOT NULL AS published FROM cms_datasource WHERE key='view-posts'").get();
    } finally {
      d.close();
    }
  })(),
));

// =================================================================================================
console.log('\nM1 part 2 — a DDL op that changes a published view, through the runner\n');

{
  const d = db();
  try {
    d.exec("CREATE VIEW cms_v_posts_2 AS SELECT title FROM u_posts WHERE status = 'published'");
  } finally {
    d.close();
  }
}
const secondSum = registerView('cms_v_posts_2', storedSql('cms_v_posts_2'));
const pub2 = publishSource(
  FILE,
  {
    key: 'view-ddl',
    kind: 'view',
    spec: { view: 'cms_v_posts_2', columns: ['title'], order: [{ col: 'title', dir: 'asc' }], limit_max: 10 },
    isPublic: true,
    ttlS: 0,
  },
  ACTOR,
);
show('publish view source over cms_v_posts_2', `ok published_at=${String(pub2.published_at)}`);
show('resolve before the DDL', resolve('view-ddl'));
const auditBefore = (() => {
  const d = db();
  try {
    return Number((d.prepare('SELECT count(*) AS n FROM cms_audit').get() as { n: number }).n);
  } finally {
    d.close();
  }
})();

const report = runDdl(FILE, [{ op: 'rename_table', from: 'u_posts', to: 'u_posts_2' }], { actor: ACTOR });
show('runDdl rename_table', `ops=${report.ops} statements=${report.statements} audit=${JSON.stringify(report.audit)}`);
show('view body now names', JSON.stringify(storedSql('cms_v_posts_2')));
show('registry checksum moved?', (() => {
  const d = db();
  try {
    const row = d.prepare("SELECT checksum FROM cms_view_registry WHERE name = 'cms_v_posts_2'").get() as { checksum: string };
    return `${row.checksum === secondSum ? 'NO (same)' : 'YES'} ${secondSum.slice(0, 12)}… -> ${row.checksum.slice(0, 12)}…`;
  } finally {
    d.close();
  }
})());
show('cms_datasource published_at', JSON.stringify((() => {
  const d = db();
  try {
    return d.prepare("SELECT key, published_at, is_public FROM cms_datasource WHERE key = 'view-ddl'").get();
  } finally {
    d.close();
  }
})()));
show('audit rows added', String((() => {
  const d = db();
  try {
    const rows = d.prepare('SELECT action, target_kind, target_id, before_json, after_json FROM cms_audit ORDER BY id DESC LIMIT 4').all();
    return JSON.stringify(rows);
  } finally {
    d.close();
  }
})()));
show(`cms_audit count (was ${auditBefore})`, String((() => {
  const d = db();
  try {
    return Number((d.prepare('SELECT count(*) AS n FROM cms_audit').get() as { n: number }).n);
  } finally {
    d.close();
  }
})()));
show('resolve after the DDL', resolve('view-ddl'));
const repub = publishSource(
  FILE,
  {
    key: 'view-ddl',
    kind: 'view',
    spec: { view: 'cms_v_posts_2', columns: ['title'], order: [{ col: 'title', dir: 'asc' }], limit_max: 10 },
    isPublic: true,
    ttlS: 0,
  },
  ACTOR,
);
show('republish', `ok published_at=${String(repub.published_at)}`);
show('resolve after the republish', resolve('view-ddl'));

console.log('\nview checksum hashing counter:', JSON.stringify(viewChecksumStats));

fixture.cleanup();
