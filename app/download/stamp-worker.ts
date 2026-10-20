/**
 * The stamp worker — **the only place `pdf-lib` or `sharp` runs**.
 *
 * `pdf-lib` is synchronous CPU work. On the request thread it blocks the event loop for
 * the whole render, which §7.5 measured as 20/20 unrelated requests waiting 510–514 ms
 * behind a 600 ms block; and a `Promise.race` with a 2 s timer cannot pre-empt it,
 * because the timer callback cannot run until the render has already returned. A worker
 * is the smallest mechanism that makes both sentences true: it is off the loop, and it
 * can be terminated the instant the budget expires.
 *
 * The job is plain data (paths, numbers, one string), so nothing is closed over and
 * nothing but the output bytes crosses the boundary.
 */
import { parentPort } from 'node:worker_threads';

import { stamp, type StampJob } from './watermark.ts';

if (parentPort === null) throw new Error('stamp-worker must be started as a worker thread');

parentPort.on('message', (job: StampJob) => {
  void stamp(job)
    .then((bytes) => {
      const copy = new Uint8Array(bytes);
      parentPort?.postMessage({ ok: true, bytes: copy }, [copy.buffer]);
    })
    .catch((err: unknown) => {
      parentPort?.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
    });
});
