# Skunkworks — Multi-Tenant Astro CMS

**Status:** Decided / pre-architecture
**Last updated:** 2026-10-20
> **Authority note (2026-10-20):** this file records intent and the decisions made at the time. It is
> no longer the newest word: `docs/sds/SDS.md` + `docs/sds/00-adjudication.md` are authoritative where
> they disagree, and **§13 Amendments** lists every decision that measurement changed.

---

## 1. Original brief

Create an Astro-based CMS with the ability to host multiple domains, either via subdomains or
top-level domains. For instance, `abc.com` (TLD) will be served from the CMS, but we can have a
separate `abc2.com` served out of the same CMS under a different key. We can also have
`test.abc.com`, a third website served out of the same CMS under a different key. Routing is done
by nginx. Websites are served on port 80 or 443, leveraging Let's Encrypt with auto-renewal.

There is a public section and an admin section. In admin, one can perform CRUD through detailed
forms on the CMS DB, and can create/update/delete tables — but tables mandatory for the operation
of the CMS cannot be created/updated/deleted (the data inside them can be altered). Non-secure
data from tables must be callable from the front end.

There should be a drag-and-drop website editor for the publicly exposed websites, but the source
code it generates must be pure HTML/JS and human-editable. Websites can contain multiple pages
using slugs. Pages must be easy to add and remove, and hideable from the UI. There must be
safeguards against flooding and against hacking.

All code must adhere to DRY, SOLID and clean code; Google code style; human-readable. SQLite as
the backend RDBMS with proper normalisation and separation of concerns. The CMS, nginx etc. must
be self-contained in Docker (compose). It must be possible to export an Astro website and all its
data into a new website+CMS containing only that website's data — a self-contained Astro+CMS
instance.

### 1.1 Commercial intent (added 2026-10-20)

- Host **our own company website**.
- Host **demo sites for prospective clients** on subdomains.
- Host **client sites on their own TLDs** (companies we've won).
- If a client likes the design, **sell them the website + CMS**, deploy on their infrastructure,
  running in ~5 minutes without drama.
- If a client likes the design **and wants a static website**, sell them the **static website**
  (HTML + JavaScript + assets, **without the CMS**), deploy on their infrastructure, running in
  ~5 minutes without drama.
- If a client likes the design **and wants an Astro website**, sell them the **Astro website**
  (Astro + assets, **without the CMS**), deploy on their infrastructure, running in ~5 minutes
  without drama.

This makes export/install a **product feature**, not a utility. Three sellable outcomes from one
source of truth — see §5.1 for the capability matrix and the pre-flight checks.

### 1.2 Plugin intent (added 2026-10-20)

- The CMS must support **plugins**: self-contained features that own their implementation, their
  tables and their settings.
- A plugin integrates with the **public UI** — a hand-built page or block calls it (e.g. a contact
  form submits to the contact-form plugin), and the plugin persists what it captures into its own
  tables.
- A plugin hooks into the **admin UI** and may provide its own management forms. Forms are optional:
  some plugins have nothing to administer.
- Plugins must be exportable with the site: a bundle carries the plugin, its schema and its data.
- **Plugins may be written by third parties and built entirely outside our source tree.** They are
  installed into a running CMS, not compiled into it. That makes every plugin untrusted code by
  default, and the containment mechanism is a first-class part of the design, not a policy note.

### 1.3 Asset and digital-goods intent (added 2026-10-20)

- Upload and manage **assets** (images, PDFs, video, audio, archives) in a media library.
- **Link assets into pages** — images, galleries, file links — without hand-writing paths.
- **Download files** served with correct MIME, range support and cache headers.
- **Gatekeep downloadable assets**: a customer buys a PDF book, receives an **access code**, enters
  it in a form, and only then can download the file.

---

## 2. Decisions log

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | **TypeScript on Node 22** for the whole stack | Astro SSR requires Node anyway. One runtime, one toolchain, shared types between renderer and admin API, and the editor ecosystem (GrapesJS, Prettier) is JS. |
| D2 | **One SQLite file per tenant** + a small global `control.db` | Blast-radius isolation, no cross-tenant leak by construction, and export becomes a file copy instead of a filtered-schema nightmare. |
| D3 | **Drizzle ORM for core/CMS tables; Kysely for user-defined tables** | Drizzle owns a static, known schema and gives migrations + types. Kysely handles runtime-introspected, user-created tables that no ORM can know at build time. Shared driver, strict ownership boundary (§6). |
| D4 | **No raw SQL from the browser, ever.** Data reaches templates through named **Data Sources** | §4. The admin never accepts SQL text; templates never see a DB handle. |
| D5 | **Render at request time** from stored HTML/templates; **snapshot to static only on publish/export** | A CMS writes at runtime; Astro builds at build time. Request-time SSR avoids per-tenant build storms. |
| D6 | **GrapesJS embedded** for the DnD editor, **best-effort quality bar** | Building an editor is a 6-month product. GrapesJS is BSD-3 and does drag-drop + layer tree + code view out of the box. |
| D7 | **Host-based tenant routing is primary; per-host HTTP-01 certs, not a wildcard cert** | A wildcard cert needs DNS-01 and registrar API credentials. Per-host HTTP-01 needs nothing but a DNS record pointing at the box. Path-prefix routing (`/demo/<key>`) is the no-DNS fallback (§3.1, measured). |
| D8 | **Protected tables are enforced by name prefix**: core tables are `cms_*`, user tables are `u_*` | Turns "mandatory tables cannot be dropped" into one checkable invariant the DDL runner enforces, instead of a fragile allowlist. |
| D9 | **Admin on a separate origin/port with IP allowlist; no filesystem writes from the DB admin panel** | Runtime DDL is the single largest attack surface. Contain it. |
| D10 | **Sell/deploy via a published container image + tenant bundle**, not source divergence | Keeps one codebase. Export = bundle referencing a pinned image tag. |
| D11 | **Agent orchestration is a build-process concern, not a CMS feature** | "Agents talk to each other" belongs to how we build this, not to what ships. |
| D12 | **No DRM/licensing enforcement in v1** | Ship value; don't build a moat before there's a customer. |
| D13 | **Assets are content-addressed** on disk: `content/media/<sha256[0:2]>/<sha256>.<ext>` | Dedupes identical uploads, makes files immutable and cacheable forever, and removes user-supplied filenames from every filesystem path. |
| D14 | **Gated downloads are authorise-then-offload**: the app validates, then hands off with `X-Accel-Redirect` | Node never streams multi-hundred-MB PDFs through JS. nginx does the byte-shuffling, with range support, while the app stays the authorisation point. |
| D15 | **Access codes are stored argon2id-hashed, never plaintext, never in a URL** | Codes are bearer secrets. Plaintext in the DB or a query string (Referer/log leakage) turns a paid asset into a free one. |
| D16 | **The CMS is not a storefront.** Payment stays external; the CMS only issues/redeems codes | Carts, tax, refunds and chargebacks are a different product. A signed webhook covers every store that can POST. |
| D17 | **Asset identity is the `key`; the checksum is only the physical address** | Users pick, name and reference assets by key (`banner-home`). Content stores keys, never paths, never hashes. Renaming a key cascades to references; the bytes never move. |
| D18 | **nginx serves public assets from a symlink farm** `content/public/<key>.<ext> → media/<hh>/<sha256>.<ext>` | Keeps Node out of the image hot path, gives humans a readable URL, and makes gated assets structurally absent from the public tree rather than merely permission-checked. |
| D19 | **`max_uses` is a CMS-managed field**, not a constant: tenant default in `cms_settings`, overridable per issue (form, bulk CSV, webhook) | Buyers lose downloads and issuers know their own risk appetite per product. Enforcement stays atomic in a single UPDATE, so a mutable cap can't be raced by concurrent requests. |
| D20 | **Watermarking is a CMS-managed field**: upload a watermark asset, select it per asset/bundle (tenant default as fallback), and a text template renders per purchaser | A static logo deters nobody; the purchaser's own details do. Measured 51.9 ms cold / 23.4 ms warm to stamp a 40-page PDF, so on-the-fly stamping is affordable. |
| D21 | **Every site we build is authored for the editor** — same HTML, same component vocabulary GrapesJS emits, one CSS layer, and an empty-diff round-trip as a gate | "DnD works on day one" is a property of how the markup is written. No editor can retrofit drag-and-drop onto arbitrary hand-rolled HTML. |
| D22 | **Export target is a render mode, not a fork**: CMS bundle, Astro project, or static HTML/JS, all generated from the same pages + assets | Three SKUs, one content model. A fork would mean the fourth client's bug never reaches the first. |
| D23 | **Watermark text is sanitised to cp1252, not flattened to ASCII** — preserve everything WinAnsi can render; transliterate common symbols; `?` for the rest | Measured: pdf-lib's WinAnsi accepts the full cp1252 set (€ “ – … ¥ £ © ° ÷ all encode). Stripping accents would have mangled `München` and `Øyvind` for no reason. Only CJK/emoji-class characters actually fail. |
| D24 | **Astro export ships a runnable, editable project** (not pre-built SSG with source stripped) | The client bought the code, so they get the code. Stripped source would turn every future change into a rebuild request to us. |
| D25 | **Plugins are a first-class extension surface**, not a folder of scripts: a manifest, owned tables, declared admin forms, declared public endpoints | One contract means a plugin is installable, exportable, disableable and auditable in the same way everywhere. The contract's details are being decided by the debate (§12). |
| D26 | **Third-party plugins are supported, so plugins are untrusted by default** — loaded at runtime from outside the source tree, contained, and granted capabilities through a declared contract | First-party trust would make the plugin system a marketing claim rather than a feature. The moment someone else's code runs inside the CMS, containment stops being optional, and the design must show the boundary rather than assert it. |
| D27 | **No publisher CA in v1.** First-party plugins are signed with a key baked into the image and verify automatically; third-party plugins require the tenant owner to import the publisher's public key (fingerprint shown) before enable | Running a CA means vouching for someone else's code and carrying the liability when it misbehaves. Importing a key is a trust decision the tenant makes, visibly, and it costs us no support economics. Reversible if we ever want to publish plugins ourselves. |
| D28 | **CSRF header is frozen as `X-CSRF-Token`** — one header, no form-field alternative | Two accepted CSRF paths is two ways to get it wrong, and a form field survives in the HTML an editor can rewrite. |
| D29 | **Fleet console lives at `/admin` on the admin host; tenant-scoped URLs are `/admin/t/<key>/…`; login is `/admin/login`** | §9.2 requires the tenant in the path for tenant routes, which leaves no address for "choose a tenant". One non-tenant URL fixes it without a second session model. |
| D30 | **First-run bootstrap is `skwctl admin bootstrap`**, printing a one-time TOTP URI + password to a 0600 file; **the 5-minute install now includes one human step** | A TOTP-mandatory bundle with no enrolment path is a product nobody can log into. The promise stays ~5 min; the wording must admit the scan step rather than the docs quietly omitting it. |

---

## 3. Architecture

```
                        ┌──────────────────────────────┐
   :80 :443  ──────────►│ nginx-proxy  + acme-companion│  (TLS, Host→upstream)
                        └──────────────┬───────────────┘
                                       │  Host header
                        ┌──────────────▼───────────────┐
                        │  app (single Node process)    │
                        │  ├ Fastify  → /admin, /api    │  separate vhost/origin
                        │  └ Astro SSR → public render  │  (mounted in middleware mode)
                        └──────────────┬───────────────┘
                                       │
              ┌────────────────────────┼────────────────────────┐
              │                        │                        │
      control.db (global)      tenants/<key>/site.db      tenants/<key>/content
      tenants, domains,        cms_* (Drizzle)            pages HTML
      users, sessions,         u_*   (Kysely)             media/<sha256>
      audit_log                cms_datasource             sources/*.js
```

Request lifecycle: `Host` → tenant lookup in `control.db` (cached in memory with a version
stamp) → resolve page slug → render through Astro SSR with a **read-only** connection to that
tenant's `site.db`.

Services in `docker-compose.yml`: `nginx`, `app`, `acme`. Nothing else.

### 3.1 Tenant resolution (measured, nginx 1.31.7 + echo upstream, 2026-10-20)

Resolution order: **(1)** `X-Skunkworks-Tenant` injected by nginx → **(2)** exact `Host` match in
`control.db` → **(3)** `/demo/<key>` path prefix.

| Pattern | Request | What the app received |
|---|---|---|
| Host proxy, no rewrite | `Host: demo.abc.com`, `GET /pricing?plan=pro` | `path=/pricing?plan=pro`, `host=demo.abc.com`, `tenant=acme` |
| Path prefix, stripped (`proxy_pass http://up/`) | `GET /demo/acme/pricing` | `path=/pricing`, `tenant=acme` |
| Path prefix, retained | `GET /demo/beta/pricing` | `path=/demo/beta/pricing`, `tenant=beta` |
| Path prefix, no trailing slash | `GET /demo/acme` | `301` (nginx appends the slash) |
| Name-based redirect | `Host: demo.abc.com`, `GET /pricing?plan=pro` | `301` → target composed from `$request_uri` |

**Reading of the evidence:**

- **Header/host proxy preserves the URI exactly.** No path rewriting, so no `base`-path bugs and no
  asset-URL prefixing. This is the primary route.
- **Prefix stripping works but is a trap**: the app receives `/pricing` while the browser says
  `/demo/acme/pricing`. Everything the app emits must be prefixed from `X-Forwarded-Prefix`, and
  Astro's `base` is build-time config — it cannot be per-request. Use a URL helper, never `base`.
- A 301 was observed for the redirect pattern, but **the `Location` header line was not captured**
  in the run (the follow-up probe failed). `$request_uri` is the full original URI including query,
  so the target is `https://abc.com/demo/acme/pricing?plan=pro` — re-verify before relying on it.
- **Cert consequence:** per-host HTTP-01 certs need only DNS. A wildcard cert needs DNS-01 plus
  registrar API credentials — that is the only thing that made wildcards look hard. Let's Encrypt
  allows 50 certs per registered domain per week, which is far more than a sales pipeline of demos.
- **Cookie consequence:** path-based demos share the parent origin, so every session cookie must be
  `__Host-` prefixed and path-scoped. Subdomain demos get domain scoping for free.

---

## 4. Data Sources — how non-secure data reaches the front end

The brief's "non-secure data from tables should be callable from the front-end" is implemented as
a **registry of named, read-only Data Sources**. Raw SQL is never stored as text and never
accepted from a browser.

**Registry** (`cms_datasource` in each tenant DB):

```
id | key | kind | spec_json | is_public | ttl_s | created_at
```

**Kinds:**

1. **`view`** — points at a SQLite view (e.g. `v_public_posts`). No parameters. The view *is* the
   contract: columns are the exposed surface, and the DB enforces the projection.
2. **`query`** — a declarative spec, compiled server-side into a parameterised statement:
   ```json
   {
     "table": "u_posts",
     "columns": ["slug", "title", "published_at", "cover_asset"],
     "where": [{ "col": "status", "op": "=", "param": "status" }],
     "order": [{ "col": "published_at", "dir": "desc" }],
     "limit_default": 10,
     "limit_max": 50
   }
   ```
   No free-form SQL. Operators are an enumerated set. Values are always bound parameters.
   `limit` is clamped to `limit_max`. Columns typed `asset` are resolved to asset URLs at render
   (§7.3), never stored as paths.
3. **`function`** — a trusted JS module in `tenants/<key>/content/sources/` for aggregates and
   joins too complex to express as a spec. **Cannot be created from the admin UI** — it is a
   developer-authored file that ships with the tenant. Runs in-process against a read-only handle.

**Consumption in templates:**

```astro
---
const posts = await site.source('posts', { status: 'published', limit: 3 });
---
{posts.map(p => <article><h2>{p.title}</h2></article>)}
```

- Astro: available as `Astro.locals.site.source(...)`.
- React/Vue islands: **data is resolved at SSR and passed in as props.** Islands never talk to the
  database. (If a client-side fetch is ever needed, it goes through a `/__data/<key>` endpoint that
  applies the same allowlist and rate limits.)

**Enforcement (defence in depth):**

- Render path uses a `{ readonly: true }` connection — it physically cannot write.
- `is_public = false` (the default) → resolver throws. Publishing a source is an explicit, audited
  admin action.
- Column allowlist applied server-side; unknown params rejected; no string interpolation into SQL.
- Per-source TTL cache to absorb traffic spikes; per-tenant request budget at nginx.

---

## 5. Tenant, demo, and resale model

**Tenant kinds** (`mode` on the tenant record):

| Mode | Hosting | Behaviour |
|------|---------|-----------|
| `production` | Client TLD or `www.company.com` | Full features, per-host Let's Encrypt cert (HTTP-01). |
| `demo` | `<client>.demos.company.com` — per-host HTTP-01 cert; or `company.com/demo/<client>` when DNS/ACME is unavailable | `X-Robots-Tag: noindex`, watermark banner, storage cap, TTL auto-expiry, read-mostly. |
| `internal` | Our own site | Normal. |

A demo created as a path prefix needs **no DNS and no cert** — it is a tenant row plus an nginx
`location`. A demo created as a subdomain needs one DNS `A` record and gets its cert automatically.

**Export → install (the 5-minute promise):**

Export produces `site-bundle.tar.gz` containing:
`docker-compose.yml` (pinned image tag) · `.env` (generated secrets, domain, ACME email) ·
`data/site.db` (that tenant's file, nothing else) · `content/` (built HTML, `media/`, `sources/`) ·
`install.sh`.

Install on a fresh host: `tar xf && ./install.sh && docker compose up -d` → DNS check, cert
issued, tenant marked active. Target **< 5 minutes**, measured, not asserted.

Because the DB is per-tenant and user tables live in that same file, export has **nothing to
filter** — this is why D2 matters. Because media is content-addressed and referenced by checksum
rather than by path, the bundle is self-contained and provably complete (§7.1).

### 5.1 Three export targets (one source of truth)

Everything a client can buy is generated from the same `cms_pages` rows, the same assets and the
same component registry. The exporter is a **render mode** (D22) — never a hand-maintained fork.

| Capability | CMS bundle | Astro project | Static HTML/JS |
|---|---|---|---|
| Pages, slugs, nav | live DB | generated `.astro` + content files | rendered `.html` |
| Data Sources | live queries | **snapshotted** to JSON at export | snapshotted to JSON |
| DnD editor + admin | yes | no — the client edits code | no |
| Forms | stored submissions | post to a configured external endpoint | same |
| Gated downloads | yes | **no** | **no** |
| Watermarking | yes | n/a | n/a |
| Runtime on client box | node + sqlite (docker compose) | `npm ci && npm run build`, then SSG or node | none — copy files |
| Target install time | **≤ 5 min** (measured) | ≤ 3 min | ≤ 1 min |

**What each bundle contains**

- **CMS bundle** — `docker-compose.yml` (pinned image), `.env`, `data/site.db`, `content/`,
  `install.sh`. Full features.
- **Astro project (runnable + editable, D24)** — `package.json`, `astro.config.mjs`,
  `src/pages/*.astro` generated from stored pages, `src/content/*.json` snapshots of every public
  Data Source, `public/` with assets, `src/components/` for islands, plus a README with the exact
  deploy commands. It builds and runs on the client's box as-is, and they can open `src/` and edit
  it. Islands carry their own React/Vue dependencies. No DB, no admin.
- **Static site** — exactly the D5 publish snapshot: `index.html`, per-slug directories, `assets/`,
  `robots.txt`, `sitemap.xml`. Reproducible: the same DB state must produce identical bytes.

**Pre-flight checks — the exporter refuses rather than lying**

Before writing any bundle it inspects what the site actually uses and reports:

1. **Gated assets present → static and Astro exports are refused**, with the offending asset keys
   named. A "download after payment" page with no CMS behind it is a broken promise, not a feature.
2. **Forms** → the operator must supply an external `action` URL, or the form is emitted disabled
   with a comment in the markup. Never a silently dead form.
3. **Parameterised Data Sources cannot be snapshotted faithfully** — they vary per request. The
   export freezes them at their default parameters, states the row count frozen, and lists each one
   in `EXPORT-NOTES.md`. Silent truncation is how a client discovers a bug in production.
4. **Islands** are copied with their dependencies and their hydration directives intact; an island
   that depends on request data is flagged in the same notes file.

---

## 6. Schema ownership invariant

| Owner | Tables | Rules |
|-------|--------|-------|
| **Drizzle** (`control.db`) | `tenants`, `domains`, `users`, `sessions`, `audit_log`, `deploy_tokens` | Global, never exported. Migration-only changes. |
| **Drizzle** (`site.db`) | `cms_pages`, `cms_page_blocks`, `cms_settings`, `cms_nav`, `cms_forms`, `cms_form_submissions`, `cms_datasource`, `cms_table_registry`, `cms_asset`, `cms_asset_variant`, `cms_asset_link`, `cms_asset_bundle`, `cms_download_code`, `cms_download_event`, `cms_watermark_render` | Protected: the DDL runner refuses `CREATE`/`ALTER`/`DROP`. **Row data is editable through the CRUD forms**, as the brief requires. |
| **Kysely** (`site.db`) | all `u_*` tables | Created/altered/dropped by the admin table builder, through a transactional DDL runner. Introspected at runtime; types regenerated on change. |

Enforcement:
- The DDL runner accepts only identifiers matching `^u_[a-z0-9_]+$`.
- No `ATTACH`, no `PRAGMA writable_schema`, no trigger creation from the UI in v1.
- Every DDL statement is recorded in `cms_table_registry` + `audit_log` in the same transaction.
- The Kysely handle for `u_*` tables is **not exported outside the module that owns user data**;
  a lint rule enforces it so nothing accidentally queries core tables through the untyped path.

---

## 7. Assets, media library and gated downloads

### 7.1 Storage

`content/media/<sha256[0:2]>/<sha256>.<ext>` — **content-addressed** (D13). Immutable, deduped,
safe to serve `Cache-Control: immutable, max-age=31536000`. The original is never mutated;
renditions are derived separately. No user-supplied filename ever reaches the filesystem, so
path-traversal and `..%2f` games have nothing to attack.

**Identity vs address.** The checksum is storage, not identity. A separate human handle
(`cms_asset.key`) is what content references — see §7.3. Several asset rows may share one sha256
(the same logo uploaded as `logo-dark` and `logo-dark-alt`), but nothing in a page, a datasource or
a user table ever holds a checksum or a filesystem path.

**Tables:**

| Table | Columns (essential) |
|---|---|
| `cms_asset` | `key` (stable slug), `filename`, `mime`, `bytes`, `sha256`, `kind` (image/video/audio/document/archive), `storage_path`, `width`, `height`, `alt_text`, `caption`, `is_public`, `created_at` |
| `cms_asset_variant` | `asset_id`, `label` (thumb/md/lg/og), `format` (webp/avif/jpg), `width`, `height`, `sha256`, `path` |
| `cms_asset_link` | `asset_id`, `owner_kind` (page_block/datasource/setting), `owner_id` — the usage graph |
| `cms_asset_bundle` | `key`, `title`, `asset_id` rows for selling sets (book + worksheets) |
| `cms_download_code` | `code_hash` (argon2id), `asset_id` **or** `bundle_id`, `max_uses`, `uses`, `expires_at`, `issued_to_email`, `order_ref`, `revoked_at`, `created_at` |
| `cms_download_event` | `code_id`, `asset_id`, `ip_hash`, `ua_hash`, `bytes_sent`, `ranged`, `ts` |

`cms_asset_link` is what makes deletion safe: delete is refused while links exist, and orphan
sweeping is an explicit, reported operation — never a background surprise.

### 7.2 Three access classes

| Class | Reachable by | Served by |
|---|---|---|
| **public** | anyone, `/media/<key>` | nginx directly (`internal` alias, `X-Accel-Redirect`) |
| **linked-private** | admin / preview session | app |
| **gated** | holder of a redeemed code + short-lived token | app authorises → nginx streams (`X-Accel-Redirect`, D14) |

### 7.3 Using assets in pages — identity is the key, not the hash

Yes: the DB holds the human name and the checksum side by side, and content stores **only the
human name**.

```
cms_asset
  id            1
  key           banner-home            ← the only thing any content ever stores
  filename      Banner_Home_FINAL.png  ← what the user uploaded
  alt_text      Team in the workshop   ← content, and required for images
  sha256        ab12cd…                ← physical address, internal only
  storage_path  media/ab/ab12cd….webp
```

- **Page block:** `asset_key = 'banner-home'`.
- **User table column of type `asset`:** stores the string `banner-home` — legible when you open the
  row, exactly as you asked. Real referential integrity comes free: SQLite enforces the FK to
  `cms_asset(key)` (`ON UPDATE CASCADE`, `ON DELETE RESTRICT`) regardless of whether Drizzle or
  Kysely created the table, so you cannot orphan a cover image or delete one that is in use.
- **Keys** are unique slugs derived from the filename (`hero`, `hero-2`), optionally namespaced
  (`products/book-cover`). Renaming an asset's display name leaves the key untouched; changing the
  key cascades to every reference, and writes an alias row so an old hand-edited `/media/old-key`
  URL still 301s.
- **Public URL** is `/media/banner-home.webp?v=ab12cd` — readable, cacheable, and safe to pin
  `immutable` because `?v=` changes whenever the bytes do. Content never stores this string;
  `site.asset('banner-home')` returns `{ url, srcset, width, height, alt }` and the URL exists only
  in rendered output.

**How nginx serves it without touching Node:** `content/public/banner-home.webp` is a symlink to
`content/media/ab/ab12cd….webp`, regenerated on create/rename/delete. nginx serves `/media/` from
that directory with `try_files`, so images and PDFs never cost a Node request. Gated assets get
**no symlink at all** — they are absent from the public tree by construction, which is a stronger
guarantee than any permission check.

**Duplicate uploads:** the same sha256 uploaded twice dedupes at storage and prompts "this file
already exists as `banner-home` — reuse it?". If the user insists on a separate entry, a second
`cms_asset` row shares the same bytes and renditions; only identity is duplicated, never storage.

**Picking assets in admin:** a media library with a thumbnail grid, search across key / filename /
alt text / kind, and a picker that writes the key — never a path. Editor blocks (image, gallery,
download button) all go through the same picker.

**In Data Sources:** an `asset` column resolves to the same `{ url, srcset, width, height, alt }`
shape, so `u_products.cover` works identically to a page block. **Nobody hand-writes a path** — the
resolver owns URLs, which is what keeps exports portable and lets the CDN story change without
touching content.

### 7.4 Gated download flow

1. `GET /d/<asset-key>` → page with one input box: the access code (plus optional email for
   receipt matching).
2. `POST /d/<asset-key>` → verify. Rate limit 5 attempts / 15 min per IP **and** per code hash;
   argon2id compare; on an unknown code perform a dummy compare so response time does not leak
   existence; one uniform error message.
3. On success, mint an HMAC token: 10-minute TTL, bound to `code_id` + `asset_id` + IP/UA hash.
   Deliver as `Set-Cookie: __Host-dl-<key>=…; HttpOnly; Secure; SameSite=Lax; Path=/d/<key>`.
4. `GET /d/<asset-key>/file` → validate token → atomic consume:
   `UPDATE cms_download_code SET uses = uses + 1 WHERE id = ? AND uses < max_uses AND revoked_at IS NULL`
   (0 rows changed = deny) → `X-Accel-Redirect: /__protected/<sha256>.<ext>` → nginx streams with
   `Range` support and `Content-Disposition: attachment; filename="<original name>"`.
5. Append `cms_download_event`. Admin sees redemptions, bytes sent and per-code usage.

**`max_uses` is configurable** (§7.6) — tenant default with a per-issue override, and `NULL` meaning
unlimited behind an explicit flag. The consume statement covers both cases atomically:

```sql
UPDATE cms_download_code
   SET uses = uses + 1
 WHERE id = ?
   AND revoked_at IS NULL
   AND (max_uses IS NULL OR uses < max_uses);
```

Raising the cap after issue is allowed. Lowering it below `uses` blocks further downloads
immediately — that is the cheap "revoke-lite" behaviour — and both edits are audited with actor and
before/after values.

Rules that are not negotiable:
- Codes are generated server-side, 12 characters, Crockford base32 (no `I/L/O/U`), ~60 bits — shown
  **once** at issue, never again, never logged, never recoverable.
- Codes are never accepted in a query string (Referer and access-log leakage) and never emailed as
  a clickable link — the email contains the code and a link to the *form*, not to the file.
- `/__protected/` is an nginx `internal` location: a direct hit is a 404 even if someone guesses the
  checksum path.
- Token is per-asset and short-lived, so a leaked token buys one file for ten minutes, not a
  library.

### 7.5 Upload hardening

Sniff the real type from magic bytes and reject mismatches; re-encode images through sharp (kills
polyglot payloads and strips EXIF, including GPS); reject SVG in v1 rather than sanitise it;
archives and executables are never public; per-tenant size caps and a per-tenant byte quota;
uploaded files never land in the app's module graph or an executable path.

### 7.6 Where codes come from, and what is settable

Codes are generated in admin — singly, or bulk (CSV) against an order list — plus one signed
webhook, `POST /api/hooks/<tenant>/issue-code`, that any store can call: Stripe Payment Link →
webhook → code generated and emailed to the purchaser. Cart, tax, refunds and chargebacks stay out
of the CMS (D16); refunding a purchase means revoking a code, which is one admin action.

**`max_uses` resolution order:** per-issue value → tenant default
(`cms_settings.download.default_max_uses`, shipped as **3**) → never hard-coded. Settable at issue
time through every channel:

| Channel | Fields |
|---|---|
| Admin, single issue | asset or bundle, email (optional), **`max_uses`**, `expires_at` (optional) |
| Bulk CSV | `email, asset_key, max_uses, expires_at` — blank `max_uses` uses the tenant default |
| Webhook | same fields, HMAC-signed; omitted `max_uses` uses the tenant default |

Validation: integer `1..100`, or `NULL` for unlimited. Unlimited is behind an explicit toggle that
is off by default, requires a confirmation ("this code is effectively shareable"), and is labelled
as such in the code list so nobody wonders later why a file circulated.

**Editable after issue:** `max_uses`, `expires_at`, revoke. **Immutable:** the code itself — it is
only ever stored as an argon2id hash, so it cannot be re-displayed; the remedy is reissue, which
revokes the old one and mints a replacement. Every mutation writes an audit row with actor and
before/after.

### 7.7 Bandwidth

nginx `limit_conn` / `limit_rate` per tenant; large-file downloads are the one place a cheap box
falls over, so `Range` is enabled, public assets are cacheable and immutable, and per-tenant byte
caps are enforced at the edge rather than discovered by an invoice.

### 7.8 Watermarking — a CMS-managed field

**Measured** before designing it (Node 22, `pdf-lib` + `sharp`; 40-page / 32 KB PDF; 3.9 KB watermark
PNG; every page stamped with the logo image, a 45° "DO NOT DISTRIBUTE", and a per-purchaser footer):

| Operation | Observed |
|---|---|
| Stamp all 40 pages, cold (embeds PNG + font) | **51.9 ms** |
| Stamp all 40 pages, warm | **23.4 ms** |
| Output size | 32,782 → 52,432 B (+60%) |
| Two purchasers → identical bytes? | **No** — per-purchaser text forks the output |
| `café@example.com` (Latin-1) | OK |
| `buyer@例え.jp` | **throws** `WinAnsi cannot encode "例" (0x4f8b)` |
| `buyer😀@example.com` | **throws** `WinAnsi cannot encode "" (0x1f600)` |

Three consequences that shape the design:

1. **On-the-fly stamping is affordable** — ~1.3 ms/page. A cache is an optimisation, not a
   requirement, but keep it: a 400-page PDF is 10× that, and a paid download should never be 10×
   anything.
2. **The cache key must include the rendered spec**, because the bytes genuinely differ per
   purchaser: `content/protected/wm/<spec_sha>/<asset_sha>.<ext>`, recorded in
   `cms_watermark_render` for quota accounting. A *static* watermark (no per-user variables)
   collapses to a single shared copy — effectively free.
3. **Built-in PDF fonts cannot encode non-Latin text — but the limit is cp1252, not ASCII.** Probing
   the encoder directly (`€ “ ” – … ¥ £ © ° ÷`) showed **every one encodes fine**, so accents and
   typographic punctuation must be *preserved*, not transliterated: `München` stays `München`,
   `Øyvind Ærø` stays intact. Only characters outside cp1252 (CJK, emoji, Cyrillic, Greek, Arabic)
   need handling, and they get a small transliteration table (`→` → `->`, `✓` → `[ok]`) or `?`.

   Policy: **sanitise to cp1252, preserving fidelity** (D23). `buyer@例え.jp` becomes `buyer@??.jp`,
   not `buyer@??.jp` with `München` collateral damage. The sanitiser's own test asserts every output
   character is genuinely cp1252-representable, so a future font change can't silently regress it.

   Attribution survives mangling because `order_ref` and `code_id` are ASCII by construction — the
   footer always carries one, so a lost email still identifies the buyer. A customer's name must
   never crash a paid download, and it never does: the fallback is `?`, not an exception.

**Configuration is CMS-managed, two levels** (same hierarchy as `max_uses`):

- `cms_asset.watermark_asset_id` → FK to another `cms_asset` of kind `image`, `role = watermark`.
  Uploaded through the media library, chosen in a dropdown on the asset form.
- Per-asset value overrides the tenant default
  (`cms_settings.download.default_watermark_asset`).
- `cms_asset.watermark_spec_json`:
  ```json
  { "position": "center|tile|corner|bottom-band",
    "opacity": 0.25, "scale": 0.5, "rotation": 0,
    "pages": "all|first|last",
    "text_template": "licensed to {email} / order {order_ref}",
    "text_font_asset": null,
    "sanitize": "cp1252" }
  ```

**The text template is what makes it per-purchaser rather than decoration.** Variables resolve from
the code row (`email`, `order_ref`, `issued_at`) — never from the request, so a buyer cannot rename
their copy mid-download.

**Fail policy: fail closed.** Corrupt PDF or unencodable text denies the download, logs an event and
alerts the tenant admin. Silently serving an unwatermarked paid asset is worse than a support
ticket, and the admin list surfaces the denial so the operator finds it, not the customer.

**Format coverage, honestly:** PDF via `pdf-lib` (drawn into the content stream — not a separate
removable layer); images via `sharp` composite; ZIP bundles get a generated `LICENSE.txt` receipt
inside the archive; **video and audio are not watermarked in v1**, and the issue screen warns when
the selected asset cannot be stamped.

**This is not DRM.** A determined buyer can crop or re-typeset it. It is attribution and
deterrence — price and describe it as such.

---

## 8. DnD editor (best effort)

### 8.1 Authored for the editor, always (D21)

Any site we build must open in the editor and be fully drag-and-droppable on day one. That is a
property of how the markup is written, so it is a build rule, not a feature request:

- **Page bodies live in the same format the editor emits** — HTML plus one stylesheet. Astro owns
  the shell (head, meta, layout, data sources); it does not own the page body.
- **One registry entry per block, three parts:** GrapesJS block definition + component type,
  server-side renderer/validator, and its CSS in `components.css`. One file per component, one
  registration point, so the editor and hand-authoring cannot drift apart.
- **CSS is component classes + design tokens** (`.sk-hero__title`), not utility soup. A
  Tailwind-classed body round-trips badly through GrapesJS; Tailwind stays in the admin UI.
- **Islands are locked components:** `data-gjs-type="island"`, internals non-droppable, editable
  only through the settings panel.
- **The gate:** `roundtrip.test.ts` loads every page of the fixture site into the editor model,
  saves without touching anything, and diffs the output. Acceptance is an **empty diff**
  (whitespace-normalised). A page that cannot round-trip is not shippable.

### 8.2 The editor itself

- GrapesJS embedded in the admin, blocks mapped to the site's component set (hero, prose, image,
  gallery, download button, CTA, form, embed).
- Output: HTML + scoped CSS per page, normalised through Prettier and a fixed reset so the markup
  is genuinely human-editable.
- Explicitly **not** guaranteed: pixel-perfect output for arbitrary block compositions, responsive
  breakpoint fidelity, or lossless round-trip of hand-edited HTML back into the canvas.
- Hand-edited HTML always wins — the canvas renders whatever is stored.
- Data Source bindings are inserted as placeholders (`<div data-source="posts" data-limit="3">`)
  and resolved at SSR, so generated HTML stays static and readable.

---

## 9. Security posture

| Layer | Control |
|-------|---------|
| Edge | nginx `limit_req` per IP + per tenant, request size caps, `limit_conn` on downloads, CrowdSec for repeat offenders |
| Admin | Separate origin/port, IP allowlist, argon2id, session rotation on privilege change, CSRF tokens, CSP |
| DDL | `u_*`-only, transactional, audited, no ATTACH/writable_schema/triggers |
| Data sources | Read-only connection, explicit `is_public`, column allowlist, bound params, TTL cache |
| Assets | Content-addressed paths, magic-byte sniffing, re-encode images, EXIF stripped, SVG rejected, per-tenant quota |
| Gated downloads | argon2id code hashes, rate-limited attempts, timing-equalised verification, 10-min HMAC token, atomic use-count, `X-Accel-Redirect` offload, `internal`-only protected path, every redemption logged |
| Watermarks | Uploaded asset only (never public), per-purchaser text sourced from the code row not the request, drawn into the content stream rather than a removable layer, render cache keyed on the rendered spec, fail-closed on error |
| Tenancy | One DB per tenant; no cross-tenant query path exists by construction |
| Certs | acme-companion, per-host HTTP-01; on-demand TLS gated behind an `ask` endpoint so nobody can force cert issuance for arbitrary hosts |

---

## 10. Delivery slices

| Slice | Contents | Est. |
|-------|----------|------|
| **S1 — Hosting core** | Astro SSR shell, tenant resolution (host + path prefix), control.db, nginx + acme, compose, one hand-built page rendering | 2 wk |
| **S2 — Admin + data plane** | Auth, CRUD forms for `cms_*`, table builder + DDL runner for `u_*`, Data Source registry + resolver, read-only render connection | 2–3 wk |
| **S3 — Assets + gated downloads** | Content-addressed storage, media library, renditions, link graph, `site.asset()`, public download path, code issuance/redemption, token flow, `X-Accel-Redirect` offload, watermark spec + render cache + fail-closed policy | 2–2.5 wk |
| **S4 — Editor + export** | GrapesJS integration, shared block registry, page/slug management, block→HTML normalisation, `roundtrip.test.ts` empty-diff gate, three exporters (CMS bundle / Astro project / static) with pre-flight checks, `install.sh`, measured install-time proofs | 3.5–4.5 wk |

S1 is demoable on its own. S2 is where the security work lives. S3 is the commercially interesting
slice — it is what turns a website into a product you can sell. S4 is where scope creep lives; it
ships best-effort and gets iterated after the first client uses it.

---

## 11. Open questions (to resolve in the SDS)

1. Static snapshot on publish — export-only, or also a CDN-cacheable static mode for production
   sites? (Leaning: export-only in v1.)
2. Form submissions — stored in `cms_form_submissions` per tenant, or emailed out with storage as
   a fallback? (Spam handling differs.)
3. Media — filesystem volume per tenant, or SQLite BLOB for single-file portability? (Decided:
   filesystem volume; content-addressed, tarred into the bundle. Revisit only if a client wants a
   single-file backup.)
4. Does the exported instance include the full admin, or a reduced "client can edit content but
   not schema" mode? (Leaning: full admin, with schema editing off unless enabled in `.env`.)
5. Per-tenant resource ceilings (disk, request rate, download bandwidth) — enforced at nginx or
   in-app? (Leaning: nginx for bandwidth and rate, in-app for the byte quota so the admin can
   report on it.)
6. ~~Per-purchaser watermarking of gated PDFs — v1 says no?~~ **Resolved 2026-10-20:** watermarking
   is CMS-managed (D20, §7.8) — uploaded watermark asset, selectable per asset, per-purchaser text
   template, fail-closed. **Sanitising resolved 2026-10-20: cp1252-preserving (D23), no TTF in v1.**
   TTF embedding stays a reserved field (`text_font_asset`) if a client ever needs CJK attribution.
7. ~~Codes: single-use by default, or `max_uses` configurable per issue?~~ **Resolved 2026-10-20:**
   settable in the CMS (D19, §7.6) — tenant default 3, per-issue override, `NULL` = unlimited behind
   an explicit flag.
8. Is there any case where the CMS must take payment directly, or is every purchase external for
   the foreseeable future? (Leaning: external, D16.)
9. ~~Astro export shape — runnable project or pre-built SSG with source stripped?~~ **Resolved
   2026-10-20: runnable, editable project (D24).** SSG output is whatever `npm run build` produces on
   their box; we do not pre-build it for them.

---

## 12. Plugins (requirement added 2026-10-20 — design pending)

Numbered last because it arrived last. The Architect folds it into §6 (schema ownership), §8
(admin surface), §9 (security) and §10 (slices) in the SDS rather than leaving it an appendix.

**What is fixed:**
- A plugin owns its implementation, its tables, and its settings.
- Public UI integration: a page, block or island calls the plugin; the plugin persists what it
  captures. The page never gets a database handle (§4).
- Admin integration: the plugin appears in the admin UI and *may* ship management forms.
- Export: the plugin travels with the site — code, schema, settings, data.

**Constraint fixed by the CEO on 2026-10-20:** a plugin may be authored by a third party and built
outside this repository. It is installed into a running instance. Every plugin is therefore
untrusted code, and §12.6, §12.7 and §12.11 below are no longer open questions about *whether* —
only about *which mechanism*, at what cost.

**What the debate must settle (seeded, not decided):**

1. **Table ownership and naming.** `cms_*` is protected core, `u_*` is user-created. Plugin tables
   need a third class — presumably `p_<plugin>_*` — that the DDL runner protects, the plugin's own
   migrations own, and export includes. Who may alter a plugin table: the plugin migration only, or
   the user via the table builder?
2. **Migration ownership.** Plugins must ship forward-only migrations that run on install and on
   upgrade, idempotently, inside the same transaction discipline as core migrations. What happens
   when a plugin is downgraded, or when its migration conflicts with a `u_*` table the user already
   built at the same name?
3. **The contract shape.** A manifest (`plugin.json`): id, version, CMS version range, declared
   tables, declared settings schema, declared admin routes/forms, declared public endpoints,
   declared capabilities. What is *not* in the manifest cannot be done at runtime.
4. **Admin UI extension — declarative or code?** Declarative form/table schemas keep the admin
   consistent and make plugins renderable without shipping React; code gives flexibility and puts
   unreviewed UI in the admin origin. Pick one, or pick declarative-with-an-escape-hatch and say
   what the hatch costs.
5. **Public endpoint security.** A plugin's public route is internet-exposed by definition: CSRF,
   rate limiting, honeypot/Turnstile-style spam control, payload caps, and per-tenant quotas. A
   contact form is the most attacked surface in any CMS.
6. **Trust model.** Are plugins only first-party (we write them, they run in-process with full
   privileges), or can a client install a third-party plugin? Node has no cheap sandbox; a
   `vm`/worker boundary changes the whole runtime shape. Decide explicitly — "we'll be careful" is
   not a trust model.
7. **Capability scoping.** A plugin needs its own tables; does it get a handle that can only reach
   them? Given round 1's finding that a readonly handle `ATTACH`es anything, "restricted handle" is
   a claim that needs a mechanism, not a wish.
8. **Disable vs uninstall.** Disabling must not lose data; uninstalling must state whether data is
   dropped, archived to a bundle, or left orphaned. Defaults matter more than options.
9. **Export semantics across the three SKUs.** A CMS bundle carries plugin code + tables + data. An
   Astro or static export has no database — so a plugin must declare how it degrades: a contact form
   can post to an external endpoint; a gated download cannot exist at all. Same pre-flight refusal
   discipline as §5.1.
10. **Version compatibility.** Plugin × CMS version matrix, and what the CMS does at boot when a
    plugin demands a version it does not have: refuse to start, or run degraded?
11. **Where plugin code lives.** Fixed by D26: runtime-loaded from a plugin directory, not compiled
    into the image. What remains open is discovery, dependency resolution (a plugin's own
    `node_modules` must not poison the host's), and boot behaviour when a plugin fails to load.
12. **Supply chain.** Package format, publisher identity, signature verification at install,
    CMS-version compatibility refusal, revocation, and what the admin UI shows a non-developer
    before they enable somebody else's code. **Trust root fixed by D27:** no CA — our key ships in
    the image for first-party plugins; a third-party publisher's key is imported by the tenant owner
    and its fingerprint is displayed beside every capability the plugin requests.
13. **Migration authority for untrusted code.** If a third-party plugin may not send SQL, who
    creates its `p_*` tables and applies its schema changes — and what happens on upgrade or
    downgrade of a plugin we did not write?
14. **Degradation contract.** A plugin process that hangs or dies must not take the site down:
    timeout, circuit breaker, and what the public endpoint returns while it is broken.

---

## 13. Amendments — where measurement overruled this document

**Authority:** `IDEA.md` records intent and the decisions made at the time. `docs/sds/SDS.md` and
`docs/sds/00-adjudication.md` are authoritative where the two disagree. Everything below was changed
by a measurement in the debate, not by a preference; the SDS implements the right-hand column.

The four CEO decisions adopted on 2026-10-20 are folded into the replacement text for **D15**
(16-character codes), **D21** (drag-and-drop restated as registry-bounded, round-trip gate is a
fixpoint), **D22** (static export refuses free parameters), **D26** and **§3** (the plugin runner is a
fourth compose service).

**D-numbers are IDEA's. "Replacement text" is what the SDS will say; the SDS is authoritative and IDEA.md is
history.** Eleven decisions and six section-level statements change. Two decisions are reaffirmed against a
paper that contradicted them.

| D | What is now wrong | Replacement text |
|---|---|---|
| **D7** | "Path-prefix routing (`/demo/<key>`) is the no-DNS fallback" is right, but §3.1's reading ("everything the app emits must be prefixed from `X-Forwarded-Prefix`") left open who *strips*. | "Path-prefix demos are served by one `location /demo/`; nginx strips the prefix with `rewrite … break` and sets `X-Forwarded-Prefix`; the app never rewrites an inbound path and prefixes every emitted URL exactly once through `site.url()`." |
| **D8** | Two prefix classes (`cms_*`, `u_*`) cannot express a plugin table. | "Protected tables are enforced by prefix: core `cms_*` (image-owned), user `u_*` (DDL runner), plugin `p_<id>_*` (host migration executor), plugin-system `cms_plugin_*` (image-owned). No fifth namespace exists and a DDL transaction asserts it." |
| **D9** | "Admin on a separate origin/port with IP allowlist" is unsupportable in a sold bundle (dynamic IPs, CGNAT, phones) and a port is not an origin boundary (cookies ignore ports, measured). | "Admin is a separate **hostname** (`admin.<domain>`) behind nginx with no published port; the IP allowlist is opt-in and empty in exported bundles; when it is empty, TOTP is mandatory and idle drops to 15 min; every non-GET carries a session-bound CSRF token and an exact `Origin` check." |
| **D14** | "App validates, then hands off with `X-Accel-Redirect`" omitted that the app never sees a byte and that a missing target discards the app's 200. | "Gated downloads are authorise-then-offload: the app stats the target, validates the range, consumes the redemption atomically, then returns `200` with an empty body and `X-Accel-Redirect: /__protected/<sha256>.<ext>`; a missing target is `503 SKW_E_RT_ASSET_MISSING`, never a silent nginx 404." |
| **D15** | "Access codes are stored argon2id-hashed" cannot be looked up by equality (salted), and a pepper adds a fleet-wide secret whose residency is undecided. | "An access code is 16 Crockford-base32 characters (`<selector:4><secret:12>`); the selector is stored plaintext and unique, the full code is stored as argon2id(m=19456,t=2,p=1); there is no pepper." |
| **D17** | "Renaming a key cascades to references" is false under the FK action this design needs, and CASCADE costs 439 ms / 2,412 ms of write lock at 200k references. | "Asset identity is the key and the checksum is only the physical address. A referenced key cannot be renamed (`409`); an unreferenced rename writes a `cms_asset_alias` row and 301s; a bounded `repoint` operation rewrites at most 5,000 references in one audited transaction." |
| **D19** | "Enforcement stays atomic in a single UPDATE" is true but the *unit* was a request, and one download spends four. | "`max_uses` counts redemptions. `uses` increments once per token `jti`, by an insert-first, update-second pair inside one `BEGIN IMMEDIATE`; Range continuations under the same `jti` never consume; `NULL` means unlimited behind an explicit flag." |
| **D21** | "An empty-diff round-trip as a gate" is unachievable — GrapesJS normalises on load, 8 of 9 fixtures differ at pass 1 — and "fully drag-and-droppable" cannot be true for markup the registry does not know. | "Every site we build is authored for the editor: page bodies use the editor's own component vocabulary, the round-trip gate is a **fixpoint** (`canon(load(save(load))) == canon(load))`, and drag-and-drop is guaranteed **within the shipped component registry**; a new interaction is a component release, not a content edit. Repetition is the `list` component." |
| **D22** | "Three export targets, one content model" holds, but "the same DB state produces identical bytes" did not, and a `free` parameter could be frozen silently. | "Export target is a render mode. A snapshot is enumerated (declared parameter domains, cap 1024 combinations), pinned to `SKW_EXPORT_NOW`, and **refused** when a `free` parameter appears in a link on any exported page; two exports of one DB at one `SKW_EXPORT_NOW` are byte-identical." |
| **D26** | Holds, and is the reason C-8 exists. | "Third-party plugins are untrusted by default and run in a separate `plugin-runner` container with no network, no native addons, no filesystem write and no database handle, reached over a 14-operation RPC enum." |
| **D27** | Contradicted by `r2-plugin.md` §3 Q12 (a root key signing publisher keys). D27 wins. | "No publisher CA in v1. Our key verifies first-party packages; a third-party publisher's key is imported by the tenant owner, fingerprint shown beside every capability; revocation is local to the install." |
| **§3** | "Services in `docker-compose.yml`: `nginx`, `app`, `acme`. Nothing else." | "`docker-compose.yml` has four services: `nginx`, `app`, `plugin-runner`, `acme`." |
| **§6** | Lists `cms_page_blocks` (deleted, and nothing replaced its loop) and omits seven tables the DDL now has. | "Drizzle owns `cms_page` (one document per page, no block table), `cms_page_revision`, `cms_asset`, `cms_asset_variant`, `cms_asset_alias`, `cms_asset_link`, `cms_asset_bundle`, `cms_asset_bundle_item`, `cms_download_code`, `cms_download_event`, `cms_watermark_render`, `cms_form`, `cms_form_submission`, `cms_datasource`, `cms_view_registry`, `cms_table_registry`, `cms_trigger_registry`, `cms_audit`, `cms_redirect`, `cms_settings`, and `cms_plugin_migration` / `cms_plugin_installed` / `cms_plugin_revoked`." |
| **§5** | "Export has nothing to filter" is true across tenants and false inside one: a demo carries prospects' submissions, buyers' codes and per-purchaser watermarked files. | "Export has nothing to filter **across tenants**; inside a tenant it applies `schema/export-projection.json` (five tables `empty`, `cms_settings` filtered) plus each plugin manifest's export class; `content/protected/wm/`, `content/sources/`, `data/control.db` and any `-wal`/`-shm` are never in a bundle, and `--include-pii` is off by default." |
| **§5.1** | "Target install time ≤ 5 min (measured)" is not what was measured. | "≤ 5 minutes, measured, from a Docker host (≥ 2 vCPU / 2 GB / Compose ≥ 2.20) whose images are pullable or supplied with `--offline`, an A record already pointing at the box, and TCP/80 reachable. Our part: 18.2 s warm, 29.8 s cold-pull, 7.5 s re-run, +16.0 s for TLS once DNS and port 80 are correct. Bundle transfer is excluded and capped." |
| **§7.4.3** | `__Host-dl-<key>; Path=/d/<key>` is an invalid cookie — `__Host-` requires `Path=/`. | "`Set-Cookie: __Host-sk-dl-<tenantKey>=<token>; Path=/; Secure; HttpOnly; SameSite=Lax`, 600 s, bound in the token to `(cid, aid, jti, iph, uah)`." |
| **§9** | "Tenancy: one DB per tenant; no cross-tenant query path exists by construction" is a claim the corpus falsified four times: a readonly handle can `ATTACH` a sibling and `VACUUM INTO` the public tree. | "Tenant isolation is a **permission** boundary inside one Node process, not a construction. Structural: one SQLite file per tenant and no request value ever becomes a path segment. Permissions, each tested: no statement that names a file; no write outside the tenant directory (`query_only=1`); no code we did not ship in the process; no caller-controlled path segment. The three paths that can break it are the DDL runner, any `ATTACH`-capable handle, and any `import()` from a tenant-writable tree." |

**Reaffirmed, not changed, against a paper that contradicted them:** D2 (one file per tenant — `r2-red-team.md`
§6.1 says do not reopen it, and nothing in the corpus does), and D23 (cp1252-preserving sanitiser — `r2-red-team.md`
§6.9; the omission was applying it to filenames, which O-07 fixes).

**Largest blast radius of the delta: D21 + §6 (one document, registry-bounded, `list` component).** It changes
the stored shape of every page, the block registry, the SSR renderer, and all three exporters — the widest
surface in the build, and the one Red Team called "the single most expensive late decision in the set"
(`r2-red-team.md` §5 item 5). Second largest: D15/D19 (the paid feature's schema and accounting), which is
contained to S3 but touches the one table that holds live codes.

---
