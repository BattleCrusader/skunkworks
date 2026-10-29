/**
 * One **demo** advert for the Fractional Works board, so the public list and detail pages can be
 * shown with a real published row before a real company posts the first role.
 *
 * It is deliberately obvious in the copy — the company is "Northwind (demo company)" and the title
 * ends "(demo advert)" — because a demo role that reads like a real one is a lie to the next person
 * who opens the board. Close or delete it from `/admin/t/fractional/jobs` once a real advert exists.
 *
 * ## What it writes
 *
 *   - one `p_jobboard_company` row, `account_id = 0`: no account owns a demo company, and 0 is the
 *     honest value — `companyOwner()` treats it as "no owner" rather than inventing one;
 *   - one `p_jobboard_job` row, `status = 'published'`, keyed on the slug `fractional-cto-demo`.
 *
 * A second run finds the slug and changes nothing. It never deletes, never touches another row, and
 * never edits an advert an operator wrote: this is a seed, not a migration.
 *
 *   docker compose stop app
 *   node --no-warnings --experimental-strip-types scripts/seed-fractionalworks-demo-job.ts \
 *     --tenant fractional --data data
 *   docker compose start app
 *
 * The board's tables are the job-board package's, so this script writes them **directly** — it is
 * operator tooling standing in for the admin screen, exactly like `seed-fractionalworks.ts` writing
 * `cms_page`. The app itself never does this: `app/accounts/jobs.ts` reads through the plugin facade.
 */
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 || process.argv[index + 1] === undefined ? fallback : (process.argv[index + 1] as string);
}

const dataDir = arg('data', 'data');
const tenant = arg('tenant', 'fractional');
const siteDb = join(dataDir, 'tenants', tenant, 'site.db');

if (!existsSync(siteDb)) {
  process.stderr.write(`no tenant database at ${siteDb}\n`);
  process.exit(1);
}

const DEMO = {
  company: 'Northwind (demo company)',
  title: 'Fractional CTO (demo advert)',
  slug: 'fractional-cto-demo',
  summary:
    'Two days a week to own the platform, the roadmap and the two engineers who keep it running. Seeded as a demo so the board has one published role to show.',
  body: [
    'This is a demo advert, seeded by the operator so the board has one published role to prove its list and detail pages. It is not a real vacancy: close or delete it from the admin once a company posts the first real one.',
    'The work. Two days a week alongside a product team of six. You own the technical roadmap, the architecture decisions and the two engineers who keep the platform running. The board carries the advert as the company wrote it, and the company answers applications directly.',
    'The first three months. A review of the current stack, a written plan for the next two quarters, and a hiring recommendation for the third engineer. The days are yours to arrange; the team is in Sydney two days a week and the rest is remote.',
    'What it needs. Someone who has run a platform team before, has made the build-versus-buy call in public, and is content to work two days a week rather than five.',
  ].join('\n\n'),
} as const;

const db = new Database(siteDb);
db.pragma('busy_timeout = 5000');

const existing = db
  .prepare('SELECT id, status FROM p_jobboard_job WHERE slug = ? LIMIT 1')
  .get(DEMO.slug) as { id: number; status: string } | undefined;

if (existing !== undefined) {
  // Published already, or closed by an operator: either way this script does not reopen it. A seed
  // that silently undoes an operator's decision is worse than a seed that says it did nothing.
  db.close();
  process.stdout.write(
    `seed-fractionalworks-demo-job: ${tenant} already has "${DEMO.slug}" (id ${String(existing.id)}, ${existing.status}) — nothing written\n`,
  );
  process.exit(0);
}

const now = new Date().toISOString();
db.exec('BEGIN IMMEDIATE');
try {
  const company = db
    .prepare('SELECT id FROM p_jobboard_company WHERE name = ? LIMIT 1')
    .get(DEMO.company) as { id: number } | undefined;
  const companyId =
    company === undefined
      ? Number(
          db
            .prepare(
              `INSERT INTO p_jobboard_company (account_id, name, url, about, created_at)
               VALUES (0, ?, NULL, NULL, ?)`,
            )
            .run(DEMO.company, now).lastInsertRowid,
        )
      : company.id;

  const job = db
    .prepare(
      `INSERT INTO p_jobboard_job
         (company_id, title, slug, summary, body, hourly_rate_cents, currency, days_per_week,
          location, work_mode, status, published_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'AUD', ?, ?, 'hybrid', 'published', ?, ?)`,
    )
    .run(
      companyId,
      DEMO.title,
      DEMO.slug,
      DEMO.summary,
      DEMO.body,
      // $95.50 an hour, which is what a fractional CTO's two days a week works out to.
      9_550,
      2,
      'Sydney',
      now,
      now,
    );

  db.exec('COMMIT');
  db.close();
  process.stdout.write(
    `seed-fractionalworks-demo-job: ${tenant} published "${DEMO.title}" (job ${String(job.lastInsertRowid)}, company ${String(companyId)}) — /jobs/${String(job.lastInsertRowid)}\n`,
  );
} catch (error) {
  db.exec('ROLLBACK');
  db.close();
  throw error;
}
