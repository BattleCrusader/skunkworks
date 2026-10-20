/**
 * TOTP secret material — E-19, §9.1's "TOTP mandatory when the allowlist is empty".
 *
 * The parameters are the normative ones and are not negotiable per install:
 * RFC 6238 defaults, SHA-1, 6 digits, 30 s, one step either side accepted
 * (`app/admin/auth.ts`'s `verifyTotp`). A secret is 20 fresh random bytes rendered
 * as unpadded base32 — 32 characters — which is the length RFC 4226 recommends and
 * what every authenticator app accepts.
 *
 * `app/cli/skwctl.ts` and `app/admin/routes.ts` both mint secrets, so the mint, the
 * grouping and the URI live here and nowhere else: two implementations of "what a
 * secret looks like" would drift on the first change.
 */
import { randomBytes } from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** 20 fresh random bytes as unpadded RFC 4648 base32 (32 characters). */
export function newSecret(): string {
  const bytes = randomBytes(20);
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** The secret in groups of four, which is how a human types it into a form. */
export function groupOf(secret: string): string {
  return (secret.match(/.{1,4}/g) ?? []).join(' ');
}

/** `otpauth://totp/Skunkworks:<email>?...`, E-19's URI verbatim. */
export function otpauthUri(email: string, secret: string): string {
  return `otpauth://totp/${encodeURIComponent(`Skunkworks:${email}`)}?secret=${secret}&issuer=Skunkworks&algorithm=SHA1&digits=6&period=30`;
}

/** The one-line parameter statement that goes in the enrolment file. */
export const TOTP_PARAMETERS = 'SHA1, 6 digits, 30 s period, one step either side accepted';

/**
 * A 24-character password. base64url of 18 random bytes is exactly 24 characters
 * and contains no shell-special byte, so it survives being pasted, quoted and
 * typed. E-19's floor is 16; this is the generator, and 24 is the value the slice
 * promises.
 */
export function newPassword(): string {
  return randomBytes(18).toString('base64url');
}
