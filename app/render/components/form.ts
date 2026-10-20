/**
 * **The core form, rendered.** `components/form.ts` — the file `schema/component-registry.json`
 * has declared since the registry was written and which never existed, so a `form` block inserted
 * from the editor's palette produced markup that posted to the *page's own URL* with no `_pt`
 * token and was refused by `submitCoreForm` with `SKW_E_SEC_CSRF`'s `missing` reason. A form you
 * cannot submit is a form that is not a component.
 *
 * This module is the missing half of `app/forms/intake.ts`. The intake owns the contract — 16 KiB,
 * 5 per 10 min, a signed `_pt` with a 1.5 s minimum fill, a `_hp` honeypot — and a renderer that
 * does not carry those two fields is a renderer that guarantees the refusal. So the binding is:
 *
 *   | the intake checks        | this renderer emits                                    |
 *   |--------------------------|--------------------------------------------------------|
 *   | `action` = `POST /f/<k>` | `<form method="post" action="/f/<key>">`                |
 *   | `_pt` signed, 30 min TTL | `<input type="hidden" name="_pt" value="<ts>.<mac>">`   |
 *   | `_hp` empty → a bot      | `<input name="_hp" value="">` inside an `aria-hidden` p |
 *   | declared fields only     | one input per `fields_json` entry the markup lacks     |
 *   | required, per-field max  | `required`, `maxlength`, `type` from the spec          |
 *
 * **The token is minted here and verified there, from the same function.** `formIntentToken()` is
 * the only minter in the tree; the gate's own negative control is a token minted for another form
 * key, which the intake refuses on the signature. A renderer that inlined the HMAC would be a
 * second implementation of the one thing that must not have two.
 *
 * **A form with no row is a render failure, not an empty form.** `renderBody()` has the same rule
 * for an asset key that resolves to nothing (`SKW_E_RT_ASSET_MISSING`): a page that names data the
 * tenant does not have is a broken page, and an empty `<form>` would submit nothing forever while
 * looking correct. `data-form` absent is not a failure — it is the editor's placeholder markup,
 * which is left alone so a draft can be saved before the form it names exists.
 *
 * **What the export path does.** `app/export/*` calls the same `renderStoredBody()` with no intent
 * context, because a static bundle holds no `SKW_SESSION_KEY` and a token minted at export time
 * would be 30-minutes-stale the moment a visitor loads the page. The form is left submittable in
 * shape and carries `data-form-intent="absent"`, so the bytes say what they are instead of
 * pretending a bundle can take a submission. `docs/build/S5-inprocess-report.md` §10 records it.
 */
import type Database from 'better-sqlite3';

import { AppError } from '../../errors.ts';
import {
  formByKey,
  formIntentToken,
  fieldsOf,
  type FormFieldSpec,
  type FormIntentContext,
} from '../../forms/intake.ts';
import { attr, element, elements, parseHtml, serialize, setAttr, type ElementNode } from '../../editor/html.ts';

export type { FormIntentContext };

/** The honeypot's wrapper: present in the DOM, invisible to a person, irresistible to a bot. */
const HONEYPOT_HTML =
  '<p class="form__hp" aria-hidden="true" style="position:absolute;left:-9999px" data-honeypot>' +
  '<label>Leave this empty<input name="_hp" type="text" value="" tabindex="-1" autocomplete="off"></label></p>';

function inputFor(spec: FormFieldSpec): ElementNode {
  const attrs: [string, string][] = [
    ['class', 'form__input'],
    ['name', spec.name],
    ['type', spec.type ?? 'text'],
    ['value', ''],
  ];
  if (spec.required === true) attrs.push(['required', '']);
  if (spec.max !== undefined) attrs.push(['maxlength', String(spec.max)]);
  const input = element('input', attrs);
  const label = element('label', [['class', 'form__label']], [
    { type: 'text', text: spec.name.replace(/(^|[-_])([a-z])/g, (_m, _s, c: string) => ` ${c.toUpperCase()}`).trim() },
    input,
  ]);
  return label;
}

/**
 * Bind one `<form data-gjs-type="form">` element in place.
 *
 * Returns the fields it added, so a caller (or a gate) can name what came from `fields_json`
 * rather than from the author.
 */
export function bindCoreForm(
  db: Database.Database,
  el: ElementNode,
  ctx: FormIntentContext | undefined,
): { key: string; added: string[] } {
  const key = attr(el, 'data-form');
  if (key === undefined || key === '') return { key: '', added: [] };
  const row = formByKey(db, key);
  if (row === undefined || row.mode === 'disabled') {
    throw new AppError('SKW_E_RT_SOURCE_UNKNOWN', 'a page embeds a form that this tenant does not have', {
      reason: 'form',
      form: key,
      ...(row === undefined ? {} : { mode: row.mode }),
    });
  }
  const fields = fieldsOf(row.fields_json);

  // 1. Where it posts. A `mode='forward'` row keeps its declared `action_url` — core cannot
  //    deliver it (there is no outbound client), and pointing the browser at the real endpoint is
  //    the only honest rendering of a row core refuses to store.
  setAttr(el, 'method', 'post');
  setAttr(el, 'action', row.mode === 'forward' && row.action_url !== null ? row.action_url : `/f/${key}`);
  setAttr(el, 'data-form-intent', ctx === undefined ? 'absent' : 'minted');

  // 2. One input per declared field the markup does not already name.
  const present = new Set(
    elements([el])
      .filter((node) => node.tag === 'input' || node.tag === 'select' || node.tag === 'textarea')
      .map((node) => attr(node, 'name') ?? '')
      .filter((name) => name !== ''),
  );
  const added: string[] = [];
  const trailing = el.children.findIndex((child) => child.type === 'element' && child.tag === 'button');
  for (const spec of fields) {
    if (present.has(spec.name)) continue;
    added.push(spec.name);
    const input = inputFor(spec);
    if (trailing === -1) el.children.push(input);
    else el.children.splice(trailing, 0, input);
  }

  // 3. The token, and the honeypot. Both are hidden inputs and both are the intake's contract;
  //    without a context (the export path) neither is emitted, and `data-form-intent` says so.
  if (ctx !== undefined) {
    const token = formIntentToken(ctx.tenant, key, ctx.sessionKey, ctx.atMs);
    el.children.unshift(element('input', [['type', 'hidden'], ['name', '_pt'], ['value', token]]));
    const [honeypot] = parseHtml(HONEYPOT_HTML);
    if (honeypot !== undefined) {
      const submitAt = el.children.findIndex((child) => child.type === 'element' && child.tag === 'button');
      if (submitAt === -1) el.children.push(honeypot);
      else el.children.splice(submitAt, 0, honeypot);
    }
  }
  return { key, added };
}

/**
 * A rendered body with every core form bound. `renderStoredBody()` calls this **after** the asset
 * pass, because a form is not an asset and the two projections must not interleave.
 *
 * Parsing twice is deliberate: `renderBody()` is the asset projection and stays one function with
 * one job, and a body with no form block — the overwhelming majority — is rejected by the string
 * test below without a second parse.
 */
export function bindCoreForms(html: string, db: Database.Database, ctx: FormIntentContext | undefined): string {
  if (!html.includes('data-gjs-type="form"')) return html;
  const tree = parseHtml(html);
  for (const el of elements(tree)) {
    if (attr(el, 'data-gjs-type') === 'form' || el.tag === 'form') bindCoreForm(db, el, ctx);
  }
  return serialize(tree);
}
