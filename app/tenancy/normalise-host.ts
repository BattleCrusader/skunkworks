/**
 * normalise(Host) = lowercase -> strip :port -> strip trailing dot ->
 * domainToASCII -> reject anything not [a-z0-9.-] (SDS §5.3).
 *
 * Host is never parsed twice: the resolver is the only reader (§5.3).
 */
import { domainToASCII } from 'node:url';

const HOST_RE = /^[a-z0-9.-]+$/;

export function normaliseHost(raw: string | undefined | null): string | null {
  if (raw === undefined || raw === null) return null;
  let host = raw.trim().toLowerCase();
  if (host === '') return null;
  // strip :port. A bracketed IPv6 literal is not a tenant host.
  host = host.replace(/:\d+$/, '');
  // strip trailing dots ("acme.test." is the same origin as "acme.test")
  host = host.replace(/\.+$/, '');
  if (host === '') return null;
  if (host.startsWith('[')) return null;
  let ascii: string;
  try {
    ascii = domainToASCII(host);
  } catch {
    return null;
  }
  if (ascii === '' || !HOST_RE.test(ascii)) return null;
  return ascii;
}
