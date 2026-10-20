#!/usr/bin/env node
/**
 * The gate's client for the runner socket (S4c).
 *
 * It runs **inside** the container (`docker exec`), not on the host: on Docker Desktop the
 * container is a VM, so a unix socket created inside it is not connectable from macOS even
 * though the directory is bind-mounted. The protocol is the same either way — JSON lines,
 * request/response — and running the client in the same netns is also the only honest way to
 * ask "can this container reach the network".
 *
 * Usage: node client.mjs '<json request>' ['<json request>' …]
 * Prints one JSON response per line, in order.
 */
import { connect } from 'node:net';

const socketPath = process.env.SKW_RUNNER_SOCKET ?? '/srv/run/plugin.sock';
const requests = process.argv.slice(2);

const socket = connect(socketPath);
let buffer = '';
let received = 0;

const timer = setTimeout(() => {
  process.stderr.write(`client: timed out after 10 s (${received}/${requests.length} replies)\n`);
  process.exit(1);
}, 10_000);

socket.setEncoding('utf8');
socket.on('connect', () => {
  for (const request of requests) socket.write(`${request}\n`);
});
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
    if (message?.type === 'host.call') {
      // S4d: this client stands in for the app's host channel. It answers the ten host ops
      // with a canned but **context-shaped** result, so the gate can prove the child's
      // skw.call() reached a host over the socket inside `--network none`. The real app
      // answers from site.db (`test/plugin-host.test.ts`).
      const answers = {
        'store.insert': { id: 41, changes: 1 },
        'store.query': { rows: [{ id: 41, body: 'answered-by-host' }], limit: 10, offset: 0 },
        'store.count': { count: 1 },
        'settings.get': null,
        'settings.has': { has: false },
        'settings.set': { ok: true },
        'assets.resolve': null,
        'mail.send': { queued: true },
      };
      const result = answers[message.op] ?? null;
      socket.write(`${JSON.stringify({ type: 'host.result', id: message.id, ok: true, result })}\n`);
      continue;
    }
    process.stdout.write(`${line}\n`);
    received += 1;
    if (received === requests.length) {
      clearTimeout(timer);
      socket.end();
    }
  }
});
socket.on('error', (err) => {
  process.stderr.write(`client: ${err.message}\n`);
  process.exit(1);
});
