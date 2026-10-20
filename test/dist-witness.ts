/**
 * E-28 — **the dist-witness register**: every site whose path or URL is computed from a
 * value that differs between `app/**\/*.ts` and `dist/app/**\/*.js`.
 *
 * The rule (SDS §16's preamble, E–28): a path assembled from ` import.meta.url `,
 * `process.argv[1]`, `process.cwd()` or `require.resolve` — or from a relative join
 * against one of them — must have **at least one gate that runs the built artefact**
 * (`make verify-dist`, `scripts/dist-gate.mjs`), or a `DIST_EXEMPT` entry with a reason.
 * There is no third option, and "the test suite passes" is not one of them: under Node's
 * type stripping `import.meta.url` ends in `.ts`, so every `.ts`-relative sibling exists
 * and the suite is blind to the difference between the two worlds.
 *
 * **The claim is per occurrence, not per file (S3R2-1).** The first version of this module
 * keyed `claimed` on `row.file`, so a ninth runtime-path site appended to `app/main.ts` —
 * a file three rows already listed — was invisible: fifteen occurrences behind eight rows,
 * E28-1/2/3 all green. That is the same class of defect as the `.ts`-solver bug this
 * register exists to catch, one level up. So a row now names each occurrence it claims by
 * an **anchor** (a substring of that site's source line), and the audit compares
 * occurrence counts per file. Both directions fail:
 *
 *   - a new site in a listed file is an *unclaimed occurrence* (the count moved, the rows
 *     did not), and the refusal names the file, the line and the code;
 *   - a new site whose line looks exactly like one a row already claims is an *ambiguous
 *     anchor* — the anchor must name one line, so it names none.
 *
 * **Adding a legitimate site** is therefore: one row. Take the unique half of the line
 * (`anchor`), name what it resolves (`resolvedBy`), and point it at the `D<n>` that
 * executes the built artefact — or, if nothing can execute it, add a `DIST_EXEMPT` entry
 * with a reason and the occurrence count it covers. The gate's refusal message prints the
 * file, the line and the code you are adding, so it is a paste, not an investigation.
 *
 * Three assertions live in `test/dist-witness.test.ts`, mirroring the witness table:
 *   1. every row's `gate` is an id `scripts/dist-gate.mjs` actually runs (so the link is a
 *      transcript, because `make verify-dist` prints each id with its site);
 *   2. every occurrence of the four markers under `app/` and `tools/` is claimed by exactly
 *      one row anchor or covered by an exemption, and the per-file counts agree;
 *   3. an unclaimed occurrence and an ambiguous anchor fail, so the class cannot grow
 *      silently — the half a one-directional table cannot see.
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
  /**
   * The occurrence(s) this row claims, each a substring of that site's source line.
   *
   * One anchor, one occurrence: an anchor that matches two lines is refused rather than
   * silently widened to cover both. Empty only for a row that names a **consumer** of
   * another row's site rather than an occurrence of its own (the Astro entry join, whose
   * `findProjectRoot()` default is `app/db/migrate.ts`'s claimed site).
   */
  anchors: string[];
  /** The `D<n>` in `scripts/dist-gate.mjs` that executes the built artefact. */
  gate: string;
}

/**
 * Eight rows over five files, fourteen occurrences. `gate` names the assertion, not the
 * file: `D1` boots `dist/app/main.js`, which is the only place `isMain`, `schemaDirFrom`
 * and `findProjectRoot` are exercised as the image runs them.
 */
export const DIST_SITES: DistSite[] = [
  {
    site: 'the stamp worker URL, and the Worker it starts',
    file: 'app/download/render.ts',
    resolvedBy: "stampWorkerUrl(import.meta.url) -> new URL('./stamp-worker' + suffix) -> new Worker(...)",
    anchors: ['new Worker(stampWorkerUrl(import.meta.url))'],
    gate: 'D3',
  },
  {
    site: 'the schema directory',
    file: 'app/main.ts',
    resolvedBy: 'schemaDirFrom(import.meta.url) -> findProjectRoot(dirname(fileURLToPath(url)))',
    anchors: ['schemaDirFrom(import.meta.url)'],
    gate: 'D1',
  },
  {
    site: 'the Astro SSR entry',
    file: 'app/main.ts',
    resolvedBy: "join(findProjectRoot(), 'build', 'astro', 'server', 'entry.mjs') — a consumer of migrate.ts's root, not an occurrence of its own",
    anchors: [],
    gate: 'D2',
  },
  {
    site: "the app's own entry detection",
    file: 'app/main.ts',
    resolvedBy: 'isMain(import.meta.url) -> process.argv[1]',
    anchors: ['const entry = process.argv[1];', 'if (isMain(import.meta.url))'],
    gate: 'D1',
  },
  {
    site: "the project root a tenant migration reads `schema/` from",
    file: 'app/db/migrate.ts',
    resolvedBy: 'findProjectRoot(dirname(fileURLToPath(import.meta.url))) -> process.cwd() when nothing matches',
    anchors: ['fileURLToPath(import.meta.url)', 'return process.cwd();'],
    gate: 'D4',
  },
  {
    site: "the migrator's entry detection",
    file: 'app/db/migrate.ts',
    resolvedBy: 'isMain(import.meta.url) -> process.argv[1], relative(process.cwd(), …)',
    anchors: ['const entry = process.argv[1];', 'relative(process.cwd(), entry)', 'if (isMain(import.meta.url))'],
    gate: 'D4',
  },
  {
    site: "skwctl's entry detection",
    file: 'app/cli/skwctl.ts',
    resolvedBy: 'isMain(import.meta.url) -> process.argv[1]',
    anchors: ['const entry = process.argv[1];', 'if (isMain(import.meta.url))'],
    gate: 'D5',
  },
  {
    site: "the nginx generator's entry detection and default output path",
    file: 'tools/nginx_gen.ts',
    resolvedBy: "isMain(import.meta.url) -> new URL(metaUrl).pathname === process.argv[1]; join(process.cwd(), …)",
    anchors: ["join(process.cwd(), 'nginx', 'conf.d', '10-app.conf')", 'const entry = process.argv[1];', 'if (isMain(import.meta.url))'],
    gate: 'D6',
  },
];

/**
 * Sites in the class that may not claim a `D` row, each with the reason it is not proved on
 * the artefact **and the occurrence count it covers**. An exemption is a statement, not a
 * silent pass: a new marker in an exempt file reddens the count.
 */
export const DIST_EXEMPT: { file: string; occurrences: number; reason: string }[] = [
  {
    file: 'tools/regen_conf.ts',
    occurrences: 0,
    reason:
      'Ships (Dockerfile.app copies dist/, so dist/tools/regen_conf.js is in the image) but nothing invokes ' +
      'it, and its REPO comes from test-helpers/fixture.ts, so in dist it names …/dist and cannot work. ' +
      'The site itself is transitive — this file holds no marker of its own, which is what the count of 0 ' +
      'records. A gate over a tool nobody runs would be a gate over nothing; the fix is to take the root ' +
      'from findProjectRoot, and that is S4 packaging work (S3R2-5).',
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

export interface FileCount {
  file: string;
  /** Occurrences the scan found in this file. */
  found: number;
  /** Occurrences a row anchor (or the exemption's count) accounts for. */
  claimed: number;
  exempt: boolean;
}

export interface WitnessReport {
  occurrences: Occurrence[];
  /** Occurrences no row claims and no exemption covers, as `file:line marker — code`. */
  unclaimed: string[];
  /** Rows whose anchors no longer describe the tree, or which claim the same line twice. */
  claimErrors: string[];
  unknownGates: string[];
  /** Per-file counts, so the reader (and the gate) compares occurrences, not files. */
  files: FileCount[];
  exemptFiles: string[];
}

/**
 * The register's own audit, over a list of occurrences.
 *
 * Separated from `auditWitnesses` so the negative control can inject a site **in memory**
 * and see the register refuse it, without writing to the tree the suite is running on.
 */
export function auditOccurrences(found: Occurrence[], script = GATE_SCRIPT): WitnessReport {
  const claimErrors: string[] = [];
  const owner = new Map<Occurrence, string>();
  const byFile = new Map<string, Occurrence[]>();
  for (const o of found) {
    const list = byFile.get(o.file);
    if (list === undefined) byFile.set(o.file, [o]);
    else list.push(o);
  }

  for (const row of DIST_SITES) {
    for (const anchor of row.anchors) {
      const matches = (byFile.get(row.file) ?? []).filter((o) => o.text.includes(anchor));
      if (matches.length === 0) {
        claimErrors.push(`"${row.site}" (${row.file}): anchor "${anchor}" matches no line in the file`);
        continue;
      }
      if (matches.length > 1) {
        const where = matches.map((o) => `${o.file}:${o.line}`).join(', ');
        claimErrors.push(
          `"${row.site}" (${row.file}): anchor "${anchor}" matches ${matches.length} lines (${where}) — an anchor must name one site`,
        );
        continue;
      }
      const only = matches[0] as Occurrence;
      const already = owner.get(only);
      if (already !== undefined) {
        claimErrors.push(`"${already}" and "${row.site}" both claim ${only.file}:${only.line}`);
        continue;
      }
      owner.set(only, row.site);
    }
  }

  const exempt = new Set(DIST_EXEMPT.map((row) => row.file));
  const exemptCount = new Map(DIST_EXEMPT.map((row) => [row.file, row.occurrences]));
  const unclaimed = found
    .filter((o) => !owner.has(o) && !exempt.has(o.file))
    .map((o) => `${o.file}:${o.line} ${o.marker} — ${o.text}`);

  const ids = new Set(gateIds(script));
  const unknownGates = DIST_SITES.filter((row) => !ids.has(row.gate)).map((row) => `${row.site} -> ${row.gate}`);

  const files: FileCount[] = [...byFile.keys()].sort().map((file) => {
    const rows = found.filter((o) => o.file === file);
    const isExempt = exempt.has(file);
    const claimed = isExempt
      ? (exemptCount.get(file) as number)
      : rows.filter((o) => owner.has(o)).length;
    return { file, found: rows.length, claimed, exempt: isExempt };
  });
  // An exempt file with no occurrence is still a row in the report: "0 covered, 0 found" is
  // the statement that keeps it from quietly becoming one covered occurrence.
  for (const row of DIST_EXEMPT) {
    if (!byFile.has(row.file)) files.push({ file: row.file, found: 0, claimed: row.occurrences, exempt: true });
  }
  files.sort((a, b) => a.file.localeCompare(b.file));
  // A row or an exemption that names a file with no occurrence still owes an entry: a stale
  // file name is a claim about code that no longer exists.
  for (const row of DIST_SITES) {
    if (!byFile.has(row.file) && row.anchors.length > 0) {
      claimErrors.push(`"${row.site}" names ${row.file}, which holds no marker`);
    }
  }
  for (const row of DIST_EXEMPT) {
    if (!byFile.has(row.file) && row.occurrences > 0) {
      claimErrors.push(`DIST_EXEMPT ${row.file} covers ${row.occurrences} occurrence(s); the file holds none`);
    }
  }

  return { occurrences: found, unclaimed, claimErrors, unknownGates, files, exemptFiles: [...exempt] };
}

/** The same audit over the tree on disk — what the gate runs. */
export function auditWitnesses(root = REPO, script = GATE_SCRIPT): WitnessReport {
  return auditOccurrences(occurrences(root), script);
}
