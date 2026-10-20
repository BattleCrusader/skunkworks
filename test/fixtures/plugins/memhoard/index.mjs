/**
 * S4e's memory probe (§8.4, F4).
 *
 * `hold` allocates in 8 MiB chunks and keeps every one alive in an array, so the bytes are
 * real RSS, not a number the package reports. Buffers are **external** memory: V8's
 * `--max-old-space-size` does not count them, which is exactly why the cgroup has to be the
 * backstop a gate measures. `holdObjects` does the same with JS objects, which the heap cap
 * does count — the two paths are the two controls.
 *
 * The result is only returned when the allocation succeeded; at the ceiling the kernel kills
 * this process instead, and the runner names the kill.
 */
export async function handle(op, args = {}) {
  if (op === 'hold') {
    const mb = Number(args.mb ?? 256);
    if (!Number.isInteger(mb) || mb < 1) throw new Error('hold needs mb >= 1');
    const chunks = [];
    for (let i = 0; i < mb; i += 8) {
      const size = Math.min(8, mb - i) * 1024 * 1024;
      chunks.push(Buffer.alloc(size, i & 0xff));
    }
    return {
      requested_mb: mb,
      held_mb: chunks.reduce((n, b) => n + b.length, 0) / (1024 * 1024),
      rss_mb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
    };
  }
  if (op === 'holdObjects') {
    // Arrays of tagged numbers, not repeated strings: V8 stores `'x'.repeat(1 MiB)` as a
    // compact rope and 512 of them cost 49 MiB of RSS (measured while writing this gate).
    // 131 072 doubles are 1 MiB of heap the heap cap has to count.
    const mb = Number(args.mb ?? 256);
    const rows = [];
    for (let i = 0; i < mb; i += 1) rows.push(new Array(131_072).fill(((i % 250) + 1) / 3));
    return { requested_mb: mb, held_mb: rows.length, rss_mb: Math.round(process.memoryUsage().rss / (1024 * 1024)) };
  }
  if (op === 'rss') {
    return { rss_mb: Math.round(process.memoryUsage().rss / (1024 * 1024)), heap_mb: Math.round(process.memoryUsage().heapUsed / (1024 * 1024)) };
  }
  throw new Error(`memhoard: unknown op ${JSON.stringify(op)}`);
}

export default handle;
