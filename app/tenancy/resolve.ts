/**
 * resolveTenant() — the ten steps of SDS §5.3, in order.
 *
 * Frozen contract (register §4.1). Every failure gets exactly one code:
 *   SKW_E_PLT_EDGE_PROOF       421  steps 1, 2, 8
 *   SKW_E_PLT_TENANT_HEADER    400  steps 3, 4
 *   SKW_E_PLT_TENANT_UNKNOWN   404  resolution miss (steps 5, 6, 7), step 9
 *   SKW_E_PLT_TENANT_UNAVAILABLE 503 step 10 (non-schema)
 *   SKW_E_DM_SCHEMA_STALE      503 + Retry-After: 5   step 10 (user_version stale)
 *   SKW_E_DM_BUSY              503 + Retry-After: 1   step 10 (SQLITE_BUSY)
 *
 * ORDER DEVIATION, STATED: the table lists step 8 after steps 5 and 7, which
 * makes it unreachable (a valid non-empty header is consumed by step 5 before
 * step 8 is consulted). §9.2 and C-25 both require the admin listener to
 * refuse a header that is *present at all*, so step 8 is evaluated before
 * steps 5 and 7. Steps 1-4 keep their numeric order. Recorded as a spec defect
 * in docs/build/S1-report.md.
 */
import { AppError } from '../errors.ts';
import { normaliseHost } from './normalise-host.ts';

export const TENANT_HEADER = 'x-skunkworks-tenant';
export const EDGE_HEADER = 'x-skunkworks-edge';
export const PREFIX_HEADER = 'x-forwarded-prefix';

/** §5.1: the header name is a constant; a deployment cannot rename it. */
export const TENANT_KEY_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export type Listener = 'public' | 'admin';
export type TenantMode = 'production' | 'demo' | 'internal';
export type TenantStatus = 'provisioning' | 'active' | 'suspended' | 'archived';

export interface Tenant {
  id: number;
  key: string;
  mode: TenantMode;
  status: TenantStatus;
  dbVersion: number;
}

export type ProbeResult = 'ok' | 'stale' | 'busy' | 'unavailable';

export interface ResolveDeps {
  edgeToken: string;
  trustedCidrs: readonly string[];
  lookupHost(host: string): Tenant | undefined;
  lookupKey(key: string): Tenant | undefined;
  lookupId(id: number): Tenant | undefined;
  probe(tenant: Tenant): ProbeResult;
}

export interface ResolveInput {
  peer: string;
  host: string | undefined;
  headers: Record<string, string | string[] | undefined>;
  listener: Listener;
  session: { tenantId: number } | null;
}

export interface Resolved {
  ok: true;
  step: number;
  tenant: Tenant;
  via: 'header' | 'host' | 'session';
  prefix: string | null;
  host: string | null;
}

export interface Refused {
  ok: false;
  step: number;
  error: AppError;
}

export type Resolution = Resolved | Refused;

function header(headers: ResolveInput['headers'], name: string): string | undefined {
  const v = headers[name];
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v[0] : v;
}

function headerPresent(headers: ResolveInput['headers'], name: string): boolean {
  return Object.prototype.hasOwnProperty.call(headers, name) && headers[name] !== undefined;
}

/** Any X-Skunkworks-* header at all (step 1 is about the family, not one name). */
function anySkunkworksHeader(headers: ResolveInput['headers']): boolean {
  return Object.keys(headers).some((k) => k.startsWith('x-skunkworks-'));
}

/** The key out of `X-Forwarded-Prefix: /demo/<key>`; null when not a demo prefix. */
export function prefixKey(prefix: string | undefined): string | null {
  if (prefix === undefined) return null;
  const m = /^\/demo\/([a-z0-9][a-z0-9-]{0,62})(?:\/|$)/.exec(prefix);
  return m === null ? null : (m[1] as string);
}

export function resolveTenant(input: ResolveInput, deps: ResolveDeps): Resolution {
  const hdr = header(input.headers, TENANT_HEADER);
  const edge = header(input.headers, EDGE_HEADER);
  const prefix = header(input.headers, PREFIX_HEADER);
  const hdrNonEmpty = hdr !== undefined && hdr !== '';

  // Step 1 — an untrusted peer may not assert anything at all.
  if (!peerInCidrs(input.peer, deps.trustedCidrs) && anySkunkworksHeader(input.headers)) {
    return refuse(1, 'SKW_E_PLT_EDGE_PROOF', 'edge assertion from an untrusted peer');
  }

  // Step 2 — the token is the proof; the CIDR is the second half (§4.1).
  if (hdrNonEmpty && edge !== deps.edgeToken) {
    return refuse(2, 'SKW_E_PLT_EDGE_PROOF', 'missing or wrong edge token');
  }

  // Step 3 — shape, and the comma that a joined duplicate header produces.
  if (hdrNonEmpty && (!TENANT_KEY_RE.test(hdr) || hdr.includes(','))) {
    return refuse(3, 'SKW_E_PLT_TENANT_HEADER', 'tenant header is not a tenant key');
  }

  // Step 4 — the header and the prefix must name the same tenant.
  if (hdrNonEmpty && prefix !== undefined && prefixKey(prefix) !== hdr) {
    return refuse(4, 'SKW_E_PLT_TENANT_HEADER', 'tenant header disagrees with X-Forwarded-Prefix');
  }

  // Step 8 — the admin listener never takes a tenant from a header (§9.2, C-25).
  if (input.listener === 'admin' && headerPresent(input.headers, TENANT_HEADER)) {
    return refuse(8, 'SKW_E_PLT_EDGE_PROOF', 'the admin listener does not accept a tenant header');
  }

  const tenantPrefix = prefix === undefined ? null : prefix;

  // Step 5 — the edge asserted a tenant.
  if (hdrNonEmpty) {
    const tenant = deps.lookupKey(hdr);
    if (tenant === undefined) return refuse(5, 'SKW_E_PLT_TENANT_UNKNOWN');
    return finish(5, tenant, 'header', tenantPrefix, normalisedHost(input.host), deps);
  }

  // Step 6 — public listener, resolve from the normalised Host.
  if (input.listener === 'public') {
    const host = normalisedHost(input.host);
    if (host === null) return refuse(6, 'SKW_E_PLT_TENANT_UNKNOWN');
    const tenant = deps.lookupHost(host);
    if (tenant === undefined) return refuse(6, 'SKW_E_PLT_TENANT_UNKNOWN');
    return finish(6, tenant, 'host', tenantPrefix, host, deps);
  }

  // Step 7 — admin listener, session.tenant_id is the only source (C-11).
  if (input.session === null) return refuse(7, 'SKW_E_PLT_TENANT_UNKNOWN');
  const tenant = deps.lookupId(input.session.tenantId);
  if (tenant === undefined) return refuse(7, 'SKW_E_PLT_TENANT_UNKNOWN');
  return finish(7, tenant, 'session', tenantPrefix, normalisedHost(input.host), deps);
}

function finish(
  step: number,
  tenant: Tenant,
  via: Resolved['via'],
  prefix: string | null,
  host: string | null,
  deps: ResolveDeps,
): Resolution {
  // Step 9 — a resolved tenant that is not serving.
  if (tenant.status === 'suspended' || tenant.status === 'archived') {
    return refuse(9, 'SKW_E_PLT_TENANT_UNKNOWN');
  }
  // Step 10 — the file behind the tenant.
  const probe = deps.probe(tenant);
  if (probe === 'stale') return refuse(10, 'SKW_E_DM_SCHEMA_STALE');
  if (probe === 'busy') return refuse(10, 'SKW_E_DM_BUSY');
  if (probe === 'unavailable') return refuse(10, 'SKW_E_PLT_TENANT_UNAVAILABLE');
  return { ok: true, step, tenant, via, prefix, host };
}

function refuse(step: number, code: string, message?: string): Refused {
  return { ok: false, step, error: new AppError(code, message) };
}

function normalisedHost(raw: string | undefined): string | null {
  return normaliseHost(raw);
}

/**
 * IPv4/IPv6 CIDR containment. Exact addresses are compared after mapping the
 * IPv4-mapped IPv6 form (`::ffff:127.0.0.1`) down to IPv4.
 */
export function peerInCidrs(peer: string, cidrs: readonly string[]): boolean {
  const addr = canonicalPeer(peer);
  if (addr === null) return false;
  for (const cidr of cidrs) {
    if (cidrMatches(addr, cidr.trim())) return true;
  }
  return false;
}

function canonicalPeer(peer: string): string | null {
  if (peer === '') return null;
  let p = peer.trim().toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(p);
  if (mapped !== null) p = mapped[1] as string;
  if (p === '::1') return '127.0.0.1';
  // strip a zone id ("fe80::1%en0")
  p = p.replace(/%.*$/, '');
  return p;
}

function cidrMatches(addr: string, cidr: string): boolean {
  if (cidr === '') return false;
  const slash = cidr.indexOf('/');
  const base = slash === -1 ? cidr : cidr.slice(0, slash);
  const bits = slash === -1 ? null : Number(cidr.slice(slash + 1));
  const a = ipv4ToInt(addr);
  const b = ipv4ToInt(base);
  if (a !== null && b !== null) {
    const prefix = bits === null ? 32 : bits;
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
    const mask = prefix === 0 ? 0 : (-1 << (32 - prefix)) >>> 0;
    return (a & mask) === (b & mask);
  }
  if (a === null && b === null) {
    // IPv6: only exact match is supported, which is all a loopback needs.
    if (bits !== null) return false;
    return canonicalPeer(addr) === canonicalPeer(base);
  }
  return false;
}

function ipv4ToInt(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (m === null) return null;
  const parts = [m[1], m[2], m[3], m[4]].map((x) => Number(x));
  if (parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  const [a, b, c, d] = parts as [number, number, number, number];
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}
