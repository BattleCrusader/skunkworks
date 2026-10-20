/**
 * S3c — the mutation controls. A test that cannot fail is a comment, so each mechanism
 * this slice added is removed once and the gate that owns it is run:
 *
 *   M1  the insert-first gate            -> C1 and R1 must redden (uses = 8)
 *   M2  the MAC length check             -> R5 must redden (a 500 instead of a 401)
 *   M3  the `uses < max_uses` guard      -> R3 and R10 must redden (200 instead of 410)
 *   M4  the dummy verify                 -> the timing gate must redden (unknown selector fast)
 *   M5  the failure counter in the limiter -> R12 must redden (no 429)
 *   M6  the code/asset binding in `file()` -> R5b must redden (a forged `aid` is served)
 *
 * Every file is restored in a `finally`, and each file's sha256 is printed before and
 * after, so "restored" is a fact rather than an intention. Nothing is committed; it is a
 * proof run. `make test` never runs this file — `scratch/` is not in the suite.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const REPO = process.cwd();

function sha(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 12);
}

interface Mutation {
  name: string;
  file: string;
  from: string;
  to: string;
  tests: { file: string; pattern: string }[];
}

const MUTATIONS: Mutation[] = [
  {
    name: 'M1 — the counter moves whatever the gate did (update-before-insert, in effect)',
    file: join(REPO, 'app/download/ledger.ts'),
    from: '    if (inserted.changes === 1) {',
    to: '    if (inserted.changes >= 0) {',
    tests: [
      { file: 'test/download-consume.test.ts', pattern: 'C1' },
      { file: 'test/download-redeem.test.ts', pattern: 'R1 ' },
    ],
  },
  {
    name: 'M2 — the MAC length is not checked before timingSafeEqual',
    file: join(REPO, 'app/download/token.ts'),
    from: '  if (given.length !== MAC_BYTES) return { ok: false, reason: \'mac\' };',
    to: '  if (false as boolean) return { ok: false, reason: \'mac\' };',
    tests: [{ file: 'test/download-redeem.test.ts', pattern: 'R5 ' }],
  },
  {
    name: 'M3 — the UPDATE drops the quota guard',
    file: join(REPO, 'app/download/ledger.ts'),
    from: '              AND (max_uses IS NULL OR uses < max_uses)`',
    to: '              AND (max_uses IS NULL OR uses >= 0)`',
    tests: [
      { file: 'test/download-redeem.test.ts', pattern: 'R3 ' },
      { file: 'test/download-redeem.test.ts', pattern: 'R10 ' },
    ],
  },
  {
    name: 'M4 — an unknown selector skips the (dummy) argon2 verify',
    file: join(REPO, 'app/download/plane.ts'),
    from: '        matches = await this.#deps.argon.run(() => argonVerify(hashToTry, candidate));',
    to: '        matches = row === undefined ? false : await this.#deps.argon.run(() => argonVerify(hashToTry, candidate));',
    tests: [{ file: 'test/perf/download-timing.perf.test.ts', pattern: 'P-S3c-1' }],
  },
  {
    name: 'M5 — refusals no longer count toward the limiter',
    file: join(REPO, 'app/download/plane.ts'),
    from: '        this.#ipFailures.hit(iph, atMs);',
    to: '        void iph;',
    tests: [{ file: 'test/download-redeem.test.ts', pattern: 'R12' }],
  },
  {
    name: 'M6 — the token\'s `aid` is not checked against the code it was minted for',
    file: join(REPO, 'app/download/plane.ts'),
    from: '      if (row === undefined || asset === null || row.asset_id !== claims.aid) {',
    to: '      if (row === undefined || asset === null) {',
    tests: [{ file: 'test/download-redeem.test.ts', pattern: 'R5b' }],
  },
];

const results: string[] = [];
let failures = 0;
for (const mutation of MUTATIONS) {
  const original = readFileSync(mutation.file, 'utf8');
  const before = sha(mutation.file);
  if (!original.includes(mutation.from)) {
    results.push(`${mutation.name}: SKIPPED — the mutation target is not in ${mutation.file}`);
    failures += 1;
    continue;
  }
  try {
    writeFileSync(mutation.file, original.replace(mutation.from, mutation.to));
    for (const target of mutation.tests) {
      const run = spawnSync(
        process.execPath,
        ['--test', '--test-concurrency=1', '--test-timeout=180000', `--test-name-pattern=${target.pattern}`, target.file],
        { encoding: 'utf8' },
      );
      const failed = (run.stdout.match(/^not ok \d+ - (.+)$/gm) ?? []).map((line) =>
        line.replace(/^not ok \d+ - /, ''),
      );
      const passed = (run.stdout.match(/^ok \d+ - (.+)$/gm) ?? []).length;
      const red = failed.length > 0 || run.status !== 0;
      if (!red) failures += 1;
      results.push(
        `${mutation.name} -> ${target.file} (${target.pattern.trim()}): exit=${run.status} ` +
          `passed=${passed} failed=[${failed.join(' | ')}] ${red ? 'RED as intended' : 'STILL GREEN — the gate does not bite'}`,
      );
    }
  } finally {
    writeFileSync(mutation.file, original);
  }
  const after = sha(mutation.file);
  results.push(
    `${mutation.name}: file restored ${before === after ? 'IDENTICAL' : `CHANGED (${before} -> ${after})`}`,
  );
  if (before !== after) failures += 1;
}

process.stdout.write(`${results.join('\n')}\n`);
process.stdout.write(`\n${failures === 0 ? 'all mutations reddened the owning gate and every file is byte-identical' : `${failures} control(s) failed`}\n`);
process.exit(failures === 0 ? 0 : 1);
