# Made to Ship — the site

A six-page site for the software agency **Made to Ship** (`madetoship.com`), built in the Skunkworks
CMS and deployed on the local stack at **`dev-madetoship.com`**.

No page carries a `<script>`, a `<style>` or a stylesheet of its own: the look is a theme package,
the copy is content in the database, the header/footer are `cms_nav` rows, the two page menus are
the **menu package's** rows, and the enquiry form is the **contact package's** form drawn by the
host from a marker.

| | |
|---|---|
| Tenant | `madetoship` |
| Host | `dev-madetoship.com` → `127.0.0.1` (this box) |
| Pages | `/`, `/services`, `/process`, `/engagements`, `/about`, `/contact` |
| Theme | `madetoship` — `sites/madetoship/theme/` → package in `sites/madetoship/dist/theme/` |
| Packages | `menu` 1.0.0 (enabled) · `contact` 1.2.0 (enabled) |
| Form | `contact/contact`, rows in `p_contact_message`, read at **Admin → Messages** |
| Admin | `https://dev-madetoship.com/admin` — password + TOTP in `data/enrol-madetoship.txt` (0600) |

## The directory

```
sites/madetoship/
  content.ts          the copy — six page bodies, words only
  site.ts             the site as data — placeholders, page rows, SEO, menus, package menu rows
  seed.ts             the writer: pages, nav, settings, p_menu_item (one transaction)
  build.ts            theme package builder (canonical sheet + manifest → dist/theme/)
  install-plugins.ts  installs and enables menu + contact, writing their test reports
  verify.ts           the read-back: pages, theme, menus, form POST, database row
  verify-admin.ts     the other half: the owner credential, the console, and the bounce without it
  deploy.sh           tenant → packages → pages → theme → edge → verify, in that order
  theme/              theme.css, assets/ (monogram, marks, two fonts, OFL licence)
  dist/               build output (theme package, test reports) — regenerate, do not edit
```

## Deploying

```sh
sites/madetoship/deploy.sh            # from the repository root
sites/madetoship/deploy.sh --verify   # read back only
```

It stops the app, writes everything, gives the tenant's files back to the container's uid, starts
the app once, regenerates the edge config from `control.db`, reloads nginx and verifies from
outside. **Every write happens with the app stopped** — a host write under a live app checkpoints
the WAL behind the container's open connection, and the container's next write fails with
`SqliteError: disk I/O error` while every read still works (measured here on the first attempt:
the contact form answered 500 and `integrity_check` was clean).

`dev-madetoship.com` must resolve to `127.0.0.1`; `deploy.sh` checks and prints the `/etc/hosts`
line rather than editing it.

## The theme

`theme/` is the source; `dist/theme/` is the package `skw-theme import` takes. Edit the CSS, run
`node --no-warnings --experimental-strip-types sites/madetoship/build.ts`, then import + activate —
`deploy.sh` does all three.

The idea is a freight document rather than a SaaS brochure: paper ground (`#f5f2ec`), hairline
rules where a page would draw a shadow, mono column heads over ruled rows, and one industrial
orange (`#ff4a1c`) used as a stamp. Type is Inter (display, 800, uppercase, tight tracking) and
JetBrains Mono (labels, numbering, tables), both self-hosted latin subsets carried inside the
package with `assets/OFL-1.1.txt`; nothing render-blocks on a font CDN.

Contrast is measured, not assumed — every pairing used for text clears WCAG AA, the two smallest
at 5.61:1 (`ink on accent`, `accent on ink`); the accent is never used as text on paper, where
`--accent-ink` (`#a82b0a`, 6.23:1) is. The numbers are in the sheet's header comment.

## The packages

- **menu 1.0.0** — `p_menu_item`, the `Menus` screen, `GET /_plugin/menu/items`, and the
  `menu-main` / `menu-footer` blocks. The home page's **manifest** (`data-source="menu/menu-main"`,
  five rows) and the About page's **index** (`menu-footer`, four rows) are its rows; the host draws
  the `<ul>` and this site's CSS draws the ruled rows. Editing a row in **Admin → Menus** changes
  the page — the page carries no list.
- **contact 1.2.0** — `p_contact_message`, the `Messages` screen, `POST /_plugin/contact/submit`.
  `/contact` carries a marker with the page's own words on it (`data-skw-label-*`, `data-skw-submit`,
  `data-skw-thanks`); the package owns the four fields and the door they post to. Submit → 303
  `?sent=1` → the thanks sentence replaces the form; a refusal comes back to `?form_error=1` with
  the values still in the fields.

The install reports are honest about what they attest: `runner_image_digest` is
`sha256:madetoship-local`, the root hash is computed from the bytes on disk, `ran_at` is the run of
`test/plugin-menu.test.ts` + `test/plugin-shipped-packages.test.ts`, and the audit row records
`allow_unsigned=true` because these packages carry no publisher signature.

## The placeholders

Everything that must be a real business detail is a `CONFIG` constant in `site.ts` and a
`__TOKEN__` in the copy. Search for `REPLACE`.

| Constant | Currently | Replace with |
|---|---|---|
| `BUSINESS_EMAIL` | `hello@madetoship.com` | the address an enquiry is answered from |
| `BUSINESS_PHONE` / `BUSINESS_PHONE_HREF` | `+61 400 000 000` | the number a client rings (and its `tel:` digits) |
| `LINKEDIN_URL` | `…/company/made-to-ship/` | the agency's LinkedIn page |
| `ABN` | `00 000 000 000` | the registered ABN (also in the footer and the structured data) |
There are two cards, and the page a client reads decides which one they see — no geo-detection,
no currency swap, both indexable:

| Token | Reads | Buys |
|---|---|---|
| `DISCOVERY_FEE` | `$9,500` | one week, fixed, credited against the build |
| `SPRINT_FEE` | `$32,000` | two senior engineers, two weeks |
| `EXTRA_ENGINEER` | `$16,000` | a third engineer, per sprint |
| `RETAINER_FEE` | `$9,500` | four senior days a month, from |
| `DAY_RATE` | `$2,000` | a senior day beyond the retainer |
| `MIN_PROJECT` | `$32,000` | one sprint |

The arithmetic is written into `site.ts` beside the constants: a senior agency day runs
A$1,200–2,200, a sprint is 20 person-days at $1,600, and the retainer is four days plus an
availability premium. The business bills in Australian dollars and shows them as `$` — one
currency, one set of numbers, no per-visitor swapping and no second card.

`fill()` replaces the tokens, and `seed.ts` **refuses to write a page that still carries a
token** — a missing replacement is a build failure, not a price that reads `__SPRINT_FEE__` on the
live site.

Change them, then rerun `deploy.sh` — the copy lives in the database, so nothing is rebuilt.

## What was verified

`verify.ts` runs against `https://dev-madetoship.com` and asserts, from outside the container:

- six pages, 200, each with its own `<title>`, and no `<script>` other than the JSON-LD document;
- one currency: the card on `/engagements` reads `$32,000` and no page carries an `A$`, `AU$` or
  `US$`;
- the theme sheet at its declared URL, `text/css`, carrying `#ff4a1c`, and its monogram asset
  answering 200 as SVG;
- the menu package's block resolved to **five** rows on `/` with real labels and no template
  placeholder;
- the contact package's marker drawn as a **four-field** form; a real POST → `303 ?sent=1` → one
  row in `p_contact_message` (read back, then deleted, so the check leaves no residue);
- six published pages, nine menu rows, both packages enabled, theme `madetoship` active.

43 checks, all passing. `verify-admin.ts` then signs in with the password + TOTP from
`data/enrol-madetoship.txt` and asserts the other half: the login form asks for a second factor, the
POST answers `303 → /admin`, the Pages screen lists this site's paths, the Messages screen opens, and
the same URL *without* the session cookie bounces — 8 checks, all passing. No secret is printed.

Layout was checked at 1440 and 390 CSS px through CDP device emulation: `scrollWidth === 390` and
no element to the right of the viewport. (`--screenshot` with a small `--window-size` lies on macOS
— the OS enforces a minimum window width, so the page lays out wider than the captured image and
everything *looks* clipped.)

## Known gaps

- The site is a brochure plus an enquiry form: no blog, no case studies, no client logos. That is
  deliberate — a portfolio of invented clients would be a lie on a page that says "software,
  delivered".
- Prices are placeholders until the agency's real numbers replace them.
- `data/bundle` exports (`app/cli/export.ts --target static|cms`) work for this tenant, but the CMS
  target has not been cut for `madetoship.com` yet; this deployment serves the live CMS.
