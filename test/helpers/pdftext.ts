/**
 * Extract the text a PDF actually **draws** — not its metadata.
 *
 * A watermark that lives in `/Subject` is a watermark a buyer can delete with one
 * `qpdf --replace-info` call, so the gate that proves attribution must read the
 * content stream. pdf-lib flate-encodes the streams it writes, so every `stream …
 * endstream` is tried as zlib first and as raw text second; the `(…) Tj` operands are
 * decoded through cp1252, which is the encoding a WinAnsi font wrote them in.
 */
import { inflateSync } from 'node:zlib';

import { cp1252Char } from '../../app/download/cp1252.ts';

function unescapePdfString(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i] as string;
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = raw[i + 1] ?? '';
    i += 1;
    if (next === 'n') out += '\n';
    else if (next === 'r') out += '\r';
    else if (next === 't') out += '\t';
    else if (next === 'b') out += '\b';
    else if (next === 'f') out += '\f';
    else if (next === '(' || next === ')' || next === '\\') out += next;
    else if (/[0-7]/.test(next)) {
      // Octal escape: up to three digits, already consumed one.
      let digits = next;
      while (digits.length < 3 && /[0-7]/.test(raw[i + 1] ?? '')) {
        digits += raw[i + 1];
        i += 1;
      }
      out += String.fromCharCode(Number.parseInt(digits, 8));
    } else out += next;
  }
  return out;
}

/** Byte-level cp1252 decode, because `latin1` mangles 0x80–0x9F (`€ “ ” – …`). */
function decodeCp1252(bytes: Buffer): string {
  let out = '';
  for (const b of bytes) out += cp1252Char(b);
  return out;
}

export function pdfDrawnText(bytes: Buffer): string {
  const haystack = bytes.toString('latin1');
  const chunks: string[] = [];
  let at = 0;
  for (;;) {
    const start = haystack.indexOf('stream', at);
    if (start === -1) break;
    // `endstream` contains `stream`, so skip past the keyword itself.
    let bodyStart = start + 'stream'.length;
    if (haystack[bodyStart] === '\r') bodyStart += 1;
    if (haystack[bodyStart] === '\n') bodyStart += 1;
    const end = haystack.indexOf('endstream', bodyStart);
    if (end === -1) break;
    const slice = bytes.subarray(bodyStart, end);
    let text: string;
    try {
      text = decodeCp1252(inflateSync(slice));
    } catch {
      text = decodeCp1252(slice);
    }
    chunks.push(text);
    at = end + 'endstream'.length;
  }

  const content = chunks.join('\n');
  let drawn = '';
  for (let i = 0; i < content.length; i += 1) {
    // pdf-lib writes `drawText` as a **hex** string — `<4F52442D31303031> Tj`; a producer
    // that writes a literal `(…)` string is handled too, because this helper's job is to
    // read what the page draws, not to assume which library drew it.
    if (content[i] === '<') {
      const close = content.indexOf('>', i);
      if (close === -1) break;
      const hex = content.slice(i + 1, close).replace(/\s+/g, '');
      if (/^[0-9A-Fa-f]*$/.test(hex) && /^\s*Tj/.test(content.slice(close + 1, close + 8))) {
        if (hex.length % 2 === 0) drawn += `${decodeCp1252(Buffer.from(hex, 'hex'))}\n`;
        i = close;
      }
      continue;
    }
    if (content[i] !== '(') continue;
    // A `(` inside a string is data, not a nested string: walk to the matching `)`.
    let depth = 0;
    let j = i;
    let raw = '';
    for (; j < content.length; j += 1) {
      const ch = content[j] as string;
      if (ch === '\\') {
        raw += ch + (content[j + 1] ?? '');
        j += 1;
        continue;
      }
      if (ch === '(') {
        depth += 1;
        if (depth === 1) continue;
      }
      if (ch === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
      raw += ch;
    }
    const after = content.slice(j + 1, j + 8);
    if (/^\s*Tj/.test(after)) drawn += `${unescapePdfString(raw)}\n`;
    i = j;
  }
  return drawn;
}
