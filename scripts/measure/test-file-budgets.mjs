#!/usr/bin/env node
/**
 * Measures one test file at a time and writes `test/perf-budgets.json` — the table
 * `TEST_TIMEOUT_MS` is derived from.
 *
 * Why this exists: the constant used to cite "the worst idle file" in a Makefile comment.
 * When a heavier test appeared the sentence stayed true about a file that no longer set the
 * maximum, and nothing could tell. The table is the constant's input; this script is how the
 * input is produced, so re-deriving the budget is a command rather than an act of memory.
 *
 *   node scripts/measure/test-file-budgets.mjs                 # every file, one at a time
 *   node scripts/measure/test-file-budgets.mjs --files test/first-boot-tls.test.ts --repeat 2
 *   node scripts/measure/test-file-budgets.mjs --only-heaviest --repeat 2   # re-measure rows >= 3 s
 *
 * Each run is `scripts/run-node-tests.mjs --timeout=<measurement ceiling> <file>` — the same
 * runner `make test` uses, so the number includes the runner's own startup and the file's
 * `before`/`after` hooks, which is exactly what the per-file budget has to cover. The box's
 * 1-minute load average is recorded before and after every run; a number without its load is
 * not a measurement, and the table rejects one.
 *
 * Merge rule: for a file whose sha256 is unchanged, a new run is appended and the worst run
 * wins; for a file whose bytes changed, the old runs are discarded (they measured other bytes)
 * and the new run is the row. The table is rewritten in place; it is not sorted by hand.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, platform, release, arch, totalmem, hostname } from 'node:os';
import { join, relative } from 'node:path';

const REPO = process.cwd();
const TABLE = join(REPO, 'test', 'perf-budgets.json');
const RUNNER = join(REPO, 'scripts', 'run-node-tests.mjs');
const MEASUREMENT_TIMEOUT_MS = 300_000; // a ceiling for the measurement run, never the gate
const KEEP_RUNS = 8;
/** Idle is the preflight's definition: the 1-minute load did not exceed the core count when
 * the run started. A run that starts above it is recorded but cannot set the budget. */
const IDLE_MAX_LOAD = cpus().length;

function parseArgs(argv) {
  const opts = { files: [], exclude: [], repeat: 1, onlyHeaviest: false, dryRun: false, fresh: false, maxWaitS: 60, timeoutMs: MEASUREMENT_TIMEOUT_MS };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--files') {
      opts.files = String(argv[++i] ?? '')
        .split(',')
        .map((file) => file.trim())
        .filter((file) => file !== '');
    } else if (arg === '--exclude') {
      opts.exclude = String(argv[++i] ?? '')
        .split(',')
        .map((file) => file.trim())
        .filter((file) => file !== '');
    } else if (arg === '--repeat') {
      opts.repeat = Number(argv[++i] ?? '1');
      if (!Number.isInteger(opts.repeat) || opts.repeat < 1) throw new Error('--repeat must be a positive integer');
    } else if (arg === '--max-wait-s') {
      opts.maxWaitS = Number(argv[++i] ?? '60');
      if (!Number.isFinite(opts.maxWaitS) || opts.maxWaitS < 0) throw new Error('--max-wait-s must be a non-negative number');
    } else if (arg === '--timeout') {
      opts.timeoutMs = Number(argv[++i] ?? '0');
      if (!Number.isInteger(opts.timeoutMs) || opts.timeoutMs < 1000) throw new Error('--timeout must be an integer >= 1000');
    } else if (arg === '--only-heaviest') {
      opts.onlyHeaviest = true;
    } else if (arg === '--fresh') {
      opts.fresh = true;
    } else if (arg === '--dry-run') {
      opts.dryRun = true;
    } else {
      throw new Error(`unknown argument ${JSON.stringify(arg)}`);
    }
  }
  return opts;
}

/** Every test file under test/ (except the perf split), in the same order as the Makefile. */
function allTestFiles() {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const stat = statSync(path);
      if (stat.isDirectory()) {
        if (name === 'perf') continue;
        walk(path);
      } else if (name.endsWith('.test.ts')) {
        out.push(relative(REPO, path));
      }
    }
  };
  walk(join(REPO, 'test'));
  return out.sort();
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function box() {
  const docker = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}/{{.NCPU}}cpu/{{.MemTotal}}B'], {
    encoding: 'utf8',
  });
  const dockerText = docker.status === 0 ? `docker ${docker.stdout.trim()}` : 'docker unavailable';
  return `${hostname()} ${platform()} ${release()} ${arch()}, ${String(cpus().length)} cpus, ${String(
    Math.round(totalmem() / 1024 ** 3),
  )} GiB, node ${process.version}, ${dockerText}`;
}

function load() {
  return Math.round(loadavg()[0] * 100) / 100;
}

function nowIso() {
  return new Date().toISOString();
}

/** The date on the wall calendar of the box, not UTC: 10:40 on 2026-10-21 in AEDT is
 * 2026-10-20T23:40Z, and a table that says 10-20 for a run made on the 21st is a small lie. */
function localDate(iso) {
  const d = new Date(iso);
  return `${String(d.getFullYear())}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function readTable() {
  if (!existsSync(TABLE)) {
    return { schema: 1, multiplier: 4, staleCheckFloorMs: 3000, box: box(), measurements: [] };
  }
  const parsed = JSON.parse(readFileSync(TABLE, 'utf8'));
  if (!Array.isArray(parsed.measurements)) parsed.measurements = [];
  return parsed;
}

function waitForIdle(maxWaitS) {
  const deadline = Date.now() + maxWaitS * 1000;
  while (load() > IDLE_MAX_LOAD && Date.now() < deadline) {
    spawnSync('sleep', ['2']);
  }
}

function measure(file, opts) {
  const runs = [];
  for (let run = 0; run < opts.repeat; run += 1) {
    waitForIdle(opts.maxWaitS);
    const before = load();
    const startedAt = process.hrtime.bigint();
    const child = spawnSync(process.execPath, [RUNNER, `--timeout=${opts.timeoutMs}`, file], {
      cwd: REPO,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: opts.timeoutMs + 60_000,
    });
    const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const after = load();
    const output = `${child.stdout ?? ''}\n${child.stderr ?? ''}`;
    const summary = /^# (tests|pass|fail|cancelled|skipped) (\d+)$/gm;
    const counts = {};
    let match;
    while ((match = summary.exec(output)) !== null) counts[match[1]] = Number(match[2]);
    const ok = child.status === 0 && (counts.fail ?? 0) === 0 && (counts.cancelled ?? 0) === 0;
    const idle = before <= IDLE_MAX_LOAD;
    runs.push({
      ms: Math.round(ms),
      at: nowIso(),
      load1mBefore: before,
      load1mAfter: after,
      idle,
      exitCode: child.status,
      tests: counts.tests ?? null,
      ...(ok ? {} : { failed: true }),
    });
    process.stdout.write(
      `${file}: run ${String(run + 1)}/${String(opts.repeat)} ${String(Math.round(ms))} ms, exit ${String(
        child.status,
      )}, tests ${String(counts.tests ?? '?')}, load ${before.toFixed(2)} -> ${after.toFixed(2)}` +
        `${idle ? '' : '  ← NOT IDLE (load > cpus)'}${ok ? '' : '  ← NOT A PASS'}\n`,
    );
    if (!ok) process.stdout.write(`${output.split('\n').slice(-20).join('\n')}\n`);
    // A file that carries its own breakdown says so on stdout; keep that line in the
    // measurement log so the table's worst number has a stated composition, not just a total.
    for (const line of output.split('\n')) {
      if (line.includes('phases: total=')) process.stdout.write(`  ${line.replace(/^#\s*/, '')}\n`);
    }
  }
  return runs;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const table = opts.fresh
    ? { schema: 1, multiplier: 4, staleCheckFloorMs: 3000, box: box(), measurements: [] }
    : readTable();
  const rows = new Map(table.measurements.map((row) => [row.file, row]));

  let targets;
  if (opts.files.length > 0) {
    targets = opts.files;
  } else {
    targets = allTestFiles();
  }
  if (opts.exclude.length > 0) {
    targets = targets.filter((file) => !opts.exclude.includes(file));
  }
  if (opts.onlyHeaviest) {
    const floor = Number.isFinite(table.staleCheckFloorMs) ? table.staleCheckFloorMs : 3000;
    targets = targets.filter((file) => {
      const row = rows.get(file);
      return row !== undefined && row.worstIdleMs >= floor;
    });
  }

  process.stdout.write(
    `measuring ${String(targets.length)} file(s) alone, one at a time, ${String(opts.repeat)} run(s) each; ` +
      `idle means load <= ${String(IDLE_MAX_LOAD)} at the start; box: ${box()}\n`,
  );

  for (const file of targets) {
    if (!existsSync(join(REPO, file))) throw new Error(`${file} does not exist`);
    const hash = sha256(join(REPO, file));
    const previous = rows.get(file);
    const fresh = previous === undefined || previous.sha256 !== hash;
    const runs = measure(file, opts);
    const allRuns = fresh ? runs : [...(previous.runs ?? []), ...runs].slice(-KEEP_RUNS);
    const idleRuns = allRuns.filter((run) => run.idle === true);
    const worst = idleRuns.reduce((max, run) => (run.ms > max.ms ? run : max), idleRuns[0]);
    rows.set(file, {
      file,
      worstIdleMs: worst === undefined ? 0 : worst.ms,
      measuredOn: localDate((worst ?? allRuns[allRuns.length - 1]).at),
      load1m: (worst ?? allRuns[allRuns.length - 1]).load1mBefore,
      box: box(),
      sha256: hash,
      runs: allRuns,
    });
    if (worst === undefined) {
      process.stdout.write(`${file}: NO IDLE RUN — this row cannot set TEST_TIMEOUT_MS\n`);
    }
  }

  const measurements = [...rows.values()].sort((a, b) => b.worstIdleMs - a.worstIdleMs || a.file.localeCompare(b.file));
  const next = { ...table, schema: 1, box: box(), updatedAt: nowIso(), measurements };
  if (opts.dryRun) {
    process.stdout.write(`${JSON.stringify(next, null, 2)}\n`);
    return;
  }
  writeFileSync(TABLE, `${JSON.stringify(next, null, 2)}\n`);
  process.stdout.write(`\nwrote ${relative(REPO, TABLE)}; worst 8:\n`);
  for (const row of measurements.slice(0, 8)) {
    process.stdout.write(`  ${String(row.worstIdleMs).padStart(7)} ms  load ${String(row.load1m).padStart(5)}  ${row.file}\n`);
  }
}

main();
