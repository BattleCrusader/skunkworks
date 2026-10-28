/**
 * Fractional Works — the site definition, as data.
 *
 * One description of what the tenant's site *is*: the five placeholders, the six page rows with
 * their search metadata, the two menus, the settings and the enquiry form. Both scripts read this
 * file — `seed-fractionalworks.ts` (build the site) and `update-fractionalworks.ts` (apply the copy
 * to a live tenant without clobbering rows the seed does not own) — so the two cannot drift apart.
 *
 * ## The five placeholders
 *
 * Everything that must be a real business detail before this site goes live is a constant in
 * `CONFIG` below and a `__TOKEN__` in the copy. Nothing is invented at render time.
 *
 * ## Why pages are upserted by path
 *
 * Three pages have to agree with one another and with one stylesheet, plus a form row and per-page
 * `seo_json` documents. The editor edits a page; a site is the set. Every write is keyed on the page
 * path, so building the site twice leaves the same site.
 */
import {
  ABOUT,
  CONTACT,
  FAQ,
  FOR_ADVERTISERS,
  FOR_APPLICANTS,
  HOME,
  HOW_IT_WORKS,
  META,
} from './fractionalworks.ts';

/* ---------------------------------------------------------------- the five placeholders */

/**
 * Replace these five values before the site goes live. They are the only invented strings in the
 * repository, and they are all here so that a search for `REPLACE` finds every one of them.
 */
export const CONFIG = {
  /** REPLACE: the address a company or an applicant writes to. */
  BUSINESS_EMAIL: 'hello@fractionalworks.com.au',
  /** REPLACE: the number a company or an applicant rings. */
  BUSINESS_PHONE: '+61 400 000 000',
  /** REPLACE: the operator's LinkedIn page. */
  LINKEDIN_URL: 'https://www.linkedin.com/company/fractional-works/',
  /** REPLACE: the registered ABN. */
  ABN: '00 000 000 000',
  /** REPLACE: the address an applicant writes to about their own account. */
  SUPPORT_EMAIL: 'support@fractionalworks.com.au',
} as const;

export const ORIGIN = 'https://fractionalworks.com.au';

export function fill(text: string): string {
  return text
    .replaceAll('__BUSINESS_EMAIL__', CONFIG.BUSINESS_EMAIL)
    .replaceAll('__BUSINESS_PHONE__', CONFIG.BUSINESS_PHONE)
    .replaceAll('__LINKEDIN_URL__', CONFIG.LINKEDIN_URL)
    .replaceAll('__ABN__', CONFIG.ABN)
    .replaceAll('__SUPPORT_EMAIL__', CONFIG.SUPPORT_EMAIL);
}

/* ------------------------------------------------------------------ structured data */

const ORGANIZATION = {
  '@type': 'Organization',
  '@id': `${ORIGIN}/#organisation`,
  name: 'Fractional Works',
  description:
    'A job board for fractional work: companies post senior roles measured in days per week, and senior people apply directly.',
  url: `${ORIGIN}/`,
  email: CONFIG.BUSINESS_EMAIL,
  telephone: CONFIG.BUSINESS_PHONE,
  areaServed: { '@type': 'Country', name: 'Australia' },
  address: {
    '@type': 'PostalAddress',
    addressLocality: 'Newcastle',
    addressRegion: 'NSW',
    addressCountry: 'AU',
  },
  sameAs: [CONFIG.LINKEDIN_URL],
};

const WEBSITE = {
  '@type': 'WebSite',
  '@id': `${ORIGIN}/#website`,
  name: 'Fractional Works',
  url: `${ORIGIN}/`,
  inLanguage: 'en-AU',
  publisher: { '@id': `${ORIGIN}/#organisation` },
};

const FAQ_PAGE = {
  '@type': 'FAQPage',
  '@id': `${ORIGIN}/how-it-works#faq`,
  mainEntity: FAQ.map((entry) => ({
    '@type': 'Question',
    name: entry.q,
    acceptedAnswer: { '@type': 'Answer', text: entry.a },
  })),
};

/** A plain WebPage node for a page that is not the home page and carries no FAQ. */
function webPage(path: string, title: string, description: string): Record<string, unknown> {
  return {
    '@type': 'WebPage',
    '@id': `${ORIGIN}${path}#page`,
    url: `${ORIGIN}${path}`,
    name: title,
    description,
    isPartOf: { '@id': `${ORIGIN}/#website` },
    about: { '@id': `${ORIGIN}/#organisation` },
  };
}

/* ----------------------------------------------------------------------------- pages */

export interface SeededPage {
  path: string;
  slug: string;
  title: string;
  body: string;
  seo: Record<string, unknown>;
}

export const PAGES: SeededPage[] = [
  {
    path: '/',
    slug: 'home',
    title: META.home.title,
    body: fill(HOME),
    seo: {
      title: META.home.title,
      description: META.home.description,
      jsonLd: { '@context': 'https://schema.org', '@graph': [ORGANIZATION, WEBSITE] },
    },
  },
  {
    path: '/for-advertisers',
    slug: 'for-advertisers',
    title: META.advertisers.title,
    body: fill(FOR_ADVERTISERS),
    seo: {
      title: META.advertisers.title,
      description: META.advertisers.description,
      jsonLd: {
        '@context': 'https://schema.org',
        '@graph': [webPage('/for-advertisers', META.advertisers.title, META.advertisers.description)],
      },
    },
  },
  {
    path: '/for-applicants',
    slug: 'for-applicants',
    title: META.applicants.title,
    body: fill(FOR_APPLICANTS),
    seo: {
      title: META.applicants.title,
      description: META.applicants.description,
      jsonLd: {
        '@context': 'https://schema.org',
        '@graph': [webPage('/for-applicants', META.applicants.title, META.applicants.description)],
      },
    },
  },
  {
    path: '/how-it-works',
    slug: 'how-it-works',
    title: META.how.title,
    body: fill(HOW_IT_WORKS),
    seo: {
      title: META.how.title,
      description: META.how.description,
      jsonLd: { '@context': 'https://schema.org', '@graph': [FAQ_PAGE] },
    },
  },
  {
    path: '/about',
    slug: 'about',
    title: META.about.title,
    body: fill(ABOUT),
    seo: {
      title: META.about.title,
      description: META.about.description,
      jsonLd: {
        '@context': 'https://schema.org',
        '@graph': [webPage('/about', META.about.title, META.about.description)],
      },
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
        about: { '@id': `${ORIGIN}/#organisation` },
      },
    },
  },
];

/** Pages the brochure had that the board does not. The update script retires them by name. */
export const RETIRED_PATHS = ['/careers'];

/* ----------------------------------------------------------------------------- menus */

export interface NavItem {
  label: string;
  href: string;
  /** `page` for a path with a published `cms_page`; `url` for an absolute address. */
  kind: 'page' | 'url';
}

export const HEADER_NAV: NavItem[] = [
  { label: 'Find work', href: '/for-applicants', kind: 'page' },
  { label: 'Post a role', href: '/for-advertisers', kind: 'page' },
  { label: 'How it works', href: '/how-it-works', kind: 'page' },
  { label: 'About', href: '/about', kind: 'page' },
  { label: 'Contact', href: '/contact', kind: 'page' },
];

export const FOOTER_NAV: NavItem[] = [
  { label: 'For advertisers', href: '/for-advertisers', kind: 'page' },
  { label: 'For applicants', href: '/for-applicants', kind: 'page' },
  { label: 'How it works', href: '/how-it-works', kind: 'page' },
  { label: 'About', href: '/about', kind: 'page' },
  { label: 'Contact', href: '/contact', kind: 'page' },
  { label: 'Sign in', href: `${ORIGIN}/portal/signin`, kind: 'url' },
  { label: 'Create an account', href: `${ORIGIN}/portal/register`, kind: 'url' },
];

export const SITE_TITLE = 'Fractional Works';
export const FOOTER_TEXT =
  '© 2026 Fractional Works — a job board for fractional work. Newcastle, New South Wales.';

/* ------------------------------------------------------------------- the enquiry form */

/**
 * The form row the page's `<div data-skw-form="contact/contact">` marker binds to.
 *
 * `store` keeps the submission in `cms_form_submission`; a deployment that would rather hand it to
 * Formspree or Netlify changes `mode` to `forward` and sets `action_url`, and the same markup
 * posts there instead. The core adds the signed `_pt` token and the `_hp` honeypot either way.
 */
export const FORM_FIELDS = [
  { name: 'name', type: 'text', required: true, max: 120 },
  { name: 'email', type: 'email', required: true, max: 254 },
  { name: 'company', type: 'text', required: false, max: 160 },
  { name: 'message', type: 'textarea', required: true, max: 4000 },
];

export const FORM_KEY = 'enquiry';
export const FORM_TITLE = 'Website enquiry';
