/**
 * The plugin runner (§8.4, D26, C-8) — the fourth compose service.
 *
 * It binds **one unix socket** (`/srv/run/plugin.sock`), loads every package under
 * `/srv/plugins/<id>/` **at runtime, from outside the source tree**, and spawns one
 * `node --permission` child per package with:
 *
 *     --allow-fs-read=/srv/runner/child.mjs
 *     --allow-fs-read=/srv/plugins/<id>
 *     --allow-fs-read=/srv/scratch/<id>
 *
 * and **no** `--allow-addons`, `--allow-child-process` or `--allow-worker`. The container is
 * `network_mode: none` with `cap_drop: [ALL]`, `read_only: true` and `pids_limit: 64`; that is
 * the layer that stops a socket, because Node's permission model does not cover `net`
 * (§8.4, measured twice).
 *
 * ## What this slice does and does not do
 *
 * Implemented and proven here: the socket, the manifest validation, the capability gate, the
 * child spawn, the four ops that need no host (`util.now`, `util.random`, `util.hash`,
 * `log.write`), `plugin.invoke` (how a plugin's code actually runs), the 2 s op budget, and a
 * named refusal for every failure.
 *
 * **Not** implemented: the ten ops that need the host (`store.*`, `settings.*`,
 * `assets.resolve`, `mail.send`). They are authorised against the manifest and then refused
 * with `SKW_E_PL_UNAVAILABLE` because the app-side client (the other end of this socket) is
 * not wired yet — `app/main.ts` step 6 still says "S4 owns the plugin runner". A runner that
 * pretended to answer `store.insert` by writing a file would be a second, unaudited data
 * path; the refusal is the honest half.
 *
 * ## Every refusal names the plugin
 *
 * A refusal an operator cannot attribute to a package is a refusal they cannot act on. The
 * `plugin` field is on every response, including the ones about an op the package did not
 * declare.
 */
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';

const SOCKET = process.env.SKW_RUNNER_SOCKET ?? '/srv/run/plugin.sock';
const PLUGINS = process.env.SKW_PLUGINS_DIR ?? '/srv/plugins';
const SCRATCH = process.env.SKW_SCRATCH_DIR ?? '/srv/scratch';
/** §15.3: a plugin RPC op has 2 s. A child that misses it is killed and marked unavailable. */
const OP_TIMEOUT_MS = 2000;
/** The child's own start-up (module graph + handshake), measured at 0.19 s cold per child. */
const READY_TIMEOUT_MS = 10_000;

/** The 14 operations of §8.3, split by who answers them. */
const LOCAL_OPS = new Set(['util.now', 'util.random', 'util.hash', 'log.write']);
const HOST_OPS = new Set([
  'store.insert',
  'store.update',
  'store.delete',
  'store.query',
  'store.count',
  'settings.get',
  'settings.has',
  'settings.set',
  'assets.resolve',
  'mail.send',
]);
const ALL_OPS = new Set([...LOCAL_OPS, ...HOST_OPS]);

const PLUGIN_ID = /^[a-z][a-z0-9]{1,19}$/;
const TABLE = /^p_[a-z0-9]{1,20}_[a-z0-9_]+$/;

function log(line) {
  process.stdout.write(`runner: ${line}\n`);
}

function refused(id, plugin, code, message) {
  log(`refusal plugin=${plugin ?? '-'} code=${code}: ${message}`);
  return `${JSON.stringify({ id: id ?? null, ok: false, plugin, code, message })}\n`;
}

/** Manifest validation — the only place a package's claims become the runner's limits. */
function readManifest(dir) {
  const path = join(dir, 'plugin.json');
  if (!existsSync(path)) throw new Error(`${dir} has no plugin.json`);
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof raw.id !== 'string' || !PLUGIN_ID.test(raw.id)) throw new Error(`${dir}: plugin id ${JSON.stringify(raw.id)} is not ${PLUGIN_ID}`);
  if (typeof raw.version !== 'string' || raw.version === '') throw new Error(`${raw.id}: no version`);
  if (typeof raw.entry !== 'string' || raw.entry.includes('..') || raw.entry.startsWith('/')) {
    throw new Error(`${raw.id}: entry ${JSON.stringify(raw.entry)} is not a relative path inside the package`);
  }
  if (!existsSync(join(dir, raw.entry))) throw new Error(`${raw.id}: entry ${raw.entry} does not exist`);
  const capabilities = Array.isArray(raw.capabilities) ? raw.capabilities.map(String) : [];
  for (const op of capabilities) {
    // A manifest that declares an op the protocol does not have is a package built against a
    // different runner; refusing at load is the only place it can be said once.
    if (!ALL_OPS.has(op)) throw new Error(`${raw.id}: capability ${JSON.stringify(op)} is not one of the 14 operations`);
  }
  const tables = Array.isArray(raw.tables) ? raw.tables : [];
  for (const table of tables) {
    if (typeof table.name !== 'string' || !TABLE.test(table.name)) throw new Error(`${raw.id}: table ${JSON.stringify(table.name)} is not p_<id>_<name>`);
    if (!table.name.startsWith(`p_${raw.id.replace(/[^a-z0-9]/g, '')}_`)) {
      throw new Error(`${raw.id}: table ${table.name} is not in this plugin's namespace`);
    }
  }
  return { id: raw.id, version: raw.version, entry: raw.entry, capabilities, tables };
}

/** id -> { manifest, dir, child, ready, scratch, pending, nextId } */
const packages = new Map();

function load() {
  if (!existsSync(PLUGINS)) {
    log(`no plugins directory at ${PLUGINS}; serving an empty registry`);
    return;
  }
  for (const name of readdirSync(PLUGINS).sort()) {
    const dir = join(PLUGINS, name);
    if (!statSync(dir).isDirectory()) continue;
    let manifest;
    try {
      manifest = readManifest(dir);
    } catch (err) {
      // A package the runner cannot validate is not loaded, and says why. It is not a
      // reason to refuse the others: one bad widget must not take the site's forms down.
      log(`refused package ${name}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const scratch = join(SCRATCH, manifest.id);
    mkdirSync(scratch, { recursive: true });
    packages.set(manifest.id, { manifest, dir, child: null, ready: false, scratch, pending: new Map(), nextId: 1 });
    log(`loaded ${manifest.id} ${manifest.version} (${manifest.capabilities.length} capabilit${manifest.capabilities.length === 1 ? 'y' : 'ies'})`);
  }
}

/**
 * The child, with the permission set of §8.4. `--permission` denies fs by default; the two
 * `--allow-fs-read` roots are the package and its scratch. Addons, child processes and
 * workers stay off — the flags are absent, not set to false, because the absence is the
 * control.
 */
function startChild(pkg) {
  const entry = join(pkg.dir, pkg.manifest.entry);
  const child = spawn(
    process.execPath,
    [
      '--permission',
      '--allow-fs-read=/srv/runner/child.mjs',
      `--allow-fs-read=${pkg.dir}`,
      `--allow-fs-read=${pkg.scratch}`,
      '/srv/runner/child.mjs',
      entry,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', NODE_ENV: 'production' } },
  );
  pkg.child = child;

  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('handshake timed out')), READY_TIMEOUT_MS);
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let index = buffer.indexOf('\n');
      while (index !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf('\n');
        if (line.trim() === '') continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id === undefined) {
          clearTimeout(timer);
          if (message.ready === true) resolve();
          else reject(new Error(String(message.error ?? 'the package did not start')));
          continue;
        }
        const waiter = pkg.pending.get(message.id);
        if (waiter === undefined) continue;
        pkg.pending.delete(message.id);
        clearTimeout(waiter.timer);
        if (message.ok === true) waiter.resolve(message.result ?? null);
        else waiter.reject(new Error(`${String(message.code ?? 'SKW_E_PL_PLUGIN_ERROR')}: ${String(message.message ?? '')}`));
      }
    });
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    // The plugin's stderr is not the operator's log by default (§8.3: `log.write` is the
    // channel, ≤ 1 KiB, ≤ 100 lines/min). Anything here is a hard failure worth seeing once.
    log(`plugin ${pkg.manifest.id} stderr: ${chunk.trim().slice(0, 400)}`);
  });

  child.on('exit', (code, signal) => {
    pkg.ready = false;
    for (const waiter of pkg.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`SKW_E_PL_UNAVAILABLE: plugin ${pkg.manifest.id} exited (${String(code ?? signal)})`));
    }
    pkg.pending.clear();
    log(`plugin ${pkg.manifest.id} exited (${String(code ?? signal)})`);
  });

  ready.then(
    () => {
      pkg.ready = true;
      log(`plugin ${pkg.manifest.id} ready`);
    },
    (err) => {
      pkg.ready = false;
      log(`plugin ${pkg.manifest.id} failed to start: ${err.message}`);
    },
  );
}

/** One request to the child, with the 2 s budget. */
function ask(pkg, op, args) {
  if (pkg.child === null || !pkg.ready) {
    return Promise.reject(new Error(`SKW_E_PL_UNAVAILABLE: plugin ${pkg.manifest.id} is not ready`));
  }
  const id = pkg.nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pkg.pending.delete(id);
      // §15.3: a child that misses its op budget is killed. Leaving it running is how one
      // plugin starves its co-tenants inside the one shared cgroup (§14 F4).
      pkg.child?.kill('SIGKILL');
      reject(new Error(`SKW_E_PL_UNAVAILABLE: plugin ${pkg.manifest.id} exceeded ${OP_TIMEOUT_MS} ms on ${op}`));
    }, OP_TIMEOUT_MS);
    pkg.pending.set(id, { resolve, reject, timer });
    pkg.child?.stdin.write(`${JSON.stringify({ id, op, args })}\n`);
  });
}

/** The four ops that need no host. Everything else is the host's (§8.3). */
function local(op, args) {
  switch (op) {
    case 'util.now':
      return new Date().toISOString();
    case 'util.random': {
      const n = Number(args.n ?? 16);
      if (!Number.isInteger(n) || n < 1 || n > 32) throw new Error('SKW_E_PL_ROW: util.random n must be 1..32');
      return randomBytes(n).toString('hex');
    }
    case 'util.hash': {
      const algo = String(args.algo ?? 'sha256');
      if (algo !== 'sha256' && algo !== 'sha512') throw new Error('SKW_E_PL_ROW: util.hash algo must be sha256 or sha512');
      const data = String(args.data ?? '');
      if (Buffer.byteLength(data) > 1024) throw new Error('SKW_E_PL_TOO_LARGE: util.hash data is capped at 1 KiB');
      return createHash(algo).update(data).digest('hex');
    }
    case 'log.write': {
      const msg = String(args.msg ?? '').slice(0, 1024);
      log(`plugin log [${String(args.level ?? 'info')}] ${msg}`);
      return null;
    }
    default:
      throw new Error(`SKW_E_PL_REJECTED: ${op} is not a local op`);
  }
}

/** One line in, one reply out. `invoke` is the asynchronous branch. */
function handle(line) {
  let request;
  try {
    request = JSON.parse(line);
  } catch (err) {
    return { reply: refused(null, null, 'SKW_E_PL_ROW', `not JSON: ${String(err)}`), close: false };
  }
  const id = request.id ?? null;
  const op = typeof request.op === 'string' ? request.op : '';

  if (op === 'plugin.list') {
    return {
      reply: `${JSON.stringify({
        id,
        ok: true,
        result: [...packages.values()].map((p) => ({
          id: p.manifest.id,
          version: p.manifest.version,
          ready: p.ready,
          capabilities: p.manifest.capabilities,
        })),
      })}\n`,
      close: false,
    };
  }

  const name = typeof request.plugin === 'string' ? request.plugin : '';
  const pkg = packages.get(name);
  if (pkg === undefined) {
    return { reply: refused(id, name === '' ? null : name, 'SKW_E_PL_UNAVAILABLE', `no package ${JSON.stringify(name)}`), close: false };
  }

  if (op === 'plugin.invoke') {
    // `plugin.invoke` runs the package's **own** code; `args.op` is that package's entrypoint
    // name, not one of the 14 RPC ops. The capability gate applies to the ops the plugin
    // *calls* (below), which is where the manifest is the grant.
    const inner = request.args ?? {};
    const innerOp = typeof inner.op === 'string' ? inner.op : '';
    if (innerOp === '') return { reply: refused(id, name, 'SKW_E_PL_ROW', 'plugin.invoke needs args.op'), close: false };
    return { reply: '', close: false, invoke: { id, pkg, op: innerOp, args: inner.args ?? {} } };
  }

  if (!ALL_OPS.has(op)) {
    // §8.3: an unknown op is `PL_REJECTED` and closes the channel.
    return { reply: refused(id, name, 'SKW_E_PL_REJECTED', `unknown op ${JSON.stringify(op)}`), close: true };
  }
  if (!pkg.manifest.capabilities.includes(op)) {
    return { reply: refused(id, name, 'SKW_E_PL_REJECTED', `${op} is not in ${name}'s declared capabilities`), close: false };
  }
  if (HOST_OPS.has(op)) {
    return {
      reply: refused(id, name, 'SKW_E_PL_UNAVAILABLE', `${op} needs the host client, which is not wired in this slice`),
      close: false,
    };
  }
  try {
    return { reply: `${JSON.stringify({ id, ok: true, plugin: name, result: local(op, request.args ?? {}) })}\n`, close: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = message.startsWith('SKW_E_') ? message.slice(0, message.indexOf(':')) : 'SKW_E_PL_ROW';
    return { reply: refused(id, name, code, message), close: false };
  }
}

function attach(socket) {
  socket.setEncoding('utf8');
  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf('\n');
      if (line.trim() === '') continue;
      const result = handle(line);
      if (result.invoke !== undefined) {
        const { id, pkg, op, args } = result.invoke;
        ask(pkg, op, args).then(
          (value) => socket.write(`${JSON.stringify({ id, ok: true, plugin: pkg.manifest.id, result: value ?? null })}\n`),
          (err) => {
            const message = err instanceof Error ? err.message : String(err);
            const code = message.startsWith('SKW_E_') ? message.slice(0, message.indexOf(':')) : 'SKW_E_PL_PLUGIN_ERROR';
            socket.write(refused(id, pkg.manifest.id, code, message));
          },
        );
        continue;
      }
      socket.write(result.reply);
      if (result.close) socket.end();
    }
  });
  socket.on('error', (err) => log(`socket error: ${err.message}`));
}

// --- boot ------------------------------------------------------------------------------
load();
for (const pkg of packages.values()) startChild(pkg);

if (existsSync(SOCKET)) rmSync(SOCKET, { force: true });
mkdirSync(dirname(SOCKET), { recursive: true });
const server = createServer(attach);
server.listen(SOCKET, () => {
  log(`listening on ${SOCKET} (${packages.size} package(s), version ${process.env.SKW_RUNNER_VERSION ?? 'dev'})`);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    log(`${signal}: closing`);
    for (const pkg of packages.values()) pkg.child?.kill('SIGKILL');
    server.close(() => {
      rmSync(SOCKET, { force: true });
      process.exit(0);
    });
  });
}
