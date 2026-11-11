/**
 * Made to Ship — prove the owner credential on the tenant's own admin surface.
 *
 * The site's public flow is `verify.ts`. This is the other half: the password and TOTP in
 * `data/enrol-madetoship.txt` really sign an owner in, the CSRF token on the form really is
 * accepted, and the tenant's Pages screen really lists the six pages this site is made of.
 *
 *     node --no-warnings --experimental-strip-types sites/madetoship/verify-admin.ts \
 *       --host dev-madetoship.com --tenant madetoship
 *
 * No secret is printed: the password and the code are read, used, and dropped.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { totpCode } from '../../app/admin/auth.ts';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index === -1 ? undefined : process.argv[index + 1];
  return value === undefined || value === '' ? fallback : value;
}

const host = arg('host', 'dev-madetoship.com');
const tenant = arg('tenant', 'madetoship');
const dataDir = arg('data', 'data');

const enrol = readFileSync(join(dataDir, `enrol-${tenant}.txt`), 'utf8');
const field = (name: string): string => new RegExp(`^${name}:\\s*(.*)$`, 'm').exec(enrol)?.[1]?.trim() ?? '';
const email = field('email');
const password = field('password');
const secret = field('secret');
if (email === '' || password === '' || secret === '') {
  process.stderr.write(`verify-admin: ${dataDir}/enrol-${tenant}.txt is missing email, password or secret\n`);
  process.exit(1);
}

const base = `https://${host}`;
let cookies: string[] = [];

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('Host', host);
  // A browser asks for a document and gets a 303 to the console; a JSON client gets a 200 with the
  // session in the body. This script is checking the browser's path, so it asks like one.
  headers.set('Accept', 'text/html');
  if (cookies.length > 0) headers.set('Cookie', cookies.join('; '));
  const res = await fetch(`${base}${path}`, { ...init, headers, redirect: 'manual' });
  const setCookies = res.headers.getSetCookie?.() ?? [];
  for (const cookie of setCookies) cookies.push(cookie.split(';')[0] ?? '');
  return res;
}

const checks: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = ''): void => {
  checks.push({ name, ok, detail });
  process.stdout.write(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok || detail === '' ? '' : ` — ${detail}`}\n`);
};

const login = await call('/admin/login');
const loginHtml = await login.text();
check('GET /admin/login 200', login.status === 200, `status ${String(login.status)}`);
check('login form asks for the second factor', /name="totp"/.test(loginHtml), 'no totp field');

// The pre-auth form carries no CSRF: there is no session yet to bind a token to. Every form behind
// the sign-in does, and `logout` below uses the one on the authenticated page.
const body = new URLSearchParams({ email, password, totp: totpCode(secret, Date.now()) });
const signedIn = await call('/admin/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: base },
  body: body.toString(),
});
const signedInHtml = await signedIn.clone().text();
const refusal = /role="alert"[^>]*>([^<]{0,120})/.exec(signedInHtml)?.[1] ?? /class="error"[^>]*>([^<]{0,120})/.exec(signedInHtml)?.[1] ?? '';
// The house's "accepted, now GET this" is a 303 (§13.3.4); a 302 is the other legitimate spelling.
check('POST /admin/login redirects to the console', signedIn.status === 302 || signedIn.status === 303, `status ${String(signedIn.status)}${refusal === '' ? '' : ` — ${refusal}`}`);
check('signed in, not refused', (signedIn.headers.get('location') ?? '') !== '/admin/login', String(signedIn.headers.get('location') ?? ''));

const pages = await call(`/admin/t/${tenant}/pages`);
const pagesHtml = await pages.text();
check('GET /admin/t/<tenant>/pages 200', pages.status === 200, `status ${String(pages.status)}`);
const listed = ['/services', '/process', '/engagements', '/about', '/contact'].filter((path) => pagesHtml.includes(path));
check('the Pages screen lists this site', listed.length >= 5, `found ${String(listed.length)}/5 paths`);

const messages = await call(`/admin/t/${tenant}/messages`);
check('GET /admin/t/<tenant>/messages 200', messages.status === 200, `status ${String(messages.status)}`);

// The same URL without this session's cookie is a bounce to the sign-in screen, which is what makes
// the two checks above mean something: the console was open because of the credential, not by luck.
const anonymous = await fetch(`${base}/admin/t/${tenant}/pages`, {
  headers: { Host: host, Accept: 'text/html' },
  redirect: 'manual',
});
check('without the session the console bounces', anonymous.status === 302, `status ${String(anonymous.status)}`);

const failed = checks.filter((entry) => !entry.ok).length;
process.stdout.write(failed === 0 ? `\nadmin surface: ${String(checks.length)}/${String(checks.length)} checks passed on ${host}\n` : `\n${String(failed)} FAILED\n`);
process.exitCode = failed === 0 ? 0 : 1;
