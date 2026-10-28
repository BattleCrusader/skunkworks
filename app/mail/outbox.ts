/**
 * The outbox — the queue `cms_mail` has been collecting since schema v8, and the drain that empties it.
 *
 * The queue exists because sending is the unreliable part. `mail.send`, registration and (later) the
 * job fan-out all write a row and return; a separate drain hands rows to a transport. Three
 * consequences, each of which is why a field is here:
 *
 *   - a row can be **claimed** before it is sent (`status = 'sending'`), so two drains never send the
 *     same message twice;
 *   - a drain that dies mid-flight leaves a row in `sending`, and `RECLAIM_AFTER_MS` puts it back —
 *     the alternative is a message that is silently never sent;
 *   - a failed send is **retried with backoff** and, after `MAX_ATTEMPTS`, marked `failed` so an
 *     operator can see it rather than watching a queue grow.
 *
 * Suppression is checked at send time, not at enqueue time: someone who unsubscribes between the
 * write and the drain must not receive the message, and the row records `suppressed` rather than
 * being deleted, because "we chose not to send this" is a fact worth keeping.
 */
import type Database from 'better-sqlite3';

import { AppError } from '../errors.ts';
import { isTemplate, renderMail } from './templates.ts';

/** Give up after five attempts: 1, 5, 25, 125, 625 seconds of backoff — about 13 minutes of trying. */
export const MAX_ATTEMPTS = 5;
export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_FACTOR = 5;
/** A row stuck in `sending` for longer than this is assumed to belong to a dead drain. */
export const RECLAIM_AFTER_MS = 10 * 60_000;
/** How many rows one drain claims. Small on purpose: a burst should be several short drains. */
export const BATCH = 20;

export interface OutgoingMail {
  readonly id: number;
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly idempotencyKey: string;
}

export interface MailTransport {
  /** Send one message. Throws on failure; the message is retried, so a throw must mean "not sent". */
  send(mail: OutgoingMail): Promise<{ readonly providerId: string }>;
}

/** A transport that fails loudly. The default while `SKW_EMAIL_MODE=off`. */
export const NULL_TRANSPORT: MailTransport = {
  async send(mail) {
    throw new AppError('SKW_E_PLT_INTERNAL', `no mail transport configured (would send ${mail.subject})`);
  },
};

export interface DrainReport {
  readonly claimed: number;
  readonly sent: number;
  readonly failed: number;
  readonly suppressed: number;
  readonly skipped: number;
}

interface MailRow {
  id: number;
  to_email: string;
  template: string;
  subject: string;
  vars_json: string;
  attempts: number;
  status: string;
}

export class Outbox {
  readonly #db: Database.Database;
  readonly #transport: MailTransport;
  readonly #now: () => number;

  constructor(db: Database.Database, transport: MailTransport, now: () => number = Date.now) {
    this.#db = db;
    this.#transport = transport;
    this.#now = now;
  }

  /**
   * One drain. `claimed` rows are those this call took; anything already `sending` from a live
   * drain is left alone. The whole claim is one transaction so a crash between "read" and "mark"
   * is impossible.
   */
  async drain(): Promise<DrainReport> {
    const atMs = this.#now();
    const nowIso = new Date(atMs).toISOString();

    // The claim is a lease: `next_attempt_at` is moved forward to when the row becomes available
    // again, so a drain that dies mid-send is recovered and a live one is never stolen. Its
    // `attempts` already counted the try, so the backoff is respected rather than reset.
    this.#db
      .prepare(
        `UPDATE cms_mail SET status = 'queued', next_attempt_at = ?
          WHERE status = 'sending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)`,
      )
      .run(nowIso, nowIso);

    const claimed = this.#db.transaction((): MailRow[] => {
      const rows = this.#db
        .prepare(
          `SELECT id, to_email, template, subject, vars_json, attempts, status FROM cms_mail
            WHERE status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
              AND attempts < ?
            ORDER BY id LIMIT ?`,
        )
        .all(nowIso, MAX_ATTEMPTS, BATCH) as MailRow[];
      const lease = new Date(atMs + RECLAIM_AFTER_MS).toISOString();
      const mark = this.#db.prepare(
        "UPDATE cms_mail SET status = 'sending', next_attempt_at = ? WHERE id = ? AND status = 'queued'",
      );
      return rows.filter((row) => mark.run(lease, row.id).changes === 1);
    })();

    let sent = 0;
    let failed = 0;
    let suppressed = 0;
    let skipped = 0;

    for (const row of claimed) {
      const to = row.to_email.toLowerCase();
      const blocked = this.#db
        .prepare('SELECT 1 AS one FROM cms_mail_suppression WHERE email = ?')
        .get(to) as { one: number } | undefined;
      if (blocked !== undefined) {
        this.#db
          .prepare("UPDATE cms_mail SET status = 'suppressed', last_error = 'suppressed', sent_at = NULL WHERE id = ?")
          .run(row.id);
        suppressed += 1;
        continue;
      }

      let vars: Record<string, unknown>;
      try {
        vars = JSON.parse(row.vars_json) as Record<string, unknown>;
        if (!isTemplate(row.template)) throw new Error(`unknown template ${row.template}`);
      } catch (err) {
        // A row this build cannot render will never render. Failing it now is honest; leaving it
        // queued forever is a lie about how much mail is pending.
        this.#db
          .prepare("UPDATE cms_mail SET status = 'failed', last_error = ? WHERE id = ?")
          .run(`unrenderable: ${(err as Error).message}`.slice(0, 500), row.id);
        failed += 1;
        continue;
      }

      const rendered = renderMail(row.template, vars);
      try {
        const result = await this.#transport.send({
          id: row.id,
          to: row.to_email,
          // The template owns the subject. `cms_mail.subject` is the snapshot the enqueuer saw,
          // kept for the operator's queue view — sending it instead would let two renderings of the
          // same template disagree about what the message is.
          subject: rendered.subject,
          text: rendered.text,
          idempotencyKey: String(row.id),
        });
        this.#db
          .prepare(
            "UPDATE cms_mail SET status = 'sent', attempts = attempts + 1, sent_at = ?, provider_id = ?, last_error = NULL WHERE id = ?",
          )
          .run(new Date(this.#now()).toISOString(), result.providerId, row.id);
        sent += 1;
      } catch (err) {
        const attempts = row.attempts + 1;
        const message = err instanceof AppError ? err.message : err instanceof Error ? err.message : String(err);
        if (attempts >= MAX_ATTEMPTS) {
          this.#db
            .prepare("UPDATE cms_mail SET status = 'failed', attempts = ?, last_error = ? WHERE id = ?")
            .run(attempts, message.slice(0, 500), row.id);
          failed += 1;
        } else {
          const backoff = BACKOFF_BASE_MS * BACKOFF_FACTOR ** (attempts - 1);
          this.#db
            .prepare("UPDATE cms_mail SET status = 'queued', attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?")
            .run(attempts, new Date(this.#now() + backoff).toISOString(), message.slice(0, 500), row.id);
          skipped += 1;
        }
      }
    }

    return { claimed: claimed.length, sent, failed, suppressed, skipped };
  }

  /** How much is waiting, for the operator's screen. One query, no rows. */
  counts(): { queued: number; sending: number; sent: number; failed: number; suppressed: number } {
    const rows = this.#db.prepare('SELECT status, count(*) AS n FROM cms_mail GROUP BY status').all() as {
      status: string;
      n: number;
    }[];
    const out = { queued: 0, sending: 0, sent: 0, failed: 0, suppressed: 0 };
    for (const row of rows) if (row.status in out) out[row.status as keyof typeof out] = row.n;
    return out;
  }
}
