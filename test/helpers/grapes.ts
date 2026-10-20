/**
 * Real GrapesJS, headless, over jsdom — the only way the round-trip gate means anything.
 *
 * The gate this exists for (§10.3 / §13 D21) is
 *
 *     stored(load(stored(load(page)))) == stored(load(page))
 *
 * and every word of that sentence is a GrapesJS behaviour: `load` normalises (8 of 9
 * hand-authored fixtures differ from the input at pass 1), `save` re-serialises from the
 * model, and a component whose model omits `data-gjs-type` in its defaults loses the lock
 * even though it is registered (measured 110 B vs 135 B). A stub editor would agree with
 * whatever we asserted.
 *
 * **What `document()` is, and why it is raw.** It is `editor.getHtml()` byte for byte —
 * the canvas's `<body>…</body>` wrapper included — plus `getCss()` and the component
 * inventory the model believes it holds. That is exactly what `window.skwSave` posts
 * (`app/admin/editor.ts`). This helper used to strip the wrapper with `unwrapBody()`
 * before returning, which is how S4a F1 hid: the product stored a wrapped document while
 * the gate measured an unwrapped one. A helper that pre-processes the document is a
 * second implementation of the save path, and the first one is the only one that ships.
 *
 * One jsdom per process: GrapesJS reaches for `document` at module scope, so the globals
 * have to be installed before the dynamic `import()`, and only once.
 */
import { JSDOM } from 'jsdom';

import type { Registry } from '../../app/editor/registry.ts';
import { typeDefinitions } from '../../app/editor/registry.ts';

interface GjsComponent {
  get(name: string): unknown;
  components(): { forEach(cb: (child: GjsComponent) => void): void };
}

interface GjsEditor {
  Components: { addType(name: string, def: unknown): void };
  setComponents(html: string): void;
  getHtml(): string;
  getCss(): string;
  getWrapper(): GjsComponent;
  destroy(): void;
}

let installed = false;

function installDom(): void {
  if (installed) return;
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
  const w = dom.window as unknown as Record<string, unknown>;
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = dom.window;
  g.document = dom.window.document;
  // `navigator` is a getter on Node 22's globalThis: assignment throws, defineProperty does not.
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
  for (const name of ['HTMLElement', 'Element', 'Node', 'DOMParser', 'XMLSerializer', 'CustomEvent', 'Event', 'MutationObserver']) {
    if (w[name] !== undefined) g[name] = w[name];
  }
  g.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  installed = true;
}

/**
 * What the canvas would post: the document, its CSS, and the inventory of registered
 * component types the model holds (F2's belt and braces — the server compares it with
 * the locks in the bytes it is about to store).
 */
export interface CanvasDocument {
  html: string;
  css: string;
  components: string[];
}

export interface EditorSession {
  /** `setComponents`, i.e. the editor's load. */
  load(html: string): void;
  /** `getHtml()` / `getCss()` / the model's inventory, unmodified. */
  document(): CanvasDocument;
  destroy(): void;
}

export interface EditorOptions {
  /**
   * The type definitions to register. Defaults to the registry's. The round-trip gate's
   * negative control passes a *mutated* list (one whose `model.defaults` drops the lock),
   * because a gate that cannot be made to fail is a gate that measures nothing.
   */
  types?: { type: string; isComponent: (el: unknown) => boolean; model: unknown }[];
}

/**
 * An editor with the registry's types registered — nothing else. `addType` is what makes
 * a `data-gjs-type` survive a save; the definitions come from the registry, so a component
 * added as data is draggable and round-trippable with no code change.
 */
export async function openEditor(registry: Registry, options: EditorOptions = {}): Promise<EditorSession> {
  installDom();
  // The package's `init` is on the default export; its `.d.ts` exports the type but not the
  // factory shape under `NodeNext`, so the module is cast once, here, and nowhere else.
  const grapesjs = (await import('grapesjs')).default as unknown as {
    init(options: Record<string, unknown>): unknown;
  };
  const host = (globalThis as unknown as { document: Document }).document.createElement('div');
  (globalThis as unknown as { document: Document }).document.body.appendChild(host);
  const editor = grapesjs.init({
    headless: true,
    container: host,
    storageManager: false,
    // No canvas iframe: headless mode parses into the model without painting, which is
    // exactly the half of the editor the gate is about.
  }) as unknown as GjsEditor;

  const defs = options.types ?? typeDefinitions(registry);
  for (const def of defs) {
    editor.Components.addType(def.type, { isComponent: def.isComponent, model: def.model });
  }
  const known = new Set(defs.map((def) => def.type));

  const session: EditorSession = {
    load(html: string): void {
      editor.setComponents(html);
    },
    document(): CanvasDocument {
      const inventory: string[] = [];
      const walk = (component: GjsComponent): void => {
        const type = component.get('type');
        if (typeof type === 'string' && known.has(type)) inventory.push(type);
        component.components().forEach(walk);
      };
      editor.getWrapper().components().forEach(walk);
      return { html: editor.getHtml(), css: editor.getCss(), components: inventory };
    },
    destroy(): void {
      editor.destroy();
      host.remove();
    },
  };
  return session;
}

/** Load, save, load the output, save again — the two documents the canvas produces. */
export async function twoPasses(
  registry: Registry,
  html: string,
  options: EditorOptions = {},
): Promise<{ pass1: string; pass2: string }> {
  const editor = await openEditor(registry, options);
  try {
    editor.load(html);
    const pass1 = editor.document().html;
    editor.load(pass1);
    const pass2 = editor.document().html;
    return { pass1, pass2 };
  } finally {
    editor.destroy();
  }
}
