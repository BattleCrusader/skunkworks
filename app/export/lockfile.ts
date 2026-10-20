/**
 * The Astro export's `package-lock.json` — **the lockfile the exporter resolved** (§11.1
 * file list, O-24), filtered to the dependency closure a static Astro build needs.
 *
 * Copying the platform's lockfile is wrong in the other direction: it carries Fastify,
 * better-sqlite3, sharp and GrapesJS, and `npm ci` on the client's box would compile a
 * native driver they have no code for. Hand-writing a lockfile is worse: an entry without
 * `integrity` is a promise nobody verified.
 *
 * So this walks the **resolved** lock — every entry, `resolved` URL and `integrity` hash
 * copied verbatim — starting from one root, and keeps only what that root reaches. npm's
 * resolution is the standard `node_modules` walk: a package at `a/node_modules/x` is found
 * from a path under `a/`. Nested entries are kept nested for exactly that reason.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

interface LockPackage {
  name?: string;
  version?: string;
  resolved?: string;
  integrity?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  bin?: Record<string, string>;
  engines?: Record<string, string>;
  os?: string[];
  cpu?: string[];
  libc?: string[];
  hasInstallScript?: boolean;
  dev?: boolean;
  license?: string;
  funding?: unknown;
}

export interface Lockfile {
  name: string;
  version: string;
  lockfileVersion: number;
  requires: boolean;
  packages: Record<string, LockPackage>;
}

/**
 * The package path npm would find `name` at, from a package at `from`.
 *
 * `from` is a `packages` key (`''` for the root, `node_modules/a`, `node_modules/a/node_modules/b`).
 * The walk strips one `node_modules/<pkg>` segment at a time and tries
 * `<prefix>node_modules/<name>` at each level, which is what npm does on disk.
 */
function resolveFrom(packages: Record<string, LockPackage>, from: string, name: string): string | null {
  let prefix = from;
  for (;;) {
    const candidate = prefix === '' ? `node_modules/${name}` : `${prefix}/node_modules/${name}`;
    if (packages[candidate] !== undefined) return candidate;
    if (prefix === '') return null;
    const cut = prefix.lastIndexOf('/node_modules/');
    prefix = cut === -1 ? '' : prefix.slice(0, cut);
  }
}

/**
 * A lockfile containing `roots` and everything they reach.
 *
 * Returns `null` when a dependency of the closure is not in the source lock — a lock that
 * cannot be filtered is not a lock this exporter may ship, and the caller says so instead
 * of writing a tree that `npm ci` will refuse.
 */
export function filterLockfile(source: Lockfile, roots: readonly string[], rootDeps: Record<string, string>): Lockfile | null {
  const packages: Record<string, LockPackage> = {};
  const queue: string[] = [];
  for (const name of roots) {
    const path = resolveFrom(source.packages, '', name);
    if (path === null || source.packages[path] === undefined) return null;
    queue.push(path);
  }

  while (queue.length > 0) {
    const path = queue.shift();
    if (path === undefined || packages[path] !== undefined) continue;
    const entry = source.packages[path];
    if (entry === undefined) return null;
    packages[path] = entry;
    const deps = { ...(entry.dependencies ?? {}), ...(entry.optionalDependencies ?? {}) };
    for (const name of Object.keys(deps)) {
      const found = resolveFrom(source.packages, path, name);
      // An optional dependency may legitimately be absent (platform-specific binaries).
      if (found === null) {
        if (entry.optionalDependencies?.[name] !== undefined) continue;
        return null;
      }
      if (packages[found] === undefined) queue.push(found);
    }
  }

  // Sorted keys: the file is content, and two exports must produce the same bytes.
  const sorted: Record<string, LockPackage> = {};
  for (const key of Object.keys(packages).sort()) sorted[key] = packages[key] as LockPackage;

  const root: LockPackage = { name: 'skunkworks-export', version: '1.0.0', dependencies: rootDeps };
  return {
    name: 'skunkworks-export',
    version: '1.0.0',
    lockfileVersion: source.lockfileVersion,
    requires: true,
    packages: { '': root, ...sorted },
  };
}

/** Read the platform's lockfile from the repo root. */
export function readSourceLock(repoRoot: string): Lockfile {
  return JSON.parse(readFileSync(join(repoRoot, 'package-lock.json'), 'utf8')) as Lockfile;
}

/** The resolved version of `name` in the source lock, or `null`. */
export function resolvedVersion(lock: Lockfile, name: string): string | null {
  return lock.packages[`node_modules/${name}`]?.version ?? null;
}
