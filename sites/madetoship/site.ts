/**
 * Made to Ship — the site definition, as data.
 *
 * One description of what the tenant's site *is*: the placeholders, the six page rows with their
 * search metadata, the site bar and footer, the two plugin menus and the settings. `seed.ts` reads
 * this file and nothing else, so the copy in `content.ts` and the site around it cannot drift.
 *
 * ## The placeholders
 *
 * Everything that must be a real business detail before this site answers a customer is a constant
 * in `CONFIG` below and a `__TOKEN__` in the copy. Search for `REPLACE` to find all of them.
 *
 * ## Why the menus are here and not in `cms_nav`
 *
 * `cms_nav` is the site's own bar and footer, authored on the Site screen. The **menu package**
 * (`plugins/menu`) owns page-level menus, which is what the home page's manifest and the About
 * page's index are: content, with rows in `p_menu_item`, drawn by the host from the declared block.
 * Both are declared here so a rebuild of the site leaves the same two menus.
 */
import { ABOUT, CONTACT, ENGAGEMENTS, HOME, PROCESS, SERVICES } from './content.ts';

/* ------------------------------------------------------------------------- the placeholders */

export const CONFIG = {
  /** REPLACE: the address an enquiry is answered from. */
  BUSINESS_EMAIL: 'hello@madetoship.com',
  /** REPLACE: the number a client rings. */
  BUSINESS_PHONE: '+61 400 000 000',
  /** Derived from BUSINESS_PHONE; `tel:` needs the digits and no spaces. */
  BUSINESS_PHONE_HREF: '+61400000000',
  /** REPLACE: the agency's LinkedIn page. */
  LINKEDIN_URL: 'https://www.linkedin.com/company/made-to-ship/',
  /** REPLACE: the registered ABN. */
  ABN: '00 000 000 000',
} as const;

/**
 * The card `engagements` publishes. The business sells in Australian dollars and shows them as
 * `$`: one currency, one set of numbers, no per-visitor swapping.
 *
 * How the numbers were set, so the next person can move them honestly:
 *   - a senior agency day in Australia runs A$1,200-2,200. A billable day here is $2,000: inside
 *     the band, not the cheap end;
 *   - a build sprint is two engineers for two weeks — 20 person-days at $1,600 = $32,000. That is
 *     a volume discount on the day rate, not a discount on the team;
 *   - the discovery sprint is one week at roughly cost, because it is credited against the build.
 *     It exists to qualify a client, not to earn;
 *   - the retainer is four senior days ($8,000) plus an availability premium: $9,500. The
 *     Australian fractional-CTO market for hands-on work is A$8,000-20,000 a month.
 *
 * These are prices, not conversions: if the exchange rate moves 10% the numbers should not move
 * with it. Revisit them against the market bands, not against the dollar.
 */
export const AU_CARD = {
  DISCOVERY: '$9,500',
  SPRINT: '$32,000',
  EXTRA_ENGINEER: '$16,000',
  RETAINER: '$9,500',
  DAY: '$2,000',
  MIN: '$32,000',
} as const;

/** The canonical origin. A rendered page's `rel=canonical` comes from the request's Host. */
export const ORIGIN = 'https://madetoship.com';

/** The business's own details — the same on every page, whichever card it carries. */
function business(text: string): string {
  return text
    .replaceAll('__BUSINESS_EMAIL__', CONFIG.BUSINESS_EMAIL)
    .replaceAll('__BUSINESS_PHONE_HREF__', CONFIG.BUSINESS_PHONE_HREF)
    .replaceAll('__BUSINESS_PHONE__', CONFIG.BUSINESS_PHONE)
    .replaceAll('__LINKEDIN_URL__', CONFIG.LINKEDIN_URL)
    .replaceAll('__ABN__', CONFIG.ABN);
}

/** The AUD card — every page a client in Australia or New Zealand reads. */
export function fill(text: string): string {
  return business(text)
    .replaceAll('__DISCOVERY_FEE__', AU_CARD.DISCOVERY)
    .replaceAll('__SPRINT_FEE__', AU_CARD.SPRINT)
    .replaceAll('__EXTRA_ENGINEER__', AU_CARD.EXTRA_ENGINEER)
    .replaceAll('__RETAINER_FEE__', AU_CARD.RETAINER)
    .replaceAll('__DAY_RATE__', AU_CARD.DAY)
    .replaceAll('__MIN_PROJECT__', AU_CARD.MIN);
}

/* ---------------------------------------------------------------------------- structured data */

const ORGANIZATION = {
  '@type': 'ProfessionalService',
  '@id': `${ORIGIN}/#organisation`,
  name: 'Made to Ship',
  slogan: 'Software, delivered.',
  description:
    'A senior-only software agency: product engineering, platform integration and rescue work, delivered as working software in production.',
  url: `${ORIGIN}/`,
  email: CONFIG.BUSINESS_EMAIL,
  telephone: CONFIG.BUSINESS_PHONE,
  areaServed: 'Worldwide',
  knowsAbout: [
    'Product engineering',
    'Subscription billing',
    'API design',
    'Data integration',
    'Application rescue',
  ],
  sameAs: [CONFIG.LINKEDIN_URL],
};

const WEBSITE = {
  '@type': 'WebSite',
  '@id': `${ORIGIN}/#website`,
  name: 'Made to Ship',
  url: `${ORIGIN}/`,
  inLanguage: 'en',
  publisher: { '@id': `${ORIGIN}/#organisation` },
};

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

/* ------------------------------------------------------------------------------------ pages */

export interface SeededPage {
  path: string;
  slug: string;
  title: string;
  body: string;
  seo: Record<string, unknown>;
}

const META = {
  home: {
    title: 'Made to Ship — software agency. Software, delivered.',
    description:
      'A senior-only software agency. Fixed scope, two-week sprints, working software in production. Product engineering, platform integrations and rescue work.',
  },
  services: {
    title: 'What we build — Made to Ship',
    description:
      'Product engineering, platform and payment integrations, applied AI and rescue work — delivered as software in production, with the repository and the docs in your name.',
  },
  process: {
    title: 'How a project runs — Made to Ship',
    description:
      'Six weeks from kickoff to production: a written scope, two-week sprints with a clickable demo every second Friday, hardening, launch and handover.',
  },
  engagements: {
    title: 'Engagements and pricing — Made to Ship',
    description:
      'A one-week discovery sprint, two-week build sprints and an ongoing retainer. Fixed prices agreed in writing before any work starts.',
  },
  about: {
    title: 'About Made to Ship — small, senior, accountable',
    description:
      'A compact team of senior engineers who would rather finish something than describe it. How we are set up, what we believe about the work, and who we are not.',
  },
  contact: {
    title: 'Contact — Made to Ship',
    description:
      'Tell us what you need to ship. An engineer reads every enquiry and replies within one business day, with a written scope and a fixed price.',
  },
} as const;

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
    path: '/services',
    slug: 'services',
    title: META.services.title,
    body: fill(SERVICES),
    seo: {
      title: META.services.title,
      description: META.services.description,
      jsonLd: {
        '@context': 'https://schema.org',
        '@graph': [webPage('/services', META.services.title, META.services.description)],
      },
    },
  },
  {
    path: '/process',
    slug: 'process',
    title: META.process.title,
    body: fill(PROCESS),
    seo: {
      title: META.process.title,
      description: META.process.description,
      jsonLd: {
        '@context': 'https://schema.org',
        '@graph': [webPage('/process', META.process.title, META.process.description)],
      },
    },
  },
  {
    path: '/engagements',
    slug: 'engagements',
    title: META.engagements.title,
    body: fill(ENGAGEMENTS),
    seo: {
      title: META.engagements.title,
      description: META.engagements.description,
      jsonLd: {
        '@context': 'https://schema.org',
        '@graph': [webPage('/engagements', META.engagements.title, META.engagements.description)],
      },
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

/**
 * Pages a previous deploy published that this one does not. The seed deletes them, revisions and
 * all, so a page that was withdrawn stops answering instead of lingering as an orphan nobody
 * edits. `/us` was a USD card that is no longer part of the site.
 */
export const RETIRED_PATHS: string[] = ['/us'];

/* ------------------------------------------------------------------------------- the site bar */

export interface NavItem {
  label: string;
  href: string;
  /** `page` for a path with a published `cms_page`; `url` for an absolute address. */
  kind: 'page' | 'url';
}

export const HEADER_NAV: NavItem[] = [
  { label: 'Services', href: '/services', kind: 'page' },
  { label: 'Process', href: '/process', kind: 'page' },
  { label: 'Engagements', href: '/engagements', kind: 'page' },
  { label: 'About', href: '/about', kind: 'page' },
  { label: 'Contact', href: '/contact', kind: 'page' },
];

export const FOOTER_NAV: NavItem[] = [
  { label: 'Services', href: '/services', kind: 'page' },
  { label: 'Process', href: '/process', kind: 'page' },
  { label: 'Engagements', href: '/engagements', kind: 'page' },
  { label: 'About', href: '/about', kind: 'page' },
  { label: 'Contact', href: '/contact', kind: 'page' },
];

export const SITE_TITLE = 'Made to Ship';

export const FOOTER_TEXT = `© 2026 Made to Ship — a software agency. Software, delivered. ABN ${CONFIG.ABN}.`;

/* -------------------------------------------------------------------- the menu package's rows */

export interface MenuRow {
  menu: string;
  label: string;
  href: string;
  /** 1-based, so the page's numbered list reads 01… and not 00… */
  position: number;
}

/**
 * The home page's manifest and the About page's index. Rows live in the **menu package's** table
 * (`p_menu_item`), which exists only once the package is installed on this tenant — the seed says
 * so rather than writing to a table that is not there.
 */
export const MENU_MAIN: MenuRow[] = [
  { menu: 'main', label: 'Services', href: '/services', position: 1 },
  { menu: 'main', label: 'Process', href: '/process', position: 2 },
  { menu: 'main', label: 'Engagements', href: '/engagements', position: 3 },
  { menu: 'main', label: 'About', href: '/about', position: 4 },
  { menu: 'main', label: 'Contact', href: '/contact', position: 5 },
];

export const MENU_FOOTER: MenuRow[] = [
  { menu: 'footer', label: 'Services', href: '/services', position: 1 },
  { menu: 'footer', label: 'Engagements', href: '/engagements', position: 2 },
  { menu: 'footer', label: 'Process', href: '/process', position: 3 },
  { menu: 'footer', label: 'Contact', href: '/contact', position: 4 },
];
