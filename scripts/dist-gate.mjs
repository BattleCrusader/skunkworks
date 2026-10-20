#!/usr/bin/env node
/**
 * `make verify-dist` — **the gate that executes the artefact that ships** (E-28).
 *
 * Every other code-executing gate in this tree imports the TypeScript modules under
 * Node's type stripping. Under type stripping `import.meta.url` ends in `.ts`, so a
 * resolver like
 * `stampWorkerUrl` finds `stamp-worker.ts` and every test passes — while the same line in
 * `dist/app/download/render.js` names a file that does not exist, every stamp throws, and
 * every paying download is a 503. That happened (S3d report §2.10) with 404/404 green.
 *
 * This gate builds nothing (the `verify-dist` target depends on `build`) and imports no
 * `app/*.ts`. It runs `dist/` as a child process and asserts on what comes out:
 *
 *   D1  `node dist/app/main.js` boots and answers `/healthz` 200 within 15 s
 *   D2  `GET /` renders a page — the Astro entry is reached only on a page render
 *   D3  one redemption end to end: 303 + cookie, then 200 with
 *       `x-accel-redirect: /__protected/wm/…`, the named file exists and is not the blob
 *   D4  `node dist/app/db/migrate.js --tenant all` exits 0 and reaches the schema version
 *   D5  `node dist/app/cli/skwctl.js admin bootstrap` exits 0 and writes a 0600 file
 *   D6  `node dist/tools/nginx_gen.js` reproduces the committed `nginx/conf.d/10-app.conf`
 *
 * The fixture is built **by this process, from source** (`test/helpers/fixture.ts`,
 * `app/assets/library.ts`): the app under test is `dist/`, which is the only thing D1–D6
 * relax. The gate never reads or writes `data/` or `content/`.
 *
 * E-28's rule: a path computed at runtime from `import.meta.url`, `process.argv[1]`,
 * `process.cwd()` or `require.resolve` must be proved here or listed in `DIST_EXEMPT` in
 * `test/dist-witness.ts`. There is no third option.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { PDFDocument, StandardFonts } from 'pdf-lib';

import { uploadAsset } from '../app/assets/library.ts';
import { issueCode, seedSettings } from '../app/download/code.ts';
import { openAdminWrite } from '../app/db/classes.ts';
import { makeFixture } from '../test/helpers/fixture.ts';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const NODE = process.execPath;
const D1_BOOT_MS = 15_000;

const scratch = mkdtempSync(join(tmpdir(), 'skw-dist-'));
const fixtures = [];
process.on('exit', () => {
  for (const fixture of fixtures) {
    try {
      fixture.cleanup();
    } catch {
      // a fixture that is already gone is the postcondition
    }
  }
  rmSync(scratch, { recursive: true, force: true });
});

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One HTTP request with an explicit Host — `fetch` refuses to set one, and Host is the tenant. */
function http(port, path, opts = {}) {
  return new Promise((resolve, reject) => {
    const headers = { ...(opts.headers ?? {}) };
    if (opts.host !== undefined) headers.host = opts.host;
    if (opts.body !== undefined) headers['content-length'] = String(Buffer.byteLength(opts.body));
    const req = httpRequest(
      { host: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers, timeout: 20_000 },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('timeout', () => req.destroy(new Error(`no response from :${port}${path} in 20 s`)));
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

async function freePort() {
  const { createServer } = await import('node:net');
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/** A child process we can kill, with its output kept for the failure message. */
function run(command, args, env, timeoutMs = 30_000) {
  return spawnSync(command, args, {
    cwd: REPO,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: timeoutMs,
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// ---------------------------------------------------------------------------------
// the fixture — built here, from source, so `dist/` is the only thing on trial
// ---------------------------------------------------------------------------------

function makeGateFixture() {
  const fixture = makeFixture({ specs: [{ key: 'acme', hosts: ['acme.test'], title: 'Acme' }] });
  fixtures.push(fixture);
  const site = new Database(fixture.sitePath('acme'));
  try {
    site
      .prepare(
        `INSERT INTO cms_page (path, slug, title, status, template, body_html, published_at)
         VALUES ('/', 'home', 'Acme home', 'published', 'page', '<h1>Acme home</h1><p>verify-dist</p>', '2026-01-01T00:00:00.000Z')`,
      )
      .run();
  } finally {
    site.close();
  }
  return fixture;
}

async function makePdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 2; i += 1) {
    doc.addPage([612, 792]).drawText(`verify-dist page ${i + 1}`, { x: 72, y: 700, size: 14, font });
  }
  return Buffer.from(await doc.save());
}

/** The gated asset and its code, written through the real store and the real issuer. */
async function seedGatedAsset(fixture) {
  const contentRoot = join(fixture.dir, 'content');
  mkdirSync(join(contentRoot, 'media'), { recursive: true });
  const bytes = await makePdf();
  const db = openAdminWrite(fixture.sitePath('acme'));
  try {
    // Boot seeds these (§2.3 step 5); the gate seeds them because it mints a code before
    // the app under test has ever started.
    seedSettings(db);
    const uploaded = await uploadAsset({
      db,
      contentRoot,
      tenantKey: 'acme',
      key: 'vault/book',
      filename: 'book.pdf',
      bytes,
      quotaLimitBytes: 50_000_000,
      accessClass: 'gated',
    });
    const issued = await issueCode({ db, contentRoot, assetKey: 'vault/book', email: 'dist@example.com', orderRef: 'ORD-DIST-1' });
    return { contentRoot, code: issued.code, blobSha: uploaded.asset.sha256, blobPath: uploaded.asset.storage_path };
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------------
// the six assertions
// ---------------------------------------------------------------------------------

const SITES = [];

async function d1() {
  // `isMain` (app/main.ts), `schemaDirFrom`/`findProjectRoot` (app/main.ts, app/db/migrate.ts)
  // — the boot path, in the layout the image has: `dist/` beside `schema/` and `build/`.
  const fixture = makeGateFixture();
  const port = await freePort();
  const child = spawn(NODE, ['dist/app/main.js'], {
    cwd: REPO,
    env: { ...process.env, ...fixture.env, PORT: String(port), NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    output += String(chunk);
  });
  let exited = null;
  child.on('exit', (code) => {
    exited = code;
  });

  const deadline = Date.now() + D1_BOOT_MS;
  let health = null;
  try {
    while (Date.now() < deadline) {
      if (exited !== null) throw new Error(`dist/app/main.js exited ${exited} before /healthz:\n${output}`);
      try {
        health = await http(port, '/healthz');
        if (health.status === 200) break;
      } catch {
        // not listening yet
      }
      await sleep(100);
    }
    assert(health !== null && health.status === 200, `no /healthz 200 within ${D1_BOOT_MS} ms:\n${output}`);
    const body = JSON.parse(health.body);
    assert(body.build === 'test-build', `healthz build was ${JSON.stringify(body.build)}`);
    return `:${port} /healthz 200 (build ${body.build}) in ${D1_BOOT_MS - Math.max(0, deadline - Date.now())} ms`;
  } finally {
    child.kill('SIGTERM');
    await sleep(150);
    if (exited === null) child.kill('SIGKILL');
  }
}

async function d2() {
  // `astroHandler`'s `build/astro/server/entry.mjs` (app/main.ts) — reached only on a page
  // render, never by `/healthz`.
  const fixture = makeGateFixture();
  const port = await freePort();
  const child = spawn(NODE, ['dist/app/main.js'], {
    cwd: REPO,
    env: { ...process.env, ...fixture.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    output += String(chunk);
  });
  let exited = null;
  child.on('exit', (code) => {
    exited = code;
  });
  try {
    const deadline = Date.now() + D1_BOOT_MS;
    let up = false;
    while (Date.now() < deadline && !up) {
      if (exited !== null) throw new Error(`dist/app/main.js exited ${exited}:\n${output}`);
      try {
        up = (await http(port, '/healthz')).status === 200;
      } catch {
        await sleep(100);
      }
    }
    assert(up, `the app did not come up:\n${output}`);
    const page = await http(port, '/', { host: 'acme.test' });
    assert(page.status === 200, `GET / -> ${page.status}:\n${page.body.slice(0, 400)}\n${output}`);
    assert(/text\/html/.test(String(page.headers['content-type'])), `content-type was ${String(page.headers['content-type'])}`);
    assert(page.body.includes('Acme home'), `the rendered page does not carry its own body:\n${page.body.slice(0, 400)}`);
    return `GET / -> 200 ${String(page.headers['content-type'])}, ${page.body.length} B, title rendered`;
  } finally {
    child.kill('SIGTERM');
    await sleep(150);
    if (exited === null) child.kill('SIGKILL');
  }
}

async function d3() {
  // `stampWorkerUrl` (app/download/render.ts) and `new Worker(…)` — the defect of §2.10, and
  // the only assertion in the tree that a `.ts`-only resolver reddens. The harness is the
  // built `buildApp` with a writable content root; `node dist/app/main.js` hard-codes
  // `/srv/content`, which a gate may not write.
  const fixture = makeGateFixture();
  const seeded = await seedGatedAsset(fixture);
  const port = await freePort();
  const child = spawn(
    NODE,
    ['scripts/dist-app-harness.mjs', '--content-root', seeded.contentRoot, '--port', String(port)],
    { cwd: REPO, env: { ...process.env, ...fixture.env }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    output += String(chunk);
  });
  let exited = null;
  child.on('exit', (code) => {
    exited = code;
  });
  try {
    const deadline = Date.now() + D1_BOOT_MS;
    let up = false;
    while (Date.now() < deadline && !up) {
      if (exited !== null) throw new Error(`the harness exited ${exited}:\n${output}`);
      try {
        up = (await http(port, '/healthz')).status === 200;
      } catch {
        await sleep(100);
      }
    }
    assert(up, `the harness did not come up:\n${output}`);

    const redeemed = await http(port, '/d/acme', {
      method: 'POST',
      host: 'acme.test',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: seeded.code }),
    });
    assert(redeemed.status === 303, `POST /d/acme -> ${redeemed.status}:\n${redeemed.body}\n${output}`);
    const setCookie = String(redeemed.headers['set-cookie'] ?? '');
    assert(setCookie.startsWith('__Host-sk-dl-acme='), `set-cookie was ${setCookie.slice(0, 60)}`);
    const cookie = setCookie.slice(0, setCookie.indexOf(';'));

    const file = await http(port, '/d/acme/file', { host: 'acme.test', headers: { cookie } });
    assert(file.status === 200, `GET /d/acme/file -> ${file.status}:\n${file.body}\n${output}`);
    const uri = String(file.headers['x-accel-redirect'] ?? '');
    assert(/^\/__protected\/wm\/[0-9a-f]{64}\/[0-9a-f]{64}\.pdf$/.test(uri), `x-accel-redirect was ${JSON.stringify(uri)}`);
    assert(!uri.includes('/media/'), 'the hand-off must not be the shared blob');

    const onDisk = join(seeded.contentRoot, 'protected', uri.slice('/__protected/'.length));
    assert(existsSync(onDisk), `the handed-off path does not exist: ${onDisk}`);
    const renderSha = sha256(readFileSync(onDisk));
    assert(renderSha !== seeded.blobSha, 'the handed-off file is the source blob, not a render');
    assert(statSync(onDisk).size > 0, 'the render is empty');
    // §7.5: the render's row is what the sweep and the hand-off both trust.
    const site = new Database(fixture.sitePath('acme'));
    try {
      const row = site.prepare(`SELECT path, bytes FROM cms_watermark_render`).get();
      assert(row !== undefined, 'no cms_watermark_render row was written');
      assert(row.path === `content/protected${uri.slice('/__protected'.length)}`, `the row names ${row.path}`);
      assert(Number(row.bytes) === statSync(onDisk).size, 'the row\'s byte count is not the file\'s');
    } finally {
      site.close();
    }
    return `303 -> 200, x-accel ${uri.slice(0, 34)}…, ${statSync(onDisk).size} B, render != blob (${renderSha.slice(0, 8)})`;
  } finally {
    child.kill('SIGTERM');
    await sleep(150);
    if (exited === null) child.kill('SIGKILL');
  }
}

function d4() {
  // `migrate.ts`'s `isMain` — the command `npm run migrate` ships. A fixture with no
  // `site.db` at all, so the command has to create one from `schema/site.sql`; a wrong
  // schema root would fail here and nowhere else.
  const fixture = makeFixture({
    specs: [{ key: 'acme', hosts: ['acme.test'], title: 'Acme' }],
    createSiteDbs: false,
  });
  fixtures.push(fixture);
  const result = run(NODE, ['dist/app/db/migrate.js', '--tenant', 'all', '--data-dir', fixture.dir], {});
  assert(result.status === 0, `migrate exited ${result.status}:\n${result.stdout}\n${result.stderr}`);
  const sitePath = fixture.sitePath('acme');
  assert(existsSync(sitePath), 'migrate did not create tenants/acme/site.db');
  const site = new Database(sitePath);
  let version;
  try {
    version = Number(site.pragma('user_version', { simple: true }));
  } finally {
    site.close();
  }
  assert(version === 3, `tenants/acme/site.db is at user_version ${version}, expected 3`);
  return `--tenant all exit 0, tenants/acme/site.db at user_version ${version}`;
}

function d5() {
  // `skwctl.ts`'s `isMain` — the command `install.sh` runs, on the one box where nobody is
  // watching. 0600 is the contract (`docs/sdd` §O-?): the file holds a TOTP secret.
  const fixture = makeFixture({ specs: [{ key: 'acme', hosts: ['acme.test'], title: 'Acme' }] });
  fixtures.push(fixture);
  const out = join(scratch, 'enrolment.txt');
  const result = run(NODE, ['dist/app/cli/skwctl.js', 'admin', 'bootstrap', '--enrolment-out', out], fixture.env);
  assert(result.status === 0, `skwctl exited ${result.status}:\n${result.stdout}\n${result.stderr}`);
  assert(existsSync(out), 'skwctl wrote no enrolment file');
  const mode = statSync(out).mode & 0o777;
  assert(mode === 0o600, `the enrolment file is mode ${mode.toString(8)}, expected 600`);
  const text = readFileSync(out, 'utf8');
  assert(/^Email: /m.test(text) || /email/i.test(text), `the enrolment file has no email line:\n${text}`);
  assert(/^Secret: /m.test(text) || /secret/i.test(text), 'the enrolment file has no secret line');
  return `admin bootstrap exit 0, ${out.replace(scratch, '<scratch>')} mode 0600`;
}

function d6() {
  // `nginx_gen.ts`'s `isMain` — the command `test/nginx-config.test.ts:188` names in its
  // failure message and no gate has ever run. Byte-compared with the committed conf: the
  // file in the repo is the generator's output, or the repo is lying.
  const fixture = makeFixture(); // DEFAULT_SPECS: the fixture the committed conf was built from
  fixtures.push(fixture);
  const out = join(scratch, '10-app.conf');
  const result = run(NODE, ['dist/tools/nginx_gen.js', '--data-dir', fixture.dir, '--out', out], {
    ...fixture.env,
    SKW_DATA_DIR: fixture.dir,
  });
  assert(result.status === 0, `nginx_gen exited ${result.status}:\n${result.stdout}\n${result.stderr}`);
  const generated = readFileSync(out, 'utf8');
  const committed = readFileSync(join(REPO, 'nginx', 'conf.d', '10-app.conf'), 'utf8');
  assert(
    generated === committed,
    `the committed nginx/conf.d/10-app.conf is not dist/tools/nginx_gen.js's output ` +
      `(${generated.length} B vs ${committed.length} B); regenerate it`,
  );
  return `${generated.split('\n').length} lines, byte-identical to nginx/conf.d/10-app.conf`;
}

const CHECKS = [
  ['D1', 'boot — node dist/app/main.js answers /healthz', d1],
  ['D2', 'page render — GET / reaches build/astro/server/entry.mjs', d2],
  ['D3', 'the download — one redemption to a stamped file under content/protected/wm/', d3],
  ['D4', 'migrate — node dist/app/db/migrate.js --tenant all', d4],
  ['D5', 'skwctl — node dist/app/cli/skwctl.js admin bootstrap', d5],
  ['D6', 'nginx_gen — node dist/tools/nginx_gen.js against the committed conf', d6],
];

let failed = 0;
process.stdout.write(`verify-dist: executing dist/ as a child process (E-28)\n`);
for (const [id, site, fn] of CHECKS) {
  const started = Date.now();
  try {
    const detail = await fn();
    process.stdout.write(`ok   ${id}  ${site}\n          ${detail} (${Date.now() - started} ms)\n`);
  } catch (err) {
    failed += 1;
    process.stdout.write(`FAIL ${id}  ${site}\n          ${String(err && err.message ? err.message : err).split('\n').join('\n          ')}\n`);
  }
}

if (failed > 0) {
  process.stdout.write(`verify-dist: ${failed} of ${CHECKS.length} failed — the artefact is not proved\n`);
  process.exit(1);
}
process.stdout.write(`verify-dist: ${CHECKS.length}/6 passed — the artefact on disk is the one asserted\n`);
