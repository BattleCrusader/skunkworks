# Personal information in Australia — the position this product takes

**Status of this document:** written 2026-10-29 against `main` @ `c7f3575` plus the commit that adds
this file — 900 tests green, `make test` clean (900 pass, 0 fail, 0 skipped), `npm run typecheck`
clean. It is a working document, not a policy statement: every control below is marked with **where
it is enforced**, and the controls that are not enforced yet are numbered in §8 rather than implied.
If a row in §4 says *module*, the function exists and is tested but no route calls it yet — that is a
gap with a number, not a claim.

**The product in one sentence:** a job board where a person applies to an advert, an advertiser sees
the applicant's profile only because that person applied, and **the advertiser never sees contact
details.**

---

## 0. How to read the status column

| Mark | Means |
|---|---|
| **enforced** | A type, a SQL `CHECK`, or a test makes the alternative impossible or red. The enforcing artefact is named. |
| **module** | Implemented and tested in `app/accounts/pii.ts`; not yet called by a route. Always paired with a gap number in §8. |
| **policy** | A decision that lives in copy, contract or operator practice, with no code behind it. |
| **gap** | No control exists. Numbered in §8 with the smallest fix. |

---

## 1. What counts as personal information in Australia

### 1.1 The statutory definition

Privacy Act 1988 (Cth), s 6(1):

> **personal information** means information or an opinion about an identified individual, or an
> individual who is reasonably identifiable:
>
> (a) whether the information or opinion is true or not; and
>
> (b) whether the information or opinion is recorded in a material form or not.

Three consequences that matter for a job board:

1. **It is not limited to identifiers.** A summary that says "the only payments architect in
   Newcastle who has run a scheme migration" can identify one person without a name in it. The test
   is *reasonably identifiable*, not *named*.
2. **Opinions count.** A cover note is a person's opinion about themselves and their work. It is
   personal information even where it is wrong.
3. **It does not have to be in a database.** An email in a log line, a name in a rendered page, a
   cover note in a mail body: all personal information.

### 1.2 The OAIC's caution rule

The Office of the Australian Information Commissioner's guidance, *What is personal information?*
(https://www.oaic.gov.au/privacy/privacy-guidance-for-organisations-and-government-agencies/handling-personal-information/what-is-personal-information),
states that where it is unclear whether information is personal information, an organisation should
**err on the side of treating it as personal information**.

This document applies that rule in one specific way, and the way is the whole design: the risky
fields in this product are **not** the columns with obvious names. `cms_account.email` is
understood — it is a column called email. The risk is the four free-text fields (`display_name`,
`headline`/`summary`, `cover_note`, and `location`), because a text box is where a person types a
phone number, a street address, a diagnosis or a religion, and every one of those fields is then
shown to somebody who is not the person.

### 1.3 Sensitive information

Section 6 also defines **sensitive information** as information or an opinion about a person's
racial or ethnic origin, political opinions, membership of a political association, religious
beliefs or affiliations, philosophical beliefs, membership of a professional or trade association,
membership of a trade union, sexual orientation or practices, criminal record, health information
about the person, genetic information, biometric information used for identification, and
biometric templates.

Sensitive information may only be collected with consent and where it is reasonably necessary. A
job board has **no** reasonably necessary purpose for any of it, so the design answer is not "collect
it carefully" — it is a screen that refuses it, and forms that never ask. See §4 and §5.

The thirteen Australian Privacy Principles are at
https://www.oaic.gov.au/privacy/australian-privacy-principles/read-the-australian-privacy-principles.

### 1.4 IP addresses

An IP address is not, on its own, personal information: it identifies a connection, not a person.
The Office of the Information Commissioner (Queensland) puts the qualification precisely — an IP
address becomes personal information **once it is linked to other information about an
individual**
(https://www.oic.qld.gov.au/guidelines/for-government/guidelines-privacy-principles/transferring-personal-information-out-of-australia/ip-addresses,-google-analytics-and-the-privacy-principles).

This product links them. An IP is recorded against a session, a verification token, an audit row and
a rate-limit window, each of which is attached to an account. So under the OAIC's caution rule the
position taken here is: **treat the IP as personal information, and never store the address itself.**
What is stored is an HMAC-SHA256 of it under a server-side key (`hash64` in
`app/accounts/service.ts`, 64 hex characters), so a copy of `site.db` does not contain a working
address. The key is the install's, not the tenant's (`env.ipHashKey`), which means one hash value can
appear in more than one tenant on the same box; that is the cost of a single key and it is recorded
here rather than assumed away.

### 1.5 What this means for the two promises

- **"The advertiser never sees PII."** Enforced by shape: `policy.projectProfile()` returns a
  `ProfileProjection`, and that type has no field for an email, phone or address. A function cannot
  leak a field it has no name for. `test/accounts-policy.test.ts` asserts the key set, so a
  well-meaning refactor that adds one fails.
- **"No address may be stored; suburb/city is the most."** Enforced by the intake functions in
  `app/accounts/pii.ts` once they are wired (§8, gap G1). The column is `cms_profile.location`; the
  bound is `normaliseSuburbCity`.

---

## 2. Field-by-field inventory

Every row is marked **necessary**, **minimised** or **prohibited**, with the APP that justifies it.
"Necessary" does not mean "harmless" — it means APP 3's *reasonably necessary for a function of the
product* is satisfied, and the field is still subject to APP 6 (use only for that function) and APP
11 (protect it, delete it when the purpose ends).

### 2.1 The accounts surface — one `site.db` per tenant

| Storage | Field | Mark | What it holds, and why the mark is right | APP |
|---|---|---|---|---|
| `cms_account` | `email` | **necessary** | The account's identity: it is the address that receives the verification link and the reset link, and the one a person signs in with. There is no account without it. Used for nothing else — see §3.1. | APP 3, APP 6 |
| `cms_account` | `password_hash` | **necessary** | Argon2id hash, never the password. Verification requires the hash; the alternative (no password) is a weaker account. | APP 3, APP 11 |
| `cms_account` | `totp_secret` | **necessary — stored in clear (G11)** | Second factor. A job board holding an address and a CV is worth stealing, so the factor earns its place; but the secret is read straight out of the column by `verifyTotp`, so a copy of `site.db` is a copy of every second factor. | APP 3, APP 11 |
| `cms_account` | `failed_logins`, `locked_until`, `last_login_at` | **necessary** | Lockout state. APP 11 security, and the counters are integers, not facts about a person's life. | APP 11 |
| `cms_account_token` | `token_hash`, `expires_at`, `consumed_at` | **minimised** | A SHA-256 of the token, not the token: a stolen copy of the database cannot be replayed to activate an account. Single use by conditional `UPDATE`. | APP 11 |
| `cms_account_token` | `ip_hash` | **minimised** | 64-hex HMAC. Says "requested from the same network as the session", which is what a support question needs, and nothing more. | APP 11 |
| `cms_account_session` | `id`, `csrf_secret`, `expires_at`, `revoked_at` | **necessary** | Random ids, not tokens with claims; the CSRF secret binds the anti-forgery token to this session. 12 h absolute, 1 h idle (`PORTAL_SESSION_MS`, `PORTAL_IDLE_MS`). | APP 11 |
| `cms_account_session` | `ip_hash`, `ua_hash` | **minimised** | HMACs. They are what lets a rotated-away session be noticed, which is the whole reason to keep them. | APP 11 |
| `cms_profile` | `display_name` | **necessary** | The name the applicant chooses to be shown under. Nothing requires a legal name: a pseudonym is a valid display name, which is this product's answer to APP 2 (see §4). Free text, so screened. | APP 2, APP 3 |
| `cms_profile` | `headline`, `summary` | **minimised** | Free text capped at 200 and 4 000 characters (`PROFILE_LIMITS`). Their value is the person's own words; the risk is that the words include an email or an address, so they are screened before storage. | APP 3 |
| `cms_profile` | `location` | **minimised** | Suburb or city, optionally state and postcode. **Not an address** — see §3.3. | APP 3 |
| `cms_profile` | `skills_json`, `links_json` | **minimised** | The skills and the portfolio URLs the applicant chose to publish. A link is a deliberate disclosure to the advertiser; it is not a contact field. | APP 3 |
| `cms_profile` | `hourly_rate_cents`, `currency`, `availability_days_per_week`, `work_mode`, `visibility`, `notify_new_jobs` | **necessary** | The matching facts the product is for, plus two consents. The rate is money and `work_mode` is one of three words (`onsite`, `hybrid`, `remote`); nothing here identifies a person on its own. | APP 3, APP 6 |
| `cms_application` | `cover_note` | **minimised** | Free text, 4 000 characters, shown to the advertiser the applicant chose to send it to. Screened before storage; redacted in the operator view. | APP 3, APP 6 |
| `cms_mail` | `to_email` | **necessary** | Delivery address of one message. Bounded retention — see §6. | APP 3, APP 6, APP 11 |
| `cms_mail` | `vars_json` | **minimised** | Template variables. The application mail carries a job title, a display name and a headline **only**: `application_received` has no variable for an address, a phone or a rate, so a template cannot render one. | APP 3 |
| `cms_mail_suppression` | `email` | **necessary** | A suppression list only works if it holds the address it suppresses. **Gap G4**: it is stored in clear, with no retention bound. | APP 6, APP 11 |
| `cms_form_submission` | `payload_json` | **minimised — retention gap G5** | Core intake for a tenant-built form: whatever fields the operator declared. Arbitrary by construction, and kept indefinitely. | APP 3, APP 11 |
| `cms_download_event` | `ip_hash`, `ua_hash` | **minimised** | Counted redemptions, not people. | APP 11 |
| `cms_watermark_render` | `path` (and the file it names) | **necessary** | One stamped file per purchaser, carrying that purchaser's address. It is the anti-piracy control — a leaked file names its buyer — and the reason the table is swept and exported empty. | APP 3, APP 11 |
| `p_contact_message` (plugin) | `name`, `email`, `company`, `message` | **necessary — bounded by policy** | A visitor asks for a reply; the reply needs an address. Kept 90 days, then purged (§6.1). The message is free text from a stranger and is never shown to anyone but the operator. | APP 3, APP 5, APP 11 |
| `p_contact_message` (plugin) | `ip_hash` | **minimised** | Nullable and **NULL today**: the endpoint contract hands a package no client address, so the plugin writes nothing rather than a guess. | APP 11 |

### 2.2 The operator surface — `control.db`

| Storage | Field | Mark | Why | APP |
|---|---|---|---|---|
| `user` | `email`, `password_hash`, `totp_secret` | **necessary** | The operator is a person too; the same reasoning as `cms_account`, and a smaller population. | APP 3, APP 11 |
| `session` | `id`, `csrf_secret`, `ip_hash`, `ua_hash` | **minimised** | As above; the IP is an HMAC (control schema fixes `ip_hash TEXT NOT NULL`). | APP 11 |
| `audit_log` | `actor_label`, `action`, `target_kind`, `target_id`, `before_json`, `after_json`, `ip_hash` | **minimised — necessary for accountability** | The record of what an operator did. It is *about* the operator, so it is personal information; it is also the control that makes every other access answerable. Kept, with `ip_hash` rather than an address. | APP 6, APP 11 |
| `audit_seal` | `anchor`, `head`, `rows_in_day` | **prohibited-carrier / not personal information** | Day-segment hashes. It contains no personal information; it is what makes the log tamper-evident. | n/a |

### 2.3 Fields with no column anywhere

`cms_account` has twelve columns and `cms_profile` has fifteen; **none** of them is a phone
number, a street address, a date of birth, a government identifier, a racial or ethnic origin, a
religion, a sexual orientation, a political opinion, a health record, a biometric or a criminal
record. That is a schema fact, not a policy: adding one is a migration, a `gen_schema.py` change and
a review, which is exactly the friction such a field should meet.

---

## 3. The decisions

### 3.1 Email is stored, and it is the one exception

An account cannot exist without an address to confirm and sign in with. That is the whole
justification, and it is an APP 3 justification: the address is **reasonably necessary for the
function** the person came for (register, verify, sign in, be told about their own applications).
APP 3 also requires that the collection be by lawful and fair means and, under guideline 3.26, that
what is collected be **relevant, minimal and not excessive**
(https://www.oaic.gov.au/privacy/australian-privacy-principles/australian-privacy-principles-guidelines/chapter-3-app-3-collection-of-solicited-personal-information).
One address is the minimum that satisfies the function.

**And for no other purpose** (APP 6). In this tree the address is used for: the verification link,
the reset link, sign-in, and transactional mail about the person's own account or applications. It
is **not** shown to another user, **not** in any `ProfileProjection`, **not** in the advertiser's
screen, **not** in a mail template's variables, and **not** used for marketing except through the
separate `notify_new_jobs` opt-in, which defaults to off and is only ever set by the account holder
(`policy.mayNotify`). An address change has no self-service route today — gap G6.

### 3.2 Nothing else is collected

- **No phone number.** Not a column, not a form field, not a required step. A phone number cannot be
  verified by this platform, cannot be shown to an advertiser, and would only exist to be breached.
- **No street address.** See §3.3.
- **No date of birth.** Age is not a matching fact on this board; a birth date is an identifier.
- **No government identifiers.** No TFN, Medicare, passport, licence number or Centrelink reference.
  The screen refuses each by name rather than relying on a form not asking.
- **No sensitive information.** Nothing in §1.3 is solicited, and the screen refuses an obvious
  disclosure typed into a free-text field.

### 3.3 Location is suburb or city — the most we store

`cms_profile.location` is bounded by `normaliseSuburbCity()` in `app/accounts/pii.ts`:

- accepted: `Newcastle`, `Newcastle NSW`, `Melbourne, VIC`, `Surry Hills NSW 2010`;
- refused, `street`: `12 Smith Street`, `Unit 4/12 Smith St`, `123 Somewhere Rd`, `PO Box 55`;
- refused, `digits`: `12 Sydney`, `Sydney NSW 200`, `Sydney NSW 2010 extra` — any digit outside a
  trailing four-digit postcode;
- refused, `too-long`: beyond 80 characters.

The two exemptions are deliberate and narrow. A street-type word is refused **after the first
token**, so "St Kilda", "St Peters" and "Lane Cove" — real suburbs whose names begin with a street
word — remain storable, while "Smith Street" and "Main Rd Bentleigh" do not. And a four-digit
postcode is the only digit sequence the field will keep, because a postcode locates a suburb and a
house number locates a person.

What the function does **not** do is check that "Sydney" is a real suburb. That needs a gazetteer,
and a gazetteer that rejects "Wyndham Vale" because the dataset predates the estate is a worse
control than none. The guarantee is the one that matters: no house number, no street type, so the
column cannot hold an address.

### 3.4 Free text is screened before it is stored or shown

Every free-text field is a place a contact detail arrives by accident: people sign a summary, paste
a signature block, or write "call me on 0412…" in a cover note because they are anxious to be
reached. `screenFreeText()` refuses four shapes — email, Australian phone, street address, and a
sensitive-category disclosure — before the write, and `redactFreeText()` removes the same contact
shapes from text that must be preserved for an operator to read.

The matchers are structural, not topical, because a screen that refuses "health-tech product
manager" or "disability support worker" is a screen operators learn to bypass:

- a phone must have a real Australian number's digit pattern (ten digits, a mobile prefix or an area
  code) — "ABN 12 345 678 901", "2019 to 2024" and "$120,000" are not numbers of people;
- an address must have a **number adjacent to a street-type word**, and the number token accepts
  exactly one trailing letter, which is what makes "1st", "2nd" and "3rd" unmatchable;
- a sensitive disclosure needs a first-person shape ("my health condition", "I was diagnosed with",
  "I'm a Christian", "my political views", "convicted of"); the bare domain words — healthcare,
  mental health services, disability support, criminal justice reform — are ordinary vocabulary on
  a job board and stay allowed;
- a 1300/1800/13 business number is not personal information and is not refused.

The screen's own limits are stated in §7 rather than hidden here.

---

## 4. The controls, mapped to the APPs

| APP | Requirement | Control | Where | Status |
|---|---|---|---|---|
| **APP 1** | A policy about how personal information is managed, available | This document. **No public privacy page exists in this tree.** | `docs/privacy/` | **policy / gap G7** — per tenant, still to be written |
| **APP 2** | People may deal anonymously or pseudonymously where lawful and practicable | An account needs an address (identity), but **no legal name**: `display_name` may be a pseudonym and nothing else is shown. | `cms_profile.display_name`; `ProfileProjection` | **enforced by absence** — no column requires a real name |
| **APP 3** | Collect only what is reasonably necessary; by fair means; minimal | The form and the types carry no contact field but the address; `PROFILE_LIMITS` caps every free text; `screenFreeText` refuses contact detail typed into one; `normaliseSuburbCity` bounds the locality. | `app/accounts/policy.ts`, `app/accounts/pii.ts` | **enforced** (types, CHECKs) / **module** (screen, locality — G1) |
| **APP 5** | Tell the person, at collection, what is collected, why, who it goes to, and the access/complaint path | The decision: a collection notice on each collecting page, with the contact page's notice specified in §6.1. **None is written yet.** | page copy | **policy** — G7, G8 |
| **APP 6** | Use or disclose only for the purpose collected (or a permitted secondary purpose) | `projectProfile()` is the single decision point; `ProfileProjection` has no contact field; an advertiser sees a profile **only** through an application to their own advert (`shares` is derived from the application row, never a query parameter). | `app/accounts/policy.ts` | **enforced** — `test/accounts-policy.test.ts` asserts the key set |
| **APP 8** | Cross-border disclosure accountability | The product stores data in the tenant's own `site.db`; the only outbound path is SMTP to the mail host the operator configures, and the mail body carries no contact field for a third party. | `app/mail/`, operator config | **policy** — the operator's SMTP choice is theirs, and the notice must name it (G8) |
| **APP 11** | Secure the information; destroy or de-identify when no longer needed | Argon2id passwords, TOTP, HMAC'd IPs (`hash64`), 64-hex `CHECK`s in the DDL, session expiry, single-use tokens; retention in §6. | `app/accounts/service.ts`, `schema/site.sql`, `schema/control.sql` | **enforced** (hashing, expiry) / **partial** (destruction — G2, G3, G4, G5) |
| **APP 11.2** | Destroy or de-identify when no longer needed | Sessions and tokens expire and are refused at read; the contact form's 90-day purge is decided but **not built**; mail and form-submission rows have no bound. | §6 | **partial** — see gaps G2/G3 |
| **APP 12** | Access on request | The account holder reads their own profile and applications at `/portal/applicant`; the operator reads the whole record to answer a request. | `app/accounts/routes.ts` | **enforced** for what the portal shows; **gap** for a full export (G6) |
| **APP 13** | Correction | Every profile field is editable at `/portal/applicant`; the account **address** is not. | `app/accounts/routes.ts` | **partial** — G6 |
| **NDB** | Assess and notify an eligible data breach | `audit_log` + `audit_seal` make access attributable and tamper-evident; a breach can be scoped by tenant and time window. No written playbook. | `control.db` | **gap** (G9) |

### 4.1 Why the projection is the strongest control here

`policy.projectProfile()` returns a type with no `email`, no `phone`, no `address`, no account id.
That is not a convention — it is a shape. Three separate things would have to change for a contact
field to reach an advertiser: the `ProfileProjection` interface, the single `view()` constructor,
and the key-set assertion in `test/accounts-policy.test.ts`. And an advertiser cannot even reach a
profile without an application row scoped to their own company, so the disclosure itself is the
applicant's act.

The leak that remains possible is not the projection. It is **content**: a person who types their
email into their summary, or their address into a cover note, is projected faithfully — the field
is theirs. That is what the screen is for, and it is the residual risk in §7.

---

## 5. What we do **not** store

- No phone number, anywhere, for anyone.
- No street address, no unit number, no PO box. Suburb or city is the most.
- No date of birth.
- No government identifiers: TFN, Medicare, passport, driver licence number, Centrelink reference.
- No sensitive information as defined in s 6: racial or ethnic origin, political opinions,
  religious beliefs, philosophical beliefs, union or association membership, sexual orientation,
  health or genetic information, biometrics, criminal record.
- No plaintext IP address: only an HMAC-SHA256 under a server key.
- No plaintext password: an Argon2id hash. (The TOTP secret *is* stored in clear — gap G11 — so it is
  named as a gap rather than claimed as a protection here.)
- No card number, no bank account: this product takes no payments.
- No third-party analytics, no advertising pixel, no session replay. There is no JavaScript on the
  portal pages at all, so there is nothing to instrument.
- No address in any mail template's variables: `application_received` has variables for a job title,
  a display name and a headline, and nothing else.

---

## 6. Retention

APP 11.2 requires destruction or de-identification when the information is no longer needed. The
table below is the schedule; **it distinguishes what the code does now from what the schedule
requires**, because a retention table that described the intention would be the least useful kind.

| Store | What | Retention | Mechanism today | Status |
|---|---|---|---|---|
| `cms_account_session` | session id, CSRF, ip/ua HMACs | 12 h absolute, 1 h idle | `expires_at` checked at every read; a session past it is treated as absent. **Rows are not deleted.** | **enforced at read / gap G2 at rest** |
| `cms_account_token` | verification and reset tokens | verify 24 h, reset 1 h; single use | `expires_at` + `consumed_at` checked at use; only a hash is stored. Rows are not deleted. | **enforced at use / gap G2 at rest** |
| `cms_mail` | queued and sent mail, `to_email` + vars | **30 days after `sent_at`** (recommended); suppressed and failed rows 90 days | Nothing deletes them; sent rows accumulate with an address in each. | **gap G3** |
| `cms_mail_suppression` | suppressed addresses | for as long as mail could be sent to that address | Kept in clear by necessity of matching; no bound and no hash. | **gap G4** |
| `cms_form_submission` | tenant form payloads (arbitrary PII) | **90 days** (recommended), or the operator's stated period | Nothing deletes them. | **gap G5** |
| `cms_watermark_render` | stamped download files | token expiry + continuation grace | A minute-interval sweep deletes the row and the file (`plane.watermark.sweep`). | **enforced** |
| `p_contact_message` (plugin) | contact-form messages | **90 days from `created_at`** | **Decided, not built** — §6.1. | **gap G1** |
| `audit_log` | operator actions, ip_hash | kept; the accountability record | Day-sealed; no deletion, deliberately. | **enforced as policy** |
| `cms_application`, `cms_profile`, `cms_account` | the applicant's record | for the life of the account, then on request | An account closing sets `status='closed'` and revokes sessions; the rows remain. Erasure is an operator action. | **gap G6** |

### 6.1 Contact messages: 90 days, automated, with a notice at the point of collection

**The decision.** The contact form stays. A contact message is kept **90 days from `created_at`**,
then deleted automatically. A **collection notice is shown on the contact page**, immediately above
the form, at the point of collection (APP 5): what is collected (name, email, optional company,
message), why (to reply to the enquiry), how long it is kept (90 days), that it is not used for
marketing or shared, and how to ask for a copy or a correction.

Ninety days is chosen as the longest period a small operator plausibly needs to answer an enquiry,
follow up once, and keep a record that the enquiry happened. It bounds the exposure of the one
public form on the site, which is the only place a stranger can write personal information into the
database without an account.

**Where the purge belongs, and why it cannot go where it looks like it should.** The contact plugin
owns `p_contact_message`. Core must not reach into a `p_*` table: the plugin installer **DROPs**
every table a manifest declares, so a core query against `p_contact_message` would be a dependency
on a table a package can remove at uninstall — and the same rule is why `cms_application.job_id`
takes no foreign key to the jobboard's table. The deletion must therefore be expressed *by the
plugin*, through the plugin contract.

**The contract has no scheduled work.** `app/plugins/manifest.ts` freezes twelve hooks — six filters
and six actions — and the file says in terms that `cron` and `worker` are absent because in-process
they would be theatre. A package cannot register anything that runs on a clock. Nor can it bulk
delete: `store.delete(table, id)` is `DELETE … WHERE id = ?` and requires exactly one row, while
`store.query` can select by `where`/`order` (the `created_at` column is indexed) with a limit of
1–500.

So the gap is real and is stated as a gap. **The smallest contract addition** — recommended, not
built here:

1. **One action hook name**, `maintenance.tick`, appended to `ACTION_HOOKS` in
   `app/plugins/manifest.ts`. No new manifest grammar: a package already declares the hooks it may
   register in `plugin.json`'s `hooks` array, so the package's own manifest is where it opts in.
2. **One dispatch site** beside the existing timers in `app/main.ts` — the watermark sweep already
   runs `setInterval(…).unref()` per tenant every 60 s, and the mail drain every 30 s, so the
   pattern, the tenant loop and the shutdown path exist. The tick passes `{tenant, plugin, now}`.
3. **Two capabilities** in the contact package's `plugin.json`: `store.query` and `store.delete`,
   which it does not declare today (it declares `store.insert` only). The package then selects the
   expired ids in bounded pages and deletes them one at a time, and writes one `log.write` line
   naming the cutoff and the count.

That is a name, a timer call and two capability strings — no new operation, no SQL from the
package, no new validator. The alternative considered and rejected is a `maintenance` block in the
manifest grammar (`{interval_s, max_per_tick}`), which is more surface for the same outcome.

Two properties make this safe: a daily tick cannot trip the hook bus's disable rule (three failures
in 60 s disables a plugin, `app/plugins/runtime.ts`), and the package already holds `log.write`, so
a purge is attributable without a new audit path. If the tick is never added, the honest fallback
is the one below.

**TODO (G1, the requirement, verbatim):** *`p_contact_message` rows older than 90 days from
`created_at` must be deleted automatically, at least daily, by the contact plugin itself through a
declared contract capability; core must not query or delete a `p_*` table; each run must write one
log line naming the plugin, the cutoff and the number of rows removed; and a failed run must not
disable the contact form.*

**If the operator wants zero PII from a public form**, the alternative already in the schema is
`cms_form.mode = 'forward'`: the form posts to an external `action_url` and **stores nothing**, or
`mode = 'disabled'` removes it. That is the zero-storage option, and its cost is the admin Messages
screen — no message is ever in this database, so none can be read there, exported, or breached.

**One thing the 90-day purge does not fix, and the operator should know:** the contact package
declares `p_contact_message`'s export class as `"rows"` in `plugins/contact/plugin.json`, so a
bundle exported from this site carries contact messages (and any message not yet purged) into
whatever copy the bundle becomes. Changing that one word to `"empty"` — the class
`cms_form_submission` and `cms_watermark_render` already use — makes an export a copy of the site
and never of its visitors. That is a one-line change to an existing file and is **not** made here
(G10).

---

## 7. The residual risk, stated plainly

Two things in this system remain personal information by necessity, and both are named rather than
wished away:

1. **An account's email address.** It exists because an account cannot exist without it (§3.1). It
   is protected by the hash of the password beside it, by TOTP, by a projection that has no field
   for it, and by the fact that no other user can reach it. It is **not encrypted at rest**: a person
   with the `site.db` file has the addresses. That is accepted for a self-hosted product whose
   database belongs to the operator, and it is why the address is never joined to anything a third
   party receives.
2. **Whatever a person types into a free-text field.** The screen catches the shapes people
   actually type — an email, a formatted Australian phone number, a number next to a street-type
   word, a first-person disclosure — and it will not catch an address written as prose: *"the white
   house on the corner of Smith and George"* passes, and would be shown to the advertiser the
   person applied to. That is the accepted residual risk.

**The mitigations that bound it**, in order of strength: the advertiser projection has no contact
field at all, so a leaked detail can only travel as *content the applicant wrote*; an advertiser
reaches a profile only through an application to their own advert; the screen refuses contact
detail before it is stored; and `redactFreeText` removes it from the operator's view, so a support
screenshot or a ticket does not carry it further.

**What would close it entirely** is not a better regex. It is a product decision not to accept free
text at all, which would remove the thing the product exists to carry. The position taken here is
that the screen, the projection and the application-as-grant are together proportionate to a job
board's purpose — and that the residual risk is disclosed to the operator, who is the entity bound
by the Act.

---

## 8. Gaps, with the smallest fix for each

| # | Gap | Smallest fix |
|---|---|---|
| **G1** | `screenFreeText` and `normaliseSuburbCity` are implemented and tested but **no route calls them**; the contact message purge does not exist. | Call the screen in the profile and application handlers before the write, and the locality bound wherever `location` is written; add `maintenance.tick` and the contact purge (§6.1). |
| **G2** | Expired sessions and consumed tokens are refused at read but never deleted; the tables grow without bound. | A daily sweep in the app's existing timer loop: `DELETE FROM cms_account_session WHERE expires_at < ?`, the same for consumed/expired tokens. |
| **G3** | `cms_mail` keeps every sent row, each with an address. | Delete `sent`/`failed` rows 30 days after `sent_at`, in the mail drain. |
| **G4** | `cms_mail_suppression` holds addresses in clear with no bound. | Store an HMAC of the address, or bound the row to the life of the account it belongs to. |
| **G5** | `cms_form_submission.payload_json` is arbitrary PII with no retention. | A retention setting per form, defaulting to 90 days, swept on the same timer as G2. |
| **G6** | No self-service **address change** (APP 13); no erasure on request (APP 11.2); no full export (APP 12). | A verified email-change flow (confirm the new address before releasing the old), and an operator-run erase that deletes the account row and lets `ON DELETE CASCADE` remove the profile, sessions and applications. |
| **G7** | APP 1/APP 5 copy: there is no per-tenant privacy page generated from this document. | A page template whose text is this document's §2–§6 in the operator's own words, linked from every form. |
| **G8** | The APP 5 notice must name the SMTP host that carries mail (APP 8). | One sentence in the notice, generated from the tenant's mail configuration. |
| **G9** | No written NDB response: assess, contain, notify the OAIC and affected individuals within 30 days where serious harm is likely. | A one-page playbook that starts from `audit_log`'s tenant + time window, which is the query the schema already supports. |
| **G10** | `p_contact_message` exports as `"rows"`, so a bundle carries contact messages. | Change `export` to `"empty"` in `plugins/contact/plugin.json`. |
| **G11** | `cms_account.totp_secret` is stored in clear, so a copy of `site.db` is a copy of every second factor. | Encrypt it with the key the rest of the secrets use, or accept and record the risk against the file's permissions. |

---

## 9. Sources

- Privacy Act 1988 (Cth), s 6 — definitions of personal information and sensitive information.
- OAIC, *What is personal information?* —
  https://www.oaic.gov.au/privacy/privacy-guidance-for-organisations-and-government-agencies/handling-personal-information/what-is-personal-information
- OAIC, *Australian Privacy Principles*, and APP 3 guideline 3.26 on relevant, minimal and
  non-excessive collection —
  https://www.oaic.gov.au/privacy/australian-privacy-principles/read-the-australian-privacy-principles
  and
  https://www.oaic.gov.au/privacy/australian-privacy-principles/australian-privacy-principles-guidelines/chapter-3-app-3-collection-of-solicited-personal-information
- Office of the Information Commissioner (Queensland), *IP addresses, Google Analytics and the
  Privacy Principles* —
  https://www.oic.qld.gov.au/guidelines/for-government/guidelines-privacy-principles/transferring-personal-information-out-of-australia/ip-addresses,-google-analytics-and-the-privacy-principles
- OAIC, *Notifiable Data Breaches scheme* — the 30-day assessment and notification obligation
  referred to in G9.
- In this repository: `app/accounts/policy.ts` (the projection), `app/accounts/pii.ts` (the screen
  and the locality bound), `schema/site.sql` and `schema/control.sql` (what can be stored at all),
  `schema/export-projection.json` (what leaves in a bundle).
