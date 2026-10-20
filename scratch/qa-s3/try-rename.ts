import { mkdirSync, readdirSync, readlinkSync, statSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import sharp from 'sharp';
import { uploadAsset, renameAsset } from '../../app/assets/library.ts';
import { makeFixture } from '../../test/helpers/fixture.ts';
import { openAdminWrite } from '../../app/db/classes.ts';

const fixture = makeFixture({ specs: [{ key: 'acme', hosts: ['acme.test'] }] });
const contentRoot = join(fixture.dir, 'content');
mkdirSync(contentRoot, { recursive: true });
const db = openAdminWrite(fixture.sitePath('acme'));
const bytes = await sharp({ create: { width: 320, height: 240, channels: 3, background: { r: 10, g: 20, b: 20 } } }).jpeg().toBuffer();
const up = await uploadAsset({ db, contentRoot, tenantKey: 'acme', key: 'campaign/spring', filename: 'x.jpg', bytes, quotaLimitBytes: 10_000_000, accessClass: 'public' });
console.log('sha', up.asset.sha256.slice(0,8), 'path', up.asset.storage_path);
console.log('public tree:', readdirSync(join(contentRoot, 'public', 'campaign')).map(f => `${f} -> ${readlinkSync(join(contentRoot,'public','campaign',f))}`));
for (const [from, to] of [['campaign/spring','campaign/summer'], ['campaign/summer','campaign/spring'], ['campaign/spring','campaign/summer']]) {
  renameAsset(db, { from, to, contentRoot });
  const dir = join(contentRoot, 'public', 'campaign');
  console.log(`after ${from}->${to}:`, existsSync(dir) ? readdirSync(dir).map(f => `${f} -> ${readlinkSync(join(dir,f))}`) : 'NO DIR');
}
console.log('edge inc:', existsSync(join(contentRoot,'edge','media-aliases.inc')) ? 'yes' : 'no');
db.close(); fixture.cleanup();
