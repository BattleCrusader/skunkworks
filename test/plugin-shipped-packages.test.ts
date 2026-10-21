/**
 * The two packages this repository **ships** — `plugins/blog` and `plugins/contact` — driven
 * through the real install path, the real activation path and the real endpoint resolver.
 *
 * Nothing here mocks the host. `installPlugin()` copies the package into `<data>/plugins` and
 * creates the tables from the validated manifest; `PluginRuntime.enable()` imports the module
 * with the cache-buster and records what `activate(ctx)` registered; `runEndpoint()` is the
 * function the `/_plugin/*` route calls, so the facade each handler receives is the per-request
 * one with the installed row's capability check in front of it.
 *
 *   S1  blog installs: `p_blog_post` exists with the declared columns and **exactly** the
 *       declared indexes, and `cms_table_registry` records it as a plugin table
 *   S2  contact installs the same way, with the one index `created_at` needs
 *   S3  blog activates: `/blog` is in the registry, `GET posts` is registered, and the endpoint
 *       answers its documented shape — published rows only, newest first, drafts invisible
 *   S4  contact activates: `POST submit` refuses empty/oversized/malformed bodies without
 *       writing, inserts a valid one, and never echoes the message back
 *   S5  disable removes screen, endpoint and public surface for both, in one operation
 *   S6  re-enable re-registers both and lands on a fresh `activation_seq` (2), so the ESM
 *       cache-buster did its job rather than handing back the previous module namespace
 *
 * The order is the lifecycle and is deliberate: a package that cannot be installed, cannot be
 * enabled or cannot be turned off cleanly is not shippable, and each test names which of those
 * it is proving.
 */
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { openAdminWrite } from '../app/db/classes.ts';
import { runEndpoint } from '../app/plugins/endpoint.ts';
import { installPlugin } from '../app/plugins/install.ts';
import { packageRootHash, readManifest, type Manifest } from '../app/plugins/manifest.ts';
import { PluginRuntime } from '../app/plugins/runtime.ts';
import { REPO, makeFixture, type Fixture } from './helpers/fixture.ts';

const TENANT = 'acme';
const DIGEST = 'sha256:shipped-packages';
const BLOG = join(REPO, 'plugins', 'blog');
const CONTACT = join(REPO, 'plugins', 'contact');

let fixture: Fixture;
let runtime: PluginRuntime;

function siteDbFile(): string {
  return fixture.sitePath(TENANT);
}

/** The lifecycle test's install helper: a real report bound to the package root and the image. */
function install(sourceDir: string, plugin: string): void {
  const { root } = packageRootHash(sourceDir);
  const report = join(fixture.dir, `${plugin}-report.json`);
  writeFileSync(
    report,
    `${JSON.stringify({ plugin, version: '1.0.0', root_hash: root, runner_image_digest: DIGEST, ran_at: new Date().toISOString() }, null, 2)}\n`,
  );
  installPlugin({
    siteDb: siteDbFile(),
    pluginsRoot: join(fixture.dir, 'plugins'),
    sourceDir,
    allowUnsigned: true,
    testReportPath: report,
    runnerImageDigest: DIGEST,
  });
}

/** One read-only question against the tenant file, closed before the next one. */
function read<T>(query: (db: Database.Database) => T): T {
  const db = new Database(siteDbFile(), { readonly: true });
  try {
    return query(db);
  } finally {
    db.close();
  }
}

function indexNames(table: string): string[] {
  return read((db) =>
    (
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL ORDER BY name`)
        .all(table) as { name: string }[]
    ).map((row) => row.name),
  );
}

function rowSeq(plugin: string): number {
  return read(
    (db) =>
      Number(
        (db.prepare('SELECT activation_seq FROM cms_plugin_installed WHERE plugin_id = ?').get(plugin) as { activation_seq: number })
          .activation_seq,
      ),
  );
}

function countRows(table: string): number {
  return read((db) => Number((db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n));
}

/** The endpoint exactly as the `/_plugin/*` route calls it: host db, host tenant, host facade. */
async function invoke(plugin: string, endpoint: string, method: 'GET' | 'POST', url: string, body = ''): Promise<unknown> {
  const db = openAdminWrite(siteDbFile(), 5000);
  try {
    return await runEndpoint(runtime, { db, tenant: TENANT, plugin, endpoint, method, url, body });
  } finally {
    db.close();
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value), `expected an object, got ${JSON.stringify(value)}`);
  return value as Record<string, unknown>;
}

/**
 * The install's own claim, checked against the file: every table the manifest declares exists,
 * every column has the declared type and nullability, and `indexed: true` is present in
 * `sqlite_master` as `ix_<table>_<column>` (the host's naming, `manifest.ts:tableStatements`).
 */
function assertDeclaredSchema(dir: string, plugin: string): Manifest {
  const manifest = readManifest(dir);
  const db = new Database(siteDbFile(), { readonly: true });
  try {
    for (const table of manifest.tables) {
      const exists = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table.name);
      assert.ok(exists !== undefined, `${plugin}: ${table.name} was not created by the install`);

      const columns = db.prepare(`PRAGMA table_info("${table.name}")`).all() as {
        name: string;
        type: string;
        notnull: number;
      }[];
      const byName = new Map(columns.map((column) => [column.name, column]));
      assert.ok(byName.has('id'), `${plugin}: ${table.name} has no implicit id`);

      for (const declared of table.columns ?? []) {
        const actual = byName.get(declared.name);
        assert.ok(actual !== undefined, `${plugin}: ${table.name}.${declared.name} was not created`);
        const sqlType = declared.type === 'ASSET' || declared.type === 'JSON' ? 'TEXT' : declared.type;
        assert.equal(actual.type, sqlType, `${plugin}: ${table.name}.${declared.name} has type ${actual.type}`);
        assert.equal(actual.notnull, declared.notNull === true ? 1 : 0, `${plugin}: ${table.name}.${declared.name} nullability`);
      }

      const indexes = new Set(indexNames(table.name));
      for (const declared of table.columns ?? []) {
        const name = `ix_${table.name}_${declared.name}`;
        assert.equal(
          indexes.has(name),
          declared.indexed === true,
          `${plugin}: ${name} ${declared.indexed === true ? 'is missing' : 'exists but was not declared indexed'}`,
        );
      }

      const registered = db
        .prepare('SELECT table_class, column_count, index_count FROM cms_table_registry WHERE table_name = ?')
        .get(table.name) as { table_class: string; column_count: number; index_count: number } | undefined;
      assert.ok(registered !== undefined, `${plugin}: ${table.name} is not in cms_table_registry`);
      assert.equal(registered.table_class, 'plugin');
      assert.equal(registered.column_count, (table.columns ?? []).length + 1);
      assert.equal(registered.index_count, (table.columns ?? []).filter((column) => column.indexed === true).length);
    }
    return manifest;
  } finally {
    db.close();
  }
}

before(() => {
  fixture = makeFixture({ specs: [{ key: TENANT, hosts: ['acme.test'], title: 'Acme' }] });
  install(BLOG, 'blog');
  install(CONTACT, 'contact');
  runtime = new PluginRuntime({ dataDir: fixture.dir, emailMode: 'off' });
});

after(() => {
  fixture.cleanup();
});

test('S1. blog installs: p_blog_post, its declared columns, and exactly its declared indexes', () => {
  const manifest = assertDeclaredSchema(BLOG, 'blog');
  assert.deepEqual(
    manifest.tables.map((table) => table.name),
    ['p_blog_post'],
  );
  assert.equal(manifest.tables[0]?.export, 'rows', 'a table with no export class cannot be sold');
  assert.deepEqual(indexNames('p_blog_post'), [
    'ix_p_blog_post_created_at',
    'ix_p_blog_post_published_at',
    'ix_p_blog_post_slug',
    'ix_p_blog_post_status',
  ]);
});

test('S2. contact installs: p_contact_message and the created_at index', () => {
  assertDeclaredSchema(CONTACT, 'contact');
  assert.deepEqual(indexNames('p_contact_message'), ['ix_p_contact_message_created_at']);
});

test('S3. blog activates: /blog and GET posts register, and the feed answers its documented shape', async () => {
  const activation = await runtime.enable(TENANT, 'blog');
  assert.equal(activation.alreadyActive, false);
  assert.equal(activation.activationSeq, 1);
  assert.deepEqual(activation.hooks, [], 'blog declares no hooks');
  assert.deepEqual(activation.endpoints, ['GET posts']);

  const entry = runtime.registry.get(TENANT, 'blog');
  assert.ok(entry !== undefined, 'the runtime has no entry for blog');
  // S8g: the screen carries the fields the package declared for its table — the form is drawn
  // from them, so a screen without them is a screen that falls back to raw columns.
  const screen = entry.screens.get('/blog');
  assert.ok(screen !== undefined, 'blog registered no /blog screen');
  assert.deepEqual(
    { path: screen.path, table: screen.table, title: screen.title },
    { path: '/blog', table: 'p_blog_post', title: 'Blog posts' },
  );
  assert.deepEqual(
    screen.fields?.map((f) => f.name),
    ['title', 'slug', 'body', 'status', 'published_at', 'created_at'],
    'the blog form is drawn from these fields, in this order',
  );
  assert.deepEqual(screen.fields?.find((f) => f.name === 'status')?.options, ['draft', 'published']);
  assert.deepEqual(screen.fields?.find((f) => f.name === 'slug')?.from, 'title');
  assert.deepEqual(screen.list, ['title', 'status', 'published_at']);

  const endpoint = runtime.endpoint(TENANT, 'blog', 'GET', 'posts');
  assert.ok(endpoint !== undefined, 'GET posts is declared but was not registered');
  assert.equal(endpoint.method, 'GET');

  // Seed through the tenant's own file: a public feed has no write surface, which is the point.
  const db = openAdminWrite(siteDbFile(), 5000);
  try {
    const insert = db.prepare(
      `INSERT INTO p_blog_post (title, slug, body, status, published_at, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    insert.run('Draft post', 'draft', '<p>not yet</p>', 'draft', null, '2026-01-03T00:00:00.000Z');
    insert.run('First post', 'first', '<p>first <strong>body</strong></p>', 'published', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    insert.run('Second post', 'second', '<p>second body</p>', 'published', '2026-02-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z');
  } finally {
    db.close();
  }

  const answer = asRecord(await invoke('blog', 'posts', 'GET', '/_plugin/blog/posts?limit=5'));
  assert.deepEqual(Object.keys(answer).sort(), ['count', 'limit', 'offset', 'posts']);
  assert.equal(answer.count, 2, 'a draft must not be published by the feed');
  assert.equal(answer.limit, 5);
  assert.equal(answer.offset, 0);

  const posts = answer.posts as Record<string, unknown>[];
  assert.deepEqual(
    posts.map((post) => post.slug),
    ['second', 'first'],
    'published_at must order the feed newest-first',
  );
  assert.deepEqual(Object.keys(posts[0] ?? {}).sort(), ['excerpt', 'published_at', 'slug', 'title']);
  assert.equal(posts[1]?.title, 'First post');
  assert.equal(posts[1]?.excerpt, 'first body', 'the excerpt is plain text, tags stripped, whitespace collapsed');

  // A slug lookup adds the body and still refuses an unpublished row.
  const one = asRecord(await invoke('blog', 'posts', 'GET', '/_plugin/blog/posts?slug=first'));
  assert.equal(one.count, 1);
  assert.equal((one.posts as Record<string, unknown>[])[0]?.body, '<p>first <strong>body</strong></p>');
  assert.equal(asRecord(await invoke('blog', 'posts', 'GET', '/_plugin/blog/posts?slug=draft')).count, 0);

  // A limit beyond the package ceiling is clamped, not refused: the public surface answers.
  assert.equal(asRecord(await invoke('blog', 'posts', 'GET', '/_plugin/blog/posts?limit=999')).limit, 50);

  // `page_size` is a live setting, not a dead declaration: with it set, the default follows it.
  const settings = openAdminWrite(siteDbFile(), 5000);
  try {
    settings
      .prepare(`INSERT INTO cms_plugin_setting (plugin_id, key, value_json, type, secret) VALUES ('blog', 'page_size', '2', 'int', 0)`)
      .run();
  } finally {
    settings.close();
  }
  assert.equal(asRecord(await invoke('blog', 'posts', 'GET', '/_plugin/blog/posts')).limit, 2);
});

test('S4. contact activates: POST submit validates, writes one row, and never echoes the message', async () => {
  const activation = await runtime.enable(TENANT, 'contact');
  assert.equal(activation.alreadyActive, false);
  assert.equal(activation.activationSeq, 1);
  assert.deepEqual(activation.endpoints, ['POST submit']);

  const entry = runtime.registry.get(TENANT, 'contact');
  assert.ok(entry !== undefined, 'the runtime has no entry for contact');
  const screen = entry.screens.get('/messages');
  assert.ok(screen !== undefined, 'contact registered no /messages screen');
  assert.deepEqual(
    { path: screen.path, table: screen.table, title: screen.title },
    { path: '/messages', table: 'p_contact_message', title: 'Messages' },
  );
  assert.deepEqual(
    screen.fields?.map((f) => f.name),
    ['name', 'email', 'message', 'status', 'created_at', 'ip_hash'],
  );
  assert.deepEqual(screen.fields?.find((f) => f.name === 'status')?.options, ['new', 'read', 'replied', 'archived']);
  assert.equal(screen.fields?.find((f) => f.name === 'ip_hash')?.widget, 'hidden');
  assert.deepEqual(screen.list, ['name', 'email', 'status', 'created_at']);
  assert.ok(runtime.endpoint(TENANT, 'contact', 'POST', 'submit') !== undefined, 'POST submit was not registered');

  const empty = asRecord(await invoke('contact', 'submit', 'POST', '/_plugin/contact/submit', ''));
  assert.deepEqual(empty, { ok: false, error: 'body' });

  const malformed = asRecord(await invoke('contact', 'submit', 'POST', '/_plugin/contact/submit', 'not json'));
  assert.deepEqual(malformed, { ok: false, error: 'body' });

  const blank = asRecord(
    await invoke(
      'contact',
      'submit',
      'POST',
      '/_plugin/contact/submit',
      JSON.stringify({ name: 'Ada', email: 'ada@example.com', message: '   ' }),
    ),
  );
  assert.equal(blank.ok, false);
  assert.deepEqual(blank.fields, ['message'], 'an empty message is refused by name, with no value echoed');
  assert.equal(countRows('p_contact_message'), 0, 'a refused body must not reach the table');

  const tooLong = asRecord(
    await invoke(
      'contact',
      'submit',
      'POST',
      '/_plugin/contact/submit',
      JSON.stringify({ name: 'Ada', email: 'ada@example.com', message: 'x'.repeat(4_001) }),
    ),
  );
  assert.equal(tooLong.ok, false);
  assert.deepEqual(tooLong.fields, ['message']);
  assert.equal(countRows('p_contact_message'), 0);

  const message = 'Please call me on Tuesday.';
  const accepted = asRecord(
    await invoke(
      'contact',
      'submit',
      'POST',
      '/_plugin/contact/submit',
      JSON.stringify({ name: '  Ada Lovelace ', email: ' ada@example.com ', message, admin: true }),
    ),
  );
  assert.deepEqual(accepted, { ok: true }, 'success is exactly {ok:true}: no id, no echo, no extra fields');
  assert.doesNotMatch(JSON.stringify(accepted), /call me/, 'the endpoint must not reflect the message');

  assert.equal(countRows('p_contact_message'), 1);
  const row = read(
    (db) =>
      db.prepare('SELECT name, email, message, status, created_at, ip_hash FROM p_contact_message').get() as {
        name: string;
        email: string;
        message: string;
        status: string;
        created_at: string;
        ip_hash: string | null;
      },
  );
  assert.equal(row.name, 'Ada Lovelace');
  assert.equal(row.email, 'ada@example.com');
  assert.equal(row.message, message);
  assert.equal(row.status, 'new');
  assert.match(row.created_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(row.ip_hash, null, 'no client address reaches an endpoint, so ip_hash stays NULL rather than invented');
});

test('S5. disable removes both packages from the registry and from the public surface', async () => {
  assert.equal(await runtime.disable(TENANT, 'blog'), true);
  assert.equal(await runtime.disable(TENANT, 'contact'), true);

  for (const plugin of ['blog', 'contact']) {
    assert.equal(runtime.registry.has(TENANT, plugin), false, `${plugin} is still in the registry`);
    assert.equal(runtime.registry.get(TENANT, plugin), undefined);
    assert.deepEqual(runtime.describe(TENANT), [], 'nothing may be described as loaded');
  }
  assert.equal(runtime.endpoint(TENANT, 'blog', 'GET', 'posts'), undefined);
  assert.equal(runtime.endpoint(TENANT, 'contact', 'POST', 'submit'), undefined);
  assert.equal(rowSeq('blog'), 1, 'disable must not consume an activation number');
  assert.equal(rowSeq('contact'), 1);

  // The declared URL is no longer answered: installed-but-disabled is a refusal, not a 404.
  await assert.rejects(
    () => invoke('blog', 'posts', 'GET', '/_plugin/blog/posts'),
    (err: unknown) => (err as { code?: string }).code === 'SKW_E_PL_UNAVAILABLE',
    'a disabled package must refuse its declared endpoint',
  );
  await assert.rejects(
    () => invoke('contact', 'submit', 'POST', '/_plugin/contact/submit', '{}'),
    (err: unknown) => (err as { code?: string }).code === 'SKW_E_PL_UNAVAILABLE',
  );
});

test('S6. re-enable re-registers both surfaces on a fresh activation_seq', async () => {
  const blog = await runtime.enable(TENANT, 'blog');
  assert.equal(blog.alreadyActive, false);
  assert.equal(blog.activationSeq, 2, 'a disable→enable cycle must be a new module instance, not the cached one');
  assert.equal(rowSeq('blog'), 2);
  assert.deepEqual(blog.endpoints, ['GET posts']);
  assert.ok(runtime.registry.get(TENANT, 'blog')?.screens.get('/blog') !== undefined);

  const contact = await runtime.enable(TENANT, 'contact');
  assert.equal(contact.activationSeq, 2);
  assert.equal(rowSeq('contact'), 2);
  assert.deepEqual(contact.endpoints, ['POST submit']);
  assert.ok(runtime.registry.get(TENANT, 'contact')?.screens.get('/messages') !== undefined);

  // The re-activated module answers again, on the rows it already had.
  const answer = asRecord(await invoke('blog', 'posts', 'GET', '/_plugin/blog/posts'));
  assert.equal(answer.count, 2);
  assert.equal(
    asRecord(await invoke('contact', 'submit', 'POST', '/_plugin/contact/submit', JSON.stringify({ name: 'Grace', email: 'grace@example.com', message: 'Second message' }))).ok,
    true,
  );
  assert.equal(countRows('p_contact_message'), 2);
});
