/**
 * The containment probe (S4c): a plugin whose only job is to reach the network.
 *
 * It is not malicious — it is the *measurement*. Under `network_mode: none` every route off
 * the namespace must fail, and the runner must report the failure **naming this package**.
 *
 * **What `network_mode: none` actually gives you, measured, and why this file is written the
 * way it is:** the container still has a loopback interface, and a UDP `send()` to a loopback
 * address is *accepted by the kernel* (`SENT`) because there is no route to look up and
 * nothing has to answer. So "the plugin cannot open a socket" is the wrong claim, and a probe
 * that asserted it would be a false green. The claim that matters is:
 *
 *   - **no route off the namespace** — TCP and UDP to an external address fail
 *     `ENETUNREACH`, and `fetch` fails with the same cause;
 *   - **loopback reaches nothing** — a TCP connect to a loopback port with no listener is
 *     `ECONNREFUSED`/`ENETUNREACH`, never a delivered body;
 *   - **the filesystem is closed by the permission model, not by the mount** —
 *     `/srv/runner/server.mjs` exists and is world-readable, and `--permission` still denies it.
 */
import { connect } from 'node:net';
import { createSocket } from 'node:dgram';
import { readFileSync } from 'node:fs';

/** An address that is not in this namespace under any configuration. */
const EXTERNAL = '1.1.1.1';

function tcp(host, port) {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    let settled = false;
    const done = (message) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(message);
    };
    socket.setTimeout(1500, () => done('TIMEOUT'));
    socket.on('connect', () => done('CONNECTED'));
    socket.on('error', (err) => done(String(err.code ?? err.name)));
  });
}

function udp(host, port) {
  return new Promise((resolve) => {
    const socket = createSocket('udp4');
    let settled = false;
    const done = (message) => {
      if (settled) return;
      settled = true;
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      resolve(message);
    };
    socket.on('error', (err) => done(String(err.code ?? err.name)));
    try {
      socket.send('probe', port, host, (err) => done(err === null || err === undefined ? 'SENT' : String(err.code ?? err.name)));
    } catch (err) {
      done(String(err.code ?? err.name));
    }
  });
}

export async function handle(op) {
  if (op !== 'reach') throw new Error(`probenet: unknown op ${JSON.stringify(op)}`);

  const results = {
    external_tcp: await tcp(EXTERNAL, 53),
    external_udp: await udp(EXTERNAL, 53),
    loopback_tcp: await tcp('127.0.0.1', 8765),
    loopback_udp: await udp('127.0.0.1', 8765),
    fetch_external: 'not attempted',
    read: 'not attempted',
  };

  try {
    const response = await fetch(`http://${EXTERNAL}/`, { signal: AbortSignal.timeout(1500) });
    results.fetch_external = `HTTP ${response.status}`;
  } catch (err) {
    results.fetch_external = String(err.cause?.code ?? err.name);
  }

  try {
    readFileSync('/srv/runner/server.mjs', 'utf8');
    results.read = 'READ';
  } catch (err) {
    results.read = String(err.code ?? err.name);
  }

  // Fail loudly if a route off the namespace worked: a silent success would make the gate's
  // `ok: true` read as "contained" when it means the opposite.
  for (const route of ['external_tcp', 'external_udp', 'fetch_external', 'loopback_tcp', 'read']) {
    if (results[route] === 'CONNECTED' || results[route] === 'READ' || String(results[route]).startsWith('HTTP')) {
      throw new Error(`containment broken: ${route} succeeded (${results[route]})`);
    }
  }
  // `loopback_udp` is reported, not asserted: on `none` the interface exists and the kernel
  // accepts the datagram. Saying so is the difference between a measurement and a slogan.
  return results;
}

export default handle;
