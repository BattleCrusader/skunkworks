/**
 * S8s — themes are rows, stylesheets are files, and the canvas is the site.
 *
 * Three claims, each measured against the running app rather than asserted about it:
 *
 *   1. **A page's CSS is its own file.** It used to travel inside the document as `<style>`, which
 *      the site's policy (`style-src 'self'`, no inline allowance) makes a browser block — the
 *      bytes were in the markup and dead in the browser (E-41). The document now links
 *      `/_css/<sha256>.css` after the site's sheet, and that URL is what the export writes too.
 *   2. **One theme is active.** The active theme is one settings value, so activating the second
 *      theme deactivates the first — not by a rule the app enforces, by shape.
 *   3. **The canvas is the site.** The editor's frame links the site's sheet and the draft's own
 *      CSS, wraps the page in `<main>` and draws the header and footer. The chrome is furniture:
 *      `editor.getHtml()` never sees it, which is what keeps the save payload exactly the page.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';

import { openAdminWrite } from '../app/db/classes.ts';
import { chromeCss, loadChrome } from '../app/render/chrome.ts';
import { siteSheet } from '../app/render/theme.ts';
import { putCssBlob, previewToken, verifyPreviewToken } from '../app/render/themes.ts';
import { loadEnv } from '../app/env.ts';
import { loadRegistry } from '../app/editor/registry.ts';
import { assertPasteAllowed } from '../app/editor/paste.ts';
import { buildApp, type AppHandle } from '../app/main.ts';
import { ADMIN_HOST, ADMIN_ORIGIN, TOTP_SECRET, openSession, seedUser, type Sessioned } from './helpers/admin.ts';
import { REPO, SCHEMA, makeFixture, type Fixture } from './helpers/fixture.ts';
import { call, header, type Res } from './helpers/http.ts';

const PAGE_CSS = '.probe-band{outline:3px solid rgb(1,2,3)}';
const PAGE_CSS_SHA = createHash('sha256').update(PAGE_CSS, 'utf8').digest('hex');
/** A theme that is visibly not the site's own: the marker rule is what the canvas and the page link. */
const THEME_CSS = '.probe-theme{forced-color-adjust:none}\nbody{--probe-theme:1}\n';

let fixture: Fixture;
let handle: AppHandle;
let port = 0;
let session: Sessioned;
/** The probe page's id: the fixture seeds its own pages, so "page 1" is not necessarily ours. */
let probePageId = 0;

function get(path: string, sessioned = true): Promise<Res> {
  return call({ port, path, host: ADMIN_HOST, headers: sessioned ? { cookie: session.cookie } : {} });
}

function post(path: string, fields: Record<string, string>): Promise<Res> {
  return call({
    port,
    path,
    method: 'POST',
    host: ADMIN_HOST,
    headers: {
      origin: ADMIN_ORIGIN,
      'content-type': 'application/x-www-form-urlencoded',
      cookie: session.cookie,
    },
    body: new URLSearchParams({ ...fields, csrf: session.csrfToken }).toString(),
  });
}

/** A multipart body, because the upload door is a browser form and the test should be one too. */
function multipart(
  path: string,
  fields: Record<string, string>,
  file: { name: string; filename: string },
): Promise<Res> {
  const boundary = '----skwtestboundary';
  const parts: string[] = [];
  for (const [name, value] of Object.entries({ ...fields, csrf: session.csrfToken })) {
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
  }
  parts.push(
    `--${boundary}\r\nContent-Disposition: form-data; name="theme"; filename="${file.filename}"\r\n` +
      `Content-Type: text/css\r\n\r\n${file.name}\r\n`,
  );
  parts.push(`--${boundary}--\r\n`);
  return call({
    port,
    path,
    method: 'POST',
    host: ADMIN_HOST,
    headers: {
      origin: ADMIN_ORIGIN,
      'content-type': `multipart/form-data; boundary=${boundary}`,
      cookie: session.cookie,
    },
    body: Buffer.from(parts.join(''), 'utf8'),
  });
}

before(async () => {
  fixture = makeFixture({ specs: [{ key: 'acme', hosts: [ADMIN_HOST], title: 'Acme' }] });
  await seedUser({ controlDb: fixture.controlDb, tenantKey: 'acme', email: 'owner@acme.test', totpSecret: TOTP_SECRET });
  const db = openAdminWrite(fixture.sitePath('acme'));
  try {
    const info = db
      .prepare(
        `INSERT INTO cms_page (path, slug, title, status, template, body_html, body_css, published_at)
         VALUES ('/probe', 'probe', 'Probe', 'published', 'page', '<section class="probe-band"><h1>Probe</h1></section>', ?, '2026-01-01T00:00:00.000Z')`,
      )
      .run(PAGE_CSS);
    probePageId = Number(info.lastInsertRowid);
    // A site with a bar: the sheet is the chrome's rules *plus* the theme, and the order between
    // them is the cascade's — a site restyles its own bar without `!important`.
    db.prepare(
      `INSERT INTO cms_settings (key, value_json, type) VALUES ('site.title', '"Acme"', 'string')`,
    ).run();
    // The blob the document will name. In the product it is written by `savePage`/`publishPage`;
    // here the row is inserted directly, so the file has to be named the same way.
    putCssBlob(db, PAGE_CSS);
  } finally {
    db.close();
  }
  handle = await buildApp({ env: loadEnv(fixture.env) });
  port = await handle.app.listen({ port: 0, host: '127.0.0.1' }).then(() => (handle.app.server.address() as { port: number }).port);
  session = await openSession({ port, key: 'acme', email: 'owner@acme.test' });
});

after(async () => {
  await handle.close();
  fixture.cleanup();
});

test('S8s-1. a page with CSS links its own content-addressed file, after the site sheet', async () => {
  const page = await get('/probe', false);
  assert.equal(page.status, 200);
  assert.match(
    page.body,
    new RegExp(`<link rel="stylesheet" href="/_css/${PAGE_CSS_SHA}\\.css">`),
    'the page must name its stylesheet by its own hash',
  );
  assert.doesNotMatch(page.body, /<style[\s>]/, 'no inline stylesheet: the policy blocks it (E-41)');
  // The page's sheet comes after the site's, so a page rule wins at equal specificity.
  const sheetAt = page.body.indexOf('/theme.css');
  const ownAt = page.body.indexOf(`/_css/${PAGE_CSS_SHA}.css`);
  if (sheetAt !== -1) assert.ok(sheetAt < ownAt, 'page CSS is linked after the site sheet');
});

test('S8s-2. the stylesheet URL serves the bytes, immutably, and refuses anything else', async () => {
  const css = await get(`/_css/${PAGE_CSS_SHA}.css`, false);
  assert.equal(css.status, 200);
  assert.equal(css.body, PAGE_CSS);
  assert.match(String(header(css, 'content-type')), /text\/css/);
  assert.match(String(header(css, 'cache-control')), /immutable/);

  const missing = await get(`/_css/${'0'.repeat(64)}.css`, false);
  assert.equal(missing.status, 404, 'an unknown hash is a 404, not somebody else’s sheet');

  const bad = await get('/_css/theme.css', false);
  assert.equal(bad.status, 400, 'a stylesheet URL is /_css/<sha256>.css and nothing else');
});

test('S8s-3. uploading a theme stores it once and lands on the screen', async () => {
  const up = await multipart('/admin/t/acme/themes/upload', { name: 'Probe look' }, { name: THEME_CSS, filename: 'probe-look.css' });
  assert.equal(up.status, 303, up.body);
  assert.match(String(header(up, 'location')), /result=uploaded/);

  const screen = await get('/admin/t/acme/themes');
  assert.equal(screen.status, 200);
  assert.match(screen.body, /Probe look/);
  assert.match(screen.body, /probe-look/, 'the key is derived from the file name');

  // The same bytes again: a second row, but one blob — content addressing, not a second copy.
  const again = await multipart('/admin/t/acme/themes/upload', { name: 'Probe look' }, { name: THEME_CSS, filename: 'probe-look.css' });
  assert.equal(again.status, 303);
  const db = openAdminWrite(fixture.sitePath('acme'));
  try {
    const blobs = db.prepare('SELECT count(*) AS n FROM cms_css_blob WHERE css = ?').get(THEME_CSS) as { n: number };
    const themes = db.prepare('SELECT count(*) AS n FROM cms_theme').get() as { n: number };
    assert.equal(blobs.n, 1, 'one row for one stylesheet');
    assert.equal(themes.n, 2, 'two themes, and the second got its own key');
  } finally {
    db.close();
  }
});

test('S8s-4. a stylesheet with markup in it is refused, and so is a non-css upload', async () => {
  const markup = await multipart(
    '/admin/t/acme/themes/upload',
    { name: 'Markup' },
    { name: 'a{}</style><script>alert(1)</script>', filename: 'markup.css' },
  );
  assert.equal(markup.status, 303);
  assert.match(String(header(markup, 'location')), /result=markup/);

  const wrongType = await multipart('/admin/t/acme/themes/upload', { name: 'Nope' }, { name: 'a{}', filename: 'theme.txt' });
  assert.equal(wrongType.status, 303);
  assert.match(String(header(wrongType, 'location')), /result=css/);

  const db = openAdminWrite(fixture.sitePath('acme'));
  try {
    const refused = db.prepare(`SELECT count(*) AS n FROM cms_theme WHERE name IN ('Markup','Nope')`).get() as { n: number };
    assert.equal(refused.n, 0);
  } finally {
    db.close();
  }
});

test('S8s-5. one theme is active: activating the second retires the first', async () => {
  const before = await get('/theme.css', false);
  const chromeOnly = (() => {
    const db = openAdminWrite(fixture.sitePath('acme'));
    try {
      return siteSheet({ chrome: loadChrome(db), showChrome: true });
    } finally {
      db.close();
    }
  })();
  assert.equal(before.body, chromeOnly, 'with no theme active the sheet is the chrome’s rules plus the pasted theme');

  const act = await post('/admin/t/acme/themes/activate', { theme: 'probe-look' });
  assert.equal(act.status, 303);

  const db = openAdminWrite(fixture.sitePath('acme'));
  try {
    const pointer = db.prepare(`SELECT value_json FROM cms_settings WHERE key = 'site.theme_key'`).get() as { value_json: string };
    assert.equal(JSON.parse(pointer.value_json), 'probe-look');
    const active = db.prepare(`SELECT count(*) AS n FROM cms_theme WHERE theme_key = 'probe-look'`).get() as { n: number };
    assert.equal(active.n, 1);
  } finally {
    db.close();
  }

  const after = await get('/theme.css', false);
  assert.match(after.body, /--probe-theme:1/, 'the active theme’s bytes are in the site sheet');
  assert.match(after.body, /\.site-header\{/, 'and the chrome’s rules are still first');

  // The active theme cannot be deleted: the refusal is what stops a delete unstyling the site.
  const del = await post('/admin/t/acme/themes/delete', { theme: 'probe-look' });
  assert.equal(del.status, 303);
  assert.match(String(header(del, 'location')), /deactivate/i);
  const db2 = openAdminWrite(fixture.sitePath('acme'));
  try {
    const still = db2.prepare(`SELECT count(*) AS n FROM cms_theme WHERE theme_key = 'probe-look'`).get() as { n: number };
    assert.equal(still.n, 1, 'the active theme survives a delete attempt');
  } finally {
    db2.close();
  }
});

test('S8s-6. a preview renders the real page with a theme that is not active, and only with a token', async () => {
  const key = loadEnv(fixture.env).sessionKey;
  const token = previewToken(key, 'acme', 'probe-look', Date.now());
  assert.equal(verifyPreviewToken(key, token, 'acme', ['probe-look']), 'probe-look', 'the token verifies in isolation');
  const direct = openAdminWrite(fixture.sitePath('acme'));
  let count = -1;
  try {
    count = (direct.prepare('SELECT count(*) AS n FROM cms_theme').get() as { n: number }).n;
  } finally {
    direct.close();
  }
  const screen2 = await get('/admin/t/acme/themes');
  const preview = await get(`/preview-theme?t=${encodeURIComponent(token)}&path=/probe`, false);
  assert.equal(
    preview.status,
    200,
    `preview ${preview.status} dbg=${String(header(preview, 'x-skw-preview-keys'))} rows=${count} screenHas=${/Probe look/.test(screen2.body)}`,
  );
  assert.match(preview.body, /theme=probe-look/, 'the preview page names the theme it is wearing');
  assert.match(preview.body, /class="probe-band"/, 'it is the real page, not a mock');
  assert.match(String(header(preview, 'cache-control')), /no-store/);
  assert.match(String(header(preview, 'x-robots-tag')), /noindex/);

  const forged = await get('/preview-theme?t=1.deadbeef&path=/probe', false);
  assert.equal(forged.status, 404);

  const expired = previewToken(loadEnv(fixture.env).sessionKey, 'acme', 'probe-look', Date.now() - 60 * 60 * 1000);
  const stale = await get(`/preview-theme?t=${encodeURIComponent(expired)}&path=/probe`, false);
  assert.equal(stale.status, 404, 'a token that has expired is not a token');
});

test('S8s-7. the canvas is given the site: sheet, draft CSS, and a frame the save payload never sees', async () => {
  const editor = await get(`/admin/t/acme/editor?page=${probePageId}`);
  assert.equal(editor.status, 200);
  const boot = /<script type="application\/json" id="skw-editor-boot">([\s\S]*?)<\/script>/.exec(editor.body);
  assert.ok(boot !== null, 'the boot payload is in the page');
  const payload = JSON.parse(String(boot[1] ?? '')) as {
    frame: { sheet: string | null; pageCss: string | null; header: string; footer: string; path: string };
  };
  assert.match(String(payload.frame.sheet), /^\/theme\.css\?v=[0-9a-f]{12}$/, 'the site’s own sheet');
  assert.match(String(payload.frame.pageCss), /^\/admin\/t\/acme\/editor\/page\.css\?page=\d+&v=[0-9a-f]{12}$/);
  assert.match(payload.frame.header, /class="site-header/, 'the header the shell draws');
  assert.match(payload.frame.path, /^\//);

  // The furniture is inserted beside the wrapper, never into it: the save payload is the page.
  // The boot script is a served file, not an inline script — the admin policy allows no inline
  // script — so what proves the frame is applied is the file the page loads.
  const bootScript = await get('/admin/t/acme/editor/editor.js');
  assert.equal(bootScript.status, 200);
  assert.match(bootScript.body, /data-skw-frame/);
  assert.match(bootScript.body, /applySiteFrame/);
  assert.match(bootScript.body, /boot\.frame\.sheet/, 'the canvas links the sheet it was given');
  // The page's CSS is a served file linked into the canvas, never a style element in the admin
  // document. The check is anchored on the element's own bytes: a `<style>` elsewhere in the
  // document (the admin chrome's) must not make this pass or fail by accident.
  const styleBodies = [...editor.body.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => String(m[1] ?? ''));
  assert.ok(styleBodies.every((body) => !body.includes('probe-band')), 'the admin document does not carry the page’s CSS');

  // The editor document is the one admin screen that allows inline style: GrapesJS applies every
  // Style Manager rule by inserting a <style> into the canvas iframe, which inherits this policy.
  assert.match(String(header(editor, 'content-security-policy')), /style-src 'self' 'unsafe-inline'/);
});

test('S8s-8. the draft stylesheet is on the admin prefix, behind the session, and never cached', async () => {
  const served = await get(`/admin/t/acme/editor/page.css?page=${probePageId}`);
  assert.equal(served.status, 200);
  assert.equal(served.body, PAGE_CSS);
  assert.match(String(header(served, 'cache-control')), /no-store/);

  const anonymous = await get(`/admin/t/acme/editor/page.css?page=${probePageId}`, false);
  assert.notEqual(anonymous.status, 200, 'a draft is not public');
});

test('S8s-10. the palette carries the basic elements, and the page’s CSS is editable where the page is', async () => {
  const editor = await get(`/admin/t/acme/editor?page=${probePageId}`);
  const boot = /<script type="application\/json" id="skw-editor-boot">([\s\S]*?)<\/script>/.exec(editor.body);
  assert.ok(boot !== null);
  const payload = JSON.parse(String(boot[1] ?? '')) as {
    palette: { id: string; label: string; category: string; kind: string }[];
    css: string;
  };
  const ids = payload.palette.map((item) => item.id);
  for (const id of ['basic-section', 'basic-div', 'basic-h2', 'basic-p', 'basic-columns-3', 'basic-stack', 'basic-table', 'basic-hr']) {
    assert.ok(ids.includes(id), `the palette offers ${id}`);
  }
  const basic = payload.palette.find((item) => item.id === 'basic-div');
  assert.equal(basic?.category, 'Basic');
  assert.equal(basic?.kind, 'element', 'a plain element, not a registry component');

  // The CSS panel: the box on the page and the boot field it is filled from.
  assert.match(editor.body, /<textarea id="skw-css-text"/);
  assert.match(editor.body, /<span>Page CSS<\/span>/);
  assert.equal(payload.css, PAGE_CSS, 'the panel opens on the stylesheet the draft holds');

  const script = await get('/admin/t/acme/editor/editor.js');
  assert.match(script.body, /composeCss/);
  assert.match(script.body, /skw:style-manager/, 'the generated rules travel under a marker, once');
});

test('S8s-11. selecting anything opens the inspector: what it is, what it paints, and the rules that reach it', async () => {
  const editor = await get(`/admin/t/acme/editor?page=${probePageId}`);
  const rail = /<aside id="skw-settings"[\s\S]*?<\/aside>/.exec(editor.body);
  assert.ok(rail !== null, 'the inspector is one rail');
  const html = String(rail[0]);

  // (a) the element's own details — tag/id/classes/attributes, editable in place
  assert.match(html, /id="skw-selection"/);
  assert.match(html, /id="skw-sel-where"/);
  assert.match(html, /id="skw-sel-id"/);
  assert.match(html, /id="skw-sel-classes"/);
  assert.match(html, /id="skw-sel-attrs"/);
  assert.match(html, /id="skw-attr-add"/);

  // (b) what the browser is actually painting, inherited values included
  assert.match(html, /id="skw-computed-list"/);
  assert.match(html, /id="skw-computed-chip"/);

  // (c) the Style Manager, in a container of its own, and the rules that reach the selection
  assert.match(html, /id="skw-styles"/);
  assert.match(html, /id="skw-rules"/);

  // (c2) every card folds, and the selection card can act on the element it describes
  assert.equal((html.match(/data-skw-collapse/g) ?? []).length, 4, 'one fold control per card');
  for (const id of ['skw-el-up', 'skw-el-down', 'skw-el-dup', 'skw-el-del', 'skw-sel-text']) {
    assert.match(html, new RegExp(`id="${id}"`), `the selection card offers ${id}`);
  }

  // (d) the page's stylesheet, in the same rail
  assert.match(html, /id="skw-css"/);
  assert.match(html, /id="skw-css-text"/);

  const script = await get('/admin/t/acme/editor/editor.js');
  const js = script.body;
  assert.match(js, /styleManager: \{ appendTo: '#skw-styles' \}/, 'the manager mounts in its own card');
  // The defect this test exists for: the old selection handler emptied the whole rail, which is
  // the Style Manager's container, and returned early for every element with no registry entry.
  assert.doesNotMatch(js, /skw-settings/, 'the boot script never touches the rail itself');
  {
    // Every innerHTML write is confined to a generated list, never to a container that holds
    // another owner's markup.
    const writes = [...js.matchAll(/([A-Za-z_$][\w$]*)\.innerHTML\s*=\s*''/g)].map((m) => String(m[1]));
    assert.deepEqual(
      [...new Set(writes)].sort(),
      ['computedList', 'rulesList', 'selAttrs', 'selFields'],
      'only generated rows and lists are cleared',
    );
  }
  assert.match(js, /component:selected', inspector\)/, 'the inspector is what a selection calls');
  assert.match(js, /authoredIds/, 'ids the editor invents are told apart from ids in the content');
  assert.match(js, /scrubInventedIds\(\)/, 'and none of them reaches the stored page');

  // The canvas is another document: the rules that draw the insertion marker and the drop outline
  // must arrive there as a stylesheet the CSP allows, not as an inline <style> it would drop.
  assert.match(js, /editor\/canvas\.css/, 'the canvas links its own stylesheet');
  const canvasCss = await get('/admin/t/acme/editor/canvas.css');
  assert.equal(canvasCss.status, 200);
  assert.match(String(header(canvasCss, 'content-type')), /text\/css/);
  assert.match(canvasCss.body, /\.gjs-placeholder-int/);
  assert.match(canvasCss.body, /\[data-skw-drop="1"\]/, 'the element under the pointer is outlined');
  assert.match(js, /renderComputed/, 'the computed values are measured, not assumed');
  assert.match(js, /renderRules/, 'the matching rules are listed');
  assert.match(js, /getComputedStyle/, 'from the canvas itself');
});

test('S8s-12. a palette drag has a drop path of its own, because this build creates no sorter', async () => {
  const script = await get('/admin/t/acme/editor/editor.js');
  const js = script.body;

  // The palette element is the only thing page script can see, so each block carries its id in
  // the attributes BlockView writes onto that element.
  assert.match(js, /data-block-id/, 'blocks are addressable from the DOM');
  assert.match(js, /function blockFromElement/, 'and resolved back to their model');
  assert.match(js, /function canvasDrops/, 'the drop path is ours');

  // dragover must be accepted, or the browser never delivers a drop at all. That is the defect
  // this test exists for: GrapesJS's sorter is never created here (Canvas.getSorter and
  // Blocks.config.getSorter are both undefined), so nothing called preventDefault.
  const dragover = /addEventListener\('dragover'[\s\S]{0,600}?preventDefault\(\)/.exec(js);
  assert.ok(dragover !== null, 'dragover calls preventDefault');
  assert.match(js, /function insertContent/, 'content is placed where the pointer is');
  assert.match(js, /function isBand/, 'a band goes beside a band, never inside one');
  assert.match(js, /function placeElement/, 'and its element is attached, not left detached');
  assert.match(js, /refreshCanvas/, 'the canvas is redrawn from the model after an insert');
});

test('S8s-13. a plain element is content, not an unknown component — on paste and on save', async () => {
  // A copied h1 arrives wearing GrapesJS's own type. That is not a claim on a component; it is
  // how GrapesJS labels every plain element it parses.
  const registry = loadRegistry(SCHEMA);
  assert.doesNotThrow(() => assertPasteAllowed('<h1 data-gjs-type="text">Slides</h1>', registry));
  assert.doesNotThrow(() => assertPasteAllowed('<div data-gjs-type="default"><p>x</p></div>', registry));
  assert.throws(
    () => assertPasteAllowed('<div data-gjs-type="carousel">x</div>', registry),
    (err: unknown) => (err as { code?: string }).code === 'SKW_E_RT_COMPONENT_UNKNOWN',
    'a type nobody defines is still refused',
  );

  // And the same body reaches the save route: 200, stored, without editor plumbing in the bytes.
  const res = await call({
    port,
    path: '/admin/t/acme/editor/save',
    method: 'POST',
    host: ADMIN_HOST,
    headers: { origin: ADMIN_ORIGIN, 'content-type': 'application/json', cookie: session.cookie },
    body: JSON.stringify({
      path: '/plain-elements',
      title: 'Plain elements',
      template: 'page',
      csrf: session.csrfToken,
      html: '<body><section><h1 data-gjs-type="text">Slides</h1><p data-gjs-type="text">Plain.</p></section></body>',
    }),
  });
  assert.equal(res.status, 200, res.body);
  // Read what was actually written, not what the route said about it.
  const db = openAdminWrite(fixture.sitePath('acme'));
  try {
    const row = db.prepare("SELECT body_html AS html FROM cms_page WHERE path = '/plain-elements'").get() as
      | { html: string }
      | undefined;
    assert.ok(row !== undefined, 'the page was stored');
    assert.match(row.html, /<h1>Slides<\/h1>/);
    assert.doesNotMatch(row.html, /data-gjs-type/, 'GrapesJS types are stripped on the way out');
  } finally {
    db.close();
  }
});

test('S8s-9. the theme rows travel in an export, so a bundle arrives wearing its own look', () => {
  const projection = JSON.parse(readFileSync(`${REPO}/schema/export-projection.json`, 'utf8')) as {
    tables: Record<string, { mode: string }>;
  };
  assert.equal(projection.tables['cms_theme']?.mode, 'rows');
  assert.equal(projection.tables['cms_css_blob']?.mode, 'rows');
});
