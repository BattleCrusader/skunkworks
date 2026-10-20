/**
 * §16 S1 gate: "compose has exactly 4 services; app publishes no port —
 * docker compose config assertion" (§12.1, C-8, C-11).
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

test('exactly four services, named as the SDS names them', () => {
  assert.deepEqual(Object.keys(result.json.services).sort(), ['acme', 'app', 'nginx', 'plugin-runner']);
});

test('app publishes no port', () => {
  const app = result.json.services.app;
  assert.equal(app.ports, undefined, 'app must not publish a port (C-11)');
  assert.deepEqual(app.expose, ['3000']);
});

test('plugin-runner has no network and drops every capability', () => {
  const runner = result.json.services['plugin-runner'];
  assert.equal(runner.network_mode, 'none');
  assert.equal(runner.read_only, true);
  assert.deepEqual(runner.cap_drop, ['ALL']);
  assert.equal(runner.pids_limit, 64);
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

test('app runs read-only with a tmpfs /tmp and the three volumes (§12.2)', () => {
  const app = result.json.services.app;
  assert.equal(app.read_only, true);
  assert.ok(Array.isArray(app.tmpfs) && app.tmpfs.some((t: string) => t.startsWith('/tmp')));
  const targets = app.volumes.map((v: any) => v.target).sort();
  assert.deepEqual(targets, ['/srv/content', '/srv/data', '/srv/run']);
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
