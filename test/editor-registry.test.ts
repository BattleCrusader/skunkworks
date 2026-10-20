/**
 * §10.2 (D21 as amended): one registry entry, three consumers, and the palette is
 * **generated** from the registry rather than written beside it.
 *
 * The acceptance criterion is behavioural: *add a registry entry in a test and the palette
 * grows with no other edit*. R1 is that test, and it is the reason `palette()` takes a
 * `Registry` rather than reading the file itself — a generated palette over an injected
 * registry is testable; a palette that reads `schema/component-registry.json` is not.
 *
 * R2–R8 are the registry's own refusals. Each is a way a *builder* can break the editor
 * without noticing, and each one is red at boot rather than green until a designer drags
 * the block:
 *
 *   - a block whose `type` is not its `name` (two vocabularies),
 *   - a block whose html root does not carry its own `data-gjs-type` (the lock is stripped
 *     on save, measured 176 B -> 110 B),
 *   - a `type` that is a GrapesJS built-in (`image` — measured: the built-in model writes a
 *     `src="data:image/svg+xml;base64,…"` placeholder into the body),
 *   - an `editable` field that does not exist in the html it edits,
 *   - `allowed_children` naming something unregistered,
 *   - a `list` without `[data-repeat]` or without a clamp (§6.3's two CHECKs),
 *   - a `block` with no html, or `type != name`.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  GRAPESJS_TYPES,
  loadRegistry,
  palette,
  paletteCategories,
  parseRegistry,
  registryCss,
  typeDefinitions,
} from '../app/editor/registry.ts';
import { REPO, SCHEMA } from './helpers/fixture.ts';

const raw = JSON.parse(readFileSync(join(SCHEMA, 'component-registry.json'), 'utf8')) as {
  version: number;
  components: Record<string, unknown>[];
};

test('R1 — the palette is generated: a new registry entry appears with no other edit', () => {
  const before = palette(loadRegistry(SCHEMA));
  const grown = parseRegistry({
    version: 5,
    components: [
      ...raw.components,
      {
        name: 'quote',
        kind: 'block',
        type: 'quote',
        label: 'Pull quote',
        category: 'Text',
        renderer: 'components/quote.ts',
        version: '1.0.0',
        bindings: [],
        props: { type: 'object', properties: {}, additionalProperties: false },
        editable: [{ prop: 'body', type: 'text' }],
        allowed_children: [],
        html: '<blockquote class="quote" data-gjs-type="quote"><p data-prop="body">A sentence worth pulling out.</p></blockquote>',
        css: '.quote{margin:2rem 0;font-size:1.25rem}',
      },
    ],
  });
  const after = palette(grown);
  assert.equal(after.length, before.length + 1);
  const added = after.filter((item) => item.id === 'quote');
  assert.equal(added.length, 1);
  assert.equal(added[0]?.label, 'Pull quote');
  assert.equal(added[0]?.category, 'Text');
  assert.match(added[0]?.content ?? '', /data-gjs-type="quote"/);
  // …and nothing else changed: the palette is a projection, not a hand-maintained list.
  assert.deepEqual(
    after.filter((item) => item.id !== 'quote').map((item) => item.id),
    before.map((item) => item.id),
  );
  // The type is draggable because the entries, not the page, say so.
  assert.ok(typeDefinitions(grown).some((def) => def.type === 'quote'));
});

test('R2 — the shipped registry is one entry per component, type === name, one css rule each', () => {
  const registry = loadRegistry(SCHEMA);
  assert.equal(registry.version, 4);
  const blocks = registry.entries.filter((e) => e.kind !== 'shell');
  assert.equal(blocks.length, 10);
  for (const entry of blocks) {
    assert.equal(entry.type, entry.name, `${entry.name}: type must be the name`);
    assert.notEqual(entry.html, null, `${entry.name}: no html`);
    assert.match(entry.css, /\S/, `${entry.name}: no css`);
    assert.ok(!GRAPESJS_TYPES.has(entry.type), `${entry.name}: collides with a GrapesJS type`);
  }
  // Shells are not draggable and have no html: a shell is a layout, not a block.
  for (const shell of registry.entries.filter((e) => e.kind === 'shell')) {
    assert.equal(shell.html, null);
    assert.ok(!palette(registry).some((item) => item.id === shell.name));
  }
});

test('R3 — the palette keeps registry order and groups categories in first-seen order', () => {
  const registry = loadRegistry(SCHEMA);
  const items = palette(registry);
  assert.deepEqual(
    items.map((item) => item.id),
    ['hero', 'prose', 'figure', 'gallery', 'download-button', 'cta', 'form', 'embed', 'list', 'copy-email'],
  );
  assert.deepEqual(paletteCategories(items), ['Structure', 'Text', 'Media', 'Commerce', 'Data', 'Interactive']);
});

test('R4 — a block whose html root does not carry its own data-gjs-type is refused', () => {
  const broken = JSON.parse(JSON.stringify(raw)) as { version: number; components: Record<string, unknown>[] };
  const prose = broken.components.find((c) => c.name === 'prose');
  assert.ok(prose !== undefined);
  prose.html = '<div class="prose"><p data-prop="body">x</p></div>';
  assert.throws(
    () => parseRegistry(broken),
    /prose\.html root must carry data-gjs-type="prose"/,
  );
});

test('R5 — a type that is one of GrapesJS\'s own is refused at boot, not discovered at save', () => {
  const broken = JSON.parse(JSON.stringify(raw)) as { version: number; components: Record<string, unknown>[] };
  const figure = broken.components.find((c) => c.name === 'figure');
  assert.ok(figure !== undefined);
  // The measurement: a registry that calls its figure block "image" is parsed by the
  // *built-in* image model, which writes src="data:image/svg+xml;base64,…" into the body.
  figure.name = 'image';
  figure.type = 'image';
  figure.html = String(figure.html).replace('data-gjs-type="figure"', 'data-gjs-type="image"');
  assert.throws(() => parseRegistry(broken), /one of GrapesJS's own component types/);

  // …and the neighbouring refusal, so the two are not confused: two vocabularies is also red.
  const renamed = JSON.parse(JSON.stringify(raw)) as { version: number; components: Record<string, unknown>[] };
  const cta = renamed.components.find((c) => c.name === 'cta');
  assert.ok(cta !== undefined);
  cta.type = 'calltoaction';
  assert.throws(() => parseRegistry(renamed), /type must equal name/);
});

test('R6 — an editable field that does not exist in the html is refused', () => {
  const broken = JSON.parse(JSON.stringify(raw)) as { version: number; components: Record<string, unknown>[] };
  const cta = broken.components.find((c) => c.name === 'cta');
  assert.ok(cta !== undefined);
  cta.editable = [{ prop: 'headline', type: 'text' }];
  assert.throws(() => parseRegistry(broken), /editable names "headline"/);
});

test('R7 — allowed_children must name a registered, non-shell component', () => {
  const broken = JSON.parse(JSON.stringify(raw)) as { version: number; components: Record<string, unknown>[] };
  const hero = broken.components.find((c) => c.name === 'hero');
  assert.ok(hero !== undefined);
  hero.allowed_children = ['carousel'];
  assert.throws(() => parseRegistry(broken), /allowed_children names "carousel"/);

  const shellChild = JSON.parse(JSON.stringify(raw)) as { version: number; components: Record<string, unknown>[] };
  const gallery = shellChild.components.find((c) => c.name === 'gallery');
  assert.ok(gallery !== undefined);
  gallery.allowed_children = ['landing'];
  assert.throws(() => parseRegistry(shellChild), /names a shell/);
});

test('R8 — §6.3\'s two list CHECKs, restated: [data-repeat] and a clamp', () => {
  const noRepeat = JSON.parse(JSON.stringify(raw)) as { version: number; components: Record<string, unknown>[] };
  const list = noRepeat.components.find((c) => c.name === 'list');
  assert.ok(list !== undefined);
  list.repeat_child = '[data-item]';
  assert.throws(() => parseRegistry(noRepeat), /repeat_child '\[data-repeat\]'/);

  const noClamp = JSON.parse(JSON.stringify(raw)) as { version: number; components: Record<string, unknown>[] };
  const list2 = noClamp.components.find((c) => c.name === 'list');
  assert.ok(list2 !== undefined);
  list2.limit_max = null;
  assert.throws(() => parseRegistry(noClamp), /limit_max/);
});

test('R9 — typeDefinitions re-emit the lock, which is what keeps a type registered across a save', () => {
  const defs = typeDefinitions(loadRegistry(SCHEMA));
  for (const def of defs) {
    const defaults = (def.model as { defaults: { attributes: Record<string, string> } }).defaults;
    assert.equal(defaults.attributes['data-gjs-type'], def.type);
    assert.equal(def.isComponent({ attributes: { 'data-gjs-type': def.type } }), true);
    assert.equal(def.isComponent({ attributes: { 'data-gjs-type': 'nope' } }), false);
    assert.equal(def.isComponent(null), false);
  }
});

test('R10 — the stylesheet is the registry\'s rules, in registry order', () => {
  const registry = loadRegistry(SCHEMA);
  const css = registryCss(registry);
  assert.match(css, /\.hero\{padding:4rem 1\.5rem\}/);
  assert.ok(css.indexOf('.hero{') < css.indexOf('.prose{'), 'registry order, not alphabetical');
  // Every block contributes exactly one rule set; a block with no css was refused in R2.
  assert.equal(css.split('\n').length, 10);
  // The file the image ships is the file the test read.
  assert.equal(loadRegistry(join(REPO, 'schema')).version, 4);
});
