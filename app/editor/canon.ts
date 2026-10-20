/**
 * `canon` — the one function the round-trip gate is written in terms of (SDS §10.3).
 *
 *     canon(load(save(load(page)))) == canon(load(page))
 *
 * What it does, in order, and why each step is there:
 *
 *  1. **Parse** with `html.ts` (a tree, not a regex).
 *  2. **Whitespace normalisation.** Runs of whitespace inside a text node become one
 *     space; a whitespace-only text node at the start or end of an element that has
 *     element children is dropped. That is the difference between hand-authored markup
 *     (newlines between blocks) and GrapesJS's output (none) — and it is *not* hidden by
 *     the gate, because the gate compares pass 2 against pass 1, both post-GrapesJS.
 *  3. **A fixed attribute order** (`attrRank`): `data-gjs-type`, `class`, `data-*`
 *     alphabetically, then the rest alphabetically.
 *  4. **Pretty-print with Prettier** (`parser: 'html'`, `htmlWhitespaceSensitivity:
 *     'ignore'`), which is what the SDS names and what makes the stored bytes the same
 *     on every machine that runs the save path. Prettier is idempotent, so `canon` is too:
 *     `canon(canon(x)) == canon(x)` is asserted in `test/editor-canon.test.ts` against
 *     every fixture, not assumed.
 *
 * `unwrapBody` exists because `editor.getHtml()` returns the canvas's `<body>` wrapper:
 * `cms_page.body_html` is a fragment, and storing the wrapper would make every page a
 * `<body>` inside the shell's `<body>`.
 */
import prettier from 'prettier';

import { type HtmlNode, element, elements, parseHtml, serialize, text } from './html.ts';

export interface CanonOptions {
  /** Prettier's print width. 100 keeps a component's root attributes on one line. */
  printWidth?: number;
}

function normalise(nodes: HtmlNode[]): HtmlNode[] {
  const out: HtmlNode[] = [];
  for (const node of nodes) {
    if (node.type === 'text') {
      const collapsed = node.text.replace(/[\t\n\r ]+/g, ' ');
      if (collapsed === '') continue;
      out.push(text(collapsed));
      continue;
    }
    if (node.type === 'comment') {
      // Kept: the write validator refuses comments, and a canon that deleted them would
      // make that refusal untestable.
      out.push(node);
      continue;
    }
    const children = normalise(node.children);
    const trimmed = children.filter((child, index) => {
      const whitespaceOnly = child.type === 'text' && child.text === ' ';
      if (!whitespaceOnly) return true;
      const hasElementSibling = children.some((c) => c.type === 'element');
      if (!hasElementSibling) return true;
      // Drop the padding at the edges, keep a single space between inline children.
      return index !== 0 && index !== children.length - 1;
    });
    out.push(element(node.tag, node.attrs, trimmed));
  }
  // Collapse runs of two text nodes produced by the trimming above.
  return out;
}

/**
 * Canonicalise a body fragment. Async because Prettier 3 is; every caller is either a
 * request handler or a test, and both can await. There is no synchronous twin on purpose
 * — two implementations of a gate are two gates, and one of them is wrong.
 */
export async function canon(html: string, options: CanonOptions = {}): Promise<string> {
  const normalised = serialize(normalise(parseHtml(html)));
  const formatted = await prettier.format(normalised, {
    parser: 'html',
    printWidth: options.printWidth ?? 100,
    htmlWhitespaceSensitivity: 'ignore',
    // No trailing newline: `body_sha` covers bytes, and a newline is a byte.
  });
  return formatted.replace(/\s+$/, '');
}

/** Every element carrying a `data-gjs-type`, in document order, with its type. */
export function componentNodes(html: string): { tag: string; type: string }[] {
  return elements(parseHtml(html))
    .filter((el) => el.attrs.some(([k]) => k === 'data-gjs-type'))
    .map((el) => ({
      tag: el.tag,
      type: el.attrs.find(([k]) => k === 'data-gjs-type')?.[1] ?? '',
    }));
}

/**
 * Strip the canvas wrapper. `editor.getHtml()` answers `<body>…</body>`; a fragment is
 * what `cms_page.body_html` stores. Anything else is returned unchanged so a body that
 * legitimately starts with a `<section>` is not misread.
 */
export function unwrapBody(html: string): string {
  const trimmed = html.trim();
  if (!/^<body(\s|>)/i.test(trimmed)) return trimmed;
  const tree = parseHtml(trimmed);
  const bodies = tree.filter((n) => n.type === 'element' && n.tag === 'body');
  if (bodies.length !== 1) return trimmed;
  const body = bodies[0];
  if (body === undefined || body.type !== 'element') return trimmed;
  return serialize(body.children);
}
