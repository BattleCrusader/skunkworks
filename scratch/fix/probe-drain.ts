/**
 * The drain, as numbers: a real in-flight request, the refusal, the instant the request is
 * released, and the retry that removes. Prints what the build report quotes; not a gate.
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadEnv } from '../../app/env.ts';
import { buildApp } from '../../app/main.ts';
import { installPlugin } from '../../app/plugins/install.ts';
import { packageRootHash } from '../../app/plugins/manifest.ts';
import { ADMIN_HOST, ADMIN_ORIGIN, PASSWORD, TOTP_SECRET, openSession, seedUser } from '../../test/helpers/admin.ts';
import { call } from '../../test/helpers/http.ts';
import { makeFixture, REPO } from '../../test/helpers/fixture.ts';

const GATEHOOK = join(REPO, 'test', 'fixtures', 'plugins', 'gatehook');
const DIGEST = 'sha256:probe-drain';
const fixture = makeFixture({ specs: [{ key: 'acme', hosts: ['acme.test'], title: 'Acme', body: '<h1>x</h1>' }] });
const root = packageRootHash(GATEHOOK).root;
const report = join(fixture.dir, 'gatehook-report.json');
writeFileSync(report, `${JSON.stringify({ plugin: 'gatehook', version: '1.0.0', root_hash: root, runner_image_digest: DIGEST, ran_at: new Date().toISOString() })}\n`);
installPlugin({ siteDb: fixture.sitePath('acme'), pluginsRoot: join(fixture.dir, 'plugins'), sourceDir: GATEHOOK, allowUnsigned: true, testReportPath: report, runnerImageDigest: DIGEST });

const hold = join(fixture.dir, 'gate');
mkdirSync(hold, { recursive: true });
process.env.SKW_GATE_HOLD_DIR = hold;

const handle = await buildApp({ env: loadEnv(fixture.env) });
await handle.app.listen({ port: 0, host: '127.0.0.1' });
const address = handle.app.server.address();
const port = typeof address === 'object' && address !== null ? address.port : 0;
const email = 'owner@acme.test';
await seedUser({ controlDb: fixture.controlDb, tenantKey: 'acme', email, totpSecret: TOTP_SECRET });
const session = await openSession({ port, key: 'acme', email, password: PASSWORD });

await handle.plugins.enable('acme', 'gatehook');
const held = call({ port, path: '/_plugin/gatehook/hold', host: 'acme.test' });
const deadline = Date.now() + 10_000;
while (!existsSync(join(hold, 'entered')) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
const inFlight = handle.plugins.inFlightCount('acme');

const t0 = Date.now();
const refused = await call({
  port,
  path: '/admin/t/acme/plugins/uninstall',
  method: 'POST',
  host: ADMIN_HOST,
  headers: { cookie: session.cookie, origin: ADMIN_ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ plugin: 'gatehook', csrf: session.csrfToken }).toString(),
});
const waitedMs = Date.now() - t0;
const refusedCode = (refused.json as { error?: { code?: string; message?: string } } | undefined)?.error?.code;
const refusedMessage = (refused.json as { error?: { message?: string } } | undefined)?.error?.message;

console.log(`in_flight_before_uninstall: ${inFlight}`);
console.log(`uninstall_during_request: status=${refused.status} code=${refusedCode ?? '(none)'} waited_ms=${waitedMs}`);
console.log(`message: ${refusedMessage ?? refused.body.slice(0, 200)}`);

writeFileSync(join(hold, 'release'), '1');
const answered = await held;
console.log(`held_request_after_release: status=${answered.status} body=${answered.body}`);

const t1 = Date.now();
const done = await call({
  port,
  path: '/admin/t/acme/plugins/uninstall',
  method: 'POST',
  host: ADMIN_HOST,
  headers: { cookie: session.cookie, origin: ADMIN_ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ plugin: 'gatehook', csrf: session.csrfToken }).toString(),
});
console.log(`uninstall_when_idle: status=${done.status} waited_ms=${Date.now() - t1} flash=${decodeURIComponent(String(done.headers.location ?? ''))}`);
console.log(`package_on_disk_after: ${existsSync(join(fixture.dir, 'plugins', 'gatehook'))}`);

// The archive is real and names the tables it took (none, for this package).
const archiveDir = join(fixture.dir, 'plugin-archive');
const archive = (await import('node:fs')).readdirSync(archiveDir)[0] ?? '';
console.log(`archive: ${archive} ${archive === '' ? '' : `${readFileSync(join(archiveDir, archive), 'utf8').length} bytes`}`);

await handle.close();
delete process.env.SKW_GATE_HOLD_DIR;
fixture.cleanup();
