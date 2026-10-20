/**
 * Container bookkeeping for the gates that need a real nginx (S4a, ITEM 0).
 *
 * Why this exists: five `skw-*` nginx containers and one `skw-*` network survived a
 * run and had to be removed by hand. Every one of those leaks came from the same
 * shape of code:
 *
 *     container = `skw-…`;            // assigned only *after* the wait loop
 *     spawnSync('docker', ['run', …]);
 *     for (…) { … }                   // ← throws here, and the name is never recorded
 *     assert.ok(ready);
 *
 * i.e. the name was recorded on the success path of the *hook*, so a container that
 * started and then failed its health probe was invisible to `after()`. `--rm` does
 * not help: it removes on *stop*, and a container that is never stopped (or whose
 * file was killed by `--test-timeout`) stays.
 *
 * The rule this enforces: **the name is recorded before `docker run`.** A name that
 * is recorded is removed by `after()`, and — because a killed test file never runs
 * `after()` — also by the process `exit`/signal handlers installed here. Nothing in
 * a test file should call `docker rm` directly; `removeContainer()` is the one way.
 */
import { spawnSync } from 'node:child_process';

/** Names this process created and has not removed. Order preserved for messages. */
const live = new Set<string>();
let installed = false;

function rm(name: string): void {
  // Synchronous on purpose: `process.on('exit')` cannot await, and a removed
  // container is the whole point of the handler.
  spawnSync('docker', ['rm', '-f', name], { encoding: 'utf8', stdio: 'ignore' });
  live.delete(name);
}

function install(): void {
  if (installed) return;
  installed = true;
  process.on('exit', () => {
    for (const name of [...live]) rm(name);
  });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => {
      for (const name of [...live]) rm(name);
      // 128+n is the shell's convention for "died on a signal"; the runner turns a
      // cancelled file into a red gate anyway (E-8).
      process.exit(128 + (signal === 'SIGINT' ? 2 : signal === 'SIGTERM' ? 15 : 1));
    });
  }
}

/**
 * Record a container name **before** `docker run` so that every later failure path
 * (a failed run, a health probe that never answers, an assertion in the hook) leaves
 * the name in the cleanup set. Returns the name unchanged, for `const c = track(…)`.
 */
export function trackContainer(name: string): string {
  install();
  live.add(name);
  return name;
}

/** Remove now, and forget. Idempotent: a second call is a no-op. */
export function removeContainer(name: string): void {
  if (name === '') return;
  if (installed) {
    rm(name);
    return;
  }
  spawnSync('docker', ['rm', '-f', name], { encoding: 'utf8', stdio: 'ignore' });
}

/** Remove every name this process still holds. Called by `after()` and the handlers. */
export function sweepContainers(): void {
  for (const name of [...live]) rm(name);
}

/** Names still held by this process — the `after()` hook asserts this is empty. */
export function liveContainers(): string[] {
  return [...live];
}

/**
 * The audit, as a pure function over `docker ps -a` output.
 *
 * Pure so the negative control in `test/container-leak.test.ts` can feed it a listing
 * that *does* contain a leak without creating one: a checker that cannot see a
 * container it was just told about is not a checker.
 */
export function findLeaks(
  psOutput: string,
  networkOutput: string,
  prefix = 'skw-',
): { containers: string[]; networks: string[] } {
  const first = (line: string): string => line.split(/\s+/)[0] ?? '';
  const containers = psOutput
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    // `docker ps --format '{{.Names}}'` prints one name per line; `{{.Names}}\t{{.Status}}`
    // is also accepted, and only the first field is a name.
    .map(first)
    .filter((name) => name.startsWith(prefix))
    .sort();
  const networks = networkOutput
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map(first)
    .filter((name) => name.startsWith(prefix))
    .sort();
  return { containers, networks };
}
