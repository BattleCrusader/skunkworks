/** F2 — a backfilled seal carries the file's *current* head, not the day's. */
import Database from 'better-sqlite3';

import { appendAudit, readSeal } from '../../app/audit/chain.ts';
import { sealDay } from '../../app/audit/scheduler.ts';
import { makeFixture } from '../../test/helpers/fixture.ts';

const fixture = makeFixture({ specs: [{ key: 'acme', hosts: ['acme.test'] }] });

const add = (what: string, at: number): void => {
  const db = new Database(fixture.sitePath('acme'));
  try {
    appendAudit(db, { userId: 1, label: 'qa' }, what, 'cms_page', '1', null, { n: what }, at);
  } finally {
    db.close();
  }
};

// Traffic on the 20th.
add('row.on.20', Date.parse('2026-10-20T10:00:00Z'));
// The 21st is never sealed (the process was down at midnight).
// Traffic on the 22nd, then somebody notices and backfills the 21st.
add('row.on.22', Date.parse('2026-10-22T10:00:00Z'));

const report = sealDay({ dataDir: fixture.dir, day: '2026-10-21', atMs: Date.parse('2026-10-22T12:00:00Z') });
console.log('backfilled seal for 2026-10-21:', JSON.stringify(report.tenants.map((r) => ({ key: r.key, rows: r.rows, created: r.created }))));

const control = new Database(fixture.controlDb);
const seal = readSeal(control, 'acme', '2026-10-21');
const db = new Database(fixture.sitePath('acme'));
const actual = db.prepare('SELECT count(*) AS n FROM cms_audit').get() as { n: number };
console.log('seal row:', JSON.stringify(seal));
console.log('actual rows in the file today:', actual.n);
console.log('sealed_at is after the day it covers?', seal !== undefined && seal.sealed_at > '2026-10-21T23:59:59Z');
db.close();

// And the day-20 seal, written on time, for comparison.
const onTime = sealDay({ dataDir: fixture.dir, day: '2026-10-20', atMs: Date.parse('2026-10-21T00:00:05Z') });
console.log('on-time seal for 2026-10-20:', JSON.stringify(onTime.tenants.map((r) => ({ key: r.key, rows: r.rows, created: r.created }))));
control.close();
fixture.cleanup();
