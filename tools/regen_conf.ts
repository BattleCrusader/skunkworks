/**
 * Regenerate nginx/conf.d/10-app.conf from the test fixture.
 *
 * The committed file is the generator's output for `makeFixture()` with the
 * production vhost names — that is what `test/nginx-config.test.ts` asserts, so
 * the two cannot drift. Run: `node tools/regen_conf.ts`.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { generateAppConf, readHosts } from './nginx_gen.ts';
import { REPO, makeFixture } from '../test/helpers/fixture.ts';

const fixture = makeFixture();
try {
  const text = generateAppConf(readHosts(fixture.controlDb), {
    adminHost: 'admin.skw.test',
    demosHost: 'demos.skw.test',
    boxRps: 192,
  });
  const out = join(REPO, 'nginx', 'conf.d', '10-app.conf');
  writeFileSync(out, text);
  process.stdout.write(`wrote ${out} (${text.split('\n').length} lines)\n`);
} finally {
  fixture.cleanup();
}
