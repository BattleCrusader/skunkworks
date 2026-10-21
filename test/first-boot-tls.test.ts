/**
 * S4e blocker 1 — **the first boot of a cold bundle is a served HTTPS site** (§12.5, §16 S4
 * row 12; the S4 QA's defect 1).
 *
 * The defect, reproduced by the QA: a bundle exported from a tenant that had TLS carried
 * `cert_state: "issued"` in its seed and `ssl_certificate /etc/nginx/certs/<host>.crt` in its
 * generated config, and shipped no certificate (it cannot — a private key is per-host state).
 * `install.sh` wrote only `certs/default.crt`, `nginx` depended on `app`, and `acme` could not
 * issue until nginx was up. First `docker compose up` on a fresh box: `[emerg] cannot load
 * certificate … No such file or directory`, exit 1, dead site.
 *
 * This gate builds a real bundle, installs it into an empty directory with the real
 * `install.sh`, starts the real compose stack, and then asserts, over a real TLS connection:
 *
 *   T1  the exported seed says `none` (no claim the target cannot keep) and the bundle ships
 *       no `.crt`/`.key` at all;
 *   T2  install.sh minted `<data>/certs/<host>.crt|key` for every host the config names, plus
 *       `default.crt`, and wrote the key 0600;
 *   T3  `compose up` reached a served page over **HTTPS** with that self-signed pair, and the
 *       control plane still says `cert_state != 'issued'` — the certificate exists, the claim
 *       is pending, and those two facts are both true;
 *   T4  the `acme` service is *startable* (the old one exited 1 on `can't get docker-gen
 *       container id`), and with no CA reachable it leaves the state alone rather than
 *       inventing `failed` or `issued`;
 *   T5  against **Pebble** (a real ACME server, on this box's image store), the same service
 *       issues a certificate, writes it over the self-signed pair, sets `cert_state = 'issued'`,
 *       and HUPs nginx — the connection's issuer changes and nginx was never restarted.
 *
 * The images are local: `skw-acme:s4e` and the existing `skw-app:s4d` with
 * this tree's `dist/` mounted over it. The published digests do not exist here and nothing in
 * this file claims they were pulled.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import Database from 'better-sqlite3';

import { runExport } from '../app/export/index.ts';
import { openAdminWrite } from '../app/db/classes.ts';
import { REPO, makeFixture, type Fixture } from './helpers/fixture.ts';
import { removeContainer, trackContainer } from './helpers/docker.ts';

const PROJECT = 'skw-s4e-boot';
const PEBBLE = 'skw-s4e-pebble';
const HTTPS_PORT = 19_443;
const HTTP_PORT = 19_080;

let fixture: Fixture;
let installDir = '';
let installed = false;
let up = false;
let installLog = '';
let nginxStartedAt = '';

/**
 * Where the file's wall clock goes. The file is the reason `TEST_TIMEOUT_MS` is what it is, so
 * it reports its own breakdown on every run: setup (tsc, export, install.sh, image build),
 * `docker compose up`, nginx answering TLS, the app answering 200, Pebble issuance, teardown.
 * `test/perf-budgets.json` records the total; this line says which part is the budget.
 */
const FILE_STARTED_AT = Date.now();
const PHASES: { name: string; ms: number }[] = [];
let bootFirstAnswerMs = -1;
let bootReadyMs = -1;

function phase(name: string, startedAt: number): void {
  PHASES.push({ name, ms: Date.now() - startedAt });
}

function sh(cmd: string, args: readonly string[], opts: { cwd?: string; env?: Record<string, string>; timeout?: number } = {}): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const res = spawnSync(cmd, args, {
    cwd: opts.cwd ?? REPO,
    env: { ...process.env, ...(opts.env ?? {}) },
    encoding: 'utf8',
    timeout: opts.timeout ?? 180_000,
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function compose(args: readonly string[], env: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string } {
  return sh('docker', ['compose', '-p', PROJECT, '-f', join(installDir, 'docker-compose.yml'), '-f', join(installDir, 'compose.gate.yml'), ...args], {
    cwd: installDir,
    env: { HOST_UID: String(process.getuid?.() ?? 10001), HOST_GID: String(process.getgid?.() ?? 10001), ...env },
  });
}

interface TlsAnswer {
  status: number;
  body: string;
  issuer: string;
  subject: string;
  fingerprint: string;
}

/** One HTTPS request to 127.0.0.1:<port> with `Host: acme.test` and no CA verification. */
function get(path: string, host = 'acme.test'): Promise<TlsAnswer> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      { host: '127.0.0.1', port: HTTPS_PORT, path, method: 'GET', headers: { host }, rejectUnauthorized: false, servername: host },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk as Buffer));
        res.on('end', () => {
          // `res.socket` is null once the response has ended; the request's socket is the
          // TLSSocket that did the handshake and still holds the peer certificate.
          const socket = req.socket as import('node:tls').TLSSocket;
          const cert = socket.getPeerCertificate();
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
            issuer: String(cert.issuer?.CN ?? ''),
            subject: String(cert.subject?.CN ?? ''),
            fingerprint: String(cert.fingerprint256 ?? ''),
          });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

interface Boot {
  ok: boolean;
  /** ms from the poll's start until *any* HTTPS answer: nginx is up (a 502 is an answer). */
  firstAnswerMs: number;
  /** ms from the poll's start until a 200: the app has migrated and is serving. */
  readyMs: number;
}

function composeUp(timeout = 30_000): Promise<Boot> {
  const startedAt = Date.now();
  const deadline = startedAt + timeout;
  return (async () => {
    let firstAnswerMs = -1;
    while (Date.now() < deadline) {
      try {
        // 200, not "any answer": nginx answers 502 while the app is still migrating, and a
        // gate that accepted 502 would call a half-started stack a served site.
        const answer = await get('/pricing');
        if (firstAnswerMs < 0) firstAnswerMs = Date.now() - startedAt;
        if (answer.status === 200) return { ok: true, firstAnswerMs, readyMs: Date.now() - startedAt };
      } catch {
        /* not listening yet */
      }
      spawnSync('sleep', ['0.5']);
    }
    return { ok: false, firstAnswerMs, readyMs: Date.now() - startedAt };
  })();
}

function certState(host: string): string {
  const db = new Database(join(installDir, 'data', 'control.db'), { readonly: true });
  try {
    return String((db.prepare('SELECT cert_state FROM domain WHERE host = ?').get(host) as { cert_state: string }).cert_state);
  } finally {
    db.close();
  }
}

before(async () => {
  // The app container runs this tree's compiled dist/: the image's bytes are S4d's.
  let startedAt = Date.now();
  const compile = sh(join(REPO, 'node_modules', '.bin', 'tsc'), ['-p', 'tsconfig.json']);
  assert.equal(compile.status, 0, `tsc failed:\n${compile.stdout}\n${compile.stderr}`);
  phase('tsc', startedAt);

  // A previous aborted run must not poison this one (or the leak audit).
  startedAt = Date.now();
  sh('docker', ['rm', '-f', PEBBLE]);
  sh('docker', ['network', 'rm', `${PROJECT}_default`]);
  phase('docker cleanup', startedAt);

  startedAt = Date.now();
  fixture = makeFixture({ specs: [{ key: 'acme', hosts: ['acme.test', 'www.acme.test'] }] });
  // The tenant on the *source* box had TLS — the exact input that produced the QA's dead
  // first boot. The exporter must not carry that claim into a bundle.
  // The source box's control plane says `issued` (the tenant really had TLS); the export is
  // what must refuse to carry that claim.
  const source = new Database(fixture.controlDb);
  try {
    source.prepare("UPDATE domain SET cert_state = 'issued'").run();
  } finally {
    source.close();
  }
  const db = openAdminWrite(fixture.sitePath('acme'), 5000);
  let result;
  try {
    result = runExport({
      target: 'cms',
      db,
      tenantKey: 'acme',
      out: join(fixture.dir, 'bundle'),
      exportNow: '2026-10-21T00:00:00.000Z',
      contentRoot: join(fixture.dir, 'content'),
      repoRoot: REPO,
      tmpDir: fixture.dir,
      origin: 'https://acme.test',
      tenant: {
        key: 'acme',
        mode: 'production',
        status: 'active',
        displayName: 'Acme',
        dbVersion: 3,
        hosts: [
          { host: 'acme.test', kind: 'primary', isPrimary: 1, certState: 'issued' },
          { host: 'www.acme.test', kind: 'alias', isPrimary: 0, certState: 'issued' },
        ],
      },
    });
  } finally {
    db.close();
  }
  assert.equal(result.ok, true, JSON.stringify(result.ok ? {} : result.refusals));

  // A copy, so install.sh writes its `.env` and `data/` beside a bundle this test owns.
  installDir = join(fixture.dir, 'site');
  cpSync(join(fixture.dir, 'bundle'), installDir, { recursive: true });

  // Gate-only overlay: published ports (the host may own 80/443), local images, this tree's
  // dist, and the app as the invoking user so a root-owned test data dir is writable. Not the
  // product's compose; the product's is the file under test above it.
  writeFileSync(
    join(installDir, 'compose.gate.yml'),
    [
      'services:',
      '  nginx:',
      '    ports: !override',
      `      - "${HTTP_PORT}:80"`,
      `      - "${HTTPS_PORT}:443"`,
      '    networks:',
      '      default:',
      '        aliases:',
      '          - acme.test',
      '          - www.acme.test',
      '  app:',
      '    image: skw-app:s4d',
      '    user: "${HOST_UID}:${HOST_GID}"',
      '    volumes:',
      `      - ${join(REPO, 'dist')}:/srv/app/dist:ro`,
      '  acme:',
      '    image: skw-acme:s4e',
    ].join('\n'),
  );
  phase('fixture + export + install tree', startedAt);

  // The app image is needed only for its runtime `node_modules` (native modules compiled for
  // linux/arm64); `dist/` is mounted over the image's own. It was built on this box in S4d and
  // the registry that could rebuild it is unreachable, so its absence is a named failure, not
  // a silent fallback to the host.
  // Compose names are deterministic; record them **before** `compose up` so a hook that
  // throws mid-boot still leaves nothing behind (the leak audit runs after the suite).
  // E-31: three services. The fourth had no image left to build once `runner/**` was deleted,
  // and this gate was the last thing still asking for one.
  for (const service of ['nginx', 'app', 'acme']) trackContainer(`${PROJECT}-${service}-1`);

  startedAt = Date.now();
  const appImage = sh('docker', ['image', 'inspect', 'skw-app:s4d']);
  assert.equal(appImage.status, 0, 'no skw-app:s4d image on this box (and the registry is unreachable): the composed gate cannot run');
  for (const [tag, file, context] of [['skw-acme:s4e', 'acme/Dockerfile', '.']] as const) {
    const built = sh('docker', ['build', '-t', tag, '-f', file, context]);
    assert.equal(built.status, 0, `could not build ${tag}:\n${built.stderr}`);
  }
  phase('image check + acme build', startedAt);

  startedAt = Date.now();
  const env = { ...process.env, SKW_ENV_FILE: join(installDir, '.env') };
  const install = spawnSync(join(installDir, 'install.sh'), ['--bundle', installDir, '--target', join(installDir, 'data'), '--runtime', REPO, '--no-compose'], {
    cwd: installDir,
    env,
    encoding: 'utf8',
    timeout: 180_000,
  });
  installLog = `${install.stdout}\n${install.stderr}`;
  installed = install.status === 0;
  phase('install.sh', startedAt);
});

after(() => {
  let startedAt = Date.now();
  if (installDir !== '') {
    const logs = compose(['logs', '--no-color'], {}).stdout;
    writeFileSync(join(REPO, 'scratch', `s4e-first-boot-${process.pid}.log`), `${logs}\n--- install ---\n${installLog}`);
  }
  phase('logs capture', startedAt);
  // Pebble first: it holds an attachment on the compose network, so `compose down` cannot
  // remove that network while Pebble is on it (measured: `skw-s4e-boot_default` survived and
  // the leak gate named it).
  startedAt = Date.now();
  sh('docker', ['rm', '-f', PEBBLE]);
  compose(['down', '-v', '--remove-orphans'], {});
  for (const service of ['nginx', 'app', 'acme']) removeContainer(`${PROJECT}-${service}-1`);
  sh('docker', ['network', 'rm', `${PROJECT}_default`]);
  phase('teardown', startedAt);
  startedAt = Date.now();
  fixture?.cleanup();
  phase('fixture cleanup', startedAt);

  const total = Date.now() - FILE_STARTED_AT;
  const accounted = PHASES.reduce((sum, entry) => sum + entry.ms, 0);
  process.stdout.write(
    `# first-boot-tls phases: total=${total} ms, unaccounted=${total - accounted} ms; ` +
      `${PHASES.map((entry) => `${entry.name}=${entry.ms}`).join('; ')}; ` +
      `https first-answer=${bootFirstAnswerMs} ms, 200=${bootReadyMs} ms\n`,
  );
});

test('T1 — the bundle claims no certificate: the seed says `none` and no private key travels', () => {
  assert.equal(installed, true, `install.sh failed:\n${installLog}`);
  const seed = JSON.parse(readFileSync(join(installDir, 'data', 'control.seed.json'), 'utf8')) as {
    tenants: { hosts: { host: string; cert_state: string }[] }[];
  };
  const hosts = seed.tenants[0]?.hosts ?? [];
  assert.deepEqual(
    hosts.map((h) => `${h.host}=${h.cert_state}`).sort(),
    ['acme.test=none', 'www.acme.test=none'],
    'an exported seed must not claim a certificate the target does not have',
  );
  for (const path of ['certs/acme.test.crt', 'certs/acme.test.key', 'certs/default.crt']) {
    assert.equal(existsSync(join(installDir, path)), false, `the bundle ships ${path}`);
  }
  // The generated config still names a certificate per host — the file install.sh now mints.
  const conf = readFileSync(join(installDir, 'nginx', 'conf.d', '10-app.conf'), 'utf8');
  // Superseded (cleartext fix): 443 and 80 are separate blocks now — the port-80 one serves
  // only the http-01 challenge and a 301, so a login form is never served unencrypted.
  assert.match(conf, /listen 443 ssl;/);
  assert.match(conf, /location \/ \{ return 301 https:\/\/\$host\$request_uri; \}/);
  assert.match(conf, /ssl_certificate     \/etc\/nginx\/certs\/acme\.test\.crt;/);
  assert.match(conf, /location \^~ \/\.well-known\/acme-challenge\/ \{/);
});

test('T2 — install.sh minted a pair for every host the config names, and the key is 0600', () => {
  assert.equal(installed, true, `install.sh failed:\n${installLog}`);
  for (const host of ['acme.test', 'default']) {
    const crt = join(installDir, 'data', 'certs', `${host}.crt`);
    const key = join(installDir, 'data', 'certs', `${host}.key`);
    assert.equal(existsSync(crt), true, `no ${host}.crt`);
    assert.equal(existsSync(key), true, `no ${host}.key`);
    assert.ok(statSync(crt).size > 0);
    assert.ok(statSync(key).size > 0);
    assert.equal((statSync(key).mode & 0o777).toString(8), '600', `${host}.key is not 0600`);
  }
  assert.match(installLog, /certificate: pending \(self-signed\) acme\.test for acme\.test,www\.acme\.test/);
  // The installed control plane is honest about it: the file exists, the claim is not `issued`.
  assert.equal(certState('acme.test'), 'none');
  assert.equal(certState('www.acme.test'), 'none');
});

test('T3 — compose up serves the page over HTTPS with the self-signed pair, and the state stays pending', async () => {
  assert.equal(installed, true, `install.sh failed:\n${installLog}`);
  // T4's condition, set for this boot: no CA is reachable (the shell environment wins over
  // `.env` in compose). The service must log the failure and leave `cert_state` alone rather
  // than inventing `failed` or `issued`.
  let startedAt = Date.now();
  const started = compose(['up', '-d', '--remove-orphans'], { SKW_ACME_DIRECTORY: 'http://127.0.0.1:9/dir' });
  assert.equal(started.status, 0, `compose up failed:\n${started.stdout}\n${started.stderr}`);
  phase('compose up -d (containers started)', startedAt);
  startedAt = Date.now();
  const boot = await composeUp(180_000);
  up = boot.ok;
  bootFirstAnswerMs = boot.firstAnswerMs;
  bootReadyMs = boot.readyMs;
  phase('https served (nginx + app)', startedAt);
  assert.equal(up, true, `nginx never answered on 443:\n${compose(['ps', '-a'], {}).stdout}\n${compose(['logs', '--no-color', 'nginx'], {}).stdout}${compose(['logs', '--no-color', 'nginx'], {}).stderr}`);

  const answer = await get('/pricing');
  assert.equal(answer.status, 200, answer.body);
  assert.match(answer.body, /acme pricing/i);
  assert.match(answer.body, /data-tenant="acme"/);
  // A self-signed pair is its own issuer; anything else here would mean a CA was involved.
  assert.equal(answer.issuer, answer.subject, `the first-boot certificate is not self-signed: issuer=${answer.issuer} subject=${answer.subject}`);
  assert.ok(answer.fingerprint.length > 0);
  assert.equal(certState('acme.test'), 'none', 'the control plane claimed a certificate it does not have');
  // nginx is the container that was checked, and it is still the one compose started.
  const ps = compose(['ps', '--format', 'json'], {}).stdout;
  assert.match(ps, /"Service":"nginx"/);
  nginxStartedAt = sh('docker', ['inspect', '-f', '{{.State.StartedAt}}', compose(['ps', '-q', 'nginx'], {}).stdout.trim()]).stdout.trim();
});

test('T4 — the acme service starts (the old one exited 1) and, with no CA reachable, claims nothing', async () => {
  assert.equal(up, true, 'the stack never came up');
  const ps = compose(['ps', '-a', '--format', 'json'], {}).stdout;
  // Compose's one-line-per-service JSON; a service that exits 1 is still listed, so the
  // state is asserted too: running (or exited 0), never "exited (1)".
  const acmeLine = ps.split('\n').find((line) => line.includes('"Service":"acme"')) ?? '';
  assert.notEqual(acmeLine, '', `no acme service in compose ps:\n${ps}`);
  assert.doesNotMatch(acmeLine, /"ExitCode":1[,}]/, `the acme service exited 1:\n${acmeLine}`);

  // Give it one pass with a directory that does not answer; the state must not move.
  const logs = compose(['logs', '--no-color', 'acme'], {}).stdout;
  assert.match(logs, /acme: /, 'the acme service printed nothing');
  assert.equal(certState('acme.test'), 'none', 'a failed pass wrote a state it did not achieve');
});

test('T5 — against Pebble, the acme service issues, replaces the pair, sets `issued` and reloads nginx', async () => {
  assert.equal(up, true, 'the stack never came up');
  const before = await get('/');

  // Pebble: a real ACME server, from the local image store. httpPort 80 so its validation
  // reaches the nginx that serves the challenge; the compose network gives it `acme.test`.
  const cfg = join(fixture.dir, 'pebble.json');
  writeFileSync(
    cfg,
    JSON.stringify({
      pebble: {
        listenAddress: '0.0.0.0:14000',
        managementListenAddress: '0.0.0.0:15000',
        certificate: '/test/certs/localhost/cert.pem',
        privateKey: '/test/certs/localhost/key.pem',
        httpPort: 80,
        tlsPort: 5001,
        ocspResponderURL: '',
        externalAccountBindingRequired: false,
        profiles: { default: { description: 'gate', validityPeriod: 7776000 } },
      },
    }),
  );
  const network = `${PROJECT}_default`;
  let startedAt = Date.now();
  sh('docker', ['rm', '-f', PEBBLE]);
  const pebble = sh('docker', [
    'run', '-d', '--name', PEBBLE, '--network', network,
    // `/app` in this image *is* the pebble binary (a file, not a directory): a mount target
    // under it fails with ENOTDIR. `/test` is a directory in the image.
    '-v', `${cfg}:/test/gate-config.json:ro`,
    'ghcr.io/letsencrypt/pebble:latest', '-config', '/test/gate-config.json',
  ]);
  assert.equal(pebble.status, 0, `pebble did not start:\n${pebble.stderr}`);
  phase('pebble container start', startedAt);

  // Point the same service at Pebble and recreate it. The nginx container is untouched.
  startedAt = Date.now();
  const restarted = compose(['up', '-d', '--force-recreate', 'acme'], {
    SKW_ACME_DIRECTORY: `https://${PEBBLE}:14000/dir`,
    SKW_ACME_INSECURE: '1',
  });
  assert.equal(restarted.status, 0, `compose up acme failed:\n${restarted.stdout}\n${restarted.stderr}`);
  phase('acme recreate', startedAt);

  // Wait for the state machine to reach `issued` (the order + challenge + finalize round trip).
  startedAt = Date.now();
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline && certState('acme.test') !== 'issued') spawnSync('sleep', ['1']);
  phase('acme issuance (state=issued)', startedAt);
  const logs = compose(['logs', '--no-color', 'acme'], {}).stdout;
  assert.equal(certState('acme.test'), 'issued', `cert_state never reached issued; acme said:\n${logs}`);
  assert.equal(certState('www.acme.test'), 'issued');
  assert.match(logs, /issued acme\.test\.crt for 2 host\(s\); cert_state=issued/);

  // The bytes on disk are the CA's, not the self-signed pair's.
  const pem = readFileSync(join(installDir, 'data', 'certs', 'acme.test.crt'), 'utf8');
  assert.match(pem, /-----BEGIN CERTIFICATE-----/);
  assert.ok(pem.includes('BEGIN CERTIFICATE') && (pem.match(/BEGIN CERTIFICATE/g) ?? []).length >= 2, 'the chain is not the leaf + issuer');

  // …and nginx is serving it, without a restart: the same process answered before and after.
  // A HUP briefly drops connections while the workers are replaced, so the read is retried
  // until it succeeds; the certificate itself is the assertion, not the first attempt.
  startedAt = Date.now();
  let afterIssue = before;
  const serveDeadline = Date.now() + 20_000;
  while (Date.now() < serveDeadline) {
    try {
      afterIssue = await get('/pricing');
      if (afterIssue.fingerprint !== before.fingerprint && afterIssue.status === 200) break;
    } catch {
      /* mid-reload */
    }
    spawnSync('sleep', ['0.5']);
  }
  phase('nginx HUP + CA cert served', startedAt);
  assert.notEqual(afterIssue.fingerprint, before.fingerprint, 'nginx is still serving the self-signed pair');
  assert.match(afterIssue.issuer, /Pebble/i, `the served certificate's issuer is ${afterIssue.issuer}`);
  assert.equal(afterIssue.status, 200);
  const nginxId = compose(['ps', '-q', 'nginx'], {}).stdout.trim();
  const started = sh('docker', ['inspect', '-f', '{{.State.StartedAt}}', nginxId]).stdout.trim();
  assert.equal(started, sh('docker', ['inspect', '-f', '{{.State.StartedAt}}', nginxId]).stdout.trim());
  // The HUP is a reload, not a restart: the nginx container's start time is the one it had
  // before the certificate existed.
  const stillStarted = sh('docker', ['inspect', '-f', '{{.State.StartedAt}}', compose(['ps', '-q', 'nginx'], {}).stdout.trim()]).stdout.trim();
  assert.equal(stillStarted, nginxStartedAt, 'nginx was restarted rather than reloaded by the HUP');
  assert.match(logs, /issued acme\.test\.crt/);
});
