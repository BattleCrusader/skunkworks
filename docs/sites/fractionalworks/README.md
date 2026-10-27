# Fractional Works — the site

A three-page site for a fractional software engineering firm, built in the Skunkworks CMS: three
`cms_page` rows, a theme package, and one enquiry form. No page carries a `<script>`, a `<style>` or
a stylesheet of its own — the look is a theme, the copy is content, and the form is a row.

| | |
|---|---|
| Tenant | `fractional` |
| Host | `fractionalworks.com.au` |
| Pages | `/`, `/contact`, `/careers` |
| Theme | `fractional-works` — `themes/fractionalworks/` → `themes/fractionalworks.zip` |
| Form | `cms_form` row `enquiry` (`mode = store`) |
| Menu | header: Contact · footer: Careers, Contact |

## The five placeholders

Everything a real business must fill in is a constant at the top of `scripts/seed-fractionalworks.ts`
(`CONFIG`) and a `__TOKEN__` in the copy. Nothing is invented at render time.

| Constant | Currently | Replace with |
|---|---|---|
| `BUSINESS_EMAIL` | `hello@fractionalworks.com.au` | the address a client writes to |
| `BUSINESS_PHONE` | `+61 400 000 000` | the number a client rings |
| `LINKEDIN_URL` | `…/company/fractional-works/` | the firm's LinkedIn page |
| `ABN` | `00 000 000 000` | the registered ABN |
| `CAREERS_EMAIL` | `careers@fractionalworks.com.au` | the address an engineer writes to |

Change them, then re-seed (below). The ABN and phone appear in the contact list and in the
`ProfessionalService` structured data, which is why they are single-sourced.

## Re-seeding the copy

```sh
node --no-warnings --experimental-strip-types scripts/seed-fractionalworks.ts --tenant fractional
```

It is an upsert keyed on the page path: run it twice and the site is the same site. It writes the
settings, the three pages with their `seo_json`, the two menus, and the `enquiry` form row.

**Stop the app before writing to a tenant database from the host**, and start it afterwards:

```sh
docker compose stop app
node --no-warnings --experimental-strip-types scripts/seed-fractionalworks.ts --tenant fractional
docker compose start app
```

A second writer against a live WAL has produced `SQLITE_READONLY` and, once, a
`database disk image is malformed` read that was cured by checkpointing. The CMS is the writer; the
host is a guest.

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

`<form data-gjs-type="form" data-form="enquiry">` on `/contact` (and the close section of `/`)
binds to the `cms_form` row. The host supplies what a hand-written form cannot:

- `action="/f/enquiry"`, `method="post"`;
- a signed `_pt` intent token, 30-minute TTL and a 1.5-second minimum fill;
- an `_hp` honeypot inside `aria-hidden` markup — filled means `202` and **no row**;
- per-field `required`/`maxlength` from `fields_json`, and 5 submissions per 10 minutes per
  fingerprint.

Measured on the live tenant: a real submission answers `202 {"ok":true,"id":1}` and writes one row;
a submission with `_hp` filled answers `202 {"ok":true}` and writes none; a missing `_pt` is a named
`400` refusal.

Submissions land in `cms_form_submission`. To send them somewhere else instead — Netlify Forms,
Formspree — set the row to forward mode; the markup does not change:

```sql
UPDATE cms_form SET mode = 'forward', action_url = 'https://formspree.io/f/<id>' WHERE key = 'enquiry';
```

The honeypot and token are then bypassed (the third party receives a plain POST), so keep the
honeypot field name in the service's own spam settings.

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

That writes `index.html`, `contact/index.html`, `careers/index.html`, `theme.css`,
`_theme/fractional-works/assets/**`, `robots.txt`, `sitemap.xml` and `security-headers.conf`
(13 files, 206 KB for this site).

**Netlify**

```sh
npm i -g netlify-cli
netlify deploy --dir dist-site --prod
```

`security-headers.conf` is nginx syntax. Netlify reads `_headers`, so translate the three lines once
(the CSP is the same string the app sends):

```
/*
  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data: https:; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
```

**Cloudflare Pages**

```sh
npx wrangler pages deploy dist-site --project-name fractionalworks
```

Cloudflare also reads `_headers` (same file as above), and `_redirects` is not needed: every page is
a directory with an `index.html`.

**A static tree has no server, so the enquiry form cannot store anything.** Either point the form at
Formspree/Netlify Forms first (see above) and re-export, or keep the form only on the CMS deployment.

## What is verified

- 748 tests, 0 failures (`make test`), including six for per-page SEO and the export gates.
- Rendered in Chrome at 375, 768 and 1440: no horizontal overflow, all three fonts loaded, 9 FAQ
  rows, form bound with `_pt` and `_hp`, 0 console errors.
- FAQ is native `<details>`/`<summary>`: keyboard operable, no script, and it prints.
- Contrast, computed: ink on paper 15.34:1, secondary 11.39:1, muted 5.67:1, accent 8.56:1, paper on
  the warm CTA 5.24:1 — all AA for normal text.
- The motion is transform-only on scroll (`animation-timeline: view()`, 380 ms), disabled under
  `prefers-reduced-motion`: a fade with `fill-mode: both` would hold `opacity: 0` on everything below
  the fold in a screenshot, a print, or any environment whose timeline never advances.

## Known gap

`og:site_name` is emitted by the live render (it reads the site's chrome record) and omitted from the
static tree, which has no chrome. Nothing else differs between the two documents.
