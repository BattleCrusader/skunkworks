/**
 * The SKW_E_ taxonomy (SDS §4.3): ^SKW_E_(RT|DM|SEC|PLT|EXP|PL)_[A-Z0-9_]+$.
 *
 * The HTTP map is a compile-time constant (a table would need a migration per
 * code and put a query on the error path, §4.3). It is asserted equal to
 * schema/error-codes.json by test/error-codes.test.ts, so the JSON file stays
 * the authority without a runtime file read on the error path.
 *
 * A body is always JSON {error:{code,message?,requestId,detail?}} and never
 * contains a stack, a path, a SQL fragment or a key.
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
  // DM — the data model plane
  SKW_E_DM_SCHEMA_STALE: 503,
  SKW_E_DM_BUSY: 503,
  SKW_E_DM_QUOTA: 507,
};

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
