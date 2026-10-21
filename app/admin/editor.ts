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
function listComponentFor(registry: Registry, source: string, limit: number): string {
  const entry = registry.entries.find((item) => item.type === 'list' && item.html !== null);
  if (entry === undefined || entry.html === null) {
    // The registry is a shipped file, not a runtime input; a missing `list` is a broken build,
    // and a marker that renders nothing is a better failure than a page with placeholder copy.
    return `<div data-unresolved-source="${source}"></div>`;
  }
  return entry.html
    .replace(/data-source="[^"]*"/, `data-source="${source}"`)
    .replace(/data-limit="[^"]*"/, `data-limit="${limit}"`);
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
  /** The page's own stylesheet, so the canvas is not unstyled. */
  bodyCss: string;
  /**
   * S8h: the blocks this tenant's **enabled** packages contribute. Each becomes a palette entry
   * that inserts a marker; the host draws the view at render time. A disabled package's blocks
   * are absent from this list, which is how the palette and the renderer stay in step.
   */
  blocks?: { id: string; label: string; plugin: string; limit: number }[];
}

/** `JSON.stringify` inside a `<script type="application/json">`: `<` must not close it. */
function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

export function editorBootPayload(input: EditorPageInput): {
  palette: PaletteItem[];
  categories: string[];
  types: { type: string; tagName: string; droppable: boolean }[];
  page: NonNullable<EditorPageInput['page']>;
  css: string;
  tenant: string;
  csrf: string;
} {
  // The host's components first, then one group for the packages: a package cannot add a
  // component (that would be plugin markup in the canvas), only a marker the host resolves.
  const items: PaletteItem[] = [
    ...palette(input.registry),
    ...(input.blocks ?? []).map((block) => ({
      id: `block-${block.id.replace(/\//g, '-')}`,
      label: block.label,
      category: 'Plugins',
      type: 'block',
      kind: 'block' as const,
      content: listComponentFor(input.registry, block.id, block.limit),
      // No settings panel: the block's view is the package's declaration, not a page decision.
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
<style>${payload.css}
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
#skw-layout{height:calc(100vh - 56px)}
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
        } else {
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
        } else {
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

  window.skwSave = function () {
    var body = {
      id: boot.page.id === null ? undefined : boot.page.id,
      path: boot.page.path,
      title: boot.page.title,
      template: boot.page.template,
      html: editor.getHtml(),
      css: editor.getCss() || '',
      components: inventory(),
    };
    return fetch('/admin/t/' + encodeURIComponent(boot.tenant) + '/editor/save', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-csrf-token': boot.csrf },
      body: JSON.stringify(body),
    }).then(function (r) { return r.json(); });
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
