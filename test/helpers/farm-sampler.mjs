/**
 * A concurrent reader of the farm, for the rename-atomicity gate.
 *
 * The rename is synchronous JavaScript, so a sampler inside the same process can never run
 * while it is in progress — it would always report "one sample", which is the measurement
 * equivalent of not testing anything. This script is a second process reading both names
 * continuously while the parent performs the rename, and it reports how many samples saw the
 * old name, the new name, and **neither** (the value the gate asserts is zero).
 *
 * Usage: node farm-sampler.mjs <publicDir> <oldName> <newName> <durationMs>
 * Prints one JSON line: {"samples":N,"dead":N,"sawOld":N,"sawNew":N}
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const [, , dir, oldName, newName, msArg] = process.argv;
if (dir === undefined || oldName === undefined || newName === undefined) {
  process.stderr.write('usage: farm-sampler.mjs <publicDir> <oldName> <newName> <durationMs>\n');
  process.exit(2);
}
const duration = Number(msArg ?? '400');

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
const end = Date.now() + duration;
while (Date.now() < end) {
  const old = resolves(oldName);
  const next = resolves(newName);
  samples += 1;
  if (old) sawOld += 1;
  if (next) sawNew += 1;
  if (!old && !next) dead += 1;
}
process.stdout.write(`${JSON.stringify({ samples, dead, sawOld, sawNew })}\n`);
