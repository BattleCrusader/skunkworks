/**
 * contact — capture a message from a public form, into one owned table.
 *
 * Three declarations, and this file is the third:
 *
 *   - `p_contact_message` is created by the host from `plugin.json`; the package never emits DDL;
 *   - `/messages` is a declarative admin screen over that table — the host renders it, so the
 *     package supplies no markup;
 *   - `POST /_plugin/contact/submit` is the one public URL. It validates the body, inserts one
 *     row through the per-request facade, and answers `{ok:true}`.
 *
 * Two rules are load-bearing here, and both are about what a public endpoint must not do:
 *
 *   1. **It never echoes the submission.** The success answer carries no message, name or email,
 *      and a refusal names only the fields that failed — never their values. A reflection bug in
 *      a contact form is how a tenant's own origin starts serving an attacker's text.
 *   2. **It validates before it writes.** The host caps the request body at 16 KiB; this package
 *      caps it tighter (12 KiB) and caps each field, so a 15 KiB "message" is refused here with
 *      the same answer as any other invalid body rather than reaching the table.
 *
 * `store.write` needs the `store.insert` capability, and that is the only one declared: this
 * package reads nothing and configures nothing.
 *
 * **What arrives as `body`.** The host hands an endpoint the raw request body *as a string*, and
 * only when its own parser left it a string: a request whose `Content-Type` is `application/json`
 * is parsed by the host's JSON parser into an object and reaches this handler as `''`, which is
 * refused here as `{ok:false, error:'body'}`. Send the JSON document as `text/plain` (or with no
 * content type) until the host forwards non-string bodies. The refusal is the safe half of that
 * limitation — a dropped body never becomes a row.
 *
 * **`ip_hash` is deliberately left NULL.** The host hands an endpoint `{query, body, method,
 * facade, ctx}` — there is no client address and no header in that signature, and inventing one
 * from the body would be a lie in a column an operator reads. The column exists (nullable) so a
 * host that later exposes a trusted client hash can populate it without a migration.
 */
const BODY_MAX_BYTES = 12 * 1024;
const NAME_MAX = 120;
const EMAIL_MAX = 254;
const COMPANY_MAX = 160;
const MESSAGE_MAX = 4_000;
/** The same shape the core form intake accepts, so one address is not legal in one form and not the other. */
const EMAIL = /^[^\s@<>]{1,64}@[^\s@<>]{1,190}\.[^\s@<>]{2,24}$/;

export function activate(ctx) {
  ctx.screen({ path: '/messages', table: 'p_contact_message', title: 'Messages' });

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
      // 1.2.0: the firm the enquiry came from, when the visitor named one. Null, not '', so a
      // missing company reads as "not given" rather than as a company with an empty name.
      company: checked.value.company === '' ? null : checked.value.company,
      message: checked.value.message,
      // Explicit rather than the column default: the row this package creates says what state it
      // is in, and a later change to the default cannot silently reclassify it.
      status: 'new',
      created_at: new Date().toISOString(),
    });

    return { ok: true };
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
