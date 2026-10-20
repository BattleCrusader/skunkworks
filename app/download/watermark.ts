/**
 * §7.5 (C-16), D20, D23 — **what the stamp is, and the hash that makes it per-purchaser.**
 *
 * The cache key is the **rendered spec**, never the asset: two buyers of one PDF must
 * not share bytes, and a key over the asset alone would be exactly that bug. So
 * `specSha` is SHA-256 over a canonical JSON of *everything the renderer will draw* —
 * the resolved text, the template it came from, the geometry, the pages, and the
 * SHA-256 of the logo image. The asset's own SHA-256 is `source_sha`, the second half of
 * `cms_watermark_render`'s unique key: a re-upload with the same text must not reuse a
 * render of the old bytes.
 *
 * The text resolves from the **code row** (`issued_to_email`, `order_ref`, `created_at`),
 * never from the request (§7.5: "a buyer cannot rename their copy mid-download"), and
 * every resolved character passes the one cp1252 sanitiser before it reaches a font.
 * `order_ref` and the code id are ASCII by construction, so the footer still identifies
 * the buyer when their name is CJK and becomes `?`.
 *
 * `stampable` is the honest coverage list: PDF and raster images. Video and audio are
 * not stamped in v1, and the issue screen has already told the operator so (§7.5).
 *
 * Exclusive witness: test/download-watermark.test.ts W1, W8
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { PDFDocument, StandardFonts, degrees, rgb, type PDFFont, type PDFImage, type PDFPage } from 'pdf-lib';
import sharp, { type OverlayOptions } from 'sharp';

import { sanitiseCp1252 } from './cp1252.ts';

export type WatermarkKind = 'pdf' | 'image';

export type WatermarkPosition = 'center' | 'tile' | 'corner' | 'bottom-band';
export type WatermarkPages = 'all' | 'first' | 'last';

/** §7.5's shipped template. `{order_ref}` is the half that survives any mangling. */
export const DEFAULT_TEMPLATE = 'licensed to {email} · order {order_ref}';

export interface WatermarkSpec {
  /** Bumped when the drawing changes, so an old render is not reused under a new code path. */
  v: 1;
  kind: WatermarkKind;
  /** The resolved, sanised footer. The per-purchaser part. */
  text: string;
  /** The template `text` came from, so two templates that resolve alike still differ. */
  template: string;
  position: WatermarkPosition;
  opacity: number;
  scale: number;
  rotation: number;
  pages: WatermarkPages;
  /** SHA-256 of the logo asset's bytes, or null when there is no logo. */
  logo: string | null;
  /** SHA-256 of the asset these bytes will be drawn on. */
  source: string;
}

/** The fields of `cms_download_code` a watermark may read. Never the request. */
export interface WatermarkCode {
  id: number;
  email: string | null;
  orderRef: string | null;
  /** ISO 8601; `cms_download_code.created_at`. */
  issuedAt: string;
  /** The plaintext selector — four ASCII characters, a second attribution handle. */
  selector: string;
}

export interface WatermarkAsset {
  sha256: string;
  kind: string;
  mime: string;
  filename: string;
}

export interface SpecOptions {
  template?: string | undefined;
  position?: WatermarkPosition | undefined;
  opacity?: number | undefined;
  scale?: number | undefined;
  rotation?: number | undefined;
  pages?: WatermarkPages | undefined;
  logo?: string | null | undefined;
}

/**
 * `cms_asset.watermark_spec_json` (§7.5), parsed with a refusal rather than a default for
 * anything a renderer would act on. A typo in `position` must not silently become
 * `center`: the operator asked for something, and being told "that is not a position" at
 * download time is late but honest — `issueCode` validates the same JSON at issue time.
 */
export function parseSpecJson(raw: string | null): SpecOptions {
  if (raw === null || raw.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('watermark_spec_json is not JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('watermark_spec_json is not an object');
  }
  const o = parsed as Record<string, unknown>;
  const out: SpecOptions = {};
  if (o.text_template !== undefined) {
    if (typeof o.text_template !== 'string' || o.text_template.length > 400) {
      throw new Error('watermark_spec_json.text_template is not a string of at most 400 characters');
    }
    out.template = o.text_template;
  }
  if (o.position !== undefined) {
    if (o.position !== 'center' && o.position !== 'tile' && o.position !== 'corner' && o.position !== 'bottom-band') {
      throw new Error(`watermark_spec_json.position is not one of center|tile|corner|bottom-band`);
    }
    out.position = o.position;
  }
  if (o.opacity !== undefined) {
    if (typeof o.opacity !== 'number' || !(o.opacity >= 0 && o.opacity <= 1)) {
      throw new Error('watermark_spec_json.opacity is not a number in [0,1]');
    }
    out.opacity = o.opacity;
  }
  if (o.scale !== undefined) {
    if (typeof o.scale !== 'number' || !(o.scale > 0 && o.scale <= 1)) {
      throw new Error('watermark_spec_json.scale is not a number in (0,1]');
    }
    out.scale = o.scale;
  }
  if (o.rotation !== undefined) {
    if (typeof o.rotation !== 'number' || !(o.rotation >= -180 && o.rotation <= 180)) {
      throw new Error('watermark_spec_json.rotation is not a number in [-180,180]');
    }
    out.rotation = o.rotation;
  }
  if (o.pages !== undefined) {
    if (o.pages !== 'all' && o.pages !== 'first' && o.pages !== 'last') {
      throw new Error('watermark_spec_json.pages is not one of all|first|last');
    }
    out.pages = o.pages;
  }
  if (o.sanitize !== undefined && o.sanitize !== 'cp1252') {
    // D23 is a decision, not a per-asset option: there is one sanitiser and no ASCII mode.
    throw new Error('watermark_spec_json.sanitize must be "cp1252" (the only sanitiser in v1)');
  }
  return out;
}

/** Resolve `{email}`, `{order_ref}`, `{issued_at}`, `{code_id}`, `{selector}` from the code row. */
export function resolveTemplate(template: string, code: WatermarkCode): string {
  const email = code.email === null || code.email.trim() === '' ? `buyer-${code.id}` : code.email;
  const orderRef = code.orderRef === null || code.orderRef.trim() === '' ? `code-${code.id}` : code.orderRef;
  return template
    .replaceAll('{email}', email)
    .replaceAll('{order_ref}', orderRef)
    .replaceAll('{issued_at}', code.issuedAt.slice(0, 10))
    .replaceAll('{code_id}', String(code.id))
    .replaceAll('{selector}', code.selector);
}

/** The two shapes this build can stamp. Everything else is `null`, and §7.5 says why. */
export function stampable(asset: WatermarkAsset): WatermarkKind | null {
  if (asset.mime === 'application/pdf') return 'pdf';
  if (asset.kind === 'image' && asset.mime.startsWith('image/')) return 'image';
  return null;
}

/**
 * Build the spec that will be drawn. Throws for anything that cannot be stamped — the
 * caller turns that into `503` and a `denied_watermark` row, never into a fallback.
 */
export function buildSpec(asset: WatermarkAsset, code: WatermarkCode, options: SpecOptions = {}): WatermarkSpec {
  const kind = stampable(asset);
  if (kind === null) throw new Error(`${asset.mime} is not stampable in v1`);
  const template = options.template ?? DEFAULT_TEMPLATE;
  const text = sanitiseCp1252(resolveTemplate(template, code));
  if (text === '') throw new Error('the resolved watermark text is empty');
  return {
    v: 1,
    kind,
    text,
    template,
    position: options.position ?? 'bottom-band',
    opacity: options.opacity ?? 0.45,
    scale: options.scale ?? 0.25,
    rotation: options.rotation ?? 0,
    pages: options.pages ?? 'all',
    logo: options.logo ?? null,
    source: asset.sha256,
  };
}

/** Sorted-key JSON: two objects with the same fields hash alike whatever built them. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${entries.join(',')}}`;
}

/**
 * The cache key. `wm-spec-v1` is a domain separator: a hash of the same JSON computed
 * for another purpose must not collide with this one.
 */
export function specSha(spec: WatermarkSpec): string {
  return createHash('sha256').update(`wm-spec-v1\u0000${canonicalJson(spec)}`).digest('hex');
}

/** The bytes every renderer receives. Structured-cloneable, so the worker needs no closure. */
export interface StampJob {
  kind: WatermarkKind;
  sourcePath: string;
  logoPath: string | null;
  specSha: string;
  text: string;
  position: WatermarkPosition;
  opacity: number;
  scale: number;
  rotation: number;
  pages: WatermarkPages;
  /** Output extension: `pdf`, `png`, `jpg`, `webp`, `avif`. */
  format: string;
}

function selectPages(count: number, pages: WatermarkPages): number[] {
  if (pages === 'first') return count > 0 ? [0] : [];
  if (pages === 'last') return count > 0 ? [count - 1] : [];
  return Array.from({ length: count }, (_, i) => i);
}

function logoBytes(path: string): Buffer {
  return readFileSync(path);
}

async function embedLogo(doc: PDFDocument, path: string): Promise<PDFImage> {
  const bytes = logoBytes(path);
  // The magic decides, not the file name: a PNG named `.jpg` would otherwise throw.
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return doc.embedPng(bytes);
  }
  return doc.embedJpg(bytes);
}

function drawFooter(page: PDFPage, text: string, font: PDFFont): void {
  const size = 8;
  const width = font.widthOfTextAtSize(text, size);
  const { width: pageWidth } = page.getSize();
  // One line, centred, inside the bottom margin. Long footers shrink rather than run off
  // the page — a truncated order_ref is attribution that silently stopped working.
  const fitted = width > pageWidth - 36 ? Math.max(4.5, (size * (pageWidth - 36)) / width) : size;
  const drawn = font.widthOfTextAtSize(text, fitted);
  page.drawText(text, {
    x: Math.max(18, (pageWidth - drawn) / 2),
    y: 14,
    size: fitted,
    font,
    color: rgb(0.28, 0.28, 0.28),
    opacity: 0.95,
  });
}

function drawLogo(page: PDFPage, logo: PDFImage, job: StampJob): void {
  const { width: pageWidth, height: pageHeight } = page.getSize();
  const width = Math.max(12, pageWidth * job.scale);
  const height = (logo.height / logo.width) * width;
  const margin = 24;
  const at = (x: number, y: number): void => {
    page.drawImage(logo, { x, y, width, height, opacity: job.opacity, rotate: degrees(job.rotation) });
  };
  if (job.position === 'center') at((pageWidth - width) / 2, (pageHeight - height) / 2);
  else if (job.position === 'corner') at(pageWidth - width - margin, pageHeight - height - margin);
  else if (job.position === 'bottom-band') at(margin, 28);
  else {
    // `tile`: a 3 x 2 grid, inset so no stamp is cut by the edge.
    for (let col = 0; col < 3; col += 1) {
      for (let row = 1; row <= 2; row += 1) {
        at((pageWidth / 3) * col + (pageWidth / 3 - width) / 2, (pageHeight / 3) * row);
      }
    }
  }
}

/**
 * PDF: drawn into the page's content stream with a built-in WinAnsi font, so the text is
 * part of the page a viewer renders — not an annotation a buyer can delete in a panel.
 */
export async function stampPdf(job: StampJob): Promise<Buffer> {
  const source = readFileSync(job.sourcePath);
  // pdf-lib refuses an encrypted document; §7.5 refuses those at issue time so this is a
  // second line of defence, not the first.
  const doc = await PDFDocument.load(source);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const logo = job.logoPath === null ? null : await embedLogo(doc, job.logoPath);
  const pages = doc.getPages();
  for (const index of selectPages(pages.length, job.pages)) {
    const page = pages[index] as PDFPage;
    drawFooter(page, job.text, font);
    if (logo !== null) drawLogo(page, logo, job);
  }
  // A support handle that survives a buyer cropping the footer, and that names no PII.
  doc.setSubject(`watermark:${job.specSha}`);
  doc.setProducer('skunkworks');
  return Buffer.from(await doc.save());
}

function xml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * Images: a translucent band with the footer drawn by librsvg, composited by sharp. The
 * band is what makes the text legible on a photograph; `opacity` controls how hard it
 * sits. The output keeps the asset's own format.
 */
export async function stampImage(job: StampJob): Promise<Buffer> {
  const image = sharp(job.sourcePath, { failOn: 'error' });
  const meta = await image.metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (width === 0 || height === 0) throw new Error('the image has no dimensions');

  const bandHeight = Math.max(18, Math.round(height * 0.06));
  const fontSize = Math.max(10, Math.round(bandHeight * 0.42));
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${bandHeight}">` +
      `<rect width="100%" height="100%" fill="rgba(0,0,0,${(0.35 + job.opacity * 0.4).toFixed(2)})"/>` +
      `<text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" ` +
      `font-family="Helvetica, Arial, sans-serif" font-size="${fontSize}" fill="rgba(255,255,255,0.95)">` +
      `${xml(job.text)}</text></svg>`,
  );

  const layers: OverlayOptions[] = [];
  if (job.logoPath !== null) {
    const logoWidth = Math.max(8, Math.round(width * job.scale));
    const logo = await sharp(logoBytes(job.logoPath))
      .resize({ width: logoWidth })
      .ensureAlpha(job.opacity)
      .png()
      .toBuffer();
    const gravity =
      job.position === 'tile' ? 'northwest' : job.position === 'corner' ? 'northeast' : job.position === 'center' ? 'center' : 'southwest';
    layers.push({ input: logo, gravity, blend: 'over' });
  }
  layers.push({ input: svg, gravity: 'south', blend: 'over' });

  const out = sharp(job.sourcePath, { failOn: 'error' }).composite(layers);
  switch (job.format) {
    case 'jpg':
      return out.flatten({ background: '#000000' }).jpeg({ quality: 92 }).toBuffer();
    case 'webp':
      return out.webp({ quality: 92 }).toBuffer();
    case 'avif':
      return out.avif({ quality: 70 }).toBuffer();
    default:
      return out.png().toBuffer();
  }
}

/** The one dispatcher; the worker calls it, and so does an in-process fallback. */
export async function stamp(job: StampJob): Promise<Buffer> {
  if (job.kind === 'pdf') return stampPdf(job);
  if (job.kind === 'image') return stampImage(job);
  throw new Error(`no renderer for ${job.kind satisfies never}`);
}
