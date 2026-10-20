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
  SKW_E_SEC_RATE_LIMITED: 429,
  SKW_E_SEC_ROLE_DISABLED: 403,
  // §9.6 (C-21): the chain and the daily seal disagree — the anchor is what makes a
  // recomputed chain visible, so this is the code an unanchored verifier cannot raise.
  SKW_E_SEC_AUDIT_SEAL: 500,
  // RT — the render plane (§4.3 E-4): a resolved tenant with no page row
  SKW_E_RT_PAGE_NOT_FOUND: 404,
  // §6.1/§6.2 (S2e): the Data Source plane. UNKNOWN covers an unknown key, an
  // unregistered relation, a column outside the allowlist and C-18's `function`
  // kind; UNINDEXED covers a where/order/group_by column with no usable index and
  // a plan containing SCAN; BUDGET covers `cost_ms_max` and `group_by` arity.
  SKW_E_RT_SOURCE_UNKNOWN: 422,
  SKW_E_RT_SOURCE_UNINDEXED: 422,
  SKW_E_RT_SOURCE_BUDGET: 422,
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

  constructor(code: string, message?: string, detail?: unknown) {
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
    this.status = status;
    this.retryAfter = RETRY_AFTER[code];
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
