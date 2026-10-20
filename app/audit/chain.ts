/**
 * §9.6 (C-21) — the tenant-plane audit chain, its verifier, and the daily seal that
 * anchors it.
 *
 * `cms_audit` is hash-chained **inside the tenant's own file**, written in the same
 * transaction as the change it records. That chain is tamper-*evident* only against
 * an editor who cannot rewrite the hashes: an attacker with write access recomputes
 * every link, and round 2 measured that the rebuilt chain verifies. The anchor is one
 * `audit_seal(tenant_key, day, rows, head)` row per tenant per UTC day in
 * `control.db` — a file the app that serves the tenant does not write — and the
 * verifier compares **count and head against the seal**, not only the links.
 *
 * Measured both ways (`scripts/model/verify_claims.py` check 25): delete the last 5
 * rows and the shortened chain still verifies; the seal comparison fails. That is the
 * whole argument for the second file, and `verifyAgainstSeal` is where it is enforced:
 * a chain that walks cleanly but does not match its seal is `SKW_E_SEC_AUDIT_SEAL`,
 * never a pass.
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
  rows: number;
  head: string;
  sealed_at: string;
}

export function readSeal(control: Database.Database, tenantKey: string, day: string): SealRow | undefined {
  return control
    .prepare('SELECT tenant_key, day, rows, head, sealed_at FROM audit_seal WHERE tenant_key = ? AND day = ?')
    .get(tenantKey, day) as SealRow | undefined;
}

/** The day a seal covers: UTC, `YYYY-MM-DD`. One clock, not the caller's locale. */
export function utcDay(atMs: number = Date.now()): string {
  return new Date(atMs).toISOString().slice(0, 10);
}

/**
 * Writes `audit_seal(tenant_key, day, rows, head)` — the anchor.
 *
 * `rows` is `count(cms_audit)` and `head` is the chain's last hash, so the seal is a
 * cumulative snapshot of the file at the end of a UTC day (§9.6's own wording: "the
 * verifier compares count(cms_audit) and the recomputed head to the seal").
 *
 * **A day is sealed once.** Re-sealing the same day with a different head is exactly
 * the attack the seal exists to catch — tamper, delete the trigger, recompute, re-seal
 * — so it is refused rather than overwritten. Re-sealing with the *same* head is
 * idempotent, which is what a daily job that ran twice needs.
 */
export function writeSeal(
  control: Database.Database,
  tenantKey: string,
  day: string,
  rows: number,
  head: string,
  atMs: number = Date.now(),
): SealRow {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new AppError('SKW_E_PLT_REQUEST_INVALID', 'a seal day is YYYY-MM-DD');
  const existing = readSeal(control, tenantKey, day);
  if (existing !== undefined) {
    if (existing.head === head && existing.rows === rows) return existing;
    throw new AppError('SKW_E_SEC_AUDIT_SEAL', 'the day is already sealed with a different head');
  }
  control
    .prepare('INSERT INTO audit_seal (tenant_key, day, rows, head, sealed_at) VALUES (?, ?, ?, ?, ?)')
    .run(tenantKey, day, rows, head, new Date(atMs).toISOString());
  return readSeal(control, tenantKey, day) as SealRow;
}

/** Seals the tenant's chain as it stands now, for `day` (default: today, UTC). */
export function sealNow(
  db: Database.Database,
  control: Database.Database,
  tenantKey: string,
  day: string = utcDay(),
  atMs: number = Date.now(),
): SealRow {
  const report = verifyChain(db);
  if (!report.ok) {
    // Never seal a broken chain: that would anchor the break.
    throw new AppError('SKW_E_SEC_AUDIT_SEAL', `the chain is broken at row ${String(report.brokenAt)}`);
  }
  return writeSeal(control, tenantKey, day, report.rows, report.head, atMs);
}

export interface SealVerification extends ChainReport {
  sealed: boolean;
  seal?: SealRow;
}

/**
 * The verifier §9.6 asks for: walk the links **and** compare count and head to the
 * seal. Two independent failures, one code:
 *
 *   - the links do not walk                       → SKW_E_SEC_AUDIT_SEAL
 *   - no seal for the day                         → SKW_E_SEC_AUDIT_SEAL ("a missing
 *                                                   digest is itself the evidence")
 *   - count(cms_audit) ≠ seal.rows                → SKW_E_SEC_AUDIT_SEAL
 *   - head ≠ seal.head                            → SKW_E_SEC_AUDIT_SEAL
 *
 * The count and head checks are what an unanchored verifier cannot do: after a row is
 * tampered with and every hash recomputed, `verifyChain` returns ok and only the head
 * comparison fails.
 */
export function verifyAgainstSeal(
  db: Database.Database,
  control: Database.Database,
  tenantKey: string,
  day: string = utcDay(),
): SealVerification {
  const report = verifyChain(db);
  const seal = readSeal(control, tenantKey, day);
  if (!report.ok) {
    throw new AppError('SKW_E_SEC_AUDIT_SEAL', `the chain is broken at row ${String(report.brokenAt)}`, {
      day,
      brokenAt: report.brokenAt,
    });
  }
  if (seal === undefined) {
    throw new AppError('SKW_E_SEC_AUDIT_SEAL', `no seal for ${day}`, { day });
  }
  if (seal.rows !== report.rows || seal.head !== report.head) {
    throw new AppError('SKW_E_SEC_AUDIT_SEAL', `the chain disagrees with the seal for ${day}`, {
      day,
      sealed: { rows: seal.rows, head: seal.head },
      found: { rows: report.rows, head: report.head },
    });
  }
  return { ...report, sealed: true, seal };
}
