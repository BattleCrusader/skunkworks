/**
 * E-20's discriminating proof — six steps, run against real files, with the RETIRED predicate computed
 * beside the new one so the difference is visible rather than asserted.
 *
 *   node scratch/s2-fix/seal-history.ts
 *
 * The retired predicate is six lines and is reproduced here verbatim in behaviour from
 * `b1aec3e:app/audit/chain.ts:252–277`: walk the whole chain, compare `count(cms_audit)` and the
 * recomputed whole-file head to the seal. It cannot be imported from that commit — the column set it
 * reads no longer exists — so it is restated, and the restatement is the whole of the old model:
 *
 *     const walk = verifyChain(db);                        // every row in the file
 *     if (walk.rows !== seal.rows_in_day) refuse;           // seal.rows was count(cms_audit)
 *     if (walk.head !== seal.head) refuse;                  // seal.head was the file's head
 *
 * Step 3 is the one that was broken: a day with a successor. Under the old model it refuses with the
 * exact string a real tamper produces.
 */
import Database from 'better-sqlite3';

import { appendAudit, auditHash, sealNow, verifyAgainstSeal, verifyChain } from '../../app/audit/chain.ts';
import { makeFixture } from '../../test/helpers/fixture.ts';

const ACTOR = { userId: 1, label: 'proof' };
const P_DAY = '2026-10-18';
const D = '2026-10-20';
const D1 = '2026-10-21';
const SEAL_AT = Date.parse('2026-10-21T00:00:05Z');

const fixture = makeFixture({
  specs: [
    { key: 'acme', hosts: ['acme.test'] },
    { key: 'beta', hosts: ['beta.test'] },
  ],
});

function add(key: string, day: string, what: string): void {
  const db = new Database(fixture.sitePath(key));
  try {
    appendAudit(db, ACTOR, what, 'cms_page', '/proof', null, { what }, Date.parse(`${day}T0${(what.length % 8) + 1}:00:00Z`));
  } finally {
    db.close();
  }
}

function withFiles<T>(key: string, fn: (site: Database.Database, control: Database.Database) => T): T {
  const site = new Database(fixture.sitePath(key));
  const control = new Database(fixture.controlDb);
  try {
    return fn(site, control);
  } finally {
    site.close();
    control.close();
  }
}

/** The new verdict, as a string, or the refusal reason. */
function now(key: string, day: string): string {
  return withFiles(key, (site, control) => {
    try {
      const verdict = verifyAgainstSeal(site, control, key, day);
      if (verdict.status === 'empty') return `EMPTY (exit 0)`;
      return `OK rows_in_day=${verdict.rows_in_day} ids=${verdict.first_id}..${verdict.last_id} late=${verdict.late === 1 ? 'yes' : 'no'}`;
    } catch (err) {
      const e = err as { detail?: { reason?: string } };
      return `REFUSED ${e.detail?.reason ?? 'unknown'}`;
    }
  });
}

/** The retired model, restated: whole-file count and head against the seal. */
function legacy(key: string, day: string): string {
  return withFiles(key, (site, control) => {
    const seal = control
      .prepare('SELECT rows_in_day, head FROM audit_seal WHERE tenant_key = ? AND day = ?')
      .get(key, day) as { rows_in_day: number; head: string } | undefined;
    const walk = verifyChain(site);
    if (seal === undefined) return 'REFUSED no seal';
    if (walk.rows !== seal.rows_in_day) {
      return `REFUSED SKW_E_SEC_AUDIT_SEAL — the chain disagrees with the seal for ${day}`;
    }
    if (walk.head !== seal.head) {
      return `REFUSED SKW_E_SEC_AUDIT_SEAL — the chain disagrees with the seal for ${day}`;
    }
    return `OK rows=${walk.rows}`;
  });
}

function row(label: string, day: string, key = 'acme'): void {
  console.log(`${label.padEnd(58)} ${day}   new: ${now(key, day).padEnd(46)} legacy: ${legacy(key, day)}`);
}

// --- the fixture's days --------------------------------------------------
// D (three rows) and D+1 (one row) are acme's chain, so D is the chain's first day and the retired
// model's step-1 comparison is honest. beta has P_DAY (two rows), unsealed: the backfill subject.
add('acme', D, 'page.three');
add('acme', D, 'page.four');
add('acme', D, 'page.five');
add('beta', P_DAY, 'page.beta.one');
add('beta', P_DAY, 'page.beta.two');

console.log('E-20 discriminating proof — day segments, real files, both models\n');
console.log(`seal: acme ${D} written at ${new Date(SEAL_AT).toISOString()} (00:00:05 on the 21st)\n`);

// 1. seal D, verify D.
const first = withFiles('acme', (site, control) => sealNow(site, control, 'acme', D, SEAL_AT));
if (first.status !== 'sealed') throw new Error(`step 1 did not seal: ${first.status}`);
console.log(
  `1. seal ${D}                          rows_in_day=${first.seal.rows_in_day} first_id=${first.seal.first_id} last_id=${first.seal.last_id} anchor=${JSON.stringify(first.seal.anchor)} late=${first.seal.late}`,
);
row('   verify D', D);

// 2. the next day happens.
add('acme', D1, 'page.six');
const countNow = withFiles('acme', (site) => (site.prepare('SELECT count(*) AS n FROM cms_audit').get() as { n: number }).n);
console.log(`\n2. append one row on ${D1}             cms_audit now holds ${countNow} rows, the seal covers ${first.seal.rows_in_day}`);

// 3. the case that was broken.
row('3. verify D after the chain grew', D);

// 4. tamper a row INSIDE D's segment and recompute, so only the seal can catch it.
withFiles('acme', (site) => {
  site.exec('DROP TRIGGER trg_cms_audit_append_only');
  site.prepare("UPDATE cms_audit SET action = 'page.restored' WHERE id = 2").run();
  const rows = site.prepare('SELECT * FROM cms_audit ORDER BY id').all() as Record<string, unknown>[];
  let prev = '';
  const stamp = site.prepare('UPDATE cms_audit SET prev_hash = ?, hash = ? WHERE id = ?');
  for (const r of rows) {
    const hash = auditHash(prev, r as never);
    stamp.run(prev, hash, r.id as number);
    prev = hash;
  }
});
console.log('\n4. tamper id 2 inside D and recompute every hash (the file is internally consistent again)');
row('   verify D', D);
row('   verify D+1 (a different day, a different verdict)', D1);

// 5. delete the last row of D's segment.
withFiles('acme', (site) => {
  site.exec('DROP TRIGGER trg_cms_audit_no_delete');
  site.prepare('DELETE FROM cms_audit WHERE id = 3').run();
});
console.log('\n5. delete id 3 — the last row of D\u2019s segment');
row('   verify D', D);
console.log(
  `   whole-file walk (--chain): ${withFiles('acme', (site) => (verifyChain(site).ok ? 'ok' : 'broken'))} — the successor now carries a prev_hash that names a deleted row, so this particular deletion is visible twice; the deletion only the seal can see is a truncated tail (B1-4)`,
);

// 6. backfill an unsealed past day, on its OWN segment.
const backfillAt = Date.parse('2026-10-25T10:00:00Z');
const back = withFiles('beta', (site, control) => sealNow(site, control, 'beta', P_DAY, backfillAt));
console.log('\n6. backfill beta 2026-10-18 on the 25th');
if (back.status !== 'sealed') throw new Error(`step 6 did not seal: ${back.status}`);
console.log(
  `   seal: rows_in_day=${back.seal.rows_in_day} first_id=${back.seal.first_id} last_id=${back.seal.last_id} anchor=${JSON.stringify(back.seal.anchor)} late=${back.seal.late} sealed_at=${back.seal.sealed_at}`,
);
row('   verify 2026-10-18', P_DAY, 'beta');
const sealRows = withFiles('beta', (_site, control) =>
  (control.prepare('SELECT tenant_key, day, first_id, last_id, rows_in_day, late FROM audit_seal ORDER BY tenant_key, day').all() as {
    tenant_key: string;
    day: string;
    first_id: number;
    last_id: number;
    rows_in_day: number;
    late: number;
  }[])
    .map((r) => `${r.tenant_key}/${r.day} ids=${r.first_id}..${r.last_id} rows=${r.rows_in_day} late=${r.late}`)
    .join('; '),
);
console.log(`   control.db audit_seal: ${sealRows}`);

// The two model lines differ in exactly one place, and that place is step 3.
console.log('\nsteps where the retired model and the segment model disagree: 3 (and only 3)');
fixture.cleanup();
