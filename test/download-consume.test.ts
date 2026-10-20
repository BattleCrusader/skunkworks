/**
 * S3c / C-7 — **the consume under real, multi-process contention.**
 *
 * `download-redeem.test.ts` sends 8 parallel HTTP requests, and they do prove the
 * contract a client sees. They cannot prove the *transaction's* ordering, because one
 * Node process serialises them: `better-sqlite3` is synchronous and the event loop
 * runs one callback at a time, so update-first would pass that test by accident.
 *
 * This file removes the event loop from the question: 8 OS processes, 8 connections to
 * the same `site.db`, each waiting on a wall-clock instant and then running one
 * `BEGIN IMMEDIATE`. That is the arrangement the SDS measured at `uses = 24` under
 * update-first, and the arrangement that must produce `uses = 1` here.
 *
 *   C1  8 processes, one `jti`            -> one `spent`, 7 continuations, uses = 1, 1 row
 *   C2  8 processes, two `jti`            -> two `spent`, uses = 2, 2 rows
 *   C3  8 processes, 8 `jti`, max_uses=2  -> exactly 2 `spent`, 6 denied_quota, uses = 2
 *   C4  a denial is not a continuation    -> the same jti retried after a quota denial
 *                                            is denied again, never served
 */
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { before, test } from 'node:test';

import { consumeUse } from '../app/download/ledger.ts';
import { makeFixture, SCHEMA, type Fixture } from './helpers/fixture.ts';

const CHILD = join(import.meta.dirname, 'helpers', 'consume-child.ts');
/** Far enough ahead that eight `node` start-ups are all sitting in their timer. */
const LEAD_MS = 1500;

let fixture: Fixture;
let dbPath = '';
let assetId = 0;

interface Outcome {
  spent?: boolean;
  continuation?: boolean;
  reason?: string | null;
  error?: string;
}

function seedCode(maxUses: number | null, uses = 0): number {
  const db = new Database(dbPath);
  db.pragma('foreign_keys = 1');
  try {
    const info = db
      .prepare(
        `INSERT INTO cms_download_code (code_selector, code_hash, asset_id, max_uses, uses)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        String(Math.random()).slice(2, 6).toUpperCase().padEnd(4, 'Z'),
        '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2E$' + 'A'.repeat(43),
        assetId,
        maxUses,
        uses,
      );
    return Number(info.lastInsertRowid);
  } finally {
    db.close();
  }
}

function runChild(args: string[]): Promise<Outcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHILD, dbPath, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (c: Buffer) => (out += String(c)));
    child.stderr.on('data', (c: Buffer) => (err += String(c)));
    child.on('error', reject);
    child.on('close', () => {
      const line = out.trim().split('\n').pop() ?? '';
      if (line === '') {
        reject(new Error(`child produced no result: ${err}`));
        return;
      }
      resolve(JSON.parse(line) as Outcome);
    });
  });
}

/** Eight processes released at the same instant; `jtis[i]` is the jti for process i. */
async function race(jtis: string[], codeId: number): Promise<Outcome[]> {
  const start = Date.now() + LEAD_MS;
  return Promise.all(
    jtis.map((jti) => runChild([jti, String(codeId), String(assetId), '1024', String(start)])),
  );
}

function state(codeId: number): { uses: number; rows: number; outcomes: string[] } {
  const db = new Database(dbPath);
  try {
    const uses = Number((db.prepare(`SELECT uses FROM cms_download_code WHERE id = ?`).get(codeId) as { uses: number }).uses);
    const rows = db
      .prepare(`SELECT outcome FROM cms_download_event WHERE code_id = ? AND kind = 'first' ORDER BY id`)
      .all(codeId) as { outcome: string }[];
    return { uses, rows: rows.length, outcomes: rows.map((r) => r.outcome) };
  } finally {
    db.close();
  }
}

before(() => {
  fixture = makeFixture({ specs: [{ key: 'acme', hosts: ['acme.test'] }] });
  dbPath = fixture.sitePath('acme');
  const db = new Database(dbPath);
  db.pragma('foreign_keys = 1');
  try {
    const info = db
      .prepare(
        `INSERT INTO cms_asset (key, filename, mime, bytes, sha256, kind, access_class)
         VALUES ('vault/book', 'book.pdf', 'application/pdf', 4096, ?, 'document', 'gated')`,
      )
      .run('ab'.repeat(32));
    assetId = Number(info.lastInsertRowid);
  } finally {
    db.close();
  }
  // The schema the fixture wrote is the shipped one; assert that rather than assume it.
  assert.ok(readFileSync(join(SCHEMA, 'site.sql'), 'utf8').includes('ux_ev_jti_first'));
});

test('C1. 8 processes, one jti: one redemption, seven continuations, one row', async () => {
  const codeId = seedCode(3);
  const jti = '1'.repeat(32);
  const results = await race(Array.from({ length: 8 }, () => jti), codeId);

  const spent = results.filter((r) => r.spent === true).length;
  const continuations = results.filter((r) => r.continuation === true).length;
  const errors = results.filter((r) => r.error !== undefined);
  assert.deepEqual(errors, [], `no child may fail: ${JSON.stringify(errors)}`);
  assert.equal(spent, 1, `expected one spent, got ${spent} of ${JSON.stringify(results)}`);
  assert.equal(continuations, 7, `expected seven continuations, got ${continuations}`);
  assert.deepEqual(state(codeId), { uses: 1, rows: 1, outcomes: ['ok'] });
});

test('C2 — 8 processes, two jti: two uses, two rows', async () => {
  const codeId = seedCode(3);
  // A jti is unique per redemption and the index on it is global, so the two groups
  // must not reuse an id from C1: that would be one jti on two purchases, which is a
  // token collision rather than a second redemption (and `ledger.ts` refuses it).
  const jtis = Array.from({ length: 8 }, (_, i) => `c2-${i % 2}`.padEnd(32, 'f'));
  const results = await race(jtis, codeId);
  const spent = results.filter((r) => r.spent === true).length;
  assert.equal(spent, 2, `one spend per jti, got ${spent}: ${JSON.stringify(results)}`);
  assert.deepEqual(state(codeId), { uses: 2, rows: 2, outcomes: ['ok', 'ok'] });
});

test('C3. 8 processes, 8 jti, max_uses=2: exactly two spend and six are denied', async () => {
  const codeId = seedCode(2);
  const jtis = Array.from({ length: 8 }, (_, i) => `a${i}`.padEnd(32, 'b'));
  const results = await race(jtis, codeId);
  const spent = results.filter((r) => r.spent === true).length;
  const denied = results.filter((r) => r.reason === 'denied_quota').length;
  assert.equal(spent, 2, `the cap is 2 and ${spent} spent: ${JSON.stringify(results)}`);
  assert.equal(denied, 6, `the other six are denials, got ${denied}`);
  const after = state(codeId);
  assert.equal(after.uses, 2, 'the counter never exceeds the cap');
  assert.equal(after.rows, 8, 'every attempt is on the ledger');
  assert.equal(after.outcomes.filter((o) => o === 'ok').length, 2);
  assert.equal(after.outcomes.filter((o) => o === 'denied_quota').length, 6);
});

test('C4 — a quota denial is not a continuation: the same jti retried is denied again', () => {
  const codeId = seedCode(1);
  const jti = 'c'.repeat(32);
  const args = {
    jti,
    codeId,
    assetId,
    bytesDeclared: 10,
    ipHash: 'ip'.repeat(11),
    uaHash: 'ua'.repeat(11),
    at: new Date().toISOString(),
    nowMs: Date.now(),
  };
  const db = new Database(dbPath);
  db.pragma('busy_timeout = 5000');
  try {
    assert.deepEqual(consumeUse(db, args), { spent: true });
    // Spend the last use on a second token, then retry the *first* one after the cap.
    const second = consumeUse(db, { ...args, jti: 'd'.repeat(32) });
    assert.equal(second.spent, false);
    assert.equal(second.continuation, false);
    // The first jti has an `ok` row, so it is a legitimate continuation — the code is
    // still live, and a resume must not be re-charged.
    assert.deepEqual(consumeUse(db, args), { spent: false, continuation: true });
    // A *new* third token is denied by the cap.
    assert.deepEqual(consumeUse(db, { ...args, jti: 'e'.repeat(32) }), {
      spent: false,
      continuation: false,
      reason: 'denied_quota',
    });
    // And retrying that denied token finds its own denial row: still denied.
    assert.deepEqual(consumeUse(db, { ...args, jti: 'e'.repeat(32) }), {
      spent: false,
      continuation: false,
      reason: 'denied_quota',
    });
  } finally {
    db.close();
  }
});
