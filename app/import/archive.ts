/**
 * A bundle as a list of entries, from a `.zip`, a `.tar.gz`, or a directory.
 *
 * Three containers, one shape. Everything above this file — verification, the database, the
 * media copy, the plugin packages — reads `BundleEntry[]` and never asks where the bytes came
 * from, so an archive and an unpacked tree are imported by the same code and refused by the same
 * codes.
 *
 * ## Why this is not `app/render/zip.ts` or `app/plugins/archive.ts`
 *
 * Both of those readers are correct for what they read and wrong for a bundle:
 *
 *   - `readZip()` refuses symlinks outright ("a theme package cannot carry one") and caps a
 *     bundle at 16 MiB / 400 entries. A site bundle carries `content/public/**` as **relative
 *     symlinks** — that is how the farm publishes a media file without a second copy — and a
 *     real media library is thousands of files and hundreds of megabytes.
 *   - `readPackageArchive()` reads a tar and refuses symlinks and hard links for the same kind of
 *     reason: a plugin is code, and a link in code is a path that resolves after the checks.
 *
 * So the parsers here are the same fixed-offset work with the two differences a bundle needs: a
 * symlink is a **first-class member** (zip's `S_IFLNK` external attribute with the target as its
 * data; tar's typeflag `2` with the target in `linkname`), and the size ceilings are the ones a
 * media library implies. Nothing is added as a dependency: `node:zlib` inflates a raw deflate
 * member and a tar's data is not compressed at all.
 *
 * ## Everything is verified before anything is written
 *
 * These readers return buffers. `importSite()` verifies every hash and every symlink target
 * **in memory**, and only then writes to the data directory. That is why a tampered archive
 * leaves no half-installed tenant: the refusal happens before the first `mkdir`.
 */
import { createHash } from 'node:crypto';
import { inflateRawSync, crc32, gunzipSync } from 'node:zlib';
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { ImportRefusal, isProtectedPath, PROTECTED_PREFIX } from './errors.ts';

/** 4 GiB of archive. A site bundle is media and one SQLite file; this is a sanity ceiling. */
export const MAX_ARCHIVE_BYTES = 4 * 1024 * 1024 * 1024;
/** One member. */
export const MAX_ENTRY_BYTES = 2 * 1024 * 1024 * 1024;
/** Members. A media library is thousands of files; a million is not a website. */
export const MAX_ENTRIES = 200_000;

export interface BundleEntry {
  /** POSIX path relative to the bundle root, no leading slash, no `.`/`..` segment. */
  path: string;
  kind: 'file' | 'symlink';
  /** A file's bytes. Absent for a symlink. */
  bytes?: Buffer;
  /** A symlink's target exactly as the writer recorded it (relative, by contract). */
  target?: string;
  mode: number;
}

export interface BundleSource {
  kind: 'zip' | 'tar.gz' | 'dir';
  /** The path the operator named. */
  path: string;
  entries: BundleEntry[];
}

const ZIP_EOCD = 0x0605_4b50;
const ZIP_CENTRAL = 0x0201_4b50;
const ZIP_LOCAL = 0x0403_4b50;

function u16(buf: Buffer, at: number): number {
  return buf.readUInt16LE(at);
}

function u32(buf: Buffer, at: number): number {
  return buf.readUInt32LE(at);
}

/**
 * A member name, normalised, or a named refusal.
 *
 * The rules are the ones a filesystem enforces plus the two a bundle adds: no absolute path, no
 * drive letter, no `..` segment, no control character, and the tree's own excluded prefix.
 */
export function normaliseBundlePath(raw: string): string {
  const slashed = raw.replace(/\\/g, '/').replace(/^\.\/+/, '');
  if (slashed === '') throw new ImportRefusal('SKW_E_IMP_ENTRY_UNSAFE', 'the bundle has a member with no name');
  if (slashed.startsWith('/')) {
    throw new ImportRefusal('SKW_E_IMP_ENTRY_UNSAFE', `the bundle has an absolute member name (${JSON.stringify(slashed.slice(0, 80))})`);
  }
  if (/^[a-zA-Z]:/.test(slashed)) {
    throw new ImportRefusal('SKW_E_IMP_ENTRY_UNSAFE', `the bundle has a drive-qualified member name (${JSON.stringify(slashed.slice(0, 80))})`);
  }
  const segments = slashed.split('/');
  if (segments.some((part) => part === '..')) {
    throw new ImportRefusal('SKW_E_IMP_ENTRY_UNSAFE', `the bundle has a member that escapes its root (${JSON.stringify(slashed.slice(0, 80))})`);
  }
  const cleaned = segments.filter((part) => part !== '' && part !== '.').join('/');
  if (cleaned === '') throw new ImportRefusal('SKW_E_IMP_ENTRY_UNSAFE', 'the bundle has a member with no name');
  if (/[\u0000-\u001f]/.test(cleaned)) {
    throw new ImportRefusal('SKW_E_IMP_ENTRY_UNSAFE', `the bundle has a member name with a control character (${JSON.stringify(cleaned.slice(0, 80))})`);
  }
  if (isProtectedPath(cleaned)) {
    throw new ImportRefusal(
      'SKW_E_IMP_FORBIDDEN_PATH',
      `${cleaned} is under ${PROTECTED_PREFIX}/ — a render never travels in a bundle, and an import is not a second door`,
      { path: cleaned },
    );
  }
  return cleaned;
}

/** `__MACOSX/…`, `._foo`: what macOS adds to a zipped folder, never bundle content. */
function isAppleDouble(path: string): boolean {
  return path.startsWith('__MACOSX/') || path.split('/').some((part) => part.startsWith('._'));
}

// --------------------------------------------------------------------------- zip

function findEnd(buf: Buffer): number {
  const floor = Math.max(0, buf.length - 0xffff - 22);
  for (let at = buf.length - 22; at >= floor; at -= 1) {
    if (at >= 0 && u32(buf, at) === ZIP_EOCD) return at;
  }
  return -1;
}

export function readBundleZip(buf: Buffer): BundleEntry[] {
  if (buf.length < 22) throw new ImportRefusal('SKW_E_IMP_ARCHIVE_FAILED', 'that file is too short to be a zip');
  if (buf.length > MAX_ARCHIVE_BYTES) {
    throw new ImportRefusal('SKW_E_IMP_ARCHIVE_FAILED', `that archive is ${buf.length} bytes; the limit is ${MAX_ARCHIVE_BYTES}`, {
      bytes: buf.length,
    });
  }
  const end = findEnd(buf);
  if (end < 0) throw new ImportRefusal('SKW_E_IMP_ARCHIVE_FAILED', 'that file is not a zip (no end-of-central-directory record)');

  const disk = u16(buf, end + 4);
  const cdDisk = u16(buf, end + 6);
  const entriesHere = u16(buf, end + 8);
  const total = u16(buf, end + 10);
  const cdSize = u32(buf, end + 12);
  const cdOffset = u32(buf, end + 16);
  if (disk !== 0 || cdDisk !== 0 || entriesHere !== total) {
    throw new ImportRefusal('SKW_E_IMP_ARCHIVE_FAILED', 'multi-disk zips are not accepted');
  }
  if (total === 0xffff || cdSize === 0xffff_ffff || cdOffset === 0xffff_ffff) {
    throw new ImportRefusal('SKW_E_IMP_ARCHIVE_FAILED', 'that archive is zip64; re-save it without zip64');
  }
  if (total > MAX_ENTRIES) {
    throw new ImportRefusal('SKW_E_IMP_ARCHIVE_FAILED', `that archive holds ${total} members; the limit is ${MAX_ENTRIES}`, {
      entries: total,
    });
  }
  if (cdOffset + cdSize > buf.length) {
    throw new ImportRefusal('SKW_E_IMP_ARCHIVE_FAILED', 'the central directory points outside the file');
  }

  const entries: BundleEntry[] = [];
  const seen = new Set<string>();
  let at = cdOffset;
  for (let index = 0; index < total; index += 1) {
    if (at + 46 > buf.length) throw new ImportRefusal('SKW_E_IMP_ARCHIVE_FAILED', 'the central directory ends early');
    if (u32(buf, at) !== ZIP_CENTRAL) {
      throw new ImportRefusal('SKW_E_IMP_ARCHIVE_FAILED', `central directory entry ${index} has the wrong signature`);
    }
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
    const rawName = buf.subarray(at + 46, at + 46 + nameLen).toString('utf8');
    at += 46 + nameLen + extraLen + commentLen;

    if ((flags & 0x1) !== 0) {
      throw new ImportRefusal('SKW_E_IMP_ARCHIVE_FAILED', `${rawName} is encrypted; a bundle cannot be`);
    }
    if (plainSize === 0xffff_ffff || compressedSize === 0xffff_ffff) {
      throw new ImportRefusal('SKW_E_IMP_ARCHIVE_FAILED', 'that archive is zip64; re-save it without zip64');
    }
    const mode = (externalAttr >>> 16) & 0o170000;
    const directory = rawName.endsWith('/') || mode === 0o040000;
    if (directory) continue;
    if (isAppleDouble(rawName)) continue;
    const path = normaliseBundlePath(rawName);
    if (seen.has(path)) {
      throw new ImportRefusal('SKW_E_IMP_ARCHIVE_FAILED', `the archive names ${path} twice`);
    }
    seen.add(path);

    if (plainSize > MAX_ENTRY_BYTES) {
      throw new ImportRefusal('SKW_E_IMP_ARCHIVE_FAILED', `${path} is ${plainSize} bytes; one member may be ${MAX_ENTRY_BYTES}`, {
        path,
        bytes: plainSize,
      });
    }
    if (localOffset + 30 > buf.length) throw new ImportRefusal('SKW_E_IMP_ARCHIVE_FAILED', `${path} points outside the file`);
    if (u32(buf, localOffset) !== ZIP_LOCAL) throw new ImportRefusal('SKW_E_IMP_ARCHIVE_FAILED', `${path} has no local header`);
    const localNameLen = u16(buf, localOffset + 26);
    const localExtraLen = u16(buf, localOffset + 28);
    const dataFrom = localOffset + 30 + localNameLen + localExtraLen;
    const dataTo = dataFrom + compressedSize;
    if (dataTo > buf.length) throw new ImportRefusal('SKW_E_IMP_ARCHIVE_FAILED', `${path} ends outside the file`);
    const packed = buf.subarray(dataFrom, dataTo);

    let plain: Buffer;
    if (method === 0) {
      plain = Buffer.from(packed);
    } else if (method === 8) {
      try {
        plain = inflateRawSync(packed, { maxOutputLength: Math.max(plainSize, 64) });
      } catch (err) {
        throw new ImportRefusal('SKW_E_IMP_ARCHIVE_FAILED', `${path} could not be inflated (${(err as Error).message})`, { path });
      }
    } else {
      throw new ImportRefusal('SKW_E_IMP_ARCHIVE_FAILED', `${path} uses compression method ${method}; only stored and deflate are accepted`, {
        path,
        method,
      });
    }
    if (plain.length !== plainSize) {
      throw new ImportRefusal('SKW_E_IMP_ARCHIVE_FAILED', `${path} inflated to ${plain.length} bytes, not ${plainSize}`, { path });
    }
    // The checksum is what makes a single flipped byte a refusal instead of a plausible-looking
    // bundle: a deflate stream can decode to *something* after corruption.
    if ((crc32(plain) >>> 0) !== expectCrc) {
      throw new ImportRefusal('SKW_E_IMP_ARCHIVE_FAILED', `${path} does not match its stored checksum — the archive is corrupt or was edited`, {
        path,
      });
    }
    if (mode === 0o120000) {
      entries.push({ path, kind: 'symlink', target: plain.toString('utf8'), mode: 0o777 });
      continue;
    }
    entries.push({ path, kind: 'file', bytes: plain, mode: (externalAttr >>> 16) & 0o777 });
  }
  return entries;
}

// --------------------------------------------------------------------------- tar.gz

const BLOCK = 512;

function tarField(header: Buffer, at: number, length: number): string {
  const slice = header.subarray(at, at + length);
  const nul = slice.indexOf(0);
  return slice.subarray(0, nul === -1 ? length : nul).toString('utf8');
}

function tarOctal(header: Buffer, at: number, length: number): number {
  const text = tarField(header, at, length).trim();
  if (text === '') return 0;
  if (!/^[0-7]+$/.test(text)) {
    throw new ImportRefusal('SKW_E_IMP_ARCHIVE_FAILED', `the archive has a malformed tar header field at ${at}`);
  }
  return Number.parseInt(text, 8);
}

function tarChecksum(header: Buffer): number {
  let sum = 0;
  for (let i = 0; i < BLOCK; i += 1) sum += i >= 148 && i < 156 ? 0x20 : (header[i] as number);
  return sum;
}

/** GNU long name/value records: `len key=value\n`. Only `path`/`linkpath` change a member. */
function paxRecords(text: string): { path?: string; linkpath?: string } {
  const out: { path?: string; linkpath?: string } = {};
  for (const line of text.split('\n')) {
    const m = /^\d+ (path|linkpath)=(.*)$/.exec(line);
    if (m === null) continue;
    if (m[1] === 'path') out.path = m[2] as string;
    else out.linkpath = m[2] as string;
  }
  return out;
}

export function readBundleTarGz(archive: Buffer): BundleEntry[] {
  if (archive.length === 0) throw new ImportRefusal('SKW_E_IMP_ARCHIVE_FAILED', 'the archive is empty');
  if (archive.length > MAX_ARCHIVE_BYTES) {
    throw new ImportRefusal('SKW_E_IMP_ARCHIVE_FAILED', `that archive is ${archive.length} bytes; the limit is ${MAX_ARCHIVE_BYTES}`, {
      bytes: archive.length,
    });
  }
  let plain: Buffer;
  try {
    plain = gunzipSync(archive, { maxOutputLength: MAX_ARCHIVE_BYTES });
  } catch (err) {
    throw new ImportRefusal('SKW_E_IMP_ARCHIVE_FAILED', `that file is not a readable gzip stream (${(err as Error).message})`);
  }

  const entries: BundleEntry[] = [];
  const seen = new Set<string>();
  let offset = 0;
  let longName: string | null = null;
  let longLink: string | null = null;
  let pax: { path?: string; linkpath?: string } = {};

  while (offset + BLOCK <= plain.length) {
    const header = plain.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) break;
    if (tarChecksum(header) !== tarOctal(header, 148, 8)) {
      throw new ImportRefusal('SKW_E_IMP_ARCHIVE_FAILED', 'the archive header fails its checksum — the file is corrupt or was edited');
    }
    const declaredSize = tarOctal(header, 124, 12);
    const dataStart = offset + BLOCK;
    const dataEnd = dataStart + declaredSize;
    if (dataEnd > plain.length) {
      throw new ImportRefusal('SKW_E_IMP_ARCHIVE_FAILED', `the archive ends inside ${JSON.stringify(tarField(header, 0, 100))}`);
    }
    const data = plain.subarray(dataStart, dataEnd);
    const type = String.fromCharCode(header[156] as number);
    const next = dataStart + Math.ceil(declaredSize / BLOCK) * BLOCK;

    if (type === 'x' || type === 'X') {
      pax = paxRecords(data.toString('utf8'));
      offset = next;
      continue;
    }
    if (type === 'g') {
      // A global pax header describes the packing machine, not a member.
      offset = next;
      continue;
    }
    if (type === 'L') {
      longName = data.toString('utf8').replace(/\0[\s\S]*$/, '');
      offset = next;
      continue;
    }
    if (type === 'K') {
      longLink = data.toString('utf8').replace(/\0[\s\S]*$/, '');
      offset = next;
      continue;
    }
    if (type === '5') {
      offset = next;
      continue;
    }
    if (type !== '0' && type !== '\0' && type !== '7' && type !== '2') {
      throw new ImportRefusal(
        'SKW_E_IMP_ARCHIVE_FAILED',
        `the archive contains something a bundle cannot be (tar type ${JSON.stringify(type)}, ${JSON.stringify(tarField(header, 0, 100))})`,
        { type },
      );
    }

    const nameField = tarField(header, 0, 100);
    const prefix = tarField(header, 345, 155);
    const combined = pax.path ?? longName ?? (prefix === '' ? nameField : `${prefix}/${nameField}`);
    // `linkpath` and the GNU long-link record describe **this** member, so they are read before
    // the per-entry state is cleared — the one ordering bug that would silently lose a link's
    // target and turn every farm symlink into a link to nowhere.
    const linkTarget = pax.linkpath ?? longLink ?? tarField(header, 157, 100);
    longName = null;
    longLink = null;
    pax = {};
    if (isAppleDouble(combined)) {
      offset = next;
      continue;
    }
    const path = normaliseBundlePath(combined);
    if (seen.has(path)) throw new ImportRefusal('SKW_E_IMP_ARCHIVE_FAILED', `the archive names ${path} twice`);
    seen.add(path);

    if (type === '2') {
      entries.push({ path, kind: 'symlink', target: linkTarget, mode: 0o777 });
      offset = next;
      continue;
    }
    if (declaredSize > MAX_ENTRY_BYTES) {
      throw new ImportRefusal('SKW_E_IMP_ARCHIVE_FAILED', `${path} is ${declaredSize} bytes; one member may be ${MAX_ENTRY_BYTES}`, {
        path,
        bytes: declaredSize,
      });
    }
    entries.push({ path, kind: 'file', bytes: Buffer.from(data), mode: tarOctal(header, 100, 8) & 0o777 });
    offset = next;
  }

  if (entries.length === 0) throw new ImportRefusal('SKW_E_IMP_ARCHIVE_FAILED', 'the archive contains no files');
  return entries;
}

// --------------------------------------------------------------------------- a directory

/**
 * The same entries, read off disk.
 *
 * An unpacked bundle is imported by the same verification and the same writer as an archive, so
 * the two cannot drift. The walk keeps symlinks **as links** (`readlinkSync`) rather than
 * resolving them: a bundle's links are the farm's relative pointers, and a reader that followed
 * them would copy the media twice and lose the fact that it is the same file.
 */
export function readBundleDir(root: string): BundleEntry[] {
  if (!existsSync(root)) throw new ImportRefusal('SKW_E_IMP_SOURCE_MISSING', `no such bundle: ${root}`, { source: root });
  if (!statSync(root).isDirectory()) {
    throw new ImportRefusal('SKW_E_IMP_SOURCE_MISSING', `${root} is not a directory and does not name an archive`, { source: root });
  }
  const entries: BundleEntry[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir).sort()) {
      if (name === 'node_modules' || name === '.git') continue;
      const full = join(dir, name);
      const rel = prefix === '' ? name : `${prefix}/${name}`;
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) {
        const path = normaliseBundlePath(rel);
        entries.push({ path, kind: 'symlink', target: readlinkSync(full), mode: 0o777 });
        continue;
      }
      if (stat.isDirectory()) {
        walk(full, rel);
        continue;
      }
      const path = normaliseBundlePath(rel);
      entries.push({ path, kind: 'file', bytes: readFileSync(full), mode: stat.mode & 0o777 });
      if (entries.length > MAX_ENTRIES) {
        throw new ImportRefusal('SKW_E_IMP_ARCHIVE_FAILED', `the bundle holds more than ${MAX_ENTRIES} entries`);
      }
    }
  };
  walk(root, '');
  return entries;
}

/** What container the operator named, by extension — the same rule the writer uses. */
export type SourceKind = 'zip' | 'tar.gz' | 'dir';

/**
 * The entries behind `source`, whatever it is.
 *
 * An archive is read into memory here, which is what makes "verified before anything is written"
 * literally true: the bytes never touch the destination until every hash has been checked.
 */
export function readBundleSource(source: string): BundleSource {
  if (!existsSync(source)) {
    throw new ImportRefusal('SKW_E_IMP_SOURCE_MISSING', `no such bundle: ${source}`, { source });
  }
  const stat = statSync(source);
  if (stat.isDirectory()) return { kind: 'dir', path: source, entries: readBundleDir(source) };
  const lower = source.toLowerCase();
  const bytes = readFileSync(source);
  if (lower.endsWith('.zip')) {
    return { kind: 'zip', path: source, entries: readBundleZip(bytes) };
  }
  if (lower.endsWith('.tar.gz')) {
    return { kind: 'tar.gz', path: source, entries: readBundleTarGz(bytes) };
  }
  throw new ImportRefusal(
    'SKW_E_IMP_ARCHIVE_FORMAT',
    `${source} is not a bundle this importer understands: pass a directory, a .zip or a .tar.gz`,
    { source, accepted: ['<dir>', '.zip', '.tar.gz'] },
  );
}

/** `sha256` of a byte string — the one hash the manifest and the verifier both speak. */
export function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
