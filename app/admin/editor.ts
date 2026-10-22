/**
 * The editor page (§10.1, item 2 of S4a): GrapesJS in the admin, **palette generated from
 * the registry**, and a load path that refuses an unregistered type before the canvas
 * sees it.
 *
 * The page is deliberately three pieces of data and two scripts:
 *
 *   <script type="application/json" id="skw-editor-boot">  the palette, the types, the page
 *   /admin/t/<key>/editor/grapesjs.js                      the editor itself
 *   /admin/t/<key>/editor/editor.js                        the boot script (a constant below)
 *
 * The palette is *not* written into the markup: the boot script reads the JSON and calls
 * `editor.Blocks.add()` per entry, so adding a registry row grows the palette with no edit
 * here (§10.2). `types` carries the same entries so the boot script can `addType()` every
 * one — a registered type whose `model.defaults` omits the attribute loses `data-gjs-type`
 * on save, which is why the server sends the lock explicitly rather than trusting the
 * client to remember it.
 *
 * The media picker writes a **key** (D17): `pickUrl` is the endpoint the boot script posts
 * to, and the answer is the whole document with `data-asset-key` set — there is no code
 * path here that returns a URL for the canvas to store.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { PaletteItem, Registry } from '../editor/registry.ts';
import { palette, paletteCategories, typeDefinitions } from '../editor/registry.ts';

import { DATA_GJS_TYPE_PATTERN } from '../editor/paste.ts';

/**
 * S8h: the `list` component the registry ships, with this block's source and limit written into it.
 *
 * A plugin block is not a new component — it is the front-end's own repeating list, pointed at a
 * package's data. That is what makes it look native and what keeps a package from shipping markup:
 * the canvas and the renderer both see a component the host already owns.
 */
export interface BlockForPalette {
  /** `<plugin>/<name>`, the marker's `data-source`. */
  id: string;
  label: string;
  limit: number;
  /** The column whose value is the link's text. */
  labelColumn?: string;
  /** A href template: `/blog/{slug}` (a path) or `{href}` (the cell *is* the URL). */
  href?: string;
  layout?: 'list' | 'cards';
}

/**
 * The markup a plugin block inserts, built from **the block's own declaration**.
 *
 * S8h reused the registry's shipped `list` component verbatim and only swapped `data-source`,
 * which quietly assumed every plugin table has columns called `title` and `slug` — the blog's
 * shape. A menu's table does not, so its block rendered "Post title" and a link to
 * `/blog/post` on a page that had neither. The shipped component is still the *component*
 * (the renderer is the same `data-bind-*` contract); what changes is that the bindings now
 * name the block's columns instead of the blog's.
 *
 * `data-bind-href-*` sits on the same element as the text binding on purpose: `bindRow` sets
 * the element's text from one column and its `href` from another, and a row whose href is
 * refused (`javascript:`) keeps its label and loses only the link.
 */
function listComponentFor(registry: Registry, block: BlockForPalette): string {
  const entry = registry.entries.find((item) => item.type === 'list' && item.html !== null);
  const labelColumn = block.labelColumn ?? (block.href === undefined ? undefined : 'title');
  if (entry === undefined || labelColumn === undefined) {
    // The registry is a shipped file, not a runtime input; a missing `list` is a broken build,
    // and a marker that renders nothing is a better failure than a page with placeholder copy.
    return `<div data-unresolved-source="${block.id}"></div>`;
  }
  // `{href}` (the cell is the URL) or `/blog/{slug}` (a path template) — either way the
  // binding needs *a* column to pass `bindRow`'s "does this row have it" check; the template
  // itself is what `hrefFor` fills.
  const hrefColumn =
    block.href === undefined
      ? undefined
      : (/^\{([a-z][a-z0-9_]*)\}$/.exec(block.href)?.[1] ?? /\{([a-z][a-z0-9_]*)\}/.exec(block.href)?.[1]);
  const repeat =
    block.layout === 'cards'
      ? `<article class="card" data-repeat><h3 class="card__title" data-bind-label="${labelColumn}">Item</h3>${
          hrefColumn === undefined ? '' : `<a class="card__link" data-bind-href-link="${hrefColumn}" href="#">Open</a>`
        }</article>`
      : `<li data-repeat><a data-bind-label="${labelColumn}"${
          hrefColumn === undefined ? '' : ` data-bind-href-link="${hrefColumn}"`
        } href="#">Item</a></li>`;
  const wrapper = block.layout === 'cards' ? '' : '<ul class="list__items">';
  const close = block.layout === 'cards' ? '' : '</ul>';
  return `<div class="list" data-gjs-type="list" data-source="${block.id}" data-limit="${block.limit}">${wrapper}${repeat}${close}<p class="list__empty" data-empty>Nothing here yet.</p></div>`;
}

export interface EditorPageInput {
  tenant: string;
  /** `null` opens a blank document (a new page). */
  page: {
    id: number | null;
    path: string;
    title: string;
    status: string;
    template: string;
    managedBy: string;
    bodyHtml: string;
    rev: number;
    /** There are unpublished changes (S8b): the canvas holds a draft the site is not serving. */
    draft: boolean;
  } | null;
  registry: Registry;
  csrf: string;
  /** The page's own stylesheet, as the bytes the draft holds. Shown in the canvas below it. */
  bodyCss: string;
  /**
   * S8s: the site's stylesheet, linked into the canvas so the page is edited in the look it will
   * be published in. `null` when the tenant has no theme and no chrome rules — a canvas with no
   * sheet is what a brand-new site looks like, and it says so.
   */
  sheetHref?: string | null;
  /**
   * S8s: the page's own CSS as a URL on the editor's own prefix (the draft, not the published
   * copy), or `null` when the draft has none. Served session-gated and `no-store`: it is a draft,
   * and a draft must not be cacheable by anything.
   */
  pageCssHref?: string | null;
  /**
   * S8s: the site's header and footer, as the shell writes them, so the canvas shows the page in
   * place instead of a document floating in an editor. `null` when the site has neither bar.
   */
  frame?: { header: string; footer: string } | null;
  /** The page's path, so the header marks the current item the way the site does. */
  pagePath?: string;
  /**
   * S8h: the blocks this tenant's **enabled** packages contribute. Each becomes a palette entry
   * that inserts a marker; the host draws the view at render time. A disabled package's blocks
   * are absent from this list, which is how the palette and the renderer stay in step.
   */
  blocks?: (BlockForPalette & { plugin: string })[];
  /** S8k: the forms this tenant's enabled packages declared. Each inserts a marker the host fills. */
  forms?: { id: string; label: string }[];
}

/** `JSON.stringify` inside a `<script type="application/json">`: `<` must not close it. */
function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/**
 * S8s: the basic palette — plain HTML, no registry entry, no `data-gjs-type`.
 *
 * The palette was *only* the registry, which is the right rule for anything the renderer has to
 * know about (a hero, a list bound to a table, a plugin's view) and the wrong rule for `<div>`.
 * An operator laying out a page reaches for a section, a column, a heading, a rule; every one of
 * those is ordinary markup the renderer treats as ordinary markup, and until this list existed
 * the only way to get one was to type it into a page that had been hand-managed — which the editor
 * refuses to open.
 *
 * They carry `data-type="element"` so the picker can tell them apart from a registry entry (it has
 * no fields for them: the Style Manager is their panel), and they are inserted as **content**, so
 * GrapesJS parses them into ordinary components — droppable, nestable, draggable, stylable by the
 * same Style Manager as everything else. That is what "*fully* supported in DnD" means here: a
 * `div` you can drop a `section` into, and a `section` you can drop a `div` into.
 *
 * The starters carry a little copy so a drop is visible and obviously editable; an empty `div`
 * would be a zero-height box, which is indistinguishable from a drop that did nothing.
 */
const BASIC_BLOCKS: PaletteItem[] = [
  {
    id: 'basic-section',
    label: 'Section',
    category: 'Basic',
    type: 'element',
    kind: 'element',
    content: '<section class="s-band"><h2>Section heading</h2><p>Say what this band is for.</p></section>',
    editable: [],
  },
  {
    id: 'basic-div',
    label: 'Div (container)',
    category: 'Basic',
    type: 'element',
    kind: 'element',
    content: '<div class="s-grid"><div class="s-col"><h3>Column</h3><p>Text.</p></div><div class="s-col"><h3>Column</h3><p>Text.</p></div></div>',
    editable: [],
  },
  {
    id: 'basic-columns-3',
    label: 'Three columns',
    category: 'Basic',
    type: 'element',
    kind: 'element',
    content:
      '<div class="s-grid"><div class="s-col"><h3>One</h3><p>Text.</p></div><div class="s-col"><h3>Two</h3><p>Text.</p></div><div class="s-col"><h3>Three</h3><p>Text.</p></div></div>',
    editable: [],
  },
  {
    id: 'basic-stack',
    label: 'Combo (heading + text + link)',
    category: 'Basic',
    type: 'element',
    kind: 'element',
    content:
      '<div><p class="s-eyebrow">Eyebrow</p><h2>A heading that carries the point</h2><p>A paragraph under it, then a way onward.</p><p><a class="s-btn" href="/contact">Get in touch</a></p></div>',
    editable: [],
  },
  { id: 'basic-h2', label: 'Heading h2', category: 'Basic', type: 'element', kind: 'element', content: '<h2>Heading</h2>', editable: [] },
  { id: 'basic-h3', label: 'Heading h3', category: 'Basic', type: 'element', kind: 'element', content: '<h3>Subheading</h3>', editable: [] },
  { id: 'basic-p', label: 'Paragraph', category: 'Basic', type: 'element', kind: 'element', content: '<p>Paragraph text.</p>', editable: [] },
  { id: 'basic-link', label: 'Link', category: 'Basic', type: 'element', kind: 'element', content: '<p><a href="/">Link text</a></p>', editable: [] },
  {
    id: 'basic-ul',
    label: 'Bulleted list',
    category: 'Basic',
    type: 'element',
    kind: 'element',
    content: '<ul><li>First point</li><li>Second point</li></ul>',
    editable: [],
  },
  {
    id: 'basic-ol',
    label: 'Numbered list',
    category: 'Basic',
    type: 'element',
    kind: 'element',
    content: '<ol><li>First step</li><li>Second step</li></ol>',
    editable: [],
  },
  {
    id: 'basic-quote',
    label: 'Quote',
    category: 'Basic',
    type: 'element',
    kind: 'element',
    content: '<blockquote><p>The sentence worth setting apart.</p><footer>— who said it</footer></blockquote>',
    editable: [],
  },
  {
    id: 'basic-details',
    label: 'Collapsible',
    category: 'Basic',
    type: 'element',
    kind: 'element',
    content: '<details><summary>More detail</summary><p>The part most readers skip.</p></details>',
    editable: [],
  },
  {
    id: 'basic-table',
    label: 'Table',
    category: 'Basic',
    type: 'element',
    kind: 'element',
    content:
      '<table><thead><tr><th>Heading</th><th>Heading</th></tr></thead><tbody><tr><td>Cell</td><td>Cell</td></tr><tr><td>Cell</td><td>Cell</td></tr></tbody></table>',
    editable: [],
  },
  { id: 'basic-hr', label: 'Divider', category: 'Basic', type: 'element', kind: 'element', content: '<hr>', editable: [] },
  {
    id: 'basic-blockquote-attr',
    label: 'Note',
    category: 'Basic',
    type: 'element',
    kind: 'element',
    content: '<aside class="s-note"><p>A small note beside the argument.</p></aside>',
    editable: [],
  },
];

export function editorBootPayload(input: EditorPageInput): {
  palette: PaletteItem[];
  categories: string[];
  types: { type: string; tagName: string; droppable: boolean }[];
  page: NonNullable<EditorPageInput['page']>;
  css: string;
  tenant: string;
  csrf: string;
  /** S8s: what the canvas needs to look like the site. See `applySiteFrame` in the boot script. */
  frame: {
    sheet: string | null;
    pageCss: string | null;
    header: string;
    footer: string;
    path: string;
  };
} {
  // S8s: the basic elements first — they are what a page is made of — then the host's registry
  // components, then one group for the packages: a package cannot add a component (that would be
  // plugin markup in the canvas), only a marker the host resolves.
  const items: PaletteItem[] = [
    ...BASIC_BLOCKS,
    ...palette(input.registry),
    ...(input.blocks ?? []).map((block) => ({
      id: `block-${block.id.replace(/\//g, '-')}`,
      label: block.label,
      category: 'Plugins',
      type: 'block',
      kind: 'block' as const,
      content: listComponentFor(input.registry, block),
      // No settings panel: the block's view is the package's declaration, not a page decision.
      editable: [],
    })),
    // A form is a marker too: the fields and the sent/error state are the host's to draw.
    ...(input.forms ?? []).map((form) => ({
      id: `form-${form.id.replace(/\//g, '-')}`,
      label: form.label,
      category: 'Plugins',
      type: 'form',
      kind: 'block' as const,
      // Visible in the canvas: the marker draws nothing on the page (the host replaces this whole
      // element at render time), and a zero-height div reads as "the drop did nothing".
      //
      // **The root carries no `data-gjs-draggable`.** GrapesJS decides whether a drop is legal by
      // parsing the block's content and asking `canMove` about *that component's* `draggable` — so
      // marking the root non-draggable to keep the preview inert made the block impossible to drop
      // at all: no green line, no insertion, silently. The inertness has to sit on the preview's
      // own children, which are not the component being dragged.
      content:
        `<div data-skw-form="${form.id}" class="skw-form-marker" ` +
        `style="border:1px dashed #8a97a8;border-radius:6px;padding:12px;margin:8px 0;background:#f7f9fc">` +
        `<div data-gjs-editable="false" style="font-weight:600;font-size:13px;color:#33415c">${form.label}</div>` +
        `<div data-gjs-editable="false" style="font-size:12px;color:#5b6b83;margin-top:4px">Drawn by the site when the page is served — fields, labels and the thanks line come from the package.</div>` +
        `</div>`,
      editable: [],
    })),
  ];
  const defs = typeDefinitions(input.registry);
  return {
    palette: items,
    categories: paletteCategories(items),
    types: defs.map((def) => {
      const defaults = (def.model as { defaults: { tagName: string; droppable: boolean } }).defaults;
      return { type: def.type, tagName: defaults.tagName, droppable: defaults.droppable };
    }),
    page:
      input.page ?? {
        id: null,
        path: '/new',
        title: 'New page',
        status: 'draft',
        template: 'page',
        managedBy: 'editor',
        bodyHtml: '',
        rev: 0,
        draft: false,
      },
    css: input.bodyCss,
    tenant: input.tenant,
    csrf: input.csrf,
    frame: {
      sheet: input.sheetHref ?? null,
      pageCss: input.pageCssHref ?? null,
      header: input.frame?.header ?? '',
      footer: input.frame?.footer ?? '',
      path: input.pagePath ?? input.page?.path ?? '/',
    },
  };
}

export function renderEditorPage(input: EditorPageInput): string {
  const payload = editorBootPayload(input);
  const title = input.page === null ? 'New page' : input.page.title;
  // The assets are on the same tenant-scoped prefix as the page: they are behind the
  // session like everything else on this surface, so a static bundle cannot be hot-linked
  // from another origin or read without a cookie.
  const base = `/admin/t/${encodeURIComponent(input.tenant)}/editor`;
  const readonly = payload.page.managedBy === 'hand';
  // S8b: "Live" and "everything you made is live" are two different claims. A published page
  // with a pending draft is the second one's absence, so it gets its own pill rather than a
  // green Live over a body the operator has already replaced in the canvas.
  const pillState = payload.page.status === 'published' && payload.page.draft ? 'pending' : payload.page.status;
  const pillWord = pillState === 'pending' ? 'Unpublished changes' : statusWord(payload.page.status);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)} — editor</title>
<link rel="stylesheet" href="${base}/grapesjs.css">
<style>
body{margin:0;font:14px/1.4 system-ui,sans-serif}
#skw-layout{display:grid;grid-template-columns:240px minmax(0,1fr) 344px;height:100vh}
#skw-blocks{overflow:auto;border-right:1px solid #ddd;padding:.5rem}
#skw-settings{overflow:auto;border-left:1px solid #e3e3e8;background:#f7f7f9;padding:.6rem;display:flex;flex-direction:column;gap:.6rem}
#skw-canvas{overflow:auto;background:#f3f3f6}
/* GrapesJS ships a DARK theme (:root{--gjs-primary-color:#444 …}). Half a dark editor inside a
   white admin reads as unfinished, so the palette is re-pointed at the admin's own colours
   here — five custom properties, no stylesheet fork, no !important spray. */
/* On :root, not #gjs: the Style Manager is mounted in #skw-settings, which is outside the
   editor container, and a theme set on #gjs would leave exactly that column dark. */
:root{
  --gjs-primary-color:#ffffff;
  --gjs-secondary-color:#24242b;
  --gjs-tertiary-color:#f3f3f6;
  --gjs-quaternary-color:#2563eb;
  --gjs-font-color:#24242b;
  --gjs-font-color-active:#111116;
  --gjs-main-dark-color:rgba(0,0,0,.04);
  --gjs-secondary-dark-color:rgba(0,0,0,.03);
  --gjs-main-light-color:rgba(255,255,255,.6);
  --gjs-secondary-light-color:rgba(0,0,0,.45);
}
/* A page editor should show the page as the visitor sees it: white, not the theme's gutter. */
#skw-canvas .gjs-cv-canvas,#skw-canvas .gjs-cv-canvas__frames,#skw-canvas .gjs-frame-wrapper{background:#e9e9ee}
#skw-blocks h3{margin:.75rem 0 .25rem;font-size:.75rem;text-transform:uppercase;color:#666}
/* The palette is GrapesJS's block manager (S8j): its own elements, styled as our column's
   buttons were, so the library keeps the drag and the column keeps its look. */
#skw-blocks .gjs-block-category{width:100%}
#skw-blocks .gjs-title{font-size:.75rem;text-transform:uppercase;color:#666;letter-spacing:.03em;margin:.75rem 0 .25rem;padding:0}
#skw-blocks .gjs-blocks-c{display:block;padding:0}
#skw-blocks .gjs-block{display:block;width:100%;text-align:left;margin:.15rem 0;padding:.35rem .5rem;cursor:grab;border:1px solid var(--line);border-radius:var(--r-in);background:#fff;font:inherit;font-size:13.5px;min-height:0;box-shadow:none}
#skw-blocks .gjs-block:hover{border-color:var(--blue)}
#skw-blocks .gjs-block.gjs-block--disabled{opacity:.45;cursor:not-allowed}
#skw-settings .field{margin:.5rem 0}
#skw-settings img{max-width:100%}
#skw-notice{margin:0;padding:.6rem .8rem;background:#fdecec;border-bottom:1px solid #d9a3a3;color:#8a1c1c;font-weight:600}
#skw-notice[hidden]{display:none}
[data-skw-readonly="1"] #skw-canvas{opacity:.7}
/* The editor's own toolbar. GrapesJS ships default panel buttons whose icons are Font
   Awesome class names ('fa fa-eye', 'fa fa-code', 'fa fa-arrows-alt' …), and this repo
   never loads Font Awesome — so every one of them rendered as an empty 30×30 box. Rather
   than add a 900 kB icon font to draw four glyphs, the buttons are drawn as inline SVG
   here and GrapesJS's panels are switched off in the boot script. */
#skw-bar{display:flex;align-items:center;gap:.5rem;height:56px;padding:0 1rem;background:#fff;border-bottom:1px solid #e3e3e8;font:14px/1.4 system-ui,sans-serif}
#skw-bar .skw-back{display:inline-flex;align-items:center;gap:.35rem;color:#4a4a55;text-decoration:none;padding:.35rem .5rem;border-radius:8px}
#skw-bar .skw-back:hover{background:#f2f2f5}
#skw-bar h1{font-size:1rem;font-weight:600;margin:0;color:#16161a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:38vw}
#skw-bar .skw-pill{display:inline-flex;align-items:center;gap:.35rem;font-size:.75rem;font-weight:600;padding:.2rem .55rem;border-radius:999px;background:#e7f6ec;color:#14532d}
#skw-bar .skw-pill[data-state="draft"]{background:#fff4e0;color:#7a4a00}
#skw-bar .skw-pill[data-state="hidden"]{background:#f2f2f5;color:#4a4a55}
/* Live, with unpublished changes: the page is up, but what the operator made is not what
   visitors are getting. Amber, and never the green "Live" on its own. */
#skw-bar .skw-pill[data-state="pending"]{background:#fff4e0;color:#7a4a00}
#skw-bar .skw-spacer{flex:1}
#skw-bar .skw-btn{display:inline-flex;align-items:center;gap:.4rem;height:34px;padding:0 .7rem;border:1px solid #d8d8de;background:#fff;color:#24242b;border-radius:9px;font:inherit;cursor:pointer}
#skw-bar .skw-btn:hover{background:#f6f6f8}
#skw-bar .skw-btn:focus-visible{outline:3px solid #2563eb;outline-offset:2px}
#skw-bar .skw-btn[disabled]{opacity:.45;cursor:default}
#skw-bar .skw-btn--icon{padding:0;width:34px;justify-content:center}
#skw-bar .skw-btn--primary{background:#2563eb;border-color:#2563eb;color:#fff;font-weight:600}
#skw-bar .skw-btn--primary:hover{background:#1d4ed8}
#skw-bar .skw-btn svg{width:17px;height:17px;fill:none;stroke:currentColor;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round}
#skw-bar .skw-save-state{font-size:.8rem;color:#6b6b76;min-width:9rem;text-align:right}
#skw-bar .skw-save-state[data-dirty="1"]{color:#7a4a00;font-weight:600}
#skw-layout{height:calc(100vh - 56px);display:grid;grid-template-columns:240px minmax(0,1fr) 344px;grid-template-rows:1fr}
/* ---- the inspector: three cards in the right rail ----
   Selection (what the element is, and the attributes it carries), CSS for that element
   (the GrapesJS Style Manager), and the page's own stylesheet. Before this, the rail held the
   Style Manager alone and the selection handler *emptied the rail* for any component that had
   no registry entry — so selecting a heading left a blank white column. */
/* flex:0 0 auto — a flex column squeezes its children, and an inspector card that is clipped
   halfway through its rows looks like a bug in the values rather than a scrollbar away. */
.skw-card{flex:0 0 auto;border:1px solid #e4e4e9;border-radius:10px;background:#fff;overflow:hidden}
.skw-card__head{display:flex;align-items:center;gap:.45rem;padding:.5rem .6rem;border-bottom:1px solid #f0f0f3;background:#fff;position:sticky;top:0;z-index:2}
.skw-card__head h2{font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#6b6b76;margin:0;white-space:nowrap}
.skw-chip{font:11.5px/1 ui-monospace,SFMono-Regular,Menlo,monospace;color:#24242b;background:#f3f3f6;border:1px solid #e6e6ea;border-radius:999px;padding:.28rem .45rem;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.skw-chip[data-empty="1"]{color:#9a9aa4;background:#fafafc}
.skw-body{padding:.55rem .6rem .65rem}
.skw-hint{margin:.15rem .1rem .2rem;font-size:.76rem;line-height:1.45;color:#6b6b76}
.skw-row{display:grid;grid-template-columns:58px minmax(0,1fr);align-items:center;gap:.45rem;margin:.35rem 0}
.skw-row label,.skw-attrhead span{font-size:.7rem;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:#6b6b76}
.skw-in{width:100%;height:28px;padding:0 .45rem;border:1px solid #dcdce2;border-radius:6px;font:12.5px/1 ui-monospace,SFMono-Regular,Menlo,monospace;color:#1f2430;background:#fff}
.skw-in:focus{outline:2px solid #2563eb;outline-offset:1px;border-color:#2563eb}
.skw-attrhead{display:flex;align-items:center;justify-content:space-between;margin:.6rem 0 .2rem}
.skw-attrs{display:grid;gap:.28rem}
.skw-attr{display:grid;grid-template-columns:minmax(0,.85fr) minmax(0,1fr) 26px;gap:.28rem}
.skw-attr .skw-in{height:26px;font-size:12px}
.skw-attrs__none{margin:.1rem 0 .2rem;font-size:.75rem;color:#9a9aa4}
.skw-railbtn{display:inline-flex;align-items:center;justify-content:center;height:26px;padding:0 .5rem;border:1px solid #dcdce2;border-radius:6px;background:#fff;color:#24242b;font:12px/1 system-ui,sans-serif;cursor:pointer}
.skw-railbtn:hover{background:#f4f4f7;border-color:#c9c9d2}
.skw-railbtn:focus-visible{outline:2px solid #2563eb;outline-offset:1px}
.skw-railbtn[disabled]{opacity:.45;cursor:default}
.skw-attr__drop{border:1px solid transparent;background:transparent;color:#9a9aa4;font:15px/1 system-ui,sans-serif;cursor:pointer;border-radius:6px}
.skw-attr__drop:hover{background:#fdecec;color:#8a1c1c}
/* The Style Manager, inside its card. GrapesJS's own chrome is dense; these are spacing and
   rule-colour changes only — no property, sector or field is hidden. */
#skw-styles{padding:.3rem .4rem .5rem;max-height:min(52vh,520px);overflow:auto}
#skw-styles .gjs-sm-sector{border:0;border-top:1px solid #f0f0f3}
#skw-styles .gjs-sm-sector:first-child{border-top:0}
#skw-styles .gjs-sm-sector-title{font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;padding:.45rem .2rem;border-bottom:0}
#skw-styles .gjs-sm-properties{padding:.1rem .2rem .5rem}
#skw-styles .gjs-sm-property{margin:.25rem 0}
#skw-styles .gjs-sm-label{font-size:.72rem;color:#6b6b76}
#skw-styles .gjs-field{background:#fff;border:1px solid #dcdce2;border-radius:6px;color:#1f2430;font-size:12px}
/* What the browser is painting, as opposed to what a rule says: the value column is
   getComputedStyle, so an inherited serif and an inherited colour show up as themselves. */
.skw-computed{display:grid;grid-template-columns:auto minmax(0,1fr);gap:.2rem .7rem;margin:0}
.skw-computed dt{font-size:.7rem;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:#6b6b76;white-space:nowrap;padding-top:.15rem}
.skw-computed dd{margin:0;font:11.5px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;color:#1f2430;overflow-wrap:anywhere}
.skw-swatch{display:inline-block;width:11px;height:11px;border-radius:3px;border:1px solid rgba(0,0,0,.18);vertical-align:-1px;margin-right:.35rem}
#skw-rules-details{border-top:1px solid #f0f0f3;padding:.35rem .6rem .5rem}
#skw-rules-details summary{font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#6b6b76;cursor:pointer;padding:.25rem 0}
.skw-rules{margin:.2rem 0 0;padding:0 0 0 1.1rem;display:grid;gap:.3rem}
.skw-rules li{font:11.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:#4a4a55;overflow-wrap:anywhere}
.skw-rules code{color:#1f2430;background:#f3f3f6;border-radius:4px;padding:.05rem .3rem}
.skw-rules .skw-media{color:#9a9aa4;font-size:11px}
/* S8s: the page's own stylesheet, in the rail under the element's CSS. It is a file the server
   serves (/_css/<sha>.css), linked after the theme; this box is what writes it. */
#skw-css{flex:0 0 auto;display:flex;flex-direction:column}
#skw-css-hint{margin:.45rem .6rem .2rem}
#skw-css-actions{display:flex;align-items:center;gap:.4rem;padding:0 .6rem .45rem}
#skw-css-text{margin:0;border:0;border-top:1px solid #f0f0f3;padding:.55rem .6rem;font:12.5px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;tab-size:2;resize:vertical;min-height:132px;color:#1f2430;background:#fbfbfd;outline:none;width:100%}
#skw-css[data-open="0"] #skw-css-text{display:none}
#skw-css-text:focus{box-shadow:inset 0 0 0 2px #2563eb}
</style></head>
<body data-skw-readonly="${readonly ? '1' : '0'}">
<header id="skw-bar">
  <a class="skw-back" href="/admin/t/${encodeURIComponent(input.tenant)}/" aria-label="Back to your pages"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 12H5"/><path d="m12 19-7-7 7-7"/></svg>Pages</a>
  <h1>${escapeHtml(title)}</h1>
  <span class="skw-pill" data-state="${escapeHtml(pillState)}" id="skw-pill"><svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor" aria-hidden="true"><circle cx="12" cy="12" r="6"/></svg><span id="skw-pill-word">${escapeHtml(pillWord)}</span></span>
  <span class="skw-spacer"></span>
  <span class="skw-save-state" id="skw-save-state" role="status" aria-live="polite">${readonly ? 'Hand-written page — read only' : 'No changes yet'}</span>
  <button type="button" class="skw-btn skw-btn--icon" id="skw-undo" title="Undo" aria-label="Undo" aria-keyshortcuts="Control+z"${readonly ? ' disabled' : ''}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/></svg></button>
  <button type="button" class="skw-btn skw-btn--icon" id="skw-redo" title="Redo" aria-label="Redo" aria-keyshortcuts="Control+Shift+z"${readonly ? ' disabled' : ''}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 14 5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/></svg></button>
  <button type="button" class="skw-btn" id="skw-preview" title="Preview the page without editing controls"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>Preview</button>
  <button type="button" class="skw-btn" id="skw-save" title="Save your changes as a draft — nothing goes live until you publish"${readonly ? ' disabled' : ''}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 13 4 4L19 7"/></svg>Save</button>
  <button type="button" class="skw-btn skw-btn--primary" id="skw-publish" title="Publish — put what you have made live for visitors"${readonly || !payload.page.draft ? ' disabled' : ''}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>Publish</button>
</header>
<p id="skw-notice" role="alert" hidden></p>
<div id="skw-layout">
  <aside id="skw-blocks" aria-label="Blocks"></aside>
  <div id="skw-canvas"><div id="gjs"></div></div>
  <aside id="skw-settings" aria-label="Inspector">
    <section class="skw-card" id="skw-selection" aria-labelledby="skw-selection-head">
      <header class="skw-card__head"><h2 id="skw-selection-head">Selection</h2><span class="skw-chip" id="skw-sel-where" data-empty="1">nothing selected</span></header>
      <div class="skw-body">
        <p class="skw-hint" id="skw-sel-empty">Click an element in the page — or drop one from the library — to see its tag, id, classes and every attribute it carries. All of them are editable here.</p>
        <div id="skw-sel-body" hidden>
          <div class="skw-row"><label for="skw-sel-id">id</label><input class="skw-in" id="skw-sel-id" spellcheck="false" autocapitalize="off" autocomplete="off" placeholder="(no id)"></div>
          <div class="skw-row"><label for="skw-sel-classes">classes</label><input class="skw-in" id="skw-sel-classes" spellcheck="false" autocapitalize="off" autocomplete="off" placeholder="space separated"></div>
          <div class="skw-attrhead"><span>Attributes</span><button type="button" class="skw-railbtn" id="skw-attr-add">+ add</button></div>
          <div class="skw-attrs" id="skw-sel-attrs"></div>
          <div id="skw-sel-fields"></div>
        </div>
      </div>
    </section>
    <section class="skw-card" id="skw-computed" aria-labelledby="skw-computed-head">
      <header class="skw-card__head"><h2 id="skw-computed-head">Computed</h2><span class="skw-chip" id="skw-computed-chip" data-empty="1">—</span></header>
      <div class="skw-body">
        <p class="skw-hint" id="skw-computed-empty">Select an element to see the values the browser is actually painting — including everything it inherits.</p>
        <dl class="skw-computed" id="skw-computed-list" hidden></dl>
      </div>
    </section>
    <section class="skw-card" id="skw-styles-card" aria-labelledby="skw-styles-head">
      <header class="skw-card__head"><h2 id="skw-styles-head">CSS · this element</h2><span class="skw-chip" id="skw-styles-target" data-empty="1">—</span></header>
      <p class="skw-hint" id="skw-style-need" hidden>No class or id yet — a CSS rule needs a selector. Name one here and the properties appear.</p>
      <div id="skw-style-give" hidden><input class="skw-in" id="skw-style-class" spellcheck="false" autocapitalize="off" autocomplete="off" placeholder="class name"><button type="button" class="skw-railbtn" id="skw-style-add">Style it</button></div>
      <div id="skw-styles"></div>
      <details id="skw-rules-details"><summary>Rules reaching this element</summary><ol class="skw-rules" id="skw-rules"></ol></details>
    </section>
    <section class="skw-card" id="skw-css" aria-label="This page's CSS" data-open="1">
      <header class="skw-card__head">
        <h2>Page CSS</h2>
        <span class="skw-chip" id="skw-css-count">0 rules</span>
        <button type="button" class="skw-railbtn" id="skw-css-toggle" aria-expanded="true" aria-controls="skw-css-text" style="margin-left:auto">Hide</button>
      </header>
      <p class="skw-hint" id="skw-css-hint">Its own file, this page only, loaded <em>after</em> the theme — a rule here wins at equal specificity. Press Save to put it on the page.</p>
      <div id="skw-css-actions"><button type="button" class="skw-railbtn" id="skw-css-scaffold"${readonly ? ' disabled' : ''}>Add a rule for the selected element</button></div>
      <textarea id="skw-css-text" spellcheck="false" autocapitalize="off" autocomplete="off" placeholder=".s-hero h1 { font-size: 4.5rem }"${readonly ? ' readonly' : ''}></textarea>
    </section>
  </aside>
</div>
<script type="application/json" id="skw-editor-boot">${jsonForScript(payload)}</script>
<script src="${base}/grapesjs.js"></script>
<script src="${base}/editor.js"></script>
</body></html>`;
}

/** The three words the page list uses, so the editor and the list never disagree. */
function statusWord(status: string): string {
  if (status === 'published') return 'Live';
  if (status === 'hidden') return 'Hidden';
  return 'Draft';
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * The boot script, as a constant rather than a file: `tsc` copies `.ts` to `dist/`, and a
 * `.js` beside it would be a file that exists in the repo and not in the image — the exact
 * class of defect E-28's dist gate exists to catch. It is served byte-for-byte.
 *
 * One thing is injected: the `data-gjs-type` pattern the paste gate scans for, from
 * `app/editor/paste.ts`. The browser cannot import a server module, so what is shared is the
 * pattern's **source text** — a second regex literal here would be a second registry reader,
 * and the two would drift exactly the way S4a F1's two unwrappers did.
 */
const BOOT_SCRIPT = String.raw`
(function () {
  'use strict';
  var boot = JSON.parse(document.getElementById('skw-editor-boot').textContent);
  var readonly = document.body.dataset.skwReadonly === '1';
  // Declared at the top because rememberIds() runs before the inspector's own section further
  // down: var hoists the name but not the value, and the first version of this threw
  // "Cannot set properties of undefined" — an exception that aborted the rest of the boot
  // script, so Save was never bound.
  var authoredIds = Object.create(null);
  var editor = grapesjs.init({
    container: '#gjs',
    height: '100%',
    storageManager: false,
    fromElement: false,
    // The canvas is the page's own markup: no iframe, so the admin CSP applies to it and
    // a component cannot escape into a frame the server did not configure.
    canvas: { scripts: [], styles: [] },
    deviceManager: { devices: [{ name: 'Desktop', width: '' }] },
    // GrapesJS's default panels are switched OFF. Every button in them draws a Font
    // Awesome glyph ('fa fa-eye', 'fa fa-code', 'fa fa-arrows-alt' …) and this repo ships no
    // Font Awesome, so all of them rendered as empty 30×30 boxes — the defect the operator
    // reported as "the buttons are not visible". The toolbar in the page above is ours and
    // draws its icons as inline SVG.
    panels: { defaults: [] },
    // The Style Manager is the one part of GrapesJS's stock chrome this screen needs, and it
    // used to arrive inside a default panel whose buttons are Font Awesome glyphs. It is mounted
    // into the inspector's own card (#skw-styles) — a container this script never writes to, so
    // selecting an element cannot wipe it.
    styleManager: { appendTo: '#skw-styles' },
    // The palette is GrapesJS's own block manager, mounted in our column. Its views are what
    // implement a block drag: they set the transfer payload *and* the editor's dragSource, which
    // is what the canvas sorter reads on drop. Hand-rolled buttons in this column could show the
    // insertion line (dragover is accepted for anything) and then drop nothing, because they set
    // neither — the defect the operator reported as "the green line appears, then nothing".
    blockManager: { appendTo: '#skw-blocks' },
  });

  // The toolbar. Four controls, wired to the editor's own commands, plus a dirty marker so
  // "did that save?" is answered on screen instead of guessed.
  function el(id) { return document.getElementById(id); }
  function on(id, fn) {
    var node = el(id);
    if (node) node.addEventListener('click', function (event) { event.preventDefault(); fn(); });
  }
  var saveState = el('skw-save-state');

  function setState(text, isDirty) {
    if (!saveState) return;
    saveState.textContent = text;
    saveState.setAttribute('data-dirty', isDirty ? '1' : '0');
  }

  editor.on('update', function () { setState('Unsaved changes', true); });

  function pillSet(state, word) {
    var pill = el('skw-pill');
    var text = el('skw-pill-word');
    if (pill) pill.setAttribute('data-state', state);
    if (text) text.textContent = word;
  }

  /**
   * E-47: a save or a publish answered "no session" means the idle window closed while the
   * editor was open. Nothing typed into this document can be saved, so the only useful move
   * is the login page, carrying this page's own address so signing in comes back to it.
   *
   * The console's screens are links and forms, so the server answers them with a redirect
   * itself; this editor talks to its save and publish routes with fetch, which asks for JSON
   * and therefore still gets the row-7 404. That is why the branch lives here as well.
   */
  function signedOut(res) {
    var code = res && res.error && res.error.code;
    if (code !== 'SKW_E_PLT_TENANT_UNKNOWN') return false;
    setState('Your session expired — taking you back to sign in', true);
    window.location.assign('/admin/login?next=' + encodeURIComponent(window.location.pathname));
    return true;
  }

  /**
   * S8b: Save writes a draft; Publish is what puts it in front of visitors. Save therefore
   * ENABLES Publish rather than claiming the change is live — the sentence this screen used to
   * put on the Save button ("a page that visitors can see updates the moment you save") was
   * true, and true is why it was wrong: it took live pages off the site.
   */
  function saveNow() {
    var button = el('skw-save');
    if (button) button.disabled = true;
    setState('Saving…', true);
    return window.skwSave()
      .then(function (res) {
        var ok = res && res.ok !== false && !(res.error);
        if (ok) {
          boot.page.draft = true;
          if (boot.page.id === null && res && res.id !== undefined) boot.page.id = res.id;
          var publish = el('skw-publish');
          if (publish) publish.disabled = false;
          if (boot.page.status === 'published') {
            pillSet('pending', 'Unpublished changes');
            setState('Saved as a draft — press Publish to put it live', true);
          } else {
            setState('Saved as a draft — press Publish to make it live', true);
          }
        } else if (!signedOut(res)) {
          setState((res && res.error && res.error.message) || 'Could not save', true);
        }
        return ok;
      })
      .catch(function () { setState('Could not save', true); return false; })
      .then(function (ok) { if (button) button.disabled = false; return ok; });
  }

  function publishNow() {
    if (boot.page.id === null) {
      setState('Save the page first', true);
      return Promise.resolve(false);
    }
    var button = el('skw-publish');
    if (button) button.disabled = true;
    setState('Publishing…', true);
    return window.skwPublish()
      .then(function (res) {
        var ok = res && res.ok !== false && !(res.error);
        if (ok) {
          boot.page.draft = false;
          boot.page.status = 'published';
          pillSet('published', 'Live');
          setState('Published — visitors can see it now', false);
        } else if (!signedOut(res)) {
          setState((res && res.error && res.error.message) || 'Could not publish', true);
          if (button) button.disabled = false;
        }
        return ok;
      })
      .catch(function () { setState('Could not publish', true); if (button) button.disabled = false; return false; });
  }

  on('skw-undo', function () { editor.UndoManager.undo(); });
  on('skw-redo', function () { editor.UndoManager.redo(); });
  on('skw-preview', function () { editor.runCommand('core:preview'); });
  on('skw-save', function () { saveNow(); });
  on('skw-publish', function () { publishNow(); });

  document.addEventListener('keydown', function (event) {
    if ((event.metaKey || event.ctrlKey) && String(event.key).toLowerCase() === 's') {
      event.preventDefault();
      saveNow();
    }
  });
  if (readonly) {
    ['skw-undo', 'skw-redo', 'skw-save', 'skw-publish'].forEach(function (id) { var n = el(id); if (n) n.disabled = true; });
  }

  // 1. The types, then the lock. Both come from the registry: a type the image does not
  //    ship is not registered here, and the server refused the document before this ran.
  boot.types.forEach(function (t) {
    editor.Components.addType(t.type, {
      isComponent: function (el) {
        if (el && el.getAttribute) return el.getAttribute('data-gjs-type') === t.type;
        if (el && el.attributes) return el.attributes['data-gjs-type'] === t.type;
        return false;
      },
      model: {
        defaults: {
          tagName: t.tagName,
          attributes: { 'data-gjs-type': t.type },
          droppable: t.droppable,
        },
      },
    });
  });

  var KNOWN_TYPES = Object.create(null);
  boot.types.forEach(function (t) { KNOWN_TYPES[t.type] = true; });

  // 0. THE PASTE GATE (S4a F2a). GrapesJS strips a data-gjs-type it has no definition for
  //    *while parsing*, so a pasted block arrives at the save route as a bare div with no
  //    lock — the server cannot tell it from prose, and S4a measured exactly that: 49 B in,
  //    37 B stored, HTTP 200. The evidence does not survive the parse, so the refusal runs
  //    on the clipboard's bytes: capture phase, on the canvas document, before GrapesJS's
  //    own handler and before the browser inserts anything. One unregistered type refuses
  //    the WHOLE paste — a partial insert is the defect, not the mitigation.
  var TYPE_RE = new RegExp(__SKW_PASTE_TYPE_PATTERN__, 'gi');
  var notice = document.getElementById('skw-notice');

  function clearNotice() {
    if (!notice) return;
    notice.hidden = true;
    notice.textContent = '';
    notice.removeAttribute('data-code');
    notice.removeAttribute('data-type');
  }

  function refuse(type, what) {
    if (!notice) return;
    notice.textContent = what + ' refused (SKW_E_RT_COMPONENT_UNKNOWN): no component is registered for ' +
      'data-gjs-type="' + type + '". Nothing was inserted.';
    notice.setAttribute('data-code', 'SKW_E_RT_COMPONENT_UNKNOWN');
    notice.setAttribute('data-type', type);
    notice.hidden = false;
  }

  function pastedTypes(html) {
    var found = [];
    var m;
    TYPE_RE.lastIndex = 0;
    while ((m = TYPE_RE.exec(html)) !== null) {
      var value = m[1] !== undefined ? m[1] : (m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : ''));
      if (found.indexOf(value) === -1) found.push(value);
    }
    // A bare data-gjs-type names no registered type either: refuse, do not guess.
    if (found.length === 0 && /data-gjs-type/i.test(html)) found.push('');
    return found;
  }

  function unregisteredIn(html) {
    if (!html) return null;
    var types = pastedTypes(html);
    for (var i = 0; i < types.length; i += 1) {
      if (!KNOWN_TYPES[types[i]]) return types[i];
    }
    return null;
  }

  function onPaste(ev) {
    var cd = ev.clipboardData;
    if (!cd) return;
    // text/plain is scanned too: GrapesJS's rich-text paste handler inserts plain text
    // through insertHTML, so in that element plain text *is* markup.
    var bad = unregisteredIn(cd.getData('text/html') || '');
    if (bad === null) bad = unregisteredIn(cd.getData('text/plain') || '');
    if (bad === null) { clearNotice(); return; }
    ev.preventDefault();
    ev.stopImmediatePropagation();
    refuse(bad, 'Paste');
  }

  // THE IMPORT CHOKEPOINT. Two documents enter this canvas without a paste: the stored body
  // the server validated (load) and the picker's answer, which is the client's own bytes
  // echoed back after one attribute changed (applyPick does not re-validate the document).
  // Both go through the scan, so GrapesJS is never handed a type it will silently strip.
  function applyDocument(html) {
    var bad = unregisteredIn(html || '');
    if (bad !== null) { refuse(bad, 'Document'); return false; }
    clearNotice();
    editor.setComponents(html || '');
    return true;
  }

  function gatePaste(doc) {
    if (!doc || doc.__skwPasteGate) return;
    doc.__skwPasteGate = true;
    doc.addEventListener('paste', onPaste, true);
  }

  function attachPasteGate() {
    try { gatePaste(editor.Canvas.getDocument()); } catch (e) { /* the frame is not up yet */ }
  }

  // The canvas is an iframe: its document is replaced when the frame reloads, so the gate is
  // attached again on every frame event rather than once at boot.
  attachPasteGate();
  editor.on('canvas:frame:load', attachPasteGate);
  editor.on('canvas:frame:load:body', attachPasteGate);
  editor.on('load', attachPasteGate);


  // S8s. THE SITE AROUND THE PAGE.
  //
  // The canvas is an iframe holding the page body. On its own that is a document in an editor:
  // browser-default type, no margins, no bar, no footer — which is the report this answers
  // ("the demo site looks amazing; the editor makes it hard to visualise"). Four things put the
  // site back, and none of them is a copy of the site's CSS:
  //
  //   1. the site's stylesheet, linked — same origin, so style-src 'self' allows it, and the
  //      theme's own bytes are what make the type, colours and band spacing match;
  //   2. the page's own draft CSS, linked after it, so a page rule wins at equal specificity;
  //   3. a real <main>: the shell wraps a page's body in one and every theme's layout selects
  //      main, so the components are moved into an element of that name and the GrapesJS view
  //      is pointed at it. main>section is a child selector — nothing else makes it match;
  //   4. the header and footer, inserted as *siblings* of <main>, so editor.getHtml() (which
  //      serialises the wrapper) never sees them and Save still stores exactly the page.
  //
  // GrapesJS rebuilds the canvas body when components are added or removed, so this runs on every
  // frame load and after every structural change: the furniture is ours to put back, not to keep.
  var frameScheduled = false;
  function scheduleFrame() {
    if (frameScheduled) return;
    frameScheduled = true;
    setTimeout(function () { frameScheduled = false; applySiteFrame(); }, 0);
  }

  function insertFrameNode(doc, html, before, kind) {
    // The template is created in the *canvas* document: a node from the admin document inserted
    // into the frame is adopted by the browser, which is a silent cross-document step that has
    // bitten this codebase before (the export's DOM). One document, one node.
    var tpl = doc.createElement('template');
    tpl.innerHTML = html;
    var node = tpl.content && tpl.content.firstElementChild;
    if (!node) return null;
    // The marker carries the *kind*, because that is what the lookups above ask for
    // ('[data-skw-frame="header"]'). Writing '1' here made those lookups never match, so every
    // structural change inserted another header and another footer into the canvas.
    node.setAttribute('data-skw-frame', kind);
    if (before === null) before.parentNode.appendChild(node);
    else before.parentNode.insertBefore(node, before);
    return node;
  }

  function applySiteFrame() {
    var doc;
    try { doc = editor.Canvas.getDocument(); } catch (e) { return; }
    if (!doc || !doc.body || !doc.head) return;
    doc.body.setAttribute('data-page-path', boot.frame.path);

    if (boot.frame.sheet && !doc.querySelector('link[data-skw-sheet]')) {
      var sheet = doc.createElement('link');
      sheet.rel = 'stylesheet';
      sheet.href = boot.frame.sheet;
      sheet.setAttribute('data-skw-sheet', '1');
      doc.head.appendChild(sheet);
    }
    if (boot.frame.pageCss && !doc.querySelector('link[data-skw-page-css]')) {
      var own = doc.createElement('link');
      own.rel = 'stylesheet';
      own.href = boot.frame.pageCss;
      own.setAttribute('data-skw-page-css', '1');
      doc.head.appendChild(own);
    }

    var view = editor.getWrapper().view;
    var el = view && view.el;
    if (!el) return;
    if (el.tagName !== 'MAIN') {
      var main = doc.createElement('main');
      main.setAttribute('data-skw-page', '1');
      if (el.id) main.id = el.id;
      while (el.firstChild) main.appendChild(el.firstChild);
      el.replaceWith(main);
      view.el = main;
      el = main;
    } else if (!el.getAttribute('data-skw-page')) {
      el.setAttribute('data-skw-page', '1');
    }

    var header = doc.querySelector('[data-skw-frame="header"]');
    if (boot.frame.header) {
      if (!header) header = insertFrameNode(doc, boot.frame.header, el, 'header');
    } else if (header) {
      header.remove();
    }
    var footer = doc.querySelector('[data-skw-frame="footer"]');
    if (boot.frame.footer) {
      if (!footer) insertFrameNode(doc, boot.frame.footer, el.nextSibling, 'footer');
    } else if (footer) {
      footer.remove();
    }
  }

  applySiteFrame();
  editor.on('canvas:frame:load', scheduleFrame);
  editor.on('component:add', scheduleFrame);
  editor.on('component:remove', scheduleFrame);

  // The editor is on window on purpose: every "the drop does nothing" report is a question about
  // em.get('dragSource'), Components.canMove and the parsed content, and none of that is readable
  // from outside. This is the same instance the page uses; no product code reads it.
  window.skwEditor = editor;

  // 2. The palette. Every registry entry becomes a block; the manager draws the DOM in our
  //    column, groups them by category and owns the drag. The data-type attribute is kept on
  //    each block's element so the picker can still find the entry a selection belongs to.
  boot.palette.forEach(function (item) {
    editor.Blocks.add(item.id, {
      label: item.label,
      category: item.category,
      content: item.content,
      // A hand-managed page is read-only in the canvas, so its palette must not insert either.
      ...(readonly ? { disable: true } : {}),
    });
  });
  boot.palette.forEach(function (item) {
    var view = editor.Blocks.get(item.id);
    if (view) view.set('attributes', { 'data-type': item.type });
  });

  // 3. The document. page.bodyHtml is what the server validated; a hand-managed page is
  //    read-only in the canvas (§10.6) because the next drag would re-serialise it.
  applyDocument(boot.page.bodyHtml || '');
  // The ids in the stored document are content; every id seen later is the editor's own.
  rememberIds();
  if (readonly) {
    editor.Canvas.getBody().setAttribute('contenteditable', 'false');
    editor.on('component:selected', function (c) { editor.selectRemove(c); });
  }

  // 4. THE INSPECTOR. Three things in the right rail, in this order:
  //
  //    a) what the element *is* — tag, id, classes, and every attribute it carries, each one
  //       editable in place (this is the panel the operator asked for after finding the rail
  //       blank: selecting a heading used to empty the whole rail and then return, because
  //       the handler bailed on any component with no registry entry — which is every plain
  //       element: div, section, h1, p, table …);
  //    b) the Style Manager, mounted in its own card (#skw-styles) and never written to by
  //       this script;
  //    c) the page's stylesheet.
  //
  //    The three are separate containers so that (b) and (c) survive any selection change.
  var selWhere = el('skw-sel-where');
  var selEmpty = el('skw-sel-empty');
  var selBody = el('skw-sel-body');
  var selId = el('skw-sel-id');
  var selClasses = el('skw-sel-classes');
  var selAttrs = el('skw-sel-attrs');
  var selFields = el('skw-sel-fields');
  var stylesTarget = el('skw-styles-target');
  var computedChip = el('skw-computed-chip');
  var computedList = el('skw-computed-list');
  var computedEmpty = el('skw-computed-empty');
  var rulesList = el('skw-rules');
  var stylesBox = el('skw-styles');
  var styleNeed = el('skw-style-need');
  var styleGive = el('skw-style-give');
  var styleClass = el('skw-style-class');
  var current = null;

  /**
   * WHICH IDS ARE CONTENT AND WHICH ARE THE EDITOR'S.
   *
   * GrapesJS assigns an id to a component the moment it is selected, because the Style Manager
   * needs a selector name and a bare element has none (i465, ir4g, ijq4 — four random
   * characters). That id is bookkeeping, not content: left alone it lands in cms_page.body_html
   * on the next Save, and the operator's markup starts collecting random ids from clicks they
   * only meant as "show me this element". So every id that exists at load is recorded here, and
   * an id on a selected component that is not in this table was made by the editor — it is
   * removed, together with the empty rule the Style Manager created for it.
   *
   * A bare element is not styled through a fake selector: the rail asks for a real class
   * (#skw-style-class), which is what a stylesheet should be keyed on anyway.
   */
  function rememberIds() {
    var walk = function (component) {
      if (!component || component.cid === undefined) return;
      var id = component.getAttributes().id;
      if (id) authoredIds[component.cid] = id;
      component.components().forEach(walk);
    };
    walk(editor.getWrapper());
  }

  function authoredId(component) {
    return authoredIds[component.cid] || '';
  }

  /**
   * Remove the id the editor invented for this component, if it has one and the operator never
   * named it. Called before the card is drawn, after the Style Manager is pointed at the element
   * (pointing it is what creates the id), and once more before the document is serialised — the
   * last one is the guarantee, because the first two only keep the screen honest.
   */
  function dropInventedId(component) {
    if (!component || component.cid === undefined) return false;
    var attrs = component.getAttributes();
    if (!attrs.id || authoredId(component) !== '') return false;
    forgetRule('#' + attrs.id);
    component.removeAttributes('id');
    return true;
  }

  /** Every unauthored id in the document, dropped. Used by save, the one place it must hold. */
  function scrubInventedIds() {
    var walk = function (component) {
      if (!component || component.cid === undefined) return;
      dropInventedId(component);
      component.components().forEach(walk);
    };
    walk(editor.getWrapper());
  }

  function forgetRule(selector) {
    try {
      editor.CssComposer.getAll().forEach(function (rule) {
        var names = (rule.selectors || []).map(function (s) { return s.getFullName(); });
        var empty = Object.keys(rule.getStyle() || {}).length === 0;
        if (names.indexOf(selector) !== -1 && empty) rule.remove();
      });
    } catch (e) { /* nothing to undo */ }
  }

  /** The selector a CSS rule would use for this component: id, else first class, else its tag. */
  function selectorFor(component) {
    var classes = component.getClasses();
    if (classes.length > 0) return '.' + classes[0];
    var id = authoredId(component) || component.getAttributes().id;
    if (id) return '#' + id;
    var tag = String(component.get('tagName') || 'div').toLowerCase();
    return tag === '' ? 'div' : tag;
  }

  /**
   * WHAT THE BROWSER IS PAINTING.
   *
   * The Style Manager answers "what does the rule say"; this answers "what do I see". They
   * differ for exactly the elements that made the operator ask: an <em> inside the hero heading
   * takes its serif from the h1 and its colour from .s-hero h1 em, so a panel that shows only
   * a rule for the em looks like it has failed to load the styles. getComputedStyle is the
   * measurement; the list of matching rules underneath says where each part came from.
   */
  var COMPUTED_PROPS = [
    ['font-family', 'Font'],
    ['font-size', 'Size'],
    ['font-weight', 'Weight'],
    ['font-style', 'Style'],
    ['letter-spacing', 'Tracking'],
    ['line-height', 'Leading'],
    ['color', 'Colour'],
    ['background-color', 'Fill'],
  ];

  function shortFamily(value) {
    var first = String(value).split(',')[0].replace(/^"|"$/g, '').trim();
    return first === '' ? String(value) : first;
  }

  function rgbHex(value) {
    var m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/.exec(String(value));
    if (m === null) return null;
    var hex = '#' + [1, 2, 3].map(function (i) {
      var part = Number(m[i]).toString(16);
      return part.length === 1 ? '0' + part : part;
    }).join('');
    var alpha = m[4] === undefined ? 1 : Number(m[4]);
    return { hex: hex, alpha: alpha };
  }

  function renderComputed(component) {
    if (computedList === null) return;
    computedList.innerHTML = '';
    if (component === null) {
      computedList.hidden = true;
      if (computedEmpty !== null) computedEmpty.hidden = false;
      chip(computedChip, '—', true);
      return;
    }
    var node = component.getEl();
    var view = null;
    try { view = editor.Canvas.getDocument().defaultView; } catch (e) { view = null; }
    if (!node || view === null) return;
    var style = view.getComputedStyle(node);
    COMPUTED_PROPS.forEach(function (pair) {
      var value = style.getPropertyValue(pair[0]);
      if (value === '') return;
      var dt = document.createElement('dt');
      dt.textContent = pair[1];
      var dd = document.createElement('dd');
      if (pair[0] === 'color' || pair[0] === 'background-color') {
        var rgb = rgbHex(value);
        if (rgb !== null && rgb.alpha === 0) {
          dd.textContent = 'transparent';
        } else if (rgb !== null) {
          var dot = document.createElement('span');
          dot.className = 'skw-swatch';
          dot.style.background = rgb.hex;
          dd.appendChild(dot);
          dd.appendChild(document.createTextNode(rgb.hex + (rgb.alpha < 1 ? ' · ' + rgb.alpha : '')));
        } else {
          dd.textContent = value;
        }
      } else if (pair[0] === 'font-family') {
        dd.textContent = shortFamily(value);
        dd.title = value;
      } else {
        dd.textContent = value;
      }
      computedList.appendChild(dt);
      computedList.appendChild(dd);
    });
    computedList.hidden = false;
    if (computedEmpty !== null) computedEmpty.hidden = true;
    chip(computedChip, '<' + String(component.get('tagName') || 'div').toLowerCase() + '>', false);
  }

  /** Every stylesheet rule whose selector matches this element, media queries included. */
  function renderRules(component) {
    if (rulesList === null) return;
    rulesList.innerHTML = '';
    if (component === null) return;
    var node = component.getEl();
    var doc = null;
    try { doc = editor.Canvas.getDocument(); } catch (e) { doc = null; }
    if (!node || doc === null) return;
    var found = [];
    var seen = Object.create(null);
    var walkRules = function (list, media) {
      for (var i = 0; i < list.length; i += 1) {
        var rule = list[i];
        // 1 = style rule, 4 = media, 12 = supports
        if (rule.cssRules && (rule.type === 4 || rule.type === 12)) {
          var condition = rule.conditionText || '';
          if (rule.type === 4 && window.matchMedia && !window.matchMedia(condition).matches) continue;
          walkRules(rule.cssRules, media === '' ? condition : media);
          continue;
        }
        if (rule.type !== 1 || !rule.selectorText) continue;
        // A universal reset matches every element and says nothing about this one: a rule whose
        // selector starts with * and names no class, id or attribute is not about this element.
        if (/^\s*\*/.test(rule.selectorText) && !/[.#\[]/.test(rule.selectorText)) continue;
        var matches = false;
        try { matches = node.matches(rule.selectorText); } catch (e) { matches = false; }
        if (!matches) continue;
        var key = rule.selectorText + '|' + (media || '');
        if (seen[key]) continue;
        seen[key] = true;
        found.push({ selector: rule.selectorText, media: media || '', css: rule.style.cssText });
      }
    };
    var sheets = doc.styleSheets;
    for (var s = 0; s < sheets.length; s += 1) {
      var rules = null;
      try { rules = sheets[s].cssRules; } catch (e) { rules = null; }
      if (rules === null) continue;
      walkRules(rules, '');
    }
    found.slice(0, 12).forEach(function (entry) {
      var li = document.createElement('li');
      var code = document.createElement('code');
      code.textContent = entry.selector;
      li.appendChild(code);
      if (entry.media !== '') {
        var media = document.createElement('span');
        media.className = 'skw-media';
        media.textContent = '  @' + entry.media;
        li.appendChild(media);
      }
      var body = document.createElement('div');
      body.textContent = entry.css.length > 150 ? entry.css.slice(0, 150) + '…' : entry.css;
      li.appendChild(body);
      rulesList.appendChild(li);
    });
    if (found.length === 0) {
      var none = document.createElement('li');
      none.textContent = 'No stylesheet rule names this element; it inherits everything it shows.';
      rulesList.appendChild(none);
    }
  }

  function chip(node, text, empty) {
    if (!node) return;
    node.textContent = text;
    node.setAttribute('data-empty', empty ? '1' : '0');
  }

  /** One editable attribute row. Renaming is remove-then-add, because a DOM attribute is a name. */
  function attrRow(name, value) {
    var row = document.createElement('div');
    row.className = 'skw-attr';
    var nameIn = document.createElement('input');
    nameIn.className = 'skw-in';
    nameIn.value = name;
    nameIn.placeholder = 'name';
    nameIn.spellcheck = false;
    var valIn = document.createElement('input');
    valIn.className = 'skw-in';
    valIn.value = value;
    valIn.placeholder = 'value';
    valIn.spellcheck = false;
    var drop = document.createElement('button');
    drop.type = 'button';
    drop.className = 'skw-attr__drop';
    drop.textContent = '×';
    drop.title = 'Remove this attribute';
    drop.setAttribute('aria-label', 'Remove attribute ' + (name === '' ? '(new)' : name));
    row.appendChild(nameIn);
    row.appendChild(valIn);
    row.appendChild(drop);
    selAttrs.appendChild(row);

    nameIn.addEventListener('change', function () {
      if (current === null) return;
      var next = nameIn.value.trim();
      var previous = name;
      if (next === previous) return;
      if (previous !== '') current.removeAttributes(previous);
      if (next !== '') {
        var attrs = {};
        attrs[next] = valIn.value;
        current.addAttributes(attrs);
      }
      name = next;
      setState('Unsaved changes', true);
      chip(selWhere, '<' + String(current.get('tagName') || 'div').toLowerCase() + '>', false);
    });
    valIn.addEventListener('input', function () {
      if (current === null || name === '') return;
      var attrs = {};
      attrs[name] = valIn.value;
      current.addAttributes(attrs);
      setState('Unsaved changes', true);
    });
    drop.addEventListener('click', function () {
      if (current !== null && name !== '') current.removeAttributes(name);
      row.remove();
      setState('Unsaved changes', true);
      if (selAttrs !== null && selAttrs.children.length === 0) attrNone();
    });
    return row;
  }

  function attrNone() {
    if (selAttrs === null) return;
    var none = document.createElement('p');
    none.className = 'skw-attrs__none';
    none.id = 'skw-sel-attrs-none';
    none.textContent = 'No attributes beyond its class list.';
    selAttrs.appendChild(none);
  }

  /**
   * Everything the inspector shows for one component. It writes only into #skw-selection;
   * #skw-styles and #skw-css belong to other owners and are left alone.
   */
  function inspector(component) {
    current = component || null;
    var has = current !== null;
    if (selEmpty !== null) selEmpty.hidden = has;
    if (selBody !== null) selBody.hidden = !has;
    if (selAttrs !== null) selAttrs.innerHTML = '';
    if (selFields !== null) selFields.innerHTML = '';
    if (!has) {
      chip(selWhere, 'nothing selected', true);
      chip(stylesTarget, '—', true);
      if (stylesBox !== null) stylesBox.hidden = true;
      renderComputed(null);
      renderRules(null);
      updateScaffold();
      return;
    }
    var tag = String(current.get('tagName') || 'div').toLowerCase();
    var type = current.get('type');
    var item = boot.palette.filter(function (p) { return p.type === type; })[0];
    chip(selWhere, item ? '<' + tag + '> · ' + item.label : '<' + tag + '>', false);

    dropInventedId(current);
    var hook = current.getClasses().length > 0 || authoredId(current) !== '';
    chip(stylesTarget, hook ? selectorFor(current) : 'no hook yet', !hook);
    if (styleNeed !== null) styleNeed.hidden = hook;
    if (styleGive !== null) styleGive.hidden = hook;
    // With no hook there is no target, and the manager keeps drawing the last one's sectors.
    if (stylesBox !== null) stylesBox.hidden = !hook;
    if (styleClass !== null && hook === false && document.activeElement !== styleClass) {
      styleClass.value = tag;
    }

    var attrs = current.getAttributes();
    // id and class have their own fields; style belongs to the Style Manager below; the
    // data-gjs-* names are the editor's own bookkeeping and are not the operator's to edit.
    Object.keys(attrs).forEach(function (name) {
      if (name === 'id' || name === 'class' || name === 'style') return;
      if (name.indexOf('data-gjs-') === 0) return;
      attrRow(name, String(attrs[name]));
    });
    if (selAttrs !== null && selAttrs.children.length === 0) attrNone();
    if (selId !== null && document.activeElement !== selId) selId.value = attrs.id || '';
    if (selClasses !== null && document.activeElement !== selClasses) {
      selClasses.value = current.getClasses().join(' ');
    }

    if (item) {
      item.editable.forEach(function (field) {
        var wrap = document.createElement('div');
        wrap.className = 'field';
        var label = document.createElement('label');
        label.textContent = field.prop;
        wrap.appendChild(label);
        var inner = current.find('[data-prop="' + field.prop + '"]')[0] || current;
        if (field.type === 'asset') {
          var key = inner.getAttributes()['data-asset-key'] || '';
          var button = document.createElement('button');
          button.type = 'button';
          button.className = 'skw-railbtn';
          button.textContent = key || 'Choose an image';
          button.addEventListener('click', function () { pick(current, field, button); });
          wrap.appendChild(button);
        } else {
          var input = document.createElement('input');
          input.type = 'text';
          input.className = 'skw-in';
          input.value = inner.getEl().textContent || '';
          input.addEventListener('input', function () {
            inner.components(input.value);
            inner.set('content', input.value);
          });
          wrap.appendChild(input);
        }
        selFields.appendChild(wrap);
      });
    }
    // The Style Manager is pointed at a component only when it has a real hook. Pointing it at a
    // bare element is what makes GrapesJS invent the id we just removed, so a component with no
    // class and no id gets the "name a class" control instead — and the canvas selection is left
    // exactly as the click made it.
    try {
      // An empty array is "no target": the one-argument form with nothing in it is not the
      // same call, and it leaves the manager pointing at the selector it invented a moment ago.
      if (hook) editor.StyleManager.select(current);
      else editor.StyleManager.select([]);
    } catch (e) { /* no target */ }
    // Pointing the manager at an element is what makes it invent an id, so the drop happens on
    // both sides of that call — and the card is redrawn from the attributes as they now are.
    if (dropInventedId(current)) {
      if (selId !== null && document.activeElement !== selId) selId.value = '';
      if (selAttrs !== null) {
        selAttrs.innerHTML = '';
        var fresh = current.getAttributes();
        Object.keys(fresh).forEach(function (name) {
          if (name === 'id' || name === 'class' || name === 'style') return;
          if (name.indexOf('data-gjs-') === 0) return;
          attrRow(name, String(fresh[name]));
        });
        if (selAttrs.children.length === 0) attrNone();
      }
    }
    renderComputed(current);
    renderRules(current);
    updateScaffold();
  }

  editor.on('component:selected', inspector);
  editor.on('component:deselected', function () {
    // A target change inside the Style Manager emits this too; the canvas selection is what the
    // card describes, so it only clears when the canvas has really let go.
    if (editor.getSelected()) return;
    if (current !== null) inspector(null);
  });
  // The rail's own chip has to keep up with renames made in the canvas (a class added by the
  // Style Manager's selector field, an id typed into the canvas). Rows are not rebuilt here:
  // that would destroy the input the operator is typing into.
  editor.on('component:update:attributes', function (c) {
    if (c !== current || current === null) return;
    chip(stylesTarget, selectorFor(current), false);
  });
  editor.on('component:update:classes', function (c) {
    if (c !== current || current === null) return;
    renderRules(current);
    chip(stylesTarget, selectorFor(current), false);
    if (selClasses !== null && document.activeElement !== selClasses) {
      selClasses.value = current.getClasses().join(' ');
    }
  });

  // A property typed into the Style Manager changes what is painted; the measurement follows it.
  editor.on('component:update:style', function (c) {
    if (c !== current || current === null) return;
    renderComputed(current);
  });
  editor.on('component:styleUpdate', function (c) {
    if (c !== current || current === null) return;
    renderComputed(current);
  });

  if (selId !== null) {
    selId.addEventListener('input', function () {
      if (current === null) return;
      var next = selId.value.trim();
      if (next === '') {
        delete authoredIds[current.cid];
        current.removeAttributes('id');
      } else {
        // Typed by the operator: this one is content, and it survives the next selection.
        authoredIds[current.cid] = next;
        current.addAttributes({ id: next });
      }
      chip(stylesTarget, next === '' ? 'no hook yet' : selectorFor(current), next === '');
      setState('Unsaved changes', true);
    });
  }
  if (selClasses !== null) {
    selClasses.addEventListener('input', function () {
      if (current === null) return;
      var list = selClasses.value.split(/\s+/).filter(function (s) { return s !== ''; });
      current.setClass(list);
      chip(stylesTarget, selectorFor(current), false);
      setState('Unsaved changes', true);
    });
  }
  var attrAdd = el('skw-attr-add');
  if (attrAdd !== null) {
    attrAdd.addEventListener('click', function () {
      if (current === null) return;
      var none = document.getElementById('skw-sel-attrs-none');
      if (none) none.remove();
      var row = attrRow('', '');
      var first = row.querySelector('input');
      if (first) first.focus();
    });
  }

  // "Style it": a bare element becomes styleable by *having a class*, which is the selector a
  // stylesheet wants anyway. The name is prefilled with the tag so the common case (style every
  // paragraph, style this heading) is one keystroke away, and an existing class of that name is
  // reused rather than duplicated.
  var styleAdd = el('skw-style-add');
  function applyStyleHook() {
    if (current === null || styleClass === null) return;
    var name = styleClass.value.trim().replace(/^\./, '').replace(/\s+/g, '-');
    if (name === '') return;
    if (current.getClasses().indexOf(name) === -1) current.addClass(name);
    setState('Unsaved changes', true);
    inspector(current);
  }
  if (styleAdd !== null) styleAdd.addEventListener('click', applyStyleHook);
  if (styleClass !== null) {
    styleClass.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') { event.preventDefault(); applyStyleHook(); }
    });
  }

  // Every sector of the Style Manager is open from the start: a collapsed accordion of six
  // headings is what the operator saw before this, and it reads as an empty panel.
  function openSectors() {
    try {
      editor.StyleManager.getSectors().forEach(function (sector) { sector.set('open', true); });
    } catch (e) { /* the manager is not ready yet */ }
  }
  editor.on('load', openSectors);
  setTimeout(openSectors, 0);

  // 5. The media picker: post the document and the field, get the document back with
  //    data-asset-key set. The browser never composes a URL (D17).
  function pick(component, field, button) {
    fetch('/admin/t/' + encodeURIComponent(boot.tenant) + '/editor/media.json', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var key = window.prompt('Asset key', (data.assets[0] || {}).key || '');
        if (!key) return;
        return fetch('/admin/t/' + encodeURIComponent(boot.tenant) + '/editor/pick', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json', 'x-csrf-token': boot.csrf },
          body: JSON.stringify({ html: editor.getHtml(), type: component.get('type'), prop: field.prop, field: field.type, key: key }),
        });
      })
      .then(function (r) { return r && r.json(); })
      .then(function (out) {
        if (!out || !out.html) return;
        // The picker's answer is the client's document with one key changed: it takes the
        // same scan as a paste, because it is the same import (see applyDocument).
        if (!applyDocument(out.html)) return;
        button.textContent = out.key;
      });
  }

  // 6. Save. The server canonicalises, validates again and writes the row; the answer is
  //    the stored bytes, so the textarea below the canvas shows exactly what was kept.
  //    html is editor.getHtml() verbatim — the canvas's <body> document, which the save
  //    path unwraps (S4a F1) — and components is the inventory the canvas believes it
  //    holds, which the server checks against the locks it is about to store (F2b).
  function inventory() {
    var out = [];
    var walk = function (component) {
      var type = component.get('type');
      if (KNOWN_TYPES[type]) out.push(type);
      component.components().forEach(walk);
    };
    editor.getWrapper().components().forEach(walk);
    return out;
  }


  // S8s. THE PAGE'S OWN STYLESHEET.
  //
  // A page's CSS is a file the server serves (/_css/<sha>.css), linked after the site's theme.
  // Before this panel the editor had no field for it and save() sent editor.getCss() — the
  // Style Manager's generated rules — which meant the stored stylesheet was **replaced by an empty
  // string** the first time anyone pressed Save. The panel is now the source of truth; what the
  // Style Manager generates is appended under one marker, so it survives a round trip and does not
  // accumulate a second copy on every save.
  var cssBox = document.getElementById('skw-css-text');
  var cssPanel = document.getElementById('skw-css');
  var cssToggle = document.getElementById('skw-css-toggle');
  var GEN_MARK = '/* skw:style-manager */';

  function stripGenerated(css) {
    var at = css.indexOf(GEN_MARK);
    return at === -1 ? css : css.slice(0, at).replace(/\s+$/, '');
  }

  function composeCss() {
    var hand = cssBox ? stripGenerated(cssBox.value) : '';
    // avoidProtected is the difference between "the rules the operator made" and "the editor's
    // own canvas reset". Without it every save appended * { box-sizing: border-box; } body
    // { margin: 0; } to the page's stylesheet — GrapesJS's baseline, which a site must not
    // inherit (it is a layout change nobody asked for, and it is not what the Style Manager shows).
    var gen = (editor.getCss({ avoidProtected: true }) || '').trim();
    if (gen === '') return hand;
    return (hand === '' ? '' : hand + '\n\n') + GEN_MARK + '\n' + gen;
  }

  // The page-CSS card lives in the rail, open by default (it is one of the three things the
  // rail is for), and the count next to its title is the number of opening braces at nesting depth 0 —
  // a rule count that survives comments and media queries well enough to answer "is there
  // anything in here?".
  var cssCount = el('skw-css-count');

  function ruleCount(css) {
    var depth = 0;
    var count = 0;
    for (var i = 0; i < css.length; i += 1) {
      var ch = css.charAt(i);
      if (ch === '{') {
        if (depth === 0) count += 1;
        depth += 1;
      } else if (ch === '}') {
        depth = Math.max(0, depth - 1);
      }
    }
    return count;
  }

  function refreshCssCount() {
    if (cssCount === null || cssBox === null) return;
    var n = ruleCount(stripGenerated(cssBox.value));
    cssCount.textContent = n === 1 ? '1 rule' : n + ' rules';
  }

  function setCssOpen(next) {
    if (cssPanel === null) return;
    cssPanel.setAttribute('data-open', next ? '1' : '0');
    if (cssToggle !== null) {
      cssToggle.setAttribute('aria-expanded', next ? 'true' : 'false');
      cssToggle.textContent = next ? 'Hide' : 'Show';
    }
    try { window.localStorage.setItem('skw-css-open', next ? '1' : '0'); } catch (e) { /* private mode */ }
  }

  if (cssBox) {
    cssBox.value = stripGenerated(boot.css || '');
    refreshCssCount();
    if (cssToggle) {
      var open = true;
      try { open = window.localStorage.getItem('skw-css-open') !== '0'; } catch (e) { /* private mode */ }
      setCssOpen(open);
      cssToggle.addEventListener('click', function () {
        setCssOpen(cssPanel.getAttribute('data-open') !== '1');
      });
      // The panel is part of the document: an edit here is a change, exactly as a drag is.
      cssBox.addEventListener('input', function () {
        setState('Unsaved changes', true);
        refreshCssCount();
        updateScaffold();
      });
    }
  }

  /**
   * "Add a rule for the selected element": the bridge between the selection card and this one.
   * It writes nothing to the server — it scaffolds a rule in the page's own stylesheet, puts
   * the caret inside the declaration block, and marks the document dirty. If a rule for that
   * selector already exists, the caret goes to it instead of appending a second one.
   */
  // Declared before its first *runtime* use below and after the input listeners that call it:
  // the function declaration hoists to the top of the boot closure, the variable does not.
  var scaffold = el('skw-css-scaffold');

  function updateScaffold() {
    if (scaffold === null) return;
    scaffold.disabled = readonly || current === null;
    scaffold.textContent = current === null
      ? 'Select an element to add a rule for it'
      : 'Add a rule for ' + selectorFor(current);
  }

  if (scaffold !== null) {
    scaffold.addEventListener('click', function () {
      if (current === null || cssBox === null) return;
      var sel = selectorFor(current);
      var text = cssBox.value;
      var at = text.indexOf(sel + ' {');
      if (at === -1) {
        at = text.replace(/\s+$/, '');
        cssBox.value = (at === '' ? '' : at + '\n\n') + sel + ' {\n  \n}';
        at = cssBox.value.length - 2;
      } else {
        at = at + sel.length + 3;
      }
      setCssOpen(true);
      cssBox.focus();
      cssBox.setSelectionRange(at, at);
      setState('Unsaved changes', true);
      refreshCssCount();
      updateScaffold();
    });
  }
  updateScaffold();

  /**
   * Save. The CSS travels as composeCss(): the panel's hand-written rules, then the Style
   * Manager's generated ones under a marker. It used to be editor.getCss(), which is the
   * generated rules only — so a page whose stylesheet was written by hand lost it on the first
   * Save. That is the defect this line fixes.
   */
  window.skwSave = function () {
    // Content, not bookkeeping: no id the editor invented reaches the stored page.
    scrubInventedIds();
    var body = {
      id: boot.page.id === null ? undefined : boot.page.id,
      path: boot.page.path,
      title: boot.page.title,
      template: boot.page.template,
      html: editor.getHtml(),
      css: composeCss(),
      components: inventory(),
    };
    return fetch('/admin/t/' + encodeURIComponent(boot.tenant) + '/editor/save', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-csrf-token': boot.csrf },
      body: JSON.stringify(body),
    }).then(function (r) {
      return r.json().then(function (answer) {
        if (answer && answer.ok === true) {
          // The draft's stylesheet is a file behind a session; the canvas links it. Its v= is
          // the hash of the bytes the server holds, so a new draft is a new URL — without this the
          // canvas would keep painting the rules it loaded when the page opened.
          boot.css = body.css;
          var link = editor.Canvas.getDocument().querySelector('link[data-skw-page-css]');
          if (link && boot.frame.pageCss) {
            link.setAttribute('href', boot.frame.pageCss.split('&v=')[0] + '&v=' + Date.now());
          }
          if (cssBox) cssBox.value = stripGenerated(body.css);
        }
        return answer;
      });
    });
  };

  /**
   * Publish is its own request, not a status field on save: the body being published is
   * whatever the server holds as the draft, so the page goes live exactly as it was last saved
   * — never as the canvas happens to look now. An unpublished tab cannot publish a half-typed
   * document by accident.
   */
  window.skwPublish = function () {
    return fetch('/admin/t/' + encodeURIComponent(boot.tenant) + '/editor/publish', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-csrf-token': boot.csrf },
      body: JSON.stringify({ id: boot.page.id }),
    }).then(function (r) { return r.json(); });
  };
})();
`;

/**
 * The served script. The pattern is injected as a JSON string literal — `JSON.stringify`
 * handles the quoting and the backslashes, so the browser builds the same `RegExp` the
 * server's `pastedTypes()` builds from the same constant.
 */
export const EDITOR_BOOT_JS = BOOT_SCRIPT.replace('__SKW_PASTE_TYPE_PATTERN__', JSON.stringify(DATA_GJS_TYPE_PATTERN));

/** The vendored GrapesJS bundle, read once. Served from the admin origin, never a CDN. */
let cachedGrapes: string | null = null;
export function grapesJsBundle(repoRoot: string): string {
  if (cachedGrapes === null) {
    cachedGrapes = readFileSync(join(repoRoot, 'node_modules', 'grapesjs', 'dist', 'grapes.min.js'), 'utf8');
  }
  return cachedGrapes;
}

let cachedCss: string | null = null;
export function grapesJsCss(repoRoot: string): string {
  if (cachedCss === null) {
    cachedCss = readFileSync(join(repoRoot, 'node_modules', 'grapesjs', 'dist', 'css', 'grapes.min.css'), 'utf8');
  }
  return cachedCss;
}
