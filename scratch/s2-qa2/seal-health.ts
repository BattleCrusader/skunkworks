/**
 * QA round 2 — is a missed day *visible*, as E-20 rule (c) and §9.6a(d) promise?
 *
 *   node scratch/s2-qa2/seal-health.ts
 *
 * The errata's own example is `{"last_sealed_day": "2026-10-20", "unsealed": ["2026-10-18"],
 * "late_days": 1}` — a gap two days older than the last sealed day. This probe builds exactly that
 * shape on real files and reads the payload the admin health route returns (`sealSummary`), then the
 * CLI's wider window beside it.
 */
import Database from 'better-sqlite3';

import { appendAudit } from '../../app/audit/chain.ts';
import { sealNow } from '../../app/audit/chain.ts';
import { sealStatus, sealSummary } from '../../app/audit/scheduler.ts';
import { makeFixture } from '../../test/helpers/fixture.ts';

const ACTOR = { userId: 1, label: 'qa2' };

function day(off: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + off);
  return d.toISOString().slice(0, 10);
}

const GAP = day(-4); // rows here, never sealed
const LAST = day(-1); // sealed on time today
const fixture = makeFixture({ specs: [{ key: 'acme', hosts: ['acme.test'] }] });

function add(d: string, what: string): void {
  const db = new Database(fixture.sitePath('acme'));
  try {
    appendAudit(db, ACTOR, what, 'cms_page', '/x', null, { what }, Date.parse(`${d}T06:00:00.000Z`));
  } finally {
    db.close();
  }
}
add(GAP, 'page.gap.one');
add(GAP, 'page.gap.two');
add(LAST, 'page.last.one');

{
  const site = new Database(fixture.sitePath('acme'));
  const control = new Database(fixture.controlDb);
  try {
    const r = sealNow(site, control, 'acme', LAST, Date.parse(`${day(0)}T00:00:05Z`));
    console.log(`sealed ${LAST}: status=${r.status}`);
  } finally {
    site.close();
    control.close();
  }
}

console.log(`\ngap day ${GAP} (2 rows, never sealed); last sealed day ${LAST}`);
console.log('health payload (sealSummary, the admin health field):');
console.log('  ' + JSON.stringify(sealSummary(fixture.dir, 'acme')));
console.log('errata example shape:  {"last_sealed_day":"<last>","unsealed":["<gap>"],"late_days":1}');
console.log('\nsealStatus windows:');
for (const days of [1, 2, 5, 10]) {
  const r = sealStatus({ dataDir: fixture.dir, tenantKey: 'acme', days });
  console.log(
    `  days=${String(days).padEnd(2)} unsealed=${JSON.stringify(r.unsealed)} late_days=${r.late_days} days=${r.days.map((d) => `${d.day}:${d.state}`).join(' ')}`,
  );
}
fixture.cleanup();
