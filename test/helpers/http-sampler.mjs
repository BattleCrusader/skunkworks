/**
 * A concurrent HTTP reader of two farm URLs, for the rename-atomicity gate at the edge.
 *
 * The rename is synchronous JavaScript in the test process, so nothing in that process can
 * observe the window. This script is a second process issuing real requests to a real nginx
 * while the parent renames, and it reports how many samples saw the old URL, the new URL and
 * **neither** — the count the gate asserts is zero.
 *
 * A name "resolves" here if nginx answered 200 (bytes) or 301 (the alias map): both mean the
 * URL still names the asset. 404 is the only answer that means gone.
 *
 * Usage: node http-sampler.mjs <port> <host> <oldPath> <newPath> <durationMs>
 * Prints one JSON line: {"samples":N,"dead":N,"sawOld":N,"sawNew":N,"oldStatus":[...],"newStatus":[...]}
 */
import { request } from 'node:http';

const [, , portArg, host, oldPath, newPath, msArg] = process.argv;
if (portArg === undefined || host === undefined || oldPath === undefined || newPath === undefined) {
  process.stderr.write('usage: http-sampler.mjs <port> <host> <oldPath> <newPath> <durationMs>\n');
  process.exit(2);
}
const port = Number(portArg);
const duration = Number(msArg ?? '600');

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
const oldStatuses = new Set();
const newStatuses = new Set();
const end = Date.now() + duration;
while (Date.now() < end) {
  const [oldStatus, newStatus] = await Promise.all([statusOf(oldPath), statusOf(newPath)]);
  samples += 1;
  oldStatuses.add(oldStatus);
  newStatuses.add(newStatus);
  if (ok(oldStatus)) sawOld += 1;
  if (ok(newStatus)) sawNew += 1;
  if (!ok(oldStatus) && !ok(newStatus)) dead += 1;
}
process.stdout.write(
  `${JSON.stringify({
    samples,
    dead,
    sawOld,
    sawNew,
    oldStatuses: [...oldStatuses].sort(),
    newStatuses: [...newStatuses].sort(),
  })}\n`,
);
