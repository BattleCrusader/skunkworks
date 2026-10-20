/**
 * S4e blocker 2, composed — **one HTTP request, three processes, two containers** (D25, §8.3,
 * §8.4; §13.4's "not proven anywhere" item 2, now measured).
 *
 * The in-process gate (`test/plugin-host.test.ts` E1–E5) proves the contract with the runner as
 * a host child. This one proves the shape the product ships: `nginx`-less but otherwise the
 * same two containers — `app` on a bridge network, `plugin-runner` with `--network none` —
 * sharing only the `run/` volume, with the app reached over published HTTP.
 *
 *     HTTP GET /_plugin/notes/list  (Host: acme.test)
 *       -> app container (Fastify)
 *         -> /srv/run/plugin.sock
 *           -> runner container (no network namespace)
 *             -> node --permission child running the package
 *               -> skw.call('store.query')
 *             <- host.call frame on the same socket
 *           <- rows from /srv/data/tenants/acme/site.db
 *       <- 200 application/json, the package's own result
 *
 * Every hop is asserted: the response body is the database's row (not a canned string), the
 * runner's `NetworkMode` is `none`, the app's log says the socket is bound, and the socket's
 * mode is one the app's uid can connect to (0666 — measured: the default 0755 refused the app
 * with EACCES, which is why a composed stack had never bound).
 *
 * The images are built locally and tagged (`skw-runner:s4e`, plus the existing `skw-app:s4d`
 * with this tree's `dist/` mounted over the image's). The published digests do not exist on
 * this box; this file never claims to have pulled them.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { loadEnv } from '../app/env.ts';
import { installPlugin, uninstallPlugin } from '../app/plugins/install.ts';
import { packageRootHash } from '../app/plugins/protocol.ts';
import Database from 'better-sqlite3';
import { makeFixture, REPO, type Fixture } from './helpers/fixture.ts';
import { call } from './helpers/http.ts';
import { removeContainer, trackContainer } from './helpers/docker.ts';

const RUNNER_IMAGE = 'skw-runner:s4e';
const APP_IMAGE = 'skw-app:s4d';
const NET = 'skw-s4e-net';
const APP = 'skw-s4e-app';
const RUNNER = 'skw-s4e-runner';
const PORT = 18_443;

let fixture: Fixture;
let appUp = false;
let failure = '';

function docker(args: readonly string[], timeout = 120_000): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync('docker', args, { encoding: 'utf8', timeout });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

/**
 * One HTTP request with an explicit `Host`, because the Host is the tenant (§5.3).
 * `fetch` cannot set Host — it is a forbidden header in undici — so this goes through the
 * suite's `node:http` client, which is also what every other host-routing gate uses.
 */
async function http(path: string, method = 'GET', body?: string): Promise<{ status: number; type: string; body: string; json: unknown }> {
  const res = await call({
    port: PORT,
    path,
    method,
    host: 'acme.test',
    ...(body === undefined ? {} : { headers: { 'content-type': 'text/plain' }, body }),
  });
  const type = Array.isArray(res.headers['content-type']) ? (res.headers['content-type'][0] ?? '') : (res.headers['content-type'] ?? '');
  return { status: res.status, type, body: res.body, json: res.json };
}

before(async () => {
  fixture = makeFixture({ specs: [{ key: 'acme', hosts: ['acme.test'] }] });
  const dataDir = fixture.dir;
  const pluginsRoot = join(dataDir, 'plugins');
  const source = join(REPO, 'test', 'fixtures', 'plugins', 'notes');
  const { root } = packageRootHash(source);
  const report = join(dataDir, 'report.json');
  writeFileSync(
    report,
    JSON.stringify({ plugin: 'notes', version: '1.0.0', root_hash: root, runner_image_digest: 'sha256:composed', ran_at: '2026-10-21T00:00:00.000Z' }),
  );
  installPlugin({
    siteDb: fixture.sitePath('acme'),
    pluginsRoot,
    sourceDir: source,
    testReportPath: report,
    runnerImageDigest: 'sha256:composed',
    allowUnsigned: true,
    enable: true,
  });
  // One row for the package to read back over the socket.
  const Database = (await import('better-sqlite3')).default;
  const db = new Database(fixture.sitePath('acme'));
  try {
    db.prepare("INSERT INTO p_notes_note (body) VALUES ('written-before-the-request')").run();
  } finally {
    db.close();
  }
  mkdirSync(join(dataDir, 'run'), { recursive: true });
  mkdirSync(join(dataDir, 'scratch'), { recursive: true });
  mkdirSync(join(dataDir, 'content'), { recursive: true });
  for (const p of [dataDir, join(dataDir, 'run'), join(dataDir, 'scratch'), join(dataDir, 'content'), pluginsRoot]) chmodSync(p, 0o777);

  // The app container runs this tree's compiled `dist/`, not the image's: the image's bytes are
  // from S4d, and a gate that measured them would be measuring the previous slice. `tsc` only
  // (no Astro build): the plugin endpoint is server code, and a page build adds a minute to a
  // gate that never renders a page.
  const compile = spawnSync(join(REPO, 'node_modules', '.bin', 'tsc'), ['-p', 'tsconfig.json'], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 180_000,
  });
  assert.equal(compile.status, 0, `tsc failed:\n${compile.stdout}\n${compile.stderr}`);
  assert.ok(readFileSync(join(REPO, 'dist', 'app', 'plugins', 'endpoint.js'), 'utf8').includes('matchEndpoint'));

  const built = docker(['build', '-t', RUNNER_IMAGE, 'runner']);
  assert.equal(built.status, 0, `runner build failed:\n${built.stderr}`);

  // Recorded before `docker run`, so a failed boot still cleans up (the leak audit runs after
  // the suite and a `skw-*` network is a red gate).
  trackContainer(APP);
  trackContainer(RUNNER);
  docker(['rm', '-f', APP, RUNNER]);
  docker(['network', 'rm', NET]);
  const net = docker(['network', 'create', NET]);
  assert.equal(net.status, 0, net.stderr);

  const uid = String(process.getuid?.() ?? 10001);
  const gid = String(process.getgid?.() ?? 10001);
  const env = loadEnv(fixture.env);
  const shared = [
    '-v',
    `${join(fixture.dir, 'run')}:/srv/run`,
  ];

  const runner = docker([
    'run',
    '-d',
    '--name',
    RUNNER,
    '--network',
    'none',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--pids-limit',
    '64',
    '--memory',
    '384m',
    '--memory-swap',
    '384m',
    '--security-opt',
    'no-new-privileges:true',
    '--tmpfs',
    '/tmp',
    '-v',
    `${pluginsRoot}:/srv/plugins:ro`,
    ...shared,
    '-v',
    `${join(fixture.dir, 'scratch')}:/srv/scratch`,
    RUNNER_IMAGE,
  ]);
  assert.equal(runner.status, 0, `runner run failed:\n${runner.stderr}`);

  const app = docker([
    'run',
    '-d',
    '--name',
    APP,
    '--network',
    NET,
    '--user',
    `${uid}:${gid}`,
    '-p',
    `${PORT}:3000`,
    '-v',
    `${join(REPO, 'dist')}:/srv/app/dist:ro`,
    '-v',
    `${fixture.dir}:/srv/data`,
    ...shared,
    '-v',
    `${join(fixture.dir, 'content')}:/srv/content`,
    '-e',
    'SKW_DATA_DIR=/srv/data',
    '-e',
    `SKW_BUILD_ID=${env.buildId}`,
    '-e',
    `SKW_EDGE_TOKEN=${env.edgeToken}`,
    '-e',
    `SKW_SESSION_KEY=${env.sessionKey}`,
    '-e',
    `SKW_DOWNLOAD_TOKEN_KEY=${env.downloadTokenKey}`,
    '-e',
    `SKW_IP_HASH_KEY=${env.ipHashKey}`,
    '-e',
    'SKW_ADMIN_ORIGIN=https://admin.skw.test',
    '-e',
    'SKW_EDGE_TRUSTED_CIDRS=127.0.0.1/32,172.16.0.0/12',
    APP_IMAGE,
  ]);
  assert.equal(app.status, 0, `app run failed:\n${app.stderr}`);

  // Wait for the app to answer at all, then for the socket to be bound (the log line is the
  // app's own statement that `plugins.connect()` succeeded — not an inference).
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const health = await fetch(`http://127.0.0.1:${PORT}/healthz`);
      if (health.ok) {
        const logs = docker(['logs', APP], 10_000);
        if (/plugin\.sock: bound/.test(`${logs.stdout}${logs.stderr}`)) {
          appUp = true;
          break;
        }
      }
    } catch {
      /* not listening yet */
    }
    spawnSync('sleep', ['0.25']);
  }
  if (!appUp) {
    const logs = docker(['logs', appUp ? APP : APP], 10_000);
    failure = `${logs.stdout}\n${logs.stderr}`;
  }
});

after(() => {
  const logs = `${docker(['logs', APP], 10_000).stdout}\n${docker(['logs', RUNNER], 10_000).stdout}`;
  writeFileSync(join(REPO, 'scratch', `s4e-composed-${process.pid}.log`), logs);
  removeContainer(APP);
  removeContainer(RUNNER);
  docker(['network', 'rm', NET]);
  fixture?.cleanup();
});

test('C1 — the two containers are the shipped shape: one network namespace between them, and the socket is bound', () => {
  assert.equal(appUp, true, `the app never bound the plugin socket:\n${failure}`);
  const composed = docker(['logs', APP], 10_000);
  assert.match(
    `${composed.stdout}${composed.stderr}`,
    /plugin\.sock: bound at \/srv\/run\/plugin\.sock \(1 package\(s\): notes@1\.0\.0\)/,
  );

  const inspect = JSON.parse(docker(['inspect', RUNNER]).stdout) as { HostConfig: { NetworkMode: string; Memory: number } }[];
  assert.equal(inspect[0]?.HostConfig.NetworkMode, 'none', 'the runner has a network namespace');
  assert.equal(inspect[0]?.HostConfig.Memory, 384 * 1024 * 1024, 'the runner has no memory ceiling in the composed shape');

  // The socket's mode is the reason the composed stack can work at all across two uids.
  const mode = docker(['exec', APP, 'node', '-e', "process.stdout.write((require('node:fs').statSync('/srv/run/plugin.sock').mode & 0o777).toString(8))"]);
  assert.equal(mode.status, 0, mode.stderr);
  assert.equal(mode.stdout.trim(), '666', `the socket mode is ${mode.stdout.trim()}`);
});

test('C2 — the HTTP request runs the package in the no-network container and its host op reads the tenant database', async () => {
  const res = await http('/_plugin/notes/list');
  assert.equal(res.status, 200, res.body);
  assert.match(res.type, /application\/json/);
  const body = res.json as { count?: number; rows?: { body?: string }[] };
  assert.equal(body.count, 1, JSON.stringify(body));
  assert.equal(body.rows?.[0]?.body, 'written-before-the-request', 'the answer is not the row the host read');
});

test('C3 — a POST endpoint writes through the host from inside the container, and the write is in site.db', async () => {
  const res = await http('/_plugin/notes/sign', 'POST', 'signed-over-http');
  assert.equal(res.status, 200, res.body);
  assert.deepEqual(res.json, { ok: true });
  const Database = (await import('better-sqlite3')).default;
  const db = new Database(fixture.sitePath('acme'), { readonly: true });
  try {
    const row = db.prepare("SELECT value_json FROM cms_plugin_setting WHERE plugin_id='notes' AND key='signature'").get() as
      | { value_json: string }
      | undefined;
    assert.equal(row?.value_json, '"signed-over-http"');
  } finally {
    db.close();
  }
});

test('C4 — uninstalling the package removes the URL: the same request becomes the tenant’s 404', async () => {
  // The runner still holds the package until it restarts; the host must not route to it,
  // because the row is gone. That is §8.6's "503, then 404 once uninstalled".
  uninstallPlugin({
    siteDb: fixture.sitePath('acme'),
    pluginsRoot: join(fixture.dir, 'plugins'),
    pluginId: 'notes',
    archiveDir: join(fixture.dir, 'plugin-archive'),
  });
  const res = await http('/_plugin/notes/list');
  // The message separates the two things a 200 can mean: the row is still there in *this*
  // process (an uninstall that did not commit, which is this code's fault) or the app is
  // reading a stale view of a file this process has already emptied (a cross-process WAL
  // question, which is the environment's). Without it, a flake here is indistinguishable
  // from a broken uninstall.
  const host = new Database(fixture.sitePath('acme'), { readonly: true });
  let rowGone: boolean;
  let tableGone: boolean;
  try {
    rowGone = host.prepare("SELECT plugin_id FROM cms_plugin_installed WHERE plugin_id = 'notes'").get() === undefined;
    tableGone = host.prepare("SELECT name FROM sqlite_master WHERE name = 'p_notes_note'").get() === undefined;
  } finally {
    host.close();
  }
  const hostView = `host: row=${rowGone ? 'gone' : 'present'} table=${tableGone ? 'gone' : 'present'}`;
  // Measured on this box: the *first* request after an uninstall answers 200 in roughly one
  // full-suite run in four, while the host's own connection already reports `row=gone` — the
  // container's page cache of the bind-mounted file has not observed the host's DDL commit
  // yet (Docker Desktop's virtiofs; a Linux bind mount is coherent, which is why the strict
  // one-shot form is asserted on a host-process app in `plugin-host.test.ts` P8). The strict
  // property still holds here: if the row is still present in this process, or the app has
  // not caught up within a second, this gate is red.
  let status = res.status;
  let body = res.body;
  for (let attempt = 0; attempt < 20 && status === 200 && rowGone && tableGone; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const again = await http('/_plugin/notes/list');
    status = again.status;
    body = again.body;
  }
  assert.equal(status, 404, `${hostView}; app said: ${body}`);
  const miss = await http('/no-such-page');
  const strip = (s: string): string => s.replace(/"requestId":"[^"]+"/, '"requestId":"*"');
  assert.equal(strip(body), strip(miss.body));
});
