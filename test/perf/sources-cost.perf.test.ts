/**
 * `make test-perf` — every gate in the suite that asserts a **rate**: `cost_ms_max`, the publish
 * gate's measured worst case (§6.1/§6.2).
 *
 * Why these are not in `make test` (`S2-qa.md` D12): a max-of-200 wall-clock statistic is a
 * measurement of the box. Measured on this laptop with the S2 fixture: idle worst case
 * **0.059 ms** over ten publishes (25× under the 1.5 ms ceiling); under six `yes(1)` processes
 * one publish in ten recorded **1.401 ms** — 93 % of the ceiling, in a run where the code did
 * not change. `test/sources.test.ts S2E-2` asserted that number inside `make test`, so CPU
 * contention could turn a green suite red; and the publish gate itself refuses when two
 * consecutive batches exceed 1.5 ms, so the same contention could make an ordinary fixture
 * publish throw `SKW_E_RT_SOURCE_BUDGET`.
 *
 * What `make test` keeps (and this file therefore does not hide):
 *
 *   - the plan and index rules — `S2E-1`, `S2E-11`, the exclusive witnesses — are structural;
 *   - the budget is still *enforced* in `make test`, by refusal rather than by measurement:
 *     `S2E-3` (`budgetMsMax: 0` on a `query`) and `V1-4` (`budgetMsMax: 0` on a `view`) both
 *     prove the ceiling is consulted and that it throws its own code. Load can only push a
 *     measurement **up**, so those refusals are monotone and cannot flake;
 *   - `cost_ms_max` is still asserted to exist, be finite and be stored — the number is measured
 *     by the product in every publish, it is only the *budget comparison* that moved here.
 *
 * What is only here: **"a source that passes the plan rules on this box measures under the
 * budget"** — the positive direction of the 1.5 ms ceiling, and the refusal of a source that is
 * genuinely over it (an expensive view body), where the decision is the real ceiling rather than
 * a zero one. Run on an idle box; `make test-perf` refuses to pretend otherwise.
 *
 * Idle baseline, this laptop, 2026-10-20 (`make test-perf`, 1-min load average 4.26–5.08 on 8 cpus;
 * the preflight prints a WARNING at that level, so these are the numbers of a warning run, not a
 * quiet one):
 *   ordinary query source   cost_ms_max 0.0122–0.6738 ms over 15 publishes, median 0.016–0.032 ms
 *                           (the 0.67 ms sample is a deschedule: the same code, the same fixture)
 *   expensive view body     cost_ms_max **26.13–37.73 ms** across runs (the CTE is 200k rows; the
 *                           spread is the box), refused in both 200-run batches
 */
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { after, before, test } from 'node:test';

import { totpCode } from '../../app/admin/auth.ts';
import { runDdl } from '../../app/ddl/run.ts';
import { loadEnv } from '../../app/env.ts';
import { hashRelationSql } from '../../app/sources/registry.ts';
import { buildApp, type AppHandle } from '../../app/main.ts';
import { publishSource, type SourceInput } from '../../app/sources/publish.ts';
import { COST_MS_MAX } from '../../app/sources/spec.ts';
import { ADMIN_HOST, ADMIN_ORIGIN, TOTP_SECRET, login, seedUser, type Sessioned } from '../helpers/admin.ts';
import { makeFixture, type Fixture } from '../helpers/fixture.ts';
import { call, type Res } from '../helpers/http.ts';

const ACTOR = { userId: 7, label: 'perf' };
const OWNER = 'owner@acme.test';

/** The idle worst case this file's drift alarm is derived from, in ms (§6.1's budget is 1.5). */
const IDLE_COST_MS_MAX = 0.059;
/** 10× the idle worst case, applied to the **median** of a run: the max is a max-of-200 tail and
 * a single deschedule moves it (measured: 0.8279 ms on this box at load 5.19, code unchanged). */
const DRIFT_FACTOR = 10;

/** The median of a sample set — the robust statistic for "did the query itself get slower". */
function medianOf(samples: readonly number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

const SPEC = {
  table: 'u_posts',
  columns: ['title', 'slug'],
  where: [{ col: 'status', op: '=' as const, param: 'status' }],
  order: [{ col: 'published_at', dir: 'desc' as const }],
  limit_default: 3,
  limit_max: 50,
};

const POSTS: SourceInput = {
  key: 'posts',
  kind: 'query',
  spec: SPEC,
  params: [{ name: 'status', kind: 'enum', values: ['published', 'draft'] }],
  isPublic: true,
  ttlS: 60,
};

let fixture: Fixture;
let file: string;
let handle: AppHandle;
let port = 0;
let session: Sessioned;

function site(): Database.Database {
  return new Database(file);
}

function migrateView(db: Database.Database, name: string, body: string): string {
  db.exec(`DROP VIEW IF EXISTS ${name}`);
  db.exec(`CREATE VIEW ${name} AS ${body}`);
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'view' AND name = ?").get(name) as { sql: string };
  const checksum = hashRelationSql(row.sql);
  db.prepare('INSERT OR REPLACE INTO cms_view_registry (name, checksum) VALUES (?, ?)').run(name, checksum);
  return checksum;
}

function post(path: string, body: unknown): Promise<Res> {
  return call({
    port,
    path,
    method: 'POST',
    host: ADMIN_HOST,
    headers: { cookie: session.cookie, origin: ADMIN_ORIGIN, 'content-type': 'application/json', 'x-csrf-token': session.csrfToken },
    body: JSON.stringify(body),
  });
}

before(async () => {
  fixture = makeFixture({ specs: [{ key: 'acme', hosts: ['acme.test'] }] });
  file = fixture.sitePath('acme');
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
  const db = site();
  try {
    const insert = db.prepare('INSERT INTO u_posts (title, slug, status, published_at) VALUES (?, ?, ?, ?)');
    for (let i = 1; i <= 5; i += 1) insert.run(`Published ${i}`, `published-${i}`, 'published', `2026-10-0${i}T00:00:00.000Z`);
    insert.run('Draft one', 'draft-1', 'draft', '2026-09-01T00:00:00.000Z');
  } finally {
    db.close();
  }

  await seedUser({ controlDb: fixture.controlDb, tenantKey: 'acme', email: OWNER, totpSecret: TOTP_SECRET });
  handle = await buildApp({ env: loadEnv(fixture.env) });
  await handle.app.listen({ port: 0, host: '127.0.0.1' });
  const address = handle.app.server.address();
  port = typeof address === 'object' && address !== null ? address.port : 0;
  const res = await login({ port, key: 'acme', email: OWNER, totp: totpCode(TOTP_SECRET, Date.now()) });
  assert.equal(res.status, 200, res.body);
  const raw = String(res.headers['set-cookie']);
  session = {
    cookie: raw.slice(0, raw.indexOf(';')),
    csrfToken: (res.json as { csrfToken: string }).csrfToken,
    email: OWNER,
  };
});

after(async () => {
  await handle.close();
  fixture.cleanup();
});

test('P-1. an ordinary query source publishes under the real 1.5 ms ceiling, five times', () => {
  const samples: number[] = [];
  for (let i = 0; i < 5; i += 1) {
    const report = publishSource(file, { ...POSTS, key: `perf-posts-${i}` }, ACTOR);
    assert.equal(typeof report.cost_ms_max, 'number');
    const cost = Number(report.cost_ms_max);
    samples.push(cost);
    // The contract: the worst of 200 measured runs is under the ceiling §6.1 fixes.
    assert.ok(
      cost <= COST_MS_MAX,
      `cost_ms_max ${cost.toFixed(4)} ms exceeds the ${COST_MS_MAX} ms budget (idle baseline ${IDLE_COST_MS_MAX} ms)`,
    );
  }
  const median = medianOf(samples);
  // The drift alarm, on the median: a single deschedule moves one sample's max (measured 0.8279 ms
  // at load 5.19 with this fixture), but an order-of-magnitude move of the *typical* publish is the
  // query getting slower, which is the thing worth a red gate.
  assert.ok(
    median <= IDLE_COST_MS_MAX * DRIFT_FACTOR,
    `median cost_ms_max ${median.toFixed(4)} ms is more than ${DRIFT_FACTOR}× the idle baseline ` +
      `${IDLE_COST_MS_MAX} ms: either the fixture query got slower or this box is not idle. ` +
      `samples ${samples.map((s) => s.toFixed(4)).join(' ')}`,
  );
  process.stdout.write(`P-1 cost_ms_max ${samples.map((s) => s.toFixed(4)).join(' ')} ms (budget ${COST_MS_MAX})\n`);
});

test('P-2. the ceiling still refuses an expensive view body, measured against the real budget', () => {
  const admin = site();
  try {
    migrateView(
      admin,
      'cms_v_expensive',
      'WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 200000) SELECT sum(i) AS total FROM n',
    );
  } finally {
    admin.close();
  }
  let refusal: { code?: string; detail?: { reason?: string; cost_ms_max?: number; limit_ms?: number } } | null = null;
  try {
    publishSource(
      file,
      {
        key: 'expensive-view',
        kind: 'view',
        spec: { view: 'cms_v_expensive', columns: ['total'], limit_default: 1, limit_max: 1 },
        isPublic: true,
      },
      ACTOR,
    );
  } catch (err) {
    refusal = err as { code?: string; detail?: { reason?: string; cost_ms_max?: number; limit_ms?: number } };
  }
  assert.notEqual(refusal, null, 'a view body that costs milliseconds per run must be refused by the 1.5 ms ceiling');
  assert.equal(refusal?.code, 'SKW_E_RT_SOURCE_BUDGET');
  assert.equal(refusal?.detail?.reason, 'cost');
  assert.equal(refusal?.detail?.limit_ms, COST_MS_MAX);
  assert.ok((refusal?.detail?.cost_ms_max ?? 0) > COST_MS_MAX, 'the refusal must quote a measurement over the ceiling');
  process.stdout.write(`P-2 expensive view cost_ms_max ${String(refusal?.detail?.cost_ms_max)} ms (ceiling ${COST_MS_MAX})\n`);
});

test('P-3. the admin publish route returns the measured report under the real ceiling', async () => {
  const res = await post('/admin/t/acme/sources/publish', {
    key: 'posts-admin',
    kind: 'query',
    spec: SPEC,
    params: [{ name: 'status', kind: 'enum', values: ['published', 'draft'] }],
    is_public: true,
    ttl_s: 60,
  });
  assert.equal(res.status, 200, `publish failed: ${res.body}`);
  const published = (res.json as { published: { cost_ms_max: number; cost_rows: number; plan: string[]; published_at: string } })
    .published;
  assert.ok(published.cost_ms_max <= COST_MS_MAX, `cost_ms_max ${published.cost_ms_max} exceeds the ${COST_MS_MAX} ms budget`);
  assert.match(published.plan.join('\n'), /SEARCH/);
  assert.equal(published.cost_rows, 6);
  assert.match(published.published_at, /^\d{4}-\d{2}-\d{2}T/);
  process.stdout.write(`P-3 admin publish cost_ms_max ${published.cost_ms_max.toFixed(4)} ms\n`);
});
