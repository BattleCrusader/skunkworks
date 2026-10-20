/**
 * S3d mutation controls — a test that cannot fail is a comment.
 *
 * Each mutation is applied to the source, the owning gate is run, and the file is
 * restored from the bytes that were read. The script asserts every file is
 * **byte-identical** afterwards, so a mutation that "did not apply" cannot masquerade
 * as a passing control.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

interface Mutation {
  name: string;
  file: string;
  from: string;
  to: string;
  tests: string[];
  expect: string;
}

const MUTATIONS: Mutation[] = [
  {
    name: 'M1 — the hand-off is the store blob even when a render exists',
    file: 'app/download/plane.ts',
    from: "const uri = handOff?.uri ?? `/__protected/${asset.storage_path.slice('content/media/'.length)}`;",
    to: "const uri = `/__protected/${asset.storage_path.slice('content/media/'.length)}`;",
    tests: ['test/download-watermark.test.ts'],
    expect: 'W3',
  },
  {
    name: 'M2 — the spec hash covers the asset, not the buyer',
    file: 'app/download/watermark.ts',
    from: 'return createHash(\'sha256\').update(`wm-spec-v1\\u0000${canonicalJson(spec)}`).digest(\'hex\');',
    to: 'return createHash(\'sha256\').update(`wm-spec-v1\\u0000${spec.source}`).digest(\'hex\');',
    tests: ['test/download-watermark.test.ts'],
    expect: 'W1',
  },
  {
    name: 'M3 — a stampable asset silently falls back to the media tree',
    file: 'app/download/plane.ts',
    from: 'if (stampable(asset) !== null) {',
    to: 'if (stampable(asset) !== null && false) {',
    tests: ['test/download-watermark.test.ts'],
    expect: 'W4',
  },
  {
    name: 'M4 — the sweep deletes the row but leaves the file',
    file: 'app/download/render.ts',
    from: '        unlinkSync(absOf(this.#contentRoot, row.path));\n        files += 1;',
    to: '        files += 0;',
    tests: ['test/download-watermark.test.ts'],
    expect: 'W7',
  },
];

function digest(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

let failures = 0;
for (const m of MUTATIONS) {
  const before = digest(m.file);
  const source = readFileSync(m.file, 'utf8');
  if (!source.includes(m.from)) {
    process.stdout.write(`SKIP ${m.name}: anchor not found in ${m.file}\n`);
    failures += 1;
    continue;
  }
  writeFileSync(m.file, source.replace(m.from, m.to));
  try {
    const run = spawnSync('node', ['scripts/run-node-tests.mjs', '--timeout=120000', ...m.tests], {
      encoding: 'utf8',
    });
    const out = `${run.stdout}${run.stderr}`;
    const red = /^not ok \d+ - /m.test(out);
    const named = out.includes(`not ok`) && out.split('\n').some((l) => l.startsWith('not ok') && l.includes(m.expect));
    const ok = run.status !== 0 && red && named;
    if (!ok) failures += 1;
    process.stdout.write(`${ok ? 'RED ' : 'GREEN'} ${m.name} -> ${m.expect} ${ok ? 'reddened' : 'DID NOT REDDEN'}\n`);
    for (const line of out.split('\n').filter((l) => l.startsWith('not ok '))) {
      process.stdout.write(`      ${line}\n`);
    }
  } finally {
    writeFileSync(m.file, source);
  }
  const after = digest(m.file);
  if (after !== before) {
    failures += 1;
    process.stdout.write(`FILE CHANGED ${m.file}: ${before} -> ${after}\n`);
  }
}

process.stdout.write(
  failures === 0
    ? `\n${MUTATIONS.length} mutations, every owning gate reddened, every file byte-identical\n`
    : `\n${failures} control(s) failed\n`,
);
process.exit(failures === 0 ? 0 : 1);
