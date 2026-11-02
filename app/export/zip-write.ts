/**
 * Write a zip — deterministic, dependency-free, and small enough to audit.
 *
 * ## Why hand-rolled
 *
 * The box has no archiver dependency and will not get one for this: a zip is a local header, the
 * bytes, a central directory and an end record, and `node:zlib` already supplies crc32 and raw
 * deflate. The reader (`app/render/zip.ts`) was written the same way for the same reason, and the
 * two are tested against each other (`test/zip-write.test.ts` reads back what this writes).
 *
 * ## Why deterministic
 *
 * Two exports of an unchanged site must be the same bytes, or "did this change?" is unanswerable and
 * a bundle's sha256 stops being a receipt. So: entries in the caller's order (callers sort), one
 * pinned timestamp for every entry, fixed modes (0644, or 0755 for a script), no extra fields, no
 * OS metadata, deflate at a fixed level.
 *
 * Symlinks are stored the unix way — mode `S_IFLNK|0777` in the external attributes, the target as
 * the entry's data — which is what `unzip` and `bsdtar` both understand.
 */
import { crc32, deflateRawSync } from 'node:zlib';

export interface ZipWriteEntry {
  /** Forward-slash path inside the archive. */
  path: string;
  /** The file's bytes, or the target when `symlink` is true. */
  bytes?: Buffer;
  /** A relative symlink target. Mutually exclusive with `bytes`. */
  symlink?: string;
  /** Unix mode bits; default 0o644, and 0o755 is what an installer wants. */
  mode?: number;
}

const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;
const VERSION_MADE_BY = (3 << 8) | 20; // unix, zip 2.0

function dosDateTime(iso: string): { time: number; date: number } {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) throw new Error(`not a timestamp: ${iso}`);
  const year = at.getUTCFullYear();
  if (year < 1980) throw new Error(`zip cannot store ${iso} (before 1980)`);
  const time = (at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | Math.floor(at.getUTCSeconds() / 2);
  const date = ((year - 1980) << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate();
  return { time, date };
}

/** Deterministic: same entries + same `now` → same bytes. */
export function writeZip(entries: readonly ZipWriteEntry[], now: string): Buffer {
  const { time, date } = dosDateTime(now);
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    if ((entry.bytes === undefined) === (entry.symlink === undefined)) {
      throw new Error(`${entry.path}: give either bytes or a symlink target`);
    }
    if (entry.path.startsWith('/') || entry.path.split('/').includes('..')) {
      throw new Error(`${entry.path}: a zip entry path must be relative and must not climb`);
    }
    const name = Buffer.from(entry.path, 'utf8');
    const data = entry.bytes ?? Buffer.from(entry.symlink ?? '', 'utf8');
    const isLink = entry.symlink !== undefined;
    const mode = (isLink ? S_IFLNK : S_IFREG) | (entry.mode ?? (isLink ? 0o777 : 0o644));
    const crc = crc32(data) >>> 0;
    // Stored for tiny members (a deflate header costs more than the bytes) and for anything already
    // compressed; deflated for the rest. The rule is a function of the input, so it stays
    // deterministic.
    const deflate = data.length > 128;
    const packed = deflate ? deflateRawSync(data, { level: 9 }) : data;
    const method = deflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x0403_4b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, packed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x0201_4b50, 0);
    central.writeUInt16LE(VERSION_MADE_BY, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + packed.length;
  }

  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x0605_4b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, directory, end]);
}

/** A safe archive name for a download: `fractional-works-2026-10-29.zip`. */
export function archiveName(base: string, now: string): string {
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${slug === '' ? 'site' : slug}-${now.slice(0, 10)}.zip`;
}
