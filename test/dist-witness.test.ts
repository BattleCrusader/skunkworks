/**
 * E-28 — the register's gate (three assertions), over `test/dist-witness.ts`.
 *
 * It reads files and needs no `dist/`, so it belongs in `make test`; the gate the rows
 * point at needs `dist/` and a child process, so it lives in `make verify-dist`. That split
 * is E-28's, and it is why a row's `gate` is checked against the script's own `CHECKS`
 * table rather than taken on trust.
 *
 * **Round 2 (S3R2-1): the claim is per occurrence, not per file.** The first version of
 * this file built `claimed` as a set of *files*, so a ninth runtime-path site appended to
 * `app/main.ts` — a file three rows already listed — was invisible: 15 occurrences behind
 * 8 rows, E28-1/2/3 all green. `E28-3` below is the regression: the same mutation, in
 * memory, must name the file, the line and the site.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DIST_EXEMPT,
  DIST_SITES,
  auditOccurrences,
  auditWitnesses,
  gateIds,
  occurrences,
  type Occurrence,
} from './dist-witness.ts';

test('E28-1 — every register row names a D-assertion scripts/dist-gate.mjs actually runs', () => {
  const ids = gateIds();
  assert.ok(ids.length >= 6, `the gate runs only ${ids.length} assertions: ${ids.join(', ')}`);
  // D1..D6 are E-28's six; the register may name only these.
  for (const id of ['D1', 'D2', 'D3', 'D4', 'D5', 'D6']) {
    assert.ok(ids.includes(id), `scripts/dist-gate.mjs no longer runs ${id}`);
  }
  for (const row of DIST_SITES) {
    assert.ok(ids.includes(row.gate), `register row "${row.site}" names ${row.gate}, which the gate does not run`);
  }
  assert.equal(new Set(DIST_SITES.map((r) => r.gate)).size >= 5, true, 'the rows are not spread over the assertions');
  // A register of rows that claim no occurrence would pass E28-2 vacuously.
  const anchored = DIST_SITES.filter((r) => r.anchors.length > 0);
  assert.ok(
    anchored.length >= 5,
    `only ${anchored.length} rows claim an occurrence; the register has become prose`,
  );
  process.stdout.write(
    `# E28-1 ${DIST_SITES.length} rows (${anchored.length} anchored) -> ` +
      `${[...new Set(DIST_SITES.map((r) => r.gate))].sort().join(', ')} (gate runs ${ids.join(', ')})\n`,
  );
});

test('E28-2 — every occurrence under app/ and tools/ is claimed by exactly one row anchor, and the counts agree per file', () => {
  const report = auditWitnesses();
  assert.deepEqual(report.unknownGates, [], `rows point at assertions that do not exist: ${report.unknownGates.join('; ')}`);
  assert.ok(
    report.occurrences.length >= 14,
    `the scan found only ${report.occurrences.length} occurrences; it is not reading the tree`,
  );
  // A row whose anchor no longer matches one line in its file is a stale claim: the code
  // moved and the row has not followed it. An anchor matching two is a claim that cannot
  // say which site it proves.
  assert.deepEqual(report.claimErrors, [], `stale or ambiguous claims:\n  ${report.claimErrors.join('\n  ')}`);
  assert.deepEqual(report.unclaimed, [], `unclaimed path sites (E-28 has no third option):\n  ${report.unclaimed.join('\n  ')}`);

  // The count is the assertion, per file: what the rows claim must equal what is there.
  for (const f of report.files) {
    if (f.exempt) {
      assert.equal(
        f.claimed,
        f.found,
        `${f.file} is exempt for ${f.claimed} occurrence(s) but holds ${f.found}; the exemption's count is stale`,
      );
    } else {
      assert.equal(f.claimed, f.found, `${f.file}: rows claim ${f.claimed} of ${f.found} occurrences`);
    }
  }
  assert.equal(
    report.files.reduce((n, f) => n + f.claimed, 0),
    report.occurrences.length,
    'the per-file claims do not add up to the scan',
  );

  // Every exemption carries prose: an empty reason is a silent pass.
  for (const row of DIST_EXEMPT) {
    assert.ok(row.reason.length > 40, `DIST_EXEMPT ${row.file} has no reason worth the name`);
  }
  const exempt = report.files.filter((f) => f.exempt);
  process.stdout.write(
    `# E28-2 ${report.occurrences.length} occurrences over ${new Set(report.occurrences.map((o) => o.file)).size} files, ` +
      `claimed ${report.files.reduce((n, f) => n + f.claimed, 0)}/${report.occurrences.length}, ` +
      `${DIST_SITES.length} rows, ${DIST_EXEMPT.length} exempt ` +
      `(${exempt.map((f) => `${f.file} ${f.found}`).join(', ') || 'none'})\n`,
  );
});

test('E28-3 — a new site in a file the register already lists is unclaimed: the claim is per occurrence', () => {
  // The negative control for the register itself, done in memory so it runs in every gate.
  const real = occurrences();
  assert.ok(real.length > 0, 'the scan found nothing to prove anything with');
  assert.deepEqual(auditOccurrences(real).unclaimed, [], 'the real tree is unclaimed, so this control proves nothing');

  // S3R2-1's mutation: a ninth runtime-path site appended to `app/main.ts`, which three rows
  // already list. The file-scoped register answered green at 15 occurrences; this must not.
  const ninth: Occurrence = {
    file: 'app/main.ts',
    line: 999,
    marker: 'process.cwd()',
    text: "const scratch = join(process.cwd(), 'scratch');",
  };
  const red = auditOccurrences([...real, ninth]);
  assert.equal(red.unclaimed.length, 1, `a ninth site in app/main.ts was not refused: ${JSON.stringify(red.unclaimed)}`);
  assert.match(red.unclaimed[0] as string, /^app\/main\.ts:999 process\.cwd\(\) — /);
  assert.ok((red.unclaimed[0] as string).includes("join(process.cwd(), 'scratch')"), 'the refusal must quote the site');
  const main = red.files.find((f) => f.file === 'app/main.ts');
  assert.equal(main?.found, 4, 'the file grew');
  assert.equal(main?.claimed, 3, 'the rows did not');
  assert.deepEqual(
    auditOccurrences([...real, ninth]).claimErrors,
    [],
    'a new site is an unclaimed occurrence, not a stale row',
  );

  // A file with no row at all is still refused, as it always was.
  const stranger: Occurrence = { file: 'app/download/unregistered.ts', line: 1, marker: 'import.meta.url', text: 'x' };
  const unknown = auditOccurrences([...real, stranger]);
  assert.equal(unknown.unclaimed.length, 1);
  assert.match(unknown.unclaimed[0] as string, /^app\/download\/unregistered\.ts:1 import\.meta\.url — /);

  // And a second site whose line looks exactly like one a row already claims cannot be
  // absorbed by that row's anchor: the anchor must name one line, so it names none.
  const twin: Occurrence = {
    file: 'app/main.ts',
    line: 998,
    marker: 'import.meta.url',
    text: 'const schemaDir = opts.schemaDir ?? schemaDirFrom(import.meta.url);',
  };
  const ambiguous = auditOccurrences([...real, twin]);
  assert.equal(ambiguous.claimErrors.length, 1, `a duplicated line was absorbed: ${JSON.stringify(ambiguous.claimErrors)}`);
  assert.ok(
    (ambiguous.claimErrors[0] as string).includes('schemaDirFrom(import.meta.url)'),
    'the refusal must name the anchor',
  );
  assert.ok((ambiguous.claimErrors[0] as string).includes('app/main.ts:998'), 'the refusal must name the newcomer');

  process.stdout.write(
    `# E28-3 +1 site in app/main.ts -> unclaimed "${red.unclaimed[0] as string}"; ` +
      `+1 duplicate line -> claimErrors ${ambiguous.claimErrors.length}\n`,
  );
});
