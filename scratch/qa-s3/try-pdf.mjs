
import { PDFDocument } from "pdf-lib";
const cases = {
  "startxref-past-eof": "%PDF-1.7\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\ntrailer<</Root 1 0 R/Size 4>>\nstartxref\n999999\n%%EOF\n",
  "garbage-xref": "%PDF-1.7\nxref\n0 4\n0000000000 65535 f \n0000000010 00000 n \ntrailer<</Size 4>>\nstartxref\n0\n%%EOF\n",
  "truncated-mid-stream": "%PDF-1.7\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R>>endobj\n4 0 obj<</Length 500>>stream\nBT /F1 12 Tf (hello) Tj ET\n",
};
for (const [k,v] of Object.entries(cases)) {
  try { const d = await PDFDocument.load(Buffer.from(v, "latin1")); console.log(k, "LOADED pages=", d.getPageCount()); }
  catch (e) { console.log(k, "THREW:", String(e).split("\n")[0].slice(0,120)); }
}
