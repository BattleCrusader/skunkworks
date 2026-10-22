/**
 * S8l — the site has a bar and a footer, and every page wears them.
 *
 * The operator's report: "when I open a blog post, I just see the blog post and nothing about
 * the website I'm visiting." They were right, and not only about posts: **no** page had a
 * header, because `cms_nav` had a reader and no author and there was no way to set a site name
 * at all. `site.db` could have had menu rows since S1 and no screen could create one.
 *
 * So this file drives the new Site screen end to end over a socket: save an identity, add menu
 * rows, and read the rendered HTML of an ordinary page *and* of a page a package draws
 * (`/blog/<slug>`, which is a row in `p_blog_post`, not a `cms_page`) — because the whole point
 * of putting the chrome in the shell is that the second case needs no separate feature.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { packageRootHash } from '../app/plugins/manifest.ts';
import { loadEnv } from '../app/env.ts';
import { buildApp, type AppHandle } from '../app/main.ts';
import { ADMIN_HOST, ADMIN_ORIGIN, TOTP_SECRET, openSession, seedUser, type Sessioned } from './helpers/admin.ts';
import { REPO, makeFixture, type Fixture } from './helpers/fixture.ts';
import { call, type Res } from './helpers/http.ts';

const CLI = join(REPO, 'app', 'cli', 'skwctl.ts');
const BLOG = join(REPO, 'plugins', 'blog');
const RUNNER_DIGEST = 'sha256:s8l-site';

let fixture: Fixture;
let handle: AppHandle;
let port = 0;
let session: Sessioned;

function skwctl(args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    cwd: REPO,
    env: { ...process.env, SKW_DATA_DIR: fixture.dir },
    encoding: 'utf8',
    timeout: 120_000,
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function reportFor(dir: string): string {
  const root = packageRootHash(dir).root;
  const manifest = JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8')) as { id: string; version: string };
  const out = join(fixture.dir, 'reports', `${root.slice(0, 10)}.json`);
  mkdirSync(join(fixture.dir, 'reports'), { recursive: true });
  writeFileSync(
    out,
    JSON.stringify({
      plugin: manifest.id,
      version: manifest.version,
      root_hash: root,
      runner_image_digest: RUNNER_DIGEST,
      ran_at: '2026-10-22T00:00:00.000Z',
      passed: 1,
      failed: 0,
    }),
  );
  return out;
}

function get(path: string): Promise<Res> {
  return call({ port, path, host: ADMIN_HOST, headers: { cookie: session.cookie } });
}

function post(path: string, fields: Record<string, string>): Promise<Res> {
  return call({
    port,
    path,
    method: 'POST',
    host: ADMIN_HOST,
    headers: { origin: ADMIN_ORIGIN, 'content-type': 'application/x-www-form-urlencoded', cookie: session.cookie },
    body: new URLSearchParams({ ...fields, csrf: session.csrfToken }).toString(),
  });
}

/** A visitor's request: no cookie, the tenant's own host. */
function site(path: string): Promise<Res> {
  return call({ port, path, host: 'acme.test' });
}

before(async () => {
  fixture = makeFixture({ specs: [{ key: 'acme', hosts: ['acme.test'] }] });
  await seedUser({ controlDb: fixture.controlDb, tenantKey: 'acme', email: 'owner@acme.test', totpSecret: TOTP_SECRET });
  const installed = skwctl([
    'plugin',
    'install',
    BLOG,
    '--tenant',
    'acme',
    '--allow-unsigned',
    '--test-report',
    reportFor(BLOG),
    '--runner-digest',
    RUNNER_DIGEST,
    '--enable',
  ]);
  assert.equal(installed.status, 0, `install failed: ${installed.stderr}${installed.stdout}`);
  handle = await buildApp({ env: loadEnv(fixture.env) });
  port = await handle.app.listen({ port: 0, host: '127.0.0.1' }).then(() => (handle.app.server.address() as { port: number }).port);
  session = await openSession({ port, key: 'acme', email: 'owner@acme.test' });
});

after(async () => {
  await handle.close();
  fixture.cleanup();
});

test('S8l-1. a tenant with no chrome renders no header and no footer — unchanged bytes', async () => {
  const res = await site('/pricing');
  assert.equal(res.status, 200, res.body);
  assert.doesNotMatch(res.body, /<header/, 'nothing set means nothing drawn');
  assert.doesNotMatch(res.body, /<footer/);
});

test('S8l-2. the Site screen answers and shows the identity form and both menus', async () => {
  const res = await get('/admin/t/acme/site');
  assert.equal(res.status, 200, res.body);
  assert.match(res.body, /<h1>Site<\/h1>/);
  assert.match(res.body, /action="\/admin\/t\/acme\/site\/save"/);
  assert.match(res.body, /action="\/admin\/t\/acme\/site\/nav\/add"/);
  assert.match(res.body, /data-screen="site-header"/);
  assert.match(res.body, /data-screen="site-footer"/);
  // The screen is reachable from the admin nav, not only by typing the path.
  assert.match(res.body, /href="\/admin\/t\/acme\/site"[^>]*>Site</);
});

test('S8l-3. saving the identity puts a sticky bar and a footer sentence on every page', async () => {
  const saved = await post('/admin/t/acme/site/save', {
    title: 'Acme Widgets',
    logo_key: '',
    footer_text: '© 2026 Acme Widgets',
    header_sticky: '1',
  });
  assert.equal(saved.status, 303, saved.body);
  assert.match(String(saved.headers.location), /flash=saved/);

  const home = await site('/pricing');
  assert.equal(home.status, 200, home.body);
  assert.match(home.body, /<header class="site-header site-header--sticky">/, 'the bar is sticky when asked');
  assert.match(home.body, /<a class="site-id" href="\/"><span>Acme Widgets<\/span><\/a>/);
  assert.match(home.body, /<footer class="site-footer">/);
  assert.match(home.body, /<p class="site-footer__text">© 2026 Acme Widgets<\/p>/);
  // S8o: the rules are a linked stylesheet, not an inline `<style>` — the site's CSP is
  // `style-src 'self'`, so inline CSS never reached a browser. The rule still ships with the bar;
  // it ships at /theme.css.
  const barSheet = await site('/theme.css');
  assert.match(barSheet.body, /\.site-header--sticky\{position:sticky;top:0;z-index:20\}/, 'the sticky rule ships with the bar');

  // Every page, not just the home page.
  const other = await site('/pricing');
  assert.equal(other.status, 200, other.body);
  assert.match(other.body, /<span>Acme Widgets<\/span>/);
});

test('S8l-4. a menu row renders as a link in the bar, in position order', async () => {
  const first = await post('/admin/t/acme/site/nav/add', {
    location: 'header',
    label: 'Pricing',
    href_kind: 'page',
    href_target: '/pricing',
  });
  assert.equal(first.status, 303, first.body);
  const second = await post('/admin/t/acme/site/nav/add', {
    location: 'footer',
    label: 'Buy',
    href_kind: 'page',
    href_target: '/pricing',
  });
  assert.equal(second.status, 303, second.body);

  const home = await site('/pricing');
  assert.match(home.body, /<nav aria-label="Main"><ul class="site-menu"><li><a href="\/pricing">Pricing<\/a><\/li><\/ul><\/nav>/);
  assert.match(home.body, /<nav aria-label="Footer"><ul class="site-menu site-menu--footer"><li><a href="\/pricing">Buy<\/a><\/li><\/ul><\/nav>/);
});

test('S8l-5. a blog post — a row in a package table, not a cms_page — wears the same bar', async () => {
  const db = new (await import('better-sqlite3')).default(fixture.sitePath('acme'));
  try {
    db.prepare(
      `INSERT INTO p_blog_post (title, slug, body, status, published_at, created_at)
       VALUES ('Chrome Check', 'chrome-check', 'Hello from a post.', 'published', '2026-10-22', '2026-10-22T00:00:00.000Z')`,
    ).run();
  } finally {
    db.close();
  }
  const post1 = await site('/blog/chrome-check');
  assert.equal(post1.status, 200, post1.body);
  assert.match(post1.body, /<h1>Chrome Check<\/h1>/, 'the post itself');
  assert.match(post1.body, /<header class="site-header site-header--sticky">/, 'and the site around it');
  assert.match(post1.body, /<span>Acme Widgets<\/span>/);
});

test('S8l-5b. a menu entry may point at a path a package serves', async () => {
  // `/blog/<slug>` is a row in `p_blog_post`, not a `cms_page`. Before S8l's nav fix, adding it
  // as a header link was refused as a dead link by a renderer that had never been told a package
  // can serve a path — which is exactly what an operator would try to do first.
  const added = await post('/admin/t/acme/site/nav/add', {
    location: 'header',
    label: 'Blog',
    href_kind: 'page',
    href_target: '/blog/chrome-check',
  });
  assert.equal(added.status, 303, added.body);
  const home = await site('/pricing');
  assert.equal(home.status, 200, home.body);
  assert.match(home.body, /<a href="\/blog\/chrome-check">Blog<\/a>/, 'a package page is a real target');

  // Clean up by the row that carries the label, not by "the first one".
  const page = await get('/admin/t/acme/site');
  const blogId = /data-nav-id="(\d+)"><td>Blog</.exec(page.body)?.[1];
  assert.ok(blogId !== undefined, 'the Blog row must be on the screen');
  const removed = await post('/admin/t/acme/site/nav/delete', { id: blogId });
  assert.equal(removed.status, 303, removed.body);
  assert.doesNotMatch((await site('/pricing')).body, />Blog</, 'and gone from the page');
});

test('S8l-6. hiding a row removes it from the page; deleting removes the row', async () => {
  const page = await get('/admin/t/acme/site');
  const id = /data-nav-id="(\d+)"><td>Pricing</.exec(page.body)?.[1];
  assert.ok(id !== undefined, 'the screen must list the row it just added');

  const hidden = await post('/admin/t/acme/site/nav/visible', { id, visible: '0' });
  assert.equal(hidden.status, 303, hidden.body);
  assert.doesNotMatch((await site('/pricing')).body, /<a href="\/pricing">Pricing<\/a>/, 'a hidden row does not render');

  const shown = await post('/admin/t/acme/site/nav/visible', { id, visible: '1' });
  assert.equal(shown.status, 303, shown.body);
  assert.match((await site('/pricing')).body, /<a href="\/pricing">Pricing<\/a>/);

  const removed = await post('/admin/t/acme/site/nav/delete', { id });
  assert.equal(removed.status, 303, removed.body);
  assert.doesNotMatch((await site('/pricing')).body, /<a href="\/pricing">Pricing<\/a>/);
});

test('S8l-7. a logo key that names no asset is refused, and the title is not lost with it', async () => {
  const res = await post('/admin/t/acme/site/save', {
    title: 'Acme Widgets',
    logo_key: 'brand/missing',
    footer_text: '© 2026 Acme Widgets',
  });
  assert.equal(res.status, 303, res.body);
  assert.match(String(res.headers.location), /flash=logo-missing/);
  const home = await site('/pricing');
  assert.match(home.body, /<span>Acme Widgets<\/span>/, 'the title survived the refusal');
  assert.doesNotMatch(home.body, /class="site-id"[^>]*><img/, 'and no <img> was invented');
});

test('S8l-8. the footer pins only when asked', async () => {
  const on = await post('/admin/t/acme/site/save', {
    title: 'Acme Widgets',
    footer_text: '© 2026 Acme Widgets',
    footer_sticky: '1',
  });
  assert.equal(on.status, 303, on.body);
  const home = await site('/pricing');
  assert.match(home.body, /<footer class="site-footer site-footer--sticky">/);
  // The stylesheet always carries both rules; it is the element's class list that says which
  // switch is on. (Asserting on the raw substring would have matched the CSS.)
  assert.doesNotMatch(home.body, /class="site-header site-header--sticky"/, 'the header switch is independent');
});

test('S8o-7. the site stylesheet is a linked response, because inline <style> is blocked by the CSP', async () => {
  // The defect: the shell used to write the chrome's rules and the page's CSS as inline <style>,
  // and the site's policy is `style-src 'self'` with no inline allowance — so a browser blocked
  // both and every page rendered unstyled while curl and the tests saw the CSS in the markup.
  const save = await post('/admin/t/acme/site/save', {
    title: 'Acme Widgets',
    footer_text: '© 2026 Acme Widgets',
    theme_css: ':root{--brand:#123456}body{font-family:Georgia,serif}',
  });
  assert.equal(save.status, 303, save.body);

  const home = await site('/pricing');
  assert.equal(home.status, 200, home.body);
  assert.match(home.body, /<link rel="stylesheet" href="\/theme\.css">/, 'the page links the sheet');
  // The page has no `body_css` of its own, so there is no inline `<style>` at all: the policy
  // would block one, and the shell only writes it when a page carries CSS.
  assert.doesNotMatch(home.body, /<style[ >]/, 'no inline style element for a page with no CSS');

  const sheet = await site('/theme.css');
  assert.equal(sheet.status, 200);
  assert.match(String(sheet.headers['content-type']), /^text\/css/, 'a browser will not parse anything else as a stylesheet');
  assert.match(sheet.body, /\.site-header\{/, 'the chrome rules travel with it');
  assert.match(sheet.body, /--brand:#123456/, 'and so does the site theme');
  assert.match(sheet.body, /\.site-menu\{/, 'the menu class the chrome stylesheet selects');

  // One conditional request, no body: a returning visitor whose settings have not changed.
  const etag = String(sheet.headers.etag);
  assert.ok(etag.startsWith('"'), 'a strong ETag');
  const again = await call({ port, path: '/theme.css', host: 'acme.test', headers: { 'if-none-match': etag } });
  assert.equal(again.status, 304);
  assert.equal(again.body, '');

  // One sheet per site, whatever page asks for it: the theme is site-wide, and a page's own CSS
  // is inline (see the note in the shell). The same bytes come back for another page's request.
  const again2 = await site('/theme.css');
  assert.equal(again2.body, sheet.body);
});

test('S8o-8. a theme stylesheet with a "<" is refused, and the site keeps the old one', async () => {
  const before = await site('/theme.css');
  const attempt = await post('/admin/t/acme/site/save', {
    title: 'Acme Widgets',
    theme_css: 'body{color:red}</style><script>alert(1)</script>',
  });
  assert.equal(attempt.status, 303, attempt.body);
  assert.match(String(attempt.headers.location), /flash=theme/);
  const after = await site('/theme.css');
  assert.equal(after.body, before.body, 'a refused save writes nothing');
  assert.doesNotMatch(after.body, /alert\(1\)/);
});
