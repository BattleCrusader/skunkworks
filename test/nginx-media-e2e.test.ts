/**
 * S3b / §7.1 / D18 — **the farm, served by a real nginx, with no Node in the path.**
 *
 * This is the only gate in the suite that executes the `/media/` location rather than
 * describing it. It runs `nginx:1.31-alpine` with the file `tools/nginx_gen.ts` generates and
 * the content tree `app/assets/farm.ts` wrote, and then:
 *
 *   N1  `GET /media/<key>.<ext>` returns the stored bytes with the app **killed** — after
 *       `handle.close()` the proxied `/healthz` is a 502 and `/media/…` is still a 200 with
 *       the right sha256. That pair is the no-Node proof: one path lost its upstream, the other
 *       never had one.
 *   N2  a gated asset is 404 and its body is **byte-identical** to a key that never existed —
 *       the same response from the same `try_files`, so the 404 is not an oracle.
 *   N3  a rename is sampled through HTTP while it happens: no sample exists in which both the
 *       old and the new URL fail, and after a reload the old URL is a 301 to the new one with
 *       the current `?v=`.
 *   N4  a delete removes the link, the alias stops being a 301, and both URLs are 404.
 *
 * Harness substitutions, the same two the S1 edge gate makes and no others:
 *   `listen 443 ssl;`            -> removed        (TLS is not under test)
 *   `proxy_pass http://app:3000` -> the host app   (the app is not in a container here)
 * Both are asserted to have hit at least one line, so a generator change cannot make this test
 * silently stop testing the edge it claims to test.
 */
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import sharp from 'sharp';

import { uploadAsset, deleteAsset, renameAsset } from '../app/assets/library.ts';
import { ensureVariants } from '../app/assets/renditions.ts';
import { openAdminWrite } from '../app/db/classes.ts';
import { loadEnv } from '../app/env.ts';
import { buildApp, type AppHandle } from '../app/main.ts';
import { generateAppConf, readHosts } from '../tools/nginx_gen.ts';
import { EDGE_TOKEN, REPO, makeFixture, type Fixture } from './helpers/fixture.ts';
import { call, header, type Res } from './helpers/http.ts';
import { removeContainer, trackContainer } from './helpers/docker.ts';

const SKIP = process.env.SKW_SKIP_DOCKER === '1';
const HOST = 'acme.test';

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
let contentRoot = '';
let appAlive = true;

/** The bytes `/media/<name>` must return, read from the farm link the app wrote. */
function bytesOf(name: string): Buffer {
  return readFileSync(join(contentRoot, 'public', name));
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function upload(key: string, accessClass: 'public' | 'gated', shade: number): Promise<{ sha256: string; ext: string }> {
  const db = openAdminWrite(fixture.sitePath('acme'));
  try {
    const bytes = await sharp({
      create: { width: 640, height: 480, channels: 3, background: { r: shade, g: 90, b: 160 } },
    })
      .jpeg({ quality: 90 })
      .toBuffer();
    const result = await uploadAsset({
      db,
      contentRoot,
      tenantKey: 'acme',
      key,
      filename: `${key.split('/').pop() ?? key}.jpg`,
      bytes,
      quotaLimitBytes: 10_000_000,
      accessClass,
      altText: key,
    });
    await ensureVariants({ db, contentRoot, assetId: result.asset.id });
    return { sha256: result.asset.sha256, ext: 'jpg' };
  } finally {
    db.close();
  }
}

async function get(path: string): Promise<Res & { raw: Buffer }> {
  return new Promise((resolve, reject) => {
    import('node:http').then(({ request }) => {
      const req = request({ host: '127.0.0.1', port: edgePort, path, headers: { host: HOST } }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks);
          let json: unknown;
          try {
            json = JSON.parse(raw.toString('utf8'));
          } catch {
            json = undefined;
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: raw.toString('utf8'), json, raw });
        });
      });
      req.on('error', reject);
      req.end();
    }, reject);
  });
}

before(async () => {
  if (SKIP) return;
  if (!dockerAvailable()) {
    throw new Error('no docker daemon: this gate needs one (set SKW_SKIP_DOCKER=1 to skip it deliberately)');
  }
  fixture = makeFixture({ specs: [{ key: 'acme', hosts: [HOST], title: 'Acme' }] });
  // Under the repo, not $TMPDIR: Docker Desktop shares the repository path, and a bind mount
  // from /var/folders is refused on some installs.
  tmp = mkdtempSync(join(REPO, '.e2e-media-'));
  contentRoot = join(tmp, 'content');
  mkdirSync(contentRoot, { recursive: true });

  handle = await buildApp({ env: loadEnv(fixture.env) });
  appPort = await freePort();
  await handle.app.listen({ port: appPort, host: '0.0.0.0' });
  appAlive = true;

  await upload('banner/home', 'public', 20);
  await upload('vault/paid', 'gated', 200);

  const conf = join(tmp, 'conf.d');
  const snippets = join(tmp, 'snippets');
  mkdirSync(conf, { recursive: true });
  mkdirSync(snippets, { recursive: true });
  const snippet = readFileSync(join(REPO, 'snippets', 'skunk-proxy.conf'), 'utf8');
  writeFileSync(join(snippets, 'skunk-proxy.conf'), snippet.replaceAll('__SKW_EDGE_TOKEN__', EDGE_TOKEN));
  writeFileSync(join(conf, '00-default.conf'), 'server { listen 80 default_server; server_name _; location / { return 404; } }\n');

  const gateway = hostGatewayIPv4();
  let generated = generateAppConf(readHosts(fixture.controlDb), {
    adminHost: 'admin.skw.test',
    demosHost: 'demos.skw.test',
    boxRps: 192,
  });
  const tls = generated.match(/listen 443 ssl;/g)?.length ?? 0;
  const upstream = generated.match(/proxy_pass http:\/\/app:3000;/g)?.length ?? 0;
  assert.ok(tls >= 1 && upstream >= 1, `generated conf has ${tls} tls listens and ${upstream} upstreams`);
  generated = generated
    .replace(/listen 443 ssl;/g, '')
    .replace(/proxy_pass http:\/\/app:3000;/g, `proxy_pass http://${gateway}:${appPort};`);
  // The media location must be the generated one, alias and all.
  assert.match(generated, /location \/media\/ \{[\s\S]*?alias \/srv\/content\/public\/;[\s\S]*?try_files \$uri =404;/);
  assert.match(generated, /include \/srv\/content\/edge\/\*\.inc;/);
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
  container = trackContainer(`skw-nginx-media-${process.pid}`);
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
      '-v', `${contentRoot}:/srv/content:ro`,
      'nginx:1.31-alpine',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(run.status, 0, run.stderr);
  for (let i = 0; i < 80; i += 1) {
    const probe = await get('/healthz').catch(() => undefined);
    if (probe !== undefined && probe.status === 200) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('nginx never answered /healthz through the edge');
});

after(async () => {
  removeContainer(container);
  if (handle !== undefined && appAlive) await handle.close();
  if (tmp !== '') rmSync(tmp, { recursive: true, force: true });
  if (fixture !== undefined) fixture.cleanup();
});

// --- N1: the no-Node proof ---------------------------------------------------------------

test('N1 — with the app killed, /media/<key> is a 200 with the stored bytes and everything else is a 502', { skip: SKIP }, async () => {
  const key = 'banner/home';
  const url = `/media/${key}.jpg`;

  // Alive: the edge is proxying, and both paths answer.
  const warm = await get(url);
  assert.equal(warm.status, 200, warm.body);
  assert.equal(sha256(warm.raw), sha256(bytesOf(`${key}.jpg`)), 'the edge served different bytes than the farm link');
  const healthBefore = await get('/healthz');
  assert.equal(healthBefore.status, 200, 'the app is not behind the edge before the kill');

  // Kill it. `close()` is the process's listener going away: nothing is listening on appPort.
  await handle.close();
  appAlive = false;

  // The app path is now dead…
  const healthAfter = await get('/healthz');
  assert.equal(healthAfter.status, 502, `a proxied path should now be 502, got ${healthAfter.status}`);

  // …and /media is not: nginx answered from the symlink, with the right bytes.
  const after = await get(url);
  assert.equal(after.status, 200, `the asset died with the app: ${after.status}`);
  assert.equal(sha256(after.raw), sha256(bytesOf(`${key}.jpg`)));
  assert.equal(after.raw.length, bytesOf(`${key}.jpg`).length);
  assert.match(String(header(after, 'cache-control')), /immutable/);
  // Printed, not asserted: the numbers the report quotes. TAP diagnostics (`# …`) are ignored
  // by the runner, so this cannot change the gate's verdict.
  process.stdout.write(
    `# N1 app-killed: /healthz -> ${healthAfter.status}, ${url} -> ${after.status} ` +
      `(${after.raw.length} B, sha256 ${sha256(after.raw).slice(0, 8)}), ` +
      `farm link sha256 ${sha256(bytesOf(`${key}.jpg`)).slice(0, 8)}\n`,
  );
  // The rendition is a farm entry too, so it survives the same way.
  const thumb = await get(`/media/${key}@thumb.webp`);
  assert.equal(thumb.status, 200, `the rendition died with the app: ${thumb.status}`);
  assert.equal(sha256(thumb.raw), sha256(bytesOf(`${key}@thumb.webp`)));
});

// --- N2: the gated asset is a 404 with no oracle ------------------------------------------

test('N2 — a gated asset is 404 and its body is identical to a key that never existed', { skip: SKIP }, async () => {
  const gated = await get('/media/vault/paid.jpg');
  const missing = await get('/media/never/existed.jpg');
  assert.equal(gated.status, 404, 'a gated asset is reachable at /media/');
  assert.equal(missing.status, 404);
  process.stdout.write(
    `# N2 gated 404 body sha256 ${sha256(gated.raw)} (${gated.raw.length} B) == missing 404 body sha256 ${sha256(missing.raw)}\n`,
  );
  // Byte-identical: same server, same location, same try_files — the 404 cannot be told apart,
  // so `/media/<key>` is not an existence oracle for gated bytes.
  assert.equal(sha256(gated.raw), sha256(missing.raw), 'the gated 404 differs from a missing-key 404');
  assert.deepEqual(
    { ...gated.headers, date: '', etag: '' },
    { ...missing.headers, date: '', etag: '' },
    'the gated 404 carries different headers than a missing key',
  );
  // And no link exists to point at it — the 404 is the mechanism, not a check that could fail open.
  const listing = spawnSync('find', [join(contentRoot, 'public'), '-lname', '*paid*'], { encoding: 'utf8' });
  assert.equal(listing.stdout.trim(), '', `a gated asset has a link: ${listing.stdout}`);
});

// --- N3: rename, sampled through the edge --------------------------------------------------

test('N3 — a rename never leaves both URLs dead (HTTP-sampled), and the old URL then 301s', { skip: SKIP }, async () => {
  await upload('campaign/summer', 'public', 60);
  const oldPath = '/media/campaign/summer.jpg';
  const newPath = '/media/campaign/spring.jpg';
  // The link first, the URL second: if this fails the farm is wrong, and if the GET fails the
  // mount is — two different bugs that a single status assertion would blur.
  assert.ok(existsSync(join(contentRoot, 'public', 'campaign/summer.jpg')), 'the upload wrote no farm link');
  // Polled: a bind mount's view of a *new* directory is eventually consistent on Docker Desktop
  // (the same file is visible to the host immediately and to the container after a short
  // cache interval). The assertion is the end state — that the URL resolves — not the latency.
  assert.equal((await pollFor(oldPath, 200)).status, 200, 'the old URL is not live before the rename');
  assert.equal((await get(newPath)).status, 404, 'the new URL is live before the rename');

  // A second process requests both URLs throughout the rename. In-process sampling could not
  // observe the window: the farm writes are synchronous.
  const sampler = spawn(process.execPath, [
    join(REPO, 'test', 'helpers', 'http-sampler.mjs'),
    String(edgePort),
    HOST,
    oldPath,
    newPath,
    '1200',
  ]);
  let raw = '';
  sampler.stdout.on('data', (chunk: Buffer) => {
    raw += chunk.toString('utf8');
  });
  const finished = new Promise<{ samples: number; dead: number; sawOld: number; sawNew: number; oldStatuses: number[]; newStatuses: number[] }>(
    (resolve, reject) => {
      sampler.on('error', reject);
      sampler.on('close', () => {
        try {
          resolve(JSON.parse(raw.trim()));
        } catch (err) {
          reject(new Error(`sampler printed ${JSON.stringify(raw)}: ${String(err)}`));
        }
      });
    },
  );
  await new Promise((r) => setTimeout(r, 150));

  const db = openAdminWrite(fixture.sitePath('acme'));
  let newSha = '';
  try {
    renameAsset(db, { from: 'campaign/summer', to: 'campaign/spring', contentRoot });
    newSha = (db.prepare('SELECT sha256 FROM cms_asset WHERE key = ?').get('campaign/spring') as { sha256: string }).sha256;
  } finally {
    db.close();
  }
  const samples = await finished;
  process.stdout.write(
    `# N3 samples ${samples.samples}, dead ${samples.dead}, sawOld ${samples.sawOld}, sawNew ${samples.sawNew}, ` +
      `old statuses ${JSON.stringify(samples.oldStatuses)}, new statuses ${JSON.stringify(samples.newStatuses)}\n`,
  );
  assert.ok(samples.samples > 5, `only ${samples.samples} samples through the edge — the window was not observed`);
  assert.equal(samples.dead, 0, `both URLs failed in ${samples.dead} of ${samples.samples} samples (statuses: ${JSON.stringify(samples)})`);
  assert.ok(samples.sawOld > 0, 'the sampler never saw the old URL');
  assert.ok(samples.sawNew > 0, 'the sampler never saw the new URL resolve');

  // The edge now answers the old URL with a 301 built from the alias map — no database.
  // The container's own view of the file is asserted first: a passing 301 on a stale map
  // would prove the wrong thing.
  const inContainer = spawnSync('docker', ['exec', container, 'cat', '/srv/content/edge/media-aliases.inc'], {
    encoding: 'utf8',
  });
  assert.match(inContainer.stdout, /\/media\/campaign\/summer\.jpg \/media\/campaign\/spring\.jpg\?v=[0-9a-f]{8};/);
  assert.equal(reload(), 0, 'nginx did not reload the regenerated alias map');
  // A reload is asynchronous: the old workers finish in-flight requests while the new ones
  // parse the config. Poll briefly rather than racing it — and assert the *end state*, not a
  // timing.
  const redirect = await pollFor(oldPath, 301);
  assert.equal(redirect.status, 301, `the old URL is ${redirect.status}, not a 301`);
  assert.match(String(header(redirect, 'location')), /\/media\/campaign\/spring\.jpg\?v=[0-9a-f]{8}$/);
  assert.equal(String(header(redirect, 'location')).split('?v=')[1], newSha.slice(0, 8), 'the 301 carries a stale version');
  // Follow it: the target serves the bytes.
  const target = await get(String(header(redirect, 'location')));
  assert.equal(target.status, 200);
  assert.equal(sha256(target.raw), sha256(bytesOf('campaign/spring.jpg')));
});

// --- N4: delete ----------------------------------------------------------------------------

test('N4 — a delete removes the link and the alias: both URLs are 404 after a reload', { skip: SKIP }, async () => {
  const db = openAdminWrite(fixture.sitePath('acme'));
  try {
    deleteAsset(db, 'campaign/spring', { contentRoot });
  } finally {
    db.close();
  }
  assert.equal((await pollFor('/media/campaign/spring.jpg', 404)).status, 404, 'the deleted asset still serves');
  assert.equal(reload(), 0, 'nginx did not reload');
  // 404 is the *expected* answer here, so the poll waits for the map to stop redirecting: a
  // 301 would mean the alias outlived the asset it pointed at.
  const old = await pollFor('/media/campaign/summer.jpg', 404);
  assert.equal(old.status, 404, `the alias is ${old.status}, not a 404 after the delete`);
  const map = readFileSync(join(contentRoot, 'edge', 'media-aliases.inc'), 'utf8');
  assert.doesNotMatch(map, /campaign/);
});

/** Poll a path until it answers `want`, up to ~3 s: a reload is asynchronous by design. */
async function pollFor(path: string, want: number): Promise<Res & { raw: Buffer }> {
  // A reload restarts workers, and a connection that lands in that instant is reset — a
  // property of `nginx -s reload`, not of the farm. The poll treats a reset as "not yet".
  let last = await get(path).catch(() => ({ status: 0, headers: {}, body: '', json: undefined, raw: Buffer.alloc(0) }));
  for (let i = 0; i < 40 && last.status !== want; i += 1) {
    await new Promise((r) => setTimeout(r, 100));
    last = await get(path).catch(() => ({ status: 0, headers: {}, body: '', json: undefined, raw: Buffer.alloc(0) }));
  }
  return last;
}

/** `nginx -s reload` in the container: the map is read at config load, not per request. */
function reload(): number {
  const r = spawnSync('docker', ['exec', container, 'nginx', '-s', 'reload'], { encoding: 'utf8' });
  return r.status ?? 1;
}
