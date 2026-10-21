/**
 * The page list (Direction 03's landing screen).
 *
 * This is the screen at `/admin` — the tenant home. `GET /admin/t/<key>/pages` stays a
 * JSON read (`{tenant, pages}`), because that is the contract the S3 tests pin and a
 * screen is not a reason to change it; what an operator lands on is `/admin`.
 *
 * The screen answers three questions in the order a non-technical owner asks them:
 * what is live, what still needs me, and where do I go next. The next-step banner is
 * driven by a real draft row, not by a fixture: with no draft it says so, calmly.
 */
import { ICON, layout, type NavItem } from './layout.ts';
import { esc, initialOf, plural, tintOf, whenLabel } from './html.ts';

export interface PageRow {
  id: number;
  path: string;
  title: string;
  /** `draft` | `published` | `hidden` — the schema's three, and no others. */
  status: string;
  /** There are unpublished changes: the editor has a draft the live body does not have. */
  draft: boolean;
  versions: number;
  updatedAt: string;
}

export interface PageListInput {
  tenant: { key: string; label: string };
  user: { email: string; role: string } | null;
  pages: readonly PageRow[];
  /** Injected so "Saved 41 minutes ago" is a function of its inputs. */
  nowMs: number;
  notices?: number;
  /** Core's remaining screens plus anything `admin.menu` added. */
  more?: readonly NavItem[];
  /**
   * The site database could not be read. The screen says so and changes nothing —
   * the old home page needed no database, and a broken tenant should not turn the
   * admin's front door into a 500.
   */
  unavailable?: boolean;
}

function statusPill(status: string): string {
  if (status === 'published') return '<span class="pill pill--live"><i aria-hidden="true"></i>Live</span>';
  if (status === 'draft') return '<span class="pill pill--draft"><i aria-hidden="true"></i>Draft</span>';
  if (status === 'hidden') return '<span class="pill pill--private"><i aria-hidden="true"></i>Hidden</span>';
  // An unknown state is named, never guessed: the schema forbids it, and if it ever
  // appears the operator should see the word the database actually holds.
  return `<span class="pill pill--private"><i aria-hidden="true"></i>${esc(status)}</span>`;
}

function row(page: PageRow, base: string, nowMs: number): string {
  const title = page.title === '' ? page.path : page.title;
  const where = page.path === '/' ? 'Home page' : page.path;
  const action = page.status === 'draft' ? 'Finish' : 'Edit';
  // "not published yet" is a claim about PUBLICATION, and a revision count cannot make it:
  // the four seeded pages are `status = 'published'` with zero revisions, so this line used
  // to print "not published yet" beside a Live pill on every row — the screen contradicting
  // itself on the one fact it exists to report. Found by reading the deployed page, not by
  // a test, which is why there is now one (S7-9).
  const versions =
    page.versions > 0
      ? plural(page.versions, 'version')
      : page.status === 'published'
        ? 'no earlier versions kept'
        : 'not published yet';
  // S8b: a published page with a pending draft is two facts, and the row says both. The status
  // pill answers "can visitors see it?"; this line answers "is what they see what I just made?".
  const pending = page.draft
    ? `<i class="dotsep" aria-hidden="true"></i><span class="pagerow__pending">unpublished changes</span>`
    : '';
  return `      <div class="pagerow" data-page-id="${page.id}" data-status="${esc(page.status)}" data-draft="${page.draft ? '1' : '0'}">
        <span class="thumb-ic ${tintOf(page.path)}" aria-hidden="true">${esc(initialOf(title, page.path))}</span>
        <div class="pagerow__main">
          <div class="pagerow__title">${esc(title)}</div>
          <div class="pagerow__meta"><span>${esc(where)}</span><i class="dotsep" aria-hidden="true"></i><span>Updated ${esc(whenLabel(page.updatedAt, nowMs))}</span><i class="dotsep" aria-hidden="true"></i><span>${esc(versions)}</span>${pending}</div>
        </div>
        ${statusPill(page.status)}
        <div class="rowactions"><a class="btn btn--sm" href="${esc(`${base}/editor?page=${page.id}`)}">${action}<span class="sr-only"> — ${esc(title)}</span></a>${ICON.chevron}</div>
      </div>`;
}

export function pageListScreen(input: PageListInput): string {
  const base = `/admin/t/${encodeURIComponent(input.tenant.key)}`;
  if (input.unavailable === true) {
    return layout({
      title: `${input.tenant.key} — your pages`,
      tenant: input.tenant,
      user: input.user,
      active: 'pages',
      ...(input.notices === undefined ? {} : { notices: input.notices }),
      body: `    <div class="pagehead">
      <div>
        <h1>Your pages</h1>
        <p>We could not read this site's pages just now. Nothing has been changed.</p>
      </div>
    </div>
    <div class="card empty">Try again in a moment. If this keeps happening, ask your developer to look at the site's database.</div>`,
    });
  }
  const pages = input.pages;
  const live = pages.filter((p) => p.status === 'published').length;
  const drafts = pages.filter((p) => p.status === 'draft').length;
  const hidden = pages.filter((p) => p.status === 'hidden').length;
  const versions = pages.reduce((sum, p) => sum + p.versions, 0);
  const newestDraft = [...pages].filter((p) => p.status === 'draft').sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];

  const summary = (() => {
    if (pages.length === 0) return 'No pages yet. The first one you make will appear here.';
    const parts = [`${plural(pages.length, 'page')} on your site.`];
    parts.push(live === 0 ? 'Nothing is live for visitors yet.' : `${live} ${live === 1 ? 'is' : 'are'} live for everyone.`);
    if (drafts > 0) parts.push(`${plural(drafts, 'draft')} only you can see.`);
    if (hidden > 0) parts.push(`${plural(hidden, 'page')} hidden from the menu.`);
    return parts.join(' ');
  })();

  const banner =
    newestDraft === undefined
      ? `    <div class="nextstep nextstep--calm">
      <span class="nextstep__icon" aria-hidden="true">${ICON.check}</span>
      <div><b>Everything is live</b><p>There is nothing waiting for you. When you change a page it saves as a draft first, so you can look before you publish.</p></div>
      <a class="btn btn--sm" href="${esc(`${base}/media`)}">See photos &amp; files</a>
    </div>`
      : `    <div class="nextstep">
      <span class="nextstep__icon" aria-hidden="true">${ICON.warn}</span>
      <div><b>${esc(newestDraft.title === '' ? newestDraft.path : newestDraft.title)} is almost ready</b><p>It was saved ${esc(whenLabel(newestDraft.updatedAt, input.nowMs))} and is still a draft, so visitors cannot see it yet. Give it a final look, then publish it when you are happy.</p></div>
      <a class="btn btn--primary btn--sm" href="${esc(`${base}/editor?page=${newestDraft.id}`)}">Finish ${esc(newestDraft.title === '' ? 'this page' : newestDraft.title)}</a>
    </div>`;

  const list =
    pages.length === 0
      ? `      <div class="empty">Nothing here yet. <a href="${esc(`${base}/editor`)}">Make your first page</a>.</div>`
      : pages.map((p) => row(p, base, input.nowMs)).join('\n');

  const more = input.more ?? [];
  const moreList =
    more.length === 0
      ? ''
      : `
    <div class="sectionhead"><h2>More in this admin</h2><span>Every screen, including the ones your developer uses</span></div>
    <div class="card morelist">
${more.map((item) => `      <a class="morelink" href="${esc(item.href)}">${esc(item.label)}<span class="chev" aria-hidden="true">›</span></a>`).join('\n')}
    </div>`;

  return layout({
    title: `${input.tenant.key} — your pages`,
    tenant: input.tenant,
    user: input.user,
    active: 'pages',
    ...(input.notices === undefined ? {} : { notices: input.notices }),
    body: `    <div class="pagehead">
      <div>
        <h1>Your pages</h1>
        <p>${esc(summary)}</p>
      </div>
      <div class="actions">
        <a class="btn" href="/" target="_blank" rel="noopener">Preview site${ICON.external}<span class="sr-only"> (opens in a new tab)</span></a>
        <a class="btn btn--primary" href="${esc(`${base}/editor`)}">${ICON.plus}New page</a>
      </div>
    </div>

${banner}

    <div class="sectionhead"><h2>All pages</h2><span>Sorted by address</span></div>
    <div class="card pagelist">
${list}
    </div>

    <dl class="stats">
      <div class="stat"><dt>pages live for visitors</dt><dd>${live}</dd></div>
      <div class="stat"><dt>${drafts === 1 ? 'draft only you can see' : 'drafts only you can see'}</dt><dd>${drafts}</dd></div>
      <div class="stat"><dt>versions kept safely</dt><dd>${versions}</dd></div>
    </dl>

    <div class="helper">
      ${ICON.info}
      <span><b>What does publishing do?</b> It puts the page live and keeps the version before it, so nothing is ever lost. Publish again whenever you like.</span>
    </div>${moreList}
`,
  });
}
