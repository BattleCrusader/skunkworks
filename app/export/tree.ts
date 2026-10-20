/**
 * The one writer — deterministic trees, and the hash that proves it (§6.4, §11.5).
 *
 * Reproducibility is a property of the **filesystem**, not only of the strings: a tree
 * whose bytes match but whose mtimes differ is not byte-identical under `tar`, `rsync -a`
 * or a sha256 of the archive, and the S4 row is phrased as "byte-identical" because that
 * is the promise a client can check. So every file and every directory is written here,
 * in sorted order, with its own mode and an mtime pinned to `SKW_EXPORT_NOW`.
 *
 * Two consequences worth stating rather than discovering:
 *
 *   - the writer refuses a non-empty destination. A stale `about/index.html` from an
 *     earlier export would make the second tree differ by a file nobody regenerated,
 *     which reads as non-determinism and is actually a bad `rm`;
 *   - `hashTree()` hashes **paths, kinds and content**, symlink targets included, and it
 *     hashes a symlink's target string rather than the file it points at — otherwise two
 *     trees whose links differ but resolve to the same inode would hash equal, and the
 *     farm's relative-link property (§11.6, O-09) is exactly what must be identical.
 */
import type { Stats } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  lutimesSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

export interface TreeFile {
  /** POSIX path relative to the tree root. */
  path: string;
  /** Exactly one of `bytes` or `symlink`. */
  bytes?: Buffer | string;
  symlink?: string;
  /** `0o644` by default; `0o755` for the one script a bundle runs. */
  mode?: number;
}

/** Directories under this name are build artefacts, never part of an export. */
const IGNORED = new Set(['node_modules', '.git']);

function byPath(a: TreeFile, b: TreeFile): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/**
 * Write `files` into `root`, sorted, with every mtime set to `mtimeMs`.
 *
 * The directory's own mtime is set **after** its children, in reverse path order, because
 * creating a child updates the parent's mtime — the one ordering bug that makes a
 * "pinned" tree differ between runs.
 */
export function writeTree(root: string, files: readonly TreeFile[], mtimeMs: number): void {
  if (!Number.isFinite(mtimeMs)) throw new Error(`writeTree: mtimeMs is not a number (${mtimeMs})`);
  if (existsSync(root)) {
    const entries = readdirSync(root);
    if (entries.length > 0) throw new Error(`writeTree: ${root} is not empty; an export needs a fresh tree`);
  } else {
    mkdirSync(root, { recursive: true });
  }

  for (const file of [...files].sort(byPath)) {
    if ((file.bytes === undefined) === (file.symlink === undefined)) {
      throw new Error(`writeTree: ${file.path} must carry exactly one of bytes or symlink`);
    }
    const full = join(root, file.path);
    mkdirSync(dirname(full), { recursive: true });
    if (file.symlink !== undefined) {
      symlinkSync(file.symlink, full);
      lutimesSync(full, mtimeMs / 1000, mtimeMs / 1000);
      continue;
    }
    writeFileSync(full, file.bytes ?? '');
    chmodSync(full, file.mode ?? 0o644);
    utimesSync(full, mtimeMs / 1000, mtimeMs / 1000);
  }

  // Deepest first. `utimesSync` on a child does not touch its parent, so the order is
  // belt-and-braces — but it is the order a reader expects from the comment above.
  for (const dir of directories(root)) utimesSync(dir, mtimeMs / 1000, mtimeMs / 1000);
}

/** Every directory under `root`, deepest first. */
function directories(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (IGNORED.has(entry.name)) continue;
        const full = join(dir, entry.name);
        walk(full);
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

export interface TreeEntry {
  path: string;
  kind: 'file' | 'symlink' | 'dir';
  sha256: string;
  bytes: number;
  /** The target string for a symlink, empty otherwise. */
  target: string;
}

export interface TreeHash {
  /** sha256 over the sorted `path\0kind\0sha256\n` lines. */
  sha256: string;
  entries: TreeEntry[];
  files: number;
  bytes: number;
}

function relativePosix(root: string, full: string): string {
  return relative(root, full).split(sep).join('/');
}

/**
 * Hash a tree: paths, kinds and content, sorted. Directories are included (a directory
 * that exists in one tree and not the other is a difference) but contribute no bytes.
 */
export function hashTree(root: string): TreeHash {
  const entries: TreeEntry[] = [];
  let bytes = 0;

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (IGNORED.has(entry.name)) continue;
      const full = join(dir, entry.name);
      const path = relativePosix(root, full);
      const stat: Stats = lstatSync(full);
      if (stat.isSymbolicLink()) {
        const target = readlinkSync(full);
        entries.push({ path, kind: 'symlink', sha256: createHash('sha256').update(target).digest('hex'), bytes: 0, target });
        continue;
      }
      if (stat.isDirectory()) {
        entries.push({ path, kind: 'dir', sha256: createHash('sha256').update('').digest('hex'), bytes: 0, target: '' });
        walk(full);
        continue;
      }
      const content = readFileSync(full);
      bytes += content.byteLength;
      entries.push({
        path,
        kind: 'file',
        sha256: createHash('sha256').update(content).digest('hex'),
        bytes: content.byteLength,
        target: '',
      });
    }
  };
  walk(root);

  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const lines = entries.map((e) => `${e.path}\0${e.kind}\0${e.sha256}\n`).join('');
  return {
    sha256: createHash('sha256').update(lines).digest('hex'),
    entries,
    files: entries.filter((e) => e.kind !== 'dir').length,
    bytes,
  };
}

