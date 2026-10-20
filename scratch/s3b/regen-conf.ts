/**
 * S3b — regenerate nginx/conf.d/10-app.conf from the generator, for the default fixture.
 * `test/nginx-config.test.ts` asserts the committed file equals this output, so this is the
 * only supported way to change it. Prints a sha256 of what it wrote.
 */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { generateAppConf, readHosts } from '../../tools/nginx_gen.ts';
import { REPO, makeFixture } from '../../test/helpers/fixture.ts';

const fixture = makeFixture();
try {
  const text = generateAppConf(readHosts(fixture.controlDb), {
    adminHost: 'admin.skw.test',
    demosHost: 'demos.skw.test',
    boxRps: 192,
  });
  const out = join(REPO, 'nginx', 'conf.d', '10-app.conf');
  writeFileSync(out, text);
  process.stdout.write(
    `wrote ${out}\n  ${text.split('\n').length} lines, sha256 ${createHash('sha256').update(text).digest('hex')}\n`,
  );
} finally {
  fixture.cleanup();
}
