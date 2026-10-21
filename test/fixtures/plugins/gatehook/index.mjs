/**
 * `gatehook` — U1's in-flight witness (see plugin.json).
 *
 * The endpoint does one thing: if `SKW_GATE_HOLD_DIR` names a directory, it announces that it is
 * inside the request by writing `entered`, then waits (asynchronously, so the event loop keeps
 * turning and the drain's own timers run) until the gate writes `release`. Without the variable
 * it answers immediately, so the fixture is inert in every other gate that installs it.
 *
 * It is an **endpoint** and not a hook on purpose: a hook is bounded by
 * `SKW_PLUGIN_HOOK_TIMEOUT_MS` (2 s by default) and would be released by the dispatch timeout
 * before the 5 s drain budget could ever be reached. An endpoint is a request the app counts
 * with `plugins.enter()` for as long as the handler runs, which is the thing §13.3.8's drain
 * waits for.
 */
import { existsSync, writeFileSync } from 'node:fs';

export function activate(ctx) {
  ctx.endpoint('GET', 'hold', async () => {
    const dir = process.env.SKW_GATE_HOLD_DIR;
    if (dir !== undefined && dir !== '') {
      writeFileSync(`${dir}/entered`, String(process.pid));
      const release = `${dir}/release`;
      const deadline = Date.now() + 60_000;
      while (!existsSync(release) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    return { held: true, plugin: 'gatehook' };
  });
}
