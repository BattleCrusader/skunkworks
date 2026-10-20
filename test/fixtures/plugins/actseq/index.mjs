/**
 * The activation-counter witness (E-31 item 5).
 *
 * `import.meta.url` is the URL the host handed `import()`, and the host puts `?tenant=…&act=N`
 * on it (§13.3.2 step 6). Reading it **at import time** is the only observation that proves
 * the module instance the process got is the one the URL named — a hook that read the counter
 * out of the database would prove the row and nothing about the cache key.
 *
 * `page.head` is the cheapest hook in the twelve and fires on any rendered page, so the gate
 * needs no endpoint and no facade to ask the question.
 */
const ACT = new URL(import.meta.url).searchParams.get('act');

export function activate(ctx) {
  ctx.on('page.head', () => `<!--act:${ACT}-->`);
}

/** For a process that imports the package directly (never used by the runtime). */
export const act = ACT;

export default activate;
