/**
 * §10.3 / §13 D21 — **the fixpoint gate, driven through the production entry point.**
 *
 *     stored(load(stored(load(page)))) == stored(load(page))
 *
 * This file used to compute `stored()` itself:
 *
 *     canon(analyseBody({ html: (await twoPasses(...)).pass1, registry }).html)
 *
 * — a second copy of `savePage()`'s pipeline, fed by an editor helper that stripped the
 * canvas's `<body>` wrapper before returning. The product never did either: `savePage()`
 * canonicalised the string it was handed and `window.skwSave` posted `editor.getHtml()`
 * verbatim, so every page the editor wrote began with `<body>` while the gate was green
 * for three slices (S4a F1). A gate that re-implements the path it is a gate for measures
 * its own copy.
 *
 * So the gate now does what the browser does:
 *
 *   1. load the fixture into a real GrapesJS (jsdom, headless),
 *   2. post `{id?, path, title, template, html: getHtml(), css: getCss(), components}`
 *      to `POST /admin/t/<tenant>/editor/save` — the payload `window.skwSave` posts,
 *   3. read the **bytes the response says were stored**, and load *those* into the canvas,
 *   4. post again and compare the two stored generations.
 *
 * There is no canonicaliser, no unwrap and no analyse in this file. The only save path in
 * the test is the product's.
 *
 * A fixpoint on bytes alone is **not** sufficient, and RT-1 says so out loud: a save that
 * silently drops a component reaches a fixpoint immediately (the second pass has nothing
 * left to drop). So the gate asserts the second half too — the multiset of
 * `data-gjs-type` values is the same before and after — plus the fragment property F1 was
 * about: the stored bytes begin with the page's first component and contain no `<body>`.
 * RT-11 is the negative control for that half: an editor missing one type definition must
 * redden RT-1 and name the page and the type.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { openAdminWrite } from '../app/db/classes.ts';
import { analyseBody, type ComponentInstance } from '../app/editor/model.ts';
import { attr, type ElementNode, parseHtml } from '../app/editor/html.ts';
import { loadRegistry, typeDefinitions } from '../app/editor/registry.ts';
import { renderBody } from '../app/editor/render.ts';
import { AppError } from '../app/errors.ts';
import { loadEnv } from '../app/env.ts';
import { buildApp, type AppHandle } from '../app/main.ts';
import {
  ADMIN_HOST,
  ADMIN_ORIGIN,
  TOTP_SECRET,
  codeOf,
  openSession,
  seedUser,
  type Sessioned,
} from './helpers/admin.ts';
import { REPO, SCHEMA, makeFixture, type Fixture } from './helpers/fixture.ts';
import { openEditor, type EditorOptions, type EditorSession } from './helpers/grapes.ts';
import { call, type Res } from './helpers/http.ts';

const registry = loadRegistry(SCHEMA);
const SITE = join(REPO, 'test', 'fixtures', 'site');
const PAGES = readdirSync(SITE)
  .filter((name) => name.endsWith('.html'))
  .sort();

let fixture: Fixture;
let handle: AppHandle;
let port = 0;
let session: Sessioned;

before(async () => {
  fixture = makeFixture({ specs: [{ key: 'acme', hosts: ['acme.test'], title: 'Acme' }] });
  await seedUser({ controlDb: fixture.controlDb, tenantKey: 'acme', email: 'owner@acme.test', totpSecret: TOTP_SECRET });
  // The keys the corpus names, so the render half can derive a URL for each (D17). One
  // gated document, because a stored `<a data-asset-key>` on gated bytes must render to
  // the redeem path and not to a farm URL.
  const db = openAdminWrite(fixture.sitePath('acme'));
  try {
    const asset = (key: string, mime: string, kind: string, access: string): void => {
      db.prepare(
        `INSERT INTO cms_asset (key, filename, mime, bytes, sha256, kind, width, height, access_class)
         VALUES (?, ?, ?, 10, ?, ?, 1200, 800, ?)`,
      ).run(key, `${key}.bin`, mime, 'ab'.repeat(32), kind, access);
    };
    asset('banner/home', 'image/jpeg', 'image', 'public');
    for (const key of ['work/one', 'work/two', 'work/three', 'team/studio', 'posts/first']) {
      asset(key, 'image/jpeg', 'image', 'public');
    }
    asset('vault/rate-card', 'application/pdf', 'document', 'gated');
  } finally {
    db.close();
  }
  handle = await buildApp({
    env: loadEnv(fixture.env),
    schemaDir: SCHEMA,
    contentRoot: `${fixture.dir}/content`,
  });
  await handle.app.listen({ port: 0, host: '127.0.0.1' });
  const address = handle.app.server.address();
  port = typeof address === 'object' && address !== null ? address.port : 0;
  session = await openSession({ port, email: 'owner@acme.test' });
});

after(async () => {
  if (handle !== undefined) await handle.close();
  if (fixture !== undefined) fixture.cleanup();
});

/** Every save in this file writes a page at its own path, so a re-run cannot collide. */
let pathSeq = 0;

/**
 * The exact payload `window.skwSave` posts (`app/admin/editor.ts`, step 6): the page's
 * identity, `editor.getHtml()` untouched, `editor.getCss()`, and the inventory of
 * registered component types the canvas model holds. A create sends no `id` key at all,
 * because the boot script sets it to `undefined` when `boot.page.id === null`.
 */
async function postSave(document: { html: string; css: string; components: string[] }, page: string, id?: number): Promise<Res> {
  pathSeq += 1;
  const body: Record<string, unknown> = {
    id,
    path: `/gate/${page.replace('.html', '')}-${pathSeq}`,
    title: page,
    template: 'page',
    html: document.html,
    css: document.css,
    components: document.components,
  };
  if (id === undefined) delete body.id;
  return call({
    port,
    host: ADMIN_HOST,
    path: '/admin/t/acme/editor/save',
    method: 'POST',
    headers: {
      cookie: session.cookie,
      'content-type': 'application/json',
      origin: ADMIN_ORIGIN,
      'x-csrf-token': session.csrfToken,
    },
    body: JSON.stringify(body),
  });
}

interface Stored {
  id: number;
  bodyHtml: string;
}

/** Post the canvas's document and return the bytes the server says it stored. */
async function saveThroughProduct(editor: EditorSession, page: string, id?: number): Promise<Stored> {
  const res = await postSave(editor.document(), page, id);
  assert.equal(res.status, 200, `${page}: the save route refused the canvas's document: ${res.body}`);
  const saved = res.json as { id: number; bodyHtml: string };
  assert.equal(typeof saved.bodyHtml, 'string', `${page}: the save response carries no stored bytes`);
  return { id: saved.id, bodyHtml: saved.bodyHtml };
}

/** The `data-gjs-type` multiset, sorted — a component that vanished changes this. */
function componentTypes(html: string): string[] {
  return analyseBody({ html, registry }).components.map((c) => c.type).sort();
}

/** The document's top-level elements, in order. A fragment has the page's roots; a document has one `<body>`. */
function roots(html: string): ElementNode[] {
  return parseHtml(html).filter((node): node is ElementNode => node.type === 'element');
}

/**
 * The gate for one page. Returns the two stored generations, or throws with the page name
 * and the first divergent line. Both RT-1 and RT-11 call it; a control that used a
 * different check would prove nothing about the gate.
 */
async function fixpointOf(
  page: string,
  options: EditorOptions = {},
): Promise<{ first: string; second: string; types: string[]; components: ComponentInstance[] }> {
  const authored = readFileSync(join(SITE, page), 'utf8');
  const editor = await openEditor(registry, options);
  try {
    // Pass 1: the canvas loads the hand-authored page and posts what it holds.
    editor.load(authored);
    const first = await saveThroughProduct(editor, page);

    // Half 1: no component was lost or invented between the page as authored and the bytes
    // that are stored. A fixpoint cannot see this (both sides are post-loss), which is why
    // it is a separate assertion.
    const beforeTypes = componentTypes(authored);
    const afterTypes = componentTypes(first.bodyHtml);
    assert.deepEqual(
      afterTypes,
      beforeTypes,
      `${page}: the stored document changed its component set (${beforeTypes.join(',')} -> ${afterTypes.join(',')})`,
    );

    // Half 1b: the stored bytes are a **fragment that starts with the page's first
    // component**. This is the half S4a F1 was invisible to: a `<body>` wrapper keeps the
    // component set, keeps the fixpoint, and is still not what `cms_page.body_html` means.
    assert.ok(
      !/<body[\s>]/i.test(first.bodyHtml) && !/<\/body/i.test(first.bodyHtml),
      `${page}: the stored bytes are a document, not a fragment: ${JSON.stringify(first.bodyHtml.slice(0, 60))}`,
    );
    const storedRoots = roots(first.bodyHtml);
    const authoredRoots = roots(authored);
    assert.equal(storedRoots.length, authoredRoots.length, `${page}: the stored bytes changed the number of top-level blocks`);
    const root = storedRoots[0] as ElementNode;
    const rootType = attr(root, 'data-gjs-type');
    assert.ok(rootType !== undefined, `${page}: the stored bytes do not begin with a registered component`);
    assert.ok(
      first.bodyHtml.startsWith(`<${root.tag} data-gjs-type="${rootType}"`),
      `${page}: the stored bytes do not begin with the component's own tag: ${JSON.stringify(first.bodyHtml.slice(0, 60))}`,
    );

    // Pass 2: reload the stored bytes — the product's load hands `body_html` to the canvas —
    // and post again.
    editor.load(first.bodyHtml);
    const second = await saveThroughProduct(editor, page, first.id);
    if (first.bodyHtml !== second.bodyHtml) {
      const a = first.bodyHtml.split('\n');
      const b = second.bodyHtml.split('\n');
      for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
        if (a[i] !== b[i]) {
          assert.fail(
            `${page} does not reach the fixpoint (first divergent line ${i + 1}: ${JSON.stringify(a[i])} != ${JSON.stringify(b[i])})`,
          );
        }
      }
      assert.fail(`${page} does not reach the fixpoint (trailing whitespace)`);
    }
    return {
      first: first.bodyHtml,
      second: second.bodyHtml,
      types: afterTypes,
      components: analyseBody({ html: first.bodyHtml, registry }).components,
    };
  } finally {
    editor.destroy();
  }
}

/** RT-1's measurement, cached so RT-13 renders the same bytes without saving nine more pages. */
const storedByPage = new Map<string, { first: string; components: ComponentInstance[] }>();

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

test('RT-1 — all nine fixtures reach the fixpoint on bytes the save route stored, and lose no component on the way', async (t) => {
  const rows: { page: string; inputBytes: number; storedBytes: number; roots: number; body: boolean }[] = [];
  for (const page of PAGES) {
    const { first, types, components } = await fixpointOf(page);
    storedByPage.set(page, { first, components });
    const html = readFileSync(join(SITE, page), 'utf8');
    rows.push({
      page,
      inputBytes: Buffer.byteLength(html, 'utf8'),
      storedBytes: Buffer.byteLength(first, 'utf8'),
      roots: roots(first).length,
      body: /<body[\s>]/i.test(first),
    });
    t.diagnostic(`${page.padEnd(14)} ${types.join('+').padEnd(30)} stored ${String(Buffer.byteLength(first, 'utf8')).padStart(5)} B`);
  }
  assert.equal(rows.length, 9);
  // The wrapper is gone from every row, not just the ones a diagnostic happened to print.
  assert.deepEqual(
    rows.filter((r) => r.body).map((r) => r.page),
    [],
    'a stored body still carries the canvas <body> wrapper',
  );
  t.diagnostic(`${rows.filter((r) => !r.body).length}/9 stored bodies are fragments (no <body> wrapper)`);
});

test('RT-13 — the stored bytes render inside the page shell as the fragment they are', () => {
  // The shell is `app/render/components/shells/page.astro`:
  //   <body data-page-path={page.path}><main set:html={page.bodyHtml} /></body>
  // `set:html` writes the string into `<main>`. If `body_html` were a document, the browser
  // would have to hoist a second `<body>`'s children out of it — which is what S4a F1 was,
  // and the reason a fragment has to be asserted here and not only in a browser.
  const db = openAdminWrite(fixture.sitePath('acme'));
  try {
    for (const page of PAGES) {
      const cached = storedByPage.get(page);
      assert.ok(cached !== undefined, `${page}: RT-1 did not store this page`);
      const stored = cached.first;
      const rendered = renderBody(db, stored);
      assert.ok(!/<body[\s>]/i.test(rendered), `${page}: the rendered body contains a <body> element`);
      const shell = `<main>${rendered}</main>`;
      assert.equal((shell.match(/<main>/g) ?? []).length, 1);
      assert.equal((shell.match(/<body[\s>]/gi) ?? []).length, 0, `${page}: a shell would host a <body>`);
      const root = roots(rendered)[0] as ElementNode;
      assert.equal(attr(root, 'data-gjs-type'), attr(roots(stored)[0] as ElementNode, 'data-gjs-type'));
    }
  } finally {
    db.close();
  }
});

test('RT-2 — the render derives the URL from the key, and a gated asset renders to its redeem path', () => {
  const stored = storedByPage.get('pricing.html');
  assert.ok(stored !== undefined);
  const db = openAdminWrite(fixture.sitePath('acme'));
  try {
    const rendered = renderBody(db, stored.first);
    // D17: the body names `vault/rate-card`; the render is the only place a URL is made,
    // and a gated asset has none — its address is the redeem path.
    assert.match(rendered, /data-asset-key="vault\/rate-card"/);
    assert.match(rendered, /href="\/d\/vault\/rate-card"/);
    assert.ok(!rendered.includes('/media/vault/rate-card'), 'a gated asset must not get a public URL');
  } finally {
    db.close();
  }
  const gallery = storedByPage.get('gallery.html');
  assert.ok(gallery !== undefined);
  const db2 = openAdminWrite(fixture.sitePath('acme'));
  try {
    assert.match(renderBody(db2, gallery.first), /src="\/media\/work\/one\.jpg\?v=abababab"/);
  } finally {
    db2.close();
  }
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
  const editor = await openEditor(registry);
  try {
    editor.load(first);
    const again = await saveThroughProduct(editor, 'index.html');
    assert.equal(again.bodyHtml, first);
  } finally {
    editor.destroy();
  }
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
