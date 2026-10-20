/**
 * A concurrent reader of the farm, for the rename-atomicity gate.
 *
 * The rename is synchronous JavaScript, so a sampler inside the same process can never run while
 * it is in progress — it would always report "one sample", which is the measurement equivalent of
 * not testing anything. This is a second process reading both names continuously while the parent
 * renames.
 *
 * **It speaks; it is not timed.** The first version sampled for a fixed window and the parent
 * slept 120 ms before renaming, so `sawOld > 0` depended on this process finishing its boot
 * inside that sleep — the same luck that failed N3 at load 22–34. It now reports events, and
 * `renameAsset` parks inside the window (`SKW_RENAME_WINDOW_HOLD`, see `app/assets/library.ts`)
 * until the release below:
 *
 *   {"event":"ready"}    the old name resolved. The parent may start the rename.
 *   {"event":"release"}  the parent may leave the window: either `windowSamples` rounds saw both
 *                        names resolve, or one saw **neither** (a violation — release anyway so
 *                        the gate reports `dead > 0` instead of hitting the barrier deadline).
 *   {"event":"done"}     final counts; `dead` is the number of rounds where neither resolved.
 *
 * Usage: node farm-sampler.mjs <publicDir> <oldName> <newName> <maxMs> [holdDir]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [, , dir, oldName, newName, msArg, holdDir] = process.argv;
if (dir === undefined || oldName === undefined || newName === undefined) {
  process.stderr.write('usage: farm-sampler.mjs <publicDir> <oldName> <newName> <maxMs> [holdDir]\n');
  process.exit(2);
}
const maxMs = Number(msArg ?? '400');
const WINDOW_ROUNDS = 3;

const resolves = (name) => {
  try {
    readFileSync(join(dir, name));
    return true;
  } catch {
    return false;
  }
};

let samples = 0;
let dead = 0;
let sawOld = 0;
let sawNew = 0;
let windowSamples = 0;
let readySent = false;
let released = false;
let releaseReason = holdDir === undefined ? 'no-hold' : 'timeout';
const end = Date.now() + maxMs;

function release(reason) {
  if (released) return;
  released = true;
  releaseReason = reason;
  if (holdDir !== undefined) writeFileSync(join(holdDir, 'window-release'), `${reason}\n`);
  process.stdout.write(`${JSON.stringify({ event: 'release', reason, windowSamples, dead })}\n`);
}

while (Date.now() < end) {
  const old = resolves(oldName);
  const next = resolves(newName);
  samples += 1;
  if (old) sawOld += 1;
  if (next) sawNew += 1;
  if (!old && !next) dead += 1;
  if (old && next) windowSamples += 1;
  if (!readySent && old) {
    readySent = true;
    process.stdout.write(`${JSON.stringify({ event: 'ready', samples, sawOld })}\n`);
  }
  if (dead > 0) release('dead');
  else if (windowSamples >= WINDOW_ROUNDS) release('window');
}

release('timeout');
process.stdout.write(
  `${JSON.stringify({ event: 'done', samples, dead, sawOld, sawNew, windowSamples, releaseReason })}\n`,
);
