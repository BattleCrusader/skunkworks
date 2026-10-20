/**
 * The child harness — the **only** code the plugin's package is loaded into.
 *
 * One process per package, spawned by `server.mjs` as:
 *
 *     node --permission \
 *          --allow-fs-read=/srv/runner/child.mjs \
 *          --allow-fs-read=/srv/plugins/<id> \
 *          --allow-fs-read=/srv/scratch/<id> \
 *          /srv/runner/child.mjs /srv/plugins/<id>/<entry>
 *
 * No `--allow-addons`, no `--allow-child-process`, no `--allow-worker`. The child cannot
 * read a file outside its own package and scratch, cannot load a native addon, cannot spawn,
 * and — because the container has no network namespace — cannot open a socket. The last one
 * is not Node's doing and the file that says so is `docker-compose.yml` (`network_mode:
 * none`); measured: `net.connect` to a loopback port returns `ENETUNREACH` there and a 200
 * without it.
 *
 * The protocol is JSON lines on stdin/stdout: one request in, one response out. Nothing is
 * evaluated from the host side; the plugin's own `handle(op, args)` decides what it does with
 * an op the runner has already authorised against the manifest's capability list.
 */
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';

const entry = process.argv[2];
if (entry === undefined) {
  process.stderr.write('child: no entry\n');
  process.exit(2);
}

let mod;

/**
 * The host bridge (S4d): `skw.call(op, args)` is one of §8.3's ten host operations.
 *
 * The package's code runs in this child, but the host writes the row. The call is a
 * request on stdout, answered on stdin by the runner — which forwards it over the unix
 * socket to the **host channel that requested this invoke**, so the tenant binding is the
 * caller's and not a field the package controls. The id space is the child's, so two
 * concurrent calls cannot cross their replies.
 */
const hostPending = new Map();
let nextHostId = 1;
const skw = Object.freeze({
  call(op, args = {}) {
    if (typeof op !== 'string' || op === '') return Promise.reject(new Error('skw.call needs an operation name'));
    const id = `c${nextHostId++}`;
    return new Promise((resolve, reject) => {
      hostPending.set(id, { resolve, reject });
      process.stdout.write(`${JSON.stringify({ type: 'host', id, op, args })}\n`);
    });
  },
});
// A global, documented name: the package is imported as a file URL and has no package.json
// of its own to resolve a specifier through, so an injected module would be a second
// resolution rule. One frozen object is the whole surface.
Object.defineProperty(globalThis, 'skw', { value: skw, enumerable: false, writable: false, configurable: false });

try {
  // A file URL, because the package lives on an absolute path the runner resolved from its
  // manifest — not a bare specifier that would resolve through `node_modules`.
  mod = await import(pathToFileURL(entry).href);
} catch (err) {
  process.stdout.write(`${JSON.stringify({ ready: false, error: String(err) })}\n`);
  process.exit(1);
}

const handler = typeof mod.handle === 'function' ? mod.handle : typeof mod.default === 'function' ? mod.default : null;
if (handler === null) {
  process.stdout.write(`${JSON.stringify({ ready: false, error: 'the package exports no handle()' })}\n`);
  process.exit(1);
}

process.stdout.write(
  `${JSON.stringify({
    ready: true,
    node: process.version,
    // A witness the gate can read: with `--permission` on, `process.permission` exists and
    // `has('fs.read')` is true only inside the two granted roots.
    permission: typeof process.permission?.has === 'function',
    fs_read: typeof process.permission?.has === 'function' ? process.permission.has('fs.read') : false,
  })}\n`,
);

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', (line) => {
  if (line.trim() === '') return;
  let request;
  try {
    request = JSON.parse(line);
  } catch (err) {
    process.stdout.write(`${JSON.stringify({ id: null, ok: false, code: 'SKW_E_PL_ROW', message: `bad JSON: ${String(err)}` })}\n`);
    return;
  }
  if (request.type === 'host.result') {
    const waiter = hostPending.get(String(request.id));
    if (waiter === undefined) return;
    hostPending.delete(String(request.id));
    if (request.ok === true) waiter.resolve(request.result ?? null);
    else waiter.reject(new Error(`${String(request.code ?? 'SKW_E_PL_UNAVAILABLE')}: ${String(request.message ?? '')}`));
    return;
  }
  void run(request);
});

async function run(request) {
  try {
    const result = await handler(request.op, request.args ?? {});
    process.stdout.write(`${JSON.stringify({ id: request.id, ok: true, result: result ?? null })}\n`);
  } catch (err) {
    // The plugin's own failure is reported, never swallowed: a widget that throws is a
    // plugin error the operator has to see, and the runner names the plugin around it.
    // A **host** refusal that the package let escape keeps its own code: the operator needs
    // `PL_REJECTED`/`PL_NO_TABLE`, not a generic wrapper around it.
    const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    const match = /(SKW_E_[A-Z0-9_]+):\s*([\s\S]*)$/.exec(text);
    process.stdout.write(
      `${JSON.stringify({
        id: request.id,
        ok: false,
        code: match?.[1] ?? 'SKW_E_PL_PLUGIN_ERROR',
        message: match?.[2] ?? text,
      })}\n`,
    );
  }
}
