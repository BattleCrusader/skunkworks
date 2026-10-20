/**
 * S2e (6) / E-20 — the daily `audit_seal` job, the gap scan, and the operator verifier.
 *
 * The seal is one row per tenant per UTC **day segment** in `control.db`. What this file gates, in
 * the order the errata asks for it:
 *
 *   - `S2E-18` a first run seals the day that ended, with that day's own id range, and a second run
 *     is refused `already_sealed` with the row byte-identical — there is no idempotent re-seal path
 *     left to aim at (E-20 rule (a));
 *   - `S2E-19` a second seal after the chain grew does not overwrite the anchor;
 *   - `S2E-20` the timer targets the next UTC midnight (unchanged) and a manual run seals the last
 *     **ended** day, because a day that can still grow has no segment;
 *   - `S2E-21a`/`S2E-21b` the old `S2E-21` asserted only the failing direction, which is true of a
 *     legitimate new day as well as of tamper (E-22). It is two cases now: **passes after the chain
 *     grows** and **fails after a row inside the day is altered**, plus the distinct refusal names;
 *   - `B1-8` the tick reports a gap, writes one `audit_log` row, and does **not** seal it.
 */
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { appendAudit, readSeal } from '../app/audit/chain.ts';
import { msUntilNextUtcMidnight, sealDay, sealStatus, startSealScheduler } from '../app/audit/scheduler.ts';
import { makeFixture, REPO, type Fixture } from './helpers/fixture.ts';

const DAY = '2026-10-20';
const NEXT_DAY = '2026-10-21';
const SEAL_AT = Date.parse('2026-10-21T00:00:05Z');
const CLI = join(REPO, 'app', 'cli', 'skwctl.ts');
const ACTOR = { userId: 1, label: 'scheduler' };

interface SealRecord {
  tenant_key: string;
  day: string;
  first_id: number;
  last_id: number;
  rows_in_day: number;
  anchor: string;
  head: string;
  sealed_at: string;
  late: number;
}

let fixture: Fixture;

before(() => {
  fixture = makeFixture({
    specs: [
      { key: 'acme', hosts: ['acme.test'] },
      { key: 'beta', hosts: ['beta.test'] },
      { key: 'gamma', hosts: ['gamma.test'] },
      { key: 'delta', hosts: ['delta.test'] },
    ],
  });
  const add = (key: string, at: number, what: string): void => {
    const db = new Database(fixture.sitePath(key));
    try {
      appendAudit(db, ACTOR, what, 'cms_page', '/pricing', null, { status: 'published' }, at);
    } finally {
      db.close();
    }
  };
  for (const key of ['acme', 'beta', 'gamma']) add(key, Date.parse(`${DAY}T01:00:00Z`), 'page.publish');
  // `delta` has one row, on a day of its own: the gap scan's subject.
  add('delta', Date.parse('2026-10-27T01:00:00Z'), 'page.publish');
});

after(() => {
  fixture.cleanup();
});

function controlDb(): Database.Database {
  return new Database(fixture.controlDb);
}

function sealsFor(day: string): SealRecord[] {
  const control = controlDb();
  try {
    return control.prepare('SELECT * FROM audit_seal WHERE day = ? ORDER BY tenant_key').all(day) as SealRecord[];
  } finally {
    control.close();
  }
}

function skwctl(args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    cwd: REPO,
    env: { ...fixture.env },
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

test('S2E-18. one seal per tenant per day, covering that day\u2019s own ids, and a second run is refused', () => {
  const first = sealDay({ dataDir: fixture.dir, day: DAY, atMs: SEAL_AT });
  assert.deepEqual(first.tenants.map((t) => t.key), ['acme', 'beta', 'delta', 'gamma']);
  for (const tenant of first.tenants) {
    if (tenant.key === 'delta') {
      // Nothing was written on DAY for delta, so it has no segment to seal.
      assert.equal(tenant.status, 'empty', JSON.stringify(tenant));
      continue;
    }
    assert.equal(tenant.status, 'sealed', JSON.stringify(tenant));
    assert.equal(tenant.first_id, 1);
    assert.equal(tenant.last_id, 1);
    assert.equal(tenant.rows_in_day, 1);
    assert.equal(tenant.late, 0, 'a seal written at 00:00:05 on the 21st covers the 20th on time');
    assert.match(tenant.head, /^[0-9a-f]{64}$/);
  }

  const rows = sealsFor(DAY);
  assert.equal(rows.length, 3, `one seal per tenant with rows; got ${JSON.stringify(rows)}`);
  assert.deepEqual(rows.map((r) => r.tenant_key), ['acme', 'beta', 'gamma']);
  const sealedAt = rows[0]?.sealed_at;
  assert.equal(sealedAt, '2026-10-21T00:00:05.000Z');

  // A second run is refused as `already_sealed` and changes nothing — no idempotent re-seal path.
  const second = sealDay({ dataDir: fixture.dir, day: DAY, atMs: Date.parse('2026-10-21T00:10:00Z') });
  for (const tenant of second.tenants.filter((t) => t.status !== 'empty')) {
    assert.equal(tenant.status, 'already_sealed', `${tenant.key}: ${JSON.stringify(tenant)}`);
    assert.equal(tenant.created, false);
    assert.equal(tenant.sealed_at, sealedAt, 'a re-run rewrote sealed_at');
  }
  const again = sealsFor(DAY);
  assert.equal(again.length, 3, 'a second run wrote a second seal');
  assert.equal(again[0]?.sealed_at, sealedAt);
  assert.equal(again[0]?.head, rows[0]?.head);
});

test('S2E-19. a second seal after the chain grew does not overwrite the anchor', () => {
  const original = sealsFor(DAY);
  // The next day's traffic — the ordinary consequence of existing. It moves the chain's head, and
  // under the old cumulative model that alone was enough to make the 20th unverifiable.
  const db = new Database(fixture.sitePath('acme'));
  try {
    appendAudit(db, ACTOR, 'page.update', 'cms_page', '/pricing', null, { status: 'draft' }, Date.parse(`${NEXT_DAY}T02:00:00Z`));
  } finally {
    db.close();
  }

  const run = sealDay({ dataDir: fixture.dir, day: DAY, atMs: Date.parse('2026-10-21T03:00:00Z') });
  const acme = run.tenants.find((t) => t.key === 'acme');
  assert.ok(acme !== undefined);
  assert.equal(acme.status, 'already_sealed');
  assert.equal(acme.created, false);
  assert.match(String(acme.sealed_at), /2026-10-21T00:00:05/);

  const after = sealsFor(DAY);
  assert.equal(after.length, 3, 'the refused re-seal wrote a row');
  const acmeSeal = after.find((r) => r.tenant_key === 'acme');
  const acmeBefore = original.find((r) => r.tenant_key === 'acme');
  assert.deepEqual(acmeSeal, acmeBefore, 'the refused re-seal changed the anchor');
});

test('S2E-20. the scheduler targets the next UTC midnight, seals the last ended day, and stops cleanly', () => {
  assert.equal(msUntilNextUtcMidnight(Date.parse('2026-10-20T23:00:00Z')), 3_600_000);
  assert.equal(msUntilNextUtcMidnight(Date.parse('2026-10-20T00:00:00Z')), 86_400_000);
  assert.equal(msUntilNextUtcMidnight(Date.parse('2026-10-20T23:59:59.500Z')), 500);

  const scheduler = startSealScheduler({
    dataDir: fixture.dir,
    runImmediately: false,
    now: () => Date.parse('2026-10-20T12:00:00Z'),
  });
  assert.equal(scheduler.nextRunAt, Date.parse('2026-10-21T00:00:00Z'));
  // A manual run on the 22nd seals the 21st, never the 22nd.
  const manual = startSealScheduler({
    dataDir: fixture.dir,
    runImmediately: false,
    now: () => Date.parse('2026-10-22T09:00:00Z'),
  });
  const report = manual.runOnce();
  assert.equal(report.day, NEXT_DAY, 'a manual run must seal the last day that ended');
  manual.stop();
  scheduler.stop();
  assert.equal(scheduler.stopped, true);
  assert.equal(manual.stopped, true);
});

test('S2E-21a. `audit verify` PASSES for a sealed day after the chain grew on the next day', () => {
  // acme's chain grew on the 21st in S2E-19; its 20th is still the segment it sealed.
  const acme = skwctl(['audit', 'verify', '--tenant', 'acme', '--day', DAY]);
  assert.equal(acme.status, 0, `acme must verify after the chain grew:\n${acme.stdout}\n${acme.stderr}`);
  assert.match(acme.stdout, /verified: tenant=acme day=2026-10-20/);
  assert.match(acme.stdout, /rows_in_day=1/);
  assert.match(acme.stdout, /first_id=1/);
  assert.match(acme.stdout, /last_id=1/);
  assert.doesNotMatch(acme.stderr, /SKW_E_SEC_AUDIT_SEAL/);

  // beta never grew: the same command, the same answer.
  const beta = skwctl(['audit', 'verify', '--tenant', 'beta', '--day', DAY]);
  assert.equal(beta.status, 0, beta.stderr);
  assert.match(beta.stdout, /tenant=beta/);

  // A day with no seal and no rows is `empty`, exit 0 — nothing to verify, nothing wrong.
  const empty = skwctl(['audit', 'verify', '--tenant', 'beta', '--day', '2026-10-01']);
  assert.equal(empty.status, 0, empty.stderr);
  assert.match(empty.stdout, /empty:/);
});

test('S2E-21b. `audit verify` FAILS after a row inside the day is altered, with its own refusal name', () => {
  // gamma's single row is on DAY; change what it says without recomputing.
  const db = new Database(fixture.sitePath('gamma'));
  try {
    db.exec('DROP TRIGGER trg_cms_audit_append_only');
    db.prepare("UPDATE cms_audit SET actor_label = 'intruder@elsewhere.test' WHERE id = 1").run();
  } finally {
    db.close();
  }
  const gamma = skwctl(['audit', 'verify', '--tenant', 'gamma', '--day', DAY]);
  assert.equal(gamma.status, 1, `gamma must refuse:\n${gamma.stdout}\n${gamma.stderr}`);
  assert.match(gamma.stderr, /REFUSAL: AUDIT_SEAL_MISMATCH/);
  assert.match(gamma.stderr, /SKW_E_SEC_AUDIT_SEAL/);
  // `--chain` is the other question: the broken link is named there too.
  const walk = skwctl(['audit', 'verify', '--tenant', 'gamma', '--chain']);
  assert.equal(walk.status, 1);
  assert.match(walk.stderr, /REFUSAL: AUDIT_SEAL_CHAIN/);
  assert.match(walk.stderr, /broken at row 1/);
});

test('S2E-21c. an unsealed day with rows refuses with `AUDIT_SEAL_UNSEALED`, not as a mismatch', () => {
  // delta's only audit row is on 2026-10-27 and has never been sealed.
  const delta = skwctl(['audit', 'verify', '--tenant', 'delta', '--day', '2026-10-27']);
  assert.equal(delta.status, 1, `delta must refuse:\n${delta.stdout}\n${delta.stderr}`);
  assert.match(delta.stderr, /REFUSAL: AUDIT_SEAL_UNSEALED/);
  assert.match(delta.stderr, /UNSEALED/);
});

test('B1-8. the tick reports a gap, writes ONE audit_log row, and does not seal it', () => {
  // The 27th has delta's row and no seal; the tick for the 28th can see that and must say so.
  assert.equal(sealsFor('2026-10-27').length, 0, 'the gap must not be sealed before it is reported');

  const tickAt = Date.parse('2026-10-29T00:00:05Z');
  const report = sealDay({ dataDir: fixture.dir, day: '2026-10-28', atMs: tickAt, tenant: 'delta' });
  const delta = report.tenants[0];
  assert.ok(delta !== undefined);
  assert.deepEqual(
    delta.gaps.map((g) => ({ day: g.day, state: g.state })),
    [{ day: '2026-10-27', state: 'UNSEALED' }],
    `the gap scan covers every day before the one the tick owns: ${JSON.stringify(delta.gaps)}`,
  );
  assert.equal(delta.status, 'empty', 'the day the tick owns has no rows');

  const control = controlDb();
  try {
    const rows = control
      .prepare("SELECT target_id, actor_label, ts, after_json FROM audit_log WHERE action = 'audit.seal_gap'")
      .all() as { target_id: string; actor_label: string; ts: string; after_json: string }[];
    const forDelta = rows.filter((r) => r.target_id === 'delta/2026-10-27');
    assert.equal(forDelta.length, 1, `one audit_log row per gap, not ${forDelta.length}`);
    assert.equal(forDelta[0]?.actor_label, 'scheduler');
    assert.equal(forDelta[0]?.ts, '2026-10-29T00:00:05.000Z');
    assert.equal(JSON.parse(forDelta[0]?.after_json ?? '{}').rows_on_day, 1);
    // An empty day is reported, not recorded as a gap: there is nothing to anchor.
    assert.equal(rows.filter((r) => r.target_id === 'delta/2026-10-28').length, 0);
  } finally {
    control.close();
  }

  // The tick did NOT heal its own gap: `late = 1` must mean "an operator backfilled this".
  assert.equal(sealsFor('2026-10-27').length, 0, 'the tick healed the gap it reported');
  // A second tick reports it again — a gap stays visible until somebody seals it.
  sealDay({ dataDir: fixture.dir, day: '2026-10-28', atMs: tickAt + 86_400_000, tenant: 'delta' });
  const control2 = controlDb();
  try {
    const count = control2
      .prepare("SELECT count(*) AS n FROM audit_log WHERE action = 'audit.seal_gap' AND target_id = 'delta/2026-10-27'")
      .get() as { n: number };
    assert.equal(count.n, 2, 'a gap must be reported at every tick until it is sealed');
  } finally {
    control2.close();
  }
});

test('B1-12. the status read names a sealed day, an UNSEALED day and an empty one', () => {
  const status = sealStatus({ dataDir: fixture.dir, tenantKey: 'delta', days: 3, atMs: Date.parse('2026-10-29T12:00:00Z') });
  assert.equal(status.chain.ok, true);
  assert.deepEqual(
    status.days.map((d) => ({ day: d.day, state: d.state })),
    [
      { day: '2026-10-26', state: 'empty' },
      { day: '2026-10-27', state: 'UNSEALED' },
      { day: '2026-10-28', state: 'empty' },
    ],
  );
  assert.deepEqual(status.unsealed, ['2026-10-27']);
  assert.equal(status.last_sealed_day, null);
  assert.equal(status.late_days, 0);
  // And a sealed day shows its segment, not a file count.
  const acme = sealStatus({ dataDir: fixture.dir, tenantKey: 'acme', days: 1, atMs: Date.parse('2026-10-21T12:00:00Z') });
  const sealedDay = acme.days.find((d) => d.day === DAY);
  assert.equal(sealedDay?.state, 'sealed');
  assert.equal(sealedDay?.rows_in_day, 1);
  assert.equal(sealedDay?.first_id, 1);
  assert.equal(sealedDay?.late, 0);
  // S2E-20's manual run sealed the 21st for every tenant, so that is the newest anchored day.
  assert.equal(acme.last_sealed_day, NEXT_DAY);
  assert.equal(readSeal(controlDb(), 'acme', DAY)?.rows_in_day, 1);
});
