/**
 * C-6 / §7.2 / §7.6 — issuing an access code, and the three channels that do it.
 *
 * A code is **16 Crockford-base32 characters**: `<selector:4><secret:12>`. The first
 * four are stored plaintext and `UNIQUE` (a 20-bit index seek, ~6 µs); the whole 16
 * are argon2id-hashed at `m=19456,t=2,p=1`. There is no pepper and no column that
 * holds the secret in a form anything can read back — which is why redelivery is
 * **a reissue, never a re-send** (§7.6): the plaintext exists once, in the response
 * that created it, and nowhere else.
 *
 * Two refusals are decided here rather than at download time, because they are the
 * two ways a code can be sold for a file the buyer can already have:
 *
 *   - an `encrypted=1` asset (an owner-password PDF) cannot be stamped or read by
 *     the renderer, and a fail-closed download would deny 100 % of that tenant's
 *     buyers while the issue screen warned about nothing (§7.5). Refused at issue,
 *     `422 SKW_E_DM_ASSET_UNSTAMPABLE`, naming the asset;
 *   - a `public` asset has a farm link, so a code for it sells what `/media/<key>`
 *     already gives away. Same code, `detail.reason='access_class'`.
 *
 * `max_uses` is resolved per issue → `cms_settings.download.default_max_uses` →
 * and never hard-coded: a tenant whose setting is missing is a **refusal**, not a
 * silent 3, because the number is the tenant's commercial decision.
 */
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import type Database from 'better-sqlite3';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, openSync, readSync, statSync } from 'node:fs';

import { ARGON2_OPTIONS, Semaphore } from '../admin/auth.ts';
import { pathUnder } from '../assets/store.ts';
import { AppError } from '../errors.ts';

/** Crockford base32: no I, L, O or U. `U` is excluded so a code cannot spell a profanity. */
export const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const CODE_LENGTH = 16;
export const SELECTOR_LENGTH = 4;
/** 20 bits of selector: ~12 collisions per 5,000 issuances, each resolved by a retry (§7.2). */
export const SELECTOR_RETRIES = 8;

export const SETTING_DEFAULT_MAX_USES = 'download.default_max_uses';
export const SETTING_ALLOW_UNLIMITED = 'download.allow_unlimited';
export const SETTING_WEBHOOK_SECRET = 'download.webhook_secret';

/** The values `cms_settings` is seeded with at boot. Changing one is a migration, not a default. */
export const SHIPPED_SETTINGS: { key: string; value: string; type: 'int' | 'bool' }[] = [
  { key: SETTING_DEFAULT_MAX_USES, value: '3', type: 'int' },
  { key: SETTING_ALLOW_UNLIMITED, value: 'false', type: 'bool' },
];

/** `cms_download_code.max_uses`'s CHECK — stated once so the refusal can name both bounds. */
export const MAX_USES_MIN = 1;
export const MAX_USES_MAX = 100;

export interface AssetRow {
  id: number;
  key: string;
  filename: string;
  mime: string;
  bytes: number;
  sha256: string;
  kind: 'image' | 'video' | 'audio' | 'document' | 'archive';
  access_class: 'public' | 'linked-private' | 'gated';
  encrypted: number;
  storage_path: string;
}

/**
 * Uppercase, drop spaces and hyphens, and apply Crockford's aliases (I/L → 1, O → 0).
 * A code is read off a screen, a receipt or an email, so the normaliser is the
 * difference between "it did not work" and "you typed a lowercase l".
 */
export function normaliseCode(raw: string): string | null {
  const cleaned = raw.trim().toUpperCase().replace(/[\s-]/g, '');
  let out = '';
  for (const ch of cleaned) {
    if (ch === 'I' || ch === 'L') out += '1';
    else if (ch === 'O') out += '0';
    else if (CROCKFORD.includes(ch)) out += ch;
    else return null;
  }
  if (out.length !== CODE_LENGTH) return null;
  return out;
}

/** `crypto.randomBytes` is uniform over 256 values and 256 % 32 === 0, so `& 31` introduces no bias. */
export function generateCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let out = '';
  for (const b of bytes) out += CROCKFORD[b & 31];
  return out;
}

export function selectorOf(code: string): string {
  return code.slice(0, SELECTOR_LENGTH);
}

/** The plaintext code exists in this object and nowhere else. */
export interface IssuedCode {
  id: number;
  code: string;
  selector: string;
  maxUses: number | null;
  expiresAt: string | null;
  assetKey: string;
  /** §7.5's format coverage: video and audio are not stamped in v1, and the screen says so. */
  stampable: boolean;
}

export interface IssueInput {
  db: Database.Database;
  assetKey: string;
  /** `content/` — where the bytes are, so the issue path can read them (§7.5). */
  contentRoot: string;
  email?: string | null | undefined;
  orderRef?: string | null | undefined;
  /** `undefined` = the tenant default; `null` = unlimited (needs both consents). */
  maxUses?: number | null | undefined;
  expiresAt?: string | null | undefined;
  /** The per-issue confirmation §7.6 requires ("this code is effectively shareable"). */
  confirmUnlimited?: boolean | undefined;
  /** Injectable only so a gate can mint at a fixed clock. */
  atMs?: number | undefined;
  /** The CSV line a row came from, so a refusal in a batch names it (§7.6). */
  line?: number | undefined;
}

export async function issueCode(input: IssueInput, semaphore?: Semaphore): Promise<IssuedCode> {
  const issued = await mintBatch(input.db, [input], semaphore);
  return issued[0] as IssuedCode;
}

interface PreparedIssue {
  code: string;
  selector: string;
  codeHash: string;
  asset: AssetRow;
  maxUses: number | null;
  expiresAt: string | null;
  email: string | null;
  orderRef: string | null;
}

/**
 * The one insert path, and the reason it is a batch: `better-sqlite3` transactions are
 * **synchronous**, so an `await` (the argon2 hash) cannot sit inside one. Hashing
 * inside a transaction is impossible; claiming "all-or-nothing" while hashing between
 * two inserts would be a lie. So the split is by phase, not by row:
 *
 *   phase 1  validate every row and hash every code, outside any transaction;
 *   phase 2  insert every row inside one synchronous `db.transaction()`, and if a
 *            selector collided, roll the whole batch back and retry it with fresh codes.
 *
 * A single issue is a batch of one, so both channels run the same code.
 */
export async function mintBatch(
  db: Database.Database,
  inputs: IssueInput[],
  semaphore?: Semaphore,
): Promise<IssuedCode[]> {
  const gate = semaphore ?? new Semaphore(4);
  const specs = inputs.map((input) => prepareIssue(db, input));

  for (let attempt = 0; attempt < SELECTOR_RETRIES; attempt += 1) {
    const prepared: PreparedIssue[] = [];
    for (const spec of specs) {
      const code = generateCode();
      const codeHash = await gate.run(() => argonHash(code, ARGON2_OPTIONS));
      prepared.push({ ...spec, code, selector: selectorOf(code), codeHash });
    }
    try {
      const insert = db.prepare(
        `INSERT INTO cms_download_code
           (code_selector, code_hash, asset_id, max_uses, expires_at, issued_to_email, order_ref)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      const write = db.transaction(() => {
        const ids: number[] = [];
        for (const p of prepared) {
          const info = insert.run(
            p.selector,
            p.codeHash,
            p.asset.id,
            p.maxUses,
            p.expiresAt,
            p.email,
            p.orderRef,
          );
          ids.push(Number(info.lastInsertRowid));
        }
        return ids;
      });
      const ids = write();
      return prepared.map((p, i) => ({
        id: ids[i] as number,
        code: p.code,
        selector: p.selector,
        maxUses: p.maxUses,
        expiresAt: p.expiresAt,
        assetKey: p.asset.key,
        stampable: isStampable(p.asset.kind),
      }));
    } catch (err) {
      // A selector collision is the expected 20-bit birthday problem, not a failure:
      // a fresh batch has fresh selectors, so the retry is a new attempt at 1/32^4.
      // The transaction rolled back, so no partial batch exists to reconcile.
      if (String((err as Error).message).includes('UNIQUE') && attempt < SELECTOR_RETRIES - 1) continue;
      throw err;
    }
  }
  throw new AppError('SKW_E_PLT_INTERNAL', 'no free code selector after the retry budget');
}

/** Everything that can be refused without hashing, so a bad CSV row costs no argon2. */
function prepareIssue(db: Database.Database, input: IssueInput): Omit<PreparedIssue, 'code' | 'selector' | 'codeHash'> {
  try {
    const asset = assetByKey(db, input.assetKey);
    assertGateable(asset, input.assetKey, input.contentRoot);
    const maxUses = resolveMaxUses(db, input.maxUses, input.confirmUnlimited === true);
    const expiresAt = normaliseExpiry(input.expiresAt ?? null, input.atMs ?? Date.now());
    const email = normaliseEmail(input.email ?? null);
    const orderRef =
      input.orderRef === undefined || input.orderRef === null ? null : String(input.orderRef).slice(0, 200);

    if (orderRef !== null) {
      const existing = db
        .prepare(`SELECT id FROM cms_download_code WHERE order_ref = ? AND revoked_at IS NULL`)
        .get(orderRef) as { id: number } | undefined;
      if (existing !== undefined) {
        throw new AppError('SKW_E_DM_KEY_IN_USE', 'a code already exists for this order reference', {
          reason: 'duplicate_order_ref',
          code_id: existing.id,
        });
      }
    }

    return { asset, maxUses, expiresAt, email, orderRef };
  } catch (err) {
    // A batch refusal must say which line, or an operator with 400 rows has to bisect
    // the file. The detail is merged rather than replaced, so the reason survives.
    if (input.line === undefined || !(err instanceof AppError)) throw err;
    const detail =
      err.detail !== null && typeof err.detail === 'object' ? (err.detail as Record<string, unknown>) : {};
    throw new AppError(err.code, err.message, { ...detail, line: input.line });
  }
}

/**
 * §7.6: per-issue → `cms_settings.download.default_max_uses` → never hard-coded.
 * `NULL` (unlimited) needs the tenant toggle **and** the per-issue confirmation;
 * one of the two is a refusal, because "unlimited" is a shareable code.
 */
export function resolveMaxUses(
  db: Database.Database,
  requested: number | null | undefined,
  confirmUnlimited: boolean,
): number | null {
  if (requested === undefined) return settingInt(db, SETTING_DEFAULT_MAX_USES);

  if (requested === null) {
    if (!settingBool(db, SETTING_ALLOW_UNLIMITED)) {
      throw new AppError('SKW_E_PLT_REQUEST_INVALID', 'unlimited uses is switched off for this tenant', {
        reason: 'unlimited_disabled',
        setting: SETTING_ALLOW_UNLIMITED,
      });
    }
    if (!confirmUnlimited) {
      throw new AppError('SKW_E_PLT_REQUEST_INVALID', 'unlimited uses needs an explicit confirmation', {
        reason: 'unlimited_unconfirmed',
      });
    }
    return null;
  }

  if (!Number.isInteger(requested) || requested < MAX_USES_MIN || requested > MAX_USES_MAX) {
    throw new AppError(
      'SKW_E_PLT_REQUEST_INVALID',
      `max_uses is an integer between ${MAX_USES_MIN} and ${MAX_USES_MAX}`,
      { reason: 'max_uses_range', min: MAX_USES_MIN, max: MAX_USES_MAX },
    );
  }
  return requested;
}

export function settingInt(db: Database.Database, key: string): number {
  const raw = settingRaw(db, key);
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new AppError('SKW_E_PLT_INTERNAL', `cms_settings.${key} is not an integer`);
  return value;
}

export function settingBool(db: Database.Database, key: string): boolean {
  const raw = settingRaw(db, key);
  if (raw !== 'true' && raw !== 'false') {
    throw new AppError('SKW_E_PLT_INTERNAL', `cms_settings.${key} is not a boolean`);
  }
  return raw === 'true';
}

/** Missing is a refusal: a shipped default that is absent from the file is a broken tenant. */
export function settingRaw(db: Database.Database, key: string): string {
  const row = db.prepare(`SELECT value_json FROM cms_settings WHERE key = ?`).get(key) as
    | { value_json: string }
    | undefined;
  if (row === undefined) {
    throw new AppError('SKW_E_PLT_INTERNAL', `cms_settings.${key} is not seeded for this tenant`, { setting: key });
  }
  try {
    const parsed = JSON.parse(row.value_json) as unknown;
    return typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
  } catch {
    // `value_json` is TEXT with no json_valid() CHECK; a hand-edited row can be anything.
    throw new AppError('SKW_E_PLT_INTERNAL', `cms_settings.${key} is not JSON`);
  }
}

/** §2.3 step 5's sibling: the shipped settings exist after boot, `ON CONFLICT DO NOTHING`. */
export function seedSettings(db: Database.Database): string[] {
  const insert = db.prepare(
    `INSERT INTO cms_settings (key, value_json, type) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING`,
  );
  const wrote: string[] = [];
  const tx = db.transaction(() => {
    for (const s of SHIPPED_SETTINGS) {
      if (insert.run(s.key, s.value, s.type).changes === 1) wrote.push(s.key);
    }
  });
  tx();
  return wrote;
}

export function assetByKey(db: Database.Database, key: string): AssetRow {
  const row = db
    .prepare(
      `SELECT id, key, filename, mime, bytes, sha256, kind, access_class, encrypted, storage_path
         FROM cms_asset WHERE key = ?`,
    )
    .get(key) as AssetRow | undefined;
  if (row === undefined) {
    throw new AppError('SKW_E_PLT_REQUEST_INVALID', 'no such asset', { reason: 'asset_unknown', asset_key: key });
  }
  return row;
}

export function assetById(db: Database.Database, id: number): AssetRow | null {
  const row = db
    .prepare(
      `SELECT id, key, filename, mime, bytes, sha256, kind, access_class, encrypted, storage_path
         FROM cms_asset WHERE id = ?`,
    )
    .get(id) as AssetRow | undefined;
  return row ?? null;
}

/**
 * The issue-time refusals, each naming the asset. `detail.asset` is the key and the
 * filename, because the operator's next action is to find the file.
 *
 * Three refusals, one code. `SKW_E_DM_ASSET_UNSTAMPABLE` is the taxonomy's word for
 * "this asset cannot be gated", and the `reason` says which of the three it was:
 *
 *   - `encrypted` — `encrypted=1`, the flag an import sets;
 *   - `encrypted_bytes` — the flag is 0 but the file is a PDF whose trailer carries
 *     `/Encrypt`. The flag is not written by the upload path in this build, so
 *     trusting it alone would gate a file the renderer will refuse at download time;
 *   - `access_class` — a `public`/`linked-private` asset has a farm link, and a code
 *     for it sells what `/media/<key>` already gives away.
 *
 * Exclusive witness: test/download-codes.test.ts I4
 */
export function assertGateable(asset: AssetRow, requestedKey: string, contentRoot?: string): void {
  const detail = { asset: { key: asset.key, filename: asset.filename }, requested_key: requestedKey };
  if (asset.encrypted === 1) {
    throw new AppError('SKW_E_DM_ASSET_UNSTAMPABLE', 'this asset is encrypted and cannot be gated', {
      ...detail,
      reason: 'encrypted',
    });
  }
  if (contentRoot !== undefined && asset.mime === 'application/pdf' && pdfCarriesEncryption(asset, contentRoot)) {
    throw new AppError('SKW_E_DM_ASSET_UNSTAMPABLE', 'this PDF is encrypted and cannot be gated', {
      ...detail,
      reason: 'encrypted_bytes',
    });
  }
  if (asset.access_class !== 'gated') {
    throw new AppError('SKW_E_DM_ASSET_UNSTAMPABLE', 'this asset has a public URL and cannot be gated', {
      ...detail,
      reason: 'access_class',
      access_class: asset.access_class,
    });
  }
}

/**
 * An owner-password PDF is not corrupt — it just cannot be loaded without the password,
 * so `pdf-lib` (S3d) throws and a fail-closed download would deny every buyer of that
 * tenant. Refusing at issue moves the failure to the one moment a human is present.
 *
 * The test is narrow on purpose: `/Encrypt` followed by an indirect reference
 * (`/Encrypt 5 0 R`) or an inline dictionary. A bare substring match would refuse a
 * plain PDF whose text mentions the word. The scan covers the first and last 512 KiB,
 * which is where a trailer lives; a PDF whose trailer sits outside both windows is not
 * detected, and that limit is stated rather than implied.
 */
export function pdfCarriesEncryption(asset: AssetRow, contentRoot: string): boolean {
  const ENCRYPT_MARK = /\/Encrypt\s+(\d+\s+\d+\s+R|<<)/;
  let fd: number | undefined;
  try {
    const path = pathUnder(contentRoot, asset.storage_path);
    const size = statSync(path).size;
    fd = openSync(path, 'r');
    const window = 512 * 1024;
    const head = Buffer.alloc(Math.min(size, window));
    readSync(fd, head, 0, head.length, 0);
    if (!head.toString('latin1').startsWith('%PDF-')) return false;
    if (ENCRYPT_MARK.test(head.toString('latin1'))) return true;
    if (size <= window) return false;
    const tail = Buffer.alloc(Math.min(size, window));
    readSync(fd, tail, 0, tail.length, Math.max(0, size - window));
    return ENCRYPT_MARK.test(tail.toString('latin1'));
  } catch {
    // A missing blob is the download plane's `503 SKW_E_RT_ASSET_MISSING`, not an
    // encryption claim made by the issue screen.
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** §7.5's honest coverage: PDF, image and archive are stamped; video and audio are not. */
export function isStampable(kind: AssetRow['kind']): boolean {
  return kind !== 'video' && kind !== 'audio';
}

/** §7.6: revoke the old row, mint a new one, and the plaintext is again returned exactly once. */
export async function reissueCode(
  db: Database.Database,
  contentRoot: string,
  codeId: number,
  atMs = Date.now(),
): Promise<IssuedCode> {
  const row = db
    .prepare(
      `SELECT c.id, c.max_uses, c.expires_at, c.issued_to_email, c.order_ref, c.revoked_at, a.key AS asset_key
         FROM cms_download_code c JOIN cms_asset a ON a.id = c.asset_id
        WHERE c.id = ?`,
    )
    .get(codeId) as
    | {
        id: number;
        max_uses: number | null;
        expires_at: string | null;
        issued_to_email: string | null;
        order_ref: string | null;
        revoked_at: string | null;
        asset_key: string;
      }
    | undefined;
  if (row === undefined) throw new AppError('SKW_E_PLT_REQUEST_INVALID', 'no such code', { code_id: codeId });

  const at = new Date(atMs).toISOString();
  const revoke = db.transaction(() => {
    db.prepare(`UPDATE cms_download_code SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?`).run(at, codeId);
  });
  revoke();

  const issued = await issueCode({
    db,
    contentRoot,
    assetKey: row.asset_key,
    email: row.issued_to_email,
    // The new row must not collide with the old order_ref, which is still on the
    // revoked row: the duplicate check ignores revoked rows, so this is safe.
    orderRef: row.order_ref,
    maxUses: row.max_uses === null ? null : row.max_uses,
    expiresAt: row.expires_at,
    confirmUnlimited: row.max_uses === null,
    atMs,
  });
  return issued;
}

export function revokeCode(db: Database.Database, codeId: number, atMs = Date.now()): boolean {
  const info = db
    .prepare(`UPDATE cms_download_code SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`)
    .run(new Date(atMs).toISOString(), codeId);
  return info.changes === 1;
}

/**
 * `max_uses` and `expires_at` are editable; the code itself is not (it exists only as
 * a hash). Lowering `max_uses` below `uses` is allowed and blocks the next redemption
 * immediately — the `UPDATE` in `ledger.ts` carries `uses < max_uses` as its guard.
 */
export function updateCode(
  db: Database.Database,
  codeId: number,
  patch: { maxUses?: number | null; expiresAt?: string | null; confirmUnlimited?: boolean },
  atMs = Date.now(),
): void {
  const row = db.prepare(`SELECT max_uses FROM cms_download_code WHERE id = ?`).get(codeId) as
    | { max_uses: number | null }
    | undefined;
  if (row === undefined) throw new AppError('SKW_E_PLT_REQUEST_INVALID', 'no such code', { code_id: codeId });

  if (patch.maxUses !== undefined) {
    const value = resolveMaxUses(db, patch.maxUses, patch.confirmUnlimited === true);
    db.prepare(`UPDATE cms_download_code SET max_uses = ? WHERE id = ?`).run(value, codeId);
  }
  if (patch.expiresAt !== undefined) {
    const value = normaliseExpiry(patch.expiresAt, atMs);
    db.prepare(`UPDATE cms_download_code SET expires_at = ? WHERE id = ?`).run(value, codeId);
  }
}

// --- the CSV channel (§7.6) -------------------------------------------------------

export interface CsvRow {
  line: number;
  email: string | null;
  assetKey: string;
  /** `undefined` when blank, which is the tenant default — not `null`, which is unlimited. */
  maxUses: number | undefined;
  expiresAt: string | null;
}

export const CSV_HEADER = ['email', 'asset_key', 'max_uses', 'expires_at'] as const;

/**
 * `email, asset_key, max_uses, expires_at`. Blank `max_uses` is the tenant default and
 * blank `expires_at` is "never"; a blank email is allowed (a code can be printed).
 * A quoted field is supported for the email, because `"Doe, Jane" <j@x>` is a real
 * thing a store puts in a CSV; anything else is refused rather than half-parsed.
 */
export function parseIssueCsv(text: string): CsvRow[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const headerFields = (splitCsvLine((lines[0] ?? '').trim()) ?? []).map((f) => f.trim().toLowerCase());
  // §7.6's table writes `email, asset_key, max_uses, expires_at` with spaces; a
  // spreadsheet writes it without. Both are the same header, so the fields are
  // trimmed rather than the operator being told their CSV is wrong about whitespace.
  if (headerFields.join(',') !== CSV_HEADER.join(',')) {
    throw new AppError('SKW_E_PLT_REQUEST_INVALID', `the CSV header is ${CSV_HEADER.join(',')}`, {
      reason: 'csv_header',
      header: lines[0] ?? '',
    });
  }
  const rows: CsvRow[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i] as string;
    if (line.trim() === '') continue;
    const fields = splitCsvLine(line);
    if (fields === null || fields.length !== CSV_HEADER.length) {
      throw new AppError('SKW_E_PLT_REQUEST_INVALID', `CSV line ${i + 1} does not have four fields`, {
        reason: 'csv_fields',
        line: i + 1,
      });
    }
    const [email, assetKey, maxUsesRaw, expiresRaw] = fields as [string, string, string, string];
    if (assetKey.trim() === '') {
      throw new AppError('SKW_E_PLT_REQUEST_INVALID', `CSV line ${i + 1} has no asset_key`, {
        reason: 'csv_asset_key',
        line: i + 1,
      });
    }
    let maxUses: number | undefined;
    if (maxUsesRaw.trim() !== '') {
      const n = Number(maxUsesRaw.trim());
      if (!Number.isInteger(n)) {
        throw new AppError('SKW_E_PLT_REQUEST_INVALID', `CSV line ${i + 1} has a non-integer max_uses`, {
          reason: 'csv_max_uses',
          line: i + 1,
        });
      }
      maxUses = n;
    }
    rows.push({
      line: i + 1,
      email: email.trim() === '' ? null : email.trim(),
      assetKey: assetKey.trim(),
      maxUses,
      expiresAt: expiresRaw.trim() === '' ? null : expiresRaw.trim(),
    });
  }
  if (rows.length === 0) {
    throw new AppError('SKW_E_PLT_REQUEST_INVALID', 'the CSV has a header and no rows', { reason: 'csv_empty' });
  }
  return rows;
}

/** RFC 4180's double-quote escape, and nothing cleverer. */
function splitCsvLine(line: string): string[] | null {
  const out: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i] as string;
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === '') {
      quoted = true;
    } else if (ch === ',') {
      out.push(field);
      field = '';
    } else field += ch;
  }
  if (quoted) return null;
  out.push(field);
  return out;
}

/**
 * All-or-nothing: every row is validated before the first code is minted, and the
 * inserts run in one transaction. A half-issued CSV is a receipt for codes nobody
 * received, so a bad line refuses the whole file and names it.
 */
export async function issueFromCsv(
  db: Database.Database,
  contentRoot: string,
  text: string,
  atMs = Date.now(),
): Promise<{ issued: IssuedCode[]; defaultMaxUses: number }> {
  const rows = parseIssueCsv(text);
  const defaultMaxUses = settingInt(db, SETTING_DEFAULT_MAX_USES);
  // Every row's asset, expiry, email and `max_uses` are validated by `prepareIssue`
  // before the first hash is computed (it maps the whole batch up front), and the
  // rows are inserted in ONE transaction — a bad line leaves no committed code.
  const issued = await mintBatch(
    db,
    rows.map((row) => ({
      db,
      contentRoot,
      assetKey: row.assetKey,
      email: row.email,
      maxUses: row.maxUses,
      expiresAt: row.expiresAt,
      atMs,
      line: row.line,
    })),
  );
  return { issued, defaultMaxUses };
}

// --- the webhook channel (§7.6) ---------------------------------------------------

export const WEBHOOK_SKEW_S = 300;

/**
 * `X-Skw-Signature: sha256=<hex>`, HMAC over the **raw body**, compared in constant
 * time. The signature is per tenant (`cms_settings.download.webhook_secret`): using
 * the download-token key here would mean one compromise signs both tokens and
 * issuance requests. No configured secret means the channel does not exist.
 */
export function verifyWebhookSignature(input: {
  secret: string;
  rawBody: string;
  header: string | undefined;
  iat: number;
  nowMs: number;
}): { ok: true } | { ok: false; reason: 'signature' | 'stale' | 'format' } {
  const header = input.header ?? '';
  if (!header.startsWith('sha256=')) return { ok: false, reason: 'format' };
  const given = Buffer.from(header.slice('sha256='.length), 'hex');
  if (given.length !== 32) return { ok: false, reason: 'format' };
  const expected = createHmac('sha256', input.secret).update(input.rawBody).digest();
  if (!timingSafeEqual(given, expected)) return { ok: false, reason: 'signature' };
  if (Math.abs(input.nowMs - input.iat) > WEBHOOK_SKEW_S * 1000) return { ok: false, reason: 'stale' };
  return { ok: true };
}

// --- shared validation ------------------------------------------------------------

function normaliseEmail(raw: string | null): string | null {
  if (raw === null) return null;
  let value = raw.trim();
  if (value === '') return null;
  // `"Doe, Jane" <jane@two.test>` is how a store's CSV spells an address. The column
  // holds the address — a display name in `issued_to_email` would break the one thing
  // it is for (matching a buyer), so the angle-bracket form is unwrapped, not stored.
  const angled = /<([^<>]+)>\s*$/.exec(value);
  if (angled !== null) value = (angled[1] as string).trim();
  if (value.length > 254 || !value.includes('@') || /\s/.test(value)) {
    throw new AppError('SKW_E_PLT_REQUEST_INVALID', 'that is not an email address', { reason: 'email' });
  }
  return value;
}

function normaliseExpiry(raw: string | null, atMs: number): string | null {
  if (raw === null) return null;
  const value = raw.trim();
  if (value === '') return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new AppError('SKW_E_PLT_REQUEST_INVALID', 'expires_at is not a timestamp', { reason: 'expires_at' });
  }
  if (ms <= atMs) {
    throw new AppError('SKW_E_PLT_REQUEST_INVALID', 'expires_at is in the past', { reason: 'expires_at_past' });
  }
  return new Date(ms).toISOString();
}

/** Exported so a gate can prove the hash is the frozen parameter set, not "some argon2". */
export async function verifyCodeHash(codeHash: string, code: string): Promise<boolean> {
  try {
    return await argonVerify(codeHash, code);
  } catch {
    return false;
  }
}
