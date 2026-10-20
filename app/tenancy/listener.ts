/**
 * §9.1 (E-2): the admin surface is a **hostname**, and that hostname is the only
 * thing that makes a request an admin request. The path never selects the
 * listener: `/admin`, `/admin/…`, `/adminish` and `/demo/<key>/admin/…` are
 * ordinary paths on a public listener.
 *
 * This lives outside `main.ts` so the admin router can reach the same rule
 * without a cycle: two implementations of "is this the admin listener" would be
 * the second source of truth §9.2 forbids.
 */
import { normaliseHost } from './normalise-host.ts';
import type { Listener } from './resolve.ts';

export function listenerFor(host: string | null | undefined, adminHost: string | null): Listener {
  if (adminHost === null) return 'public';
  const h = normaliseHost(host);
  const admin = normaliseHost(adminHost);
  if (h === null || admin === null) return 'public';
  return h === admin ? 'admin' : 'public';
}
