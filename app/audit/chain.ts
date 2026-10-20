/**
 * §9.6 (C-21) — the tenant-plane audit chain, its verifier, and the daily seal that
 * anchors it.
 *
 * `cms_audit` is hash-chained **inside the tenant's own file**, written in the same
 * transaction as the change it records. That chain is tamper-*evident* only against
 * an editor who cannot rewrite the hashes: an attacker with write access recomputes
 * every link, and round 2 measured that the rebuilt chain verifies. The anchor is one
 * `audit_seal(tenant_key, day, first_id, last_id, rows_in_day, head, anchor, sealed_at,
 * late)` row per tenant per UTC **day segment** in `control.db` — a file the app that
 * serves the tenant does not write — and the verifier walks **that id range only**,
 * starting from the anchor, and compares count and head. Rows with `id > last_id` are
 * never read: a later day's traffic cannot falsify an earlier day's seal (E-20).
 *
 * Measured both ways (`scripts/model/verify_claims.py` check 25): delete the last 5
 * rows of a segment and the shortened chain still walks; the seal comparison fails. And
 * the direction that was missing: append rows for the next day and the earlier day still
 * verifies. That is the whole argument for the second file, and `verifyAgainstSeal` is
 * where it is enforced: a segment that does not reproduce its anchor, links, count and
 * head is `SKW_E_SEC_AUDIT_SEAL`, never a pass.
 *
 * The canonical row is defined **here and once**. S2c put it in `app/admin/crud.ts`
 * (the writer); a verifier that invented a second definition would disagree with the
 * writer at the first field it forgot, so the writer imports this module now and there
 * is exactly one `stable()` in the tree:
 *
 *     canonical = {actor_user_id, actor_label, action, target_kind, target_id,
 *                  before_json, after_json, ts}   keys sorted, JSON-encoded values
 *     hash      = sha256(prev_hash + canonical)
 *
 * `ts` is the row's stored timestamp, not the clock: the verifier must be able to
 * recompute a row six months later, so the writer binds the value it hashes.
 */
import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';

import { AppError } from '../errors.ts';

/** The eight fields the hash covers, in the order the row carries them. */
export interface AuditFields {
  actor_user_id: number | null;
  actor_label: string;
  action: string;
  target_kind: string | null;
  target_id: string | null;
  before_json: string | null;
  after_json: string | null;
  ts: string;
}

export interface AuditActor {
  userId: number | null;
  label: string;
}

/** JSON with keys sorted and no spaces: the one canonicalisation in the tree. */
export function canonicalRow(row: AuditFields): string {
  const value: Record<string, unknown> = {
    actor_user_id: row.actor_user_id,
    actor_label: row.actor_label,
    action: row.action,
    target_kind: row.target_kind,
    target_id: row.target_id,
    before_json: row.before_json,
    after_json: row.after_json,
    ts: row.ts,
  };
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${JSON.stringify(value[k])}`).join(',')}}`;
}

/** `sha256(prev_hash + canonical(row))`. The writer and the verifier both call this. */
export function auditHash(prev: string, row: AuditFields): string {
  return createHash('sha256').update(prev + canonicalRow(row)).digest('hex');
}

/** The last hash in the file, or `''` for an empty chain. */
export function chainHead(db: Database.Database): string {
  const row = db.prepare('SELECT hash FROM cms_audit ORDER BY id DESC LIMIT 1').get() as { hash: string } | undefined;
  return row?.hash ?? '';
}

/**
 * Appends one audit row and returns what it wrote.
 *
 * Called with a handle that is **already inside the caller's transaction** (the CRUD
 * writer and the DDL runner both do this): the row and the change it records commit or
 * roll back together, which is the half of §9.6 that a separate connection cannot
 * provide.
 */
export function appendAudit(
  db: Database.Database,
  actor: AuditActor,
  action: string,
  targetKind: string | null,
  targetId: string | null,
  before: unknown,
  after: unknown,
  atMs: number = Date.now(),
): { hash: string; ts: string } {
  const prev = chainHead(db);
  const ts = new Date(atMs).toISOString();
  const fields: AuditFields = {
    actor_user_id: actor.userId,
    actor_label: actor.label,
    action,
    target_kind: targetKind,
    target_id: targetId,
    before_json: before === undefined || before === null ? null : JSON.stringify(before),
    after_json: after === undefined || after === null ? null : JSON.stringify(after),
    ts,
  };
  const hash = auditHash(prev, fields);
  db.prepare(
    `INSERT INTO cms_audit
       (actor_user_id, actor_label, action, target_kind, target_id, before_json, after_json, prev_hash, hash, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    fields.actor_user_id,
    fields.actor_label,
    fields.action,
    fields.target_kind,
    fields.target_id,
    fields.before_json,
    fields.after_json,
    prev,
    hash,
    fields.ts,
  );
  return { hash, ts };
}

export interface ChainReport {
  ok: boolean;
  rows: number;
  head: string;
  /** The id of the first row whose link or hash disagrees, when one does. */
  brokenAt: number | null;
}

/**
 * Walks the chain and recomputes every link from the stored row.
 *
 * This alone is **not** a verifier: a chain an attacker rewrote walks cleanly. It is
 * the first half, and `verifyAgainstSeal` is the second.
 */
export function verifyChain(db: Database.Database): ChainReport {
  const rows = db
    .prepare(
      `SELECT id, actor_user_id, actor_label, action, target_kind, target_id,
              before_json, after_json, prev_hash, hash, ts
         FROM cms_audit ORDER BY id`,
    )
    .all() as (AuditFields & { id: number; prev_hash: string; hash: string })[];

  let prev = '';
  let brokenAt: number | null = null;
  for (const row of rows) {
    const expected = auditHash(prev, row);
    if (expected !== row.hash || row.prev_hash !== prev) {
      brokenAt = row.id;
      break;
    }
    prev = expected;
  }
  return { ok: brokenAt === null, rows: rows.length, head: prev, brokenAt };
}

export interface SealRow {
  tenant_key: string;
  day: string;
  /** First id of the day's own segment. */
  first_id: number;
  /** Last id of the day's own segment. */
  last_id: number;
  /** `count(*)` over the day — the number the walk must reproduce. */
  rows_in_day: number;
  /** The hash of the row immediately BEFORE the segment; `''` when it starts the chain. */
  anchor: string;
  /** The last hash INSIDE the segment, never the chain's current head. */
  head: string;
  sealed_at: string;
  /** 1 when the seal was written later than the day after the day it covers. */
  late: number;
}

/** What `writeSeal` inserts: a day's own id range, anchored on its predecessor. */
export interface SealSegment {
  first_id: number;
  last_id: number;
  rows_in_day: number;
  anchor: string;
  head: string;
  late: number;
}

export function readSeal(control: Database.Database, tenantKey: string, day: string): SealRow | undefined {
  return control
    .prepare(
      `SELECT tenant_key, day, first_id, last_id, rows_in_day, anchor, head, sealed_at, late
         FROM audit_seal WHERE tenant_key = ? AND day = ?`,
    )
    .get(tenantKey, day) as SealRow | undefined;
}

/** The day a seal covers: UTC, `YYYY-MM-DD`. One clock, not the caller's locale. */
export function utcDay(atMs: number = Date.now()): string {
  return new Date(atMs).toISOString().slice(0, 10);
}

/** `day + n` UTC days, as `YYYY-MM-DD`. Arithmetic on the calendar, not on milliseconds. */
export function addUtcDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export interface DaySegment {
  first_id: number;
  last_id: number;
  rows_in_day: number;
}

/**
 * The day's own segment: `min(id)`, `max(id)` and `count(*)` over rows whose `ts` begins with
 * `day`. `null` when the day has no rows — a day with nothing on it has nothing to anchor, and a
 * seal with `rows_in_day = 0` would have no head.
 */
export function daySegment(db: Database.Database, day: string): DaySegment | null {
  const row = db
    .prepare(
      `SELECT min(id) AS first_id, max(id) AS last_id, count(*) AS rows_in_day
         FROM cms_audit WHERE substr(ts, 1, 10) = ?`,
    )
    .get(day) as { first_id: number | null; last_id: number | null; rows_in_day: number };
  if (row.rows_in_day === 0 || row.first_id === null || row.last_id === null) return null;
  return { first_id: row.first_id, last_id: row.last_id, rows_in_day: row.rows_in_day };
}

/** How many audit rows fall on `day` (any id). Used by the unsealed/empty distinction. */
export function rowsOnDay(db: Database.Database, day: string): number {
  const row = db.prepare('SELECT count(*) AS n FROM cms_audit WHERE substr(ts, 1, 10) = ?').get(day) as { n: number };
  return Number(row.n);
}

/**
 * Writes one `audit_seal` row: a day's segment, written once.
 *
 * **A day is sealed once, full stop.** A second write for `(tenant_key, day)` is refused with
 * `reason = 'already_sealed'` whether or not the computed head matches the stored one — a re-seal
 * path that can write at all is the laundering route the seal exists to close, and a rule that
 * distinguishes the two cases is a rule an attacker can aim at. The stored row is never updated:
 * `trg_audit_seal_immutable` aborts an `UPDATE` in the database itself.
 *
 * `late` is computed by `sealNow`, never asserted by a caller, and a caller cannot contradict the
 * table's CHECK (`late = 1 OR sealed_at is the day after`): that mismatch is refused here with a
 * code instead of surfacing as a raw SQLITE_CONSTRAINT.
 *
 * Exclusive witness: test/audit-seal.test.ts B1-6
 */
export function writeSeal(
  control: Database.Database,
  tenantKey: string,
  day: string,
  segment: SealSegment,
  atMs: number = Date.now(),
): SealRow {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new AppError('SKW_E_PLT_REQUEST_INVALID', 'a seal day is YYYY-MM-DD');
  const sealedAt = new Date(atMs).toISOString();
  const existing = readSeal(control, tenantKey, day);
  if (existing !== undefined) {
    throw new AppError(
      'SKW_E_SEC_AUDIT_SEAL',
      `the day ${day} is already sealed at ${existing.sealed_at} (late=${existing.late === 1 ? 'yes' : 'no'}); a sealed day is never re-sealed`,
      { day, reason: 'already_sealed', sealed_at: existing.sealed_at, late: existing.late },
    );
  }
  if (segment.late === 0 && utcDay(atMs) !== addUtcDays(day, 1)) {
    throw new AppError(
      'SKW_E_SEC_AUDIT_SEAL',
      `an on-time seal of ${day} is written on ${addUtcDays(day, 1)}, not ${utcDay(atMs)}`,
      { day, reason: 'late_mismatch', sealed_at: sealedAt },
    );
  }
  control
    .prepare(
      `INSERT INTO audit_seal (tenant_key, day, first_id, last_id, rows_in_day, anchor, head, sealed_at, late)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      tenantKey,
      day,
      segment.first_id,
      segment.last_id,
      segment.rows_in_day,
      segment.anchor,
      segment.head,
      sealedAt,
      segment.late,
    );
  return readSeal(control, tenantKey, day) as SealRow;
}

export type SealOutcome =
  | { status: 'sealed'; day: string; seal: SealRow }
  | { status: 'already_sealed'; day: string; seal: SealRow }
  | { status: 'empty'; day: string };

/**
 * Seals one UTC day of the tenant's chain — the day's **own segment**, not the file (E-20).
 *
 * The procedure is §9.6a's, in its order, and each refusal names its reason:
 *
 *   1. `D < utcDay(T)`                       → `day_not_over`
 *   2. the day's `min(id)`/`max(id)`/`count` → no rows: write nothing, report `empty`
 *   3. `count(id BETWEEN first AND last)` = `count(*) OR P` → `not_contiguous`
 *   4. `anchor` = the predecessor's hash; missing below `first_id > 1` → `anchor_missing`
 *   5. `head` = the hash AT `last_id` (never the chain's head)
 *   6. a whole-file walk must be ok first     → `chain_broken` naming `brokenAt`
 *   7. `late = 1` unless `T` is on `D + 1`; `sealed_at` is always the real instant
 *
 * Step 1 is why this cannot be a snapshot: sealing a day that can still grow writes a segment that
 * is wrong by construction, which is the defect the segment exists to remove, in its smallest form.
 *
 * Re-sealing a sealed day is **not** an error for the caller: it returns `already_sealed` with the
 * stored row, because "this day is anchored" is the outcome the operator wanted. `writeSeal` still
 * refuses the write itself.
 */
export function sealNow(
  db: Database.Database,
  control: Database.Database,
  tenantKey: string,
  day: string = utcDay(),
  atMs: number = Date.now(),
): SealOutcome {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new AppError('SKW_E_PLT_REQUEST_INVALID', 'a seal day is YYYY-MM-DD');
  const today = utcDay(atMs);
  if (!(day < today)) {
    throw new AppError(
      'SKW_E_SEC_AUDIT_SEAL',
      `the day ${day} has not ended (the seal instant is ${today}); a day that can still grow has no segment`,
      { day, reason: 'day_not_over', now: today },
    );
  }
  const existing = readSeal(control, tenantKey, day);
  if (existing !== undefined) return { status: 'already_sealed', day, seal: existing };

  const segment = daySegment(db, day);
  if (segment === null) return { status: 'empty', day };

  const inRange = db
    .prepare('SELECT count(*) AS n FROM cms_audit WHERE id BETWEEN ? AND ?')
    .get(segment.first_id, segment.last_id) as { n: number };
  if (Number(inRange.n) !== segment.rows_in_day) {
    throw new AppError(
      'SKW_E_SEC_AUDIT_SEAL',
      `the rows of ${day} are not contiguous by id: ${segment.rows_in_day} on the day, ${String(inRange.n)} between ${segment.first_id} and ${segment.last_id}`,
      { day, reason: 'not_contiguous', first_id: segment.first_id, last_id: segment.last_id, rows_in_day: segment.rows_in_day, in_range: Number(inRange.n) },
    );
  }

  const predecessor = db
    .prepare('SELECT hash FROM cms_audit WHERE id < ? ORDER BY id DESC LIMIT 1')
    .get(segment.first_id) as { hash: string } | undefined;
  const anchor = predecessor?.hash ?? '';
  if (segment.first_id > 1 && predecessor === undefined) {
    throw new AppError(
      'SKW_E_SEC_AUDIT_SEAL',
      `no row before id ${segment.first_id}: ${day} cannot be anchored on its left edge`,
      { day, reason: 'anchor_missing', first_id: segment.first_id },
    );
  }

  const last = db.prepare('SELECT hash FROM cms_audit WHERE id = ?').get(segment.last_id) as { hash: string } | undefined;
  if (last === undefined) {
    throw new AppError('SKW_E_SEC_AUDIT_SEAL', `no row at id ${segment.last_id} for ${day}`, {
      day,
      reason: 'chain_broken',
      brokenAt: segment.last_id,
    });
  }

  const report = verifyChain(db);
  if (!report.ok) {
    // Never seal a broken chain: that would anchor the break as if it were history.
    throw new AppError('SKW_E_SEC_AUDIT_SEAL', `the chain is broken at row ${String(report.brokenAt)}`, {
      day,
      reason: 'chain_broken',
      brokenAt: report.brokenAt,
    });
  }

  const late = today === addUtcDays(day, 1) ? 0 : 1;
  const seal = writeSeal(
    control,
    tenantKey,
    day,
    { first_id: segment.first_id, last_id: segment.last_id, rows_in_day: segment.rows_in_day, anchor, head: last.hash, late },
    atMs,
  );
  return { status: 'sealed', day, seal };
}

export interface SealVerified {
  ok: true;
  status: 'verified';
  day: string;
  first_id: number;
  last_id: number;
  rows_in_day: number;
  anchor: string;
  head: string;
  late: number;
  seal: SealRow;
}

/** A day with no rows and no seal: there is nothing to verify and nothing is wrong. */
export interface SealEmptyDay {
  ok: true;
  status: 'empty';
  day: string;
  rows_in_day: 0;
}

export type SealVerdict = SealVerified | SealEmptyDay;

/**
 * Verifies one day against its seal — **reading only `[first_id, last_id]`** (E-20).
 *
 * This is the whole fix. Rows with `id > last_id` are not read, so a later day's traffic cannot
 * make an earlier day fail, and a later day's tampering is the later day's verdict. A whole-file
 * walk is a different question and a different command (`skwctl audit verify --chain`).
 *
 * Refusals, each with its own `reason` on the error's detail — because one string for two events
 * is how an operator learns to ignore the control:
 *
 *   - no seal and rows exist          → `unsealed`
 *   - anchor ≠ the predecessor's hash → `anchor_mismatch`
 *   - a link or hash disagrees        → `broken_at` (with the id)
 *   - rows walked ≠ `rows_in_day`     → `count_mismatch`
 *   - last recomputed hash ≠ `head`   → `head_mismatch`
 *
 * Exclusive witness: test/audit-seal.test.ts B1-1, B1-3
 */
export function verifyAgainstSeal(
  db: Database.Database,
  control: Database.Database,
  tenantKey: string,
  day: string = utcDay(),
): SealVerdict {
  const seal = readSeal(control, tenantKey, day);
  if (seal === undefined) {
    const rows = rowsOnDay(db, day);
    if (rows === 0) return { ok: true, status: 'empty', day, rows_in_day: 0 };
    throw new AppError('SKW_E_SEC_AUDIT_SEAL', `${day} is UNSEALED: ${rows} audit rows on that day and no seal`, {
      day,
      reason: 'unsealed',
      rows_on_day: rows,
    });
  }

  const predecessor = db
    .prepare('SELECT hash FROM cms_audit WHERE id < ? ORDER BY id DESC LIMIT 1')
    .get(seal.first_id) as { hash: string } | undefined;
  const anchor = predecessor?.hash ?? '';
  if (anchor !== seal.anchor) {
    throw new AppError(
      'SKW_E_SEC_AUDIT_SEAL',
      `the row before ${day}'s segment does not match the seal's anchor: a row was deleted or inserted before id ${seal.first_id}`,
      { day, reason: 'anchor_mismatch', first_id: seal.first_id, sealed: seal.anchor, found: anchor },
    );
  }

  const rows = db
    .prepare(
      `SELECT id, actor_user_id, actor_label, action, target_kind, target_id,
              before_json, after_json, prev_hash, hash, ts
         FROM cms_audit WHERE id BETWEEN ? AND ? ORDER BY id`,
    )
    .all(seal.first_id, seal.last_id) as (AuditFields & { id: number; prev_hash: string; hash: string })[];

  let prev = seal.anchor;
  for (const row of rows) {
    const expected = auditHash(prev, row);
    if (row.prev_hash !== prev || row.hash !== expected) {
      throw new AppError('SKW_E_SEC_AUDIT_SEAL', `the chain of ${day} is broken at row ${row.id}`, {
        day,
        reason: 'broken_at',
        brokenAt: row.id,
        first_id: seal.first_id,
        last_id: seal.last_id,
      });
    }
    prev = expected;
  }
  if (rows.length !== seal.rows_in_day) {
    throw new AppError(
      'SKW_E_SEC_AUDIT_SEAL',
      `${day} has ${rows.length} rows between ${seal.first_id} and ${seal.last_id}; the seal records ${seal.rows_in_day}`,
      { day, reason: 'count_mismatch', sealed: seal.rows_in_day, found: rows.length },
    );
  }
  if (prev !== seal.head) {
    throw new AppError('SKW_E_SEC_AUDIT_SEAL', `the last hash of ${day}'s segment is not the seal's head`, {
      day,
      reason: 'head_mismatch',
      sealed: seal.head,
      found: prev,
    });
  }

  return {
    ok: true,
    status: 'verified',
    day,
    first_id: seal.first_id,
    last_id: seal.last_id,
    rows_in_day: seal.rows_in_day,
    anchor: seal.anchor,
    head: seal.head,
    late: seal.late,
    seal,
  };
}
