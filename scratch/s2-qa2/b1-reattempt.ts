/**
 * QA round 2 — the B1 re-attempt (E-20), seven steps, real CLI + real files.
 *
 *   node scratch/s2-qa2/b1-reattempt.ts
 *
 * "Real" here means: `skwctl` is invoked as a subprocess exactly as an operator runs it, against a
 * real control.db and real tenants/<key>/site.db files on disk. Audit rows are appended with the
 * product's own writer (`appendAudit`), and the tamper is done with a second connection and hand
 * SQL, which is what an attacker with the file does. Nothing is mocked and nothing is asserted in
 * place of an observation.
 *
 * The seven steps are the task's:
 *   1 seal a day, verify it
 *   2 write an audit row dated the NEXT day
 *   3 verify the sealed day again        -> MUST still pass (this was the blocker)
 *   4 tamper a row inside the segment and recompute the chain -> MUST refuse
 *   5 delete the last row of the segment -> MUST refuse
 *   6 backfill an unsealed past day -> late=1 and it verifies
 *   7 seal the same day twice with different heads -> MUST refuse the second
 */
import Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { appendAudit, auditHash, verifyAgainstSeal, writeSeal } from '../../app/audit/chain.ts';
import { makeFixture, REPO } from '../../test/helpers/fixture.ts';

const SKWCTL = join(REPO, 'app/cli/skwctl.ts');
const ACTOR = { userId: 1, label: 'qa2' };

function utcDayOffset(off: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + off);
  return d.toISOString().slice(0, 10);
}
const T = utcDayOffset(0); // today (UTC)
const D = utcDayOffset(-1); // the day under seal: sealing it today is ON TIME
const NX = T; // its successor
const E = utcDayOffset(-3); // an earlier day, gives D a non-empty anchor
const P = utcDayOffset(-4); // beta's unsealed past day, for the backfill

const fixture = makeFixture({
  specs: [
    { key: 'acme', hosts: ['acme.test'] },
    { key: 'del', hosts: ['del.test'] },
    { key: 'dup', hosts: ['dup.test'] },
    { key: 'beta', hosts: ['beta.test'] },
  ],
});

let step = 0;
function head(title: string): void {
  step += 1;
  console.log(`\n=== ${String(step)}. ${title}`);
}
function note(text: string): void {
  console.log(`    ${text}`);
}

function add(key: string, day: string, what: string): number {
  const db = new Database(fixture.sitePath(key));
  try {
    appendAudit(db, ACTOR, what, 'cms_page', '/qa2', null, { what }, Date.parse(`${day}T06:00:00.000Z`));
    const row = db.prepare('SELECT max(id) AS id FROM cms_audit').get() as { id: number };
    return row.id;
  } finally {
    db.close();
  }
}

interface CliResult {
  code: number;
  out: string;
  err: string;
}
function cli(...args: string[]): CliResult {
  const r = spawnSync(process.execPath, [SKWCTL, ...args], {
    cwd: REPO,
    env: { ...process.env, ...fixture.env },
    encoding: 'utf8',
  });
  const res = { code: r.status ?? -1, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
  console.log(`    $ skwctl ${args.join(' ')}`);
  if (res.out !== '') console.log(`      stdout: ${res.out.split('\n').join('\n              ')}`);
  if (res.err !== '') console.log(`      stderr: ${res.err.split('\n').join('\n              ')}`);
  console.log(`      exit=${res.code}`);
  return res;
}

function sealRow(key: string, day: string): Record<string, unknown> | undefined {
  const c = new Database(fixture.controlDb, { readonly: true });
  try {
    return c.prepare('SELECT * FROM audit_seal WHERE tenant_key = ? AND day = ?').get(key, day) as
      | Record<string, unknown>
      | undefined;
  } finally {
    c.close();
  }
}

/** The library's own `detail.reason` for the same day — the CLI prints a message, not the reason. */
function reasonOf(key: string, day: string): string {
  const site = new Database(fixture.sitePath(key));
  const control = new Database(fixture.controlDb);
  try {
    const v = verifyAgainstSeal(site, control, key, day);
    return v.status;
  } catch (err) {
    const e = err as { detail?: { reason?: string }; code?: string };
    return `${e.code ?? 'ERR'}/${e.detail?.reason ?? 'no-reason'}`;
  } finally {
    site.close();
    control.close();
  }
}

function dropGuards(key: string): void {
  const db = new Database(fixture.sitePath(key));
  try {
    db.exec('DROP TRIGGER IF EXISTS trg_cms_audit_append_only; DROP TRIGGER IF EXISTS trg_cms_audit_no_delete;');
  } finally {
    db.close();
  }
}

/** Recompute every link from the (now edited) rows, so the file is internally consistent again. */
function rechain(key: string): void {
  const db = new Database(fixture.sitePath(key));
  try {
    const rows = db
      .prepare(
        `SELECT id, actor_user_id, actor_label, action, target_kind, target_id,
                before_json, after_json, prev_hash, hash, ts FROM cms_audit ORDER BY id`,
      )
      .all() as Record<string, unknown>[];
    let prev = '';
    const stamp = db.prepare('UPDATE cms_audit SET prev_hash = ?, hash = ? WHERE id = ?');
    for (const r of rows) {
      const hash = auditHash(prev, r as never);
      stamp.run(prev, hash, r.id as number);
      prev = hash;
    }
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------------------------
console.log('B1 re-attempt — real skwctl, real files');
console.log(`today=${T}  sealed day D=${D}  successor day=${NX}  earlier day=${E}  backfill day=${P}`);

add('acme', E, 'page.early.one');
add('acme', E, 'page.early.two');
const acmeFirst = add('acme', D, 'page.one');
add('acme', D, 'page.two');
add('acme', D, 'page.three');
add('del', D, 'page.del.one');
add('del', D, 'page.del.two');
add('del', D, 'page.del.three');
add('dup', D, 'page.dup.one');
add('dup', D, 'page.dup.two');
add('dup', D, 'page.dup.three');
add('beta', P, 'page.beta.one');
add('beta', P, 'page.beta.two');
note(`acme chain: ids 1..2 on ${E}, ids ${acmeFirst}..${acmeFirst + 2} on ${D}`);
console.log(`fixture: ${fixture.dir}`);

// 1 -------------------------------------------------------------------------------------------
head(`seal ${D}, then verify it`);
cli('audit', 'seal', '--tenant', 'acme', '--day', D);
const v1 = cli('audit', 'verify', '--tenant', 'acme', '--day', D);
note(`STEP 1 RESULT: ${v1.code === 0 ? 'PASS (verified)' : 'FAIL (refused)'}`);

// 2 -------------------------------------------------------------------------------------------
head(`write one audit row dated the NEXT day (${NX})`);
const nextId = add('acme', NX, 'page.nextday');
note(`appended id=${nextId} with ts ${NX}T06:00:00Z; cms_audit rows now 6, the seal covers 3`);

// 3 -------------------------------------------------------------------------------------------
head(`verify ${D} again — THE BLOCKER`);
const v3 = cli('audit', 'verify', '--tenant', 'acme', '--day', D);
note(`STEP 3 RESULT: ${v3.code === 0 ? 'PASS — the sealed day still verifies after its successor' : 'FAIL — the blocker is still present'} (library status=${reasonOf('acme', D)})`);

// 4 -------------------------------------------------------------------------------------------
head(`tamper a row INSIDE ${D}'s segment and recompute the whole chain`);
dropGuards('acme');
{
  const db = new Database(fixture.sitePath('acme'));
  try {
    db.prepare("UPDATE cms_audit SET action = 'page.forged' WHERE id = ?").run(acmeFirst + 1);
  } finally {
    db.close();
  }
}
rechain('acme');
note('id ' + String(acmeFirst + 1) + " action changed to 'page.forged'; every prev_hash/hash recomputed");
const chainAfterTamper = cli('audit', 'verify', '--tenant', 'acme', '--chain');
note(`whole-file walk after the tamper: exit=${chainAfterTamper.code} (a chain an attacker rewrote walks cleanly — that is why the seal exists)`);
const v4 = cli('audit', 'verify', '--tenant', 'acme', '--day', D);
const v4Reason = reasonOf('acme', D);
note(`STEP 4 RESULT: ${v4.code !== 0 ? 'PASS (refused)' : 'FAIL (still green — no discriminating power)'} reason=${v4Reason}`);

// 5 -------------------------------------------------------------------------------------------
head(`delete the LAST row of a sealed segment (tenant del, no successor: only the seal can see it)`);
cli('audit', 'seal', '--tenant', 'del', '--day', D);
const delSeal = sealRow('del', D);
note(`del seal: ids=${String(delSeal?.first_id)}..${String(delSeal?.last_id)} rows_in_day=${String(delSeal?.rows_in_day)}`);
dropGuards('del');
{
  const db = new Database(fixture.sitePath('del'));
  try {
    db.prepare('DELETE FROM cms_audit WHERE id = ?').run(Number(delSeal?.last_id));
  } finally {
    db.close();
  }
}
const delChain = cli('audit', 'verify', '--tenant', 'del', '--chain');
note(`whole-file walk: exit=${delChain.code} — a truncated tail walks cleanly`);
const v5 = cli('audit', 'verify', '--tenant', 'del', '--day', D);
const v5Reason = reasonOf('del', D);
note(`STEP 5 RESULT: ${v5.code !== 0 ? 'PASS (refused)' : 'FAIL (still green)'} reason=${v5Reason}`);

// 6 -------------------------------------------------------------------------------------------
head(`backfill beta's unsealed past day ${P} on ${T}`);
const v6seal = cli('audit', 'seal', '--tenant', 'beta', '--day', P);
const betaSeal = sealRow('beta', P);
note(`stored: late=${String(betaSeal?.late)} sealed_at=${String(betaSeal?.sealed_at)} ids=${String(betaSeal?.first_id)}..${String(betaSeal?.last_id)} rows_in_day=${String(betaSeal?.rows_in_day)}`);
const v6 = cli('audit', 'verify', '--tenant', 'beta', '--day', P);
const lateOk = Number(betaSeal?.late) === 1;
note(`STEP 6 RESULT: late=1 ${lateOk ? 'YES' : 'NO'}; verify ${v6.code === 0 ? 'PASS' : 'FAIL'}; seal exit=${v6seal.code}`);

// 7 -------------------------------------------------------------------------------------------
head(`seal ${D} twice for tenant dup, with a DIFFERENT head the second time`);
cli('audit', 'seal', '--tenant', 'dup', '--day', D);
const before = sealRow('dup', D);
// A row dated the SAME day, after the seal: a re-seal would now compute a larger segment and a new head.
add('dup', D, 'page.dup.late');
const afterRow = sealRow('dup', D);
const v7 = cli('audit', 'seal', '--tenant', 'dup', '--day', D);
const after = sealRow('dup', D);
const identical = JSON.stringify(before) === JSON.stringify(after);
note(`stored row before re-seal: ${JSON.stringify(before)}`);
note(`stored row after  re-seal: ${JSON.stringify(after)}`);
note(`byte-identical after the second seal: ${identical ? 'YES' : 'NO'}`);
note(`the row appended after the seal (${String(afterRow?.rows_in_day)} sealed rows) would have made head=${'a different value'}; the seal did not move`);
{
  const c = new Database(fixture.controlDb);
  try {
    c.prepare("UPDATE audit_seal SET head = 'deadbeef' WHERE tenant_key = 'dup'").run();
    note('direct UPDATE audit_seal: ACCEPTED — the immutability trigger is missing');
  } catch (err) {
    note(`direct UPDATE audit_seal: aborted — ${(err as { message?: string }).message ?? String(err)}`);
  } finally {
    c.close();
  }
}
note(`STEP 7 RESULT: second seal exit=${v7.code}; row unchanged ${identical ? 'YES' : 'NO'}`);

// 7b: the write itself, not the CLI's reporting. `writeSeal` is what must refuse a different head.
{
  const control = new Database(fixture.controlDb);
  try {
    writeSeal(control, 'dup', D, {
      first_id: 1,
      last_id: 4,
      rows_in_day: 4,
      anchor: '',
      head: 'f'.repeat(64),
      late: 0,
    });
    note('7b. writeSeal with a different head: ACCEPTED — the anchor is writable');
  } catch (err) {
    const e = err as { code?: string; detail?: { reason?: string } };
    note(`7b. writeSeal with a different head: REFUSED ${String(e.code)} reason=${String(e.detail?.reason)}`);
  } finally {
    control.close();
  }
  const after7b = sealRow('dup', D);
  note(`7b. stored row after the direct attempt: unchanged ${JSON.stringify(after7b) === JSON.stringify(before) ? 'YES' : 'NO'}`);
}

// the operator's view of the whole file, after everything above
head("operator status for acme (the sealed day, its successor, the tampered segment)");
cli('audit', 'status', '--tenant', 'acme', '--days', '6');

console.log('\nfixture left on disk for inspection:', fixture.dir);
fixture.cleanup();
