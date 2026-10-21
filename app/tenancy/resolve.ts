/**
 * resolveTenant() — SDS §5.3 as amended by 02-errata E-1, and by **D37**, which
 * removed the two rows that existed only because the admin surface was a hostname:
 *
 *   - **row 1** (`listener = 'admin'` refuses the tenant header, present at all) —
 *     there is no admin listener any more. The rule it enforced lives where it still
 *     means something: `AdminSurface.handle` refuses a **non-empty** tenant header on
 *     every `/admin` path, and the tenant on `/admin` comes from the Host, never from
 *     a header. An *empty* header is the edge's own `proxy_set_header … ""` and
 *     asserts nothing, which is why the refusal narrowed to non-empty.
 *   - **row 7** (`listener = 'admin'` resolves from `session.tenant_id`) — the admin
 *     tenant is the Host's tenant now, so a session cannot choose it. The gate that
 *     replaced the row is in `AdminSurface`: session.tenant_id must equal the Host's
 *     tenant id, and a mismatch is the same 404 a missing tenant is.
 *
 * The surviving rows keep their numbers. A gap in the table is honest; renumbering
 * would make every citation of "row 8" in the reports point at a different rule.
 *
 * Frozen contract (register §4.1, superseded for ordering/numbering by E-1):
 *   SKW_E_PLT_EDGE_PROOF       421  rows 2, 3
 *   SKW_E_PLT_TENANT_HEADER    400  rows 4, 5
 *   SKW_E_PLT_TENANT_UNKNOWN   404  rows 6/8 miss, row 9
 *   SKW_E_PLT_TENANT_UNAVAILABLE 503 row 10 (non-schema)
 *   SKW_E_DM_SCHEMA_STALE      503 + Retry-After: 5   row 10 (user_version stale)
 *   SKW_E_DM_BUSY              503 + Retry-After: 1   row 10 (SQLITE_BUSY)
 */
import { AppError } from '../errors.ts';
import { normaliseHost } from './normalise-host.ts';

export const TENANT_HEADER = 'x-skunkworks-tenant';
export const EDGE_HEADER = 'x-skunkworks-edge';
export const PREFIX_HEADER = 'x-forwarded-prefix';

/** §5.1: the header name is a constant; a deployment cannot rename it. */
export const TENANT_KEY_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

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
  /**
   * D37: there is no `listener` and no `session` here any more. Both existed to
   * answer "is this the admin hostname, and if so which tenant did the session
   * name", and the answer since D37 is "the admin surface is a path, and the
   * tenant is the Host's". Removing the inputs is what makes a second source of
   * truth (a header or a session choosing the tenant) unrepresentable rather
   * than merely unused.
   */
}

export interface Resolved {
  ok: true;
  /** The row of §5.3 that resolved this request (6, 7 or 8). */
  step: number;
  tenant: Tenant;
  /** D37 removed `'session'`: a session no longer chooses a tenant. */
  via: 'header' | 'host';
  /** `tenant.prefix`: `/demo/<key>` on a header-routed request, else `""` (E-11). */
  prefix: string;
  host: string | null;
}

export interface Refused {
  ok: false;
  /** The row of §5.3 that refused this request (1-5, 7, 8, 9, 10). */
  step: number;
  error: AppError;
}

export type Resolution = Resolved | Refused;

function header(headers: ResolveInput['headers'], name: string): string | undefined {
  const v = headers[name];
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v[0] : v;
}

/** Any X-Skunkworks-* header at all (row 2 is about the family, not one name). */
export function anySkunkworksHeader(headers: ResolveInput['headers']): boolean {
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

  // Row 2 — an untrusted peer may not assert anything at all.
  if (!peerInCidrs(input.peer, deps.trustedCidrs) && anySkunkworksHeader(input.headers)) {
    return refuse(2, 'SKW_E_PLT_EDGE_PROOF', 'edge assertion from an untrusted peer');
  }

  // Row 3 — the token is the proof; the CIDR is the second half (§4.1).
  if (hdrNonEmpty && edge !== deps.edgeToken) {
    return refuse(3, 'SKW_E_PLT_EDGE_PROOF', 'missing or wrong edge token');
  }

  // Row 4 — shape, and the comma that a joined duplicate header produces.
  if (hdrNonEmpty && (!TENANT_KEY_RE.test(hdr) || hdr.includes(','))) {
    return refuse(4, 'SKW_E_PLT_TENANT_HEADER', 'tenant header is not a tenant key');
  }

  // Row 5 — the header and the prefix must name the same tenant.
  if (hdrNonEmpty && prefix !== undefined && prefixKey(prefix) !== hdr) {
    return refuse(5, 'SKW_E_PLT_TENANT_HEADER', 'tenant header disagrees with X-Forwarded-Prefix');
  }

  // Row 6 — the edge asserted a tenant. Prefix is "" when absent (E-11).
  if (hdrNonEmpty) {
    const tenant = deps.lookupKey(hdr);
    if (tenant === undefined) return refuse(6, 'SKW_E_PLT_TENANT_UNKNOWN');
    return finish(6, tenant, 'header', prefix ?? '', normalisedHost(input.host), deps);
  }

  // Row 8 — no tenant header: the normalised Host is the only source, and a Host
  // that maps to nothing is a 404 (no default tenant).
  const host = normalisedHost(input.host);
  if (host === null) return refuse(8, 'SKW_E_PLT_TENANT_UNKNOWN');
  const tenant = deps.lookupHost(host);
  if (tenant === undefined) return refuse(8, 'SKW_E_PLT_TENANT_UNKNOWN');
  return finish(8, tenant, 'host', '', host, deps);
}

function finish(
  step: number,
  tenant: Tenant,
  via: Resolved['via'],
  prefix: string,
  host: string | null,
  deps: ResolveDeps,
): Resolution {
  // Row 9 — a resolved tenant that is not serving.
  if (tenant.status === 'suspended' || tenant.status === 'archived') {
    return refuse(9, 'SKW_E_PLT_TENANT_UNKNOWN');
  }
  // Row 10 — the file behind the tenant, one code per cause.
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
