/**
 * S4f item 2 — **capabilities enforced twice, and each layer proved on its own.**
 *
 * S4e's report §8 named the gap plainly: `forwardHost()` in the runner forwarded whatever
 * the child asked for, and `app/plugins/host.ts` re-checked it. One line of defence, in the
 * process that trusts the package least, for a child that is the least trusted thing in the
 * system. A bug in the host's one `if` was the whole distance between a plugin and the
 * tenant's rows.
 *
 * This gate proves the two layers **separately**, which is the only way a second layer can
 * be said to exist:
 *
 *   C1  **the runner, with no host at all.** A raw socket client plays the app: it sends
 *       `plugin.invoke` with a grant that excludes `store.insert` and drives the package's
 *       `save` op, which calls `store.insert`. The invoke must fail `PL_REJECTED` naming the
 *       op, and the client must receive **zero** `host.call` frames — the host was never
 *       asked. The positive control in the same case grants the op and watches the frame
 *       arrive, so "no frames" is a property of the grant and not of a broken client.
 *
 *   C2  **the host, with no runner at all.** A fake runner accepts the app's connection and
 *       writes `host.call` frames itself — exactly what a compromised or buggy runner would
 *       do — for an op the package's manifest does not declare. The host must answer
 *       `ok:false` `PL_REJECTED`. Its positive control sends a declared op and gets a row
 *       back, so the refusal is the capability check and not a general failure.
 *
 * Neither case can pass by way of the other: C1 has no `host.ts` in the loop and C2 has no
 * `server.mjs` in the loop.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer, connect, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { installPlugin } from '../app/plugins/install.ts';
import { PluginHost } from '../app/plugins/host.ts';
import { packageRootHash } from '../app/plugins/protocol.ts';
import { openAdminWrite } from '../app/db/classes.ts';
import { REPO, makeFixture, type Fixture } from './helpers/fixture.ts';

const RUNNER_DIGEST = 'sha256:s4f-capability';
const PLUGIN_SRC = join(REPO, 'test', 'fixtures', 'plugins', 'notes');

let fixture: Fixture;
let pluginsRoot = '';
let scratchRoot = '';
let runner: ChildProcess | null = null;
let runnerSocket = '';
let runnerLog = '';

function waitFor(predicate: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      if (predicate()) return resolve();
      if (Date.now() > deadline) return reject(new Error(`timed out waiting for ${what}`));
      setTimeout(tick, 40);
    };
    tick();
  });
}

interface Frame {
  [key: string]: unknown;
}

/**
 * A client that plays the app's end of the socket, and records every frame the runner
 * sends — `host.call` frames included, which is how the runner's own gate is observed.
 */
class RawClient {
  readonly socket: Socket;
  readonly frames: Frame[] = [];
  private buffer = '';
  private autoTimer: NodeJS.Timeout | null = null;
  constructor(path: string) {
    this.socket = connect(path);
    this.socket.setEncoding('utf8');
    // A refused connect is the test's problem to report, not an unhandled 'error' event.
    this.socket.on('error', () => undefined);
    this.socket.on('data', (chunk: string) => {
      this.buffer += chunk;
      let index = this.buffer.indexOf('\n');
      while (index !== -1) {
        const line = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 1);
        index = this.buffer.indexOf('\n');
        if (line.trim() === '') continue;
        this.frames.push(JSON.parse(line) as Frame);
      }
    });
  }

  get hostCalls(): Frame[] {
    return this.frames.filter((f) => f.type === 'host.call');
  }

  send(frame: Frame): void {
    this.socket.write(`${JSON.stringify(frame)}\n`);
  }

  async reply(id: string, body: Record<string, unknown>): Promise<void> {
    this.send({ type: 'host.result', id, ...body });
  }

  /**
   * Answer every `host.call` the way a cooperative host would. The interesting refusal then
   * comes from the *next* call — the one the runner declines to forward — so the package
   * gets that refusal as its own error and the invoke ends where the gate is.
   */
  autoAnswer(result: unknown): void {
    const answered = new Set<string>();
    this.autoTimer = setInterval(() => {
      for (const call of this.hostCalls) {
        const id = String(call.id);
        if (answered.has(id)) continue;
        answered.add(id);
        this.send({ type: 'host.result', id, ok: true, result });
      }
    }, 10);
    this.autoTimer.unref();
  }

  async answer(id: number, ms = 10_000): Promise<Frame> {
    await waitFor(() => this.frames.some((f) => f.id === id && f.type !== 'host.call'), ms, `reply ${id}`);
    return this.frames.find((f) => f.id === id && f.type !== 'host.call') as Frame;
  }

  close(): void {
    if (this.autoTimer !== null) clearInterval(this.autoTimer);
    this.socket.destroy();
  }
}

before(async () => {
  fixture = makeFixture({ specs: [{ key: 'acme', hosts: ['acme.test'] }] });
  pluginsRoot = join(fixture.dir, 'plugins');
  scratchRoot = join(fixture.dir, 'scratch');
  mkdirSync(scratchRoot, { recursive: true });
  const source = join(fixture.dir, 'source');
  cpSync(PLUGIN_SRC, source, { recursive: true });
  const root = packageRootHash(source).root;
  const report = join(fixture.dir, 'report.json');
  writeFileSync(
    report,
    JSON.stringify({ plugin: 'notes', version: '1.0.0', root_hash: root, runner_image_digest: RUNNER_DIGEST, ran_at: '2026-10-21T00:00:00.000Z' }),
  );
  installPlugin({
    siteDb: fixture.sitePath('acme'),
    pluginsRoot,
    sourceDir: source,
    testReportPath: report,
    runnerImageDigest: RUNNER_DIGEST,
    allowUnsigned: true,
    enable: true,
  });
  const db = openAdminWrite(fixture.sitePath('acme'), 5000);
  try {
    db.prepare(`INSERT INTO p_notes_note (body) VALUES ('a row the host can read')`).run();
  } finally {
    db.close();
  }

  runnerSocket = join(fixture.dir, 'run', 'plugin.sock');
  mkdirSync(join(fixture.dir, 'run'), { recursive: true });
  runner = spawn(process.execPath, [join(REPO, 'runner', 'server.mjs')], {
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      SKW_RUNNER_SOCKET: runnerSocket,
      SKW_PLUGINS_DIR: pluginsRoot,
      SKW_SCRATCH_DIR: scratchRoot,
      SKW_RUNNER_HOME: join(REPO, 'runner'),
      SKW_RUNNER_VERSION: 's4f-capability',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  runner.stdout?.setEncoding('utf8');
  runner.stderr?.setEncoding('utf8');
  runner.stdout?.on('data', (chunk: string) => (runnerLog += chunk));
  runner.stderr?.on('data', (chunk: string) => (runnerLog += chunk));
  await waitFor(() => existsSync(runnerSocket), 20_000, 'the runner socket');

  // The child handshake is asynchronous; `plugin.list` answers only once the registry is up.
  const probe = new RawClient(runnerSocket);
  try {
    await waitFor(
      () => {
        probe.send({ id: 0, op: 'plugin.list' });
        const listed = probe.frames.filter((f) => f.id === 0).pop() as { result?: { ready: boolean }[] } | undefined;
        return listed?.result?.[0]?.ready === true;
      },
      20_000,
      'the package to be ready',
    );
  } finally {
    probe.close();
  }
});

after(() => {
  runner?.kill('SIGKILL');
  fixture?.cleanup();
});

test('C1 — the runner refuses an ungranted host op itself, before the host is called', async () => {
  assert.ok(runner !== null);
  const client = new RawClient(runnerSocket);
  try {
    // `save` calls `settings.get` and then `store.insert`. The grant carries only the read;
    // the read is answered normally, so the refusal is about `store.insert` alone.
    client.autoAnswer(null);
    client.send({
      id: 1,
      op: 'plugin.invoke',
      plugin: 'notes',
      tenant: 'acme',
      granted: ['settings.get', 'store.query'],
      args: { op: 'save', args: { body: 'written by a package that was not granted insert' } },
    });
    const reply = await client.answer(1);
    assert.equal(reply.ok, false, `the invoke must fail at the runner:\n${JSON.stringify(reply)}`);
    assert.equal(reply.code, 'SKW_E_PL_REJECTED');
    assert.match(String(reply.message), /store\.insert is not in notes's granted capabilities at the runner/);

    // The proof that this was the runner's layer: the host (this client) was never asked for
    // `store.insert` — the only frame that crossed the socket is the granted read.
    assert.equal(client.hostCalls.length, 1, `expected exactly one forwarded call, got ${JSON.stringify(client.hostCalls)}`);
    assert.equal(client.hostCalls[0]?.op, 'settings.get');
    assert.ok(
      client.hostCalls.every((f) => f.op !== 'store.insert'),
      `the runner forwarded an op it did not grant: ${JSON.stringify(client.hostCalls)}`,
    );
  } finally {
    client.close();
  }
});

test('C1b — the same invoke succeeds when the grant includes the op: the gate is not "refuse everything"', async () => {
  const client = new RawClient(runnerSocket);
  try {
    client.autoAnswer({ ok: true, id: 41 });
    client.send({
      id: 2,
      op: 'plugin.invoke',
      plugin: 'notes',
      tenant: 'acme',
      granted: ['store.insert', 'settings.get', 'store.query'],
      args: { op: 'save', args: { body: 'granted insert' } },
    });
    await waitFor(() => client.hostCalls.length >= 2, 10_000, 'both host calls');
    const ops = client.hostCalls.map((f) => f.op);
    assert.deepEqual(ops, ['settings.get', 'store.insert'], `expected both forward hops, got ${JSON.stringify(ops)}`);
    const reply = await client.answer(2);
    assert.equal(reply.ok, true, JSON.stringify(reply));
  } finally {
    client.close();
  }
});

test('C1c — a grant the app sends that is wider than the manifest is intersected, not trusted', async () => {
  const client = new RawClient(runnerSocket);
  try {
    // `notes` does not declare `mail.send`; an app claiming it must not widen the grant, and
    // the intersection here is empty — so the package's `store.query` never reaches the host.
    client.send({ id: 4, op: 'plugin.invoke', plugin: 'notes', tenant: 'acme', granted: ['mail.send'], args: { op: 'list', args: {} } });
    const narrowed = await client.answer(4);
    assert.equal(narrowed.ok, false, 'a grant emptied by the intersection must refuse the op the package calls');
    assert.equal(narrowed.code, 'SKW_E_PL_REJECTED');
    assert.match(String(narrowed.message), /store\.query is not in notes's granted capabilities/);
    assert.equal(client.hostCalls.length, 0, 'nothing may cross the socket when the grant is empty');
    assert.ok(runnerLog.includes('granted=0/5'), `the runner log must state the intersected size:\n${runnerLog}`);
  } finally {
    client.close();
  }
});

test('C2 — the host refuses an undeclared op even when the runner forwards it; the two layers are independent', async () => {
  // A fake runner: it accepts the app's connection and writes `host.call` frames itself. That
  // is precisely a compromised runner, so whatever `host.ts` does here it does without help.
  let accepted: Socket | null = null;
  const frames: Frame[] = [];
  const server: Server = createServer((socket) => {
    accepted = socket;
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let index = buffer.indexOf('\n');
      while (index !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf('\n');
        if (line.trim() === '') continue;
        frames.push(JSON.parse(line) as Frame);
      }
    });
  });
  const fakeSocket = join(fixture.dir, 'run', 'fake-runner.sock');
  mkdirSync(join(fixture.dir, 'run'), { recursive: true });
  await new Promise<void>((resolve) => server.listen(fakeSocket, resolve));

  const host = new PluginHost({ socketPath: fakeSocket, dataDir: fixture.dir, emailMode: 'off', log: () => undefined });
  try {
    assert.equal(await host.connect(), true);
    await waitFor(() => accepted !== null, 5000, 'the fake runner to accept');
    const channel = accepted as unknown as Socket;

    // The op `notes` never declared, sent as if the package had asked for it.
    channel.write(
      `${JSON.stringify({ type: 'host.call', id: 'h1', tenant: 'acme', plugin: 'notes', op: 'store.delete', args: { table: 'p_notes_note', id: 1 } })}\n`,
    );
    await waitFor(() => frames.some((f) => f.id === 'h1'), 5000, 'the host to answer the undeclared op');
    const refused = frames.find((f) => f.id === 'h1') as { ok: boolean; code: string; message: string };
    assert.equal(refused.ok, false, `the host must refuse an undeclared op:\n${JSON.stringify(refused)}`);
    assert.equal(refused.code, 'SKW_E_PL_REJECTED');
    assert.match(refused.message, /store\.delete is not in notes's declared capabilities/);

    // Positive control: a declared op is answered from the tenant's own database, so the
    // refusal above is the capability check and not the fake channel failing generally.
    channel.write(
      `${JSON.stringify({ type: 'host.call', id: 'h2', tenant: 'acme', plugin: 'notes', op: 'store.query', args: { table: 'p_notes_note', limit: 5 } })}\n`,
    );
    await waitFor(() => frames.some((f) => f.id === 'h2'), 5000, 'the host to answer the declared op');
    const allowed = frames.find((f) => f.id === 'h2') as { ok: boolean; result?: { rows: { body: string }[] } };
    assert.equal(allowed.ok, true, JSON.stringify(allowed));
    assert.equal(allowed.result?.rows[0]?.body, 'a row the host can read');

    // And the row the package would have deleted is still there: the refusal was not cosmetic.
    const db = openAdminWrite(fixture.sitePath('acme'), 5000);
    try {
      const count = db.prepare('SELECT COUNT(*) AS n FROM p_notes_note').get() as { n: number };
      assert.equal(count.n, 1);
    } finally {
      db.close();
    }
  } finally {
    host.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('C2b — an invoke with no grant on the wire is refused: the runner never falls back to the manifest', async () => {
  const client = new RawClient(runnerSocket);
  try {
    client.send({ id: 9, op: 'plugin.invoke', plugin: 'notes', tenant: 'acme', args: { op: 'list', args: {} } });
    const reply = await client.answer(9);
    assert.equal(reply.ok, false);
    assert.equal(reply.code, 'SKW_E_PL_ROW');
    assert.match(String(reply.message), /needs the granted capability set/);
  } finally {
    client.close();
  }
});
