/**
 * S4d item B's fixture: a **real** control.db + tenant site.db + CMS bundle, built with the
 * product's own DDL and exporter. No mocks; the same files `install.sh` expects.
 *
 * Run from the repository root: `node scratch/s4d-compose/make-bundle.mjs`.
 */
import Database from 'better-sqlite3';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const data = join(here, 'data');
const content = join(here, 'content');
const out = join(here, 'bundle');

rmSync(here + '/data', { recursive: true, force: true });
rmSync(here + '/bundle', { recursive: true, force: true });
rmSync(here + '/content', { recursive: true, force: true });
for (const dir of ['tenants/acme', 'run', 'certs', 'content/media/ab']) mkdirSync(join(data, dir), { recursive: true });
mkdirSync(content, { recursive: true });

const control = new Database(join(data, 'control.db'));
control.pragma('journal_mode = WAL');
control.exec(readFileSync(join(repo, 'schema', 'control.sql'), 'utf8'));
const tenant = control
  .prepare(
    `INSERT INTO tenant (key, mode, status, display_name, db_version, demo_expires_at)
     VALUES ('acme', 'production', 'active', 'Acme', 3, NULL)`,
  )
  .run();
const tenantId = Number(tenant.lastInsertRowid);
// `cert_state: none` is §12.5's "listen 80 only" shape: nothing to issue, so the vhost does
// not reference a certificate file that does not exist. The ACME service still runs and is
// observed separately; a public CA cannot issue for acme.test.
control
  .prepare('INSERT INTO domain (host, tenant_id, kind, is_primary, cert_state) VALUES (?, ?, ?, ?, ?)')
  .run('acme.test', tenantId, 'primary', 1, 'none');
control.close();

const site = new Database(join(data, 'tenants', 'acme', 'site.db'));
site.pragma('journal_mode = WAL');
site.exec(readFileSync(join(repo, 'schema', 'site.sql'), 'utf8'));
site.prepare(
  `INSERT INTO cms_page (path, slug, title, status, template, body_html, published_at)
   VALUES ('/', 'home', 'Acme home', 'published', 'page', '<h1>Acme home</h1>', '2026-10-21T00:00:00.000Z')`,
).run();
site.close();

process.stdout.write(`${data}\n${content}\n${out}\n`);
