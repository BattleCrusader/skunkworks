/**
 * Fractional Works — the site, seeded from one script.
 *
 * The copy lives in `scripts/content/fractionalworks.ts` (a module of HTML strings, written as
 * copy and reviewed as copy); this file is the operator's half: the settings, the pages, the
 * menus, the enquiry form and the per-page search metadata.
 *
 * ## The five placeholders
 *
 * Everything that must be a real business detail before this site goes live is a constant in
 * `CONFIG` below and a `__TOKEN__` in the copy. Nothing is invented at render time.
 *
 * ## Why a script and not the editor
 *
 * Three pages that have to agree with one another and with one stylesheet, plus a form row and
 * three `seo_json` documents. The editor edits a page; a site is the set. Every write is an upsert
 * keyed on the page path, so running it twice leaves the same site.
 *
 *   node --no-warnings --experimental-strip-types scripts/seed-fractionalworks.ts --tenant fractional
 */
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { CAREERS, CONTACT, FAQ, HOME, META } from './content/fractionalworks.ts';

const SHA = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/* ---------------------------------------------------------------- the five placeholders */

/**
 * Replace these five values before the site goes live. They are the only invented strings in the
 * repository, and they are all here so that a search for `REPLACE` finds every one of them.
 */
const CONFIG = {
  /** REPLACE: the address a prospective client writes to. */
  BUSINESS_EMAIL: 'hello@fractionalworks.com.au',
  /** REPLACE: the number a prospective client rings. */
  BUSINESS_PHONE: '+61 400 000 000',
  /** REPLACE: the firm's LinkedIn page. */
  LINKEDIN_URL: 'https://www.linkedin.com/company/fractional-works/',
  /** REPLACE: the registered ABN. */
  ABN: '00 000 000 000',
  /** REPLACE: the address an engineer writes to. */
  CAREERS_EMAIL: 'careers@fractionalworks.com.au',
} as const;

const ORIGIN = 'https://fractionalworks.com.au';

function fill(text: string): string {
  return text
    .replaceAll('__BUSINESS_EMAIL__', CONFIG.BUSINESS_EMAIL)
    .replaceAll('__BUSINESS_PHONE__', CONFIG.BUSINESS_PHONE)
    .replaceAll('__LINKEDIN_URL__', CONFIG.LINKEDIN_URL)
    .replaceAll('__ABN__', CONFIG.ABN)
    .replaceAll('__CAREERS_EMAIL__', CONFIG.CAREERS_EMAIL);
}

/* ------------------------------------------------------------------ the pages */

const SERVICE = {
  '@type': 'ProfessionalService',
  '@id': `${ORIGIN}/#business`,
  name: 'Fractional Works',
  description:
    'Fractional software engineering: senior engineering capacity, two or three days a week, for companies that need the capability before they can justify the hire.',
  url: `${ORIGIN}/`,
  email: CONFIG.BUSINESS_EMAIL,
  telephone: CONFIG.BUSINESS_PHONE,
  areaServed: { '@type': 'Country', name: 'Australia' },
  serviceType: 'Software Engineering',
  address: {
    '@type': 'PostalAddress',
    addressLocality: 'Newcastle',
    addressRegion: 'NSW',
    addressCountry: 'AU',
  },
  sameAs: [CONFIG.LINKEDIN_URL],
  knowsAbout: [
    'software integration',
    'identity federation',
    'Amazon Web Services',
    'Java',
    'Spring Boot',
    'Python',
    'Kotlin',
    'PostgreSQL',
    'React',
  ],
};

const FAQ_PAGE = {
  '@type': 'FAQPage',
  '@id': `${ORIGIN}/#faq`,
  mainEntity: FAQ.map((entry) => ({
    '@type': 'Question',
    name: entry.q,
    acceptedAnswer: { '@type': 'Answer', text: entry.a },
  })),
};

interface SeededPage {
  path: string;
  slug: string;
  title: string;
  body: string;
  seo: Record<string, unknown>;
}

const PAGES: SeededPage[] = [
  {
    path: '/',
    slug: 'home',
    title: META.home.title,
    body: fill(HOME),
    seo: {
      title: META.home.title,
      description: META.home.description,
      jsonLd: { '@context': 'https://schema.org', '@graph': [SERVICE, FAQ_PAGE] },
    },
  },
  {
    path: '/contact',
    slug: 'contact',
    title: META.contact.title,
    body: fill(CONTACT),
    seo: {
      title: META.contact.title,
      description: META.contact.description,
      jsonLd: {
        '@context': 'https://schema.org',
        '@type': 'ContactPage',
        name: META.contact.title,
        url: `${ORIGIN}/contact`,
        about: { '@id': `${ORIGIN}/#business` },
      },
    },
  },
  {
    path: '/careers',
    slug: 'careers',
    title: META.careers.title,
    body: fill(CAREERS),
    seo: {
      title: META.careers.title,
      description: META.careers.description,
    },
  },
];

/* ------------------------------------------------------------------ the menus */

const HEADER_NAV = [{ label: 'Contact', href: '/contact' }];
const FOOTER_NAV = [
  { label: 'Careers', href: '/careers' },
  { label: 'Contact', href: '/contact' },
];

const SITE_TITLE = 'Fractional Works';
const FOOTER_TEXT =
  '© 2026 Fractional Works — fractional software engineering. Newcastle, New South Wales.';

/* ------------------------------------------------------------------ the enquiry form */

/**
 * The form row the page's `<form data-gjs-type="form" data-form="enquiry">` binds to.
 *
 * `store` keeps the submission in `cms_form_submission`; a deployment that would rather hand it to
 * Formspree or Netlify changes `mode` to `forward` and sets `action_url`, and the same markup
 * posts there instead. The core adds the signed `_pt` token and the `_hp` honeypot either way.
 */
const FORM_FIELDS = [
  { name: 'name', type: 'text', required: true, max: 120 },
  { name: 'email', type: 'email', required: true, max: 254 },
  { name: 'company', type: 'text', required: false, max: 160 },
  { name: 'brief', type: 'textarea', required: true, max: 4000 },
];

/* ------------------------------------------------------------------ writing it */

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

const db = new Database(siteDb);
db.pragma('busy_timeout = 5000');
const now = new Date().toISOString();

function setting(key: string, value: string | boolean, type: 'string' | 'bool'): void {
  db.prepare(
    `INSERT INTO cms_settings (key, value_json, type, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, type = excluded.type, updated_at = excluded.updated_at`,
  ).run(key, JSON.stringify(value), type, now);
}

db.transaction(() => {
  setting('site.title', SITE_TITLE, 'string');
  setting('site.footer_text', FOOTER_TEXT, 'string');
  setting('site.header_sticky', true, 'bool');
  setting('site.footer_sticky', false, 'bool');
  // The look is a theme package the operator uploads and activates; a site that also carried
  // `site.theme_css` would be two stylesheets disagreeing, so this one is empty on purpose.
  setting('site.theme_css', '', 'string');
  // Per-page descriptions live in `cms_page.seo_json`; the site-wide one stays empty so a page
  // cannot end up with two `<meta name="description">` elements.
  setting('site.description', '', 'string');

  const upsertPage = db.prepare(
    `INSERT INTO cms_page (path, slug, title, status, template, body_html, body_css, rev, body_sha, seo_json, managed_by, published_at, updated_at)
     VALUES (?, ?, ?, 'published', 'page', ?, '', 1, ?, ?, 'editor', ?, ?)
     ON CONFLICT(path) DO UPDATE SET
       slug = excluded.slug, title = excluded.title, status = 'published',
       body_html = excluded.body_html, body_css = excluded.body_css, seo_json = excluded.seo_json,
       rev = cms_page.rev + 1, body_sha = excluded.body_sha,
       published_at = excluded.published_at, updated_at = excluded.updated_at,
       draft_html = '', draft_css = '', draft_sha = ''`,
  );
  for (const page of PAGES) {
    upsertPage.run(page.path, page.slug, page.title, page.body, SHA(page.body), JSON.stringify(page.seo), now, now);
  }

  db.prepare('DELETE FROM cms_nav').run();
  const addNav = db.prepare(
    `INSERT INTO cms_nav (location, label, href_kind, href_target, position, visible) VALUES (?, ?, 'page', ?, ?, 1)`,
  );
  HEADER_NAV.forEach((item, index) => addNav.run('header', item.label, item.href, index));
  FOOTER_NAV.forEach((item, index) => addNav.run('footer', item.label, item.href, index));

  db.prepare(
    `INSERT INTO cms_form (key, title, fields_json, mode, notify_email, created_at)
     VALUES ('enquiry', 'Website enquiry', ?, 'store', ?, ?)
     ON CONFLICT(key) DO UPDATE SET fields_json = excluded.fields_json, mode = excluded.mode, notify_email = excluded.notify_email`,
  ).run(JSON.stringify(FORM_FIELDS), CONFIG.BUSINESS_EMAIL, now);
})();

const pages = db.prepare(`SELECT path, title, length(body_html) AS bytes FROM cms_page WHERE status = 'published' ORDER BY path`).all() as {
  path: string;
  title: string;
  bytes: number;
}[];
const nav = (db.prepare(`SELECT COUNT(*) AS n FROM cms_nav`).get() as { n: number }).n;
const form = db.prepare(`SELECT key, mode FROM cms_form WHERE key = 'enquiry'`).get() as { key: string; mode: string } | undefined;
const seo = db.prepare(`SELECT path, json_valid(seo_json) AS ok FROM cms_page WHERE seo_json IS NOT NULL`).all() as {
  path: string;
  ok: number;
}[];
db.close();

process.stdout.write(
  `seeded ${tenant}: ${String(pages.length)} pages, ${String(nav)} menu rows, form ${form?.key ?? 'MISSING'} (${form?.mode ?? '-'})\n` +
    pages.map((page) => `  ${page.path.padEnd(10)} ${String(page.bytes).padStart(6)} B  ${page.title}\n`).join('') +
    `  seo_json valid: ${seo.map((row) => `${row.path}=${row.ok === 1 ? 'yes' : 'NO'}`).join(' ')}\n`,
);
