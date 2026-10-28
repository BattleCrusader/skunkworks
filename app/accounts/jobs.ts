/**
 * The advert, as the portal is allowed to read it — **read-only, through the plugin facade**.
 *
 * The job board package owns `p_jobboard_job` and `p_jobboard_company`, and the portal needs two
 * facts from them: is this advert open, and which account owns the company behind it. Neither fact
 * is identity — the advert is public content — but the table is not core, so the portal does not
 * write SQL against it. It goes through `hostOp`, the one layer that knows a plugin's tables and
 * enforces the manifest's declared, indexed columns. That is also why this read is *genuinely*
 * required rather than a shortcut: there is no core mirror of an advert, and the alternative — a
 * core table shadowing plugin content — would be a second source of truth that can disagree.
 *
 * What this module deliberately cannot do:
 *
 *   - **write.** Only `store.query` is called, so a portal bug cannot edit an advert.
 *   - **decide anything about a person.** It returns integers and strings from the advert; the
 *     decision about what a viewer may see lives in `policy.ts`, which never sees a plugin row.
 *   - **throw at the caller for a missing plugin.** A tenant without the job board installed has no
 *     adverts, which is an empty board and not a 500. Every call answers `null`, and the callers
 *     turn that into a named refusal ("that advert is not on this board").
 */
import type Database from 'better-sqlite3';

import { installedPlugins } from '../plugins/install.ts';
import { hostOp, type HostContext } from '../plugins/ops.ts';

/** The package id the portal reads. One constant, so a rename is one edit and a loud one. */
export const JOBBOARD_PLUGIN = 'jobboard';

/** The two facts the portal needs about one advert. Nothing here is personal data. */
export interface JobFact {
  readonly id: number;
  readonly title: string;
  readonly status: string;
  readonly companyId: number;
}

export interface AdvertReader {
  /** The advert, or `null` when the plugin is not installed, the row is gone, or the read refused. */
  job(id: number): JobFact | null;
  /** The account that owns a company, or `null` for the same reasons. */
  companyOwner(companyId: number): number | null;
}

interface Row {
  readonly [column: string]: unknown;
}

/**
 * A facade call that returns rows, or `null`.
 *
 * `hostOp` raises plain `Error`s carrying the plugin protocol's codes (`SKW_E_PL_*`), which never
 * become an HTTP response of their own. For a portal reading reference data, every one of them —
 * no package installed, table not created yet, a column the manifest does not declare — has the
 * same meaning: this box cannot answer, so the portal must not invent an answer. The refusal is
 * logged nowhere and surfaced by the caller as "not on this board", which is true of an empty board.
 */
function query(db: Database.Database, ctx: HostContext | null, table: string, where: unknown[]): Row[] | null {
  if (ctx === null) return null;
  try {
    const result = hostOp(ctx, 'store.query', { table, where, limit: 1 }) as { rows?: unknown };
    return Array.isArray(result.rows) ? (result.rows as Row[]) : null;
  } catch {
    return null;
  }
}

/**
 * A reader bound to one open handle. The installed manifest is read once per reader rather than per
 * call: `store.query` re-validates its grant against the database row on every call by design, and
 * re-parsing the manifest for each of a page's rows would be work with no extra guarantee.
 */
export function advertReader(
  db: Database.Database,
  tenant: string,
  emailMode: 'off' | 'smtp',
): AdvertReader {
  let ctx: HostContext | null | undefined;
  const context = (): HostContext | null => {
    if (ctx !== undefined) return ctx;
    const installed = installedPlugins(db).find((p) => p.plugin_id === JOBBOARD_PLUGIN && p.enabled);
    ctx =
      installed === undefined
        ? null
        : { db, tenant, plugin: JOBBOARD_PLUGIN, manifest: installed.manifest, emailMode };
    return ctx;
  };

  return {
    job(id: number): JobFact | null {
      if (!Number.isInteger(id) || id <= 0) return null;
      const rows = query(db, context(), 'p_jobboard_job', [{ column: 'id', op: '=', value: id }]);
      const row = rows?.[0];
      if (row === undefined) return null;
      const title = row.title;
      const status = row.status;
      const companyId = row.company_id;
      if (typeof title !== 'string' || typeof status !== 'string' || typeof companyId !== 'number') return null;
      return { id, title, status, companyId };
    },

    companyOwner(companyId: number): number | null {
      if (!Number.isInteger(companyId) || companyId <= 0) return null;
      const rows = query(db, context(), 'p_jobboard_company', [
        { column: 'id', op: '=', value: companyId },
      ]);
      const row = rows?.[0];
      if (row === undefined) return null;
      const accountId = row.account_id;
      return typeof accountId === 'number' && Number.isInteger(accountId) && accountId > 0 ? accountId : null;
    },
  };
}
