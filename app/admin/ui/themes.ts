/**
 * The Themes screen: the looks a site can wear, one at a time (S8s).
 *
 * ## Why the screen exists at all
 *
 * A theme used to be a textarea. That is a value, not a theme: it cannot be kept beside the one it
 * replaced, it cannot be previewed without retyping it, and "go back" means "paste the old string,
 * which you no longer have". Here a theme is a row: upload it, look at it on the real site, activate
 * it, and the previous one is still in the list if the new one is worse.
 *
 * ## The three things this screen refuses to pretend
 *
 *  - **One is active, not many.** The active theme is a single value (`site.theme_key`), so the
 *    pill on exactly one row reads Active and the others read "Not active". There is no checkbox to
 *    get out of step with the rest.
 *  - **Preview is the site.** The Preview link opens `/?…` on the tenant's own host with a signed
 *    token, rendering the real pages with the candidate sheet — not a mock frame here that could
 *    disagree with the shell about fonts, gutters or the header.
 *  - **Delete is not activation.** The active theme cannot be deleted; the refusal is the feature,
 *    because a delete that silently unstyled the live site is the kind of mistake this screen is
 *    for. Deactivate first, and the site visibly falls back before anything is removed.
 *
 * The pasted `site.theme_css` on the Site screen still works and still wins when no theme is
 * active — that is the one-line override an operator reaches for, and the note says so.
 */
import { esc } from './html.ts';
import { layout } from './layout.ts';

export interface ThemeListRow {
  key: string;
  name: string;
  bytes: number;
  createdAt: string;
  active: boolean;
  /** Files the package carried, and how much they weigh — the difference between a sheet and a look. */
  assetCount: number;
  assetBytes: number;
  /** The signed preview URL for this theme, or `null` when a token could not be minted. */
  previewHref: string | null;
}

export interface ThemesScreenInput {
  tenant: { key: string; label: string };
  user: { email: string; role: string };
  csrf: string;
  notices?: number;
  themes: ThemeListRow[];
  /** The pasted fallback's length, so the screen can say whether it is doing anything. */
  pastedCssBytes: number;
  activeKey: string | null;
  flash?: string | undefined;
}

const FLASH: Record<string, string> = {
  uploaded: 'Theme uploaded. It is not active yet — preview it, then activate.',
  activated: 'Active. Every page of the site is wearing this theme now.',
  deactivated: 'No theme is active. The site is using its pasted stylesheet, if it has one.',
  deleted: 'Theme deleted.',
  empty: 'That file was empty, so nothing was stored.',
  large: 'That file exceeds the theme limit and was not stored.',
  css: 'A theme is a .css file or a .zip package. That upload was neither.',
  markup: 'That stylesheet contains a closing style tag or a script tag; a theme cannot carry markup.',
  name: 'Give the theme a name of 120 characters or fewer.',
  role: 'Your role may look at themes but not change them.',
};

/**
 * Which outcomes are good news.
 *
 * The screen says "uploaded" in green and "the archive is zip64" in amber, and the difference is
 * whether the operator has to do anything — not whether the request was a 303 either way, which is
 * exactly the distinction a status code cannot carry.
 */
const GOOD = new Set(['uploaded', 'activated', 'deactivated', 'deleted']);

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  return `${(n / 1024).toFixed(1)} KiB`;
}

export function themesScreen(input: ThemesScreenInput): string {
  const base = `/admin/t/${encodeURIComponent(input.tenant.key)}/themes`;
  const canChange = input.user.role !== 'viewer';
  const rows =
    input.themes.length === 0
      ? `<p class="note">No themes yet. Upload a stylesheet, or keep using the pasted CSS on the Site screen.</p>`
      : `<table>
      <thead><tr><th>Theme</th><th>Key</th><th>Sheet</th><th>Files</th><th>Uploaded</th><th>State</th><th></th></tr></thead>
      <tbody>
${input.themes
  .map((theme) => {
    const pill = theme.active
      ? `<span class="pill pill--live">Active</span>`
      : `<span class="pill">Not active</span>`;
    const preview =
      theme.previewHref === null
        ? ''
        : `<a class="btn btn--sm" href="${esc(theme.previewHref)}" target="_blank" rel="noopener">Preview</a>`;
    const act = theme.active
      ? canChange
        ? `<form method="post" action="${base}/deactivate"><input type="hidden" name="csrf" value="${esc(input.csrf)}"><button class="btn btn--sm" type="submit">Deactivate</button></form>`
        : ''
      : canChange
        ? `<form method="post" action="${base}/activate"><input type="hidden" name="csrf" value="${esc(input.csrf)}"><input type="hidden" name="theme" value="${esc(theme.key)}"><button class="btn btn--sm btn--primary" type="submit">Activate</button></form>`
        : '';
    const del =
      canChange && !theme.active
        ? `<form method="post" action="${base}/delete"><input type="hidden" name="csrf" value="${esc(input.csrf)}"><input type="hidden" name="theme" value="${esc(theme.key)}"><button class="btn btn--sm btn--danger" type="submit">Delete</button></form>`
        : '';
    // A theme that carries files is a package; one that does not is a stylesheet. The operator
    // should be able to see which they uploaded without opening the preview.
    const files =
      theme.assetCount === 0
        ? '<span class="note">stylesheet only</span>'
        : `${theme.assetCount} file${theme.assetCount === 1 ? '' : 's'} · ${bytes(theme.assetBytes)}`;
    return `      <tr>
        <td><strong>${esc(theme.name)}</strong></td>
        <td><code>${esc(theme.key)}</code></td>
        <td>${bytes(theme.bytes)}</td>
        <td>${files}</td>
        <td>${esc(theme.createdAt.replace('T', ' ').slice(0, 16))}</td>
        <td>${pill}</td>
        <td class="rowey">${preview}${act}${del}</td>
      </tr>`;
  })
  .join('\n')}
      </tbody>
    </table>`;

  const upload = canChange
    ? `<div class="card card--padded">
      <h2>Upload a theme</h2>
      <p class="note">A <code>.css</code> file, or a <code>.zip</code> package holding <code>theme.css</code> plus the pictures and fonts its rules name (a <code>theme.json</code> with a <code>name</code> is optional). The stylesheet is stored by its own hash — the same file uploaded twice is stored once — and a package's files are kept beside this site's database and linked to the theme, so the look arrives with its images.</p>
      <form method="post" action="${base}/upload" enctype="multipart/form-data" class="uploadcard">
        <input type="hidden" name="csrf" value="${esc(input.csrf)}">
        <label for="theme-file">Stylesheet or package</label>
        <input id="theme-file" type="file" name="theme" accept=".css,.zip,text/css,application/zip,application/x-zip-compressed" required>
        <label for="theme-name">Name <span class="note">(optional — defaults to the file name)</span></label>
        <input id="theme-name" name="name" maxlength="120" placeholder="Editorial serif">
        <p><button class="btn btn--primary" type="submit">Upload</button></p>
      </form>
    </div>`
    : `<div class="card card--padded"><h2>Upload a theme</h2><p class="note">Your role may look at themes but not add them.</p></div>`;

  const fallback =
    input.pastedCssBytes > 0
      ? `The pasted stylesheet on the <a href="/admin/t/${esc(input.tenant.key)}/site">Site</a> screen is ${bytes(input.pastedCssBytes)} and is used whenever no theme is active.`
      : `There is no pasted stylesheet on the <a href="/admin/t/${esc(input.tenant.key)}/site">Site</a> screen, so deactivating the last theme leaves the site with no site-wide CSS at all.`;

  return layout({
    title: 'Themes',
    tenant: input.tenant,
    user: input.user,
    active: 'themes',
    ...(input.notices === undefined ? {} : { notices: input.notices }),
    // `flash` used to be passed into `layout()` as a bare string, which the layout silently dropped:
    // the upload worked, the redirect carried `?result=uploaded`, and the screen said nothing at
    // all (S8x). It is now a value the layout renders, with a kind that decides the colour.
    ...(input.flash === undefined
      ? {}
      : { flash: { text: FLASH[input.flash] ?? input.flash, kind: GOOD.has(input.flash) ? 'ok' : 'bad' } }),
    body: `<h1>Themes</h1>
    <p class="note">A theme is one stylesheet the whole site wears: the chrome's rules plus the theme's own, served as one cacheable file. Only one theme is active at a time${input.activeKey === null ? ' — none is right now' : ` — currently <code>${esc(input.activeKey)}</code>`}.</p>
    <p class="note">${fallback}</p>
    ${upload}
    <div class="card card--padded">
      <h2>Uploaded themes</h2>
      ${rows}
    </div>
    <div class="card card--padded">
      <h2>Per-page CSS</h2>
      <p class="note">A page's own rules are not a theme: they belong to that page, live in its editor, and are served as their own file — <code>/_css/&lt;sha256&gt;.css</code> — linked after the theme so a page rule wins at equal specificity. There is nothing to upload here.</p>
    </div>`,
  });
}
