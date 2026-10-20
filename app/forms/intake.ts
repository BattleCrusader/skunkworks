/**
 * Core form intake — the one place a `cms_form` submission becomes a row, and the two
 * call sites `form.validate` and `form.submitted` are wired to (§13.3.4, O-30, §8.6).
 *
 * The contract is O-30's, in its order:
 *
 *   1. **16 KiB cap** on the decoded body — a form is a message, not an upload.
 *   2. **5 per 10 min per address**, counted on the hash the row records, so the limiter
 *      cannot be turned into a per-address oracle.
 *   3. **intent token `_pt`**: `HMAC(SKW_SESSION_KEY, tenant|form|ts)`, 30 minutes, and a
 *      **minimum fill of 1.5 s** — a form submitted faster than a human can type it did
 *      not have a human in front of it.
 *   4. **honeypot `_hp`**: non-empty → `202` with the success body and **no row**. No
 *      `form.validate`, no `form.submitted`: nothing was submitted.
 *   5. **core's own rules** — required fields, declared fields only, per-field length.
 *   6. **`form.validate`**, if a plugin is attached, with core's verdict as the value it
 *      may only worsen: a filter may refuse what core accepted, never accept what core
 *      refused (`coreRefused` makes `ok:true` a counted failure rather than a rescue).
 *   7. the row, committed, and only then **`form.submitted`** — the action runs after the
 *      commit and its return value is discarded, so a plugin cannot un-store a submission.
 *
 * **Why the row is written here and not by a hook.** Submissions are our PII
 * (`cms_form_submission`), and a hook that could write it would be a hook that decides
 * whether a submission exists. The plugin's only say is "refuse", which is a decision
 * about *this* request, recorded in the response and in the failure counter.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

import type Database from 'better-sqlite3';

import { AppError } from '../errors.ts';
import { actionSite, filterSite } from '../plugins/site.ts';

/** O-30's numbers, in one place, so a gate can assert them rather than read a comment. */
export const FORM_BODY_MAX = 16 * 1024;
export const FORM_INTENT_TTL_MS = 30 * 60 * 1000;
export const FORM_MIN_FILL_MS = 1500;
export const FORM_RATE_LIMIT = 5;
export const FORM_RATE_WINDOW_MS = 10 * 60 * 1000;
export const FORM_INTENT_FIELD = '_pt';
export const FORM_HONEYPOT_FIELD = '_hp';

/**
 * What a renderer needs to mint `_pt`: the tenant it binds, the install's secret, and the instant.
 *
 * It lives here, beside `formIntentToken()`, so the renderer (`app/render/components/form.ts`) and
 * the render options (`app/editor/render.ts`) can both name it without the editor importing the
 * render tree — the dependency points at the intake, which is what the token *is*.
 */
export interface FormIntentContext {
  tenant: string;
  sessionKey: string;
  /** `Date.now()`. Passed in rather than read by the renderer so a gate can render at a fixed instant. */
  atMs: number;
}

export interface FormFieldSpec {
  name: string;
  type?: string;
  required?: boolean;
  max?: number;
}

export interface FormRow {
  id: number;
  key: string;
  title: string;
  fields_json: string;
  mode: 'store' | 'forward' | 'disabled';
  action_url: string | null;
}

export interface FormFieldError {
  field: string;
  message: string;
}

/** The verdict `form.validate` hands in and may only worsen. */
export interface FormVerdict {
  ok: boolean;
  errors: FormFieldError[];
}

export interface SubmitResult {
  status: number;
  body: Record<string, unknown>;
  /** Present only when a row was committed — the id `form.submitted` was given. */
  submissionId?: number;
}

// ---------------------------------------------------------------- the intent token

function intentMac(secret: string, tenant: string, key: string, ts: number): string {
  return createHmac('sha256', secret).update(`${tenant}|${key}|${ts}`).digest('hex');
}

/**
 * Mint `_pt` for one (tenant, form) at one instant. A form renderer calls this; the gate
 * calls it to post a submission without a browser. Nothing else may mint it.
 */
export function formIntentToken(tenant: string, key: string, secret: string, atMs: number): string {
  const ts = Math.floor(atMs / 1000);
  return `${ts}.${intentMac(secret, tenant, key, ts)}`;
}

export type IntentRefusal = 'missing' | 'malformed' | 'expired' | 'too_fast' | 'signature';

/** Verify `_pt`: signed, inside 30 minutes, and older than the 1.5 s minimum fill. */
export function verifyFormIntent(
  tenant: string,
  key: string,
  token: string | undefined,
  secret: string,
  atMs: number,
): { ok: true } | { ok: false; reason: IntentRefusal } {
  if (token === undefined || token === '') return { ok: false, reason: 'missing' };
  const dot = token.indexOf('.');
  if (dot < 1) return { ok: false, reason: 'malformed' };
  const ts = Number(token.slice(0, dot));
  const mac = token.slice(dot + 1);
  if (!Number.isInteger(ts) || mac === '') return { ok: false, reason: 'malformed' };
  const expected = intentMac(secret, tenant, key, ts);
  const a = Buffer.from(mac, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'signature' };
  const atS = Math.floor(atMs / 1000);
  if (atS - ts > FORM_INTENT_TTL_MS / 1000) return { ok: false, reason: 'expired' };
  if (atMs - ts * 1000 < FORM_MIN_FILL_MS) return { ok: false, reason: 'too_fast' };
  return { ok: true };
}

// ---------------------------------------------------------------- core rules

/** `fields_json` → the specs core enforces. A malformed column refuses the submission. */
export function fieldsOf(json: string): FormFieldSpec[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new AppError('SKW_E_RT_SOURCE_UNKNOWN', 'this form has no readable field list', { reason: 'fields_json' });
  }
  if (!Array.isArray(parsed)) {
    throw new AppError('SKW_E_RT_SOURCE_UNKNOWN', 'this form has no readable field list', { reason: 'fields_json' });
  }
  return parsed.map((line) => {
    const f = (line ?? {}) as Record<string, unknown>;
    return {
      name: String(f.name ?? ''),
      ...(typeof f.type === 'string' ? { type: f.type } : {}),
      ...(f.required === true ? { required: true } : {}),
      ...(typeof f.max === 'number' ? { max: f.max } : {}),
    };
  });
}

/**
 * Core's rules, run **first** and never re-run: declared fields only, required present,
 * per-field cap. Returns the verdict the plugin is then handed.
 */
export function validateCore(specs: readonly FormFieldSpec[], values: Record<string, string>): FormVerdict {
  const errors: FormFieldError[] = [];
  const declared = new Set(specs.map((s) => s.name));
  for (const spec of specs) {
    const value = values[spec.name] ?? '';
    if (spec.required === true && value.trim() === '') {
      errors.push({ field: spec.name, message: `${spec.name} is required` });
      continue;
    }
    if (spec.max !== undefined && value.length > spec.max) {
      errors.push({ field: spec.name, message: `${spec.name} is longer than ${spec.max} characters` });
    }
  }
  // An undeclared field is dropped, not refused: a browser that sends `_pt`/`_hp` and a
  // stray autofill must not turn a valid message into an error.
  for (const name of Object.keys(values)) {
    if (!declared.has(name)) delete values[name];
  }
  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------- the limiter

/** A fixed-window counter keyed by an opaque string. One instance per process. */
export class FormLimiter {
  private readonly hits = new Map<string, number[]>();

  count(key: string, atMs: number): number {
    const kept = (this.hits.get(key) ?? []).filter((t) => atMs - t < FORM_RATE_WINDOW_MS);
    if (kept.length === 0) this.hits.delete(key);
    else this.hits.set(key, kept);
    return kept.length;
  }

  hit(key: string, atMs: number): void {
    this.hits.set(key, [...(this.hits.get(key) ?? []), atMs]);
  }
}

// ---------------------------------------------------------------- the intake

export interface SubmitOptions {
  db: Database.Database;
  tenant: string;
  key: string;
  /** Every decoded field, `_pt` and `_hp` included. */
  raw: Record<string, string>;
  /** `sha256(ip)` under the install's key — never the address itself. */
  ipHash: string | null;
  sessionKey: string;
  atMs: number;
  limiter?: FormLimiter | undefined;
}

/** The form row for a key, or `undefined`. `mode='disabled'` is refused by the caller. */
export function formByKey(db: Database.Database, key: string): FormRow | undefined {
  return db
    .prepare('SELECT id, key, title, fields_json, mode, action_url FROM cms_form WHERE key = ?')
    .get(key) as FormRow | undefined;
}

/**
 * One submission, start to finish. Throws `AppError` for the refusals that are not the
 * form's verdict (unknown form, disabled form, bad token, rate limit); returns a verdict
 * for the ones that are (`422` with `errors`, or `202` with the row id).
 */
export async function submitCoreForm(opts: SubmitOptions): Promise<SubmitResult> {
  const bytes = Buffer.byteLength(JSON.stringify(opts.raw), 'utf8');
  if (bytes > FORM_BODY_MAX) {
    throw new AppError('SKW_E_PLT_REQUEST_INVALID', `a form submission is capped at ${FORM_BODY_MAX} bytes`, {
      bytes,
      limit: FORM_BODY_MAX,
    });
  }

  const form = formByKey(opts.db, opts.key);
  if (form === undefined || form.mode === 'disabled') {
    throw new AppError('SKW_E_RT_PAGE_NOT_FOUND', 'no form here', { form: opts.key });
  }
  if (form.mode === 'forward') {
    // Not a silent success: forwarding needs an outbound HTTP client this box does not
    // have (§13.3.4's absent `net.*`), so the row is neither stored nor claimed stored.
    throw new AppError('SKW_E_PLT_REQUEST_INVALID', 'this form is in forward mode, which this install cannot deliver', {
      form: form.key,
      mode: 'forward',
    });
  }

  if (opts.limiter !== undefined && opts.ipHash !== null) {
    if (opts.limiter.count(opts.ipHash, opts.atMs) >= FORM_RATE_LIMIT) {
      throw new AppError('SKW_E_SEC_RATE_LIMITED', 'too many submissions from this address', {
        reason: 'form',
        window_s: FORM_RATE_WINDOW_MS / 1000,
      });
    }
    opts.limiter.hit(opts.ipHash, opts.atMs);
  }

  const intent = verifyFormIntent(opts.tenant, opts.key, opts.raw[FORM_INTENT_FIELD], opts.sessionKey, opts.atMs);
  if (!intent.ok) {
    throw new AppError('SKW_E_PLT_REQUEST_INVALID', `the form token is ${intent.reason.replace('_', ' ')}`, {
      reason: intent.reason,
    });
  }

  // O-30: a filled honeypot is a success response and no row — and no hook fires, because
  // no submission was made. Answering differently would tell a script which field it hit.
  if ((opts.raw[FORM_HONEYPOT_FIELD] ?? '') !== '') {
    return { status: 202, body: { ok: true } };
  }

  const values: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.raw)) {
    if (k === FORM_INTENT_FIELD || k === FORM_HONEYPOT_FIELD) continue;
    values[k] = v;
  }

  const specs = fieldsOf(form.fields_json);
  const core = validateCore(specs, values);

  // §13.3.4's row: `{tenant, form, values} → {ok:true}|{ok:false,errors[]}`. The value
  // handed in is core's verdict; `coreRefused` is what stops `ok:true` resurrecting it.
  const verdict = await filterSite<FormVerdict>(
    'form.validate',
    opts.tenant,
    { tenant: opts.tenant, form: form.key, values },
    { ok: core.ok, errors: [...core.errors] },
    { coreRefused: !core.ok },
  );
  if (verdict.ok !== true) {
    return { status: 422, body: { ok: false, errors: verdict.errors ?? [] } };
  }

  const inserted = opts.db
    .prepare(
      `INSERT INTO cms_form_submission (form_id, payload_json, ip_hash, state)
       VALUES (?, ?, ?, 'new')`,
    )
    .run(form.id, JSON.stringify(values), opts.ipHash);
  const submissionId = Number(inserted.lastInsertRowid);

  // After the commit, observation only (§13.3.4's action row). A throw is caught by the
  // dispatch and counted; the row exists either way, which is the honest order.
  await actionSite('form.submitted', opts.tenant, { tenant: opts.tenant, form: form.key, submissionId });
  return { status: 202, body: { ok: true, id: submissionId }, submissionId };
}
