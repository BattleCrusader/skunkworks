/**
 * S3b — the mutation controls. A test that cannot fail is a comment, so each of the three
 * mechanisms this slice added is removed once and the gate that owns it is run:
 *
 *   M1  publish's D31 refusal  -> `D31-1` must redden, `D31-2` must stay green
 *   M2  compile's D31 clamp    -> `D31-2` and `D31-3` must redden, `D31-1` must stay green
 *   M3  the farm's gated branch-> `F2` must redden (and `N2`, the same rule at the edge)
 *
 * Every file is restored in a `finally`, and each file's sha256 is printed before and after so
 * "restored" is a fact rather than an intention. Nothing here is committed; it is a proof run.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const REPO = process.cwd();

function sha(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 12);
}

interface Mutation {
  name: string;
  file: string;
  from: string;
  to: string;
  tests: { file: string; pattern: string }[];
  expectFail: string;
}

const MUTATIONS: Mutation[] = [
  {
    name: 'M1 — publish stops refusing limit_default > limit_max',
    file: join(REPO, 'app/sources/publish.ts'),
    from: "{ defaultAboveMax: 'refuse' }",
    to: "{ defaultAboveMax: 'clamp' }",
    tests: [{ file: 'test/d31-limit.test.ts', pattern: '.' }],
    expectFail: 'D31-1',
  },
  {
    name: 'M2 — the render parse stops clamping (D31-2 owns this clamp)',
    file: join(REPO, 'app/sources/resolve.ts'),
    from: "defaultAboveMax: 'clamp',",
    to: "defaultAboveMax: 'refuse',",
    tests: [{ file: 'test/d31-limit.test.ts', pattern: '.' }],
    expectFail: 'D31-2',
  },
  {
    name: 'M2b — compile stops clamping a hand-built spec (D31-3 owns this one)',
    file: join(REPO, 'app/sources/compile.ts'),
    from: 'let limit = Math.min(spec.limitDefault, spec.limitMax);',
    to: 'let limit = spec.limitDefault;',
    tests: [{ file: 'test/d31-limit.test.ts', pattern: '.' }],
    expectFail: 'D31-3',
  },
  {
    // The control for the `tree()` change in test/assets.test.ts: excluding symlinks must not
    // stop A1 noticing a *second byte*. `putBytes` writes one spare file next to the blob.
    name: 'M4 — putBytes writes a second real file (A1 must still notice)',
    file: join(REPO, 'app/assets/store.ts'),
    from: '    linkSync(tmp, absPath);',
    to: "    linkSync(tmp, absPath);\n    writeFileSync(join(dirname(absPath), 'second-byte.bin'), Buffer.from('x'));",
    tests: [{ file: 'test/assets.test.ts', pattern: 'A1' }],
    expectFail: 'A1',
  },
  {
    name: 'M3 — the farm links a gated asset',
    file: join(REPO, 'app/assets/farm.ts'),
    from: "if (row.access_class === 'gated') {",
    to: "if (false as boolean) {",
    tests: [
      { file: 'test/farm.test.ts', pattern: 'F2' },
      { file: 'test/nginx-media-e2e.test.ts', pattern: 'N2' },
    ],
    expectFail: 'F2',
  },
];

const results: string[] = [];
for (const mutation of MUTATIONS) {
  const original = readFileSync(mutation.file, 'utf8');
  const before = sha(mutation.file);
  if (!original.includes(mutation.from)) {
    results.push(`${mutation.name}: SKIPPED — the mutation target is not in ${mutation.file}`);
    continue;
  }
  try {
    writeFileSync(mutation.file, original.replace(mutation.from, mutation.to));
    for (const target of mutation.tests) {
      const run = spawnSync(
        process.execPath,
        ['--test', '--test-concurrency=1', '--test-timeout=180000', `--test-name-pattern=${target.pattern}`, target.file],
        { encoding: 'utf8' },
      );
      const failed = (run.stdout.match(/^not ok \d+ - (.+)$/gm) ?? []).map((line) => line.replace(/^not ok \d+ - /, ''));
      const passed = (run.stdout.match(/^ok \d+ - (.+)$/gm) ?? []).length;
      results.push(
        `${mutation.name} -> ${target.file} (${target.pattern}): exit=${run.status} passed=${passed} failed=[${failed.join(' | ')}]`,
      );
      if (target.pattern === '.' && failed.length === 0 && run.status !== 0) {
        results.push(`  (file-level failure with no test named: ${run.stdout.split('\n').filter((l) => l.startsWith('not ok')).join(' | ')})`);
      }
    }
  } finally {
    writeFileSync(mutation.file, original);
  }
  const after = sha(mutation.file);
  results.push(`${mutation.name}: file restored ${before === after ? 'IDENTICAL' : `CHANGED (${before} -> ${after})`}`);
}

process.stdout.write(`${results.join('\n')}\n`);
