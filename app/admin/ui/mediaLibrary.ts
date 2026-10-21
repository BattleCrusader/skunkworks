/**
 * The media library (Direction 03's second screen).
 *
 * Three things this screen refuses to do, because the server would refuse them too:
 *
 *   1. **Publish a gated file.** A gated asset has no farm URL (§7.1), so the tile
 *      shows a lock, the words "No preview" and "Needs a code", and never an `<img src>`
 *      pointing at it.
 *   2. **Offer a delete the API rejects.** The delete control appears only when nothing
 *      refers to the asset — no page link, no bundle item, no download code — which is
 *      exactly the trigger's own condition (`trg_cms_asset_delete_guard`). A gated file
 *      never gets one at all; it gets Share, which is the action a gated file exists for.
 *   3. **Upload.** There is no upload route in this build, so the panel that the design
 *      draws as a drop zone says what is true instead of offering a dead control.
 *
 * Everything else is the existing contract: `?q=` is the search, `?pick=<column>&key=<key>`
 * is the picker, the picker writes a **key** into a field and refuses a gated one, and a
 * plain GET form works with JavaScript off. The only script on the page is a filter that
 * hides tiles as you type — a convenience over a server search that already works.
 */
import { ICON, layout } from './layout.ts';
import { bytes, esc, plural } from './html.ts';

export interface MediaAsset {
  id: number;
  key: string;
  filename: string;
  alt: string | null;
  kind: string;
  mime: string;
  width: number | null;
  height: number | null;
  bytes: number;
  access: string;
  thumb: { width: number; height: number } | null;
  /** A thumbnail URL is only ever set for an asset that has a public URL. */
  thumbUrl: string | null;
  usedOn: readonly { id: number; title: string }[];
  /**
   * True only when the delete trigger would allow it: no page link, no bundle item and
   * no download code. The route computes it from the same three tables the trigger reads.
   */
  deletable: boolean;
  /** Why it cannot be deleted, in words, for the tile. */
  blockedBy: 'pages' | 'bundle' | 'codes' | null;
}

export interface MediaCounts {
  total: number;
  public: number;
  gated: number;
  unused: number;
  totalBytes: number;
}

export interface MediaLibraryInput {
  tenant: { key: string; label: string };
  user: { email: string; role: string } | null;
  assets: readonly MediaAsset[];
  counts: MediaCounts;
  q: string;
  /** The picker: a validated column name, and the key already accepted by the route. */
  pick?: { column: string; key: string } | undefined;
  notices?: number;
  /** The CSRF token a delete form posts in its `csrf` field. */
  csrf: string;
}

function kindWord(asset: MediaAsset): string {
  if (asset.mime === 'application/pdf') return 'PDF';
  if (asset.kind === 'image') return 'Photo';
  if (asset.kind === 'document') return 'File';
  if (asset.kind === 'video') return 'Video';
  if (asset.kind === 'audio') return 'Audio';
  return asset.kind === '' ? 'File' : asset.kind;
}

/** "1600 × 900 · 1.2 KB", or "PDF · 410 KB" when the file has no pixels. */
function dimensions(asset: MediaAsset): string {
  const size = bytes(asset.bytes);
  if (asset.width !== null && asset.height !== null) return `${asset.width} × ${asset.height} · ${size}`;
  return `${kindWord(asset)} · ${size}`;
}

function usage(asset: MediaAsset): string {
  if (asset.usedOn.length === 0) {
    return `<div class="asset__use is-unused">${ICON.check}Not used on any page</div>`;
  }
  const only = asset.usedOn.length === 1 ? asset.usedOn[0] : undefined;
  const where = only === undefined ? '' : ` — ${esc(only.title)}`;
  return `<div class="asset__use">${ICON.page}Used on <b>${plural(asset.usedOn.length, 'page')}</b>${where}</div>`;
}

function gatedNote(asset: MediaAsset): string {
  const where = asset.usedOn.length === 0 ? '' : ` It is used on ${esc(asset.usedOn[0]?.title ?? '')}.`;
  return `<div class="asset__note">People can only open this with a code you give them.${where} Private files are shared with a code, not removed here.</div>`;
}

/**
 * The frame: a real thumbnail, the honest "no rendition" state, or the lock.
 *
 * A gated asset's frame is dashed and hatched and carries three separate words — the
 * badge, the pill and the sentence — so the state survives a monochrome screen, a
 * screenshot, and a reader who cannot tell amber from white.
 */
function frame(asset: MediaAsset): string {
  if (asset.access === 'gated') {
    return `<div class="asset__frame asset__frame--gated"><span class="kind lock">Private file</span><div class="locked"><span class="locked__ring" aria-hidden="true">${ICON.lock}</span><span class="locked__word">No preview</span><span class="locked__sub">Visitors need a code — this file has no public address</span></div></div>`;
  }
  if (asset.thumbUrl !== null) {
    return `<div class="asset__frame"><span class="kind">${esc(kindWord(asset))}</span><img loading="lazy" src="${esc(asset.thumbUrl)}" alt="${esc(asset.alt ?? '')}"${
      asset.thumb === null ? '' : ` width="${asset.thumb.width}" height="${asset.thumb.height}"`
    }></div>`;
  }
  return `<div class="asset__frame"><span class="kind">${esc(kindWord(asset))}</span><div class="nothumb">${ICON.doc}<span>no rendition</span></div></div>`;
}

interface Foot {
  /** The access pill, first in the row. */
  pill: string;
  /** The one action this tile offers, or the sentence explaining why it offers none. */
  action: string;
}

function foot(asset: MediaAsset, base: string, csrf: string, use: string): Foot {
  if (asset.access === 'gated') {
    return {
      pill: '<span class="pill pill--lock"><i aria-hidden="true"></i>Needs a code</span>',
      action: `<a class="btn btn--sm" href="${esc(`${base}/codes`)}">Share<span class="sr-only"> ${esc(asset.key)} with a code</span></a>`,
    };
  }
  const pill = '<span class="pill pill--live"><i aria-hidden="true"></i>Public</span>';
  if (!asset.deletable) {
    const why =
      asset.blockedBy === 'bundle'
        ? 'part of a bundle'
        : asset.blockedBy === 'codes'
          ? 'has access codes'
          : asset.usedOn.length > 0
            ? 'used on a page'
            : 'in use';
    return { pill, action: `${use}<span class="asset__blocked">Cannot delete — ${esc(why)}</span>` };
  }
  // A plain form: the CRUD delete route accepts the session token in the `csrf` body
  // field, so this works with JavaScript off. The confirm() is an enhancement only.
  const del = `<form method="post" action="${esc(`${base}/tables/cms_asset/${asset.id}/delete`)}" data-confirm="Delete ${esc(asset.key)}? This cannot be undone."><input type="hidden" name="csrf" value="${esc(csrf)}"><button class="btn btn--sm btn--danger" type="submit">Delete<span class="sr-only"> ${esc(asset.key)}</span></button></form>`;
  return { pill, action: `${use}${del}` };
}

function tile(asset: MediaAsset, base: string, csrf: string, pick: MediaLibraryInput['pick']): string {
  const gated = asset.access === 'gated';
  const search = [asset.key, asset.filename, asset.alt ?? '', asset.kind].join(' ').toLowerCase();
  // The picker writes a key, never a URL, and never for a gated asset — the route has
  // already refused the gated case, so the link is simply absent here too.
  const use =
    pick === undefined || gated
      ? ''
      : `<a class="btn btn--sm" href="${esc(`${base}/media?pick=${encodeURIComponent(pick.column)}&amp;key=${encodeURIComponent(asset.key)}`)}">Use<span class="sr-only"> ${esc(asset.key)}</span></a>`;
  const parts = foot(asset, base, csrf, use);
  return `      <figure class="asset${gated ? ' asset--gated' : ''}" data-asset-key="${esc(asset.key)}" data-kind="${esc(asset.kind)}" data-access="${esc(asset.access)}" data-search="${esc(search)}">
        ${frame(asset)}
        <figcaption class="asset__body">
          <div class="asset__name">${esc(asset.key)}</div>
          <div class="asset__meta">${esc(dimensions(asset))}</div>
          ${usage(asset)}
          <div class="asset__foot">${parts.pill}${parts.action}</div>
          ${gated ? gatedNote(asset) : ''}
        </figcaption>
      </figure>`;
}

export function mediaLibraryScreen(input: MediaLibraryInput): string {
  const base = `/admin/t/${encodeURIComponent(input.tenant.key)}`;
  const q = input.q;
  const active = q === 'image' ? 'photos' : q === 'document' ? 'files' : 'all';
  const chip = (id: string, label: string, href: string): string =>
    `<a class="chip" href="${esc(href)}"${active === id ? ' aria-current="page"' : ''}>${label}</a>`;

  // The one number that answers "can I clean up?" before a single tile is read: how much of
  // the library nothing refers to. `counts.unused` is the same test the delete control uses
  // (no page link), computed over the whole library rather than the current search.
  const unusedLine =
    input.counts.unused === 0
      ? 'Every file is used on at least one page.'
      : `${plural(input.counts.unused, 'file')} ${input.counts.unused === 1 ? 'is' : 'are'} not used on any page.`;
  const countLine = `${plural(input.counts.total, 'file')}, ${bytes(input.counts.totalBytes)}. ${unusedLine} Each tile says what it is used on.`;
  const pickedField =
    input.pick === undefined
      ? ''
      : `      <p class="picked"><label for="picked_value">${esc(input.pick.column)}</label><input id="picked_value" type="text" name="${esc(input.pick.column)}" value="${esc(input.pick.key)}" readonly></p>\n`;

  const grid =
    input.assets.length === 0
      ? `      <div class="empty card">${q === '' ? 'The library is empty.' : `Nothing matches “${esc(q)}”. <a href="${esc(`${base}/media`)}">Show every file</a>.`}</div>`
      : input.assets.map((asset) => tile(asset, base, input.csrf, input.pick)).join('\n');

  // The enhancement: hide tiles that do not contain the typed text, and say how many are
  // left. It never hides the server-rendered truth on load — only on a keystroke.
  const script = `<script>
(function(){
  var input=document.getElementById('media-filter');
  var grid=document.getElementById('media-grid');
  var status=document.getElementById('media-count');
  if(!input||!grid||!status) return;
  var tiles=Array.prototype.slice.call(grid.querySelectorAll('[data-asset-key]'));
  var total=tiles.length;
  function apply(){
    var needle=input.value.toLowerCase().trim();
    var shown=0;
    tiles.forEach(function(tile){
      var hit=needle===''||(tile.getAttribute('data-search')||'').indexOf(needle)>-1;
      tile.hidden=!hit;
      if(hit) shown++;
    });
    status.textContent=needle===''?total+' file'+(total===1?'':'s'):shown+' of '+total+' shown';
  }
  input.addEventListener('input',apply);
  var forms=document.querySelectorAll('form[data-confirm]');
  Array.prototype.forEach.call(forms,function(form){
    form.addEventListener('submit',function(event){
      if(!window.confirm(form.getAttribute('data-confirm'))) event.preventDefault();
    });
  });
})();
</script>`;

  return layout({
    title: `${input.tenant.key} — photos & files`,
    tenant: input.tenant,
    user: input.user,
    active: 'media',
    ...(input.notices === undefined ? {} : { notices: input.notices }),
    body: `    <div class="pagehead">
      <div>
        <h1>Photos &amp; files</h1>
        <p>${esc(countLine)}</p>
      </div>
      <div class="actions">
        <span class="pill pill--private">${input.counts.public} public · ${input.counts.gated} private</span>
      </div>
    </div>

    <div class="notepanel">
      <span class="notepanel__icon" aria-hidden="true">${ICON.doc}</span>
      <div><b>This is the library, not an uploader</b><p>Adding files is not available on this screen yet. Everything already here is listed below, with what each file is used on.</p></div>
    </div>

    <div class="toolbar">
      <nav class="chips" aria-label="Filter files">
        ${chip('all', `All ${input.counts.total}`, `${base}/media`)}
        ${chip('photos', 'Photos', `${base}/media?q=image`)}
        ${chip('files', 'Files', `${base}/media?q=document`)}
      </nav>
      <form class="search" role="search" method="get" action="${esc(`${base}/media`)}">
        <label class="sr-only" for="media-filter">Search files by name, description or kind</label>
        ${ICON.search}
        <input id="media-filter" type="search" name="q" value="${esc(q)}" placeholder="Search by name or description">
        <button class="btn" type="submit">Search</button>
      </form>
    </div>
    <p class="sr-only" id="media-count" role="status">${plural(input.assets.length, 'file')}</p>

${pickedField}    <div class="mediagrid" id="media-grid">
${grid}
    </div>

    <div class="helper">
      ${ICON.info}
      <span><b>Can I remove a file?</b> Only when nothing uses it: no page, no bundle and no access code. A file that says “Used on 3 pages” has no remove button, because deleting it would leave a gap on those pages. Private files are never removed from here — they are shared with a code instead.</span>
    </div>
${script}
`,
  });
}
