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
  } | null;
  registry: Registry;
  csrf: string;
  /** The page's own stylesheet, so the canvas is not unstyled. */
  bodyCss: string;
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
  const items = palette(input.registry);
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
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)} — editor</title>
<link rel="stylesheet" href="${base}/grapesjs.css">
<style>${payload.css}
body{margin:0;font:14px/1.4 system-ui,sans-serif}
#skw-layout{display:grid;grid-template-columns:240px 1fr 300px;height:100vh}
#skw-blocks,#skw-settings{overflow:auto;border-right:1px solid #ddd;padding:.5rem}
#skw-canvas{overflow:auto}
#skw-blocks h3{margin:.75rem 0 .25rem;font-size:.75rem;text-transform:uppercase;color:#666}
#skw-blocks button{display:block;width:100%;text-align:left;margin:.15rem 0;padding:.35rem .5rem;cursor:grab}
#skw-settings .field{margin:.5rem 0}
#skw-settings img{max-width:100%}
[data-skw-readonly="1"] #skw-canvas{opacity:.7}
</style></head>
<body data-skw-readonly="${readonly ? '1' : '0'}">
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

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * The boot script, as a constant rather than a file: `tsc` copies `.ts` to `dist/`, and a
 * `.js` beside it would be a file that exists in the repo and not in the image — the exact
 * class of defect E-28's dist gate exists to catch. It is served byte-for-byte.
 */
export const EDITOR_BOOT_JS = String.raw`
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
  });

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

  // 2. The palette, generated. One button per registry entry, grouped by category.
  var blocks = document.getElementById('skw-blocks');
  var byCategory = {};
  boot.palette.forEach(function (item) {
    (byCategory[item.category] = byCategory[item.category] || []).push(item);
    editor.Blocks.add(item.id, { label: item.label, category: item.category, content: item.content });
  });
  boot.categories.forEach(function (category) {
    var h = document.createElement('h3');
    h.textContent = category;
    blocks.appendChild(h);
    (byCategory[category] || []).forEach(function (item) {
      var button = document.createElement('button');
      button.type = 'button';
      button.textContent = item.label;
      button.dataset.type = item.type;
      button.draggable = !readonly;
      button.addEventListener('click', function () {
        if (readonly) return;
        var selected = editor.getSelected();
        var container = selected ? selected : editor.getWrapper();
        container.append(item.content)[0];
      });
      blocks.appendChild(button);
    });
  });

  // 3. The document. page.bodyHtml is what the server validated; a hand-managed page is
  //    read-only in the canvas (§10.6) because the next drag would re-serialise it.
  editor.setComponents(boot.page.bodyHtml || '');
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
        editor.setComponents(out.html);
        button.textContent = out.key;
      });
  }

  // 6. Save. The server canonicalises, validates again and writes the row; the answer is
  //    the stored bytes, so the textarea below the canvas shows exactly what was kept.
  window.skwSave = function () {
    var body = {
      id: boot.page.id === null ? undefined : boot.page.id,
      path: boot.page.path,
      title: boot.page.title,
      template: boot.page.template,
      html: editor.getHtml(),
      css: editor.getCss() || '',
    };
    return fetch('/admin/t/' + encodeURIComponent(boot.tenant) + '/editor/save', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-csrf-token': boot.csrf },
      body: JSON.stringify(body),
    }).then(function (r) { return r.json(); });
  };
})();
`;

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
