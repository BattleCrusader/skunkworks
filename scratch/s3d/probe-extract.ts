import { PDFDocument, StandardFonts } from 'pdf-lib';
import { stampPdf, type StampJob } from '../../app/download/watermark.ts';
import { pdfDrawnText } from '../../test/helpers/pdftext.ts';

const doc = await PDFDocument.create();
const f = await doc.embedFont(StandardFonts.Helvetica);
for (let i = 0; i < 2; i += 1) doc.addPage([612, 792]).drawText(`chapter ${i + 1}`, { x: 72, y: 700, size: 14, font: f });
const bytes = Buffer.from(await doc.save());

const job: StampJob = {
  kind: 'pdf',
  sourcePath: '',
  logoPath: null,
  specSha: 'a'.repeat(64),
  text: 'licensed to alice@example.com · order ORD-ALICE-1001',
  position: 'bottom-band',
  opacity: 0.45,
  scale: 0.25,
  rotation: 0,
  pages: 'all',
  format: 'pdf',
};
// write source
const { writeFileSync, mkdtempSync } = await import('node:fs');
const { join } = await import('node:path');
const dir = mkdtempSync('/tmp/skw-wm-');
writeFileSync(join(dir, 'src.pdf'), bytes);
job.sourcePath = join(dir, 'src.pdf');
const out = await stampPdf(job);
writeFileSync(join(dir, 'out.pdf'), out);
console.log('size', bytes.length, '->', out.length);
console.log('extracted:', JSON.stringify(pdfDrawnText(out)));
const raw = out.toString('latin1');
console.log('streams', (raw.match(/stream/g) ?? []).length, 'Tj', (raw.match(/Tj/g) ?? []).length);
console.log('dir', dir);
