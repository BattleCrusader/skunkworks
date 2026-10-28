# Fractional Works — the site

A six-page job board for fractional work, built in the Skunkworks CMS: six `cms_page` rows, a theme
package, and one enquiry form. Companies post roles measured in days per week; applicants build a
profile with visibility control and apply. The core portals are `/portal/register`, `/portal/signin`,
`/portal/applicant` and `/portal/advertiser`; the job board package publishes each advert at
`/jobs/{slug}` and its public feed at `GET /_plugin/jobboard/jobs`.

No page carries a `<script>`, a `<style>` or a stylesheet of its own — the look is a theme, the copy
is content, and the form is a **package's** form, drawn by the host.

| | |
|---|---|
| Tenant | `fractional` |
| Host | `fractionalworks.com.au` |
| Pages | `/`, `/for-advertisers`, `/for-applicants`, `/how-it-works`, `/about`, `/contact` |
| Theme | `fractional-works` — `themes/fractionalworks/` → `themes/fractionalworks.zip` |
| Plugin | `jobboard` **1.0.0**, enabled — the home page's latest roles are its `latest-jobs` block |
| Form | `contact` package **1.2.0**, enabled — `/contact` carries a `data-skw-form` marker |
| Messages | `p_contact_message` in this tenant's `site.db`, read at **Admin → Messages** |
| Menu | header: Find work · Post a role · How it works · About · Contact; footer adds Sign in · Create an account |

## The five placeholders

Everything a real business must fill in is a constant in `scripts/content/fractionalworks-site.ts`
(`CONFIG`) and a `__TOKEN__` in the copy. Nothing is invented at render time.

| Constant | Currently | Replace with |
|---|---|---|
| `BUSINESS_EMAIL` | `hello@fractionalworks.com.au` | the address a company or an applicant writes to |
| `BUSINESS_PHONE` | `+61 400 000 000` | the number a company or an applicant rings |
| `LINKEDIN_URL` | `…/company/fractional-works/` | the operator's LinkedIn page |
| `ABN` | `00 000 000 000` | the registered ABN |
| `SUPPORT_EMAIL` | `support@fractionalworks.com.au` | the address an applicant writes to about their account |

Change them, then apply the copy (below). The ABN and phone appear on `/about`, on `/contact` and in
the `Organization` structured data, which is why they are single-sourced.

## The copy, as two files

- `scripts/content/fractionalworks.ts` — the six page bodies, the FAQ and the per-page titles and
  descriptions. Copy only.
- `scripts/content/fractionalworks-site.ts` — the placeholders, the six page rows with their
  `seo_json`, the two menus, the settings and the `enquiry` form row. Data only.

Both scripts below read that second file, so the seed and an update cannot disagree about what the
site is.

## Re-seeding a fresh site

```sh
node --no-warnings --experimental-strip-types scripts/seed-fractionalworks.ts --tenant fractional
```

The seed **builds** the site: it upserts the six pages, retires the brochure's `/careers`, `DELETE`s
every `cms_nav` row and rewrites both menus, and writes the settings and the form. That is right for
a new tenant and wrong for a live one, because the delete takes any menu row an operator added with
it.

## Applying the copy to a live tenant

```sh
node --no-warnings --experimental-strip-types scripts/update-fractionalworks.ts --tenant fractional --dry-run
node --no-warnings --experimental-strip-types scripts/update-fractionalworks.ts --tenant fractional
```

It changes only what the seed owns, and only when the bytes differ:

- the six page rows at the paths in `PAGES` — a page whose `body_sha`, title, slug and `seo_json`
  already match is not written, so `rev` does not move;
- the six `cms_settings` keys the seed writes;
- the `enquiry` form row;
- the header and footer rows it recognises by target. A row an operator added with another target is
  left alone, and a position it occupies is skipped rather than reused;
- the retired `/careers` page (with its revisions), which the board does not have.

A second run reports `0 change(s)`. The script refuses to write a body that still contains
`fractional software engineering`, `consultancy`, `consulting` or `we build your product`.

**Stop the app before writing to a tenant database from the host**, and start it afterwards:

```sh
docker compose stop app
cp data/tenants/fractional/site.db "$HOME/fw-site-$(date +%Y%m%d-%H%M%S).db"
node --no-warnings --experimental-strip-types scripts/update-fractionalworks.ts --tenant fractional
docker compose start app
```

A second writer against a live WAL has produced `SQLITE_READONLY` and, once, a
`database disk image is malformed` read that was cured by checkpointing. The CMS is the writer; the
host is a guest.

The copy lives in the database, so applying it needs **no rebuild and no redeploy**: the app reads
`cms_page` and `cms_settings` per request. A theme or code change is the only reason to rebuild the
image.

## The home page's latest roles

`/` carries the job board's block, not a hand-written list:

```html
<div class="fw-cards" data-gjs-type="list" data-source="jobboard/latest-jobs" data-limit="8">
  <article class="fw-card" data-repeat>…</article>
  <p class="fw-note" data-empty>No roles are published yet. …</p>
</div>
```

The host fills `[data-repeat]` from the package's declared block (published adverts only, newest
first, cap 20) and keeps `[data-empty]` when there are none. The package supplies rows, never markup;
the page supplies the card and its CSS. With no published adverts the page shows the empty note and
no placeholder card.

There is no `/jobs` index page: the home page is the list, and each advert is `/jobs/{slug}`.

## The theme

`themes/fractionalworks/` is the source, `themes/fractionalworks.zip` is what the Themes screen
takes. It is a package, not a stylesheet: the sheet, three self-hosted variable fonts (Fraunces,
Inter, JetBrains Mono — latin subsets, 147 KB together, OFL 1.1 with the licence text inside the
zip), and one drawn diagram. Rebuild and upload:

```sh
cd themes/fractionalworks && zip -qrX ../fractionalworks.zip theme.css theme.json assets \
  -x '.DS_Store' -x '__MACOSX/*' -x '._*'
```

Then **Admin → Themes → Upload a theme**, and **Activate**. `theme.css` references its files
relatively; the uploader rewrites them to `/_theme/fractional-works/assets/…?v=<sha8>` and serves
the bytes immutably.

Delete-then-upload keeps the theme key (`fractional-works`). Uploading a second copy alongside the
first produces `fractional-works-2`.

## The form

The enquiry form belongs to the **`contact` package** (1.2.0), not to a `cms_form` row. `/contact`
carries a marker, and the host draws the fields the package declared:

```html
<div data-skw-form="contact/contact"
     data-skw-label-name="Name" data-skw-label-email="Email"
     data-skw-label-company="Company" data-skw-label-message="What's the question?"
     data-skw-submit="Send it"
     data-skw-thanks="Thanks — your message is on its way. …"></div>
```

The package owns the **structure** (four fields, posted to its own endpoint); the page owns the
**words**, which is why the marker carries them. A page with no marker attributes gets the package's
own labels instead.

What happens on submit: the browser posts the page's own URL, the host forwards the declared fields
to `POST /_plugin/contact/submit` as JSON, the package validates and inserts one row, and the
visitor is redirected to `?sent=1` — where the page shows its thanks line instead of the form. A
refused submit comes back to `?form_error=1` with the form still filled in.

Messages live in `p_contact_message` **in this tenant's database** and are read at
**Admin → Messages** (list, open, edit, delete). They are exported with the rest of the tenant's
rows.

**The old core form is still installed but unused.** `cms_form` row `enquiry` (`mode = store`) and
`POST /f/enquiry` still work — nothing points at them.

## The portals

The board's two sides are core routes, not pages:

| Path | What it does |
|---|---|
| `/portal/register` | email, password, display name, and the applicant/advertiser roles |
| `/portal/signin` | password and TOTP code; a pending account is refused like a wrong password |
| `/portal/applicant` | profile edit (day rate, days a week, remote, discoverability), applications, the advert-number apply form |
| `/portal/advertiser` | applications to the advertiser's own adverts, each with a read-only profile projection |

Both portals are JS-free and follow the admin's discipline: origin check on every POST, CSRF bound
to the session, no third-party request. Contact details are not projected to advertisers at all;
`app/accounts/policy.ts` is the only place that decides what a viewer sees.

A new applicant profile starts **hidden** (the column's default), and a hidden profile cannot apply.
The copy says so on `/for-applicants` and `/how-it-works`.

## Deploying

### A. On Skunkworks (what this box runs)

The site is already a tenant on the local stack. To put it on a real domain:

1. **DNS** — point `fractionalworks.com.au` (and `www`) at the box.
2. **Certificate** — `tools/install_certs.mjs` mints a self-signed pair on install; the `acme`
   service replaces it. `data/certs/fractionalworks.com.au.crt|key` is the file nginx names.
3. **Edge config** — regenerate and reload after any tenant or host change:

   ```sh
   SKW_ADMIN_ORIGIN=$(grep -E '^SKW_ADMIN_ORIGIN=' .env | cut -d= -f2-) \
     node --no-warnings --experimental-strip-types tools/nginx_gen.ts --data-dir data --out data/nginx/10-app.conf
   docker exec skunkworks-nginx-1 nginx -t && docker exec skunkworks-nginx-1 nginx -s reload
   ```

4. **Admin** — `https://fractionalworks.com.au/admin`, the owner account in
   `data/enrol-fractional.txt` (password and TOTP secret; file mode `0600`, the only copy).

### B. Static, on Netlify or Cloudflare Pages

The CMS exports a tree that needs no server, and it carries the theme (sheet + fonts + diagram) and
each page's search metadata:

```sh
node --no-warnings --experimental-strip-types app/cli/export.ts \
  --target static --tenant fractional \
  --data-dir data --content content \
  --origin https://fractionalworks.com.au \
  --out dist-site
```

That writes `index.html`, one directory per page, `theme.css`, `_theme/fractional-works/assets/**`,
`robots.txt`, `sitemap.xml` and `security-headers.conf`.

**A static tree has no server, so the portals, the form and the job feed do not work there.** A
static export of a job board is a brochure again; keep the CMS deployment unless the board moves to
another host with its database.

### C. A self-contained image on another server (the CMS, form included)

For a box that should run the site *and* keep the editor, the export is a kit that builds its own
image — no registry, no Node on the host, no nginx to configure:

```sh
node --no-warnings --experimental-strip-types app/cli/export.ts \
  --target cms --tenant fractional \
  --data-dir data --content content \
  --origin https://fractionalworks.com.au \
  --out /tmp/fw-cms
```

`/tmp/fw-cms` is the stock bundle (verified by `BUNDLE.json`). The kit wraps it in
`Dockerfile` + `docker-compose.yml` + `Caddyfile` + `provision.sh` + `deploy.sh` and the app's own
sources; on the server:

```sh
tar xf fractionalworks-deploy.tar.gz && cd fractionalworks-deploy
./deploy.sh            # build -> verify bundle -> seed the volume -> up
```

`provision.sh` runs the bundle's own sequence inside the image (`bundle_verify.mjs` →
`control.sql` → `seed_control.mjs` → tenant `site.db` → theme assets → `skwctl admin bootstrap`),
so the only host requirements are Docker and free ports 80/443. Caddy obtains the certificate and
sets `X-Forwarded-Proto: https`, which the admin's origin check requires.

## What is verified

- `make test` green, including the per-page SEO and export gates.
- Each page fetched from the running app after the copy update: 200, the new `<title>`, the two
  portal CTAs, and none of the brochure's terms.
- The latest-roles block resolved against a published advert in a copied database (title, location,
  `/jobs/{slug}`) and against no adverts (the empty note, no placeholder card).
- The update script run twice: 11 changes, then 0.

## Known gaps

- The advertiser portal shows applications to the advertiser's own adverts; it has no "post a role"
  form. Adverts are created on **Admin → Job adverts** today, and the copy describes the role's
  fields rather than a portal screen that does not exist yet.
- A public advert page renders the title and the body, not the structured day rate/days/remote
  columns, and it does not print the advert's id. The applicant portal's apply form asks for that
  number. Both are product gaps, not copy.
- `og:site_name` is emitted by the live render (it reads the site's chrome record) and omitted from
  the static tree, which has no chrome.
