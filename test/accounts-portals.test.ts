/**
 * The two portal pages, over real HTTP, against real rows in a real `site.db`.
 *
 * What is being proved, in the order the tests appear:
 *
 *   1. an applicant's page is *their* rows — a second applicant's application is not in the bytes;
 *   2. an advertiser's page is their own adverts' applicants, and the HTML carries no address for
 *      any of them (the projection has no field for one, and this asserts the consequence);
 *   3. a hidden profile is never enumerated: it cannot apply, and no advertiser page shows it;
 *   4. every named refusal — duplicate, closed, unknown advert, own advert, hidden profile;
 *   5. an application enqueues exactly one mail, to the advertiser, and the rendered message
 *      contains a name and a headline and no address;
 *   6. the profile POST writes the eight fields the form owns, refuses a third visibility state,
 *      and refuses a missing CSRF token or a foreign Origin before it reads anything;
 *   7. the advertiser's decision is scoped to their own application, refuses `submitted`, and
 *      cannot reopen a withdrawn one;
 *   8. role mismatch is refused by name on both pages;
 *   9. a session minted on one tenant finds nothing on another.
 *
 * The job board plugin is **installed** in every fixture (`cms_plugin_installed` + the manifest's
 * own DDL), because the portal's advert read goes through the plugin facade: a tenant without the
 * package has no adverts, which is a case the last test covers deliberately.
 */
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { Accounts, type Role } from '../app/accounts/service.ts';
import { registerPortal } from '../app/accounts/routes.ts';
import { Semaphore, totpCode } from '../app/admin/auth.ts';
import { parseManifest, tableStatements } from '../app/plugins/manifest.ts';
import { renderMail } from '../app/mail/templates.ts';
import type { Env } from '../app/env.ts';
import { REPO, SCHEMA } from './helpers/fixture.ts';

const root = mkdtempSync(join(tmpdir(), 'skw-portals-'));
after(() => rmSync(root, { recursive: true, force: true }));

const ENV = {
  ipHashKey: 'portals-test-ip-hash-key-0123456789',
  sessionKey: 'portals-test-session-key-0123456789',
} as Env;
const HOST = 'fractional.test';
const ORIGIN = `https://${HOST}`;
const PASSWORD = 'correct horse battery staple';
const NOW = '2026-10-28T00:00:00.000Z';

const JOBBOARD = JSON.parse(readFileSync(join(REPO, 'plugins', 'jobboard', 'plugin.json'), 'utf8')) as unknown;
const JOBBOARD_MANIFEST = parseManifest(JOBBOARD);

/** A tenant's file, created from the shipped DDL on first use. */
function dbFile(key: string): string {
  const dir = join(root, key);
  mkdirSync(dir, { recursive: true });
  return join(dir, 'site.db');
}

/**
 * Install the job board the way the host does: the manifest row, then the tables the manifest
 * declares. The portal reads adverts through the facade, and the facade's grant *is* that row.
 */
function installJobboard(key: string): void {
  const handle = new Database(dbFile(key));
  try {
    handle.exec(readFileSync(join(SCHEMA, 'site.sql'), 'utf8'));
    for (const statement of tableStatements(JOBBOARD_MANIFEST)) handle.exec(statement);
    handle
      .prepare(
        `INSERT INTO cms_plugin_installed
           (plugin_id, version, manifest_json, root_hash, publisher, signature_state, enabled, test_report_sha)
         VALUES ('jobboard', ?, ?, ?, 'skunkworks', 'first_party', 1, 'sha256:test')`,
      )
      .run(JOBBOARD_MANIFEST.version, JSON.stringify(JOBBOARD), 'a'.repeat(64));
  } finally {
    handle.close();
  }
}

interface Built {
  app: ReturnType<typeof Fastify>;
  db(): Database.Database;
  tenant: { key: string };
}

let next = 0;

async function build(withPlugin = true): Promise<Built> {
  const key = `portals-${(next += 1)}`;
  if (withPlugin) installJobboard(key);
  else {
    const handle = new Database(dbFile(key));
    handle.exec(readFileSync(join(SCHEMA, 'site.sql'), 'utf8'));
    handle.close();
  }
  const tenant = { key };
  const accounts = new Accounts({
    env: ENV,
    openDb: (k: string) => new Database(dbFile(k)),
    argon: new Semaphore(4),
    exposeVerifyLink: true,
  });
  const app = Fastify({ logger: false });
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) =>
    done(null, body),
  );
  registerPortal(app, {
    accounts,
    env: ENV,
    tenantOf: () => tenant.key,
    exposeVerifyLink: true,
    emailMode: 'off',
    openDb: (k: string) => new Database(dbFile(k)),
  });
  await app.ready();
  return { app, db: () => new Database(dbFile(tenant.key)), tenant };
}

function post(url: string, form: Record<string, string | string[]>, extra: Record<string, string> = {}) {
  const usp = new URLSearchParams();
  for (const [key, value] of Object.entries(form)) {
    for (const item of Array.isArray(value) ? value : [value]) usp.append(key, item);
  }
  return {
    method: 'POST' as const,
    url,
    headers: { host: HOST, origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded', ...extra },
    payload: usp.toString(),
  };
}

function get(url: string, extra: Record<string, string> = {}) {
  return { method: 'GET' as const, url, headers: { host: HOST, ...extra } };
}

interface Session {
  readonly cookie: string;
  readonly csrf: string;
  readonly accountId: number;
}

/**
 * A person who can sign in: register, prove the address, enrol the authenticator, sign in — the
 * whole public path, because a session minted by hand would not prove the pages accept a real one.
 */
async function enterAs(built: Built, email: string, displayName: string, roles: readonly Role[]): Promise<Session> {
  const reg = await built.app.inject(
    post('/portal/register', { email, password: PASSWORD, display_name: displayName, role: [...roles] }),
  );
  assert.equal(reg.statusCode, 200, reg.body);
  const url = /\/portal\/verify\?token=[0-9a-f]{64}/.exec(reg.body)?.[0];
  assert.ok(url !== undefined, 'the offline operator sees the verification link');
  const verified = await built.app.inject(get(url));
  assert.equal(verified.statusCode, 200);
  const enrolCookie = String(verified.headers['set-cookie']).split(';')[0] as string;

  const handle = built.db();
  const row = handle.prepare('SELECT id, totp_secret FROM cms_account WHERE email = ?').get(email) as {
    id: number;
    totp_secret: string;
  };
  handle.close();

  const enrol = await built.app.inject(
    post('/portal/enrol', { code: totpCode(row.totp_secret, Date.now()) }, { cookie: enrolCookie }),
  );
  assert.equal(enrol.statusCode, 303, enrol.body);

  const signin = await built.app.inject(
    post('/portal/signin', { email, password: PASSWORD, code: totpCode(row.totp_secret, Date.now()) }),
  );
  assert.equal(signin.statusCode, 303, signin.body);
  const cookie = String(signin.headers['set-cookie']).split(';')[0] as string;

  // The token a browser would copy out of a form on the page it lands on.
  const home = await built.app.inject(get('/portal', { cookie }));
  assert.equal(home.statusCode, 200);
  const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(home.body)?.[1];
  assert.ok(csrf !== undefined, 'a signed-in page carries its session CSRF token');
  return { cookie, csrf, accountId: row.id };
}

interface Job {
  readonly jobId: number;
  readonly companyId: number;
}

let slugN = 0;

/** One advert, owned by `owner`, created the way the plugin's own tables expect it. */
function addJob(handle: Database.Database, owner: number, title: string, status = 'published'): Job {
  const existing = handle.prepare('SELECT id FROM p_jobboard_company WHERE account_id = ?').get(owner) as
    | { id: number }
    | undefined;
  const companyId =
    existing?.id ??
    Number(
      handle
        .prepare('INSERT INTO p_jobboard_company (account_id, name, created_at) VALUES (?, ?, ?)')
        .run(owner, `Company ${owner}`, NOW).lastInsertRowid,
    );
  slugN += 1;
  const jobId = Number(
    handle
      .prepare(
        `INSERT INTO p_jobboard_job
           (company_id, title, slug, summary, body, currency, remote_ok, status, published_at, created_at)
         VALUES (?, ?, ?, 'one line', 'the role', 'AUD', 1, ?, ?, ?)`,
      )
      .run(companyId, title, `role-${slugN}`, status, status === 'published' ? NOW : null, NOW).lastInsertRowid,
  );
  return { jobId, companyId };
}

/** The projection's fields are a choice; the absence of a contact field is the promise. */
const EMAIL_SHAPED = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/;

test('P1 — an applicant sees their own applications and only theirs', async () => {
  const built = await build();
  const advertiser = await enterAs(built, 'owner@acme.test', 'Owner', ['advertiser']);
  const alice = await enterAs(built, 'alice@example.test', 'Alice Rivera', ['applicant']);
  const bob = await enterAs(built, 'bob@example.test', 'Bob Chen', ['applicant']);

  const handle = built.db();
  const cto = addJob(handle, advertiser.accountId, 'Fractional CTO');
  const designer = addJob(handle, advertiser.accountId, 'Fractional Designer');
  // Applying requires a discoverable profile (P3 proves the refusal); both applicants choose that.
  handle.prepare("UPDATE cms_profile SET visibility = 'discoverable' WHERE account_id IN (?, ?)").run(
    alice.accountId,
    bob.accountId,
  );
  handle.close();

  for (const [session, jobId, note] of [
    [alice, cto.jobId, 'I have run two platform teams.'],
    [bob, designer.jobId, 'I design systems.'],
  ] as const) {
    const res = await built.app.inject(
      post('/portal/applicant/apply', { csrf: session.csrf, job_id: String(jobId), cover_note: note }, { cookie: session.cookie }),
    );
    assert.equal(res.statusCode, 303, res.body);
    assert.equal(res.headers.location, '/portal/applicant');
  }

  const page = await built.app.inject(get('/portal/applicant', { cookie: alice.cookie }));
  assert.equal(page.statusCode, 200);
  assert.match(page.headers['content-type'] as string, /text\/html/);
  assert.equal(page.headers['cache-control'], 'no-store');
  assert.match(page.body, /Alice Rivera/, 'the profile summary is hers');
  assert.match(page.body, /Fractional CTO/, 'her application is listed with the advert it names');
  assert.equal(page.body.includes('Fractional Designer'), false, "bob's advert is not in her page");
  assert.equal(page.body.includes('bob@example.test'), false);
  assert.equal(page.body.includes('Bob Chen'), false);
  assert.match(page.body, /submitted/);
  assert.match(page.body, /name="csrf" value="[0-9a-f]{64}"/, 'both forms carry the session token');

  const own = built.db();
  try {
    const rows = own.prepare('SELECT job_id, applicant_account_id, status FROM cms_application ORDER BY id').all() as {
      job_id: number;
      applicant_account_id: number;
      status: string;
    }[];
    assert.deepEqual(
      rows.map((r) => [r.job_id, r.applicant_account_id, r.status]),
      [
        [cto.jobId, alice.accountId, 'submitted'],
        [designer.jobId, bob.accountId, 'submitted'],
      ],
      'two rows, each scoped to the person who sent it',
    );
  } finally {
    own.close();
  }
});

test('P2 — an advertiser sees only their own adverts’ applicants, and no contact detail reaches the HTML', async () => {
  const built = await build();
  const acme = await enterAs(built, 'hiring@acme.test', 'Acme Hiring', ['advertiser']);
  const globex = await enterAs(built, 'hiring@globex.test', 'Globex Hiring', ['advertiser']);
  const alice = await enterAs(built, 'alice@example.test', 'Alice Rivera', ['applicant']);

  const handle = built.db();
  const acmeJob = addJob(handle, acme.accountId, 'Fractional CTO');
  const acmeJob2 = addJob(handle, acme.accountId, 'Fractional COO');
  const globexJob = addJob(handle, globex.accountId, 'Interim Head of Data');
  handle
    .prepare("UPDATE cms_profile SET headline = ?, summary = ?, visibility = 'discoverable' WHERE account_id = ?")
    .run('Platform leader, 12 years', 'I build small teams that ship.', alice.accountId);
  handle.close();

  for (const jobId of [acmeJob.jobId, globexJob.jobId]) {
    const res = await built.app.inject(
      post('/portal/applicant/apply', { csrf: alice.csrf, job_id: String(jobId), cover_note: 'Keen.' }, { cookie: alice.cookie }),
    );
    assert.equal(res.statusCode, 303, res.body);
  }

  const page = await built.app.inject(get('/portal/advertiser', { cookie: acme.cookie }));
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /Alice Rivera/);
  assert.match(page.body, /Platform leader, 12 years/, 'the projection carries the headline she chose');
  assert.match(page.body, /I build small teams that ship\./);
  assert.match(page.body, /Fractional CTO/, "their advert is named");
  assert.equal(page.body.includes('Interim Head of Data'), false, "another advertiser's advert is not here");
  assert.equal(page.body.includes('alice@example.test'), false, 'no address, because the projection has none');
  assert.equal(EMAIL_SHAPED.test(page.body), false, 'not one email-shaped token in the whole page');
  assert.equal(/mailto:/i.test(page.body), false);
  assert.match(page.body, /visible because they applied to this role/, 'the basis is stated, not implied');

  const other = await built.app.inject(get('/portal/advertiser', { cookie: globex.cookie }));
  assert.equal(other.statusCode, 200);
  assert.match(other.body, /Interim Head of Data/);
  assert.equal(other.body.includes('Fractional CTO'), false);

  // The shares axis is derived from the advert's company, never from the row's advertiser column:
  // a forged row naming globex against an acme advert is not globex's to read, because the company
  // that owns the advert is not theirs. (And it is not acme's either — their column says globex.)
  const forge = built.db();
  try {
    forge
      .prepare(
        `INSERT INTO cms_application
           (job_id, advertiser_account_id, applicant_account_id, cover_note, status, created_at, updated_at)
         VALUES (?, ?, ?, 'forged', 'submitted', ?, ?)`,
      )
      .run(acmeJob2.jobId, globex.accountId, alice.accountId, NOW, NOW);
  } finally {
    forge.close();
  }
  const afterForge = await built.app.inject(get('/portal/advertiser', { cookie: globex.cookie }));
  assert.equal(afterForge.body.includes('Fractional COO'), false, 'the advert’s company is what grants the disclosure');
  assert.equal((afterForge.body.match(/Alice Rivera/g) ?? []).length, 1, 'one applicant, not two');
});

test('P3 — a hidden profile is never enumerated, and cannot apply', async () => {
  const built = await build();
  const acme = await enterAs(built, 'hiring@acme.test', 'Acme Hiring', ['advertiser']);
  const alice = await enterAs(built, 'alice@example.test', 'Alice Rivera', ['applicant']);

  const handle = built.db();
  const job = addJob(handle, acme.accountId, 'Fractional CTO');
  handle.prepare("UPDATE cms_profile SET visibility = 'hidden' WHERE account_id = ?").run(alice.accountId);
  handle.close();

  const apply = await built.app.inject(
    post('/portal/applicant/apply', { csrf: alice.csrf, job_id: String(job.jobId), cover_note: 'Hello.' }, { cookie: alice.cookie }),
  );
  assert.equal(apply.statusCode, 403);
  assert.match(apply.body, /SKW_E_SEC_FORBIDDEN/);
  assert.match(apply.body, /hidden/);

  const page = await built.app.inject(get('/portal/advertiser', { cookie: acme.cookie }));
  assert.equal(page.statusCode, 200);
  assert.equal(page.body.includes('Alice Rivera'), false, 'a hidden profile is not on any advertiser page');
  assert.match(page.body, /No applications yet/);

  const rows = built.db();
  try {
    assert.equal(
      (rows.prepare('SELECT count(*) AS n FROM cms_application').get() as { n: number }).n,
      0,
      'a refused application leaves no row',
    );
    assert.equal(
      (rows.prepare("SELECT count(*) AS n FROM cms_mail WHERE template = 'application_received'").get() as { n: number }).n,
      0,
      'and no mail about an application',
    );
  } finally {
    rows.close();
  }
});

test('P4 — every way an application is refused, by name', async () => {
  const built = await build();
  const acme = await enterAs(built, 'hiring@acme.test', 'Acme Hiring', ['advertiser', 'applicant']);
  const alice = await enterAs(built, 'alice@example.test', 'Alice Rivera', ['applicant']);

  const handle = built.db();
  const open = addJob(handle, acme.accountId, 'Fractional CTO');
  const closed = addJob(handle, acme.accountId, 'Closed role', 'closed');
  const draft = addJob(handle, acme.accountId, 'Draft role', 'draft');
  handle.prepare("UPDATE cms_profile SET visibility = 'discoverable' WHERE account_id = ?").run(alice.accountId);
  handle.close();

  const apply = (session: Session, jobId: number | string) =>
    built.app.inject(
      post('/portal/applicant/apply', { csrf: session.csrf, job_id: String(jobId), cover_note: 'Hello.' }, { cookie: session.cookie }),
    );

  assert.equal((await apply(alice, open.jobId)).statusCode, 303);

  const duplicate = await apply(alice, open.jobId);
  assert.equal(duplicate.statusCode, 409, duplicate.body);
  assert.match(duplicate.body, /already applied/);

  const shut = await apply(alice, closed.jobId);
  assert.equal(shut.statusCode, 400);
  assert.match(shut.body, /closed/, 'the refusal names the state the advert is in');

  const unpublished = await apply(alice, draft.jobId);
  assert.equal(unpublished.statusCode, 400);
  assert.match(unpublished.body, /draft/);

  const missing = await apply(alice, 9999);
  assert.equal(missing.statusCode, 404);
  assert.match(missing.body, /not on this board/);

  const own = await apply(acme, open.jobId);
  assert.equal(own.statusCode, 403);
  assert.match(own.body, /your own/);

  const handle2 = built.db();
  try {
    assert.equal(
      (handle2.prepare('SELECT count(*) AS n FROM cms_application').get() as { n: number }).n,
      1,
      'exactly one application survived the four refusals',
    );
  } finally {
    handle2.close();
  }
});

test('P5 — an application enqueues one mail, to the advertiser, with a name and a headline and nothing else', async () => {
  const built = await build();
  const acme = await enterAs(built, 'hiring@acme.test', 'Acme Hiring', ['advertiser']);
  const alice = await enterAs(built, 'alice@example.test', 'Alice Rivera', ['applicant']);

  const handle = built.db();
  const job = addJob(handle, acme.accountId, 'Fractional CTO');
  handle
    .prepare("UPDATE cms_profile SET headline = ?, visibility = 'discoverable' WHERE account_id = ?")
    .run('Platform leader, 12 years', alice.accountId);
  handle.close();

  const res = await built.app.inject(
    post('/portal/applicant/apply', { csrf: alice.csrf, job_id: String(job.jobId), cover_note: 'Keen.' }, { cookie: alice.cookie }),
  );
  assert.equal(res.statusCode, 303, res.body);

  const rows = built.db();
  try {
    const mail = rows
      .prepare(
        `SELECT to_email, template, subject, vars_json, idempotency_key FROM cms_mail
          WHERE template = 'application_received'`,
      )
      .all() as { to_email: string; template: string; subject: string; vars_json: string; idempotency_key: string }[];
    assert.equal(mail.length, 1, 'one application, one message');
    const [row] = mail;
    assert.equal(row?.to_email, 'hiring@acme.test', "the advertiser's own address");
    assert.equal(row?.template, 'application_received');
    assert.match(row?.subject ?? '', /Fractional CTO/);
    assert.match(row?.idempotency_key ?? '', /^application:\d+$/);

    const vars = JSON.parse(row?.vars_json ?? '{}') as Record<string, unknown>;
    assert.deepEqual(Object.keys(vars).sort(), ['applicant_headline', 'applicant_name', 'job_title']);

    const rendered = renderMail('application_received', vars);
    assert.match(rendered.text, /Alice Rivera/);
    assert.match(rendered.text, /Platform leader, 12 years/);
    assert.match(rendered.text, /Fractional CTO/);
    assert.equal(rendered.text.includes('alice@example.test'), false, 'the applicant’s address is not in the mail');
    assert.equal(EMAIL_SHAPED.test(rendered.text), false, 'and no address is anywhere in the body');
  } finally {
    rows.close();
  }
});

test('P6 — the profile form writes the eight fields it owns, and refuses a third visibility state', async () => {
  const built = await build();
  const alice = await enterAs(built, 'alice@example.test', 'Alice Rivera', ['applicant']);

  const edit = {
    csrf: alice.csrf,
    display_name: 'Alice R. Rivera',
    headline: 'Fractional CTO',
    summary: 'Twenty years of small teams.',
    day_rate_cents: '120000',
    availability_days_per_week: '3',
    remote_ok: '1',
    visibility: 'discoverable',
    notify_new_jobs: '1',
  };
  const saved = await built.app.inject(post('/portal/applicant/profile', edit, { cookie: alice.cookie }));
  assert.equal(saved.statusCode, 303, saved.body);
  assert.equal(saved.headers.location, '/portal/applicant');

  const handle = built.db();
  try {
    const row = handle
      .prepare(
        `SELECT display_name, headline, summary, day_rate_cents, availability_days_per_week, remote_ok,
                visibility, notify_new_jobs
           FROM cms_profile WHERE account_id = ?`,
      )
      .get(alice.accountId) as Record<string, unknown>;
    assert.deepEqual(row, {
      display_name: 'Alice R. Rivera',
      headline: 'Fractional CTO',
      summary: 'Twenty years of small teams.',
      day_rate_cents: 120000,
      availability_days_per_week: 3,
      remote_ok: 1,
      visibility: 'discoverable',
      notify_new_jobs: 1,
    });
  } finally {
    handle.close();
  }

  const page = await built.app.inject(get('/portal/applicant', { cookie: alice.cookie }));
  assert.match(page.body, /Alice R\. Rivera/);
  assert.match(page.body, /1200\.00 AUD a day/);
  assert.match(page.body, /3 days a week/);

  // There is no third state: `policy.ts` has two, the column has two, and the form refuses the word.
  const third = await built.app.inject(
    post('/portal/applicant/profile', { ...edit, visibility: 'matchable' }, { cookie: alice.cookie }),
  );
  assert.equal(third.statusCode, 400, third.body);
  assert.match(third.body, /Choose discoverable or hidden/);

  // A number where a number belongs.
  const notANumber = await built.app.inject(
    post('/portal/applicant/profile', { ...edit, day_rate_cents: 'twelve hundred' }, { cookie: alice.cookie }),
  );
  assert.equal(notANumber.statusCode, 400);
  assert.match(notANumber.body, /whole number/);

  // And the bound the policy owns.
  const tooLong = await built.app.inject(
    post('/portal/applicant/profile', { ...edit, display_name: 'x'.repeat(121) }, { cookie: alice.cookie }),
  );
  assert.equal(tooLong.statusCode, 400);
  assert.match(tooLong.body, /1 to 120 characters/);
});

test('P7 — origin and CSRF are refused on the profile write, before anything is read', async () => {
  const built = await build();
  const alice = await enterAs(built, 'alice@example.test', 'Alice Rivera', ['applicant']);
  const form = { csrf: alice.csrf, display_name: 'Nobody', visibility: 'hidden', notify_new_jobs: '0', remote_ok: '0' };

  const noOrigin = await built.app.inject({
    ...post('/portal/applicant/profile', form, { cookie: alice.cookie }),
    headers: { host: HOST, 'content-type': 'application/x-www-form-urlencoded', cookie: alice.cookie },
  });
  assert.equal(noOrigin.statusCode, 403);
  assert.match(noOrigin.body, /SKW_E_SEC_CSRF/);

  const foreign = await built.app.inject({
    ...post('/portal/applicant/profile', form, { cookie: alice.cookie }),
    headers: {
      host: HOST,
      origin: 'https://evil.test',
      'content-type': 'application/x-www-form-urlencoded',
      cookie: alice.cookie,
    },
  });
  assert.equal(foreign.statusCode, 403);
  assert.match(foreign.body, /origin does not match/);

  const noToken = await built.app.inject(
    post('/portal/applicant/profile', { ...form, csrf: '' }, { cookie: alice.cookie }),
  );
  assert.equal(noToken.statusCode, 403);
  assert.match(noToken.body, /csrf token/);

  const wrongToken = await built.app.inject(
    post('/portal/applicant/profile', { ...form, csrf: 'f'.repeat(64) }, { cookie: alice.cookie }),
  );
  assert.equal(wrongToken.statusCode, 403);

  const handle = built.db();
  try {
    assert.equal(
      (handle.prepare('SELECT display_name FROM cms_profile WHERE account_id = ?').get(alice.accountId) as {
        display_name: string;
      }).display_name,
      'Alice Rivera',
      'no refused write reached the row',
    );
  } finally {
    handle.close();
  }
});

test('P8 — the advertiser’s decision is scoped, named, and cannot reopen a withdrawal', async () => {
  const built = await build();
  const acme = await enterAs(built, 'hiring@acme.test', 'Acme Hiring', ['advertiser']);
  const globex = await enterAs(built, 'hiring@globex.test', 'Globex Hiring', ['advertiser']);
  const alice = await enterAs(built, 'alice@example.test', 'Alice Rivera', ['applicant']);

  const handle = built.db();
  const job = addJob(handle, acme.accountId, 'Fractional CTO');
  handle.prepare("UPDATE cms_profile SET visibility = 'discoverable' WHERE account_id = ?").run(alice.accountId);
  handle.close();

  const applied = await built.app.inject(
    post('/portal/applicant/apply', { csrf: alice.csrf, job_id: String(job.jobId), cover_note: 'Keen.' }, { cookie: alice.cookie }),
  );
  assert.equal(applied.statusCode, 303, applied.body);
  const rows = built.db();
  const applicationId = (rows.prepare('SELECT id FROM cms_application').get() as { id: number }).id;
  rows.close();

  const shortlist = await built.app.inject(
    post('/portal/advertiser/application', { csrf: acme.csrf, application_id: String(applicationId), status: 'shortlisted' }, { cookie: acme.cookie }),
  );
  assert.equal(shortlist.statusCode, 303, shortlist.body);
  assert.equal(shortlist.headers.location, '/portal/advertiser');

  const page = await built.app.inject(get('/portal/advertiser', { cookie: acme.cookie }));
  assert.match(page.body, /shortlisted/);

  // Another advertiser's id is not an application: 404, and the row is untouched.
  const foreign = await built.app.inject(
    post('/portal/advertiser/application', { csrf: globex.csrf, application_id: String(applicationId), status: 'rejected' }, { cookie: globex.cookie }),
  );
  assert.equal(foreign.statusCode, 404);
  assert.match(foreign.body, /no such application/);

  // `submitted` is the applicant's state, not a decision an advertiser may set.
  const submitted = await built.app.inject(
    post('/portal/advertiser/application', { csrf: acme.csrf, application_id: String(applicationId), status: 'submitted' }, { cookie: acme.cookie }),
  );
  assert.equal(submitted.statusCode, 400);
  assert.match(submitted.body, /shortlisted or rejected/);

  // A withdrawn application is ended, not editable.
  const withdrawn = built.db();
  try {
    withdrawn.prepare("UPDATE cms_application SET status = 'withdrawn' WHERE id = ?").run(applicationId);
  } finally {
    withdrawn.close();
  }
  const reopen = await built.app.inject(
    post('/portal/advertiser/application', { csrf: acme.csrf, application_id: String(applicationId), status: 'shortlisted' }, { cookie: acme.cookie }),
  );
  assert.equal(reopen.statusCode, 400, reopen.body);
  assert.match(reopen.body, /withdrew/);

  const after = built.db();
  try {
    assert.equal(
      (after.prepare('SELECT status FROM cms_application WHERE id = ?').get(applicationId) as { status: string }).status,
      'withdrawn',
      'the row still says what the applicant decided',
    );
  } finally {
    after.close();
  }
});

test('P9 — the advertiser’s write refuses a missing token and a foreign origin too', async () => {
  const built = await build();
  const acme = await enterAs(built, 'hiring@acme.test', 'Acme Hiring', ['advertiser']);

  const noOrigin = await built.app.inject({
    ...post('/portal/advertiser/application', { application_id: '1', status: 'shortlisted' }, { cookie: acme.cookie }),
    headers: { host: HOST, 'content-type': 'application/x-www-form-urlencoded', cookie: acme.cookie },
  });
  assert.equal(noOrigin.statusCode, 403);
  assert.match(noOrigin.body, /SKW_E_SEC_CSRF/);

  const noToken = await built.app.inject(
    post('/portal/advertiser/application', { application_id: '1', status: 'shortlisted' }, { cookie: acme.cookie }),
  );
  assert.equal(noToken.statusCode, 403);
  assert.match(noToken.body, /csrf token/);
});

test('P10 — no session redirects, and the wrong role is refused by name on both pages', async () => {
  const built = await build();
  const applicant = await enterAs(built, 'alice@example.test', 'Alice Rivera', ['applicant']);
  const advertiser = await enterAs(built, 'hiring@acme.test', 'Acme Hiring', ['advertiser']);

  for (const path of ['/portal/applicant', '/portal/advertiser']) {
    const anonymous = await built.app.inject(get(path));
    assert.equal(anonymous.statusCode, 303, `${path} without a session`);
    assert.equal(anonymous.headers.location, '/portal/signin');
  }

  const wrongForApplicant = await built.app.inject(get('/portal/advertiser', { cookie: applicant.cookie }));
  assert.equal(wrongForApplicant.statusCode, 403);
  assert.match(wrongForApplicant.body, /advertiser/);

  const wrongForAdvertiser = await built.app.inject(get('/portal/applicant', { cookie: advertiser.cookie }));
  assert.equal(wrongForAdvertiser.statusCode, 403);
  assert.match(wrongForAdvertiser.body, /applicant/);

  // The POSTs refuse the role too — a page you cannot see is not a form you may post.
  const postAsAdvertiser = await built.app.inject(
    post('/portal/applicant/apply', { csrf: advertiser.csrf, job_id: '1', cover_note: 'x' }, { cookie: advertiser.cookie }),
  );
  assert.equal(postAsAdvertiser.statusCode, 403);
  assert.match(postAsAdvertiser.body, /SKW_E_SEC_FORBIDDEN/);
  assert.match(postAsAdvertiser.body, /applicant/);

  const decisionAsApplicant = await built.app.inject(
    post('/portal/advertiser/application', { csrf: applicant.csrf, application_id: '1', status: 'shortlisted' }, { cookie: applicant.cookie }),
  );
  assert.equal(decisionAsApplicant.statusCode, 403);
  assert.match(decisionAsApplicant.body, /advertiser/);
});

test('P11 — a session and an application do not cross a tenant boundary', async () => {
  const built = await build();
  const acme = await enterAs(built, 'hiring@acme.test', 'Acme Hiring', ['advertiser']);
  const alice = await enterAs(built, 'alice@example.test', 'Alice Rivera', ['applicant']);

  const handle = built.db();
  const job = addJob(handle, acme.accountId, 'Fractional CTO');
  handle.prepare("UPDATE cms_profile SET visibility = 'discoverable' WHERE account_id = ?").run(alice.accountId);
  handle.close();

  const applied = await built.app.inject(
    post('/portal/applicant/apply', { csrf: alice.csrf, job_id: String(job.jobId), cover_note: 'Keen.' }, { cookie: alice.cookie }),
  );
  assert.equal(applied.statusCode, 303, applied.body);
  const applicationId = (() => {
    const db = built.db();
    try {
      return (db.prepare('SELECT id FROM cms_application').get() as { id: number }).id;
    } finally {
      db.close();
    }
  })();

  // A second tenant, with the same schema and no rows.
  const other = 'portals-other';
  installJobboard(other);
  built.tenant.key = other;

  const stolen = await built.app.inject(get('/portal/applicant', { cookie: alice.cookie }));
  assert.equal(stolen.statusCode, 303, "the cookie names its tenant, so another tenant does not receive it");
  assert.equal(stolen.headers.location, '/portal/signin');

  const forged = await built.app.inject(
    post('/portal/advertiser/application', { csrf: acme.csrf, application_id: String(applicationId), status: 'rejected' }, { cookie: acme.cookie }),
  );
  assert.equal(forged.statusCode, 303, 'no session on this tenant: the form post is sent to sign in');
  assert.equal(forged.headers.location, '/portal/signin');

  const crossTenant = built.db();
  try {
    assert.equal(
      (crossTenant.prepare('SELECT count(*) AS n FROM cms_application').get() as { n: number }).n,
      0,
      'the other tenant has no application to decide about',
    );
  } finally {
    crossTenant.close();
  }
});

test('P12 — a tenant without the job board has no adverts, and the portal says so instead of failing', async () => {
  const built = await build(false);
  const alice = await enterAs(built, 'alice@example.test', 'Alice Rivera', ['applicant']);

  const res = await built.app.inject(
    post('/portal/applicant/apply', { csrf: alice.csrf, job_id: '1', cover_note: 'Hello.' }, { cookie: alice.cookie }),
  );
  assert.equal(res.statusCode, 404, res.body);
  assert.match(res.body, /not on this board/);

  const page = await built.app.inject(get('/portal/applicant', { cookie: alice.cookie }));
  assert.equal(page.statusCode, 200, 'the page still renders: it is the adverts that are absent');
  assert.match(page.body, /You have not applied for anything yet/);
});
