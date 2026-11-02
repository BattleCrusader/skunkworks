/**
 * The zip writer, read back by the zip reader.
 *
 * A writer tested only against itself proves nothing, so every case here round-trips through
 * `readZip` — the same reader that accepts a person's uploaded theme package. The determinism case
 * is the one the export path depends on: one clock, same bytes, or a bundle's sha stops being a
 * receipt.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readZip } from '../app/render/zip.ts';
import { archiveName, writeZip } from '../app/export/zip-write.ts';

const NOW = '2026-10-29T00:00:00.000Z';

test('Z1 — files round-trip through the product reader, stored and deflated', () => {
  const small = Buffer.from('tiny', 'utf8');
  const large = Buffer.from('x'.repeat(4096), 'utf8');
  const zip = writeZip(
    [
      { path: 'a.txt', bytes: small },
      { path: 'nested/b big.bin', bytes: large },
    ],
    NOW,
  );
  const entries = readZip(zip);
  assert.deepEqual(
    entries.map((entry) => entry.path),
    ['a.txt', 'nested/b big.bin'],
  );
  assert.deepEqual(entries[0]?.bytes, small);
  assert.deepEqual(entries[1]?.bytes, large);
});

test('Z2 — a symlink is stored the unix way, and the theme reader refuses it by name', () => {
  const zip = writeZip(
    [
      { path: 'content/public/hero.svg', symlink: '../media/ab/abcdef.svg' },
      { path: 'install.sh', bytes: Buffer.from('#!/bin/sh\n'), mode: 0o755 },
    ],
    NOW,
  );

  // A site bundle legitimately carries the farm's relative links, so the writer must produce them.
  const central = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  assert.ok(central > 0, 'no central directory');
  const external = zip.readUInt32LE(central + 38);
  assert.equal((external >>> 16) & 0o170000, 0o120000, 'the first entry is not marked as a symlink');

  const second = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), central + 4);
  const scriptMode = (zip.readUInt32LE(second + 38) >>> 16) & 0o777;
  assert.equal(scriptMode, 0o755, 'install.sh must keep its executable bit');

  // …and a *theme* package may not carry one, which is the reader's rule and stays its rule.
  assert.throws(() => readZip(zip), /cannot carry one/);
});

test('Z3 — one clock, one byte string: the archive is deterministic', () => {
  const entries = [
    { path: 'B.txt', bytes: Buffer.from('second') },
    { path: 'a.txt', bytes: Buffer.from('first') },
  ];
  const one = writeZip(entries, NOW);
  const two = writeZip(entries, NOW);
  assert.deepEqual(one, two);
  const later = writeZip(entries, '2026-10-30T00:00:00.000Z');
  assert.notDeepEqual(one, later, 'a different clock must produce different bytes');
});

test('Z4 — a path that climbs out, or an entry with both bytes and a target, is refused', () => {
  assert.throws(() => writeZip([{ path: '../escape.txt', bytes: Buffer.from('x') }], NOW), /must be relative/);
  assert.throws(() => writeZip([{ path: '/abs.txt', bytes: Buffer.from('x') }], NOW), /must be relative/);
  assert.throws(
    () => writeZip([{ path: 'both.txt', bytes: Buffer.from('x'), symlink: 'y' }], NOW),
    /either bytes or a symlink/,
  );
  assert.throws(() => writeZip([{ path: 'neither.txt' }], NOW), /either bytes or a symlink/);
});

test('Z5 — the download name is a slug plus the day', () => {
  assert.equal(archiveName('Fractional Works', NOW), 'fractional-works-2026-10-29.zip');
  assert.equal(archiveName('  ', NOW), 'site-2026-10-29.zip');
  assert.equal(archiveName('a/b c', NOW), 'a-b-c-2026-10-29.zip');
});
