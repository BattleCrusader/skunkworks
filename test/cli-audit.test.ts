/**
 * E-20 (5) — the operator surface: `skwctl audit status`, `seal --heal`, and the three refusal
 * names the CLI prints on stderr.
 *
 * QA's week-one failure (`S2-qa.md` §9) was an operator reading **one string for two events**:
 * `SKW_E_SEC_AUDIT_SEAL — the chain disagrees with the seal` was the answer for a real tamper and
 * for the next day's ordinary traffic. So the strings are separated here, and the exit codes are
 * asserted on both sides of each one:
 *
 *   - `REFUSAL: AUDIT_SEAL_UNSEALED` — no seal, rows exist, exit 1;
 *   - `REFUSAL: AUDIT_SEAL_MISMATCH` — anchor, link, count or head, exit 1;
 *   - `REFUSAL: AUDIT_SEAL_EMPTY`    — nothing to anchor, **exit 0** (printed as `empty:`);
 *   - `status` exits 0 only when `chain=ok` and no day is `UNSEALED`.
 *
 * The `--heal` half asserts the backfill is honest: one seal and one `audit_log` row
 * (`action = 'audit.seal_backfill'`) per day, `late = 1`, and a real `sealed_at` — never a snapshot
 * of today wearing yesterday's date (`S2-qa.md` §5.2).
 *
 * The days are relative to the real clock because the command reads it: `TODAY` is the day that
 * cannot be sealed, `YDAY` is the one an on-time seal covers, and `D2` is a day in the past.
 */
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { addUtcDays, appendAudit, auditHash, utcDay, verifyAgainstSeal } from '../app/audit/chain.ts';
import { makeFixture, REPO, type Fixture } from './helpers/fixture.ts';

const CLI = join(REPO, 'app', 'cli', 'skwctl.ts');
const ACTOR = { userId: 1, label: 'operator' };

const TODAY = utcDay();
const YDAY = addUtcDays(TODAY, -1);
const D2 = addUtcDays(TODAY, -2);
const D3 = addUtcDays(TODAY, -3);

let fixture: Fixture;

before(() => {
  fixture = makeFixture({
    specs: [
      { key: 'acme', hosts: ['acme.test'] },
      { key: 'beta', hosts: ['beta.test'] },
    ],
  });
  const add = (key: string, day: string): void => {
    const db = new Database(fixture.sitePath(key));
    try {
      appendAudit(db, ACTOR, 'page.publish', 'cms_page', '/pricing', null, { status: 'published' }, Date.parse(`${day}T01:00:00Z`));
    } finally {
      db.close();
    }
  };
  // acme: one row on D2 and one on YDAY, so a window of three days shows a gap and an empty day.
  add('acme', D2);
  add('acme', YDAY);
  add('beta', D2);
});

after(() => {
  fixture.cleanup();
});

function skwctl(args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    cwd: REPO,
    env: { ...fixture.env },
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function control<T>(fn: (db: Database.Database) => T): T {
  const db = new Database(fixture.controlDb);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

test('CLI-1. `audit status` names a sealed day, an UNSEALED day and an empty one, and exits 1 on the gap', () => {
  const first = skwctl(['audit', 'status', '--tenant', 'acme', '--days', '3']);
  assert.equal(first.status, 1, `an UNSEALED day must make status exit 1:\n${first.stdout}`);
  assert.match(first.stdout, /^tenant=acme chain=ok$/m);
  assert.match(first.stdout, new RegExp(`^${D3} empty +0 rows on that day; no seal is required$`, 'm'));
  assert.match(first.stdout, new RegExp(`^${D2} UNSEALED +1 rows on that day; no seal$`, 'm'));
  assert.match(first.stdout, new RegExp(`^${YDAY} UNSEALED +1 rows on that day; no seal$`, 'm'));

  // Seal yesterday ON TIME (a seal written today covers yesterday), and leave D2 open.
  const sealed = skwctl(['audit', 'seal', '--tenant', 'acme', '--day', YDAY]);
  assert.equal(sealed.status, 0, sealed.stderr);
  assert.match(
    sealed.stdout,
    new RegExp(`^seal: tenant=acme day=${YDAY} sealed rows_in_day=1 first_id=2 last_id=2 late=no sealed_at=`, 'm'),
  );

  const mid = skwctl(['audit', 'status', '--tenant', 'acme', '--days', '3']);
  assert.equal(mid.status, 1, 'the D2 gap must still make status exit 1');
  assert.match(mid.stdout, new RegExp(`^${YDAY} sealed +rows_in_day=1 +first_id=2 last_id=2 late=no$`, 'm'));
  assert.match(mid.stdout, new RegExp(`^${D2} UNSEALED +1 rows on that day; no seal$`, 'm'));

  // Heal the gap: the same command now exits 0 and the backfilled day says `late=yes`.
  const healed = skwctl(['audit', 'seal', '--heal', '--tenant', 'acme']);
  assert.equal(healed.status, 0, healed.stderr);
  assert.match(healed.stdout, new RegExp(`heal: tenant=acme day=${D2} rows_in_day=1 late=yes`));

  const last = skwctl(['audit', 'status', '--tenant', 'acme', '--days', '3']);
  assert.equal(last.status, 0, `with every day anchored status must exit 0:\n${last.stdout}`);
  assert.doesNotMatch(last.stdout, /UNSEALED/);
  assert.match(last.stdout, new RegExp(`^${D2} sealed +rows_in_day=1 +first_id=1 last_id=1 late=yes {2}sealed_at=`, 'm'));
});

test('CLI-2. `--heal` writes one seal and one audit_log row per day, with a real sealed_at', () => {
  const backfills = control(
    (db) =>
      db
        .prepare("SELECT target_id, actor_label, after_json FROM audit_log WHERE action = 'audit.seal_backfill' ORDER BY target_id")
        .all() as { target_id: string; actor_label: string; after_json: string }[],
  );
  assert.equal(backfills.length, 1, `exactly one backfill row: ${JSON.stringify(backfills)}`);
  assert.equal(backfills[0]?.target_id, `acme/${D2}`);
  assert.equal(backfills[0]?.actor_label, 'operator');
  const after = JSON.parse(backfills[0]?.after_json ?? '{}') as { late: number; first_id: number; last_id: number; rows_in_day: number };
  assert.equal(after.late, 1);
  assert.equal(after.first_id, 1);
  assert.equal(after.last_id, 1);
  assert.equal(after.rows_in_day, 1);

  const seal = control(
    (db) => db.prepare("SELECT * FROM audit_seal WHERE tenant_key = 'acme' AND day = ?").get(D2) as Record<string, unknown>,
  );
  assert.equal(seal.late, 1);
  assert.equal(seal.first_id, 1);
  assert.equal(seal.last_id, 1);
  assert.equal(seal.rows_in_day, 1);
  // `sealed_at` is the real instant of the backfill — today, not the day it covers.
  assert.equal(String(seal.sealed_at).slice(0, 10), TODAY);
  assert.match(String(seal.sealed_at), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

  // A second `--heal` has nothing to do and writes no second row.
  const again = skwctl(['audit', 'seal', '--heal', '--tenant', 'acme']);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /nothing to seal/);
  const count = control(
    (db) => db.prepare("SELECT count(*) AS n FROM audit_log WHERE action = 'audit.seal_backfill'").get() as { n: number },
  );
  assert.equal(count.n, 1, 'a second --heal wrote a second backfill row');
});

test('CLI-3. the three refusal names are distinct on stderr and carry the exit code each one means', () => {
  // (a) a day with rows and no seal -> AUDIT_SEAL_UNSEALED, exit 1.
  const unsealed = skwctl(['audit', 'verify', '--tenant', 'beta', '--day', D2]);
  assert.equal(unsealed.status, 1);
  assert.match(unsealed.stderr, /^REFUSAL: AUDIT_SEAL_UNSEALED: /m);

  // (b) nothing to anchor -> a success: `empty:`, exit 0, and nothing on stderr.
  const empty = skwctl(['audit', 'verify', '--tenant', 'beta', '--day', '2020-01-01']);
  assert.equal(empty.status, 0, empty.stderr);
  assert.match(empty.stdout, /^empty: tenant=beta day=2020-01-01 0 rows on that day; no seal is required$/m);
  assert.equal(empty.stderr.trim(), '');

  // (c) a tampered-and-recomputed row -> AUDIT_SEAL_MISMATCH, exit 1, with the code still on the line.
  // The tamper is the interesting one: the chain still walks, so only the seal can catch it.
  const clean = skwctl(['audit', 'seal', '--tenant', 'beta', '--day', D2]);
  assert.equal(clean.status, 0, clean.stderr);
  const db = new Database(fixture.sitePath('beta'));
  try {
    db.exec('DROP TRIGGER trg_cms_audit_append_only');
    db.prepare("UPDATE cms_audit SET action = 'page.restore' WHERE id = 1").run();
    const row = db.prepare('SELECT * FROM cms_audit WHERE id = 1').get() as Record<string, unknown>;
    db.prepare('UPDATE cms_audit SET prev_hash = ?, hash = ? WHERE id = 1').run('', auditHash('', row as never));
  } finally {
    db.close();
  }
  const tampered = skwctl(['audit', 'verify', '--tenant', 'beta', '--day', D2]);
  assert.equal(tampered.status, 1);
  assert.match(tampered.stderr, /^REFUSAL: AUDIT_SEAL_MISMATCH: SKW_E_SEC_AUDIT_SEAL: /m);
  // The chain command answers the other question and finds nothing wrong with the links.
  const walk = skwctl(['audit', 'verify', '--tenant', 'beta', '--chain']);
  assert.equal(walk.status, 0, `the recomputed chain must walk:\n${walk.stdout}\n${walk.stderr}`);
  // The three strings are not one string in three places.
  assert.notEqual(unsealed.stderr.split('\n')[0], tampered.stderr.split('\n')[0]);
});

test('CLI-4. `audit seal` on an already-sealed day is a non-failure that prints the stored facts', () => {
  const again = skwctl(['audit', 'seal', '--tenant', 'acme', '--day', YDAY]);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /already_sealed \(no write\)/);
  assert.match(again.stdout, /late=no/);
  const count = control(
    (db) => db.prepare("SELECT count(*) AS n FROM audit_seal WHERE tenant_key = 'acme'").get() as { n: number },
  );
  assert.equal(count.n, 2, 'the re-run wrote a row');
});

test('CLI-5. `seal` with no `--day` seals the last day that ENDED, never today', () => {
  const run = skwctl(['audit', 'seal', '--tenant', 'acme']);
  assert.equal(run.status, 0, run.stderr);
  assert.doesNotMatch(run.stdout, new RegExp(`day=${TODAY}\\b`), 'the default day was today, which can still grow');
  assert.match(run.stdout, new RegExp(`day=${YDAY}\\b`));
});

test('CLI-6. the verify verdict is a segment report, not a file count', () => {
  const ok = skwctl(['audit', 'verify', '--tenant', 'acme', '--day', YDAY]);
  assert.equal(ok.status, 0, `acme's ${YDAY} must verify after later rows:\n${ok.stdout}\n${ok.stderr}`);
  assert.match(ok.stdout, /rows_in_day=1/);
  assert.match(ok.stdout, /first_id=2/);
  assert.match(ok.stdout, /last_id=2/);
  assert.doesNotMatch(ok.stdout, /rows=2\b/, 'the verdict leaked the file count');
  // And the library agrees with the command.
  const site = new Database(fixture.sitePath('acme'), { readonly: true });
  const ctl = new Database(fixture.controlDb, { readonly: true });
  try {
    const verdict = verifyAgainstSeal(site, ctl, 'acme', YDAY);
    assert.equal(verdict.status, 'verified');
    if (verdict.status !== 'verified') return;
    assert.equal(verdict.rows_in_day, 1);
    assert.equal(verdict.last_id, 2);
  } finally {
    site.close();
    ctl.close();
  }
});
