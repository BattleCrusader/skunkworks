/**
 * One OS process of N5's restart proof: `fail` breaks a package, `read` opens the notices screen.
 *
 * It exists because the claim under test is about a **process boundary** — "an operator who
 * restarts loses the explanation" — and an in-process test cannot make it. The parent spawns this
 * twice with the same `SKW_DATA_DIR`:
 *
 *     node test/helpers/notice-child.ts fail acme badshape
 *     node test/helpers/notice-child.ts read acme badshape child@acme.test
 *
 * `fail` builds the real app, enables the package (which fails), and prints the notice it
 * recorded — including its instant. `read` is a second process that builds the app fresh, seeds
 * its own operator, signs in over HTTP and fetches `/admin/t/<key>/plugins`, printing the body.
 * Nothing is shared but the data directory, which is the point.
 *
 * Output: the last line beginning with `{` is the JSON result; everything else (`plugins: …` from
 * `buildApp`) is noise the caller filters out.
 */
import { join } from 'node:path';

import { loadEnv } from '../../app/env.ts';
import { buildApp } from '../../app/main.ts';
import { ADMIN_HOST, PASSWORD, TOTP_SECRET, openSession, seedUser } from './admin.ts';
import { call } from './http.ts';

const [mode, tenant, plugin, email] = process.argv.slice(2);
if (mode === undefined || tenant === undefined || plugin === undefined) {
  throw new Error('usage: notice-child.ts <fail|read> <tenant> <plugin> [email]');
}

const env = loadEnv(process.env as Record<string, string | undefined>);
const handle = await buildApp({ env });
await handle.app.listen({ port: 0, host: '127.0.0.1' });
const address = handle.app.server.address();
const port = typeof address === 'object' && address !== null ? address.port : 0;

try {
  if (mode === 'fail') {
    let code: string | undefined;
    let message = '';
    try {
      await handle.plugins.enable(tenant, plugin);
      message = 'UNEXPECTED: the package activated, so there is nothing to remember';
    } catch (err) {
      code = (err as { code?: string }).code;
      message = err instanceof Error ? err.message : String(err);
    }
    const notices = handle.plugins.noticesFor(tenant);
    const notice = notices.filter((n) => n.plugin === plugin).at(-1);
    process.stdout.write(
      `${JSON.stringify({
        mode,
        pid: process.pid,
        code: code ?? null,
        message,
        notices: notices.length,
        at: notice?.at ?? null,
        notice_code: notice?.code ?? null,
      })}\n`,
    );
  } else {
    await seedUser({ controlDb: join(env.dataDir, 'control.db'), tenantKey: tenant, email: email ?? 'child@acme.test', totpSecret: TOTP_SECRET });
    const session = await openSession({ port, key: tenant, email: email ?? 'child@acme.test', password: PASSWORD });
    const res = await call({ port, path: `/admin/t/${tenant}/plugins`, host: ADMIN_HOST, headers: { cookie: session.cookie } });
    process.stdout.write(`${JSON.stringify({ mode, pid: process.pid, status: res.status, body: res.body })}\n`);
  }
} finally {
  await handle.close();
}
