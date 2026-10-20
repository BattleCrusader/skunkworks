/**
 * §7.5 / D23 — **one cp1252 sanitiser, and this is it.**
 *
 * A built-in PDF font is WinAnsi, which is cp1252, which is *not* ASCII: `München`,
 * `Øyvind`, `€ “ ” – … ¥ £ © ° ÷` all encode, and mangling them would be the same
 * crime as serving an un-stamped file for a smaller reason. Only the characters
 * outside cp1252 — CJK, Cyrillic, Greek, Arabic, emoji — have nowhere to go, and they
 * get a transliteration when one exists (`→` is `->`) and `?` otherwise.
 *
 * Two properties this module exists to keep:
 *
 *   1. **The fallback is `?`, never a throw.** A buyer's name must not crash a paid
 *      download; the renderer's WinAnsi encoder is the second line of defence, and a
 *      throw there is `503 SKW_E_SEC_WATERMARK_FAILED` — a denial for the buyer, which
 *      is worse than a `?` in a footer.
 *   2. **`isCp1252` is the assertion the sanitiser's own test makes**, so a future font
 *      or a new call site cannot silently reintroduce a character the encoder refuses.
 *      It is also what lets a caller *check* rather than trust.
 *
 * `order_ref` and `code_id` are ASCII by construction (§7.5), so attribution survives
 * any mangling of the name beside them: the footer always carries one of the two.
 *
 * There is no second implementation of this table in the tree. The PDF path, the image
 * path and the tests all call these two functions.
 *
 * Exclusive witness: test/download-watermark.test.ts W9
 */

/**
 * cp1252's 0x80–0x9F block. `null` is one of the five bytes cp1252 leaves undefined
 * (0x81, 0x8D, 0x8F, 0x90, 0x9D) — a decoder that mapped them would invent characters.
 */
const HIGH_BLOCK: readonly (number | null)[] = [
  0x20ac, null, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039,
  0x0152, null, 0x017d, null, null, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, null, 0x017e, 0x0178,
];

/** byte → Unicode code point, 256 entries, no holes. */
const DECODE: readonly number[] = (() => {
  const table: number[] = [];
  for (let b = 0; b < 256; b += 1) {
    if (b < 0x80) table.push(b);
    else if (b < 0xa0) table.push(HIGH_BLOCK[b - 0x80] ?? 0xfffd);
    else table.push(b);
  }
  return table;
})();

/** code point → byte. Built once; the sanitiser's membership test is a map lookup. */
const ENCODE = new Map<number, number>(DECODE.map((cp, byte) => [cp, byte] as const).filter(([cp]) => cp !== 0xfffd));

/**
 * One character in, one or more characters out. Only what cp1252 *cannot* carry
 * appears here: anything the encoder accepts is left exactly as the buyer wrote it.
 */
const TRANSLITERATIONS: Readonly<Record<string, string>> = {
  '→': '->',
  '←': '<-',
  '↑': '^',
  '↓': 'v',
  '↔': '<->',
  '⇒': '=>',
  '≤': '<=',
  '≥': '>=',
  '≠': '!=',
  '≈': '~=',
  '−': '-',
  '–': '–', // cp1252 already: en dash
  '—': '—', // cp1252 already: em dash
  '―': '--',
  '‐': '-',
  '‑': '-',
  '‒': '-',
  '✓': '[ok]',
  '✔': '[ok]',
  '✗': '[x]',
  '✘': '[x]',
  '•': '•', // cp1252 already
  '⁃': '-',
  '⁄': '/',
  '×': 'x',
  'ﬁ': 'fi',
  'ﬂ': 'fl',
  'ﬀ': 'ff',
  'ﬃ': 'ffi',
  'ﬄ': 'ffl',
  'ﬅ': 'st',
  'ﬆ': 'st',
  '\u2009': ' ',
  '\u200a': ' ',
  '\u202f': ' ',
  '\u2007': ' ',
  '\u2060': '',
  '\ufeff': '',
};

/** The byte a cp1252 encoder would write for this code point, or `undefined`. */
export function cp1252Byte(codePoint: number): number | undefined {
  return ENCODE.get(codePoint);
}

/** The character at this byte. 0x81/0x8D/0x8F/0x90/0x9D decode to U+FFFD, as they must. */
export function cp1252Char(byte: number): string {
  return String.fromCodePoint(DECODE[byte & 0xff] as number);
}

/**
 * Render `text` into the character set a WinAnsi font can draw.
 *
 * Order: a cp1252 character is kept; otherwise a known transliteration is substituted;
 * otherwise `?`. Control characters become spaces and runs of whitespace collapse, so
 * one footer is one line.
 */
export function sanitiseCp1252(text: string): string {
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    if (cp === 0x09 || cp === 0x0a || cp === 0x0d) {
      out += ' ';
      continue;
    }
    if (cp < 0x20 || cp === 0x7f) continue; // a control character in a footer is noise
    if (ENCODE.has(cp)) {
      out += ch;
      continue;
    }
    const transliterated = TRANSLITERATIONS[ch];
    if (transliterated !== undefined) {
      out += transliterated;
      continue;
    }
    out += '?';
  }
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * True when every character is one a WinAnsi encoder accepts. Newlines and tabs are
 * allowed because they are *layout*, not content: a caller that joins lines for a test
 * is not making a claim about the footer.
 */
export function isCp1252(text: string): boolean {
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    if (cp === 0x09 || cp === 0x0a || cp === 0x0d) continue;
    if (!ENCODE.has(cp)) return false;
  }
  return true;
}
