# Import and export — sites and themes

Two artefacts, two CLIs, one rule: **a package is verified before anything is written**, so a
refused import leaves no half-built tenant and no half-installed theme.

```
site    → skw-export  (cut a bundle)      skwctl site import   (put it on a box)
theme   → skw-theme export                skw-theme import
```

---

## 1. A site

### Export

```bash
node --experimental-strip-types app/cli/export.ts \
  --target cms --tenant fractional \
  --data-dir data --content content \
  --origin https://fractionalworks.com.au \
  --out /tmp/fractional \
  --archive /tmp/fractional.zip        # or .tar.gz
```

- `--data-dir` is the box's `data/`; `--content` is the media root **and defaults to
  `<data-dir>/content`**, which is not where the repo's media lives. Pass `--content content` for a
  source checkout, or the cms target will refuse with `SKW_E_EXP_ASSET_UNRESOLVED` (and write
  nothing — the refusal is before the first byte).
- The tree is always written; `--archive` adds one file beside it, deterministic: two runs at one
  `--now` are byte-identical.
- `--target static` and `--target astro` produce publishable trees from the same projection
  (`projection_sha` is identical across all three targets for one database and one clock).

**What a `cms` bundle carries**

| | |
|---|---|
| schema | `schema/control.sql`, `schema/site.sql`, and the tenant `data/site.db` (every table created; content rows populated) |
| content | pages, nav, settings, forms, CSS blobs, theme rows, plugin rows, plugin data (`p_<id>_*`) |
| assets | every `cms_asset` **and every `cms_asset_variant`** (renditions are files too), plus theme assets under `data/tenants/<key>/theme-assets/` |
| plugins | `data/plugins/<id>/{plugin.json,index.mjs}` |
| installer | `install.sh`, `docker-compose.yml`, `nginx/`, `snippets/`, `tools/`, `BUNDLE.json` (sha256 per file), `EXPORT-NOTES.md` |

**What it deliberately does not carry** — the people. `cms_account`, `cms_account_role`,
`cms_account_token`, `cms_account_session`, `cms_profile`, `cms_mail`, `cms_application`,
`cms_audit` and the download/form-submission planes ship **empty** (`schema/export-projection.json`
classes them `empty`). A site bundle is a copy of the *site*, not a backup of the tenant's users. A
migration that must move accounts needs a separate decision, not this flag.

### Import

```bash
node --experimental-strip-types app/cli/skwctl.ts site import /tmp/fractional.zip \
  --tenant fractional --host fractionalworks.com.au --host dev-fractionalworks.com.au \
  --primary fractionalworks.com.au \
  --data-dir data
```

- Verifies every hash and symlink in `BUNDLE.json` **first**; a tampered archive refuses by name.
- Refuses an existing tenant key unless `--replace`; refuses a host that already belongs to another
  tenant (`domain.host` is unique).
- Migrates the bundled `site.db` forward to this tree's schema; refuses a bundle *newer* than the tree.
- Writes the tenant row and one `domain` row per `--host`, exactly one primary.
- `--nginx` regenerates `nginx/conf.d/10-app.conf` (off by default: in a source tree that file is
  committed).

### Routing — how a host reaches its site

The CMS already routes by `Host`. One nginx `server` block per tenant, listing all its hosts, each
host a `domain` row pointing at that tenant's own `site.db`. Measured on the dev box:

```
Host: abc123.com                  → data-tenant="abc123"
Host: dev-fractionalworks.com.au  → data-tenant="fractional"
Host: 123abc.com                  → data-tenant="site123"
```

Therefore:

- **A customer's own domain** is a `domain` row plus a DNS record that resolves to the box
  (`test.com ALIAS/A <box>`, or `CNAME` to a hostname — never a CNAME to a URL, and apex CNAMEs are
  invalid next to SOA/NS, so use the provider's ALIAS/ANAME/flattening). The request arrives with
  `Host: test.com` and the CMS picks the tenant. It needs its own certificate: ACME HTTP-01 (port 80
  inbound) or DNS-01 (which can be delegated with
  `_acme-challenge.test.com CNAME test.com.auth.<your-zone>` so no registrar API key is needed).
- **No per-customer certificate**: register `test-com.<your-zone>` as an alias (`--wildcard
  <your-zone>`) and point the customer at it, or 301 `test.com` to it. One wildcard certificate
  covers every site.
- **`/<your-zone>/sites/<key>/` is a preview, not a URL to sell.** Content links are absolute
  (`/jobs`, `/theme.css`) and cookies are scoped `Path=/portal`, so a site served under a path
  prefix would leak out of the prefix. The route 302s to the tenant's primary host instead.

---

## 2. A theme

### Export

```bash
node --experimental-strip-types app/cli/theme.ts export fractional-works \
  --tenant fractional --out /tmp/fractional-works --now 2026-10-29T00:00:00.000Z
```

Produces the portable package:

```
theme.json   manifest — key, name, version, css sha256+bytes, one entry per asset
theme.css    the sheet with *relative* references: url("assets/inter-latin.woff2")
assets/…     every file the sheet names
```

The stored sheet is the absolute rewrite (`/_theme/<key>/assets/x.woff2?v=<sha8>`); the package is
that rewrite's inverse, so the sheet names no host and no tenant. Measured on the live theme: 7
files out, 5 assets, **0** occurrences of `/_theme/` in the exported CSS.

### Import and activate

```bash
node --experimental-strip-types app/cli/theme.ts import /tmp/fractional-works.zip   # or a directory
node --experimental-strip-types app/cli/theme.ts list --library
node --experimental-strip-types app/cli/theme.ts activate fractional-works --tenant abc123
node --experimental-strip-types app/cli/theme.ts list --tenant abc123
```

- The library is `data/themes/<key>/` — one copy per box. Rendering does **not** read it: activation
  copies rows, blob and files into the tenant through `uploadTheme`, the same function the admin
  upload door uses. So a site keeps working even if the library entry is later removed.
- Activation is idempotent for identical bytes; a key collision with different bytes refuses with
  `SKW_E_EXP_THEME_DIGEST` unless `--replace`, in both the library and the tenant.
- Two shas exist for one theme and they are not interchangeable: the package sheet's (portable) and
  the stored sheet's (absolute). A tenant row holds the stored one.

### Refusals worth knowing

| code | when |
|---|---|
| `SKW_E_EXP_THEME_SCHEMA` | no `theme.json`, or a schema other than `skunkworks/theme/v1` |
| `SKW_E_EXP_THEME_DIGEST` | a file does not match the manifest, or a key collides with different bytes |
| `SKW_E_EXP_THEME_PATH` | absolute path, `..`, backslash, control character, or a type a theme may not carry (`.html`, `.js`) |
| `SKW_E_EXP_THEME_REF` | the sheet names a file the package does not ship, or a tenant names a theme file that is not on disk |
| `SKW_E_EXP_THEME_LIMIT` | 512 KiB sheet, 8 MiB per asset, 32 MiB per package |
| `SKW_E_EXP_THEME_EXTRA` | a file in the package the manifest never declared |

---

## 3. Moving a site to another server

On the source box:

```bash
skw-export … --target cms --archive site.zip
skw-theme export <theme> --tenant <tenant> --out theme/     # only if you want the look on its own
```

On the target (a fresh host): unzip and `./install.sh` — verify, `control.sql`, seed, tenant DB,
`.env`, bootstrap, compose up; `--verify-login` proves a served page.

On an **already-running** box: `skwctl site import site.zip --tenant … --host …`, then
`skw-theme import` + `activate` for any theme the site did not carry, then reload nginx.

The one thing no bundle can carry is reachability: a host only answers if its DNS points at the box
and the box accepts inbound 80/443.
