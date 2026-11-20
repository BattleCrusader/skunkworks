/**
 * Put every package on the shelf.
 *
 *     make plugin-shelf          (or: node --experimental-strip-types scripts/plugin-shelf.ts)
 *
 * ## Why this exists
 *
 * `plugins/README.md` promises three states — in the **library** (`data/plugin-library/`, "every
 * tenant sees every entry"), **installed** per tenant, **enabled** per tenant. The middle state had
 * a door (`/admin/t/<tenant>/plugins`) and the library had none: no command wrote an archive, so the
 * shelf was whatever an operator had once `cp`-ed by hand. In practice it held five stale archives
 * and no `analytics` at all, which is why a tenant could not install a package the box had been
 * running for months.
 *
 * ## What it does, per package
 *
 *   1. computes the package's canonical root hash (the value `install` re-computes and compares);
 *   2. runs the **smoke checks** below and writes `test-reports/<id>-<version>.json`;
 *   3. packs `data/plugin-library/<id>-<version>.tar.gz` with `packPackage`, report beside the
 *      package (inside the archive it would change the root the report attests).
 *
 * ## What it does NOT do, and says so in every report
 *
 * No package in this repo declares `plugin.json.tests`, so there is no suite result to record.
 * The report therefore carries `checks[]` (what was actually run) and a `note` that says exactly
 * that. It is a smoke report, and calling a fabricated suite green would be worse than having none:
 * the install gate exists precisely so a client's contact form cannot be the first test.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

import { packPackage } from '../app/plugins/archive.ts';
import { packageRootHash } from '../app/plugins/manifest.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_DIR = join(REPO, 'plugins');
const LIBRARY = join(REPO, 'data', 'plugin-library');
const REPORTS = join(REPO, 'test-reports');

/** A package's own manifest, as far as this script needs it. */
interface Manifest {
  id: string;
  version: string;
  main: string;
  hooks?: string[];
  capabilities?: string[];
  files?: { name: string; path: string }[];
  tables?: { name: string }[];
  endpoints?: { name: string; method: string }[];
  tests?: unknown;
}

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

async function smoke(dir: string, manifest: Manifest): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (name: string, fn: () => string): void => {
    try {
      checks.push({ name, ok: true, detail: String(fn()) });
    } catch (e) {
      checks.push({ name, ok: false, detail: String((e as Error).message ?? e) });
    }
  };

  add('manifest declares id, version, main', () => {
    for (const key of ['id', 'version', 'main'] as const) if (!manifest[key]) throw new Error(`missing ${key}`);
    return `${manifest.id}@${manifest.version}`;
  });

  // A package entry is ESM, so it is imported rather than parsed as a classic script: `new Script`
  // on `export …` throws `Unexpected token 'export'`, which reads like a broken package but is a
  // broken checker. Importing also proves the module actually links and exports something.
  {
    const entry = join(dir, manifest.main);
    try {
      const mod = (await import(pathToFileURL(entry).href)) as Record<string, unknown>;
      const keys = Object.keys(mod);
      if (keys.length === 0) throw new Error('entry exports nothing');
      checks.push({ name: 'entry imports as a module', ok: true, detail: `${entry} exports: ${keys.join(',')}` });
    } catch (e) {
      checks.push({ name: 'entry imports as a module', ok: false, detail: String((e as Error).message ?? e) });
    }
  }

  add('declared client files exist and fit the static cap', () => {
    const out: string[] = [];
    for (const file of manifest.files ?? []) {
      const path = join(dir, file.path ?? file.name); // `path`, not `name`: name is the URL segment
      const size = statSync(path).size;
      if (size > 512 * 1024) throw new Error(`${file.path} is over the 512 KiB static cap`);
      out.push(`${file.name}<-${file.path}:${size}B`);
    }
    return out.join(', ') || 'none declared';
  });

  add('tables declared', () => (manifest.tables ?? []).map((t) => t.name).join(',') || 'NONE');
  add('hooks declared', () => (manifest.hooks ?? []).join(',') || 'NONE');
  add('endpoints declared', () =>
    (manifest.endpoints ?? []).map((e) => `${e.method} ${e.name}`).join(',') || 'NONE');
  add('capabilities declared', () => (manifest.capabilities ?? []).join(','));

  return checks;
}

async function main(): Promise<number> {
  mkdirSync(LIBRARY, { recursive: true });
  mkdirSync(REPORTS, { recursive: true });

  const digest = `sha256:plugin-shelf`;
  const failures: string[] = [];
  const packed: string[] = [];

  for (const id of readdirSync(SOURCE_DIR).sort()) {
    const dir = join(SOURCE_DIR, id);
    if (!statSync(dir).isDirectory()) continue;
    const manifestPath = join(dir, 'plugin.json');
    if (!existsSync(manifestPath)) continue;

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
    const { root, files } = packageRootHash(dir);
    const checks = await smoke(dir, manifest);
    const allOk = checks.every((c) => c.ok);

    const report = {
      plugin: manifest.id,
      version: manifest.version,
      root_hash: root,
      runner_image_digest: digest,
      ran_at: new Date().toISOString(),
      note:
        'plugin.json declares no tests (tests=null), so no suite result exists. These are the ' +
        'packager\'s pre-pack smoke checks against the exact bytes being packed, not a test suite.',
      tests_declared: manifest.tests ?? null,
      checks,
      package_files: files.length,
      all_checks_passed: allOk,
    };
    const reportPath = join(REPORTS, `${manifest.id}-${manifest.version}.json`);
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

    if (!allOk) {
      failures.push(`${manifest.id}@${manifest.version}: ${checks.filter((c) => !c.ok).map((c) => c.name).join('; ')}`);
      console.error(`  FAIL ${manifest.id}@${manifest.version} — see ${reportPath}`);
      continue;
    }

    const archive = packPackage(dir, { reportPath });
    const out = join(LIBRARY, `${manifest.id}-${manifest.version}.tar.gz`);
    writeFileSync(out, archive);
    packed.push(out);
    console.log(`  shelved ${manifest.id}@${manifest.version} -> ${out} (${archive.length} bytes, root ${root.slice(0, 12)})`);
  }

  /**
   * Prune a **superseded** version — `contact-1.2.0` beside `contact-1.3.0` is the drift that made
   * the shelf lie. The rule is deliberately narrow: only for an id this run actually packed. The
   * first version of this script pruned anything it had not just written, so a run where every
   * package failed its smoke check emptied the whole shelf — deleting the very thing it maintains.
   */
  const packedIds = new Set(packed.map((p) => p.split('/').pop()!.replace(/-\d+\.\d+\.\d+\.tar\.gz$/, '')));
  for (const existing of readdirSync(LIBRARY)) {
    if (!existing.endsWith('.tar.gz')) continue;
    if (packed.some((p) => p.endsWith(`/${existing}`))) continue;
    const id = existing.replace(/-\d+\.\d+\.\d+\.tar\.gz$/, '');
    if (!packedIds.has(id)) {
      console.log(`  kept ${existing} (its package did not pack this run — never prune on a failure)`);
      continue;
    }
    rmSync(join(LIBRARY, existing));
    console.log(`  pruned superseded ${existing}`);
  }

  console.log(`\nlibrary: ${LIBRARY} (${packed.length} package(s))`);
  if (failures.length > 0) {
    console.error(`refused ${failures.length} package(s):`);
    for (const f of failures) console.error(`  - ${f}`);
    return 1;
  }
  return 0;
}

process.exit(await main());
