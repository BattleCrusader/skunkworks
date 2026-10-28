/**
 * The public board: `GET /jobs` and `GET /jobs/<id>`, over real HTTP, against real rows.
 *
 * What this file proves, in the order the tests appear:
 *
 *   1. the list shows **only published** adverts, newest first, and every row a visitor needs is in
 *      it: title, company, day rate as money, days a week, location, remote, posted date and a link;
 *   2. a draft and a closed advert are absent from the list *and* their detail URLs are 404s — the
 *      filter is in the query, so guessing an id is not a way in;
 *   3. an unknown id and another tenant's id are both the site's ordinary 404, and one tenant's id
 *      never resolves on another tenant's host (each site is its own file, and the read is scoped to
 *      the Host's);
 *   4. pagination is bounded: 20 a page, page 2 carries the remainder, a page past the end is a 404
 *      and a nonsense `?page=` is page 1;
 *   5. an empty board is a page, not an error: it says so and links a company to advertiser sign-up —
 *      and a tenant with no job-board package installed gets the same page rather than a 500;
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
  readonly dayRateCents?: number | null;
  readonly daysPerWeek?: number | null;
  readonly location?: string;
  readonly remoteOk?: boolean;
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
           (company_id, title, slug, summary, body, day_rate_cents, currency, days_per_week,
            location, remote_ok, status, published_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'AUD', ?, ?, ?, ?, ?, '2026-10-01T00:00:00.000Z')`,
      )
      .run(
        Number(company.lastInsertRowid),
        job.title,
        job.slug,
        job.summary ?? `${job.title}, in one line.`,
        job.body ?? `${job.title} — the work, as the company wrote it.\n\nThe first three months.`,
        job.dayRateCents === undefined ? 120_000 : job.dayRateCents,
        job.daysPerWeek === undefined ? 2 : job.daysPerWeek,
        job.location ?? 'Sydney',
        job.remoteOk === false ? 0 : 1,
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
    dayRateCents: 120_000,
    daysPerWeek: 2,
    location: 'Sydney',
    remoteOk: true,
    publishedAt: '2026-10-20T00:00:00.000Z',
  });
  const res = await get('/jobs');
  assert.equal(res.status, 200, res.body);
  assert.match(res.body, /<h1 class="fw-h2">Roles on the board\.<\/h1>/);
  assert.match(res.body, /Fractional CTO/, 'the role title');
  assert.match(res.body, /Northwind/, 'the company name');
  assert.match(res.body, /\$1,200 a day/, 'the day rate, as money');
  assert.match(res.body, /2 days a week/, 'the days a week');
  assert.match(res.body, /Sydney/, 'the location');
  assert.match(res.body, /Remote: yes/, 'the remote flag');
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
  assert.match(res.body, /\$1,200 a day/, 'the day rate');
  assert.match(res.body, /2 days a week/, 'the days a week');
  assert.match(res.body, /Sydney/, 'the location');
  assert.match(res.body, /Posted<\/p>\s*<p class="fw-card__body">20 October 2026<\/p>/, 'the posted date');
  // The Apply call to action: the portal for a signed-in applicant, and the sign-in form (with the
  // way back) for everyone else. The portal cookie is scoped to `/portal`, so this page cannot see
  // it — which is why both doors are named rather than guessed.
  assert.match(res.body, /<a class="fw-btn fw-btn--primary" href="\/portal\/applicant">Apply<\/a>/);
  assert.match(res.body, /href="\/portal\/signin\?next=\/portal\/applicant"/);
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
    assert.match(res.body, /<a href="\/jobs">Jobs<\/a>/, `${path} carries the Jobs menu item`);
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

test('PJ-12. a tenant with no job-board package answers an empty board, not a 500', async () => {
  const res = await get('/jobs', NOBOARD);
  assert.equal(res.status, 200, 'no package is no adverts, which is an empty board');
  assert.match(res.body, /No open roles yet\./);
  assert.equal((await get('/jobs/1', NOBOARD)).status, 404);
});

test('PJ-13. the sitemap names the board', async () => {
  const res = await get('/sitemap.xml');
  assert.equal(res.status, 200, res.body);
  assert.match(res.body, new RegExp(`<loc>https://${ALPHA}/jobs</loc>`));
});
