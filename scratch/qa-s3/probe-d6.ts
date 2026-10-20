/**
 * QA S3 / defeat attempt 6 — **the farm at the instant of a rename and of a delete.**
 *
 * Two questions, asked of a real nginx and a real farm, with the request issued on the
 * next turn of the event loop (measured: 0–1 ms after the mutation returned):
 *
 *   R  a key renamed "1 ms ago": the new URL must serve the asset's bytes (no stale
 *      bytes, no 500), and the old URL must serve or 301 but never 500;
 *   D  a row deleted "1 ms ago": the URL must be 404 with no bytes — not a 200 from a
 *      link that outlived the row, and not a 500 from a dangling symlink.
 *
 * A dangling symlink is the interesting failure: `try_files $uri =404` on a symlink whose
 * target is gone is a 404 *from nginx*, and an `alias` into a missing directory can be a
 * 500. Both are counted, and the nginx error log is read afterwards for ` 500 ` and for
 * `open() … failed`, so "no 500s" is a statement about the server, not only the client.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer as createNetServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type Database from 'better-sqlite3';
import sharp from 'sharp';

import { deleteAsset, renameAsset, uploadAsset } from '../../app/assets/library.ts';
import { openAdminWrite } from '../../app/db/classes.ts';
import { loadEnv } from '../../app/env.ts';
import { buildApp, type AppHandle } from '../../app/main.ts';
import { EDGE_TOKEN, REPO, makeFixture, type Fixture } from '../../test/helpers/fixture.ts';
import { generateAppConf, readHosts } from '../../tools/nginx_gen.ts';

const HOST = 'acme.test';
const out = (s: string): void => process.stdout.write(`${s}\n`);
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

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

interface Res {
  status: number;
  body: Buffer;
  ms: number;
}
function get(port: number, path: string): Promise<Res> {
  const t0 = performance.now();
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: ['127.0.0.1', '127.0.0.1'][0] as string, port, path, headers: { host: HOST } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks), ms: performance.now() - t0 }),
      );
    });
    req.on('error', reject);
    req.end();
  });
}

async function main(): Promise<void> {
  const fixture: Fixture = makeFixture({ specs: [{ key: 'acme', hosts: [HOST], title: 'Acme' }] });
  const tmp = mkdtempSync(join(REPO, '.qa-s3-farm-'));
  const contentRoot = join(tmp, 'content');
  mkdirSync(contentRoot, { recursive: true });

  const handle: AppHandle = await buildApp({ env: loadEnv(fixture.env), contentRoot });
  const appPort = await freePort();
  await handle.app.listen({ port: appPort, host: '0.0.0.0' });

  const db: Database.Database = openAdminWrite(fixture.sitePath('acme'));
  const shade = (v: number): Promise<Buffer> =>
    sharp({ create: { width: 320, height: 240, channels: 3, background: { r: v, g: 20, b: 20 } } })
      .jpeg({ quality: 92 })
      .toBuffer();

  const upload = async (key: string, v: number): Promise<{ id: number; sha: string }> => {
    const r = await uploadAsset({
      db,
      contentRoot,
      tenantKey: 'acme',
      key,
      filename: `${key.replace('/', '-')}.jpg`,
      bytes: await shade(v),
      quotaLimitBytes: 50_000_000,
      accessClass: 'public',
    });
    return { id: r.asset.id, sha: r.asset.sha256 };
  };

  const asset = await upload('campaign/spring', 10);
  db.close();

  // --- nginx ------------------------------------------------------------------------------
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
    .replace(/proxy_pass http:\/\/app:3000;/g, `proxy_pass http://${gateway}:${appPort};`);
  writeFileSync(join(conf, '10-app.conf'), generated);
  writeFileSync(
    join(tmp, 'nginx.conf'),
    [
      'worker_processes 1;',
      'error_log /dev/stderr notice;',
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
  const container = `skw-qa-farm-${process.pid}`;
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
      if ((await get(edgePort, '/healthz').catch(() => null)) !== null) break;
      await new Promise((r) => setTimeout(r, 250));
    }

    // --- R: rename, then request on the next turn of the loop -----------------------------
    //
    // The host's view and the container's view are recorded side by side, because a bind
    // mount is a second filesystem and a 404 from it says nothing about the farm. The
    // question is only a product question when the container can see the link and the URL
    // still fails.
    const statuses = new Map<string, number>();
    const containerSaw = { yes: 0, no: 0 };
    const settleMs: number[] = [];
    let staleBytes = 0;
    let slowest = 0;
    const conn = openAdminWrite(fixture.sitePath('acme'));
    const inContainer = (p: string): boolean =>
      spawnSync('docker', ['exec', container, 'test', '-e', p], { encoding: 'utf8' }).status === 0;
    try {
      for (let i = 0; i < 24; i += 1) {
        const from = i % 2 === 0 ? 'campaign/spring' : 'campaign/summer';
        const to = i % 2 === 0 ? 'campaign/summer' : 'campaign/spring';
        const t0 = performance.now();
        renameAsset(conn, { from, to, contentRoot });
        const renameMs = performance.now() - t0;

        // "1 ms ago": no await between the mutation and the request.
        const [next, old] = await Promise.all([
          get(edgePort, `/media/${to}.jpg`),
          get(edgePort, `/media/${from}.jpg`),
        ]);
        const seen = inContainer(`/srv/content/public/${to}.jpg`);
        containerSaw[seen ? 'yes' : 'no'] += 1;
        slowest = Math.max(slowest, renameMs);
        statuses.set(`new:${next.status}`, (statuses.get(`new:${next.status}`) ?? 0) + 1);
        statuses.set(`old:${old.status}`, (statuses.get(`old:${old.status}`) ?? 0) + 1);
        if (next.status === 200 && sha(next.body) !== asset.sha) staleBytes += 1;
        if (old.status === 200 && sha(old.body) !== asset.sha) staleBytes += 1;

        // How long the edge took to resolve the new URL at all (mount cache, not product).
        const t1 = performance.now();
        let settled = next.status;
        while (settled !== 200 && performance.now() - t1 < 3000) {
          await new Promise((r) => setTimeout(r, 10));
          const again = await get(edgePort, `/media/${to}.jpg`);
          settled = again.status;
          if (settled === 200 && sha(again.body) !== asset.sha) staleBytes += 1;
        }
        settleMs.push(performance.now() - t1);
      }
    } finally {
      conn.close();
    }
    const pct = (p: number): string => {
      const s = [...settleMs].sort((a, b) => a - b);
      return (s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0).toFixed(1);
    };
    out(
      `# D6-R 24 renames, request issued immediately (slowest rename ${slowest.toFixed(2)} ms): ` +
        `${JSON.stringify([...statuses])}, servedBytesNotTheAsset=${staleBytes}`,
    );
    out(
      `# D6-R container could see the new link immediately in ${containerSaw.yes}/24 cases (host always could); ` +
        `edge settled to 200 in p50 ${pct(50)} ms / p95 ${pct(95)} ms / max ${Math.max(...settleMs).toFixed(1)} ms`,
    );

    // --- D: delete, then request on the next turn of the loop ----------------------------
    const del = new Map<number, number>();
    let deletedBytes = 0;
    const conn2 = openAdminWrite(fixture.sitePath('acme'));
    try {
      for (let i = 0; i < 12; i += 1) {
        const key = `gone/a${i}`;
        const made = await uploadAsset({
          db: conn2,
          contentRoot,
          tenantKey: 'acme',
          key,
          filename: `a${i}.jpg`,
          bytes: await shade(40 + i),
          quotaLimitBytes: 50_000_000,
          accessClass: 'public',
        });
        // A rename first, so an alias row exists and the delete has something to cascade.
        renameAsset(conn2, { from: key, to: `gone/b${i}`, contentRoot });
        deleteAsset(conn2, `gone/b${i}`, { contentRoot });
        const r = await get(edgePort, `/media/gone/b${i}.jpg`);
        del.set(r.status, (del.get(r.status) ?? 0) + 1);
        if (r.status === 200) deletedBytes += r.body.length;
      }
    } finally {
      conn2.close();
    }
    out(`# D6-D 12 deletes (each after a rename), request issued immediately: ${JSON.stringify([...del])}, bytesServedAfterDelete=${deletedBytes}`);

    // --- the error log: a 500 is a server-side statement, not a client one ---------------
    const logs = spawnSync('docker', ['logs', container], { encoding: 'utf8' });
    const errText = `${logs.stdout}${logs.stderr}`;
    const fiveHundreds = (errText.match(/ 500 /g) ?? []).length;
    const openFailed = (errText.match(/open\(\) .*failed/g) ?? []).length;
    out(`# D6 log: ' 500 ' occurrences=${fiveHundreds}, 'open() … failed' occurrences=${openFailed}`);
    const interesting = errText
      .split('\n')
      .filter((l) => /emerg|crit|\[error\]/.test(l))
      .slice(0, 6);
    for (const line of interesting) out(`# D6 log: ${line.trim().slice(0, 200)}`);
  } finally {
    spawnSync('docker', ['rm', '-f', container], { encoding: 'utf8' });
    await handle.close();
    rmSync(tmp, { recursive: true, force: true });
    fixture.cleanup();
  }
}

main().catch((err) => {
  out(`# PROBE FAILED: ${String(err)}`);
  process.exitCode = 1;
});
