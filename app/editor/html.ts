/**
 * A small, strict HTML tree — the parser the save path, the validator, the renderer and
 * the canon step share (SDS §10.3).
 *
 * Why not `jsdom`: the save path runs inside a request on a tenant box and must not need
 * a browser; the *gate* uses jsdom, but only to drive GrapesJS. Why not a regex: the
 * things this module has to decide — "is the root of this block the registered type",
 * "does an `<img>` carry a URL where a key belongs", "is this child allowed inside that
 * parent" — are tree questions, and a regex over HTML is how a `<p>` inside a comment
 * becomes a component.
 *
 * The parser is deliberately *tolerant* of unknown tags and *intolerant* of nothing: it
 * does not sanitise. Sanitising is `app/editor/validate.ts`'s job, and it can only do it
 * if the tree still contains what was written.
 */

export type Attr = [name: string, value: string];

export interface ElementNode {
  type: 'element';
  tag: string;
  attrs: Attr[];
  children: HtmlNode[];
}

export interface TextNode {
  type: 'text';
  text: string;
}

export interface CommentNode {
  type: 'comment';
  text: string;
}

export type HtmlNode = ElementNode | TextNode | CommentNode;

/** §10.5: the five things a body may not contain, and the tags that carry them. */
export const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

const RAW_TAGS = new Set(['script', 'style', 'textarea', 'title']);

export function element(tag: string, attrs: Attr[] = [], children: HtmlNode[] = []): ElementNode {
  return { type: 'element', tag: tag.toLowerCase(), attrs, children };
}

export function text(value: string): TextNode {
  return { type: 'text', text: value };
}

export function attr(node: ElementNode, name: string): string | undefined {
  const found = node.attrs.find(([k]) => k === name);
  return found === undefined ? undefined : found[1];
}

export function setAttr(node: ElementNode, name: string, value: string): void {
  const found = node.attrs.find(([k]) => k === name);
  if (found === undefined) node.attrs.push([name, value]);
  else found[1] = value;
}

export function removeAttr(node: ElementNode, name: string): void {
  node.attrs = node.attrs.filter(([k]) => k !== name);
}

/** Every element in document order. */
export function elements(nodes: HtmlNode[]): ElementNode[] {
  const out: ElementNode[] = [];
  const visit = (list: HtmlNode[]): void => {
    for (const node of list) {
      if (node.type === 'element') {
        out.push(node);
        visit(node.children);
      }
    }
  };
  visit(nodes);
  return out;
}

/** Every text node whose parent is `parent`, in order. */
export function textOf(parent: ElementNode): string {
  return parent.children
    .filter((n): n is TextNode => n.type === 'text')
    .map((n) => n.text)
    .join('');
}

export function decodeEntities(raw: string): string {
  return raw
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, '\u00a0')
    // `&amp;` last: decoding it first would turn `&amp;lt;` into `<`.
    .replace(/&amp;/g, '&');
}

export function escapeText(raw: string): string {
  return raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function escapeAttr(raw: string): string {
  return raw.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

interface Open {
  tag: string;
  attrs: Attr[];
  children: HtmlNode[];
}

/**
 * Parse a fragment. Unclosed tags are closed at the end of input (HTML's own recovery
 * rule) rather than thrown on: the validator has to *report* a malformed body, and it
 * cannot do that from an exception that has lost the position.
 */
export function parseHtml(input: string): HtmlNode[] {
  const root: HtmlNode[] = [];
  const stack: Open[] = [];
  let i = 0;
  const top = (): HtmlNode[] => (stack.length === 0 ? root : (stack[stack.length - 1] as Open).children);

  while (i < input.length) {
    const lt = input.indexOf('<', i);
    if (lt === -1) {
      top().push(text(decodeEntities(input.slice(i))));
      break;
    }
    if (lt > i) top().push(text(decodeEntities(input.slice(i, lt))));

    if (input.startsWith('<!--', lt)) {
      const end = input.indexOf('-->', lt + 4);
      const stop = end === -1 ? input.length : end;
      top().push({ type: 'comment', text: input.slice(lt + 4, stop) });
      i = end === -1 ? input.length : end + 3;
      continue;
    }
    if (input.startsWith('<!', lt)) {
      // doctype / CDATA: not part of a page body, and not something to preserve.
      const end = input.indexOf('>', lt);
      i = end === -1 ? input.length : end + 1;
      continue;
    }
    if (input.startsWith('</', lt)) {
      const end = input.indexOf('>', lt);
      const name = input.slice(lt + 2, end === -1 ? input.length : end).trim().toLowerCase();
      i = end === -1 ? input.length : end + 1;
      // Close to the matching open tag, or ignore a stray close.
      for (let d = stack.length - 1; d >= 0; d -= 1) {
        if ((stack[d] as Open).tag === name) {
          while (stack.length > d) {
            const open = stack.pop() as Open;
            top().push(element(open.tag, open.attrs, open.children));
          }
          break;
        }
      }
      continue;
    }

    const tagMatch = /^<([a-zA-Z][^\s/>]*)/.exec(input.slice(lt));
    if (tagMatch === null) {
      top().push(text('<'));
      i = lt + 1;
      continue;
    }
    const tag = (tagMatch[1] as string).toLowerCase();
    // The tag's attribute text, quoted values respected.
    let j = lt + tagMatch[0].length;
    const attrs: Attr[] = [];
    let selfClosing = false;
    while (j < input.length) {
      while (j < input.length && /\s/.test(input[j] as string)) j += 1;
      if (input[j] === '>') {
        j += 1;
        break;
      }
      if (input[j] === '/' && input[j + 1] === '>') {
        selfClosing = true;
        j += 2;
        break;
      }
      let k = j;
      while (k < input.length && !/[\s=/>]/.test(input[k] as string)) k += 1;
      const name = input.slice(j, k).toLowerCase();
      let value = '';
      j = k;
      while (j < input.length && /\s/.test(input[j] as string)) j += 1;
      if (input[j] === '=') {
        j += 1;
        while (j < input.length && /\s/.test(input[j] as string)) j += 1;
        const quote = input[j];
        if (quote === '"' || quote === "'") {
          const end = input.indexOf(quote, j + 1);
          value = input.slice(j + 1, end === -1 ? input.length : end);
          j = end === -1 ? input.length : end + 1;
        } else {
          let e = j;
          while (e < input.length && !/[\s>]/.test(input[e] as string)) e += 1;
          value = input.slice(j, e);
          j = e;
        }
      }
      if (name !== '') attrs.push([name, decodeEntities(value)]);
    }
    i = j;

    if (VOID_TAGS.has(tag) || selfClosing) {
      top().push(element(tag, attrs));
      continue;
    }
    if (RAW_TAGS.has(tag)) {
      // Raw text: read to the matching close so a `<` inside it is not a tag.
      const close = input.toLowerCase().indexOf(`</${tag}`, i);
      const end = close === -1 ? input.length : close;
      const inner = input.slice(i, end);
      const after = close === -1 ? input.length : input.indexOf('>', close) + 1;
      const node = element(tag, attrs);
      if (inner !== '') node.children.push(text(inner));
      top().push(node);
      i = after === 0 ? input.length : after;
      continue;
    }
    stack.push({ tag, attrs, children: [] });
  }

  while (stack.length > 0) {
    const open = stack.pop() as Open;
    top().push(element(open.tag, open.attrs, open.children));
  }
  return root;
}

/**
 * Serialise. Attributes are written in the fixed order (§10.3): the component lock
 * first, then `class`, then the `data-*` family alphabetically, then everything else
 * alphabetically — so two documents that differ only in attribute order serialise
 * identically and a diff means a real change.
 */
export function attrRank(name: string): number {
  if (name === 'data-gjs-type') return 0;
  if (name === 'class') return 1;
  if (name.startsWith('data-')) return 2;
  return 3;
}

export function sortAttrs(attrs: Attr[]): Attr[] {
  return [...attrs].sort((a, b) => {
    const ra = attrRank(a[0]);
    const rb = attrRank(b[0]);
    if (ra !== rb) return ra - rb;
    return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
  });
}

export function serialize(nodes: HtmlNode[]): string {
  const out: string[] = [];
  const write = (list: HtmlNode[]): void => {
    for (const node of list) {
      if (node.type === 'text') {
        out.push(escapeText(node.text));
      } else if (node.type === 'comment') {
        out.push(`<!--${node.text}-->`);
      } else {
        const attrs = sortAttrs(node.attrs)
          .map(([k, v]) => (v === '' ? ` ${k}` : ` ${k}="${escapeAttr(v)}"`))
          .join('');
        if (VOID_TAGS.has(node.tag)) {
          out.push(`<${node.tag}${attrs}>`);
        } else {
          out.push(`<${node.tag}${attrs}>`);
          write(node.children);
          out.push(`</${node.tag}>`);
        }
      }
    }
  };
  write(nodes);
  return out.join('');
}
