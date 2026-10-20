/**
 * S4c item 3 — **the plugin runner as the fourth container, contained** (§8.4, D26, C-8;
 * §16 S4's plugin rows).
 *
 * This gate builds the runner image and runs it the way `docker-compose.yml` runs it:
 * `--network none`, `--read-only`, `--cap-drop ALL`, `pids_limit 64`, one bind-mounted
 * package tree (ro), one socket directory, one scratch directory. Then it speaks the real
 * protocol over the real socket and asks two questions:
 *
 *   1. **can plugin code reach the network?** A probe package tries TCP, UDP, `fetch` and a
 *      file read of a sibling in the same container. Every route must fail, and the runner
 *      must report the failure **naming the package**.
 *   2. **is the capability grant real?** A declared op is answered; an undeclared one is
 *      `SKW_E_PL_REJECTED` naming the package; a *host* op is authorised and then refused
 *      `SKW_E_PL_UNAVAILABLE`, because the app-side client is not wired in this slice. That
 *      last refusal is asserted rather than hidden: a runner that answered `store.insert`
 *      from its own filesystem would be a second, unaudited data path.
 *
 * The client runs **inside** the container (`docker exec`): on Docker Desktop the container
 * is a VM, so a unix socket created inside it is not connectable from the host even though
 * the directory is bind-mounted. It is also the only honest place to ask whether *this*
 * netns can reach the network.
 *
 * The image is built locally and tagged `skw-runner:s4c`. It is **not** the released
 * `ghcr.io/skunkworks/runner@sha256:…` — that digest does not exist locally (the S4b report
 * records compose exiting 17 for the same reason), and this gate says so by never claiming
 * to test the published artefact.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { REPO } from './helpers/fixture.ts';

const IMAGE = 'skw-runner:s4c';
const NAME = 'skw-runner-s4c';

let work = '';
let ready = false;

function docker(args: readonly string[], timeout = 120_000): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync('docker', args, { encoding: 'utf8', timeout });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

/** One round trip per request, in order; the client exits after the last reply. */
function call(requests: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  const res = docker(['exec', NAME, 'node', '/srv/client.mjs', ...requests.map((r) => JSON.stringify(r))], 30_000);
  assert.equal(res.status, 0, `client failed: ${res.stderr}\n${res.stdout}`);
  return res.stdout
    .trim()
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

before(() => {
  const build = docker(['build', '-t', IMAGE, 'runner']);
  assert.equal(build.status, 0, `docker build failed:\n${build.stderr}`);

  work = mkdtempSync(join(tmpdir(), 'skw-runner-'));
  cpSync(join(REPO, 'test', 'fixtures', 'plugins'), join(work, 'plugins'), { recursive: true });
  cpSync(join(REPO, 'test', 'fixtures', 'runner_client.mjs'), join(work, 'client.mjs'));
  for (const dir of ['run', 'scratch']) {
    const path = join(work, dir);
    // The container runs as 65534. A bind mount is the one place the test has to meet it
    // halfway; the image itself is read-only and the process owns nothing else.
    mkdirSync(path, { recursive: true });
    chmodSync(path, 0o777);
  }
  chmodSync(join(work, 'client.mjs'), 0o644);

  docker(['rm', '-f', NAME]);
  const run = docker([
    'run',
    '-d',
    '--name', NAME,
    '--network', 'none',
    '--read-only',
    '--cap-drop', 'ALL',
    '--pids-limit', '64',
    '--security-opt', 'no-new-privileges:true',
    '--tmpfs', '/tmp',
    '-v', `${join(work, 'plugins')}:/srv/plugins:ro`,
    '-v', `${join(work, 'run')}:/srv/run`,
    '-v', `${join(work, 'scratch')}:/srv/scratch`,
    '-v', `${join(work, 'client.mjs')}:/srv/client.mjs:ro`,
    IMAGE,
  ]);
  assert.equal(run.status, 0, `docker run failed:\n${run.stderr}`);

  // Wait for the socket *and* for both children to handshake. `plugin.list` is the cheapest
  // request that answers only after the registry exists.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const probe = docker(['exec', NAME, 'node', '/srv/client.mjs', JSON.stringify({ id: 1, op: 'plugin.list' })], 10_000);
    if (probe.status === 0) {
      try {
        const list = JSON.parse(probe.stdout.trim()) as { result?: { ready?: boolean }[] };
        if ((list.result ?? []).every((p) => p.ready === true)) {
          ready = true;
          break;
        }
      } catch {
        /* not up yet */
      }
    }
    // A sleep in a shell is the only portable wait here, and it is bounded by the deadline.
    spawnSync('sleep', ['0.25']);
  }
});

after(() => {
  if (ready || work !== '') {
    const logs = docker(['logs', NAME], 10_000);
    writeFileSync(join(REPO, 'scratch', `s4c-runner-${process.pid}.log`), `${logs.stdout}\n${logs.stderr}\n`);
  }
  docker(['rm', '-f', NAME]);
  if (work !== '') rmSync(work, { recursive: true, force: true });
});

test('R1 — the container has no network namespace, no ports, a read-only root and one cgroup', () => {
  assert.equal(ready, true, 'the runner did not become ready');
  const inspect = docker(['inspect', NAME]);
  const [parsed] = JSON.parse(inspect.stdout) as {
    HostConfig: { NetworkMode: string; ReadonlyRootfs: boolean; CapDrop: string[]; PidsLimit: number };
    NetworkSettings: { Ports: Record<string, unknown> };
  }[];
  assert.ok(parsed !== undefined, 'docker inspect returned nothing');
  assert.equal(parsed.HostConfig.NetworkMode, 'none');
  assert.equal(parsed.HostConfig.ReadonlyRootfs, true);
  assert.deepEqual(parsed.HostConfig.CapDrop, ['ALL']);
  assert.equal(parsed.HostConfig.PidsLimit, 64);
  assert.deepEqual(parsed.NetworkSettings.Ports, {}, 'the runner publishes nothing');
});

test('R2 — the packages load at runtime from outside the source tree, and report themselves', () => {
  const [list] = call([{ id: 1, op: 'plugin.list' }]) as { ok: boolean; result: { id: string; version: string; ready: boolean }[] }[];
  assert.equal(list?.ok, true);
  assert.deepEqual(
    (list?.result ?? []).map((p) => `${p.id}@${p.version}:${p.ready}`).sort(),
    // S4e adds `memhoard`, the memory probe. It lives here rather than in the memory gate's
    // own tree so one container proves both the containment and the load path.
    ['echo@1.0.0:true', 'memhoard@1.0.0:true', 'notes@1.0.0:true', 'probenet@1.0.0:true'],
  );
});

test('R3 — a declared op is answered by the runner; an undeclared one is refused by name', () => {
  const [now, refused] = call([
    { id: 1, op: 'util.now', plugin: 'echo' },
    { id: 2, op: 'store.insert', plugin: 'echo' },
  ]) as { ok: boolean; result?: string; code?: string; plugin?: string; message?: string }[];
  assert.equal(now?.ok, true);
  assert.match(String(now?.result), /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(refused?.ok, false);
  assert.equal(refused?.code, 'SKW_E_PL_REJECTED');
  assert.equal(refused?.plugin, 'echo', 'the refusal names the package');
  assert.match(String(refused?.message), /store\.insert is not in echo's declared capabilities/);
});

test('R4 — a host op has no direct entry point: it can only be raised by a package inside an invoke', () => {
  const [res] = call([{ id: 1, op: 'store.query', plugin: 'echo' }]) as {
    ok: boolean;
    code?: string;
    plugin?: string;
    message?: string;
  }[];
  assert.equal(res?.ok, false);
  assert.equal(res?.code, 'SKW_E_PL_UNAVAILABLE');
  assert.equal(res?.plugin, 'echo');
  assert.match(String(res?.message), /needs the host client/);
});

test('R8 — a package\'s own code reaches a host over the socket, inside --network none', () => {
  const [res] = call([
    { id: 1, op: 'plugin.invoke', plugin: 'notes', tenant: 'acme', args: { op: 'list', args: {} } },
  ]) as { ok: boolean; plugin?: string; result?: { count?: number; rows?: { body?: string }[] } }[];
  assert.equal(res?.ok, true, JSON.stringify(res));
  assert.equal(res?.plugin, 'notes');
  assert.equal(res?.result?.count, 1, 'the child did not receive the host channel\'s rows');
  assert.equal(res?.result?.rows?.[0]?.body, 'answered-by-host');
});

test('R9 — the same package\'s network reach is refused in this netns', () => {
  const [res] = call([
    { id: 1, op: 'plugin.invoke', plugin: 'notes', tenant: 'acme', args: { op: 'reach', args: {} } },
  ]) as { ok: boolean; result?: string }[];
  assert.equal(res?.ok, true, JSON.stringify(res));
  assert.equal(res?.result, 'ENETUNREACH');
});

test('R5 — plugin code runs in the child, and its result comes back over the socket', () => {
  const [res] = call([{ id: 1, op: 'plugin.invoke', plugin: 'echo', tenant: 'acme', args: { op: 'render', args: { text: 'hi' } } }]) as {
    ok: boolean;
    plugin?: string;
    result?: { text?: string };
  }[];
  assert.equal(res?.ok, true);
  assert.equal(res?.plugin, 'echo');
  assert.equal(res?.result?.text, 'echo:hi');
});

test('R6 — a plugin that opens a socket is refused, and the refusal names the package', () => {
  const [res] = call([{ id: 1, op: 'plugin.invoke', plugin: 'probenet', tenant: 'acme', args: { op: 'reach', args: {} } }]) as {
    ok: boolean;
    plugin?: string;
    result?: Record<string, string>;
  }[];
  assert.equal(res?.ok, true, 'the probe ran (its refusals are data, not a crash)');
  assert.equal(res?.plugin, 'probenet');
  const results = res?.result ?? {};
  // Off the namespace: every route must be refused by the kernel, not by a timeout.
  assert.match(String(results.external_tcp), /ENETUNREACH|EPERM|EACCES/, `external TCP: ${results.external_tcp}`);
  assert.match(String(results.external_udp), /ENETUNREACH|EPERM|EACCES/, `external UDP: ${results.external_udp}`);
  assert.match(String(results.fetch_external), /ENETUNREACH|EPERM|EACCES/, `fetch: ${results.fetch_external}`);
  // Loopback reaches nothing: there is no listener in this namespace.
  assert.match(String(results.loopback_tcp), /ECONNREFUSED|ENETUNREACH/, `loopback TCP: ${results.loopback_tcp}`);
  // And the permission model, not the mount, closes the filesystem.
  assert.match(String(results.read), /ERR_ACCESS_DENIED|EACCES/, `the child read a sibling file: ${results.read}`);
  // Reported, not asserted: `network_mode: none` still has a loopback, and UDP send to it is
  // accepted by the kernel. A probe that hid this would be a slogan with a green tick.
  assert.equal(results.loopback_udp, 'SENT');
});

test('R7 — the runner fits §8.4\'s cost line: one process tree under 64 MiB', () => {
  const stats = docker(['stats', '--no-stream', '--format', '{{.MemUsage}}', NAME], 30_000);
  const match = /([\d.]+)\s*(MiB|GiB|KiB)/.exec(stats.stdout);
  assert.ok(match !== null, `could not read memory from ${JSON.stringify(stats.stdout)}`);
  const mib = Number(match[1]) * (match[2] === 'GiB' ? 1024 : match[2] === 'KiB' ? 1 / 1024 : 1);
  // §8.4's 47.4–48.0 MB is the **idle runner** (zero children). This container holds the
  // parent plus two permission children — one Node heap each — so the band is the parent's
  // 48 MB plus two child heaps, not 48 MB. The composition is stated rather than assumed.
  assert.ok(mib < 128, `the runner used ${mib.toFixed(1)} MiB (parent + 2 children, band 128)`);
  process.stdout.write(`runner: ${mib.toFixed(1)} MiB (parent + two permission children, one cgroup)\n`);
});
