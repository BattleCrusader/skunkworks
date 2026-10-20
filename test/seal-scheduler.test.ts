/**
 * S2e (6) — the daily `audit_seal` job and the operator verifier.
 *
 * The seal is one row per tenant per UTC day in `control.db`; a second seal for the
 * same day with a different head is the attack the seal exists to catch, so it is
 * refused (SDS §9.6, C-21). `sealNow` and `verifyAgainstSeal` already existed and
 * were gated by S2d; nothing called them on a clock. This gate covers the clock and
 * the operator command.
 */
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { appendAudit } from '../app/audit/chain.ts';
import { msUntilNextUtcMidnight, sealDay, startSealScheduler } from '../app/audit/scheduler.ts';
import { makeFixture, REPO, type Fixture } from './helpers/fixture.ts';

const DAY = '2026-10-20';
const CLI = join(REPO, 'app', 'cli', 'skwctl.ts');
const ACTOR = { userId: 1, label: 'scheduler' };

let fixture: Fixture;

before(() => {
  fixture = makeFixture({
    specs: [
      { key: 'acme', hosts: ['acme.test'] },
      { key: 'beta', hosts: ['beta.test'] },
    ],
  });
  for (const key of ['acme', 'beta']) {
    const db = new Database(fixture.sitePath(key));
    try {
      appendAudit(db, ACTOR, 'page.publish', 'cms_page', '/pricing', null, { status: 'published' }, Date.parse('2026-10-20T01:00:00Z'));
    } finally {
      db.close();
    }
  }
});

after(() => {
  fixture.cleanup();
});

function seals(c: Database.Database): { tenant_key: string; day: string; rows: number; head: string; sealed_at: string }[] {
  return c.prepare('SELECT tenant_key, day, rows, head, sealed_at FROM audit_seal WHERE day = ? ORDER BY tenant_key').all(DAY) as {
    tenant_key: string;
    day: string;
    rows: number;
    head: string;
    sealed_at: string;
  }[];
}

test('S2E-18. one seal per tenant per day, and a second run with the same head is idempotent', () => {
  const first = sealDay({ dataDir: fixture.dir, day: DAY, atMs: Date.parse('2026-10-21T00:00:05Z') });
  assert.deepEqual(first.tenants.map((t) => t.key), ['acme', 'beta']);
  assert.ok(first.tenants.every((t) => t.error === undefined));
  assert.ok(first.tenants.every((t) => t.rows >= 1 && t.head.length === 64));

  const control = new Database(fixture.controlDb);
  let rows: ReturnType<typeof seals>;
  try {
    rows = seals(control);
  } finally {
    control.close();
  }
  assert.equal(rows.length, 2, `one seal per tenant; got ${JSON.stringify(rows)}`);
  assert.equal(rows[0]?.tenant_key, 'acme');
  assert.equal(rows[1]?.tenant_key, 'beta');
  assert.equal(rows[0]?.day, DAY);
  assert.match(rows[0]?.head ?? '', /^[0-9a-f]{64}$/);
  const sealedAt = rows[0]?.sealed_at;

  const second = sealDay({ dataDir: fixture.dir, day: DAY, atMs: Date.parse('2026-10-21T00:10:00Z') });
  assert.ok(second.tenants.every((t) => t.error === undefined), 'a same-head re-run must be idempotent');
  const control2 = new Database(fixture.controlDb);
  try {
    const again = seals(control2);
    assert.equal(again.length, 2, 'a second run must not write a second seal');
    assert.equal(again[0]?.sealed_at, sealedAt, 'an idempotent re-run rewrote the seal row');
    assert.equal(again[0]?.head, rows[0]?.head);
  } finally {
    control2.close();
  }
});

test('S2E-19. a second seal for the day with a different head is refused and does not overwrite the anchor', () => {
  const control = new Database(fixture.controlDb);
  let original: ReturnType<typeof seals>;
  try {
    original = seals(control);
  } finally {
    control.close();
  }

  // A legitimate new audit row moves the head. Re-sealing the same day would then
  // launder "tamper, recompute, re-seal", so it must be refused.
  const db = new Database(fixture.sitePath('acme'));
  try {
    appendAudit(db, ACTOR, 'page.update', 'cms_page', '/pricing', null, { status: 'draft' }, Date.parse('2026-10-20T02:00:00Z'));
  } finally {
    db.close();
  }

  const run = sealDay({ dataDir: fixture.dir, day: DAY });
  const acme = run.tenants.find((t) => t.key === 'acme');
  assert.ok(acme !== undefined);
  assert.equal(acme.error?.code, 'SKW_E_SEC_AUDIT_SEAL');
  assert.match(acme.error?.message ?? '', /different head/);

  const control2 = new Database(fixture.controlDb);
  try {
    const after = seals(control2);
    assert.equal(after.length, 2, 'the refused re-seal wrote a row');
    assert.equal(after[0]?.head, original[0]?.head, 'the refused re-seal changed the anchor');
    assert.equal(after[0]?.rows, original[0]?.rows);
  } finally {
    control2.close();
  }
});

test('S2E-20. the scheduler targets the next UTC midnight and stops cleanly', () => {
  assert.equal(msUntilNextUtcMidnight(Date.parse('2026-10-20T23:00:00Z')), 3_600_000);
  assert.equal(msUntilNextUtcMidnight(Date.parse('2026-10-20T00:00:00Z')), 86_400_000);
  assert.equal(msUntilNextUtcMidnight(Date.parse('2026-10-20T23:59:59.500Z')), 500);

  const scheduler = startSealScheduler({
    dataDir: fixture.dir,
    runImmediately: false,
    now: () => Date.parse('2026-10-20T12:00:00Z'),
  });
  assert.equal(scheduler.nextRunAt, Date.parse('2026-10-21T00:00:00Z'));
  scheduler.stop();
  assert.equal(scheduler.stopped, true);
});

// --- the operator command -------------------------------------------------

function skwctl(args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    cwd: REPO,
    env: { ...fixture.env },
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

test('S2E-21. `skwctl audit verify` passes on a sealed day and fails after the chain moves', () => {
  // S2E-19 moved acme's head after the seal, so acme must fail verification for DAY;
  // beta is still sealed and must pass. Two answers, one command.
  const acme = skwctl(['audit', 'verify', '--tenant', 'acme', '--day', DAY]);
  assert.equal(acme.status, 1, `acme verify should fail:\n${acme.stdout}\n${acme.stderr}`);
  assert.match(acme.stderr, /SKW_E_SEC_AUDIT_SEAL/);

  const beta = skwctl(['audit', 'verify', '--tenant', 'beta', '--day', DAY]);
  assert.equal(beta.status, 0, `beta verify should pass:\n${beta.stdout}\n${beta.stderr}`);
  assert.match(beta.stdout, /verified/);
  assert.match(beta.stdout, /tenant=beta/);
  assert.match(beta.stdout, /day=2026-10-20/);

  const missing = skwctl(['audit', 'verify', '--tenant', 'beta', '--day', '2026-10-19']);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /no seal/);
});
