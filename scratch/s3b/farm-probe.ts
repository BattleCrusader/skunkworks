/**
 * S3b probe — build a farm the way the e2e gate does, then ask a real nginx (in Docker) for
 * every name and print what it answered. Not a gate: a diagnostic used once while wiring the
 * e2e harness, kept because "which names did the container actually see" is the first question
 * any future farm bug asks.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import sharp from 'sharp';

import { uploadAsset } from '../../app/assets/library.ts';
import { ensureVariants } from '../../app/assets/renditions.ts';
import { openAdminWrite } from '../../app/db/classes.ts';
import { REPO, makeFixture } from '../../test/helpers/fixture.ts';

const fixture = makeFixture({ specs: [{ key: 'acme', hosts: ['acme.test'], title: 'Acme' }] });
const tmp = mkdtempSync(join(REPO, '.probe-media-'));
const contentRoot = join(tmp, 'content');
mkdirSync(contentRoot, { recursive: true });

const db = openAdminWrite(fixture.sitePath('acme'));
const bytes = await sharp({ create: { width: 640, height: 480, channels: 3, background: { r: 20, g: 90, b: 160 } } })
  .jpeg({ quality: 90 })
  .toBuffer();
const result = await uploadAsset({
  db,
  contentRoot,
  tenantKey: 'acme',
  key: 'banner/home',
  filename: 'home.jpg',
  bytes,
  quotaLimitBytes: 10_000_000,
  altText: 'banner home',
});
const variants = await ensureVariants({ db, contentRoot, assetId: result.asset.id });
// A rename, so the alias map has an entry before the container starts.
const { renameAsset } = await import('../../app/assets/library.ts');
const { aliasMapText } = await import('../../app/assets/farm.ts');
renameAsset(db, { from: 'banner/home', to: 'banner/home2', contentRoot });
process.stdout.write(`map text:\n${aliasMapText(db)}\n`);
db.close();

process.stdout.write(`media files: ${readdirSync(join(contentRoot, 'media')).length}\n`);
for (const variant of variants) process.stdout.write(`  variant ${variant.label}/${variant.format} ${variant.storage_path} exists=${readFileSync(join(contentRoot, variant.storage_path.replace(/^content\//, ''))).length}\n`);
const links = spawnSync('find', [join(contentRoot, 'public'), '-type', 'l'], { encoding: 'utf8' }).stdout.trim().split('\n');
for (const link of links) process.stdout.write(`  link ${link.replace(contentRoot, '')} -> ${readlinkSync(link)}\n`);

const conf = join(tmp, 'conf.d');
mkdirSync(conf, { recursive: true });
writeFileSync(
  join(conf, '10.conf'),
  `server {\n  listen 80;\n  server_name acme.test;\n  location /media/ {\n    if ($skw_media_alias) { return 301 $skw_media_alias; }\n    alias /srv/content/public/;\n    try_files $uri =404;\n  }\n}\n`,
);
writeFileSync(
  join(tmp, 'nginx.conf'),
  'worker_processes 1;\nerror_log /dev/stderr warn;\npid /tmp/nginx.pid;\nevents { worker_connections 64; }\nhttp { include /etc/nginx/mime.types; default_type application/octet-stream; access_log off; map $uri $skw_media_alias { default ""; include /srv/content/edge/*.inc; } include /etc/nginx/conf.d/*.conf; }\n',
);

const container = `skw-probe-media-${process.pid}`;
spawnSync('docker', ['rm', '-f', container], { encoding: 'utf8' });
const run = spawnSync(
  'docker',
  [
    'run', '--rm', '-d', '--name', container, '-p', '18095:80',
    '-v', `${join(tmp, 'nginx.conf')}:/etc/nginx/nginx.conf:ro`,
    '-v', `${conf}:/etc/nginx/conf.d:ro`,
    '-v', `${contentRoot}:/srv/content:ro`,
    'nginx:1.31-alpine',
  ],
  { encoding: 'utf8' },
);
process.stdout.write(`docker run: ${run.status} ${run.stderr}\n`);
await new Promise((r) => setTimeout(r, 2000));

const inside = spawnSync('docker', ['exec', container, 'sh', '-c', 'ls -la /srv/content/public/banner; echo ---; ls /srv/content/media/*'], {
  encoding: 'utf8',
});
process.stdout.write(`inside:\n${inside.stdout}${inside.stderr}\n`);

for (const name of ['banner/home2.jpg', 'banner/home2@thumb.webp', 'banner/home.jpg']) {
  const curl = spawnSync(
    'curl',
    ['-s', '-o', '/dev/null', '-w', '%{http_code}', '-H', 'Host: acme.test', `http://127.0.0.1:18095/media/${name}`],
    { encoding: 'utf8' },
  );
  process.stdout.write(`GET /media/${name} -> ${curl.stdout}\n`);
}

spawnSync('docker', ['rm', '-f', container], { encoding: 'utf8' });
rmSync(tmp, { recursive: true, force: true });
fixture.cleanup();
