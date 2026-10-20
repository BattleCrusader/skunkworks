/**
 * M6 probe — reproduce `S2-qa.md` §6/§10 in this tree, before the fix.
 *
 * A tenant with audit rows on D-4, D-3 and D-1, sealed on D-1 only, is asked through the
 * same function the health route calls. The gap three days back must be in `unsealed`.
 */
import Database from 'better-sqlite3';

import { addUtcDays, appendAudit, utcDay } from '../../app/audit/chain.ts';
import { sealDay, sealStatus, sealSummary } from '../../app/audit/scheduler.ts';
import { makeFixture } from '../../test/helpers/fixture.ts';

const TODAY = utcDay();
const D1 = addUtcDays(TODAY, -1);
const D3 = addUtcDays(TODAY, -3);
const D4 = addUtcDays(TODAY, -4);
const ACTOR = { userId: 1, label: 'probe' };

const fixture = makeFixture({ specs: [{ key: 'acme', hosts: ['acme.test'] }] });
try {
  const add = (day: string): void => {
    const db = new Database(fixture.sitePath('acme'));
    try {
      appendAudit(db, ACTOR, 'page.publish', 'cms_page', '/pricing', null, { day }, Date.parse(`${day}T01:00:00Z`));
    } finally {
      db.close();
    }
  };
  add(D4);
  add(D3);
  add(D1);
  const sealed = sealDay({ dataDir: fixture.dir, day: D1, tenant: 'acme' });
  console.log('seal D-1            ', JSON.stringify(sealed.tenants[0]?.status));
  console.log('health (sealSummary)', JSON.stringify(sealSummary(fixture.dir, 'acme')));
  console.log('status  days=5      ', JSON.stringify(sealStatus({ dataDir: fixture.dir, tenantKey: 'acme', days: 5 }).unsealed));
} finally {
  fixture.cleanup();
}
