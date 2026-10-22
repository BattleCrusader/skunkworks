/**
 * A plugin package as one file: read it, and write it.
 *
 * ## Why a tarball and not a directory
 *
 * Installing a package needs its bytes in one place, and until now the only way to put them
 * there was a shell on the box (`skwctl plugin install <dir>`). The moment the operator can
 * upload one from the admin, the bytes arrive over HTTP — so they need a format that is one
 * buffer, that carries no absolute paths, and that cannot smuggle a symlink or a device node
 * into the package root.
 *
 * `tar.gz` and not `zip`: zip needs a dependency to read (Node ships `zlib`, not an inflate
 * path for the container format), and this repository's rule is that the app's runtime
 * dependency list is a cost paid on every deploy. A tar reader is 150 lines of fixed-offset
 * parsing; `packPackage()` below is the writer, so the format the operator produces with
 * `skwctl plugin pack` is exactly the format this reads.
 *
 * ## What is refused, and why each refusal is not paranoia
 *
 *  - **`..` or an absolute path.** The install copies a directory; a name that escapes it
 *    would write outside the package root before `installPlugin` ever saw the manifest.
 *  - **Anything that is not a regular file or a directory.** A symlink in the archive is a
 *    path that resolves somewhere else after extraction; a hard link is the same problem
 *    with a different header. Packages are source; they do not need either.
 *  - **AppleDouble entries (`._*`, `__MACOSX/`).** macOS's tar writes resource forks as
 *    extra files. They are not package content, and a package root hash is computed over
 *    every file it finds — an xattr blob would change the hash of an unchanged package.
 *  - **PAX/GNU long names.** Supported by reading them (macOS and GNU tar both emit them),
 *    but the *name* is still checked by the same rule; the support exists so a deep path is
 *    a name, not a parse failure.
 *  - **Size.** A cap on the compressed body, the expanded total, the file count and one
 *    file's size. The numbers are the ones the media uploader already uses as its ceiling,
 *    because the same operator is on the other end.
 */
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

import { AppError } from '../errors.ts';

/** 8 MiB compressed. A package is source: the three shipped ones are under 20 KiB. */
export const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024;
/** 32 MiB once expanded — four times the compressed cap, which is generous for text. */
export const MAX_EXPANDED_BYTES = 32 * 1024 * 1024;
/** One file in a package. */
export const MAX_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_ENTRIES = 500;

const BLOCK = 512;

function refuse(code: string, message: string, detail?: Record<string, unknown>): never {
  throw new AppError(code, message, detail ?? {});
}

function field(buf: Buffer, offset: number, length: number): string {
  return buf.subarray(offset, offset + length).toString('utf8').replace(/\0[\s\S]*$/, '').trim();
}

/** Tar's octal field, terminated by NUL or space. Base-256 is refused: it is only for >8 GiB. */
function octal(buf: Buffer, offset: number, length: number): number {
  const raw = buf.subarray(offset, offset + length);
  if (((raw[0] ?? 0) & 0x80) !== 0) refuse('SKW_E_PL_ARCHIVE_FAILED', 'the archive uses base-256 numbers, which this reader does not accept');
  const text = raw.toString('utf8').replace(/\0[\s\S]*$/, '').trim();
  if (text === '') return 0;
  if (!/^[0-7]+$/.test(text)) refuse('SKW_E_PL_ARCHIVE_FAILED', `the archive has a corrupt number field (${JSON.stringify(text.slice(0, 16))})`);
  return parseInt(text, 8);
}

/** The header's own checksum: the sum of its bytes with the checksum field read as spaces. */
function checksumOf(header: Buffer): number {
  let sum = 0;
  for (let i = 0; i < BLOCK; i += 1) sum += i >= 148 && i < 156 ? 0x20 : (header[i] ?? 0);
  return sum;
}

/**
 * A name inside the package, or a refusal.
 *
 * This is the only place a name becomes a path, so every rule lives here: relative, no `.`
 * or `..` segment, no empty segment, and a character set that cannot confuse the shell that
 * later reads the extracted tree.
 */
function safeName(raw: string): string {
  const name = raw.replace(/\\/g, '/').replace(/^\.\//, '');
  if (name === '') return '';
  if (name.startsWith('/')) refuse('SKW_E_PL_ARCHIVE_FAILED', `the archive contains an absolute path (${JSON.stringify(name)})`);
  const parts = name.split('/').filter((part) => part !== '');
  if (parts.length === 0) return '';
  for (const part of parts) {
    if (part === '.' || part === '..') refuse('SKW_E_PL_ARCHIVE_FAILED', `the archive contains a path that leaves the package (${JSON.stringify(name)})`);
    if (!/^[A-Za-z0-9._@+-]+$/.test(part)) {
      refuse('SKW_E_PL_ARCHIVE_FAILED', `the archive contains a name that is not a plain file name (${JSON.stringify(name)})`, { name });
    }
  }
  return parts.join('/');
}

function isAppleDouble(name: string): boolean {
  return name.startsWith('__MACOSX/') || name.split('/').some((part) => part.startsWith('._'));
}

interface Entry {
  name: string;
  bytes: Buffer;
}

/**
 * Parse a tar (optionally gzipped) into entries, refusing anything that is not a regular
 * file or a directory.
 *
 * The pax and GNU long-name headers are read because the two tars an operator is likely to
 * use — macOS `bsdtar` and GNU `tar` — both emit them for long paths; a reader that refused
 * them would refuse a correct archive.
 */
export function readPackageArchive(archive: Buffer): { entries: Entry[]; files: number; bytes: number } {
  if (archive.length === 0) refuse('SKW_E_PL_ARCHIVE_FAILED', 'the upload is empty');
  if (archive.length > MAX_ARCHIVE_BYTES) {
    refuse('SKW_E_PL_ARCHIVE_FAILED', `the archive is larger than ${MAX_ARCHIVE_BYTES} bytes`, { limit: MAX_ARCHIVE_BYTES, size: archive.length });
  }
  const plain = archive[0] === 0x1f && archive[1] === 0x8b ? gunzipSync(archive) : archive;
  if (plain.length > MAX_EXPANDED_BYTES) {
    refuse('SKW_E_PL_ARCHIVE_FAILED', `the archive expands to more than ${MAX_EXPANDED_BYTES} bytes`, { limit: MAX_EXPANDED_BYTES });
  }

  const entries: Entry[] = [];
  let offset = 0;
  let expanded = 0;
  // A pax/GNU header describes the *next* entry, so its overrides live across one iteration.
  let overrideName: string | null = null;

  while (offset + BLOCK <= plain.length) {
    const header = plain.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) break;
    const expected = octal(header, 148, 8);
    if (checksumOf(header) !== expected) refuse('SKW_E_PL_ARCHIVE_FAILED', 'the archive header fails its checksum — the file is corrupt');
    const nameField = field(header, 0, 100);
    const prefix = field(header, 345, 155);
    const declaredSize = octal(header, 124, 12);
    if (declaredSize > MAX_FILE_BYTES) {
      refuse('SKW_E_PL_ARCHIVE_FAILED', `the archive contains a file larger than ${MAX_FILE_BYTES} bytes`, { name: nameField, size: declaredSize });
    }
    const type = String.fromCharCode(header[156] as number);
    const dataStart = offset + BLOCK;
    const dataEnd = dataStart + declaredSize;
    if (dataEnd > plain.length) refuse('SKW_E_PL_ARCHIVE_FAILED', `the archive ends inside ${JSON.stringify(nameField)}`);
    const data = plain.subarray(dataStart, dataEnd);

    if (type === 'x') {
      // `len key=value\n` records; only `path` matters to a package root.
      const text = data.toString('utf8');
      const pathRecord = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(`\n${text}`);
      if (pathRecord !== null) overrideName = pathRecord[1] as string;
      offset = dataStart + Math.ceil(declaredSize / BLOCK) * BLOCK;
      continue;
    }
    if (type === 'g' || type === 'K') {
      offset = dataStart + Math.ceil(declaredSize / BLOCK) * BLOCK;
      continue;
    }
    if (type === 'L') {
      overrideName = data.toString('utf8').replace(/\0[\s\S]*$/, '');
      offset = dataStart + Math.ceil(declaredSize / BLOCK) * BLOCK;
      continue;
    }

    const combined = overrideName ?? (prefix === '' ? nameField : `${prefix}/${nameField}`);
    overrideName = null;
    const name = safeName(combined);

    if (type === '5') {
      // A directory carries no bytes and no entry: `mkdir` comes from writing its children.
      offset = dataStart + Math.ceil(declaredSize / BLOCK) * BLOCK;
      continue;
    }
    if (type !== '0' && type !== '\0' && type !== '7') {
      refuse('SKW_E_PL_ARCHIVE_FAILED', `the archive contains something that is not a file or a directory (type ${JSON.stringify(type)}, ${JSON.stringify(name)})`, {
        type,
        name,
      });
    }
    if (name !== '' && !isAppleDouble(name)) {
      expanded += declaredSize;
      if (expanded > MAX_EXPANDED_BYTES) {
        refuse('SKW_E_PL_ARCHIVE_FAILED', `the archive expands to more than ${MAX_EXPANDED_BYTES} bytes`, { limit: MAX_EXPANDED_BYTES });
      }
      entries.push({ name, bytes: Buffer.from(data) });
      if (entries.length > MAX_ENTRIES) refuse('SKW_E_PL_ARCHIVE_FAILED', `the archive has more than ${MAX_ENTRIES} files`, { limit: MAX_ENTRIES });
    }
    offset = dataStart + Math.ceil(declaredSize / BLOCK) * BLOCK;
  }

  if (entries.length === 0) refuse('SKW_E_PL_ARCHIVE_FAILED', 'the archive contains no files');
  return { entries, files: entries.length, bytes: expanded };
}

/**
 * Unpack into `destDir`, returning the directory that holds `plugin.json`.
 *
 * A package built with `tar czf x.tgz -C plugins/contact .` has `plugin.json` at the root; one
 * built with `tar czf x.tgz contact` has it one level down. Both are what an operator would
 * produce by hand, so both install: the returned root is the deepest single directory that
 * contains the manifest, and anything else is a refusal.
 */
export function unpackArchive(archive: Buffer, destDir: string): { root: string; reportPath: string; files: number; bytes: number } {
  const { entries, files, bytes } = readPackageArchive(archive);
  mkdirSync(destDir, { recursive: true });
  for (const entry of entries) {
    const target = join(destDir, entry.name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, entry.bytes, { mode: 0o644 });
    // `writeFileSync`'s mode is masked by the umask; a package is data, never executable.
    chmodSync(target, 0o644);
  }
  const manifestAt = (dir: string): boolean => {
    try {
      return statSync(join(dir, 'plugin.json')).isFile();
    } catch {
      return false;
    }
  };
  // The test report must be a **sibling** of the package root, never inside it: the root hash is
  // computed over every file under the root, so a report that named that hash and then became
  // part of the package would be attesting a number its own presence changed. That is also why
  // `skwctl plugin install --test-report` takes a path outside the directory, and why
  // `plugin pack` puts the report beside the package in the archive rather than inside it.
  const inner = (dir: string): { root: string; reportPath: string; files: number; bytes: number } => ({
    root: dir,
    reportPath: join(destDir, 'test-report.json'),
    files,
    bytes,
  });
  if (manifestAt(destDir)) {
    if (existsSync(join(destDir, 'test-report.json'))) {
      refuse(
        'SKW_E_PL_ARCHIVE_FAILED',
        'the archive has test-report.json inside the package root; it must sit beside the package, because a file inside changes the root hash the report attests — pack with `skwctl plugin pack <dir> --report <file>`',
      );
    }
    return inner(destDir);
  }
  const top = readdirSync(destDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  if (top.length === 1) {
    const candidate = join(destDir, (top[0] as { name: string }).name);
    if (manifestAt(candidate)) {
      if (existsSync(join(candidate, 'test-report.json'))) {
        refuse(
          'SKW_E_PL_ARCHIVE_FAILED',
          'the archive has test-report.json inside the package root; it must sit beside the package — pack with `skwctl plugin pack <dir> --report <file>`',
        );
      }
      return inner(candidate);
    }
  }
  refuse('SKW_E_PL_ARCHIVE_FAILED', 'the archive has no plugin.json at its root (or in its single top-level directory)', {
    top_level: top.map((entry) => entry.name).slice(0, 10),
  });
}

/** A temporary directory for one upload, removed by the caller. */
export function uploadScratchDir(): string {
  return mkdtempSync(join(tmpdir(), 'skw-plugin-upload-'));
}

export function removeScratchDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

// --------------------------------------------------------------------------- writing

function tarHeader(name: string, size: number, mode: number, type: string): Buffer {
  const header = Buffer.alloc(BLOCK, 0);
  const write = (offset: number, length: number, value: string): void => {
    header.write(value.slice(0, length - 1), offset, 'utf8');
  };
  const octalField = (offset: number, length: number, value: number): void => {
    const text = value.toString(8).padStart(length - 1, '0');
    header.write(`${text}\0`, offset, 'utf8');
  };
  write(0, 100, name);
  octalField(100, 8, mode);
  octalField(108, 8, 0); // uid
  octalField(116, 8, 0); // gid
  octalField(124, 12, size);
  octalField(136, 12, 0); // mtime — 0 makes two packs of one tree identical
  header.write('        ', 148, 'utf8'); // checksum computed with spaces here
  header.write(type, 156, 'utf8');
  header.write('ustar\0', 257, 'utf8');
  header.write('00', 263, 'utf8');
  octalField(148, 8, checksumOf(header));
  return header;
}

function walk(dir: string, prefix: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) walk(join(dir, entry.name), relative, out);
    else if (entry.isFile()) out.push(relative);
  }
}

/**
 * Pack a package directory into a `.tar.gz` whose bytes depend only on the tree's contents.
 *
 * Deterministic on purpose: `plugin pack` twice on one tree produces one hash, and the hash is
 * what a test report and a signature are bound to. Sorted names, zero mtime, fixed mode, zero
 * uid/gid — nothing about the machine that packed it survives.
 */
export function packPackage(dir: string, opts: { reportPath?: string } = {}): Buffer {
  const names: string[] = [];
  walk(dir, '', names);
  if (!names.includes('plugin.json')) refuse('SKW_E_PL_ARCHIVE_FAILED', 'there is no plugin.json to pack', { dir });
  // The archive holds `<basename>/…` for the package and `test-report.json` beside it; see the
  // docblock above and `unpackArchive` for why the report may not be inside the package.
  const top = dir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? 'package';
  const blocks: Buffer[] = [];
  const add = (name: string, bytes: Buffer): void => {
    if (name.length > 99) refuse('SKW_E_PL_ARCHIVE_FAILED', `a path in the package is too long for the tar format (${name.length} > 99): ${name}`);
    blocks.push(tarHeader(name, bytes.length, 0o644, '0'));
    blocks.push(bytes);
    const padding = (BLOCK - (bytes.length % BLOCK)) % BLOCK;
    if (padding > 0) blocks.push(Buffer.alloc(padding, 0));
  };
  for (const name of names) add(`${top}/${name}`, readFileSync(join(dir, name)));
  if (opts.reportPath !== undefined) {
    if (!existsSync(opts.reportPath)) refuse('SKW_E_PL_ARCHIVE_FAILED', `no test report at ${opts.reportPath}`);
    add('test-report.json', readFileSync(opts.reportPath));
  }
  blocks.push(Buffer.alloc(BLOCK * 2, 0));
  return gzipSync(Buffer.concat(blocks), { level: 9 });
}

/** `sha256` of a package archive — what an operator compares with a publisher's note. */
export function archiveSha256(archive: Buffer): string {
  return createHash('sha256').update(archive).digest('hex');
}
