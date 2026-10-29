/**
 * The portal's presentation: the site's chrome around every portal page, and one first-party
 * stylesheet that follows the tenant's own theme tokens.
 *
 * What is proved here, and why each assertion is in this file rather than in `accounts-portal`:
 *
 *   - **the chrome is the site's, not a lookalike.** A CMS page and a portal page are rendered by
 *     the same running app for the same tenant, their `<header>` blocks are extracted and compared
 *     byte for byte. A second, hand-written bar in `app/accounts/routes.ts` would fail this the
 *     first time either renderer learned a new attribute;
 *   - **every page links the portal's own stylesheet and no other host.** The site's policy is
 *     `style-src 'self'`, so an inline `<style>` or a CDN link is either blocked or absent by
 *     policy; the assertions pin the link and the absence;
 *   - **every visible control has a label.** A page without JavaScript is a page whose labels are
 *     the only affordance a screen reader has;
 *   - **the stylesheet is a real response**, `text/css`, with the rules the pages depend on — an
 *     empty sheet would satisfy "it links /portal.css" and style nothing.
 *
 * The account pages are reached through the public flow (register, confirm, enrol, sign in), not
 * by minting a session row: the point of the test is a page a browser would actually receive.
 */
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { after, before, test } from 'node:test';

import { Accounts } from '../app/accounts/service.ts';
import { registerPortal } from '../app/accounts/routes.ts';
import { Semaphore, totpCode } from '../app/admin/auth.ts';
import { loadEnv } from '../app/env.ts';
import { buildApp, type AppHandle } from '../app/main.ts';
import { makeFixture, type Fixture } from './helpers/fixture.ts';
import { call, header, type Res } from './helpers/http.ts';

const HOST = 'acme.test';
const ORIGIN = `https://${HOST}`;
const PASSWORD = 'correct horse battery staple';

let fixture: Fixture;
let handle: AppHandle;
let port = 0;
let db: Database.Database;

interface Entered {
  readonly cookie: string;
  /** The page that asked for the authenticator code — the "enrol" step in the user's list. */
  readonly enrolPage: Res;
}

function formPost(path: string, fields: Record<string, string>, extra: Record<string, string> = {}) {
  const body = new URLSearchParams(fields).toString();
  return call({
    port,
    path,
    method: 'POST',
    host: HOST,
    headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded', ...extra },
    body,
  });
}

/** The first cookie a response sets, as `name=value`; a response that sets none fails by name. */
function cookieOf(res: Res): string {
  const raw = header(res, 'set-cookie');
  assert.ok(typeof raw === 'string' && raw !== '', 'the response sets a cookie');
  const first = raw.split(';')[0];
  assert.ok(first !== undefined && first !== '', 'the cookie has a value');
  return first;
}

/**
 * Register, prove the address, enrol the authenticator and sign in — the four public steps.
 *
 * The verification link is the one the offline operator sees in the response body; the code is
 * computed from the secret the account row holds, exactly as `accounts-portals.test.ts` does, so
 * nothing here invents a session the product would not have issued.
 */
async function enterAs(email: string, displayName: string, role: 'applicant' | 'advertiser'): Promise<Entered> {
  const registered = await formPost('/portal/register', {
    email,
    password: PASSWORD,
    display_name: displayName,
    role,
  });
  assert.equal(registered.status, 200, registered.body);
  const verifyPath = /\/portal\/verify\?token=[0-9a-f]{64}/.exec(registered.body)?.[0];
  assert.ok(verifyPath !== undefined, 'the offline operator sees the verification link');

  const verified = await call({ port, path: verifyPath, host: HOST });
  assert.equal(verified.status, 200);
  const enrolCookie = cookieOf(verified);
  assert.match(enrolCookie, /^__Secure-sk-enrol-acme=/);

  const row = db.prepare('SELECT id, totp_secret FROM cms_account WHERE email = ?').get(email) as {
    id: number;
    totp_secret: string;
  };

  const enrolled = await formPost('/portal/enrol', { code: totpCode(row.totp_secret, Date.now()) }, { cookie: enrolCookie });
  assert.equal(enrolled.status, 303, enrolled.body);

  const signedIn = await formPost('/portal/signin', {
    email,
    password: PASSWORD,
    code: totpCode(row.totp_secret, Date.now()),
  });
  assert.equal(signedIn.status, 303, signedIn.body);
  const cookie = cookieOf(signedIn);
  assert.match(cookie, /^__Secure-sk-portal-acme=/);
  return { cookie, enrolPage: verified };
}

/** Every `<link rel="stylesheet">` href on a page, in document order. */
function sheetHrefs(body: string): string[] {
  return [...body.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*>/g)].map((match) => {
    const href = /href="([^"]*)"/.exec(match[0]);
    return href?.[1] ?? '';
  });
}

/** The header block, from `<header` to `</header>`, or `null`. */
function headerBlock(body: string): string | null {
  const match = /<header\b[\s\S]*?<\/header>/.exec(body);
  return match?.[0] ?? null;
}

function footerBlock(body: string): string | null {
  const match = /<footer\b[\s\S]*?<\/footer>/.exec(body);
  return match?.[0] ?? null;
}

/** A page with the chrome the footer and header assertions read. */
function assertSiteShell(body: string, where: string): void {
  assert.match(body, /<header class="site-header[^"]*"/, `${where}: the site header`);
  assert.match(body, /<footer class="site-footer[^"]*"/, `${where}: the site footer`);
  assert.match(body, /<nav aria-label="Main">/, `${where}: the main menu`);
  assert.match(body, /<a class="site-id" href="\/">/, `${where}: the site's identity links home`);
  assert.ok(sheetHrefs(body).includes('/portal.css'), `${where}: the portal stylesheet is linked`);
  assert.ok(sheetHrefs(body).includes('/theme.css'), `${where}: the tenant theme is linked first`);
  assert.ok(sheetHrefs(body).every((href) => href.startsWith('/')), `${where}: every sheet is first-party`);
  assert.doesNotMatch(body, /<style[\s>]/, `${where}: no inline style element (style-src 'self')`);
  assert.doesNotMatch(body, /<script[\s>]/, `${where}: the portal runs no script`);
}

/** Every control a person can see, with the label that names it. */
function assertLabelled(body: string, where: string): void {
  const controls = [...body.matchAll(/<(input|select|textarea)\b[^>]*>/g)].map((match) => match[0]);
  const visible = controls.filter((tag) => !/type="hidden"/.test(tag));
  assert.ok(visible.length > 0, `${where}: the page has a control`);
  for (const tag of visible) {
    if (/type="checkbox"/.test(tag) || /type="radio"/.test(tag)) {
      assert.ok(body.includes(`<label class="portal-check">${tag}`), `${where}: the checkbox is inside its label: ${tag}`);
      continue;
    }
    const id = /id="([^"]+)"/.exec(tag)?.[1];
    assert.ok(id !== undefined && id !== '', `${where}: a control has an id: ${tag}`);
    assert.ok(body.includes(`<label for="${id}">`), `${where}: a label names ${id}`);
  }
}

before(async () => {
  fixture = makeFixture({ specs: [{ key: 'acme', hosts: [HOST], title: 'Acme' }] });
  db = new Database(fixture.sitePath('acme'));
  db.pragma('foreign_keys = ON');

  // The identity and the two menus the marketing pages already render. `url` rows are used so the
  // fixture does not need a `cms_page` row for every link; the identity is what makes a bar at all.
  const setting = db.prepare('INSERT OR REPLACE INTO cms_settings (key, value_json, type) VALUES (?, ?, ?)');
  setting.run('site.title', JSON.stringify('Acme Fractional'), 'string');
  setting.run('site.footer_text', JSON.stringify('Fractional work, listed by the day.'), 'string');
  setting.run('site.header_sticky', JSON.stringify(true), 'bool');

  const nav = db.prepare(
    `INSERT INTO cms_nav (location, label, href_kind, href_target, position, visible)
     VALUES (?, ?, 'url', ?, ?, 1)`,
  );
  nav.run('header', 'Find work', 'https://acme.test/find-work', 0);
  nav.run('header', 'Post a role', 'https://acme.test/post-a-role', 1);
  nav.run('footer', 'Privacy', 'https://acme.test/privacy', 0);
  nav.run('footer', 'Contact', 'https://acme.test/contact', 1);

  // A CMS page at `/`, so the chrome comparison has a marketing page to compare with.
  db.prepare(
    `INSERT INTO cms_page (path, slug, title, status, template, body_html, published_at)
     VALUES ('/', 'home', 'Fractional work, listed by the day', 'published', 'page', '<p>Home.</p>', '2026-01-01T00:00:00.000Z')`,
  ).run();

  handle = await buildApp({ env: loadEnv(fixture.env), contentRoot: `${fixture.dir}/content` });
  await handle.app.listen({ port: 0, host: '127.0.0.1' });
  const address = handle.app.server.address();
  port = typeof address === 'object' && address !== null ? address.port : 0;
});

after(async () => {
  db?.close();
  if (handle !== undefined) await handle.close();
  if (fixture !== undefined) fixture.cleanup();
});

// One account of each kind, created on first use. Registering is rate-limited per address
// (`REGISTER_LIMIT`), so a test that walked the public flow again for every assertion would be
// asserting the rate limiter as much as the page.
let applicantOnce: Promise<Entered> | null = null;
let advertiserOnce: Promise<Entered> | null = null;
function applicantSession(): Promise<Entered> {
  return (applicantOnce ??= enterAs('applicant@example.test', 'Alice Rivera', 'applicant'));
}
function advertiserSession(): Promise<Entered> {
  return (advertiserOnce ??= enterAs('advertiser@example.test', 'Acme Hiring', 'advertiser'));
}

test("P-1 — every portal page is the site: header, footer, main menu and the portal's own sheet", async () => {
  const applicant = await applicantSession();
  const advertiser = await advertiserSession();

  const pages: [string, Res][] = [
    ['register', await call({ port, path: '/portal/register', host: HOST })],
    ['signin', await call({ port, path: '/portal/signin', host: HOST })],
    ['verify', await call({ port, path: '/portal/verify', host: HOST })],
    ['enrol', applicant.enrolPage],
    ['applicant', await call({ port, path: '/portal/applicant', host: HOST, headers: { cookie: applicant.cookie } })],
    ['advertiser', await call({ port, path: '/portal/advertiser', host: HOST, headers: { cookie: advertiser.cookie } })],
  ];

  for (const [name, page] of pages) {
    assert.ok(page.status === 200 || page.status === 400, `${name}: a rendered page (${page.status})`);
    assert.match(String(header(page, 'content-type')), /text\/html/, `${name}: html`);
    assertSiteShell(page.body, name);
  }
});

test('P-2 — /portal.css is this app’s stylesheet, with the rules the pages depend on', async () => {
  const css = await call({ port, path: '/portal.css', host: HOST });
  assert.equal(css.status, 200, css.body);
  assert.match(String(header(css, 'content-type')), /^text\/css/, 'served as CSS, or the browser ignores it');
  assert.match(String(header(css, 'cache-control')), /max-age=86400/);

  for (const rule of [
    '.portal-main',
    '.portal-container--auth',
    '.portal-form',
    '.portal-field > label',
    '.portal-fieldset',
    '.portal-check',
    '.portal-main select',
    '.portal-main textarea',
    '.portal-button--quiet',
    '.portal-button--danger',
    '.portal-banner--error',
    '.portal-banner--success',
    '.portal-error',
    '.portal-table',
    '.portal-empty',
    '.portal-profile',
    '@media (max-width: 640px)',
  ]) {
    assert.ok(css.body.includes(rule), `the sheet styles ${rule}`);
  }
  assert.match(css.body, /var\(--paper/, 'colours come from the tenant theme');
  assert.match(css.body, /var\(--gutter/, 'spacing comes from the tenant theme');
  assert.doesNotMatch(css.body, /https?:\/\//, 'no third-party request from the stylesheet');
  assert.doesNotMatch(css.body, /@import/, 'nothing is pulled in from elsewhere');
});

test('P-3 — the register form has a label for every control', async () => {
  const page = await call({ port, path: '/portal/register', host: HOST });
  assert.equal(page.status, 200);
  assertLabelled(page.body, 'register');
  assert.match(page.body, /<fieldset class="portal-fieldset">/, 'the role choice is a fieldset');
  assert.match(page.body, /<legend>What do you want to do\?<\/legend>/, 'with a legend');
});

test('P-4 — the applicant page is a profile form and an empty applications state, both labelled', async () => {
  const applicant = await applicantSession();
  const page = await call({ port, path: '/portal/applicant', host: HOST, headers: { cookie: applicant.cookie } });
  assert.equal(page.status, 200, page.body);
  assertSiteShell(page.body, 'applicant');
  assertLabelled(page.body, 'applicant');
  assert.match(page.body, /<dl class="portal-profile">/, 'the read-only summary is a definition list');
  assert.match(page.body, /You have not applied for anything yet\./, 'the empty state says why the table is absent');
  assert.match(page.body, /class="portal-empty"/, 'and it is the empty-state box, not a one-cell table');
  assert.match(page.body, /<button class="portal-button" type="submit">Save profile<\/button>/, 'the primary action is the primary button');
});

test('P-5 — the advertiser page is an applications list with an empty state', async () => {
  const advertiser = await advertiserSession();
  const page = await call({ port, path: '/portal/advertiser', host: HOST, headers: { cookie: advertiser.cookie } });
  assert.equal(page.status, 200, page.body);
  assertSiteShell(page.body, 'advertiser');
  assert.match(page.body, /No applications yet\. When someone applies to one of your roles it appears here\./);
  assert.match(page.body, /class="portal-empty"/);
});

test('P-6 — a CMS page and a portal page are drawn with the same header and footer', async () => {
  const marketing = await call({ port, path: '/', host: HOST });
  assert.equal(marketing.status, 200, marketing.body);
  const portal = await call({ port, path: '/portal/register', host: HOST });
  assert.equal(portal.status, 200);

  const marketingHeader = headerBlock(marketing.body);
  const portalHeader = headerBlock(portal.body);
  assert.ok(marketingHeader !== null && portalHeader !== null);
  assert.equal(portalHeader, marketingHeader, 'one chrome renderer, not two that agree today');
  assert.match(portalHeader, /<ul class="site-menu"><li><a href="https:\/\/acme\.test\/find-work">Find work<\/a><\/li>/, 'the main menu is the CMS menu');

  assert.equal(footerBlock(portal.body), footerBlock(marketing.body), 'the footer is shared too');
  assert.match(String(portal.body), /<p class="site-footer__text">Fractional work, listed by the day\.<\/p>/);
});

test('P-7 — a menu entry naming a package-served page does not cost the portal its header', async () => {
  // The live tenant's main menu points at `/jobs`, which is a row in the job board's table and not
  // a `cms_page`. `loadNav` refuses that as a dead link unless the caller says a package serves
  // it; the CMS render path says so, and the portal must pass the same predicate. Without it,
  // `#chromeParts` refuses and every portal page loses its header — which is exactly what the
  // first deployed build did.
  const local = makeFixture({ specs: [{ key: 'menu', hosts: ['menu.test'] }] });
  const env = loadEnv(local.env);
  const tenant = 'menu';
  const seedDb = new Database(local.sitePath(tenant));
  seedDb.prepare('INSERT INTO cms_settings (key, value_json, type) VALUES (?, ?, ?)').run(
    'site.title',
    JSON.stringify('Menu Tenant'),
    'string',
  );
  seedDb
    .prepare(
      `INSERT INTO cms_nav (location, label, href_kind, href_target, position, visible)
       VALUES ('header', 'Jobs', 'page', '/jobs', 0, 1)`,
    )
    .run();
  seedDb.close();

  const build = async (pageExists?: (key: string, path: string) => boolean): Promise<ReturnType<typeof Fastify>> => {
    const app = Fastify({ logger: false });
    app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) =>
      done(null, body),
    );
    registerPortal(app, {
      accounts: new Accounts({
        env,
        openDb: (key: string) => new Database(local.sitePath(key)),
        argon: new Semaphore(2),
        exposeVerifyLink: true,
      }),
      env,
      tenantOf: () => tenant,
      emailMode: 'off',
      openDb: (key: string) => new Database(local.sitePath(key)),
      ...(pageExists === undefined ? {} : { pageExists }),
    });
    await app.ready();
    return app;
  };

  try {
    const served = await build((_key, path) => path === '/jobs');
    const page = await served.inject({ method: 'GET', url: '/portal/register', headers: { host: 'menu.test' } });
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /<header class="site-header[^"]*"/, 'the header is drawn');
    assert.match(page.body, /<a href="\/jobs">Jobs<\/a>/, 'and it carries the package-served link');

    // The negative control: with no predicate the row is refused, `#chromeParts` falls back, and
    // the page still renders — just without the site around it. A header assertion must be able
    // to fail, or P-1 would pass on a portal that had no chrome at all.
    const bare = await build();
    const barePage = await bare.inject({ method: 'GET', url: '/portal/register', headers: { host: 'menu.test' } });
    assert.equal(barePage.statusCode, 200, 'the form is still served');
    assert.doesNotMatch(barePage.body, /<header/, 'a refused menu drops the bar rather than the page');
    await served.close();
    await bare.close();
  } finally {
    local.cleanup();
  }
});

