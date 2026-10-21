/**
 * Prints the real operator text for a zero-capability package: the install screen, then the
 * enable and uninstall lines. Used to quote the before/after in the build report; not a gate.
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { packageRootHash } from '../../app/plugins/manifest.ts';
import { makeFixture, REPO } from '../../test/helpers/fixture.ts';

const CLI = join(REPO, 'app', 'cli', 'skwctl.ts');
const NOTHING = join(REPO, 'test', 'fixtures', 'plugins', 'nothing');
const DIGEST = 'sha256:report';
const fixture = makeFixture({ specs: [{ key: 'acme', hosts: ['acme.test'], title: 'Acme' }] });
const root = packageRootHash(NOTHING).root;
const report = join(fixture.dir, 'nothing-report.json');
writeFileSync(report, `${JSON.stringify({ plugin: 'nothing', version: '1.0.0', root_hash: root, runner_image_digest: DIGEST, ran_at: '2026-10-21T00:00:00.000Z' }, null, 2)}\n`);

function run(args: string[]): void {
  const res = spawnSync(process.execPath, [CLI, ...args], { cwd: REPO, env: { ...fixture.env }, encoding: 'utf8' });
  process.stdout.write(`$ skwctl ${args.join(' ')}\n${res.stdout}${res.stderr}`);
}

run(['plugin', 'install', NOTHING, '--tenant', 'acme', '--allow-unsigned', '--test-report', report, '--runner-digest', DIGEST]);
run(['plugin', 'enable', 'nothing', '--tenant', 'acme']);
run(['plugin', 'uninstall', 'nothing', '--tenant', 'acme']);
fixture.cleanup();
