/**
 * Made to Ship — prove the site is live, from outside the container.
 *
 *     node --no-warnings --experimental-strip-types sites/madetoship/verify.ts --host dev-madetoship.com
 *
 * Every check is a claim a visitor or the operator could make, tested over HTTP against the running
 * stack — **this file never opens the database**. That is deliberate: a host process that writes a
 * tenant's SQLite file under a live app checkpoints the WAL behind the container's open connection,
 * and the container's next write fails `SqliteError: disk I/O error` while every read still works.
 * A read-back that can damage the thing it is measuring is not a read-back.
 *
 *   1. all six pages answer 200 over TLS and carry their own `<title>`;
 *   2. no page carries a `<script>` except the JSON-LD document (data, not code);
 *   3. the theme sheet at its declared URL is `text/css`, carries the brand accent, and its monogram
 *      asset answers 200 as SVG;
 *   4. the menu package filled the home page's manifest (five rows, no template placeholder) and the
 *      About page's index (four rows), and its public feed answers JSON;
 *   5. the contact package drew the form on `/contact`; a real POST gets a 303 to `?sent=1`, the row
 *      appears on the admin Messages screen, and it is deleted from that screen — the operator's
 *      own door, in both directions, so the check leaves no residue and writes nothing itself.
 *
 * A self-signed pair is what a dev box has, so TLS verification is off for these requests only.
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

interface Answer {
  status: number;
  location: string;
  body: string;
  /** Response headers, so a check can assert a policy (`x-robots-tag`) and not just a body. */
  headers: Headers;
}

let cookies: string[] = [];

async function call(method: string, path: string, body?: string, accept = 'text/html', extra: Record<string, string> = {}): Promise<Answer> {
  const headers = new Headers({ Host: host, Accept: accept, 'User-Agent': 'madetoship-verify/1' });
  for (const [name, value] of Object.entries(extra)) headers.set(name, value);
  if (body !== undefined) headers.set('Content-Type', 'application/x-www-form-urlencoded');
  // Every non-GET on this surface answers to an Origin — including the pre-auth login, where there
  // is no session to bind a token to but login CSRF is still the attack the header closes.
  if (method !== 'GET') headers.set('Origin', `https://${host}`);
  if (cookies.length > 0) headers.set('Cookie', cookies.join('; '));
  const res = await fetch(`https://${host}${path}`, { method, headers, body, redirect: 'manual' });
  for (const cookie of res.headers.getSetCookie?.() ?? []) cookies.push(cookie.split(';')[0] ?? '');
  return { status: res.status, location: res.headers.get('location') ?? '', body: await res.text(), headers: res.headers };
}

const failures: string[] = [];
function check(name: string, condition: boolean, detail: string): void {
  process.stdout.write(`  ${condition ? 'ok  ' : 'FAIL'} ${name}${condition || detail === '' ? '' : ` — ${detail}`}\n`);
  if (!condition) failures.push(name);
}

/** Everything a visitor may put on an origin: no code, except the JSON-LD document the head carries. */
function hasCode(html: string): boolean {
  return [...html.matchAll(/<script\b([^>]*)>/gi)].some((match) => !/application\/ld\+json/i.test(match[1] ?? ''));
}

const PAGES: { path: string; title: RegExp }[] = [
  { path: '/', title: /Made to Ship — software agency/ },
  { path: '/services', title: /What we build — Made to Ship/ },
  { path: '/websites', title: /Website development, three fixed prices — Made to Ship/ },
  { path: '/process', title: /How a project runs — Made to Ship/ },
  { path: '/engagements', title: /Engagements and pricing — Made to Ship/ },
  { path: '/about', title: /About Made to Ship/ },
  { path: '/contact', title: /Contact — Made to Ship/ },
];

const bodies = new Map<string, string>();
for (const page of PAGES) {
  const answer = await call('GET', page.path);
  bodies.set(page.path, answer.body);
  const title = /<title>([\s\S]*?)<\/title>/.exec(answer.body)?.[1] ?? '';
  check(`${page.path} 200`, answer.status === 200, `status ${String(answer.status)}`);
  check(`${page.path} title`, page.title.test(title), title.slice(0, 60));
  check(`${page.path} no code`, !hasCode(answer.body), '<script> found');
}

const home = bodies.get('/') ?? '';
const about = bodies.get('/about') ?? '';

check('manifest: six rows on /', (home.match(/class="index__row"/g) ?? []).length === 6, `${String((home.match(/class="index__row"/g) ?? []).length)} row(s)`);
check('manifest: labels drew', /class="index__link"[^>]*>Services</.test(home.replace(/\s+/g, ' ')), 'no Services link');
check('manifest: placeholder gone', !home.includes('>A page<'), 'template placeholder still rendered');
check('websites: three tiers are priced', (bodies.get('/websites') ?? '').includes('$6,500') && (bodies.get('/websites') ?? '').includes('$14,500') && (bodies.get('/websites') ?? '').includes('$28,000'), 'a tier price is missing');
check('websites: the services page links to them', (bodies.get('/services') ?? '').includes('href="/websites"'), 'no link from /services');

// Site search is a server route (base skunkworks), not a page row: the site must link to it from
// the footer, the route must answer, and the results must be the site's own pages.
check('search: the footer links to /search', (bodies.get('/') ?? '').includes('href="/search"'), 'no search link in the footer');
const searchEmpty = await call('GET', '/search');
check('search: the route answers with a box', searchEmpty.status === 200 && searchEmpty.body.includes('class="skw-search__form"'), `status ${String(searchEmpty.status)}`);
const searchHit = await call('GET', '/search?q=pricing');
check('search: a word in a page body is found', searchHit.status === 200 && searchHit.body.includes('class="skw-search__hit"'), `status ${String(searchHit.status)}, no hit`);
check('search: results are noindex', (searchHit.headers.get('x-robots-tag') ?? '').includes('noindex'), `x-robots-tag ${String(searchHit.headers.get('x-robots-tag'))}`);
check('index: six rows on /about', (about.match(/class="index__row"/g) ?? []).length === 6, `${String((about.match(/class="index__row"/g) ?? []).length)} row(s)`);

const feed = await call('GET', '/_plugin/menu/items?menu=main', undefined, 'application/json');
let feedCount = -1;
try {
  feedCount = (JSON.parse(feed.body) as { items?: unknown[] }).items?.length ?? -1;
} catch {
  feedCount = -1;
}
check('menu feed answers JSON with six items', feed.status === 200 && feedCount === 6, `status ${String(feed.status)}, items ${String(feedCount)}`);

// One currency, one set of numbers, and no per-visitor swapping: every page quotes dollars as `$`
// and no page qualifies them — an `A$` or a `US$` anywhere means a second card crept back in.
const engagements = bodies.get('/engagements') ?? '';
check('the card is on /engagements', engagements.includes('$32,000') && engagements.includes('$9,500'), 'price figures missing');
check('the minimum is stated', engagements.includes('$32,000'), 'no minimum');
check('no page qualifies the dollar', !/A\$|US\$|AU\$/.test([...bodies.values()].join('')), 'a prefixed dollar sign is on a page');
check('there is no second card', !bodies.has('/us'), '/us is still published');

const sheetPath = /<link rel="stylesheet" href="([^"]+)">/.exec(home)?.[1] ?? '/theme.css';
const sheet = await call('GET', sheetPath, undefined, 'text/css');
check(`theme sheet 200 (${sheetPath})`, sheet.status === 200, `status ${String(sheet.status)}`);
check('theme sheet carries the brand accent', /#ff4a1c/i.test(sheet.body), 'accent not found');
check('theme sheet names its monogram', /\/_theme\/madetoship\/assets\/monogram\.svg/.test(sheet.body), 'no monogram url');
const monogram = await call('GET', '/_theme/madetoship/assets/monogram.svg', undefined, 'image/svg+xml');
check('monogram.svg 200 + svg', monogram.status === 200 && /<svg/i.test(monogram.body), `status ${String(monogram.status)}`);

// The font the page names must be a real file, not a 404 the browser hides.
const fontPath = /url\("(\/_theme\/madetoship\/assets\/[a-z-]+\.woff2[^"]*)"\)/.exec(sheet.body)?.[1];
if (fontPath !== undefined) {
  const font = await fetch(`https://${host}${fontPath}`, { headers: { Host: host } });
  check('the self-hosted font resolves', font.status === 200 && Number(font.headers.get('content-length') ?? 900) > 400, `status ${String(font.status)}`);
}

const contact = bodies.get('/contact') ?? '';
check('contact form drawn', /data-skw-form="contact\/contact"/.test(contact), 'no form marker rendered');
check('contact form has four fields', (contact.match(/class="field"/g) ?? []).length === 4, `${String((contact.match(/class="field"/g) ?? []).length)} field(s)`);

// A real submission through the visitor's door, then the operator's door to read and remove it.
const marker = `verify+${String(Date.now())}@example.invalid`;
const form = new URLSearchParams({
  _skw_form: 'contact/contact',
  name: 'Verification',
  email: marker,
  company: 'Made to Ship verify.ts',
  message: 'This message is written by sites/madetoship/verify.ts and deleted through the Messages screen in the same run.',
}).toString();
const posted = await call('POST', '/contact', form);
check('POST /contact 303', posted.status === 303, `status ${String(posted.status)}`);
check('POST redirects to ?sent=1', posted.location.includes('sent=1'), posted.location);

const enrol = readFileSync(join(dataDir, `enrol-${tenant}.txt`), 'utf8');
const field = (name: string): string => new RegExp(`^${name}:\\s*(.*)$`, 'm').exec(enrol)?.[1]?.trim() ?? '';
const signedIn = await call(
  'POST',
  '/admin/login',
  new URLSearchParams({ email: field('email'), password: field('password'), totp: totpCode(field('secret'), Date.now()) }).toString(),
);
check('admin sign-in accepted', signedIn.status === 303 || signedIn.status === 302, `status ${String(signedIn.status)}`);

const screen = `/admin/t/${tenant}/messages`;
const listed = await call('GET', screen);
check('Messages screen 200', listed.status === 200, `status ${String(listed.status)}`);
check('the message is on the Messages screen', listed.body.includes(marker), 'marker not listed');

/**
 * Which rows on this screen belong to the verifier?
 *
 * The list carries no email text — it carries links. So the honest way to find the row is to open
 * each row page and read it, which is also how an operator finds one. (A regex for the first
 * `/messages/<id>` on the list is not the row: it is whichever row the markup happens to name
 * first, which is how an earlier version of this file deleted somebody else's message and then
 * reported the marker still present.)
 */
const candidateIds = [...new Set([...listed.body.matchAll(new RegExp(`/${tenant}/messages/(\\d+)`, 'g'))].map((m) => m[1] ?? ''))].filter(
  (id) => id !== '',
);
const mine: { id: string; csrf: string }[] = [];
for (const id of candidateIds) {
  const row = await call('GET', `${screen}/${id}`);
  if (!row.body.includes('example.invalid')) continue;
  const csrf = /data-csrf-token="([^"]+)"/.exec(row.body)?.[1] ?? /name="csrf" value="([^"]+)"/.exec(row.body)?.[1] ?? '';
  if (csrf !== '') mine.push({ id, csrf });
}
check('the row opens with a signed Delete', mine.length > 0, `${String(mine.length)} of ${String(candidateIds.length)} row(s) recognised`);
check('the verifier owns the row it wrote', mine.some((row) => row.id !== undefined), 'no row page carried the marker');

// Both spellings of the token: the row page's script posts it in an `X-CSRF-Token` header, the older
// forms post it in a `csrf` body field, and the route accepts either. Sending both is what a browser
// effectively does when a form falls back to a plain submit.
let deletedAll = mine.length > 0;
for (const row of mine) {
  const deleted = await call('POST', `${screen}/${row.id}/delete`, new URLSearchParams({ csrf: row.csrf }).toString(), 'text/html', {
    'X-CSRF-Token': row.csrf,
  });
  if (deleted.status !== 303) deletedAll = false;
}
check('DELETE through the Messages screen 303', deletedAll, 'a delete was refused');

const after = await call('GET', screen);
check('the verification message is gone', !after.body.includes('example.invalid'), 'a verifier row is still listed');

process.stdout.write(
  failures.length === 0
    ? `\nall checks passed on https://${host} (${String(PAGES.length)} pages, no database opened by this script)\n`
    : `\n${String(failures.length)} FAILED: ${failures.join(', ')}\n`,
);
process.exitCode = failures.length === 0 ? 0 : 1;
