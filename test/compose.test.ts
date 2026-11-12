/**
 * §16 S1 gate (E-31/D36): "compose has exactly **3** services — `nginx`, `app`, `acme` —
 * and `app` publishes no port — `docker compose config` assertion" (§12.1, §13.3.9).
 *
 * The old row — "compose has exactly 4 services" — is **withdrawn, not passed**: there is
 * no fourth container to run. The assertion that used to count `plugin-runner` now asserts
 * its *absence* by name, because a service that comes back is the regression this row exists
 * to catch, and `deepEqual` on a three-name list catches it only as "4 != 3".
 */
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

import { REPO } from './helpers/fixture.ts';

function composeConfig(): { status: number | null; json: any; stderr: string } {
  const res = spawnSync(
    'docker',
    ['compose', '--env-file', '.env.example', 'config', '--format', 'json'],
    { cwd: REPO, encoding: 'utf8' },
  );
  let json: unknown = undefined;
  try {
    json = JSON.parse(res.stdout);
  } catch {
    json = undefined;
  }
  return { status: res.status, json, stderr: res.stderr };
}

const result = composeConfig();

test('docker compose config parses the file', () => {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(typeof result.json, 'object');
});

test('exactly three services — nginx, app, acme — and plugin-runner is absent by name', () => {
  assert.deepEqual(Object.keys(result.json.services).sort(), ['acme', 'app', 'nginx']);
  // E-31: the fourth service is deleted, not renamed, not "deferred". A compose file that
  // reintroduces it fails here even if the count still happened to read 3 (a removal plus an
  // addition), which the list comparison alone could not see.
  assert.equal(
    result.json.services['plugin-runner'],
    undefined,
    'plugin-runner must not exist: D36 removed the process boundary (§13.3.9)',
  );
});

test('app publishes no port', () => {
  const app = result.json.services.app;
  assert.equal(app.ports, undefined, 'app must not publish a port (C-11)');
  assert.deepEqual(app.expose, ['3000']);
});

test('nginx is the only service with published ports, and it publishes 80 and 443', () => {
  const published = Object.entries(result.json.services)
    .filter(([, svc]: [string, any]) => Array.isArray(svc.ports) && svc.ports.length > 0)
    .map(([name]) => name);
  assert.deepEqual(published, ['nginx']);
  assert.deepEqual(
    result.json.services.nginx.ports.map((p: any) => `${p.published}:${p.target}`).sort(),
    ['443:443', '80:80'],
  );
});

test('app runs read-only with a tmpfs /tmp and only its data volumes (§12.2, E-31)', () => {
  const app = result.json.services.app;
  assert.equal(app.read_only, true);
  assert.ok(Array.isArray(app.tmpfs) && app.tmpfs.some((t: string) => t.startsWith('/tmp')));
  const targets = app.volumes.map((v: any) => v.target).sort();
  // `/srv/run` held `plugin.sock`. With the socket deleted (§13.3.9) the mount is deleted
  // too: a directory mounted for a file that is never created is a place a future builder
  // puts a second boundary without noticing this design has none.
  //
  // `/srv/skunkworks-sites` is the sites repository, and it is a *data* mount, not a second
  // boundary: a site's tenant data lives beside its sources (sources and state travel
  // together, so a site can leave the platform without an export), and `/srv/data/tenants/<key>`
  // reaches it through a relative symlink. Everything else E-31 asks for still holds — the
  // root filesystem stays read-only, /tmp stays a tmpfs, and nothing else is mounted.
  assert.deepEqual(targets, ['/srv/content', '/srv/data', '/srv/skunkworks-sites']);
});

test('app gets SKW_DATA_DIR and UV_THREADPOOL_SIZE=8, and no legacy prefix', () => {
  const env = result.json.services.app.environment;
  assert.equal(env.SKW_DATA_DIR, '/srv/data');
  assert.equal(env.UV_THREADPOOL_SIZE, '8');
  for (const key of Object.keys(env)) {
    assert.doesNotMatch(key, /^SK_|^SKUNK_/, `legacy env name ${key} in compose`);
  }
});

test('there is no migrate service (app migrates itself, C-10)', () => {
  assert.equal(result.json.services.migrate, undefined);
});
