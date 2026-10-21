/**
 * `cms_nav` -> the header and footer menus (SDS §3, §4.4; `schema/site.sql`).
 *
 * Until this module existed `cms_nav` had no reader in `app/`: the table, its
 * `ux_nav_pos` index and its admin CRUD form were all there, and a tenant site had no
 * menu. A row is not a menu until something renders it, so this is that something.
 *
 * ## The shape, and why one query per location
 *
 * `cms_nav` is an adjacency list whose unique key is
 * `(location, ifnull(parent_id, 0), position)`. One query per location
 * (`WHERE location = ? AND visible = 1`) is a SEARCH on `ux_nav_pos` and returns every
 * row the menu needs; the tree is assembled in memory. A query per parent would be
 * `WHERE parent_id = ?`, whose leading column the index does not have — the exact scan
 * shape `test/index-audit.test.ts` refuses.
 *
 * ## What is refused, and why the whole page rather than one link
 *
 * A menu entry the server cannot resolve is a dead link the CMS itself created. Three
 * shapes are refused **by name** (the row's label and target are in the message):
 *
 *   - `page` -> a path with no published `cms_page` row. A draft is not a page yet: a
 *     preview visitor following it would get the 404 the CMS could have predicted.
 *   - `asset` -> a key with no row, or a `gated` asset. A gated asset has no farm link
 *     (`app/assets/url.ts`: `url` is null), so a menu entry for it would be a 404
 *     dressed as a resource — and a public one would publish paid bytes.
 *   - `url` -> anything that is not `http:`/`https:`. `javascript:` in an `href` is the
 *     one XSS a server-side renderer can hand a browser with no script tag at all.
 *
 * Rendering the rest of the page with the bad entry dropped was the alternative. It is
 * worse: the operator's menu silently loses an item, and the only report is a reader
 * who cannot find a page. The refusal fails the render, names the row, and leaves the
 * browser with no dead `href`.
 *
 * ## Hiding
 *
 * `visible = 0` rows do not render, and neither do their descendants: an invisible
 * parent with visible children would either promote the children to the top level
 * (changing the menu's meaning) or render them under nothing. Hiding a branch hides the
 * branch. That is a rendering rule, not a refusal, because it is what the column says.
 */
import type Database from 'better-sqlite3';

import { assetByKey } from '../assets/library.ts';
import { assetUrl } from '../assets/url.ts';
import { AppError } from '../errors.ts';

export type NavLocation = 'header' | 'footer';

export interface NavItem {
  label: string;
  /** A path (`/about`), an absolute URL (`https://…`) or a derived asset URL. */
  href: string;
  children: NavItem[];
}

export interface NavTree {
  header: NavItem[];
  footer: NavItem[];
}

/** The locations the shell renders live in `loadNav`; `sidebar` exists in the schema and no
 *  shell reads it, which is why it is not in the tree rather than in it and empty. */

interface NavRow {
  id: number;
  parent_id: number | null;
  label: string;
  href_kind: string;
  href_target: string;
  position: number;
}

/** The same internal-path predicate the schema's CHECKs use, in JavaScript. */
function isInternalPath(path: string): boolean {
  if (path === '/') return true;
  return path.startsWith('/') && !path.includes('..') && !path.includes('//') && !path.endsWith('/');
}

function refuse(row: NavRow, code: 'SKW_E_RT_NAV_TARGET_MISSING' | 'SKW_E_RT_NAV_HREF_REFUSED', why: string): never {
  // The label and the target are the name an operator needs; the row id makes the
  // message unambiguous when two entries share a label. `safeMessage()` drops anything
  // containing a slash from the wire body, so this text is for the log and the test.
  throw new AppError(
    code,
    `nav item ${row.id} "${row.label}" (${row.href_kind}) ${why}: ${row.href_target}`,
    { navId: row.id, label: row.label, target: row.href_target },
  );
}

/**
 * S8l: what "a published page" means for a menu entry.
 *
 * A `cms_page` row was the only answer until S8k gave packages the ability to serve a path
 * themselves (`/blog/<slug>` is a row in `p_blog_post`, not a page). A header link to the blog
 * would then have been refused as a dead link by a renderer that had simply never been told
 * about the new source. `pageExists` is how the caller says "and these too", and a tenant with
 * no packages loaded passes nothing — the old refusal stands unchanged.
 */
export type PageExists = (path: string) => boolean;

function hrefFor(db: Database.Database, row: NavRow, pageExists?: PageExists): string {
  switch (row.href_kind) {
    case 'page': {
      if (!isInternalPath(row.href_target)) {
        refuse(row, 'SKW_E_RT_NAV_HREF_REFUSED', 'is not an internal path');
      }
      // `cms_page.path` is COLLATE NOCASE, so this comparison is case-insensitive for
      // the same reason the renderer's own lookup is (O-01).
      const page = db.prepare('SELECT status FROM cms_page WHERE path = ?').get(row.href_target) as
        | { status: string }
        | undefined;
      const declaredByPackage = pageExists !== undefined && pageExists(row.href_target);
      if (!declaredByPackage && (page === undefined || page.status !== 'published')) {
        refuse(row, 'SKW_E_RT_NAV_TARGET_MISSING', 'points at a path with no published page');
      }
      return row.href_target;
    }
    case 'asset': {
      const asset = assetByKey(db, row.href_target);
      if (asset === undefined) {
        refuse(row, 'SKW_E_RT_NAV_TARGET_MISSING', 'names an asset that does not exist');
      }
      if (asset.access_class === 'gated') {
        refuse(row, 'SKW_E_RT_NAV_HREF_REFUSED', 'names a gated asset, which has no public URL');
      }
      return assetUrl(asset);
    }
    case 'url': {
      let parsed: URL | undefined;
      try {
        parsed = new URL(row.href_target);
      } catch {
        parsed = undefined;
      }
      if (parsed === undefined) {
        refuse(row, 'SKW_E_RT_NAV_HREF_REFUSED', 'is not an absolute URL');
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        refuse(row, 'SKW_E_RT_NAV_HREF_REFUSED', `uses the ${parsed.protocol} scheme, which a menu may not carry`);
      }
      return row.href_target;
    }
    default:
      // The schema's CHECK closes this set, but a hand-edited file is not the schema.
      refuse(row, 'SKW_E_RT_NAV_HREF_REFUSED', 'has an href_kind this renderer does not know');
  }
}

/**
 * One location's menu, assembled in `position` order.
 *
 * The query orders by `(ifnull(parent_id, 0), position)`, so roots arrive first in their
 * own order and each parent's children arrive in theirs. The tree is built in two passes
 * (all nodes, then links) because a grandchild's parent can be a child that was created
 * later — the node map makes attachment independent of row order.
 */
function loadLocation(db: Database.Database, location: NavLocation, pageExists?: PageExists): NavItem[] {
  const rows = db
    .prepare(
      `SELECT id, parent_id, label, href_kind, href_target, position
         FROM cms_nav
        WHERE location = ? AND visible = 1
        ORDER BY ifnull(parent_id, 0), position`,
    )
    .all(location) as NavRow[];

  const nodes = new Map<number, NavItem>();
  for (const row of rows) {
    nodes.set(row.id, { label: row.label, href: hrefFor(db, row, pageExists), children: [] });
  }

  // A cycle is only reachable through an UPDATE (the FK refuses a non-existent parent,
  // not a loop), and rendering it would recurse forever. Refuse it by name instead.
  const parentOf = new Map<number, number | null>();
  for (const row of rows) parentOf.set(row.id, row.parent_id);
  for (const row of rows) {
    let at = row.parent_id;
    let steps = 0;
    while (at !== null && steps <= rows.length) {
      if (at === row.id) {
        refuse(row, 'SKW_E_RT_NAV_HREF_REFUSED', 'is its own ancestor');
      }
      at = parentOf.get(at) ?? null;
      steps += 1;
    }
  }

  const roots: NavItem[] = [];
  for (const row of rows) {
    const node = nodes.get(row.id) as NavItem;
    if (row.parent_id === null) {
      roots.push(node);
      continue;
    }
    const parent = nodes.get(row.parent_id);
    // An invisible (or absent) parent hides its branch — see the module comment.
    if (parent === undefined) continue;
    parent.children.push(node);
  }
  return roots;
}

/** The two menus the shell renders, both read from `cms_nav`. */
export function loadNav(db: Database.Database, opts: { pageExists?: PageExists } = {}): NavTree {
  return {
    header: loadLocation(db, 'header', opts.pageExists),
    footer: loadLocation(db, 'footer', opts.pageExists),
  };
}

