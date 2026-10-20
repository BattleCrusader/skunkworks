import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { uploadAsset } from '../../app/assets/library.ts';
import { openAdminWrite } from '../../app/db/classes.ts';
import { loadEnv } from '../../app/env.ts';
import { buildApp } from '../../app/main.ts';
import { issueCode } from '../../app/download/code.ts';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { makeFixture } from '../../test/helpers/fixture.ts';
import { call } from '../../test/helpers/http.ts';

const fixture = makeFixture({ specs: [{ key: 'acme', hosts: ['acme.test'] }] });
const contentRoot = join(fixture.dir, 'content');
mkdirSync(join(contentRoot, 'media'), { recursive: true });

const doc = await PDFDocument.create();
doc.addPage([612, 792]).drawText('hi', { x: 72, y: 72, size: 12, font: await doc.embedFont(StandardFonts.Helvetica) });
const bytes = Buffer.from(await doc.save());

const db = openAdminWrite(fixture.sitePath('acme'));
const up = await uploadAsset({ db, contentRoot, tenantKey: 'acme', key: 'vault/book', filename: 'b.pdf', bytes, quotaLimitBytes: 1e7, accessClass: 'gated' });
db.close();

const handle = await buildApp({
  env: loadEnv(fixture.env),
  contentRoot,
  downloadLimits: { refusals: 10_000, all: 10_000 },
  watermark: { render: async () => { throw new Error('renderer exploded'); } },
});
const port = await handle.app.listen({ port: 0, host: '127.0.0.1' }).then(() => {
  const a = handle.app.server.address();
  return typeof a === 'object' && a !== null ? a.port : 0;
});

const db2 = openAdminWrite(fixture.sitePath('acme'));
const issued = await issueCode({ db: db2, contentRoot, assetKey: 'vault/book', email: 'a@b.c', orderRef: 'ORD-1' });
db2.close();
const r1 = await call({ port, path: '/d/acme', method: 'POST', host: 'acme.test', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: issued.code }) });
const cookie = String(r1.headers['set-cookie'] ?? '').split(';')[0];
const r2 = await call({ port, path: '/d/acme/file', host: 'acme.test', headers: { cookie } });
console.log('status', r2.status, 'body', r2.body);
console.log('rows', openAdminWrite(fixture.sitePath('acme')).prepare('SELECT kind,outcome FROM cms_download_event').all());
await handle.close();
fixture.cleanup();
