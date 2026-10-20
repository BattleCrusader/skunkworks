/**
 * §9.6 / C-21 as amended by 02-errata E-20 — the audit chain, its verifier, and the daily seal,
 * which covers **a day's own id segment** and not the whole file.
 *
 * Why the file is shaped this way. The whole-file snapshot this replaces could only verify in the
 * interval between its own write and the next audit row, so every day with a successor refused with
 * the same string a real tamper produces (`S2-qa.md` §5.3). The acceptance criterion that decides
 * whether that defect is closed is therefore a **positive control**: `B1-1` seals a day, appends
 * rows on the next day, and asserts the earlier day still verifies. It cannot pass against the old
 * model — that is the point — and no test in the old suite could express it.
 *
 * Every case runs against real `site.db` / `control.db` files built from `schema/site.sql` and
 * `schema/control.sql`. `A1` also writes one row through the production writer (`crud.createRow`),
 * so the writer and the verifier cannot drift without this file going red.
 *
 * Exclusive witnesses (§13.1a): `B1-1` and `B1-3` for `verifyAgainstSeal`; `B1-6` for `writeSeal`.
 */
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { createRow, type Actor } from '../app/admin/crud.ts';
import {
  addUtcDays,
  appendAudit,
  auditHash,
  canonicalRow,
  chainHead,
  daySegment,
  readSeal,
  sealNow,
  utcDay,
  verifyAgainstSeal,
  verifyChain,
  writeSeal,
} from '../app/audit/chain.ts';
import { AppError } from '../app/errors.ts';
import { makeFixture, SCHEMA, type Fixture } from './helpers/fixture.ts';

const ACTOR: Actor = { userId: 7, label: 'owner@acme.test' };
const DAY = '2026-10-20';
const NEXT_DAY = '2026-10-21';
/** An on-time seal of DAY is written on the day after it — 00:00:05 on the 21st. */
const SEAL_AT = Date.parse('2026-10-21T00:00:05.000Z');
const NEXT_SEAL_AT = Date.parse('2026-10-22T00:00:05.000Z');

let fixture: Fixture;
let sitePath: string;
let controlPath: string;

before(() => {
  fixture = makeFixture({ specs: [{ key: 'acme', hosts: ['acme.test'] }] });
  sitePath = fixture.sitePath('acme');
  controlPath = fixture.controlDb;
});

after(() => {
  fixture.cleanup();
});

/** A fresh pair of files per test: a seal is per tenant per day and mutating one must not leak. */
function freshPair(name: string): { site: Database.Database; control: Database.Database } {
  const site = new Database(sitePath.replace('site.db', `${name}.db`));
  site.pragma('journal_mode = WAL');
  site.exec(readFileSync(join(SCHEMA, 'site.sql'), 'utf8'));
  const control = new Database(controlPath.replace('control.db', `${name}-control.db`));
  control.pragma('journal_mode = WAL');
  control.exec(readFileSync(join(SCHEMA, 'control.sql'), 'utf8'));
  control
    .prepare("INSERT INTO tenant (key, mode, status, display_name, db_version) VALUES ('acme','production','active','Acme',3)")
    .run();
  return { site, control };
}

/** Three audit rows on `day`, written by the chain module the runner and the CRUD writer share. */
function seedChain(site: Database.Database, day = DAY): void {
  const tx = site.transaction(() => {
    appendAudit(site, { userId: 7, label: ACTOR.label }, 'page.create', 'cms_page', '1', null, { id: 1 }, Date.parse(`${day}T01:00:00Z`));
    appendAudit(site, { userId: 7, label: ACTOR.label }, 'u_post.create', 'u_post', '1', null, { id: 1 }, Date.parse(`${day}T02:00:00Z`));
    appendAudit(site, { userId: 7, label: ACTOR.label }, 'u_post.update', 'u_post', '1', { id: 1 }, { id: 1, title: 'x' }, Date.parse(`${day}T03:00:00Z`));
  });
  tx();
}

/** Appends one row on `day` and returns its id. */
function addRow(site: Database.Database, day: string, what = 'page.update'): number {
  appendAudit(site, { userId: 7, label: ACTOR.label }, what, 'cms_page', '/one', null, { at: what }, Date.parse(`${day}T04:00:00Z`));
  return Number((site.prepare('SELECT max(id) AS id FROM cms_audit').get() as { id: number }).id);
}

/** Recompute every hash from the stored rows, as an attacker with write access can. */
function recomputeChain(site: Database.Database): void {
  const rows = site.prepare('SELECT * FROM cms_audit ORDER BY id').all() as Record<string, unknown>[];
  let prev = '';
  const stamp = site.prepare('UPDATE cms_audit SET prev_hash = ?, hash = ? WHERE id = ?');
  for (const row of rows) {
    const hash = auditHash(prev, row as never);
    stamp.run(prev, hash, row.id as number);
    prev = hash;
  }
}

function code(error: unknown): string | undefined {
  return (error as { code?: string }).code;
}

/** The `reason` on the error's detail — how one code tells six controls apart. */
function reasonOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return String((err as { detail?: { reason?: string } }).detail?.reason ?? code(err));
  }
  throw new Error('expected a refusal, got none');
}

// --- the chain itself ------------------------------------------------------

test('A1. the writer and the verifier agree: rows chain, every hash recomputes, and nothing seals', () => {
  const { site, control } = freshPair('a1');
  try {
    seedChain(site);
    // One row from the production writer, so the writer and the verifier are the same definition.
    createRow(site, 'cms_page', { path: '/one', slug: 'one', title: 'One', body_html: '<p>one</p>' }, ACTOR);
    const report = verifyChain(site);
    assert.equal(report.ok, true);
    assert.equal(report.rows, 4);
    assert.equal(report.head, chainHead(site));
    const rows = site.prepare('SELECT prev_hash, hash FROM cms_audit ORDER BY id').all() as { prev_hash: string; hash: string }[];
    assert.equal(rows[0]!.prev_hash, '');
    for (let i = 1; i < rows.length; i += 1) assert.equal(rows[i]!.prev_hash, rows[i - 1]!.hash);
    const raw = site.prepare('SELECT * FROM cms_audit ORDER BY id').all() as Record<string, unknown>[];
    let prev = '';
    for (const row of raw) {
      const expected = auditHash(prev, row as never);
      assert.equal(row.hash, expected, `row ${String(row.id)} does not recompute`);
      prev = expected;
    }
    const sealed = control.prepare('SELECT count(*) AS n FROM audit_seal').get() as { n: number };
    assert.equal(sealed.n, 0, 'nothing writes a seal until the daily job does');
  } finally {
    site.close();
    control.close();
  }
});

test('A2. the canonical row is the eight fields §9.6 hashes, with sorted keys', () => {
  const row = {
    actor_user_id: 7,
    actor_label: 'owner@acme.test',
    action: 'u_post.create',
    target_kind: 'u_post',
    target_id: '1',
    before_json: null,
    after_json: '{"id":1}',
    ts: '2026-10-20T00:00:00.000Z',
  };
  assert.equal(
    canonicalRow(row),
    '{"action":"u_post.create","actor_label":"owner@acme.test","actor_user_id":7,"after_json":"{\\"id\\":1}","before_json":null,"target_id":"1","target_kind":"u_post","ts":"2026-10-20T00:00:00.000Z"}',
  );
  // Key order in the object must not change the hash; a second definition would.
  const shuffled = { ts: row.ts, action: row.action, after_json: row.after_json, actor_label: row.actor_label, actor_user_id: 7, before_json: null, target_id: '1', target_kind: 'u_post' };
  assert.equal(auditHash('', row), auditHash('', shuffled as never));
});

// --- the segment shape -----------------------------------------------------

test('A3. a seal covers the day\u2019s own id range: first_id, last_id, rows_in_day, anchor, head', () => {
  const { site, control } = freshPair('a3');
  try {
    seedChain(site);
    const outcome = sealNow(site, control, 'acme', DAY, SEAL_AT);
    assert.equal(outcome.status, 'sealed');
    if (outcome.status !== 'sealed') return;
    const seal = outcome.seal;
    assert.equal(seal.first_id, 1);
    assert.equal(seal.last_id, 3);
    assert.equal(seal.rows_in_day, 3);
    assert.equal(seal.anchor, '', 'a segment that starts the chain has no predecessor');
    assert.equal(seal.head, chainHead(site));
    assert.equal(seal.late, 0, 'sealed at 00:00:05 on the 21st for the 20th is on time');
    assert.equal(seal.sealed_at, '2026-10-21T00:00:05.000Z');
    assert.deepEqual(daySegment(site, DAY), { first_id: 1, last_id: 3, rows_in_day: 3 });
    const verdict = verifyAgainstSeal(site, control, 'acme', DAY);
    assert.equal(verdict.status, 'verified');
    if (verdict.status !== 'verified') return;
    assert.equal(verdict.rows_in_day, 3);
    assert.equal(verdict.head, seal.head);
  } finally {
    site.close();
    control.close();
  }
});

test('A4. tamper one row and recompute the chain: the walk passes and the seal refuses', () => {
  const { site, control } = freshPair('a4');
  try {
    seedChain(site);
    sealNow(site, control, 'acme', DAY, SEAL_AT);
    // The attacker model: write access to site.db. Drop the append-only trigger, change what a
    // row says, recompute every hash so the file is internally consistent again.
    site.exec('DROP TRIGGER trg_cms_audit_append_only');
    site.prepare("UPDATE cms_audit SET action = 'u_post.restore' WHERE id = 2").run();
    recomputeChain(site);
    const walk = verifyChain(site);
    assert.equal(walk.ok, true, 'the recomputed chain must pass the link walk — the premise of the seal');
    assert.notEqual(walk.head, readSeal(control, 'acme', DAY)?.head, 'the recomputed head must differ from the seal');
    assert.equal(reasonOf(() => verifyAgainstSeal(site, control, 'acme', DAY)), 'head_mismatch');
  } finally {
    site.close();
    control.close();
  }
});

test('A5. a row deleted INSIDE the segment breaks the walk, and the day is refused', () => {
  const { site, control } = freshPair('a5');
  try {
    seedChain(site);
    sealNow(site, control, 'acme', DAY, SEAL_AT);
    site.exec('DROP TRIGGER trg_cms_audit_no_delete');
    // The middle row: its successor still carries its hash, so the link walk is what notices.
    site.prepare('DELETE FROM cms_audit WHERE id = 2').run();
    assert.equal(reasonOf(() => verifyAgainstSeal(site, control, 'acme', DAY)), 'broken_at');
  } finally {
    site.close();
    control.close();
  }
});

test('A6. a day with rows and no seal is `unsealed`; a day with no rows is `empty`', () => {
  const { site, control } = freshPair('a6');
  try {
    seedChain(site);
    assert.equal(reasonOf(() => verifyAgainstSeal(site, control, 'acme', DAY)), 'unsealed');
    const empty = verifyAgainstSeal(site, control, 'acme', '2026-10-19');
    assert.equal(empty.status, 'empty');
    assert.equal(empty.rows_in_day, 0);
  } finally {
    site.close();
    control.close();
  }
});

test('A7. a day is sealed once: a second seal is `already_sealed` and the stored row is untouched', () => {
  const { site, control } = freshPair('a7');
  try {
    seedChain(site);
    const outcome = sealNow(site, control, 'acme', DAY, SEAL_AT);
    assert.equal(outcome.status, 'sealed');
    const stored = readSeal(control, 'acme', DAY);
    assert.ok(stored !== undefined);
    // A re-run of the same day is not a failure for the caller…
    assert.equal(sealNow(site, control, 'acme', DAY, Date.parse('2026-10-21T06:00:00Z')).status, 'already_sealed');
    // …but it writes nothing, even when the head has moved: the write itself is refused.
    addRow(site, DAY);
    assert.equal(sealNow(site, control, 'acme', DAY, Date.parse('2026-10-21T07:00:00Z')).status, 'already_sealed');
    assert.throws(
      () =>
        writeSeal(
          control,
          'acme',
          DAY,
          { first_id: 1, last_id: 4, rows_in_day: 4, anchor: '', head: chainHead(site), late: 0 },
          Date.parse('2026-10-21T07:00:00Z'),
        ),
      (err: unknown) =>
        code(err) === 'SKW_E_SEC_AUDIT_SEAL' && (err as { detail?: { reason?: string } }).detail?.reason === 'already_sealed',
    );
    assert.deepEqual(readSeal(control, 'acme', DAY), stored, 'the refused re-seal changed the anchor');
  } finally {
    site.close();
    control.close();
  }
});

test('A8. the seal day is UTC and comes from one function, not the caller\u2019s locale', () => {
  assert.equal(utcDay(Date.parse('2026-10-20T23:59:59.999Z')), '2026-10-20');
  assert.equal(utcDay(Date.parse('2026-10-21T00:00:00.000Z')), '2026-10-21');
  assert.equal(addUtcDays('2026-02-28', 1), '2026-03-01');
  assert.equal(addUtcDays('2026-01-01', -1), '2025-12-31');
});

// --- E-20's cases ----------------------------------------------------------

test('B1-1. an untouched chain that GREW on the next day still verifies for the earlier day (the positive control)', () => {
  const { site, control } = freshPair('b1-1');
  try {
    seedChain(site);
    assert.equal(sealNow(site, control, 'acme', DAY, SEAL_AT).status, 'sealed');
    assert.equal(verifyAgainstSeal(site, control, 'acme', DAY).status, 'verified');

    // The next day happens. Under the whole-file seal this assertion was the false accusation
    // `S2-qa.md` §5.3 measured; under the segment it is the control's whole point.
    addRow(site, NEXT_DAY);
    addRow(site, NEXT_DAY);

    const verdict = verifyAgainstSeal(site, control, 'acme', DAY);
    assert.equal(verdict.status, 'verified', 'a later day\u2019s traffic must not falsify an earlier day\u2019s seal');
    if (verdict.status !== 'verified') return;
    assert.equal(verdict.rows_in_day, 3, 'the verdict is about that day\u2019s segment, not the file');
    assert.equal(verdict.last_id, 3);
    // The day that grew is simply not sealed yet — a different, honest answer.
    assert.equal(reasonOf(() => verifyAgainstSeal(site, control, 'acme', NEXT_DAY)), 'unsealed');
  } finally {
    site.close();
    control.close();
  }
});

test('B1-2. a row deleted BEFORE the segment is `anchor_mismatch`', () => {
  const { site, control } = freshPair('b1-2');
  try {
    // Two days: the 19th is the predecessor, the 20th is the segment under test.
    addRow(site, '2026-10-19');
    seedChain(site, DAY);
    const outcome = sealNow(site, control, 'acme', DAY, SEAL_AT);
    assert.equal(outcome.status, 'sealed');
    if (outcome.status !== 'sealed') return;
    assert.equal(outcome.seal.first_id, 2);
    assert.notEqual(outcome.seal.anchor, '', 'the 20th is anchored on the 19th');
    assert.equal(verifyAgainstSeal(site, control, 'acme', DAY).status, 'verified');

    site.exec('DROP TRIGGER trg_cms_audit_no_delete');
    site.prepare('DELETE FROM cms_audit WHERE id = 1').run();
    assert.equal(reasonOf(() => verifyAgainstSeal(site, control, 'acme', DAY)), 'anchor_mismatch');
  } finally {
    site.close();
    control.close();
  }
});

test('B1-3. a row tampered INSIDE the segment is `broken_at`, and a corrupted later day leaves day D green', () => {
  const { site, control } = freshPair('b1-3');
  try {
    seedChain(site);
    sealNow(site, control, 'acme', DAY, SEAL_AT);
    addRow(site, NEXT_DAY);
    sealNow(site, control, 'acme', NEXT_DAY, NEXT_SEAL_AT);

    // Corrupt the LATER day and recompute everything, so its walk is internally consistent and
    // only its seal can catch it. Day D must not notice — this is the range bound.
    site.exec('DROP TRIGGER trg_cms_audit_append_only');
    site.prepare("UPDATE cms_audit SET action = 'page.restore' WHERE id = 4").run();
    recomputeChain(site);
    assert.equal(
      verifyAgainstSeal(site, control, 'acme', DAY).status,
      'verified',
      'a later day\u2019s tampering is the later day\u2019s verdict',
    );
    assert.equal(reasonOf(() => verifyAgainstSeal(site, control, 'acme', NEXT_DAY)), 'head_mismatch');

    // Now tamper INSIDE day D without recomputing: the link walk refuses at that row.
    site.prepare("UPDATE cms_audit SET actor_label = 'someone@else.test' WHERE id = 2").run();
    assert.equal(reasonOf(() => verifyAgainstSeal(site, control, 'acme', DAY)), 'broken_at');
  } finally {
    site.close();
    control.close();
  }
});

test('B1-4. a segment truncated on disk is `count_mismatch` — the walk alone cannot see it', () => {
  const { site, control } = freshPair('b1-4');
  try {
    seedChain(site);
    sealNow(site, control, 'acme', DAY, SEAL_AT);
    site.exec('DROP TRIGGER trg_cms_audit_no_delete');
    site.prepare('DELETE FROM cms_audit WHERE id = 3').run();
    assert.equal(verifyChain(site).ok, true, 'a deleted tail still walks — only the seal knows');
    assert.equal(reasonOf(() => verifyAgainstSeal(site, control, 'acme', DAY)), 'count_mismatch');
  } finally {
    site.close();
    control.close();
  }
});

test('B1-5. sealing a day that has not ended is `day_not_over`', () => {
  const { site, control } = freshPair('b1-5');
  try {
    seedChain(site);
    // The day is still open at 23:59:59 on the day itself.
    assert.equal(reasonOf(() => sealNow(site, control, 'acme', DAY, Date.parse('2026-10-20T23:59:59Z'))), 'day_not_over');
    // And the same for a day that has not begun.
    assert.equal(reasonOf(() => sealNow(site, control, 'acme', '2026-10-25', SEAL_AT)), 'day_not_over');
    assert.equal(readSeal(control, 'acme', DAY), undefined, 'a refused seal wrote a row');
  } finally {
    site.close();
    control.close();
  }
});

test('B1-6. a second seal is refused, the row is byte-identical, and a direct UPDATE is aborted by the trigger', () => {
  const { site, control } = freshPair('b1-6');
  try {
    seedChain(site);
    const outcome = sealNow(site, control, 'acme', DAY, SEAL_AT);
    assert.equal(outcome.status, 'sealed');
    if (outcome.status !== 'sealed') return;
    const before = control.prepare('SELECT * FROM audit_seal WHERE tenant_key = ? AND day = ?').get('acme', DAY) as Record<string, unknown>;
    assert.throws(
      () =>
        writeSeal(
          control,
          'acme',
          DAY,
          { first_id: 1, last_id: 3, rows_in_day: 3, anchor: '', head: outcome.seal.head, late: 0 },
          SEAL_AT + 3_600_000,
        ),
      (err: unknown) =>
        code(err) === 'SKW_E_SEC_AUDIT_SEAL' && (err as { detail?: { reason?: string } }).detail?.reason === 'already_sealed',
    );
    const after = control.prepare('SELECT * FROM audit_seal WHERE tenant_key = ? AND day = ?').get('acme', DAY) as Record<string, unknown>;
    assert.deepEqual(after, before, 'the refused second seal changed the row');
    // The database refuses an UPDATE even when the app is not the writer.
    assert.throws(
      () => control.prepare("UPDATE audit_seal SET head = ? WHERE tenant_key = 'acme'").run('b'.repeat(64)),
      /SKW_E_SEC_AUDIT_SEAL/,
      'trg_audit_seal_immutable did not abort the UPDATE',
    );
  } finally {
    site.close();
    control.close();
  }
});

test('B1-7. a backfilled day is sealed from its OWN segment, with late=1 and the real sealed_at', () => {
  const { site, control } = freshPair('b1-7');
  try {
    seedChain(site, '2026-10-18');
    addRow(site, NEXT_DAY);
    addRow(site, NEXT_DAY);
    // The 18th is still unsealed two days later: backfill it on the 23rd.
    const backfillAt = Date.parse('2026-10-23T09:30:00Z');
    const outcome = sealNow(site, control, 'acme', '2026-10-18', backfillAt);
    assert.equal(outcome.status, 'sealed');
    if (outcome.status !== 'sealed') return;
    assert.equal(outcome.seal.late, 1, 'a backfill is late by definition');
    assert.equal(outcome.seal.sealed_at, '2026-10-23T09:30:00.000Z', 'sealed_at is never backdated');
    assert.equal(outcome.seal.first_id, 1);
    assert.equal(outcome.seal.last_id, 3, 'the segment is that day\u2019s ids, not the file\u2019s last id (5)');
    assert.equal(outcome.seal.rows_in_day, 3);
    assert.equal(readSeal(control, 'acme', NEXT_DAY), undefined, 'the backfill sealed a day it does not cover');
    const verdict = verifyAgainstSeal(site, control, 'acme', '2026-10-18');
    assert.equal(verdict.status, 'verified');
    if (verdict.status !== 'verified') return;
    assert.equal(verdict.late, 1);
  } finally {
    site.close();
    control.close();
  }
});

test('B1-9. a day whose rows are interleaved with another day\u2019s is `not_contiguous`', () => {
  const { site, control } = freshPair('b1-9');
  try {
    // A restored backup or a clock step: 1,2,3 on the 20th, 4 on the 21st, 5 on the 20th. Day 20
    // has four rows but its id range holds the 21st's too, so no range expresses it.
    seedChain(site, DAY);
    addRow(site, NEXT_DAY);
    addRow(site, DAY);
    assert.deepEqual(daySegment(site, DAY), { first_id: 1, last_id: 5, rows_in_day: 4 });
    assert.equal(reasonOf(() => sealNow(site, control, 'acme', DAY, SEAL_AT)), 'not_contiguous');
    assert.equal(readSeal(control, 'acme', DAY), undefined, 'a refused seal wrote a row');
  } finally {
    site.close();
    control.close();
  }
});

test('B1-10. a broken chain is never sealed: `chain_broken` refuses the write', () => {
  const { site, control } = freshPair('b1-10');
  try {
    seedChain(site);
    site.exec('DROP TRIGGER trg_cms_audit_append_only');
    site.prepare("UPDATE cms_audit SET action = 'forged' WHERE id = 2").run();
    assert.equal(reasonOf(() => sealNow(site, control, 'acme', DAY, SEAL_AT)), 'chain_broken');
    assert.equal(readSeal(control, 'acme', DAY), undefined, 'a broken chain was anchored');
  } finally {
    site.close();
    control.close();
  }
});

test('B1-11. one code, distinct reasons: the operator and the test can tell the controls apart', () => {
  const { site, control } = freshPair('b1-11');
  try {
    seedChain(site);
    try {
      verifyAgainstSeal(site, control, 'acme', DAY);
      assert.fail('an unsealed day must refuse');
    } catch (err) {
      assert.ok(err instanceof AppError);
      assert.equal(err.code, 'SKW_E_SEC_AUDIT_SEAL');
      assert.equal((err.detail as { reason?: string }).reason, 'unsealed');
      assert.match(err.message, /UNSEALED/);
    }
  } finally {
    site.close();
    control.close();
  }
});
