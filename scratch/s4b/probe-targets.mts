/**
 * S4b probe 3 — do the two document targets emit the site's bytes, and does the Astro
 * project build with `npx astro build`? Measured before the gate is written, because the
 * gate asserts byte equality and the number of places that can differ is not zero.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { openAdminWrite } from '../../app/db/classes.ts';
import { loadEnv } from '../../app/env.ts';
import { runExport } from '../../app/export/index.ts';
import { buildApp } from '../../app/main.ts';
import { REPO, SCHEMA, makeFixture } from '../../test/helpers/fixture.ts';
import { call } from '../../test/helpers/http.ts';

const NOW = '2026-10-20T12:00:00.000Z';
const fixture = makeFixture({ specs: [{ key: 'acme', hosts: ['acme.test'] }] });
const contentRoot = join(fixture.dir, 'content');

const db = openAdminWrite(fixture.sitePath('acme'));
const sha = createHash('sha256').update('bytes:work/one').digest('hex');
db.prepare(
  `INSERT INTO cms_asset (key, filename, mime, bytes, sha256, kind, width, height, access_class)
   VALUES ('work/one','one.jpg','image/jpeg',12,?,'image',1200,800,'public')`,
).run(sha);
const assetRow = db.prepare(`SELECT storage_path FROM cms_asset WHERE key='work/one'`).get() as { storage_path: string };
mkdirSync(dirname(join(fixture.dir, assetRow.storage_path)), { recursive: true });
writeFileSync(join(fixture.dir, assetRow.storage_path), 'bytes:work/one');
db.prepare(
  `INSERT INTO cms_page (path, slug, title, status, template, body_html, body_css, published_at)
   VALUES ('/about','about','About & Co <ltd>','published','page',?,'.a{color:red}','2026-01-01T00:00:00.000Z')`,
).run('<section data-gjs-type="hero"><h1>About</h1><img data-asset-key="work/one" alt="One"></section>');
db.prepare(
  `INSERT INTO cms_page (path, slug, title, status, template, body_html, body_css, published_at)
   VALUES ('/plain','plain','Plain','published','page','<p>plain</p>','','2026-01-01T00:00:00.000Z')`,
).run();
db.close();

const work = mkdtempSync(join(tmpdir(), 'skw-s4b-probe-'));
const outStatic = join(work, 'static');
const outAstro = join(work, 'astro');

for (const [target, out] of [
  ['static', outStatic],
  ['astro', outAstro],
] as const) {
  const db2 = openAdminWrite(fixture.sitePath('acme'));
  const r = runExport({
    target,
    db: db2,
    tenantKey: 'acme',
    out,
    exportNow: NOW,
    contentRoot,
    repoRoot: REPO,
    tmpDir: work,
    origin: 'https://acme.test',
  });
  db2.close();
  console.log(target, 'ok=', r.ok, r.ok ? `${r.tree.files} files sha=${r.tree.sha256.slice(0, 16)}` : JSON.stringify(r.refusals));
}

const handle = await buildApp({ env: loadEnv(fixture.env), schemaDir: SCHEMA, contentRoot });
await handle.app.listen({ port: 0, host: '127.0.0.1' });
const addr = handle.app.server.address();
const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
const served = (await call({ port, path: '/about', host: 'acme.test' })).body;
console.log('served bytes', served.length);

const stat = readFileSync(join(outStatic, 'about/index.html'), 'utf8');
console.log('static === served:', stat === served, stat.length);
if (stat !== served) {
  for (let i = 0; i < Math.max(stat.length, served.length); i += 1) {
    if (stat[i] !== served[i]) {
      console.log('first diff at', i, JSON.stringify(served.slice(i - 20, i + 30)), 'vs', JSON.stringify(stat.slice(i - 20, i + 30)));
      break;
    }
  }
}

// --- the astro build -------------------------------------------------------
const buildDir = join(work, 'astro-build');
cpSync(outAstro, buildDir, { recursive: true });
symlinkSync(join(REPO, 'node_modules'), join(buildDir, 'node_modules'), 'dir');
const started = Date.now();
try {
  const out = execFileSync('npx', ['astro', 'build'], { cwd: buildDir, encoding: 'utf8', stdio: 'pipe' });
  console.log('astro build ok in', Date.now() - started, 'ms');
  console.log(out.split('\n').filter((l) => l.includes('page') || l.includes('Complete') || l.includes('error')).join('\n'));
} catch (err) {
  console.log('astro build FAILED', (err as { stdout?: string }).stdout?.slice(-2000), (err as { stderr?: string }).stderr?.slice(-2000));
}
try {
  const built = readFileSync(join(buildDir, 'dist', 'about', 'index.html'), 'utf8');
  console.log('astro dist === served:', built === served, built.length);
  if (built !== served) {
    for (let i = 0; i < Math.max(built.length, served.length); i += 1) {
      if (built[i] !== served[i]) {
        console.log('first diff at', i, JSON.stringify(served.slice(i - 20, i + 40)), 'vs', JSON.stringify(built.slice(i - 20, i + 40)));
        break;
      }
    }
  }
} catch (err) {
  console.log('no dist', String(err));
}

console.log('plain static:', JSON.stringify(readFileSync(join(outStatic, 'plain/index.html'), 'utf8')));
console.log('plain served:', JSON.stringify((await call({ port, path: '/plain', host: 'acme.test' })).body));

await handle.close();
fixture.cleanup();
