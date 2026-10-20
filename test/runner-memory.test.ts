/**
 * S4e blocker 3 — **the runner's memory ceiling, measured** (§8.4, §13.3, F4; D26, C-8).
 *
 * The S4 QA measured the opposite: `docker inspect` said `Memory=0`, `/sys/fs/cgroup/memory.max`
 * said `max`, and a package held 256 MB inside a 1.54 GB VM (container 321 MiB, 21.85%). §8.4's
 * "it cannot starve the host" was false, because there was no ceiling to starve it against.
 *
 * This gate runs the runner image the way `docker-compose.yml` runs it — the flags are read
 * from the compose file, not invented here — and asks four questions:
 *
 *   M1  is the ceiling in the shipped compose file, and does the container's real cgroup agree?
 *   M2  what does a package that asks for more than the ceiling get? A named `SKW_E_PL_OOM`,
 *       not a hang and not a container restart.
 *   M3  how much did it actually take (peak), and did the host survive — is the runner still
 *       answering for the packages that did nothing wrong?
 *   M4  is the package usable again after its child died (the restart §8.6's crash row
 *       promises), while a JS-object hoard is stopped by the child's own heap cap?
 *
 * The image is built locally and tagged `skw-runner:s4e`. It is not the released digest — that
 * does not exist on this box — and this file never claims otherwise.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { REPO } from './helpers/fixture.ts';

const IMAGE = 'skw-runner:s4e';
const NAME = 'skw-runner-mem';
/** Read from `docker-compose.yml` by M1; the run below uses the same number. */
let LIMIT_MB = 0;

let work = '';
let ready = false;
let peakMiB = 0;

function docker(args: readonly string[], timeout = 120_000): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync('docker', args, { encoding: 'utf8', timeout });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function call(requests: readonly Record<string, unknown>[], timeout = 30_000): Record<string, unknown>[] {
  const res = docker(['exec', NAME, 'node', '/srv/client.mjs', ...requests.map((r) => JSON.stringify(r))], timeout);
  assert.equal(res.status, 0, `client failed: ${res.stderr}\n${res.stdout}`);
  return res.stdout
    .trim()
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** `docker stats` is a point sample; the cgroup's `memory.peak` is the high-water mark. */
function peak(): number {
  const res = docker(['exec', NAME, 'node', '-e', "process.stdout.write(require('node:fs').readFileSync('/sys/fs/cgroup/memory.peak','utf8'))"], 20_000);
  if (res.status !== 0) return 0;
  return Number(res.stdout.trim()) / (1024 * 1024);
}

before(() => {
  const compose = readFileSync(join(REPO, 'docker-compose.yml'), 'utf8');
  const section = compose.slice(compose.indexOf('plugin-runner:'));
  const limit = /^\s+mem_limit:\s*(\d+)m\s*$/m.exec(section);
  assert.ok(limit !== null, 'docker-compose.yml has no mem_limit for plugin-runner');
  LIMIT_MB = Number(limit[1]);

  const build = docker(['build', '-t', IMAGE, 'runner']);
  assert.equal(build.status, 0, `docker build failed:\n${build.stderr}`);

  work = mkdtempSync(join(tmpdir(), 'skw-runner-mem-'));
  mkdirSync(join(work, 'plugins'), { recursive: true });
  cpSync(join(REPO, 'test', 'fixtures', 'plugins', 'memhoard'), join(work, 'plugins', 'memhoard'), { recursive: true });
  cpSync(join(REPO, 'test', 'fixtures', 'runner_client.mjs'), join(work, 'client.mjs'));
  for (const dir of ['run', 'scratch']) {
    mkdirSync(join(work, dir), { recursive: true });
    chmodSync(join(work, dir), 0o777);
  }
  chmodSync(join(work, 'client.mjs'), 0o644);

  docker(['rm', '-f', NAME]);
  const run = docker([
    'run',
    '-d',
    '--name',
    NAME,
    '--network',
    'none',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--pids-limit',
    '64',
    // The two flags this gate exists to prove, at the values compose ships.
    '--memory',
    `${LIMIT_MB}m`,
    '--memory-swap',
    `${LIMIT_MB}m`,
    '--security-opt',
    'no-new-privileges:true',
    '--tmpfs',
    '/tmp',
    '-e',
    `SKW_RUNNER_MEMORY_MB=${LIMIT_MB}`,
    '-v',
    `${join(work, 'plugins')}:/srv/plugins:ro`,
    '-v',
    `${join(work, 'run')}:/srv/run`,
    '-v',
    `${join(work, 'scratch')}:/srv/scratch`,
    '-v',
    `${join(work, 'client.mjs')}:/srv/client.mjs:ro`,
    IMAGE,
  ]);
  assert.equal(run.status, 0, `docker run failed:\n${run.stderr}`);

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const probe = docker(['exec', NAME, 'node', '/srv/client.mjs', JSON.stringify({ id: 1, op: 'plugin.list' })], 10_000);
    if (probe.status === 0) {
      try {
        const list = JSON.parse(probe.stdout.trim()) as { result?: { ready?: boolean }[] };
        if ((list.result ?? []).some((p) => p.ready === true)) {
          ready = true;
          break;
        }
      } catch {
        /* not up yet */
      }
    }
    spawnSync('sleep', ['0.25']);
  }
});

after(() => {
  if (work !== '') {
    const logs = docker(['logs', NAME], 10_000);
    writeFileSync(join(REPO, 'scratch', `s4e-runner-memory-${process.pid}.log`), `${logs.stdout}\n${logs.stderr}\n`);
  }
  docker(['rm', '-f', NAME]);
  if (work !== '') rmSync(work, { recursive: true, force: true });
});

test('M1 — the ceiling is in the shipped compose file, and the container’s cgroup agrees', () => {
  assert.equal(ready, true, 'the runner did not become ready');
  const compose = readFileSync(join(REPO, 'docker-compose.yml'), 'utf8');
  const section = compose.slice(compose.indexOf('plugin-runner:'));
  assert.equal(LIMIT_MB, 384, `compose mem_limit is ${LIMIT_MB}m, expected 384m`);
  assert.match(section, /^\s+memswap_limit:\s*384m\s*$/m, 'memswap_limit must equal mem_limit (no swap escape)');
  assert.match(section, /^\s+pids_limit:\s*64\s*$/m);

  const inspect = docker(['inspect', NAME]);
  const [parsed] = JSON.parse(inspect.stdout) as { HostConfig: { Memory: number; MemorySwap: number } }[];
  assert.equal(parsed?.HostConfig.Memory, LIMIT_MB * 1024 * 1024, 'the container has no memory limit');
  assert.equal(parsed?.HostConfig.MemorySwap, LIMIT_MB * 1024 * 1024, 'swap would let a package escape the limit');

  const inside = docker(['exec', NAME, 'node', '-e', "process.stdout.write(require('node:fs').readFileSync('/sys/fs/cgroup/memory.max','utf8'))"]);
  assert.equal(inside.status, 0, 'could not read the cgroup');
  assert.equal(Number(inside.stdout.trim()), LIMIT_MB * 1024 * 1024, `memory.max is ${inside.stdout.trim()}, not the ceiling`);
});

test('M2 — a package that asks for more than the ceiling is refused by name (PL_OOM), not by a dead container', () => {
  const [hoard] = call([
    { id: 1, op: 'plugin.invoke', plugin: 'memhoard', tenant: 'acme', granted: [], args: { op: 'hold', args: { mb: 4096 } } },
  ]) as { ok: boolean; code?: string; plugin?: string; message?: string }[];
  assert.equal(hoard?.ok, false, `the hoard was allowed: ${JSON.stringify(hoard)}`);
  assert.equal(hoard?.code, 'SKW_E_PL_OOM', `expected PL_OOM, got ${String(hoard?.code)}: ${String(hoard?.message)}`);
  assert.equal(hoard?.plugin, 'memhoard', 'the refusal names the package');
  assert.match(String(hoard?.message), new RegExp(`${LIMIT_MB} MiB`), 'the refusal names the ceiling');

  // The container did not die with the child; the host is not in the blast radius.
  const inspect = docker(['inspect', '-f', '{{.State.Running}}', NAME]);
  assert.equal(inspect.stdout.trim(), 'true', 'the runner container is not running after the OOM');
});

test('M3 — the peak is measured, and it is bounded by the ceiling', () => {
  peakMiB = peak();
  assert.ok(peakMiB > 64, `memory.peak is ${peakMiB.toFixed(1)} MiB — the hoard did not move the needle, so this is not a measurement`);
  assert.ok(peakMiB <= LIMIT_MB + 8, `memory.peak is ${peakMiB.toFixed(1)} MiB, above the ${LIMIT_MB} MiB ceiling`);
  process.stdout.write(`runner memory: peak ${peakMiB.toFixed(1)} MiB of ${LIMIT_MB} MiB (cgroup v2 memory.peak, after a 4096 MiB hoard)\n`);
});

test('M4 — the dead package is restarted and answers again; a JS-object hoard is refused by name too', () => {
  // Poll: the runner restarts the child 250 ms after exit, and the handshake takes ~0.2 s.
  let again: Record<string, unknown> | undefined;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const [res] = call([{ id: 1, op: 'plugin.invoke', plugin: 'memhoard', tenant: 'acme', granted: [], args: { op: 'hold', args: { mb: 8 } } }]) as Record<
      string,
      unknown
    >[];
    if (res?.ok === true) {
      again = res;
      break;
    }
    spawnSync('sleep', ['0.5']);
  }
  assert.equal(again?.ok, true, 'the package never answered again after its child was OOM-killed (no restart)');
  assert.equal((again?.result as { held_mb?: number } | undefined)?.held_mb, 8);

  // The other control: an object hoard grows the JS heap. `--max-old-space-size` caps it, and
  // the cgroup is behind that; the measurement (scratch/s4e-transcript.txt §10) shows the
  // cgroup reaching its ceiling first for 512 MiB of doubles, so this asserts the *refusal and
  // the name*, not which of the two controls won the race.
  const spawned = docker(['logs', NAME], 10_000);
  assert.match(`${spawned.stdout}${spawned.stderr}`, /heap=64MiB permission=on/, 'the child was not spawned with the heap cap');
  const [objects] = call([
    { id: 1, op: 'plugin.invoke', plugin: 'memhoard', tenant: 'acme', granted: [], args: { op: 'holdObjects', args: { mb: 512 } } },
  ]) as { ok: boolean; code?: string; message?: string }[];
  assert.equal(objects?.ok, false, 'a 512 MiB object hoard was allowed inside a 64 MiB heap cap');
  assert.equal(objects?.code, 'SKW_E_PL_OOM', `expected PL_OOM for the object hoard, got ${String(objects?.code)}: ${String(objects?.message)}`);

  // And the runner is still alive after both deaths.
  const inspect = docker(['inspect', '-f', '{{.State.Running}}', NAME]);
  assert.equal(inspect.stdout.trim(), 'true');
});
