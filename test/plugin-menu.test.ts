/**
 * S8m — the menu package, and the block that puts it on a page.
 *
 * A menu on a page is not the site's header: `cms_nav` is one menu on every page, authored on
 * the Site screen. This package is the *other* kind — a menu an editor drops on one page, with
 * its own rows in its own table.
 *
 * What this file proves, through the real install path and a real render:
 *
 *   1. the package installs, enables and declares two blocks (`menu-main`, `menu-footer`);
 *   2. a page whose body carries `data-source="menu/menu-main"` renders a `<ul>` of links in
 *      `position` order;
 *   3. `visible = 0` rows and the other menu's rows are absent — two conditions, both required;
 *   4. an `href` that is not a site path or an `http(s)` URL (`javascript:`) renders as text
 *      with no `href` at all, rather than as a live dead link;
 *   5. `GET /_plugin/menu/items` answers the same rows as JSON.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
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
const MENU = join(REPO, 'plugins', 'menu');
const RUNNER_DIGEST = 'sha256:s8m-menu';

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

/**
 * The block marker exactly as the palette inserts it — read out of the **editor's own boot
 * payload**, not retyped here. A previous version of this helper reproduced the markup from
 * the registry's shipped `list` component, which is how the S8h defect (blog-shaped bindings
 * on every plugin block) went unnoticed: the test agreed with the bug.
 */
async function paletteMarker(label: string): Promise<string> {
  const res = await get('/admin/t/acme/editor?page=1');
  assert.equal(res.status, 200, res.body);
  const boot = /<script[^>]*id="skw-editor-boot"[^>]*>([\s\S]*?)<\/script>/.exec(res.body)?.[1];
  assert.ok(boot !== undefined, 'the editor page must carry its boot payload');
  const payload = JSON.parse(boot) as { palette: { label: string; content: string }[] };
  const entry = payload.palette.find((item) => item.label === label);
  assert.ok(entry !== undefined, `the palette must offer ${label}; it offers ${payload.palette.map((p) => p.label).join(', ')}`);
  return entry.content;
}

function row(fields: {
  menu: string;
  label: string;
  href: string;
  position: number;
  visible?: number;
}): void {
  const db = new Database(fixture.sitePath('acme'));
  try {
    db.prepare(
      `INSERT INTO p_menu_item (menu, label, href, position, visible, created_at)
       VALUES (?, ?, ?, ?, ?, '2026-10-22T00:00:00.000Z')`,
    ).run(fields.menu, fields.label, fields.href, fields.position, fields.visible ?? 1);
  } finally {
    db.close();
  }
}

function publishPage(path: string, bodyHtml: string): void {
  const db = new Database(fixture.sitePath('acme'));
  try {
    db.prepare(
      `INSERT INTO cms_page (path, slug, title, status, template, body_html, published_at)
       VALUES (?, ?, 'Menu page', 'published', 'page', ?, '2026-10-22T00:00:00.000Z')`,
    ).run(path, path.slice(1), bodyHtml);
  } finally {
    db.close();
  }
}

before(async () => {
  fixture = makeFixture({ specs: [{ key: 'acme', hosts: ['acme.test'] }] });
  await seedUser({ controlDb: fixture.controlDb, tenantKey: 'acme', email: 'owner@acme.test', totpSecret: TOTP_SECRET });
  const installed = skwctl([
    'plugin',
    'install',
    MENU,
    '--tenant',
    'acme',
    '--allow-unsigned',
    '--test-report',
    reportFor(MENU),
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

test('S8m-1. the package installs, and its two blocks and one screen are live', async () => {
  const res = await get('/admin/t/acme/plugins');
  assert.equal(res.status, 200, res.body);
  assert.match(res.body, /menu@1\.0\.0/, 'the installed row names the package');
  // The screen is reachable from the admin surface, which is what makes the rows authorable.
  const screen = await get('/admin/t/acme/menus');
  assert.equal(screen.status, 200, screen.body);
  assert.match(screen.body, /<h1>Menus<\/h1>/);
});

test('S8m-2. a page bearing the menu block renders links in position order', async () => {
  row({ menu: 'main', label: 'Second', href: '/pricing', position: 2 });
  row({ menu: 'main', label: 'First', href: '/pricing', position: 1 });
  publishPage('/menu-demo', await paletteMarker('Menu'));

  const res = await call({ port, path: '/menu-demo', host: 'acme.test' });
  assert.equal(res.status, 200, res.body);
  const ul = /<ul[^>]*>(.*?)<\/ul>/s.exec(res.body)?.[1] ?? '';
  assert.match(ul, /<li[^>]*><a[^>]*href="\/pricing"[^>]*>First<\/a><\/li>/, `the row the package ordered first; got ${ul}`);
  assert.ok(ul.indexOf('First') < ul.indexOf('Second'), `position order, got: ${ul}`);
});

test('S8m-3. a hidden row and the other menu do not appear', async () => {
  row({ menu: 'main', label: 'Ghost', href: '/pricing', position: 3, visible: 0 });
  row({ menu: 'footer', label: 'Elsewhere', href: '/pricing', position: 4 });

  const res = await call({ port, path: '/menu-demo', host: 'acme.test' });
  assert.equal(res.status, 200, res.body);
  assert.doesNotMatch(res.body, /Ghost/, 'visible = 0 is not rendered');
  assert.doesNotMatch(res.body, /Elsewhere/, 'menu-main must not read the footer menu');
});

test('S8m-4. an href that is not a path or an http(s) URL renders no link at all', async () => {
  row({ menu: 'main', label: 'Trap', href: 'javascript:alert(1)', position: 5 });
  const res = await call({ port, path: '/menu-demo', host: 'acme.test' });
  assert.equal(res.status, 200, res.body);
  assert.doesNotMatch(res.body, /href="javascript:/, 'never a live javascript: href');
  // The label still renders — as text, because the row is the editor's data, not ours to hide.
  assert.match(res.body, /Trap/);
});

test('S8m-5. the JSON feed answers the same rows, filtered the same way', async () => {
  const res = await call({ port, path: '/_plugin/menu/items?menu=main', host: 'acme.test' });
  assert.equal(res.status, 200, res.body);
  const body = res.json as { items: { label: string; href: string }[]; count: number };
  assert.equal(body.count, 3, `expected the three visible main rows, got ${JSON.stringify(body.items)}`);
  assert.deepEqual(
    body.items.map((item) => item.label),
    ['First', 'Second', 'Trap'],
  );
});
