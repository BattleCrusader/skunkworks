#!/usr/bin/env node
/**
 * `install.sh --verify-login` — the install's own smoke test.
 *
 * Boots **the installed app** (`dist/app/main.js`) against the installed data
 * directory, signs in with the password and the TOTP secret from the enrolment
 * file, and fetches `GET /admin`. Nothing is mocked: this is the same `buildApp`
 * the container runs, the same login route a browser posts to, and the same
 * `session` row.
 *
 * Exit 0: the box is usable. Exit 1: it is not, and the reason is printed.
 */
import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';

const args = process.argv.slice(2);
const value = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};

const dataDir = value('data');
const enrolmentPath = value('enrolment');
if (dataDir === undefined || enrolmentPath === undefined) {
  process.stderr.write('usage: install_check.mjs --data <dir> --enrolment <file>\n');
  process.exit(1);
}

const text = readFileSync(enrolmentPath, 'utf8');
const field = (name) => {
  const m = new RegExp(`^${name}:\\s+(.*)$`, 'm').exec(text);
  if (m === null) throw new Error(`the enrolment file has no ${name} line`);
  return m[1];
};

const email = field('email');
const password = field('password');
const url = new URL(field('admin'));
const host = url.host;
const origin = url.origin;

process.env.SKW_DATA_DIR = dataDir;

const { buildApp } = await import('../dist/app/main.js');
const { totpCode } = await import('../dist/app/admin/auth.js');

function call(port, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const h = { host, ...headers };
    if (body !== undefined) h['content-length'] = String(Buffer.byteLength(body));
    const req = httpRequest({ host: '127.0.0.1', port, path, method, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const handle = await buildApp({ env: (await import('../dist/app/env.js')).loadEnv(process.env) });
let failed = false;
try {
  await handle.app.listen({ port: 0, host: '127.0.0.1' });
  const address = handle.app.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  const login = await call(port, '/admin/login', {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, totp: totpCode(field('secret').replace(/ /g, ''), Date.now()) }),
  });
  if (login.status !== 200) {
    process.stderr.write(`install_check: login failed: ${login.status} ${login.body}\n`);
    failed = true;
  } else {
    const cookie = String(login.headers['set-cookie'] ?? '').split(';')[0];
    const consoleRes = await call(port, '/admin', { headers: { cookie } });
    if (consoleRes.status !== 200) {
      process.stderr.write(`install_check: GET /admin failed: ${consoleRes.status} ${consoleRes.body}\n`);
      failed = true;
    } else {
      process.stdout.write(
        `install_check: signed in as ${email}, GET /admin ${consoleRes.status} (${String(consoleRes.headers['content-type']).split(';')[0]})\n`,
      );
    }
  }
} finally {
  await handle.close();
}
process.exit(failed ? 1 : 0);
