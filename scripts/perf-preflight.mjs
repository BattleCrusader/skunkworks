#!/usr/bin/env node
/**
 * `make test-perf`'s preflight: say out loud that the gate that follows measures the box, and
 * refuse when the box is too busy for the measurement to mean anything.
 *
 * A performance gate that runs on a loaded machine is red for a reason that is not the code, and
 * the first reader to see it will "fix" it by widening a band. So the gate states its terms before
 * it starts:
 *
 *   - always prints the CPU count and the 1-minute load average;
 *   - **refuses** (exit 2) when the 1-minute load exceeds the core count — the box is
 *     oversubscribed and a wall-clock assertion cannot separate the code from the queue;
 *   - warns when it exceeds half the cores: the numbers are still a measurement, but a tighter
 *     one than usual;
 *   - `SKW_PERF_FORCE=1` overrides the refusal, and then says the numbers are not a measurement.
 *
 * This is a developer script, not a product surface: it adds no `SKW_` name to §4.3's table, and
 * nothing in `app/` reads it.
 */
import os from 'node:os';

const cpus = os.cpus().length;
const load = os.loadavg()[0];
const forced = process.env.SKW_PERF_FORCE === '1';

process.stdout.write(`  box: ${String(cpus)} cpus, 1-min load average ${load.toFixed(2)}\n`);

if (forced) {
  process.stdout.write('  SKW_PERF_FORCE=1: the load guard is OFF; these numbers are not a measurement\n');
  process.exit(0);
}
if (load > cpus) {
  process.stderr.write(
    `  REFUSED: load ${load.toFixed(2)} on ${String(cpus)} cpus — this box is oversubscribed, and a\n` +
      '  busy box makes a wall-clock gate red for its own reasons.\n' +
      '  Re-run on an idle box, or set SKW_PERF_FORCE=1 to run anyway (and say so when you quote the numbers).\n',
  );
  process.exit(2);
}
if (load > cpus * 0.5) {
  process.stdout.write(
    `  WARNING: load ${load.toFixed(2)} is over half the core count — the numbers below are a measurement,\n` +
      '  but a tighter one than usual. A failure here is worth re-running on an idle box before it is believed.\n',
  );
}
