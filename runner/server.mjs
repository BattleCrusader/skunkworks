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
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';

const SOCKET = process.env.SKW_RUNNER_SOCKET ?? '/srv/run/plugin.sock';
const PLUGINS = process.env.SKW_PLUGINS_DIR ?? '/srv/plugins';
const SCRATCH = process.env.SKW_SCRATCH_DIR ?? '/srv/scratch';
/** Where `child.mjs` lives. A constant in the image; overridable so a gate can run the
 *  same server on the host, which is the only place the app-side socket is reachable on
 *  Docker Desktop (a socket created inside the VM is not connectable from the host). */
const RUNNER_HOME = process.env.SKW_RUNNER_HOME ?? '/srv/runner';
/** §15.3: a plugin RPC op has 2 s. A child that misses it is killed and marked unavailable. */
const OP_TIMEOUT_MS = 2000;
/** The child's own start-up (module graph + handshake), measured at 0.19 s cold per child. */
const READY_TIMEOUT_MS = 10_000;
/**
 * S4e (F4): the two memory controls, in the order they bite.
 *
 *   - `--max-old-space-size` caps the child's **JS heap** so an object graph that grows
 *     without bound dies inside V8 with a message rather than dragging the cgroup to its
 *     ceiling. 64 MiB is ~1.4× the measured idle child (38–43 MiB) and leaves room for a
 *     page-sized response.
 *   - the **cgroup** (compose's `mem_limit: 384m`, mirrored by the gate's `--memory`) is the
 *     backstop for memory V8 does not count — Buffers, ArrayBuffers, native strings. That is
 *     the one that kills a hoard, and it kills only the hoarding child.
 *
 * Neither is a per-plugin accounting scheme (§13.3's honest limitation stands): one cgroup,
 * shared. What changed in S4e is that the shared cgroup now has a ceiling and the failure is
 * named.
 */
const CHILD_HEAP_MB = Number(process.env.SKW_CHILD_HEAP_MB ?? 64);
const RUNNER_MEMORY_MB = Number(process.env.SKW_RUNNER_MEMORY_MB ?? 384);
/** A package that dies is restarted; five deaths in a minute is a broken package, not a blip. */
const RESTART_WINDOW_MS = 60_000;
const RESTART_MAX = 5;

/**
 * The cgroup's OOM-kill counter, or null where there is no cgroup v2 (a host-side run).
 * Reading the counter *before* the spawn and *after* the exit is what tells an OOM kill
 * apart from the 2 s timeout, which also ends in SIGKILL.
 */
function cgroupOomKills() {
  try {
    const text = readFileSync('/sys/fs/cgroup/memory.events', 'utf8');
    const match = /^oom_kill (\d+)$/m.exec(text);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

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

/** id -> { manifest, dir, child, ready, scratch, pending, hostPending, binding, queue, nextId, nextHostId, oomBase, restarts, givenUp } */
const packages = new Map();
/** Set on SIGTERM/SIGINT: no child is restarted while the container is going down. */
let shuttingDown = false;

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
    packages.set(manifest.id, {
      manifest,
      dir,
      child: null,
      ready: false,
      scratch,
      pending: new Map(),
      hostPending: new Map(),
      binding: null,
      queue: Promise.resolve(),
      nextId: 1,
      nextHostId: 1,
      /** The cgroup's oom_kill count at the moment this child was spawned. */
      oomBase: cgroupOomKills(),
      heapOom: false,
      restarts: [],
      givenUp: false,
    });
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
  // `realpath`, because on macOS a temp directory is `/var/…` (a symlink to `/private/var/…`)
  // and `--permission` compares the **resolved** path of the loaded module with the granted
  // roots. In the container `/srv/…` is already real; on a host test this is the difference
  // between a loaded package and "Access to this API has been restricted".
  const grantedDir = realpathSync(pkg.dir);
  const grantedScratch = realpathSync(pkg.scratch);
  const child = spawn(
    process.execPath,
    [
      '--permission',
      // S4e: the child's JS heap ceiling. Absent this, V8 grows to the cgroup's OOM killer
      // (or to the default ~4 GB on a host run) and the operator sees only "exited".
      `--max-old-space-size=${CHILD_HEAP_MB}`,
      `--allow-fs-read=${realpathSync(join(RUNNER_HOME, 'child.mjs'))}`,
      `--allow-fs-read=${grantedDir}`,
      `--allow-fs-read=${grantedScratch}`,
      realpathSync(join(RUNNER_HOME, 'child.mjs')),
      realpathSync(entry),
    ],
    { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', NODE_ENV: 'production' } },
  );
  pkg.child = child;
  pkg.oomBase = cgroupOomKills();
  // The heap cap is a flag, and a flag nobody can read is a comment. One line names it, so a
  // gate (and an operator reading `docker logs`) can see what the child was actually given.
  log(`plugin ${pkg.manifest.id} child pid ${child.pid} heap=${CHILD_HEAP_MB}MiB permission=on`);

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
        if (message.type === 'host') {
          // The package's code is asking the **host** for one of the ten ops. It is
          // forwarded on the very connection that requested this invoke, so the tenant is
          // the caller's binding and never a field the package wrote (§8.3).
          forwardHost(pkg, message).then(
            (result) => {
              pkg.child?.stdin.write(`${JSON.stringify({ type: 'host.result', id: message.id, ok: true, result: result ?? null })}\n`);
            },
            (err) => {
              const text = err instanceof Error ? err.message : String(err);
              const { code, detail } = splitCode(text, 'SKW_E_PL_UNAVAILABLE');
              pkg.child?.stdin.write(`${JSON.stringify({ type: 'host.result', id: message.id, ok: false, code, message: detail })}\n`);
            },
          );
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
    const text = chunk.trim();
    // S4e: V8's own heap-limit abort is the other way a greedy plugin dies. It is not a
    // cgroup OOM kill (the kernel never sees it), so the exit handler needs this flag to
    // report `PL_OOM` rather than a bare `SIGABRT`.
    if (/heap out of memory|Reached heap limit|Allocation failed/i.test(text)) pkg.heapOom = true;
    log(`plugin ${pkg.manifest.id} stderr: ${text.slice(0, 400)}`);
  });

  child.on('exit', (code, signal) => {
    // A superseded child (a restart already spawned a new one) must not touch the package.
    if (pkg.child !== child) return;
    pkg.ready = false;
    const now = cgroupOomKills();
    const killedByOom = (now !== null && pkg.oomBase !== null && now > pkg.oomBase) || pkg.heapOom === true;
    pkg.oomBase = now;
    pkg.heapOom = false;
    for (const waiter of pkg.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(
        new Error(
          killedByOom
            ? `SKW_E_PL_OOM: plugin ${pkg.manifest.id} was killed at the runner's ${RUNNER_MEMORY_MB} MiB cgroup while running ${waiter.op ?? 'an op'}`
            : `SKW_E_PL_UNAVAILABLE: plugin ${pkg.manifest.id} exited (${String(code ?? signal)})`,
        ),
      );
    }
    pkg.pending.clear();
    log(
      `plugin ${pkg.manifest.id} exited (${String(code ?? signal)})${killedByOom ? ` after an OOM kill at ${RUNNER_MEMORY_MB} MiB` : ''}`,
    );
    // §8.6's crash/hang row: a dead child is restarted, so one slow or greedy op does not
    // disable the package until the container restarts (the S4 QA's §4.8). A package that
    // dies five times in a minute is broken, not unlucky: after that it stays down and every
    // call says so.
    if (shuttingDown || pkg.givenUp) return;
    const at = Date.now();
    pkg.restarts = pkg.restarts.filter((t) => at - t < RESTART_WINDOW_MS);
    if (pkg.restarts.length >= RESTART_MAX) {
      pkg.givenUp = true;
      log(`plugin ${pkg.manifest.id} died ${RESTART_MAX} times in ${RESTART_WINDOW_MS / 1000} s; not restarting again`);
      return;
    }
    pkg.restarts.push(at);
    setTimeout(() => {
      if (!shuttingDown && pkg.child === child) startChild(pkg);
    }, 250).unref();
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
    pkg.pending.set(id, { resolve, reject, timer, op });
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

/** `SKW_E_X: detail` -> {code, detail}. The code crosses three processes; it must not double. */
function splitCode(text, fallback) {
  const match = /^(SKW_E_[A-Z0-9_]+):\s*([\s\S]*)$/.exec(String(text));
  if (match === null) return { code: fallback, detail: String(text) };
  return { code: match[1], detail: match[2] };
}

/** The runner -> host hop's budget. The host answers from a local `site.db`. */
const HOST_TIMEOUT_MS = 2000;

/**
 * One host op, forwarded to the connection that requested the current invoke.
 *
 * The binding is set by `invokeSerial()` and cleared in its `finally`; a child that asks
 * for `store.query` outside an invoke gets `PL_UNAVAILABLE` rather than a guess about
 * which tenant it meant.
 */
function forwardHost(pkg, frame) {
  const binding = pkg.binding;
  if (binding === null || binding.socket === null) {
    return Promise.reject(new Error('SKW_E_PL_UNAVAILABLE: no host channel is bound to this invoke'));
  }
  const socket = binding.socket;
  const id = `h${pkg.nextHostId++}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.hostPending.delete(id);
      reject(new Error(`SKW_E_PL_UNAVAILABLE: host op ${String(frame.op)} exceeded ${HOST_TIMEOUT_MS} ms`));
    }, HOST_TIMEOUT_MS);
    socket.hostPending.set(id, { resolve, reject, timer });
    socket.write(
      `${JSON.stringify({ type: 'host.call', id, tenant: binding.tenant, plugin: pkg.manifest.id, op: frame.op, args: frame.args ?? {} })}\n`,
    );
  });
}

/**
 * §14 F4: one package has one in-flight invoke. The tenant binding is a property of
 * that invoke, so two tenants calling the same widget at once cannot have their host
 * ops routed to each other's database. The queue is per package, not per container.
 */
function invokeSerial(pkg, tenant, op, args, socket) {
  const run = async () => {
    pkg.binding = { tenant, socket };
    try {
      return await ask(pkg, op, args);
    } finally {
      for (const [id, waiter] of socket.hostPending) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error('SKW_E_PL_UNAVAILABLE: the invoke that bound this host channel ended'));
        socket.hostPending.delete(id);
      }
      pkg.binding = null;
    }
  };
  const next = pkg.queue.then(run, run);
  pkg.queue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

/** One line in, one reply out. `invoke` is the asynchronous branch. */
function handle(line, socket) {
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
    // The tenant binding is the caller's, not the package's (§8.3). A host op raised by the
    // package during this invoke is answered against this tenant and no other.
    const tenant = typeof request.tenant === 'string' ? request.tenant : '';
    if (tenant === '') {
      return { reply: refused(id, name, 'SKW_E_PL_ROW', 'plugin.invoke needs the host tenant binding'), close: false };
    }
    return { reply: '', close: false, invoke: { id, pkg, op: innerOp, args: inner.args ?? {}, tenant, socket } };
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
  socket.hostPending = new Map();
  let buffer = '';
  socket.on('data', (chunk) => {
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
        message = null;
      }
      if (message !== null && message.type === 'host.result') {
        const waiter = socket.hostPending.get(String(message.id));
        if (waiter !== undefined) {
          socket.hostPending.delete(String(message.id));
          clearTimeout(waiter.timer);
          if (message.ok === true) waiter.resolve(message.result ?? null);
          else waiter.reject(new Error(`${String(message.code ?? 'SKW_E_PL_UNAVAILABLE')}: ${String(message.message ?? '')}`));
        }
        continue;
      }
      const result = handle(line, socket);
      if (result.invoke !== undefined) {
        const { id, pkg, op, args, tenant } = result.invoke;
        invokeSerial(pkg, tenant, op, args, socket).then(
          (value) => socket.write(`${JSON.stringify({ id, ok: true, plugin: pkg.manifest.id, result: value ?? null })}\n`),
          (err) => {
            const message = err instanceof Error ? err.message : String(err);
            const { code, detail } = splitCode(message, 'SKW_E_PL_PLUGIN_ERROR');
            socket.write(refused(id, pkg.manifest.id, code, detail));
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
// S4e: the app runs as uid 10001 and this process as 65534, so a socket created under the
// image's umask (022 ⇒ 0755) is one the app can see and cannot connect to — a composed stack
// in which `plugins.connect()` is always false. The mode is set at **creation** by a zero
// umask rather than by `chmod` afterwards: on a bind mount that is not a Linux filesystem
// (Docker Desktop's virtiofs returns EINVAL for `chmod` on a socket — measured), the
// afterwards form silently leaves 0755. 0666 is the narrowest mode that works across two
// uids: the file lives inside the `run/` volume both containers mount.
const restoreUmask = process.umask(0o000);
server.listen(SOCKET, () => {
  process.umask(restoreUmask);
  try {
    chmodSync(SOCKET, 0o666);
  } catch {
    // virtiofs: the socket already has 0666 from the zero umask, and there is nothing to fix.
  }
  log(`listening on ${SOCKET} (${packages.size} package(s), version ${process.env.SKW_RUNNER_VERSION ?? 'dev'})`);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    shuttingDown = true;
    log(`${signal}: closing`);
    for (const pkg of packages.values()) pkg.child?.kill('SIGKILL');
    server.close(() => {
      rmSync(SOCKET, { force: true });
      process.exit(0);
    });
  });
}
