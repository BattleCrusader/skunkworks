import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { openAdminWrite } from '../../app/db/classes.ts';
import { buildProjection } from '../../app/export/project.ts';
import { makeFixture } from '../../test/helpers/fixture.ts';

const fixture = makeFixture({ specs: [{ key: 'acme', hosts: ['acme.test'] }] });
const db = openAdminWrite(fixture.sitePath('acme'));
const sha = createHash('sha256').update('bytes:vault/handbook').digest('hex');
db.prepare(`INSERT INTO cms_asset (key, filename, mime, bytes, sha256, kind, width, height, access_class)
  VALUES ('vault/handbook','h.pdf','application/pdf',12,?,'document',1200,800,'gated')`).run(sha);
const row = db.prepare('SELECT id, storage_path FROM cms_asset WHERE key=?').get('vault/handbook') as any;
const file = join(fixture.dir, row.storage_path);
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, 'bytes:vault/handbook');
db.prepare('INSERT INTO cms_asset_link (asset_id, owner_kind, owner_id) VALUES (?,?,?)').run(row.id, 'settings', 1);
console.log('links', db.prepare('SELECT * FROM cms_asset_link').all());
db.close();
const r = openAdminRead(fixture.sitePath('acme'));
function openAdminRead(p: string) { return new Database(p, { readonly: true, fileMustExist: true }); }
console.log('readonly links', r.prepare('SELECT * FROM cms_asset_link').all());
console.log(JSON.stringify(buildProjection({ db: r, tenantKey: 'acme', target: 'static', exportNow: '2026-10-20T12:00:00.000Z', contentRoot: join(fixture.dir, 'content') }), null, 1).slice(0, 800));
r.close(); fixture.cleanup();
