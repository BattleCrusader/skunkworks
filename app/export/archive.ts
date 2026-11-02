/**
 * One file for the whole tree — the archive a client can carry (§11.1, S12).
 *
 * A directory is what an operator deploys; a **file** is what a client emails, uploads to a
 * shared drive, or hands to a hosting provider's import box. So `skw-export --archive <path>`
 * produces one of these *after* the tree is written and hashed, and the archive is an addition
 * to the tree, never a replacement for it: the tree is the thing `install.sh` runs from and the
 * thing the hash in the summary describes.
 *
 * Two formats, chosen **by extension and nothing else** — `.zip` or `.tar.gz`. A guess based on
 * content would be a second authority beside the path the operator typed, and the refusal for
 * anything else names the two spellings that work.
 *
 * ## Byte-identical, twice
 *
 * The determinism promise of §6.4 extends to the archive, and it costs three decisions:
 *
 *   - entries are written in sorted path order, never in directory-walk order;
 *   - every timestamp is `SKW_EXPORT_NOW` (DOS date/time in the zip, the tar `mtime` field), so
 *     nothing about the day the export ran survives;
 *   - the gzip container is written here rather than by `zlib.gzipSync`, because zlib's default
 *     header carries the **OS code of the machine that compressed it**. An archive exported on a
 *     developer's Mac and the same archive exported on the build box would then differ in byte 9
 *     — a difference with no meaning and a hash that cannot be compared. The header below pins
 *     `MTIME=0`, `XFL=0`, `OS=255 (unknown)` and a hand-written trailer.
 *
 * Zip's `external_attr` carries the unix mode, so `install.sh` keeps 0755 and every other file is
 * 0644 in both formats. A symlink is a member of its own — zip's `S_IFLNK` mode with the target
 * as data, tar's typeflag `2` with the target in `linkname` — because `content/public/**` is a
 * tree of relative links and `unzip`/`tar -x` both restore them from those bytes.
 */
import { crc32, deflateRawSync } from 'node:zlib';

import type { TreeFile } from './tree.ts';

export type ArchiveFormat = 'zip' | 'tar.gz';

/** The two accepted spellings. Both are matched case-insensitively, nothing else is a format. */
export function archiveFormatOf(path: string): ArchiveFormat | null {
  const lower = path.toLowerCase();
  if (lower.endsWith('.zip')) return 'zip';
  if (lower.endsWith('.tar.gz')) return 'tar.gz';
  return null;
}

const BLOCK = 512;
const DOS_MIN_YEAR = 1980;

function byPath(a: TreeFile, b: TreeFile): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/**
 * One member per path, sorted.
 *
 * `planCms()` can name the same `storage_path` more than once — two `cms_asset_variant` rows whose
 * bytes are identical (the same sha256, therefore the same file) both list it — and a tree writer
 * that overwrites the file twice is harmless. An **archive** cannot be: a zip or tar with two
 * members of one name extracts to whichever the reader takes last, and this importer refuses the
 * ambiguity by name. So the archive carries one member per path, and two entries for one path that
 * disagree about the bytes is a refusal rather than a coin toss.
 */
export function uniqueMembers(files: readonly TreeFile[]): TreeFile[] {
  const byName = new Map<string, TreeFile>();
  for (const file of files) {
    const previous = byName.get(file.path);
    if (previous === undefined) {
      byName.set(file.path, file);
      continue;
    }
    const same =
      previous.symlink !== undefined && file.symlink !== undefined
        ? previous.symlink === file.symlink
        : previous.bytes !== undefined && file.bytes !== undefined && Buffer.compare(Buffer.from(previous.bytes), Buffer.from(file.bytes)) === 0;
    if (!same) throw new Error(`the tree names ${file.path} twice with different content`);
  }
  return [...byName.values()].sort(byPath);
}

/** The mode a member carries: the tree's own when it set one, else 0644. */
function modeOf(file: TreeFile): number {
  return file.mode ?? 0o644;
}

/** A file's bytes, or a symlink's target as bytes. `writeTree` guarantees exactly one. */
function dataOf(file: TreeFile): Buffer {
  return file.symlink === undefined ? Buffer.from(file.bytes ?? '') : Buffer.from(file.symlink, 'utf8');
}

// --------------------------------------------------------------------------- zip

/** A DOS date/time from the pinned instant, in **UTC** so the container's timezone never leaks. */
function dosStamp(mtimeMs: number): { time: number; date: number } {
  const at = new Date(mtimeMs);
  const year = at.getUTCFullYear();
  if (year < DOS_MIN_YEAR) throw new Error(`a zip cannot record a year before ${DOS_MIN_YEAR} (got ${year})`);
  const time = (at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | (at.getUTCSeconds() >> 1);
  const date = ((year - DOS_MIN_YEAR) << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate();
  return { time, date };
}

interface ZipMember {
  name: Buffer;
  method: number;
  time: number;
  date: number;
  crc: number;
  compressed: Buffer;
  plainSize: number;
  externalAttr: number;
  offset: number;
}

/**
 * A zip with no dependencies: local headers, a central directory and one EOCD record.
 *
 * 64-bit fields and the zip64 escape records are never emitted, because nothing this writer
 * produces can exceed 4 GiB — a bundle is refused at 2× its projected size before a byte is
 * written, and a tree that large has already failed that check.
 */
export function buildZip(files: readonly TreeFile[], mtimeMs: number): Buffer {
  const { time, date } = dosStamp(mtimeMs);
  const members: ZipMember[] = [];
  const chunks: Buffer[] = [];
  let offset = 0;

  for (const file of uniqueMembers(files)) {
    const plain = dataOf(file);
    const compressed = deflateRawSync(plain, { level: 9 });
    const name = Buffer.from(file.path, 'utf8');
    const mode = file.symlink === undefined ? 0o100000 | modeOf(file) : 0o120000 | 0o777;

    const local = Buffer.alloc(30, 0);
    local.writeUInt32LE(0x0403_4b50, 0);
    local.writeUInt16LE(20, 4); // version needed to extract
    local.writeUInt16LE(0x0800, 6); // UTF-8 names, no data descriptor
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc32(plain) >>> 0, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(plain.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    members.push({
      name,
      method: 8,
      time,
      date,
      crc: crc32(plain) >>> 0,
      compressed,
      plainSize: plain.length,
      externalAttr: (mode << 16) >>> 0,
      offset,
    });
    chunks.push(local, name, compressed);
    offset += local.length + name.length + compressed.length;
  }

  const centralStart = offset;
  let centralBytes = 0;
  for (const member of members) {
    const header = Buffer.alloc(46, 0);
    header.writeUInt32LE(0x0201_4b50, 0);
    // 0x03 = UNIX in the high byte, so `external_attr`'s mode bits are read as a mode.
    header.writeUInt16LE(0x031e, 4); // version made by
    header.writeUInt16LE(20, 6); // version needed
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(member.method, 10);
    header.writeUInt16LE(member.time, 12);
    header.writeUInt16LE(member.date, 14);
    header.writeUInt32LE(member.crc, 16);
    header.writeUInt32LE(member.compressed.length, 20);
    header.writeUInt32LE(member.plainSize, 24);
    header.writeUInt16LE(member.name.length, 28);
    header.writeUInt16LE(0, 30); // extra
    header.writeUInt16LE(0, 32); // comment
    header.writeUInt16LE(0, 34); // disk
    header.writeUInt16LE(0, 36); // internal attrs
    header.writeUInt32LE(member.externalAttr, 38);
    header.writeUInt32LE(member.offset, 42);
    chunks.push(header, member.name);
    centralBytes += header.length + member.name.length;
  }

  const end = Buffer.alloc(22, 0);
  end.writeUInt32LE(0x0605_4b50, 0);
  end.writeUInt16LE(0, 4); // this disk
  end.writeUInt16LE(0, 6); // disk with the central directory
  end.writeUInt16LE(members.length, 8);
  end.writeUInt16LE(members.length, 10);
  end.writeUInt32LE(centralBytes, 12);
  end.writeUInt32LE(centralStart, 16);
  end.writeUInt16LE(0, 20); // comment length
  chunks.push(end);

  return Buffer.concat(chunks);
}

// --------------------------------------------------------------------------- tar.gz

function octalField(header: Buffer, at: number, length: number, value: number): void {
  const text = value.toString(8);
  if (text.length > length - 1) throw new Error(`tar field at ${at} cannot hold ${value} in octal`);
  header.write(`${text.padStart(length - 1, '0')}\0`, at, 'utf8');
}

/**
 * ustar splits a long name into `prefix` (155) and `name` (100) at a `/`. A path that cannot be
 * split is refused by name rather than silently truncated: a truncated entry extracts to the
 * wrong path, which is worse than a refusal.
 */
function splitTarName(path: string): { name: string; prefix: string } {
  if (Buffer.byteLength(path, 'utf8') <= 100) return { name: path, prefix: '' };
  for (let at = path.length - 1; at > 0; at -= 1) {
    if (path[at] !== '/') continue;
    const prefix = path.slice(0, at);
    const name = path.slice(at + 1);
    if (Buffer.byteLength(name, 'utf8') > 100) continue;
    if (Buffer.byteLength(prefix, 'utf8') > 155) break;
    return { name, prefix };
  }
  throw new Error(`a tar cannot hold this path (${path.length} chars, too long for ustar prefix/name)`);
}

function tarHeader(file: TreeFile, size: number, mtimeSeconds: number): Buffer {
  const header = Buffer.alloc(BLOCK, 0);
  const { name, prefix } = splitTarName(file.path);
  header.write(name, 0, 'utf8');
  octalField(header, 100, 8, modeOf(file));
  octalField(header, 108, 8, 0); // uid — the exporter's own account is not part of the artefact
  octalField(header, 116, 8, 0); // gid
  octalField(header, 124, 12, size);
  octalField(header, 136, 12, mtimeSeconds);
  header.write('        ', 148, 'utf8'); // checksum computed with this field blank
  if (file.symlink === undefined) {
    header.write('0', 156, 'utf8');
  } else {
    header.write('2', 156, 'utf8');
    header.write(file.symlink.slice(0, 100), 157, 'utf8');
  }
  header.write('ustar\0', 257, 'utf8');
  header.write('00', 263, 'utf8');
  // ustar's long-name half: `name` at 0, `prefix` at 345. Writing the split to only one of the
  // two fields is how a deep path silently extracts as its own basename.
  if (prefix !== '') header.write(prefix, 345, 'utf8');
  // `uname`/`gname` stay empty on purpose: a name here would be the packaging box's account.
  octalField(header, 148, 8, checksumOf(header));
  return header;
}

function checksumOf(header: Buffer): number {
  let sum = 0;
  for (const byte of header) sum += byte;
  return sum;
}

/**
 * The gzip container, written by hand.
 *
 * `zlib.gzipSync()` sets the OS byte from the platform the process was built for, which makes two
 * otherwise-identical archives differ between a Mac and a Linux box. The header below is the
 * documented 10-byte one with `MTIME=0`, `XFL=0`, `OS=255` — "unknown" — and a trailer this code
 * computes, so the only thing in the file is the deflated tree.
 */
function gzipContainer(raw: Buffer): Buffer {
  const deflated = deflateRawSync(raw, { level: 9 });
  const header = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff]);
  const trailer = Buffer.alloc(8, 0);
  trailer.writeUInt32LE(crc32(raw) >>> 0, 0);
  trailer.writeUInt32LE(raw.length >>> 0, 4);
  return Buffer.concat([header, deflated, trailer]);
}

/** A ustar stream: header + padded data per member, then two zero blocks. */
export function buildTarGz(files: readonly TreeFile[], mtimeMs: number): Buffer {
  const mtimeSeconds = Math.floor(mtimeMs / 1000);
  const blocks: Buffer[] = [];
  for (const file of uniqueMembers(files)) {
    const plain = dataOf(file);
    const size = file.symlink === undefined ? plain.length : 0;
    blocks.push(tarHeader(file, size, mtimeSeconds));
    if (size > 0) {
      blocks.push(plain);
      const padding = (BLOCK - (size % BLOCK)) % BLOCK;
      if (padding > 0) blocks.push(Buffer.alloc(padding, 0));
    }
  }
  blocks.push(Buffer.alloc(BLOCK * 2, 0));
  return gzipContainer(Buffer.concat(blocks));
}

/** The archive bytes for a format, from the tree the exporter is about to write. */
export function buildArchive(
  format: ArchiveFormat,
  files: readonly TreeFile[],
  mtimeMs: number,
): Buffer {
  return format === 'zip' ? buildZip(files, mtimeMs) : buildTarGz(files, mtimeMs);
}
