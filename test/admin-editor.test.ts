/**
 * The editor **over the wire** (§10.1, item 2 and 3 of S4a): the admin page, the vendored
 * GrapesJS bundle, the palette generated from the registry, the save, the picker, and the
 * refusal that has to happen before the canvas exists.
 *
 * These cases go through `buildApp` on a real socket with a real session and the real CSRF
 * header (D28), because the failure mode this slice is most likely to have is not "the
 * module is wrong" but "the route is not wired" — the same class S3's register defect was.
 *
 * E1  the page is 200, carries the palette JSON and the three script/link tags, and the
 *     palette's ids are the registry's draggable components in registry order.
 * E2  `grapesjs.js` is served from this origin and starts with the library's banner (the
 *     bundle the image ships, not a CDN reference).
 * E3  a page whose stored body names an unregistered type is refused with 422 and the code.
 * E4  the save route writes the row, returns the canonical bytes, and a second save with
 *     the returned bytes is byte-identical (the fixpoint, through HTTP).
 * E5  the picker returns a document with `data-asset-key` and no URL; a pick for an asset
 *     that does not exist is refused rather than written into the body.
 * E6  the write routes refuse without CSRF — the editor is not a hole in D28.
 */
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { after, before, test } from 'node:test';

import { openAdminWrite } from '../app/db/classes.ts';
import { loadEnv } from '../app/env.ts';
import { buildApp, type AppHandle } from '../app/main.ts';
import { loadRegistry, palette } from '../app/editor/registry.ts';
import { ADMIN_HOST, ADMIN_ORIGIN, TOTP_SECRET, codeOf, openSession, seedUser, type Sessioned } from './helpers/admin.ts';
import { REPO, SCHEMA, makeFixture, type Fixture } from './helpers/fixture.ts';
import { call, type Res } from './helpers/http.ts';

let fixture: Fixture;
let handle: AppHandle;
let port = 0;
let session: Sessioned;

const registry = loadRegistry(SCHEMA);

before(async () => {
  fixture = makeFixture({ specs: [{ key: 'acme', hosts: ['acme.test'], title: 'Acme' }] });
  await seedUser({ controlDb: fixture.controlDb, tenantKey: 'acme', email: 'owner@acme.test', totpSecret: TOTP_SECRET });
  handle = await buildApp({
    env: loadEnv(fixture.env),
    schemaDir: SCHEMA,
    contentRoot: `${fixture.dir}/content`,
  });
  await handle.app.listen({ port: 0, host: '127.0.0.1' });
  const address = handle.app.server.address();
  port = typeof address === 'object' && address !== null ? address.port : 0;
  session = await openSession({ port, email: 'owner@acme.test' });
  // One page with a public image asset, and one page that names a type this image does not ship.
  const db = openAdminWrite(fixture.sitePath('acme'));
  try {
    db.prepare(
      `INSERT INTO cms_asset (key, filename, mime, bytes, sha256, kind, width, height)
       VALUES ('banner/home', 'b.jpg', 'image/jpeg', 10, ?, 'image', 1200, 800)`,
    ).run('ab'.repeat(32));
    db.prepare(
      `INSERT INTO cms_page (path, slug, title, status, template, body_html, body_css, rev, body_sha, managed_by)
       VALUES ('/legacy', 'legacy', 'Legacy', 'draft', 'page', '<div data-gjs-type="carousel"><p>x</p></div>', '', 0, '', 'editor')`,
    ).run();
  } finally {
    db.close();
  }
});

after(async () => {
  if (handle !== undefined) await handle.close();
  if (fixture !== undefined) fixture.cleanup();
});

function admin(path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Res> {
  const options: Parameters<typeof call>[0] = {
    port,
    host: ADMIN_HOST,
    path,
    method: init.method ?? 'GET',
    headers: { cookie: session.cookie, ...init.headers },
  };
  if (init.body !== undefined) options.body = init.body;
  return call(options);
}

test('E1 — the editor page carries the generated palette, in registry order, and the vendored bundle', async () => {
  const res = await admin('/admin/t/acme/editor');
  assert.equal(res.status, 200, res.body);
  assert.match(res.body, /id="gjs"/, 'the canvas mount point');
  assert.match(res.body, /src="\/admin\/t\/acme\/editor\/grapesjs\.js"/);
  assert.match(res.body, /src="\/admin\/t\/acme\/editor\/editor\.js"/);
  assert.match(res.body, /href="\/admin\/t\/acme\/editor\/grapesjs\.css"/);

  const json = /<script type="application\/json" id="skw-editor-boot">([\s\S]*?)<\/script>/.exec(res.body);
  assert.ok(json?.[1] !== undefined, 'the boot payload is a JSON script');
  const boot = JSON.parse(json[1]) as {
    palette: { id: string; label: string; category: string; type: string; content: string }[];
    categories: string[];
    types: { type: string; tagName: string; droppable: boolean }[];
    csrf: string;
  };
  // S8s: the basic elements come first — a page is made of sections and paragraphs before it is
  // made of a hero — and they carry no `data-gjs-type`, because they are ordinary markup. The
  // registry follows in its own order.
  const ids = boot.palette.map((item) => item.id);
  const basic = ids.filter((id) => id.startsWith('basic-'));
  assert.ok(basic.length >= 8, `the basic palette is present: ${basic.length}`);
  assert.deepEqual(ids.slice(0, basic.length), basic, 'the basic elements lead the palette');
  assert.deepEqual(ids.slice(basic.length), palette(registry).map((item) => item.id));
  const registered = boot.palette.slice(basic.length);
  assert.ok(
    registered.every((item) => item.content.includes(`data-gjs-type="${item.type}"`)),
    'every registry block still carries its lock',
  );
  assert.ok(
    boot.palette
      .slice(0, basic.length)
      .every((item) => !item.content.includes('data-gjs-type')),
    'a basic element is plain markup, not a registered component',
  );
  assert.deepEqual(boot.categories.slice(0, 1), ['Basic']);
  assert.deepEqual(boot.categories.slice(1), ['Structure', 'Text', 'Media', 'Commerce', 'Data', 'Interactive']);
  assert.equal(boot.types.length, 10);
  assert.equal(boot.csrf, session.csrfToken, 'the page carries the token the boot script posts');
  // No inline script: the page is data + two external scripts, which is the shape the
  // admin CSP can keep.
  assert.ok(!/<script>(?!<\/script>)/.test(res.body.replace(/<script type="application\/json"[\s\S]*?<\/script>/g, '')), 'no inline script');
});

test('E1b — the editor has a toolbar of its own, and no button is a missing Font Awesome glyph', async () => {
  // The operator's report: "on the wysiwyg editor page, the buttons are not visible". They
  // were GrapesJS's DEFAULT panel buttons, which draw `fa fa-eye`, `fa fa-code`,
  // `fa fa-arrows-alt` … and this repo loads no Font Awesome, so each one painted as an
  // empty 30×30 box. The fix is not a font: the default panels are switched off in the boot
  // script and the four controls the screen needs are drawn as inline SVG here.
  const res = await admin('/admin/t/acme/editor');
  assert.equal(res.status, 200, res.body);

  // Icon-only buttons need an aria-label; text buttons take their name from the label. Both
  // are asserted, because "it has a title attribute" is not an accessible name.
  for (const [id, name] of [
    ['skw-undo', 'Undo'],
    ['skw-redo', 'Redo'],
  ]) {
    assert.match(res.body, new RegExp(`<button[^>]*id="${id}"[^>]*aria-label="${name}"`), `${id} has no aria-label`);
  }
  for (const [id, name] of [
    ['skw-preview', 'Preview'],
    ['skw-save', 'Save'],
    ['skw-publish', 'Publish'],
  ]) {
    const button = new RegExp(`<button[^>]*id="${id}"[^>]*>([\\s\\S]*?)</button>`).exec(res.body);
    assert.ok(button !== null, `${id} is missing`);
    // The label sits beside the icon, inside the button: `…</svg>Preview</button>`.
    assert.match(button[1] as string, new RegExp(`\\b${name}\\b`), `${id} has no visible ${name} label`);
  }
  // Every control carries a drawn icon, not a class that assumes a font.
  assert.equal((res.body.match(/<svg viewBox="0 0 24 24"/g) ?? []).length >= 6, true, 'the icons are inline SVG');
  assert.doesNotMatch(res.body, /class="fa fa-/, 'no Font Awesome class in the toolbar');
  assert.doesNotMatch(res.body, /gjs-pn-btn/, 'GrapesJS panel buttons cannot reappear in the static markup');

  // The default panels are off in the boot script, which is what stops them being created
  // at runtime — a static-markup assertion alone would pass while the empty boxes came back.
  const boot = await admin('/admin/t/acme/editor/editor.js');
  assert.match(boot.body, /panels:\s*\{\s*defaults:\s*\[\s*\]\s*\}/, 'GrapesJS default panels must be disabled');

  // The save button is wired to the same POST the boot script already exposed, and Ctrl+S
  // does not open the browser's save dialog.
  assert.match(boot.body, /window\.skwSave\(\)/);
  // S8b: Save writes a draft and Publish is the request that makes it live. The button and the
  // request it calls are one contract; a toolbar with a Publish that posts to nothing is the
  // defect this line exists to catch.
  assert.match(boot.body, /window\.skwPublish = function \(\)/);
  assert.match(boot.body, /\/editor\/publish/);
  assert.match(boot.body, /addEventListener\('keydown'/);
  assert.match(boot.body, /toLowerCase\(\) === 's'/);
});

test('E2 — the bundle is served from this origin, and it is GrapesJS', async () => {
  const js = await admin('/admin/t/acme/editor/grapesjs.js');
  assert.equal(js.status, 200);
  assert.ok(js.body.length > 100_000, `the bundle is ${js.body.length} B`);
  assert.match(js.body.slice(0, 400), /GrapesJS|grapesjs/i);
  const css = await admin('/admin/t/acme/editor/grapesjs.css');
  assert.equal(css.status, 200);
  assert.ok(css.body.includes('gjs'), 'the editor stylesheet');
  const boot = await admin('/admin/t/acme/editor/editor.js');
  assert.equal(boot.status, 200);
  assert.match(boot.body, /skw-editor-boot/);
});

test('E3 — a page whose body names an unregistered type is refused at load, with the code', async () => {
  const db = openAdminWrite(fixture.sitePath('acme'));
  let id = 0;
  try {
    id = (db.prepare("SELECT id FROM cms_page WHERE path = '/legacy'").get() as { id: number }).id;
  } finally {
    db.close();
  }
  const res = await admin(`/admin/t/acme/editor?page=${id}`);
  assert.equal(res.status, 422, res.body);
  assert.equal(codeOf(res), 'SKW_E_RT_COMPONENT_UNKNOWN');
  const body = res.json as { error: { detail?: { type?: string } } };
  assert.equal((body.error.detail as { type?: string } | undefined)?.type, 'carousel');
});

test('E4 — the save route writes the row and the fixpoint holds through HTTP', async () => {
  const html = '<div class="prose" data-gjs-type="prose"><p data-prop="body">Over the wire.</p></div>';
  const first = await admin('/admin/t/acme/editor/save', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ADMIN_ORIGIN, 'x-csrf-token': session.csrfToken },
    body: JSON.stringify({ path: '/wire', title: 'Wire', template: 'page', html }),
  });
  assert.equal(first.status, 200, first.body);
  const saved = first.json as { id: number; rev: number; bodyHtml: string; bodySha: string; created: boolean };
  assert.equal(saved.created, true);
  assert.match(saved.bodyHtml, /data-gjs-type="prose"/);

  // The row is there, and it holds exactly the bytes the response claimed.
  const db = openAdminWrite(fixture.sitePath('acme'));
  try {
    const row = db.prepare('SELECT body_html, body_sha FROM cms_page WHERE id = ?').get(saved.id) as {
      body_html: string;
      body_sha: string;
    };
    assert.equal(row.body_html, saved.bodyHtml);
    assert.equal(row.body_sha, saved.bodySha);
  } finally {
    db.close();
  }

  // Save the bytes the server returned: the fixpoint, over the wire.
  const second = await admin('/admin/t/acme/editor/save', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ADMIN_ORIGIN, 'x-csrf-token': session.csrfToken },
    body: JSON.stringify({ id: saved.id, path: '/wire', title: 'Wire', template: 'page', html: saved.bodyHtml }),
  });
  assert.equal(second.status, 200, second.body);
  const again = second.json as { rev: number; bodyHtml: string; bodySha: string };
  assert.equal(again.bodyHtml, saved.bodyHtml, 'the second save must equal the first, byte for byte');
  assert.equal(again.bodySha, saved.bodySha);
  assert.equal(again.rev, 1, 'and it is a revision, not a new page');
});

test('E5 — the picker writes a key and never a URL; an unknown key is refused', async () => {
  const list = await admin('/admin/t/acme/editor/media.json');
  assert.equal(list.status, 200);
  const assets = (list.json as { assets: { key: string; previewUrl: string }[] }).assets;
  assert.deepEqual(
    assets.map((a) => a.key),
    ['banner/home'],
  );

  const res = await admin('/admin/t/acme/editor/pick', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ADMIN_ORIGIN, 'x-csrf-token': session.csrfToken },
    body: JSON.stringify({
      html: '<figure class="figure" data-gjs-type="figure"><img data-prop="src" src="/media/banner/old.jpg" alt=""><figcaption data-prop="caption">x</figcaption></figure>',
      type: 'figure',
      prop: 'src',
      field: 'asset',
      key: 'banner/home',
    }),
  });
  assert.equal(res.status, 200, res.body);
  const picked = res.json as { html: string; key: string; previewUrl: string };
  assert.equal(picked.key, 'banner/home');
  assert.match(picked.html, /data-asset-key="banner\/home"/);
  assert.ok(!picked.html.includes('/media/banner/old.jpg'), 'the pick removes the URL it replaced');
  // The preview URL is for the canvas; the document it returns has none.
  assert.match(picked.previewUrl, /^\/media\/banner\/home\.jpg\?v=abababab$/);

  const bad = await admin('/admin/t/acme/editor/pick', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ADMIN_ORIGIN, 'x-csrf-token': session.csrfToken },
    body: JSON.stringify({
      html: '<figure data-gjs-type="figure"><img data-prop="src" alt=""></figure>',
      type: 'figure',
      prop: 'src',
      field: 'asset',
      key: 'nope/missing',
    }),
  });
  assert.equal(bad.status, 409, bad.body);
});

test('E6 — the editor\'s writes are behind D28: no CSRF token, no write', async () => {
  const res = await admin('/admin/t/acme/editor/save', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ADMIN_ORIGIN },
    body: JSON.stringify({ path: '/nocsrf', title: 'No', template: 'page', html: '<p>x</p>' }),
  });
  assert.equal(res.status, 403);
  assert.equal(codeOf(res), 'SKW_E_SEC_CSRF');
  const db = new Database(fixture.sitePath('acme'));
  try {
    const count = db.prepare("SELECT count(*) AS n FROM cms_page WHERE path = '/nocsrf'").get() as { n: number };
    assert.equal(count.n, 0);
  } finally {
    db.close();
  }
  // And the page itself is a session read: no cookie, no page (the row-7 404, not a 401).
  const anonymous = await call({ port, host: ADMIN_HOST, path: '/admin/t/acme/editor' });
  assert.equal(anonymous.status, 404);
});

/** The corpus is the same nine files the fixpoint gate uses; a missing one is a broken repo. */
test('E7 — every fixture page saves over HTTP and reloads to the same bytes', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const pages = readdirSync(join(REPO, 'test', 'fixtures', 'site')).filter((n: string) => n.endsWith('.html')).sort();
  assert.equal(pages.length, 9);
  for (const page of pages) {
    const html = readFileSync(join(REPO, 'test', 'fixtures', 'site', page), 'utf8');
    const res = await admin('/admin/t/acme/editor/save', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ADMIN_ORIGIN, 'x-csrf-token': session.csrfToken },
      body: JSON.stringify({ path: `/corpus/${page.replace('.html', '')}`, title: page, template: 'page', html }),
    });
    assert.equal(res.status, 200, `${page}: ${res.body}`);
    // The stored bytes are a fragment: the save path strips the canvas wrapper, and this
    // route is where the product's editor posts it (S4a F1). E4's input is already a
    // fragment, so only a route-level assertion on the corpus can see the difference.
    const bodyHtml = (res.json as { bodyHtml: string }).bodyHtml;
    assert.ok(!/<body[\s>]/i.test(bodyHtml), `${page}: the stored bytes carry the canvas <body> wrapper`);
  }
});

/**
 * F2(b) — the belt and braces. The save request carries the component inventory the canvas
 * believed it had; the server refuses when the locks in the bytes it is about to store do
 * not match it.
 *
 * This is **redundant with F2(a) for the paste vector** — after the paste gate nothing
 * unregistered ever reaches the canvas — and it is kept for the complementary case: a lock
 * the canvas *does* hold going missing between the model and the bytes (a serialiser bug, a
 * stale tab, a different client sending a stripped document). (a) cannot see that by
 * construction, because it inspects the clipboard and not the document.
 */
test('E8 — the save refuses bytes whose locks disagree with the inventory the canvas sent', async () => {
  const canvas =
    '<section data-gjs-type="hero"><h1 data-prop="title">Hi</h1></section>\n' +
    '<div data-gjs-type="prose"><p data-prop="body">Body</p></div>';
  const send = (html: string, components?: string[]): Promise<Res> =>
    admin('/admin/t/acme/editor/save', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ADMIN_ORIGIN, 'x-csrf-token': session.csrfToken },
      body: JSON.stringify({
        path: `/inventory/${String(components?.length ?? 'none')}-${html.length}`,
        title: 'Inventory',
        template: 'page',
        html,
        ...(components === undefined ? {} : { components }),
      }),
    });

  // The honest payload: the inventory and the bytes agree, so the save is a 200.
  const ok = await send(canvas, ['hero', 'prose']);
  assert.equal(ok.status, 200, ok.body);

  // A lock removed by another route — the document is rewritten between the canvas and the
  // server, and the inventory still names the hero the canvas held.
  const stripped = canvas.replace(' data-gjs-type="hero"', '');
  const missing = await send(stripped, ['hero', 'prose']);
  assert.equal(missing.status, 422, missing.body);
  assert.equal(codeOf(missing), 'SKW_E_RT_COMPONENT_INVENTORY');
  const detail = (missing.json as { error: { detail: Record<string, unknown> } }).error.detail;
  assert.deepEqual(detail['missing'], ['hero'], 'the refusal names what went missing');
  assert.deepEqual(detail['unexpected'], []);

  // The other direction: the bytes hold a component the canvas said it did not have.
  const unexpected = await send(canvas, ['prose']);
  assert.equal(unexpected.status, 422, unexpected.body);
  assert.deepEqual((unexpected.json as { error: { detail: Record<string, unknown> } }).error.detail['unexpected'], ['hero']);

  // A client that sends no inventory is not refused for it: the field is the editor's
  // second pair of eyes, not a new required field on an API other surfaces already post to.
  const without = await send(canvas);
  assert.equal(without.status, 200, without.body);

  const db = openAdminWrite(fixture.sitePath('acme'));
  try {
    const rows = db.prepare("SELECT count(*) AS n FROM cms_page WHERE path LIKE '/inventory/%'").get() as { n: number };
    assert.equal(rows.n, 2, 'only the two payloads that agreed with their inventory were written');
  } finally {
    db.close();
  }
});

/**
 * F2 at the last possible moment: the bytes GrapesJS produces from an unregistered paste.
 *
 * S4a §7.3 measured this exact document being stored with a **200**. The paste gate (a)
 * stops it being created; this asserts that the shape it produces — content, no lock —
 * cannot be written even if it arrives by another road (a stale tab, a second client, a
 * future import that forgets the gate).
 */
test('E9 — component-less bytes (what a degraded paste looks like) are refused, not stored with a 200', async () => {
  const res = await admin('/admin/t/acme/editor/save', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ADMIN_ORIGIN, 'x-csrf-token': session.csrfToken },
    body: JSON.stringify({
      path: '/degraded',
      title: 'Degraded',
      template: 'page',
      html: '<body>\n  <div><p>slides</p></div>\n</body>',
      components: [],
    }),
  });
  assert.equal(res.status, 422, res.body);
  assert.equal(codeOf(res), 'SKW_E_RT_BODY_FORBIDDEN');
  assert.equal((res.json as { error: { detail: Record<string, unknown> } }).error.detail['rule'], 'no-component');
  const db = openAdminWrite(fixture.sitePath('acme'));
  try {
    const count = db.prepare("SELECT count(*) AS n FROM cms_page WHERE path = '/degraded'").get() as { n: number };
    assert.equal(count.n, 0);
  } finally {
    db.close();
  }
});
