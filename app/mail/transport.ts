/**
 * The SMTP transport, and the one place a connection string becomes a client.
 *
 * `SKW_SMTP_URL` is a URL (`smtp://user:pass@host:587`, `smtps://…:465`), parsed here so the rest of
 * the app never sees credentials as a string. Nodemailer does the protocol — hand-rolling SMTP is
 * how a message gets sent twice, or sent in the clear because a `STARTTLS` was silently dropped.
 *
 * Two settings are not negotiable:
 *
 *   - **`requireTLS`.** A server that does not offer STARTTLS on port 587 is refused rather than
 *     used, because the alternative is a password and a stranger's address in cleartext.
 *   - **`rejectUnauthorized` stays on.** A self-signed mail server is a configuration problem, and
 *     disabling verification to "make it work" would make every later message forgeable.
 *
 * `pool` keeps one connection for a drain instead of one per message: a fan-out to fifty applicants
 * should not open fifty TCP connections in a minute.
 */
import { createTransport } from 'nodemailer';

import type { MailTransport, OutgoingMail } from './outbox.ts';

export interface SmtpOptions {
  /** `smtp://`, `smtps://`, or `smtp://host:587?secure=false` — parsed by WHATWG URL. */
  readonly url: string;
  /** The envelope sender. A mail server rejects a domain it does not own; this must be one it does. */
  readonly from: string;
  /** How long one message may take before it is a failure the outbox retries. */
  readonly timeoutMs?: number;
}

export const SMTP_TIMEOUT_MS = 20_000;

/** Parse and validate a connection string. Throws with the reason, never with the password in it. */
export function parseSmtpUrl(url: string): {
  host: string;
  port: number;
  secure: boolean;
  auth?: { user: string; pass: string };
} {
  const parsed = new URL(url);
  if (parsed.protocol !== 'smtp:' && parsed.protocol !== 'smtps:') {
    throw new Error(`SKW_SMTP_URL must start with smtp:// or smtps:// (got ${parsed.protocol})`);
  }
  const host = parsed.hostname;
  if (host === '') throw new Error('SKW_SMTP_URL has no host');
  const secure = parsed.protocol === 'smtps:' || parsed.port === '465';
  const port = parsed.port === '' ? (secure ? 465 : 587) : Number(parsed.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('SKW_SMTP_URL has no usable port');
  const user = decodeURIComponent(parsed.username);
  const pass = decodeURIComponent(parsed.password);
  return {
    host,
    port,
    secure,
    ...(user === '' ? {} : { auth: { user, pass } }),
  };
}

export function smtpTransport(options: SmtpOptions): MailTransport {
  const connection = parseSmtpUrl(options.url);
  const client = createTransport({
    ...connection,
    pool: true,
    maxConnections: 2,
    requireTLS: !connection.secure,
    tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
    connectionTimeout: options.timeoutMs ?? SMTP_TIMEOUT_MS,
    greetingTimeout: options.timeoutMs ?? SMTP_TIMEOUT_MS,
    socketTimeout: options.timeoutMs ?? SMTP_TIMEOUT_MS,
  });

  return {
    async send(mail: OutgoingMail) {
      const info = await client.sendMail({
        from: options.from,
        to: mail.to,
        subject: mail.subject,
        text: mail.text,
        // A stable Message-ID makes a retry recognisable to a receiving server, and to us in a log.
        messageId: `<${mail.idempotencyKey}@${options.from.split('@')[1] ?? 'localhost'}>`,
        headers: {
          'Auto-Submitted': 'auto-generated',
          'X-Auto-Response-Suppress': 'All',
        },
      });
      return { providerId: String(info.messageId ?? '') };
    },
  };
}
