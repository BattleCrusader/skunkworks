/**
 * A tiny HTTP client. `fetch` will not let a caller set `Host`, and Host is the
 * whole point of this slice, so this uses node:http directly.
 */
import { request as httpRequest } from 'node:http';
import { connect } from 'node:net';

export interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  json: unknown;
}

export interface CallOptions {
  port: number;
  path: string;
  method?: string;
  host?: string;
  headers?: Record<string, string>;
  body?: string;
}

export function call(opts: CallOptions): Promise<Res> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.host !== undefined) headers.host = opts.host;
    if (opts.body !== undefined) headers['content-length'] = String(Buffer.byteLength(opts.body));
    const req = httpRequest(
      { host: '127.0.0.1', port: opts.port, path: opts.path, method: opts.method ?? 'GET', headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          let json: unknown = undefined;
          try {
            json = JSON.parse(body);
          } catch {
            json = undefined;
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json });
        });
      },
    );
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

export function header(res: Res, name: string): string | undefined {
  const v = res.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

export interface RawPostOptions {
  port: number;
  path: string;
  host: string;
  bytes: number;
  contentType?: string;
}

/**
 * A body over a raw socket, used for oversized-body gates.
 *
 * `ClientRequest` cannot be used here: the server answers 413 and closes while
 * writes are still queued, and the EPIPE surfaces from a WriteWrap callback as an
 * uncaught exception rather than a request 'error'. A raw socket handles it on
 * its own 'error' handler, which is what curl does too.
 */
export function postRaw(opts: RawPostOptions): Promise<Res> {
  // A server that answers 413 and closes while the body is still in flight may RST
  // and discard the response it just wrote; that is a transport artefact, not a
  // statement about the app. Retrying the *request* does not weaken the assertion —
  // every attempt still has to come back with the documented status and code — and
  // the pump stops as soon as any byte of response arrives, which is what makes the
  // first attempt succeed almost always.
  const attempt = (): Promise<Res | null> =>
    new Promise((resolve) => {
      const sock = connect(opts.port, '127.0.0.1');
      let raw = '';
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        sock.destroy();
        const split = raw.indexOf('\r\n\r\n');
        if (split === -1) {
          resolve(null);
          return;
        }
        const head = raw.slice(0, split).split('\r\n');
        const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(head[0] ?? '')?.[1] ?? 0);
        const headers: Record<string, string> = {};
        for (const line of head.slice(1)) {
          const i = line.indexOf(':');
          if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
        }
        const body = raw.slice(split + 4);
        let json: unknown;
        try {
          json = JSON.parse(body);
        } catch {
          json = undefined;
        }
        resolve({ status, headers, body, json });
      };
      const timer = setTimeout(finish, 30_000);
      timer.unref();
      const chunk = Buffer.alloc(256 * 1024, 0x61);
      let sent = 0;
      const pump = (): void => {
        if (settled || raw !== '' || sent >= opts.bytes) return;
        const n = Math.min(chunk.length, opts.bytes - sent);
        sent += n;
        if (sock.write(chunk.subarray(0, n))) setTimeout(pump, 0);
        else sock.once('drain', pump);
      };
      sock.on('connect', () => {
        sock.write(
          `POST ${opts.path} HTTP/1.1\r\nHost: ${opts.host}\r\n` +
            `Content-Type: ${opts.contentType ?? 'application/octet-stream'}\r\n` +
            `Content-Length: ${opts.bytes}\r\nConnection: close\r\n\r\n`,
        );
        pump();
      });
      sock.on('data', (c: Buffer) => {
        raw += c.toString('utf8');
      });
      sock.on('end', finish);
      sock.on('close', finish);
      // EPIPE after the 413 has been written is the expected path, not a failure.
      sock.on('error', finish);
    });

  return (async (): Promise<Res> => {
    for (let i = 0; i < 3; i += 1) {
      const res = await attempt();
      if (res !== null) return res;
    }
    throw new Error(`no HTTP response to a ${opts.bytes}-byte body after 3 attempts`);
  })();
}
