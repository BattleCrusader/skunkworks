/**
 * §16 S4's install row, as far as S2b can honestly prove it: a fresh bundle can be
 * logged into **through install.sh only**, and a second run changes nothing.
 *
 *   | install on a clean host … the printed credentials plus the printed TOTP URI
 *   | produce an authenticated admin session without any other step |
 *
 * This runs the real `./install.sh` as a process, into a scratch target, with
 * `--no-compose` — the released image digest is S4's artefact and does not exist
 * locally, so a compose step here would test the registry rather than this slice.
 * The login is the installer's own `--verify-login`, which boots the installed app
 * and signs in with the file it just wrote.
 *
 * The wall-clock measurement lives in the report; this gate asserts the outcome,
 * not the time (a timing assertion in CI is a flaky gate, and §16's number is five
 * minutes).
 */
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { REPO } from './helpers/fixture.ts';

interface InstallRun {
  status: number | null;
  stdout: string;
  stderr: string;
  wallMs: number;
}

function install(target: string, envFile: string, extra: readonly string[] = []): InstallRun {
  const started = Date.now();
  const res = spawnSync(
    './install.sh',
    ['--target', target, '--no-compose', '--skip-dns', ...extra],
    {
      cwd: REPO,
      env: { ...process.env, SKW_ENV_FILE: envFile },
      encoding: 'utf8',
      timeout: 120_000,
    },
  );
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '', wallMs: Date.now() - started };
}

function row(fixtureDb: string, email: string): { password_hash: string; totp_secret: string; must_change: number } {
  const db = new Database(fixtureDb, { readonly: true });
  const r = db
    .prepare('SELECT password_hash, totp_secret, must_change FROM user_account WHERE email = ?')
    .get(email) as { password_hash: string; totp_secret: string; must_change: number };
  db.close();
  return r;
}

test('install.sh installs a fresh bundle and logs in end to end; a second run changes nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'skw-install-'));
  const data = join(dir, 'data');
  const envFile = join(dir, '.env');
  try {
    // `--nginx-conf` keeps this install out of the repo's tracked fixture: a source-tree install
    // otherwise rewrites nginx/conf.d/10-app.conf, and the fixture-identity gate then fails.
    const first = install(data, envFile, ['--verify-login', '--nginx-conf', join(dir, '10-app.conf')]);
    assert.equal(first.status, 0, `${first.stderr}\n${first.stdout}`);
    assert.match(first.stdout, /bootstrap: enrolment written/);
    assert.match(first.stdout, /install_check: signed in as owner@acme\.test, GET \/admin 200/, 'the installer proves the box is usable');

    const enrolment = join(data, 'first-login.txt');
    assert.equal(existsSync(enrolment), true);
    assert.equal((statSync(enrolment).mode & 0o777).toString(8), '600', 'the enrolment file is 0600');
    const text = readFileSync(enrolment, 'utf8');
    assert.match(text, /^uri:\s+otpauth:\/\/totp\//m);
    assert.match(text, /^password:\s+\S{16,}$/m);
    assert.match(text, /^secret:\s+([A-Z2-7]{4} )+[A-Z2-7]{4}$/m);

    // The password is not on stdout, and not in the env file.
    const password = /^password:\s+(.+)$/m.exec(text)?.[1] as string;
    assert.equal(first.stdout.includes(password), false);
    assert.equal(readFileSync(envFile, 'utf8').includes(password), false);
    assert.equal((statSync(envFile).mode & 0o777).toString(8), '600');

    // The seeded row is now claimed, and the audit row says who did it.
    const claimed = row(join(data, 'control.db'), 'owner@acme.test');
    assert.equal(claimed.must_change, 0);
    assert.match(claimed.totp_secret, /^[A-Z2-7]{32}$/);
    const db = new Database(join(data, 'control.db'), { readonly: true });
    const audit = db.prepare("SELECT actor_label, action FROM audit_log WHERE action = 'admin.bootstrap'").all() as {
      actor_label: string;
      action: string;
    }[];
    const tenants = db.prepare('SELECT key, mode FROM tenant').all() as { key: string; mode: string }[];
    db.close();
    assert.equal(audit.length, 1);
    assert.equal(audit[0]?.actor_label, 'install');
    assert.deepEqual(tenants, [{ key: 'acme', mode: 'production' }]);

    // A second ./install.sh: exit 0, the benign 3 is reported, no row changes.
    const before = row(join(data, 'control.db'), 'owner@acme.test');
    const second = install(data, envFile);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /already set up; nothing changed \(exit 3\)/);
    const after = row(join(data, 'control.db'), 'owner@acme.test');
    assert.deepEqual(after, before, 'a second install writes no user row');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The VPS kit's own scripts, where the two ways an operator loses data are decided.
 *
 * `provision.sh` copied the bundle's `site.db` over the live one on **every** deploy — every page,
 * media row and message created on the box since the last deploy. `qa-session.sh delete` read the
 * session id from a file a previous `docker run --rm` had written, so under the very invocation
 * pattern the kit uses it deleted nothing and said so to nobody.
 *
 * Both are shell, so nothing here runs them against a live database. What is asserted is the shape
 * that makes them safe — a guard that is present, says why, and cannot be a no-op — because these
 * are the lines a future edit deletes without noticing.
 */
test('the VPS kit never overwrites a live site.db, and its cleanup cannot silently do nothing', () => {
  const kit = join(REPO, 'skunkworks-sites', 'madetoship', 'vps');
  const read = (name: string): string => readFileSync(join(kit, name), 'utf8');

  const provision = read('provision.sh');
  // control.db was guarded this way from the start; site.db — the one holding what visitors and the
  // operator created — was not.
  assert.match(
    provision,
    /if \[ -f "\$DATA\/tenants\/\$TENANT\/site\.db" \]; then\s*\n\s*say "site\.db already exists; not overwriting it with the bundle's"/,
    'a deploy must not replace a live tenant database',
  );
  assert.match(provision, /else\s*\n\s*cp "\$BUNDLE\/data\/site\.db"/, 'a first deploy still seeds it');
  // …and a bundle must not replace an installed package with its older copy.
  assert.match(provision, /if \[ -d "\$DATA\/plugins\/\$id" \]; then/, 'an installed package is left for `skwctl plugin install`');
  assert.doesNotMatch(provision, /cp -R "\$BUNDLE\/data\/plugins\/\.\"/, 'the blanket copy is what downgraded a package');

  const qa = read('qa-session.sh');
  // The id is an argument first, a file only as a fallback, and a delete that removes nothing fails.
  assert.match(qa, /ID="\$\{2:-\}"/, 'delete takes the session id it is told to remove');
  assert.match(qa, /run\('\$ID'\)\.changes/, 'it counts the rows it removed');
  assert.match(qa, /if \(gone !== 1\) process\.exit\(1\)/, 'and refuses to be a no-op');

  const upgrade = read('upgrade-contact.sh');
  assert.match(upgrade, /if \[ "\$BEFORE" != "\$AFTER" \]/, 'the upgrade counts the rows across itself');
  assert.match(upgrade, /echo "upgrade: FAILED/, 'and says so before it exits');
  assert.match(upgrade, /^set -eu$/m, 'under `set -e`, so a failed install stops the script');

  // All three must parse as POSIX sh: they run in the image, where there is no bash guarantee.
  for (const name of ['provision.sh', 'qa-session.sh', 'upgrade-contact.sh']) {
    const parsed = spawnSync('sh', ['-n', join(kit, name)], { encoding: 'utf8' });
    assert.equal(parsed.status, 0, `${name} does not parse: ${parsed.stderr}`);
  }
});
