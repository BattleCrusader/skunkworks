/**
 * The gate on the gate (G3, `docs/build/S1-qa.md` §7).
 *
 * `SKW_SKIP_DOCKER=1 make verify-s1` used to exit 0 with twelve skipped tests, so
 * every real-nginx gate could be bought off with an environment variable. The
 * runner now enforces E-15's rule — *a skip is a failure* — and this test proves
 * the enforcement itself, on synthetic suites in a temp directory, so it cannot
 * be satisfied by the repo's own tests happening to not skip.
 *
 * Three cases, each a spawn of the real `scripts/run-node-tests.mjs`:
 *   (a) a clean suite is green, and the runner prints no banner;
 *   (b) a suite with one skipped test is red without the escape, and the message
 *       names the skipped test;
 *   (c) with `SKW_ALLOW_SKIP=1` the same suite exits 0 and the banner says, in
 *       words, that the run is not a gate.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { REPO } from './helpers/fixture.ts';

const RUNNER = join(REPO, 'scripts', 'run-node-tests.mjs');

interface Run {
  status: number;
  stdout: string;
  stderr: string;
}

function runRunner(file: string, env: Record<string, string> = {}): Run {
  const clean: NodeJS.ProcessEnv = { ...process.env };
  delete clean.SKW_ALLOW_SKIP;
  delete clean.SKW_SKIP_DOCKER;
  const result = spawnSync(process.execPath, [RUNNER, file], {
    cwd: REPO,
    encoding: 'utf8',
    env: { ...clean, ...env },
    timeout: 60_000,
  });
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function suite(dir: string, name: string, body: string): string {
  const file = join(dir, name);
  writeFileSync(file, `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\n${body}`);
  return file;
}

const dir = mkdtempSync(join(tmpdir(), 'skw-g3-'));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));

const CLEAN = suite(
  dir,
  'clean.test.mjs',
  `test('this gate ran', () => { assert.equal(1, 1); });\n`,
);

const SKIPS = suite(
  dir,
  'skips.test.mjs',
  `test('this gate ran', () => { assert.equal(1, 1); });\n` +
    `test('the real-nginx gate nobody exercised', { skip: true }, () => { assert.equal(1, 1); });\n`,
);

const FAILS = suite(
  dir,
  'fails.test.mjs',
  `test('this gate fails', () => { assert.equal(1, 2); });\n`,
);

test('(a) a suite with no skip exits 0 and prints no banner', () => {
  const run = runRunner(CLEAN);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^# skipped 0$/m, 'the summary must say 0 skipped');
  assert.doesNotMatch(run.stderr, /THIS RUN IS NOT A GATE/);
});

test('(b) one skipped test is a red gate, and the failure names it', () => {
  const run = runRunner(SKIPS);
  assert.equal(run.status, 1, 'a skip without the escape must not exit 0');
  assert.match(run.stderr, /SKIPPED TESTS ARE A FAILURE \(E-15\): 1 of 2 did not run/);
  assert.match(run.stderr, /skipped: the real-nginx gate nobody exercised/);
  assert.match(run.stderr, /refusing to report a green gate over skipped tests/);
});

test('(b2) SKW_SKIP_DOCKER=1 alone is not an escape, and the message says what it hid', () => {
  const run = runRunner(SKIPS, { SKW_SKIP_DOCKER: '1' });
  assert.equal(run.status, 1, 'the docker convenience flag must not buy a green gate');
  assert.match(run.stderr, /SKW_SKIP_DOCKER=1 was set: the real-nginx gates were not exercised/);
});

test('(c) SKW_ALLOW_SKIP=1 is the only escape, and it prints that the run is not a gate', () => {
  const run = runRunner(SKIPS, { SKW_ALLOW_SKIP: '1' });
  assert.equal(run.status, 0, 'the named, single-purpose escape must let a human run a partial suite');
  assert.match(run.stderr, /GATES SKIPPED — THIS RUN IS NOT A GATE \(1 of 2\)/);
  assert.match(run.stderr, /SKW_ALLOW_SKIP=1 was set deliberately/);
  assert.match(run.stderr, /1\/1 executed tests passed, 1 skipped/);
});

test('(d) a failing test is still red, and the escape does not launder it', () => {
  const plain = runRunner(FAILS);
  assert.equal(plain.status, 1);
  const escaped = runRunner(FAILS, { SKW_ALLOW_SKIP: '1' });
  assert.equal(escaped.status, 1, 'SKW_ALLOW_SKIP covers skips, never failures');
});

test('(e) the Makefile never sets the escape', () => {
  const makefile = readFileSync(join(REPO, 'Makefile'), 'utf8');
  // A comment cannot set a variable, so only recipe and assignment lines count.
  const effective = makefile
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'));
  for (const line of effective) {
    assert.doesNotMatch(line, /SKW_ALLOW_SKIP=1/, `the Makefile must not pass the escape: ${line}`);
  }
});
