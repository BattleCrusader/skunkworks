/**
 * The SKW_E_ taxonomy (SDS §4.3): ^SKW_E_(RT|DM|SEC|PLT|EXP|PL)_[A-Z0-9_]+$.
 *
 * The HTTP map is a compile-time constant (a table would need a migration per
 * code and put a query on the error path, §4.3). It is asserted equal to
 * schema/error-codes.json by test/error-codes.test.ts, so the JSON file stays
 * the authority without a runtime file read on the error path.
 *
 * A body the app emits is JSON {error:{code,message?,requestId,detail?}} and never
 * contains a stack, a path, a SQL fragment or a key. Four classes of response are
 * generated before or outside the app (nginx's default_server 404/413/400 and
 * Node's 400 for a missing Host) and carry the server's own body (§4.3, E-13).
 */

export const CODE_PATTERN = /^SKW_E_(RT|DM|SEC|PLT|EXP|PL)_[A-Z0-9_]+$/;

export const HTTP: Record<string, number> = {
  // PLT — the platform/hosting plane (§5.3, §4.2)
  SKW_E_PLT_EDGE_PROOF: 421,
  SKW_E_PLT_TENANT_HEADER: 400,
  SKW_E_PLT_TENANT_UNKNOWN: 404,
  SKW_E_PLT_TENANT_UNAVAILABLE: 503,
  SKW_E_PLT_DB_BUSY: 503,
  SKW_E_PLT_DISK_FULL: 507,
  SKW_E_PLT_CERT_PENDING: 503,
  SKW_E_PLT_INTERNAL: 500,
  SKW_E_PLT_REQUEST_INVALID: 400,
  SKW_E_PLT_BODY_TOO_LARGE: 413,
  // DM — the data model plane. S2c adds the four the CRUD write path can receive
  // from the schema itself: two triggers raise COLUMN_IMMUTABLE / ASSET_IN_USE by
  // name (§4.3), and a UNIQUE / FK refusal is a 409 by §4.3's table.
  SKW_E_DM_SCHEMA_STALE: 503,
  SKW_E_DM_BUSY: 503,
  SKW_E_DM_QUOTA: 507,
  SKW_E_DM_KEY_IN_USE: 409,
  SKW_E_DM_FK_VIOLATION: 409,
  SKW_E_DM_COLUMN_IMMUTABLE: 409,
  SKW_E_DM_ASSET_IN_USE: 409,
  // §7.5 (S3c): an asset that cannot be gated — an owner-password PDF (`encrypted=1`)
  // or one whose `access_class` already gives it a public URL. Refused at **issue**,
  // naming the asset, so the failure happens where a human is present.
  SKW_E_DM_ASSET_UNSTAMPABLE: 422,
  // §4.4: a DDL statement the AST refuses, before any SQL is emitted.
  SKW_E_DM_DDL_REJECTED: 422,
  // §9.4: the transaction committed a schema the four allowed prefixes do not
  // describe. Raised after the statements and before COMMIT, so the rollback takes
  // the whole batch.
  SKW_E_DM_DDL_POSTCONDITION: 422,
  // SEC — the security plane (S2a: §9.1's session/CSRF controls). The statuses are
  // the frozen ones from schema/error-codes.json.
  //
  // E-16: `AUTH_INVALID` is a credential login failure (identity, password or TOTP;
  // the three are one response). `CODE_INVALID` is §7.2's decision about a redeemed
  // *download* access code and stays its own code — one counter that mixed a
  // mistyped download code with a password-guessing run could not be alerted on.
  SKW_E_SEC_CSRF: 403,
  SKW_E_SEC_AUTH_INVALID: 401,
  SKW_E_SEC_CODE_INVALID: 401,
  // §7.4 (S3c): the download token's own two refusals. FORMAT/MAC/CLAIMS are one code —
  // there is nothing an attacker can do with the difference — and a token that is valid
  // but belongs to another client or another asset is `TOKEN_MISMATCH`.
  SKW_E_SEC_TOKEN_INVALID: 401,
  SKW_E_SEC_TOKEN_MISMATCH: 401,
  // §7.4: `uses` reached `max_uses`. 410 Gone, not 403: the entitlement existed and is spent.
  SKW_E_SEC_USES_EXHAUSTED: 410,
  SKW_E_SEC_RATE_LIMITED: 429,
  SKW_E_SEC_ROLE_DISABLED: 403,
  /**
   * The session is valid and its role does not include this action. Distinct from
   * `SKW_E_SEC_ROLE_DISABLED` (that role cannot exist in this build) and from a CSRF refusal:
   * an editor who may edit pages may not install code that runs in the app process.
   */
  SKW_E_SEC_FORBIDDEN: 403,
  // §7.5 (S3d): the stamp failed — renderer error, the 2 s budget, an unencodable
  // character that survived the cp1252 sanitiser, or an unwritable render tree. 503:
  // the buyer's entitlement is untouched (no use is spent) and no un-stamped byte is
  // served on any path.
  //
  // **D34 (S3 round 2): the refusal is retryable by contract.** Every 503 from this code
  // carries `Retry-After`, derived from the measured render p50 and the live backlog
  // (`render.ts`'s `retryAfterSeconds`), and the denial is written to the ledger as
  // `kind='denied'` — not `'first'` — so a retry under the same token is a new attempt
  // rather than a second denial, and the one `uses` is spent by whichever attempt is
  // served. That is why this code has a dynamic wait and no entry in `RETRY_AFTER`.
  SKW_E_SEC_WATERMARK_FAILED: 503,
  // §7.5 (S3a): every upload that the sniff, the SVG rule or the filename rule refuses.
  // 415 Unsupported Media Type is the status the frozen registry assigns it, so a PHP
  // payload renamed `.png` is refused with the code that describes the refusal.
  SKW_E_SEC_UPLOAD_REJECTED: 415,
  // §9.6 (C-21): the chain and the daily seal disagree — the anchor is what makes a
  // recomputed chain visible, so this is the code an unanchored verifier cannot raise.
  SKW_E_SEC_AUDIT_SEAL: 500,
  // RT — the render plane (§4.3 E-4): a resolved tenant with no page row
  SKW_E_RT_PAGE_NOT_FOUND: 404,
  // §7.4 (S3c): the row exists, the blob does not. 503, and never a silent nginx 404 —
  // the buyer's code is not spent, and the log names the asset that vanished.
  SKW_E_RT_ASSET_MISSING: 503,
  // §6.1/§6.2 (S2e): the Data Source plane. UNKNOWN covers an unknown key, an
  // unregistered relation, a column outside the allowlist and C-18's `function`
  // kind; UNINDEXED covers a where/order/group_by column with no usable index and
  // a plan containing SCAN; BUDGET covers `cost_ms_max` and `group_by` arity.
  SKW_E_RT_SOURCE_UNKNOWN: 422,
  SKW_E_RT_SOURCE_UNINDEXED: 422,
  SKW_E_RT_SOURCE_BUDGET: 422,
  // §10.2/§10.3 (S4a): the editor's three refusals. COMPONENT_UNKNOWN is the one that
  // must fire **before** GrapesJS sees the document — it strips an unregistered type and
  // degrades the block to a div (176 B -> 110 B), so the evidence no longer exists after
  // a load. NESTING is the registry's `allowed_children`. PAGE_READONLY is §10.6: a
  // hand-managed page opens read-only, and the save path says so rather than re-serialising.
  SKW_E_RT_COMPONENT_UNKNOWN: 422,
  SKW_E_RT_COMPONENT_NESTING: 422,
  // S4a F2(b): the save request carries the inventory of component types the canvas model
  // held. The locks in the bytes about to be stored must be the same multiset; a missing
  // one is a block that has degraded to a div between the model and the row.
  SKW_E_RT_COMPONENT_INVENTORY: 422,
  SKW_E_RT_PAGE_READONLY: 409,
  // §10.3/§10.5 and §6.3's render half: the four the JSON has always frozen and the app
  // map did not carry. `test/error-codes.test.ts` now asserts the mirror **both ways**, so
  // this list and `schema/error-codes.json` cannot drift again.
  SKW_E_RT_BODY_FORBIDDEN: 422,
  // §16 S4 row 2 / C-4 (S4e): a `list` body with more than one `[data-repeat]` child. The
  // loop contract is exactly one template; two used to be accepted and stored as two rows.
  SKW_E_RT_REPEAT_INVALID: 422,
  SKW_E_RT_ROUNDTRIP_UNSTABLE: 422,
  SKW_E_RT_TEMPLATE_UNKNOWN: 422,
  SKW_E_RT_SOURCE_TIMEOUT: 504,
  SKW_E_RT_LOOP_CONGESTED: 503,
  // §3/§4.4 (S5 closeout): `cms_nav` renders. A menu row that cannot become a link is a
  // config defect, not a visitor's mistake: the page the request named exists, but the
  // server cannot render it without emitting a dead `href`. 500 is the honest status —
  // the site is misconfigured. TARGET_MISSING is a `page`/`asset` row with no row behind
  // it; HREF_REFUSED is a link that must not be written at all (`javascript:`, a gated
  // asset, a non-internal path, a cycle).
  SKW_E_RT_NAV_TARGET_MISSING: 500,
  SKW_E_RT_NAV_HREF_REFUSED: 500,
  // §11.3's six pre-flight refusals and the plugin plane's export/trust codes: frozen in
  // the JSON from S1/S2, first mapped here because S4b's exporters are the caller.
  SKW_E_EXP_GATED_ASSETS: 409,
  SKW_E_EXP_MEDIA_GRAPH_OPEN: 409,
  SKW_E_EXP_PARAMETERISED: 422,
  SKW_E_EXP_NOT_QUIESCENT: 409,
  SKW_E_EXP_INSUFFICIENT_DISK: 507,
  SKW_E_EXP_TENANT_NOT_FOUND: 404,
  // S4b: the two the projection raises when a stored row cannot become a page. A body
  // that is still a document after `unwrapBody()` (§3.2 of the S4a-fix report), and a body
  // naming a key with no row or no bytes. Both are refusals by name, never a skipped page.
  SKW_E_EXP_BODY_UNNORMALISABLE: 409,
  SKW_E_EXP_ASSET_UNRESOLVED: 409,
  // S4c: a second export of one tenant while the first holds the tenant's export lock.
  SKW_E_EXP_WRITER_ACTIVE: 409,
  // S4c: a `cms_plugin_installed` row whose package the bundle does not carry.
  SKW_E_PL_EXPORT_PACKAGE_MISSING: 409,
  SKW_E_PL_SIGNATURE: 409,
  // S8o: an uploaded `.tar.gz` that is not a package this box will unpack (a name that leaves
  // the directory, a symlink, no plugin.json, an oversized member). 409 like the other
  // refusals about the package's own state — the operator has to produce a different file.
  SKW_E_PL_ARCHIVE_FAILED: 409,
  SKW_E_PL_REVOKED: 409,
  SKW_E_PL_TESTS_STALE: 409,
  SKW_E_PL_NO_EXPORT_CLASS: 409,
  SKW_E_PL_UNAVAILABLE: 503,
  // S5/D36. These six were named by `areas.PL` in the frozen taxonomy and had **no HTTP
  // status**, so `AppError` threw "no HTTP mapping for SKW_E_PL_SCHEMA" at the moment the
  // refusal was constructed — the upgrade refusal of §8.2 surfaced as a 500 about the error
  // mapper. A code that can reach a response needs a status; the ones that cannot
  // (`ROW`, `QUERY`, `NO_TABLE`, `MAIL`, `SETTING_INVALID`, `TOO_MANY`) stay out on purpose.
  //
  // 409 for the three refusals about the package's *state* relative to this install, 403 for
  // a capability the facade will not answer, 500 for the two that mean "the host failed to do
  // its own job" (a package that would not load; a context called after its request ended).
  SKW_E_PL_SCHEMA: 409,
  SKW_E_PL_DESTRUCTIVE_UPGRADE: 409,
  SKW_E_PL_REJECTED: 403,
  SKW_E_PL_BUSY: 409,
  SKW_E_PL_LOAD: 500,
  SKW_E_PL_CONTEXT_ENDED: 500,
  // `SKW_E_PL_OOM` is **withdrawn**, not deprecated: it named a per-package cgroup that D36
  // deleted with the runner (§13.3.9). A status left here would be a control an operator could
  // still look for in a log.
};

/**
 * §4.3 (E-4): a framework-level failure is translated **by its own status class**
 * into exactly one of the four codes that class owns, and the status sent is the
 * code's mapping — never a status that disagrees with the code. The old catch-all
 * borrowed `SKW_E_PLT_TENANT_UNAVAILABLE` (a 503) for a 400 or a 413, which is a
 * wrong status on the wire and a false statement about the tenant.
 */
export function frameworkCode(status: number): string {
  if (status === 413) return 'SKW_E_PLT_BODY_TOO_LARGE';
  if (status >= 400 && status < 500) return 'SKW_E_PLT_REQUEST_INVALID';
  return 'SKW_E_PLT_INTERNAL';
}

/** Retry-After, in seconds, per code (schema/error-codes.json `retry_after`). */
export const RETRY_AFTER: Record<string, number> = {
  SKW_E_DM_SCHEMA_STALE: 5,
  SKW_E_DM_BUSY: 1,
  SKW_E_PLT_TENANT_UNAVAILABLE: 5,
};

export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryAfter: number | undefined;
  readonly detail: unknown;

  /**
   * `retryAfterSeconds` overrides the per-code constant. It exists for D34: a watermark
   * refusal's wait is a measurement (the render p50 and the live backlog), not a table
   * entry, and the header is the contract. Everything else keeps the table, so a code's
   * `Retry-After` stays a frozen fact in `schema/error-codes.json`.
   */
  constructor(code: string, message?: string, detail?: unknown, retryAfterSeconds?: number) {
    if (!CODE_PATTERN.test(code)) {
      throw new Error(`not an SKW_E_ code: ${code}`);
    }
    super(message ?? code);
    this.name = 'AppError';
    this.code = code;
    const status = HTTP[code];
    if (status === undefined) {
      throw new Error(`no HTTP mapping for ${code} (schema/error-codes.json)`);
    }
    if (retryAfterSeconds !== undefined && (!Number.isInteger(retryAfterSeconds) || retryAfterSeconds < 0)) {
      throw new Error(`Retry-After must be a whole number of seconds, got ${retryAfterSeconds}`);
    }
    this.status = status;
    this.retryAfter = retryAfterSeconds ?? RETRY_AFTER[code];
    this.detail = detail;
  }
}

export interface ErrorBody {
  error: {
    code: string;
    message?: string;
    requestId: string;
    detail?: unknown;
  };
}

/** The only shape an error leaves the process in (§4.3). */
export function errorBody(err: AppError, requestId: string): ErrorBody {
  const body: ErrorBody = { error: { code: err.code, requestId } };
  // A message is allowed only when it is ours and contains no path/stack/key.
  const message = safeMessage(err);
  if (message !== undefined) body.error.message = message;
  if (err.detail !== undefined) body.error.detail = err.detail;
  return body;
}

function safeMessage(err: AppError): string | undefined {
  if (err.message === err.code) return undefined;
  // Anything resembling a filesystem path or a SQL fragment is dropped.
  if (/[\\/]|\.db\b|SELECT |INSERT |PRAGMA /i.test(err.message)) return undefined;
  return err.message;
}
