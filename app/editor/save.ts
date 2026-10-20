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
import { canon } from './canon.ts';
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
  /** Defaults to the registry's concatenated rules when empty. */
  css?: string;
  note?: string;
  actorId?: number;
}

export interface SaveResult {
  id: number;
  created: boolean;
  rev: number;
  bodyHtml: string;
  bodyCss: string;
  bodySha: string;
  /** `type -> rows`, for every list component in the document. */
  items: Record<string, ListItem[]>;
}

interface PageRow {
  id: number;
  rev: number;
  managed_by: string;
  template: string;
}

export async function savePage(input: SaveInput): Promise<SaveResult> {
  const { db, registry } = input;
  const analysing = analyseBody({ html: input.html, registry });
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

  const css = input.css !== undefined && input.css.trim() !== '' ? input.css : registryCss(registry);
  const sha = bodySha(canonical);
  const status = input.status ?? 'draft';
  const managedBy = input.managedBy ?? 'editor';

  if (managedBy === 'hand') {
    // §10.6: a hand-edited page opens read-only, because the next drag would re-serialise
    // the model and lose the hand edit silently.
    throw new AppError('SKW_E_RT_PAGE_READONLY', 'a hand-managed page is not editable in the canvas', {
      page: input.path,
    });
  }

  const items: Record<string, ListItem[]> = {};
  for (const component of stored.components) {
    if (component.items !== undefined) items[component.type] = component.items;
  }

  const existing =
    input.pageId === undefined || input.pageId === null
      ? undefined
      : (db.prepare('SELECT id, rev, managed_by, template FROM cms_page WHERE id = ?').get(input.pageId) as
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

  const write = db.transaction((): { id: number; rev: number } => {
    let id: number;
    let rev: number;
    if (existing === undefined) {
      const info = db
        .prepare(
          `INSERT INTO cms_page (path, slug, title, status, template, body_html, body_css, rev, body_sha, managed_by, updated_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
        )
        .run(input.path, input.slug, input.title, status, input.template, canonical, css, sha, managedBy, input.actorId ?? null);
      id = Number(info.lastInsertRowid);
      rev = 0;
    } else {
      rev = existing.rev + 1;
      db.prepare(
        `UPDATE cms_page
            SET path = ?, slug = ?, title = ?, status = ?, template = ?, body_html = ?, body_css = ?,
                rev = ?, body_sha = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_by = ?
          WHERE id = ?`,
      ).run(input.path, input.slug, input.title, status, input.template, canonical, css, rev, sha, input.actorId ?? null, existing.id);
      id = existing.id;
    }
    db.prepare(
      `INSERT INTO cms_page_revision (page_id, rev, body_html, body_css, note, created_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, rev, canonical, css, input.note ?? (existing === undefined ? 'created in the editor' : 'saved in the editor'), input.actorId ?? null);
    return { id, rev };
  });

  const { id, rev } = write();
  // D17's graph: a body that names a key owns a `cms_asset_link`, which is what the export
  // refuses a gated asset on (§11.3 refusal 2).
  syncPageLinks(db, id);

  return { id, created: existing === undefined, rev, bodyHtml: canonical, bodyCss: css, bodySha: sha, items };
}

/**
 * The load path. It refuses an unregistered type **before** the document reaches GrapesJS,
 * which is the only moment at which the evidence still exists.
 */
export function loadForEditor(
  db: Database.Database,
  registry: Registry,
  pageId: number,
): { id: number; path: string; title: string; template: string; status: string; managedBy: string; bodyHtml: string; bodyCss: string; rev: number } {
  const row = db
    .prepare(
      `SELECT id, path, title, template, status, managed_by, body_html, body_css, rev
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
      }
    | undefined;
  if (row === undefined) throw new AppError('SKW_E_RT_PAGE_NOT_FOUND', 'no such page');
  // Throws SKW_E_RT_COMPONENT_UNKNOWN, naming the type and the node.
  analyseBody({ html: row.body_html, registry });
  return {
    id: row.id,
    path: row.path,
    title: row.title,
    template: row.template,
    status: row.status,
    managedBy: row.managed_by,
    bodyHtml: row.body_html,
    bodyCss: row.body_css,
    rev: row.rev,
  };
}
