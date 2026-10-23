/**
 * A theme package as one file: read a zip without adding a dependency.
 *
 * ## Why this exists, when `app/plugins/archive.ts` already reads a tarball
 *
 * A theme is not one stylesheet. The moment a theme has a background image, a display face, or a
 * logo in its header, the operator has a directory — and a form that takes one file has to take the
 * directory as one file. Zip is what every operating system produces from a folder with a
 * right-click, so zip is the format an operator will hand us; tar.gz is what a developer produces.
 *
 * `archive.ts` says "zip needs a dependency to read (Node ships `zlib`, not an inflate path for the
 * container format)". The second half of that is wrong: a zip member is a raw deflate stream, and
 * `zlib.inflateRawSync` is exactly that. What a zip needs is a *parser* — a central directory at the
 * end, an offset per member — which is the same fixed-offset work the tar reader does, and it is
 * below. No dependency, because this repository pays for its runtime dependency list on every
 * deploy and a deploy is not free.
 *
 * ## What is refused, and why each refusal is not paranoia
 *
 *  - **Zip64, multi-disk, encryption.** Each is a flag or an escape hatch this reader does not
 *    implement. Refusing by name is honest; silently mis-parsing a 4 GiB archive is not.
 *  - **`..` or an absolute member name.** The extraction writes files under a directory named after
 *    the theme; a member that escapes it writes somewhere the theme does not own.
 *  - **A symlink.** A zip can carry one (the unix mode in the external attributes). A theme is
 *    styling and the files its rules name; a link is a path that resolves elsewhere *after* the
 *    upload has been checked.
 *  - **AppleDouble (`__MACOSX/`, `._*`).** macOS adds resource forks to a zipped folder. They are
 *    not theme content, they double the file count, and one of them is a binary blob named after
 *    an image the theme actually uses.
 *  - **Size: per member, expanded total, entry count, compressed body.** The numbers are the media
 *    uploader's ceiling, because the same operator is on the other end of the same form.
 *  - **A CRC that does not match.** A zip stores the checksum of every member; a mismatch means the
 *    bytes on the wire are not the bytes that were zipped, and a theme that half-loads looks like a
 *    CSS bug for the next hour.
 */
import { crc32, inflateRawSync } from 'node:zlib';

import { AppError } from '../errors.ts';

/** 16 MiB compressed. A theme with photographs in it, not a photo library. */
export const MAX_BUNDLE_BYTES = 16 * 1024 * 1024;
/** One member. A hero image at 8 MiB is already generous for the web. */
export const MAX_ENTRY_BYTES = 8 * 1024 * 1024;
/** Everything expanded. Four images at the per-member cap would blow past this. */
export const MAX_EXPANDED_BYTES = 32 * 1024 * 1024;
/** Members. A generated theme is dozens of files; a thousand is a tarball of a node_modules. */
export const MAX_ENTRIES = 400;

export interface ZipEntry {
  /** POSIX-relative, no leading slash, no `..`, no trailing slash (directories are dropped). */
  path: string;
  bytes: Buffer;
}

const EOCD = 0x0605_4b50;
const CENTRAL = 0x0201_4b50;
const LOCAL = 0x0403_4b50;
const CDIR_HEADER_BYTES = 46;
const LOCAL_HEADER_BYTES = 30;

/** A refusal the operator can act on: the archive is understood, its contents are not acceptable. */
function refuse(message: string, detail?: Record<string, unknown>): never {
  throw new AppError('SKW_E_PL_REJECTED', message, detail ?? {});
}

/** The archive cannot be understood at all. A different code because it is a different problem. */
function broken(message: string, detail?: Record<string, unknown>): never {
  throw new AppError('SKW_E_PL_ARCHIVE_FAILED', message, detail ?? {});
}

function u16(buf: Buffer, at: number): number {
  return buf.readUInt16LE(at);
}

function u32(buf: Buffer, at: number): number {
  return buf.readUInt32LE(at);
}

/** The end-of-central-directory record: the last signature in the file, possibly followed by a comment. */
function findEnd(buf: Buffer): number {
  const floor = Math.max(0, buf.length - 0xffff - 22);
  for (let at = buf.length - 22; at >= floor; at -= 1) {
    if (u32(buf, at) === EOCD) return at;
  }
  return -1;
}

/**
 * A member name, normalised, or a refusal.
 *
 * `\` is what Windows-produced archives use; it is a separator here, not a character in a filename.
 * A name that survives this function is safe to join under a directory: it has no drive letter, no
 * leading slash, no `..` segment and no control characters.
 */
export function normaliseEntryPath(name: string): string {
  const slashed = name.replace(/\\/g, '/').replace(/^\.\/+/, '');
  if (slashed === '') refuse('the archive has a member with no name');
  if (slashed.startsWith('/')) refuse(`the archive has an absolute member name (${JSON.stringify(slashed.slice(0, 60))})`);
  if (/^[a-zA-Z]:/.test(slashed)) refuse(`the archive has a drive-qualified member name (${JSON.stringify(slashed.slice(0, 60))})`);
  const segments = slashed.split('/');
  if (segments.some((part) => part === '..')) {
    refuse(`the archive has a member that escapes the package (${JSON.stringify(slashed.slice(0, 60))})`);
  }
  const cleaned = segments.filter((part) => part !== '' && part !== '.').join('/');
  if (cleaned === '') refuse('the archive has a member with no name');
  if (/[\u0000-\u001f]/.test(cleaned)) refuse('the archive has a member name with a control character');
  return cleaned;
}

/** `__MACOSX/…` and `._foo.png`: macOS's resource forks, not theme content. */
function isAppleDouble(path: string): boolean {
  return path.startsWith('__MACOSX/') || path.split('/').some((part) => part.startsWith('._'));
}

/**
 * Read every regular file the archive holds.
 *
 * The central directory is the authority: a local header may hold zeros when the writer streamed
 * (flag bit 3), so sizes come from the central record and the local header is only used for the
 * offset of the data.
 */
export function readZip(buf: Buffer): ZipEntry[] {
  if (buf.length < 22) broken('that file is too short to be a zip');
  if (buf.length > MAX_BUNDLE_BYTES) {
    refuse(`that archive is ${buf.length} bytes; the limit is ${MAX_BUNDLE_BYTES}`, { bytes: buf.length });
  }
  const end = findEnd(buf);
  if (end < 0) broken('that file is not a zip (no end-of-central-directory record)');

  const disk = u16(buf, end + 4);
  const cdDisk = u16(buf, end + 6);
  const entriesHere = u16(buf, end + 8);
  const entriesTotal = u16(buf, end + 10);
  const cdSize = u32(buf, end + 12);
  const cdOffset = u32(buf, end + 16);
  if (disk !== 0 || cdDisk !== 0 || entriesHere !== entriesTotal) broken('multi-disk zips are not accepted');
  if (entriesTotal === 0xffff || cdSize === 0xffff_ffff || cdOffset === 0xffff_ffff) {
    broken('that archive is zip64; re-save it without zip64');
  }
  if (entriesTotal > MAX_ENTRIES) {
    refuse(`that archive holds ${entriesTotal} files; the limit is ${MAX_ENTRIES}`, { entries: entriesTotal });
  }
  if (cdOffset + cdSize > buf.length) broken('the central directory points outside the file');

  const out: ZipEntry[] = [];
  let expanded = 0;
  let at = cdOffset;
  for (let index = 0; index < entriesTotal; index += 1) {
    if (at + CDIR_HEADER_BYTES > buf.length) broken('the central directory ends early');
    if (u32(buf, at) !== CENTRAL) broken(`central directory entry ${index} has the wrong signature`);
    const flags = u16(buf, at + 8);
    const method = u16(buf, at + 10);
    const expectCrc = u32(buf, at + 16);
    const compressedSize = u32(buf, at + 20);
    const plainSize = u32(buf, at + 24);
    const nameLen = u16(buf, at + 28);
    const extraLen = u16(buf, at + 30);
    const commentLen = u16(buf, at + 32);
    const externalAttr = u32(buf, at + 38);
    const localOffset = u32(buf, at + 42);
    const rawName = buf.subarray(at + CDIR_HEADER_BYTES, at + CDIR_HEADER_BYTES + nameLen).toString('utf8');
    at += CDIR_HEADER_BYTES + nameLen + extraLen + commentLen;

    if ((flags & 0x1) !== 0) refuse(`${rawName} is encrypted; a theme package cannot be`);
    if (plainSize === 0xffff_ffff || compressedSize === 0xffff_ffff) broken('that archive is zip64; re-save it without zip64');

    const directory = rawName.endsWith('/') || ((externalAttr >>> 16) & 0o170000) === 0o040000;
    const mode = (externalAttr >>> 16) & 0o170000;
    if (mode === 0o120000) refuse(`${rawName} is a symlink; a theme package cannot carry one`);
    const path = normaliseEntryPath(rawName);
    if (directory) continue;
    if (isAppleDouble(path)) continue;
    if (plainSize > MAX_ENTRY_BYTES) {
      refuse(`${path} is ${plainSize} bytes; one file may be ${MAX_ENTRY_BYTES}`, { path, bytes: plainSize });
    }
    expanded += plainSize;
    if (expanded > MAX_EXPANDED_BYTES) {
      refuse(`that archive expands to over ${MAX_EXPANDED_BYTES} bytes`, { expanded });
    }

    if (localOffset + LOCAL_HEADER_BYTES > buf.length) broken(`${path} points outside the file`);
    if (u32(buf, localOffset) !== LOCAL) broken(`${path} has no local header`);
    const localNameLen = u16(buf, localOffset + 26);
    const localExtraLen = u16(buf, localOffset + 28);
    const dataFrom = localOffset + LOCAL_HEADER_BYTES + localNameLen + localExtraLen;
    const dataTo = dataFrom + compressedSize;
    if (dataTo > buf.length) broken(`${path} ends outside the file`);
    const packed = buf.subarray(dataFrom, dataTo);

    let bytes: Buffer;
    if (method === 0) {
      bytes = Buffer.from(packed);
    } else if (method === 8) {
      try {
        bytes = inflateRawSync(packed, { maxOutputLength: MAX_ENTRY_BYTES });
      } catch (err) {
        broken(`${path} could not be inflated (${(err as Error).message})`);
      }
    } else {
      refuse(`${path} uses compression method ${method}; only stored and deflate are accepted`, { path, method });
    }
    if (bytes.length !== plainSize) broken(`${path} inflated to ${bytes.length} bytes, not ${plainSize}`);
    if ((crc32(bytes) >>> 0) !== expectCrc) broken(`${path} does not match its checksum`);
    out.push({ path, bytes });
  }
  return out;
}
