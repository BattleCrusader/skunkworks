/**
 * `make test-perf` — the **timing** half of §16's "the three login failure causes are
 * indistinguishable in status, body and time" (E-16).
 *
 * Why this file is not in `make test` (`S2-qa.md` D12): a median-over-60-samples ratio is a
 * wall-clock measurement, and a box under CPU contention moves it. The gate was red once in
 * five full runs at n=20 on this laptop (`scratch/s2d/e16-repeats.sh`: 3 of 12 repetitions
 * over the 1.20 band, p10..p90 spanning 23.8..43.9 ms inside one cause), which is a fact about
 * the box, not about the code. `make test` keeps the **structural** half of the same contract —
 * one status, one code, one byte-identical body per cause, and a TOTP-computation count that
 * depends on configuration only (`test/admin-auth.test.ts` cases 4 and 4b).
 *
 * What this gate adds, and what moving it costs: the structural twin cannot see an asymmetry in
 * work that the TOTP counter does not count — an unknown email that skips the argon2 verify
 * entirely is invisible to a counter and visible here, in the medians. So this is the only
 * witness for "the password step costs the same whether or not the user exists", and it must be
 * run on an idle box (`make test-perf` says so before it starts).
 *
 * Idle baseline (this laptop, 2026-10-20, `make test-perf`, 1-min load average 5.08 on 8 cpus —
 * i.e. a *warning* run, not a quiet one): medians 10.96 / 10.69 / 11.05 ms, ratio **1.033**.
 * The band is 1.20. A ratio near the band is a real asymmetry; a ratio that only crosses it on a
 * box with load above the core count is the box, and the preflight says so before it runs.
 */
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { after, before, test } from 'node:test';

import { loadEnv } from '../../app/env.ts';
import { buildApp, type AppHandle } from '../../app/main.ts';
import {
  TOTP_SECRET,
  codeOf,
  login,
  median,
  percentile,
  scrubBody,
  seedUser,
} from '../helpers/admin.ts';
import { makeFixture, type Fixture } from '../helpers/fixture.ts';

const OWNER = 'owner@acme.test';
const TIMING = 'timing@acme.test';
const TOTP_ONLY = 'totp-required@acme.test';
const MISSING = 'nobody@acme.test';

/** The band E-16 fixes. A ratio above it is either a real asymmetry or a busy box. */
const BAND = 1.2;
/** E-16's floor is 40 samples per cause; every round measures A, B and C back to back. */
const ITERATIONS = 60;

let fixture: Fixture;
let handle: AppHandle;
let port = 0;

before(async () => {
  fixture = makeFixture();
  await seedUser({ controlDb: fixture.controlDb, tenantKey: 'acme', email: OWNER, totpSecret: TOTP_SECRET });
  await seedUser({ controlDb: fixture.controlDb, tenantKey: 'acme', email: TIMING, totpSecret: TOTP_SECRET });
  await seedUser({ controlDb: fixture.controlDb, tenantKey: 'acme', email: TOTP_ONLY, totpSecret: TOTP_SECRET });
  handle = await buildApp({ env: loadEnv(fixture.env) });
  await handle.app.listen({ port: 0, host: '127.0.0.1' });
  const address = handle.app.server.address();
  port = typeof address === 'object' && address !== null ? address.port : 0;
});

after(async () => {
  await handle.close();
  fixture.cleanup();
});

test('P-4. three login failure causes are indistinguishable in time on an idle box', async () => {
  // The lockout rule is measured in `test/admin-auth.test.ts` case 5; here it would turn the
  // 6th sample into a 429 and hide the timing. Each sample resets the counter, which is the
  // only thing this test touches outside the HTTP surface.
  const reset = new Database(fixture.controlDb);
  const clearFailures = reset.prepare('UPDATE user_account SET failed_logins = 0, locked_until = NULL WHERE email = ?');
  // Warm the verifier so the first sample is not the library's cold start.
  for (let i = 0; i < 3; i += 1) {
    await login({ port, key: 'acme', email: TIMING, password: 'warm-up-wrong' });
    await login({ port, key: 'acme', email: MISSING, password: 'warm-up-wrong' });
    await login({ port, key: 'acme', email: TOTP_ONLY, totp: '000000' });
    clearFailures.run(TIMING);
    clearFailures.run(TOTP_ONLY);
  }

  const wrongPassword: number[] = [];
  const noSuchUser: number[] = [];
  const wrongTotp: number[] = [];
  let wrongRes: Awaited<ReturnType<typeof login>> | null = null;
  let missingRes: Awaited<ReturnType<typeof login>> | null = null;
  let totpRes: Awaited<ReturnType<typeof login>> | null = null;

  try {
    for (let i = 0; i < ITERATIONS; i += 1) {
      // One round: the three causes, adjacent, in the same order every time, so a load phase
      // that slows the box cannot land on one cause's block.
      const t0 = process.hrtime.bigint();
      const a = await login({ port, key: 'acme', email: TIMING, password: `wrong-${i}` });
      wrongPassword.push(Number(process.hrtime.bigint() - t0) / 1e6);
      clearFailures.run(TIMING);

      const t1 = process.hrtime.bigint();
      const b = await login({ port, key: 'acme', email: MISSING, password: `wrong-${i}` });
      noSuchUser.push(Number(process.hrtime.bigint() - t1) / 1e6);

      const t2 = process.hrtime.bigint();
      const c = await login({ port, key: 'acme', email: TOTP_ONLY, totp: '000000' });
      wrongTotp.push(Number(process.hrtime.bigint() - t2) / 1e6);
      clearFailures.run(TOTP_ONLY);

      if (i === 0) {
        wrongRes = a;
        missingRes = b;
        totpRes = c;
      }
    }
  } finally {
    reset.close();
  }

  // The structural half is asserted here too, so this file is a gate on its own when it is the
  // only one run: a timing gate that measured three different responses would be measuring
  // nothing that matters.
  for (const [name, res] of [['wrong password', wrongRes], ['unknown email', missingRes], ['wrong totp', totpRes]] as const) {
    assert.equal(res?.status, 401, name);
    assert.equal(codeOf(res!), 'SKW_E_SEC_AUTH_INVALID', `${name} must carry the E-16 code`);
  }
  const scrubbed = [wrongRes!, missingRes!, totpRes!].map((r) => scrubBody(r));
  assert.equal(scrubbed[0], scrubbed[1], 'wrong password vs unknown email');
  assert.equal(scrubbed[0], scrubbed[2], 'wrong password vs wrong TOTP');

  const medians = {
    wrong_password: median(wrongPassword),
    unknown_email: median(noSuchUser),
    wrong_totp: median(wrongTotp),
  };
  const values = Object.values(medians);
  const ratio = Math.max(...values) / Math.min(...values);
  const shape = (label: string, samples: number[]): string =>
    `${label} median=${median(samples).toFixed(2)} p10=${percentile(samples, 10).toFixed(2)} p90=${percentile(samples, 90).toFixed(2)}`;
  // Printed, not asserted: the numbers are the record for the next reader, and a machine that
  // is simply slower moves all three together.
  process.stdout.write(
    `P-4 medians ${JSON.stringify(medians)} ratio ${ratio.toFixed(3)} | ${shape('wrong_password', wrongPassword)} | ` +
      `${shape('unknown_email', noSuchUser)} | ${shape('wrong_totp', wrongTotp)}\n`,
  );
  assert.ok(
    ratio <= BAND,
    `medians across the three causes must be within ${(BAND - 1) * 100}%: ${JSON.stringify(medians)} (ratio ${ratio.toFixed(3)}); ` +
      `n=${ITERATIONS} each, interleaved; ${shape('wrong_password', wrongPassword)} | ` +
      `${shape('unknown_email', noSuchUser)} | ${shape('wrong_totp', wrongTotp)}. ` +
      'If this box was not idle, re-run: this gate measures the box as well as the code.',
  );
});
