/**
 * The shared real-nginx harness: one place that adapts the *production* edge config to a
 * test container, so a new directive in `tools/nginx_gen.ts` cannot break four gates at
 * once and be debugged four times.
 *
 * Two adaptations exist, and nothing else:
 *
 *   `listen … 443 …`             -> removed   (TLS is not under test in any edge gate)
 *   every `ssl_*` directive      -> removed   (same reason; see below)
 *   `proxy_pass http://app:3000;` -> `http://<docker-gateway>:<host port>` (the app is on
 *                                   the host, not on the compose network)
 *
 * **Why strip TLS rather than mint a self-signed pair and mount `/etc/nginx/certs`.**
 * S4d added `listen 443 ssl` plus `ssl_certificate` to every generated block. Stripping
 * only the `listen` left nginx reading `/etc/nginx/certs/<host>.crt`, which the harness
 * never mounts, so `nginx` exited at config parse (`BIO_new_file() failed`) and 23 e2e
 * tests failed for a reason no product code could fix. Both repairs work; this one is
 * chosen because:
 *
 *   1. TLS is not the subject of these gates. Each one tests a routing/strip/media/gating
 *      contract; a handshake adds a certificate authority the test would then have to
 *      trust, and an expiry date that would one day fail on its own.
 *   2. `certs/` is **install.sh runtime state**, not a repository artefact (it is
 *      gitignored). A harness that depends on it reintroduces a host dependency and an
 *      `openssl` requirement into a suite that otherwise needs only Docker.
 *   3. A keyed strip is future-proof. Matching the `ssl_` *prefix* on any line means the
 *      next `ssl_protocols`, `ssl_ciphers`, `ssl_session_cache` or `ssl_stapling` line is
 *      removed without touching a test — the failure mode S4d hit was a rule that named
 *      one directive (`listen 443 ssl`) and not its siblings.
 *
 * The strip is asserted, not assumed: `prepareAppConf` fails if any `listen …443…` or
 * `ssl_*` directive survives, or if the `proxy_pass` substitution misses a single line.
 */
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

export const NGINX_IMAGE = 'nginx:1.31-alpine';

/**
 * The host gateway's IPv4, read out of a container's /etc/hosts.
 *
 * `host.docker.internal` also resolves to an IPv6 ULA on Docker Desktop, and nginx picks
 * it, fails to connect and answers 502. Pinning the literal IPv4 keeps the harness
 * deterministic; production uses the compose network name `app:3000`, which has one
 * address.
 */
export function hostGatewayIPv4(): string {
  const r = spawnSync(
    'docker',
    [
      'run', '--rm', '--add-host', 'host.docker.internal:host-gateway',
      '--entrypoint', 'sh', NGINX_IMAGE,
      '-c', "grep host.docker.internal /etc/hosts | awk '{print $1}' | grep '\\.' | head -1",
    ],
    { encoding: 'utf8' },
  );
  const ip = r.stdout.trim();
  assert.match(ip, /^\d{1,3}(\.\d{1,3}){3}$/, `could not read the host gateway IPv4: ${r.stdout}${r.stderr}`);
  return ip;
}

export interface EdgeConf {
  /** The text to write as `10-app.conf`. */
  text: string;
  /** `listen … 443 …` directives the generator emitted (and this helper removed). */
  tlsListens: number;
  /** `ssl_*` directives removed — certificate, key, protocols, ciphers, … */
  sslDirectives: number;
  /** `proxy_pass http://app:3000;` lines rewritten to the host app. */
  upstreams: number;
}

/**
 * Adapt the generated production vhost to a plain-HTTP test edge.
 *
 * `generated` is exactly what `generateAppConf()` (or the `nginx_gen` CLI) wrote. The
 * returned counters are for the caller's own shape assertions — e.g. `tlsListens >= 4`
 * for a fixture with four hosts — so a generator that silently stops emitting a block is
 * still a red test.
 */
export function prepareAppConf(generated: string, opts: { gateway: string; appPort: number }): EdgeConf {
  const tlsListens = generated.match(/\blisten\b[^;\n]*\b443\b[^;\n]*;/g)?.length ?? 0;
  const upstreams = generated.match(/proxy_pass http:\/\/app:3000;/g)?.length ?? 0;

  // Count first, then remove, then require both numbers to be exhausted. A `listen 80;
  // listen 443 ssl;` line (the generator's one-line form, E-5) keeps its 80 listener.
  const sslDirectives = generated.match(/(?:^|[ \t])ssl_[\w]+[^;\n]*;/gm)?.length ?? 0;

  let text = generated
    .replace(/[ \t]*listen[^;\n]*\b443\b[^;\n]*;/g, '')
    .replace(/(?:^|[ \t])ssl_[\w]+[^;\n]*;/gm, '')
    .replace(/proxy_pass http:\/\/app:3000;/g, `proxy_pass http://${opts.gateway}:${opts.appPort};`);

  // The invariants, not the intent: nothing TLS-ish may survive, and every upstream must
  // have been rewritten. `nginx` refuses the whole config on either mistake, and the
  // failure would otherwise surface as "23 e2e tests could not reach the edge".
  assert.doesNotMatch(text, /\blisten\b[^;\n]*\b443\b/, 'a 443 listener survived the harness strip');
  assert.doesNotMatch(text, /(?:^|[ \t])ssl_[\w]+[^;\n]*;/m, 'an ssl_* directive survived the harness strip');
  assert.equal(
    text.match(/proxy_pass http:\/\/app:3000;/g)?.length ?? 0,
    0,
    `${upstreams} upstream(s) were generated but at least one was not rewritten`,
  );
  assert.equal(
    text.match(/proxy_pass http:\/\/[^;]+;/g)?.length ?? 0,
    upstreams,
    `expected ${upstreams} proxy_pass line(s) after rewriting`,
  );

  return { text, tlsListens, sslDirectives, upstreams };
}

/** The `nginx.conf` every edge harness mounts at `/etc/nginx/nginx.conf`. */
export function nginxConf(): string {
  return [
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
  ].join('\n');
}

/** A default server that answers 404 from a location, never from server scope (§5.2). */
export const DEFAULT_SERVER = 'server { listen 80 default_server; server_name _; location / { return 404; } }\n';
