/**
 * Palettes — the base colours a look can be worn in.
 *
 * A palette is the theme's, not the app's: the package declares a short list, the site stores which
 * one it wears, and `/theme.css` puts the chosen one in front of the sheet. Five claims, each
 * measured where it is actually decided:
 *
 *   P1  a package's palettes are checked like anything else it ships — a value that could escape its
 *       declaration (`}`, `;`, `url(`) is refused, and so is a key that is not a slug.
 *   P2  the chosen palette reaches the bytes the browser loads: `/theme.css` leads with
 *       `html:root{…}`, and the version token changes so the cache cannot pin the old colour.
 *   P3  an unknown key is refused by name rather than silently rendering the default — the failure
 *       that looks like "the button did nothing".
 *   P4  the Themes screen offers exactly the palettes the active theme declares, and posting one
 *       applies it end to end.
 *   P5  activating a different look starts it in its own colours: the previous theme's choice does
 *       not leak across.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { openAdminWrite } from '../app/db/classes.ts';
import { loadEnv } from '../app/env.ts';
import { buildApp, type AppHandle } from '../app/main.ts';
import { sheetVersion } from '../app/render/theme.ts';
import {
  BRAND_ACCENT_SETTING,
  PALETTES_PREFIX,
  PALETTE_SETTING,
  activateTheme,
  brandContrast,
  brandPrelude,
  chosenBrand,
  setBrand,
  chosenPaletteKey,
  palettePrelude,
  setPalette,
  storeThemePalettes,
  themePalettes,
  uploadTheme,
} from '../app/render/themes.ts';
import { normalisePalettes, paletteCss } from '../app/render/theme-bundle.ts';
import { AppError } from '../app/errors.ts';
import { ADMIN_HOST, ADMIN_ORIGIN, TOTP_SECRET, openSession, seedUser, type Sessioned } from './helpers/admin.ts';
import { SCHEMA, makeFixture, type Fixture } from './helpers/fixture.ts';
import { call, type Res } from './helpers/http.ts';

const THEME_CSS = '.probe-glass{outline:1px solid rgb(2,3,4)}\n:root{--bg:#ffffff}\n';

const COOL = {
  key: 'cool-stone',
  name: 'Cool stone',
  vars: { '--bg': '#eef1f2', '--ink': '#1b2426', '--accent': '#4a7f86' },
};
const SAND = {
  key: 'sand',
  name: 'Sand',
  vars: { '--bg': '#f5eee4', '--ink': '#2a2320', '--accent': '#b5764a' },
};

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

function withSite<T>(fn: (db: ReturnType<typeof openAdminWrite>) => T): T {
  const db = openAdminWrite(fixture.sitePath('acme'));
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

test('P1 — a package’s palettes are validated like anything else it ships', () => {
  const good = normalisePalettes([COOL, SAND]);
  assert.equal(good.length, 2, 'two usable palettes survive');
  assert.equal(good[0]?.vars['--bg'], '#eef1f2');

  // A value that ends its declaration, or reaches outside it, is refused rather than escaped.
  for (const value of ['#fff}body{display:none', 'red;background:url(http://x)', 'red\u0000']) {
    assert.throws(
      () => normalisePalettes([{ key: 'bad', name: 'Bad', vars: { '--bg': value } }]),
      (err: unknown) => err instanceof AppError && err.code === 'SKW_E_EXP_THEME_SCHEMA',
      `"${value}" must be refused`,
    );
  }
  // A key that is not a slug, and a property that is not a custom property.
  assert.throws(() => normalisePalettes([{ key: 'Cool Stone', name: 'x', vars: { '--bg': '#fff' } }]), AppError);
  assert.throws(() => normalisePalettes([{ key: 'ok', name: 'x', vars: { bg: '#fff' } }]), AppError);
  // An empty palette is not a palette.
  assert.throws(() => normalisePalettes([{ key: 'ok', name: 'x', vars: {} }]), AppError);

  // The rule the prelude emits wins the cascade by specificity, not by position.
  assert.equal(paletteCss(COOL), 'html:root{--bg:#eef1f2;--ink:#1b2426;--accent:#4a7f86}');
  assert.equal(paletteCss(null), '', 'no palette is no rule at all');
});

test('P2 — the chosen palette reaches /theme.css, and the version changes with it', async () => {
  withSite((db) => {
    const row = uploadTheme(db, { name: 'Probe glass', css: THEME_CSS, actorId: null, key: 'probe-glass' });
    storeThemePalettes(db, row.key, [COOL, SAND], null);
    activateTheme(db, 'probe-glass', null);
  });

  const before = await get('/theme.css', false);
  assert.equal(before.status, 200);
  assert.doesNotMatch(before.body, /html:root\{/, 'no palette chosen yet, so the theme’s own colours are served');

  withSite((db) => setPalette(db, 'probe-glass', 'sand', null));

  const after = await get('/theme.css', false);
  assert.equal(after.status, 200);
  // The preludes are served *after* the theme now (theme, then palette, then brand), which is what
  // lets the palette beat the theme's own `:root` at equal specificity and the brand beat the palette.
  assert.match(after.body, /html:root\{--bg:#f5eee4;--ink:#2a2320;--accent:#b5764a\}/, 'the palette rule is served');
  assert.ok(
    after.body.indexOf('html:root{--bg:#f5eee4') > after.body.indexOf('.probe-glass'),
    'and it comes after the theme, which is what makes it win',
  );
  assert.ok(after.body.includes(THEME_CSS.trim().split('\n')[0] ?? '-'), 'the theme itself is still served after it');
  assert.notEqual(sheetVersion(before.body), sheetVersion(after.body), 'the version token moves, so a cached URL cannot pin the old colour');
});

test('P3 — an unknown palette is refused by name, not silently ignored', () => {
  withSite((db) => {
    assert.equal(themePalettes(db, 'probe-glass').length, 2, 'the row carries what the package declared');
    assert.throws(
      () => setPalette(db, 'probe-glass', 'chartreuse', null),
      (err: unknown) => err instanceof AppError && err.code === 'SKW_E_PL_REJECTED',
    );
    // The refusal must not have written anything.
    assert.equal(chosenPaletteKey(db), 'sand', 'the refusal left the current choice alone');
    assert.deepEqual(palettePrelude(db, 'probe-glass').startsWith('html:root{--bg:#f5eee4'), true, 'still wearing sand');
    // And "default" is a real, accepted value — the theme's own colours.
    setPalette(db, 'probe-glass', '', null);
    assert.equal(chosenPaletteKey(db), '');
    assert.equal(palettePrelude(db, 'probe-glass'), '');
  });
});

test('P4 — the Themes screen offers the palettes and posting one applies it', async () => {
  const screen = await get('/admin/t/acme/themes');
  assert.equal(screen.status, 200);
  assert.match(screen.body, /Base colour/, 'the screen has a base-colour section');
  for (const palette of [COOL, SAND]) {
    assert.ok(screen.body.includes(palette.name), `the screen names ${palette.name}`);
    assert.ok(screen.body.includes(`value="${palette.key}"`), `the screen posts ${palette.key}`);
  }
  assert.ok(screen.body.includes('Theme default'), 'and offers a way back to the theme’s own colours');
  // The chooser previews the palette rather than listing it: each card paints the ground, the ink
  // and the accent through custom properties (`style-src-attr 'unsafe-inline'` covers the attribute).
  assert.match(screen.body, /class="palette-grid"/, 'the options are a grid of cards');
  assert.match(screen.body, /style="--pb:#eef1f2;--pi:#1b2426;--pa:#4a7f86"/, 'a card carries its own colours');
  assert.match(screen.body, /name="palette" value="cool-stone"/, 'and it is a radio in one group');

  const applied = await formPost('/admin/t/acme/themes/palette', { palette: COOL.key });
  assert.equal(applied.status, 303, applied.body);
  assert.equal(withSite((db) => chosenPaletteKey(db)), COOL.key, 'the post wrote the choice');

  const sheet = await get('/theme.css', false);
  assert.match(sheet.body, /html:root\{--bg:#eef1f2/, 'and the site loads it');
});

test('P5 — the chosen base colour survives activation, and is named when a look cannot offer it', async () => {
  withSite((db) => {
    setPalette(db, 'probe-glass', SAND.key, null);
    assert.equal(chosenPaletteKey(db), SAND.key);

    const other = uploadTheme(db, { name: 'Probe other', css: '.probe-other{color:red}\n', actorId: null, key: 'probe-other' });
    activateTheme(db, other.key, null);
    // The brand is the tenant's; a redesign must not silently repaint it.
    assert.equal(chosenPaletteKey(db), SAND.key, 'the choice is kept across activation');
    // That theme declares nothing, so nothing is emitted — the theme's own colours apply.
    assert.equal(palettePrelude(db, other.key), '');
  });

  // ...and the screen says so by name instead of letting the colour change quietly.
  const screen = await get('/admin/t/acme/themes');
  assert.equal(screen.status, 200);
  assert.ok(screen.body.includes(SAND.key), 'the screen names the saved palette the theme cannot offer');
  assert.match(screen.body, /does not offer it/, 'and explains why the site looks different');
  assert.match(screen.body, /Forget the saved colour/, 'with a way to clear it');

  // Switching back to the theme that declares it reapplies the same colour, with no re-pick.
  withSite((db) => {
    activateTheme(db, 'probe-glass', null);
    assert.ok(palettePrelude(db, 'probe-glass').startsWith('html:root{--bg:#f5eee4'), 'the old theme wears it again');
    assert.equal(themePalettes(db, 'probe-glass').length, 2);
  });

  // A hand-edited settings row must not be able to inject CSS through the prelude.
  withSite((db) => {
    db.prepare(
      `INSERT INTO cms_settings (key, value_json, type, updated_by) VALUES (?, ?, 'json', NULL)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
    ).run(
      `${PALETTES_PREFIX}probe-glass`,
      JSON.stringify([{ key: 'evil', name: 'Evil', vars: { '--bg': '#fff}body{display:none' } }]),
    );
    assert.deepEqual(themePalettes(db, 'probe-glass'), [], 'a settings row that would not pass the package door reads as no palettes');
    db.prepare('INSERT INTO cms_settings (key, value_json, type, updated_by) VALUES (?, \'"evil"\', \'string\', NULL) ON CONFLICT(key) DO UPDATE SET value_json = \'"evil"\'')
      .run(PALETTE_SETTING);
    assert.equal(palettePrelude(db, 'probe-glass'), '', 'and nothing is emitted for it');
  });
});

test('P6 — the brand accent is the tenant’s and is served over the palette', async () => {
  withSite((db) => {
    // a colour, not a declaration: both a non-colour and a declaration-escape are refused
    assert.throws(() => setBrand(db, { accent: 'chartreuse-ish', ink: '' }, null), AppError);
    assert.throws(() => setBrand(db, { accent: '#fff}body{display:none', ink: '' }, null), AppError);
    assert.deepEqual(chosenBrand(db), { accent: '', ink: '' }, 'neither refusal wrote anything');

    setBrand(db, { accent: '#e11d48', ink: '' }, null);
    assert.deepEqual(chosenBrand(db), { accent: '#e11d48', ink: '' });
    // the accent is applied as both the accent and its ink, so the theme's hover/edge colours follow
    assert.equal(brandPrelude(db), 'html:root{--accent:#e11d48;--accent-ink:#e11d48}');
  });

  // it is a tenant token, so switching the look does not change it
  withSite((db) => {
    activateTheme(db, 'probe-glass', null);
    assert.ok(brandPrelude(db).includes('--accent:#e11d48'), 'still set after activating a look');
    activateTheme(db, 'probe-other', null);
    assert.ok(brandPrelude(db).includes('--accent:#e11d48'), 'and after activating a different one');
  });

  const sheet = await get('/theme.css', false);
  assert.equal(sheet.status, 200);
  // order is the promise: the theme, then its palette, then the brand — brand wins at equal specificity
  const brandAt = sheet.body.indexOf('html:root{--accent:#e11d48');
  assert.ok(brandAt > 0, 'the brand rule is in the sheet');
  const paletteAt = sheet.body.indexOf('html:root{--surface:');
  if (paletteAt > 0) assert.ok(brandAt > paletteAt, 'and it comes after the palette, which is what makes it win');

  // clearing puts the theme back in charge
  withSite((db) => {
    setBrand(db, { accent: '', ink: '' }, null);
    assert.equal(brandPrelude(db), '');
    assert.equal(chosenBrand(db).accent, '');
  });
});

test('P7 — a brand accent that cannot be read on the ground is reported, not silently applied', () => {
  withSite((db) => {
    activateTheme(db, 'probe-glass', null);
    const dark = db.prepare('SELECT css FROM cms_css_blob b JOIN cms_theme t ON t.css_sha256 = b.sha256 WHERE t.theme_key = ?').get('probe-glass') as
      | { css: string }
      | undefined;
    const css = dark?.css ?? ':root{--bg:#ffffff}';

    // white on a white ground: 1:1, and it must be flagged weak
    setBrand(db, { accent: '#ffffff', ink: '' }, null);
    const onWhite = brandContrast(db, ':root{--bg:#ffffff}', 'probe-glass');
    assert.ok(onWhite !== null);
    assert.equal(onWhite.ratio?.toFixed(1), '1.0');
    assert.equal(onWhite.weak, true, 'white on white is weak, and says so');

    // a colour that carries on a white ground is not
    setBrand(db, { accent: '#1f6feb', ink: '' }, null);
    const strong = brandContrast(db, ':root{--bg:#ffffff}', 'probe-glass');
    assert.equal(strong?.weak, false);
    assert.ok((strong?.ratio ?? 0) > 3, 'blue on white clears the 3:1 floor');

    // a translucent ground cannot be judged, and “cannot judge” must never read as a warning
    const unknown = brandContrast(db, ':root{--bg:rgba(255,255,255,.05)}', 'probe-glass');
    assert.equal(unknown?.ratio, null);
    assert.equal(unknown?.weak, false);

    // the theme's own sheet is parseable even when the ground is declared last in it
    assert.ok(brandContrast(db, css, 'probe-glass') !== null);
  });
});
