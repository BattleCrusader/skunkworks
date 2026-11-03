/**
 * S4a F2(a) — the paste gate that runs **in the editor, before GrapesJS parses**.
 *
 * The measurement F2 rests on: GrapesJS strips `data-gjs-type` from a type it has no
 * definition for, so a document pasted into a running canvas arrives at the save route as
 * a bare `<div>` (49 B in, 37 B stored, HTTP 200 in S4a §7.3). The evidence is destroyed
 * by the parse, so the refusal has to happen on the clipboard's bytes, not on the
 * document the canvas hands back.
 *
 * These cases are the scanner's contract. The browser half — that the served script
 * really refuses a real paste — is `scratch/s4a/paste-proof.py` and is quoted in
 * `docs/build/S4a-fix-report.md`; a unit test cannot drive a clipboard.
 *
 * P1  every spelling of the attribute is read, in document order, de-duplicated.
 * P2  an unregistered type refuses the whole paste, with the existing code and the type.
 * P3  a registered type, and content with no lock at all, pass.
 * P4  the served boot script carries the same pattern and a visible refusal surface —
 *     the pattern is single-sourced; the 10-line loop necessarily exists on both sides of
 *     the wire, and this is what keeps them from drifting.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { EDITOR_BOOT_JS, renderEditorPage } from '../app/admin/editor.ts';
import { AppError } from '../app/errors.ts';
import { DATA_GJS_TYPE_PATTERN, assertPasteAllowed, pastedTypes } from '../app/editor/paste.ts';
import { loadRegistry } from '../app/editor/registry.ts';
import { SCHEMA } from './helpers/fixture.ts';

const registry = loadRegistry(SCHEMA);

function detailOf(err: Error): Record<string, unknown> {
  assert.ok(err instanceof AppError);
  return (err.detail ?? {}) as Record<string, unknown>;
}

test('P1 — every spelling of data-gjs-type is read, in document order, without duplicates', () => {
  const html = [
    '<div data-gjs-type="carousel"><p>x</p></div>',
    "<figure data-gjs-type='figure'></figure>",
    '<div data-gjs-type=prose>x</div>',
    '<p data-gjs-type="carousel">again</p>',
    '<span data-gjs-type="">empty</span>',
  ].join('\n');
  assert.deepEqual(pastedTypes(html), ['carousel', 'figure', 'prose', '']);
  // A bare attribute names no registered type either; refusing it is the fail-closed
  // direction, and it is what `assertRegistered` does to a stored body.
  assert.deepEqual(pastedTypes('<div data-gjs-type>x</div>'), ['']);
  // Content that names nothing is not a paste to refuse.
  assert.deepEqual(pastedTypes('<p>hello <b>world</b></p>'), []);
  assert.deepEqual(pastedTypes(''), []);
});

test('P2 — an unregistered type refuses the whole paste, with the existing code and the type', () => {
  let refused: unknown;
  try {
    assertPasteAllowed('<div data-gjs-type="carousel"><p>slides</p></div>', registry);
  } catch (err) {
    refused = err;
  }
  assert.ok(refused instanceof AppError, 'the paste must be refused, not filtered');
  assert.equal(refused.code, 'SKW_E_RT_COMPONENT_UNKNOWN');
  assert.equal(refused.status, 422);
  assert.equal(detailOf(refused)['type'], 'carousel');
  assert.equal(detailOf(refused)['source'], 'paste');
  // The refusal is of the whole paste: one bad type anywhere in it is enough.
  assert.throws(
    () => assertPasteAllowed('<div data-gjs-type="prose">x</div><div data-gjs-type="carousel">y</div>', registry),
    (err: unknown) => err instanceof AppError && err.code === 'SKW_E_RT_COMPONENT_UNKNOWN',
  );
});

test('P3 — a registered type, and content with no lock at all, pass', () => {
  assert.doesNotThrow(() =>
    assertPasteAllowed('<figure data-gjs-type="figure"><img data-asset-key="banner/home" alt=""></figure>', registry),
  );
  assert.doesNotThrow(() => assertPasteAllowed('<p>plain paste, no component</p>', registry));
});

test('P4 — the served boot script carries the same pattern and a visible refusal surface', () => {
  // One pattern, injected: the browser cannot import the module, so what is shared is the
  // source text rather than a second regex that would drift.
  assert.ok(
    EDITOR_BOOT_JS.includes(JSON.stringify(DATA_GJS_TYPE_PATTERN)),
    'the boot script must embed DATA_GJS_TYPE_PATTERN from app/editor/paste.ts',
  );
  assert.match(EDITOR_BOOT_JS, /addEventListener\('paste'/, 'the gate is a paste listener');
  assert.match(EDITOR_BOOT_JS, /preventDefault\(\)/, 'a refused paste is prevented, not filtered');
  assert.match(EDITOR_BOOT_JS, /stopImmediatePropagation\(\)/, 'and it never reaches GrapesJS');
  assert.match(EDITOR_BOOT_JS, /skw-notice/, 'the operator is told, visibly');
  // Every import goes through the chokepoint: the only `setComponents` in the served script
  // is the one inside applyDocument. A new import that calls GrapesJS directly would fail
  // here, which is the point — that is how F1's two unwrappers came to disagree.
  assert.equal(
    (EDITOR_BOOT_JS.match(/editor\.setComponents\(/g) ?? []).length,
    1,
    'the document may enter the canvas in exactly one place, and that place scans it',
  );
  assert.match(EDITOR_BOOT_JS, /function applyDocument\(/);
  // The served script parses: the pattern is injected as a JSON string literal, and a quoting
  // mistake there would be a blank editor page in every browser with nothing to catch it here.
  assert.doesNotThrow(() => new Function(EDITOR_BOOT_JS), 'the served boot script must parse');
  // The surface exists in the page before the script runs, so a refusal has somewhere to go.
  const page = renderEditorPage({
    tenant: 'acme',
    page: null,
    registry,
    csrf: 'token',
    bodyCss: '',
    siteCss: '',
    siteCssTheme: null,
  });
  assert.match(page, /id="skw-notice"/);
  assert.match(page, /role="alert"/);
});
