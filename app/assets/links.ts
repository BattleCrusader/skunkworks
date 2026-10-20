/**
 * §7.1 — the usage graph: `cms_asset_link`, one row per (asset, owner, id).
 *
 * The graph is what turns "can I delete this?" into a fact instead of a guess. Two owners
 * are written today:
 *
 *   - **page** — a body that names `/media/<key>.<ext>`. That URL form is the only reference
 *     a foreign key can never see (§7.1: "URL-level renames for keys already frozen inside
 *     `body_html`"), which is exactly why the graph has to be built by scanning, and why
 *     `cms_asset_alias` exists beside it.
 *   - **datasource** — a source that projects a `u_*` column of DDL type `ASSET`. The links
 *     are the *distinct values* the column holds, because the source can serve any of them.
 *
 * `settings` and `bundle` are legal owner kinds in the schema and are not written here:
 * settings are edited by the CRUD path (S3b) and bundles by the bundle editor, and inventing
 * a scan for either would be a link row nobody asked for.
 */
import type Database from 'better-sqlite3';

export type OwnerKind = 'page' | 'settings' | 'bundle' | 'datasource';

export interface LinkRef {
  ownerKind: OwnerKind;
  ownerId: number;
}

const KEY_SHAPE = /^[a-z0-9][a-z0-9/_.-]*$/;

/**
 * The key a URL names, resolved through the alias table: `/media/old-name.png` still reaches
 * the asset after an unreferenced rename. Returns undefined when neither a key nor an alias
 * matches, so a caller cannot mistake "renamed" for "gone".
 *
 * Lives here rather than in `library.ts` so the row module may import the graph without a
 * cycle, and because every caller of it is resolving a *reference*.
 */
export function resolveAssetId(db: Database.Database, key: string): number | undefined {
  const direct = db.prepare('SELECT id FROM cms_asset WHERE key = ?').get(key) as { id: number } | undefined;
  if (direct !== undefined) return direct.id;
  const alias = db.prepare('SELECT asset_id FROM cms_asset_alias WHERE key = ?').get(key) as
    | { asset_id: number }
    | undefined;
  return alias?.asset_id;
}

/** `/media/<key>.<ext>` anywhere in a body, de-duplicated, in first-seen order. */
export function assetRefsInHtml(html: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const pattern = /\/media\/([a-z0-9][a-z0-9/_.-]*?)\.(?:webp|jpe?g|png|avif|pdf|mp4|mp3|zip)(?=["'?#\s>)]|$)/gi;
  for (const match of html.matchAll(pattern)) {
    const key = (match[1] ?? '').toLowerCase();
    if (key === '' || !KEY_SHAPE.test(key) || key.includes('..') || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

export function linkAsset(db: Database.Database, ref: LinkRef & { assetId: number }): boolean {
  const info = db
    .prepare(
      `INSERT INTO cms_asset_link (asset_id, owner_kind, owner_id) VALUES (?, ?, ?)
       ON CONFLICT DO NOTHING`,
    )
    .run(ref.assetId, ref.ownerKind, ref.ownerId);
  return info.changes === 1;
}

export function unlinkAsset(db: Database.Database, ref: LinkRef & { assetId: number }): number {
  const info = db
    .prepare('DELETE FROM cms_asset_link WHERE asset_id = ? AND owner_kind = ? AND owner_id = ?')
    .run(ref.assetId, ref.ownerKind, ref.ownerId);
  return info.changes;
}

export function linksForAsset(db: Database.Database, assetId: number): { owner_kind: OwnerKind; owner_id: number }[] {
  return db
    .prepare('SELECT owner_kind, owner_id FROM cms_asset_link WHERE asset_id = ? ORDER BY owner_kind, owner_id')
    .all(assetId) as { owner_kind: OwnerKind; owner_id: number }[];
}

/** Every asset and alias key a page names, resolved to ids. Unknown keys are skipped, not linked. */
export function pageAssetIds(db: Database.Database, pageId: number): number[] {
  const row = db.prepare('SELECT body_html FROM cms_page WHERE id = ?').get(pageId) as
    | { body_html: string }
    | undefined;
  if (row === undefined) return [];
  const ids: number[] = [];
  for (const key of assetRefsInHtml(row.body_html)) {
    const id = resolveAssetId(db, key);
    if (id !== undefined && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

export interface SyncResult {
  linked: number;
  removed: number;
}

/** Make the page's link rows equal to the references in its body. */
export function syncPageLinks(db: Database.Database, pageId: number): SyncResult {
  const wanted = new Set(pageAssetIds(db, pageId));
  const current = new Set(
    (db.prepare("SELECT asset_id FROM cms_asset_link WHERE owner_kind = 'page' AND owner_id = ?").all(pageId) as {
      asset_id: number;
    }[]).map((r) => r.asset_id),
  );
  let linked = 0;
  let removed = 0;
  const run = db.transaction((): void => {
    for (const id of wanted) if (!current.has(id) && linkAsset(db, { assetId: id, ownerKind: 'page', ownerId: pageId })) linked += 1;
    for (const id of current) if (!wanted.has(id)) removed += unlinkAsset(db, { assetId: id, ownerKind: 'page', ownerId: pageId });
  });
  run();
  return { linked, removed };
}

/**
 * A source that projects an `ASSET` column can serve any value that column holds, so every
 * distinct non-NULL value is a reference. The column list comes from `cms_table_registry`
 * (the DDL's own closed-type inventory), never from the spec alone: a column the registry does
 * not call `ASSET` is not treated as one.
 */
export function datasourceAssetIds(db: Database.Database, datasourceId: number): number[] {
  const source = db.prepare('SELECT spec_json FROM cms_datasource WHERE id = ?').get(datasourceId) as
    | { spec_json: string }
    | undefined;
  if (source === undefined) return [];
  let spec: { table?: unknown; columns?: unknown };
  try {
    spec = JSON.parse(source.spec_json) as { table?: unknown; columns?: unknown };
  } catch {
    return [];
  }
  const table = typeof spec.table === 'string' ? spec.table : '';
  if (!/^[a-z][a-z0-9_]*$/.test(table)) return [];
  const registry = db.prepare('SELECT columns_json FROM cms_table_registry WHERE table_name = ?').get(table) as
    | { columns_json: string }
    | undefined;
  if (registry === undefined) return [];

  const assetColumns = new Set<string>();
  try {
    for (const column of JSON.parse(registry.columns_json) as { name?: unknown; type?: unknown }[]) {
      if (typeof column.name === 'string' && typeof column.type === 'string' && column.type.toUpperCase() === 'ASSET') {
        assetColumns.add(column.name);
      }
    }
  } catch {
    return [];
  }
  const projected = Array.isArray(spec.columns)
    ? spec.columns.filter((c): c is string => typeof c === 'string' && assetColumns.has(c))
    : [...assetColumns];
  if (projected.length === 0) return [];

  const ids: number[] = [];
  for (const column of projected) {
    // Identifiers are checked against KEY_SHAPE-ish rules above, so quoting is belt and braces.
    const rows = db.prepare(`SELECT DISTINCT "${column}" AS k FROM "${table}" WHERE "${column}" IS NOT NULL`).all() as {
      k: unknown;
    }[];
    for (const row of rows) {
      if (typeof row.k !== 'string') continue;
      const id = resolveAssetId(db, row.k);
      if (id !== undefined && !ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}

export function syncDatasourceLinks(db: Database.Database, datasourceId: number): SyncResult {
  const wanted = new Set(datasourceAssetIds(db, datasourceId));
  const current = new Set(
    (
      db.prepare("SELECT asset_id FROM cms_asset_link WHERE owner_kind = 'datasource' AND owner_id = ?").all(datasourceId) as {
        asset_id: number;
      }[]
    ).map((r) => r.asset_id),
  );
  let linked = 0;
  let removed = 0;
  const run = db.transaction((): void => {
    for (const id of wanted) {
      if (!current.has(id) && linkAsset(db, { assetId: id, ownerKind: 'datasource', ownerId: datasourceId })) linked += 1;
    }
    for (const id of current) {
      if (!wanted.has(id)) removed += unlinkAsset(db, { assetId: id, ownerKind: 'datasource', ownerId: datasourceId });
    }
  });
  run();
  return { linked, removed };
}
