/**
 * The edge config path, in the three places that have to agree.
 *
 * This test exists because they did not agree, and nothing noticed. `install.sh` wrote
 * `<dataDir>/nginx/10-app.conf`; compose mounts exactly that into nginx; the CMS wrote
 * `<dataDir>/nginx/conf.d/10-app.conf` and `skwctl site import --nginx` wrote the checkout's
 * tracked fixture. So an imported site got its rows, its pages, its media — and the browser still
 * saw a 404, because nginx had never read the file it was told about. Every layer reported success.
 *
 * The assertions are deliberately about *identity of paths*, not about behaviour: behaviour was
 * green throughout the bug.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { edgeConfigPath } from '../app/edge/config.ts';
import { regenerateAppConf } from '../app/import/site.ts';
import { REPO, makeFixture } from './helpers/fixture.ts';

test('G1 — the helper names the file compose mounts, inside the data directory', () => {
  assert.equal(edgeConfigPath('/srv/data'), '/srv/data/nginx/10-app.conf');

  const compose = readFileSync(join(REPO, 'docker-compose.yml'), 'utf8');
  const mount = /- (\.\/[^\s:]*nginx[^\s:]*):\/etc\/nginx\/conf\.d\/10-app\.conf/.exec(compose);
  assert.ok(mount !== null, 'compose still bind-mounts an edge config into nginx');
  // `./data/nginx/10-app.conf` on the host is `/srv/data/nginx/10-app.conf` in the container:
  // the host-side prefix is the compose project's `./data`, not the container's dataDir.
  assert.equal(mount[1], './data/nginx/10-app.conf', `compose mounts ${mount[1]}, not data/nginx/10-app.conf`);
});

test('G2 — the generator writes where the helper says, and install.sh defaults to the same file', () => {
  const fixture = makeFixture();
  try {
    const out = edgeConfigPath(fixture.dir);
    const written = regenerateAppConf({
      dataDir: fixture.dir,
      out,
      demosHost: 'demos.invalid',
    });
    assert.equal(written.path, out);
    assert.match(readFileSync(out, 'utf8'), /server_name/, 'the block was written where the edge reads it');
  } finally {
    fixture.cleanup();
  }

  // install.sh is the other writer. Its default must be `$DATA_DIR/nginx/10-app.conf` — the single
  // path the helper and the mount name — or a fresh host boots with a config nobody rewrites.
  const install = readFileSync(join(REPO, 'install.sh'), 'utf8');
  assert.match(install, /NGINX_CONF="\$\{NGINX_CONF_OUT:-\$DATA_DIR\/nginx\/10-app\.conf\}"/);
});

test('G3 — the service that holds the socket is the one that watches the file', () => {
  // The CMS cannot signal nginx (no socket, by design), so it writes the file and something else
  // must notice. That something is the acme service, which already reloads nginx for certificates.
  const acme = readFileSync(join(REPO, 'tools', 'acme.mjs'), 'utf8');
  assert.match(acme, /function edgeConfigPath\(\) \{\s*return join\(DATA, 'nginx', '10-app\.conf'\);/, 'acme watches <DATA>/nginx/10-app.conf');
  assert.match(acme, /mtime !== seenConfigMtime/, 'a changed mtime is what triggers the reload');
  assert.match(acme, /edge config changed; nginx/, 'and the reload is logged, not silent');
  assert.match(acme, /SKW_ACME_WATCH_S/, 'the watch cadence is configurable');

  // No second writer may reappear under `conf.d`: that path is what nginx is *not* given.
  const writers = [
    readFileSync(join(REPO, 'app', 'admin', 'routes.ts'), 'utf8'),
    readFileSync(join(REPO, 'app', 'cli', 'skwctl.ts'), 'utf8'),
  ];
  for (const source of writers) {
    assert.doesNotMatch(source, /nginx', 'conf\.d', '10-app\.conf'/, 'a writer still targets nginx/conf.d/');
  }
});
