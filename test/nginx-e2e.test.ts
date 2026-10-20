/**
 * §16 S1 gate: "/demo/<key>/whoami returns path=/whoami and tenant_header=<key>,
 * query preserved, slash-less form 301s — prefix test, including a POST with a
 * body under /demo/".
 *
 * This is the same contract as test/prefix-demo.test.ts, but through a real
 * nginx:1.31-alpine running the config that tools/nginx_gen.ts generates and the
 * snippet install.sh renders. It is the only place the strip (C-2: nginx strips,
 * the app never does) is executed rather than emulated.
 *
 * Two lines are adapted for the harness and nothing else:
 *   `listen 443 ssl;`            -> `listen 80;`               (TLS is not under test)
 *   `proxy_pass http://app:3000` -> `http://host.docker.internal:<port>` (the app is on the host)
 * Both substitutions are asserted to have hit the expected number of lines.
 *
 * Set SKW_SKIP_DOCKER=1 to skip on a box with no daemon; the skip is loud.
 */
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { buildApp, type AppHandle } from '../app/main.ts';
import { loadEnv } from '../app/env.ts';
import { generateAppConf, readHosts } from '../tools/nginx_gen.ts';
import { EDGE_TOKEN, REPO, makeFixture, type Fixture } from './helpers/fixture.ts';
import { call, postRaw } from './helpers/http.ts';

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

/**
 * The host gateway's IPv4, read out of a container's /etc/hosts.
 *
 * `host.docker.internal` also resolves to an IPv6 ULA on Docker Desktop, and
 * nginx picks it, fails to connect and answers 502. Pinning the literal IPv4
 * keeps the harness deterministic; production uses the compose network name
 * `app:3000`, which has one address.
 */
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
let ready = false;

before(async () => {
  if (SKIP) return;
  if (!dockerAvailable()) {
    throw new Error('no docker daemon: this gate needs one (set SKW_SKIP_DOCKER=1 to skip it deliberately)');
  }
  fixture = makeFixture();
  const gateway = hostGatewayIPv4();
  // In production the app's peer is the nginx container on the compose network
  // (172.16/12 is the frozen default). This harness reaches the host app through
  // the Docker gateway, so that address is the edge here. The edge proof is not
  // weakened: the token is still required, and every other source is untrusted.
  handle = await buildApp({
    env: loadEnv({
      ...fixture.env,
      // The app sees the nginx container's bridge address, not a loopback peer.
      // Production already trusts 172.16.0.0/12 (the compose network); Docker
      // Desktop on macOS also uses 192.168.65.0/24 for its VM.
      SKW_EDGE_TRUSTED_CIDRS: '127.0.0.1/32,172.16.0.0/12,192.168.0.0/16',
    }),
  });
  appPort = await freePort();
  await handle.app.listen({ port: appPort, host: '0.0.0.0' });

  tmp = mkdtempSync(join(REPO, '.e2e-'));
  const conf = join(tmp, 'conf.d');
  const snippets = join(tmp, 'snippets');
  mkdirSync(conf, { recursive: true });
  mkdirSync(snippets, { recursive: true });

  // install.sh's job: render the edge token into the snippet.
  // replaceAll, not replace: the placeholder also appears in the file's comment,
  // and a single replace renders the comment and leaves the directive unrendered
  // — which shows up much later as a 421.
  const snippet = readFileSync(join(REPO, 'snippets', 'skunk-proxy.conf'), 'utf8');
  const rendered = snippet.replaceAll('__SKW_EDGE_TOKEN__', EDGE_TOKEN);
  writeFileSync(join(snippets, 'skunk-proxy.conf'), rendered);

  // The edge proof only works if the snippet's token is the app's token. Assert
  // the harness wiring rather than discovering a mismatch as a 421 later.
  assert.equal(handle.env.edgeToken, EDGE_TOKEN, 'app token != snippet token');
  assert.ok(rendered.includes(`X-Skunkworks-Edge  "${EDGE_TOKEN}";`), 'the directive has no edge token');
  assert.ok(!rendered.includes('__SKW_EDGE_TOKEN__'), 'a placeholder survived rendering');

  writeFileSync(
    join(conf, '00-default.conf'),
    'server { listen 80 default_server; server_name _; location / { return 404; } }\n',
  );

  let generated = generateAppConf(readHosts(fixture.controlDb), {
    adminHost: 'admin.skw.test',
    demosHost: 'demos.skw.test',
    boxRps: 192,
  });
  const listens = generated.match(/listen 443 ssl;/g)?.length ?? 0;
  const upstreams = generated.match(/proxy_pass http:\/\/app:3000;/g)?.length ?? 0;
  assert.ok(listens >= 4 && upstreams >= 4, `generated conf shape: ${listens} listens, ${upstreams} upstreams`);
  // TLS is not under test: both listen directives collapse to 80. The generator
  // emits `listen 80; listen 443 ssl;` on one line (E-5), so removing the TLS half
  // leaves exactly one listener.
  generated = generated
    .replace(/listen 443 ssl;/g, '')
    .replace(/proxy_pass http:\/\/app:3000;/g, `proxy_pass http://${gateway}:${appPort};`);
  writeFileSync(join(conf, '10-app.conf'), generated);

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
  container = `skw-nginx-e2e-${process.pid}`;
  const run = spawnSync(
    'docker',
    [
      'run', '--rm', '-d',
      '--name', container,
      '--add-host', 'host.docker.internal:host-gateway',
      '-p', `${edgePort}:80`,
      '-v', `${join(tmp, 'nginx.conf')}:/etc/nginx/nginx.conf:ro`,
      '-v', `${conf}:/etc/nginx/conf.d:ro`,
      '-v', `${snippets}:/etc/nginx/snippets:ro`,
      'nginx:1.31-alpine',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(run.status, 0, run.stderr);

  // Wait for the edge to answer, then for the app behind it.
  for (let i = 0; i < 60; i += 1) {
    const probe = await call({ port: edgePort, path: '/healthz', host: 'acme.test' }).catch(() => undefined);
    if (probe !== undefined && probe.status === 200) {
      ready = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.ok(ready, 'nginx never answered /healthz through the edge');
});

after(async () => {
  if (container !== '') spawnSync('docker', ['rm', '-f', container], { encoding: 'utf8' });
  if (tmp !== '') rmSync(tmp, { recursive: true, force: true });
  if (handle !== undefined) await handle.close();
  if (fixture !== undefined) fixture.cleanup();
});

interface Whoami {
  path: string;
  tenant_header: string | null;
  tenant: string;
  via: string;
  prefix: string | null;
  method: string;
  query: string;
  body_bytes: number;
}

test('through real nginx: GET /demo/acme/whoami strips to /whoami and keeps the query', { skip: SKIP }, async () => {
  const res = await call({ port: edgePort, path: '/demo/acme/whoami?x=1&y=two', host: 'demos.skw.test' });
  assert.equal(res.status, 200, res.body);
  const body = res.json as Whoami;
  assert.equal(body.path, '/whoami');
  assert.equal(body.tenant_header, 'acme');
  assert.equal(body.tenant, 'acme');
  assert.equal(body.prefix, '/demo/acme');
  assert.equal(body.query, 'x=1&y=two');
});

test('through real nginx: POST /demo/acme/whoami delivers its body', { skip: SKIP }, async () => {
  const res = await call({
    port: edgePort,
    path: '/demo/acme/whoami',
    method: 'POST',
    host: 'demos.skw.test',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'name=ada&ok=1',
  });
  assert.equal(res.status, 200, res.body);
  const body = res.json as Whoami;
  assert.equal(body.method, 'POST');
  assert.equal(body.body_bytes, 13);
});

test('through real nginx: /demo/beta 301s to /demo/beta/ and keeps the query', { skip: SKIP }, async () => {
  const res = await call({ port: edgePort, path: '/demo/beta?x=1', host: 'demos.skw.test' });
  assert.equal(res.status, 301);
  // nginx answers with an absolute Location by default (absolute_redirect on);
  // the path and query are what the contract fixes.
  assert.match(String(res.headers.location), /\/demo\/beta\/\?x=1$/);
});

test('through real nginx: a host-routed page renders the right tenant', { skip: SKIP }, async () => {
  const acme = await call({ port: edgePort, path: '/pricing', host: 'acme.test' });
  assert.equal(acme.status, 200);
  assert.match(acme.body, /Acme pricing/);
  const beta = await call({ port: edgePort, path: '/pricing', host: 'beta.test' });
  assert.equal(beta.status, 200);
  assert.match(beta.body, /Beta pricing/);
});

test('through real nginx: a client-supplied tenant header is stripped by the snippet', { skip: SKIP }, async () => {
  // The snippet sets X-Skunkworks-Tenant "" on every host-routed location, so the
  // claim never reaches the app: the Host decides.
  const res = await call({
    port: edgePort,
    path: '/pricing',
    host: 'acme.test',
    headers: { 'x-skunkworks-tenant': 'beta' },
  });
  assert.equal(res.status, 200);
  assert.match(res.body, /Acme pricing/);
  assert.doesNotMatch(res.body, /Beta pricing/);
});

test('through real nginx: an unknown demo key is 404, not a rendered page', { skip: SKIP }, async () => {
  const res = await call({ port: edgePort, path: '/demo/zzz/whoami', host: 'demos.skw.test' });
  assert.equal(res.status, 404);
  assert.equal((res.json as { error: { code: string } }).error.code, 'SKW_E_PLT_TENANT_UNKNOWN');
});

test('E-5: a 40-character demo key reaches the app (JSON 404 from the app, not nginx HTML)', { skip: SKIP }, async () => {
  // `tenant.key` allows 40 characters; the old nginx regex allowed 32, so keys of
  // 33-40 were legal and unreachable. The distinction asserted here is *who*
  // answered: nginx's own 404 is HTML, the app's is a taxonomy body.
  const key = `k${'x'.repeat(39)}`;
  assert.equal(key.length, 40);
  const res = await call({ port: edgePort, path: `/demo/${key}/whoami`, host: 'demos.skw.test' });
  assert.equal(res.status, 404, res.body.slice(0, 200));
  assert.match(String(res.headers['content-type']), /application\/json/, 'nginx answered instead of the app');
  assert.equal((res.json as { error: { code: string } }).error.code, 'SKW_E_PLT_TENANT_UNKNOWN');
});

test('E-11: a client X-Forwarded-Prefix is cleared at the edge', { skip: SKIP }, async () => {
  const res = await call({
    port: edgePort,
    path: '/whoami',
    host: 'acme.test',
    headers: { 'x-forwarded-prefix': '/demo/evil' },
  });
  assert.equal(res.status, 200, res.body);
  const body = res.json as Whoami;
  assert.equal(body.via, 'host');
  assert.equal(body.prefix, '', 'a client-chosen prefix must never become tenant.prefix');
});

test('E-1(b): an empty tenant header on the admin host through the real edge is row 7, 404 not 421', { skip: SKIP }, async () => {
  // nginx does not forward a header whose proxy_set_header value is "": the app
  // sees no tenant header at all and answers row 7. The direct-connection twin
  // (row 1, 421) is test/tenancy/resolve.test.ts case E-1 (a).
  const res = await call({
    port: edgePort,
    path: '/admin/t/acme/pages',
    host: 'admin.skw.test',
    headers: { 'x-skunkworks-tenant': '' },
  });
  assert.equal(res.status, 404, res.body.slice(0, 200));
  assert.equal((res.json as { error: { code: string } }).error.code, 'SKW_E_PLT_TENANT_UNKNOWN');
});

test('E-13: a 17 MiB body through the edge is nginx\'s HTML 413, with no taxonomy code', { skip: SKIP }, async () => {
  const res = await postRaw({ port: edgePort, path: '/demo/acme/whoami', host: 'demos.skw.test', bytes: 17 * 1024 * 1024 });
  assert.equal(res.status, 413);
  assert.match(String(res.headers['content-type']), /text\/html/, 'the edge 413 is not a taxonomy body');
  assert.equal(res.json, undefined, 'the edge 413 must not be JSON');
  assert.doesNotMatch(res.body, /SKW_E_/);
});

test('E-13: a 16 MiB body through the edge passes the limit and reaches the app', { skip: SKIP }, async () => {
  const res = await postRaw({
    port: edgePort,
    path: '/demo/acme/whoami',
    host: 'demos.skw.test',
    bytes: 16 * 1024 * 1024,
    contentType: 'application/x-www-form-urlencoded',
  });
  assert.equal(res.status, 200, res.body.slice(0, 200));
  assert.equal((res.json as Whoami).body_bytes, 16 * 1024 * 1024);
});
