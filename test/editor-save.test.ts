/**
 * The save path (§10.2–§10.3) and the two refusals that make it a gate rather than a
 * form handler.
 *
 * The tests are ordered by what they protect:
 *
 *   S1–S2  the row: canonical bytes, `body_sha` over those bytes, `rev` increment,
 *          one `cms_page_revision` per save.
 *   S3     the **unregistered type**. First the defect: GrapesJS strips
 *          `data-gjs-type` from a type it does not know, so a save *after* load would
 *          write a div and say nothing. Then the gate: the same document is refused with
 *          `SKW_E_RT_COMPONENT_UNKNOWN` before the editor sees it.
 *   S4     nesting, from `allowed_children`.
 *   S5     D17: the picker writes a key, the stored body has no URL, the render derives it.
 *   S6     the `list` component's rows: stored in order, reloaded in order.
 *   S7     §10.6: a hand-managed page is read-only.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import type Database from 'better-sqlite3';

import { openAdminWrite } from '../app/db/classes.ts';
import { analyseBody, assetKeysIn, reloadListItems } from '../app/editor/model.ts';
import { applyPick } from '../app/editor/media.ts';
import { loadRegistry } from '../app/editor/registry.ts';
import { renderBody } from '../app/editor/render.ts';
import { loadForEditor, savePage } from '../app/editor/save.ts';
import { AppError, HTTP } from '../app/errors.ts';
import { REPO, SCHEMA, makeFixture, type Fixture } from './helpers/fixture.ts';
import { cspPolicy } from '../app/render/csp.ts';
import { twoPasses } from './helpers/grapes.ts';

const registry = loadRegistry(SCHEMA);

/** `AppError.detail` is `unknown` on purpose (the wire shape is JSON): index it explicitly. */
function detailOf(err: AppError): Record<string, unknown> {
  return (err.detail ?? {}) as Record<string, unknown>;
}

/** The fixture site's nine pages, read as the corpus they are. */
function corpus(name: string): string {
  return readFileSync(join(REPO, 'test', 'fixtures', 'site', name), 'utf8');
}

let fixture: Fixture;

before(() => {
  fixture = makeFixture({ specs: [{ key: 'acme', hosts: ['acme.test'], title: 'Acme' }] });
});

after(() => {
  fixture.cleanup();
});

function db(): Database.Database {
  const handle = openAdminWrite(fixture.sitePath('acme'));
  // Three assets: one public image, one public document, one gated document.
  const asset = (key: string, mime: string, kind: string, access: string, width: number | null, height: number | null): void => {
    handle
      .prepare(
        `INSERT INTO cms_asset (key, filename, mime, bytes, sha256, kind, width, height, access_class)
         VALUES (?, ?, ?, 10, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO NOTHING`,
      )
      .run(key, `${key}.bin`, mime, 'ab'.repeat(32), kind, width, height, access);
  };
  asset('banner/home', 'image/jpeg', 'image', 'public', 1200, 800);
  for (const key of ['work/one', 'work/two', 'work/three', 'team/studio', 'posts/first']) {
    asset(key, 'image/jpeg', 'image', 'public', 1200, 800);
  }
  asset('vault/book', 'application/pdf', 'document', 'gated', null, null);
  return handle;
}

test('S1 — a first save writes one page row and one revision, with body_sha over the stored bytes', async () => {
  const handle = db();
  try {
    const result = await savePage({
      db: handle,
      registry,
      path: '/about',
      slug: 'about',
      title: 'About',
      template: 'page',
      html: corpus('about.html'),
      actorId: 1,
    });
    assert.equal(result.created, true);
    assert.equal(result.rev, 0);
    const row = handle.prepare('SELECT body_html, body_css, body_sha, rev, managed_by FROM cms_page WHERE id = ?').get(result.id) as {
      body_html: string;
      body_css: string;
      body_sha: string;
      rev: number;
      managed_by: string;
    };
    assert.equal(row.body_html, result.bodyHtml);
    assert.equal(row.rev, 0);
    assert.equal(row.managed_by, 'editor');
    // body_sha covers the canonical bytes — the same function the gate compares.
    const { createHash } = await import('node:crypto');
    assert.equal(row.body_sha, createHash('sha256').update(row.body_html, 'utf8').digest('hex'));
    // No URL in the stored body; the key is there instead (D17).
    assert.ok(!/src="/.test(row.body_html), 'the stored body must not carry a src');
    assert.match(row.body_html, /data-asset-key="team\/studio"/);
    // One stylesheet per page (§10.1), generated from the registry.
    assert.match(row.body_css, /\.figure\{/);
    const revisions = handle.prepare('SELECT rev, body_html FROM cms_page_revision WHERE page_id = ? ORDER BY id').all(result.id) as {
      rev: number;
      body_html: string;
    }[];
    assert.equal(revisions.length, 1);
    assert.equal(revisions[0]?.body_html, row.body_html);
  } finally {
    handle.close();
  }
});

test('S2 — a second save increments rev and appends a revision; the bytes are canonical both times', async () => {
  const handle = db();
  try {
    const first = await savePage({
      db: handle,
      registry,
      path: '/legal',
      slug: 'legal',
      title: 'Legal',
      template: 'page',
      html: corpus('legal.html'),
    });
    // A hand-rolled edit: same document, different text, pretty-printing everywhere.
    const edited = corpus('legal.html').replace('This page exists to prove', 'This page now proves');
    const second = await savePage({
      db: handle,
      registry,
      pageId: first.id,
      path: '/legal',
      slug: 'legal',
      title: 'Legal',
      template: 'page',
      html: edited,
    });
    assert.equal(second.created, false);
    assert.equal(second.rev, 1);
    assert.notEqual(second.bodySha, first.bodySha);
    const revisions = handle.prepare('SELECT rev FROM cms_page_revision WHERE page_id = ? ORDER BY id').all(first.id) as {
      rev: number;
    }[];
    assert.deepEqual(
      revisions.map((r) => r.rev),
      [0, 1],
    );
  } finally {
    handle.close();
  }
});

test('S3 — the unregistered type: GrapesJS strips it, so the refusal runs before the load', async () => {
  const unknown = '<div class="carousel" data-gjs-type="carousel"><p>One</p></div><p data-gjs-type="prose">x</p>';
  const handle = db();
  try {
    // (a) The defect, measured: a type the editor does not know loses its lock on save.
    const { pass1 } = await twoPasses(registry, unknown);
    assert.ok(!pass1.includes('data-gjs-type="carousel"'), `GrapesJS stripped it as measured: ${pass1}`);
    assert.match(pass1, /data-gjs-type="prose"/, 'a registered type keeps its lock');

    // (b) The gate: the same document is refused, with a code, before GrapesJS sees it.
    //     The row is written directly — a body from an older image, or a hand edit — because
    //     the point is the *load* path refusing a document that already exists.
    const inserted = handle
      .prepare(
        `INSERT INTO cms_page (path, slug, title, status, template, body_html, body_css, rev, body_sha, managed_by)
         VALUES ('/legacy', 'legacy', 'Legacy', 'draft', 'page', ?, '', 0, '', 'editor')`,
      )
      .run('<div class="carousel" data-gjs-type="carousel"><p>One</p></div>');
    let refused: unknown;
    try {
      loadForEditor(handle, registry, Number(inserted.lastInsertRowid));
    } catch (err) {
      refused = err;
    }
    assert.ok(refused instanceof AppError, 'the load path must refuse, not return a document');
    assert.equal(refused.code, 'SKW_E_RT_COMPONENT_UNKNOWN');
    assert.equal(refused.status, 422);
    assert.equal(detailOf(refused)['type'], 'carousel');

    // The refused save wrote nothing.
    const before = (handle.prepare('SELECT count(*) AS n FROM cms_page').get() as { n: number }).n;
    await assert.rejects(
      savePage({
        db: handle,
        registry,
        path: '/x',
        slug: 'x',
        title: 'X',
        template: 'page',
        html: unknown,
      }),
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'SKW_E_RT_COMPONENT_UNKNOWN');
        assert.equal(detailOf(err)['type'], 'carousel');
        assert.equal(detailOf(err)['tag'], 'div');
        return true;
      },
    );
    const after = (handle.prepare('SELECT count(*) AS n FROM cms_page').get() as { n: number }).n;
    assert.equal(after, before, 'a refused save writes no page row');
  } finally {
    handle.close();
  }
});

test('S4 — nesting is the registry\'s rule: a component inside a parent that does not allow it is refused', async () => {
  const handle = db();
  try {
    await assert.rejects(
      savePage({
        db: handle,
        registry,
        path: '/bad',
        slug: 'bad',
        title: 'Bad',
        template: 'page',
        // cta allows no children; the hero allows prose and cta but not a form.
        html: '<aside class="cta" data-gjs-type="cta"><form class="form" data-gjs-type="form" data-form="contact"><button type="submit">Send</button></form></aside>',
      }),
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'SKW_E_RT_COMPONENT_NESTING');
        assert.equal(detailOf(err)['parent'], 'cta');
        assert.equal(detailOf(err)['child'], 'form');
        return true;
      },
    );
    // The allowed shape saves: a prose inside a hero.
    const ok = await savePage({
      db: handle,
      registry,
      path: '/ok',
      slug: 'ok',
      title: 'Ok',
      template: 'page',
      html: '<section class="hero" data-gjs-type="hero"><div class="prose" data-gjs-type="prose"><p data-prop="body">Hello</p></div></section>',
    });
    assert.equal(ok.created, true);
  } finally {
    handle.close();
  }
});

test('S5 — D17: the picker writes a key, the body stores no URL, and the render derives it', async () => {
  const handle = db();
  // (a) The picker's own effect: key set, src gone, and the value it returns has no URL.
  const picked = applyPick(
    '<figure class="figure" data-gjs-type="figure"><img data-prop="src" src="/media/banner/old.jpg" alt=""><figcaption data-prop="caption">x</figcaption></figure>',
    { type: 'figure', prop: 'src', field: 'asset' },
    'banner/home',
  );
  assert.match(picked, /data-asset-key="banner\/home"/);
  assert.ok(!picked.includes('/media/banner/old.jpg'), 'a pick removes the URL it replaced');

  // (b) A body that carries a URL and no key is refused: that is the defect D17 names.
  await assert.rejects(
    savePage({
      db: handle,
      registry,
      path: '/frozen',
      slug: 'frozen',
      title: 'Frozen',
      template: 'page',
      html: '<p class="hero__image"><img src="/media/banner/home.jpg" alt="x"></p>',
    }),
    (err: unknown) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.code, 'SKW_E_RT_BODY_FORBIDDEN');
      assert.equal(detailOf(err)['rule'], 'asset-url-in-body');
      return true;
    },
  );

  // (c) The saved body names the key and nothing else; the URL is derived at render.
  const saved = await savePage({
    db: handle,
    registry,
    path: '/gallery',
    slug: 'gallery',
    title: 'Gallery',
    template: 'page',
    html: corpus('gallery.html'),
  });
  assert.ok(!saved.bodyHtml.includes('src='), saved.bodyHtml);
  assert.ok(!saved.bodyHtml.includes('/media/'), saved.bodyHtml);
  assert.deepEqual(assetKeysIn(saved.bodyHtml), ['work/one', 'work/two', 'work/three']);

  const rendered = renderBody(handle, saved.bodyHtml);
  assert.match(rendered, /src="\/media\/work\/one\.jpg\?v=abababab"/);
  assert.match(rendered, /width="1200"/);
  // …and the key is still in the rendered body: the renderer adds, it does not rewrite.
  assert.match(rendered, /data-asset-key="work\/one"/);
});

test('S6 — a list stores exactly one repeat template, and reloads it in order', async () => {
  const handle = db();
  try {
    const saved = await savePage({
      db: handle,
      registry,
      path: '/',
      slug: 'home',
      title: 'Home',
      template: 'page',
      html: corpus('index.html'),
    });
    const items = saved.items['list'];
    assert.ok(items !== undefined, 'the list component produced no rows');
    // §16 S4 row 2 / C-4: one `[data-repeat]` child is the loop TEMPLATE. Rows come from
    // the bound source at render time, so a body that carries two templates has no
    // meaning — and, before this gate, it silently produced two rows and stored both.
    assert.deepEqual(
      items.map((item) => item.position),
      [0],
    );
    assert.match(saved.bodyHtml, /data-item-position="0"/);
    assert.ok(!saved.bodyHtml.includes('data-item-position="1"'), 'only one repeat template may exist');

    // Reload from the row, not from the caller's object: the template is in the bytes.
    const reloaded = reloadListItems(saved.bodyHtml, registry, 'list');
    assert.equal(reloaded.length, 1);
    assert.deepEqual(
      reloaded.map((item) => item.html),
      items.map((item) => item.html),
    );
    assert.match(reloaded[0]?.html ?? '', /Post title/);
  } finally {
    handle.close();
  }
});

test('S6b — a list with TWO [data-repeat] children is refused at save, by name, and writes nothing', async () => {
  const handle = db();
  try {
    const page = (): number => Number((handle.prepare('SELECT count(*) AS n FROM cms_page').get() as { n: number }).n);
    const before = page();
    const two = corpus('index.html').replace(
      '<p class="list__empty" data-empty>No posts yet.</p>',
      '<article class="card" data-repeat><h3 class="card__title" data-bind-title="title">Second</h3></article>\n  <p class="list__empty" data-empty>No posts yet.</p>',
    );
    // The mutation is real: the fixture now has two repeat children.
    assert.equal((two.match(/data-repeat/g) ?? []).length, 2, 'the test document must carry two [data-repeat] children');

    let refused: unknown;
    try {
      await savePage({
        db: handle,
        registry,
        path: '/two',
        slug: 'two',
        title: 'Two',
        template: 'page',
        html: two,
      });
    } catch (err) {
      refused = err;
    }
    assert.ok(refused instanceof AppError, `the save must be refused, got ${String(refused)}`);
    assert.equal(refused.code, 'SKW_E_RT_REPEAT_INVALID');
    assert.equal(refused.status, HTTP['SKW_E_RT_REPEAT_INVALID']);
    const detail = detailOf(refused);
    assert.equal(detail.rule, 'repeat-children');
    assert.equal(detail.component, 'list');
    assert.equal(detail.count, 2);
    assert.match(refused.message, /exactly one/i);
    assert.equal(page(), before, 'a refused save writes no page row');

    // Positive control, same suite: the same document with one repeat child saves.
    const one = corpus('index.html');
    assert.equal((one.match(/data-repeat/g) ?? []).length, 1);
    const ok = await savePage({ db: handle, registry, path: '/one', slug: 'one', title: 'One', template: 'page', html: one });
    assert.equal(ok.items['list']?.length, 1);
  } finally {
    handle.close();
  }
});

test('S7 — §10.6: a hand-managed page is read-only, and the refusal says so', async () => {
  const handle = db();
  try {
    const info = handle
      .prepare(
        `INSERT INTO cms_page (path, slug, title, status, template, body_html, body_css, rev, body_sha, managed_by)
         VALUES ('/hand', 'hand', 'Hand', 'draft', 'page', '<p>by hand</p>', '', 0, '', 'hand')`,
      )
      .run();
    const id = Number(info.lastInsertRowid);
    await assert.rejects(
      savePage({
        db: handle,
        registry,
        pageId: id,
        path: '/hand',
        slug: 'hand',
        title: 'Hand',
        template: 'page',
        managedBy: 'hand',
        html: '<p>by hand</p>',
      }),
      (err: unknown) => err instanceof AppError && err.code === 'SKW_E_RT_PAGE_READONLY',
    );
    // A hand page still *opens* (read-only in the canvas), which is what the route renders.
    const opened = loadForEditor(handle, registry, id);
    assert.equal(opened.managedBy, 'hand');
  } finally {
    handle.close();
  }
});

/**
 * S4a F1 — the wrapper is stripped by **this** path, not by the caller.
 *
 * The product's editor posts `editor.getHtml()`, which is a `<body>…</body>` document; a
 * page's `body_html` is a fragment. Until this case existed, the only code that stripped
 * it was the round-trip gate's test helper, so `make test` was green while every page the
 * editor wrote began with `<body>` (11/11 rows in the browser run).
 */
test('S8 — a canvas document is stored as a fragment, and a document that is not one is refused', async () => {
  const handle = db();
  const wrapped = '<body>\n  <div class="prose" data-gjs-type="prose"><p data-prop="body">Wrapped.</p></div>\n</body>';
  try {
    // A row written before this fix is a wrapped document. It still *opens*: the load path
    // must not brick the pages the old save path wrote (S4b has to assume both shapes in
    // the table it inherits), and the next save is what normalises it.
    const legacy = analyseBody({ html: wrapped, registry });
    assert.deepEqual(
      legacy.components.map((component) => component.type),
      ['prose'],
      'a wrapped stored body must still load',
    );

    const saved = await savePage({
      db: handle,
      registry,
      path: '/wrapped',
      slug: 'wrapped',
      title: 'Wrapped',
      template: 'page',
      html: wrapped,
    });
    assert.ok(!/<body[\s>]/i.test(saved.bodyHtml), `the stored bytes carry the wrapper: ${saved.bodyHtml}`);
    assert.ok(saved.bodyHtml.startsWith('<div data-gjs-type="prose"'), saved.bodyHtml);
    // `body_sha` covers the fragment, and the bytes are already canonical: a second save of
    // what was returned changes nothing (the fixpoint, at the module level).
    assert.match(saved.bodySha, /^[0-9a-f]{64}$/);
    const again = await savePage({
      db: handle,
      registry,
      pageId: saved.id,
      path: '/wrapped',
      slug: 'wrapped',
      title: 'Wrapped',
      template: 'page',
      html: saved.bodyHtml,
    });
    assert.equal(again.bodyHtml, saved.bodyHtml);
    assert.equal(again.rev, 1);
    assert.equal(again.bodySha, saved.bodySha);

    // A document that is not one `<body>` at the root is not a canvas document, and it is
    // not a fragment: storing it would put a second body inside the shell's `<main>`.
    await assert.rejects(
      savePage({
        db: handle,
        registry,
        path: '/document',
        slug: 'document',
        title: 'Document',
        template: 'page',
        html: '<html><body><div data-gjs-type="prose"><p data-prop="body">x</p></div></body></html>',
      }),
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'SKW_E_RT_BODY_FORBIDDEN');
        assert.equal(detailOf(err)['rule'], 'body-document');
        return true;
      },
    );
  } finally {
    handle.close();
  }
});

/**
 * S9 — content is content, whatever type GrapesJS gives it.
 *
 * This test used to assert the opposite: that a body of plain elements with no registered
 * component was refused as the shape a degraded paste leaves behind. That rule was written when
 * every element came from the registry, and it contradicted the Basic palette, which inserts
 * exactly this shape — an operator who built a page out of sections and headings could not save
 * it. What the rule was protecting is now enforced by type (S9b), which is the property that
 * actually mattered: a body claiming a component nobody defines.
 */
test('S9 — a body of plain elements saves, and keeps no editor internals', async () => {
  const handle = db();
  try {
    const saved = await savePage({
      db: handle,
      registry,
      path: '/plain',
      slug: 'plain',
      title: 'Plain',
      template: 'page',
      html: '<body><div><h1>Slides</h1><p>Plain markup, no component.</p></div></body>',
    });
    assert.match(saved.bodyHtml, /<h1>Slides<\/h1>/);
    assert.doesNotMatch(saved.bodyHtml, /data-gjs-type/, 'GrapesJS types are stripped on the way out');

    const row = handle.prepare("SELECT count(*) AS n FROM cms_page WHERE path = '/plain'").get() as { n: number };
    assert.equal(row.n, 1);
  } finally {
    handle.close();
  }
});

test('S9b — a body claiming a component this build does not define is still refused', async () => {
  const handle = db();
  try {
    await assert.rejects(
      savePage({
        db: handle,
        registry,
        path: '/unknown-type',
        slug: 'unknown-type',
        title: 'Unknown',
        template: 'page',
        html: '<body><div data-gjs-type="carousel"><p>x</p></div></body>',
      }),
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'SKW_E_RT_COMPONENT_UNKNOWN');
        return true;
      },
    );
    const row = handle.prepare("SELECT count(*) AS n FROM cms_page WHERE path = '/unknown-type'").get() as { n: number };
    assert.equal(row.n, 0);
  } finally {
    handle.close();
  }
});

test('S10 — a page whose shell is unknown is 422 at publish, and the same page with a real shell publishes', async () => {
  const handle = db();
  const html = '<div class="prose" data-gjs-type="prose"><p data-prop="body">Shell test.</p></div>';
  try {
    await assert.rejects(
      () =>
        savePage({
          db: handle,
          registry,
          path: '/no-shell',
          slug: 'no-shell',
          title: 'No shell',
          template: 'mystery-shell',
          status: 'published',
          html,
        }),
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'SKW_E_RT_TEMPLATE_UNKNOWN');
        // The §16 row says `422`, and the code's HTTP mapping is what makes that true.
        assert.equal(HTTP.SKW_E_RT_TEMPLATE_UNKNOWN, 422);
        return true;
      },
    );
    const missing = handle.prepare("SELECT count(*) AS n FROM cms_page WHERE path = '/no-shell'").get() as { n: number };
    assert.equal(missing.n, 0, 'a refused publish wrote a row');

    const published = await savePage({
      db: handle,
      registry,
      path: '/no-shell',
      slug: 'no-shell',
      title: 'No shell',
      template: 'page',
      status: 'published',
      html,
    });
    const row = handle.prepare("SELECT status FROM cms_page WHERE path = '/no-shell'").get() as { status: string };
    assert.equal(row.status, 'published');
    // A draft may name a shell the tenant is still building; only publish is the gate.
    const draft = await savePage({
      db: handle,
      registry,
      path: '/shell-wip',
      slug: 'shell-wip',
      title: 'WIP',
      template: 'mystery-shell',
      status: 'draft',
      html,
    });
    const wip = handle.prepare("SELECT status FROM cms_page WHERE path = '/shell-wip'").get() as { status: string };
    assert.equal(wip.status, 'draft');
  } finally {
    handle.close();
  }
});

test('S11 — v1 forbids frames: an iframe in a body is refused, and frame-src is none for every tenant', async () => {
  const handle = db();
  try {
    await assert.rejects(
      () =>
        savePage({
          db: handle,
          registry,
          path: '/embed-youtube',
          slug: 'embed-youtube',
          title: 'Embed',
          template: 'page',
          html: '<div class="prose" data-gjs-type="prose"><iframe title="video"></iframe></div>',
        }),
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'SKW_E_RT_BODY_FORBIDDEN');
        assert.equal(detailOf(err)['rule'], 'frame');
        assert.equal(detailOf(err)['element'], 'iframe');
        return true;
      },
    );
    // The registered `embed` block is a link card, not a frame — that is what a tenant who
    // needs YouTube gets in v1, and this asserts the two facts together.
    const embed = registry.byType.get('embed');
    assert.ok(embed !== undefined);
    assert.match(String(embed?.html ?? ''), /class="embed"/);
    assert.ok(!/<(iframe|embed)\b/i.test(String(embed?.html ?? '')), 'the embed block emits a frame');
    for (const tenant of ['acme', 'beta']) {
      assert.equal(cspPolicy(), `default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data: https:; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'`);
      assert.ok(tenant !== '');
    }
  } finally {
    handle.close();
  }
});
