/**
 * The box's package library: archives that exist on this machine, for any tenant that wants one.
 *
 * The distinction this file exists to draw is the one the admin screen used to blur. Before it,
 * a package was either installed for *this* tenant or it did not exist as far as this tenant
 * could see — a package dropped on the box was invisible until somebody ran `skwctl plugin
 * install --tenant …` from a shell. That made every new tenant a fresh shell session, which is
 * exactly the wheel nobody wants to reinvent.
 *
 * So there are three states, and they are different things:
 *
 *   1. **In the library** — `data/plugin-library/<file>.tar.gz`, box-wide, read-only. This is
 *      "installed on the system". Every tenant sees every entry.
 *   2. **Installed for a tenant** — a row in *that tenant's* `cms_plugin_installed`, its tables
 *      created in *that tenant's* `site.db`. Installing one tenant's copy says nothing about any
 *      other tenant's: the package's schema and rows are confined to one database file.
 *   3. **Enabled** — the per-tenant switch, unchanged, still a separate press.
 *
 * Reading here is deliberately forgiving and installing is not. A listing that refused to parse
 * would hide a package and an operator would conclude the library is empty; a listing that
 * printed `id` from an unreadable archive would be guessing. Unreadable entries are therefore
 * listed with their error and no id, and nothing in this file writes a byte.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { readPackageArchive } from './archive.ts';

/** Where the library lives, under the data directory. Also the name `skwctl` looks for. */
export const LIBRARY_DIR = 'plugin-library';

/**
 * What may be opened by name. No slashes, no `..`, no absolute paths, and it must be a `.tar.gz`
 * — the install path takes the bytes and hands them to the same reader an upload goes through,
 * so the rule for "which file" is decided here rather than in the route.
 */
export const LIBRARY_FILE = /^[a-z0-9][a-z0-9._-]{0,80}\.tar\.gz$/;

export interface LibraryReport {
  root_hash: string;
  runner_image_digest: string;
  ran_at: string;
}

export interface LibraryPackage {
  /** The file name inside the library. A name, never a path. */
  file: string;
  bytes: number;
  /** `null` when the archive could not be read — such an entry is listed, not hidden. */
  id: string | null;
  version: string | null;
  description: string | null;
  /**
   * What the archive's own `test-report.json` claims. Self-attested: the box did not run those
   * tests, and the screen says so in the same sentence it shows the date.
   */
  report: LibraryReport | null;
  error: string | null;
}

export function libraryDir(dataDir: string): string {
  return join(dataDir, LIBRARY_DIR);
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** The prefix of the package root inside the archive, or a refusal to guess between two. */
function packagePrefix(entries: { name: string }[]): string {
  if (entries.some((entry) => entry.name === 'plugin.json')) return '';
  const nested = entries.filter((entry) => /^[^/]+\/plugin\.json$/.test(entry.name));
  if (nested.length === 1) {
    return (nested[0] as { name: string }).name.slice(0, -'plugin.json'.length);
  }
  throw new Error('no single package root: the archive carries no plugin.json, or more than one');
}

function readOne(path: string, file: string, bytes: number): LibraryPackage {
  const empty: LibraryPackage = { file, bytes, id: null, version: null, description: null, report: null, error: null };
  let entries: { name: string; bytes: Buffer }[];
  try {
    entries = readPackageArchive(readFileSync(path)).entries;
  } catch (err) {
    return { ...empty, error: err instanceof Error ? err.message : String(err) };
  }
  const byName = new Map(entries.map((entry) => [entry.name, entry.bytes]));
  try {
    const prefix = packagePrefix(entries);
    const manifest = JSON.parse(String(byName.get(`${prefix}plugin.json`))) as Record<string, unknown>;
    // The report is the package root's *sibling* (`plugin pack` writes `test-report.json` at the
    // archive root, beside `contact/`), because a file inside the root would change the root hash
    // the report attests. Both spellings are accepted so an archive with the package at the top
    // level — where the sibling is also the root — reads the same way.
    const reportRaw = byName.get(`${prefix}test-report.json`) ?? byName.get('test-report.json');
    let report: LibraryReport | null = null;
    if (reportRaw !== undefined) {
      try {
        const parsed = JSON.parse(String(reportRaw)) as Record<string, unknown>;
        report = {
          root_hash: text(parsed.root_hash) ?? '',
          runner_image_digest: text(parsed.runner_image_digest) ?? '',
          ran_at: text(parsed.ran_at) ?? '',
        };
      } catch {
        // A report that is not JSON is `installPlugin`'s refusal to make, with the file named.
        // Here it is simply no claim: the entry still lists, and the install will say why not.
        report = null;
      }
    }
    return {
      ...empty,
      id: text(manifest.id),
      version: text(manifest.version),
      description: text(manifest.description),
      report,
    };
  } catch (err) {
    return { ...empty, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Every archive in the library, sorted by id so the screen does not reshuffle between requests.
 * A missing directory is an empty library, not an error: a box that has never been given one.
 */
export function listLibrary(dir: string): LibraryPackage[] {
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => LIBRARY_FILE.test(name)).sort();
  } catch {
    return [];
  }
  return names.map((file) => {
    const path = join(dir, file);
    try {
      const stat = statSync(path);
      if (!stat.isFile()) return { file, bytes: 0, id: null, version: null, description: null, report: null, error: 'not a file' };
      return readOne(path, file, stat.size);
    } catch (err) {
      return { file, bytes: 0, id: null, version: null, description: null, report: null, error: err instanceof Error ? err.message : String(err) };
    }
  });
}

/**
 * The bytes of one library entry, by name.
 *
 * The name is matched against `LIBRARY_FILE` before `join()`, so `../../control.db` is refused
 * as a name rather than resolved as a path — the check is the shape of the string, not a
 * comparison of resolved paths, because a resolved-path check is one symlink away from wrong.
 */
export function readLibraryArchive(dir: string, file: string): Buffer {
  if (!LIBRARY_FILE.test(file)) throw new Error(`not a library file name: ${file}`);
  const path = join(dir, file);
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`no such package in the library: ${file}`);
  return readFileSync(path);
}

/**
 * The library entry for a plugin id, preferring the highest version string.
 *
 * Two archives for one id is a normal state — an operator keeps the previous release beside the
 * new one. The screen lists both; the button installs the one it names, so this is only used
 * where an id alone was given.
 */
export function findInLibrary(dir: string, id: string): LibraryPackage | null {
  const matches = listLibrary(dir).filter((entry) => entry.id === id);
  if (matches.length === 0) return null;
  return matches.sort((a, b) => String(a.version).localeCompare(String(b.version), 'en', { numeric: true })).at(-1) ?? null;
}
