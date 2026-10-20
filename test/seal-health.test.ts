/**
 * M6 (`S2-qa.md` §6, §10) — the seal-health field reports every day that should have been
 * sealed and was not, not only the last one.
 *
 * The defect was one argument: `sealSummary` called `sealStatus({days: 1})`, so `"unsealed"`
 * was structurally at most yesterday, and `02-errata.md` §8 E-20(d)'s own example
 * (`unsealed: ["2026-10-18"]` under `last_sealed_day: "2026-10-20"`) was unreachable. An
 * operator watching `/admin/api/tenants/<key>/health` therefore saw a green series over a day
 * that was never anchored — the control's *report* disagreeing with its *verdict*.
 *
 * What this file gates:
 *
 *   - `M6-1` the library field names **every** unsealed day with rows inside the lookback,
 *     oldest first, and does not name a day that has no rows (nothing to anchor);
 *   - `M6-2` the HTTP health payload carries the same list, with its `cache_seconds`;
 *   - `M6-3` `skwctl audit status` prints the same days as `UNSEALED` and exits 1;
 *   - `M6-4` the days clear from both surfaces once they are sealed — the field is a verdict,
 *     not a latch;
 *   - `M6-5` the lookback is **bounded**, and the bound is stated and asserted rather than
 *     discovered: `SEAL_HEALTH_LOOKBACK_DAYS` is the widest window `skwctl audit status
 *     --days` accepts, so the field and the CLI cannot disagree about which days exist.
 *
 * Days are relative to the real clock because the health route reads `Date.now()`; the library
 * call takes the same instant explicitly, so the two cannot drift apart inside a run.
 */
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { addUtcDays, appendAudit, utcDay } from '../app/audit/chain.ts';
import { SEAL_HEALTH_LOOKBACK_DAYS, sealDay, sealSummary } from '../app/audit/scheduler.ts';
import { loadEnv } from '../app/env.ts';
import { buildApp, type AppHandle } from '../app/main.ts';
import { ADMIN_HOST, openSession, seedUser, TOTP_SECRET } from './helpers/admin.ts';
import { makeFixture, REPO, type Fixture } from './helpers/fixture.ts';
import { call } from './helpers/http.ts';

const CLI = join(REPO, 'app', 'cli', 'skwctl.ts');
const ACTOR = { userId: 1, label: 'gate' };

const TODAY = utcDay();
const D1 = addUtcDays(TODAY, -1);
const D2 = addUtcDays(TODAY, -2);
const D3 = addUtcDays(TODAY, -3);
const D4 = addUtcDays(TODAY, -4);

let fixture: Fixture;
let handle: AppHandle;
let port = 0;

before(async () => {
  fixture = makeFixture({
    specs: [
      { key: 'acme', hosts: ['acme.test'] },
      // A tenant whose only audit row is older than the health field's lookback.
      { key: 'epsilon', hosts: ['epsilon.test'] },
    ],
  });
  const add = (key: string, day: string, rows: number): void => {
    const db = new Database(fixture.sitePath(key));
    try {
      for (let i = 0; i < rows; i += 1) {
        appendAudit(db, ACTOR, 'page.publish', 'cms_page', `/p${i}`, null, { day }, Date.parse(`${day}T01:00:00Z`));
      }
    } finally {
      db.close();
    }
  };
  // acme: rows on four past days, so "every unsealed day" is three days, not one. D1 is sealed
  // on time (a seal written today covers yesterday); D2..D4 are the gap QA's report describes.
  add('acme', D4, 2);
  add('acme', D3, 1);
  add('acme', D2, 1);
  add('acme', D1, 1);
  const sealed = sealDay({ dataDir: fixture.dir, day: D1, tenant: 'acme' });
  assert.equal(sealed.tenants[0]?.status, 'sealed', JSON.stringify(sealed.tenants[0]));

  add('epsilon', addUtcDays(TODAY, -401), 1);

  await seedUser({ controlDb: fixture.controlDb, tenantKey: 'acme', email: 'owner@acme.test', totpSecret: TOTP_SECRET });
  handle = await buildApp({ env: loadEnv(fixture.env) });
  await handle.app.listen({ port: 0, host: '127.0.0.1' });
  const address = handle.app.server.address();
  port = typeof address === 'object' && address !== null ? address.port : 0;
});

after(async () => {
  await handle.close();
  fixture.cleanup();
});

function skwctl(args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    cwd: REPO,
    env: { ...fixture.env },
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

test('M6-1. the health field names every unsealed day with rows, not only yesterday', () => {
  const summary = sealSummary(fixture.dir, 'acme');
  assert.equal(summary.last_sealed_day, D1, 'yesterday is the last sealed day');
  assert.deepEqual(
    summary.unsealed,
    [D4, D3, D2],
    `every day that should have been sealed and was not, oldest first; got ${JSON.stringify(summary.unsealed)}`,
  );
  assert.equal(summary.late_days, 0);

  // A day with no rows needs no seal and is not "unsealed": the field is a verdict about
  // days that have something to anchor.
  assert.equal(summary.unsealed.includes(addUtcDays(D4, -1)), false, 'a day before the first audit row is not unsealed');
});

test('M6-2. the same list is in the HTTP health payload the operator polls', async () => {
  const session = await openSession({ port, key: 'acme', email: 'owner@acme.test' });
  const res = await call({
    port,
    path: '/admin/api/tenants/acme/health',
    host: ADMIN_HOST,
    headers: { cookie: session.cookie },
  });
  assert.equal(res.status, 200, res.body);
  const payload = res.json as { seal: { last_sealed_day: string | null; unsealed: string[]; late_days: number }; cache_seconds: number };
  assert.equal(payload.seal.last_sealed_day, D1);
  assert.deepEqual(payload.seal.unsealed, [D4, D3, D2], `health payload: ${JSON.stringify(payload.seal)}`);
  assert.equal(payload.seal.late_days, 0);
  // The staleness window is part of the contract, so a fresh seal is visible within it.
  assert.equal(payload.cache_seconds, 30);
});

test('M6-3. `skwctl audit status` prints the same days as UNSEALED and exits 1', () => {
  const status = skwctl(['audit', 'status', '--tenant', 'acme', '--days', '5']);
  assert.equal(status.status, 1, `an UNSEALED day must make status exit 1:\n${status.stdout}`);
  for (const day of [D4, D3, D2]) {
    assert.match(status.stdout, new RegExp(`^${day} UNSEALED +\\d+ rows on that day; no seal$`, 'm'), day);
  }
  assert.match(status.stdout, new RegExp(`^${D1} sealed +`, 'm'));
});

test('M6-4. sealing the days clears them from the health field and from the CLI', () => {
  const healed = skwctl(['audit', 'seal', '--heal', '--tenant', 'acme']);
  assert.equal(healed.status, 0, healed.stderr);
  for (const day of [D4, D3, D2]) assert.match(healed.stdout, new RegExp(`day=${day} rows_in_day=\\d+ late=yes`), day);

  const summary = sealSummary(fixture.dir, 'acme');
  assert.deepEqual(summary.unsealed, [], `a sealed day is not unsealed; got ${JSON.stringify(summary.unsealed)}`);
  assert.equal(summary.last_sealed_day, D1);
  assert.equal(summary.late_days, 3, 'the three backfilled days are late, and the field says so');

  const status = skwctl(['audit', 'status', '--tenant', 'acme', '--days', '5']);
  assert.equal(status.status, 0, `with every day anchored status must exit 0:\n${status.stdout}`);
  assert.doesNotMatch(status.stdout, /UNSEALED/);
});

test('M6-5. the lookback is bounded, stated, and the same window the CLI can print', () => {
  // The bound is not an accident of the loop: it is a constant with a reason (a dashboard
  // polls this from a 30 s cache, so the scan cannot grow with the age of the tenant), and it
  // is exactly `skwctl audit status --days`'s upper limit so the two surfaces agree.
  assert.equal(SEAL_HEALTH_LOOKBACK_DAYS, 400, 'the health window is the CLI window, not a second number');
  const cli = skwctl(['audit', 'status', '--tenant', 'epsilon', '--days', '400']);
  // Neither surface prints a day older than the bound: the CLI's own `--days` ceiling is 400,
  // so the 401-day-old row is outside *both*. That is the trade the bound makes, stated rather
  // than hidden — the old `days: 1` was 400× narrower than the surface that already existed.
  assert.equal(cli.status, 0, cli.stdout);
  assert.doesNotMatch(cli.stdout, /UNSEALED/);

  // And the field says the same thing for the same reason — outside the bound is outside the
  // field, by design, and it is the CLI's `--days` that widens it, not a silently longer scan.
  const summary = sealSummary(fixture.dir, 'epsilon');
  assert.deepEqual(summary.unsealed, [], 'a gap older than the documented lookback is not in the field');
  assert.equal(summary.last_sealed_day, null);
});
