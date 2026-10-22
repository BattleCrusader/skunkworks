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
#skw-layout{display:grid;grid-template-columns:240px 1fr 300px;height:100vh}
#skw-blocks,#skw-settings{overflow:auto;border-right:1px solid #ddd;padding:.5rem}
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
#skw-layout{height:calc(100vh - 56px);display:grid;grid-template-columns:240px 1fr 300px;grid-template-rows:1fr auto}
/* S8s: the page's own stylesheet, editable where the page is edited. Collapsed it is one line
   with the count of rules; expanded it is a code pane that takes the bottom third. */
#skw-css{grid-column:1 / -1;border-top:1px solid #e3e3e8;background:#fff;display:flex;flex-direction:column;max-height:34vh}
#skw-css-head{display:flex;align-items:center;gap:.6rem;padding:.4rem .75rem;min-height:40px}
#skw-css-head h2{font-size:.8rem;font-weight:650;margin:0;color:#24242b;white-space:nowrap}
#skw-css-hint{font-size:.75rem;color:#6b6b76;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#skw-css-text{display:none;margin:0;border:0;border-top:1px solid #eee;padding:.6rem .75rem;font:12.5px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;tab-size:2;resize:vertical;min-height:120px;color:#1f2430;background:#fbfbfd;outline:none}
#skw-css[data-open="1"] #skw-css-text{display:block}
#skw-css[data-open="1"]{max-height:52vh}
#skw-css-text:focus-visible{box-shadow:inset 0 0 0 2px #2563eb}
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
  <aside id="skw-settings" aria-label="Settings"></aside>
  <section id="skw-css" aria-label="This page's CSS">
    <header id="skw-css-head">
      <h2>This page's CSS</h2>
      <span class="skw-css-hint">Served as its own file, on this page only, <em>after</em> the site's theme — so a rule here wins at equal specificity. Press Save to see it on the page; the canvas shows it when you reload.</span>
      <button type="button" class="skw-btn" id="skw-css-toggle" aria-expanded="false" aria-controls="skw-css-text">Show CSS</button>
    </header>
    <textarea id="skw-css-text" spellcheck="false" autocapitalize="off" autocomplete="off" placeholder=".s-hero h1 { font-size: 4.5rem }"${readonly ? ' readonly' : ''}></textarea>
  </section>
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
    // used to arrive inside a default panel whose buttons are Font Awesome glyphs. Mounting
    // it into our own right-hand column keeps the capability and drops the missing-icon
    // chrome in one move.
    styleManager: { appendTo: '#skw-settings' },
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

  function insertFrameNode(doc, html, before) {
    // The template is created in the *canvas* document: a node from the admin document inserted
    // into the frame is adopted by the browser, which is a silent cross-document step that has
    // bitten this codebase before (the export's DOM). One document, one node.
    var tpl = doc.createElement('template');
    tpl.innerHTML = html;
    var node = tpl.content && tpl.content.firstElementChild;
    if (!node) return null;
    node.setAttribute('data-skw-frame', '1');
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
      if (!header) header = insertFrameNode(doc, boot.frame.header, el);
    } else if (header) {
      header.remove();
    }
    var footer = doc.querySelector('[data-skw-frame="footer"]');
    if (boot.frame.footer) {
      if (!footer) insertFrameNode(doc, boot.frame.footer, el.nextSibling);
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
  if (readonly) {
    editor.Canvas.getBody().setAttribute('contenteditable', 'false');
    editor.on('component:selected', function (c) { editor.selectRemove(c); });
  }

  // 4. The settings panel: the fields the registry entry declares, and nothing else.
  function settings(component) {
    var panel = document.getElementById('skw-settings');
    panel.innerHTML = '';
    if (!component) return;
    var type = component.get('type');
    var item = boot.palette.filter(function (p) { return p.type === type; })[0];
    if (!item) return;
    var title = document.createElement('h3');
    title.textContent = item.label;
    panel.appendChild(title);
    item.editable.forEach(function (field) {
      var wrap = document.createElement('div');
      wrap.className = 'field';
      var label = document.createElement('label');
      label.textContent = field.prop;
      wrap.appendChild(label);
      var inner = component.find('[data-prop="' + field.prop + '"]')[0] || component;
      if (field.type === 'asset') {
        var key = inner.getAttributes()['data-asset-key'] || '';
        var button = document.createElement('button');
        button.type = 'button';
        button.textContent = key || 'Choose an image';
        button.addEventListener('click', function () { pick(component, field, button); });
        wrap.appendChild(button);
      } else {
        var input = document.createElement('input');
        input.type = 'text';
        input.value = inner.getEl().textContent || '';
        input.addEventListener('input', function () {
          inner.components(input.value);
          inner.set('content', input.value);
        });
        wrap.appendChild(input);
      }
      panel.appendChild(wrap);
    });
  }
  editor.on('component:selected', settings);

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

  if (cssBox) {
    cssBox.value = stripGenerated(boot.css || '');
    if (cssToggle) {
      var open = false;
      try { open = window.localStorage.getItem('skw-css-open') === '1'; } catch (e) { /* private mode */ }
      var setOpen = function (next) {
        open = next;
        cssPanel.setAttribute('data-open', next ? '1' : '0');
        cssToggle.setAttribute('aria-expanded', next ? 'true' : 'false');
        cssToggle.textContent = next ? 'Hide CSS' : 'Show CSS';
        try { window.localStorage.setItem('skw-css-open', next ? '1' : '0'); } catch (e) { /* private mode */ }
      };
      setOpen(open);
      cssToggle.addEventListener('click', function () { setOpen(!open); });
      // The panel is part of the document: an edit here is a change, exactly as a drag is.
      cssBox.addEventListener('input', function () { setState('Unsaved changes', true); });
    }
  }

  /**
   * Save. The CSS travels as composeCss(): the panel's hand-written rules, then the Style
   * Manager's generated ones under a marker. It used to be editor.getCss(), which is the
   * generated rules only — so a page whose stylesheet was written by hand lost it on the first
   * Save. That is the defect this line fixes.
   */
  window.skwSave = function () {
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
