# S9 — Fractional Works becomes a job board

**Status:** slice 0 (this document + the PII policy) is in the tree; slices 1–5 are the build.
**Written before any code that stores a person's data**, because the decisions below are the ones
that are expensive to change after rows exist.

---

## 1. What changes

Fractional Works stops being a consultancy brochure and becomes a **two-sided fractional job
board**: advertisers post fractional roles, applicants apply, and both sides get a portal.

| # | Requirement (the client's words) | Where it lands |
|---|---|---|
| 1 | the web copy has to change | slice 5 — a board's copy, not a brochure's |
| 2 | user and role management | slice 1 — core `accounts` (see §3 for why not a package) |
| 3 | register with OTP setup shown at creation; account inactive until email confirmation; log the verification URL | slice 1 |
| 4 | `advertiser` posts jobs, `applicant` applies; applicant portal manages applications and profile visibility; advertiser portal manages company, ads, applicants | slices 2–3 |
| 5 | new advertisement emails all qualifying applicants whose profile is visible | slice 3 + mail (§7) |
| 6 | advertiser views an applicant's profile read-only | slice 3, through `app/accounts/policy.ts` only |

---

## 2. Two findings that decide the architecture

Both were read out of the tree today, not assumed.

**2.1 `mail.send` is a stub that reports success.** `app/plugins/ops.ts:300` validates `to`,
`template` and `vars`, then returns `{ queued: true }`. Nothing is sent — there is no transport
anywhere in the repo, and every shipped box runs `SKW_EMAIL_MODE=off`, where the op refuses by
name. Requirements 3 and 5 are both email features, so **mail is not a detail of this slice; it is
a prerequisite**, and a `queued: true` that queues nothing is worse than an error because it looks
like delivery.

**2.2 A package cannot host a portal, and must not be given the chance.** `app/plugins/endpoint.ts`
builds an `EndpointRequest` with the tenant's database, the tenant key, method, endpoint, body and
url — **no actor, no session, no identity of any kind**. Package endpoints are public JSON by
design (§10.5), package screens are operator-only declarative lists over the package's own `p_*`
tables, and a package cannot read a `cms_*` table. So "an applicant portal as a plugin" would
require inventing a session and a PII boundary *inside* the sandbox — the single most effective way
to make a sandbox leak.

**Therefore:** identity, roles, profiles, companies, jobs, applications, portals and mail are
**core**, because core is where a session, a rate limiter, an audit chain and the tenant boundary
already exist. They are built with package-shaped seams (`app/accounts`, `app/jobs`, `app/mail`,
declared tables, declared screens, capability checks) so that exposing them to third-party packages
later is a deliberate, reviewable platform change (§9) rather than an accident of this feature.

---

## 3. Identity, roles, lifecycle

**Three tables in each tenant's `site.db`, not `control.db`.** An applicant belongs to one tenant;
putting them in the control plane would put a public registration path in the same database as the
fleet's operator accounts. Separate tables mean an applicant session can never be mistaken for an
operator session — different cookie, different path, different table.

| Table | Purpose | The constraints that matter |
|---|---|---|
| `cms_account` | one row per person | `email` UNIQUE NOCASE; `totp_secret` NOT NULL (OTP is mandatory, not an option); `status IN ('pending','active','suspended','closed')`, default `pending`; `failed_logins`, `locked_until` |
| `cms_account_role` | additive roles | `role IN ('applicant','advertiser')`, PK `(account_id, role)` — a person may be both, and no role implies another |
| `cms_account_token` | email verification, password reset | `token_hash` (sha256, **never the token**), UNIQUE; `purpose IN ('verify_email','reset_password')`; `expires_at`; `consumed_at` for single use |
| `cms_account_session` | portal sessions | id 32-byte hex; `csrf_secret`; `ip_hash`, `ua_hash`; `expires_at`; `rotated_from`; `revoked_at` |

**Registration** (requirement 3), in order, each step a precondition of the next:

1. `POST /join` — email, password, role, profile basics. Argon2id `m=19456,t=2,p=1` behind the
   existing 4-slot semaphore. A duplicate email returns the **same** page and timing as a new one,
   and mails "someone tried to register with your address" to the holder instead of revealing it.
2. **The TOTP secret is generated now and shown now** — as an `otpauth://` URI plus the secret in
   groups, on the same screen, before the account can be activated. The person must submit a code
   from their authenticator to prove enrolment; `totp_confirmed_at` stays NULL until they do.
3. A verification token is minted (32 random bytes, sha256 at rest, 24 h TTL), and the **URL is
   logged** to the operator-visible log *and* mailed. Logging a live token is a real trade: the
   operator can complete an activation for a locked-out user without a mail server, and the log is
   only readable by the box's own operator — it is never in an HTTP response, never in `cms_audit`,
   and never in a page. A second, non-secret event row records that a token was issued.
4. `GET /join/verify?t=…` activates: token consumed **atomically** (`UPDATE … WHERE consumed_at IS
   NULL`), `status` → `active`, `email_verified` → 1. A used, expired or unknown token is one
   indistinguishable page.
5. Login is refused while `status <> 'active'`, with the same generic message as a wrong password.

**Roles are grants, never inferred.** `applicant` may maintain a profile and apply; `advertiser`
must additionally belong to a company row (§5) and be `approved` before it can post. A new
advertiser registers into a `pending` company: self-service signup, operator approval before any
PII is reachable. That ordering is the whole defence against a fake employer harvesting profiles.

**Sessions** copy the admin model deliberately: `HttpOnly; Secure; SameSite=Strict; Path=/portal`,
`__Secure-sk-user-<tenant>` (the `__Secure-` prefix forbids a `Domain=` attribute structurally),
rotation on privilege change, idle and absolute expiry, `ip_hash`/`ua_hash` recorded, CSRF token
bound to the session and required on every state change.

---

## 4. The PII model — one function, one test matrix

`app/accounts/policy.ts` (in the tree now) is the **only** place that decides what a viewer sees.
`test/accounts-policy.test.ts` proves it, including a key-set assertion that fails if a future
field is added to a projection without a reviewer noticing.

| Viewer | Sees | Because |
|---|---|---|
| the holder | everything | it is their record |
| tenant operator | the same projection + audit row written by the caller | they run the box; the screen has no reason to render an address |
| advertiser, **with an application from that person to that company's job** | display name, headline, summary, skills, day rate, availability, location, timezone, remote, links | the application is a deliberate disclosure |
| advertiser, no application | nothing | discoverability is not a licence to browse |
| anonymous | nothing | there is no public profile page |

**Contact details are never projected** — not to advertisers, not to operators; `mayShareContact()`
returns `false` for every viewer, and the projection type has no field to put an address in.
Contact happens through the platform.

**Visibility has two separate meanings, and the code keeps them apart:** `visibility` governs
*discovery and mail* (requirement 5's "profile as visible"), while an *application* is a grant to
one advertiser. A hidden profile is still shown to the employer the applicant applied to.

**No enumeration.** Every refusal — unknown id, another company's applicant, hidden profile, wrong
company — is the same 404 with the same body, so an id cannot be probed. Advertiser queries are
always scoped by `company_id` from the session, never by a request parameter.

---

## 5. Domain model (slice 3)

Core, in the tenant's `site.db`; the names carry `jobboard`'s domain but the rows are host-owned
because they join to identity:

- `cms_company` — name, slug, website, description, `status IN ('pending','approved','suspended')`,
  `approved_by`, `approved_at`. Only `approved` companies may post.
- `cms_company_member` — `(company_id, account_id)` PK, `role IN ('owner','poster')`. Membership is
  the only way an advertiser account reaches a company.
- `cms_job` — `company_id`, title, slug, summary, description, `skills_json`, `day_rate_cents`,
  currency, `days_per_week`, `duration_weeks`, `location`, `remote_ok`, `status IN ('draft',
  'published','closed')`, `published_at`, `closes_at`, `created_by`. Publishing is the event that
  triggers the fan-out, once (guarded by `notified_at`).
- `cms_application` (schema v9, shipped) — `job_id`, `advertiser_account_id`,
  `applicant_account_id`, `cover_note`, `status IN ('submitted','withdrawn','shortlisted',
  'rejected')`, `created_at`, `updated_at`; UNIQUE `(job_id, applicant_account_id)` so a double
  submit is the same application, not two emails to the employer. The row **is** the advertiser's
  grant for `policy.ts` (`shares`). It is core, not a `p_*` table, because a plugin's
  `EndpointRequest` carries no actor: a package can neither decide who may see this row nor send
  mail about it. `job_id` deliberately has **no** foreign key — the advert lives in the job board
  package's `p_jobboard_job`, and `app/plugins/install.ts` DROPs every table a manifest declares,
  so a core row must not be able to refuse that DROP.

---

## 6. Portals (slice 2)

Host-drawn, like the admin screens and for the same reason (no third-party markup on a tenant's
origin): `/portal` (sign in), `/portal/applicant` (applications, profile, visibility, notification
opt-in), `/portal/advertiser` (company, jobs, applicants). Every page is drawn from the session's
own role: **no session** is a `303` to `/portal/signin` — a bookmark should land on the form, not
on an error — and a session **without the role the page belongs to** is a `403` that names it
(`applicant` / `advertiser`), because a person who followed a link is owed the account type the page
is for rather than a page that cannot work.

Applicant portal, requirement 4: a list of applications with status, withdraw, and the profile with
**one** switch that governs discovery (`hidden` ⇄ `discoverable`) plus a separate opt-in for
"new jobs by email". Turning visibility on does not subscribe anyone; the two controls are separate
because the client asked for visibility and privacy is not a bundle.

Advertiser portal: company profile (editable only by `owner`), jobs (create/edit/publish/close),
applicants per job (read-only projection, never contact details), and an application status control.

---

## 7. Mail (slice 1b)

`app/mail/` — a real transport replacing the stub:

- **Transport**: SMTP via `nodemailer`, configured by `SKW_SMTP_URL` (`smtps://user:pass@host:465`).
  `SKW_EMAIL_MODE=off` still refuses by name — but a box that wants mail turns it on and it works.
  A dev sink (Mailpit in compose) is how the tests and the demo prove delivery.
- **Outbox in the tenant DB** (`cms_mail`): `idempotency_key` UNIQUE, `status IN ('queued','sending',
  'sent','failed','suppressed')`, `attempts`, `next_attempt_at`, `last_error`, `provider_id`.
  Retries are exponential with jitter; a 5xx or a hard bounce marks `suppressed` and writes
  `cms_mail_suppression` so an address that bounced is never hammered again.
- **One message per recipient.** Notification fan-out never uses `Bcc`; each row is its own send, so
  a reply cannot disclose the list, and each carries its own unsubscribe link.
- **No PII in subjects, headers or logs.** A subject names the job, never the applicant. Logs carry
  the outbox id and a template name; addresses are hashed in anything that is retained.
- **Unsubscribe, honoured at send time**: `cms_mail_suppression` is checked immediately before the
  transport call, not only at enqueue time, so an opt-out that arrives mid-queue still holds.

---

## 8. Threat model (the part that decides whether this is safe to ship)

| # | Abuse | Control | Proved by |
|---|---|---|---|
| T1 | register as an employer and harvest profiles | advertiser must belong to an **approved** company; no directory for advertisers; profile requires an application | slice 1/3 tests: `pending` company reaches no profile |
| T2 | walk ids to read other people's applications/profiles | every query scoped by session company/account; all refusals identical 404s | slice 3 test: two companies, cross ids → 404 for all |
| T3 | read a profile without an application | `projectProfile` returns null without `shares` | `P4`, `P7` |
| T4 | receive mail without consent | `mayNotify`: active + discoverable + explicit opt-in; unsubscribe honoured at send | `P12` + mail tests |
| T5 | take over an account via a stolen/guessed verification token | 32 random bytes, sha256 at rest, single-use via conditional UPDATE, 24 h TTL, one generic page for every failure | slice 1 tests |
| T6 | credential stuffing | argon2id + dummy-hash timing equalisation + exponential lockout + per-IP and per-account rate limits on `/portal/login`, `/join`, token endpoints | slice 1 tests |
| T7 | session theft | `__Secure-` + HttpOnly + Secure + SameSite=Strict + Path=/portal; rotation; idle/absolute expiry; ip/ua hashes recorded | slice 1 tests |
| T8 | CSRF on a state change | origin check (must be the tenant's https origin) + session-bound CSRF token on every POST, including logout | slice 1 tests |
| T9 | enumerate accounts by response or timing | identical page/timing for known/unknown on register, login, reset; `_pt` proof-of-time and `_hp` honeypot on public forms | slice 1 tests |
| T10 | job-spam / application-spam | per-account and per-IP limits on post and apply; one application per (job, account); publishing is idempotent | slice 3 tests |
| T11 | PII in a bundle handed to someone | accounts, profiles, tokens, sessions and mail are export-class `empty` — a bundle carries the *site*, never its people | `export-projection.json` + determinism test |
| T12 | a future field leaks by default | the projection key set is asserted exactly; `mayShareContact` is a named refusal | `P9`, `P10` |

**Out of scope for v1, stated so nobody assumes it:** CV/file upload (the media pipeline is the only
upload path and it is not opened to applicants yet), payments, and third-party "browse all
candidates" features.

---

## 9. If packages should own this later

The seams that would have to change, in order, and none of them are worth doing before the core
works: an **actor** in `EndpointRequest` (a verified `{accountId, roles, companyId}` minted by the
host, never by the package); a portal screen declaration and a per-endpoint auth policy in the
manifest; and a host-mediated read API that returns **projections**, never rows — so a package can
render a profile but can never hold one. That is a platform slice with its own threat model, not a
side-effect of this feature.

---

## 10. Slice plan and what "done" means

| Slice | Delivers | Done when |
|---|---|---|
| **0** ✅ | this document + `app/accounts/policy.ts` + `test/accounts-policy.test.ts` | 13/13 policy tests, gate green |
| **1** | schema v8, `app/accounts/*` (register, TOTP enrol, verify, login, logout, sessions), `/join`, `/join/verify`, `/portal/login` | a real browser registers, sees its OTP QR, confirms a code, cannot log in until the URL is opened, then can; every T-row above has a test |
| **1b** | `app/mail/` (SMTP + outbox + suppression), `mail.send` wired to it, Mailpit in compose | a message sent in a test arrives at the sink with the right headers and no PII; a bounced address is never retried |
| **2** | applicant and advertiser portals | portal pages render from the session's role; a role-less page is 404 |
| **3** | companies, jobs, applications, fan-out on publish | advertiser posts → visible applicants are mailed once; applicants apply; advertiser sees read-only profiles; cross-company ids are 404 |
| **4** | operator screens (approve a company, list accounts, suspend) | approval is the only path from `pending` to posting |
| **5** | copy: the site becomes a board | home lists live roles, `/for-advertisers`, `/for-applicants`, `/how-it-works`; no brochure leftovers |

Each slice lands with its own gate run; nothing is "done" on a claim.

---

## 11. Decisions taken now (reversible only with a migration, so written down)

1. **Advertisers self-register; the company starts `pending` and an operator approves it.** The
   alternative — invite-only advertisers — is safer still and can be turned on later by refusing
   self-registration; the table already carries the approval state.
2. **Notification mail is opt-in (`notifyNewJobs` default false)**, even for a discoverable profile.
   The client asked to mail "all qualifying applicants that has their profile as visible"; visible
   is necessary and not sufficient, and defaulting to on would mail people who never asked.
3. **Applications are the advertiser's only route to a profile.** No candidate search, no directory,
   no "view all applicants on the board".
4. **Contact details are never shared**, through any role. If the business later wants an employer
   to email a candidate, that is a relay feature with its own abuse controls, not a column.
5. **Accounts are per tenant and are not exported.** A bundle is a copy of the *site*, not its
   people.
