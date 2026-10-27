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
 *   N3  a rename is sampled through HTTP **inside a window the test holds open**: the sampler
 *       signals `ready` before the rename is called, and `renameAsset` (test-only, env-gated)
 *       parks between "the new links exist" and "the old links are removed" until the sampler has
 *       sampled both URLs resolving. No sample exists in which both the old and the new URL fail,
 *       and after a reload the old URL is a 301 to the new one with the current `?v=`. The
 *       barrier is what makes `sawOld > 0` a construction rather than a race against node's boot
 *       time.
 *   N4  a delete removes the link, the alias stops being a 301, and both URLs are 404.
 *
 * Harness substitutions, the same ones the S1 edge gate makes and no others (all in
 * `test/helpers/nginx.ts`):
 *   `listen … 443 …`              -> removed        (TLS is not under test)
 *   every `ssl_*` directive       -> removed        (S4d's certs live outside the harness)
 *   `proxy_pass http://app:3000`  -> the host app   (the app is not in a container here)
 * All three are asserted to have hit, so a generator change cannot make this test silently
 * stop testing the edge it claims to test.
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
import { cspPolicy } from '../app/render/csp.ts';
import { loadEnv } from '../app/env.ts';
import { buildApp, type AppHandle } from '../app/main.ts';
import { generateAppConf, readHosts } from '../tools/nginx_gen.ts';
import { startEdge } from './helpers/docker-edge.ts';
import { EDGE_TOKEN, REPO, makeFixture, type Fixture } from './helpers/fixture.ts';
import { call, header, type Res } from './helpers/http.ts';
import { removeContainer, trackContainer } from './helpers/docker.ts';
import { DEFAULT_SERVER, hostGatewayIPv4, nginxConf, prepareAppConf } from './helpers/nginx.ts';

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
  writeFileSync(join(snippets, 'skunk-csp.conf'), readFileSync(join(REPO, 'snippets', 'skunk-csp.conf')));
  writeFileSync(join(conf, '00-default.conf'), DEFAULT_SERVER);

  const gateway = hostGatewayIPv4();
  const generated = generateAppConf(readHosts(fixture.controlDb), {
    demosHost: 'demos.skw.test',
    boxRps: 192,
  });
  const edge = prepareAppConf(generated, { gateway, appPort });
  assert.ok(
    edge.tlsListens >= 1 && edge.sslDirectives >= 2 && edge.upstreams >= 1,
    `generated conf has ${edge.tlsListens} TLS listens, ${edge.sslDirectives} ssl directives and ${edge.upstreams} upstreams`,
  );
  // The media location must be the generated one, alias and all.
  assert.match(edge.text, /location \/media\/ \{[\s\S]*?alias \/srv\/content\/public\/;[\s\S]*?try_files \$uri =404;/);
  assert.match(edge.text, /include \/srv\/content\/edge\/\*\.inc;/);
  writeFileSync(join(conf, '10-app.conf'), edge.text);

  writeFileSync(join(tmp, 'nginx.conf'), nginxConf());

  container = trackContainer(`skw-nginx-media-${process.pid}`);
  const started = await startEdge({
    freePort,
    args: (port) => [
      'run', '--rm', '-d',
      '--name', container,
      '--add-host', 'host.docker.internal:host-gateway',
      '-p', `127.0.0.1:${port}:80`,
      '-v', `${join(tmp, 'nginx.conf')}:/etc/nginx/nginx.conf:ro`,
      '-v', `${conf}:/etc/nginx/conf.d:ro`,
      '-v', `${snippets}:/etc/nginx/snippets:ro`,
      '-v', `${contentRoot}:/srv/content:ro`,
      'nginx:1.31-alpine',
    ],
  });
  edgePort = started.port;
  assert.equal(started.run.status, 0, started.run.stderr);
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

// --- N5: the CSP on the wire --------------------------------------------------------------

test('N5 — a /media/ response through live nginx carries the one CSP, asserted from the wire', async () => {
  // S4d item E: S4c could only assert the header on the app's listener (C1) and that the
  // vhost *includes* the snippet. This is the missing observation: a real nginx, the
  // generated config, one asset fetched over HTTP, and the header read off the response —
  // not from the file `snippets/skunk-csp.conf`.
  const res = await get('/media/banner/home.jpg');
  assert.equal(res.status, 200);
  const onTheWire = header(res, 'content-security-policy');
  assert.equal(typeof onTheWire, 'string', 'nginx served /media/ with no CSP header at all');
  assert.equal(onTheWire, cspPolicy(), 'the wire header is not the policy app/render/csp.ts emits');
  assert.match(String(onTheWire), /frame-src 'none'/);
  // A rendition is served by the same location; a second fetch proves the header is not a
  // one-off response.
  const thumb = await get('/media/banner/home@thumb.webp');
  assert.equal(thumb.status, 200);
  assert.equal(header(thumb, 'content-security-policy'), cspPolicy(), 'the rendition lost the policy');
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
  //
  // **The window is a place the test holds open, not a duration it hopes to hit.** The first
  // version slept 150 ms and then renamed; `sawOld > 0` then depended on this child finishing its
  // *boot* inside 150 ms, which a loaded box does not do — measured at load 22–34 it landed
  // after the rename and the gate failed on "the sampler never saw the old URL", an assertion
  // about node's start time wearing an assertion about the rename. Two handshakes replace it:
  //
  //   1. the child prints `ready` once it has resolved the old URL — so `sawOld > 0` is true by
  //      construction before the rename is even called;
  //   2. `renameAsset` (test-only, `SKW_RENAME_WINDOW_HOLD`) parks between "the new links exist"
  //      and "the old links are removed" until the child has sampled **both** URLs resolving, so
  //      the samples `dead` counts are samples of the held window and not of its two endpoints.
  const holdDir = join(tmp, 'rename-window');
  mkdirSync(holdDir, { recursive: true });
  const sampler = spawn(process.execPath, [
    join(REPO, 'test', 'helpers', 'http-sampler.mjs'),
    String(edgePort),
    HOST,
    oldPath,
    newPath,
    '3000',
    holdDir,
  ]);
  const events: Record<string, unknown>[] = [];
  const waiters = new Map<string, (value: Record<string, unknown>) => void>();
  let buf = '';
  sampler.stdout.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf8');
    for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line === '') continue;
      const event = JSON.parse(line) as Record<string, unknown>;
      events.push(event);
      const waiter = waiters.get(String(event.event));
      if (waiter !== undefined) {
        waiters.delete(String(event.event));
        waiter(event);
      }
    }
  });
  const samplerExit = new Promise<void>((resolve, reject) => {
    sampler.on('error', reject);
    sampler.on('close', () => resolve());
  });
  /** Wait for one protocol line. The child speaks; the test does not sleep and hope. */
  function waitForEvent(name: string, timeoutMs: number): Promise<Record<string, unknown>> {
    const seen = events.find((e) => e.event === name);
    if (seen !== undefined) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(name);
        reject(new Error(`the sampler never emitted "${name}" within ${timeoutMs} ms (events: ${JSON.stringify(events)})`));
      }, timeoutMs);
      waiters.set(name, (value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
  }
  const ready = await waitForEvent('ready', 30_000);
  assert.ok(
    Number(ready.sawOld) >= 1,
    `the sampler said ready without having resolved the old URL: ${JSON.stringify(ready)}`,
  );

  let samples: Record<string, unknown>;
  let newSha = '';
  process.env.SKW_RENAME_WINDOW_HOLD = holdDir;
  try {
    const db = openAdminWrite(fixture.sitePath('acme'));
    let newShaLocal = '';
    try {
      renameAsset(db, { from: 'campaign/summer', to: 'campaign/spring', contentRoot });
      newShaLocal = (db.prepare('SELECT sha256 FROM cms_asset WHERE key = ?').get('campaign/spring') as { sha256: string }).sha256;
    } finally {
      db.close();
    }
    newSha = newShaLocal;
  } finally {
    delete process.env.SKW_RENAME_WINDOW_HOLD;
  }
  samples = await waitForEvent('done', 60_000);
  await samplerExit;
  process.stdout.write(`# N3 ${JSON.stringify(samples)}\n`);
  // The hold engaged at all: without this file the rename was never parked, and the sampler's
  // "both URLs resolved" rounds would be pre- and post-rename rounds that happen to overlap a
  // reload rather than samples of the window.
  assert.ok(existsSync(join(holdDir, 'window-open.json')), 'the rename never opened a window the test could hold');
  assert.equal(
    samples.releaseReason,
    'window',
    `the window was released on "${String(samples.releaseReason)}", not because both URLs resolved (${JSON.stringify(samples)})`,
  );
  assert.ok(Number(samples.samples) > 5, `only ${String(samples.samples)} samples through the edge — the window was not observed`);
  assert.equal(
    Number(samples.dead),
    0,
    `both URLs failed in ${String(samples.dead)} of ${String(samples.samples)} samples (${JSON.stringify(samples)})`,
  );
  // The anti-vacuous half: `dead === 0` only means something if the samples it counts were taken
  // while both URLs were supposed to resolve. Three rounds of the held window, guaranteed by the
  // release the child performs.
  assert.ok(
    Number(samples.windowSamples) >= 3,
    `the sampler took ${String(samples.windowSamples)} samples inside the held window, not 3 (${JSON.stringify(samples)})`,
  );
  assert.ok(Number(samples.sawOld) > 0, 'the sampler never saw the old URL');
  assert.ok(Number(samples.sawNew) > 0, 'the sampler never saw the new URL resolve');

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
