/**
 * exportSnapshot() — SDS §2.2: "the only function that opens an `exporter`
 * connection", and `backupTenant()` calls it.
 *
 * VACUUM INTO is the only copy mechanism the design allows: it is measured to
 * be byte-stable at one SKW_EXPORT_NOW (check 16) and it cannot be run by a
 * render-read handle, which is what closed the 16,384 B `content/public/backup.db`
 * finding.
 */
import { existsSync, rmSync, statSync } from 'node:fs';
import { openExporter } from './classes.ts';

export interface SnapshotResult {
  dbPath: string;
  toPath: string;
  bytes: number;
}

export function exportSnapshot(opts: { dbPath: string; toPath: string; busyTimeoutMs?: number }): SnapshotResult {
  const { dbPath, toPath } = opts;
  if (existsSync(toPath)) {
    // VACUUM INTO refuses an existing target; a stale bundle file is removed
    // rather than appended to.
    rmSync(toPath, { force: true });
  }
  const db = openExporter(dbPath, opts.busyTimeoutMs ?? 5000);
  try {
    if (db.inTransaction) throw new Error('exportSnapshot must not run inside a transaction');
    db.prepare('VACUUM INTO ?').run(toPath);
  } finally {
    db.close();
  }
  const bytes = existsSync(toPath) ? statSync(toPath).size : 0;
  return { dbPath, toPath, bytes };
}
