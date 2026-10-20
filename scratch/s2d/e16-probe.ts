/**
 * ITEM 0's measurement probe: what the three login-failure causes actually cost.
 *
 * The E-16 gate compares medians under a 20 % band. Before changing it, measure the
 * three causes interleaved (A,B,C,A,B,C …) so drift cannot load one block, and print
 * the distribution, not just the median: a gate that fails 1 run in 5 is a gate whose
 * statistic is unstable, and the fix has to name which half.
 *
 *   node scratch/s2d/e16-probe.ts [n]
 *
 * Prints, per cause: median, p10, p90, and the ratio of the max median to the min.
 * Also prints the same three sequences measured *sequentially* (all A, then all B,
 * then all C) so the drift the S2c report saw is visible in the same run.
 */
import Database from 'better-sqlite3';

import { loadEnv } from '../../app/env.ts';
import { buildApp, type AppHandle } from '../../app/main.ts';
import { login, median, seedUser, TOTP_SECRET } from '../../test/helpers/admin.ts';
import { makeFixture } from '../../test/helpers/fixture.ts';

const N = Number(process.argv[2] ?? '100');
const TIMING = 'timing@acme.test';
const TOTP_ONLY = 'totp-required@acme.test';
const MISSING = 'nobody@acme.test';

function pct(samples: number[], p: number): number {
  const s = [...samples].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))));
  return s[i] as number;
}

function summary(name: string, samples: number[]): string {
  return `${name.padEnd(15)} n=${String(samples.length).padStart(3)} median=${median(samples).toFixed(2).padStart(7)} ms  p10=${pct(samples, 10).toFixed(2).padStart(7)}  p90=${pct(samples, 90).toFixed(2).padStart(7)}  min=${Math.min(...samples).toFixed(2)}  max=${Math.max(...samples).toFixed(2)}`;
}

function ratioOf(a: number, b: number, c: number): number {
  return Math.max(a, b, c) / Math.min(a, b, c);
}

const fixture = makeFixture();
await seedUser({ controlDb: fixture.controlDb, tenantKey: 'acme', email: TIMING, totpSecret: TOTP_SECRET });
await seedUser({ controlDb: fixture.controlDb, tenantKey: 'acme', email: TOTP_ONLY, totpSecret: TOTP_SECRET });
const handle: AppHandle = await buildApp({ env: loadEnv(fixture.env) });
await handle.app.listen({ port: 0, host: '127.0.0.1' });
const address = handle.app.server.address();
const port = typeof address === 'object' && address !== null ? address.port : 0;

const reset = new Database(fixture.controlDb);
const clearFailures = reset.prepare('UPDATE user_account SET failed_logins = 0, locked_until = NULL WHERE email = ?');

// warm the verifier and the connection cache
for (let i = 0; i < 5; i += 1) {
  await login({ port, email: TIMING, password: 'warm' });
  await login({ port, email: MISSING, password: 'warm' });
  await login({ port, email: TOTP_ONLY, totp: '000000' });
  clearFailures.run(TIMING);
  clearFailures.run(TOTP_ONLY);
}

async function timed(fn: () => Promise<unknown>): Promise<number> {
  const t0 = process.hrtime.bigint();
  await fn();
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

const a = (i: number) => async () => {
  await login({ port, email: TIMING, password: `wrong-${i}` });
  clearFailures.run(TIMING);
};
const b = (i: number) => async () => {
  await login({ port, email: MISSING, password: `wrong-${i}` });
};
const c = (i: number) => async () => {
  await login({ port, email: TOTP_ONLY, totp: '000000' });
  clearFailures.run(TOTP_ONLY);
};

// --- interleaved: one triplet per round
const ia: number[] = [];
const ib: number[] = [];
const ic: number[] = [];
for (let i = 0; i < N; i += 1) {
  ia.push(await timed(a(i)));
  ib.push(await timed(b(i)));
  ic.push(await timed(c(i)));
}
console.log('--- interleaved (A,B,C per round) ---');
console.log(summary('wrong_password', ia));
console.log(summary('unknown_email', ib));
console.log(summary('wrong_totp', ic));
console.log(
  `ratio of medians = ${ratioOf(median(ia), median(ib), median(ic)).toFixed(3)}` +
    `   (band 1.200)`,
);
console.log(
  `A-C delta = ${(median(ia) - median(ic)).toFixed(2)} ms;  A-B delta = ${(median(ia) - median(ib)).toFixed(2)} ms`,
);

// --- sequential: the shape the S2c report blamed for the flake
const sa: number[] = [];
const sb: number[] = [];
const sc: number[] = [];
for (let i = 0; i < N; i += 1) sa.push(await timed(a(i)));
for (let i = 0; i < N; i += 1) sb.push(await timed(b(i)));
for (let i = 0; i < N; i += 1) sc.push(await timed(c(i)));
console.log('--- sequential blocks (all A, then B, then C) ---');
console.log(summary('wrong_password', sa));
console.log(summary('unknown_email', sb));
console.log(summary('wrong_totp', sc));
console.log(
  `ratio of medians = ${ratioOf(median(sa), median(sb), median(sc)).toFixed(3)}` +
    `   (band 1.200)`,
);

reset.close();
await handle.close();
fixture.cleanup();
