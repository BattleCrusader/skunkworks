/**
 * ITEM 0, in-suite half: the audit is a **pure function over docker's own output**, so
 * its negative control costs a millisecond and runs in every `make test`.
 *
 * The real gate is `scripts/leak-gate.mjs` (a Makefile target that runs after the node
 * suite, because a file that leaks is a file that finished). These cases prove the part
 * that gate depends on: the matcher sees what it is given, including a name it was just
 * told about, and does not see unrelated resources. The script's own negative control —
 * create a container, skip the teardown, require red — is executed by
 * `make verify-no-leak` and transcribed in `docs/build/S4a-report.md` §1.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { findLeaks } from './helpers/docker.ts';

test('L1 — the audit names every skw-* container and network, and nothing else', () => {
  const ps = [
    'skw-nginx-e2e-4412',
    'skw-nginx-gated-4412',
    'postgres-main',
    'skw-onboarding-99',
    '',
  ].join('\n');
  const nets = ['bridge', 'skw-gated_default', 'host', 'skunkworks_default', ''].join('\n');
  const found = findLeaks(ps, nets);
  assert.deepEqual(found.containers, [
    'skw-nginx-e2e-4412',
    'skw-nginx-gated-4412',
    'skw-onboarding-99',
  ]);
  assert.deepEqual(found.networks, ['skw-gated_default']);
});

test('L2 — the negative control: a container whose teardown was skipped is reported', () => {
  // The exact shape of the leak ITEM 0 describes: five containers and one network
  // survived because `after()` never learned their names.
  const ps = [
    'skw-nginx-e2e-1001',
    'skw-nginx-e2e-allow-1001',
    'skw-nginx-e2e-deny-1001',
    'skw-nginx-gated-1001',
    'skw-nginx-media-1001',
    'skw-onboarding-1001',
  ].join('\n');
  const found = findLeaks(ps, 'skw-gated_default\n');
  assert.equal(found.containers.length, 6);
  assert.equal(found.networks.length, 1);
  // …and the audit is red exactly when the counts are non-zero, which is the
  // condition scripts/leak-gate.mjs exits on.
  assert.ok(found.containers.length + found.networks.length > 0);
});

test('L3 — a clean daemon reports zero, so the gate can be green without being blind', () => {
  const found = findLeaks('skw-nginx-e2e-1\n', '');
  assert.equal(found.containers.length + found.networks.length, 1);
  const clean = findLeaks('\n', '\n');
  assert.deepEqual(clean, { containers: [], networks: [] });
  // The prefix is a parameter, not a literal buried in the matcher: `skunkworks_*`
  // (a compose project name) would otherwise be invisible to a `skw-` audit.
  assert.deepEqual(findLeaks('skunkworks_default', 'skunkworks_default', 'skunkworks_').containers, [
    'skunkworks_default',
  ]);
});
