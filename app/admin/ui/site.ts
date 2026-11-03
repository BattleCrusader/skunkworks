/**
 * The Site screen: identity, stickiness, and the two menus (S8l).
 *
 * Before this screen the tenant's site had no header and no footer, and there was no
 * route anywhere that could give it one: `cms_nav` had a reader (`app/render/nav.ts`) and
 * an index, and no author. The only way to reach a menu row was `sqlite3`.
 *
 * Three decisions worth naming:
 *
 *  - **One form for the identity, one per menu row action.** The identity is five values
 *    with one Save; a menu is rows, so each row carries its own small forms (up, down,
 *    hide, delete) and the add form is separate. A single mega-form would POST the whole
 *    menu on every arrow press, and two operators editing at once would overwrite each
 *    other's rows.
 *  - **Position is not typed.** Up/down swap `position` with the neighbour in the same
 *    `(location, parent)` group inside a transaction. `ux_nav_pos` is UNIQUE on that
 *    tuple, so a swap has to move one row out of the way first — see `#navMove` in
 *    `app/admin/routes.ts`, which is where that ordering lives.
 *  - **The preview is the site.** The screen links to the live `/` and says which pages
 *    the bar will appear on, rather than drawing a mock bar here that could disagree with
 *    the shell.
 */
import { esc } from './html.ts';
import { layout, type NavKey } from './layout.ts';

export interface SiteNavRow {
  id: number;
  location: string;
  label: string;
  hrefKind: string;
  hrefTarget: string;
  position: number;
  visible: number;
}

export interface SiteScreenInput {
  tenant: { key: string; label: string };
  user: { email: string; role: string };
  csrf: string;
  notices?: number;
  chrome: {
    title: string;
    logoKey: string;
    headerSticky: boolean;
    footerSticky: boolean;
    footerText: string;
    themeCss: string;
    /** S8r: the one sentence for `<meta name="description">`. `''` emits no tag. */
    description: string;
  };
  header: SiteNavRow[];
  footer: SiteNavRow[];
  /** A key that names a media-library asset, or `''`. Shown beside the logo field. */
  logoResolved: string | null;
  /** `undefined` is "no message"; the screen renders nothing rather than an empty panel. */
  flash?: string | undefined;
  /** Where "download this site" points. The site is the container: pages, media, plugins and the
   *  theme it wears. A theme is one of its parts, and is downloaded from Themes. */
  exportSiteHref: string;
  active?: NavKey;
}

const FLASH: Record<string, string> = {
  saved: 'Saved. The bar and footer now render on every page of this site.',
  added: 'Menu item added.',
  removed: 'Menu item removed.',
  moved: 'Menu item moved.',
  // The key is `hidden:<the new value>`, so 0 means it was just hidden. The two sentences were
  // the other way round: pressing Hide said "visible again" (E-59).
  'hidden:0': 'Menu item hidden — it no longer renders.',
  'hidden:1': 'Menu item is visible again.',
  title: 'A site name is required: it is the link back to your home page.',
  'logo-missing': 'That asset key is not in the media library, so no logo was saved.',
  'href-kind': 'Pick a link kind of page, url or asset.',
  'href-target': 'A link needs a target.',
  label: 'A menu item needs a label (1–80 characters).',
  'not-found': 'That menu item is no longer there.',
  theme: 'The stylesheet was not saved: CSS may not contain a "<" (that is the only way it could end the style element it is emitted into).',
  description: 'The search description was not saved: keep it under 300 characters.',
};

function flashBlock(flash: string | undefined): string {
  if (flash === undefined) return '';
  const message = FLASH[flash];
  if (message === undefined) return '';
  const bad =
    flash === 'title' ||
    flash === 'logo-missing' ||
    flash === 'href-kind' ||
    flash === 'href-target' ||
    flash === 'label' ||
    flash === 'not-found' ||
    flash === 'theme';
  return `    <div class="notepanel" role="status" data-flash="${esc(flash)}">
      <div class="notepanel__icon" aria-hidden="true">${bad ? '!' : '✓'}</div>
      <div><b>${bad ? 'Not saved' : 'Done'}</b><p>${esc(message)}</p></div>
    </div>\n`;
}

function kindLabel(kind: string): string {
  return kind === 'page' ? 'page' : kind === 'url' ? 'url' : kind === 'asset' ? 'asset' : kind;
}

function rowsTable(rows: SiteNavRow[], location: 'header' | 'footer', base: string, csrf: string): string {
  if (rows.length === 0) {
    return `<p>No ${location} items yet. Add one below — a site with no ${location} menu renders no ${location} at all.</p>`;
  }
  const body = rows
    .map((row, index) => {
      const up =
        index === 0
          ? ''
          : `<form method="post" action="${esc(`${base}/site/nav/move`)}"><input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="id" value="${row.id}"><input type="hidden" name="direction" value="up"><button class="btn btn--sm" type="submit" title="move up">↑<span class="sr-only"> ${esc(row.label)} up</span></button></form>`;
      const down =
        index === rows.length - 1
          ? ''
          : `<form method="post" action="${esc(`${base}/site/nav/move`)}"><input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="id" value="${row.id}"><input type="hidden" name="direction" value="down"><button class="btn btn--sm" type="submit" title="move down">↓<span class="sr-only"> ${esc(row.label)} down</span></button></form>`;
      const hide = `<form method="post" action="${esc(`${base}/site/nav/visible`)}"><input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="id" value="${row.id}"><input type="hidden" name="visible" value="${row.visible === 1 ? '0' : '1'}"><button class="btn btn--sm" type="submit">${row.visible === 1 ? 'Hide' : 'Show'}</button></form>`;
      const del = `<form method="post" action="${esc(`${base}/site/nav/delete`)}"><input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="id" value="${row.id}"><button class="btn btn--sm btn--danger" type="submit">Delete<span class="sr-only"> ${esc(row.label)}</span></button></form>`;
      return `<tr data-nav-id="${row.id}"><td>${esc(row.label)}</td><td><code>${esc(row.hrefTarget)}</code></td><td>${esc(kindLabel(row.hrefKind))}</td><td>${row.visible === 1 ? 'shown' : 'hidden'}</td><td>${up}${down}${hide}${del}</td></tr>`;
    })
    .join('\n');
  return `<table>
  <thead><tr><th>Label</th><th>Points at</th><th>Kind</th><th>State</th><th>Actions</th></tr></thead>
  <tbody>
${body}
  </tbody>
</table>`;
}

function addForm(location: 'header' | 'footer', base: string, csrf: string): string {
  return `      <form method="post" action="${esc(`${base}/site/nav/add`)}">
        <input type="hidden" name="csrf" value="${esc(csrf)}">
        <input type="hidden" name="location" value="${location}">
        <label>Label <input name="label" required maxlength="80" placeholder="${location === 'header' ? 'About' : 'Contact'}"></label>
        <label>Kind <select name="href_kind"><option value="page">page (a path on this site)</option><option value="url">url (another site)</option><option value="asset">asset (a media-library key)</option></select></label>
        <label>Target <input name="href_target" required placeholder="${location === 'header' ? '/about' : 'https://example.com'}"></label>
        <button class="btn" type="submit">Add ${location} item</button>
      </form>`;
}

export function siteScreen(input: SiteScreenInput): string {
  const base = `/admin/t/${encodeURIComponent(input.tenant.key)}`;
  const csrf = esc(input.csrf);
  const chrome = input.chrome;
  const mediaHref = `${base}/media`;
  return layout({
    title: `Site — ${input.tenant.key} — Skunkworks`,
    tenant: input.tenant,
    user: input.user,
    active: input.active ?? 'site',
    ...(input.notices === undefined ? {} : { notices: input.notices }),
    body: `${flashBlock(input.flash)}    <div class="pagehead">
      <div>
        <h1>Site</h1>
        <p>The bar and footer every page of <b>${esc(input.tenant.label)}</b> wears — including pages a
        plugin draws, such as a blog post. Nothing here is per-page.</p>
      </div>
      <div class="actions">
        <a class="btn" href="/" target="_blank" rel="noopener">View the site <span class="sr-only">(opens in a new tab)</span></a>
      </div>
    </div>

    <div class="card legacy card--padded" data-screen="site-identity">
      <h2>Identity</h2>
      <p>The name is the link back to your home page. Leave it empty and the bar carries only your menu.</p>
      <form method="post" action="${esc(`${base}/site/save`)}">
        <input type="hidden" name="csrf" value="${csrf}">
        <label>Site name <input name="title" value="${esc(chrome.title)}" maxlength="120" placeholder="Acme Widgets"></label>
        <label>Logo asset key <input name="logo_key" value="${esc(chrome.logoKey)}" maxlength="96" placeholder="brand/logo"></label>
        <label>Footer sentence <input name="footer_text" value="${esc(chrome.footerText)}" maxlength="200" placeholder="© 2026 Acme Widgets"></label>
        <label for="description">Search description <small>One sentence for <code>&lt;meta name="description"&gt;</code> — what a search result says under the title. About 155 characters is what survives the cut.</small></label>
        <input id="description" name="description" value="${esc(chrome.description)}" maxlength="300" placeholder="A six-person studio building small, well-made software.">
        <label>Header pins to the top <input type="checkbox" name="header_sticky" value="1"${chrome.headerSticky ? ' checked' : ''}></label>
        <label>Footer pins to the bottom <input type="checkbox" name="footer_sticky" value="1"${chrome.footerSticky ? ' checked' : ''}></label>
        <label for="theme_css">Site stylesheet <small>CSS for every page: the bar, the footer, and whatever a page&#39;s own markup names.</small></label>
        <textarea id="theme_css" name="theme_css" rows="10" spellcheck="false" placeholder=":root{--ink:#14181d}&#10;body{font-family:ui-serif,Georgia,serif}">${esc(chrome.themeCss)}</textarea>
        <div class="formactions"><button class="btn btn--primary" type="submit">Save</button>
        <a class="btn" href="${esc(mediaHref)}">Media library<span class="sr-only"> — to copy a logo key</span></a></div>
      </form>
      <p class="hint">${chrome.logoKey === '' ? 'No logo set — the bar shows the name as text.' : input.logoResolved === null ? `The key <code>${esc(chrome.logoKey)}</code> names no media asset, so no logo renders.` : `Logo resolves to <code>${esc(input.logoResolved)}</code>.`}</p>
    </div>

    <div class="card legacy card--padded" data-screen="site-header">
      <h2>Header menu</h2>
      <p>Rendered inside the bar, after the site name.</p>
      ${rowsTable(input.header, 'header', base, input.csrf)}
${addForm('header', base, input.csrf)}
    </div>

    <div class="card legacy card--padded" data-screen="site-footer">
      <h2>Footer menu</h2>
      <p>Rendered in the footer, above the footer sentence.</p>
      ${rowsTable(input.footer, 'footer', base, input.csrf)}
${addForm('footer', base, input.csrf)}
    </div>

    <div class="card card--padded" data-screen="site-export">
      <h2>Take this site somewhere else</h2>
      <p class="note">One <code>.zip</code> holding the whole site: its pages, menus, settings, media,
      plugin packages, schema, an <code>install.sh</code> — and the theme it happens to be wearing.
      The theme travels because <em>this site</em> wears it, not because a theme is a site. Identity
      rows are excluded by design: a bundle is a copy of the site, never of its people.</p>
      <p><a class="btn" href="${esc(input.exportSiteHref)}">Download this site (.zip)</a></p>
      <p class="hint">Want the theme on its own, to wear on a different site? That download lives on
      <a href="${base}/themes">Themes</a> — a theme is one part of a site, and it can be carried without it.</p>
    </div>
`,
  });
}
