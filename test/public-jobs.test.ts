/**
 * The public board: `GET /jobs` and `GET /jobs/<id>`, over real HTTP, against real rows.
 *
 * What this file proves, in the order the tests appear:
 *
 *   1. the list shows **only published** adverts, newest first, and every row a visitor needs is in
 *      it: title, company, hourly rate as money, days a week, location, work arrangement, posted
 *      date and a link;
 *   2. a draft and a closed advert are absent from the list *and* their detail URLs are 404s — the
 *      filter is in the query, so guessing an id is not a way in;
 *   3. an unknown id and another tenant's id are both the site's ordinary 404, and one tenant's id
 *      never resolves on another tenant's host (each site is its own file, and the read is scoped to
 *      the Host's);
 *   4. pagination is bounded: 20 a page, page 2 carries the remainder, a page past the end is a 404
 *      and a nonsense `?page=` is page 1;
 *   5. an installed board with no adverts is a page, not an error: it says so and links a company to
 *      advertiser sign-up — and a tenant with **no job-board package** has no board at all, so
 *      `/jobs` is its ordinary 404 and the sitemap does not name it;
 *   6. the detail page's `<title>` carries the role and the company, `<meta name="description">` and
 *      the canonical URL are there, and both pages are wrapped in **the site's own chrome**: the
 *      `site-header`/`site-footer` classes, the `Main` nav (including the `Jobs` item) and the
 *      tenant's `/theme.css`. That is the proof the shell was reused rather than copied.
 *
 * The package is installed through `installPlugin()` — the same call `skwctl plugin install` makes —
 * so the facade grant, the tables and the manifest row are the real ones. Adverts are inserted with
 * SQL **in the fixture only**: the app itself may not write these tables, which is the whole point
 * of `app/accounts/jobs.ts` reading through `hostOp`.
 */
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { loadEnv } from '../app/env.ts';
import { buildApp, type AppHandle } from '../app/main.ts';
import { installPlugin } from '../app/plugins/install.ts';
import { packageRootHash } from '../app/plugins/manifest.ts';
import { REPO, makeFixture, type Fixture } from './helpers/fixture.ts';
import { installMenuPackage } from './helpers/menu-package.ts';
import { call, type Res } from './helpers/http.ts';

const JOBBOARD = join(REPO, 'plugins', 'jobboard');
const DIGEST = 'sha256:public-jobs';
const ALPHA = 'alpha.test';
const BETA = 'beta.test';
const EMPTY = 'empty.test';
const NOBOARD = 'noboard.test';

let fixture: Fixture;
let handle: AppHandle;
let port = 0;

/** Install the board the way the CLI does: the copied tree, the tables, the enabled row. */
function installBoard(tenant: string): void {
  const { root } = packageRootHash(JOBBOARD);
  const report = join(fixture.dir, `jobboard-report-${tenant}.json`);
  writeFileSync(
    report,
    `${JSON.stringify({
      plugin: 'jobboard',
      version: '1.0.0',
      root_hash: root,
      runner_image_digest: DIGEST,
      ran_at: '2026-10-28T00:00:00.000Z',
      passed: 1,
      failed: 0,
    })}\n`,
  );
  installPlugin({
    siteDb: fixture.sitePath(tenant),
    pluginsRoot: join(fixture.dir, 'plugins'),
    sourceDir: JOBBOARD,
    allowUnsigned: true,
    testReportPath: report,
    runnerImageDigest: DIGEST,
    enable: true,
  });
}

interface JobSeed {
  readonly company: string;
  readonly title: string;
  readonly slug: string;
  readonly summary?: string;
  readonly body?: string;
  readonly hourlyRateCents?: number | null;
  readonly daysPerWeek?: number | null;
  readonly location?: string;
  readonly workMode?: 'onsite' | 'hybrid' | 'remote';
  readonly status?: 'draft' | 'published' | 'closed';
  readonly publishedAt?: string | null;
}

/** A company + advert, written straight into the tenant's file: fixture data, not app code. */
function seedJob(tenant: string, job: JobSeed): number {
  const db = new Database(fixture.sitePath(tenant));
  db.pragma('busy_timeout = 5000');
  try {
    const company = db
      .prepare(
        `INSERT INTO p_jobboard_company (account_id, name, url, about, created_at)
         VALUES (0, ?, NULL, NULL, '2026-10-01T00:00:00.000Z')`,
      )
      .run(job.company);
    const row = db
      .prepare(
        `INSERT INTO p_jobboard_job
           (company_id, title, slug, summary, body, hourly_rate_cents, currency, days_per_week,
            location, work_mode, status, published_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'AUD', ?, ?, ?, ?, ?, '2026-10-01T00:00:00.000Z')`,
      )
      .run(
        Number(company.lastInsertRowid),
        job.title,
        job.slug,
        job.summary ?? `${job.title}, in one line.`,
        job.body ?? `${job.title} — the work, as the company wrote it.\n\nThe first three months.`,
        job.hourlyRateCents === undefined ? 9_550 : job.hourlyRateCents,
        job.daysPerWeek === undefined ? 2 : job.daysPerWeek,
        job.location ?? 'Sydney',
        job.workMode ?? 'hybrid',
        job.status ?? 'published',
        job.publishedAt === undefined ? '2026-10-20T00:00:00.000Z' : job.publishedAt,
      );
    return Number(row.lastInsertRowid);
  } finally {
    db.close();
  }
}

/** The chrome and the two menus a site has after an operator has opened the Site screen. */
function seedSite(tenant: string, title: string): void {
  const db = new Database(fixture.sitePath(tenant));
  db.pragma('busy_timeout = 5000');
  try {
    const setting = db.prepare(
      `INSERT INTO cms_settings (key, value_json, type, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
    );
    setting.run('site.title', JSON.stringify(title), 'string', '2026-10-01T00:00:00.000Z');
    setting.run('site.footer_text', JSON.stringify(`© 2026 ${title}`), 'string', '2026-10-01T00:00:00.000Z');
    setting.run('site.header_sticky', JSON.stringify(true), 'bool', '2026-10-01T00:00:00.000Z');
    setting.run('site.footer_sticky', JSON.stringify(false), 'bool', '2026-10-01T00:00:00.000Z');
    const nav = db.prepare(
      `INSERT INTO cms_nav (location, label, href_kind, href_target, position, visible)
       VALUES (?, ?, 'page', ?, ?, 1)`,
    );
    // `Jobs` is a core route with no `cms_page` row: the live render and the editor both have to
    // accept it, or the menu loses the item that matters most.
    nav.run('header', 'Jobs', '/jobs', 0);
    nav.run('header', 'Pricing', '/pricing', 1);
    nav.run('footer', 'Pricing', '/pricing', 0);
  } finally {
    db.close();
  }
}

function get(path: string, host = ALPHA): Promise<Res> {
  return call({ port, path, host });
}

before(async () => {
  fixture = makeFixture({
    specs: [
      { key: 'alpha', hosts: [ALPHA], displayName: 'Alpha' },
      { key: 'beta', hosts: [BETA], displayName: 'Beta' },
      { key: 'empty', hosts: [EMPTY], displayName: 'Empty' },
      { key: 'noboard', hosts: [NOBOARD], displayName: 'No board' },
    ],
  });
  for (const tenant of ['alpha', 'beta', 'empty']) installBoard(tenant);
  // Chrome assertions need the `menu` package: the site bar is its feature, not `cms_nav`'s.
  for (const tenant of ['alpha', 'beta', 'empty']) {
    const site = new Database(fixture.sitePath(tenant));
    installMenuPackage(site, fixture.dir);
    site.close();
  }
  seedSite('alpha', 'Alpha Works');
  seedSite('empty', 'Empty Works');
  handle = await buildApp({ env: loadEnv(fixture.env) });
  port = await handle.app.listen({ port: 0, host: '127.0.0.1' }).then(() => {
    const address = handle.app.server.address();
    assert.ok(address !== null && typeof address === 'object', 'the app is listening on a port');
    return address.port;
  });
});

after(async () => {
  await handle.close();
  fixture.cleanup();
});

/** Ids are assigned by SQLite, so the tests read them from the rows they inserted. */
let ctoId = 0;
let cfoId = 0;
let draftId = 0;
let closedId = 0;

test('PJ-1. the list shows the published advert with every fact a visitor needs', async () => {
  ctoId = seedJob('alpha', {
    company: 'Northwind',
    title: 'Fractional CTO',
    slug: 'fractional-cto',
    summary: 'Two days a week to own the platform.',
    hourlyRateCents: 9_550,
    daysPerWeek: 2,
    location: 'Sydney',
    workMode: 'hybrid',
    publishedAt: '2026-10-20T00:00:00.000Z',
  });
  const res = await get('/jobs');
  assert.equal(res.status, 200, res.body);
  assert.match(res.body, /<h1 class="fw-h2">Roles on the board\.<\/h1>/);
  assert.match(res.body, /Fractional CTO/, 'the role title');
  assert.match(res.body, /Northwind/, 'the company name');
  assert.match(res.body, /\$95\.50\/hour/, 'the hourly rate, as money');
  assert.match(res.body, /2 days a week/, 'the days a week');
  assert.match(res.body, /Sydney/, 'the location');
  assert.match(res.body, /Hybrid/, 'the work arrangement, in words');
  assert.doesNotMatch(res.body, /Remote: (yes|no)/, 'there is no yes/no remote flag any more');
  assert.doesNotMatch(res.body, /a day\b/, 'nothing on the board is priced by the day');
  assert.match(res.body, /Posted 20 October 2026/, 'the posted date');
  assert.match(res.body, new RegExp(`href="/jobs/${String(ctoId)}"`), "a link to the advert's own page");
  assert.match(res.body, /Two days a week to own the platform\./, 'the one-line summary');
});

test('PJ-2. newest first: the later advert is rendered before the earlier one', async () => {
  cfoId = seedJob('alpha', {
    company: 'Lumen',
    title: 'Fractional CFO',
    slug: 'fractional-cfo',
    publishedAt: '2026-10-25T00:00:00.000Z',
  });
  const res = await get('/jobs');
  assert.equal(res.status, 200, res.body);
  assert.ok(
    res.body.indexOf('Fractional CFO') < res.body.indexOf('Fractional CTO'),
    'the 25 October advert must precede the 20 October one',
  );
});

test('PJ-3. a draft and a closed advert are absent from the list, and their pages are 404', async () => {
  draftId = seedJob('alpha', { company: 'Northwind', title: 'Draft role', slug: 'draft-role', status: 'draft', publishedAt: null });
  closedId = seedJob('alpha', { company: 'Northwind', title: 'Closed role', slug: 'closed-role', status: 'closed', publishedAt: null });
  const list = await get('/jobs');
  assert.equal(list.status, 200, list.body);
  assert.doesNotMatch(list.body, /Draft role/, 'a draft is not on the board');
  assert.doesNotMatch(list.body, /Closed role/, 'a closed advert is not on the board');
  for (const [label, id] of [['draft', draftId], ['closed', closedId]] as [string, number][]) {
    const detail = await get(`/jobs/${String(id)}`);
    assert.equal(detail.status, 404, `${label} advert ${String(id)} must be a 404: ${detail.body}`);
    assert.doesNotMatch(detail.body, new RegExp(label === 'draft' ? 'Draft role' : 'Closed role'));
  }
});

test('PJ-4. an unknown id is the site\u2019s ordinary 404', async () => {
  const res = await get('/jobs/999999');
  assert.equal(res.status, 404, res.body);
  const body = res.json as { error?: { code?: string } };
  assert.equal(body.error?.code, 'SKW_E_RT_PAGE_NOT_FOUND', 'the same 404 a missing page answers');
});

test('PJ-5. another tenant\u2019s advert id resolves on its own host and nowhere else', async () => {
  const betaId = seedJob('beta', {
    company: 'Beta Co',
    title: 'Beta only role',
    slug: 'beta-only',
    publishedAt: '2026-10-22T00:00:00.000Z',
  });
  const onBeta = await get(`/jobs/${String(betaId)}`, BETA);
  assert.equal(onBeta.status, 200, onBeta.body);
  assert.match(onBeta.body, /Beta only role/);

  // The same id on Alpha's host is Alpha's advert (or nothing) — never Beta's row.
  const crossTenantId = await get(`/jobs/${String(betaId)}`);
  assert.doesNotMatch(crossTenantId.body, /Beta only role/, 'a row from another tenant is not readable');

  // And an id that exists, published, on Alpha is a 404 on Beta.
  const crossTenantKnown = await get(`/jobs/${String(cfoId)}`, BETA);
  assert.equal(crossTenantKnown.status, 404, crossTenantKnown.body);
});

test('PJ-6. the detail page carries the advert, its Apply call to action, and its own head', async () => {
  const res = await get(`/jobs/${String(ctoId)}`);
  assert.equal(res.status, 200, res.body);
  const title = /<title>([^<]*)<\/title>/.exec(res.body)?.[1] ?? '';
  assert.match(title, /Fractional CTO/, `the advert title is in <title>; got ${JSON.stringify(title)}`);
  assert.match(title, /Northwind/, 'the company is in <title> too');
  assert.match(res.body, /<meta name="description" content="[^"]*Fractional CTO/, 'a per-page description naming the role');
  assert.match(res.body, new RegExp(`<link rel="canonical" href="https://${ALPHA}/jobs/${String(ctoId)}">`), 'a canonical to the id URL');
  assert.match(res.body, /<p>Fractional CTO — the work, as the company wrote it\.<\/p>/, 'the first paragraph of the body');
  assert.match(res.body, /<p>The first three months\.<\/p>/, 'the body is rendered as paragraphs');
  assert.match(res.body, /Northwind/, 'the company');
  assert.match(res.body, /\$95\.50\/hour/, 'the hourly rate');
  assert.match(res.body, /2 days a week/, 'the days a week');
  assert.match(res.body, /Sydney/, 'the location');
  assert.match(res.body, /<p class="fw-card__mark">Work arrangement<\/p>\s*<p class="fw-card__body">Hybrid<\/p>/, 'the work arrangement is a fact card');
  assert.match(res.body, /Posted<\/p>\s*<p class="fw-card__body">20 October 2026<\/p>/, 'the posted date');
  // The Apply call to action is the role's own application page. This page cannot know whether the
  // visitor holds a session (`/portal` cookies are scoped, and the board is public), so the button
  // names the one address both visitors can use: `/jobs/<id>/apply`, which sends a signed-out
  // visitor to the sign-in form with that page as `next` and comes back with the advert in hand.
  // The button points at the portal-scoped path, because the session cookie is `Path=/portal` —
  // `/jobs/<id>/apply` would arrive without a session and bounce a signed-in applicant to sign-in.
  assert.match(
    res.body,
    new RegExp(`<a class="fw-btn fw-btn--primary" href="/portal/jobs/${String(ctoId)}/apply">Apply now</a>`),
  );
  assert.match(
    res.body,
    new RegExp(`href="/portal/signin\\?next=/portal/jobs/${String(ctoId)}/apply"`),
  );
  assert.doesNotMatch(res.body, /Apply from your applicant page/, 'the advert-number copy is gone');
  assert.doesNotMatch(res.body, /advert number/i);
});

test('PJ-7. the slug address the home page links to is the same advert', async () => {
  const res = await get('/jobs/fractional-cto');
  assert.equal(res.status, 200, res.body);
  assert.match(res.body, /<h1 class="fw-h2">Fractional CTO<\/h1>/);
  const title = /<title>([^<]*)<\/title>/.exec(res.body)?.[1] ?? '';
  assert.match(title, /Fractional CTO/);
});

test('PJ-8. both pages wear the site\u2019s own chrome, not a copy of it', async () => {
  for (const path of ['/jobs', `/jobs/${String(ctoId)}`]) {
    const res = await get(path);
    assert.equal(res.status, 200, res.body);
    assert.match(res.body, /<header class="site-header site-header--sticky">/, `${path} has the site header`);
    assert.match(res.body, /<nav aria-label="Main">/, `${path} has the main menu`);
    // `[^>]*` because the menu marks the current page (`aria-current="page"`) — on `/jobs` that is
    // this item, on `/jobs/<id>` it is not, and both are the same menu.
    assert.match(res.body, /<a href="\/jobs"[^>]*>Jobs<\/a>/, `${path} carries the Jobs menu item`);
    assert.match(res.body, /<footer class="site-footer">/, `${path} has the site footer`);
    assert.match(res.body, /<p class="site-footer__text">© 2026 Alpha Works<\/p>/, `${path} has the footer sentence`);
    assert.match(res.body, /<link rel="stylesheet" href="\/theme.css\?v=[0-9a-f]{6,64}">/, `${path} links the tenant sheet`);
    assert.match(res.body, /<main>/, `${path} puts the board inside <main>`);
  }
});

test('PJ-9. the stylesheet answers with a /jobs menu row present', async () => {
  // `loadNav` refuses a `page` entry with no published row; `/jobs` is a core route, and this is
  // the caller that would have 500'd the whole site's CSS if that had been forgotten.
  const res = await get('/theme.css');
  assert.equal(res.status, 200, res.body);
  assert.match(res.body, /\.site-header\{/);
  assert.doesNotMatch(res.body, /SKW_E_RT_NAV_TARGET_MISSING/);
});

test('PJ-10. pagination is bounded: 20 a page, a remainder, and 404 past the end', async () => {
  // Twenty more published adverts, older than the two already there, so the totals are exact.
  for (let i = 0; i < 20; i += 1) {
    seedJob('alpha', {
      company: `Company ${String(i)}`,
      title: `Backlog role ${String(i)}`,
      slug: `backlog-${String(i)}`,
      publishedAt: `2026-09-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`,
    });
  }
  const first = await get('/jobs');
  assert.equal(first.status, 200, first.body);
  const firstHrefs = [...first.body.matchAll(/href="(\/jobs\/\d+)"/g)].map((m) => m[1] as string);
  assert.equal(firstHrefs.length, 20, `page 1 is a full page of 20; got ${String(firstHrefs.length)}`);
  assert.match(first.body, /Page 1 of 2/);
  assert.match(first.body, /href="\/jobs\?page=2" rel="next"/);
  assert.doesNotMatch(first.body, /href="\/jobs\?page=0"/, 'there is no page before the first');

  const second = await get('/jobs?page=2');
  assert.equal(second.status, 200, second.body);
  const secondHrefs = [...second.body.matchAll(/href="(\/jobs\/\d+)"/g)].map((m) => m[1] as string);
  assert.equal(secondHrefs.length, 2, `page 2 carries the remainder; got ${String(secondHrefs.length)}`);
  assert.equal(new Set([...firstHrefs, ...secondHrefs]).size, 22, 'no advert appears on both pages');
  assert.match(second.body, /href="\/jobs\?page=1" rel="prev"/);

  const past = await get('/jobs?page=999');
  assert.equal(past.status, 404, 'a page past the end is the site\u2019s 404');
  const unbounded = await get('/jobs?page=501');
  assert.equal(unbounded.status, 404, 'the page number is bounded by JOBS_MAX_PAGE');
  const nonsense = await get('/jobs?page=abc');
  assert.equal(nonsense.status, 200, 'a hand-edited query string lands on the first page');
  assert.match(nonsense.body, /Page 1 of 2/);
});

test('PJ-11. an empty board is a page that says so and points companies at sign-up', async () => {
  const res = await get('/jobs', EMPTY);
  assert.equal(res.status, 200, 'an empty board is not a 404');
  assert.match(res.body, /No open roles yet\./);
  assert.match(res.body, /href="\/portal\/register\?role=advertiser"/, 'a company knows where to go');
  assert.match(res.body, /<header class="site-header site-header--sticky">/, 'the empty page is still the site');
  assert.equal((await get('/jobs/1', EMPTY)).status, 404, 'there is nothing to open');
});

test('PJ-12. a tenant with no job-board package has no board: `/jobs` is the site 404, and the sitemap omits it', async () => {
  // The board is a package a tenant installs. A site that never installed it has no jobs page, and
  // an "no open roles yet" page would be the CMS inventing a feature the customer does not have —
  // the exact way `/jobs` came to appear on a marketing site with no such functionality.
  const res = await get('/jobs', NOBOARD);
  assert.equal(res.status, 404, 'no package is no board, not an empty one');
  assert.equal((res.json as { error?: { code?: string } }).error?.code, 'SKW_E_RT_PAGE_NOT_FOUND');
  assert.equal((await get('/jobs/1', NOBOARD)).status, 404);

  const sitemap = await get('/sitemap.xml', NOBOARD);
  assert.equal(sitemap.status, 200, sitemap.body);
  assert.ok(
    !locsOf(sitemap.body, NOBOARD).includes('/jobs'),
    `a site with no board must not invite a crawler to one: ${sitemap.body}`,
  );
});

test('PJ-13. the sitemap names the board', async () => {
  const res = await get('/sitemap.xml');
  assert.equal(res.status, 200, res.body);
  assert.match(res.body, new RegExp(`<loc>https://${ALPHA}/jobs</loc>`));
});

/** Every `<loc>` in a sitemap body, the tenant's origin stripped. */
function locsOf(xml: string, host = ALPHA): string[] {
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => String(m[1]).replace(`https://${host}`, ''));
}

test('PJ-14. every published advert is in the sitemap, and no unpublished one is', async () => {
  const res = await get('/sitemap.xml');
  assert.equal(res.status, 200, res.body);
  const locs = locsOf(res.body);

  // The board's rows are not `cms_page` rows: they exist only because the host serves them, so
  // they are in the file only if the route declared them. Both published adverts must be there.
  for (const [label, id] of [['cto', ctoId], ['cfo', cfoId]] as [string, number][]) {
    assert.ok(locs.includes(`/jobs/${String(id)}`), `${label} advert ${String(id)} must be listed: ${res.body}`);
  }
  // A draft and a closed advert are 404s on the site (PJ-3). A `<loc>` for one is an invitation to
  // crawl a 404, which is exactly the drift this enumeration removes.
  for (const [label, id] of [['draft', draftId], ['closed', closedId]] as [string, number][]) {
    assert.ok(!locs.includes(`/jobs/${String(id)}`), `${label} advert ${String(id)} must not be listed`);
  }
  // One `<loc>` per published advert — the index exactly once, and **no slug duplicates**: the
  // board declares `/jobs/<id>` canonical, and the package's `/jobs/{slug}` is the same advert at
  // a second address, so listing both would advertise a duplicate of every row.
  const boardLocs = locs.filter((path) => path === '/jobs' || path.startsWith('/jobs/'));
  const published = new Database(fixture.sitePath('alpha'))
    .prepare("SELECT COUNT(*) AS n FROM p_jobboard_job WHERE status = 'published'")
    .get() as { n: number };
  assert.equal(boardLocs.filter((path) => path === '/jobs').length, 1, 'the index is named once');
  assert.deepEqual(
    boardLocs.filter((path) => path.startsWith('/jobs/')).every((path) => /^\/jobs\/\d+$/.test(path)),
    true,
    `every advert URL is its canonical id address, got ${JSON.stringify(boardLocs)}`,
  );
  assert.equal(
    boardLocs.length,
    published.n + 1,
    `index + one URL per published advert (${String(published.n)}), got ${JSON.stringify(boardLocs)}`,
  );
});

test('PJ-15. every `<loc>` the sitemap publishes answers 200 — no crawlable 404s', async () => {
  const res = await get('/sitemap.xml');
  assert.equal(res.status, 200, res.body);
  const locs = locsOf(res.body);
  assert.ok(locs.length > 0, 'a sitemap with no URLs proves nothing');
  for (const path of locs) {
    const page = await get(path);
    assert.equal(page.status, 200, `${path} is invited to a crawler but answers ${String(page.status)}`);
  }
});
