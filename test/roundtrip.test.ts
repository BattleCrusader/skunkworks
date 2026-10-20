/**
 * §10.3 — **the round-trip gate is a fixpoint, and it is asserted on stored bytes.**
 *
 *     canon(load(save(load(page)))) == canon(load(page))
 *
 * The formula in the SDS is about the *editor's* two passes. What a client's site keeps is
 * what `savePage()` writes, and the two differ in a way that matters: the canvas paints an
 * `<img>` with a placeholder `src="data:image/svg+xml;base64,…"`, and the save path removes
 * it because the body names the key (D17). So the gate here is the stronger statement:
 *
 *     stored(load(stored(load(page)))) == stored(load(page))
 *
 * — load the page into GrapesJS, save it through the product's save path, load **those
 * bytes**, save them again, and compare. That is the acceptance criterion literally
 * ("edit -> save -> reload -> save -> identical bytes"), and it covers the placeholder, the
 * canon step, the attribute order and the `data-item-position` stamping of a list's rows.
 *
 * A fixpoint on bytes alone is **not** sufficient, and RT-1 says so out loud: a save that
 * silently drops a component reaches a fixpoint immediately (the second pass has nothing
 * left to drop). So the gate asserts the second half too — the multiset of
 * `data-gjs-type` values is the same before and after — which is the property a fixpoint
 * cannot see. RT-11 is the negative control for that half: an editor missing one type
 * definition must redden RT-1's assertion and name the page and the type.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { canon } from '../app/editor/canon.ts';
import { analyseBody } from '../app/editor/model.ts';
import { loadRegistry, typeDefinitions } from '../app/editor/registry.ts';
import { AppError } from '../app/errors.ts';
import { twoPasses, type EditorOptions } from './helpers/grapes.ts';
import { REPO, SCHEMA } from './helpers/fixture.ts';

const registry = loadRegistry(SCHEMA);
const SITE = join(REPO, 'test', 'fixtures', 'site');
const PAGES = readdirSync(SITE)
  .filter((name) => name.endsWith('.html'))
  .sort();

/** What the product stores for this document: the editor's save, then the product's. */
async function stored(html: string, options: EditorOptions = {}): Promise<string> {
  const { pass1 } = await twoPasses(registry, html, options);
  return canon(analyseBody({ html: pass1, registry }).html);
}

/** The `data-gjs-type` multiset, sorted — a component that vanished changes this. */
function componentTypes(html: string): string[] {
  return analyseBody({ html, registry }).components.map((c) => c.type).sort();
}

/**
 * The gate for one page. Returns the two stored generations, or throws with the page name
 * and the first divergent line. Both RT-1 and RT-11 call it; a control that used a
 * different check would prove nothing about the gate.
 */
async function fixpointOf(page: string, options: EditorOptions = {}): Promise<{ first: string; second: string; types: string[] }> {
  const html = readFileSync(join(SITE, page), 'utf8');
  const first = await stored(html, options);

  // Half 1: no component was lost or invented between the page as authored and the bytes
  // that are stored. A fixpoint cannot see this (both sides are post-loss), which is why it
  // is a separate assertion.
  const before = componentTypes(html);
  const after = componentTypes(first);
  assert.deepEqual(after, before, `${page}: the stored document changed its component set (${before.join(',')} -> ${after.join(',')})`);

  // Half 2: reload the stored bytes and save again.
  const second = await stored(first, options);
  if (first !== second) {
    const a = first.split('\n');
    const b = second.split('\n');
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
      if (a[i] !== b[i]) {
        assert.fail(`${page} does not reach the fixpoint (first divergent line ${i + 1}: ${JSON.stringify(a[i])} != ${JSON.stringify(b[i])})`);
      }
    }
    assert.fail(`${page} does not reach the fixpoint (trailing whitespace)`);
  }
  // canon is idempotent: the stored bytes are already canonical, which is what makes
  // `body_sha` a stable address for a revision.
  assert.equal(await canon(first), first, `${page}: canon is not idempotent on the stored bytes`);
  return { first, second, types: after };
}

test('RT-0 — the corpus is nine pages, and every shipped block is exercised by one of them', () => {
  assert.equal(PAGES.length, 9, `expected 9 fixtures, found ${PAGES.length}: ${PAGES.join(', ')}`);
  const types = new Set<string>();
  for (const page of PAGES) {
    const html = readFileSync(join(SITE, page), 'utf8');
    const analysed = analyseBody({ html, registry });
    assert.ok(analysed.components.length > 0, `${page}: no components`);
    for (const component of analysed.components) types.add(component.type);
  }
  // A component no fixture renders is a component that was never round-tripped.
  const shipped = registry.entries.filter((e) => e.kind !== 'shell').map((e) => e.name).sort();
  assert.deepEqual([...types].sort(), shipped);
});

test('RT-1 — all nine fixtures reach the fixpoint on stored bytes, and lose no component on the way', async (t) => {
  const rows: { page: string; inputBytes: number; storedBytes: number; stableInput: boolean }[] = [];
  for (const page of PAGES) {
    const { first, types } = await fixpointOf(page);
    const html = readFileSync(join(SITE, page), 'utf8');
    rows.push({
      page,
      inputBytes: Buffer.byteLength(html, 'utf8'),
      storedBytes: Buffer.byteLength(first, 'utf8'),
      stableInput: (await canon(html)) === first,
    });
    t.diagnostic(`${page.padEnd(14)} ${types.join('+').padEnd(30)} stored ${String(Buffer.byteLength(first, 'utf8')).padStart(5)} B`);
  }
  assert.equal(rows.length, 9);
  // The count of pages that are byte-stable from the hand-authored input is a *measurement*,
  // not a requirement: D21 as amended says an empty diff on pass 1 is not the gate because
  // GrapesJS normalises on load. It is reported so a change in it is visible.
  t.diagnostic(`${rows.filter((r) => r.stableInput).length}/9 are byte-identical to the hand-authored input; ` +
    `${rows.filter((r) => !r.stableInput).length}/9 differ at pass 1 (whitespace, the canvas placeholder, and the list rows' item positions)`);
});

test('RT-11 — the negative control: an editor missing one type definition reddens RT-1, naming the page and the type', async () => {
  const defs = typeDefinitions(registry);
  const withoutHero = defs.filter((def) => def.type !== 'hero');
  assert.equal(withoutHero.length, defs.length - 1);

  let failure: unknown;
  try {
    await fixpointOf('index.html', { types: withoutHero });
  } catch (err) {
    failure = err;
  }
  assert.ok(failure !== undefined, 'the gate must be red when a type the page uses is not registered');
  // The message names the page and the component that vanished — the two things a builder
  // needs, and the reason the check runs on the component multiset and not only on bytes.
  assert.match(String((failure as Error).message), /index\.html/);
  assert.match(String((failure as Error).message), /hero/);

  // Restored, the same page is a fixpoint again: the red was the mutation, not the page.
  const { first } = await fixpointOf('index.html');
  assert.equal(await stored(first), first);
});

test('RT-12 — an unregistered type in a stored body is refused by the gate, with a code', async () => {
  // The other direction of the same defect: a body that *already* names an unknown type
  // (written by an older image, or by hand) cannot be loaded — `analyseBody` refuses it
  // before GrapesJS strips it, and the gate says which code.
  let refused: unknown;
  try {
    analyseBody({ html: '<div data-gjs-type="carousel"><p>x</p></div>', registry });
  } catch (err) {
    refused = err;
  }
  assert.ok(refused instanceof AppError);
  assert.equal(refused.code, 'SKW_E_RT_COMPONENT_UNKNOWN');
  assert.equal(refused.status, 422);
});
