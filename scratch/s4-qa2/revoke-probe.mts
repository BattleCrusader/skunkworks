/**
 * QA round 2 — is there any operator action that revokes a package root?
 *
 * §8.5: "revocation is an operator action against a package root in data/trust/revoked.json",
 * and install "refuses ... a revoked root (SKW_E_PL_REVOKED)".
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { makeFixture, REPO } from '../../test/helpers/fixture.ts';
import { packageRootHash } from '../../app/plugins/protocol.ts';

const f = makeFixture({ specs: [{ key: 'acme', hosts: ['acme.test'] }] });
const dataDir = f.dir;
const work = join(REPO, 'scratch', 's4-qa2', 'revoke');
mkdirSync(work, { recursive: true });

const skwctl = (args: string[]) => {
  const r = spawnSync(process.execPath, ['app/cli/skwctl.ts', ...args], { cwd: REPO, env: { ...process.env, ...f.env }, encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout}${r.stderr}`.trim() };
};

// keypair + package + report + signature
const keygen = spawnSync(process.execPath, ['tools/plugin_sign.ts', '--keygen', '--out', join(work, 'qa')], { cwd: REPO, encoding: 'utf8' });
const pkg = join(work, 'pkg');
cpSync(join(REPO, 'test', 'fixtures', 'plugins', 'notes'), pkg, { recursive: true });
const root = packageRootHash(pkg).root;
writeFileSync(join(work, 'report.json'), `${JSON.stringify({ plugin: 'notes', version: '1.0.0', root_hash: root, runner_image_digest: 'sha256:qa2', ran_at: '2026-10-21T00:00:00.000Z' }, null, 2)}\n`);
const sig = join(work, 'pkg.sig.json');
const signed = spawnSync(process.execPath, ['tools/plugin_sign.ts', '--dir', pkg, '--key', join(work, 'qa.key'), '--publisher', 'acme-labs', '--out', sig], { cwd: REPO, encoding: 'utf8' });
const imported = skwctl(['plugin', 'trust', 'import', join(work, 'qa.pub'), '--publisher', 'acme-labs', '--tenant', 'acme']);

const install = () =>
  skwctl(['plugin', 'install', pkg, '--tenant', 'acme', '--test-report', join(work, 'report.json'), '--signature', sig, '--runner-digest', 'sha256:qa2', '--enable']);

console.log(JSON.stringify({
  keygen: keygen.status,
  signed: signed.status,
  root,
  imported: imported.status,
  baseline_install: (() => { const r = install(); return { status: r.status, tail: r.out.split('\n').pop() }; })(),
}, null, 2));

// 1. the operator writes the file the spec names
const revokedFile = join(dataDir, 'trust', 'revoked.json');
writeFileSync(revokedFile, `${JSON.stringify({ format: 'skw-trust/1', revoked: [{ root_hash: root, plugin_id: 'notes', reason: 'QA: compromised build', revoked_at: '2026-10-21T00:00:00.000Z' }] }, null, 2)}\n`, { mode: 0o600 });

// 2. the operator asks the CLI to revoke
const revokeVerb = skwctl(['plugin', 'revoke', 'notes', '--root', root, '--tenant', 'acme']);

// 3. re-install the same bytes, after the revocation gesture
const afterFile = (() => { const r = install(); return { status: r.status, tail: r.out.split('\n').slice(-2).join(' | ') }; })();

// 4. hand-edit the table the product actually reads
const db = new Database(join(dataDir, 'tenants', 'acme', 'site.db'));
db.prepare("INSERT INTO cms_plugin_revoked (root_hash, plugin_id, reason) VALUES (?, 'notes', 'QA hand-edit')").run(root);
db.close();

// uninstall first so the install is not refused for a different reason
const un = skwctl(['plugin', 'uninstall', 'notes', '--tenant', 'acme', '--archive-dir', join(work, 'archive')]);
const afterTable = (() => { const r = install(); return { status: r.status, tail: r.out.split('\n').slice(-2).join(' | ') }; })();

console.log(JSON.stringify({
  revoked_file_written: revokedFile,
  revoked_file_exists: existsSync(revokedFile),
  operator_revoke_verb: { status: revokeVerb.status, text: revokeVerb.out.split('\n').slice(0, 2).join(' | ') },
  install_after_file_revocation: afterFile,
  uninstall_status: un.status,
  install_after_table_row: afterTable,
}, null, 2));
