/**
 * The stored shape: an editor document -> `cms_page` (+ a list component's item rows).
 *
 * Three gates live here, and each one exists because the alternative is a silent loss:
 *
 *  1. **An unregistered `data-gjs-type` is refused, with a code.** GrapesJS does not
 *     refuse it: it *strips* the attribute and degrades the block to an editable div
 *     (176 B -> 110 B, measured R2 Runtime M1/M2). By the time the editor has saved, the
 *     evidence is gone. So the check runs on the **input HTML, before GrapesJS sees it**
 *     (`assertRegistered`, called by the editor's load path and again by the save path),
 *     and the code is `SKW_E_RT_COMPONENT_UNKNOWN` with the type and the node in `detail`.
 *  2. **Nesting is the registry's rule, not the editor's.** `allowed_children` is read
 *     from the entry; a registered component inside a parent that does not allow it is
 *     `SKW_E_RT_COMPONENT_NESTING`.
 *  3. **A URL where a key belongs is refused at save**, because D17 says content names
 *     the asset and the render derives the URL. The editor's canvas needs a `src` to
 *     paint, so `src`/`srcset`/`href` on an element that already carries
 *     `data-asset-key` is *dropped* — it is a preview artefact, and the key is the
 *     content. An `<img src="/media/…">` with **no** key is refused: that is a body that
 *     has frozen a URL, the exact defect D17 exists to prevent.
 *
 * The `list` component is a first-class row model: its single `[data-repeat]` child is the
 * row template, and each row is persisted as a discrete element stamped
 * `data-item-position="n"` in document order, so a reload cannot reorder them. (A
 * dedicated `cms_list_item` table is a site-schema v4 change — amendment, kysely, export
 * projection — and is named as the open decision in the S4a report; this module stores the
 * rows inside the document, where the editor's model already has them.)
 */
import { createHash } from 'node:crypto';

import { AppError } from '../errors.ts';
import { attr, type ElementNode, type HtmlNode, elements, parseHtml, serialize, setAttr } from './html.ts';
import { BUILT_IN_TYPES, isBuiltInType, isKnownType } from './builtin.ts';
import type { Registry, RegistryEntry } from './registry.ts';

/** §10.5: the four classes the DB CHECK also refuses, plus the two it cannot express. */
const FORBIDDEN: { name: string; test: RegExp }[] = [
  { name: '<script', test: /<script/i },
  { name: '<style', test: /<style/i },
  { name: '<!--', test: /<!--/ },
  { name: 'javascript:', test: /javascript:/i },
  { name: 'srcdoc', test: /srcdoc/i },
  // SQLite has no regex and a LIKE list of 70 handler names is not a control (§10.5).
  { name: 'on<name>=', test: /\son[a-z]+\s*=/i },
];

export interface ListItem {
  /** 0-based; equals the element's `data-item-position`. */
  position: number;
  html: string;
}

export interface ComponentInstance {
  type: string;
  entry: RegistryEntry;
  node: ElementNode;
  /** Present only for `kind='list'`: the repeat rows, in order. */
  items?: ListItem[];
}

export interface AnalysedBody {
  html: string;
  components: ComponentInstance[];
}

/** The four forbidden classes the database also checks, plus the two it cannot. */
export function assertBodyAllowed(html: string): void {
  for (const rule of FORBIDDEN) {
    if (rule.test.test(html)) {
      throw new AppError('SKW_E_RT_BODY_FORBIDDEN', `a page body may not contain ${rule.name}`, {
        rule: rule.name,
      });
    }
  }
}

/**
 * Every `data-gjs-type` in the input must name something this build can render — one of our
 * components, or one of GrapesJS's built-ins (a plain `<h1>` is `text` to GrapesJS, and that
 * is legitimate content, not a broken claim). Called on the **input** of the editor, before
 * GrapesJS normalises it — that is the whole point: after load there is nothing left to check.
 */
export function assertRegistered(html: string, registry: Registry): void {
  for (const el of elements(parseHtml(html))) {
    const declared = attr(el, 'data-gjs-type');
    if (declared === undefined) continue;
    if (declared === '') {
      throw new AppError('SKW_E_RT_COMPONENT_UNKNOWN', 'an element declares an empty data-gjs-type', {
        tag: el.tag,
        type: '',
      });
    }
    if (!isKnownType(declared, registry.byType)) {
      throw new AppError('SKW_E_RT_COMPONENT_UNKNOWN', `no component is registered for data-gjs-type="${declared}"`, {
        tag: el.tag,
        type: declared,
        known: [...registry.byType.keys(), ...BUILT_IN_TYPES],
      });
    }
  }
}

/**
 * Nesting: a registered component may only sit inside a registered parent that names it.
 * The document root always allows a component — that is what a page is.
 */
export function assertNesting(nodes: HtmlNode[], registry: Registry, inside: RegistryEntry | null): void {
  for (const node of nodes) {
    if (node.type !== 'element') continue;
    const declared = attr(node, 'data-gjs-type');
    if (declared !== undefined && isBuiltInType(declared)) {
      // A plain element: it constrains nothing about its children, exactly like an
      // unregistered wrapper below.
      assertNesting(node.children, registry, inside);
      continue;
    }
    if (declared !== undefined) {
      const entry = registry.byType.get(declared);
      if (entry === undefined) {
        // assertRegistered names it first; reaching here means a caller skipped it.
        throw new AppError('SKW_E_RT_COMPONENT_UNKNOWN', `no component is registered for data-gjs-type="${declared}"`, {
          tag: node.tag,
          type: declared,
        });
      }
      if (inside !== null && !inside.allowedChildren.includes(entry.name)) {
        throw new AppError('SKW_E_RT_COMPONENT_NESTING', `${entry.name} is not allowed inside ${inside.name}`, {
          parent: inside.name,
          child: entry.name,
          allowed: inside.allowedChildren,
        });
      }
      assertNesting(node.children, registry, entry);
      continue;
    }
    // An unregistered wrapper is transparent: GrapesJS keeps it as a div, and a block
    // nested two divs deep is not a content defect.
    assertNesting(node.children, registry, inside);
  }
}

const URL_LIKE = /^(?:[a-z][a-z0-9+.-]*:|\/|#|\.)/i;

/**
 * D17: the body names the key. On any element that carries `data-asset-key`, `src`,
 * `srcset` and `href` are canvas artefacts and are removed; an `<img>` that carries a URL
 * and no key is refused.
 */
export function assertAssetKeys(nodes: HtmlNode[]): void {
  for (const el of elements(nodes)) {
    const key = attr(el, 'data-asset-key');
    if (key !== undefined) {
      if (key === '' || key.includes('..') || !/^[a-z0-9][a-z0-9/_.-]*$/.test(key)) {
        throw new AppError('SKW_E_RT_BODY_FORBIDDEN', `data-asset-key is not a key: ${JSON.stringify(key)}`, {
          tag: el.tag,
          key,
          rule: 'asset-key-shape',
        });
      }
      for (const name of ['src', 'srcset', 'href']) el.attrs = el.attrs.filter(([k]) => k !== name);
      continue;
    }
    const src = attr(el, 'src');
    if (src !== undefined && URL_LIKE.test(src)) {
      throw new AppError('SKW_E_RT_BODY_FORBIDDEN', 'an element carries a URL and no data-asset-key (D17)', {
        tag: el.tag,
        attribute: 'src',
        rule: 'asset-url-in-body',
      });
    }
  }
}

/**
 * The `list` component's rows: the children of the list that carry `data-repeat`. Order is
 * document order, and `data-item-position` is stamped so the order is *recorded*, not just
 * implied by an array index that a save could permute.
 */
export function listItems(node: ElementNode, entry: RegistryEntry): ListItem[] {
  const marker = (entry.repeatChild ?? '[data-repeat]').replace(/^\[|\]$/g, '');
  const rows = node.children.filter(
    (child): child is ElementNode => child.type === 'element' && child.attrs.some(([k]) => k === marker),
  );
  // §16 S4 row 2 / C-4: the loop contract is **exactly one** repeat child. One child is the
  // template the renderer clones once per bound row; two are two templates, which has no
  // meaning and used to be stored as two "items" (the S4 QA reproduced it through
  // `savePage()`). Refused here rather than in `savePage()` because this is the one reader
  // every path — save, load, render and reload — shares; a rule the load path skips is a
  // rule a hand-edited row can bypass. Zero children is legal: a list with no template
  // renders its `[data-empty]` child.
  if (rows.length > 1) {
    throw new AppError(
      'SKW_E_RT_REPEAT_INVALID',
      `a ${entry.name} has ${rows.length} ${entry.repeatChild ?? '[data-repeat]'} children; exactly one repeat template is allowed`,
      {
        rule: 'repeat-children',
        component: entry.name,
        marker: entry.repeatChild ?? '[data-repeat]',
        count: rows.length,
      },
    );
  }
  return rows.map((row, position) => {
    setAttr(row, 'data-item-position', String(position));
    return { position, html: serialize([row]) };
  });
}

export interface AnalyseOptions {
  /** `body_html` as the editor or a hand author wrote it. */
  html: string;
  registry: Registry;
}

/**
 * The one entry point: validate the input, then hand back the components the save path
 * needs. It does **not** canonicalise — that is `canon()`, and the caller runs it on the
 * output so the stored bytes and the gate's bytes are the same function.
 */
export function analyseBody({ html, registry }: AnalyseOptions): AnalysedBody {
  assertBodyAllowed(html);
  assertRegistered(html, registry);
  const tree = parseHtml(html);
  assertNesting(tree, registry, null);
  assertAssetKeys(tree);

  const components: ComponentInstance[] = [];
  for (const node of elements(tree)) {
    const declared = attr(node, 'data-gjs-type');
    if (declared === undefined) continue;
    const entry = registry.byType.get(declared);
    if (entry === undefined) continue;
    const instance: ComponentInstance = { type: declared, entry, node };
    if (entry.kind === 'list') instance.items = listItems(node, entry);
    components.push(instance);
  }
  return { html: serialize(tree), components };
}

/** `body_sha` covers the canonical bytes (§4.2), not the input. */
export function bodySha(canonicalHtml: string): string {
  return createHash('sha256').update(canonicalHtml, 'utf8').digest('hex');
}

/**
 * A list component's rows, read back from a stored body. Used by the reload half of the
 * acceptance test and by the renderer: the order is `data-item-position`, which the save
 * path stamped.
 */
export function reloadListItems(bodyHtml: string, registry: Registry, type = 'list'): ListItem[] {
  const entry = registry.byType.get(type);
  if (entry === undefined) throw new AppError('SKW_E_RT_COMPONENT_UNKNOWN', `no component "${type}"`, { type });
  const node = elements(parseHtml(bodyHtml)).find((el) => attr(el, 'data-gjs-type') === type);
  if (node === undefined) return [];
  return listItems(node, entry);
}

/** Every asset key the body names, in document order, de-duplicated. */
export function assetKeysIn(bodyHtml: string): string[] {
  const out: string[] = [];
  for (const el of elements(parseHtml(bodyHtml))) {
    const key = attr(el, 'data-asset-key');
    if (key !== undefined && !out.includes(key)) out.push(key);
  }
  return out;
}
