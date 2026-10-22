/**
 * Publish: move a page's draft into the body visitors are served.
 *
 * This module exists because the operation did not. Until S8b the editor's Save *was* publish,
 * in the sense that it overwrote `cms_page.body_html` and set `status='draft'` at the same time —
 * so a page could go from live to invisible in one click, and there was no second click that put
 * it back. The page list's "Finish" button linked to the editor; the editor had no publish
 * control; the copy promised a publish step that no route implemented.
 *
 * What publish does, in one transaction:
 *
 *   1. refuses (400 `SKW_E_PLT_REQUEST_INVALID`) when there is no pending draft — a publish with
 *      nothing to publish is a mistake, and answering `ok` would hide it;
 *   2. refuses (422 `SKW_E_RT_TEMPLATE_UNKNOWN`) when the page's shell is not a registered
 *      `kind='shell'` row. §16 S4's publish row, moved here from the save path: the check belongs
 *      at the moment a body becomes public, not at the moment it is typed;
 *   3. copies `draft_*` into `body_*`, sets `status='published'`, stamps `published_at`, appends
 *      the published bytes to `cms_page_revision`, and clears the draft;
 *   4. leaves `rev` alone for a page that has never been published (its body already carries the
 *      revision number the editor gave it) and increments it for a page whose live body was
 *      being protected. `rev` is the revision of the bytes in `body_html`; both branches keep
 *      that true.
 *
 * The asset-link graph is re-scanned from the new published body inside the same call, so the
 * usage counts and the export's gated-asset refusal describe what is live, not what is drafted.
 */
import type Database from 'better-sqlite3';

import { syncPageLinks } from '../assets/links.ts';
import { putCssBlob } from '../render/themes.ts';
import { AppError } from '../errors.ts';
import type { Registry } from './registry.ts';

export interface PublishInput {
  db: Database.Database;
  registry: Registry;
  pageId: number;
  actorId?: number;
  /** Defaults to 'published in the editor'. Goes into the revision row's `note`. */
  note?: string;
  now?: () => Date;
}

export interface PublishResult {
  id: number;
  path: string;
  status: string;
  rev: number;
  publishedAt: string;
  bodySha: string;
}

interface Row {
  id: number;
  path: string;
  status: string;
  template: string;
  body_sha: string;
  rev: number;
  draft_html: string;
  draft_css: string;
  draft_sha: string;
}

export function publishPage(input: PublishInput): PublishResult {
  const { db, registry } = input;
  const row = db
    .prepare('SELECT id, path, status, template, body_sha, rev, draft_html, draft_css, draft_sha FROM cms_page WHERE id = ?')
    .get(input.pageId) as Row | undefined;
  if (row === undefined) throw new AppError('SKW_E_RT_PAGE_NOT_FOUND', 'no such page');

  if (row.draft_sha === '') {
    throw new AppError('SKW_E_PLT_REQUEST_INVALID', 'there is nothing to publish: no draft has been saved since the last publish', {
      page: row.path,
    });
  }

  // §16 S4's publish row: `cms_page.template` names a shell, and the shell is a registry row.
  // Checked here because "becomes visible to the world" is the moment that matters; the editor
  // will not save a page whose shell vanished mid-edit, but a bundle can be restored from a
  // backup where the registry moved on.
  const shell = registry.byName.get(row.template);
  if (shell === undefined || shell.kind !== 'shell') {
    throw new AppError('SKW_E_RT_TEMPLATE_UNKNOWN', `the page shell ${JSON.stringify(row.template)} is not a registered shell`, {
      page: row.path,
      template: row.template,
    });
  }

  const at = (input.now ?? (() => new Date()))().toISOString();
  // A page that was already live has been serving `body_html` while the draft waited, so this is
  // its next body revision. A page that was never live has been revising the one body it has,
  // and publishing ships the number that body already carries.
  const rev = row.status === 'draft' ? row.rev : row.rev + 1;

  db.transaction(() => {
    db.prepare(
      `UPDATE cms_page
          SET body_html = ?, body_css = ?, body_sha = ?,
              status = 'published', published_at = ?,
              rev = ?,
              draft_html = '', draft_css = '', draft_sha = '', draft_updated_at = NULL,
              updated_at = ?, updated_by = ?
        WHERE id = ?`,
    ).run(row.draft_html, row.draft_css, row.draft_sha, at, rev, at, input.actorId ?? null, row.id);

    // S8s: the live page's CSS becomes a file at `/_css/<sha>.css`; name it as it is published,
    // so the document that starts linking it never points at a 404.
    if (row.draft_css !== '') putCssBlob(db, row.draft_css);
    db.prepare(
      `INSERT INTO cms_page_revision (page_id, rev, body_html, body_css, note, created_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(row.id, rev, row.draft_html, row.draft_css, input.note ?? 'published from the editor', input.actorId ?? null);

    syncPageLinks(db, row.id);
  })();

  return { id: row.id, path: row.path, status: 'published', rev, publishedAt: at, bodySha: row.draft_sha };
}
