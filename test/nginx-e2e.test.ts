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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';

import { buildApp, type AppHandle } from '../app/main.ts';
import { parseAdminAllowlist } from '../app/admin/allowlist.ts';
import { loadEnv } from '../app/env.ts';
import { generateAppConf, readHosts } from '../tools/nginx_gen.ts';
import { EDGE_TOKEN, REPO, makeFixture, type Fixture } from './helpers/fixture.ts';
import { call, header, postRaw } from './helpers/http.ts';
import { removeContainer, trackContainer } from './helpers/docker.ts';
import { DEFAULT_SERVER, hostGatewayIPv4, nginxConf, prepareAppConf } from './helpers/nginx.ts';

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

/** The app's own access log, line by line (empty before the first request). */
function logLines(): string[] {
  if (!existsSync(accessLog)) return [];
  return readFileSync(accessLog, 'utf8').split('\n').filter((l) => l !== '');
}

function dockerAvailable(): boolean {
  return spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8' }).status === 0;
}

let fixture: Fixture;
let handle: AppHandle;
let appPort = 0;
let edgePort = 0;
let container = '';
let tmp = '';
let ready = false;

/** E-17: a second pair of edges, one admitting the test peer and one refusing it. */
let allowPort = 0;
let denyPort = 0;
let allowContainer = '';
let denyContainer = '';
let accessLog = '';
const extraDirs: string[] = [];

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
      // E-17: the edge test needs the app's own record of what reached it. The
      // access log is a build option, not an env name (§4.3 stays at 23).
      SKW_ADMIN_ALLOWLIST: '',
    }),
    accessLogPath: (accessLog = join(mkdtempSync(join(REPO, '.e2e-log-')), 'access.log')),
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
  // S4c: the generated vhost includes this beside the proxy snippet, and nginx refuses to
  // load a config whose include does not resolve. The bundle ships both files.
  writeFileSync(join(snippets, 'skunk-csp.conf'), readFileSync(join(REPO, 'snippets', 'skunk-csp.conf')));

  // The edge proof only works if the snippet's token is the app's token. Assert
  // the harness wiring rather than discovering a mismatch as a 421 later.
  assert.equal(handle.env.edgeToken, EDGE_TOKEN, 'app token != snippet token');
  assert.ok(rendered.includes(`X-Skunkworks-Edge  "${EDGE_TOKEN}";`), 'the directive has no edge token');
  assert.ok(!rendered.includes('__SKW_EDGE_TOKEN__'), 'a placeholder survived rendering');

  writeFileSync(join(conf, '00-default.conf'), DEFAULT_SERVER);
  // E-17 needs nginx's own view of the peer address, not an assumption about it.
  writeFileSync(
    join(conf, '05-probe.conf'),
    'server { listen 80; server_name probe.test; location / { return 200 "$remote_addr"; } }\n',
  );

  const generated = generateAppConf(readHosts(fixture.controlDb), {
    demosHost: 'demos.skw.test',
    boxRps: 192,
  });
  // TLS is not under test: the helper strips every 443 listener **and every ssl_*
  // directive** (S4d added certificates; stripping only `listen` left nginx reading
  // `/etc/nginx/certs`, which this harness does not mount). The counters still prove the
  // generator emitted the shape this gate is about.
  const edge = prepareAppConf(generated, { gateway, appPort });
  assert.ok(
    edge.tlsListens >= 4 && edge.upstreams >= 4 && edge.sslDirectives >= 8,
    `generated conf shape: ${edge.tlsListens} TLS listens, ${edge.sslDirectives} ssl directives, ${edge.upstreams} upstreams`,
  );
  writeFileSync(join(conf, '10-app.conf'), edge.text);

  writeFileSync(join(tmp, 'nginx.conf'), nginxConf());

  /**
   * Start one edge container and return the host port it is published on.
   *
   * `freePort()` binds and releases: between that release and docker's own bind, another process
   * can take the port, and docker then refuses with `address already in use`. The suite passed
   * alone and failed inside the full run three times before this loop existed, so a port that is
   * free when asked for is a port that is free *now*, not when docker gets to it. Six attempts,
   * a fresh port each time, and loopback only — the same one-line lesson the harness keeps
   * relearning.
   */
  const runEdge = async (name: string, confDir: string): Promise<number> => {
    let last = '';
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const port = await freePort();
      const run = spawnSync(
        'docker',
        [
          'run', '--rm', '-d',
          '--name', name,
          '--add-host', 'host.docker.internal:host-gateway',
          '-p', `127.0.0.1:${port}:80`,
          '-v', `${join(tmp, 'nginx.conf')}:/etc/nginx/nginx.conf:ro`,
          '-v', `${confDir}:/etc/nginx/conf.d:ro`,
          '-v', `${snippets}:/etc/nginx/snippets:ro`,
          'nginx:1.31-alpine',
        ],
        { encoding: 'utf8' },
      );
      if (run.status === 0) return port;
      last = String(run.stderr ?? '');
      if (!last.includes('address already in use')) break;
    }
    throw new Error(`docker run for ${name} failed: ${last}`);
  };

  container = trackContainer(`skw-nginx-e2e-${process.pid}`);
  edgePort = await runEdge(container, conf);

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

  // --- E-17: two more edges over the same app, differing only in the allowlist.
  //
  // nginx sees the *host's* address on the bridge, not 127.0.0.1, so the peer
  // address is measured rather than assumed: 05-probe.conf returns $remote_addr.
  const probe = await call({ port: edgePort, path: '/', host: 'probe.test' });
  const peer = probe.body.trim();
  assert.match(peer, /^[0-9a-fA-F:.]+$/, `could not read the edge's view of the peer: ${probe.body}`);

  const edgeFor = async (allowlist: string[], name: string): Promise<{ port: number; container: string }> => {
    const dir = mkdtempSync(join(REPO, `.e2e-${name}-`));
    extraDirs.push(dir);
    const c = join(dir, 'conf.d');
    mkdirSync(c, { recursive: true });
    writeFileSync(join(c, '00-default.conf'), DEFAULT_SERVER);
    const text = generateAppConf(readHosts(fixture.controlDb), {
      demosHost: 'demos.skw.test',
      boxRps: 192,
      adminAllowlist: parseAdminAllowlist(allowlist.join(',')),
    });
    writeFileSync(join(c, '10-app.conf'), prepareAppConf(text, { gateway, appPort }).text);
    const name_ = trackContainer(`skw-nginx-e2e-${name}-${process.pid}`);
    const port = await runEdge(name_, c);
    for (let i = 0; i < 60; i += 1) {
      const p = await call({ port, path: '/healthz', host: 'acme.test' }).catch(() => undefined);
      if (p !== undefined && p.status === 200) return { port, container: name_ };
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`nginx (${name}) never answered /healthz`);
  };

  const allow = await edgeFor([`${peer}/32`], 'allow');
  allowPort = allow.port;
  allowContainer = allow.container;
  const deny = await edgeFor(['203.0.113.0/24'], 'deny');
  denyPort = deny.port;
  denyContainer = deny.container;
});

after(async () => {
  for (const name of [container, allowContainer, denyContainer]) removeContainer(name);
  for (const dir of [tmp, accessLog === '' ? '' : dirname(accessLog)]) {
    if (dir !== '') rmSync(dir, { recursive: true, force: true });
  }
  for (const dir of extraDirs) rmSync(dir, { recursive: true, force: true });
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

test('D37 + E-1(b): /admin through the real edge is the tenant host\'s, and an empty tenant header is a no-op', { skip: SKIP }, async () => {
  // This test used to send `/admin/t/acme/pages` to `admin.skw.test` and assert row 7's
  // 404. D37 moved the admin surface onto the tenant host, so the same assertion runs
  // against `acme.test` through nginx — which is the only place the edge's
  // `proxy_set_header X-Skunkworks-Tenant ""` is executed for real. nginx does not
  // forward an empty value, so the app sees no tenant header and the Host decides.
  const res = await call({
    port: edgePort,
    path: '/admin/t/acme/pages',
    host: 'acme.test',
    headers: { 'x-skunkworks-tenant': '' },
  });
  assert.equal(res.status, 404, res.body.slice(0, 200));
  assert.equal((res.json as { error: { code: string } }).error.code, 'SKW_E_PLT_TENANT_UNKNOWN');

  // And the old admin hostname reaches nothing at all through the edge: it is not a
  // server_name in any block, so nginx's default server answers.
  const gone = await call({ port: edgePort, path: '/admin/login', host: 'admin.skw.test' });
  assert.equal(gone.status, 404, 'no vhost for the old admin hostname');
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

// --- E-17 / E-13's fifth exception: the denied peer ----------------------

test('E-17: a peer outside SKW_ADMIN_ALLOWLIST is nginx\'s 403, and the app never sees the request', { skip: SKIP }, async () => {
  const path = '/admin/login?denied=1';
  const before = logLines().length;

  // D37: the allowlist guards `/admin` inside the tenant block, so the peer is refused
  // on the tenant's own host — not on a hostname that no longer exists.
  const res = await call({ port: denyPort, path, host: 'acme.test' });
  assert.equal(res.status, 403, res.body.slice(0, 200));

  // E-13's fifth exception: nginx's body, no taxonomy code, no Set-Cookie. A
  // taxonomy body here would publish the error registry to an unauthenticated peer.
  assert.match(String(res.headers['content-type']), /text\/html/, 'the denied peer gets nginx\'s HTML, not a taxonomy body');
  assert.equal(res.json, undefined, 'a denied peer must not receive JSON');
  assert.doesNotMatch(res.body, /SKW_E_/);
  assert.equal(header(res, 'set-cookie'), undefined, 'a denied peer gets no Set-Cookie');

  // The app's own access log: the request did not arrive.
  const lines = logLines();
  assert.equal(lines.length, before, `the app recorded the denied request: ${lines.slice(-2).join(' | ')}`);
  assert.equal(lines.some((l) => l.includes('denied=1')), false, 'the denied request reached the app');
});

test('E-17: the same request from a peer inside the list reaches the app', { skip: SKIP }, async () => {
  const res = await call({ port: allowPort, path: '/admin/login?allowed=1', host: 'acme.test' });
  assert.equal(res.status, 200, res.body.slice(0, 200));
  assert.match(res.body, /<form method="post" action="\/admin\/login"/);
  // And the app's access log now has it: the pair of tests differs only in the list.
  assert.ok(logLines().some((l) => l.includes('allowed=1')), 'the allowed request never reached the app');
});
