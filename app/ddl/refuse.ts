/**
 * §4.4's five refusal reasons, and the one error constructor that carries them.
 *
 * A separate module because both halves of the AST need it — `emit.ts` (which builds
 * the statement) and `ops.ts` (which decides whether the statement may be built at
 * all) — and neither may own the other's copy: two `refuse` functions would be two
 * wire formats for one 422.
 */
import { AppError } from '../errors.ts';

export type RefusalReason = 'default_required' | 'rebuild_required' | 'limit' | 'reserved_prefix' | 'too_many_statements';

/** §4.4's refusal: `422 SKW_E_DM_DDL_REJECTED` with the reason on the wire. */
export function refuse(reason: RefusalReason, message?: string): AppError {
  return new AppError('SKW_E_DM_DDL_REJECTED', message, { reason });
}
