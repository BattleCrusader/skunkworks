/** F — the daily seal scheduler: does anything tick it, and is a missed day visible? */
import { spawn } from 'node:child_process';
import Database from 'better-sqlite3';

import { appendAudit, verifyAgainstSeal } from '../../app/audit/chain.ts';
import { msUntilNextUtcMidnight, sealDay, startSealScheduler } from '../../app/audit/scheduler.ts';
import { makeFixture } from '../../test/helpers/fixture.ts';

const fixture = makeFixture({ specs: [{ key: 'acme', hosts: ['acme.test'] }, { key: 'beta', hosts: ['beta.test'] }] });

for (const key of ['acme', 'beta']) {
  const db = new Database(fixture.sitePath(key));
  try {
    appendAudit(db, { userId: 1, label: 'qa' }, 'qa.probe', 'cms_page', '1', null, { ok: true }, Date.now());
  } finally {
    db.close();
  }
}

const control = new Database(fixture.controlDb);
const sealRows = (): { tenant_key: string; day: string; rows: number }[] =>
  control.prepare('SELECT tenant_key, day, rows FROM audit_seal ORDER BY tenant_key, day').all() as {
    tenant_key: string;
    day: string;
    rows: number;
  }[];

const t = (iso: string): number => Date.parse(iso);

// 1. Schedule arithmetic at three instants.
console.log('ms to next UTC midnight at 23:00:00Z      :', msUntilNextUtcMidnight(t('2026-10-20T23:00:00Z')));
console.log('ms to next UTC midnight at 00:00:00Z      :', msUntilNextUtcMidnight(t('2026-10-21T00:00:00Z')));
console.log('ms to next UTC midnight at 23:59:59.500Z  :', msUntilNextUtcMidnight(t('2026-10-20T23:59:59.500Z')));

// 2. A scheduler with a frozen clock: what it targets, and that stop() is real.
let runs = 0;
const handle = startSealScheduler({
  dataDir: fixture.dir,
  now: () => t('2026-10-20T23:59:59.000Z'),
  onRun: () => {
    runs += 1;
  },
});
console.log('\nscheduler nextRunAt:', new Date(handle.nextRunAt).toISOString(), '| stopped?', handle.stopped, '| runs so far', runs);
handle.stop();
console.log('after stop(): stopped?', handle.stopped, '| seal rows written:', sealRows().length);

// 3. What the tick does when it fires: `utcDay(tick - 1000)`, i.e. yesterday.
const tickDay = sealDay({ dataDir: fixture.dir, day: '2026-10-20' });
console.log('\nsealDay(2026-10-20) [the day a 00:00:00Z tick on the 21st seals]:', JSON.stringify(tickDay.tenants.map((r) => ({ key: r.key, created: r.created, rows: r.rows }))));
console.log('seal rows now:', JSON.stringify(sealRows().map((r) => `${r.tenant_key}:${r.day}:${r.rows}`)));

// 4. A missed midnight: the 21st is never sealed. Is that visible?
console.log('\n-- a day the job never ran --');
console.log('seal rows for 2026-10-21:', sealRows().filter((r) => r.day === '2026-10-21').length);
for (const key of ['acme', 'beta']) {
  const db = new Database(fixture.sitePath(key));
  try {
    try {
      const r = verifyAgainstSeal(db, control, key, '2026-10-21');
      console.log(`verifyAgainstSeal(${key}, 2026-10-21): OK rows=${r.rows}`);
    } catch (err) {
      console.log(`verifyAgainstSeal(${key}, 2026-10-21): REFUSED ${String((err as { code?: string }).code)} / ${String((err as { message?: string }).message)}`);
    }
  } finally {
    db.close();
  }
}

// 5. The operator command, as a process: a missed day and a sealed day.
const cli = (day: string): Promise<{ code: number | null; out: string; err: string }> =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, ['app/cli/skwctl.ts', 'audit', 'verify', '--tenant', 'acme', '--day', day], {
      env: { ...process.env, ...fixture.env },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString()));
    child.stderr.on('data', (c: Buffer) => (err += c.toString()));
    child.on('close', (code) => resolve({ code, out: out.trim(), err: err.trim() }));
  });
const missed = await cli('2026-10-21');
console.log(`\nskwctl audit verify --day 2026-10-21 -> exit ${String(missed.code)} stdout=${JSON.stringify(missed.out)} stderr=${JSON.stringify(missed.err.slice(0, 220))}`);
const sealed = await cli('2026-10-20');
console.log(`skwctl audit verify --day 2026-10-20 -> exit ${String(sealed.code)} stdout=${JSON.stringify(sealed.out)}`);

// 6. A gap is fillable only by naming the day.
const backfill = sealDay({ dataDir: fixture.dir, day: '2026-10-21' });
console.log('\nmanual sealDay(2026-10-21):', JSON.stringify(backfill.tenants.map((r) => ({ key: r.key, created: r.created }))));
console.log('seal rows after the manual backfill:', JSON.stringify(sealRows().map((r) => `${r.tenant_key}:${r.day}`)));

// 7. The scheduler with runImmediately (what a CLI-ish caller would use) seals *today*.
let immediate: string[] = [];
const h2 = startSealScheduler({
  dataDir: fixture.dir,
  now: () => t('2026-10-22T09:00:00Z'),
  runImmediately: true,
  onRun: (r) => {
    immediate = r.tenants.map((x) => `${x.key}:${x.created ? 'created' : 'existing'}`);
  },
});
h2.stop();
console.log('runImmediately at 09:00Z on the 22nd sealed:', JSON.stringify(immediate), '(day =', '2026-10-22)');

control.close();
fixture.cleanup();
