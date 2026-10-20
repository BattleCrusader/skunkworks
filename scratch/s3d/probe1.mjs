import { PDFDocument, StandardFonts } from 'pdf-lib';
const PDF = '%PDF-1.7\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
  '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\ntrailer<</Root 1 0 R/Size 4>>\n%%EOF\n';
try { const d = await PDFDocument.load(Buffer.from(PDF,'latin1')); console.log('parsed pages', d.getPageCount()); }
catch(e){ console.log('FAILED:', e.message); }
const doc = await PDFDocument.create();
const f = await doc.embedFont(StandardFonts.Helvetica);
for (let i=0;i<2;i++){ const p=doc.addPage([612,792]); p.drawText('hello world',{x:72,y:72,size:12,font:f}); }
const bytes = await doc.save();
console.log('real pdf', bytes.length);
const d2 = await PDFDocument.load(bytes);
console.log('reload ok', d2.getPageCount());
const p2 = d2.getPage(0); p2.drawText('Zürich · Øyvind — “ok” € ¥', {x:72,y:700,size:10,font:await d2.embedFont(StandardFonts.Helvetica)});
const b2 = await d2.save();
console.log('after draw', b2.length);
// is the content stream compressed?
console.log('has FlateDecode?', Buffer.from(b2).includes(Buffer.from('FlateDecode')));
