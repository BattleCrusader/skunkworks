#!/usr/bin/env node
/**
 * Boots the **built** app for `make verify-dist` (E-28, D3), and nothing else.
 *
 * `node dist/app/main.js` is D1's assertion and it takes `contentRoot` from
 * `DEFAULT_CONTENT_ROOT` (`/srv/content`), which a gate may not write. This harness is the
 * same `buildApp` out of `dist/app/main.js` with an explicit `--content-root`, so the
 * download path under test is the compiled one — that is the whole point of the target.
 *
 * Not copied into the image (`Dockerfile.app` ships `dist/`, `build/`, `schema/`), not a
 * gate on its own, and it asserts nothing: `scripts/dist-gate.mjs` does.
 */
import { buildApp } from '../dist/app/main.js';
import { loadEnv } from '../dist/app/env.js';

const args = process.argv.slice(2);
let contentRoot = '';
let port = 0;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--content-root') contentRoot = args[i + 1] ?? '';
  else if (args[i] === '--port') port = Number(args[i + 1] ?? 0);
}
if (contentRoot === '') {
  process.stderr.write('dist-app-harness: --content-root is required\n');
  process.exit(2);
}

const handle = await buildApp({ env: loadEnv(), contentRoot });
await handle.app.listen({ port, host: '127.0.0.1' });
process.stdout.write(`dist-app-harness: listening ${port}\n`);

const stop = async () => {
  await handle.close();
  process.exit(0);
};
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
