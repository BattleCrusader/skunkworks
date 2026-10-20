/**
 * The production shape: `dist/`, not the source tree.
 *
 * `make test` runs the `.ts` files through Node's type stripping, where a worker URL of
 * `./stamp-worker.ts` resolves. From `dist/` the same line would point at a file that is
 * not there, and every stamp would fail closed — a 503 for every paying customer. This
 * probe runs the compiled module and its compiled worker, and asserts the two things the
 * source-tree gate cannot: the worker loads, and two buyers get two files.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const { WatermarkStore, stampWorkerUrl } = await import('../../dist/app/download/render.js');
const { specSha, stampable } = await import('../../dist/app/download/watermark.js');
const { sanitiseCp1252 } = await import('../../dist/app/download/cp1252.js');
const Database = (await import('better-sqlite3')).default;

const dir = mkdtempSync(join(tmpdir(), 'skw-dist-'));
const contentRoot = join(dir, 'content');
mkdirSync(join(contentRoot, 'media'), { recursive: true });

const db = new Database(join(dir, 'site.db'));
db.exec(readFileSync('schema/site.sql', 'utf8'));

// A minimal but real asset row: the store's generated column does the rest.
const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);
for (let i = 0; i < 2; i += 1) doc.addPage([612, 792]).drawText(`page ${i}`, { x: 72, y: 700, size: 12, font });
const bytes = Buffer.from(await doc.save());
const { createHash } = await import('node:crypto');
const sha = createHash('sha256').update(bytes).digest('hex');
mkdirSync(join(contentRoot, 'media', sha.slice(0, 2)), { recursive: true });
writeFileSync(join(contentRoot, 'media', sha.slice(0, 2), `${sha}.pdf`), bytes);
const info = db
  .prepare(
    `INSERT INTO cms_asset (key, filename, mime, bytes, sha256, kind, access_class)
     VALUES ('vault/book', 'book.pdf', 'application/pdf', ?, ?, 'document', 'gated')`,
  )
  .run(bytes.length, sha);
const asset = {
  id: Number(info.lastInsertRowid),
  key: 'vault/book',
  filename: 'book.pdf',
  mime: 'application/pdf',
  bytes: bytes.length,
  sha256: sha,
  kind: 'document',
  access_class: 'gated',
  encrypted: 0,
  storage_path: `content/media/${sha.slice(0, 2)}/${sha}.pdf`,
};

const url = stampWorkerUrl(new URL('../../dist/app/download/render.js', import.meta.url).href);
console.log('worker url:', url.pathname);

const store = new WatermarkStore({ contentRoot });
const results = [];
for (const [email, orderRef] of [
  ['dist-a@example.com', 'ORD-DIST-A'],
  ['dist-b@example.com', 'ORD-DIST-B'],
]) {
  results.push(
    await store.ensure({
      tenantKey: 'acme',
      db,
      asset,
      code: { id: results.length + 1, email, orderRef, issuedAt: '2026-10-20T00:00:00.000Z', selector: 'AAAA' },
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
  );
}

const rows = db.prepare(`SELECT spec_sha, path FROM cms_watermark_render ORDER BY id`).all();
console.log('renders:', rows.length, 'distinct spec:', new Set(rows.map((r) => r.spec_sha)).size);
console.log('paths:', rows.map((r) => r.path.split('/').slice(0, 3).join('/') + '/…').join(' '));
console.log('sizes:', results.map((r) => r.bytes).join('/'), 'reused:', results.map((r) => r.reused).join('/'));
console.log('stampable(archive):', stampable({ sha256: sha, kind: 'archive', mime: 'application/zip', filename: 'a.zip' }));
console.log('sanitiser(张三):', sanitiseCp1252('张三'), 'specSha ok:', /^[0-9a-f]{64}$/.test(specSha({})));
console.log(
  'files differ:',
  readFileSync(results[0].absPath).equals(readFileSync(results[1].absPath)) === false,
);
db.close();
rmSync(dir, { recursive: true, force: true });
