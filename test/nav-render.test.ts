/**
 * `cms_nav` renders — the header and the footer of a tenant site come from rows.
 *
 * Before this slice `cms_nav` existed in the schema (`schema/site.sql`, `ux_nav_pos`)
 * and nothing in `app/` read it: the only occurrence outside the DDL was a comment in
 * `app/assets/url.ts`. A client site therefore had no menu at all, and the admin CRUD
 * form could write rows no renderer would ever show.
 *
 * The contract this file holds:
 *
 *   - a two-level menu renders in `position` order, parent before children, children
 *     in their own `position` order;
 *   - `visible = 0` rows do not render (the column exists and meant nothing before);
 *   - a `page` row whose target is not a published page is **refused by name** — the
 *     error carries the nav row's label and target — because a menu entry that 404s is
 *     a dead link the CMS itself created and could have caught;
 *   - `url` rows are absolute http(s) only, and `asset` rows resolve through the same
 *     `assetUrl()` the page bodies use, so a `javascript:` target or a gated asset
 *     cannot become a menu link.
 */
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { after, before, test } from 'node:test';

import { AppError } from '../app/errors.ts';
import { loadNav } from '../app/render/nav.ts';
import { loadEnv } from '../app/env.ts';
import { buildApp, type AppHandle } from '../app/main.ts';
import { makeFixture, type Fixture } from './helpers/fixture.ts';
import { call } from './helpers/http.ts';

const SHA = (text: string): string => text.padEnd(64, '0').slice(0, 64);

let fixture: Fixture;
let handle: AppHandle;
let port = 0;
let db: Database.Database;

function page(path: string, status = 'published'): void {
  const slug = path === '/' ? 'home' : path.replace(/^\//, '').replace(/\//g, '-');
  db.prepare(
    `INSERT INTO cms_page (path, slug, title, status, template, body_html, published_at)
     VALUES (?, ?, ?, ?, 'page', '<p>x</p>', '2026-01-01T00:00:00.000Z')`,
  ).run(path, slug, path, status);
}

function nav(row: {
  location: string;
  label: string;
  href: string;
  kind?: string;
  position: number;
  parent?: number;
  visible?: number;
}): number {
  const info = db
    .prepare(
      `INSERT INTO cms_nav (location, parent_id, label, href_kind, href_target, position, visible)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(row.location, row.parent ?? null, row.label, row.kind ?? 'page', row.href, row.position, row.visible ?? 1);
  return Number(info.lastInsertRowid);
}

function reset(): void {
  db.exec('DELETE FROM cms_nav');
  db.exec('DELETE FROM cms_page');
}

before(async () => {
  fixture = makeFixture({ specs: [{ key: 'acme', hosts: ['acme.test'], title: 'Acme' }] });
  db = new Database(fixture.sitePath('acme'));
  db.pragma('foreign_keys = ON');
  // The fixture seeds /pricing; the pages the menu points at are this file's own.
  page('/');
  page('/about');
  page('/about/team');
  page('/careers');
  page('/contact');
  // A draft is not a target: a menu entry that 404s is a dead link.
  page('/draft-post', 'draft');

  // Header, deliberately inserted out of order: the render must sort on `position`.
  const company = nav({ location: 'header', label: 'Company', href: '/about', position: 0 });
  nav({ location: 'header', label: 'Team', href: '/about/team', position: 1, parent: company });
  nav({ location: 'header', label: 'Story', href: '/about', position: 0, parent: company });
  nav({ location: 'header', label: 'Careers', href: '/careers', position: 1 });
  nav({ location: 'header', label: 'Contact', href: '/contact', position: 2 });
  nav({ location: 'header', label: 'Hidden', href: '/contact', position: 3, visible: 0 });
  // Footer: an internal page and one off-site link (href_kind='url').
  nav({ location: 'footer', label: 'Privacy', href: 'https://acme.example/privacy', kind: 'url', position: 0 });
  nav({ location: 'footer', label: 'About us', href: '/about', position: 1 });

  handle = await buildApp({ env: loadEnv(fixture.env), contentRoot: `${fixture.dir}/content` });
  await handle.app.listen({ port: 0, host: '127.0.0.1' });
  const address = handle.app.server.address();
  port = typeof address === 'object' && address !== null ? address.port : 0;
});

after(async () => {
  db?.close();
  if (handle !== undefined) await handle.close();
  if (fixture !== undefined) fixture.cleanup();
});

test('loadNav orders top-level and child items by position, and skips invisible rows', () => {
  const tree = loadNav(db);
  assert.deepEqual(
    tree.header.map((i) => i.label),
    ['Company', 'Careers', 'Contact'],
    'top level is position order, and `Hidden` (visible = 1 false) is not rendered',
  );
  assert.deepEqual(
    tree.header[0]?.children.map((i) => i.label),
    ['Story', 'Team'],
    'children are position order, not insertion order',
  );
  assert.deepEqual(
    tree.header[0]?.children.map((i) => i.href),
    ['/about', '/about/team'],
    'a page row renders its path',
  );
  assert.deepEqual(
    tree.footer.map((i) => `${i.label}=${i.href}`),
    ['Privacy=https://acme.example/privacy', 'About us=/about'],
  );
});

test('the served page carries the two-level menu in position order', async () => {
  const res = await call({ port, path: '/', host: 'acme.test' });
  assert.equal(res.status, 200, res.body);
  const html = res.body;
  // S8l: a tenant with menus now gets the styled bar (`class="site-header"`), whether or not it
  // has also set a site name. The point of these two assertions is unchanged — the menu is the
  // shell's, and the body fragment is inserted inside `<main>` — so they accept the class.
  // S8o: the menu's `<ul>` carries `site-menu`, the class the chrome's own stylesheet and every
  // site theme select. It used to be a bare `<ul>`, so those rules matched nothing.
  assert.match(html, /<header class="site-header[^"]*"><nav aria-label="Main"><ul class="site-menu">/, 'the header menu is the shell\'s, not the body\'s');
  assert.match(html, /<footer class="site-footer[^"]*"><nav aria-label="Footer"><ul class="site-menu site-menu--footer">/, 'the footer menu renders');
  const order = ['Company', 'Story', 'Team', 'Careers', 'Contact'].map((label) => {
    const at = html.indexOf(`>${label}</a>`);
    assert.ok(at > 0, `${label} is missing from the rendered menu`);
    return at;
  });
  assert.deepEqual(
    order,
    [...order].sort((a, b) => a - b),
    'parent, its children in their order, then the next top-level item',
  );
  assert.match(html, /<li><a href="\/about">Company<\/a><ul class="site-menu"><li><a href="\/about">Story<\/a><\/li>/, 'the child list is nested inside its parent');
  assert.doesNotMatch(html, />Hidden</, 'an invisible row must not reach the browser');
  assert.match(html, /<a href="https:\/\/acme\.example\/privacy">Privacy<\/a>/);
  // The body is still where it was: the menu is the shell, and the page fragment is
  // inserted by `<main set:html>` exactly as before.
  assert.match(html, /<main><p>x<\/p><\/main>/);
});

test('a menu entry pointing at a missing page is refused by name, not rendered', () => {
  reset();
  page('/');
  nav({ location: 'header', label: 'Careers', href: '/careers', position: 0 });
  assert.throws(
    () => loadNav(db),
    (err: unknown) => {
      assert.ok(err instanceof AppError, 'the refusal is a taxonomy error');
      assert.equal(err.code, 'SKW_E_RT_NAV_TARGET_MISSING');
      assert.match(err.message, /Careers/, 'the refusal names the nav row');
      assert.match(err.message, /\/careers/, 'the refusal names the target');
      return true;
    },
  );
});

test('a menu entry pointing at a draft is refused too — a draft is not a page yet', () => {
  reset();
  page('/');
  page('/draft-post', 'draft');
  nav({ location: 'header', label: 'Coming soon', href: '/draft-post', position: 0 });
  assert.throws(() => loadNav(db), /SKW_E_RT_NAV_TARGET_MISSING|Coming soon/);
});

test('an off-site row must be http(s): `javascript:` is refused by name', () => {
  reset();
  page('/');
  nav({ location: 'header', label: 'Click me', href: 'javascript:alert(1)', kind: 'url', position: 0 });
  assert.throws(
    () => loadNav(db),
    (err: unknown) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.code, 'SKW_E_RT_NAV_HREF_REFUSED');
      assert.match(err.message, /Click me/);
      return true;
    },
  );
});

test('an asset row resolves through assetUrl(), and a gated asset has no link to render', () => {
  reset();
  page('/');
  db.prepare(
    `INSERT INTO cms_asset (key, filename, mime, bytes, sha256, kind, width, height, access_class)
     VALUES ('logo', 'logo.png', 'image/png', 12, ?, 'image', 100, 40, 'public')`,
  ).run(SHA('bytes:logo'));
  db.prepare(
    `INSERT INTO cms_asset (key, filename, mime, bytes, sha256, kind, width, height, access_class)
     VALUES ('paid', 'paid.pdf', 'application/pdf', 12, ?, 'document', NULL, NULL, 'gated')`,
  ).run(SHA('bytes:paid'));
  nav({ location: 'header', label: 'Home', href: 'logo', kind: 'asset', position: 0 });
  const tree = loadNav(db);
  assert.equal(tree.header[0]?.href, `/media/logo.png?v=${SHA('bytes:logo').slice(0, 8)}`);

  reset();
  page('/');
  nav({ location: 'header', label: 'Paid', href: 'paid', kind: 'asset', position: 0 });
  assert.throws(
    () => loadNav(db),
    (err: unknown) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.code, 'SKW_E_RT_NAV_HREF_REFUSED');
      assert.match(err.message, /Paid/);
      return true;
    },
  );
});

test('the served page refuses the dead link instead of rendering it', async () => {
  reset();
  page('/');
  nav({ location: 'header', label: 'Careers', href: '/careers', position: 0 });
  const res = await call({ port, path: '/', host: 'acme.test' });
  assert.notEqual(res.status, 200, 'a menu the CMS cannot resolve is not served as a 200');
  assert.doesNotMatch(res.body, /href="\/careers"/, 'the dead link must not reach the browser');
  assert.doesNotMatch(res.body, />Careers</);
});
