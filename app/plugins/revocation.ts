/**
 * Revocation — the one trust act that can take a package back (§8.5, C-9, D27).
 *
 * **Two sources of truth, and that is the defect this file fixes.** `cms_plugin_revoked` is a
 * tenant table an operator's `skwctl plugin revoke` writes; `data/trust/revoked.json` is the
 * file §8.5 names as the install's own record. Before this module existed nothing in the tree
 * wrote either one: a root written by hand into `data/trust/revoked.json` installed cleanly,
 * exited 0, and appeared in the audit chain as a trusted package — measured in the S5 QA, and
 * the reason this file exists. Reading one and writing the other is how a "second source of
 * truth waiting to disagree with the first" (E-29's open item) becomes a single answer with
 * two copies: **every read consults both, and a root present in either is revoked.**
 *
 * A revoke writes both, in that order — the table first (inside the caller's transaction, so a
 * failure leaves nothing half-done) and then the file, atomically (tmp + rename, 0600). The
 * file is what survives a `site.db` restore, which is the reason it is not redundant.
 *
 * **Revocation is checked at install *and* at enable.** Under D36 enable is the moment code
 * starts running (`import()` on the next request), so a package that was installed while
 * trusted and revoked afterwards must be stoppable without an uninstall — otherwise the only
 * lever an operator has is the destructive one, and revocation would be a word about the past.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type Database from 'better-sqlite3';

/** The file's own format marker. A file that does not carry it is not read as a revocation list. */
export const REVOCATION_FORMAT = 'skw-revoked/1';

export interface RevokedEntry {
  root_hash: string;
  plugin_id: string;
  reason: string | null;
  revoked_at: string;
  /** Where the answer came from, for the refusal message and the audit row. */
  source: 'file' | 'table';
}

interface RevocationFile {
  format?: unknown;
  revoked?: unknown;
}

const ROOT = /^[0-9a-f]{64}$/;

export function revocationPath(trustDir: string): string {
  return join(trustDir, 'revoked.json');
}

/**
 * The file as a list. Tolerant in one direction only: a missing file is an empty list (a box
 * that never revoked anything), and a file that exists but cannot be read as a list is a
 * **refusal to guess** — it throws, because "the revocation list is corrupt" must not read as
 * "nothing is revoked".
 */
export function readRevocationFile(trustDir: string): RevokedEntry[] {
  const path = revocationPath(trustDir);
  if (!existsSync(path)) return [];
  let parsed: RevocationFile;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as RevocationFile;
  } catch (err) {
    throw new Error(`the revocation list at ${path} is not JSON: ${String(err)}`);
  }
  if (parsed.format !== REVOCATION_FORMAT) {
    throw new Error(`the revocation list at ${path} has format ${JSON.stringify(parsed.format)}, not ${REVOCATION_FORMAT}`);
  }
  if (!Array.isArray(parsed.revoked)) throw new Error(`the revocation list at ${path} carries no "revoked" array`);
  const entries: RevokedEntry[] = [];
  for (const raw of parsed.revoked) {
    if (typeof raw !== 'object' || raw === null) continue;
    const e = raw as Record<string, unknown>;
    const root = typeof e.root_hash === 'string' ? e.root_hash.toLowerCase() : '';
    if (!ROOT.test(root)) continue;
    entries.push({
      root_hash: root,
      plugin_id: typeof e.plugin_id === 'string' ? e.plugin_id : '(unnamed)',
      reason: typeof e.reason === 'string' ? e.reason : null,
      revoked_at: typeof e.revoked_at === 'string' ? e.revoked_at : '',
      source: 'file',
    });
  }
  return entries;
}

/** The table's rows, or `[]` when the tenant predates the table. Never throws on a missing table. */
export function readRevocationTable(db: Database.Database): RevokedEntry[] {
  const table = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cms_plugin_revoked'`).get();
  if (table === undefined) return [];
  const rows = db
    .prepare('SELECT root_hash, plugin_id, reason, revoked_at FROM cms_plugin_revoked ORDER BY revoked_at')
    .all() as { root_hash: string; plugin_id: string; reason: string | null; revoked_at: string }[];
  return rows.map((row) => ({
    root_hash: String(row.root_hash).toLowerCase(),
    plugin_id: String(row.plugin_id),
    reason: row.reason,
    revoked_at: String(row.revoked_at),
    source: 'table' as const,
  }));
}

/**
 * Is this root revoked, on this install? **Both sources, always.**
 *
 * The table is the tenant's own statement; the file is the install's. A package root in
 * either one is refused, and the answer names which one said so — an operator who revoked a
 * root in the file and is told "the table says so" would go looking in the wrong place.
 */
export function revokedRoot(trustDir: string, db: Database.Database, root: string): RevokedEntry | null {
  const wanted = root.toLowerCase();
  const fromFile = readRevocationFile(trustDir).find((e) => e.root_hash === wanted);
  if (fromFile !== undefined) return fromFile;
  return readRevocationTable(db).find((e) => e.root_hash === wanted) ?? null;
}

export interface RevokeRequest {
  trustDir: string;
  /** The tenant's `site.db`, or `null` to write only the file (an install-wide revoke). */
  db: Database.Database | null;
  rootHash: string;
  pluginId: string;
  reason?: string;
  operatorId?: number | null;
  now?: string;
}

/**
 * Record a revocation in both places. Idempotent: revoking a root twice is not an error, and
 * the second call does not rewrite the timestamp the first one wrote.
 */
export function revokeRoot(req: RevokeRequest): { entry: RevokedEntry; table_written: boolean; file_written: boolean } {
  const root = req.rootHash.toLowerCase();
  if (!ROOT.test(root)) throw new Error(`revocation needs a 64-hex package root, not ${JSON.stringify(req.rootHash)}`);
  const now = req.now ?? new Date().toISOString();
  let tableWritten = false;
  if (req.db !== null) {
    const info = req.db
      .prepare(
        `INSERT INTO cms_plugin_revoked (root_hash, plugin_id, reason, revoked_by, revoked_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(root_hash) DO NOTHING`,
      )
      .run(root, req.pluginId, req.reason ?? null, req.operatorId ?? null, now);
    tableWritten = info.changes > 0;
  }
  const existing = readRevocationFile(req.trustDir);
  const already = existing.find((e) => e.root_hash === root);
  let fileWritten = false;
  if (already === undefined) {
    const next = [
      ...existing.map((e) => ({ root_hash: e.root_hash, plugin_id: e.plugin_id, reason: e.reason, revoked_at: e.revoked_at })),
      { root_hash: root, plugin_id: req.pluginId, reason: req.reason ?? null, revoked_at: now },
    ];
    mkdirSync(dirname(revocationPath(req.trustDir)), { recursive: true, mode: 0o700 });
    const staging = `${revocationPath(req.trustDir)}.tmp-${process.pid}`;
    writeFileSync(staging, `${JSON.stringify({ format: REVOCATION_FORMAT, revoked: next }, null, 2)}\n`, { mode: 0o600 });
    renameSync(staging, revocationPath(req.trustDir));
    fileWritten = true;
  }
  return {
    entry: { root_hash: root, plugin_id: req.pluginId, reason: req.reason ?? null, revoked_at: now, source: req.db !== null ? 'table' : 'file' },
    table_written: tableWritten,
    file_written: fileWritten,
  };
}
