/**
 * The gate behind `TEST_TIMEOUT_MS` — a derived constant that must be able to name its input.
 *
 * The constant lived in the Makefile as a comment and a number: "40000 is 4.4× the worst idle
 * file, test/ddl-runner.test.ts at 8.99 s". When `test/first-boot-tls.test.ts` arrived at
 * ~31 s, the derivation stayed true about a file that no longer set the maximum, and the
 * constant spent four slices at 77 % of its own budget before it lost a run. A number whose
 * input is a sentence in a comment cannot be checked, so this file makes the input a machine-
 * readable table (`test/perf-budgets.json`) and checks the number against it:
 *
 *   B1  every row is an idle measurement: a file under `test/`, a worst idle run in ms, the
 *       date, the 1-minute load and the box it was measured on, the file's sha256, and the
 *       runs that produced the worst value. A run is idle when it *started* at a 1-minute
 *       load no greater than the CPU count — the same threshold `scripts/perf-preflight.mjs`
 *       refuses at;
 *   B2  the rows that can set a budget — any row at or above `staleCheckFloorMs`, plus the
 *       largest row — are measurements of the bytes that are in the tree now. Edit one of
 *       those files and the gate names it and asks for a re-measurement instead of silently
 *       comparing the budget to a stale number;
 *   B3  `TEST_TIMEOUT_MS` is **exactly** `ceil(4 × the largest recorded worst idle run)`
 *       (rounded up to the next second), both in the Makefile and in the value the runner
 *       actually used (`SKW_TEST_TIMEOUT_MS`, set by `scripts/run-node-tests.mjs`). A value
 *       below the floor is a gate that loses runs; a value above it is a gate that hides a
 *       hang. The failure names the file, its measurement, the date, the load and the box.
 *
 * B4 is the negative control: it feeds the same pure checks a table whose heaviest row claims
 * more than the budget allows, and one whose hash does not match, and requires both to be red
 * and to name the file. A checker that cannot fail is not a checker.
 *
 * What this gate cannot see: a row that understates a file's real runtime. Nothing static can;
 * that case is caught by the suite itself, which is why the negative control for it is a real
 * run at the understated budget (`docs/build/S5-inprocess-report.md` §11.4).
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { cpus } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';

import { REPO } from './helpers/fixture.ts';

const TABLE_PATH = join(REPO, 'test', 'perf-budgets.json');
const MAKEFILE_PATH = join(REPO, 'Makefile');

/** The rule, in one place. A table that lowers this is a table this gate rejects. */
const MULTIPLIER = 4;
/** The constant is quoted to the second: `ceil(4 × worst / 1000) * 1000`. */
const ROUND_UP_MS = 1_000;
/** Below this, a file cannot set a 4× budget unless the budget is already tiny; rows below
 * it are recorded for the table's completeness but are not hash-checked on every edit. */
const DEFAULT_STALE_FLOOR_MS = 3_000;
/** "Idle" is the preflight's own definition: the 1-minute load did not exceed the core count
 * when the run started. */
const IDLE_MAX_LOAD = cpus().length;

interface RunRecord {
  ms: number;
  at: string;
  load1mBefore: number;
  load1mAfter: number;
  idle: boolean;
}

interface Row {
  file: string;
  worstIdleMs: number;
  measuredOn: string;
  load1m: number;
  box: string;
  sha256: string;
  runs: RunRecord[];
}

interface Table {
  schema: number;
  multiplier: number;
  staleCheckFloorMs: number;
  measurements: Row[];
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function readTable(path = TABLE_PATH): Table {
  assert.ok(existsSync(path), `${path} does not exist: TEST_TIMEOUT_MS has no recorded input`);
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  assert.ok(typeof parsed === 'object' && parsed !== null, `${path} is not a JSON object`);
  return parsed as Table;
}

/** The one definition of the default: `TEST_TIMEOUT_MS ?= <n>`. */
function readMakefileBudget(text: string): number {
  const match = /^TEST_TIMEOUT_MS\s*\?=\s*(\d+)\s*$/m.exec(text);
  assert.ok(
    match !== null,
    'the Makefile has no `TEST_TIMEOUT_MS ?= <ms>` line — the budget has no single definition this gate can check',
  );
  return Number(match[1]);
}

/** The value the suite actually ran under: the runner exports it to each test child. When a
 * file is run directly (`node --test test/timeout-budget.test.ts`) there is no runner, and the
 * Makefile's default is the only budget in force. */
function effectiveBudget(makefileMs: number): number {
  const fromRunner = process.env.SKW_TEST_TIMEOUT_MS;
  if (fromRunner === undefined || fromRunner === '') return makefileMs;
  const value = Number(fromRunner);
  assert.ok(Number.isInteger(value) && value > 0, `SKW_TEST_TIMEOUT_MS is not a positive integer: ${JSON.stringify(fromRunner)}`);
  return value;
}

function heaviest(rows: Row[]): Row {
  let max: Row | undefined;
  for (const row of rows) if (max === undefined || row.worstIdleMs > max.worstIdleMs) max = row;
  assert.ok(max !== undefined, 'test/perf-budgets.json records no measurements: nothing derives TEST_TIMEOUT_MS');
  return max;
}

/** `ceil(multiplier × worst / 1000) × 1000`, with the row that set it. */
function derived(rows: Row[]): { ms: number; row: Row } {
  const row = heaviest(rows);
  return { ms: Math.ceil((row.worstIdleMs * MULTIPLIER) / ROUND_UP_MS) * ROUND_UP_MS, row };
}

function isMeasuredFile(file: unknown): file is string {
  return typeof file === 'string' && file.startsWith('test/') && !file.includes('..');
}

/** Every test file the suite will run, in the Makefile's order. */
function testFilesOnDisk(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
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

/** A row's own claim, checked without the filesystem, so B4 can drive it with a forged table. */
function rowProblems(row: Row): string[] {
  const problems: string[] = [];
  const file = row.file;
  if (!isMeasuredFile(file)) {
    return [`row file ${JSON.stringify(file)} is not a path under test/: it cannot name a measured file`];
  }
  if (!Number.isFinite(row.worstIdleMs) || row.worstIdleMs <= 0) {
    problems.push(`${file}: worstIdleMs ${JSON.stringify(row.worstIdleMs)} is not a positive idle measurement`);
  }
  if (typeof row.measuredOn !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.measuredOn)) {
    problems.push(`${file}: measuredOn ${JSON.stringify(row.measuredOn)} is not a YYYY-MM-DD date`);
  }
  if (!Number.isFinite(row.load1m) || row.load1m < 0) {
    problems.push(`${file}: load1m ${JSON.stringify(row.load1m)} is not a load average — every number must carry the load it was taken at`);
  } else if (row.load1m > IDLE_MAX_LOAD) {
    problems.push(`${file}: load1m ${row.load1m} exceeds ${IDLE_MAX_LOAD} cpus — that is not an idle measurement`);
  }
  if (typeof row.box !== 'string' || row.box.trim() === '') {
    problems.push(`${file}: box is empty — every number must carry the machine it was taken on`);
  }
  if (typeof row.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(row.sha256)) {
    problems.push(`${file}: sha256 ${JSON.stringify(row.sha256)} is not a measurement of specific bytes`);
  }
  const runs: RunRecord[] = Array.isArray(row.runs) ? row.runs : [];
  const idleRuns = runs.filter((run) => run.idle === true);
  if (idleRuns.length === 0) {
    problems.push(`${file}: no run recorded at load <= ${IDLE_MAX_LOAD} — a loaded box cannot set the budget`);
  } else {
    const worstIdle = Math.max(...idleRuns.map((run) => run.ms));
    if (row.worstIdleMs !== worstIdle) {
      problems.push(`${file}: worstIdleMs ${row.worstIdleMs} is not the maximum of its idle runs (${worstIdle})`);
    }
    const worstRun = idleRuns.find((run) => run.ms === row.worstIdleMs);
    if (worstRun !== undefined && Number.isFinite(row.load1m) && row.load1m !== worstRun.load1mBefore) {
      problems.push(`${file}: load1m ${row.load1m} is not the load of the run that produced worstIdleMs (${worstRun.load1mBefore})`);
    }
  }
  return problems;
}

/**
 * Every way the table or the constant is wrong. Pure over its inputs so B4 can drive it with
 * a forged table — the same function the real gate runs, not a copy of it.
 */
function budgetProblems(table: Table, effectiveMs: number, makefileMs: number): string[] {
  const problems: string[] = [];

  if (table.multiplier !== MULTIPLIER) {
    problems.push(`perf-budgets.json multiplier is ${String(table.multiplier)}, not ${MULTIPLIER}: the budget's rule changed without this gate`);
  }
  const rows: Row[] = Array.isArray(table.measurements) ? table.measurements : [];
  if (rows.length === 0) return [...problems, 'perf-budgets.json records no measurements'];

  for (const row of rows) {
    problems.push(...rowProblems(row));
    if (isMeasuredFile(row.file) && !existsSync(join(REPO, row.file))) {
      problems.push(`recorded file ${row.file} no longer exists — remove the row or re-measure it`);
    }
  }

  const { ms: required, row: largest } = derived(rows);

  const staleFloor = Number.isFinite(table.staleCheckFloorMs) ? table.staleCheckFloorMs : DEFAULT_STALE_FLOOR_MS;
  for (const row of rows) {
    const checked = row === largest || row.worstIdleMs >= staleFloor;
    if (!checked || !isMeasuredFile(row.file) || !existsSync(join(REPO, row.file))) continue;
    if (typeof row.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(row.sha256)) continue;
    const actual = sha256File(join(REPO, row.file));
    if (actual !== row.sha256) {
      problems.push(
        `${row.file} changed since it was measured (sha256 ${actual.slice(0, 12)}…, recorded ${row.sha256.slice(0, 12)}…): ` +
          `its ${row.worstIdleMs} ms row is stale — re-measure it with "node scripts/measure/test-file-budgets.mjs --files ${row.file}"`,
      );
    }
  }

  if (makefileMs !== required) {
    problems.push(
      `Makefile TEST_TIMEOUT_MS=${makefileMs} is not the derivation: ceil(${MULTIPLIER} × ${largest.worstIdleMs} ms [${largest.file}]) = ${required}. ` +
        'The constant is a function of the table, not a knob.',
    );
  }
  if (effectiveMs !== required) {
    const direction = effectiveMs < required ? 'below the derived floor' : 'above the derived value (a wider budget hides a hang)';
    problems.push(
      `the budget in force is ${effectiveMs} ms, ${direction} of ${required} ms = ${MULTIPLIER} × ${largest.worstIdleMs} ms, ` +
        `the worst idle run of ${largest.file} (measured ${largest.measuredOn}, load ${largest.load1m}, ${largest.box}). ` +
        'That file sets the budget.',
    );
  }

  return problems;
}

function assertBudget() {
  const table = readTable();
  const makefileMs = readMakefileBudget(readFileSync(MAKEFILE_PATH, 'utf8'));
  // Completeness: a new heavy file must not be able to join the suite unmeasured. The table is
  // the constant's input, so a file with no row is a file the derivation cannot see — the exact
  // way the 40 000 ms constant rotted when first-boot-tls arrived.
  const measured = new Set(table.measurements.map((row) => row.file));
  const missing = testFilesOnDisk().filter((file) => !measured.has(file));
  assert.deepEqual(
    missing,
    [],
    `these test files have no row in test/perf-budgets.json, so TEST_TIMEOUT_MS cannot see them: ${missing.join(', ')} — ` +
      `measure them with "node scripts/measure/test-file-budgets.mjs --files ${missing.join(',')}"`,
  );
  const problems = budgetProblems(table, effectiveBudget(makefileMs), makefileMs);
  assert.deepEqual(problems, [], `TEST_TIMEOUT_MS and its measurement table disagree:\n- ${problems.join('\n- ')}`);
}

test('B1 — every row is an idle measurement: file, ms, date, load, box, hash, runs', () => {
  const table = readTable();
  const rows = Array.isArray(table.measurements) ? table.measurements : [];
  assert.ok(rows.length > 0, 'perf-budgets.json records no measurements');
  const problems = rows.flatMap((row) => rowProblems(row));
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('B2 — the rows that can set a budget were measured on the bytes in the tree now', () => {
  assertBudget();
});

test('B3 — TEST_TIMEOUT_MS is exactly 4 × the heaviest idle file, and the failure names it', () => {
  const table = readTable();
  const makefileMs = readMakefileBudget(readFileSync(MAKEFILE_PATH, 'utf8'));
  const { ms: required, row } = derived(table.measurements);
  assert.equal(makefileMs, required, `Makefile TEST_TIMEOUT_MS=${makefileMs} does not equal ceil(4 × ${row.worstIdleMs} ms [${row.file}]) = ${required}`);
  assert.equal(
    effectiveBudget(makefileMs),
    required,
    `the suite ran with ${effectiveBudget(makefileMs)} ms, not ${required} ms = 4 × ${row.worstIdleMs} ms measured on ${row.file} ` +
      `(${row.measuredOn}, load ${row.load1m}, ${row.box})`,
  );
});

test('B4 — negative control: the checks are red, and name the file, when a row and the budget disagree', () => {
  const table = readTable();
  const makefileMs = readMakefileBudget(readFileSync(MAKEFILE_PATH, 'utf8'));

  // A table that claims the heaviest file is slower than the budget allows: the 4× rule fails
  // and the message must carry the file's name, measurement, date and load.
  const raised = structuredClone(table);
  const top = heaviest(raised.measurements);
  const raisedMs = top.worstIdleMs * 4;
  top.worstIdleMs = raisedMs;
  top.runs = [...top.runs, { ms: raisedMs, at: `${top.measuredOn}T00:00:00.000Z`, load1mBefore: top.load1m, load1mAfter: top.load1m, idle: true }];
  const raisedProblems = budgetProblems(raised, makefileMs, makefileMs);
  const raisedRequired = Math.ceil((raisedMs * 4) / 1000) * 1000;
  assert.ok(
    raisedProblems.some((problem) => problem.includes(top.file) && problem.includes(String(raisedRequired))),
    `raising ${top.file} to ${raisedMs} ms did not produce a named 4× failure: ${JSON.stringify(raisedProblems)}`,
  );

  // A row measured on different bytes: the staleness check fails and names the file.
  const forged = structuredClone(table);
  const forgedTop = heaviest(forged.measurements);
  forgedTop.sha256 = '0'.repeat(64);
  const forgedProblems = budgetProblems(forged, makefileMs, makefileMs);
  assert.ok(
    forgedProblems.some((problem) => problem.includes(forgedTop.file) && problem.includes('changed since it was measured')),
    `a forged hash on ${forgedTop.file} did not produce a staleness failure: ${JSON.stringify(forgedProblems)}`,
  );
});
