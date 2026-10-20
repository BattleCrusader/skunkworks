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
 * **S4c: and then it fetches the tenant's first published page.** D30's promise is
 * "an empty host directory to a **served page**", and an install whose only proof is the
 * admin console has proved the console, not the product. The page is chosen from the
 * installed databases — the first tenant's primary host, that tenant's first published
 * path, `/` preferred — so the probe asserts the box serves *its own* content without the
 * caller having to know a path.
 *
 * Exit 0: the box is usable. Exit 1: it is not, and the reason is printed.
 */
import { existsSync, readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';

const args = process.argv.slice(2);
const value = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};

const dataDir = value('data');
const enrolmentPath = value('enrolment');
const requirePage = args.includes('--require-page');
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

/**
 * The tenant's first published page and the host it is served on: read from the databases
 * the install just wrote, not from a flag. `/` wins when it exists — it is the page a
 * browser opens.
 */
async function firstPage() {
  const { DatabaseSync } = await import('node:sqlite');
  const control = new DatabaseSync(join(dataDir, 'control.db'), { readOnly: true });
  let tenant;
  let domain;
  try {
    tenant = control.prepare('SELECT id, key FROM tenant ORDER BY id LIMIT 1').get();
    if (tenant === undefined) throw new Error('control.db has no tenant');
    domain = control.prepare('SELECT host FROM domain WHERE tenant_id = ? ORDER BY is_primary DESC, host LIMIT 1').get(tenant.id);
  } finally {
    control.close();
  }
  if (domain === undefined) throw new Error(`tenant ${tenant.key} has no domain row`);
  const site = new DatabaseSync(join(dataDir, 'tenants', String(tenant.key), 'site.db'), { readOnly: true });
  try {
    const page = site
      .prepare(`SELECT path FROM cms_page WHERE status = 'published' ORDER BY (path = '/') DESC, path LIMIT 1`)
      .get();
    if (page === undefined) throw new Error(`tenant ${tenant.key} has no published page to serve`);
    return { path: String(page.path), host: String(domain.host) };
  } finally {
    site.close();
  }
}

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

const contentFlag = value('content');
const contentRoot = contentFlag !== undefined && existsSync(contentFlag) ? contentFlag : undefined;
const handle = await buildApp({
  env: (await import('../dist/app/env.js')).loadEnv(process.env),
  ...(contentRoot === undefined ? {} : { contentRoot }),
});
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

      // --- the public page: D30's "to a served page", proved by the install itself ---
      // `--require-page` is passed by `install.sh` when the bundle carried a `site.db`. A
      // source-tree install has no tenant content yet, so it reports instead of failing —
      // but a bundle install with no page is exactly the failure this probe exists for.
      const page = await firstPage().catch((err) => {
        if (requirePage) throw err;
        process.stdout.write(`install_check: no page to serve yet (${err.message})\n`);
        return null;
      });
      if (page !== null) {
        const pageRes = await call(port, page.path, { headers: { host: page.host } });
        const title = /<title>([^<]*)<\/title>/.exec(pageRes.body)?.[1] ?? '';
        if (pageRes.status !== 200) {
          process.stderr.write(
            `install_check: GET ${page.path} failed: ${pageRes.status} (host ${page.host}) ${pageRes.body.slice(0, 200)}\n`,
          );
          failed = true;
        } else {
          process.stdout.write(
            `install_check: GET ${page.path} ${pageRes.status} ${Buffer.byteLength(pageRes.body)} B ${JSON.stringify(title)} host=${page.host}\n`,
          );
        }
      }
    }
  }
} finally {
  await handle.close();
}
process.exit(failed ? 1 : 0);
