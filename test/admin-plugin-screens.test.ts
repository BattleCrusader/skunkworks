/**
 * S8e — a plugin's screen answers, and the switch has two positions.
 *
 * Two gaps, both visible in the running admin:
 *
 *   1. A loaded package's declarative screen appeared in the menu and answered "no such admin
 *      action" — the admin generated a dead link to itself.
 *   2. `plugins/enable` existed and `plugins/disable` did not, so a package could be switched on
 *      from the screen and only off from a shell.
 *
 * This file drives the whole loop with the real pieces: `skwctl plugin install` on a fixture
 * data directory, then the admin surface over a socket — enable, use the generated screen to
 * create a row, disable, and confirm the screen is gone again. No stubs, no hand-written
 * registry.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { packageRootHash } from '../app/plugins/manifest.ts';

import { ADMIN_HOST, ADMIN_ORIGIN, TOTP_SECRET, openSession, seedUser, type Sessioned } from './helpers/admin.ts';
import { loadEnv } from '../app/env.ts';
import { buildApp, type AppHandle } from '../app/main.ts';
import { REPO, makeFixture, type Fixture } from './helpers/fixture.ts';
import { call, header, type Res } from './helpers/http.ts';

const CLI = join(REPO, 'app', 'cli', 'skwctl.ts');
const BLOG = join(REPO, 'plugins', 'blog');
const CONTACT = join(REPO, 'plugins', 'contact');

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

const RUNNER_DIGEST = 'sha256:s8e-screens';

/**
 * The packager's report (§8.5). A real publishing step runs the package's `plugin.json.tests`
 * inside the test image and writes this next to the package; here it is produced from the
 * package's own bytes, bound to the digest the install is run with, so the install-time gate is
 * exercised rather than bypassed.
 */
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
      ran_at: '2026-10-21T00:00:00.000Z',
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
    headers: {
      origin: ADMIN_ORIGIN,
      'content-type': 'application/x-www-form-urlencoded',
      cookie: session.cookie,
    },
    body: new URLSearchParams({ ...fields, csrf: session.csrfToken }).toString(),
  });
}

before(async () => {
  fixture = makeFixture({ specs: [{ key: 'acme', hosts: [ADMIN_HOST], title: 'Acme' }] });
  await seedUser({ controlDb: fixture.controlDb, tenantKey: 'acme', email: 'owner@acme.test', totpSecret: TOTP_SECRET });

  // The real install path, on a real package: this is what an operator runs.
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
  ]);
  assert.equal(installed.status, 0, `install failed: ${installed.stderr}${installed.stdout}`);

  // S8k: the second shipped package, installed the same way. Its form is what the page builder
  // offers, and its messages screen is what the operator reads.
  const installedContact = skwctl([
    'plugin',
    'install',
    CONTACT,
    '--tenant',
    'acme',
    '--allow-unsigned',
    '--test-report',
    reportFor(CONTACT),
    '--runner-digest',
    RUNNER_DIGEST,
  ]);
  assert.equal(installedContact.status, 0, `contact install failed: ${installedContact.stderr}${installedContact.stdout}`);

  handle = await buildApp({ env: loadEnv(fixture.env) });
  port = await handle.app
    .listen({ port: 0, host: '127.0.0.1' })
    .then(() => (handle.app.server.address() as { port: number }).port);
  session = await openSession({ port, key: 'acme', email: 'owner@acme.test' });
});

after(async () => {
  await handle.close();
  fixture.cleanup();
});

test('S8e-1. an installed but disabled package loads nothing and serves no screen', async () => {
  const plugins = await get('/admin/t/acme/plugins');
  assert.equal(plugins.status, 200, plugins.body);
  assert.match(plugins.body, /data-plugin="blog"/);
  assert.match(plugins.body, /disabled/);

  // Not loaded, so its screen is not a route. The admin must say so in the same words it uses
  // for any unknown action rather than half-rendering a screen over a table that does not exist.
  const screen = await get('/admin/t/acme/blog');
  assert.equal(screen.status, 400, screen.body);
  assert.equal((screen.json as { error?: { code?: string } }).error?.code, 'SKW_E_PLT_REQUEST_INVALID');
});

test('S8e-2. enabling through the screen loads the package and its screen answers', async () => {
  const enabled = await post('/admin/t/acme/plugins/enable', { plugin: 'blog' });
  assert.equal(enabled.status, 303, enabled.body);

  const plugins = await get('/admin/t/acme/plugins');
  assert.match(plugins.body, /enabled, loaded/);
  // The menu lists the screen the package registered…
  assert.match(plugins.body, /href="\/admin\/t\/acme\/blog"/);

  // …and now it answers, over the package's OWN table, drawn by the host.
  const screen = await get('/admin/t/acme/blog');
  assert.equal(screen.status, 200, screen.body);
  assert.match(screen.body, /Blog posts/);
  assert.match(screen.body, /aria-label="Breadcrumb"/);
  assert.match(screen.body, /data-role="rows"/);
  assert.match(screen.body, /p_blog_post|/);
});

test('S8e-3. the generated screen writes a row through the package table', async () => {
  const created = await post('/admin/t/acme/blog', {
    title: 'First post',
    slug: 'first-post',
    body: 'Hello from the blog plugin.',
    status: 'published',
    created_at: '2026-10-21T00:00:00.000Z',
  });
  assert.equal(created.status, 303, created.body);
  const location = String(header(created, 'location'));
  assert.match(location, /\/admin\/t\/acme\/blog\/\d+/);

  const list = await get('/admin/t/acme/blog');
  assert.match(list.body, /First post/);

  const form = await get(location);
  assert.equal(form.status, 200, form.body);
  assert.match(form.body, /name="title"[^>]*value="First post"/);
});

test('S8e-4. disabling unloads it hot: the screen stops answering without a restart', async () => {
  const disabled = await post('/admin/t/acme/plugins/disable', { plugin: 'blog' });
  assert.equal(disabled.status, 303, disabled.body);

  const plugins = await get('/admin/t/acme/plugins');
  assert.match(plugins.body, /disabled/);
  assert.doesNotMatch(plugins.body, /enabled, loaded/);

  const screen = await get('/admin/t/acme/blog');
  assert.equal(screen.status, 400, screen.body);
  assert.equal((screen.json as { error?: { code?: string } }).error?.code, 'SKW_E_PLT_REQUEST_INVALID');

  // The data is the package's, not the runtime's: disabling stops the code, never the rows.
  const enabledAgain = await post('/admin/t/acme/plugins/enable', { plugin: 'blog' });
  assert.equal(enabledAgain.status, 303, enabledAgain.body);
  const list = await get('/admin/t/acme/blog');
  assert.equal(list.status, 200, list.body);
  assert.match(list.body, /First post/, 'a disable/enable cycle must not lose the package data');
});

/**
 * S8g. The complaint was concrete: "creating a new blog post isn't intuitive". It was not — the
 * form was a property sheet of the table's columns, in column order, labelled with their SQL
 * names, each a one-line input, and `created_at TEXT NOT NULL` asked the writer of a post to type
 * an ISO timestamp.
 *
 * The package now declares what a *field* is (`plugin.json` → `tables[].fields`), and the host
 * draws the form from that declaration. This test reads the generated HTML as a person would see
 * it, and then writes a row the way a person would: a title, some prose, a visibility — and no
 * slug and no timestamp at all.
 */
test('S8g-1. the blog form is drawn from the declared fields, not from the table columns', async () => {
  const form = await get('/admin/t/acme/blog/new');
  assert.equal(form.status, 200, form.body);
  assert.match(form.body, /<label for="f_title">Title/, 'the title field is labelled for a person');
  assert.match(form.body, /<label for="f_body">Post/, 'the body is a field called Post');
  assert.match(form.body, /<textarea id="f_body" name="body" rows="18"/, 'prose gets a prose box');
  assert.match(form.body, /<label for="f_status">Visibility/);
  assert.match(form.body, /<select id="f_status" name="status"[^>]*><option value="draft"[^>]*>draft<\/option><option value="published"[^>]*>published<\/option>/);
  // The slug follows the title while typing, and is derived server-side when empty.
  assert.match(form.body, /id="f_slug" name="slug"[^>]*data-slug-from="f_title"/);
  // A column nobody should type: hidden, no label, no asterisk.
  assert.match(form.body, /<input type="hidden" id="f_created_at" name="created_at" value="">/);
  assert.doesNotMatch(form.body, /<label for="f_created_at">/, 'created_at is not a question for the writer');
  assert.doesNotMatch(form.body, /NOT NULL/, 'SQL types are developer detail, not form copy');
  // The form belongs to the package's own screen, not to the Tables section.
  assert.match(form.body, /<form method="post" action="\/admin\/t\/acme\/blog"/);

  // Write a post the way a person does: no slug, no timestamp.
  const created = await post('/admin/t/acme/blog', {
    title: 'Hello From The Admin',
    body: 'A second post, written through the form.',
    status: 'published',
    published_at: '2026-10-22',
  });
  assert.equal(created.status, 303, created.body);
  const location = String(header(created, 'location'));

  const saved = await get(location);
  assert.equal(saved.status, 200, saved.body);
  // Derived from the title by the server, because the form sent it empty.
  assert.match(saved.body, /id="f_slug" name="slug"[^>]*value="hello-from-the-admin"/);
  // Stamped by the server, because the field says `default: "now"`.
  assert.match(saved.body, /<input type="hidden" id="f_created_at" name="created_at" value="\d{4}-\d{2}-\d{2}T/);

  // The list shows what the package said it shows, under its own labels.
  const list = await get('/admin/t/acme/blog');
  assert.match(list.body, /<th>Title<\/th>[\s\S]*<th>Visibility<\/th>[\s\S]*<th>Publish date<\/th>/);
  assert.match(list.body, /Hello From The Admin/);
});

/**
 * S8h. "How do I use the plugins in the WYSIWYG page builder?"
 *
 * The answer has to be a real one or none at all. A package cannot ship canvas markup (§10.5 keeps
 * plugin HTML off the tenant's origin — the same rule that makes an endpoint answer JSON), so the
 * builder gets a **block**: the package names a view over its own table and the host draws it. This
 * test walks the whole path — the palette entry, the marker the editor inserts, and the page a
 * visitor receives — including the two properties that make it safe: a draft is not rendered, and a
 * title with markup in it is escaped.
 */
test('S8m-6. no palette entry makes its own root non-draggable', async () => {
  // Measured in GrapesJS 0.23.8: `ComponentManager.canMove()` parses the block's content and reads
  // THAT component's `draggable`; a false value returns SourceReject, so the sorter never shows the
  // drop line and the drop is refused — with no error anywhere. A `data-gjs-draggable="false"` on a
  // marker root (added once to keep a form's preview inert) is therefore a palette entry that
  // silently cannot be dragged onto a page. Inertness belongs on the preview's children.
  const editor = await get('/admin/t/acme/editor?page=1');
  assert.equal(editor.status, 200, editor.body);
  const boot = /<script type="application\/json" id="skw-editor-boot">([\s\S]*?)<\/script>/.exec(editor.body);
  assert.ok(boot !== null, 'the editor page has no boot payload');
  const payload = JSON.parse((boot[1] as string).replace(/\\u003c/g, '<')) as {
    palette: { label: string; content: string }[];
  };
  for (const item of payload.palette) {
    const root = /^<[^>]+>/.exec(item.content)?.[0] ?? '';
    assert.doesNotMatch(
      root,
      /data-gjs-draggable="false"/,
      `${item.label}: a non-draggable root makes this entry impossible to drop (canMove -> SourceReject)`,
    );
  }
});

test('S8h-1. a plugin block is in the palette, and the page the visitor gets is drawn by the host', async () => {
  // The palette: the editor's boot payload carries the block, with the marker as its content.
  const editor = await get('/admin/t/acme/editor?page=1');
  assert.equal(editor.status, 200, editor.body);
  const boot = /<script type="application\/json" id="skw-editor-boot">([\s\S]*?)<\/script>/.exec(editor.body);
  assert.ok(boot !== null, 'the editor page has no boot payload');
  const payload = JSON.parse((boot[1] as string).replace(/\\u003c/g, '<')) as {
    palette: { label: string; category: string; content: string }[];
  };
  const entry = payload.palette.find((item) => item.label === 'Blog: recent posts');
  assert.ok(entry !== undefined, 'the blog block is not in the palette');
  assert.equal(entry.category, 'Plugins');
  // A plugin block is the front-end's own `list` component, pointed at the package's data — not a
  // second kind of widget with its own look.
  assert.match(entry.content, /data-gjs-type="list"/);
  assert.match(entry.content, /data-source="blog\/recent-posts"/);
  assert.match(entry.content, /data-limit="5"/);
  assert.match(entry.content, /data-repeat/);
  // S8m: the bindings name the *block's* columns, not the blog's. S8h reused the shipped list
  // markup verbatim, which meant every plugin block bound `title`/`slug` — a menu's table has
  // neither, so its block drew "Post title" and linked to a page that did not exist.
  assert.match(entry.content, /data-bind-label="title"/);
  assert.match(entry.content, /data-bind-href-link="slug"/);

  // Two posts: one published with markup in its title, one draft.
  const db = new Database(fixture.sitePath('acme'));
  try {
    const insert = db.prepare(
      `INSERT INTO p_blog_post (title, slug, body, status, published_at, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    insert.run('Published <script>alert(1)</script>', 'published-post', 'body', 'published', '2026-03-01', '2026-03-01T00:00:00.000Z');
    insert.run('Secret draft', 'secret-draft', 'body', 'draft', null, '2026-03-02T00:00:00.000Z');
    // The page an operator would have built by dropping the block into the canvas: the registry's
    // own list component, with the package's source written into it.
    db.prepare("UPDATE cms_page SET body_html = ? WHERE path = '/pricing'").run(
      '<h1>Pricing</h1><div class="list" data-gjs-type="list" data-source="blog/recent-posts" data-limit="5">' +
        '<article class="card" data-repeat><h3 class="card__title" data-bind-title="title">Post title</h3>' +
        '<a class="card__link" data-bind-href-slug="slug" href="/blog/post">Read</a></article>' +
        '<p class="list__empty" data-empty>No posts yet.</p></div>',
    );
  } finally {
    db.close();
  }

  // What a visitor gets. The host drew the list; the package supplied no markup.
  const page = await call({ port, path: '/pricing', host: 'acme.test' });
  assert.equal(page.status, 200, page.body);
  // The site's own component and the site's own CSS — the front-end look, not a plugin's.
  assert.match(page.body, /data-gjs-type="list"/, 'the list component is what renders');
  assert.match(page.body, /class="list"/, "the front-end's own list class, so the site's CSS applies");
  assert.match(page.body, /<article class="card"/, 'the repeat child is cloned from the registry markup');
  assert.match(page.body, /Published &lt;script&gt;/, 'a title is text, not markup');
  assert.doesNotMatch(page.body, /<script>alert\(1\)<\/script>/, 'a title must never become script');
  assert.doesNotMatch(page.body, /Secret draft/, 'a draft is not published by the block');
  assert.match(page.body, /href="\/blog\/published-post"/, 'the link template is filled from the row');
  assert.doesNotMatch(page.body, /data-repeat/, 'the template is replaced by one clone per row');
  assert.doesNotMatch(page.body, /Post title/, 'no placeholder copy survives a resolved block');

  // And a marker nothing claims renders nothing at all — a disabled or uninstalled package.
  const db2 = new Database(fixture.sitePath('acme'));
  try {
    db2.prepare("UPDATE cms_page SET body_html = ? WHERE path = '/pricing'").run(
      '<h1>Pricing</h1><div class="list" data-gjs-type="list" data-source="blog/no-such-block">' +
        '<article class="card" data-repeat><h3 data-bind-title="title">Post title</h3></article>' +
        '<p class="list__empty" data-empty>No posts yet.</p></div><p>after</p>',
    );
  } finally {
    db2.close();
  }
  const orphan = await call({ port, path: '/pricing', host: 'acme.test' });
  assert.equal(orphan.status, 200, 'a source nothing claims must not 500 the page');
  assert.match(orphan.body, /<p>after<\/p>/, 'the rest of the page is untouched');
  // Unresolved: the component is left exactly as authored, placeholder copy included — the
  // operator sees in the page what the canvas showed them.
  assert.match(orphan.body, /Post title/);
});

/**
 * S8i. "If a plugin is enabled and it has its own gui/forms, you should be able to access it through
 * a sub-menu under the plugins menu."
 *
 * Before this, a package's screens were a flat list at the bottom of the Plugins page and a bare
 * link, so an operator had to know the path. The sub-menu groups them by package, and the package's
 * own row in the table carries the same links.
 */
test('S8i-1. the Plugins screen has a sub-menu of each loaded package\'s own screens', async () => {
  const plugins = await get('/admin/t/acme/plugins');
  assert.equal(plugins.status, 200, plugins.body);
  assert.match(plugins.body, /<nav class="subnav" aria-label="Plugin screens">/);
  // Grouped by package, with the screen's own title as the link text.
  assert.match(plugins.body, /<span class="subnav__group">blog<\/span><ul><li><a href="\/admin\/t\/acme\/blog">Blog posts<\/a><\/li><\/ul>/);
  // And the same entry beside the package's row, so it is reachable from where a package is managed.
  assert.match(plugins.body, /data-plugin="blog"[\s\S]*?<a class="btn btn--sm" href="\/admin\/t\/acme\/blog">Blog posts<\/a>/);

  // A disabled package has no screen and no sub-menu entry: `loaded` is the only list this reads.
  assert.equal((await post('/admin/t/acme/plugins/disable', { plugin: 'blog' })).status, 303);
  const off = await get('/admin/t/acme/plugins');
  assert.doesNotMatch(off.body, /subnav__group">blog/);
  assert.doesNotMatch(off.body, /href="\/admin\/t\/acme\/blog"/);

  // The editor palette follows the same rule: no loaded package, no block.
  const editor = await get('/admin/t/acme/editor?page=1');
  assert.doesNotMatch(editor.body, /data-source="blog\/recent-posts"/);

  // Back on for the rest of the file.
  assert.equal((await post('/admin/t/acme/plugins/enable', { plugin: 'blog' })).status, 303);
});

/**
 * S8k. Two things a visitor met: a post link that answered 404, and a contact plugin with no form.
 *
 * `/blog/test` failed because a post is a row in `p_blog_post` and this CMS serves `cms_page` rows
 * by path. The package now declares the *shape* of a post page and the host renders it. And the
 * contact package declares a form the host draws, posts to the page's own URL, and forwards to the
 * JSON endpoint — so a visitor gets a page back, not `{"ok":true}`.
 */
test('S8k-1. a published post has a page at its slug, and a draft does not', async () => {
  const db = new Database(fixture.sitePath('acme'));
  try {
    db.prepare('DELETE FROM p_blog_post').run();
    db.prepare(
      `INSERT INTO p_blog_post (title, slug, body, status, published_at, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('A post <b>with</b> markup', 'a-post', 'First line.\n\nSecond paragraph.', 'published', '2026-04-01', '2026-04-01T00:00:00.000Z');
    db.prepare(
      `INSERT INTO p_blog_post (title, slug, body, status, published_at, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('Still a draft', 'still-a-draft', 'Not ready.', 'draft', null, '2026-04-02T00:00:00.000Z');
  } finally {
    db.close();
  }

  const page = await call({ port, path: '/blog/a-post', host: 'acme.test' });
  assert.equal(page.status, 200, page.body);
  assert.match(page.body, /<h1>A post &lt;b&gt;with&lt;\/b&gt; markup<\/h1>/, 'the title is text');
  assert.match(page.body, /<p>First line\.<\/p>/, 'blank lines separate paragraphs');
  assert.match(page.body, /<p>Second paragraph\.<\/p>/);

  // A draft is not published by its own page either.
  const draft = await call({ port, path: '/blog/still-a-draft', host: 'acme.test' });
  assert.equal(draft.status, 404);
  assert.equal((draft.json as { error?: { code?: string } }).error?.code, 'SKW_E_RT_PAGE_NOT_FOUND');

  // A slug nothing has is the same 404.
  assert.equal((await call({ port, path: '/blog/no-such-post', host: 'acme.test' })).status, 404);
});

test('S8k-2. the contact form is drawn by the host, and a submit lands a row', async () => {
  // Installed is not enabled: the package must be loaded before its form exists (S8i's rule).
  assert.equal((await post('/admin/t/acme/plugins/enable', { plugin: 'contact' })).status, 303);

  const db = new Database(fixture.sitePath('acme'));
  try {
    db.prepare("UPDATE cms_page SET body_html = ? WHERE path = '/pricing'").run(
      '<h1>Contact</h1><div data-skw-form="contact/contact"></div>',
    );
  } finally {
    db.close();
  }

  const form = await call({ port, path: '/pricing', host: 'acme.test' });
  assert.equal(form.status, 200, form.body);
  // Attributes come back in the canonical order, so match the parts, not a spelling.
  assert.match(form.body, /<form[^>]*method="post"/, 'a real form, posted to this page');
  assert.match(form.body, /<input[^>]*name="name"/);
  assert.match(form.body, /<input[^>]*name="email"[^>]*type="email"/);
  assert.match(form.body, /<textarea[^>]*name="message"/);
  assert.match(form.body, /<input[^>]*name="_skw_form"[^>]*value="contact\/contact"/);

  const submitted = await call({
    port,
    path: '/pricing',
    method: 'POST',
    host: 'acme.test',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      _skw_form: 'contact/contact',
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      message: 'Hello from the page.',
    }).toString(),
  });
  assert.equal(submitted.status, 303, submitted.body);
  assert.equal(header(submitted, 'location'), '/pricing?sent=1');

  // The visitor is owed a page, not JSON.
  const thanks = await call({ port, path: '/pricing?sent=1', host: 'acme.test' });
  assert.equal(thanks.status, 200, thanks.body);
  assert.match(thanks.body, /your message is on its way/i);
  assert.doesNotMatch(thanks.body, /<input[^>]*name="name"/, 'the form is replaced by the thanks line');

  const db2 = new Database(fixture.sitePath('acme'));
  try {
    const row = db2.prepare("SELECT name, email, message, status FROM p_contact_message WHERE email = 'ada@example.com'").get() as
      | { name: string; message: string; status: string }
      | undefined;
    assert.ok(row !== undefined, 'the submit wrote no row');
    assert.equal(row.name, 'Ada Lovelace');
    assert.equal(row.message, 'Hello from the page.');
    assert.equal(row.status, 'new');
  } finally {
    db2.close();
  }

  // A refused submit comes back as the page with one sentence, and writes nothing.
  const bad = await call({
    port,
    path: '/pricing',
    method: 'POST',
    host: 'acme.test',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _skw_form: 'contact/contact', name: 'x', email: 'not-an-email', message: '' }).toString(),
  });
  assert.equal(bad.status, 303);
  assert.equal(header(bad, 'location'), '/pricing?form_error=1');
  const errorPage = await call({ port, path: '/pricing?form_error=1', host: 'acme.test' });
  assert.match(errorPage.body, /That did not send/);
  assert.match(errorPage.body, /name="name"/, 'the form is back for another try');
});
