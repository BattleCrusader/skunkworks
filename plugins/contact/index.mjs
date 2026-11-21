/**
 * contact — capture a message from a public form, into one owned table, and tell the operator
 * about it **on their schedule, once** (v2.0.0).
 *
 * Five declarations, and this file is the fifth:
 *
 *   - `p_contact_message` is created by the host from `plugin.json`; the package never emits DDL;
 *   - `/messages` is a declarative admin screen over that table — the host renders it;
 *   - `POST /_plugin/contact/submit` is the one public URL. It validates the body and inserts a row;
 *   - the `notify_email`, `digest_schedule` and cursor settings name *who* is told and *when*;
 *   - the `digest` job is the scheduled entry point the host ticks (`plugin.json.jobs`). The host
 *     owns the clock; this package owns everything else.
 *
 * ## Why a digest and not a message per submission
 *
 * 1.5.0 mailed the operator once per submission. That is a notification for a form that a person
 * fills in twice a week, and it turns a busy hour into an inbox. 2.0.0 replaces it: **one message
 * per scheduled slot, carrying everything since the last one, and nothing at all when nothing
 * arrived.** There is deliberately no instant path left — two notification paths for the same row
 * is two copies of the same fact, and the operator cannot tell which one to trust.
 *
 * ## The two rules the scheduled half is written for
 *
 *   1. **Nothing new means no mail, and no lost mail.** The cursor (`digest_last_id`) is the highest
 *      `id` already sent and it advances **only after a successful enqueue**. A slot with no new
 *      rows records the slot and sends nothing; a slot whose enqueue is refused (mail off, no
 *      address) records the slot and leaves the cursor where it was — so the backlog goes out at
 *      the next slot instead of disappearing. A digest that is never sent is a fact the operator
 *      can see in Messages; a digest that silently skips rows is not.
 *   2. **The visitor is never told about mail.** The row is committed first, `{ok:true}` means
 *      "your message is stored", and the digest runs minutes or hours later with no visitor on the
 *      other end of it. Nothing about mail can turn a stored enquiry into a 500.
 *
 * ## What arrives as `body`, and why `ip_hash` is NULL
 *
 * The host hands an endpoint the raw request body *as a string*; a request parsed by the host's
 * JSON parser arrives as `''` and is refused here (`{ok:false, error:'body'}`) — send it as
 * `text/plain`. The host hands an endpoint `{query, body, method, facade, ctx}`: there is no client
 * address in that signature, so `ip_hash` stays NULL rather than being invented.
 *
 * ## Why `id` is the cursor
 *
 * `created_at` is an ISO string written by two concurrent requests that can share a millisecond,
 * and `store.query` can only order and filter on indexed columns. `id` is monotonic, is always
 * allowed, and cannot tie. The cursor is therefore `id > last_id`, ordered `id asc`.
 */
const BODY_MAX_BYTES = 12 * 1024;
const NAME_MAX = 120;
const EMAIL_MAX = 254;
const COMPANY_MAX = 160;
const MESSAGE_MAX = 4_000;
/** The same shape the core form intake accepts, so one address is not legal in one form and not the other. */
const EMAIL = /^[^\s@<>]{1,64}@[^\s@<>]{1,190}\.[^\s@<>]{2,24}$/;
/**
 * A digest slot: `HH:MM` in UTC, or `HH:MM±HH:MM` for a site that thinks in local time. The offset
 * is an explicit half of the value rather than a second setting, because "07:00" alone is a
 * question and "07:00+10:00" is an answer. DST is the operator's to adjust; a fixed offset that
 * silently moved twice a year would send the digest at the wrong hour for reasons nobody could see.
 */
/** The `cms_mail.template` this package enqueues under. The words are this package's. */
const DIGEST_TEMPLATE = 'contact-digest';
/** One digest carries at most this many enquiries; the rest wait for the next slot. */
const DIGEST_MAX_MESSAGES = 25;
/** The body budget. `mail.send` refuses `vars` over 32 KiB, and a subject/text pair is most of it. */
const DIGEST_BODY_MAX = 24_000;
/** How much of one enquiry is quoted. The whole message is in Messages and one click away. */
const DIGEST_MESSAGE_CHARS = 1_200;

/** Where an operator hands the enquiry on. A path, because the admin host is not this package's to know. */
function messagesPath(tenant) {
  return `/admin/t/${encodeURIComponent(tenant)}/messages`;
}

export function activate(ctx) {
  /**
   * Log once per distinct problem, not once per tick: the job runs every minute, so a misconfigured
   * setting would otherwise write ~1,440 identical lines a day and bury the one that mattered. The
   * key carries the offending value, so *changing* the setting logs again, and the set is bounded so
   * a pathological value cannot grow this closure forever. It writes through the **caller's**
   * facade: the activation facade is closed the moment `activate()` returns.
   */
  const warned = new Set();
  const warn = (facade, key, line) => {
    if (warned.has(key)) return;
    if (warned.size >= 32) warned.clear();
    warned.add(key);
    try {
      facade['log.write'](`contact: ${line}`.slice(0, 400));
    } catch {
      // A package that cannot log must not take the job down with it.
    }
  };

  // The screen is the package's, not only its table. Everything an operator does here — which
  // column is the handling state, the four states in their own words, the four bulk actions, what a
  // delete warns about, which column previews a message, and the badge in the admin bar — is
  // declared here. The host draws it and refuses to guess: a `set` value outside the column's
  // declared options, or a column the table does not own, fails activation by name.
  ctx.screen({
    path: '/messages',
    table: 'p_contact_message',
    title: 'Messages',
    // Rows narrow to one value of `status`; the chips are that field's own options, counted.
    filter: { column: 'status' },
    // The message itself, on one line, so a list reads like a list of enquiries.
    preview: 'message',
    actions: [
      { name: 'read', label: 'Mark read', set: { status: 'read' } },
      { name: 'replied', label: 'Mark replied', set: { status: 'replied' } },
      { name: 'archived', label: 'Archive', set: { status: 'archived' } },
      { name: 'new', label: 'Mark unread', set: { status: 'new' } },
      {
        name: 'delete',
        label: 'Delete…',
        delete: true,
        warning:
          'Deleting a message is permanent. There is no archive and no undo, and the site cannot bring the enquiry back.',
      },
    ],
    // What the admin bar counts: enquiries nobody has touched yet.
    badge: { column: 'status', value: 'new', label: 'Inbox' },
  });

  ctx.endpoint('POST', 'submit', async (args) => {
    const raw = typeof args.body === 'string' ? args.body : '';
    if (raw === '' || utf8Bytes(raw) > BODY_MAX_BYTES) return { ok: false, error: 'body' };

    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      return { ok: false, error: 'body' };
    }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return { ok: false, error: 'body' };

    const checked = validate(payload);
    if (checked.ok !== true) return { ok: false, error: 'invalid', fields: checked.fields };

    await args.facade['store.write']('p_contact_message', {
      name: checked.value.name,
      email: checked.value.email,
      // The firm the enquiry came from, when the visitor named one. Null, not '', so a missing
      // company reads as "not given" rather than as a company with an empty name.
      company: checked.value.company === '' ? null : checked.value.company,
      message: checked.value.message,
      // Explicit rather than the column default: the row this package creates says what state it
      // is in, and a later change to the default cannot silently reclassify it.
      status: 'new',
      created_at: new Date().toISOString(),
    });

    // The answer is the whole promise: the row is committed before it is written, so `{ok:true}`
    // means "stored". Telling the operator is the `digest` job's business, on the operator's clock.
    return { ok: true };
  });

  /**
   * **The digest.** Called by the host's job tick, never by a request.
   *
   * Order is the contract: read the schedule → decide whether this slot has been served → read the
   * new rows → enqueue → advance the cursor. Every refusal on the way is a returned report and a
   * log line; a job must not throw over an operator who has not filled in a setting yet.
   */
  ctx.job('digest', async ({ facade, ctx: runCtx }) => {
    // The invocation's own context, not the activation one: the activation context is closed the
    // moment `activate()` returns, and reading a field off it here would work by luck.
    const tenant = typeof runCtx.tenant === 'string' ? runCtx.tenant : '';

    const to = (await readString(facade, 'notify_email')).trim();
    if (to === '') return { skipped: 'no-recipient' };
    if (to.length > EMAIL_MAX || !EMAIL.test(to)) {
      warn(facade, `bad-recipient:${to}`, `digest skipped: notify_email ${JSON.stringify(to)} is not an address`);
      return { skipped: 'bad-recipient' };
    }

    const rawCadence = (await readString(facade, 'digest_cadence')).trim();
    // "Off" and "not answered" are the same outcome, and the screen shows one control for both.
    if (rawCadence === '' || rawCadence === DIGEST_OFF) return { skipped: 'off' };
    const cadence = CADENCES[rawCadence];
    if (cadence === undefined) {
      warn(facade, `bad-cadence:${rawCadence}`, `digest skipped: digest_cadence ${JSON.stringify(rawCadence)} is not a cadence this package knows`);
      return { skipped: 'bad-cadence' };
    }

    const at = (await readString(facade, 'digest_at')).trim();
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(at)) {
      warn(facade, `bad-time:${at}`, `digest skipped: digest_at ${JSON.stringify(at)} is not a time of day`);
      return { skipped: 'bad-time' };
    }

    // The site's clock, handed in by the host. A schedule without a zone is a time in a zone nobody
    // chose, so refuse rather than assume UTC: assuming is how a 9am digest arrives at 8pm.
    const zone = typeof runCtx.timezone === 'string' ? runCtx.timezone : '';
    if (zone === '') {
      warn(facade, 'no-timezone', 'digest skipped: this site has no time zone yet — set one on the Plugins screen');
      return { skipped: 'no-timezone' };
    }

    const nowMs = Date.parse(facade['util.now']());
    if (!Number.isFinite(nowMs)) {
      warn(facade, 'bad-clock', 'digest skipped: the host clock did not read as a time');
      return { skipped: 'bad-clock' };
    }
    const slotMs = dueSlot(nowMs, { cadence, at, zone });
    const state = await readState(facade);
    const lastRunMs = Date.parse(state.lastRunAt);
    // Not due, and this is the common case: two settings reads and one row read, no log line, no
    // write. A tick every minute is only honest because it costs this much.
    if (Number.isFinite(lastRunMs) && lastRunMs >= slotMs) return { skipped: 'not-due' };
    const slotIso = new Date(slotMs).toISOString();
    const cursor = state.lastMessageId;

    // One row more than a digest carries, so "there is more waiting" is a fact rather than a guess.
    const found = await facade['store.read']('p_contact_message', {
      where: [{ column: 'id', op: '>', value: cursor }],
      order: { column: 'id', dir: 'asc' },
      limit: DIGEST_MAX_MESSAGES + 1,
    });
    const fetched = Array.isArray(found?.rows) ? found.rows : [];
    if (fetched.length === 0) {
      // The slot happened and there was nothing to say. Record the slot so the next tick does not
      // re-ask, and leave the cursor alone: an enquiry that arrives in an hour belongs to the next
      // slot, not to this one.
      await writeState(facade, state, cursor, slotIso);
      return { sent: false, reason: 'empty', slot: slotIso };
    }

    const overflow = fetched.length > DIGEST_MAX_MESSAGES;
    const rows = overflow ? fetched.slice(0, DIGEST_MAX_MESSAGES) : fetched;
    const composed = composeDigest(rows, { tenant, hasMore: overflow });
    // The contiguous prefix the body budget could carry — never a filtered subset, or the cursor
    // below would step over an enquiry that is not in the message.
    const carried = rows.slice(0, Math.max(1, composed.included));
    const more = overflow || carried.length < rows.length;
    const subject = digestSubject(carried.length);
    const newestId = Number(carried[carried.length - 1].id);

    try {
      const queued = await facade['mail.send']({
        to,
        template: DIGEST_TEMPLATE,
        subject,
        // A template that is not one of the host's own carries its words in `vars`, and the drain
        // renders those. The fields are repeated unstructured so a site's `mail.template` filter
        // can reformat the digest without parsing the text.
        vars: {
          subject,
          text: composed.text,
          count: carried.length,
          tenant,
          last_id: newestId,
        },
      });
      // Only now does the cursor move: an enqueue that never happened must not consume rows.
      await writeState(facade, state, newestId, slotIso);
      const id = queued !== null && typeof queued === 'object' ? queued.id : undefined;
      return {
        sent: true,
        count: carried.length,
        more,
        slot: slotIso,
        mail_id: id ?? null,
      };
    } catch (err) {
      // The slot is recorded even though nothing was sent: this is "we chose (or were unable) not to
      // send for this slot", which is a fact, and it is logged once rather than every minute. The
      // cursor stays where it was, so the enquiries are still pending and go out at the next slot.
      await writeState(facade, state, cursor, slotIso);
      warn(
        facade,
        `refused:${reason(err)}`,
        `digest NOT queued: ${reason(err)} — ${carried.length} message(s) are stored and still pending`,
      );
      return { sent: false, reason: 'mail-refused', pending: carried.length, error: reason(err) };
    }
  });

  // S8k: the widget for the page builder. Registered after the endpoint: a form names the door it
  // posts to, and the host refuses a form whose endpoint the package did not declare — so the
  // order here is the contract, not a style choice.
  ctx.form({
    name: 'contact',
    label: 'Contact form',
    endpoint: 'submit',
    thanks: 'Thanks — your message is on its way. We reply to the address you left.',
    fields: [
      { name: 'name', label: 'Your name', type: 'text', required: true, maxLength: 120 },
      { name: 'email', label: 'Your email', type: 'email', required: true, maxLength: 254 },
      // Optional, and declared between email and message so the host draws it where a person
      // expects it. A page may relabel any of these (data-skw-label-*): the package names the
      // field, the page says what this site calls it.
      { name: 'company', label: 'Company', type: 'text', required: false, maxLength: 160 },
      { name: 'message', label: 'Message', type: 'textarea', required: true, maxLength: 4000 },
    ],
  });
}

/**
 * A settings read that cannot throw. A missing capability or an unreadable row is "not configured",
 * because the only alternative is a job that fails every minute for a reason the operator cannot
 * see from the Plugins screen.
 */
async function readString(facade, key) {
  try {
    const value = await facade['settings.get'](key);
    return typeof value === 'string' ? value : '';
  } catch {
    return '';
  }
}

/**
 * The digest's two facts — `last_message_id` and `last_run_at` — in the package's own table, not in
 * `settings`.
 *
 * Settings are the operator's answers, and the Plugins screen shows every one of them: a cursor a
 * person is invited to type is a cursor a person will eventually type. `p_contact_digest` is package
 * state, declared with export class `empty` so a site export does not carry it away either. One row,
 * created by the first digest that has something to record.
 */
async function readState(facade) {
  const found = await facade['store.read']('p_contact_digest', {
    order: { column: 'id', dir: 'asc' },
    limit: 1,
  });
  const row = Array.isArray(found?.rows) ? found.rows[0] : undefined;
  return {
    id: row !== undefined && Number.isInteger(row.id) ? row.id : null,
    lastMessageId:
      row !== undefined && Number.isInteger(row.last_message_id) && row.last_message_id > 0 ? row.last_message_id : 0,
    lastRunAt: row !== undefined && typeof row.last_run_at === 'string' ? row.last_run_at : '',
  };
}

/** Insert the one row, or update it in place. Written after the enqueue, never before it. */
async function writeState(facade, state, lastMessageId, lastRunAt) {
  const patch = {
    last_message_id: lastMessageId,
    last_run_at: lastRunAt,
    updated_at: new Date().toISOString(),
  };
  if (state.id === null) {
    await facade['store.write']('p_contact_digest', patch);
    return;
  }
  await facade['store.update']('p_contact_digest', state.id, patch);
}


/**
 * The five answers the `digest_cadence` control offers, and what each one means on a calendar.
 * The option strings are the values: the operator reads exactly what is stored, so there is no
 * id/label pair to drift and no lookup table on the screen's side.
 */
export const DIGEST_OFF = 'Off';
export const CADENCES = {
  'Every day': { days: 'all' },
  'Every weekday': { days: 'weekdays' },
  'Every Monday': { days: 'monday' },
  'On the 1st of each month': { days: 'first' },
};

const WEEKDAY_INDEX = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/** The wall-clock facts of one instant, in one zone, from `Intl` — the only zone database there is. */
function zonedParts(ms, zone) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
  });
  const out = {};
  for (const part of fmt.formatToParts(new Date(ms))) {
    if (part.type !== 'literal') out[part.type] = part.value;
  }
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour === '24' ? '0' : out.hour),
    minute: Number(out.minute),
    second: Number(out.second),
    weekday: WEEKDAY_INDEX[out.weekday] ?? 0,
  };
}

/** The zone's offset from UTC at one instant, in ms (positive east of Greenwich). */
function zoneOffsetMs(ms, zone) {
  const p = zonedParts(ms, zone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

/**
 * The instant at which a wall clock in `zone` reads `hour:minute` on a calendar date.
 *
 * Two passes, because the offset depends on the instant we are trying to find: the first guess uses
 * the offset at the naive UTC reading, the second corrects it with the offset at the guess. That is
 * what makes a spring-forward morning resolve to the time the clock actually said, instead of an
 * hour earlier — and an hour that does not exist resolves to the same instant as the hour after it,
 * which is the only honest answer a nonexistent time has.
 */
function zonedWallToInstant(year, month, day, hour, minute, zone) {
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0);
  const first = zoneOffsetMs(naive, zone);
  const guess = naive - first;
  const second = zoneOffsetMs(guess, zone);
  return second === first ? guess : naive - second;
}

/** Does this cadence answer to this local calendar date? */
function cadenceMatches(cadence, p) {
  if (cadence.days === 'all') return true;
  if (cadence.days === 'weekdays') return p.weekday >= 1 && p.weekday <= 5;
  if (cadence.days === 'monday') return p.weekday === 1;
  if (cadence.days === 'first') return p.day === 1;
  return false;
}

/**
 * The most recent instant at or before `nowMs` at which a slot occurred, in UTC ms.
 *
 * Walk back over the zone's own calendar — at most 32 days, because the longest gap between two
 * answers is a month — asking each date whether this cadence answers to it and, if it does, whether
 * its slot has already passed. At exactly the slot the slot is "now", so `last_run_at >= slotMs`
 * can see that it has been served.
 *
 * The month walk is bounded by the day-of-month arithmetic, not by a guess about February: a slot
 * on the 1st is found by walking back from today, which is why this works for a 31-day month
 * followed by a 28-day one without a table.
 */
export function dueSlot(nowMs, { cadence, at, zone }) {
  const [hour, minute] = at.split(':').map(Number);
  const today = zonedParts(nowMs, zone);
  for (let back = 0; back <= 32; back += 1) {
    // Step back one calendar day in the zone by stepping the instant back 24h and re-reading the
    // zone's date, so a DST day (23 or 25 hours) cannot accumulate an error.
    const probe = back === 0 ? nowMs : nowMs - back * 84_600_000;
    const p = zonedParts(probe, zone);
    if (!cadenceMatches(cadence, p)) continue;
    const slot = zonedWallToInstant(p.year, p.month, p.day, hour, minute, zone);
    if (slot <= nowMs) return slot;
  }
  // Unreachable for the four cadences above (each answers to at least one date in any window of 32
  // days); falling back to the top of today is better than a NaN that would enqueue nothing forever.
  return zonedWallToInstant(today.year, today.month, today.day, hour, minute, zone);
}

/** `3 new enquiries on acme` — singular when it is one, because an operator reads the subject. */
function digestSubject(count) {
  return `${count} new ${count === 1 ? 'enquiry' : 'enquiries'}`;
}

/**
 * The body: one block per enquiry, in arrival order, inside the byte budget the queue allows.
 *
 * **The included messages are a prefix, never a filtered subset.** A budget that skipped a long
 * enquiry in the middle and kept a short one after it would produce a digest that omits message 4
 * while the cursor — which advances to the last *included* id — jumps over it, and the enquiry would
 * never be sent at all. So the loop breaks at the first block that does not fit and reports how many
 * it took; the caller advances the cursor to exactly that message.
 *
 * An enquiry is not truncated to nothing: an operator deciding whether to answer needs the opening
 * of the message, the address to reply to, and when it arrived. The full text stays in Messages and
 * the block says so.
 */
export function composeDigest(rows, opts) {
  const tenant = typeof opts.tenant === 'string' ? opts.tenant : '';
  const opener = `${rows.length} ${rows.length === 1 ? 'enquiry' : 'enquiries'} came in through the contact form${tenant === '' ? '' : ` on ${tenant}`}.`;
  const blocks = [];
  let budget = DIGEST_BODY_MAX - opener.length;

  for (const row of rows) {
    const index = blocks.length;
    const message = typeof row.message === 'string' ? row.message.trim() : '';
    const excerpt = message.length > DIGEST_MESSAGE_CHARS ? `${message.slice(0, DIGEST_MESSAGE_CHARS)}…` : message;
    const block = [
      `${index + 1}. ${String(row.name ?? '(no name)')}${row.company ? ` — ${row.company}` : ''}`,
      `   Reply to: ${String(row.email ?? '(no address)')}`,
      `   Received: ${String(row.created_at ?? '')}   (id ${String(row.id ?? '')})`,
      '',
      excerpt
        .split('\n')
        .map((line) => `   ${line}`)
        .join('\n'),
      '',
    ].join('\n');
    // The first block always goes in: a digest with no message would be a subject line and a click.
    if (index > 0 && block.length > budget) break;
    budget -= block.length;
    blocks.push(block);
  }

  const included = blocks.length;
  const lines = [opener, '', ...blocks];
  if (included < rows.length || opts.hasMore === true) {
    lines.push(
      `More enquiries are waiting: this digest carries ${included}${opts.hasMore === true && included === rows.length ? ' and more arrived after them' : ''}, and the rest go out at the next one.`,
      '',
    );
  }

  lines.push(
    '--',
    `Open Messages to reply, mark or archive: ${messagesPath(tenant)} (on the admin host)`,
    `Enquiries newer than id ${String(rows[included - 1]?.id ?? '')} are still pending. This digest was`,
    'queued by the site on the schedule set for this package, not by a person.',
  );

  return { text: lines.join('\n'), included };
}

/** A host error's code and message, without a stack, so a log line stays one line. */
function reason(err) {
  if (err === null || typeof err !== 'object') return String(err);
  const code = typeof err.code === 'string' ? `${err.code}: ` : '';
  const message = typeof err.message === 'string' ? err.message : String(err);
  return `${code}${message}`;
}

/**
 * Field checks, in a fixed order, answering the names of the fields that failed. Nothing in the
 * answer is derived from the submitted values.
 */
function validate(payload) {
  const fields = [];
  const name = typeof payload.name === 'string' ? payload.name.trim() : '';
  const email = typeof payload.email === 'string' ? payload.email.trim() : '';
  const message = typeof payload.message === 'string' ? payload.message.trim() : '';
  // Optional: absent, null and '' all mean "not given". A value that is present but too long is
  // still refused by name, because it is a field the form drew and the visitor filled in.
  const company = typeof payload.company === 'string' ? payload.company.trim() : '';

  if (name === '' || name.length > NAME_MAX) fields.push('name');
  if (email === '' || email.length > EMAIL_MAX || !EMAIL.test(email)) fields.push('email');
  if (company.length > COMPANY_MAX) fields.push('company');
  if (message === '' || message.length > MESSAGE_MAX) fields.push('message');

  if (fields.length > 0) return { ok: false, fields };
  return { ok: true, value: { name, email, company, message } };
}

function utf8Bytes(value) {
  return new TextEncoder().encode(value).length;
}

export default activate;
