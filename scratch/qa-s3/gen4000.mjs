
import { PDFDocument, StandardFonts } from "pdf-lib";
import { writeFileSync, statSync } from "node:fs";
const t0 = Date.now();
const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);
for (let i = 0; i < 4000; i++) { const p = doc.addPage([612,792]); p.drawText(`chapter ${i+1}`, {x:72,y:700,size:14,font}); }
const bytes = Buffer.from(await doc.save());
writeFileSync("/tmp/big4000.pdf", bytes);
console.log("gen ms", Date.now()-t0, "bytes", bytes.length);
