/**
 * The notices restart, as output: one process fails the package, a second process reads the
 * screen. Prints the two children's JSON and the notices table rows the reader saw; not a gate.
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { installPlugin } from '../../app/plugins/install.ts';
import { packageRootHash } from '../../app/plugins/manifest.ts';
import { makeFixture, REPO } from '../../test/helpers/fixture.ts';

const BADSHAPE = join(REPO, 'test', 'fixtures', 'plugins', 'badshape');
const CHILD = join(REPO, 'test', 'helpers', 'notice-child.ts');
const DIGEST = 'sha256:probe-notice';
const fixture = makeFixture({ specs: [{ key: 'acme', hosts: ['acme.test'], title: 'Acme' }] });
const root = packageRootHash(BADSHAPE).root;
const report = join(fixture.dir, 'badshape-report.json');
writeFileSync(report, `${JSON.stringify({ plugin: 'badshape', version: '1.0.0', root_hash: root, runner_image_digest: DIGEST, ran_at: new Date().toISOString() })}\n`);
installPlugin({ siteDb: fixture.sitePath('acme'), pluginsRoot: join(fixture.dir, 'plugins'), sourceDir: BADSHAPE, allowUnsigned: true, testReportPath: report, runnerImageDigest: DIGEST });

function child(mode: string): string {
  const run = spawnSync(process.execPath, [CHILD, mode, 'acme', 'badshape', 'probe-reader@acme.test'], {
    cwd: REPO,
    env: { ...fixture.env },
    encoding: 'utf8',
    timeout: 90_000,
  });
  const line = (run.stdout ?? '').split('\n').filter((l) => l.startsWith('{')).pop() ?? '(no JSON)';
  return line;
}

const failed = JSON.parse(child('fail')) as { pid: number; at: string; notice_code: string; message: string; notices: number };
console.log(`process A pid=${failed.pid} notices=${failed.notices} code=${failed.notice_code} at=${failed.at}`);
console.log(`process A message: ${failed.message}`);

const read = JSON.parse(child('read')) as { pid: number; status: number; body: string };
console.log(`process B pid=${read.pid} status=${read.status}`);
const rows = read.body
  .split('\n')
  .filter((l) => l.includes('data-notice='))
  .join('\n');
console.log('process B notices table:');
console.log(rows === '' ? '(none)' : rows);
console.log(`process B shows A's instant: ${read.body.includes(failed.at)}`);
fixture.cleanup();
