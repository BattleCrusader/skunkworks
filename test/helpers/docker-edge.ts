/**
 * Start one published container on a host port that is free **when docker binds it**.
 *
 * Every edge test in this suite did the same thing by hand — `freePort()`, then `docker run -p
 * <port>:80` — and every one of them could lose the race in the same way: `freePort()` binds and
 * releases, and between that release and docker's own bind another process (a sibling test, a
 * browser, a build) can take the port. Docker then refuses with
 *
 *     docker: Error response from daemon: ports are not available: exposing port TCP
 *     0.0.0.0:52542 -> 127.0.0.1:0: listen tcp 0.0.0.0:52542: bind: address already in use
 *
 * which reads like a broken harness and is really a one-line race. It failed `nginx-e2e` three
 * times, then `nginx-gated-e2e` four times, before it was fixed in one place instead of four.
 *
 * The retry is deliberately narrow: a fresh port, up to `attempts`, and **only** for that exact
 * refusal. Any other docker failure fails on the first attempt with its own stderr, because a
 * retry loop that swallowed a real error would be worse than the race.
 */
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';

export interface EdgeStart {
  /** The port docker was last asked to publish. Meaningful only when `run.status === 0`. */
  port: number;
  run: SpawnSyncReturns<string>;
}

export async function startEdge(input: {
  /** argv after `docker`, with the port the helper chose spliced in. */
  args: (port: number) => string[];
  freePort: () => Promise<number>;
  attempts?: number;
}): Promise<EdgeStart> {
  const attempts = input.attempts ?? 6;
  let port = 0;
  let last: SpawnSyncReturns<string> | undefined;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    port = await input.freePort();
    const run = spawnSync('docker', input.args(port), { encoding: 'utf8' });
    if (run.status === 0) return { port, run };
    last = run;
    if (!String(run.stderr ?? '').includes('address already in use')) break;
  }
  // `spawnSync` always returns a record; the non-null assertion is for the type, not the runtime.
  return { port, run: last as SpawnSyncReturns<string> };
}
