/**
 * resolveAdminTenant(session) — SDS §5.3 step 7 / §9.2.
 *
 * "Every admin URL is /admin/t/<key>/…; resolveAdminTenant(session) returns the
 * tenant from session.tenant_id and is the only source; the admin listener
 * ignores Host for tenant resolution" (C-11).
 */
import { AppError } from '../errors.ts';
import type { Tenant } from './resolve.ts';

export interface AdminSession {
  tenantId: number | null;
}

export type AdminResolution =
  | { ok: true; tenant: Tenant }
  | { ok: false; error: AppError };

export function resolveAdminTenant(
  session: AdminSession | null,
  lookupId: (id: number) => Tenant | undefined,
): AdminResolution {
  if (session === null || session.tenantId === null) {
    return { ok: false, error: new AppError('SKW_E_PLT_TENANT_UNKNOWN') };
  }
  const tenant = lookupId(session.tenantId);
  if (tenant === undefined) {
    return { ok: false, error: new AppError('SKW_E_PLT_TENANT_UNKNOWN') };
  }
  return { ok: true, tenant };
}
