/**
 * **The one projection of a stored body** — the bytes the site renders and the bytes
 * every exporter ships (§10.3, §11.2, D22).
 *
 * `cms_page.body_html` is a **fragment** (S4a-fix §3.1). Two shapes exist in the table
 * S4b inherits:
 *
 *   - rows written by `436d913` and earlier begin with the canvas's `<body>…</body>`
 *     document, because nothing unwrapped them before storing;
 *   - rows written after the fix begin with the page's first component tag.
 *
 * The load path deliberately opens a wrapped row (it is a transparent wrapper there),
 * so an exporter may not assume the column is uniform. This function is the single
 * place that normalises it, and it calls `canon.ts`'s `unwrapBody` — there is no second
 * implementation of "strip the canvas wrapper", because a second one is a second gate
 * and one of them is wrong (S4a F1).
 *
 * It also owns the D17 step: the stored bytes name **keys**, and `renderBody()` turns
 * every `data-asset-key` into the URL the row implies. Before S4b the serve path never
 * called it, so a live page shipped `<img data-asset-key="work/one">` with no `src`.
 * The site and the three exporters now call this function, which is what makes the
 * export's page bytes the site's page bytes by construction rather than by review.
 *
 * A body that is still a document after `unwrapBody` (an `<html><body>` root, two
 * bodies, a nested one) is refused with `SKW_E_RT_BODY_FORBIDDEN` and a `rule` that
 * names which rule. Storing it would put a second `<body>` inside the shell's `<main>`
 * — the shape the save path already refuses.
 */
import type Database from 'better-sqlite3';

import { unwrapBody } from '../editor/canon.ts';
import { attr, parseHtml, serialize, type HtmlNode, type ElementNode } from '../editor/html.ts';
import { renderBody, type RenderOptions } from '../editor/render.ts';
import { AppError } from '../errors.ts';
import { bindCoreForms } from './components/form.ts';

/**
 * The attribute the editor puts on an element the operator hid, and the marker this module
 * removes at the last moment — before the bytes reach a visitor or an export.
 *
 * Why remove rather than `display:none`: an element that is still in the document still has
 * bytes, still appears in a text dump, still costs a reader their scroll position, and would need
 * every theme (and the exported tree, which carries no site sheet at all) to agree about a rule.
 * Dropping the subtree means the page closes up the way the operator saw it close up, in the site
 * and in a bundle, by construction. The stored body keeps the element — that is what makes it
 * possible to bring it back without retyping it.
 */
export const HIDDEN_ATTR = 'data-skw-hidden';

/** True when any element under `nodes` is marked hidden. */
function anyHidden(nodes: readonly HtmlNode[]): boolean {
  return nodes.some((node) =>
    node.type === 'element' ? attr(node, HIDDEN_ATTR) !== undefined || anyHidden(node.children) : false,
  );
}

/** Every hidden subtree gone, everything else serialised as it arrived. */
function withoutHidden(nodes: readonly HtmlNode[]): HtmlNode[] {
  const out: HtmlNode[] = [];
  for (const node of nodes) {
    if (node.type !== 'element') {
      out.push(node);
      continue;
    }
    if (attr(node, HIDDEN_ATTR) !== undefined) continue;
    out.push({ ...node, children: withoutHidden((node as ElementNode).children) });
  }
  return out;
}

/**
 * Hide what the editor hid, and only when something actually is: a body with no marked element
 * keeps the bytes it was stored with, so this step cannot reflow or re-quote an untouched page.
 */
export function applyHidden(html: string): string {
  if (!html.includes(HIDDEN_ATTR)) return html;
  const nodes = parseHtml(html);
  return anyHidden(nodes) ? serialize(withoutHidden(nodes)) : html;
}

/** `/<body` anywhere after the unwrap — a document the shell cannot hold. */
const BODY_DOCUMENT = /<body[\s>]/i;

/**
 * A stored body → the fragment the shell interpolates into `<main>`.
 *
 * Throws `SKW_E_RT_BODY_FORBIDDEN` with `detail.rule = 'body-document'` for a legacy
 * row that cannot be normalised, and whatever `renderBody` raises for a body naming an
 * asset with no row (the export turns that into `SKW_E_EXP_ASSET_UNRESOLVED` naming the
 * key and the page; the site keeps the render code, because a page that cannot render
 * is a render failure there).
 */
export function renderStoredBody(db: Database.Database, storedHtml: string, options: RenderOptions = {}): string {
  // `trim()` after the unwrap, and it is not cosmetic: `unwrapBody()` returns the body's
  // children *serialised*, so a wrapped row comes back with the wrapper's own indentation
  // (`\n  …\n`) attached. A post-fix row has no such padding, and the exported `<main>`
  // must not depend on which era wrote the row.
  const document = unwrapBody(storedHtml).trim();
  if (BODY_DOCUMENT.test(document)) {
    throw new AppError('SKW_E_RT_BODY_FORBIDDEN', 'a stored body is a document, not a fragment', {
      rule: 'body-document',
      bytes: document.length,
    });
  }
  if (document === '') return '';
  // The second projection: a `form` block becomes a form that the intake will accept (§8.6 O-30).
  // It runs here, in the one function the site and all three exporters share, so a page cannot
  // render a submittable form on the site and a token-less one in a bundle — or the reverse.
  return applyHidden(bindCoreForms(renderBody(db, document, options), db, options.forms));
}
