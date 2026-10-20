/**
 * The paste gate (S4a F2a): the scan that runs **before GrapesJS parses**.
 *
 * Why a paste needs its own gate when the load path and the save route already refuse an
 * unregistered type: those two inspect a document. A paste is not a document until
 * GrapesJS has parsed it, and the parse is the destruction — a type with no registered
 * definition is dropped, the block becomes an anonymous `<div>`, and the bytes that reach
 * the save route are a perfectly valid page with no lock in them. Measured in S4a §7.3:
 * 49 B in, 37 B stored, HTTP 200.
 *
 * So the refusal has to happen on the clipboard's bytes, in the canvas, in the capture
 * phase of `paste`, before the browser inserts anything. That is a browser-side gate, and
 * `app/admin/editor.ts` serves it. What this module owns is the **pattern** (single-sourced
 * — the boot script receives `DATA_GJS_TYPE_PATTERN` verbatim, so the two sides cannot
 * drift) and the reference implementation the tests assert.
 *
 * The scanner is deliberately fail-closed:
 *
 *  - a value of `data-gjs-type` that is not in the registry refuses the paste;
 *  - an empty value, and a bare `data-gjs-type` with no value, refuse it too — the same
 *    decision `assertRegistered` makes for a stored body;
 *  - it scans `text/plain` as well as `text/html`, because GrapesJS's own rich-text paste
 *    handler inserts plain text through `insertHTML`, so plain text *is* markup there.
 *
 * The cost is a false positive when an operator pastes documentation that mentions
 * `data-gjs-type="carousel"`. That is the safe direction: the paste is refused, the
 * operator is told which type and why, and nothing is lost.
 */
import { AppError } from '../errors.ts';
import type { Registry } from './registry.ts';

/**
 * One attribute, three spellings (`"…"`, `'…'`, unquoted), as regex **source text**.
 * Served to the browser verbatim by `EDITOR_BOOT_JS`; used here by `pastedTypes()`.
 */
export const DATA_GJS_TYPE_PATTERN = String.raw`data-gjs-type\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>/]+))`;

/** Every distinct `data-gjs-type` value in a pasted document, in document order. */
export function pastedTypes(html: string): string[] {
  const out: string[] = [];
  const re = new RegExp(DATA_GJS_TYPE_PATTERN, 'gi');
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    const value = match[1] ?? match[2] ?? match[3] ?? '';
    if (!out.includes(value)) out.push(value);
  }
  // `data-gjs-type` with no `=` at all names no registered type either.
  if (out.length === 0 && /data-gjs-type/i.test(html)) out.push('');
  return out;
}

/**
 * Refuse the **whole** paste if any type it names is not registered. Partial insertion is
 * the defect this exists to prevent: the operator would keep a div that looks like a block
 * and lose the block's identity on the next save, with nothing to notice.
 */
export function assertPasteAllowed(html: string, registry: Registry): void {
  for (const type of pastedTypes(html)) {
    if (registry.byType.has(type)) continue;
    throw new AppError('SKW_E_RT_COMPONENT_UNKNOWN', `no component is registered for data-gjs-type="${type}"`, {
      type,
      known: [...registry.byType.keys()],
      source: 'paste',
    });
  }
}
