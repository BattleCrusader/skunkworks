/**
 * §9.1a (E-17) — `SKW_ADMIN_ALLOWLIST`: **one name, one parser, enforced at the edge.**
 *
 * This module is the only place a comma-separated CIDR list becomes blocks. Two
 * consumers import it and neither has a second copy:
 *
 *   - `app/env.ts`          — at boot, so a value that cannot be used is a
 *                             boot refusal naming the offending token (§2.3 step 1);
 *   - `tools/nginx_gen.ts`  — at generation, so the edge refuses the same value
 *                             with the same message before it writes a config.
 *
 * Two answers to "is this value usable" would be one answer too many, and the
 * alternative — treating a typo as empty — emits a config that looks applied and
 * is not (E-17).
 *
 * The rules, all from §9.1a:
 *
 *   - **Unset and empty mean the same thing: no allowlist.** Unset is the bundle
 *     default and is not an error; `""`, `" "` and `","` are empty.
 *   - **There is no way to express "deny all".** A value that parses to zero
 *     blocks is empty, so an empty list emits no access directive at all.
 *   - **A non-empty value that does not parse is a refusal**, naming the token.
 *
 * The parser does not decide what an empty list *means* to the app — §9.1 does:
 * TOTP mandatory, idle 15 min. It only decides whether the value is usable, so
 * `auth.ts`, `session.ts` and the bootstrap file all read the same array.
 *
 * **Host bits must be zero.** `10.0.0.5/24` is refused rather than silently
 * masked: masking would change the address the operator wrote, and accepting it
 * would put a value in the config that nginx may reject at `nginx -t` — after
 * the boot has already said the value was fine. E-17 is silent on this case; it
 * is decided here in the direction that keeps boot and edge in agreement.
 */
import { isIP } from 'node:net';

/** The one name (§4.3's table, twenty-three entries after E-17). */
export const ALLOWLIST_ENV = 'SKW_ADMIN_ALLOWLIST';

/** A value that is non-empty and cannot be used. `token` is what to show the operator. */
export class AllowlistParseError extends Error {
  readonly token: string;
  readonly why: string;

  constructor(token: string, why: string) {
    super(`${ALLOWLIST_ENV} is not a usable allowlist: ${why}: ${JSON.stringify(token)}`);
    this.name = 'AllowlistParseError';
    this.token = token;
    this.why = why;
  }
}

/**
 * Parse a raw value into CIDR blocks, in the order given.
 *
 * Returns `[]` for `undefined`/`null`/empty/whitespace/commas-only. Throws
 * `AllowlistParseError` for a non-empty value with any unusable member — one bad
 * member refuses the whole value, because a list that silently lost a block is a
 * control that silently narrowed.
 */
export function parseAdminAllowlist(raw: string | null | undefined): string[] {
  if (raw === null || raw === undefined) return [];
  const blocks: string[] = [];
  for (const member of raw.split(',')) {
    const token = member.trim();
    if (token === '') continue;
    blocks.push(validateBlock(token));
  }
  return blocks;
}

/** The same parse, reading the one environment name. */
export function parseAdminAllowlistFrom(source: NodeJS.ProcessEnv): string[] {
  return parseAdminAllowlist(source[ALLOWLIST_ENV]);
}

/** §9.1a's derivation, used by the edge generator and by any caller that needs it. */
export function allowlistIsEmpty(blocks: readonly string[]): boolean {
  return blocks.length === 0;
}

// --- validation -----------------------------------------------------------

const BLOCK_RE = /^([^/\s]+)\/(0|[1-9][0-9]{0,2})$/;

function validateBlock(token: string): string {
  const m = BLOCK_RE.exec(token);
  if (m === null) throw new AllowlistParseError(token, 'not <address>/<prefix>');
  const address = m[1] as string;
  const prefix = Number(m[2]);

  const family = isIP(address);
  if (family === 0) throw new AllowlistParseError(token, 'not an IPv4 or IPv6 address');
  const width = family === 4 ? 32 : 128;
  if (prefix > width) throw new AllowlistParseError(token, `prefix /${prefix} is wider than ${width} bits`);

  if (!isNetworkAddress(address, family, prefix)) {
    throw new AllowlistParseError(token, 'the address has host bits set; write the network address');
  }

  // Returned as given: §9.1a's drop-in says an IPv6 block is "rendered as given;
  // no expansion, no reordering". Only the surrounding whitespace is removed.
  return `${address}/${prefix}`;
}

function isNetworkAddress(address: string, family: number, prefix: number): boolean {
  if (family === 4) {
    const octets = address.split('.').map((o) => Number(o));
    const value = ((octets[0] as number) << 24) | ((octets[1] as number) << 16) | ((octets[2] as number) << 8) | (octets[3] as number);
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return ((value >>> 0) & mask) >>> 0 === (value >>> 0);
  }
  const value = ipv6ToBigInt(address);
  if (value === null) return false;
  const full = (1n << 128n) - 1n;
  const host = prefix === 0 ? full : (1n << BigInt(128 - prefix)) - 1n;
  return (value & host) === 0n;
}

/** `::`-compressed IPv6 (and a trailing dotted quad) to a 128-bit value. */
function ipv6ToBigInt(address: string): bigint | null {
  let text = address;
  // `::ffff:192.0.2.1` — the last 32 bits may be written as an IPv4 address.
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    const parts = tail.split('.').map((o) => Number(o));
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    const hi = (((parts[0] as number) << 8) | (parts[1] as number)).toString(16);
    const lo = (((parts[2] as number) << 8) | (parts[3] as number)).toString(16);
    text = `${text.slice(0, lastColon + 1)}${hi}:${lo}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] === '' ? [] : (halves[0] as string).split(':');
  const right = halves.length === 2 && halves[1] !== '' ? (halves[1] as string).split(':') : [];
  const missing = 8 - left.length - right.length;
  if (halves.length === 1 && missing !== 0) return null;
  if (missing < 0) return null;
  const groups = [...left, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...right];
  if (groups.length !== 8) return null;
  let value = 0n;
  for (const group of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    value = (value << 16n) | BigInt(parseInt(group, 16));
  }
  return value;
}
