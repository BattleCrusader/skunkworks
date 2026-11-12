# Skunkworks

A multi-tenant Astro CMS: one deployment serves many websites, each on its own domain, with a public site, an admin path, an embedded drag-and-drop editor, an in-process plugin system, a content-addressed media library, gated downloads with optional per-purchaser watermarking, and an export path that produces a runnable site rather than a hostage.

TypeScript on Node 22. Fastify plus an Astro SSR shell in **one** Node process. One SQLite file per tenant, one small `control.db` for the fleet. Three containers on one host, nginx at the edge. Every claim below is either checkable in this repository or was measured by a gate you can re-run.

## Status & license

**Pre-1.0. No release has been cut.**

- **MIT licensed.** The full terms are in `LICENSE` at the repository root, and the copyright line is `Copyright (c) 2026 BattleCrusader`.
- `.github/workflows/gate.yml` exists and describes the CI gate, but that workflow **has never completed a run on GitHub Actions** — its own header says it must not be cited as evidence until a green run exists. The local gate is the real gate: `make test`.
- `docker-compose.yml` ships **placeholder all-zero image digests**, so a bare `docker compose up -d` fails with `denied` until you build the images locally (or a release publishes real digests). That is the first thing a new operator hits, so it is in the quickstart, not a footnote.
- Interfaces will change. The schema is frozen per release (`schema/`), not per minor version.

## Why it exists

Agencies and small hosts end up running ten WordPress installs on one box because one install cannot serve ten sites with ten admins and ten data sets. The usual answers are a shared database with a `site_id` column — where one careless query is a cross-client incident — or ten separate installs, where one upgrade is ten upgrades. This is the third shape: many sites, one deployment, one database file per tenant, and an export that hands a client a site that still runs after they stop paying you. The isolation is honest about what kind of boundary it is, and the exit path is a product, not a threat.

## What you get

- **Tenant routing by `Host`.** Each tenant has its own domain rows, its own `site.db`, its own media, theme and plugin rows.
- **A public site and an admin on the same host.** `/admin` is a path on every tenant host; `/fleet` is the cross-tenant console.
- **An embedded GrapesJS editor** over a fixed, shipped component registry, with a fixpoint round-trip gate over a nine-file corpus.
- **Data Sources instead of SQL.** Templates never receive a database handle; admin never accepts SQL text.
- **A content-addressed media library.** Uploads dedupe, bytes are immutable, assets are referenced by key.
- **Gated downloads** authorised by access codes, offloaded to nginx through `X-Accel-Redirect`, with optional per-purchaser PDF watermarking.
- **Plugins in-process** — manifest, own `p_*` tables, declared screens and public endpoints, signed packages, revocation.
- **Three export targets from one content model:** a CMS bundle, a runnable Astro project, plain static HTML.
- **One operator CLI** (`skwctl`) for the things an admin UI should not be able to do: first operator, TOTP reset, audit seals, plugin trust, site import.
- **A hash-chained audit log** per tenant, sealed by day, verifiable with one command.

## How it is put together

```
        :80  :443                     no published port
   ┌───────────────┐   proxy_pass   ┌────────────────────┐
   │     nginx     │ ─────────────► │        app         │
   │ edge, TLS,    │     app:3000   │ Fastify + Astro    │
   │ static, ACME  │                │ SSR, one process   │
   └──┬────────┬───┘                └─────────┬──────────┘
      │        │ read-only                    │ read-write
      │        │ nginx.conf, snippets,        │ ./data
      │        │ content, certs, acme webroot │ ./content
   ┌──┴─────────────────┐                      │
   │        acme        │  reads data/control.db
   │ RFC 8555, http-01  │  writes data/certs, data/acme
   │ HUP nginx          │  over the Docker socket (ro)
   └────────────────────┘
```

- `nginx` publishes `:80` and `:443`, serves `content/` read-only, hosts the ACME webroot, and runs the config generated into `data/nginx/10-app.conf`.
- `app` publishes **no port**: reachable only on the compose network at `:3000`, with `read_only: true`, `tmpfs: /tmp`, `user: 10001:10001`, `no-new-privileges`.
- `acme` is an in-repo RFC 8555 client, not `acme-companion`, because this nginx is a generated config and not an nginx-proxy vhost tree. It renews by file age and reloads nginx by `HUP`.
- There is **no separate migrate service**. The app runs migrations itself and reports per tenant, so one tenant's corruption is not a fleet-wide outage.

### Tenancy and isolation

Structural, and only these two things are structural:

1. **One SQLite file per tenant** — `data/tenants/<key>/site.db` — plus one small `data/control.db` for tenants, domains, accounts, sessions and edge state.
2. **No request value ever becomes a path segment.** The tenant is resolved from `Host` and from nothing else.

Everything else is a **permission boundary inside one Node process**, not a construction. The permissions, each tested:

- no statement that names a file;
- no write outside the tenant's own directory (`query_only=1` on read handles);
- no code in the process that we did not ship;
- no caller-controlled path segment.

The three paths that can break it are named rather than wished away: **the DDL runner**, **any `ATTACH`-capable handle**, and **any `import()` from a tenant-writable tree**. `docs/sds/00-adjudication.md` records this as risk R1; `IDEA.md` §13 carries the replacement text for the claim that used to say "by construction".

Table namespaces are enforced by prefix, and a DDL transaction asserts it:

| Prefix | Owner |
|---|---|
| `cms_*` | the image |
| `u_*` | the DDL runner (user tables, manageable from admin) |
| `p_<id>_*` | the host migration executor, one set per installed plugin |
| `cms_plugin_*` | the image (install, enable, revocation) |

There is no fifth namespace.

### Rendering

- Astro runs in **middleware mode**, mounted into the Fastify process — one listener, one process, one event loop (`output: 'server'`, `adapter: node({ mode: 'middleware' })`). Rendering is request-time SSR; static is a snapshot taken on publish or export, not a second runtime.
- Export shares the site's render path: a one-line change in `app/render/body.ts` reddens the served-page gate and all three export gates together, which is how a `<img data-asset-key>` with no `src` was caught in the served page rather than in a test.

### Data access

- Templates never receive a database handle. Data reaches them through named **Data Sources** with declared limits (`limit_default`, `limit_max`). A datasource whose `limit_default` exceeds its `limit_max` is **refused at publish**; the render path clamps anyway, because asking for too many rows is a request the caller can make.
- Admin never accepts SQL text. There is no query box, and adding one would be a design change, not a feature.

### Editor

- Embedded GrapesJS, with its default panels switched off and a toolbar that belongs to this CMS.
- The component vocabulary is data: `schema/component-registry.json`, 14 entries, upserted into `cms_component_registry` at boot. One entry drives the palette, the renderer and all three exporters.
- A page body that names a component the registry does not know is refused at save: `422 SKW_E_RT_COMPONENT_UNKNOWN`.
- **Every site is authored for the editor.** Page bodies use the editor's own component vocabulary, so drag-and-drop works because of how the markup is authored — it is not retrofitted onto hand-rolled HTML. Repetition is the `list` component.
- The round-trip gate is a **fixpoint**, `canon(load(save(load))) == canon(load)`, over a nine-file corpus. It is not an empty-diff gate and cannot be: GrapesJS normalises on load, and 8 of 9 fixtures differed at pass 1 when the gate was written that way.
- Pages are rows with a constrained `slug` and `status` in `draft | published | hidden`, so add / remove / hide are properties of the storage model rather than of a menu.

### Assets, keys, gated downloads

- Media is content-addressed on disk: `content/media/<sha256[0:2]>/<sha256>.<ext>`. Uploads dedupe; bytes are immutable and cacheable.
- **Asset identity is the key; the checksum is only the physical address.** A referenced key cannot be renamed — `409 SKW_E_DM_KEY_IN_USE`, naming the reference count. An unreferenced rename writes one `cms_asset_alias` row and 301s, moving no bytes. A bounded `repoint` rewrites at most 5,000 references in one audited transaction (`SKW_REPOINT_MAX_ROWS`).
- **This is not a storefront.** Payment happens in whatever store the operator already uses; a signed webhook issues an access code; the buyer redeems the code in a form and then downloads.
- An access code is **16 Crockford-base32 characters**, `<selector:4><secret:12>`. The selector is stored plaintext and unique; the full code is stored as `argon2id(m=19456, t=2, p=1)`. There is no pepper, and a code never appears in a URL.
- `max_uses` counts **redemptions**. `uses` increments once per token `jti`, by an insert-first, update-second pair inside one `BEGIN IMMEDIATE`; `Range` continuations under the same `jti` never consume; `NULL` means unlimited behind an explicit flag. Tokens carry two expiries — a short authorisation window and a longer continuation grace — so a large PDF on a bad connection resumes without burning a use.
- The app **authorises and then offloads**: it stats the target, validates the range, consumes the redemption atomically, then returns `200` with an empty body and `X-Accel-Redirect: /__protected/<sha256>.<ext>`. nginx does the byte-shuffling, so Node never streams a large file. A missing target is `503 SKW_E_RT_ASSET_MISSING`, never a silent 404.
- Optional watermarking is stamped on the fly with `pdf-lib`. Text is sanitised to **cp1252** rather than flattened to ASCII, so accented names survive. Concurrency is bounded by a per-tenant semaphore (8) plus a global one; a refusal is a `503` with a computed `Retry-After` that the download page retries with jitter.

### Plugins

- A plugin is a module **imported into the app process**, WordPress-style: a manifest (`plugin.json`), its own `p_*` tables, declared admin screens, declared public endpoints.
- No runner container, no socket protocol, no RPC boundary. An earlier design had all three; `IDEA.md` D36 supersedes it, and `docs/sds/13-plugin-model-delta.md` is the reader's guide to what became false.
- Third-party packages are signed. A publisher key is imported by the tenant with its fingerprint shown beside every capability; revocation is local to the install and is read at install **and** at enable.
- A plugin that fails at load is disabled and reported, not allowed to take the site down.
- Declared capabilities are **operator disclosure, not a sandbox**.

### What is not claimed

- Tenant isolation is a **permission boundary inside one process**, not a construction. Two things are structural — one file per tenant, and no request value becoming a path segment — and the three ways to break the rest are named above.
- Plugin signatures prove **authorship and integrity, not containment**. A signed plugin is still code in the app's process with the app's filesystem; declared capabilities are what the operator is shown.
- Drag-and-drop holds **within the shipped component registry**. A new interaction is a component release, not a content edit.
- The editor round-trip guarantee is a **fixpoint**, not an empty diff.

## Quickstart (Docker)

Prerequisites: a Docker host with Compose, and **Node ≥ 22.5 on the host** — the install tools use `node:sqlite` and `install.sh` exits 18 without it.

1. **Clone and make an env file.**

   ```bash
   git clone https://github.com/BattleCrusader/skunkworks.git
   cd skunkworks && cp .env.example .env
   ```

2. **Replace the placeholders.** `.env.example` carries the names this compose stack reads. Six are required and compose refuses to start without them: `SKW_EDGE_TOKEN`, `SKW_SESSION_KEY`, `SKW_DOWNLOAD_TOKEN_KEY`, `SKW_IP_HASH_KEY`, `SKW_ADMIN_ORIGIN`, `SKW_BUILD_ID`. `ACME_EMAIL` is required by the `acme` service. `UV_THREADPOOL_SIZE=8` is a boot assertion.

3. **Build the images** — the step that exists because the compose digests are placeholder zeros.

   ```bash
   docker build -f Dockerfile.app -t skw-app:local .
   docker build -f acme/Dockerfile  -t skw-acme:local .
   ```

   `.env.example` already sets `SKW_APP_IMAGE=skw-app:local` and `SKW_ACME_IMAGE=skw-acme:local`, so compose points at what you just built. A released bundle pins real digests instead.

4. **Install.** One command: verify → `control.db` → seed → tenant database → `.env` → bootstrap → compose up.

   ```bash
   ./install.sh --target ./data --bundle . \
                --email you@example.com --domain client.example.com --verify-login
   ```

   `install.sh` writes `.env` at `0600` and never overwrites an existing one. Flags: `--target DIR`, `--bundle DIR`, `--seed FILE`, `--runtime DIR`, `--admin-host HOST`, `--email ADDRESS`, `--domain DOMAIN`, `--skip-dns`, `--no-compose`, `--verify-login`, `--force`, `--nginx-conf FILE`.

5. **First login.** `install.sh` runs `skwctl admin bootstrap --generate-password --enrolment-out <file>` and writes a one-time enrolment file to `data/first-login.txt` (`0600`), then prints `https://<tenant-host>/admin/login`. TOTP enrolment is mandatory on first login; there are no recovery codes, and recovery is `skwctl admin reset-totp` over shell access on the box. **Delete the enrolment file after you scan it.**

`--verify-login` is not decoration: after install it logs in with the generated password and TOTP secret, fetches `GET /admin`, and fetches the tenant's first published page over the real listener. The "empty directory to a served page" claim is proven by the install rather than asserted by a report.

Exit codes are a contract, not diagnostics to skim:

| Code | Meaning |
|---|---|
| 0 | installed, or already bootstrapped (bootstrap exit 3 is benign) |
| 11 | the A record for `--domain` does not point at this box |
| 12 | bundle verification failed (hash, symlink, plugin row without its package, seed/schema mismatch) |
| 15 | `control.db` could not be created, migrated or seeded |
| 16 | `skwctl admin bootstrap` failed for a reason other than "already bootstrapped" |
| 17 | `docker compose up` failed |
| 18 | host Node is older than 22.5 — no `node:sqlite` |
| 19 | no app runtime carrying `skwctl` (`--runtime DIR`, `./dist`, or the pinned image) |

## Quickstart (source check-out)

```bash
npm ci
npm run build
./install.sh --target ./data --seed schema/control.seed.json \
             --no-compose --verify-login
```

- `--no-compose` stops after bootstrap. The compose path is tested against locally built images, not against the placeholder digests.
- `--seed schema/control.seed.json` is explicit on purpose: a source tree is not a deployment, and `install.sh` must never pick up a live `data/control.seed.json` by accident.
- `--verify-login` uses the local runtime that `npm run build` produces (`dist/app/cli/skwctl.js`).

**Running the app by hand.** `package.json`'s `start` is `node dist/app/main.js`, and it does **not** load `.env` — compose injects the environment instead. `app/env.ts` reads `process.env`, so the file can be supplied directly, but the `SKW_DATA_DIR` written into `.env` is the container path:

```bash
SKW_DATA_DIR=$PWD/data node --env-file=.env dist/app/main.js
```

A variable already set in the shell wins over `--env-file`, which is why the override works. The six required names must be present, `UV_THREADPOOL_SIZE` must be `8` (the boot refuses otherwise — libuv fixes the pool at process start), and `SKW_ARGON2_MAX_CONCURRENT` must be exactly `4`. Without those, use the compose path.

| Name | Status |
|---|---|
| `SKW_BUILD_ID`, `SKW_EDGE_TOKEN`, `SKW_SESSION_KEY`, `SKW_DOWNLOAD_TOKEN_KEY`, `SKW_IP_HASH_KEY`, `SKW_ADMIN_ORIGIN` | required; compose refuses to start without them |
| `ACME_EMAIL`, `UV_THREADPOOL_SIZE=8` | required by the `acme` service; boot assertion |
| `SKW_DATA_DIR=/srv/data`, `SKW_EDGE_TRUSTED_CIDRS` | defaults: `/srv/data`, loopback + RFC1918 |
| `SKW_DB_POOL_MAX=64`, `SKW_DB_BUSY_TIMEOUT_MS=5000`, `SKW_ARGON2_MAX_CONCURRENT=4`, `SKW_DDL_MAX_STATEMENTS=8` | pool and DDL bounds |
| `SKW_RENDER_MODE=live`, `SKW_SCHEMA_EDIT=off`, `SKW_FLEET_MODE=1` | rendering and admin-surface switches |
| `SKW_SNAPSHOT_MAX_COMBOS=1024`, `SKW_SNAPSHOT_MAX_BYTES=2097152`, `SKW_REPOINT_MAX_ROWS=5000`, `SKW_BOX_RPS=192`, `SKW_EMAIL_MODE=off` | export, asset and rate limits |
| `SKW_ADMIN_ALLOWLIST` | empty by default |

Two rules the environment enforces at boot:

- **Deleted prefixes are refused.** Any variable named `SK_*` or `SKUNK_*` is a boot refusal (`deleted environment prefix in use (^SK_|^SKUNK_)`): those names belonged to a previous design, and a machine that still exports them is a machine nobody has read since.
- **An empty `SKW_ADMIN_ALLOWLIST` means TOTP is mandatory** and the idle window drops to 15 minutes. nginx enforces the allowlist inside each tenant's `/admin` location; the app reads it for the TOTP and idle decisions and never enforces it. A non-empty value that does not parse refuses the boot with the same parser's message, so the edge and the app cannot disagree.

## Everyday operations

One binary, `app/cli/skwctl.ts` (`dist/app/cli/skwctl.js` once built). From source:

```bash
node --experimental-strip-types app/cli/skwctl.ts <command> [flags]
```

| Command | What it is for |
|---|---|
| `skwctl admin bootstrap --generate-password --enrolment-out <file>` | create the first operator; the secret only ever reaches that file |
| `skwctl admin reset-totp --email <email> --enrolment-out <path>` | replace a lost factor, over shell access |
| `skwctl admin reset-password --email <email> --password-stdin` | replace a password |
| `skwctl audit seal [--heal] [--tenant <key>] [--day YYYY-MM-DD]` | seal a day's audit segment(s) |
| `skwctl audit verify --chain --tenant <key>` | walk every link in the tenant's hash chain |
| `skwctl audit status --tenant <key> [--days N]` | per-day seal state |
| `skwctl plugin install <dir> --tenant <key> [--test-report <path>] [--enable]` | install a package into one tenant |
| `skwctl plugin pack <dir> --report <path> --out <file.tar.gz>` | build the archive the admin upload door accepts |
| `skwctl plugin enable` / `disable` / `uninstall <id> --tenant <key>` | tenant lifecycle |
| `skwctl plugin trust import <key.pem> --publisher <id> --tenant <key>` / `trust list --tenant <key>` | import or list the publisher keys this tenant trusts |
| `skwctl plugin revoke <id> [--root <sha256>] [--reason <text>] --tenant <key>` | revoke a root for install and enable |
| `skwctl site import <archive|dir> --tenant <key> --host <host> [--nginx]` | put a bundle on this box |

**Audit.** Every tenant has a hash-chained `cms_audit`. Segments are sealed by day; `audit verify --chain` reads past a segment and walks every link, which is the command to run after a refusal. `skwctl` writes rows with `actor_label = 'skwctl'`, so a shell action is attributable.

**Adding a tenant.** Two doors, same result: `skwctl site import … --nginx`, or `POST /fleet/import` as a fleet-scoped operator. Both write the tenant's rows, `site.db`, media and theme files, then regenerate `data/nginx/10-app.conf`. Nothing is live until nginx re-reads that file: the `acme` service watches its mtime (`SKW_ACME_WATCH_S`, default 10) and HUPs nginx over the socket it already holds for certificates. The CMS never holds the Docker socket itself.

**Hosts and certificates.** A host is a `domain` row. Install time writes a per-host self-signed pair so HTTPS answers immediately; the `acme` service then speaks RFC 8555, answers **http-01** from the webroot nginx serves, and replaces the pair. There is no wildcard certificate, so no DNS-01 credentials are needed. Renewal is **age-based** (`SKW_ACME_RENEW_DAYS`, default 60 of a 90-day certificate) because the image carries no openssl and cannot read `notAfter`.

```bash
sqlite3 data/control.db "select host, cert_state from domain"
```

A tenant without DNS yet is reachable through the `/demo/<key>/` path on the demos host: one `location /demo/`, nginx strips the prefix with `rewrite … break` and sets `X-Forwarded-Prefix`, and the app prefixes every emitted URL exactly once through `site.url()`. It is a preview, not a URL to sell.

## Plugins

Three states, and they belong to different things:

| State | Lives in | Belongs to |
|---|---|---|
| in the library | `data/plugin-library/<id>-<version>.tar.gz` | the box — every tenant sees every entry |
| installed | `cms_plugin_installed` + the package's `p_*` tables in that tenant's `site.db` | one tenant |
| enabled | `cms_plugin_installed.enabled` | one tenant |

Installing creates the tables in that tenant's database and nowhere else, and **installing does not enable** — Enable is a separate press. Two tenants installing the same package get two copies of the schema and two sets of rows.

- An unsigned package needs the operator's explicit `allow_unsigned` acknowledgement, and the installed row records `signature_state = unsigned`.
- A missing, stale or mismatched test report is refused with `SKW_E_PL_TESTS_STALE`: a package cannot ship untested and be discovered by a client's contact form.
- A revoked root cannot be installed or enabled, whatever the archive says about itself.

Shipped packages (`plugins/` holds the sources):

| Package | Version | Table | Screen | Public endpoint |
|---|---|---|---|---|
| `blog` | 1.1.0 | `p_blog_post` | Blog posts | `GET /_plugin/blog/posts` |
| `contact` | 1.2.0 | `p_contact_message` | Messages | `POST /_plugin/contact/submit` |
| `menu` | 1.0.0 | `p_menu_item` | menus | `GET /_plugin/menu/items` |

Packing one:

```bash
skwctl plugin pack plugins/contact --report test-reports/contact.json \
  --out data/plugin-library/contact-1.2.0.tar.gz
```

The report must be bound to the package's **own root hash**, and it sits beside the package in the archive rather than inside it — a file inside the root changes the hash the report attests.

A plugin that **blocks** cannot be timed out: the dispatch catches a throw and uses the value it was passed, but nothing reclaims a synchronous loop, because the timer would need the event loop the loop is holding. That is a stated cost of the in-process model.

## Export and import

One content model, three outputs from the same pages and assets:

| Target | Produces |
|---|---|
| `cms` | the CMS bundle — pinned image digests plus that tenant's data, `install.sh`, compose, nginx, `BUNDLE.json` with a sha256 per file |
| `astro` | a runnable Astro project with its source intact |
| `static` | plain static HTML/JS with no CMS |

```bash
node --experimental-strip-types app/cli/export.ts \
  --target cms --tenant fractional \
  --data-dir data --content content \
  --origin https://example.com \
  --out /tmp/site --archive /tmp/site.zip
```

- `--content` defaults to `<data-dir>/content`, which is not where a source checkout keeps media. Pass `--content content` or the `cms` target refuses with `SKW_E_EXP_ASSET_UNRESOLVED` before the first byte.
- Export target is a **render mode**, not a fork. A snapshot is enumerated over the declared parameter domains, capped at 1024 combinations (`SKW_SNAPSHOT_MAX_COMBOS`), pinned to `SKW_EXPORT_NOW`, and **refused** when a `free` parameter appears in a link on any exported page. Two exports of one database at one `SKW_EXPORT_NOW` are byte-identical.
- A bundle carries the site, not the people: accounts, sessions, mail, applications, audit and the download/form planes ship **empty** per `schema/export-projection.json`.

Import puts that bundle on another box:

```bash
skwctl site import <archive|dir> --tenant <key> --host <host> [--host <host>] \
  [--primary <host>] [--wildcard <parent>] [--data-dir <dir>] [--replace] [--nginx]
```

Every hash, every symlink target, every `source_counts` number and every plugin package's root hash is verified **before anything is written**, so a refused import leaves no half-built tenant. `--replace` is required to reuse an existing tenant key; a host that already belongs to another tenant is refused.

Themes have their own package format and CLI — `skw-theme list | import | export | activate | remove` (`app/cli/theme.ts`). The exported sheet carries *relative* asset references, so a theme package names no host and no tenant.

## Testing and gates

```bash
make test          # canonical, deterministic
make test-perf     # wall-clock assertions; refuses to run on a loaded box
make verify-claims-modern
```

`make test` is `verify-toolchain` then `verify`; `verify` is `verify-gitignore`, `verify-schema`, `verify-claims`, `verify-frozen`, `verify-s1`, `verify-dist`, `verify-no-leak`. `make verify` is an alias of `make test`.

- **A skipped test is a failure.** `scripts/run-node-tests.mjs` has no `--allow-skip`; the only escape is `SKW_ALLOW_SKIP=1`, which the Makefile never sets.
- **The gate fails if the schema DDL is stale.** `verify-schema` regenerates both DDL files, applies them to real SQLite and runs the negative tests.
- **`verify-dist` executes the artefact that ships.** `scripts/dist-gate.mjs` runs `dist/` as a child process and asserts on what comes out, because source-era `import.meta.url` bugs are invisible to source tests — a `.ts`-only worker URL once reached production with 404/404 green.
- **`verify-no-leak` fails the run** if a `skw-*` container or network is left behind, and carries its own negative control: create a probe, skip its teardown, require the audit to name it, then require clean. A matcher that matches nothing would otherwise read as a tidy daemon.
- **`verify-claims` re-runs every measurement the design documents cite** — 27 checks — rather than trusting the numbers in prose. `make verify-claims-modern` runs the same chain on an interpreter whose SQLite is ≥ 3.50, because SQLite only re-parses triggers on `ALTER TABLE … RENAME` from 3.50, and that is the only version on which one known regression class is visible.

Suite size: **119** `*.test.ts` files (`find test -name '*.test.ts' | wc -l`). `npm run test` runs them with `--test-concurrency=1`; `npm run typecheck` runs both tsconfigs; `npm run build` is `tsc` plus `astro build`.

The philosophy is the one thing here worth copying: gates you can re-run, not claims you can only trust. `docs/build/STATUS.md` keeps the measurement notes, including the four gates that were testing a path one step to the side of what shipped.

## Repository layout

```
app/            the application, one directory per concern:
                accounts (portals, sessions, PII), admin (auth, TOTP, CSRF,
                routes), assets (store, aliases, repoint, renditions), audit
                (chain, seals), cli (skwctl, export, theme), db, ddl (runner
                and namespace rules), download (codes, ledger, plane,
                watermark, cp1252), edge, editor (canon, registry, save,
                publish), export (cms/astro/static, projection), forms,
                import, mail, plugins (install, trust, archive, revocation),
                render (Astro shell, body, zip), sources (Data Sources),
                tenancy (host resolution), themes
schema/         frozen DDL: control.sql, site.sql, numbered amendments,
                control.seed.json, component and error registries
plugins/        blog, contact, jobboard, menu (+ README.md)
themes/         theme sources and packages
content/        media/ and public/ (runtime data, gitignored)
nginx/          nginx.conf, conf.d, templates
snippets/       CSP and proxy includes
scripts/        gates and measurement: model/, measure/, proof/
test/           119 test files, including the dist and leak gates
docs/           sds/, build/, debate/, design/, privacy/, sites/
tools/          acme.mjs, bundle_verify.mjs, nginx_gen.ts, seed_control.mjs
install.sh      the installer; its exit codes are its contract
Dockerfile.app  multi-stage, ends non-root on uid 10001
docker-compose.yml   Makefile   astro.config.mjs   IDEA.md
```

## Documentation

| File | What it is |
|---|---|
| `docs/sds/SDS.md` | the authoritative design; where it disagrees with `IDEA.md`, it wins |
| `docs/sds/00-adjudication.md` | the conflict and risk register — the fastest read for a sceptic |
| `docs/sds/01-verification.md`, `02-errata.md` | what was measured and how; errata by ID |
| `docs/sds/13-plugin-model-delta.md` | what to unlearn about plugins after D36 |
| `docs/DEPLOY.md` | deploy best practice, written against a live box; §11 is the gap list |
| `docs/import-export.md` | bundle contents, import, routing, theme packages |
| `docs/build/STATUS.md` | slice status, the measured numbers, and what is honestly uncovered |
| `plugins/README.md` | package lifecycle, trust rules, shipped packages |
| `IDEA.md` | the brief, the D1–D36 decision log, and §13: where measurement overruled the document |

## Security model at a glance

- **No SQL from the browser.** Templates get named Data Sources with declared limits; admin accepts no SQL text.
- **Access codes** are 16 Crockford-base32 characters, stored as `argon2id(m=19456, t=2, p=1)` against a plaintext selector, never in a URL.
- **The app container is unprivileged**: `read_only`, `tmpfs: /tmp`, uid 10001, `no-new-privileges`, no published port.
- **Admin lives behind the edge.** `/admin` is a path on each tenant host; the tenant comes from `Host` and only from `Host`; the allowlist is enforced by nginx, and an empty allowlist makes TOTP mandatory.
- **Plugins are signed, and signatures are about authorship**, not containment.
- **The audit log is hash-chained** per tenant and sealed by day, so tampering is a verification failure rather than a suspicion.
- **Imports are verified before they write.** A tampered bundle leaves no tenant behind.
- **The CMS never holds the Docker socket.** The generated nginx config is the signal; `acme` is the only container with the socket, mounted read-only, and it only signals.
- **Secrets go to files, not logs.** `skwctl` refuses to print a TOTP secret to a non-terminal stdout; enrolment goes to a `0600` file with `O_EXCL`.

## Known gaps

Verified by reading the repository, not inferred:

- **CI has never run green.** `.github/workflows/gate.yml` exists, and by its own header must not be cited as evidence.
- **The registry pull is impossible as shipped.** The compose digests are all zeros.
- **ACME against a production CA is unproven.** Measured against Pebble with validation not short-circuited; do the first issuance on a throwaway host.
- **A synchronous plugin hang cannot be timed out.** In-process means in-process.
- **Renewal is age-based, not expiry-based.** The image cannot read `notAfter`.
- **"Clean host install ≤ 5 min with images present" is unmeasured** — that row has never been run under that condition.
