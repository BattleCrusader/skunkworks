/**
 * E-28 — **the dist-witness register**: every site whose path or URL is computed from a
 * value that differs between `app/**\/*.ts` and `dist/app/**\/*.js`.
 *
 * The rule (SDS §16's preamble, E–28): a path assembled from `import.meta.url`,
 * `process.argv[1]`, `process.cwd()` or `require.resolve` — or from a relative join
 * against one of them — must have **at least one gate that runs the built artefact**
 * (`make verify-dist`, `scripts/dist-gate.mjs`), or a `DIST_EXEMPT` entry with a reason.
 * There is no third option, and "the test suite passes" is not one of them: under Node's
 * type stripping `import.meta.url` ends in `.ts`, so every `.ts`-relative sibling exists
 * and the suite is blind to the difference between the two worlds.
 *
 * Three assertions live in `test/dist-witness.test.ts`, mirroring the witness table:
 *   1. every row's `gate` is an id `scripts/dist-gate.mjs` actually runs (so the link is a
 *      transcript, because `make verify-dist` prints each id with its site);
 *   2. every occurrence of the four markers under `app/` and `tools/` is claimed by a row
 *      or listed in `DIST_EXEMPT` with a reason;
 *   3. an unclaimed occurrence fails, so the class cannot grow silently — the half a
 *      one-directional table cannot see.
 *
 * This module is not a `*.test.ts` file on purpose: the table is data, and the assertions
 * are its reader. `test/dist-witness.test.ts` is the gate.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
export const GATE_SCRIPT = join(REPO, 'scripts', 'dist-gate.mjs');

/** The four markers, and nothing else: `new URL(req.url, …)` is request parsing, not this class. */
export const MARKERS = ['import.meta.url', 'process.argv[1]', 'process.cwd()', 'require.resolve'] as const;

export type Marker = (typeof MARKERS)[number];

export interface DistSite {
  /** What is resolved. */
  site: string;
  /** The file that resolves it. */
  file: string;
  /** The expression, as a reader would find it. */
  resolvedBy: string;
  /** The `D<n>` in `scripts/dist-gate.mjs` that executes the built artefact. */
  gate: string;
}

/**
 * Eight rows over five files. `gate` names the assertion, not the file: `D1` boots
 * `dist/app/main.js`, which is the only place `isMain`, `schemaDirFrom` and
 * `findProjectRoot` are exercised as the image runs them.
 */
export const DIST_SITES: DistSite[] = [
  {
    site: 'the stamp worker URL, and the Worker it starts',
    file: 'app/download/render.ts',
    resolvedBy: "stampWorkerUrl(import.meta.url) -> new URL('./stamp-worker' + suffix) -> new Worker(...)",
    gate: 'D3',
  },
  {
    site: 'the schema directory',
    file: 'app/main.ts',
    resolvedBy: 'schemaDirFrom(import.meta.url) -> findProjectRoot(dirname(fileURLToPath(url)))',
    gate: 'D1',
  },
  {
    site: 'the Astro SSR entry',
    file: 'app/main.ts',
    resolvedBy: "join(findProjectRoot(), 'build', 'astro', 'server', 'entry.mjs')",
    gate: 'D2',
  },
  {
    site: "the app's own entry detection",
    file: 'app/main.ts',
    resolvedBy: 'isMain(import.meta.url) -> process.argv[1]',
    gate: 'D1',
  },
  {
    site: "the project root a tenant migration reads `schema/` from",
    file: 'app/db/migrate.ts',
    resolvedBy: "findProjectRoot(dirname(fileURLToPath(import.meta.url))) -> process.cwd() when nothing matches",
    gate: 'D4',
  },
  {
    site: "the migrator's entry detection",
    file: 'app/db/migrate.ts',
    resolvedBy: 'isMain(import.meta.url) -> process.argv[1], relative(process.cwd(), …)',
    gate: 'D4',
  },
  {
    site: "skwctl's entry detection",
    file: 'app/cli/skwctl.ts',
    resolvedBy: 'isMain(import.meta.url) -> process.argv[1]',
    gate: 'D5',
  },
  {
    site: "the nginx generator's entry detection and default output path",
    file: 'tools/nginx_gen.ts',
    resolvedBy: "isMain(import.meta.url) -> new URL(metaUrl).pathname === process.argv[1]; join(process.cwd(), …)",
    gate: 'D6',
  },
];

/**
 * Sites in the class that may not claim a `D` row, each with the reason it is not proved
 * on the artefact. An exemption is a statement, not a silent pass.
 */
export const DIST_EXEMPT: { file: string; markers: Marker[]; reason: string }[] = [
  {
    file: 'tools/regen_conf.ts',
    markers: ['import.meta.url'],
    reason:
      'Not shipped (Dockerfile.app copies dist/, build/, schema/ into /srv/app) and its REPO is ' +
      'module-relative through test-helpers/fixture.ts, so in dist it names …/dist and cannot work. ' +
      'A gate over a tool nobody ships would be a gate over nothing; the fix is to take the root ' +
      'from findProjectRoot, and that is S4 packaging work.',
  },
];

export interface Occurrence {
  file: string;
  line: number;
  marker: Marker;
  text: string;
}

/** `app/**\/*.ts` and `tools/**\/*.ts`, relative to the repo root. */
export function scannedFiles(root = REPO): string[] {
  const found: string[] = [];
  for (const dir of ['app', 'tools']) {
    const walk = (path: string): void => {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        const full = join(path, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile() && entry.name.endsWith('.ts')) found.push(relative(root, full));
      }
    };
    const start = join(root, dir);
    if (statSync(start).isDirectory()) walk(start);
  }
  return found.sort();
}

/**
 * Every occurrence, comments excluded.
 *
 * Comment lines are skipped because a doc comment that *describes* `import.meta.url` is not
 * a site; only a line that starts with `*`, `//` or `/*` is treated as prose. That is enough
 * for this tree, where the markers never appear inside a string literal on a code line.
 */
export function occurrences(root = REPO): Occurrence[] {
  const found: Occurrence[] = [];
  for (const file of scannedFiles(root)) {
    const lines = readFileSync(join(root, file), 'utf8').split('\n');
    lines.forEach((text, i) => {
      const trimmed = text.trimStart();
      if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) return;
      for (const marker of MARKERS) {
        if (text.includes(marker)) found.push({ file, line: i + 1, marker, text: trimmed });
      }
    });
  }
  return found;
}

/** The `D<n>` ids `scripts/dist-gate.mjs` runs, read from its CHECKS table. */
export function gateIds(script = GATE_SCRIPT): string[] {
  const source = readFileSync(script, 'utf8');
  const ids: string[] = [];
  const re = /^\s*\['(D\d+)',/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) ids.push(match[1] as string);
  return ids;
}

export interface WitnessReport {
  occurrences: Occurrence[];
  unclaimed: string[];
  unknownGates: string[];
  exemptFiles: string[];
}

/** The register's own audit, so the gate and the table can be checked without running `dist/`. */
export function auditWitnesses(root = REPO, script = GATE_SCRIPT): WitnessReport {
  const found = occurrences(root);
  const claimed = new Set(DIST_SITES.map((row) => row.file));
  const exempt = new Set(DIST_EXEMPT.map((row) => row.file));
  const ids = new Set(gateIds(script));
  const unclaimed = found
    .filter((o) => !claimed.has(o.file) && !exempt.has(o.file))
    .map((o) => `${o.file}:${o.line} ${o.marker} — ${o.text}`);
  const unknownGates = DIST_SITES.filter((row) => !ids.has(row.gate)).map((row) => `${row.site} -> ${row.gate}`);
  return { occurrences: found, unclaimed, unknownGates, exemptFiles: [...exempt] };
}
