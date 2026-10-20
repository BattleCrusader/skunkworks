#!/usr/bin/env node
/**
 * The node-side gate runner. E-15's rule, applied to `node --test`:
 *
 *   "A skip is a failure in verify_claims.py unless the gate was invoked with
 *    --allow-skip, and the Makefile never passes it."
 *
 * G3 (`docs/build/S1-qa.md` §7): the same rule did not exist on the node side,
 * so `SKW_SKIP_DOCKER=1 make verify-s1` exited 0 with twelve skipped tests —
 * every real-nginx gate, i.e. E-1(b), E-5, E-11, E-12 and E-13 — and the run
 * still read as a pass. A convenience flag must never be able to buy a green
 * gate.
 *
 * Behaviour:
 *   - runs `node --test --test-concurrency=1 --test-timeout=<ms> <files>`,
 *     streaming the child's output unchanged;
 *   - `--timeout=<ms>` sets that budget (default 15000). `make test` passes the
 *     value derived from the measured worst-case idle file runtime and states the
 *     derivation beside it; `make test-perf` passes its own, larger one;
 *   - fails when the TAP summary says any test was skipped or cancelled, or
 *     when there is no summary at all;
 *   - the only escape is `SKW_ALLOW_SKIP=1`, which is single-purpose, must be
 *     set by name, is never set by the Makefile, and prints a banner that
 *     cannot be mistaken for a gate result;
 *   - exits with the child's status otherwise, so a red test stays red.
 *
 * The timeout lives here rather than in the Makefile so that there is exactly one
 * way the suite is invoked (E-8: a gate that regresses into a wait is red with a
 * named failure instead of a CI job timeout).
 */
import { spawn } from 'node:child_process';

/** `--timeout=<ms>` is the only flag; everything else is a test file. */
let timeoutMs = 15_000;
const files = [];
for (const arg of process.argv.slice(2)) {
  const flag = /^--timeout=(\d+)$/.exec(arg);
  if (flag !== null) {
    timeoutMs = Number(flag[1]);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000) {
      process.stderr.write(`run-node-tests: --timeout must be an integer >= 1000, got ${JSON.stringify(flag[1])}\n`);
      process.exit(2);
    }
    continue;
  }
  files.push(arg);
}

if (files.length === 0) {
  process.stderr.write('run-node-tests: no test files given\n');
  process.exit(2);
}

const ALLOW = process.env.SKW_ALLOW_SKIP === '1';
const DOCKER_FLAG = process.env.SKW_SKIP_DOCKER === '1';

// `NODE_TEST_CONTEXT` is set when this process is itself running under
// `node --test` (which is what test/gate-runner.test.ts does). Inherited, it makes
// the child runner treat itself as a subtest of the parent and skip every file —
// producing a vacuous green with no TAP summary. The runner must always start a
// real, independent run.
const childEnv = { ...process.env };
delete childEnv.NODE_TEST_CONTEXT;
delete childEnv.NODE_TEST_FILTER;

const child = spawn(
  process.execPath,
  // `--test-reporter=tap` is explicit: node 22 defaults to TAP when stdout is a
  // pipe, but node 26 defaults to the `spec` reporter (`ℹ tests 2`, not `# tests 2`),
  // and a summary this process cannot read would look like "the child produced
  // nothing" on half the machines that run the gate.
  ['--test', '--test-reporter=tap', '--test-concurrency=1', `--test-timeout=${timeoutMs}`, ...files],
  { stdio: ['ignore', 'pipe', 'pipe'], env: childEnv },
);

let out = '';
child.stdout.on('data', (chunk) => {
  out += String(chunk);
  process.stdout.write(chunk);
});
child.stderr.on('data', (chunk) => {
  out += String(chunk);
  process.stderr.write(chunk);
});

/** The last `# <key> <n>` in the TAP summary; null when the summary is absent. */
function summary(key) {
  const re = new RegExp(`^# ${key} (\\d+)$`, 'gm');
  let value = null;
  let match;
  while ((match = re.exec(out)) !== null) value = Number(match[1]);
  return value;
}

/** Every test line the runner marked skipped, so the failure can name them. */
function skippedNames() {
  const names = [];
  const re = /^(?:not )?ok \d+ - (.+?)(?: # SKIP.*)?$/gm;
  let match;
  while ((match = re.exec(out)) !== null) {
    const line = match[0];
    if (line.includes('# SKIP')) names.push(match[1]);
  }
  return names;
}

function banner(lines) {
  const width = 74;
  const rule = '!'.repeat(width);
  process.stderr.write(`\n${rule}\n`);
  for (const line of lines) {
    const text = line.length > width - 6 ? `${line.slice(0, width - 9)}...` : line;
    process.stderr.write(`!!!  ${text.padEnd(width - 6)}  !!!\n`);
  }
  process.stderr.write(`${rule}\n\n`);
}

child.on('error', (err) => {
  process.stderr.write(`run-node-tests: cannot start the test runner: ${String(err)}\n`);
  process.exit(1);
});

child.on('close', (code, signal) => {
  const tests = summary('tests');
  const skipped = summary('skipped') ?? 0;
  const cancelled = summary('cancelled') ?? 0;
  const failed = summary('fail') ?? 0;
  const passed = summary('pass') ?? 0;
  const childCode = code ?? 1;

  if (tests === null) {
    banner([
      'NO TEST SUMMARY — THIS RUN IS NOT A GATE',
      `the runner exited ${signal === null ? `with status ${childCode}` : `on ${signal}`} without a TAP summary`,
    ]);
    process.exit(1);
  }

  if (cancelled > 0) {
    banner([
      `CANCELLED TESTS — THIS RUN IS NOT A GATE (${cancelled} cancelled)`,
      'a test that hit --test-timeout is a failure, never a pass (E-8)',
    ]);
    process.exit(1);
  }

  if (skipped > 0) {
    const names = skippedNames();
    const detail = [
      `SKIPPED TESTS ARE A FAILURE (E-15): ${skipped} of ${tests} did not run`,
      ...names.map((name) => `skipped: ${name}`),
    ];
    if (DOCKER_FLAG) {
      detail.push('SKW_SKIP_DOCKER=1 was set: the real-nginx gates were not exercised');
    }
    if (ALLOW) {
      banner([
        `GATES SKIPPED — THIS RUN IS NOT A GATE (${skipped} of ${tests})`,
        'SKW_ALLOW_SKIP=1 was set deliberately; the result below proves nothing',
        'about the gates that were skipped.',
        ...names.map((name) => `skipped: ${name}`),
      ]);
      process.stderr.write(`${passed}/${tests - skipped} executed tests passed, ${skipped} skipped\n`);
      process.exit(childCode);
    }
    banner(detail);
    process.stderr.write('run-node-tests: refusing to report a green gate over skipped tests\n');
    process.exit(1);
  }

  if (failed > 0) {
    process.stderr.write(`run-node-tests: ${failed} failed of ${tests}\n`);
    process.exit(childCode === 0 ? 1 : childCode);
  }

  process.exit(childCode);
});
