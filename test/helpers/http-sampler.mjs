/**
 * A concurrent HTTP reader of two farm URLs, for the rename-atomicity gate at the edge.
 *
 * The rename is synchronous JavaScript in the test process, so nothing in that process can
 * observe the window. This script is a second process issuing real requests to a real nginx
 * while the parent renames.
 *
 * **Why this is a protocol and not a duration.** The first version sampled for a fixed
 * wall-clock window and the parent slept 150 ms before renaming; `sawOld > 0` then depended on
 * this process finishing its boot inside that 150 ms. On a loaded box node's boot is slower than
 * that, every sample landed after the rename, and the gate failed on
 * "the sampler never saw the old URL" at load 22–34 — an assertion about *this process's start
 * time*, dressed as an assertion about the rename. It now speaks in events, and the rename is
 * held open until this process says it has seen the window:
 *
 *   {"event":"ready"}    the old URL resolved, at least once. The parent may start the rename.
 *   {"event":"release"}  the parent may leave the window: either `windowSamples` rounds saw both
 *                        URLs resolve (the property held), or a round saw **neither** (it did
 *                        not — release anyway, so the gate reports `dead > 0` instead of
 *                        hanging until the barrier's deadline).
 *   {"event":"done"}     the final counts. `dead` is the number of rounds in which neither URL
 *                        resolved: the value the gate asserts is zero.
 *
 * A name "resolves" here if nginx answered 200 (bytes) or 301 (the alias map): both mean the URL
 * still names the asset. 404 is the only answer that means gone.
 *
 * Usage: node http-sampler.mjs <port> <host> <oldPath> <newPath> <maxMs> [holdDir]
 * Prints one JSON object per line, then exits when `maxMs` has elapsed.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { request } from 'node:http';

const [, , portArg, host, oldPath, newPath, msArg, holdDir] = process.argv;
if (portArg === undefined || host === undefined || oldPath === undefined || newPath === undefined) {
  process.stderr.write('usage: http-sampler.mjs <port> <host> <oldPath> <newPath> <maxMs> [holdDir]\n');
  process.exit(2);
}
const port = Number(portArg);
const maxMs = Number(msArg ?? '600');
/** Rounds inside the held window before the parent is released. */
const WINDOW_ROUNDS = 3;

function statusOf(path) {
  return new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port, path, headers: { host } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', () => resolve(0));
    req.setTimeout(2000, () => {
      req.destroy();
      resolve(0);
    });
    req.end();
  });
}

const ok = (status) => status === 200 || status === 301;

let samples = 0;
let dead = 0;
let sawOld = 0;
let sawNew = 0;
let windowSamples = 0;
let readySent = false;
let released = false;
let releaseReason = 'no-hold';
const oldStatuses = new Set();
const newStatuses = new Set();
const end = Date.now() + maxMs;

if (holdDir !== undefined) releaseReason = 'timeout';

function release(reason) {
  if (released) return;
  released = true;
  releaseReason = reason;
  if (holdDir !== undefined) writeFileSync(join(holdDir, 'window-release'), `${reason}\n`);
  process.stdout.write(`${JSON.stringify({ event: 'release', reason, windowSamples, dead })}\n`);
}

while (Date.now() < end) {
  const [oldStatus, newStatus] = await Promise.all([statusOf(oldPath), statusOf(newPath)]);
  samples += 1;
  oldStatuses.add(oldStatus);
  newStatuses.add(newStatus);
  const oldOk = ok(oldStatus);
  const newOk = ok(newStatus);
  if (oldOk) sawOld += 1;
  if (newOk) sawNew += 1;
  if (!oldOk && !newOk) dead += 1;
  if (oldOk && newOk) windowSamples += 1;
  if (!readySent && oldOk) {
    readySent = true;
    process.stdout.write(`${JSON.stringify({ event: 'ready', samples, sawOld })}\n`);
  }
  // Release on the property holding, and on the property failing — never on silence. A round
  // that saw neither URL is the violation the gate asserts is impossible; it releases so the
  // failure is `dead > 0` and not a barrier deadline.
  if (dead > 0) release('dead');
  else if (windowSamples >= WINDOW_ROUNDS) release('window');
}

release('timeout');
process.stdout.write(
  `${JSON.stringify({
    event: 'done',
    samples,
    dead,
    sawOld,
    sawNew,
    windowSamples,
    releaseReason,
    oldStatuses: [...oldStatuses].sort(),
    newStatuses: [...newStatuses].sort(),
  })}\n`,
);
