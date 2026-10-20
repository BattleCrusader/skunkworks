/**
 * E-22 / SDS §13.1a rule 2 — the witness table.
 *
 * "The mechanism names its witness. The source comment above the mechanism carries the test's file
 * and its exact name, e.g. `Exclusive witness: test/sources.test.ts S2E-11`. A comment that names a
 * test which has been renamed is a lie the build cannot see, so this file holds one table of
 * `mechanism → {file, test name}`: it asserts that the named test exists in the named file **and**
 * that the mechanism's comment contains the name. Adding a security mechanism without a row there
 * fails the suite."
 *
 * Three assertions, and they are bidirectional on purpose:
 *
 *   1. every row's named test exists in the named file;
 *   2. every row's `source` file contains an `Exclusive witness:` line naming that file and those tests;
 *   3. every `Exclusive witness:` line found anywhere in `app/` is covered by a row — so a new
 *      mechanism that declares a witness it has not registered fails here, which is the half a
 *      one-directional table could not see.
 *
 * The negative control is `S2E-11`: rename it in `test/sources.test.ts` and assertion 1 goes red
 * without a line of `plan.ts` changing. That is the check that this link is enforced, not decorative.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';

import { REPO } from './helpers/fixture.ts';

interface Witness {
  /** The mechanism as the source names it. */
  mechanism: string;
  /** The file the mechanism lives in — `Exclusive witness:` must be inside it. */
  source: string;
  /** The test file that witnesses it. */
  file: string;
  /** The exact test name(s). One mechanism may need two cases (a pass and a refusal). */
  tests: string[];
  /** What the mechanism refuses, for a reader of this table. */
  refuses: string;
}

/**
 * Seeded from the mechanisms that exist today (§13.1a). `previewTokenStatus` in the errata's
 * example is `verifyPreviewToken` in this tree; the name here is the one the source carries.
 */
export const WITNESSES: readonly Witness[] = [
  {
    mechanism: 'refusePlan',
    source: 'app/sources/plan.ts',
    file: 'test/sources.test.ts',
    tests: ['S2E-11'],
    refuses: 'a plan carrying SCAN when every referenced column is indexed',
  },
  {
    mechanism: 'assertIndexedColumns',
    source: 'app/sources/plan.ts',
    file: 'test/sources.test.ts',
    tests: ['S2E-1'],
    refuses: 'a where/order/group_by column no index can start from',
  },
  {
    mechanism: 'verifyAgainstSeal',
    source: 'app/audit/chain.ts',
    file: 'test/audit-seal.test.ts',
    tests: ['B1-1', 'B1-3'],
    refuses: 'a segment that does not reproduce its anchor, links, count or head — and passes a grown chain',
  },
  {
    mechanism: 'writeSeal',
    source: 'app/audit/chain.ts',
    file: 'test/audit-seal.test.ts',
    tests: ['B1-6'],
    refuses: 'a second seal of a day, in the app and in the database',
  },
  {
    mechanism: 'isPublic',
    source: 'app/sources/resolve.ts',
    file: 'test/sources.test.ts',
    tests: ['S2E-4'],
    refuses: 'a render of a source that is not public',
  },
  {
    mechanism: 'verifyPreviewToken',
    source: 'app/render/preview.ts',
    file: 'test/preview.test.ts',
    tests: ['S2E-12'],
    refuses: 'a preview token for a published page, an expired one, or one for another path',
  },
  {
    mechanism: 'assertViewChecksum',
    source: 'app/sources/registry.ts',
    file: 'test/sources.test.ts',
    tests: ['V1-1'],
    refuses: 'a view whose definition is not the one the source was published against',
  },
  // §7.4 / C-7 (S3c) — the money plane. Four mechanisms, each with the gate that would
  // notice if it were removed, and each proven to fail under mutation in
  // `scratch/s3c/mutations.ts`.
  {
    mechanism: 'consumeUse',
    source: 'app/download/ledger.ts',
    file: 'test/download-consume.test.ts',
    tests: ['C1', 'C3'],
    refuses: 'a second use for one jti under eight concurrent processes, and a spend past max_uses',
  },
  {
    mechanism: 'verifyToken',
    source: 'app/download/token.ts',
    file: 'test/download-redeem.test.ts',
    tests: ['R5', 'R5b', 'R13', 'R14'],
    refuses:
      'a MAC that is not 32 bytes (401, never 500), a token for another client or asset, a token past cexp, and a mint inside the grace window that would spend a second use',
  },
  {
    mechanism: 'redeem',
    source: 'app/download/plane.ts',
    file: 'test/perf/download-timing.perf.test.ts',
    tests: ['P-S3c-1'],
    refuses: 'an unknown selector that is faster than a wrong secret — the oracle the dummy verify closes',
  },
  {
    mechanism: 'assertGateable',
    source: 'app/download/code.ts',
    file: 'test/download-codes.test.ts',
    tests: ['I4'],
    refuses: 'a code for an encrypted PDF (by flag or by trailer) and for an asset with a public URL',
  },
  // §7.5 / C-16 (S3d) — the watermark. Three mechanisms: the key that makes a render
  // per-purchaser, the transient that bounds it, and the character set that stops a name
  // from becoming a denial.
  {
    mechanism: 'specSha',
    source: 'app/download/watermark.ts',
    file: 'test/download-watermark.test.ts',
    tests: ['W1', 'W8'],
    refuses: 'two purchasers of one asset sharing a render — the hash covers the resolved text, not the asset',
  },
  {
    mechanism: 'WatermarkStore.ensure',
    source: 'app/download/render.ts',
    file: 'test/download-watermark.test.ts',
    tests: ['W2', 'W6', 'W6b', 'W7', 'W13', 'W14'],
    refuses:
      'a second row for one spec, a stamp above the tenant cap or above the box cap, a hand-off of a file the sweep deleted, a request still queued at the deadline, and a render that outlives cexp + grace',
  },
  {
    mechanism: 'sanitiseCp1252',
    source: 'app/download/cp1252.ts',
    file: 'test/download-watermark.test.ts',
    tests: ['W9'],
    refuses: 'a character a WinAnsi font cannot draw — preserved when cp1252 has it, transliterated next, `?` last',
  },
];

const WITNESS_LINE = /Exclusive witness: (\S+) ([A-Za-z0-9][A-Za-z0-9-]*(?:, ?[A-Za-z0-9][A-Za-z0-9-]*)*)/;

function read(rel: string): string {
  return readFileSync(join(REPO, rel), 'utf8');
}

/** Every `.ts` file under `app/`, so a new mechanism cannot hide in a subdirectory. */
function appFiles(dir = join(REPO, 'app')): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...appFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

test('W1. every mechanism in the table names a test that exists in the file it names', () => {
  for (const witness of WITNESSES) {
    const text = read(witness.file);
    for (const name of witness.tests) {
      assert.ok(
        text.includes(`test('${name}.`) || text.includes(`test("${name}.`),
        `${witness.mechanism}: ${witness.file} has no test named ${name}`,
      );
    }
  }
});

test('W2. every mechanism carries a comment naming its witness, with the file and the exact test name', () => {
  for (const witness of WITNESSES) {
    const text = read(witness.source);
    const expected = `Exclusive witness: ${witness.file} ${witness.tests.join(', ')}`;
    assert.ok(text.includes(expected), `${witness.mechanism}: ${witness.source} does not contain "${expected}"`);
  }
});

test('W3. every `Exclusive witness:` comment in app/ is registered here — a new mechanism cannot skip the table', () => {
  const registered = new Map<string, Witness>();
  for (const witness of WITNESSES) registered.set(`${witness.source}\u0000${witness.file}\u0000${witness.tests.join(',')}`, witness);

  const found: string[] = [];
  for (const path of appFiles()) {
    const rel = relative(REPO, path).split('\\').join('/');
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const m = WITNESS_LINE.exec(line);
      if (m === null) continue;
      const file = m[1] as string;
      const names = (m[2] as string).split(',').map((n) => n.trim());
      found.push(`${rel} -> ${file} ${names.join(', ')}`);
      const witness = registered.get(`${rel}\u0000${file}\u0000${names.join(',')}`);
      assert.ok(
        witness !== undefined,
        `${rel} declares a witness for ${file} ${names.join(', ')} that is not in WITNESSES`,
      );
      // And the test it names must exist, so the comment cannot point at a renamed case.
      const testText = read(file);
      for (const name of names) {
        assert.ok(
          testText.includes(`test('${name}.`) || testText.includes(`test("${name}.`),
          `${rel}: the comment names ${name}, which ${file} does not contain`,
        );
      }
    }
  }
  assert.ok(found.length >= WITNESSES.length, `the tree declares ${found.length} witnesses, the table has ${WITNESSES.length}`);
});

test('W4. the table covers every mechanism §16 S2 names as a security control', () => {
  // §16 S2's security rows, by the mechanism that enforces them: a row that disappears here is a
  // control that lost its witness, not a tidy-up.
  const required = [
    'refusePlan',
    'assertIndexedColumns',
    'verifyAgainstSeal',
    'writeSeal',
    'isPublic',
    'verifyPreviewToken',
    'assertViewChecksum',
  ];
  const have = new Set(WITNESSES.map((w) => w.mechanism));
  for (const mechanism of required) assert.ok(have.has(mechanism), `${mechanism} has no witness row`);
});

test('W5. no row repeats a mechanism, and every row explains what it refuses', () => {
  const seen = new Set<string>();
  for (const witness of WITNESSES) {
    assert.ok(!seen.has(witness.mechanism), `${witness.mechanism} is listed twice`);
    seen.add(witness.mechanism);
    assert.ok(witness.refuses.length > 20, `${witness.mechanism}: the row does not say what it refuses`);
    assert.match(witness.source, /^app\//);
    assert.match(witness.file, /^test\/.*\.test\.ts$/);
  }
});
