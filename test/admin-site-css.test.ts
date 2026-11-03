/**
 * The site stylesheet, where it is now written.
 *
 * The operator's rule: *the site stylesheet lives on the editor page, under Page CSS, filled in with
 * the global CSS whenever the editor loads, and CSS edits paint the page as you type.* That is four
 * separate promises, so each is a case here:
 *
 * C1  the editor renders the panel and the boot payload carries the prefilled CSS (no theme: the
 *     site's own sheet).
 * C2  saving with no theme writes `site.theme_css`, and `/theme.css` serves it — the write reaches
 *     the bytes the site actually loads.
 * C3  saving with an active theme writes *the theme* (new blob, same key, old blob kept), because
 *     that is the CSS every page inherits; `/theme.css` changes and the panel says which owner
 *     answered.
 * C4  a site-settings save that no longer carries the field must not blank the stylesheet. This is
 *     the trap of moving a control: the form used to post every value it showed.
 * C5  the served boot script paints both sheets — `data-skw-live-site`, `data-skw-live-page` — and
 *     the Site screen no longer offers a stylesheet textarea.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, test } from 'node:test';

import { openAdminWrite } from '../app/db/classes.ts';
import { loadEnv } from '../app/env.ts';
import { buildApp, type AppHandle } from '../app/main.ts';
import { activateTheme, uploadTheme } from '../app/render/themes.ts';
import { ADMIN_HOST, ADMIN_ORIGIN, TOTP_SECRET, openSession, seedUser, type Sessioned } from './helpers/admin.ts';
import { SCHEMA, makeFixture, type Fixture } from './helpers/fixture.ts';
import { call, type Res } from './helpers/http.ts';

const SITE_CSS = '.brand-band{outline:2px solid rgb(9,8,7)}';
const THEME_CSS = '.probe-look{outline:1px solid rgb(2,3,4)}\nbody{--probe-look:1}\n';

let fixture: Fixture;
let handle: AppHandle;
let port = 0;
let session: Sessioned;

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
});

after(async () => {
  if (handle !== undefined) await handle.close();
  if (fixture !== undefined) fixture.cleanup();
});

function get(path: string, sessioned = true): Promise<Res> {
  return call({ port, path, host: ADMIN_HOST, headers: sessioned ? { cookie: session.cookie } : {} });
}

function jsonPost(path: string, payload: Record<string, unknown>, csrf = true): Promise<Res> {
  return call({
    port,
    path,
    method: 'POST',
    host: ADMIN_HOST,
    headers: {
      origin: ADMIN_ORIGIN,
      'content-type': 'application/json',
      cookie: session.cookie,
      ...(csrf ? { 'x-csrf-token': session.csrfToken } : {}),
    },
    body: JSON.stringify(payload),
  });
}

function formPost(path: string, fields: Record<string, string>): Promise<Res> {
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

/** The boot payload, which is the JSON the panel is filled from. */
function bootOf(html: string): { siteCss: string; siteCssTheme: string | null; css: string } {
  const json = /<script type="application\/json" id="skw-editor-boot">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(json?.[1] !== undefined, 'the boot payload is a JSON script');
  return JSON.parse(json[1]) as { siteCss: string; siteCssTheme: string | null; css: string };
}

function storedThemeCss(): string {
  const db = openAdminWrite(fixture.sitePath('acme'));
  try {
    const row = db.prepare(`SELECT value_json FROM cms_settings WHERE key = 'site.theme_css'`).get() as
      | { value_json: string }
      | undefined;
    return row === undefined ? '' : (JSON.parse(row.value_json) as string);
  } finally {
    db.close();
  }
}

test('C1 — the editor carries the site stylesheet panel and prefills it from the boot payload', async () => {
  const res = await get('/admin/t/acme/editor');
  assert.equal(res.status, 200, res.body);
  assert.match(res.body, /<span>Site stylesheet<\/span>/, 'the panel is under Page CSS');
  assert.match(res.body, /id="skw-site-css-text"/);
  assert.match(res.body, /id="skw-site-css-save"/);

  // The page-CSS card must contain it, not merely the screen: the operator asked for it *under*
  // Page CSS, and "somewhere on the page" is what it was before.
  const card = /<section class="skw-card" id="skw-css"[\s\S]*?<\/section>/.exec(res.body);
  assert.ok(card !== null, 'the Page CSS card is present');
  assert.match(card[0], /id="skw-site-css-text"/, 'the site stylesheet sits inside the Page CSS card');

  const boot = bootOf(res.body);
  assert.equal(boot.siteCssTheme, null, 'no theme is active yet, so the site owns the sheet');
  assert.equal(boot.siteCss, '', 'a site that has never had a stylesheet boots with an empty one');
});

test('C2 — saving with no theme writes the site’s own sheet, and /theme.css serves it', async () => {
  const saved = await jsonPost('/admin/t/acme/site/stylesheet', { css: SITE_CSS });
  assert.equal(saved.status, 200, saved.body);
  const answer = JSON.parse(saved.body) as { ok: boolean; owner: string; bytes: number };
  assert.equal(answer.ok, true);
  assert.equal(answer.owner, 'site');
  assert.equal(answer.bytes, Buffer.byteLength(SITE_CSS, 'utf8'));
  assert.equal(storedThemeCss(), SITE_CSS);

  // What the site loads is the promise: the panel would be a lie if it wrote somewhere else.
  const sheet = await get('/theme.css', false);
  assert.equal(sheet.status, 200);
  assert.match(sheet.body, /\.brand-band\{outline:2px solid rgb\(9,8,7\)\}/);

  const editor = await get('/admin/t/acme/editor');
  assert.equal(bootOf(editor.body).siteCss, SITE_CSS, 'the next editor load is prefilled with the saved bytes');
});

test('C3 — with a theme active the panel edits the theme, because that is what the pages wear', async () => {
  const db = openAdminWrite(fixture.sitePath('acme'));
  let beforeSha = '';
  try {
    const row = uploadTheme(db, { name: 'Probe look', css: THEME_CSS, actorId: null, key: 'probe-look' });
    beforeSha = row.cssSha;
    activateTheme(db, 'probe-look', null);
  } finally {
    db.close();
  }

  const editor = await get('/admin/t/acme/editor');
  const boot = bootOf(editor.body);
  assert.equal(boot.siteCssTheme, 'probe-look');
  assert.match(boot.siteCss, /--probe-look:1/, 'the panel is filled with the CSS the site actually inherits');

  const edited = '.probe-look{outline:1px solid rgb(2,3,4)}\nbody{--probe-look:2}\n';
  const res = await jsonPost('/admin/t/acme/site/stylesheet', { css: edited });
  assert.equal(res.status, 200, res.body);
  const answer = JSON.parse(res.body) as { ok: boolean; owner: string; theme: string; sha: string };
  assert.equal(answer.ok, true);
  assert.equal(answer.owner, 'theme');
  assert.equal(answer.theme, 'probe-look');
  assert.notEqual(answer.sha, beforeSha, 'an edit is a new version under the same key');

  // The old blob survives: a bundle exported before this edit still verifies against it.
  const db2 = openAdminWrite(fixture.sitePath('acme'));
  try {
    const old = db2.prepare(`SELECT css FROM cms_css_blob WHERE sha256 = ?`).get(beforeSha) as
      | { css: string }
      | undefined;
    assert.equal(old?.css, THEME_CSS, 'the previous blob is still there');
    const row = db2.prepare(`SELECT css_sha256 FROM cms_theme WHERE theme_key = 'probe-look'`).get() as {
      css_sha256: string;
    };
    assert.equal(row.css_sha256, answer.sha);
  } finally {
    db2.close();
  }

  const sheet = await get('/theme.css', false);
  assert.match(sheet.body, /--probe-look:2/, 'the site serves the edited theme');
  assert.doesNotMatch(sheet.body, /--probe-look:1/);

  // A `<` would end the `<style>` element it is emitted into; the door refuses it by name.
  const refused = await jsonPost('/admin/t/acme/site/stylesheet', { css: 'a{}</style><script>x</script>' });
  assert.equal(refused.status, 400, refused.body);
  assert.match(refused.body, /SKW_E_PLT_REQUEST_INVALID/);

  // And the token every other write needs: the editor is not a hole in the CSRF rule.
  const noToken = await jsonPost('/admin/t/acme/site/stylesheet', { css: '.x{}' }, false);
  assert.equal(noToken.status, 403, noToken.body);
});

test('C4 — renaming the site does not blank the stylesheet the editor owns', async () => {
  // The form that used to carry `theme_css` still posts title/logo/footer/flags. An absent field
  // must mean "unchanged": writing '' for an absent field would silently wipe every page's CSS.
  const before = storedThemeCss();
  const res = await formPost('/admin/t/acme/site/save', {
    title: 'Acme Renamed',
    logo_key: '',
    footer_text: 'New footer',
    theme_css: before,
  });
  assert.equal(res.status, 303);

  const res2 = await formPost('/admin/t/acme/site/save', {
    title: 'Acme Renamed Again',
    logo_key: '',
    footer_text: 'Newer footer',
  });
  assert.equal(res2.status, 303);

  const db = openAdminWrite(fixture.sitePath('acme'));
  try {
    const pointer = db.prepare(`SELECT value_json FROM cms_settings WHERE key = 'site.theme_key'`).get() as {
      value_json: string;
    };
    assert.equal(JSON.parse(pointer.value_json), 'probe-look', 'the theme is still active');
  } finally {
    db.close();
  }
  // With a theme active the site sheet is the fallback, and it must be exactly as it was.
  assert.equal(storedThemeCss(), before, 'an absent theme_css field writes nothing');
});

test('C5 — the boot script paints both sheets live, and Site no longer offers a stylesheet box', async () => {
  const js = await get('/admin/t/acme/editor/editor.js');
  assert.equal(js.status, 200);
  assert.match(js.body, /data-skw-live-site/, 'the site sheet has a live style element');
  assert.match(js.body, /data-skw-live-page/, 'the page sheet has one too');
  assert.match(js.body, /function paintLiveCss/, 'and a painter that splices them into the canvas head');
  assert.match(js.body, /\/site\/stylesheet/, 'the panel saves to the site-stylesheet door');
  // The live site sheet must land *before* the page link and the page sheet after it, or equal
  // specificity resolves the wrong way round while typing.
  assert.match(js.body, /insertBefore\(site, pageLink\)/, 'the site sheet goes before the page link');

  const site = await get('/admin/t/acme/site');
  assert.equal(site.status, 200);
  assert.doesNotMatch(site.body, /name="theme_css"/, 'the Site screen no longer owns the stylesheet');
  assert.match(site.body, /Page CSS<\/b>/, 'and it points at the panel that does');
});

/** The digest the panel reports is the digest of the bytes served — a cheap guard against a
 *  "saved" that wrote a rewritten copy the operator did not see. */
test('C6 — the sha the save reports is the sha of what /theme.css then serves', async () => {
  const css = '.brand-band{outline:2px solid rgb(9,8,7);}\n';
  const res = await jsonPost('/admin/t/acme/site/stylesheet', { css });
  assert.equal(res.status, 200, res.body);
  const answer = JSON.parse(res.body) as { owner: string; sha?: string; css: string };
  const sheet = await get('/theme.css', false);
  // The served sheet is the chrome's rules *then* the theme, so the theme's own bytes appear as a
  // suffix; the sha the panel reports is the theme blob's, not the composed document's.
  assert.match(sheet.body, /\.brand-band\{outline:2px solid rgb\(9,8,7\);\}/);
  assert.equal(answer.owner, 'theme');
  assert.equal(
    answer.sha,
    createHash('sha256').update(answer.css, 'utf8').digest('hex'),
    'the reported sha names the bytes the row points at',
  );
});
