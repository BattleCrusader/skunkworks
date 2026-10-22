/**
 * The save path: `cms_page` (+ `cms_page_revision`) from an editor document.
 *
 * The order of operations is the design:
 *
 *   analyse (validate types, nesting, D17, forbidden classes)
 *     -> canon (Prettier + fixed attribute order)
 *       -> analyse **again** (canon must not have broken the lock)
 *         -> write, one transaction, with a revision row
 *
 * The second `analyse` is not belt-and-braces: `canon` re-serialises the tree, so a
 * serializer bug that dropped `data-gjs-type` would be *silent* on the way out and the
 * stored page would degrade to a div on the next load. Analysing the bytes we are about
 * to store is the only place that can catch it, and it is the same function the load path
 * uses, so the gate and the product agree by construction.
 */
import type Database from 'better-sqlite3';

import { AppError } from '../errors.ts';
import { syncPageLinks } from '../assets/links.ts';
import { putCssBlob } from '../render/themes.ts';
import { canon, unwrapBody } from './canon.ts';
import { elements, parseHtml } from './html.ts';
import { type ListItem, analyseBody, bodySha } from './model.ts';
import { type Registry, registryCss } from './registry.ts';

export interface SaveInput {
  db: Database.Database;
  registry: Registry;
  /** `null`/absent creates a page; a number updates it. */
  pageId?: number | null;
  path: string;
  slug: string;
  title: string;
  template: string;
  status?: string;
  managedBy?: string;
  /** The editor's document (a fragment, wrapper or not). */
  html: string;
  /**
   * The component inventory the canvas believed it had (`data-gjs-type` values in document
   * order). Optional: a client that does not run the canvas is not asked to invent one, but
   * the editor always sends it, and then the stored locks must match (S4a F2b).
   */
  components?: string[];
  /** Defaults to the registry's concatenated rules when empty. */
  css?: string;
  note?: string;
  actorId?: number;
}

export interface SaveResult {
  id: number;
  created: boolean;
  rev: number;
  /** True when this save wrote `draft_*` only — the page is live and its body was protected. */
  draft: boolean;
  /** The row's publication state after the write. */
  status: string;
  bodyHtml: string;
  bodyCss: string;
  bodySha: string;
  /** `type -> rows`, for every list component in the document. */
  items: Record<string, ListItem[]>;
}

interface PageRow {
  id: number;
  rev: number;
  status: string;
  managed_by: string;
  template: string;
}

export async function savePage(input: SaveInput): Promise<SaveResult> {
  const { db, registry } = input;
  // The canvas answers `editor.getHtml()`, which is a `<body>…</body>` document, and a
  // page's `body_html` is a fragment. This is the **only** place the wrapper is stripped:
  // the fixpoint gate posts to this function's route, so it sees whatever this line
  // produces. A test helper with its own copy of this rule is how S4a F1 stayed green for
  // three slices (11/11 stored rows began with `<body>`).
  const document = unwrapBody(input.html);
  if (/<body[\s>]/i.test(document)) {
    // `unwrapBody` only strips a document that *is* one `<body>` at the root. Anything
    // else that still carries a `<body>` is not a canvas document and is not a fragment,
    // and storing it would put a second body inside the shell's `<main>`.
    throw new AppError('SKW_E_RT_BODY_FORBIDDEN', 'a page body must be a fragment, not a document', {
      page: input.path,
      rule: 'body-document',
    });
  }
  const analysing = analyseBody({ html: document, registry });
  const canonical = await canon(analysing.html);

  // The stored bytes are validated with the same function the editor loads through, and
  // then canonicalised again: `analyseBody` normalises (it drops the canvas's asset URLs),
  // so the comparison is `canon(analyse(canonical)) == canonical` — the fixpoint, not a
  // string identity between two serialisers.
  const stored = analyseBody({ html: canonical, registry });
  const reCanon = await canon(stored.html);
  if (reCanon !== canonical) {
    throw new AppError('SKW_E_RT_ROUNDTRIP_UNSTABLE', 'the canonical bytes do not survive a re-analyse', {
      page: input.path,
    });
  }

  // F2(b): the inventory the canvas sent is compared with the locks in the bytes about to
  // be written. (a) refuses an unregistered paste in the canvas, so this cannot see that
  // vector; what it sees is the complementary one — a lock the canvas *held* going missing
  // between the model and the bytes (a stale tab, a different client, a serialiser that
  // drops the attribute). It is a multiset comparison: two `hero` blocks and one is not a
  // match for one.
  if (input.components !== undefined) {
    const declared = [...input.components].sort();
    const actual = stored.components.map((component) => component.type).sort();
    const pool = [...actual];
    const missing: string[] = [];
    for (const type of declared) {
      const at = pool.indexOf(type);
      if (at === -1) missing.push(type);
      else pool.splice(at, 1);
    }
    if (missing.length > 0 || pool.length > 0) {
      throw new AppError(
        'SKW_E_RT_COMPONENT_INVENTORY',
        'the canvas and the bytes to be stored disagree about which components the page has',
        { page: input.path, missing, unexpected: pool, canvas: declared, stored: actual },
      );
    }
  }

  // §10.5 v1's frame decision (S4d item D): the policy is `frame-src 'none'` for **every**
  // tenant, and that is a promise the editor has to keep. An `<iframe>`/`<object>`/`<embed>`
  // stored in a body would be silently blanked by the browser, so it is refused here, by
  // name, instead of shipping a page that looks broken. The `embed` block is a link card
  // (`<div class="embed">`), not a frame: a tenant who needs YouTube gets a click-through,
  // not playback. Per-tenant frame declarations are a v2 decision; the CSP parameter exists
  // so the four producers move together when it is made.
  const frame = /<(iframe|frame|frameset|object|embed)\b/i.exec(canonical);
  if (frame !== null) {
    throw new AppError('SKW_E_RT_BODY_FORBIDDEN', 'v1 serves no frames: frame-src is none for every tenant', {
      page: input.path,
      rule: 'frame',
      element: frame[1]?.toLowerCase(),
    });
  }

  // §16 S4's publish row: `cms_page.template` names a shell, and the shell is a registry
  // row. A published page whose template is not `kind='shell'` is a 422 at publish — not a
  // 404 on a client's phone, which is where the old behaviour surfaced it.
  const status = input.status ?? 'draft';
  if (status === 'published') {
    const shell = registry.byName.get(input.template);
    if (shell === undefined || shell.kind !== 'shell') {
      throw new AppError('SKW_E_RT_TEMPLATE_UNKNOWN', `the page shell ${JSON.stringify(input.template)} is not a registered shell`, {
        page: input.path,
        template: input.template,
      });
    }
  }

  // S8s: `undefined` means "the caller has no opinion" — a caller creating a page from outside the
  // editor, which still gets the component registry's styles so the page is not unstyled. An
  // **empty string** is an opinion: the operator cleared the CSS panel and means it. Before this,
  // clearing the box silently refilled it with the registry's 960 bytes, so the panel could never
  // show what its own author had written.
  const css = input.css !== undefined ? input.css : registryCss(registry);
  const sha = bodySha(canonical);
  const managedBy = input.managedBy ?? 'editor';

  if (managedBy === 'hand') {
    // §10.6: a hand-edited page opens read-only, because the next drag would re-serialise
    // the model and lose the hand edit silently.
    throw new AppError('SKW_E_RT_PAGE_READONLY', 'a hand-managed page is not editable in the canvas', {
      page: input.path,
    });
  }

  // S8s replaced the rule that used to live here ("a non-empty body must carry a registered
  // component"). It was written when every element in the canvas came from the registry, and it
  // read a body of plain `<section>`/`<h1>`/`<p>` — which is exactly what the Basic palette
  // inserts — as the shape a degraded paste leaves behind. The distinction it was reaching for is
  // now made by type: `analyseBody` refuses a `data-gjs-type` nobody defines, and GrapesJS's own
  // types are legitimate content. So what is refused here is the remaining degenerate case —
  // text with no element in it at all, which no renderer can do anything with.
  if (stored.html.trim() !== '' && elements(parseHtml(stored.html)).length === 0) {
    throw new AppError('SKW_E_RT_BODY_FORBIDDEN', 'a page body with content must contain an element', {
      page: input.path,
      rule: 'no-element',
    });
  }

  const items: Record<string, ListItem[]> = {};
  for (const component of stored.components) {
    if (component.items !== undefined) items[component.type] = component.items;
  }

  const existing =
    input.pageId === undefined || input.pageId === null
      ? undefined
      : (db.prepare('SELECT id, rev, status, managed_by, template FROM cms_page WHERE id = ?').get(input.pageId) as
          | PageRow
          | undefined);
  if (input.pageId !== undefined && input.pageId !== null && existing === undefined) {
    throw new AppError('SKW_E_RT_PAGE_NOT_FOUND', 'no such page');
  }

  // `cms_page.path` is UNIQUE COLLATE NOCASE. A create at a path that already has a page is
  // a refusal with a code — the editor offers "new page" and a designer will type a path
  // that exists — and the same refusal covers the race, because SQLite's own UNIQUE is what
  // fires if two requests pass the SELECT together.
  if (existing === undefined) {
    const taken = db.prepare('SELECT id FROM cms_page WHERE path = ?').get(input.path) as { id: number } | undefined;
    if (taken !== undefined) {
      throw new AppError('SKW_E_DM_KEY_IN_USE', 'a page already has that path', { path: input.path, page: taken.id });
    }
  }

  // A page that has been published (or hidden, which still has a real body) gets its live bytes
  // protected. `status:'published'` is the direct-publish path — seeds, fixtures and tests; the
  // editor route never sends it, and the operator's Publish button goes through `publishPage`.
  const directPublish = input.status === 'published';
  const protectsBody = !directPublish && existing !== undefined && existing.status !== 'draft';

  const write = db.transaction((): { id: number; rev: number; draft: boolean } => {
    // S8s: the CSS is a file, and its name is its own sha256 — so the row that stores it has to
    // make sure the file exists. One insert per save, `INSERT OR IGNORE` on bytes we already have.
    if (css !== '') putCssBlob(db, css);
    // S8b (E-35). Two bodies, one row. `body_*` is what visitors are served and **only publish
    // writes it**; `draft_*` is what the editor writes. A save on a page that is already live
    // therefore writes the draft and leaves the live body alone — pressing Save in the canvas
    // must not take a working site down, which is exactly what it used to do (it overwrote
    // `body_html` and set `status='draft'` in one statement).
    if (protectsBody && existing !== undefined) {
      db.prepare(
        `UPDATE cms_page
            SET path = ?, slug = ?, title = ?, template = ?,
                draft_html = ?, draft_css = ?, draft_sha = ?,
                draft_updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_by = ?
          WHERE id = ?`,
      ).run(input.path, input.slug, input.title, input.template, canonical, css, sha, input.actorId ?? null, existing.id);
      return { id: existing.id, rev: existing.rev, draft: true };
    }

    // Every other shape writes the body itself: a new page, a page that has never been published
    // (its body is the only copy, and the O-29 preview token renders it), and a caller that asks
    // for `status:'published'` directly (seeds and tests — the editor never sends it).
    let id: number;
    let rev: number;
    if (existing === undefined) {
      const info = db
        .prepare(
          `INSERT INTO cms_page (path, slug, title, status, template, body_html, body_css, rev, body_sha,
                                 draft_html, draft_css, draft_sha, draft_updated_at, managed_by, updated_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, ?)`,
        )
        .run(input.path, input.slug, input.title, status, input.template, canonical, css, sha, canonical, css, sha, managedBy, input.actorId ?? null);
      id = Number(info.lastInsertRowid);
      rev = 0;
    } else {
      rev = existing.rev + 1;
      db.prepare(
        `UPDATE cms_page
            SET path = ?, slug = ?, title = ?, status = ?, template = ?, body_html = ?, body_css = ?,
                rev = ?, body_sha = ?, draft_html = ?, draft_css = ?, draft_sha = ?,
                draft_updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                published_at = CASE WHEN ? = 'published' THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE published_at END,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_by = ?
          WHERE id = ?`,
      ).run(
        input.path,
        input.slug,
        input.title,
        status,
        input.template,
        canonical,
        css,
        rev,
        sha,
        canonical,
        css,
        sha,
        status,
        input.actorId ?? null,
        existing.id,
      );
      id = existing.id;
    }
    db.prepare(
      `INSERT INTO cms_page_revision (page_id, rev, body_html, body_css, note, created_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, rev, canonical, css, input.note ?? (existing === undefined ? 'created in the editor' : 'saved in the editor'), input.actorId ?? null);
    return { id, rev, draft: false };
  });

  const written = write();
  // D17's graph: a body that names a key owns a `cms_asset_link`, which is what the export
  // refuses a gated asset on (§11.3 refusal 2). The graph is scanned from `body_html` — the
  // published body — because that is what an export ships. A draft that names a gated asset
  // therefore does not block an export until it is published, which is the correct order.
  syncPageLinks(db, written.id);

  const statusAfter = protectsBody
    ? (existing?.status ?? 'draft')
    : directPublish
      ? 'published'
      : status;

  return {
    id: written.id,
    created: existing === undefined,
    rev: written.rev,
    draft: written.draft,
    status: statusAfter,
    bodyHtml: canonical,
    bodyCss: css,
    bodySha: sha,
    items,
  };
}

/**
 * The load path. It refuses an unregistered type **before** the document reaches GrapesJS,
 * which is the only moment at which the evidence still exists.
 */
export function loadForEditor(
  db: Database.Database,
  registry: Registry,
  pageId: number,
): {
  id: number;
  path: string;
  title: string;
  template: string;
  status: string;
  managedBy: string;
  bodyHtml: string;
  bodyCss: string;
  rev: number;
  /** There are unpublished changes: what the canvas holds is not what visitors are served. */
  draft: boolean;
} {
  const row = db
    .prepare(
      `SELECT id, path, title, template, status, managed_by, body_html, body_css, rev, draft_html, draft_css, draft_sha
         FROM cms_page WHERE id = ?`,
    )
    .get(pageId) as
    | {
        id: number;
        path: string;
        title: string;
        template: string;
        status: string;
        managed_by: string;
        body_html: string;
        body_css: string;
        rev: number;
        draft_html: string;
        draft_css: string;
        draft_sha: string;
      }
    | undefined;
  if (row === undefined) throw new AppError('SKW_E_RT_PAGE_NOT_FOUND', 'no such page');
  // The canvas opens what the operator last worked on, not what visitors are being served.
  // `draft_sha = ''` is the honest "nothing pending"; comparing it with `body_sha` would also
  // work, but the empty string is the state publish leaves behind, so it is the cheaper truth.
  const hasDraft = row.draft_sha !== '';
  const html = hasDraft ? row.draft_html : row.body_html;
  const css = hasDraft ? row.draft_css : row.body_css;
  // Throws SKW_E_RT_COMPONENT_UNKNOWN, naming the type and the node.
  analyseBody({ html, registry });
  return {
    id: row.id,
    path: row.path,
    title: row.title,
    template: row.template,
    status: row.status,
    managedBy: row.managed_by,
    bodyHtml: html,
    bodyCss: css,
    rev: row.rev,
    draft: hasDraft,
  };
}
