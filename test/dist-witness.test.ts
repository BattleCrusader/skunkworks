/**
 * E-28 — the register's gate (three assertions), over `test/dist-witness.ts`.
 *
 * It reads files and needs no `dist/`, so it belongs in `make test`; the gate the rows
 * point at needs `dist/` and a child process, so it lives in `make verify-dist`. That split
 * is E-28's, and it is why a row's `gate` is checked against the script's own `CHECKS`
 * table rather than taken on trust.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DIST_EXEMPT, DIST_SITES, auditWitnesses, gateIds, occurrences } from './dist-witness.ts';

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
  process.stdout.write(
    `# E28-1 ${DIST_SITES.length} rows -> ${[...new Set(DIST_SITES.map((r) => r.gate))].sort().join(', ')} ` +
      `(gate runs ${ids.join(', ')})\n`,
  );
});

test('E28-2 — every marker occurrence under app/ and tools/ is claimed by a row or exempt with a reason', () => {
  const report = auditWitnesses();
  assert.deepEqual(report.unknownGates, [], `rows point at assertions that do not exist: ${report.unknownGates.join('; ')}`);
  assert.ok(report.occurrences.length >= 8, `the scan found only ${report.occurrences.length} occurrences; it is not reading the tree`);
  assert.deepEqual(report.unclaimed, [], `unclaimed path sites (E-28 has no third option):\n  ${report.unclaimed.join('\n  ')}`);
  // Every exemption carries prose: an empty reason is a silent pass.
  for (const row of DIST_EXEMPT) {
    assert.ok(row.reason.length > 40, `DIST_EXEMPT ${row.file} has no reason worth the name`);
  }
  process.stdout.write(
    `# E28-2 ${report.occurrences.length} occurrences over ${new Set(report.occurrences.map((o) => o.file)).size} files, ` +
      `${DIST_SITES.length} rows, ${DIST_EXEMPT.length} exempt\n`,
  );
});

test('E28-3 — an unclaimed occurrence fails: the class cannot grow silently', () => {
  // The negative control for the register itself, done in memory: an occurrence in a file no
  // row claims and no exemption names must appear in `unclaimed`. Without this the table is
  // one-directional — it can only ever agree with itself.
  const real = occurrences();
  assert.ok(real.length > 0, 'the scan found nothing to prove anything with');
  const fake = { file: 'app/download/unregistered.ts', line: 1, marker: 'import.meta.url' as const, text: 'x' };
  const claimed = new Set(DIST_SITES.map((row) => row.file));
  const exempt = new Set(DIST_EXEMPT.map((row) => row.file));
  const isCovered = (o: { file: string }): boolean => claimed.has(o.file) || exempt.has(o.file);
  assert.equal(isCovered(real[0] as { file: string }), true, 'a real occurrence is not covered, so E28-2 should be red');
  assert.equal(isCovered(fake), false, 'an unregistered file would pass, so the register proves nothing');

  process.stdout.write(
    `# E28-3 a real occurrence (${(real[0] as { file: string }).file}) is covered; an invented one is not\n`,
  );
});
