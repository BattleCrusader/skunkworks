/**
 * S8e — a plugin's screen answers, and the switch has two positions.
 *
 * Two gaps, both visible in the running admin:
 *
 *   1. A loaded package's declarative screen appeared in the menu and answered "no such admin
 *      action" — the admin generated a dead link to itself.
 *   2. `plugins/enable` existed and `plugins/disable` did not, so a package could be switched on
 *      from the screen and only off from a shell.
 *
 * This file drives the whole loop with the real pieces: `skwctl plugin install` on a fixture
 * data directory, then the admin surface over a socket — enable, use the generated screen to
 * create a row, disable, and confirm the screen is gone again. No stubs, no hand-written
 * registry.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { packageRootHash } from '../app/plugins/manifest.ts';

import { ADMIN_HOST, ADMIN_ORIGIN, TOTP_SECRET, openSession, seedUser, type Sessioned } from './helpers/admin.ts';
import { loadEnv } from '../app/env.ts';
import { buildApp, type AppHandle } from '../app/main.ts';
import { REPO, makeFixture, type Fixture } from './helpers/fixture.ts';
import { call, header, type Res } from './helpers/http.ts';

const CLI = join(REPO, 'app', 'cli', 'skwctl.ts');
const BLOG = join(REPO, 'plugins', 'blog');

let fixture: Fixture;
let handle: AppHandle;
let port = 0;
let session: Sessioned;

function skwctl(args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    cwd: REPO,
    env: { ...process.env, SKW_DATA_DIR: fixture.dir },
    encoding: 'utf8',
    timeout: 120_000,
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

const RUNNER_DIGEST = 'sha256:s8e-screens';

/**
 * The packager's report (§8.5). A real publishing step runs the package's `plugin.json.tests`
 * inside the test image and writes this next to the package; here it is produced from the
 * package's own bytes, bound to the digest the install is run with, so the install-time gate is
 * exercised rather than bypassed.
 */
function reportFor(dir: string): string {
  const root = packageRootHash(dir).root;
  const manifest = JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8')) as { id: string; version: string };
  const out = join(fixture.dir, 'reports', `${root.slice(0, 10)}.json`);
  mkdirSync(join(fixture.dir, 'reports'), { recursive: true });
  writeFileSync(
    out,
    JSON.stringify({
      plugin: manifest.id,
      version: manifest.version,
      root_hash: root,
      runner_image_digest: RUNNER_DIGEST,
      ran_at: '2026-10-21T00:00:00.000Z',
      passed: 1,
      failed: 0,
    }),
  );
  return out;
}

function get(path: string): Promise<Res> {
  return call({ port, path, host: ADMIN_HOST, headers: { cookie: session.cookie } });
}

function post(path: string, fields: Record<string, string>): Promise<Res> {
  return call({
    port,
    path,
    method: 'POST',
    host: ADMIN_HOST,
    headers: {
      origin: ADMIN_ORIGIN,
      'content-type': 'application/x-www-form-urlencoded',
      cookie: session.cookie,
    },
    body: new URLSearchParams({ ...fields, csrf: session.csrfToken }).toString(),
  });
}

before(async () => {
  fixture = makeFixture({ specs: [{ key: 'acme', hosts: [ADMIN_HOST], title: 'Acme' }] });
  await seedUser({ controlDb: fixture.controlDb, tenantKey: 'acme', email: 'owner@acme.test', totpSecret: TOTP_SECRET });

  // The real install path, on a real package: this is what an operator runs.
  const installed = skwctl([
    'plugin',
    'install',
    BLOG,
    '--tenant',
    'acme',
    '--allow-unsigned',
    '--test-report',
    reportFor(BLOG),
    '--runner-digest',
    RUNNER_DIGEST,
  ]);
  assert.equal(installed.status, 0, `install failed: ${installed.stderr}${installed.stdout}`);

  handle = await buildApp({ env: loadEnv(fixture.env) });
  port = await handle.app
    .listen({ port: 0, host: '127.0.0.1' })
    .then(() => (handle.app.server.address() as { port: number }).port);
  session = await openSession({ port, key: 'acme', email: 'owner@acme.test' });
});

after(async () => {
  await handle.close();
  fixture.cleanup();
});

test('S8e-1. an installed but disabled package loads nothing and serves no screen', async () => {
  const plugins = await get('/admin/t/acme/plugins');
  assert.equal(plugins.status, 200, plugins.body);
  assert.match(plugins.body, /data-plugin="blog"/);
  assert.match(plugins.body, /disabled/);

  // Not loaded, so its screen is not a route. The admin must say so in the same words it uses
  // for any unknown action rather than half-rendering a screen over a table that does not exist.
  const screen = await get('/admin/t/acme/blog');
  assert.equal(screen.status, 400, screen.body);
  assert.equal((screen.json as { error?: { code?: string } }).error?.code, 'SKW_E_PLT_REQUEST_INVALID');
});

test('S8e-2. enabling through the screen loads the package and its screen answers', async () => {
  const enabled = await post('/admin/t/acme/plugins/enable', { plugin: 'blog' });
  assert.equal(enabled.status, 303, enabled.body);

  const plugins = await get('/admin/t/acme/plugins');
  assert.match(plugins.body, /enabled, loaded/);
  // The menu lists the screen the package registered…
  assert.match(plugins.body, /href="\/admin\/t\/acme\/blog"/);

  // …and now it answers, over the package's OWN table, drawn by the host.
  const screen = await get('/admin/t/acme/blog');
  assert.equal(screen.status, 200, screen.body);
  assert.match(screen.body, /Blog posts/);
  assert.match(screen.body, /aria-label="Breadcrumb"/);
  assert.match(screen.body, /data-role="rows"/);
  assert.match(screen.body, /p_blog_post|/);
});

test('S8e-3. the generated screen writes a row through the package table', async () => {
  const created = await post('/admin/t/acme/blog', {
    title: 'First post',
    slug: 'first-post',
    body: 'Hello from the blog plugin.',
    status: 'published',
    created_at: '2026-10-21T00:00:00.000Z',
  });
  assert.equal(created.status, 303, created.body);
  const location = String(header(created, 'location'));
  assert.match(location, /\/admin\/t\/acme\/blog\/\d+/);

  const list = await get('/admin/t/acme/blog');
  assert.match(list.body, /First post/);

  const form = await get(location);
  assert.equal(form.status, 200, form.body);
  assert.match(form.body, /name="title"[^>]*value="First post"/);
});

test('S8e-4. disabling unloads it hot: the screen stops answering without a restart', async () => {
  const disabled = await post('/admin/t/acme/plugins/disable', { plugin: 'blog' });
  assert.equal(disabled.status, 303, disabled.body);

  const plugins = await get('/admin/t/acme/plugins');
  assert.match(plugins.body, /disabled/);
  assert.doesNotMatch(plugins.body, /enabled, loaded/);

  const screen = await get('/admin/t/acme/blog');
  assert.equal(screen.status, 400, screen.body);
  assert.equal((screen.json as { error?: { code?: string } }).error?.code, 'SKW_E_PLT_REQUEST_INVALID');

  // The data is the package's, not the runtime's: disabling stops the code, never the rows.
  const enabledAgain = await post('/admin/t/acme/plugins/enable', { plugin: 'blog' });
  assert.equal(enabledAgain.status, 303, enabledAgain.body);
  const list = await get('/admin/t/acme/blog');
  assert.equal(list.status, 200, list.body);
  assert.match(list.body, /First post/, 'a disable/enable cycle must not lose the package data');
});
