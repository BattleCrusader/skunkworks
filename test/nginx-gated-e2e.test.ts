/**
 * S3c / §7.4 — **the hand-off, executed by a real nginx.**
 *
 * `download-redeem.test.ts` asserts the header the app writes. This file asserts what
 * nginx does with it: `200` + `X-Accel-Redirect` becomes a file, the app's bytes never
 * leave the process, `/__protected/` stays `internal` (a direct request is nginx's own
 * 404), and a `Range` is served from the file rather than from the app.
 *
 * The harness is S3b's (`test/nginx-media-e2e.test.ts`), with the same two substitutions
 * and no others:
 *   `listen 443 ssl;`             -> removed            (TLS is not under test)
 *   `proxy_pass http://app:3000;` -> the host app       (the app is not in a container)
 * Both are asserted to have hit at least one line, so a generator change cannot make this
 * test silently stop testing the edge it claims to test.
 *
 *   G1  a redeemed cookie downloads the buyer's **stamped render** through the edge, and
 *       the stored blob (which every buyer shares) is not what is served;
 *   G2  `/__protected/<hh>/<sha>.pdf` and `/__protected/wm/<spec>/<sha>.pdf` requested
 *       directly are 404 — both locations are internal;
 *   G3  `Range: bytes=100-199` is a 206 with exactly those bytes, and spends nothing more;
 *   G4  8 parallel ranges through the edge spend one use and return eight correct slices.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { uploadAsset } from '../app/assets/library.ts';
import { openAdminWrite } from '../app/db/classes.ts';
import { issueCode } from '../app/download/code.ts';
import { loadEnv } from '../app/env.ts';
import { buildApp, type AppHandle } from '../app/main.ts';
import { generateAppConf, readHosts } from '../tools/nginx_gen.ts';
import { EDGE_TOKEN, REPO, makeFixture, type Fixture } from './helpers/fixture.ts';
import { call, header, type Res } from './helpers/http.ts';
import { pdfDrawnText } from './helpers/pdftext.ts';

const SKIP = process.env.SKW_SKIP_DOCKER === '1';
const HOST = 'acme.test';
const PDF =
  '%PDF-1.7\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
  '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\ntrailer<</Root 1 0 R/Size 4>>\n%%EOF\n';

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
let bookSha = '';
let codeId = 0;
let code = '';
const book = Buffer.from(PDF, 'latin1');
/** What the edge actually served in G1 — the render, which G3/G4 then slice. */
let served: Buffer = Buffer.alloc(0);

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** One request through the edge, with the raw body kept so bytes can be compared. */
function edge(
  path: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Res & { raw: Buffer }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: HOST, ...(opts.headers ?? {}) };
    if (opts.body !== undefined) headers['content-length'] = String(Buffer.byteLength(opts.body));
    const req = httpRequest(
      { host: '127.0.0.1', port: edgePort, path, method: opts.method ?? 'GET', headers },
      (res) => {
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
      },
    );
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

function cookieOf(res: Res): string {
  const raw = String(header(res, 'set-cookie') ?? '');
  return raw.slice(0, raw.indexOf(';'));
}

function usesOf(): number {
  const db = openAdminWrite(fixture.sitePath('acme'));
  try {
    return Number((db.prepare(`SELECT uses FROM cms_download_code WHERE id = ?`).get(codeId) as { uses: number }).uses);
  } finally {
    db.close();
  }
}

function eventCount(): number {
  const db = openAdminWrite(fixture.sitePath('acme'));
  try {
    return Number(
      (db.prepare(`SELECT COUNT(*) AS n FROM cms_download_event WHERE code_id = ? AND kind = 'first'`).get(codeId) as {
        n: number;
      }).n,
    );
  } finally {
    db.close();
  }
}

before(async () => {
  if (SKIP) return;
  if (!dockerAvailable()) {
    throw new Error('no docker daemon: this gate needs one (set SKW_SKIP_DOCKER=1 to skip it deliberately)');
  }
  fixture = makeFixture({ specs: [{ key: 'acme', hosts: [HOST], title: 'Acme' }] });
  tmp = mkdtempSync(join(REPO, '.e2e-gated-'));
  contentRoot = join(tmp, 'content');
  mkdirSync(contentRoot, { recursive: true });

  const db = openAdminWrite(fixture.sitePath('acme'));
  try {
    const uploaded = await uploadAsset({
      db,
      contentRoot,
      tenantKey: 'acme',
      key: 'vault/book',
      filename: '报告.pdf',
      bytes: book,
      quotaLimitBytes: 10_000_000,
      accessClass: 'gated',
    });
    bookSha = uploaded.asset.sha256;
    const issued = await issueCode({
      db,
      contentRoot,
      assetKey: 'vault/book',
      maxUses: 10,
      email: 'reader@example.com',
      orderRef: 'ORD-G1-0001',
    });
    codeId = issued.id;
    code = issued.code;
  } finally {
    db.close();
  }

  handle = await buildApp({ env: loadEnv(fixture.env), contentRoot });
  appPort = await freePort();
  await handle.app.listen({ port: appPort, host: '0.0.0.0' });

  const conf = join(tmp, 'conf.d');
  const snippets = join(tmp, 'snippets');
  mkdirSync(conf, { recursive: true });
  mkdirSync(snippets, { recursive: true });
  writeFileSync(
    join(snippets, 'skunk-proxy.conf'),
    readFileSync(join(REPO, 'snippets', 'skunk-proxy.conf'), 'utf8').replaceAll('__SKW_EDGE_TOKEN__', EDGE_TOKEN),
  );
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
  // The protected location must be the generated one: internal, aliased at the media tree.
  assert.match(generated, /location \/__protected\/ \{[\s\S]*?internal;[\s\S]*?alias \/srv\/content\/media\/;/);
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
  container = `skw-nginx-gated-${process.pid}`;
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
    const probe = await edge('/healthz').catch(() => undefined);
    if (probe !== undefined && probe.status === 200) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('nginx never answered /healthz through the edge');
});

after(async () => {
  if (container !== '') spawnSync('docker', ['rm', '-f', container], { encoding: 'utf8' });
  if (handle !== undefined) await handle.close();
  if (tmp !== '') rmSync(tmp, { recursive: true, force: true });
  if (fixture !== undefined) fixture.cleanup();
});

test('G1 — a redeemed cookie downloads the buyer\'s stamped render through the edge', { skip: SKIP }, async () => {
  const redeemed = await edge('/d/acme', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  assert.equal(redeemed.status, 303, redeemed.body);
  const cookie = cookieOf(redeemed);

  const res = await edge('/d/acme/file', { headers: { cookie } });
  assert.equal(res.status, 200, res.body);

  // S3d: the edge serves the **render**, and the render is what the ledger authorised.
  // The stored blob is still on disk and is still *not* what a gated buyer receives.
  const db = openAdminWrite(fixture.sitePath('acme'));
  let renderPath = '';
  let declared = -1;
  let sent: number | null = -1;
  try {
    const row = db.prepare(`SELECT path FROM cms_watermark_render WHERE source_sha = ?`).get(bookSha) as {
      path: string;
    } | undefined;
    assert.ok(row !== undefined, 'no render row for this asset');
    renderPath = row.path;
    const ev = db
      .prepare(`SELECT bytes_declared, bytes_sent FROM cms_download_event WHERE code_id = ? AND kind = 'first'`)
      .get(codeId) as { bytes_declared: number; bytes_sent: number | null };
    declared = ev.bytes_declared;
    sent = ev.bytes_sent;
  } finally {
    db.close();
  }

  assert.match(renderPath, /^content\/protected\/wm\/[0-9a-f]{64}\/[0-9a-f]{64}\.pdf$/, renderPath);
  assert.ok(!renderPath.startsWith('content/media/'), 'the hand-off is the store tree');
  const render = readFileSync(join(contentRoot, renderPath.slice('content/'.length)));
  served = res.raw;
  assert.equal(sha256(res.raw), sha256(render), 'nginx served the render, byte for byte');
  assert.notEqual(sha256(res.raw), sha256(book), 'nginx served the shared store blob');
  assert.equal(res.raw.length, render.length);
  // The app sent no body and no length; this header is nginx's, from the file.
  assert.equal(String(header(res, 'content-length')), String(render.length));
  assert.match(String(header(res, 'content-disposition')), /filename\*=UTF-8''%E6%8A%A5%E5%91%8A\.pdf/);
  assert.equal(header(res, 'x-accel-redirect'), undefined, 'nginx consumed the header');
  assert.match(String(header(res, 'content-type')), /application\/pdf/);
  assert.equal(usesOf(), 1);

  // The footer is in the file the edge sent — the whole point of the slice, asserted
  // through a real nginx rather than against the app's header.
  const text = pdfDrawnText(res.raw);
  assert.ok(text.includes('ORD-G1-0001'), `the served footer lost its order_ref:\n${text}`);

  // The acceptance criterion, in one place: the ledger's `bytes_declared` is the length
  // nginx actually sent, and `bytes_sent` is NULL because the app never observes a byte.
  assert.equal(declared, Number(header(res, 'content-length')), 'bytes_declared is nginx\'s Content-Length');
  assert.equal(sent, null, 'bytes_sent stays NULL in v1');
  process.stdout.write(
    `# G1 ${res.status} ${res.raw.length} B sha256 ${sha256(res.raw).slice(0, 8)} ` +
      `(blob ${sha256(book).slice(0, 8)}) path ${renderPath.slice(0, 40)}… ` +
      `content-length ${ String(header(res, 'content-length'))} bytes_declared ${declared} ` +
      `bytes_sent ${String(sent)} uses=${usesOf()} order_ref=${text.includes('ORD-G1-0001')}\n`,
  );
});

test('G2 — /__protected/ and /__protected/wm/ are internal: a direct request is nginx\'s 404', { skip: SKIP }, async () => {
  const uri = `/__protected/${bookSha.slice(0, 2)}/${bookSha}.pdf`;
  const direct = await edge(uri);
  assert.equal(direct.status, 404, `an internal location answered a direct request: ${direct.status}`);
  assert.equal(direct.headers['x-accel-redirect'], undefined);

  // The second tree is internal too — a render is not a URL a buyer can guess or share.
  const db = openAdminWrite(fixture.sitePath('acme'));
  let renderPath = '';
  try {
    const row = db.prepare(`SELECT path FROM cms_watermark_render WHERE source_sha = ?`).get(bookSha) as {
      path: string;
    } | undefined;
    renderPath = row?.path ?? '';
  } finally {
    db.close();
  }
  assert.notEqual(renderPath, '');
  const wmUri = `/__protected/wm/${renderPath.slice(`${'content/protected/wm/'}`.length)}`;
  const wmDirect = await edge(wmUri);
  assert.equal(wmDirect.status, 404, `the wm location answered a direct request: ${wmDirect.status}`);
  process.stdout.write(`# G2 GET ${uri} -> ${direct.status}, GET ${wmUri.slice(0, 44)}… -> ${wmDirect.status} (internal)\n`);
});

test('G3 — Range: bytes=100-199 through the edge is a 206 with exactly those bytes', { skip: SKIP }, async () => {
  assert.ok(served.length > 200, 'G1 must have served a file to slice');
  // A **new token** means a new client under E-26: the mint reuses the jti for the same
  // (code, asset, IP, UA) inside the grace window, so the same User-Agent would make this
  // a continuation and spend nothing — which is the point of R13/R14, not of this case.
  const client = 'g3-range/1.0';
  const redeemed = await edge('/d/acme', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': client },
    body: JSON.stringify({ code }),
  });
  const cookie = cookieOf(redeemed);

  const before = usesOf();
  const res = await edge('/d/acme/file', { headers: { cookie, range: 'bytes=100-199', 'user-agent': client } });
  assert.equal(res.status, 206, res.body);
  assert.equal(res.raw.length, 100);
  assert.deepEqual(res.raw, served.subarray(100, 200), 'the slice is the render\'s');
  assert.equal(String(header(res, 'content-range')), `bytes 100-199/${served.length}`);
  assert.equal(usesOf(), before + 1, 'a new token spends exactly one use, range or not');

  // The same token again: a continuation, and no second use. `bytes=150-` is the render's
  // last bytes; the same render is still on disk because the second tab reused it.
  const again = await edge('/d/acme/file', { headers: { cookie, range: 'bytes=150-', 'user-agent': client } });
  assert.equal(again.status, 206);
  assert.deepEqual(again.raw, served.subarray(150));
  assert.equal(usesOf(), before + 1, 'a continuation under the same token spends nothing');
  process.stdout.write(`# G3 206 ${res.raw.length} B range ${String(header(res, 'content-range'))} uses=${usesOf()}\n`);
});

test('G4 — 8 parallel ranges through the edge: one use, eight correct slices', { skip: SKIP }, async () => {
  assert.ok(served.length > 200, 'G1 must have served a file to slice');
  const client = 'g4-parallel/1.0';
  const redeemed = await edge('/d/acme', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': client },
    body: JSON.stringify({ code }),
  });
  const cookie = cookieOf(redeemed);
  const before = usesOf();
  const beforeEvents = eventCount();

  const results = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      edge('/d/acme/file', { headers: { cookie, range: `bytes=${i * 10}-`, 'user-agent': client } }),
    ),
  );
  for (const [i, res] of results.entries()) {
    assert.equal(res.status, 206, res.body);
    assert.deepEqual(res.raw, served.subarray(i * 10), `slice ${i}`);
  }
  assert.equal(usesOf(), before + 1, 'eight parallel ranges, one use');
  assert.equal(eventCount(), beforeEvents + 1, 'one event row');
  process.stdout.write(
    `# G4 8 parallel ranges -> 206 x8, one use (${before} -> ${usesOf()}), ` +
      `event rows ${beforeEvents} -> ${eventCount()}\n`,
  );
});
