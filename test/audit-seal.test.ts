/**
 * §9.6 / C-21 — the audit chain, its verifier, and the daily seal.
 *
 * Round 2 measured the failure this file exists to prevent: **an unanchored chain
 * verifies after tampering.** Change a row's `action`, delete the `BEFORE UPDATE`
 * trigger, recompute every `hash` with the writer's own definition, and a verifier that
 * only walks the links returns ok — the attacker's file is internally consistent. The
 * seal in `control.db` is the second opinion, and the gate below asserts both halves
 * separately: the recomputed chain passes `verifyChain` **and** the seal comparison
 * fails. A test that only asserted the failure would not prove which one caught it.
 *
 * The chain is written by the production writer (`crud.createRow`) for the first row,
 * so the writer and the verifier cannot drift without this file going red.
 */
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { createRow, type Actor } from '../app/admin/crud.ts';
import {
  appendAudit,
  auditHash,
  canonicalRow,
  chainHead,
  readSeal,
  sealNow,
  utcDay,
  verifyAgainstSeal,
  verifyChain,
} from '../app/audit/chain.ts';
import { AppError } from '../app/errors.ts';
import { makeFixture, SCHEMA, type Fixture } from './helpers/fixture.ts';

const ACTOR: Actor = { userId: 7, label: 'owner@acme.test' };
const DAY = '2026-10-20';

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
  control.prepare("INSERT INTO tenant (key, mode, status, display_name, db_version) VALUES ('acme','production','active','Acme',3)").run();
  return { site, control };
}

/** Three rows: one written by the CRUD path, two by the chain module the runner uses. */
function seedChain(site: Database.Database): void {
  const tx = site.transaction(() => {
    createRow(site, 'cms_page', { path: '/one', slug: 'one', title: 'One', body_html: '<p>one</p>' }, ACTOR);
    appendAudit(site, { userId: 7, label: ACTOR.label }, 'u_post.create', 'u_post', '1', null, { id: 1 });
    appendAudit(site, { userId: 7, label: ACTOR.label }, 'u_post.update', 'u_post', '1', { id: 1 }, { id: 1, title: 'x' });
  });
  tx();
}

test('A1. the writer and the verifier agree: three rows chain, and the head is the last hash', () => {
  const { site, control } = freshPair('a1');
  try {
    seedChain(site);
    const report = verifyChain(site);
    assert.equal(report.ok, true);
    assert.equal(report.rows, 3);
    assert.equal(report.head, chainHead(site));
    // Every link carries the previous hash, row to row — not merely a hash per row.
    const rows = site.prepare('SELECT prev_hash, hash FROM cms_audit ORDER BY id').all() as { prev_hash: string; hash: string }[];
    assert.equal(rows[0]!.prev_hash, '');
    assert.equal(rows[1]!.prev_hash, rows[0]!.hash);
    assert.equal(rows[2]!.prev_hash, rows[1]!.hash);
    // And every hash is recomputable from the stored row with the writer's definition.
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

test('A3. a sealed chain verifies; the seal records count and head', () => {
  const { site, control } = freshPair('a3');
  try {
    seedChain(site);
    const seal = sealNow(site, control, 'acme', DAY);
    assert.equal(seal.rows, 3);
    assert.equal(seal.head, chainHead(site));
    const result = verifyAgainstSeal(site, control, 'acme', DAY);
    assert.equal(result.ok, true);
    assert.equal(result.rows, 3);
    assert.equal(result.seal?.head, seal.head);
  } finally {
    site.close();
    control.close();
  }
});

test('A4. THE CRITERION — tamper one row and recompute the chain: the walk passes, the seal refuses', () => {
  const { site, control } = freshPair('a4');
  try {
    seedChain(site);
    sealNow(site, control, 'acme', DAY);

    // The attacker model: write access to site.db. Delete the append-only trigger,
    // change what row 2 says, then recompute every hash with the writer's definition so
    // the file is internally consistent again.
    site.exec('DROP TRIGGER trg_cms_audit_append_only');
    site.prepare("UPDATE cms_audit SET action = 'u_post.restore' WHERE id = 2").run();
    const rows = site.prepare('SELECT * FROM cms_audit ORDER BY id').all() as Record<string, unknown>[];
    let prev = '';
    const stamp = site.prepare('UPDATE cms_audit SET prev_hash = ?, hash = ? WHERE id = ?');
    for (const row of rows) {
      const hash = auditHash(prev, row as never);
      stamp.run(prev, hash, row.id as number);
      prev = hash;
    }

    // The unanchored half: the chain walks. This is what round 2 measured, and it is
    // why the verifier may not stop here.
    const walk = verifyChain(site);
    assert.equal(walk.ok, true, 'the recomputed chain must pass the link walk — this is the premise of the seal');
    assert.notEqual(walk.head, readSeal(control, 'acme', DAY)?.head, 'the recomputed head must differ from the seal');

    // The anchored half: the seal refuses it.
    assert.throws(
      () => verifyAgainstSeal(site, control, 'acme', DAY),
      (err: unknown) => err instanceof AppError && err.code === 'SKW_E_SEC_AUDIT_SEAL',
      'an unanchored verifier would have passed this',
    );
  } finally {
    site.close();
    control.close();
  }
});

test('A5. a deleted tail still walks, and the seal catches the missing rows', () => {
  const { site, control } = freshPair('a5');
  try {
    seedChain(site);
    sealNow(site, control, 'acme', DAY);
    site.exec('DROP TRIGGER trg_cms_audit_no_delete');
    site.prepare('DELETE FROM cms_audit WHERE id = 3').run();
    assert.equal(verifyChain(site).ok, true, 'the shortened chain is still internally consistent');
    assert.throws(
      () => verifyAgainstSeal(site, control, 'acme', DAY),
      (err: unknown) => err instanceof AppError && err.code === 'SKW_E_SEC_AUDIT_SEAL',
    );
  } finally {
    site.close();
    control.close();
  }
});

test('A6. a day with no seal is a refusal, not a pass ("a missing digest is itself the evidence")', () => {
  const { site, control } = freshPair('a6');
  try {
    seedChain(site);
    assert.throws(
      () => verifyAgainstSeal(site, control, 'acme', DAY),
      (err: unknown) => err instanceof AppError && err.code === 'SKW_E_SEC_AUDIT_SEAL',
    );
  } finally {
    site.close();
    control.close();
  }
});

test('A7. a day is sealed once: re-sealing a different head is the attack, and it is refused', () => {
  const { site, control } = freshPair('a7');
  try {
    seedChain(site);
    const seal = sealNow(site, control, 'acme', DAY);
    // Idempotent when nothing moved (a daily job that ran twice).
    assert.deepEqual(sealNow(site, control, 'acme', DAY), seal);
    // One more row, then a re-seal of the same day with the new head: refused, because
    // accepting it would let an attacker launder a tampered chain by re-sealing.
    appendAudit(site, { userId: 7, label: ACTOR.label }, 'u_post.delete', 'u_post', '1', { id: 1 }, null);
    assert.throws(
      () => sealNow(site, control, 'acme', DAY),
      (err: unknown) => err instanceof AppError && err.code === 'SKW_E_SEC_AUDIT_SEAL',
    );
  } finally {
    site.close();
    control.close();
  }
});

test('A8. the seal day is UTC and comes from one function, not the caller\u2019s locale', () => {
  assert.equal(utcDay(Date.parse('2026-10-20T23:59:59.999Z')), '2026-10-20');
  assert.equal(utcDay(Date.parse('2026-10-21T00:00:00.000Z')), '2026-10-21');
});
