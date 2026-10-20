/**
 * §16 S1 gate as amended by 02-errata E-12: onboarding is one ordered sequence,
 * and the gate proves the negative as well as the positive.
 *
 *   1. the `tenant` and `domain` rows commit (which bumps `rev`, E-3);
 *   2. `tools/nginx_gen.ts --write` regenerates `10-app.conf` from the committed rows;
 *   3. `nginx -t`, then `nginx -s reload`.
 *
 * Until step 3 the edge 404s a host the app would serve, and no cache refresh can
 * close that gap — the app is not the component that decides whether a `Host`
 * reaches it. That is the week-one failure QA measured (`S1-qa.md` §3.7); this
 * test asserts it deliberately, then asserts the reload fixes it.
 *
 * Real nginx:1.31-alpine, the generator CLI, and `nginx -s reload`. Two harness
 * substitutions only (TLS off, upstream pointed at the host app).
 */
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import Database from 'better-sqlite3';

import { buildApp, type AppHandle } from '../app/main.ts';
import { loadEnv } from '../app/env.ts';
import { migrateTenant } from '../app/db/migrate.ts';
import { generateAppConf, readHosts } from '../tools/nginx_gen.ts';
import { EDGE_TOKEN, REPO, makeFixture, type Fixture } from './helpers/fixture.ts';
import { call } from './helpers/http.ts';

const SKIP = process.env.SKW_SKIP_DOCKER === '1';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

function dockerAvailable(): boolean {
  return spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8' }).status === 0;
}

function hostGatewayIPv4(): string {
  const r = spawnSync(
    'docker',
    [
      'run', '--rm', '--add-host', 'host.docker.internal:host-gateway',
      '--entrypoint', 'sh', 'nginx:1.31-alpine',
      '-c', "grep host.docker.internal /etc/hosts | awk '{print $1}' | grep '\\.' | head -1",
    ],
    { encoding: 'utf8' },
  );
  const ip = r.stdout.trim();
  assert.match(ip, /^\d{1,3}(\.\d{1,3}){3}$/, `could not read the host gateway IPv4: ${r.stdout}${r.stderr}`);
  return ip;
}

let fixture: Fixture;
let handle: AppHandle;
let appPort = 0;
let edgePort = 0;
let container = '';
let tmp = '';
let confPath = '';

before(async () => {
  if (SKIP) return;
  if (!dockerAvailable()) {
    throw new Error('no docker daemon: this gate needs one (set SKW_SKIP_DOCKER=1 to skip it deliberately)');
  }
  fixture = makeFixture();
  const gateway = hostGatewayIPv4();
  handle = await buildApp({
    env: loadEnv({
      ...fixture.env,
      SKW_EDGE_TRUSTED_CIDRS: '127.0.0.1/32,172.16.0.0/12,192.168.0.0/16',
    }),
  });
  appPort = await freePort();
  await handle.app.listen({ port: appPort, host: '0.0.0.0' });

  tmp = mkdtempSync(join(REPO, '.onboarding-'));
  const conf = join(tmp, 'conf.d');
  const snippets = join(tmp, 'snippets');
  mkdirSync(conf, { recursive: true });
  mkdirSync(snippets, { recursive: true });
  confPath = join(conf, '10-app.conf');

  const rendered = readFileSync(join(REPO, 'snippets', 'skunk-proxy.conf'), 'utf8')
    .replaceAll('__SKW_EDGE_TOKEN__', EDGE_TOKEN);
  writeFileSync(join(snippets, 'skunk-proxy.conf'), rendered);
  writeFileSync(join(conf, '00-default.conf'), 'server { listen 80 default_server; server_name _; location / { return 404; } }\n');

  // Step 2 as an operator runs it: the generator CLI against the committed rows.
  generateConf(gateway);

  writeFileSync(
    join(tmp, 'nginx.conf'),
    [
      'worker_processes 1;',
      'error_log /dev/stderr warn;',
      'pid /tmp/nginx.pid;',
      'events { worker_connections 64; }',
      'http {',
      '  include /etc/nginx/mime.types;',
      '  default_type application/octet-stream;',
      '  client_max_body_size 16m;',
      '  access_log off;',
      '  include /etc/nginx/conf.d/*.conf;',
      '}',
      '',
    ].join('\n'),
  );

  edgePort = await freePort();
  container = `skw-onboarding-${process.pid}`;
  const run = spawnSync(
    'docker',
    [
      'run', '--rm', '-d',
      '--name', container,
      '--add-host', 'host.docker.internal:host-gateway',
      '-p', `${edgePort}:80`,
      '-v', `${join(tmp, 'nginx.conf')}:/etc/nginx/nginx.conf:ro`,
      '-v', `${conf}:/etc/nginx/conf.d`,
      '-v', `${snippets}:/etc/nginx/snippets:ro`,
      'nginx:1.31-alpine',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(run.status, 0, run.stderr);

  for (let i = 0; i < 60; i += 1) {
    const probe = await call({ port: edgePort, path: '/healthz', host: 'acme.test' }).catch(() => undefined);
    if (probe !== undefined && probe.status === 200) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.fail('nginx never answered /healthz through the edge');
});

/**
 * Step 2 of the onboarding sequence. The generator writes `proxy_pass http://app:3000`
 * and `listen 443 ssl`, which are correct in production and not reachable from this
 * harness; the two substitutions are the same ones test/nginx-e2e.test.ts documents.
 */
function generateConf(gateway: string): void {
  const gen = spawnSync(
    process.execPath,
    [
      join(REPO, 'tools', 'nginx_gen.ts'),
      '--data-dir', fixture.dir,
      '--out', confPath,
      '--admin-host', 'admin.skw.test',
      '--demos-host', 'demos.skw.test',
    ],
    { cwd: REPO, encoding: 'utf8', env: { ...process.env, ...fixture.env } },
  );
  assert.equal(gen.status, 0, `nginx_gen failed: ${gen.stderr}`);
  const text = readFileSync(confPath, 'utf8')
    .replace(/listen 443 ssl;/g, '')
    .replace(/proxy_pass http:\/\/app:3000;/g, `proxy_pass http://${gateway}:${appPort};`);
  writeFileSync(confPath, text);
}

function nginx(args: string[]): { status: number; out: string } {
  const r = spawnSync('docker', ['exec', container, 'nginx', ...args], { encoding: 'utf8' });
  return { status: r.status ?? 1, out: `${r.stdout}${r.stderr}` };
}

after(async () => {
  if (container !== '') spawnSync('docker', ['rm', '-f', container], { encoding: 'utf8' });
  if (tmp !== '') rmSync(tmp, { recursive: true, force: true });
  if (handle !== undefined) await handle.close();
  if (fixture !== undefined) fixture.cleanup();
});

test('E-12: a new tenant 404s at the edge until the generator runs and nginx reloads', { skip: SKIP }, async () => {
  assert.equal(
    (await call({ port: edgePort, path: '/pricing', host: 'acme.test' })).status,
    200,
    'the fixture tenant must be served before the onboarding case starts',
  );

  // Step 1: the rows commit. This is a second connection — the operator's.
  const control = new Database(fixture.controlDb);
  const info = control
    .prepare(
      `INSERT INTO tenant (key, mode, status, display_name, db_version)
       VALUES ('onboard', 'production', 'active', 'Onboarded', 3)`,
    )
    .run();
  control
    .prepare("INSERT INTO domain (host, tenant_id, kind, is_primary, cert_state) VALUES ('new.test', ?, 'primary', 1, 'issued')")
    .run(Number(info.lastInsertRowid));
  control.close();

  // The app's own site.db and one page — the state after `migrate --tenant all`.
  const created = migrateTenant(fixture.sitePath('onboard'), 'onboard', join(REPO, 'schema'));
  assert.equal(created.ok, true, created.error ?? '');
  const site = new Database(fixture.sitePath('onboard'));
  site
    .prepare(
      `INSERT INTO cms_page (path, slug, title, status, template, body_html, published_at)
       VALUES ('/pricing', 'pricing', 'Onboard pricing', 'published', 'page', '<h1>Onboard pricing</h1>', '2026-01-01T00:00:00.000Z')`,
    )
    .run();
  site.close();

  // The app would serve it (E-3 proves the app sees the row on the next request);
  // the edge has not been told, so the request never reaches the app.
  const beforeReload = await call({ port: edgePort, path: '/pricing', host: 'new.test' });
  assert.equal(beforeReload.status, 404, 'the edge must 404 a host its generated config does not know');
  assert.equal(beforeReload.json, undefined, "nginx's default_server answered, not the app");

  // Step 2: regenerate from the committed rows. Step 3: `nginx -t`, then reload.
  generateConf(hostGatewayIPv4());
  assert.match(readFileSync(confPath, 'utf8'), /server_name new\.test;/, 'the generator did not pick up the new domain');
  const tested = nginx(['-t']);
  assert.equal(tested.status, 0, `nginx -t failed: ${tested.out}`);
  const reloaded = nginx(['-s', 'reload']);
  assert.equal(reloaded.status, 0, `nginx -s reload failed: ${reloaded.out}`);
  await new Promise((r) => setTimeout(r, 500));

  const afterReload = await call({ port: edgePort, path: '/pricing', host: 'new.test' });
  assert.equal(afterReload.status, 200, afterReload.body.slice(0, 200));
  assert.match(afterReload.body, /Onboard pricing/);
  assert.match(afterReload.body, /data-tenant="onboard"/);
});
