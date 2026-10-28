/** The job board package, driven through the real manifest validator and root hasher. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { packageRootHash, readManifest } from '../app/plugins/manifest.ts';

const DIR = join(process.cwd(), 'plugins', 'jobboard');

test('J1. the job board manifest validates and declares its three tables', () => {
  const manifest = readManifest(DIR);
  assert.equal(manifest.id, 'jobboard');
  const tables = (manifest.tables ?? []).map((t: { name: string }) => t.name).sort();
  assert.deepEqual(tables, ['p_jobboard_application', 'p_jobboard_company', 'p_jobboard_job']);
});

test('J2. its root hash is stable across two reads', () => {
  const a = packageRootHash(DIR).root;
  const b = packageRootHash(DIR).root;
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
});
