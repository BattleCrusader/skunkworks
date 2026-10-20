/**
 * C-7 / §7.4 — **the counted unit is the redemption, not the request.**
 *
 * The gate is the unique index `ux_ev_jti_first` on `cms_download_event(jti)
 * WHERE kind='first'`, and the order is what makes it a gate:
 *
 *     BEGIN IMMEDIATE
 *       INSERT … (jti, 'first', …) ON CONFLICT DO NOTHING   -- the gate
 *       if changes() = 1:
 *         UPDATE cms_download_code SET uses = uses + 1 …    -- the counter
 *       COMMIT
 *
 * Update-first was measured at `uses = 24` with one event under 24 concurrent
 * requests (`r2-data-model.md` §2 C2), because every request passes the `UPDATE`
 * and only afterwards discovers it was a duplicate. Insert-first measures
 * `uses = 1`. Both statements are inside one `BEGIN IMMEDIATE`, so the second
 * writer waits for the first to commit rather than reading a snapshot that is
 * already stale — the wait is the serialisation, not a retry loop.
 *
 * Three outcomes, and only one of them spends:
 *   - `spent`        — this jti's `first` row was inserted here and the counter moved;
 *   - `continuation` — this jti already has an `ok` `first` row: a `Range` seek, a
 *                      resumed transfer, or a parallel part of the same transfer;
 *   - `denied`       — the insert won and the `UPDATE` changed 0 rows (quota, revoked,
 *                      expired), or the jti's existing row is itself a denial.
 *
 * The last branch is the one a naive implementation misses: a denial is written as
 * a `first` row with `outcome != 'ok'`, so a retry under the same token finds a row
 * and must **not** be mistaken for a continuation. `denied_quota` then `spent` on a
 * retry would serve the bytes the quota just refused.
 *
 * Exclusive witness: test/download-consume.test.ts C1, C3
 */
import type Database from 'better-sqlite3';

/**
 * The outcomes `cms_download_event.outcome` allows that are not `ok`. `denied_watermark`
 * is S3d's; it is in the union because a row written by the watermark path can be the
 * row this module reads back, and a type that lied about it would need a cast.
 */
export type DenialReason =
  | 'denied_quota'
  | 'denied_revoked'
  | 'denied_expired'
  | 'denied_token'
  | 'denied_watermark';

export type ConsumeResult =
  | { spent: true }
  | { spent: false; continuation: true }
  | { spent: false; continuation: false; reason: DenialReason };

export interface ConsumeInput {
  jti: string;
  codeId: number;
  assetId: number;
  /** The Content-Length the app authorised for this response (§7.4). */
  bytesDeclared: number;
  ipHash: string;
  uaHash: string;
  /** ISO 8601, written to `last_used_at`. */
  at: string;
  /** Epoch ms, compared against `expires_at`. */
  nowMs: number;
}

interface CodeRow {
  uses: number;
  max_uses: number | null;
  revoked_at: string | null;
  expires_at: string | null;
}

export function consumeUse(db: Database.Database, input: ConsumeInput): ConsumeResult {
  const run = db.transaction((): ConsumeResult => {
    // The gate first. `ON CONFLICT DO NOTHING` without a target covers the partial
    // unique index; a targeted clause would have to repeat the index predicate.
    const inserted = db
      .prepare(
        `INSERT INTO cms_download_event (jti, kind, code_id, asset_id, bytes_declared, ip_hash, ua_hash, outcome)
         VALUES (?, 'first', ?, ?, ?, ?, ?, 'ok')
         ON CONFLICT DO NOTHING`,
      )
      .run(input.jti, input.codeId, input.assetId, input.bytesDeclared, input.ipHash, input.uaHash);

    if (inserted.changes === 1) {
      // The counter second, guarded in SQL so the read and the write are one
      // statement: a JS-side `if (uses < max_uses)` is a TOCTOU window.
      const moved = db
        .prepare(
          `UPDATE cms_download_code
              SET uses = uses + 1, last_used_at = ?
            WHERE id = ?
              AND revoked_at IS NULL
              AND (expires_at IS NULL OR expires_at > ?)
              AND (max_uses IS NULL OR uses < max_uses)`,
        )
        .run(input.at, input.codeId, input.at);

      if (moved.changes === 1) return { spent: true };

      // The ledger row stays — it is the record of the attempt — and it says what
      // happened. `uses` is untouched.
      const reason = denialReason(db, input.codeId, input.nowMs);
      db.prepare(`UPDATE cms_download_event SET outcome = ? WHERE jti = ? AND kind = 'first'`).run(
        reason,
        input.jti,
      );
      return { spent: false, continuation: false, reason };
    }

    // A row already exists for this jti: either a continuation of an authorised
    // redemption, or a repeat of a denial.
    const existing = db
      .prepare(`SELECT outcome, code_id, asset_id FROM cms_download_event WHERE jti = ? AND kind = 'first'`)
      .get(input.jti) as { outcome: string; code_id: number | null; asset_id: number | null } | undefined;
    if (existing === undefined) {
      // Unreachable: the insert reported a conflict, so the row is there. Treated as
      // a denial rather than a continuation because "I could not read the ledger"
      // must never authorise bytes.
      return { spent: false, continuation: false, reason: 'denied_token' };
    }
    // The jti is globally unique by construction (128 random bits), but a row that
    // names another code or another asset is not this redemption's row: a continuation
    // must prove it is the same purchase, or a reused jti would be served free.
    if (existing.code_id !== input.codeId || existing.asset_id !== input.assetId) {
      return { spent: false, continuation: false, reason: 'denied_token' };
    }
    if (existing.outcome !== 'ok') {
      return { spent: false, continuation: false, reason: existing.outcome as DenialReason };
    }

    // A live redemption. §7.4's continuation condition includes "the code is not
    // revoked", so a revoke stops the rest of an in-flight transfer too.
    const code = readCode(db, input.codeId);
    if (code === null) return { spent: false, continuation: false, reason: 'denied_revoked' };
    if (code.revoked_at !== null) return { spent: false, continuation: false, reason: 'denied_revoked' };
    if (code.expires_at !== null && Date.parse(code.expires_at) <= input.nowMs) {
      return { spent: false, continuation: false, reason: 'denied_expired' };
    }
    return { spent: false, continuation: true };
  });

  // `.immediate()` is BEGIN IMMEDIATE: the write lock is taken up front, so two
  // processes cannot both pass the gate on a shared-cache snapshot.
  return run.immediate();
}

function readCode(db: Database.Database, id: number): CodeRow | null {
  const row = db
    .prepare(`SELECT uses, max_uses, revoked_at, expires_at FROM cms_download_code WHERE id = ?`)
    .get(id) as CodeRow | undefined;
  return row ?? null;
}

function denialReason(db: Database.Database, codeId: number, nowMs: number): DenialReason {
  const code = readCode(db, codeId);
  if (code === null || code.revoked_at !== null) return 'denied_revoked';
  if (code.expires_at !== null && Date.parse(code.expires_at) <= nowMs) return 'denied_expired';
  return 'denied_quota';
}

/**
 * The one query the E1 reconciliation runs (§7.4): `kind='first'` rows only. A
 * buyer whose PDF viewer seeks writes no `range` row in this build, so a
 * `COUNT(*)` over events and a `SUM(uses)` over codes agree for every code.
 */
export function usesAndFirstEvents(db: Database.Database, codeId: number): { uses: number; events: number } {
  const uses = Number(
    (db.prepare(`SELECT uses FROM cms_download_code WHERE id = ?`).get(codeId) as { uses: number } | undefined)?.uses ??
      -1,
  );
  const events = Number(
    (
      db
        .prepare(`SELECT COUNT(*) AS n FROM cms_download_event WHERE code_id = ? AND kind = 'first'`)
        .get(codeId) as { n: number }
    ).n,
  );
  return { uses, events };
}
