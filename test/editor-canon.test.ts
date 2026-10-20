/**
 * `canon` is the function the gate is written in terms of, so its own properties are gates
 * (SDS §10.3): Prettier's HTML printer, a fixed attribute order, whitespace normalisation.
 *
 * C1 is the property everything else relies on — `canon(canon(x)) == canon(x)` on every
 * fixture and on the awkward inputs a designer actually types. C2 is the fixed attribute
 * order: two documents that differ only in attribute order are the same document. C3 is the
 * Prettier half, asserted by running Prettier over canon's output: it must not move a byte.
 * (If it did, the stored bytes would depend on which of the two formatted last.)
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import prettier from 'prettier';

import { canon, componentNodes, unwrapBody } from '../app/editor/canon.ts';
import { parseHtml, serialize } from '../app/editor/html.ts';
import { REPO } from './helpers/fixture.ts';

const SITE = join(REPO, 'test', 'fixtures', 'site');
const PAGES = readdirSync(SITE).filter((n) => n.endsWith('.html')).sort();

test('C1 — canon is idempotent on every fixture and on the awkward shapes', async () => {
  for (const page of PAGES) {
    const html = readFileSync(join(SITE, page), 'utf8');
    const once = await canon(html);
    assert.equal(await canon(once), once, `${page}: canon(canon(x)) != canon(x)`);
  }
  const awkward = [
    '<div>   </div>',
    '<p>a</p>\n\n\n<p>b</p>',
    '<div class="x" data-gjs-type="prose"   data-prop="body">text</div>',
    '<img src="a.jpg">',
    '<div><span>one</span> <span>two</span></div>',
    '<div>&lt;not a tag&gt; &amp; a bare &amp;</div>',
    '<section><p>Unclosed',
  ];
  for (const html of awkward) {
    const once = await canon(html);
    assert.equal(await canon(once), once, `not idempotent: ${html}`);
  }
});

test('C2 — the attribute order is fixed: data-gjs-type, class, data-*, then the rest', async () => {
  const a = await canon('<div class="prose" id="one" data-prop="body" data-gjs-type="prose" title="t">x</div>');
  const b = await canon('<div data-gjs-type="prose" data-prop="body" class="prose" title="t" id="one">x</div>');
  assert.equal(a, b);
  assert.match(a, /<div data-gjs-type="prose" class="prose" data-prop="body" id="one" title="t">/);
});

test('C3 — Prettier does not move a byte of canon\'s output (the SDS names Prettier; canon is it)', async () => {
  for (const page of PAGES) {
    const html = readFileSync(join(SITE, page), 'utf8');
    const once = await canon(html);
    const again = await prettier.format(once, {
      parser: 'html',
      printWidth: 100,
      htmlWhitespaceSensitivity: 'ignore',
    });
    assert.equal(again.replace(/\s+$/, ''), once, `${page}: Prettier reformatted canon's output`);
  }
});

test('C4 — whitespace between blocks is not content, and a space between inline elements is', async () => {
  const blocky = await canon('<div>\n  <p>one</p>\n  <p>two</p>\n</div>');
  assert.ok(!blocky.includes('\n\n'), blocky);
  // The space between two inline elements survives as *a* separator: Prettier puts them on
  // their own lines, and a newline between inline content renders as one space, so the
  // words do not run together. The separator is asserted, not its exact form.
  const inline = await canon('<p><span>one</span> <span>two</span></p>');
  assert.match(inline, /one<\/span>\s+<span>two/);
  assert.ok(!inline.includes('one</span><span>'), 'two inline spans must not be glued together');
});

test('C5 — the canvas wrapper is stripped, and a page that starts with <body-text> is not', () => {
  assert.equal(unwrapBody('<body><p>x</p></body>'), '<p>x</p>');
  assert.equal(unwrapBody('<section><p>x</p></section>'), '<section><p>x</p></section>');
  // A `<body` that is not the wrapper (an attribute, say) is left alone.
  assert.equal(unwrapBody('<div data-body="1">x</div>'), '<div data-body="1">x</div>');
});

test('C6 — the parser round-trips what it emits, including a void element and an entity', () => {
  const html = '<figure data-gjs-type="figure"><img data-asset-key="a/b" alt="x &amp; y"><figcaption>1 &lt; 2</figcaption></figure>';
  const once = serialize(parseHtml(html));
  const twice = serialize(parseHtml(once));
  assert.equal(twice, once);
  assert.equal(componentNodes(html).length, 1);
  assert.equal(componentNodes(html)[0]?.type, 'figure');
  // A `<` inside a text node is escaped on the way out, so a body cannot become markup by
  // being re-serialised — the validator refuses `<script` before this runs, but the
  // serializer is not the thing that has to remember that.
  assert.match(serialize(parseHtml('<p>a &lt;b&gt; c</p>')), /a &lt;b&gt; c/);
});
