/**
 * E-17 — §9.1a's IP allowlist: **one name, one parser, enforced at the edge**.
 *
 * These tests are the ones E-17 names, plus the structural half the acceptance
 * criteria demand: the parser is *literally one module*, imported by both
 * `app/env.ts` (the app) and `tools/nginx_gen.ts` (the edge). A copy would pass
 * every behavioural case below and still be two answers to "is this value
 * usable" — which is the defect E-17 exists to remove.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { AllowlistParseError, parseAdminAllowlist } from '../app/admin/allowlist.ts';
import { Auth } from '../app/admin/auth.ts';
import { idleMsFor, IDLE_MS_NO_ALLOWLIST, IDLE_MS_WITH_ALLOWLIST } from '../app/admin/session.ts';
import { SKW_NAMES, loadEnv } from '../app/env.ts';
import { generateAppConf } from '../tools/nginx_gen.ts';
import { REPO, makeFixture } from './helpers/fixture.ts';

const CLEAN: Record<string, string> = {
  SKW_DATA_DIR: '/tmp/skw-allowlist-test',
  SKW_EDGE_TOKEN: 'edge',
  SKW_SESSION_KEY: 'session',
  SKW_DOWNLOAD_TOKEN_KEY: 'download',
  SKW_IP_HASH_KEY: 'ip',
  SKW_ADMIN_ORIGIN: 'https://admin.skw.test',
  SKW_BUILD_ID: 'test',
  SKW_ARGON2_MAX_CONCURRENT: '4',
  UV_THREADPOOL_SIZE: '8',
};

const rows = [
  { host: 'acme.test', key: 'acme', cert_state: 'issued' },
  { host: 'beta.test', key: 'beta', cert_state: 'issued' },
];

// --- E-17's six parsing cases ---------------------------------------------

test('E-17.1 unset -> empty, which is the exported-bundle value', () => {
  assert.deepEqual(parseAdminAllowlist(undefined), []);
});

test('E-17.2 "" -> empty', () => {
  assert.deepEqual(parseAdminAllowlist(''), []);
});

test('E-17.3 " , " -> empty (whitespace and empty members are not blocks)', () => {
  assert.deepEqual(parseAdminAllowlist(' , '), []);
  assert.deepEqual(parseAdminAllowlist(',,,'), []);
});

test('E-17.4 two IPv4 blocks -> two entries, in the order given', () => {
  assert.deepEqual(parseAdminAllowlist('203.0.113.0/24, 198.51.100.0/24'), [
    '203.0.113.0/24',
    '198.51.100.0/24',
  ]);
});

test('E-17.5 a v4 and a v6 block -> two entries, and the v6 line is rendered as given', () => {
  const parsed = parseAdminAllowlist('203.0.113.0/24,2001:DB8::/32');
  assert.deepEqual(parsed, ['203.0.113.0/24', '2001:DB8::/32']);
  // "IPv6 rendered as given; no expansion, no reordering" (§9.1a's drop-in).
  const conf = generateAppConf(rows, {
    adminHost: 'admin.skw.test',
    demosHost: 'demos.skw.test',
    adminAllowlist: parsed,
  });
  assert.match(conf, /^ {4}allow 203\.0\.113\.0\/24;$/m);
  assert.match(conf, /^ {4}allow 2001:DB8::\/32;$/m);
});

test('E-17.6 a non-empty malformed value is a refusal naming the offending token', () => {
  for (const bad of ['10.0.0.0/33', 'not-a-cidr', '1.2.3.4', 'garbage/24', '10.0.0.5/24', '2001:db8::/129']) {
    assert.throws(
      () => parseAdminAllowlist(bad),
      (err: unknown) => {
        assert.ok(err instanceof AllowlistParseError, `${bad}: not an AllowlistParseError`);
        assert.match(err.message, /SKW_ADMIN_ALLOWLIST/);
        assert.ok(err.message.includes(bad), `${bad}: the message must name the token, got ${err.message}`);
        assert.equal(err.token, bad);
        return true;
      },
      bad,
    );
  }
});

// --- the value lives in the environment, and only there -------------------

test('E-17: SKW_ADMIN_ALLOWLIST is the twenty-third name and loadEnv carries it', () => {
  assert.equal(SKW_NAMES.length, 23, 'E-17: twenty-two names become twenty-three, by addition only');
  assert.ok((SKW_NAMES as readonly string[]).includes('SKW_ADMIN_ALLOWLIST'));
  const env = loadEnv({ ...CLEAN, SKW_ADMIN_ALLOWLIST: '203.0.113.0/24, 2001:db8::/32' });
  assert.deepEqual(env.adminAllowlist, ['203.0.113.0/24', '2001:db8::/32']);
  assert.deepEqual(loadEnv({ ...CLEAN }).adminAllowlist, [], 'unset is empty, not an error');
});

test('E-17: the real process refuses to boot on a malformed allowlist, naming the token (E-8 harness)', () => {
  const fixture = makeFixture();
  try {
    const res = spawnSync(process.execPath, [join(REPO, 'app', 'main.ts')], {
      cwd: REPO,
      encoding: 'utf8',
      env: { ...process.env, ...fixture.env, PORT: '0', SKW_ADMIN_ALLOWLIST: '10.0.0.0/33' },
      timeout: 5000,
      killSignal: 'SIGKILL',
    });
    if ((res.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT') {
      assert.fail('the process booted with a malformed allowlist instead of refusing');
    }
    assert.notEqual(res.status, 0, `expected a refusal, got status=${String(res.status)}`);
    assert.match(res.stderr, /SKW_ADMIN_ALLOWLIST/);
    assert.match(res.stderr, /10\.0\.0\.0\/33/);
    assert.equal(res.stdout.includes('listening'), false);
  } finally {
    fixture.cleanup();
  }
});

// --- §9.1's two consequences are derived from the parser -------------------

test('E-17: TOTP-mandatory-when-empty is derived from the parser, not a hardcoded flag', () => {
  const empty = new Auth({
    controlPath: '/tmp/skw-allowlist-no-such.db',
    fleetMode: true,
    allowlist: parseAdminAllowlist(undefined),
    semaphore: { run: <T>(fn: () => Promise<T>): Promise<T> => fn() } as never,
  });
  assert.equal(empty.totpRequired, true);
  assert.equal(idleMsFor(parseAdminAllowlist(undefined)), IDLE_MS_NO_ALLOWLIST);

  const populated = new Auth({
    controlPath: '/tmp/skw-allowlist-no-such.db',
    fleetMode: true,
    allowlist: parseAdminAllowlist('10.0.0.0/8'),
    semaphore: { run: <T>(fn: () => Promise<T>): Promise<T> => fn() } as never,
  });
  assert.equal(populated.totpRequired, false);
  assert.equal(idleMsFor(parseAdminAllowlist('10.0.0.0/8')), IDLE_MS_WITH_ALLOWLIST);
});

// --- one module, two consumers --------------------------------------------

test('E-17: the parser is one module imported by both consumers, not a copy', () => {
  const env = readFileSync(join(REPO, 'app', 'env.ts'), 'utf8');
  const gen = readFileSync(join(REPO, 'tools', 'nginx_gen.ts'), 'utf8');
  assert.match(env, /from '\.\/admin\/allowlist\.ts'/, 'app/env.ts must import the parser');
  assert.match(gen, /from '\.\.\/app\/admin\/allowlist\.ts'/, 'tools/nginx_gen.ts must import the parser');

  // The validation itself exists in exactly one file under app/ and tools/.
  const offenders: string[] = [];
  for (const dir of ['app', 'tools']) {
    for (const name of readdirRecursive(join(REPO, dir))) {
      if (!name.endsWith('.ts')) continue;
      if (name.endsWith(join('admin', 'allowlist.ts'))) continue;
      if (readFileSync(name, 'utf8').includes('isIP(')) offenders.push(name);
    }
  }
  assert.deepEqual(offenders, [], 'a second CIDR validator is a second answer to "is this value usable"');
});

function readdirRecursive(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...readdirRecursive(full));
    else out.push(full);
  }
  return out;
}
