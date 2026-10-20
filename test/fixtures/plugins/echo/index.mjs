/**
 * The reference package. It declares three capabilities and uses one of them; the runner
 * answers `util.*` itself, so this file's `handle()` is only reached through
 * `plugin.invoke` — which is exactly how a real widget's code runs (§8.3).
 */
export async function handle(op, args) {
  if (op === 'render') {
    return { text: `echo:${String(args?.text ?? '')}` };
  }
  if (op === 'now') {
    return { at: new Date().toISOString() };
  }
  throw new Error(`echo: unknown op ${JSON.stringify(op)}`);
}

export default handle;
