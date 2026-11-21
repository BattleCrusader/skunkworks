# Plugin packages

A package is a directory with `plugin.json`, an ESM entry point, optionally the client scripts it
declares in `files[]` (served same-origin at `GET /_plugin/<id>/f/<name>`), and — when it is packed —
a `test-report.json` beside it. Three states, and they belong to different things:

| State | Lives in | Belongs to |
|---|---|---|
| **In the library** | `data/plugin-library/<id>-<version>.tar.gz` | the box — every tenant sees every entry |
| **Installed** | `cms_plugin_installed` + the package's `p_*` tables in **that tenant's** `site.db` | one tenant |
| **Enabled** | `cms_plugin_installed.enabled` | one tenant |

A package in the library is not installed anywhere. Installing it from
`/admin/t/<tenant>/plugins` creates its tables in that tenant's database and nowhere else: two
tenants installing the same package get two copies of the schema and two sets of rows, and neither
can read the other's. Installing does not enable — Enable is a separate press.

## Putting a package on the shelf

```sh
skwctl plugin pack plugins/contact --report test-reports/contact.json \
  --out data/plugin-library/contact-1.2.0.tar.gz
```

Every package at once, with the smoke report written for you:

```sh
make plugin-shelf
```

It walks `plugins/`, computes each package's canonical root, writes `test-reports/<id>-<version>.json`,
packs `data/plugin-library/<id>-<version>.tar.gz`, and **prunes a superseded version** (never the
archive of a package that failed to pack — a failing run must not empty the shelf). No package here
declares `plugin.json.tests`, so each report says in its `note` that it records pre-pack smoke checks
rather than a suite result; that gap is real and this command does not pretend otherwise.

The report must be bound to the package's **own root hash**, and it must sit beside the package in
the archive rather than inside it — a file inside the root changes the hash the report attests,
which is why `pack` puts it there and why `unpackArchive` refuses an archive that has one inside.

Every tenant then sees `contact-1.2.0.tar.gz` under **Available on this box** until it installs it
for itself. The library is a directory, not a database: adding an archive is `cp`, removing one
removes it from the shelf for tenants that have not installed it (installed copies are unaffected).

## Signature and test reports

- Unsigned packages are legal only with the operator's explicit acknowledgement on the install form
  (`allow_unsigned`), and the installed row records `signature_state = unsigned`.
- A missing, stale or mismatched test report is `SKW_E_PL_TESTS_STALE`: a package cannot ship
  untested and be discovered by a client's contact form.
- A revoked root cannot be installed or enabled whatever the archive says about itself.

## Shipped packages

| Package | Version | Tables | Screen | Public endpoint | Scheduled job |
|---|---|---|---|---|---|
| `blog` | 1.1.0 | `p_blog_post` | “Blog posts” | `GET /_plugin/blog/posts` | — |
| `contact` | 2.1.0 | `p_contact_message`, `p_contact_digest` | “Messages” | `POST /_plugin/contact/submit` | `digest` |
| `menu` | 1.0.0 | `p_menu_item` | menus | `GET /_plugin/menu/items` | — |
| `analytics` | 1.0.3 | `p_analytics_event` | “Analytics events” | `POST /_plugin/analytics/collect` · `GET /_plugin/analytics/f/t.js` | — |

`analytics` 1.0.3 is the first package to declare `files[]`, and it is the reason the field exists.
A page's CSP is `script-src 'self'` with no nonce (§10.5, C-12), so the only way a package can run
code in a visitor's browser is a `<script src>` on the tenant's own origin — served by the host from
the package's own root at `/_plugin/<id>/f/<name>`, `text/javascript` only, realpath-contained, and
404 for anything the manifest did not declare. The package's `page.head` hook writes the tag; the
dashboard is the host's own Analytics screen (`/admin/t/<key>/analytics`), which reads the table and
draws no plugin markup. The tracker itself sets no cookie and stores no address — see
`docs/privacy/pii-australia.md` §5.

`contact` 1.2.0 adds the optional `company` column: a firm's enquiry form keeps the name of the firm
it came from instead of folding it into the message. A form the host draws can be given the page's
own words — `data-skw-label-<field>`, `data-skw-submit`, `data-skw-thanks` on the marker — because
the package owns the fields and the page owns the copy.

`contact` 2.1.0 **asks the schedule question with controls instead of a grammar.** 2.0.0 had one
string setting (`digest_schedule`, "up to 24 characters", `HH:MM±HH:MM`, UTC by default) — a parser's
input printed at a person, with the time zone pushed onto the operator. It is gone. What replaced it
is a declaration the screen can draw:

- **`digest_cadence`** — `type: "select"`, options that are the answers (`Off`, `Every day`,
  `Every weekday`, `Every Monday`, `On the 1st of each month`). The operator reads exactly what is
  stored.
- **`digest_at`** — `type: "time"`; the browser draws a clock, and the value is `HH:MM`.
- **the site's zone** — asked once per tenant under the field ("Times are in Australia/Sydney") and
  stored in `cms_settings.timezone`, because every scheduled thing on a site reads the same clock.
  The job refuses with `no-timezone` rather than assuming UTC, and `Intl` resolves the wall time, so
  a 09:00 digest stays 09:00 across a DST change instead of drifting an hour twice a year.

A setting's `type` is now the contract for **how it is asked**: `string`, `int`, `bool`, `json`,
`secret`, plus `time`, `select` (`options[]`) and `email`. `max` is a storage bound — an attribute on
the input, never the sentence under it — and `label`/`help` are the package's own words for the
screen. The Plugins save validates every answer before it writes any of them, and writes in one
transaction, so a refusal leaves the form exactly as it was found.

`contact` 2.0.0 **replaces the per-message notice with one scheduled digest**, because a site that
gets two enquiries a week does not need two emails and an operator could not turn them off. Three
declarations hold it together:

- **`jobs: [{name: "digest"}]`** — the package asks the host for a clock. A package cannot own one:
  its context is per-request and closed at response end, and §13.3.4's hook list excludes
  `cron`/`worker` on purpose. The host ticks once a minute (`app/plugins/jobs.ts`), invokes the
  handler with the same per-invocation facade as an endpoint, and asks nothing else. A job is not a
  URL: `/_plugin/contact/digest` is the tenant's ordinary 404.
- **`settings: notify_email, digest_schedule`** — what the operator answers. `digest_schedule` is
  `HH:MM` in UTC or `HH:MM±HH:MM` (e.g. `07:30+10:00`), so "07:30" is never ambiguous. `notify_email`
  is declared **`defaultFrom: "operator-email"`**: the host seeds it with the address of the operator
  who installed the package, because a scheduled job runs with no session and can never ask.
- **`p_contact_digest`** — the cursor (`last_message_id`) and the last slot served. Package state,
  not a setting: settings are the operator's answers and the Plugins screen shows every one of them.

The digest's rule is the important half: **one message per slot, carrying everything since the last
one, and nothing at all when nothing arrived.** The cursor advances only **after** a successful
enqueue, so `SKW_EMAIL_MODE=off` (or a refused capability) leaves the backlog pending instead of
consuming it — the enquiries go out at the next slot once mail works. A slot with no new rows
records the slot and sends no mail. One digest carries at most 25 enquiries inside a 24 KiB body
budget; the rest are named as waiting and go out at the next slot.

Both are edited on **Plugins → Package settings**, drawn from `manifest.settings` alone — the host
never invents a label from a key name and never renders a `secret` back. A save audits the keys it
wrote and not their values.

`plugins/` holds the sources; `data/plugin-library/` holds the archives. The zip/tar artefacts are
build output and are gitignored.
