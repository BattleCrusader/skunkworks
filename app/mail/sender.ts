/**
 * Which address a message leaves from.
 *
 * One box serves several sites, and a mail server will refuse — or worse, accept and mark as spam —
 * a message whose envelope sender claims a domain the server does not send for. So the sender is a
 * property of the **site**, not of the deployment: `<tenant>/site.db` carries `site.mail_from`, and
 * `SKW_MAIL_FROM` is only the fallback for a tenant that has not answered the question.
 *
 * The fallback is not "the first tenant's address": a site with no sender of its own is a site whose
 * operator has not configured mail, and sending its enquiries under another site's name is exactly
 * the confusion this setting exists to prevent. It is a deployment-wide default, deliberately, so a
 * single-site install needs one env var and nothing else.
 */
import type Database from 'better-sqlite3';

/** The `cms_settings` key a site answers this with. */
export const MAIL_FROM_SETTING = 'site.mail_from';

/** The same shape `env.ts` and the admin use for an address. Nothing looser is accepted. */
const ADDRESS = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * The sender for this tenant: its own declared address, or the deployment default.
 *
 * A stored value that is blank or malformed is treated as unset rather than as an error — the row
 * is editable by an operator, and a send that refuses because of a typo in a settings row is a
 * worse failure than a message from the default address.
 */
export function resolveMailFrom(db: Database.Database, fallback: string): string {
  let raw: unknown;
  try {
    const row = db.prepare('SELECT value_json FROM cms_settings WHERE key = ?').get(MAIL_FROM_SETTING) as
      | { value_json: string }
      | undefined;
    if (row !== undefined) raw = JSON.parse(row.value_json);
  } catch {
    // An unreadable row is an unset answer. See above: refusing to send is not the better failure.
    return fallback;
  }
  if (typeof raw !== 'string') return fallback;
  const value = raw.trim();
  if (value === '' || value.length > 254 || !ADDRESS.test(value)) return fallback;
  return value;
}
