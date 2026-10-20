/**
 * The cost of the health field at its bound: a tenant with an audit row on **every** day of the
 * 400-day lookback and no seals at all — the worst case for `sealSummary`, because every day is
 * unsealed and every day needs a `count(*)`.
 */
import Database from 'better-sqlite3';

import { addUtcDays, appendAudit, utcDay } from '../../app/audit/chain.ts';
import { SEAL_HEALTH_LOOKBACK_DAYS, sealSummary } from '../../app/audit/scheduler.ts';
import { makeFixture } from '../../test/helpers/fixture.ts';

const TODAY = utcDay();
const ACTOR = { userId: 1, label: 'probe' };

const fixture = makeFixture({ specs: [{ key: 'acme', hosts: ['acme.test'] }] });
try {
  const db = new Database(fixture.sitePath('acme'));
  try {
    for (let i = 1; i <= SEAL_HEALTH_LOOKBACK_DAYS; i += 1) {
      const day = addUtcDays(TODAY, -i);
      appendAudit(db, ACTOR, 'page.publish', 'cms_page', '/pricing', null, { day }, Date.parse(`${day}T01:00:00Z`));
    }
  } finally {
    db.close();
  }
  const started = performance.now();
  const summary = sealSummary(fixture.dir, 'acme');
  const took = performance.now() - started;
  console.log(`rows on ${SEAL_HEALTH_LOOKBACK_DAYS} distinct days, none sealed`);
  console.log(`unsealed days reported: ${summary.unsealed.length}`);
  console.log(`sealSummary: ${took.toFixed(1)} ms`);
} finally {
  fixture.cleanup();
}
