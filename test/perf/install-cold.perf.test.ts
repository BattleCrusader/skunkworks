/**
 * `make test-perf` — **D30's five-minute promise, measured** (SDS §1.2, §11.6, §16 S4
 * "install on a clean host: ≤ 5 min with images present, `certificate: pending` allowed").
 *
 * The promise is *machine* time plus **one human step**: the operator scans the TOTP QR
 * code with an authenticator app. D30's whole point is that the docs admit the scan
 * instead of quietly omitting it, so this gate reports the two numbers separately and
 * asserts the sum:
 *
 *     machine  — `./install.sh --no-compose --verify-login` from an empty directory to a
 *                page fetched over the installer's own listener
 *     human    — one scan, a 20 s allowance (an allowance, not a measurement: this box has
 *                no human. It is the number an operator is told to expect, and the only
 *                honest way to include a human step in a machine gate)
 *
 * The number that matters to a customer is the sum, and the band is 300 s. The machine half
 * gets its own, tighter band (120 s) because a regression that doubles the install would
 * still pass 300 s while the promise quietly became ten minutes on a slower box.
 *
 * Why this is a `perf` test and not part of `make test`: it measures a wall clock (the same
 * reason `test/perf/login-timing.perf.test.ts` exists — `S2-qa.md` D12).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { REPO } from '../helpers/fixture.ts';
import { makeBundle } from '../helpers/bundle.ts';

/** §16 S4's band, in milliseconds. */
const PROMISE_MS = 300_000;
/** Machine-only band: half the promise, so a doubling is visible before it is fatal. */
const MACHINE_MS = 120_000;
/** One human TOTP scan. An allowance, stated as one (D30). */
const HUMAN_SCAN_MS = 20_000;

test('D30 — a cold install on an empty directory reaches a served page inside the five-minute promise', () => {
  const bundle = makeBundle();
  const host = mkdtempSync(join(tmpdir(), 'skw-cold-'));
  try {
    cpSync(bundle.dir, host, { recursive: true, verbatimSymlinks: true });

    const started = process.hrtime.bigint();
    const run = spawnSync(
      './install.sh',
      ['--no-compose', '--skip-dns', '--runtime', REPO, '--verify-login'],
      {
        cwd: host,
        env: { ...process.env, SKW_ENV_FILE: join(host, '.env') },
        encoding: 'utf8',
        timeout: PROMISE_MS,
      },
    );
    const machineMs = Number(process.hrtime.bigint() - started) / 1e6;

    assert.equal(run.status, 0, `${run.stderr}\n${run.stdout}`);
    assert.match(run.stdout, /install_check: GET \/ 200 /, 'the install proved a served page');

    const totalMs = machineMs + HUMAN_SCAN_MS;
    process.stdout.write(
      `install-cold: machine ${(machineMs / 1000).toFixed(1)} s` +
        ` + human ${(HUMAN_SCAN_MS / 1000).toFixed(0)} s (one TOTP scan, allowance)` +
        ` = ${(totalMs / 1000).toFixed(1)} s of ${(PROMISE_MS / 1000).toFixed(0)} s\n`,
    );

    assert.ok(machineMs < MACHINE_MS, `machine half took ${(machineMs / 1000).toFixed(1)} s (band ${MACHINE_MS / 1000} s)`);
    assert.ok(totalMs < PROMISE_MS, `install took ${(totalMs / 1000).toFixed(1)} s (promise ${PROMISE_MS / 1000} s)`);
  } finally {
    rmSync(host, { recursive: true, force: true });
    bundle.cleanup();
  }
});
