#!/usr/bin/env node
/**
 * The leak gate (S4a, ITEM 0): a run that leaves a `skw-*` container or network behind
 * is a red gate, not a tidy-up job for the person who runs it next.
 *
 * Why a separate process and not a test: the node suite is invoked once per `make test`
 * and its last file has no idea what the *other* files left running — and a file that
 * leaks is exactly the file that finished. The audit has to run after the suite, over
 * the daemon, which makes it a Makefile target (`verify-no-leak`, last in `verify`).
 *
 * Two modes:
 *
 *   node scripts/leak-gate.mjs            the gate: names every survivor, exit 1
 *   node scripts/leak-gate.mjs --self-test  the same gate **plus its negative control**
 *
 * The negative control is what makes this a gate rather than a wish. It starts a
 * container named `skw-leak-probe-<pid>`, deliberately does *not* remove it, and
 * requires the audit to name it; then it removes it and requires a clean audit. A
 * checker that silently matches nothing (a wrong prefix, a `docker ps` format change,
 * a daemon it cannot reach) fails at step 2 with "the leak check cannot see a container
 * it just created". The probe is removed in a `finally`, and by an `exit` handler.
 *
 * `SKW_LEAK_GATE_SKIP_PROBE=1` exists only so the *self-test of the self-test* in
 * `docs/build/S4a-report.md` can time the audit without a probe; it does not disable
 * the assertion at the end, and the Makefile never sets it.
 */
import { spawn, spawnSync } from 'node:child_process';

const PREFIX = 'skw-';
const SELF_TEST = process.argv.includes('--self-test');
const PROBE = `skw-leak-probe-${process.pid}`;
const SKIP_PROBE = process.env.SKW_LEAK_GATE_SKIP_PROBE === '1';

/** One docker call, synchronous, with a timeout so a wedged daemon is a red gate. */
function docker(args) {
  const r = spawnSync('docker', args, { encoding: 'utf8', timeout: 20_000 });
  if (r.error !== undefined && r.error !== null) {
    return { ok: false, out: '', err: String(r.error) };
  }
  return { ok: r.status === 0, out: r.stdout ?? '', err: r.stderr ?? '' };
}

function audit() {
  const ps = docker(['ps', '-a', '--format', '{{.Names}}']);
  const net = docker(['network', 'ls', '--format', '{{.Name}}']);
  const reachable = ps.ok && net.ok;
  const containers = ps.out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith(PREFIX))
    .sort();
  const networks = net.out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith(PREFIX))
    .sort();
  return { reachable, containers, networks, why: reachable ? '' : `${ps.err}${net.err}`.trim() };
}

function report(a) {
  for (const name of a.containers) process.stdout.write(`  container  ${name}\n`);
  for (const name of a.networks) process.stdout.write(`  network    ${name}\n`);
}

/** Remove a probe without waiting: the daemon removes it, the audit proves it. */
function removeProbe(name) {
  spawnSync('docker', ['rm', '-f', name], { encoding: 'utf8', timeout: 20_000, stdio: 'ignore' });
}

let probe = '';
const cleanup = () => {
  if (probe !== '') removeProbe(probe);
  probe = '';
};
process.on('exit', cleanup);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    cleanup();
    process.exit(signal === 'SIGINT' ? 130 : 143);
  });
}

const before = audit();
process.stdout.write(
  `verify-no-leak: auditing the daemon for ${PREFIX}* (before: ${before.containers.length} container(s), ${before.networks.length} network(s))\n`,
);

if (!before.reachable) {
  process.stderr.write(`verify-no-leak: cannot query the docker daemon: ${before.why}\n`);
  process.stderr.write('verify-no-leak: an audit that cannot run is a failure, not a pass\n');
  process.exit(1);
}

if (SELF_TEST && !SKIP_PROBE) {
  probe = PROBE;
  const run = spawnSync(
    'docker',
    ['run', '-d', '--rm', '--name', probe, '--entrypoint', 'sleep', 'nginx:1.31-alpine', '30'],
    { encoding: 'utf8', timeout: 60_000 },
  );
  if (run.status !== 0) {
    cleanup();
    process.stderr.write(`verify-no-leak: the negative control could not start its probe:\n${run.stderr}\n`);
    process.exit(1);
  }
  const seen = audit();
  const found = seen.containers.includes(probe);
  process.stdout.write(
    `  negative control: created ${probe} and skipped its teardown — the audit ${found ? 'names it (red, as required)' : 'DOES NOT SEE IT'}\n`,
  );
  cleanup();
  if (!found) {
    process.stderr.write(
      'verify-no-leak: the leak check cannot see a container it just created — the gate is blind, so it is red\n',
    );
    process.exit(1);
  }
  const afterProbe = audit();
  if (afterProbe.containers.includes(probe)) {
    process.stderr.write(`verify-no-leak: the probe ${probe} survived its own removal\n`);
    process.exit(1);
  }
  process.stdout.write('  negative control: probe removed, audit clean again\n');
}

const final = audit();
const leaked = final.containers.length + final.networks.length;
if (leaked > 0) {
  process.stderr.write(`verify-no-leak: ${leaked} ${PREFIX}* resource(s) survived this run:\n`);
  for (const name of final.containers) process.stderr.write(`  container  ${name}\n`);
  for (const name of final.networks) process.stderr.write(`  network    ${name}\n`);
  process.stderr.write(
    'verify-no-leak: every test that creates a container must call trackContainer() before\n' +
      'docker run and removeContainer() in its cleanup; see test/helpers/docker.ts\n',
  );
  process.exit(1);
}

process.stdout.write(`verify-no-leak: clean — 0 ${PREFIX}* containers, 0 ${PREFIX}* networks\n`);
