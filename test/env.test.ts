/**
 * §16 S1 gate: "boot refuses any ^SK_|^SKUNK_ env key, naming it — env test".
 * §4.3: "the process refuses to start when any environment key matching
 * ^SK_|^SKUNK_ exists, printing the offending key and its replacement".
 */
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

import { BootRefusal, loadEnv } from '../app/env.ts';
import { REPO, makeFixture } from './helpers/fixture.ts';

const CLEAN: Record<string, string> = {
  SKW_DATA_DIR: '/tmp/skw-env-test',
  SKW_EDGE_TOKEN: 'edge',
  SKW_SESSION_KEY: 'session',
  SKW_DOWNLOAD_TOKEN_KEY: 'download',
  SKW_IP_HASH_KEY: 'ip',
  SKW_ADMIN_ORIGIN: 'https://admin.skw.test',
  SKW_BUILD_ID: 'test',
  SKW_ARGON2_MAX_CONCURRENT: '4',
  UV_THREADPOOL_SIZE: '8',
};

test('a deleted SKUNK_ key refuses the boot and names both the key and its replacement', () => {
  assert.throws(
    () => loadEnv({ ...CLEAN, SKUNK_EDGE_TOKEN: 'x' }),
    (err: unknown) => {
      assert.ok(err instanceof BootRefusal);
      assert.match(err.message, /SKUNK_EDGE_TOKEN/);
      assert.match(err.message, /SKW_EDGE_TOKEN/);
      return true;
    },
  );
});

test('a deleted SK_ key refuses the boot and names it', () => {
  assert.throws(
    () => loadEnv({ ...CLEAN, SK_IP_HASH_KEY: 'x' }),
    (err: unknown) => {
      assert.ok(err instanceof BootRefusal);
      assert.match(err.message, /\^SK_\|\^SKUNK_/);
      assert.match(err.message, /SK_IP_HASH_KEY/);
      return true;
    },
  );
});

test('the refusal lists every offending key, sorted, each with its replacement', () => {
  try {
    loadEnv({ ...CLEAN, SKUNK_MODE: '0', SK_DDL_MAX_STATEMENTS: '8' });
    assert.fail('expected a BootRefusal');
  } catch (err) {
    const message = (err as Error).message;
    const lines = message.split('\n').filter((l) => l.includes('->'));
    assert.deepEqual(lines, [
      'SKUNK_MODE -> SKW_FLEET_MODE',
      'SK_DDL_MAX_STATEMENTS -> SKW_DDL_MAX_STATEMENTS',
    ]);
  }
});

test('a missing required key refuses the boot, naming it', () => {
  const withoutBuild = { ...CLEAN };
  delete withoutBuild.SKW_BUILD_ID;
  assert.throws(
    () => loadEnv(withoutBuild),
    (err: unknown) => err instanceof BootRefusal && /SKW_BUILD_ID/.test(err.message),
  );
});

test('UV_THREADPOOL_SIZE must be 8 (§2.3 step 2)', () => {
  const wrong = { ...CLEAN, UV_THREADPOOL_SIZE: '4' };
  assert.throws(
    () => loadEnv(wrong),
    (err: unknown) => err instanceof BootRefusal && /UV_THREADPOOL_SIZE must be 8/.test(err.message),
  );
  const absent = { ...CLEAN };
  delete absent.UV_THREADPOOL_SIZE;
  assert.throws(
    () => loadEnv(absent),
    (err: unknown) => err instanceof BootRefusal && /UV_THREADPOOL_SIZE must be 8/.test(err.message),
  );
});

test('SKW_ARGON2_MAX_CONCURRENT must be 4 (§2.3 step 2, C-6)', () => {
  assert.throws(
    () => loadEnv({ ...CLEAN, SKW_ARGON2_MAX_CONCURRENT: '8' }),
    (err: unknown) => err instanceof BootRefusal && /SKW_ARGON2_MAX_CONCURRENT must be 4/.test(err.message),
  );
});

test('the real process refuses to start and exits non-zero, naming the key on stderr', () => {
  const fixture = makeFixture();
  try {
    const res = spawnSync(process.execPath, [join(REPO, 'app', 'main.ts')], {
      cwd: REPO,
      encoding: 'utf8',
      env: { ...process.env, ...fixture.env, SKUNK_EDGE_TOKEN: 'legacy-value' },
    });
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /SKUNK_EDGE_TOKEN/);
    assert.match(res.stderr, /SKW_EDGE_TOKEN/);
    assert.equal(res.stdout.includes('listening'), false);
  } finally {
    fixture.cleanup();
  }
});

test('the real process boots clean env, then stops at the DB it was given', async () => {
  // No SKW_DATA_DIR is created, so boot reaches step 3 and fails there — the
  // point is that the env gate did not fire.
  const res = spawnSync(process.execPath, [join(REPO, 'app', 'main.ts')], {
    cwd: REPO,
    encoding: 'utf8',
    env: { ...process.env, ...CLEAN, SKW_DATA_DIR: '/tmp/skw-env-test-does-not-exist' },
    timeout: 20_000,
  });
  assert.doesNotMatch(res.stderr, /deleted environment prefix/);
});
