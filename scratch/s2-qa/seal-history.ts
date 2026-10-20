/** F3 — can a historical seal ever verify once the chain has moved? */
import Database from 'better-sqlite3';

import { appendAudit, verifyAgainstSeal } from '../../app/audit/chain.ts';
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
const verify = (day: string): string => {
  const control = new Database(fixture.controlDb);
  const db = new Database(fixture.sitePath('acme'));
  try {
    const r = verifyAgainstSeal(db, control, 'acme', day);
    return `OK rows=${r.rows}`;
  } catch (err) {
    return `REFUSED ${String((err as { code?: string }).code)} / ${String((err as { message?: string }).message)}`;
  } finally {
    db.close();
    control.close();
  }
};

// Day 20: two rows, sealed on time at 00:00:05 on the 21st.
add('day20.a', Date.parse('2026-10-20T09:00:00Z'));
add('day20.b', Date.parse('2026-10-20T15:00:00Z'));
sealDay({ dataDir: fixture.dir, day: '2026-10-20', atMs: Date.parse('2026-10-21T00:00:05Z') });
console.log('verify 2026-10-20 immediately after its seal   :', verify('2026-10-20'));

// Day 21 traffic — the ordinary consequence of the next day existing.
add('day21.a', Date.parse('2026-10-21T03:00:00Z'));
console.log('verify 2026-10-20 after one row on the 21st    :', verify('2026-10-20'));

sealDay({ dataDir: fixture.dir, day: '2026-10-21', atMs: Date.parse('2026-10-22T00:00:05Z') });
console.log('verify 2026-10-21 immediately after its seal   :', verify('2026-10-21'));

add('day22.a', Date.parse('2026-10-22T03:00:00Z'));
console.log('verify 2026-10-21 after one row on the 22nd    :', verify('2026-10-21'));
console.log('verify 2026-10-20 the day after that           :', verify('2026-10-20'));

fixture.cleanup();
