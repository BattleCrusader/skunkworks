/**
 * S4f item 1 — **the trust surface D27 describes** (§8.5, C-9).
 *
 * Before this gate, `skwctl plugin install` accepted no key, showed no fingerprint and
 * verified no signature: unsigned was not a fallback, it was the only path. The cases below
 * are the four the spec promises, each with the refusal it must produce:
 *
 *   T1  a signed third-party package installs, and the screen names its publisher, key
 *       fingerprint, capabilities in plain words, owned tables and the test report.
 *   T2  a package edited after it was signed is refused **naming the file** — and the same
 *       for the manifest, which is the half that decides what the package may do.
 *   T3  an unsigned package is refused without `--allow-unsigned`; with it, it installs, the
 *       output is loud, and the audit row records that the flag was passed.
 *   T4  a publisher key mismatch names **both** fingerprints — the one the operator
 *       imported and the one the package was signed with.
 *   T5  the image's own key: a package signed by a key that is not the image key, claiming
 *       to be first-party, is refused; with the image key it is `first_party` and needs no
 *       operator action.
 *
 * Every signature is produced by the shipped packager tool (`tools/plugin_sign.ts`), not by
 * a helper that re-implements the statement — a gate that signs its own way proves the two
 * agree today and nothing after.
 */
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { AppError } from '../app/errors.ts';
import { inspectPackage, installPlugin } from '../app/plugins/install.ts';
import { packageRootHash } from '../app/plugins/manifest.ts';
import { FIRST_PARTY_PUBLISHER, FIRST_PARTY_SPKI_PEM, fingerprintOf, importPublisherKey } from '../app/plugins/trust.ts';
import { openAdminWrite } from '../app/db/classes.ts';
import { REPO, makeFixture, type Fixture } from './helpers/fixture.ts';

const RUNNER_DIGEST = 'sha256:s4f-trust-runner';
const PLUGIN_SRC = join(REPO, 'test', 'fixtures', 'plugins', 'notes');

interface Pair {
  key: string;
  pub: string;
  fingerprint: string;
}

let fixture: Fixture;
let keys: Pair;
let other: Pair;

function makePair(prefix: string): Pair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const key = join(fixture.dir, 'keys', `${prefix}.key`);
  mkdirSync(join(fixture.dir, 'keys'), { recursive: true });
  writeFileSync(key, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), { mode: 0o600 });
  const pubPath = join(fixture.dir, 'keys', `${prefix}.pub`);
  writeFileSync(pubPath, pub);
  return { key, pub: pubPath, fingerprint: fingerprintOf(pub) };
}

/** Copy the reference package, and optionally rename it so two cases can coexist. */
function packageCopy(name: string, id = 'notes'): string {
  const dir = join(fixture.dir, 'packages', name);
  cpSync(PLUGIN_SRC, dir, { recursive: true });
  if (id !== 'notes') {
    const path = join(dir, 'plugin.json');
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    manifest.id = id;
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return dir;
}

function sign(dir: string, pair: Pair, publisher = 'acme-labs'): string {
  const out = join(dir, '..', `${dir.split('/').pop() as string}.sig.json`);
  const res = spawnSync(
    process.execPath,
    [join(REPO, 'tools', 'plugin_sign.ts'), '--dir', dir, '--key', pair.key, '--publisher', publisher, '--out', out],
    { cwd: REPO, encoding: 'utf8' },
  );
  assert.equal(res.status, 0, `plugin_sign failed:\n${res.stdout}\n${res.stderr}`);
  return out;
}

/** Sign with the tool's own default output path (`<id>-<version>.sig.json` beside the package). */
function signDefault(dir: string, pair: Pair, publisher = 'acme-labs'): string {
  const res = spawnSync(process.execPath, [join(REPO, 'tools', 'plugin_sign.ts'), '--dir', dir, '--key', pair.key, '--publisher', publisher], {
    cwd: REPO,
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, `plugin_sign failed:\n${res.stdout}\n${res.stderr}`);
  const manifest = JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8')) as { id: string; version: string };
  const out = join(dir, '..', `${manifest.id}-${manifest.version}.sig.json`);
  assert.equal(existsSync(out), true, `the tool's default output is not where the refusal looks: ${res.stdout}`);
  return out;
}

function reportFor(dir: string, digest = RUNNER_DIGEST): string {
  const root = packageRootHash(dir).root;
  const path = join(fixture.dir, 'reports', `${root.slice(0, 10)}.json`);
  mkdirSync(join(fixture.dir, 'reports'), { recursive: true });
  const manifest = JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8')) as { id: string; version: string };
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        plugin: manifest.id,
        version: manifest.version,
        root_hash: root,
        runner_image_digest: digest,
        ran_at: '2026-10-21T00:00:00.000Z',
      },
      null,
      2,
    )}\n`,
  );
  return path;
}

let siteCounter = 0;
/** A fresh tenant database, so one case's tables cannot be another's. */
function freshSite(): string {
  siteCounter += 1;
  const dir = join(fixture.dir, 'sites');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `t${siteCounter}-site.db`);
  const db = new Database(path);
  try {
    db.exec(readFileSync(join(REPO, 'schema', 'site.sql'), 'utf8'));
  } finally {
    db.close();
  }
  return path;
}

function importKey(pair: Pair, publisher = 'acme-labs'): void {
  const res = skwctl(['plugin', 'trust', 'import', pair.pub, '--publisher', publisher, '--tenant', 'acme']);
  assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
}

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

function skwctl(args: readonly string[], env: Record<string, string> = fixture.env): Run {
  const res = spawnSync(process.execPath, ['app/cli/skwctl.ts', ...args], {
    cwd: REPO,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 120_000,
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function row(siteDb: string): Record<string, unknown> | undefined {
  const db = openAdminWrite(siteDb, 5000);
  try {
    return db
      .prepare('SELECT plugin_id, publisher, publisher_key_fingerprint, signature_state, enabled FROM cms_plugin_installed')
      .get() as Record<string, unknown> | undefined;
  } finally {
    db.close();
  }
}

function refusal(fn: () => unknown, code: string, message: RegExp): AppError {
  let caught: AppError | null = null;
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof AppError, `expected an AppError, got ${String(err)}`);
    assert.equal(err.code, code);
    assert.match(err.message, message);
    caught = err;
    return true;
  });
  return caught as unknown as AppError;
}

before(() => {
  // One tenant for the CLI cases; the library cases make their own site databases.
  fixture = makeFixture({ specs: [{ key: 'acme', hosts: ['acme.test'] }] });
  keys = makePair('acme-labs');
  other = makePair('someone-else');
});

after(() => {
  fixture?.cleanup();
});

test('T1 — a signed package installs, and the §8.5 screen names the publisher, fingerprint, capabilities, tables and report', () => {
  importKey(keys);
  const siteDb = freshSite();
  const dir = packageCopy('t1');
  const signaturePath = sign(dir, keys);
  const pluginsRoot = join(fixture.dir, 't1-plugins');

  const inspected = inspectPackage({
    siteDb,
    pluginsRoot,
    sourceDir: dir,
    signaturePath,
    trustDir: join(fixture.dir, 'trust'),
    testReportPath: reportFor(dir),
    runnerImageDigest: RUNNER_DIGEST,
    enable: true,
  });
  const screen = inspected.screen;
  assert.equal(screen.publisher, 'acme-labs');
  assert.equal(screen.publisher_key_fingerprint, keys.fingerprint);
  assert.equal(screen.first_party, false);
  assert.equal(screen.signature_state, 'imported');
  assert.equal(screen.key_source, 'imported');
  assert.equal(screen.unsigned, false);
  assert.equal(screen.signature?.files, 2, 'the signature covers both files');
  assert.match(screen.test_report.ran_at, /^2026-10-21T00:00:00/);
  assert.match(screen.test_report.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(
    screen.capabilities.map((c) => c.op),
    ['store.insert', 'store.query', 'settings.get', 'settings.set', 'assets.resolve'],
  );
  // In plain words, not the op's name twice — the screen is for a person deciding.
  assert.equal(screen.capabilities.find((c) => c.op === 'store.insert')?.plain, 'write a row into one of its own tables');
  assert.deepEqual(screen.tables, [{ name: 'p_notes_note', export: 'rows', columns: 2 }]);

  const result = installPlugin({
    siteDb,
    pluginsRoot,
    sourceDir: dir,
    signaturePath,
    trustDir: join(fixture.dir, 'trust'),
    testReportPath: reportFor(dir),
    runnerImageDigest: RUNNER_DIGEST,
    enable: true,
  });
  assert.equal(result.signature_state, 'imported');
  assert.equal(result.publisher, 'acme-labs');
  assert.equal(result.publisher_key_fingerprint, keys.fingerprint);
  assert.equal(result.unsigned, false);
  assert.equal(result.enabled, true);

  const recorded = row(siteDb);
  assert.equal(recorded?.publisher, 'acme-labs');
  assert.equal(recorded?.publisher_key_fingerprint, keys.fingerprint);
  assert.equal(recorded?.signature_state, 'imported');

  // A signature that exists but was not passed is not "unsigned with no alternative": the
  // refusal names it, so `--allow-unsigned` is a deliberate choice and not the short way past.
  const forgetful = packageCopy('t1b');
  const defaultSig = signDefault(forgetful, keys);
  assert.match(defaultSig, /notes-1\.0\.0\.sig\.json$/);
  const hint = refusal(
    () =>
      inspectPackage({
        siteDb: freshSite(),
        pluginsRoot: join(fixture.dir, 't1b-plugins'),
        sourceDir: forgetful,
        trustDir: join(fixture.dir, 'trust'),
        testReportPath: reportFor(forgetful),
        runnerImageDigest: RUNNER_DIGEST,
      }),
    'SKW_E_PL_SIGNATURE',
    /one is present at .*notes-1\.0\.0\.sig\.json — pass --signature/,
  );
  assert.match(String((hint.detail as { signature_present: string }).signature_present), /notes-1\.0\.0\.sig\.json$/);
});

test('T2 — a package edited after signing is refused naming the file, and so is an edited manifest', () => {
  const siteDb = freshSite();
  const dir = packageCopy('t2');
  const signaturePath = sign(dir, keys);
  const input = {
    siteDb,
    pluginsRoot: join(fixture.dir, 't2-plugins'),
    sourceDir: dir,
    signaturePath,
    trustDir: join(fixture.dir, 'trust'),
    testReportPath: reportFor(dir),
    runnerImageDigest: RUNNER_DIGEST,
  };

  // One byte more in the entry module. The root changes, but the refusal names the file.
  writeFileSync(join(dir, 'index.mjs'), `${readFileSync(join(dir, 'index.mjs'), 'utf8')}\n// edited after signing\n`);
  const code = refusal(() => inspectPackage(input), 'SKW_E_PL_SIGNATURE', /edited after it was signed: index\.mjs/);
  const detail = code.detail as { file: string; signed_sha256: string; actual_sha256: string };
  assert.equal(detail.file, 'index.mjs');
  assert.match(detail.signed_sha256, /^[0-9a-f]{64}$/);
  assert.match(detail.actual_sha256, /^[0-9a-f]{64}$/);
  assert.notEqual(detail.signed_sha256, detail.actual_sha256);

  // Nothing was installed by the refusal.
  assert.equal(row(siteDb), undefined);
  assert.equal(existsSync(join(fixture.dir, 't2-plugins', 'notes')), false);

  // The manifest is the grant: an edited `plugin.json` is the same refusal, naming it.
  const dir2 = packageCopy('t2b');
  const sig2 = sign(dir2, keys);
  const manifestPath = join(dir2, 'plugin.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  manifest.capabilities = [...(manifest.capabilities as string[]), 'mail.send'];
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const second = refusal(
    () => inspectPackage({ ...input, siteDb: freshSite(), sourceDir: dir2, signaturePath: sig2, pluginsRoot: join(fixture.dir, 't2b-plugins'), testReportPath: reportFor(dir2) }),
    'SKW_E_PL_SIGNATURE',
    /edited after it was signed: plugin\.json/,
  );
  assert.equal((second.detail as { file: string }).file, 'plugin.json');

  // A file added after signing is named too — the other direction of the same check.
  const dir3 = packageCopy('t2c');
  const sig3 = sign(dir3, keys);
  writeFileSync(join(dir3, 'extra.mjs'), 'export const x = 1;\n');
  const third = refusal(
    () => inspectPackage({ ...input, siteDb: freshSite(), sourceDir: dir3, signaturePath: sig3, pluginsRoot: join(fixture.dir, 't2c-plugins'), testReportPath: reportFor(dir3) }),
    'SKW_E_PL_SIGNATURE',
    /edited after it was signed: extra\.mjs was added/,
  );
  assert.equal((third.detail as { file: string }).file, 'extra.mjs');
});

test('T3 — unsigned is refused without --allow-unsigned, installed with it, loudly, with an audit row', () => {
  const siteDb = freshSite();
  const dir = packageCopy('t3');
  const input = {
    siteDb,
    pluginsRoot: join(fixture.dir, 't3-plugins'),
    sourceDir: dir,
    trustDir: join(fixture.dir, 'trust'),
    testReportPath: reportFor(dir),
    runnerImageDigest: RUNNER_DIGEST,
  };

  // The library refuses, and says which flag changes the answer.
  const refused = refusal(() => inspectPackage(input), 'SKW_E_PL_SIGNATURE', /--allow-unsigned/);
  assert.equal((refused.detail as { reason: string }).reason, 'unsigned');
  assert.equal(row(siteDb), undefined, 'a refusal must install nothing');
  assert.equal(existsSync(join(fixture.dir, 't3-plugins', 'notes')), false);

  // With the flag: installed, and the row says unsigned.
  const ok = installPlugin({ ...input, allowUnsigned: true, enable: true });
  assert.equal(ok.signature_state, 'unsigned');
  assert.equal(ok.unsigned, true);
  assert.equal(ok.publisher_key_fingerprint, null);
  assert.equal(ok.screen.unsigned, true);
  assert.equal(row(siteDb)?.signature_state, 'unsigned');

  // The same two answers through the CLI, where the flag is what an operator types.
  const cliInput = ['plugin', 'install', dir, '--test-report', reportFor(dir), '--runner-digest', RUNNER_DIGEST, '--tenant', 'acme'];
  const without = skwctl(cliInput);
  assert.equal(without.status, 1, `an unsigned install must exit 1:\n${without.stdout}\n${without.stderr}`);
  assert.match(`${without.stdout}${without.stderr}`, /SKW_E_PL_SIGNATURE: .*--allow-unsigned/);

  const withFlag = skwctl([...cliInput, '--allow-unsigned', '--enable']);
  assert.equal(withFlag.status, 0, `${withFlag.stdout}\n${withFlag.stderr}`);
  // Loud: the banner names the state, the flag and the audit row.
  assert.match(withFlag.stdout, /\*\*\* UNSIGNED — /);
  assert.match(withFlag.stdout, /allow_unsigned=true/);
  // And the screen came before the install line, in the same output.
  assert.ok(
    withFlag.stdout.indexOf('install screen') < withFlag.stdout.indexOf('plugin: installed'),
    'the screen must be printed before the install result',
  );
  assert.match(withFlag.stdout, /key fingerprint\s+\(none — unsigned\)/);
  assert.match(withFlag.stdout, /signature\s+none — no key vouches for these bytes/);

  // The audit row is where the decision survives.
  const db = openAdminWrite(fixture.sitePath('acme'), 5000);
  try {
    const audit = db
      .prepare("SELECT after_json FROM cms_audit WHERE action = 'plugin.install' ORDER BY id DESC LIMIT 1")
      .get() as { after_json: string } | undefined;
    assert.ok(audit, 'no plugin.install audit row');
    const after = JSON.parse(audit.after_json) as Record<string, unknown>;
    assert.equal(after.allow_unsigned, true);
    assert.equal(after.signature_state, 'unsigned');
    assert.equal(after.publisher_key_fingerprint, null);
    const chain = db.prepare('SELECT COUNT(*) AS n FROM cms_audit').get() as { n: number };
    assert.ok(chain.n >= 1);
  } finally {
    db.close();
  }
});

test('T4 — a publisher key mismatch is refused naming both fingerprints, and a key nobody imported is refused naming the presented one', () => {
  // A trust store of its own, holding `other` under acme-labs; the package is signed by
  // `keys`. (T1 imports `keys` into the shared store, and a second key there would be the
  // T6 refusal rather than this one.)
  const trustDir = join(fixture.dir, 'trust-t4');
  importPublisherKey({ trustDir, publisher: 'acme-labs', spkiPem: readFileSync(other.pub, 'utf8'), importedBy: 'gate' });
  const siteDb = freshSite();
  const dir = packageCopy('t4');
  const signaturePath = sign(dir, keys);
  const err = refusal(
    () =>
      inspectPackage({
        siteDb,
        pluginsRoot: join(fixture.dir, 't4-plugins'),
        sourceDir: dir,
        signaturePath,
        trustDir,
        testReportPath: reportFor(dir),
        runnerImageDigest: RUNNER_DIGEST,
      }),
    'SKW_E_PL_SIGNATURE',
    new RegExp(`${keys.fingerprint} but acme-labs is trusted as ${other.fingerprint}`),
  );
  const detail = err.detail as { presented_fingerprint: string; trusted_fingerprints: string[] };
  assert.equal(detail.presented_fingerprint, keys.fingerprint);
  assert.deepEqual(detail.trusted_fingerprints, [other.fingerprint]);
  // Both fingerprints are in the message, not only the one that failed.
  assert.ok(err.message.includes(keys.fingerprint));
  assert.ok(err.message.includes(other.fingerprint));

  // A publisher with no imported key at all: the refusal still names what the package
  // presented, because "which key is this?" is the operator's first question.
  const stranger = packageCopy('t4b');
  const strangerSig = sign(stranger, keys, 'never-imported');
  const missing = refusal(
    () =>
      inspectPackage({
        siteDb: freshSite(),
        pluginsRoot: join(fixture.dir, 't4b-plugins'),
        sourceDir: stranger,
        signaturePath: strangerSig,
        trustDir,
        testReportPath: reportFor(stranger),
        runnerImageDigest: RUNNER_DIGEST,
      }),
    'SKW_E_PL_SIGNATURE',
    /no public key is imported for publisher "never-imported".*tenant owner must import one/,
  );
  assert.equal((missing.detail as { presented_fingerprint: string }).presented_fingerprint, keys.fingerprint);
});

test('T5 — first-party is decided by the image key alone: the right key needs no import, another key is refused', () => {
  // The image's key is a real Ed25519 SPKI, and its fingerprint is a stable fact — the
  // screen prints it, so a silent replacement of the constant must fail this gate.
  assert.match(FIRST_PARTY_SPKI_PEM, /^-----BEGIN PUBLIC KEY-----/);
  assert.equal(fingerprintOf(FIRST_PARTY_SPKI_PEM), 'spki-sha256:8dfebc524f9583769c4489b8700ec93b96c076c15f4ddd4593033575d962d6d4');

  // A package claiming publisher=skunkworks, signed by a key that is not the image's:
  // refused, naming both, with no import and no operator action available to fix it.
  const siteDb = freshSite();
  const dir = packageCopy('t5');
  const signaturePath = sign(dir, keys, FIRST_PARTY_PUBLISHER);
  const wrong = refusal(
    () =>
      inspectPackage({
        siteDb,
        pluginsRoot: join(fixture.dir, 't5-plugins'),
        sourceDir: dir,
        signaturePath,
        trustDir: join(fixture.dir, 'trust'),
        testReportPath: reportFor(dir),
        runnerImageDigest: RUNNER_DIGEST,
      }),
    'SKW_E_PL_SIGNATURE',
    /signed by spki-sha256:[0-9a-f]{64} but skunkworks is trusted as spki-sha256:/,
  );
  assert.ok(wrong.message.includes(keys.fingerprint));
  assert.ok(wrong.message.includes(fingerprintOf(FIRST_PARTY_SPKI_PEM)));

  // With the image's own key (a gate holds the matching private half as a fixture here;
  // the release private key is not in this tree) the same package is `first_party`, and
  // nothing was imported to make that true.
  const firstPartyInput = {
    siteDb: freshSite(),
    pluginsRoot: join(fixture.dir, 't5-plugins'),
    sourceDir: dir,
    signaturePath,
    trustDir: join(fixture.dir, 't5-trust-empty'),
    testReportPath: reportFor(dir),
    runnerImageDigest: RUNNER_DIGEST,
    firstPartyKeys: [readFileSync(keys.pub, 'utf8')],
  };
  const ok = installPlugin(firstPartyInput);
  assert.equal(ok.signature_state, 'first_party');
  assert.equal(ok.publisher, FIRST_PARTY_PUBLISHER);
  assert.equal(ok.publisher_key_fingerprint, keys.fingerprint);
  assert.equal(ok.screen.first_party, true);
  assert.equal(ok.screen.key_source, 'image');
  assert.equal(existsSync(join(fixture.dir, 't5-trust-empty', 'publishers.json')), false, 'first-party must not need the trust store');
});

test('T6 — trust import writes the store 0600, list shows the fingerprint, and a second key for the same publisher is refused', () => {
  const trustDir = join(fixture.dir, 'trust');
  const publisher = 'acme-labs';
  const res = skwctl(['plugin', 'trust', 'import', keys.pub, '--publisher', publisher, '--tenant', 'acme']);
  assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
  assert.match(res.stdout, new RegExp(`imported publisher=${publisher} fingerprint=${keys.fingerprint}`));

  const file = join(trustDir, 'publishers.json');
  assert.ok(existsSync(file));
  assert.equal(statSync(file).mode & 0o777, 0o600, 'the trust store must not be world-writable');
  const store = JSON.parse(readFileSync(file, 'utf8')) as { format: string; publishers: { id: string; fingerprint: string }[] };
  assert.equal(store.format, 'skw-trust/1');
  assert.equal(store.publishers.find((k) => k.id === publisher)?.fingerprint, keys.fingerprint);

  const listed = skwctl(['plugin', 'trust', 'list', '--tenant', 'acme']);
  assert.equal(listed.status, 0, `${listed.stdout}\n${listed.stderr}`);
  assert.match(listed.stdout, new RegExp(`publisher=${publisher} fingerprint=${keys.fingerprint}`));

  // A different key under a publisher that is already imported: refused, naming both.
  const second = skwctl(['plugin', 'trust', 'import', other.pub, '--publisher', publisher, '--tenant', 'acme']);
  assert.equal(second.status, 1, `a silent key replacement must exit 1:\n${second.stdout}\n${second.stderr}`);
  const text = `${second.stdout}${second.stderr}`;
  assert.ok(text.includes(keys.fingerprint), `the refusal must name the imported key:\n${text}`);
  assert.ok(text.includes(other.fingerprint), `the refusal must name the presented key:\n${text}`);

  // The store still holds the first key: a refusal writes nothing.
  const after = JSON.parse(readFileSync(file, 'utf8')) as { publishers: { id: string; fingerprint: string }[] };
  assert.equal(after.publishers.find((k) => k.id === publisher)?.fingerprint, keys.fingerprint);

  // The import is in the audit chain, in the tenant the operator named.
  const db = openAdminWrite(fixture.sitePath('acme'), 5000);
  try {
    const audit = db
      .prepare("SELECT action, target_id, after_json FROM cms_audit WHERE action = 'plugin.trust.import' ORDER BY id DESC LIMIT 1")
      .get() as { action: string; target_id: string; after_json: string } | undefined;
    assert.ok(audit, 'a trust import must be audited');
    assert.equal(audit?.target_id, publisher);
    assert.equal((JSON.parse(audit.after_json) as { fingerprint: string }).fingerprint, keys.fingerprint);
  } finally {
    db.close();
  }

  // `--replace` is the deliberate path, and it says what it did: the old fingerprint is named
  // in the output and the store holds the new key. Without this half, the refusal above could
  // be a key nobody can ever change.
  const replaced = skwctl(['plugin', 'trust', 'import', other.pub, '--publisher', publisher, '--tenant', 'acme', '--replace']);
  assert.equal(replaced.status, 0, `${replaced.stdout}\n${replaced.stderr}`);
  assert.match(replaced.stdout, new RegExp(`imported publisher=${publisher} fingerprint=${other.fingerprint}`));
  assert.match(replaced.stdout, new RegExp(`replaced ${keys.fingerprint}`));
  const afterReplace = JSON.parse(readFileSync(file, 'utf8')) as { publishers: { id: string; fingerprint: string }[] };
  assert.equal(afterReplace.publishers.find((k) => k.id === publisher)?.fingerprint, other.fingerprint);
});
