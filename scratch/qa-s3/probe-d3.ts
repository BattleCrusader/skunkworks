/**
 * QA S3 / defeat attempt 3 — **the hand-off cannot reach a gated blob through `/media/`.**
 *
 * The threat: a compromised or buggy app emits `X-Accel-Redirect: /media/<gated-key>.<ext>`
 * (the tree a *public* asset is served from) instead of `/__protected/…`. nginx follows an
 * app's internal redirect without asking again, so the only thing between the buyer and the
 * shared, un-stamped store blob is the farm: a gated asset has no link, so `try_files` is a
 * 404 — the same 404 a key that never existed gets.
 *
 * The upstream here is a **stub**, not the product: this is the only way to emit a header
 * the shipped plane deliberately never emits. Four URIs are forced, and one control proves
 * nginx really follows `X-Accel-Redirect` at all (without it, every 404 below would be
 * vacuous):
 *
 *   /public-media    -> /media/banner/home.jpg                must be 200 (CONTROL)
 *   /gated-media     -> /media/vault/book.pdf                 must be 404, no PDF bytes
 *   /gated-protected -> /__protected/<hh>/<sha>.pdf           must be 200 (the internal
 *                                                              location is reachable *by the
 *                                                              app*, which is the trust model)
 *   /traverse        -> /media/../__protected/<hh>/<sha>.pdf   must not serve the blob
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { join } from 'node:path';

import { EDGE_TOKEN, REPO, makeFixture, type Fixture } from '../../test/helpers/fixture.ts';
import { generateAppConf, readHosts } from '../../tools/nginx_gen.ts';

const HOST = 'acme.test';
const out = (s: string): void => process.stdout.write(`${s}\n`);
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

const GATED = Buffer.from(
  '%PDF-1.7\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\ntrailer<</Root 1 0 R/Size 4>>\n%%EOF\n',
  'latin1',
);
const PUBLIC = Buffer.from('public-banner-bytes-0123456789');

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const a = srv.address();
      const p = typeof a === 'object' && a !== null ? a.port : 0;
      srv.close(() => resolve(p));
    });
  });
}

function hostGatewayIPv4(): string {
  const r = spawnSync(
    'docker',
    ['run', '--rm', '--add-host', 'host.docker.internal:host-gateway', '--entrypoint', 'sh', 'nginx:1.31-alpine',
     '-c', "grep host.docker.internal /etc/hosts | awk '{print $1}' | grep '\\.' | head -1"],
    { encoding: 'utf8' },
  );
  return r.stdout.trim();
}

function get(port: number, path: string): Promise<{ status: number; body: Buffer; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, headers: { host: HOST } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks), headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function main(): Promise<void> {
  const fixture: Fixture = makeFixture({ specs: [{ key: 'acme', hosts: [HOST], title: 'Acme' }] });
  const tmp = mkdtempSync(join(REPO, '.qa-s3-handoff-'));
  const contentRoot = join(tmp, 'content');
  const gatedSha = sha(GATED);
  const publicSha = sha(PUBLIC);

  mkdirSync(join(contentRoot, 'media', gatedSha.slice(0, 2)), { recursive: true });
  mkdirSync(join(contentRoot, 'media', publicSha.slice(0, 2)), { recursive: true });
  mkdirSync(join(contentRoot, 'public', 'banner'), { recursive: true });
  mkdirSync(join(contentRoot, 'edge'), { recursive: true });
  mkdirSync(join(contentRoot, 'protected', 'wm'), { recursive: true });
  writeFileSync(join(contentRoot, 'media', gatedSha.slice(0, 2), `${gatedSha}.pdf`), GATED);
  writeFileSync(join(contentRoot, 'media', publicSha.slice(0, 2), `${publicSha}.jpg`), PUBLIC);
  // The farm: ONE link, for the public asset only. The gated asset has none — that is the rule.
  symlinkSync(`../../media/${publicSha.slice(0, 2)}/${publicSha}.jpg`, join(contentRoot, 'public', 'banner', 'home.jpg'));
  writeFileSync(join(contentRoot, 'edge', 'media-aliases.inc'), '# no renames in this probe\n');

  // The stub upstream: emits the header the shipped plane never emits.
  const stub = createServer((req, res) => {
    const p = req.url ?? '/';
    const target =
      p === '/public-media'
        ? '/media/banner/home.jpg'
        : p === '/gated-media'
          ? '/media/vault/book.pdf'
          : p === '/gated-protected'
            ? `/__protected/${gatedSha.slice(0, 2)}/${gatedSha}.pdf`
            : p === '/traverse'
              ? `/media/../__protected/${gatedSha.slice(0, 2)}/${gatedSha}.pdf`
              : null;
    if (target === null) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'x-accel-redirect': target, 'content-type': 'text/plain' });
    res.end('stub');
  });
  const stubPort = await new Promise<number>((resolve) => {
    stub.listen(0, '0.0.0.0', () => resolve((stub.address() as AddressInfo).port));
  });

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
  generated = generated
    .replace(/listen 443 ssl;/g, '')
    .replace(/proxy_pass http:\/\/app:3000;/g, `proxy_pass http://${gateway}:${stubPort};`);
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
      '  access_log off;',
      '  include /etc/nginx/conf.d/*.conf;',
      '}',
      '',
    ].join('\n'),
  );

  const edgePort = await freePort();
  const container = `skw-qa-handoff-${process.pid}`;
  const run = spawnSync(
    'docker',
    ['run', '--rm', '-d', '--name', container, '-p', `${edgePort}:80`,
     '-v', `${join(tmp, 'nginx.conf')}:/etc/nginx/nginx.conf:ro`,
     '-v', `${conf}:/etc/nginx/conf.d:ro`,
     '-v', `${snippets}:/etc/nginx/snippets:ro`,
     '-v', `${contentRoot}:/srv/content:ro`,
     'nginx:1.31-alpine'],
    { encoding: 'utf8' },
  );
  if (run.status !== 0) throw new Error(run.stderr);

  try {
    for (let i = 0; i < 80; i += 1) {
      const p = await get(edgePort, '/nothing').catch(() => null);
      if (p !== null) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    for (const path of ['/public-media', '/gated-media', '/gated-protected', '/traverse']) {
      const r = await get(edgePort, path);
      out(
        `# D3 ${path.padEnd(17)} -> ${r.status}, ${r.body.length} B, sha256 ${sha(r.body).slice(0, 8)}, ` +
          `pdf=${r.body.includes('%PDF')}, publicBytes=${r.body.equals(PUBLIC)}, x-accel=${String(r.headers['x-accel-redirect'])}`,
      );
    }
  } finally {
    spawnSync('docker', ['rm', '-f', container], { encoding: 'utf8' });
    stub.close();
    rmSync(tmp, { recursive: true, force: true });
    fixture.cleanup();
  }
}

main().catch((err) => {
  out(`# PROBE FAILED: ${String(err)}`);
  process.exitCode = 1;
});
