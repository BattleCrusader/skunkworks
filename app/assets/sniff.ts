/**
 * §7.5 / D13 — upload hardening: **the bytes decide the type, not the name.**
 *
 * What this module owns, and why each part is here rather than in the route:
 *
 *   1. **The cap** runs before the sniff, because decoding is the expensive step and an
 *      attacker chooses the size. `SKW_E_PLT_BODY_TOO_LARGE` (413) is the same code the
 *      fastify body limit uses, so a caller cannot tell which layer refused.
 *   2. **SVG is refused in v1** (`reason='svg_forbidden'`), by extension *and* by content,
 *      because an SVG is a script document: `<svg onload=…>` passes every magic-byte test
 *      that only looks for `<`, and re-encoding it is not implementable. The refusal is
 *      `415 SKW_E_SEC_UPLOAD_REJECTED`, the taxonomy's upload code.
 *   3. **Magic bytes are the authority.** A `.png` whose bytes are `<?php` is not an image
 *      with a wrong name; it is a payload, and it is refused (`reason='magic_mismatch'`)
 *      *before* anything is written. The extension only chooses which type the bytes must
 *      prove they are — it never becomes a path segment (`store.ts` derives those from the
 *      checksum and this module's fixed extension table).
 *   4. **Images are re-encoded through libvips**, which is what strips EXIF — including the
 *      GPS IFD, which is the metadata that turns a product photo into a home address.
 *      Nothing is copied through: the stored bytes are the encoder's output, so an EXIF
 *      block cannot survive by being "unknown to the stripper".
 *
 * The eight accepted types are exactly the eight the DDL's generated `storage_path` column
 * knows (`image/webp|jpeg|png|avif`, `application/pdf`, `video/mp4`, `audio/mpeg`,
 * `application/zip`). A ninth would be stored as `.bin` and served as octet-stream, so it is
 * refused here instead of being silently mislabelled. Video and audio are **not** parsed in
 * v1 — the magic bytes are checked and the bytes are stored unchanged; that limitation is
 * stated in the S3a report rather than implied away.
 */
import { createHash } from 'node:crypto';
import { extname } from 'node:path';

import sharp from 'sharp';

import { AppError } from '../errors.ts';

/** 25 MiB. Larger than any image a site needs, smaller than a video the box should hold. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export type AssetKind = 'image' | 'video' | 'audio' | 'document' | 'archive';

export interface Magic {
  mime: string;
  ext: string;
  kind: AssetKind;
}

/**
 * The closed set, in the DDL's order. `ext` is the token the generated `storage_path`
 * column produces; a mismatch between the two would make the column lie about the file.
 */
export const TYPES: Record<string, Magic> = {
  'image/webp': { mime: 'image/webp', ext: 'webp', kind: 'image' },
  'image/jpeg': { mime: 'image/jpeg', ext: 'jpg', kind: 'image' },
  'image/png': { mime: 'image/png', ext: 'png', kind: 'image' },
  'image/avif': { mime: 'image/avif', ext: 'avif', kind: 'image' },
  'application/pdf': { mime: 'application/pdf', ext: 'pdf', kind: 'document' },
  'video/mp4': { mime: 'video/mp4', ext: 'mp4', kind: 'video' },
  'audio/mpeg': { mime: 'audio/mpeg', ext: 'mp3', kind: 'audio' },
  'application/zip': { mime: 'application/zip', ext: 'zip', kind: 'archive' },
};

/** The extension a filename claims → the type its bytes must prove. */
export const MIME_BY_EXT: Record<string, string> = {
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.avif': 'image/avif',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.zip': 'application/zip',
};

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function ascii(bytes: Buffer, start: number, end: number): string {
  if (bytes.length < end) return '';
  return bytes.subarray(start, end).toString('latin1');
}

/**
 * The magic-byte table. Order is load-bearing: `avif` and `mp4` share the `ftyp` box, so
 * the brand decides, and both are checked before the generic `ftyp` fallback.
 */
export function sniffMagic(bytes: Buffer): Magic | null {
  if (bytes.length === 0) return null;
  if (bytes.subarray(0, 8).equals(PNG)) return TYPES['image/png'] ?? null;
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return TYPES['image/jpeg'] ?? null;
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return TYPES['image/webp'] ?? null;
  if (ascii(bytes, 4, 8) === 'ftyp') {
    const brand = ascii(bytes, 8, 12);
    if (brand === 'avif' || brand === 'avis') return TYPES['image/avif'] ?? null;
    return TYPES['video/mp4'] ?? null;
  }
  if (ascii(bytes, 0, 5) === '%PDF-') return TYPES['application/pdf'] ?? null;
  if (ascii(bytes, 0, 3) === 'ID3') return TYPES['audio/mpeg'] ?? null;
  // An MPEG audio frame: eleven set bits, layer != 00.
  if (bytes.length >= 2 && bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0) return TYPES['audio/mpeg'] ?? null;
  if (ascii(bytes, 0, 2) === 'PK' && [0x03, 0x05, 0x07].includes(bytes[2] ?? 0xff)) return TYPES['application/zip'] ?? null;
  return null;
}

/** An SVG, by extension or by the first non-whitespace bytes. */
export function looksLikeSvg(filename: string, bytes: Buffer): boolean {
  if (extname(filename).toLowerCase() === '.svg') return true;
  const head = bytes.subarray(0, 512).toString('utf8').replace(/^\uFEFF/, '').trimStart().toLowerCase();
  if (head.startsWith('<svg')) return true;
  return (head.startsWith('<?xml') || head.startsWith('<!--')) && head.includes('<svg');
}

export interface Sniffed {
  mime: string;
  ext: string;
  kind: AssetKind;
  /** The exact bytes to store. For an image this is the re-encode, never the input. */
  bytes: Buffer;
  width: number | null;
  height: number | null;
  /** True when the bytes differ from the upload because they went through libvips. */
  reencoded: boolean;
}

function refuse(reason: string, message: string, detail: Record<string, unknown> = {}): AppError {
  return new AppError('SKW_E_SEC_UPLOAD_REJECTED', message, { reason, ...detail });
}

/**
 * Sniff, cap, refuse, and (for images) re-encode. Returns the bytes that will be stored —
 * so the checksum the caller computes is a checksum of *those* bytes, not of the upload.
 */
export async function sniffAndNormalise(input: {
  filename: string;
  bytes: Buffer;
  /** What the request claimed, when it claimed anything. Checked against the bytes. */
  declaredMime?: string;
  maxBytes?: number;
}): Promise<Sniffed> {
  const cap = input.maxBytes ?? MAX_UPLOAD_BYTES;
  if (input.bytes.length > cap) {
    throw new AppError('SKW_E_PLT_BODY_TOO_LARGE', `the upload is larger than ${cap} bytes`, {
      limit: cap,
      received: input.bytes.length,
    });
  }
  if (input.bytes.length === 0) throw refuse('empty', 'the upload is empty');

  if (looksLikeSvg(input.filename, input.bytes)) {
    throw refuse('svg_forbidden', 'SVG uploads are refused in v1: an SVG is a script document, not an image', {
      filename: input.filename,
    });
  }

  const claimed = input.declaredMime ?? MIME_BY_EXT[extname(input.filename).toLowerCase()];
  if (claimed === undefined || TYPES[claimed] === undefined) {
    throw refuse('type_unsupported', `unsupported upload type ${JSON.stringify(claimed ?? extname(input.filename))}`, {
      filename: input.filename,
      supported: Object.keys(TYPES),
    });
  }

  const sniffed = sniffMagic(input.bytes);
  if (sniffed === null || sniffed.mime !== claimed) {
    throw refuse(
      'magic_mismatch',
      `the upload does not look like ${claimed}; its bytes say ${sniffed?.mime ?? 'nothing'}`,
      { claimed, sniffed: sniffed?.mime ?? null, filename: input.filename },
    );
  }

  if (sniffed.kind !== 'image') {
    return { mime: sniffed.mime, ext: sniffed.ext, kind: sniffed.kind, bytes: input.bytes, width: null, height: null, reencoded: false };
  }

  // Re-encode. `rotate()` applies the EXIF orientation to the pixels before the tag is
  // dropped, so a phone photo is not silently rotated; nothing calls `withMetadata()`, which
  // is what keeps EXIF — GPS included — out of the output.
  let out: Buffer;
  let width: number | null = null;
  let height: number | null = null;
  try {
    const image = sharp(input.bytes, { failOn: 'error' }).rotate();
    switch (sniffed.mime) {
      case 'image/png':
        out = await image.png({ compressionLevel: 9 }).toBuffer();
        break;
      case 'image/jpeg':
        out = await image.jpeg({ quality: 82, mozjpeg: true }).toBuffer();
        break;
      case 'image/webp':
        out = await image.webp({ quality: 82 }).toBuffer();
        break;
      default:
        out = await image.avif({ quality: 50 }).toBuffer();
        break;
    }
    const meta = await sharp(out).metadata();
    width = meta.width ?? null;
    height = meta.height ?? null;
  } catch (err) {
    throw refuse('undecodable', 'the image could not be decoded', { reason_detail: (err as Error).name });
  }
  if (width === null || height === null) throw refuse('undecodable', 'the image has no dimensions');

  // The re-encode must still be the type it claimed, or the stored extension is a lie.
  const again = sniffMagic(out);
  if (again === null || again.mime !== sniffed.mime) {
    throw refuse('encode_mismatch', 'the re-encoded image is not the type it claimed', { mime: sniffed.mime });
  }
  return { mime: sniffed.mime, ext: sniffed.ext, kind: sniffed.kind, bytes: out, width, height, reencoded: true };
}

/** The checksum of the bytes about to be stored — over the re-encode, never the upload. */
export function sha256OfStored(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
