/** Minimal repro attempt for the `no_redemption` refusal seen in probe-window B2. */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { PDFDocument, StandardFonts } from 'pdf-lib';

import { uploadAsset } from '../../app/assets/library.ts';
import { openAdminWrite } from '../../app/db/classes.ts';
import { loadEnv } from '../../app/env.ts';
import { buildApp, type AppHandle } from '../../app/main.ts';
import { issueCode, seedSettings } from '../../app/download/code.ts';
import { makeFixture, type Fixture } from '../../test/helpers/fixture.ts';
import { call, header, type Res } from '../../test/helpers/http.ts';

const HOST = 'acme.test';
const out = (s: string): void => process.stdout.write(`${s}\n`);
const fixture: Fixture = makeFixture({ specs: [{ key: 'acme', hosts: [HOST], title: 'Acme' }] });
const contentRoot = join(fixture.dir, 'content');
mkdirSync(contentRoot, { recursive: true });
const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);
doc.addPage([612, 792]).drawText('x', { x: 72, y: 700, size: 12, font });
const pdf = Buffer.from(await doc.save());

const c = openAdminWrite(fixture.sitePath('acme'));
seedSettings(c);
await uploadAsset({ db: c, contentRoot, tenantKey: 'acme', key: 'vault/book', filename: 'book.pdf', bytes: pdf, quotaLimitBytes: 50_000_000, accessClass: 'gated' });
const code = await issueCode({ db: c, contentRoot, assetKey: 'vault/book', email: 'r@example.com', orderRef: 'ORD-R-1' });
c.close();

const handle: AppHandle = await buildApp({ env: loadEnv(fixture.env), contentRoot, downloadLimits: { refusals: 10_000, all: 10_000 } });
const port = await handle.app.listen({ port: 0, host: '127.0.0.1' }).then(() => {
  const a = handle.app.server.address();
  return typeof a === 'object' && a !== null ? a.port : 0;
});
const cookieOf = (res: Res): string => {
  const raw = String(header(res, 'set-cookie') ?? '');
  return raw.slice(0, raw.indexOf(';'));
};
const m = await call({ port, path: '/d/acme', method: 'POST', host: HOST, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: code.code }) });
const cookie = cookieOf(m);
const d = await call({ port, path: '/d/acme/file', host: HOST, headers: { cookie } });
out(`# minimal issue->redeem->download: ${d.status} ${d.body.slice(0, 120)}`);
out(`# cookie ${cookie.slice(0, 40)}…`);
await handle.close();
fixture.cleanup();
