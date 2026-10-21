# SDS — Skunkworks multi-tenant Astro CMS

**Version:** 3.0 · **Schema:** tenant `site.db` v3, `control.db` v2 · **Date:** 2026-10-20
**Author:** Architect (round 3, Phase B) · **Authority:** `docs/sds/00-adjudication.md` (the register)
**Consumes:** `IDEA.md` D1–D27 · eleven debate papers · `schema/*.sql` · `schema/*.json` · `make test`
**Produces:** this document, `docs/sds/diagrams/*`, and the schema the Builders run.

---

## 0. Status, scope, and what this document is not

**Status: frozen for S1.** A Builder may implement from §3 onwards without asking a question. Where
this document and a debate paper disagree, this document wins; where this document and the register
disagree, the register wins and this document is the bug.

**In scope.** The whole shippable system: one Node process serving many tenants, four containers, one
SQLite file per tenant plus a global control file, an editor with a registry-bounded component
vocabulary, three export SKUs, gated downloads with real accounting, and a plugin surface that can
host third-party code without giving it a database handle.

**Out of scope, and named so nobody builds it:**

| Not in v1 | Why | Where the refusal lives |
|---|---|---|
| Payments, carts, tax, refunds | D16 — the CMS issues and redeems codes; a signed webhook covers every store | §7.6 |
| DRM | D12 — watermarking is attribution and deterrence, priced as such | §7.5 |
| `function` Data Sources (in-process JS) | C-18 — arbitrary code with a cross-tenant read primitive | §6.1 |
| Tenant-authored templates/shells | C-23 — that is layout code on every render | §10.4 |
| A publisher CA / plugin store | C-9, D27 — vouching for someone else's code is a liability we decline | §8.5 |
| Plugin uploads (`accepts_upload`) | O-39 DEFERRED — a new public write surface | §18.2 |
| Cron / scheduled plugin work | O-43 DEFERRED — `"cron": "none"` is the only legal value | §18.4 |
| Table-scoped uninstall archive | O-40 DEFERRED — whole-file `VACUUM INTO` is correct, only coarse | §18.3 |
| A CDN or a shared cache in front of HTML | §5.4 — HTML is `no-store`; O-01 records the case-folding constraint a CDN would have to meet | §5.5 |
| A per-tenant process | C-8 — 49.8 MB and 34 ms cold start each is 10.0 GB at 200 tenants | §13.3 |

**What this document is not.** It is not the visual design, not the marketing copy, and not a
replacement for the code. It does not contain the CSS values, the block markup for a specific
client, or the wording of the five-minute promise as it appears on a website (§5 of the register
fixes the measured bracket; the sentence is not the SDS's).

**One number that governs the whole document.** `make test` runs 27 checks and every architectural
claim below that can be executed *is* executed. Where a claim cannot be executed here — a browser
behaviour, an ACME issuance against a production CA, a 1 GB transfer — §13.4 and §17 say so instead
of implying otherwise.

---

## 1. Constraints and non-negotiables

`IDEA.md` D1–D27 are the CEO's decisions. Eleven of them, and six section-level statements, are
changed by measurement or adjudication; the register's §5 lists every replacement. This section is
the operative list — a Builder implements *this* column, not the older text in `IDEA.md`.

### 1.1 The decisions, as amended

| # | Constraint (operative text) | State |
|---|---|---|
| D1 | TypeScript on Node 22 for the whole stack; one *app* process. **One process in the app, and since D36 one process in the deployment too** — plugins are modules in `app`, and there is no runner container | **amended** |
| D2 | One SQLite file per tenant + a global `control.db`. Never a shared schema. Not reopened by any paper | unchanged |
| D3 | Drizzle owns `cms_*` and `control.db`; Kysely owns `u_*`. The boundary is enforced by module exports and a lint rule, not by convention | unchanged |
| D4 | No raw SQL from the browser, ever. Data reaches templates through named Data Sources only | unchanged |
| D5 | Render at request time; snapshot to static only on publish/export | unchanged |
| D6 | GrapesJS embedded, best-effort quality bar | unchanged |
| D7 | Host-based routing is primary; per-host HTTP-01 certs, no wildcard. **Path-prefix demos are served by one `location /demo/`; nginx strips the prefix with `rewrite … break` and sets `X-Forwarded-Prefix`; the app never rewrites an inbound path and prefixes every emitted URL exactly once through `site.url()`** (C-2) | **amended** |
| D8 | Protected tables are enforced by prefix: core `cms_*` (image), user `u_*` (DDL runner), plugin `p_<id>_*` (host migration executor), plugin-system `cms_plugin_*` (image). No fifth namespace; a DDL transaction asserts it (C-5, C-13) | **amended** |
| D9 | **Admin is a separate hostname (`admin.<domain>`)** behind nginx with no published port; the IP allowlist is opt-in and empty in exported bundles; when it is empty TOTP is mandatory and idle drops to 15 min; every non-GET carries a session-bound CSRF token and an exact `Origin` check (C-11, C-25) | **amended** |
| D10 | Sell/deploy via a published image digest + tenant bundle, not source divergence | unchanged |
| D11 | Agent orchestration is a build-process concern, not a CMS feature | unchanged |
| D12 | No DRM/licensing enforcement in v1 | unchanged |
| D13 | Assets are content-addressed on disk: `content/media/<sha256[0:2]>/<sha256>.<ext>` | unchanged |
| D14 | **Gated downloads are authorise-then-offload**: the app stats the target, validates the range, consumes the redemption atomically, then returns `200` with an empty body and `X-Accel-Redirect: /__protected/<sha256>.<ext>`; a missing target is `503 SKW_E_RT_ASSET_MISSING`, never a silent nginx 404 (C-17, C-14) | **amended** |
| D15 | **An access code is 16 Crockford-base32 characters (`<selector:4><secret:12>`); the selector is stored plaintext and unique, the full code is stored as argon2id(m=19456,t=2,p=1); there is no pepper** (C-6) | **amended** |
| D16 | The CMS is not a storefront; payment stays external; a signed webhook covers every store | unchanged |
| D17 | **Asset identity is the key and the checksum is only the physical address. A referenced key cannot be renamed (`409`); an unreferenced rename writes a `cms_asset_alias` row and 301s; a bounded `repoint` rewrites at most 5,000 references in one audited transaction** (C-3) | **amended** |
| D18 | nginx serves public assets from a symlink farm; gated bytes live in the same tree but have no farm link and are reachable only through `internal` (C-17) | **amended** |
| D19 | **`max_uses` counts redemptions.** `uses` increments once per token `jti`, by an insert-first, update-second pair inside one `BEGIN IMMEDIATE`; Range continuations under the same `jti` never consume; `NULL` means unlimited behind an explicit flag (C-7) | **amended** |
| D20 | Watermarking is CMS-managed: an uploaded image asset, per-asset override, a per-purchaser text template, fail-closed | unchanged |
| D21 | **Every site we build is authored for the editor: page bodies use the editor's own component vocabulary, the round-trip gate is a fixpoint (`canon(load(save(load))) == canon(load))`, and drag-and-drop is guaranteed within the shipped component registry; a new interaction is a component release, not a content edit. Repetition is the `list` component** (C-4, C-23) | **amended** |
| D22 | **Export target is a render mode. A snapshot is enumerated (declared parameter domains, cap 1024 combinations), pinned to `SKW_EXPORT_NOW`, and refused when a `free` parameter appears in a link on any exported page; two exports of one DB at one `SKW_EXPORT_NOW` are byte-identical** (C-22) | **amended** |
| D23 | Watermark text is sanitised to cp1252, not flattened to ASCII; `?` for the rest. Applying it to filenames is new (O-07) | unchanged |
| D24 | The Astro export ships a runnable, editable project, with the lockfile it resolved (O-24) | unchanged |
| D25 | Plugins are a first-class extension surface: a manifest, owned tables, declared admin forms, declared public endpoints | unchanged |
| D26 | **Superseded by D36.** Third-party plugins are supported and untrusted, and they run **in-process** inside `app` as imported modules registering hooks, endpoints and admin screens; the signature and the publisher key establish who wrote the code, a per-request per-tenant facade scopes what the API will answer, and no containment is claimed (C-8 withdrawn) | **superseded** |
| D27 | **No publisher CA in v1.** Our key verifies first-party packages; a third-party publisher's key is imported by the tenant owner, fingerprint shown beside every capability; revocation is local to the install (C-9). Under D36 the fingerprint buys identity and tamper detection, **not containment** (§13.3.7) | **reaffirmed**, meaning narrowed |

### 1.2 Section-level statements that changed

| Was | Now |
|---|---|
| §3 "Services in `docker-compose.yml`: `nginx`, `app`, `acme`. Nothing else." | Three services: `nginx`, `app`, `acme`. The fourth service C-8 added was deleted by D36; plugin code runs inside `app` (E-31). |
| §6 lists `cms_page_blocks`, omits seven tables the DDL has | Drizzle owns the 27 tables in §4.1; there is no block table — the stored body is the editor's document (C-4). |
| §5 "Export has nothing to filter" | True **across** tenants, false **inside** one: a demo carries prospects' submissions, buyers' codes and per-purchaser watermarked files. §11 and `schema/export-projection.json` apply. |
| §5.1 "Target install time ≤ 5 min (measured)" | ≤ 5 minutes from a Docker host (≥ 2 vCPU / 2 GB / Compose ≥ 2.20) whose images are pullable or supplied with `--offline`, an A record already pointing at the box, and TCP/80 reachable. Our part: **18.2 s warm, 29.8 s cold-pull, 7.5 s re-run, +16.0 s for TLS** once DNS and port 80 are correct. Bundle transfer is excluded and capped. |
| §7.4.3 `__Host-dl-<key>; Path=/d/<key>` | `Set-Cookie: __Host-sk-dl-<tenantKey>=<token>; Path=/; Secure; HttpOnly; SameSite=Lax`, 600 s, bound in the token to `(cid, aid, jti, iph, uah)`. The old form is an **invalid** cookie: `__Host-` requires `Path=/`. |
| §9 "Tenancy: no cross-tenant query path exists by construction" | Tenant isolation is a **permission** boundary inside one Node process, not a construction. §13.1 states exactly what is proven. |

### 1.3 Two amendments to `.agents/ARCHITECT.md`'s own constraint list

Recorded here so a Builder is not surprised by a document that appears to contradict the brief:

1. **"nginx-proxy + acme-companion"** becomes **acme-companion + one generated `server` block per
   host.** O-25: nginx-proxy derives vhosts at container creation, so adding a TLD recreates `app`.
   We generate the config and `nginx -s reload` (milliseconds). `acme-companion` stays.
2. **"GrapesJS round-trip with an empty diff"** becomes **a fixpoint.** D21 as amended by C-4:
   GrapesJS normalises on load, 8 of 9 fixtures differ at pass 1, so an empty diff on pass 1 is
   unachievable and was never a property of the product. The gate is
   `canon(load(save(load))) == canon(load)`.

---

## 2. Architecture overview

One Node process serves every public page, the admin API, the gated-download endpoints **and, since D36,
every enabled plugin's hooks**. Three containers, and three trust boundaries plus the plugin code that now
runs inside the first one — which §13.3.7 refuses to call a boundary. `docs/sds/diagrams/components.png`
is the picture; this section is the prose that a Builder can act on.

```
:80 :443 ──► nginx ──────────────► app (one Node 22 process, `expose` only)
              │  /media/   → content/public/  (symlink farm, public assets only, no Node)
              │  /__protected/ internal → content/media/ (X-Accel-Redirect, Range)
              ▼
        app ──► control.db        (tenant map, users, sessions, audit_log, audit_seal)
            ──► tenants/<k>/site.db  (render-read: readonly + query_only=1)
            ──► data/plugins/<id>/   (import() into this process, §13.3.2 — no runner, no socket)
```

### 2.1 Processes and what each one may touch

| Process | May | May not | Why the boundary is here |
|---|---|---|---|
| `nginx` | terminate TLS, choose the tenant by `Host` or `/demo/<key>/`, serve `/media/` and `/__protected/` bytes, rate-limit | open a database, run a template | It already knows the tenant in order to route, so it is the only component that strips a prefix (C-2) |
| `app` | open `control.db` and every tenant `site.db`, render, issue codes, `import()` a signed plugin package from `data/plugins/<id>` into its own process and run its hooks | be handed SQL text on a pooled connection; hand a plugin a `Database`, the `control.db` handle, or SQL text; publish a port | It holds the keys. Since D36 it also runs third-party code, which is a **named path** in §13.1, not a boundary |
| `acme` | obtain and renew per-host certificates | gate an install | A certificate that is not ready is `certificate: pending`, not a failed deploy (§12.5) |

**There is no fifth process and no fourth container.** D36 deleted `plugin-runner`, so the row that used to sit
here — "run plugin code in a `node --permission` child … may not reach the network, load a native addon,
spawn, write a file, open a database" — described both a container that no longer exists and a guarantee
that no longer holds. Plugin code now shares `app`'s network namespace, filesystem, memory and handles, and
§13.3.7 is the paragraph that says so without softening it.

### 2.2 The three connection classes (C-15)

There are exactly three, and no fourth:

| Class | Pragma set | Lifetime | The one thing it may do that others may not |
|---|---|---|---|
| `render-read` | `readonly: true`, `PRAGMA query_only=1`, `foreign_keys=1`, `busy_timeout` | pooled LRU (`SKW_DB_POOL_MAX`, default 64) | read |
| `admin-write` | `foreign_keys=1` | discarded — **not returned to the pool** — after any DDL or any statement not emitted from a template | write, run typed DDL |
| `exporter` | `foreign_keys=1`, never inside a transaction | short-lived, never pooled | `VACUUM INTO` |

> Exactly three connection classes exist: `render-read` (`readonly:true` + `PRAGMA query_only=1` +
> `foreign_keys=1` + `busy_timeout`, never handed a statement built from text), `admin-write` (read-write,
> `foreign_keys=1`, discarded — not returned to the pool — after any DDL or any statement not emitted from a
> template), and `exporter` (a dedicated short-lived connection that is never in a transaction and is never
> pooled; the only class permitted to run `VACUUM INTO`); `exportSnapshot()` is the only function that opens an
> `exporter` connection, and `backupTenant()` calls it.

`exportSnapshot()` is the only function that opens an `exporter` connection, and `backupTenant()`
calls it. `query_only=1` is what closes Security's `VACUUM INTO` finding — a readonly handle wrote
16,384 B into `content/public/backup.db`, publishing a tenant's whole database under the web root.
Measured here (check 27): with `query_only=1`, `VACUUM INTO` and `CREATE TEMP TRIGGER` both fail
`attempt to write a readonly database`, while **`ATTACH` still succeeds** (`main,temp,other`). That
asymmetry is why the no-SQL-text rule stays load-bearing rather than decorative.

**Rejected alternative:** one readonly pool for everything, with `VACUUM INTO` denied by an allowlist
(Runtime D-R4 + Platform PD7). It fails because a deny-list is a thing to forget, and because PD7's
backup then needs the grant back, reopening the hole (register X9).

### 2.3 Boot order

1. Read the environment; refuse to start on any key matching `^SK_|^SKUNK_` (§4.3, C-19); refuse to
   start without `SKW_EDGE_TOKEN`, `SKW_SESSION_KEY`, `SKW_DOWNLOAD_TOKEN_KEY`, `SKW_IP_HASH_KEY`,
   `SKW_ADMIN_ORIGIN`, `SKW_BUILD_ID`.
> Amended by 02-errata.md E-9.

2. Assert `SKW_ARGON2_MAX_CONCURRENT=4`. `UV_THREADPOOL_SIZE` is **set by the image** —
   `Dockerfile.app` (`ENV UV_THREADPOOL_SIZE=8`), `docker-compose.yml` and `.env.example` — and the
   process refuses to start unless the inherited value is `8`; absent counts as not 8. libuv sizes the
   pool when the process starts, so a value exported after launch cannot resize it: this is a check
   that the image did its job, and it must **fail** rather than pass when an operator supplies the
   variable late. (C-6: 8 × 64 MiB peaks at 687 MB inside a 1 GB container; 4 × 19 MiB is 76 MiB.)
3. Open `control.db`; if it cannot be opened **or cannot be migrated**, exit **15** naming the
   migration. Every request needs the tenant map, so a half-migrated control plane is a silent outage
   (C-10).
4. Run `migrate --tenant all`: exits 0 with a JSON report naming every tenant it migrated and every
   tenant it could not. `app` starts regardless. A tenant below `tenant.db_version` serves
   `503 SKW_E_DM_SCHEMA_STALE` with `Retry-After: 5` on every route and is repaired lazily on its next
   request.
5. Upsert the image's component registry (`schema/component-registry.json`) into each tenant's
   `cms_component_registry` inside one transaction.
6. Load the enabled plugins into the per-tenant registry (§13.3.2). Load is **not** part of the boot gate:
   a package that fails to import, activate or verify is marked `failed`, gets an admin notice, and boot
   continues. A package that hangs the loop synchronously during load cannot be timed out here either —
   `skwctl plugin disable <id> --tenant <key>` from a shell is the recovery path, and it works because the
   flag is read from the database at this step (§13.3.6).

---

## 3. Module and file layout

Every path a Builder creates. `app/` is the Node service, and since D36 it is also where plugin code
runs; there is no `runner/`. A file not listed here is either generated (marked) or does not exist in v1.

```
skunkworks/
├── docker-compose.yml                 3 services: nginx, app, acme (D36 deleted plugin-runner)
├── Dockerfile.app                     multi-stage; ends on node:22-bookworm-slim, non-root uid 10001
├── .env.example                       every SKW_ name from §4.3 and nothing else
├── Makefile                           test / verify / verify-schema / verify-claims / verify-gitignore
├── package.json                       workspace root; scripts: build, test, lint, roundtrip
├── tsconfig.json                      strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes
│
├── schema/                            ← generated or frozen; see §4.6
│   ├── control.sql                    v2  (generated by scripts/model/gen_schema.py)
│   ├── site.sql                       v3  (generated; the target shape)
│   ├── r2-amendments.sql              v1→v2  (frozen history)
│   ├── r3-amendments.sql              v2→v3
│   ├── control-r2.sql                 v1→v2 control plane
│   ├── history/v1-baseline.sql        frozen v1 site.db, the migration input
│   ├── history/v1-control-baseline.sql
│   ├── export-projection.json         v2: 27 core tables + u_/p_ prefix rules
│   ├── error-codes.json               the frozen taxonomy + HTTP mapping
│   └── component-registry.json        the shipped component vocabulary (D21)
│
├── scripts/model/                     verification the SDS stands behind
│   ├── gen_schema.py                  one spec → both DDL files + both ER .puml + both .png
│   ├── validate_schema.py             every negative test against a real engine
│   └── verify_claims.py               27 checks; the numbers in §15 come from here
│
├── snippets/skunk-proxy.conf          the ONE include inside every proxy_pass location (§5.2)
├── nginx/
│   ├── nginx.conf                     includes conf.d; gzip; client_max_body_size 16m
│   ├── conf.d/00-default.conf         default_server: location / { return 404; }  (NOT server scope)
│   ├── conf.d/10-app.conf             generated: one server block per host, plus location /demo/
│   └── templates/server.tmpl          the generator's template; install.sh renders it
│
├── app/
│   ├── main.ts                        boot order §2.3; Fastify + Astro middleware mode
│   ├── env.ts                         SKW_ parse, prefix guard, argon2/threadpool assertions
│   ├── errors.ts                      SKW_E_ taxonomy; the JSON body shape; no stack, no path
│   ├── tenancy/
│   │   ├── resolve.ts                 resolveTenant() — the 10 steps of §5.3, in order
│   │   ├── normalise-host.ts          lowercase → strip :port → strip trailing dot → domainToASCII
│   │   ├── resolve-admin.ts           resolveAdminTenant(session) — session.tenant_id only
│   │   └── cache.ts                   tenant map cache, invalidated by a control.db version stamp
│   ├── db/
│   │   ├── classes.ts                 render-read | admin-write | exporter (§2.2); asserts on checkout
│   │   ├── migrate.ts                 per-tenant report, exit 0; control.db failure exits 15
│   │   └── snapshot.ts                exportSnapshot(): the only exporter entry point
│   ├── render/
│   │   ├── page.ts                    path → cms_page → shell → html
│   │   ├── components/                one file per registry entry (§10.2)
│   │   │   ├── index.ts               the registry, generated from schema/component-registry.json
│   │   │   ├── list.ts                the loop contract (§6.3)
│   │   │   ├── hero.ts prose.ts image.ts gallery.ts download-button.ts cta.ts form.ts embed.ts
│   │   │   └── shells/page.astro landing.astro post.astro index.astro
│   │   ├── bindings.ts                data-bind-* text/href/asset; escaping lives here and nowhere else
│   │   ├── islands.ts                 <script type="module" src="/islands/<name>.<sha8>.js">
│   │   └── props.ts                   JSON payload with <,>,&,U+2028,U+2029 escaped; schema-validated
│   ├── sources/
│   │   ├── spec.ts                    the query/view grammar; aggregate + group_by (C-18)
│   │   ├── compile.ts                 spec → parameterised statement; no string interpolation
│   │   ├── gate.ts                    EXPLAIN QUERY PLAN must contain SEARCH and no SCAN; cost_ms_max
│   │   └── cache.ts                   key = (tenant, source, rev, sha256(canonicalParams)); single-flight
│   ├── assets/
│   │   ├── store.ts                   content-addressed write; sha256 → content/media/hh/<sha>.<ext>
│   │   ├── farm.ts                    content/public/<key>.<ext> → ../media/hh/<sha>.<ext> (relative)
│   │   ├── sniff.ts                   magic bytes, re-encode images, EXIF strip, SVG rejected
│   │   └── repoint.ts                 the bounded audited rename (C-3, SKW_REPOINT_MAX_ROWS)
│   ├── downloads/
│   │   ├── code.ts                    Crockford 16-char mint, selector collision retry, argon2
│   │   ├── token.ts                   v1.<payload>.<mac>; 8 verification steps; no JSON.parse early
│   │   ├── redeem.ts                  the insert-first/update-second transaction (§7.3)
│   │   ├── watermark.ts               off-loop worker, 2000 ms budget, fail closed
│   │   └── serve.ts                   stat → range check → X-Accel-Redirect; 416 writes nothing
│   ├── admin/
│   │   ├── auth.ts                    argon2id, TOTP when the allowlist is empty, lockout
│   │   ├── session.ts                 __Host-sk-sess, rotation on privilege change, CSRF binding
│   │   ├── routes/                    /admin/t/<key>/… (pages, assets, codes, sources, plugins, audit)
│   │   └── ddl/
│   │       ├── ast.ts                 the 7-op union; ColumnSpec.type closed set (C-13)
│   │       ├── emit.ts                op → SQL; the FK target is derived from the type
│   │       └── run.ts                 BEGIN IMMEDIATE, ≤8 statements, postconditions, discard connection
│   ├── editor/
│   │   ├── grapes.ts                  GrapesJS init, blocks from the registry, locked islands
│   │   ├── canon.ts                   the fixpoint canonicaliser (§10.3)
│   │   └── validate.ts                the write validator: I8 ban, binding vocabulary, prop schema
│   ├── export/
│   │   ├── preflight.ts               the six refusals (§11.3)
│   │   ├── project.ts                 the projection union over the live DB (C-5)
│   │   ├── targets/cms.ts astro.ts static.ts
│   │   ├── bundle.ts                  BUNDLE.json (schema skunkworks/site-bundle/v3)
│   │   └── quiescence.ts              producer-side counting (O-19)
│   ├── plugins/
│   │   ├── manifest.ts                plugin.json parse + validate; main, hooks, capabilities (§13.3.1)
│   │   ├── verify.ts                  first-party key in the image | imported publisher key | revoked
│   │   ├── install.ts                 signature → tests → migrations → registry rows
│   │   ├── migrate.ts                 the host executor: 4 ops, no drop_table/rename/drop_column
│   │   ├── runtime.ts                 load/activate/deactivate: import() + cache-buster (§13.3.2)
│   │   ├── registry.ts                per-tenant hooks/endpoints/screens; prune on disable (§13.3.3)
│   │   ├── context.ts                 the per-request facade + the one capability check (§13.3.5)
│   │   └── hooks.ts                   the twelve named hooks and their return-type rules (§13.3.4)
│   ├── cli/
│   │   └── skwctl.ts                  admin bootstrap / reset-totp / reset-password (§11.6a)
│   └── security/
│       ├── csrf.ts                    session-bound token + exact Origin
│       ├── csp.ts                     the one header string (§10.5)
│       ├── limits.ts                  per-IP, per-code, per-tenant buckets
│       └── audit.ts                   chain append + daily seal
│
├── plugins/                           first-party packages we ship (each with plugin.json + tests)
│   └── contact/                       the reference plugin: one table, one form, one setting
│
├── tools/
│   ├── seed_control.py                control.seed.json → control.db, one transaction
│   ├── bundle_verify.ts               BUNDLE.json + sha256 + readlink regex + source_counts
│   └── nginx_gen.ts                   host list → conf.d/10-app.conf
│
├── install.sh                         verify → control.sql → seed → .env → bootstrap → compose up; exit 11/12/15/16
└── docs/
    ├── sds/SDS.md  docs/sds/01-verification.md  docs/sds/diagrams/*.puml,*.png
    └── debate/    (history; not authoritative)
```

> Amended by 02-errata.md E-10, E-19, **E-31** (`Dockerfile.runner` and `runner/**` are deleted, not
> deferred: a Builder that finds them in a branch is looking at code D36 retired).

§3 lists every path in the build, across all four slices; **§16's `Contains` list is the per-slice
authority** for who creates a path in which slice. `app/plugins/**` is **S4** (plugin install, enable, hook
dispatch). A builder creates neither a stub nor a placeholder for a path outside its slice's `Contains`
list, and a boot log line that names a deferred step is the requirement, not a gap.

### 3.1 The five rules that keep the layout honest

1. **One file per component** in `app/render/components/`, and its registration is generated from
   `schema/component-registry.json`. The editor, the SSR renderer and the CSS cannot drift because
   they read the same list (§10.2).
2. **`bindings.ts` is the only place HTML escaping happens.** A component that escapes its own text is
   a component that will forget.
3. **`db/classes.ts` exports three factories and no fourth.** A new `new Database(...)` anywhere else
   fails review; a lint rule (`no-restricted-imports`) blocks importing `better-sqlite3` outside it.
4. **The DDL runner never sees a string.** `admin/ddl/emit.ts` takes a typed union; the only SQL text
   in the process is what it emits from a template (§9.4).
5. **`export/` may import `db/snapshot.ts` and nothing else from `db/`.** The exporter is the only
   caller that may `VACUUM INTO`.

---

## 4. Data model

The DDL is generated from one spec (`scripts/model/gen_schema.py`), and both ER diagrams are emitted
from the same spec, so **ER ↔ DDL parity is mechanical**: `make test` check 1 compares the set of
`entity` names in each `.puml` against the set of `CREATE TABLE` names in both `.sql` files and fails
on any difference. Today: **35 entities == 35 CREATE TABLE**, 298 columns across both files
(27 tables / 229 columns in `site.db`, 8 / 69 in `control.db`), 16 FK clauses in `site.db` and 5 in
`control.db`, 21 explicit indexes and 5 triggers in `site.db`.

Files: `docs/sds/diagrams/er-data-model.puml` + `.png` (the SDS copy) and
`docs/debate/diagrams/r1-data-model.puml` + `.png` (the debate artifact, regenerated at v3).

### 4.1 Tables, classes and export classes

Four namespaces, no fifth (C-13). The class is asserted as a postcondition inside every DDL
transaction; a table matching none of them aborts the transaction.

| Class | Pattern | Owner | DDL authority | Export class source |
|---|---|---|---|---|
| core | `cms_[a-z0-9_]+` | the image (Drizzle migrations) | image only; the runner refuses, and the builder's regex `^u_[a-z0-9_]+$` cannot express it | `schema/export-projection.json` |
| user | `u_[a-z0-9_]+` | the tenant's admin | the DDL runner (typed AST, ≤8 statements, one `BEGIN IMMEDIATE`) | `schema/export-projection.json` (by prefix rule: `u_*` = `rows`) |
| plugin | `p_<id>_[a-z0-9_]+`, `id` matching `^[a-z][a-z0-9]{1,19}$` | the plugin's declarations, applied by the host | the migration executor only; the grammar excludes `drop_table`, `rename`, `drop_column` | the installed manifest's `tables[].export` |
| plugin-system | `cms_plugin_[a-z0-9_]+` | the image | image only | `schema/export-projection.json` |

The postcondition, run before `COMMIT` (connection discarded on failure):

```sql
SELECT count(*) FROM sqlite_master WHERE type='table'
  AND name NOT LIKE 'cms\_%' ESCAPE '\' AND name NOT LIKE 'u\_%' ESCAPE '\'
  AND name NOT LIKE 'p\_%'   ESCAPE '\' AND name NOT LIKE 'sqlite\_%' ESCAPE '\'
```
must be `0`. A `p_` prefix CHECK written as `GLOB 'p_*'` accepts the empty id `'p_'`; the emitter
uses `GLOB 'p_?*'` (measured — the same off-by-one that made `/` uninsertable). `make test` proves
`'p_'` is rejected and `p_contact_message` accepted.

**`site.db` (27 tables, v3).** `M` is the row count class, `E` the export class.

| Table | Purpose | E |
|---|---|---|
| `cms_settings` | site-level EAV; keys are registry-declared | filtered (`demo.*`, `billing.*` out) |
| `cms_component_registry` | the editor vocabulary; `list` owns the loop contract, `shell` the templates | rows |
| `cms_page` | one document per page; `body_html` is the editor's model | rows |
| `cms_page_revision` | append-only undo history, carries the page `rev` | rows |
| `cms_nav` | adjacency list, position unique per (location, parent) | rows |
| `cms_asset` | media identity; `storage_path` is `GENERATED … STORED` | rows |
| `cms_asset_alias` | old keys that 301 | rows |
| `cms_asset_variant` | derived renditions, stored path | rows |
| `cms_asset_link` | the usage graph; deletion refused while a link exists | rows |
| `cms_asset_bundle` / `cms_asset_bundle_item` | sellable sets | rows |
| `cms_download_code` | `code_selector` (4, plaintext, UNIQUE) + `code_hash` (argon2id PHC) | empty |
| `cms_download_code_archive` | `uses` snapshot before event pruning (O-34) | empty |
| `cms_download_event` | the redemption ledger; `jti` + `kind` | empty |
| `cms_watermark_render` | bounded transient renders, `expires_at` | empty |
| `cms_form` / `cms_form_submission` | core forms; submissions are our PII | rows / empty |
| `cms_datasource` | `view` \| `query`; aggregate grammar; `cost_ms_max` | rows |
| `cms_view_registry` | migration-owned views | rows |
| `cms_table_registry` | one row per `u_*`/`p_*` table, with the class/prefix agreement | rows |
| `cms_trigger_registry` | every trigger, by name, with its purpose | rows |
| `cms_audit` | tenant-plane audit, hash-chained, append-only | empty |
| `cms_redirect` | internal-only targets (open redirect closed) | rows |
| `cms_plugin_installed` | manifest, root hash, signature state, enabled | rows |
| `cms_plugin_migration` | the host executor's ledger | rows |
| `cms_plugin_setting` | plugin settings, `secret` write-only | filtered (`secret = 0`) |
| `cms_plugin_revoked` | local revocation roots | empty |

**`control.db` (8 tables, v2).** `tenant`, `domain`, `user_account`, `session`, `audit_log`,
`audit_seal`, `deploy_token`, `control_migration`. Never exported (C-24).

### 4.2 The invariants, each with the check that proves it

| # | Invariant | Proved by |
|---|---|---|
| I1 | `cms_asset.key` is identity; content never stores a path or a checksum | check 11 (generated column) |
| I2 | A referenced key cannot be renamed — a foreign key, not application code | check 3 |
| I3 | `storage_path` cannot be written by any driver, including the CLI | check 11 |
| I4 | `sha256` is immutable by trigger, and the asset delete guard fires with `foreign_keys=OFF` | checks 11, 12 |
| I5 | A table rebuild carries `sqlite_sequence` forward or ids are reissued | check 5, and the 4 rebuilds in `r3` |
| I6 | A rebuild runs with `foreign_keys=OFF` outside the transaction | check 13 (with it ON, 2 revisions become 0) |
| I7 | `(jti) WHERE kind='first'` is unique and tolerates NULL jti | check 15 |
| I8 | `uses` moves only after the `first` row is inserted | checks 14, 22 |
| I9 | A page body contains no `<script`, `<style`, `<!--`, `javascript:` or `srcdoc` (and no `on<name>=` from the validator) | check 26 |
| I10 | Every table is in exactly one class, and every table has an export class | checks 1, 16, 23 |
| I11 | Every trigger is registered; a trigger that is not registered fails the DDL postcondition | check 1 (validate) |
| I12 | `cms_page.path` is canonical: `/` insertable, `..`, `//`, trailing `/` rejected | check 10 |
| I13 | `cms_redirect.to_path` is internal-only | check 10 |
| I14 | `cms_page.template` is a slug resolved against the shell registry | check 26 |
| I15 | `cms_audit` rows are immutable and chained; the daily seal detects a deleted tail | check 25 |
| I16 | A `p_*` table needs a manifest export class or the install is refused | check 23 |
| I17 | `cms_download_event.bytes_declared` is `NOT NULL` with no default; `bytes_sent` is nullable | check 15 (a row without it is rejected) |

### 4.3 Environment, error codes, and why both are files, not tables

> Amended by 02-errata.md E-13, E-4.

> Every environment variable begins `SKW_`; the table in §4.2 is the complete list; the process refuses to
> start when any environment key matching `^SK_|^SKUNK_` exists, printing the offending key and its
> replacement, and every error code matches `^SKW_E_(RT|DM|SEC|PLT|EXP|PL)_[A-Z0-9_]+$`.

(§4.2 of the register is the table below; in this document the environment table and the taxonomy both live
in this section.)

**Environment: one prefix, `SKW_`. Twenty-three names, and this table is the complete list.**

| Var | Default | Required | Meaning |
|---|---|---|---|
| `SKW_DATA_DIR` | `/srv/data` | yes | root; `control.db`, `tenants/`, `backups/`, `plugins/`, `trust/`, `logs/` derive from it |
| `SKW_DB_POOL_MAX` | `64` | no | LRU size of `render-read` handles |
| `SKW_DB_BUSY_TIMEOUT_MS` | `5000` | no | per-connection `busy_timeout`; 0 loses 150/200 writes |
| `SKW_EDGE_TOKEN` | — | **yes** | the value in `X-Skunkworks-Edge`; boot fails without it |
| `SKW_EDGE_TRUSTED_CIDRS` | `127.0.0.1/32,172.16.0.0/12` | no | peer allowlist for the edge proof |
| `SKW_SESSION_KEY` | — | **yes** | session-id signing and the preview token |
| `SKW_DOWNLOAD_TOKEN_KEY` | — | **yes** | download token HMAC |
| `SKW_IP_HASH_KEY` | — | **yes** | `ip_hash` HMAC (plain SHA-256 over IPv4 is 54.9 min/core) |
| `SKW_ADMIN_ORIGIN` | — | **yes** | exact `Origin` allowed on admin non-GET |
| `SKW_ARGON2_MAX_CONCURRENT` | `4` | no | semaphore; 4 × 19 MiB = 76 MiB |
| `SKW_DDL_MAX_STATEMENTS` | `8` | no | hard cap per DDL request |
| `SKW_RENDER_MODE` | `live` | no | `live` \| `snapshot` (exporter sets `snapshot`) |
| `SKW_EXPORT_NOW` | — | when `snapshot` | the only clock a snapshot may read |
| `SKW_SCHEMA_EDIT` | `off` | no | `off` hides the table builder entirely (no disabled button) |
| `SKW_FLEET_MODE` | `1` in our fleet, `0` in every bundle | no | `0` disables `fleet_admin` |
| `SKW_BUILD_ID` | git sha baked at build | **yes** | reported by `/healthz` |
| `SKW_SMTP_URL` | — | when `SKW_EMAIL_MODE=smtp` | `smtp://user:pass@host:587` |
| `SKW_SNAPSHOT_MAX_COMBOS` | `1024` | no | static/Astro snapshot enumeration cap |
| `SKW_SNAPSHOT_MAX_BYTES` | `2097152` | no | per-source snapshot budget |
| `SKW_REPOINT_MAX_ROWS` | `5000` | no | cap on the explicit asset re-point (C-3) |
| `SKW_BOX_RPS` | `192` | yes in production | the box's measured four-source page throughput; set by the release gate on the target vCPU class (C-20) |
| `SKW_EMAIL_MODE` | `off` | no | `off` \| `smtp`; `off` returns a code once in the webhook 201 body (O-28) |
| `SKW_ADMIN_ALLOWLIST` | (empty) | no | comma-separated CIDRs allowed to reach the admin host; enforced by nginx, read by the app for §9.1's two consequences (§9.1a) |

Deleted names, with their replacements, so a reader of an old paper can find the survivor:
`SKW_DATA_DIR`←`SKUNKWORKS_CONTROL_DB`/`SKUNK_CONTROL_DB`; `SKW_DATA_DIR`←`SKUNKWORKS_TENANTS_DIR`/`SKUNK_TENANTS_DIR`;
`SKW_EDGE_TOKEN`←`SKUNK_EDGE_TOKEN`/`SKUNKWORKS_PROXY_TOKEN`; `SKW_EDGE_TRUSTED_CIDRS`←`SKUNKWORKS_TRUSTED_PROXY_CIDRS`/`SK_TRUST_PROXY`;
`SKW_DOWNLOAD_TOKEN_KEY`←`DOWNLOAD_HMAC_KEY`; `SKW_ARGON2_MAX_CONCURRENT`←`SK_ARGON2_MAX_CONCURRENT`;
`SKW_DDL_MAX_STATEMENTS`←`SK_DDL_MAX_STATEMENTS`; `SKW_IP_HASH_KEY`←`SK_IP_HASH_KEY`; `SKW_SESSION_KEY`←`SK_SESSION_KEY`/`SESSION_KEY`;
`SKW_ADMIN_ORIGIN`←`SK_ADMIN_ORIGIN`; `SKW_FLEET_MODE`←`SKUNK_MODE`/`SKUNK_TENANT_KEY`; `SKW_DB_BUSY_TIMEOUT_MS`←`SKUNK_DB_BUSY_TIMEOUT_MS`/`SKW_DB_BUSY_TIMEOUT_MS`.

Deleted with no replacement: `SK_CODE_PEPPER` (C-6), `SK_RATE_KEY` (the rate-limit bucket key is
`code_selector`), `SK_WEBHOOK_SECRET_<TENANT>` (per-tenant secrets live in `cms_settings` as `secret`
rows), `SK_TENANT_HEADER`, `SKUNKWORKS_PUBLIC_PORT`/`ADMIN_PORT` (the app listens on one port; the
admin surface is a host, C-25).

**Error-code taxonomy.** `^SKW_E_(RT|DM|SEC|PLT|EXP|PL)_[A-Z0-9_]+$`. The area is the domain that owns
the decision, not the layer that reported it.

**Every response the app emits** has a JSON taxonomy body — `{error:{code, message?, requestId,
detail?}}` — and never a stack, a path, a SQL fragment or a key. Four classes of response are
generated before or outside the app, and they are named here so that no gate asserts a body the app
cannot produce: nginx's `default_server` 404 for a `Host` that maps to nothing; nginx's 413 when
`client_max_body_size 16m` is exceeded; nginx's 400 for a request it cannot parse; and Node's 400 for
an HTTP/1.1 request with no `Host`. Those four, and **nginx's `403` for a peer outside `SKW_ADMIN_ALLOWLIST` on the admin host** (§9.1a),
are the only exceptions; each is asserted as such (status and `Content-Type`), and any other response
that is not a taxonomy body is a defect. The denied peer's body is nginx's on purpose: a taxonomy body
there would publish the product's error registry to an unauthenticated network peer.

> Amended by 02-errata.md E-13, E-17.

`schema/error-codes.json` holds the **72** codes, their HTTP mapping and their `Retry-After` values.
`validate_schema.py` asserts that every `SKW_E_*` string raised by `schema/*.sql` is a member and
matches the shape — so a trigger cannot raise a code the app has no mapping for. Two codes are raised
from inside the database today: `SKW_E_DM_ASSET_IN_USE` and `SKW_E_DM_COLUMN_IMMUTABLE`.

**A credential login failure is its own code, and it is not `SKW_E_SEC_CODE_INVALID`.** `CODE_INVALID`
is §7.2's decision about a redeemed download code; an admin login is a different decision, owned by a
different mechanism (`user_account.password_hash`, `user_account.totp_secret`), and the two must not
share a code — one counter that mixes them cannot be alerted on. The login code is:

| Code | HTTP | Raised when | Cacheable |
|---|---|---|---|
| `SKW_E_SEC_AUTH_INVALID` | 401 | an admin login attempt fails at the identity, password or TOTP step; the three are one response | no — `Cache-Control: no-store` |

Its `message` is the fixed literal `invalid credentials`, produced at the call site and not from the
emitter's table. It carries no `Retry-After` (that is the lockout's, 429 `SKW_E_SEC_RATE_LIMITED`,
unchanged) and no `WWW-Authenticate` (this surface implements no HTTP authentication scheme).

**The three login failures are one response, and timing is part of the response.** A wrong password, an
unknown email and a wrong-or-missing TOTP answer with the same status (401), the same code, and a body
that is byte-identical after `requestId` is substituted; no `Set-Cookie`, no `Location`, no
`detail`. With TOTP mandatory, **exactly one TOTP computation runs on every attempt** — against the
row's secret, or against a fixed dummy secret when the row has none — and it runs before the password
verdict is used; with TOTP optional, none runs. The work an attempt performs is therefore a function of
the configuration and never of the credentials submitted, so "the password was right, because a TOTP
step then ran" is not observable. Medians across the three causes stay within 20 %, measured with at
least 40 samples each; a password-only failure and a TOTP failure are compared in the same test, not
only the unknown-email and wrong-password pair.

**What the server may still know.** `audit_log` records the cause it observed —
`reason ∈ {unknown_user, password, totp, locked}` in `after_json` — because an operator investigating a
break-in needs it and an attacker cannot read that table. The wire distinguishes nothing, and the code
is one code.

> Amended by 02-errata.md E-16.

**A response's code and its status are one decision.** `app/errors.ts` maps every code to exactly one
status from `schema/error-codes.json`, and a framework-level failure is translated **by its own status
class** into the four codes below — never into a code whose HTTP mapping disagrees with the status
being sent. `SKW_E_PLT_TENANT_UNAVAILABLE` is raised by row 10 of §5.3 and nowhere else: it means "the
tenant resolved and its database is unusable", and it is not a catch-all. An unknown thrown value is
`500 SKW_E_PLT_INTERNAL` carrying `requestId` and no `detail`.

| Code | HTTP | Raised when | Cacheable |
|---|---|---|---|
| `SKW_E_RT_PAGE_NOT_FOUND` | 404 | the tenant resolved, `/healthz`, `/readyz` and `/media/` are ruled out, and `cms_page` has no row for the path | no — `Cache-Control: no-store` |
| `SKW_E_PLT_INTERNAL` | 500 | any unhandled error: a thrown non-`AppError`, a render failure with no taxonomy cause, a bug | no — `no-store` |
| `SKW_E_PLT_REQUEST_INVALID` | 400 | the request is refused before a route runs: malformed JSON body, unparseable URL, a content type the route cannot accept | no — `no-store` |
| `SKW_E_PLT_BODY_TOO_LARGE` | 413 | a request body over 16 MiB reached the app | no — `no-store` |

**None of the four is cacheable**, and none adds an exception to §5.5: every response carrying a
taxonomy body is `Cache-Control: no-store`, and `SKW_E_RT_PAGE_NOT_FOUND` is deliberately the least
cacheable of them — a page published a second later must not be shadowed by a stored 404, and v1 has
no CDN. The app's body limit is 16 MiB, the same number as `client_max_body_size 16m` in §12.3; it is
not a new environment variable (§4.3's table stays at twenty-two names).

**Rejected alternative:** a `cms_error_code` table. It would need a migration per code, could never be
the compile-time constant the emitter needs, and would put a query on the error path.

| Area | Codes (complete for v1) |
|---|---|
| `RT` | `SOURCE_UNKNOWN`, `SOURCE_UNINDEXED`, `SOURCE_BUDGET`, `SOURCE_TIMEOUT`, `LOOP_CONGESTED`, `TEMPLATE_UNKNOWN`, `BODY_FORBIDDEN`, `ROUNDTRIP_UNSTABLE`, `ASSET_MISSING`, `PAGE_NOT_FOUND` |
| `DM` | `SCHEMA_STALE`, `DDL_REJECTED`, `DDL_POSTCONDITION`, `FK_VIOLATION`, `KEY_IN_USE`, `BUSY`, `QUOTA`, `COLUMN_IMMUTABLE`, `ASSET_IN_USE`, `ASSET_UNSTAMPABLE` |
| `SEC` | `AUTH_INVALID`, `CSRF`, `CODE_INVALID`, `RATE_LIMITED`, `TOKEN_INVALID`, `TOKEN_MISMATCH`, `USES_EXHAUSTED`, `WATERMARK_FAILED`, `AUDIT_SEAL`, `ROLE_DISABLED`, `UPLOAD_REJECTED` |
| `PLT` | `EDGE_PROOF`, `TENANT_HEADER`, `TENANT_UNKNOWN`, `TENANT_UNAVAILABLE`, `CERT_PENDING`, `DB_BUSY`, `DISK_FULL`, `INTERNAL`, `REQUEST_INVALID`, `BODY_TOO_LARGE` |
| `EXP` | `GATED_ASSETS`, `MEDIA_GRAPH_OPEN`, `PARAMETERISED`, `NOT_QUIESCENT`, `INSUFFICIENT_DISK`, `TENANT_NOT_FOUND` |
| `PL` | `SCHEMA`, `NO_TABLE`, `NO_EXPORT_CLASS`, `NO_SETTING`, `SETTING_INVALID`, `ROW`, `QUERY`, `TOO_MANY`, `TOO_LARGE`, `CONTENT_TYPE`, `REJECTED`, `RATE`, `QUOTA`, `PLUGIN_ERROR`, `UNAVAILABLE`, `DOWNGRADE`, `DESTRUCTIVE_UPGRADE`, `ARCHIVE_FAILED`, `TESTS_STALE`, `SIGNATURE`, `REVOKED`, `BROKEN`, `EXPORT_REFUSE`, `EXPORT_FORWARD_NO_TARGET`, `EXPORT_SNAPSHOT` |

### 4.4 The DDL AST (C-13)

The runner accepts only this union — no strings, no reference objects:

```ts
type DdlOp =
  | { op: 'create_table'; name: string; columns: ColumnSpec[] }      // name matches ^u_[a-z0-9_]+$
  | { op: 'add_column';   table: string; column: ColumnSpec }
  | { op: 'drop_column';  table: string; column: string; rebuild?: true }
  | { op: 'rename_table'; from: string; to: string }
  | { op: 'create_index'; table: string; name: string; columns: string[]; unique: boolean }
  | { op: 'drop_index';   name: string }
  | { op: 'drop_table';   name: string };

// ASSET -> cms_asset(key), PAGE -> cms_page(path), RELATION -> u_<name>(id)
type ColumnSpec = {
  name: string;                       // ^[a-z][a-z0-9_]{0,39}$
  type: 'TEXT'|'INTEGER'|'REAL'|'BLOB'|'NUMERIC'|'BOOLEAN'|'DATE'|'ASSET'|'PAGE'|'RELATION';
  notNull?: boolean; default?: string | number | boolean; relation?: string;
};
```

Five refusals, each `422 SKW_E_DM_DDL_REJECTED` with a `reason`, each before any SQL is emitted:

| Statement | Refusal |
|---|---|
| `add_column` with `notNull` and no literal default | `reason=default_required` (SQLite: "Cannot add a NOT NULL column with default value NULL") |
| `drop_column` on an indexed or FK-referenced column, without `rebuild: true` | `reason=rebuild_required`; the UI disables the control rather than offering a button that throws |
| more than 40 columns or 8 indexes | `reason=limit` |
| a name not matching `^u_[a-z0-9_]+$`, or a `cms_*`/`p_*` name | `reason=reserved_prefix` |
| more than `SKW_DDL_MAX_STATEMENTS` operations | `reason=too_many_statements` |

**The FK target is derived from the type, never supplied.** A caller-supplied `{table:'cms_asset',
column:'key'}` is one forgotten allowlist away from `REFERENCES cms_page(path)` on a column that is
supposed to be an asset. Deriving it makes the bad statement unrepresentable rather than rejected.

> The DDL runner accepts only Data Model's seven-operation `DdlOp` union with
> `ColumnSpec.type ∈ {TEXT,INTEGER,REAL,BLOB,NUMERIC,BOOLEAN,DATE,ASSET,PAGE,RELATION}`; the FK target is
> derived from the type and a caller-supplied reference object does not exist; `add_column` with `notNull` and
> no literal default is refused with `422 SKW_E_DM_DDL_REJECTED reason=default_required`;
> `drop_column` on an indexed or FK-referenced column is refused with `reason=rebuild_required` unless the
> caller asked for the rebuild, and the rebuild runs the 12-step procedure with `foreign_keys=OFF` outside the
> transaction and restores `sqlite_sequence` inside it.

**Rejected alternative:** Security's `TableSpec` with a `ref` object and a `datetime` type. `datetime`
has no SQLite storage class (it is TEXT or INTEGER, and the choice is a contract), and `ref` is the
hole above. Register X5 records that one union had to be authoritative; this is it.

### 4.5 Migrations

Four files, two chains, and both chains are *proved* against the target DDL every run (check 20):

> Amended by 02-errata.md E-3, E-14, E-6.

```
v1 site.db   ──r2-amendments.sql──► v2 ──r3-amendments.sql──► v3  ==  schema/site.sql
v1 control.db ──control-r2.sql──► v2 ──control-r3.sql──► v3  ==  schema/control.sql
```

Check 20 compares, on both planes and in both directions: the table set; `PRAGMA table_info` per table
as `(name, type, notnull)`; the `sqlite_master.sql` text of every table, which is where `CHECK`
constraints live; the trigger set; and the `sqlite_master.sql` text of every trigger — normalising only
identifier quoting (`"x"` and `x` are the same identifier) and runs of whitespace. Column *order* and
defaults are still not compared, for the two reasons below. A name-set comparison is **not** this
check: a table that lost a `CHECK` passes `(type, name)`, and a trigger body that lost a column passes
a trigger-name comparison. `test/migrate.test.ts` uses the same comparison against
`schema/site.sql` and reports the differing object by name.

Column *order* is not compared, deliberately: the migration appends a column that the fresh DDL
declares in the middle (`cms_page_revision.rev`), which SQLite allows and no query can observe.
Defaults are not compared either, which is why `cms_watermark_render.expires_at` carries an epoch
default in the migration only — it exists because SQLite demands a non-NULL default on
`ALTER ADD NOT NULL`, and a legacy render is due for deletion the moment it is created.

`r3` has two preconditions that refuse rather than rewrite:

1. **A v2 file with any `cms_download_code` row refuses**, with the constraint name as the message:
   `legacy_12_char_codes_have_no_v3_selector`. A 12-character code is stored as
   `HMAC(code_lookup)` + argon2id; no function of that HMAC yields the first four characters of a
   code nobody can read back, and inventing a selector would produce a row that can never match. The
   operator's remedy is one audited reissue (§7.6). Check 20 runs this refusal and asserts the message.
2. **A v2 page whose `body_html` contains a banned construct refuses**, because the I8 CHECK cannot
   accept it. `migrate` reports that tenant; it serves `503 SKW_E_DM_SCHEMA_STALE`; no content is
   rewritten silently. A page someone hand-edited with a script is a decision, not a typo.

**Rejected alternative:** rewriting pages or revoking codes inside the migration. It makes a
data-loss incident look like a successful upgrade, and `make test` would still be green.

The four rebuilds (`cms_page`, `cms_download_code`, `cms_download_event`, `cms_table_registry`) all
follow the 12-step procedure: `foreign_keys=OFF` **outside** the transaction, `BEGIN IMMEDIATE`,
`CREATE …_r3`, `INSERT … SELECT` with an explicit column list, **`DROP TRIGGER` for every trigger whose
body or `ON` clause names the table being rebuilt**, `DROP TABLE`, `RENAME`, recreate every index,
restore `sqlite_sequence` from a temp copy, `COMMIT`, `foreign_keys` back on; the triggers dropped in the
rebuild are recreated verbatim, with their `cms_trigger_registry` rows, later in the same transaction.
The trigger-drop step is not optional: SQLite ≥ 3.25 re-parses every trigger when a table is renamed,
so a trigger that names the dropped table aborts the rename. `r3`'s two such triggers are
`trg_cms_asset_delete_guard` and `trg_cms_download_code_hash_immutable`, and both are dropped before
`DROP TABLE cms_download_code` (A1) and recreated in A9.

**`PRAGMA legacy_alter_table` is set by nobody** — not by `app/db/migrate.ts`, not by
`scripts/model/verify_claims.py`, not by an operator, not by `install.sh`. With the trigger order above
the chain applies on a modern SQLite with the pragma at its default, and convergence (check 20, §4.5)
is what proves the outcome. A migration that needs the pragma to apply is a migration with the defect
above, not a migration with a workaround. Rebuilding `cms_download_event` copies the event table once;
it is append-only, so the copy is sequential, and it exists to remove the `DEFAULT 0` on
`bytes_declared` (a default that would let an INSERT write a byte count nobody observed).

### 4.6 What is generated and what is frozen

> Amended by 02-errata.md E-3.

| File | Generated by | Rule |
|---|---|---|
| `schema/control.sql`, `schema/site.sql` | `scripts/model/gen_schema.py` | never edited by hand |
| `docs/*/diagrams/{r1-data-model,er-data-model}.puml` + `.png` | same script | never edited by hand |
| `schema/history/v1-*.sql` | frozen at commit `cc1a5b4` | **never** regenerated; editing it invalidates check 20 |
| `schema/r2-amendments.sql` | hand-written history | frozen once v3 shipped |
| `schema/r3-amendments.sql`, `schema/control-r2.sql`, `schema/control-r3.sql` | hand-written | edited only with a check that proves the change |
| `schema/export-projection.json`, `error-codes.json`, `component-registry.json` | hand-written | a table or code added without an entry fails `make test` |

---

## 5. Tenancy and request lifecycle

### 5.1 The frozen header contract

**Headers, exactly three, and no others carry tenancy.**

```
X-Skunkworks-Tenant: <key>        # "" on every host-routed location; <key> on every path-prefix location
X-Skunkworks-Edge:   <token>      # SKW_EDGE_TOKEN, rendered into the snippet by install.sh
X-Forwarded-Prefix:  /demo/<key>  # path-prefix locations only; the only source of tenant.prefix
```

The header name is a constant. There is no `SKW_TENANT_HEADER` setting; a deployment cannot rename it.

> `X-Skunkworks-Tenant` is `""` on every host-routed location and the tenant key on every path-prefix
> location; an absent or empty header means *no edge assertion* and the tenant is resolved from the
> normalised `Host`; a non-empty header is honoured only when `X-Skunkworks-Edge` equals `SKW_EDGE_TOKEN`
> **and** the peer address is inside `SKW_EDGE_TRUSTED_CIDRS`, and otherwise the request is
> `421 SKW_E_PLT_EDGE_PROOF`; a non-empty header that fails `^[a-z0-9][a-z0-9-]{0,62}$`, contains a comma,
> or disagrees with `X-Forwarded-Prefix` is `400 SKW_E_PLT_TENANT_HEADER`; a request for which no tenant can
> be resolved is `404 SKW_E_PLT_TENANT_UNKNOWN`, and a resolved tenant whose database cannot be opened is
> `503 SKW_E_PLT_TENANT_UNAVAILABLE`.

**Why the empty header is legal.** An empty header is not evidence of an attack; it is the *absence* of
an assertion, and after the proxy snippet it is the normal state of every host-routed request. A rule
that 400s it converts a correct configuration into a total outage — 100 % of production traffic is a
400 — which is the loudest possible failure aimed at the wrong layer (C-1).

### 5.2 The nginx snippet

`snippets/skunk-proxy.conf`, included inside **every** `location` that contains `proxy_pass` — a CI
check asserts `count(location-with-proxy_pass) == count(skunk-proxy include)`:

> Amended by 02-errata.md E-11.

```nginx
proxy_http_version 1.1;
proxy_set_header Host               $host;
proxy_set_header X-Real-IP          $remote_addr;
proxy_set_header X-Forwarded-For    $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto  $scheme;
proxy_set_header X-Forwarded-Host   $host;
proxy_set_header X-Skunkworks-Edge  "<SKW_EDGE_TOKEN rendered at install>";
proxy_set_header X-Skunkworks-Tenant "";          # fail closed: a client claim never survives
proxy_set_header X-Forwarded-Prefix  "";          # fail closed: a client prefix never survives
proxy_ignore_headers X-Accel-Redirect;            # on any location proxying to a non-app upstream
proxy_connect_timeout 2s;
proxy_send_timeout    20s;
proxy_read_timeout    20s;
proxy_next_upstream   off;
```

The path-prefix location still overrides exactly two lines after the include
(`X-Skunkworks-Tenant $demo_key`, `X-Forwarded-Prefix "/demo/$demo_key"`), so those two overrides are
the only way either header acquires a value.

The `default_server` answers 404 from `location / { return 404; }` — **not** from server scope, which
was measured to swallow the health location and make the edge `(unhealthy)`.

> Amended by 02-errata.md E-1.

### 5.3 Resolution algorithm, in order

`peer` = `req.socket.remoteAddress`; `hdr` = `X-Skunkworks-Tenant`; `edge` = `X-Skunkworks-Edge`;
`prefix` = `X-Forwarded-Prefix`. **`hdr present`** means the header exists on the request at all,
including with an empty value; **`hdr non-empty`** means it exists and its value is not `""`.
**`listener`** is `'admin'` when the normalised `Host` equals the host component of
`SKW_ADMIN_ORIGIN`, and `'public'` otherwise; the path plays no part in it (E-2).

The rows are executed once, in this order, first match wins, and no row is evaluated after a row has
produced a response. Every row is reachable: row 1 answers every admin-listener request that carries
the tenant header **at all**, so rows 3–6 all run with `listener = 'public'`, and rows 7 and 8 split
the remaining header-absent case exhaustively.

| # | Condition | Outcome |
|---|---|---|
| 1 | `listener = 'admin'` **and** `hdr present` | `421 SKW_E_PLT_EDGE_PROOF` — the admin never takes a tenant from a header, empty or not (§9.2: "present at all") |
| 2 | `peer ∉ SKW_EDGE_TRUSTED_CIDRS` **and** any `X-Skunkworks-*` header present (including an empty `X-Skunkworks-Tenant`) | `421 SKW_E_PLT_EDGE_PROOF` |
| 3 | `hdr non-empty` **and** `edge ≠ SKW_EDGE_TOKEN` | `421 SKW_E_PLT_EDGE_PROOF` |
| 4 | `hdr non-empty` **and** (`hdr` fails `^[a-z0-9][a-z0-9-]{0,62}$` **or** contains `,`) | `400 SKW_E_PLT_TENANT_HEADER` |
| 5 | `hdr non-empty` **and** `prefix` present **and** prefix key ≠ `hdr` | `400 SKW_E_PLT_TENANT_HEADER` |
| 6 | `hdr non-empty` (valid, public listener) | tenant = `hdr`; `via='header'`; `tenant.prefix` = `prefix` when present, else `""` |
| 7 | `listener = 'admin'` (so `hdr` is absent or `""`) | tenant = `session.tenant_id`; `via='session'`; no session → `404 SKW_E_PLT_TENANT_UNKNOWN` |
| 8 | `listener = 'public'` (so `hdr` is absent or `""`) | tenant = `domain.host` = `normalise(Host)`; `via='host'`; `tenant.prefix` = `""`; no row → `404 SKW_E_PLT_TENANT_UNKNOWN` |
| 9 | tenant resolved **and** `tenant.status ∈ {'suspended','archived'}` | `404 SKW_E_PLT_TENANT_UNKNOWN` |
| 10 | tenant resolved **and** `site.db` unusable | one code per cause, see below |

`normalise(Host)` = lowercase → strip `:port` → strip trailing dot → `domainToASCII` → reject anything
not `[a-z0-9.-]`. No default tenant at any row. `Host` is never parsed twice: the resolver is the
only reader.

**Why row 1 is first, and where it differs from §4.1.** §4.1's rows 7 and 8 disagree for the empty
header: row 7 sends it to the session, row 8 refuses it. Row 1 resolves the disagreement in favour
of §9.2's frozen "present at all", because the empty case is **unreachable through the edge** — nginx
does not forward a header whose `proxy_set_header` value is `""`, so the admin vhost presents no
tenant header at all and the app answers row 7. Row 1 therefore changes behaviour only for a direct
connection or a future proxy that forwards empty headers, where failing closed is the correct
answer. Row 1 ahead of row 2 is not a change of outcome: an untrusted peer with a header on the admin
listener is `421 SKW_E_PLT_EDGE_PROOF` either way.

After row 10 the request is routed. `/healthz` and `/readyz` are answered before any page lookup and
on every listener (§9.5); they are not resolution outcomes and carry no tenant.

**One status code per failure, and no code is reused.**

| Code | HTTP | Raised when |
|---|---|---|
| `SKW_E_PLT_EDGE_PROOF` | 421 | rows 1, 2, 3 |
| `SKW_E_PLT_TENANT_HEADER` | 400 | rows 4, 5 |
| `SKW_E_PLT_TENANT_UNKNOWN` | 404 | row 7 with no session, row 8 with no `domain` row, row 9 |
| `SKW_E_DM_SCHEMA_STALE` | 503 + `Retry-After: 5` | row 10, `user_version < tenant.db_version` |
| `SKW_E_DM_BUSY` | 503 + `Retry-After: 1` | row 10, `SQLITE_BUSY` after `busy_timeout` |
| `SKW_E_PLT_TENANT_UNAVAILABLE` | 503 + `Retry-After: 5` | row 10, any other reason the database is unusable |
| `SKW_E_DM_QUOTA` | 507 | per-tenant byte quota exceeded |

**Every `Retry-After` in the taxonomy is asserted on the wire.** `SKW_E_DM_SCHEMA_STALE` carries
`Retry-After: 5`, `SKW_E_DM_BUSY` carries `Retry-After: 1` and `SKW_E_PLT_TENANT_UNAVAILABLE` carries
`Retry-After: 5`; **no other code carries the header**. The value is a delta-seconds integer, never an
HTTP-date. The gate asserts `response.headers['retry-after']` on the HTTP response for each of the
three, and asserts the header's **absence** for every other code that appears in the S1 suites.
Asserting a field on the error object is not the gate: the header is the contract, and it is the only
part a proxy or a client acts on.

`docs/sds/diagrams/request-lifecycle.png` is this table drawn as a sequence.

> Amended by 02-errata.md E-3, E-12, E-7.

### 5.4 The tenant map cache and the cold path

`control.db` carries one revision row, and six triggers move it — `AFTER INSERT`, `AFTER UPDATE` and
`AFTER DELETE` on `tenant`, and the same three on `domain`:

```sql
CREATE TABLE control_revision (
  id         INTEGER PRIMARY KEY CHECK(id = 1),
  rev        INTEGER NOT NULL CHECK(rev >= 1),
  changed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT INTO control_revision(id, rev) VALUES (1, 1);
```

Each trigger is `UPDATE control_revision SET rev = rev + 1, changed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = 1;`
in the same transaction as the write that fired it. **Triggers and not the application**, because the
write that suspends a tenant may come from `sqlite3`, from `migrate`, or from the next image's admin
tool, and the contract has to hold for all of them — B2's measured case was a second connection.

`TenantMap.stamp()` is `rev || ':' || PRAGMA user_version` read from the control handle it already
holds: one `SEARCH control_revision USING INTEGER PRIMARY KEY` plus one pragma read. The old
`MAX(control_migration.id) || count(tenant)` stamp is **deleted**, because it cannot see an UPDATE
(and a status flip is an UPDATE) and it cannot see a `domain` row deleted while the tenant count is
unchanged. The migration runner bumps `rev` in the same transaction that writes `control_migration`,
so the migration ledger stays covered without a second term.

The map carries every column a request decision reads — `tenant.id`, `key`, `mode`, `status`,
`db_version`, and the host list — so any bump is a full rebuild of one immutable generation. There is
no partial invalidation and no per-table invalidation to forget.

**Cold cache cost.** One `control.db` query (indexed on `domain.host`) plus one open of that tenant's
`site.db`. Measured on this box as part of `make test`: 4.05 ms per tenant in the migration fan-out and
185 KB per pooled handle. A 64-handle pool therefore costs ≈ 11.8 MB, which is why `SKW_DB_POOL_MAX`
defaults to 64 rather than to "all tenants".

**What "picked up on the next request" covers, and what it does not.** A control write is visible to
the **app** on the next request (§5.4a). The **edge** is a generated artefact: `tools/nginx_gen.ts`
writes `nginx/conf.d/10-app.conf` from `control.db`, and nginx does not re-read it until
`nginx -s reload`. Onboarding is one ordered sequence and no step is optional:

1. the `tenant` and `domain` rows commit (which bumps `rev`, E-3);
2. `tools/nginx_gen.ts --write` regenerates `10-app.conf` from the committed rows;
3. `nginx -t`, then `nginx -s reload`;
4. the certificate for the new host is issued (§12.5); until `domain.cert_state = 'issued'` the
   generator emits that host's block with `listen 80` **only**, so `nginx -t` never depends on a
   certificate that does not exist yet, and the host answers on 80 with `certificate: pending`.

Until step 3 the edge 404s a host the app would serve, and no cache refresh can close that gap — the
app is not the component that decides whether a `Host` reaches it. §16 S1 gates steps 1–3 end to end
through the real edge, in that order, including the negative: before the reload the new host 404s at
the edge, so the contract is never overclaimed again.

**Rename.** `control.db.tenant.key` is the tenant's identity and appears in the download cookie name
and in `audit_seal.tenant_key`. Renaming a key is not supported in v1: it would invalidate every
issued `__Host-sk-dl-<key>` cookie and orphan the seal. `display_name` is the renameable field. A
*host* is renameable (delete the `domain` row, insert another) and does not touch tenant identity.

### 5.4a What happens when the counter moves mid-request

The stamp is read **exactly once per request**, before the map is consulted, and the generation it
selects is immutable for the rest of that request: the resolver never re-reads the stamp, never reads
a second generation, and never mixes a tenant row from one generation with a host list from another.
A write that commits while a request is in flight is therefore observed by the **next** request and
never by the one in flight; a request may serve from a generation one revision stale, and that window
is bounded by one request rather than by a restart. After a bump, concurrent requests perform **one**
rebuild and share it (single-flight); the rest wait on that rebuild instead of each running their own.

### 5.5 Path-prefix demos, and the case-folding constraint

> Amended by 02-errata.md E-11.

> nginx strips the demo prefix (`rewrite ^/demo/<key>/(.*)$ /$1 break;`) and sets
> `X-Forwarded-Prefix: /demo/<key>`; the app never rewrites or strips an inbound path, and every URL it emits
> is produced by `site.url()` or `site.asset()`, which prepend `tenant.prefix` (taken from
> `X-Forwarded-Prefix` and from nowhere else) exactly once; a request under `/demo/` whose key is well-formed
> but absent from `control.db` is `404 SKW_E_PLT_TENANT_UNKNOWN`.
>
> `tenant.prefix` is `/demo/<key>` when and only when the request resolved `via='header'` at a path-prefix
> location; on `via='host'` and `via='session'` it is `""`. An `X-Forwarded-Prefix` that arrives on a
> host-routed request is **ignored** — not honoured and not refused: honouring it puts
> `/demo/<attacker>/…` on every link the site emits, refusing it would 400 real traffic behind a second
> proxy that sets the header for its own reasons, and ignoring it can produce neither.

Two failures this prevents, both measured: a double strip is a 404 on a prospect's screen
(`/demo/acme/whoami` → app sees `/whoami`, and if the app strips again it 404s), and a double prefix is
a link that 404s one click later (`/demo/acme/demo/acme/…`). Astro's `base` cannot do this per request —
measured: `X-Forwarded-Prefix: /demo/acme` in, `["/blog/a","/media/banner-home.webp?v=ab12cd"]` out — so
a URL helper is mandatory and `base` is banned in components.

**Recorded constraint (O-01).** `cms_page.path` is `COLLATE NOCASE` and nginx 1.31.7 does not fold
case (`$request_uri` preserved). v1 has no CDN because HTML is `no-store`. Any future CDN **must** pass
case through unchanged, or the `NOCASE` unique index must be dropped first — otherwise `/About` and
`/about` become two cache entries for one page.

### 5.6 What the demo host may not reach

> Amended by 02-errata.md E-2.
>
> A host that serves tenant-authored HTML never serves the admin listener: demos live at
> `demos.<our-domain>/demo/<key>/`, admin at `admin.<our-domain>`, and the admin surface is mounted on
> no other Host — so a demo page cannot reach it at all, and neither can a production tenant's page.
> `mode='demo'` no longer participates in that decision (§9.1 rule 4).

Without this, a demo page is tenant-authored HTML with JavaScript in it — that is the product — on the
same origin as the admin. It can `fetch('/admin/pages')` with the operator's `__Host-sk-sess` cookie
attached, CORS does not block a same-origin read, and the admin page renders the CSRF token because the
admin UI has to. The port-based `Origin` check saves a separate-port admin, not a same-port path demo.
One DNS record and one certificate is the price (C-25).

---

---

## 6. Data Sources and repetition

Two things a page needs from the database: **rows** and **repetition**. They are separate mechanisms
and neither is SQL text.

### 6.1 The registry, and the kind that no longer exists

`cms_datasource` holds one row per named source: `key`, `kind ∈ {view, query}`, `spec_json`,
`aggregate_json`, `group_by_json`, `params_json`, `is_public`, `ttl_s`, the cost stamps, publish
metadata.

> `cms_datasource.kind` is `CHECK(kind IN ('view','query'))`; a `function` value is not representable and a
> pre-existing row fails resolution with `SKW_E_RT_SOURCE_UNKNOWN`; a `query` source may declare
> `aggregate: {fn: count|sum|min|max, column}` and `group_by` of at most two columns, and is published only
> when `EXPLAIN QUERY PLAN` contains `SEARCH` and no `SCAN` and the measured worst-case cost is at most
> 1.5 ms.

**Why `function` is gone.** It is arbitrary JavaScript in `tenants/<key>/content/sources/`, inside the
tree the app writes and the exporter tars, executed in the process that holds every tenant's handle and
every HMAC key. One line of it is a cross-tenant read primitive (`ATTACH`), and in the export
direction it is reachable *by design* because the bundle carries `sources/` and the five-minute install
runs it. With `--allow-addons` off the module cannot even load; with it on, `ATTACH` to a sibling
tenant succeeds — measured. There is no version of that which is shippable.

**Why the aggregate gap is closed by grammar, not by code.** "How many products?" and "latest post per
category" need an answer, and the developer alternative is a migration, which a sold bundle cannot run.
A `count` over an indexed column is 1,990 µs at 90 k rows (under the 4 ms page budget, over the 1.5 ms
worst-source budget), so it is publishable only with a covering index and only where the budget allows —
which is exactly what the publish gate already decides. `join` is **not** expressible in v1.

**Rejected alternative:** a sandboxed child that receives row sets and never a handle. That is a v2
mechanism (register C-18, "what would overturn it"), and it changes the runtime shape for a feature no
client has asked for.

### 6.1a A `view` source is anchored to the definition it was published against

`cms_view_registry.checksum` is `sha256(sqlite_master.sql)` of the view — lower-case hex, 64 characters,
over the exact text SQLite stores for it, with no normalisation. That text is what the renderer's query is
planned against, so it is the right thing to hash; normalising it (stripping `CREATE VIEW`, folding
whitespace) would let two different definitions share a checksum, which is the failure mode a checksum is
for.

**Verified at publish and at resolve.** At publish, a `view` source is refused when the checksum does not
match, before the source row is written. At resolve — every `resolveSource` call, not only the first — a
`view` source's checksum is compared before the allowlist is taken, as step 5a of the resolve order:

    5a. kind = 'view':  sha256(sqlite_master.sql of the relation) == cms_view_registry.checksum
                        else 422 SKW_E_RT_SOURCE_UNKNOWN, reason = 'view_checksum'
    5b. every named column is in the allowlist (PRAGMA table_xinfo, read after 5a)

The order matters: 5b reads the live view, so it must not run before the body has been proved to be the one
that was registered.

**Cached under the schema stamp, so the hash is not per-request.** The schema stamp of a tenant file is

    stamp = PRAGMA user_version || ':' || PRAGMA schema_version

`PRAGMA schema_version` is SQLite's schema cookie: it advances on **every** DDL statement that changes the
schema, including `CREATE VIEW`, `DROP VIEW`, and a `ALTER TABLE … RENAME` that rewrites a view's body. The
verdict map is therefore `relation → {stamp, checksum}`: one pragma read and **no hash** when the stamp is
unchanged, one `SELECT sql FROM sqlite_master` and one sha256 per view when it moved. A cache that could go
stale is not needed and is not permitted: if the stamp did not move, the stored text did not change.

**What this does and does not defend.** It detects drift between the registered definition and the file —
a re-pointed view, a dropped and recreated view, a rename that rewrote a view's body. It is not tamper
evidence against an attacker who owns the file: such an attacker can `PRAGMA writable_schema=ON`, rewrite
the body and the stored checksum together. That is the job of §9.6's chain and seal, and the two controls
are complementary by design: the seal covers *rows*, the checksum covers *definitions*.

**The refusal.** `422 SKW_E_RT_SOURCE_UNKNOWN`, `reason = 'view_checksum'`,
`detail = {relation, registered: <first 16 hex>, found: <first 16 hex>}`, message

    the definition of view cms_v_posts_public is not the one the source was published against;
    review it and republish the source

No new error code: the source is no longer the object that was published, which is the same class as
`reason = 'view_missing'` (already a taxonomy refusal, measured in `S2-qa.md` §4 A5), and 422 is the status
that code already carries. One log line per refusal carrying `requestId`, `tenantKey`, `relation` and both
digests, rate-limited to one per `(tenant, relation)` per 60 s so a page in a hot loop cannot flood the log
— and no `detail` on the wire beyond the two digests, so nothing tells an attacker whether they were caught
or merely mistyped.

**What happens when a DDL op touches a published view.** Views are migration-owned; the DDL AST has no
`create_view` op and this item adds none. A published view's body can still change by two routes, and both
are specified rather than left to chance:

1. **Through the DDL runner.** Any statement whose execution changes `sqlite_master.sql` for a relation
   named by a `view` source — a `DROP`/`CREATE` in a migration, or a table rename that SQLite rewrites into
   the view's body — must, **in the same transaction** as that statement:
   (i) recompute and store `cms_view_registry.checksum`;
   (ii) clear publication of every `view` source over that relation —
   `UPDATE cms_datasource SET published_at = NULL, is_public = 0 WHERE kind = 'view' AND
   json_extract(spec_json, '$.view') = :relation` (a `view` source names its relation in `spec.view`, not
   `spec.table`);
   (iii) write one `cms_audit` row, `action = 'source.view_redefined'`, `target_kind = 'view'`,
   `target_id = :relation`, `before_json = {checksum}`, `after_json = {checksum, unpublished: [keys]}`.
   The next resolve then refuses `reason = 'not_published'` — an existing, tested refusal — and republication
   re-runs the whole publish gate. A redefinition is therefore never silent: the object changed, so the
   statement "this source was published" stopped being true, and the app says so in the same transaction.
   Clearing publication is the point, not a side effect: a checksum refreshed without that would anchor the
   *new* definition and launder exactly the attack A5 performed.
2. **Out of band** (a second `sqlite3`, a restored backup, a hand-run migration). The stamp moves, the hash
   disagrees with the registry, and the next resolve refuses `view_checksum` (above). Nothing is
   un-published, because nothing trustworthy is running to do it.

A `view` source is also measured at publish like any other: `cost_ms_max ≤ 1.5` applies to both kinds
(§6.2, E-23). The plan and index rules apply to `query` only, because a view's plan is migration-authored
and the source cannot change it — the checksum is the view's equivalent of those gates.

> Amended by 02-errata.md E-21.

### 6.2 The `query` grammar

> Amended by 02-errata.md E-24.

```json
{
  "table": "u_posts",
  "columns": ["slug", "title", "published_at", "cover"],
  "where": [{ "col": "status", "op": "=", "param": "status" }],
  "order": [{ "col": "published_at", "dir": "desc" }],
  "limit_default": 10,
  "limit_max": 50,
  "aggregate": { "fn": "count", "column": "id" },
  "group_by": ["category"]
}
```

**Rules, and the moment each one is enforced.** Two rules run at both publish and render, because both read
something that can change under a published source: the **column allowlist** (a table can be rebuilt between
publish and resolve) and a `view` source's **definition checksum** (§6.1a). Everything else runs at publish
only, because everything else describes a *plan* or a *measurement* of the spec — re-planning and
re-measuring on every render would put `EXPLAIN QUERY PLAN` and a 200-run measurement inside the page budget
to re-learn a fact that only a DDL op can change. "Re-checked at render" in this document means exactly the
two rows marked **both**, and no other rule may claim it.

| Rule | When | Applies to | Failure |
|---|---|---|---|
| every referenced column exists in the relation's allowlist | publish **and** render | `query`, `view` | `422 SKW_E_RT_SOURCE_UNKNOWN` |
| a `view` source's `cms_view_registry.checksum` equals the view's `sqlite_master.sql` hash | publish **and** render | `view` | `422 SKW_E_RT_SOURCE_UNKNOWN`, `reason='view_checksum'` (§6.1a) |
| every `where`/`order`/`group_by` column is indexed | publish only | `query` | `422 SKW_E_RT_SOURCE_UNINDEXED` |
| `EXPLAIN QUERY PLAN` contains `SEARCH` and no `SCAN` | publish only | `query` | `422 SKW_E_RT_SOURCE_UNINDEXED`, `reason='plan_scan'` |
| `cost_ms_max ≤ 1.5` (worst of 200 measured runs) | publish only | `query`, `view` | `422 SKW_E_RT_SOURCE_BUDGET` |
| `order` only on declared **and indexed** columns | publish only | `query` | `422 SKW_E_RT_SOURCE_UNINDEXED` |
| `group_by` ≤ 2 columns | publish only | `query` | `422 SKW_E_RT_SOURCE_BUDGET` |
| `limit` clamped to `limit_max`, and a non-integer `limit` is refused, never ignored | publish **and** render | `query`, `view` | silently clamped with `data-truncated`; a non-integer is `422 SKW_E_RT_SOURCE_UNKNOWN`, `reason='param_invalid'`, `detail.param='limit'` |
| values are bound parameters, never interpolated | structural | both | a bug, not a refusal — `compile.ts` has no string concatenation |

**Why a `view` source is not planned or index-checked, and why that is not a hole.** A view's plan is
migration-authored: the source cannot change it, the operator did not write it, and it was reviewed when the
migration that created it was reviewed. What a source *can* silently change is which definition it is
reading, and that is the checksum's job (§6.1a). The cost bound still applies to both kinds, because cost is
the page's problem whoever wrote the query. The old phrasing "table/view" on the plan and index rows was true
of neither kind's mechanism and is deleted rather than widened.

**A `limit` that is not an integer is refused, not ignored.** `data-limit` is an HTML attribute and therefore
always a string; a resolver that accepts `'5'` for one caller and drops it for another is a rule with two
answers. The clamp is `Math.floor` on a number, and anything else is `param_invalid` (§6.3's `list` is the
first caller that will produce it).

> Amended by 02-errata.md E-23, E-21.

**The gate reads the maximum, not a percentile.** `p95 of 20` is not an estimator: measured spreads of
0.29×–13.97× the truth. The gate stores `cost_ms_max` and `cost_ms_p95`, refuses on **max**, and runs the
plan check *before* measurement (0.015 ms versus 1,304 ms to reject). `cost_ms_max` is invalidated when
the row count doubles; a re-measure is mandatory before the next publish.

**Result cache.** Key = `(tenantKey, sourceKey, specRev, sha256(canonicalParams))`, single-flight per
key, TTL from `ttl_s`. A cache keyed per source rather than per parameter serves `{limit:3}` rows to a
`{limit:50}` request — the defect O-10 records; the test renders both in both orders inside one TTL and
asserts each row count.

### 6.3 Repetition: the `list` component (C-4)

> Repetition is the `list` component: `<div data-gjs-type="list" data-source="posts" data-limit="3">
> <article data-repeat data-bind-title="title" data-bind-href-slug="slug"></article>
> <p data-empty>No posts yet.</p></div>`; SSR clones the single `[data-repeat]` child once per row, writes
> text through `data-bind-<col>`, `href` through `data-bind-href-<col>` and `src`/`srcset` through
> `data-bind-asset-<col>`, renders the `data-empty` child when the source returns zero rows, clamps
> `data-limit` to the source's `limit_max`, and sets `data-truncated` when it clamped.

The contract is in the database, not in a comment:

```sql
-- cms_component_registry
CHECK(kind <> 'list' OR (repeat_child IS '[data-repeat]' AND limit_max IS NOT NULL))
CHECK(kind = 'list' OR repeat_child IS NULL)
```
`IS` and not `=`: with `=`, a NULL `repeat_child` makes the predicate NULL and SQLite **passes** a CHECK
on NULL — a `list` with no repeat child would have been accepted. That is the same class of mistake as
`GLOB 'p_*'` matching `'p_'`, and `make test` now pins both.

Three binding families and no expressions:

| Attribute | Written as | Cannot |
|---|---|---|
| `data-bind-<col>` | a **text node** | inject markup: `<` is escaped by `bindings.ts`, not by the component |
| `data-bind-href-<col>` | an `href` through `site.url()` | emit an off-site or un-prefixed URL |
| `data-bind-asset-<col>` | `src`/`srcset` through `site.asset()` | name a path or a checksum |

**Rejected alternatives, both measured or reasoned against:** a template language inside a body that
also accepts client-authored HTML is an XSS surface with no owner; an island (`data-island="post-list"`)
needs client JS plus a data snapshot, so a static export must refuse every page whose island needs
request data — a larger export hole than the one it closes. And an unregistered type loses
`data-gjs-type` on save and degrades to an editable div (176 B → 110 B), which is why the loop must be a
*registered* type.

Reference behaviour (executed in `make test` check 26, so a Builder's TypeScript has something to match):
expansion is deterministic; text is escaped (`<script>` becomes `&lt;script&gt;`); zero rows render
`[data-empty]`; `limit:99` with `limit_max:50` yields 50 children and `data-truncated`.

### 6.4 Snapshot rules (D22/C-22)

> `SKW_EXPORT_NOW` (ISO 8601) is written into `BUNDLE.json` and is the only clock a snapshot may read; every
> `query` source declares each parameter's domain in `params_json` (`enum`, `int`, `page`, `bound` or `free`);
> the exporter enumerates the cross product of the non-`free` domains up to `SKW_SNAPSHOT_MAX_COMBOS` (1024)
> and `SKW_SNAPSHOT_MAX_BYTES` (2 MB per source), and refuses with `SKW_E_EXP_PARAMETERISED` when a `free`
> parameter appears in a link on any exported page; two exports of one database at one `SKW_EXPORT_NOW` are
> byte-identical.

A `free` parameter is a search box, and the static SKU refuses a site with one — before the client pays,
not after their customer finds the 404 (CEO-3). Enumeration is affordable: a 10-row/4-column source is
561 B raw / 103 B gzip per combination; 500 combinations is 274 KB and 500 files at 0.07 ms each; 1,024
generated pages is ≈ 50 s at the measured `astro build` rate, inside the ≤ 3 min Astro target.

---

## 7. Assets, downloads, accounting

### 7.1 One byte tree, two locations, one generated path

> `content/media/` is the only byte tree; `/media/<key>.<ext>` is served by nginx from `content/public/`, which
> contains one relative symlink per public asset and nothing else; `/__protected/` is `internal` and aliases
> `content/media/` behind a 64-hex guard; a gated asset has no farm link and `GET /media/<key>` is 404;
> `cms_asset.storage_path` is `GENERATED ALWAYS AS ('content/media/'||substr(sha256,1,2)||'/'||sha256||'.'||<mime ext>) STORED`
> and any `INSERT` or `UPDATE` naming it fails.

Why a generated column rather than a form policy: `storage_path` was row data, a CRUD form exposed it,
the symlink regenerator read it, so `../../../../etc/passwd` became a symlink in `content/public` and
nginx served it. A per-column write policy in the CRUD generator is application code that can be
forgotten; a generated column is not writable by any statement, from any driver, including the `sqlite3`
CLI (`make test` check 11 proves all three).

The cost is real and is paid with a test, not a claim: a missing symlink is weaker than a missing
directory, so **every bundle runs the link-absence test** — `find content/public -lname "*<gated sha>*"`
must be empty, `GET /media/<key>` must be 404, and a direct `/__protected/<sha>.pdf` must be 404.

> `u_*` asset columns are `TEXT REFERENCES cms_asset(key) ON UPDATE RESTRICT ON DELETE RESTRICT`; renaming a
> key that any row references is refused with `409 SKW_E_DM_KEY_IN_USE` naming the key and the reference
> count, and the only rename paths are (a) an unreferenced key, which also writes a `cms_asset_alias` row,
> and (b) the explicit `repoint` operation, which runs in one `BEGIN IMMEDIATE`, rewrites at most
> `SKW_REPOINT_MAX_ROWS` (default 5,000) referencing rows, and writes exactly one `cms_audit` row recording
> `{from, to, rows, tables}`.

**Why `RESTRICT` and not `CASCADE`.** With `CASCADE`, 200,000 references cost 439 ms of write lock on a
settled database and 2,412 ms inside the inserting transaction, and every writer on that tenant gets
`SQLITE_BUSY` for the duration. A rename button that stalls every writer is a self-inflicted outage, and
"audit the cascaded write" is unimplementable at scale: an honest audit row for a 200,000-row rewrite is
200,000 audit rows. The `repoint` gives the same guarantee at O(1) audit cost, with a cap and a refusal
above it.

`cms_asset_alias` therefore records two things: unreferenced renames, and URL-level renames for keys
already frozen inside `body_html`, which no foreign key can see.

### 7.2 Access codes: selector + argon2 (C-6)

> An access code is 16 Crockford-base32 characters (`<selector:4><secret:12>`); `cms_download_code` stores
> `code_selector` (the first four characters, plaintext, `UNIQUE`, `CHECK(length(code_selector)=4)`) and
> `code_hash` = argon2id(`m=19456, t=2, p=1`) over the normalised full 16 characters; there is no pepper
> column and no column that contains the secret in recoverable form; `SKW_ARGON2_MAX_CONCURRENT=4` and
> `UV_THREADPOOL_SIZE=8` are asserted at boot, the redemption path performs exactly one verify for a matched
> selector and exactly one dummy verify at the same parameters for an unmatched one, and both paths return
> the same status, the same body and one `cms_download_event` row.

Measured here: 5,000 codes issued with **12 selector collisions resolved by retry** (the expected count
for 20 bits), selector seek **6.08 µs p50** over 1,000 lookups with `SEARCH` in the plan, argon2id
`m=19456,t=2` at **25.8 ms** real versus **26.6 ms** dummy, and an equality scan of 5,000 argon2 hashes
at **377 s**. That last number is why a selector exists at all: argon2 is salted, so the row cannot be
found by hash, and a design without a selector either scans or keeps a pepper.

**Why the pepper is dead.** A keyed `code_lookup` dies the moment the pepper leaks with the file, and its
residency is not a property of the mechanism — the projection excludes the codes, but a pepper in a
backup is a Platform decision nobody owned. It also cannot be rotated: a `code_lookup` cannot be
recomputed without the plaintext. The selector removes the secret entirely. Deleting the verifier is then
the one thing that cannot be done, because the selector is plaintext and 20 bits, and argon2 is the only
barrier left (4.46×10⁸ core-years at these parameters).

**Rejected alternative:** 12-character codes with a pepper (CEO-4 option B). Four extra characters is the
cheaper promise.

### 7.3 The counted unit is the redemption (C-7)

> `max_uses` counts redemptions, not requests: `uses` is incremented exactly once per token `jti`, by
> `INSERT INTO cms_download_event(jti, kind, code_id, asset_id) VALUES(?, 'first', ?, ?) ON CONFLICT DO
> NOTHING` followed — only when `changes() = 1` — by `UPDATE cms_download_code SET uses = uses + 1 WHERE id =
> ? AND revoked_at IS NULL AND (max_uses IS NULL OR uses < max_uses)`, both inside one `BEGIN IMMEDIATE`;
> every other request under the same `jti` is served without consuming; a request whose `Range` is
> unsatisfiable is answered `416` without writing a `first` event and without incrementing `uses`.

The exact consume, in order, one transaction:

```sql
BEGIN IMMEDIATE;
INSERT INTO cms_download_event(jti, kind, code_id, asset_id, bytes_declared, ip_hash, ua_hash, outcome)
     VALUES(?, 'first', ?, ?, ?, ?, ?, 'ok') ON CONFLICT DO NOTHING;
-- if changes() = 1:
UPDATE cms_download_code SET uses = uses + 1, last_used_at = ?
 WHERE id = ? AND revoked_at IS NULL AND (max_uses IS NULL OR uses < max_uses);
COMMIT;
```

If the `UPDATE` changes 0 rows after the insert succeeded, the redemption is denied
(`410 SKW_E_SEC_USES_EXHAUSTED`) and the event row is rewritten to `outcome='denied_quota'` in a second
statement of the same transaction — the `first` row is the ledger entry, and a ledger entry with no use
is a denial, not a free download.

**Order is the gate.** Update-first produced `uses = 24` with one event under 24 concurrent requests;
insert-first produces `uses = 1`. Re-measured on the real v3 tables (check 22): 24 threads, one `jti`,
`uses=1`, one `first` row; a third redemption over a cap of 2 writes the ledger row, updates 0 rows,
`outcome=denied_quota`, `uses` unchanged; a `range` row spends nothing.

**Rejected alternative:** Platform's "decrement only when there is no `Range` header, or `Range` starts at
byte 0". `Range: bytes=1-` never increments, so one token downloads the asset indefinitely. That is a
bypass, not a fix.

### 7.4 The token, and the two columns that tell the truth (C-14)

> Amended by 02-errata.md E-26.

```
v1.<base64url(payload)>.<base64url(HMAC-SHA256(SKW_DOWNLOAD_TOKEN_KEY, "v1." + payload))>
payload = {"jti":"<128-bit hex>","cid":<code id>,"aid":<asset id>,"iat":<unix s>,"exp":<unix s>,
           "iph":"<22 chars>","uah":"<22 chars>"}
```

Verification order, each step a contract: (1) split on `.`, exactly three parts; (2) require `v1`;
(3) base64url-decode the MAC and require **exactly 32 bytes before comparing** (a length mismatch makes
`timingSafeEqual` throw `ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH`, which surfaces as 500 instead of 401);
(4) `timingSafeEqual`; (5) `exp - iat = 600` **and** `iat ≤ now + 30`; (6) `iph`/`uah` match; (7) `aid`
matches the route; (8) DB consume. **No `JSON.parse` before step 4.**

> `cms_download_event` records `bytes_declared INTEGER NOT NULL` (the `Content-Length` the app authorised),
> `bytes_sent INTEGER NULL` (filled only from the nginx access log; NULL in v1), `kind TEXT NOT NULL
> CHECK(kind IN ('first','range','denied'))` and `jti TEXT NULL` with a partial unique index
> `WHERE kind='first'`; no process writes a byte count it did not observe.

A `NOT NULL DEFAULT 0` byte count in the table that exists to prove what was downloaded is a fabrication:
"0 because the app cannot know" and "0 because nothing was sent" are indistinguishable to a reader in a
dispute. Platform's falsifier ("`bytes_sent` within 1 % of nginx's `$body_bytes_sent`") can never pass,
so it would be deleted the first time it tripped — worse than not having it. It is restated against the
access-log line, and the daily ingest that fills `bytes_sent` is documented and **not** wired in S3.

**Cookie.** `__Host-sk-dl-<tenantKey>=<token>; Path=/; Secure; HttpOnly; SameSite=Lax`, 600 s. `__Host-`
requires `Path=/` and no `Domain`; the tenant key in the **name** prevents shadowing on a shared origin,
and `Path=/` is what makes the prefix legal. The asset binding is in the token (`aid`), not in the
cookie path — `Path=/d/<key>` would have made the cookie invalid.

**Continuation grace.** A request with an expired token is served without consuming **iff** the MAC
verifies, `iph`/`uah`/`aid` match, a `cms_download_event` row exists with that `jti` and `kind='first'`,
the code is not revoked, and `now - iat ≤ download.continuation_grace_s` (default 21,600). That is what
lets a 1 GiB download finish under `limit_rate 1m` (1,024 s) without spending a second use, while a
leaked token buys one asset for at most six hours on one IP/UA pair.

### 7.5 Watermarking (C-16)

> Amended by 02-errata.md E-27.

> Watermark stamping runs in a worker with a 2000 ms wall-clock budget and returns
> `503 SKW_E_SEC_WATERMARK_FAILED` on timeout, renderer error or unencodable text after cp1252 sanitisation; a
> render file is deleted `download.continuation_grace_s` (default 21,600 s) after the token that produced it
> expires and is excluded from every bundle; an asset with `encrypted=1` is refused for gating at issue time
> with `422 SKW_E_DM_ASSET_UNSTAMPABLE` naming the asset, and no code path serves an un-stamped gated byte.

Numbers: 51.9 ms cold / 23.4 ms warm to stamp 40 pages (≈ 1.3 ms/page), output +60 %, and two purchasers
never share bytes because the text template forks the output. A 600 ms synchronous block made 20/20
unrelated requests wait 510–514 ms against a 0.5 ms baseline, and `X-Accel-Redirect` does not help because
the stamping happens before the redirect — hence: off-loop, 2 s cap, per-tenant semaphore of 8.

The cache is a **bounded transient**, not a store. `spec_sha` includes the buyer's email, so the hit rate
is ≈ 1 and every redemption would leave a permanent file (1,000 buyers × a 5 MB book at +60 % ≈ 8 GB).
`cms_watermark_render.expires_at` is token expiry + grace, the sweep deletes file and row, and
`content/protected/wm/**` is excluded from every bundle (class `pii`).

**Encrypted assets are refused at issue, not at download.** An owner-password PDF is not corrupt, but
`pdf-lib` cannot load it, so fail-closed would deny 100 % of that tenant's downloads while the issue
screen warned about nothing. The refusal moves the failure to the one moment a human is present.

**Format coverage, honestly:** PDF via `pdf-lib` (drawn into the content stream, not a removable layer);
images via `sharp` composite; ZIP bundles get a generated `LICENSE.txt`; **video and audio are not
watermarked in v1**, and the issue screen says so when the selected asset cannot be stamped.

**This is not DRM.** A determined buyer can crop or re-typeset it. It is attribution and deterrence, and
it is priced as such.

### 7.6 Issuing, reissuing, and the channels

| Channel | Fields |
|---|---|
| Admin, single issue | asset or bundle, email (optional), `max_uses`, `expires_at` (optional) |
| Bulk CSV | `email, asset_key, max_uses, expires_at` — blank `max_uses` uses the tenant default |
| Webhook `POST /api/hooks/<tenant>/issue-code` | same fields, HMAC-signed; omitted `max_uses` uses the tenant default |

`max_uses` resolution: per-issue value → `cms_settings.download.default_max_uses` (shipped as **3**) →
never hard-coded. `NULL` means unlimited, behind a toggle that is off by default, requires a confirmation
("this code is effectively shareable"), and is labelled as such in the code list.

Editable after issue: `max_uses`, `expires_at`, revoke. Immutable: the code itself (it exists only as an
argon2 hash) — the remedy is reissue. **Redelivery is never a re-send**: `POST
/admin/t/<key>/codes/<id>/reissue` revokes the old row, mints a new code, and sends it, because we cannot
read the old one.

Email transport (O-28): one SMTP transport (`SKW_SMTP_URL`, from-address, one template).
`SKW_EMAIL_MODE=off|smtp`, default `off`; when `off`, the webhook's 201 body carries the code once and the
store emails it. Codes are never accepted in a query string and never emailed as a clickable link — the
email contains the code and a link to the *form*.

---

## 8. Plugins

> **Read §13.3 before this section.** D36 moved plugins in-process: §8.3 and §8.4 below are rewritten
> (the RPC wire and the runner are deleted; the operation grammar survives as facade methods), and §8.6's
> failure table is replaced by §13.3.8. §8.1, §8.2 and §8.5 are the install-time contract and stand as
> written, with the two manifest fields E-31 adds. Where §8 and §13.3 disagree, §13.3 wins.

### 8.1 The manifest is the contract

`plugin.json`, validated at install, stored verbatim in `cms_plugin_installed.manifest_json`:

```json
{
  "id": "contact", "version": "1.4.0", "cms": ">=3.0.0 <4",
  "publisher": {"id": "acme-labs", "key_id": "spki-sha256:…"},
  "main": "index.mjs",
  "hooks": ["content.render.html", "form.validate", "form.submitted"],
  "tables": [{"name": "p_contact_message", "columns": [...], "indexes": [...], "export": "rows"}],
  "settings": [{"key": "recipient", "type": "string"}, {"key": "smtp_password", "type": "secret"}],
  "admin": [{"path": "messages", "form": "message-list", "table": "p_contact_message"}],
  "public": [{"path": "contact", "methods": ["POST"]}],
  "capabilities": ["store.insert", "store.query", "mail.send", "settings.get"],
  "tests": {"entry": "tests/run.js", "timeout_s": 30},
  "cron": "none"
}
```

`main` and `hooks` are D36's two additions (§13.3.1): the app has to be told which file to `import()` and
which hooks the package intends to register, because there is no supervisor to discover either. A
manifest without `main` is refused at install (`SKW_E_PL_LOAD`); a `ctx.on()` for a hook not in `hooks`
is refused at activation (`SKW_E_PL_REJECTED`).

What is not in the manifest cannot be done **through the facade**, and the distinction matters: in-process,
a plugin can do anything the process can, declared or not (§13.3.7). `"cron": "none"` is the only legal
value in v1 (O-43 DEFERRED). A table without an `export` class is refused at install with
`SKW_E_PL_NO_EXPORT_CLASS`, because a table nobody classified cannot be sold. `capabilities` is
**disclosure**: it is what the install screen shows the operator, and what the facade checks before
answering a method — not a limit on the code.

### 8.2 Tables, migrations, and who may create what

A plugin table is `p_<id>_<name>`; `id` matches `^[a-z][a-z0-9]{1,19}$`; the `p_` prefix is exclusively
plugin-owned (the register's O-35 renamed the ledger tables to `cms_plugin_*` so the prefix stays clean).

**The plugin never sends SQL.** Its manifest declares tables; the host executor creates them inside one
`BEGIN IMMEDIATE`, in this order:

1. `CREATE TABLE p_<id>_<name>` with only the declared columns and indexes.
2. For every `asset_key` column: `CREATE TRIGGER trg_asset_guard_p_<id>_<table>` + a
   `cms_trigger_registry` row with `purpose='asset_delete_guard'`, in the same transaction.
3. Row in `cms_plugin_migration(plugin_id, version, seq, checksum)`.
4. Row in `cms_table_registry(table_class='plugin', plugin_id, column_count, columns_json)`.
5. Postcondition: every table is `cms_*` | `u_*` | `p_*` | `sqlite_*`, else `ABORT`.

Measured (check 24): with the guard, deleting a referenced asset aborts `SKW_E_DM_ASSET_IN_USE` even with
`foreign_keys=OFF`; without it, the delete succeeds and leaves a dangling `asset_key`.

The migration grammar is four operations — `create_table`, `add_column`, `create_index`, `drop_index` —
forward-only. `drop_table`, `rename_table` and `drop_column` are **not expressible**, so a destructive
upgrade cannot be sent by accident (`SKW_E_PL_DESTRUCTIVE_UPGRADE` if a manifest asks). A downgrade is
refused (`SKW_E_PL_DOWNGRADE`): uninstall-then-install is the only path, and it states what happens to
data (§8.6).

**Uninstall** archives the whole tenant file with the same `VACUUM INTO` the exporter uses, then drops
the plugin's rows and tables. The consequence is stated, not hidden: restoring that archive rolls back
every other change made since (O-40 DEFERRED — a table-scoped format is a v2 experiment).

### 8.3 The facade grammar (the 14 operations survive as methods; the wire does not)

> **Rewritten by D36 and 02-errata.md E-31.** There is no socket and no message envelope. The operations
> below survive as **methods on the per-request facade** (§13.3.5); the bounds survive with them, because a
> bound is a property of the operation and not of the transport. What is deleted is the transport: the
> `plugin.invoke` frame, the `granted[]` array in the envelope, the host-op callback frames, the 2 s op
> timeout and the `SKW_E_PL_UNAVAILABLE`-when-the-socket-is-absent path. The enforcement point is the facade
> in `app/plugins/context.ts`, and §13.3.7 states exactly what that single layer does and does not prove.

| Method | Shape | Bound | Refusal |
|---|---|---|---|
| `store.insert` | `(table, row)` | row ≤ 32 KiB, ≤ 24 columns, declared columns only, types coerced and checked | `PL_ROW`, `PL_NO_TABLE` |
| `store.update` | `(table, id, patch)` | ≤ 24 columns, exactly one row | `PL_ROW` |
| `store.delete` | `(table, id)` | exactly one row; `delete_all` is an admin action, not a method | `PL_ROW` |
| `store.query` | `(table, where, order, limit, offset)` | `limit ≤ 500`, `offset ≤ 10000`, ops ∈ `{=,!=,<,<=,>,>=,in,like_prefix}`, `order` on declared **and indexed** columns, response ≤ 256 KiB | `PL_QUERY`, `PL_TOO_MANY` |
| `store.count` | `(table, where)` | same `where` grammar; declared+indexed columns only | `PL_QUERY` |
| `settings.get` | `(key)` | declared key; `secret: true` → `null` | `PL_NO_SETTING` |
| `settings.has` | `(key)` | boolean only | — |
| `settings.set` | `(key, value)` | declared type and bounds; `secret` write-only | `PL_SETTING_INVALID` |
| `assets.resolve` | `(key)` | one key → `{key,url,width,height,alt,mime,bytes}`; never a path, a checksum or bytes | returns `null` |
| `mail.send` | `(to, template, vars)` | `to` is the tenant's configured address or an address the host validated **in this request**; declared template; ≤ 32 KiB rendered | `PL_MAIL` |
| `log.write` | `(level, msg)` | ≤ 1 KiB, ≤ 100 lines/min/plugin | dropped silently |
| `util.now` | `()` | server clock, ISO 8601 | — |
| `util.random` | `(n)` | `n ≤ 32` bytes, CSPRNG | `PL_ROW` |
| `util.hash` | `(algo, data)` | `sha256`/`sha512`, data ≤ 1 KiB (idempotency keys, not crypto) | `PL_ROW` |

Every method takes a `table` that must be in the manifest and resolves its connection from the context, so
there is no tenant argument anywhere: the tenant is closed over (§13.3.5). A call made after the response
ended refuses `SKW_E_PL_CONTEXT_ENDED` rather than reaching a recycled connection.

**Why the host writes the row.** `store.insert` is a *host* operation. The plugin describes the row; the
host validates it against the manifest and writes it with its own connection for that tenant. A plugin that
cannot name a table it did not declare cannot name a tenant either.

**Absent by decision**, each absence a control at the facade: `sql`, `exec`, `prepare`, `db`, `attach`,
`pragma`, `fs.*`, `net.*`, `http.*`, `fetch`, `env`, `assets.write`, `assets.upload`, `mail.raw`,
`tenant.*`, `cms.*`, `store.raw`, `store.join`, `cron`, `stream`. These are absent **from the facade**.
They are not absent from the process, and §13.3.7 says so in the same words the install screen uses.

### 8.4 Containment: there is none (C-8 withdrawn by D36)

> Amended by 02-errata.md E-30.

> `docker-compose.yml` has three services — `nginx`, `app`, `acme` — and no `plugin-runner`: there is no
> `network_mode: none`, no `node --permission` child, no per-package cgroup, no `run/plugin.sock` and no
> operation enum, because a plugin is a module imported into the `app` process and shares that process's
> network namespace, filesystem, memory and database handles. **Nothing in this design contains a plugin.**
> What it does instead is authenticate it (a signature and a publisher key, §8.5), scope the *API* it is
> given (§13.3.5), and isolate its failures well enough that a plugin that throws does not take a page down
> (§13.3.6).

The measurements that produced C-8 are kept here as history, because they are why the alternative was
rejected rather than unconsidered: a process per tenant is 49.8 MB and 34 ms cold start, which is 10.0 GB
at 200 tenants; the runner container itself was 47.4–48.0 MB idle and 22 µs per IPC hop. D36 does not
dispute those numbers; it decides the product does not need the boundary they buy, and that the 384 MiB
cgroup E-30 added to the runner is a cost with no remaining purpose.

**The one honest sentence.** A plugin can read every tenant's database, open a socket, write a file, or
block the event loop until the box is restarted. No capability, manifest field or signature changes that.
What the operator is buying is a plugin ecosystem at WordPress economics; what they are giving up is the
process boundary that would have made the opposite true. The install screen says this before enable
(§13.3.7), and §13.3.6 states the hang as an accepted cost rather than a mitigated one.

**Rejected alternatives, unchanged:** a process per tenant (10.0 GB at 200), a per-plugin worker thread
(no timeout that can interrupt a synchronous loop, and V8 workers do not isolate the filesystem), and
`vm.Script` (`node:vm` is not a security boundary and its timeout does not preempt a running script
reliably). None of them would have survived the same honesty test the chosen model now has to pass.

### 8.5 Supply chain: no publisher CA (C-9, D27)

> There is no publisher CA: the image carries our public key and verifies first-party packages against it;
> `data/trust/publishers.json` is written only by the tenant owner importing a publisher public key (SPKI
> base64, fingerprint shown), and no key we hold signs, countersigns or revokes a third-party publisher's key;
> revocation is an operator action against a package root in `data/trust/revoked.json`, which is local to the
> install.

Install refuses, in this order: an unknown signature (`SKW_E_PL_SIGNATURE`), a revoked root
(`SKW_E_PL_REVOKED`), a missing or stale test report (`SKW_E_PL_TESTS_STALE`), a CMS version outside the
declared range (`SKW_E_PL_SCHEMA`), a table with no export class (`SKW_E_PL_NO_EXPORT_CLASS`), a
destructive migration (`SKW_E_PL_DESTRUCTIVE_UPGRADE`).

`plugin.json.tests = {entry, timeout_s}`: the packager runs it **in the app image** (there is no runner
image after E-31) against a scratch `site.db` and writes `test-report.json` with `app_image_digest`. A
report whose digest does not match the running image is stale, and a stale report is a refusal — a plugin
can therefore not ship untested and be discovered by a client's contact form. The report is also the only
place a package's load-time behaviour is exercised before an operator enables it: `L1`–`L4` run the same
suite in CI.

**What the install screen shows a non-developer**, in this order: publisher id and key fingerprint;
every declared capability in plain words; every table it will create and whether that table exports;
whether the package is first-party; and the test report's timestamp and digest. That screen is the trust
decision, and it is reversible.

### 8.6 Disable, degrade, uninstall

> Amended by 02-errata.md E-32.

> **Replaced by §13.3.8.** The table below is the *old* contract and is kept for one reason: three of its
> sentences are now false in the opposite direction, and a Builder who reads them will build the wrong
> thing. The row that said "no plugin code is on the render path" is exactly backwards — a plugin's hooks
> run inside the render call. The 2 s per-op timeout no longer exists (there is no per-op boundary to time
> out) and the circuit breaker is a failure counter with no half-open state.

| Action | Data | Code | Public endpoint | Now |
|---|---|---|---|---|
| Disable | untouched | not loaded | 503 `SKW_E_PL_UNAVAILABLE` | true, and *removed* from the registry rather than "not loaded" (§13.3.8) |
| Crash / hang | untouched | no timeout; a throw is caught and counted | 503 on that endpoint; a page that does not call it renders normally | a **synchronous hang stops the whole box** — §13.3.6, accepted cost, no mitigation |
| Uninstall | whole-file archive first, then its tables and rows dropped | removed | 404 once uninstalled | true, plus a 5 s drain and `SKW_E_PL_BUSY` |

**Not true any more, and must not be written again:** "no plugin code is on the render path", "2 s per-op
timeout", "circuit breaker opens after 3 failures" (it is a 3-in-60 s auto-disable with operator
recovery), and "a broken plugin cannot take a page down" — a plugin that throws cannot, a plugin that
blocks can.

**Coexistence with core forms** is decided (register §7.2): a plugin form and a `cms_form` can both exist
on one page, and the static SKU depends on core forms for its only form story. Core form intake uses the
plugin endpoint contract verbatim (O-30): 16 KiB cap, 5/10 min per IP, intent token `_pt` (HMAC over
tenant|form|ts, 30 min, minimum fill 1.5 s), honeypot `_hp` → 202 with the success body and no row.

---

## 9. Admin surface

> Amended by 02-errata.md E-2.
>
> **Superseded by D37 (2026-10-21).** The CEO overruled D9: the admin surface is **not a
> hostname**. `/admin` on every tenant host is that tenant's admin, the fleet console is
> `/fleet`, the tenant comes from `Host`, and the isolation D9 got from the separate origin
> is carried by the cookie (`__Secure-sk-sess-<tenantKey>`; `Path=/admin`; `HttpOnly;
> Secure; SameSite=Strict`) plus the session row's tenant. Superseded in this section:
> §9.1's `listener = 'admin'` definition and its four consequences, the session-cookie row
> and the CSRF/`SKW_ADMIN_ORIGIN` row of §9.1's table, §9.1a's "inside the admin server
> block", and §9.2's "the admin listener ignores `Host`". Unchanged: TOTP and the empty-
> allowlist consequences, lockout, §9.1b's session lifetime, §9.2's one-source rule (only
> *which* source changed), §9.3's immutable columns, the DDL preview, §9.5 and §9.6.
> The two reasons D9 gave — C-25's same-origin argument and `/admin` as an anti-oracle —
> are given up **by decision**, and both are recorded rather than dropped in
> `docs/build/S6-admin-path-report.md` §2. `scripts/model/check_frozen.py` asserts that the
> retired sentences are still quoted here, so the supersession is recorded as this note
> and as a named erratum-shaped entry in the report, not by deleting the frozen text.

### 9.1 One listener, one origin, one hostname

The app listens on **one** port and publishes none (`expose` only). The admin surface is a
**hostname**, and that hostname is the **only** thing that makes a request an admin request:

    listener = 'admin'  ⟺  normalise(Host) == normalise(host(SKW_ADMIN_ORIGIN))

`host(SKW_ADMIN_ORIGIN)` is the host component of the required `SKW_ADMIN_ORIGIN` value, put through
the same `normalise()` as a tenant `Host` (§5.3). No new environment variable is added: the
twenty-two-name table in §4.3 is unchanged, and a missing or unnormalisable `SKW_ADMIN_ORIGIN` is a
boot refusal (step 1 of §2.3 already requires the variable).

The **path never selects the listener**. `/admin`, `/admin/…`, `/adminish` and `/demo/<key>/admin/…`
are ordinary paths on a public listener.

Four consequences, each a rule and not an implementation note:

1. **The admin surface is mounted only when `listener = 'admin'`.** On a public listener no admin
   route, no session cookie parse and no admin response exists. `/admin/...` on any Host other than
   the admin host resolves like any other path — tenant from the Host (row 8 of §5.3), then
   `cms_page`, then `404 SKW_E_RT_PAGE_NOT_FOUND` (§4.3) — **byte-identical to the body for any path
   that has no page**, with no `Set-Cookie`, no `Location` and no 421. There is no oracle that says
   `/admin` is special on a tenant host.
2. **The admin host serves the admin surface and nothing else.** Any path on the admin host outside
   `/admin…` is `404 SKW_E_PLT_TENANT_UNKNOWN` — the admin host maps to no tenant (rule 3), so "there
   is no tenant here" is the true statement. It never renders a tenant page and never serves
   `/media/`. The only exceptions are `/healthz` and `/readyz` (§9.5), which are answered on every
   listener.
3. **The admin host and the `demos.<domain>` host are not `domain` rows.** `tools/nginx_gen.ts`
   refuses, by name and with a test, a `control.db` whose `domain.host` equals either, and exits
   non-zero instead of emitting a config that silently shadows the admin or demos vhost. A control
   plane that mapped the admin host to a tenant would make rule 2 false in one direction and rule 1
   false in the other.
4. **C-25 is enforced by absence, not by a status code.** A host that serves tenant-authored HTML
   does not serve the admin listener — now true of **every** tenant host, not only of
   `mode='demo'`. `mode='demo'` keeps its CHECK, its `demo_expires_at` and its quota meaning; it no
   longer gates the admin surface, and **no rule may reintroduce a listener decision keyed on tenant
   mode** — that is the second source of truth §9.2 forbids.

| Control | Value |
|---|---|
| Session cookie | `__Host-sk-sess`; `Path=/`; `Secure`; `HttpOnly`; `SameSite=Lax` |
| Session id | 32-byte random hex, stored as a row in `control.db.session`, rotated on privilege change; the lineage dies 12 h after `created_at`, however continuously it is used (§9.1b) |
| CSRF | session-bound token on every non-GET, plus an exact `Origin` check against `SKW_ADMIN_ORIGIN` |
| IP allowlist | opt-in, empty in every exported bundle; **when empty, TOTP is mandatory and idle drops to 15 min**; stored in `SKW_ADMIN_ALLOWLIST` and enforced by nginx on the admin host, never by the app (§9.1a) |
| Password hash | argon2id, `m=19456, t=2, p=1`, through the same 4-slot semaphore as codes |
| Lockout | 5 failures → `locked_until`, exponential to 15 min |
| `fleet_admin` | role stays in the schema; every bundle sets `SKW_FLEET_MODE=0`, and with 0 the app refuses to create or authenticate that role (`403 SKW_E_SEC_ROLE_DISABLED`) |

> Amended by 02-errata.md E-17, E-18.

### 9.1a The IP allowlist: one name, one parser, enforced at the edge

`SKW_ADMIN_ALLOWLIST` is a comma-separated list of CIDR blocks, IPv4 and IPv6, optional, and **empty in
every exported bundle**. It is the only place the allowlist is stored: no `control.db` table and no
admin route, because the value protects the surface that would edit it and a lockout administered
through the locked door is a support ticket with a rebuild attached.

- **Unset and empty mean the same thing: no allowlist.** Unset is the bundle default and is not an
  error; `""`, `" "` and `","` are empty. With no allowlist the edge emits no access directive and
  §9.1's consequences apply unchanged — TOTP mandatory, idle 15 min.
- **There is no way to express "deny all".** A value that parses to zero blocks is empty. The only
  routes to "refuse everyone" are a typo and a lockout, and neither is a configuration.
- **A non-empty value that does not parse is a boot refusal** (§2.3 step 1), naming the offending
  token, and `tools/nginx_gen.ts` refuses to emit a config with the same message from the same parser
  (`app/admin/allowlist.ts`). Two answers to "is this value usable" would be one answer too many, and
  the alternative — treating a typo as empty — produces a config that looks applied and is not.

**Enforced at the edge; the app never enforces it.** `tools/nginx_gen.ts` emits one `allow <cidr>;` per
block followed by `deny all;`, inside the **admin** server block and in no other block. The app cannot
do this: nginx terminates the connection, so `req.socket.remoteAddress` is the edge's address and not
the operator's (§5.3 row 2 uses it for exactly that reason, and `trustProxy: false` means an
`X-Forwarded-For` is not evidence). The app reads the same variable for the two consequences §9.1
attaches to it — TOTP mandatory, and the idle window — and for nothing else.

A peer outside the list is `403` from nginx, before the app is reached: nginx's body, no taxonomy code,
no `Set-Cookie` (E-13's fifth exception, below). The admin hostname is public — it is in the
certificate's CT log — so the list controls *reachability*, not *secrecy*; what it buys is that an
attacker holding the password and a live TOTP code still has to be on the listed network.

**Changing it.** The list is read at boot by the app and at generation by the edge, so the two disagree
for as long as it takes to apply both. **Narrowing is edge-first** — `nginx -t`, `nginx -s reload`,
then `docker compose up -d app` — because the other order leaves the edge admitting peers the app has
already stopped asking a second factor from. **Widening is safe in either order**; the install report
does it app-first, so the state it prints is the app's.

### 9.1b Session lifetime: a 12-hour cap over a sliding idle window

Two constants already in `app/admin/session.ts` and one added, none of them an environment variable:
§4.3's table carries deployment facts, and a session lifetime is a parameter the product fixes — one box
that sets it to 30 days is a support case, not a configuration.

| Constant | Value | Meaning |
|---|---|---|
| `IDLE_MS_NO_ALLOWLIST` | 15 min | §9.1's number for an empty allowlist; unchanged |
| `IDLE_MS_WITH_ALLOWLIST` | 60 min | the populated-allowlist window, fixed here |
| `SESSION_ABSOLUTE_MS` | 12 h | the cap, measured from `session.created_at` |

`session.created_at` is the **start of the session lineage**; `session.expires_at` is the **idle
deadline**. A session is live when all three hold: `revoked_at IS NULL`, `expires_at > now`, and
`created_at + SESSION_ABSOLUTE_MS > now`. `created_at` is written once, never moved by a request, and
is the only timestamp that can anchor a cap — a new column would buy the same thing and cost a v4
control-plane migration, a `control-r4.sql`, a `gen_schema.py` bump and a re-baselined check 20, for a
value that is a pure function of a column already present.

**The idle window slides, and it is clamped.** On an authenticated request,
`expires_at := min(now + idle, created_at + SESSION_ABSOLUTE_MS)`, so the idle deadline can never be
pushed past the cap and a session in continuous use dies at 12 h instead of never. The comparison and
the clamp stay in the code that already parses these strings (`Date.parse`), not in SQL: `datetime()`
reformats `2026-10-20T10:00:00.000Z` to a space-separated value, and a string comparison against an ISO
timestamp after that is silently wrong.

**Rotation inherits the lineage.** `session/rotate` revokes the parent and inserts the child with the
**parent's** `created_at`; only `expires_at` is new. Without that, rotation is a laundering path — an
operator, or a stolen cookie, that rotates every few hours resets the cap, which is the same hole as
having none. The parent's revocation stays in the same transaction, as today.

**A dead session is row 7.** Expired by either deadline is no session: `404 SKW_E_PLT_TENANT_UNKNOWN`
(§5.3 row 7), no `Set-Cookie`, and the row is not slid on the way out — a refused request must not
extend anything. The sweeper deletes a row when either deadline has passed, and deletes a revoked row
once the cap has passed.

**Deploy consequence, stated rather than discovered.** A session minted before this change carries a
`created_at` and a slid `expires_at`; if it is older than 12 h it dies at deploy and the operator logs
in again. That is the correct outcome for a security change, and it needs no migration.

### 9.2 Tenant selection (C-11)

> Every admin URL is `/admin/t/<key>/…`; `resolveAdminTenant(session)` returns the tenant from
> `session.tenant_id` and is the only source; the admin listener ignores `Host` for tenant resolution and
> returns `421 SKW_E_PLT_EDGE_PROOF` if `X-Skunkworks-Tenant` is present at all; every `cms_audit` row carries
> the tenant key, and the app container publishes no port (`expose` only).

Two sources of truth for "which tenant am I editing" is how an operator edits tenant B's homepage while
looking at tenant A's page list — a cross-tenant *write* by a trusted user, which is worse for trust than
an attacker. Making a bundle a special case (host resolution when there is one tenant) would create
exactly the second path the fleet needs to prohibit, and the bundle would then be the only place the bug
is untested. A tenant switcher changes the URL; the URL stays the authority.

### 9.3 CRUD, and the three tables that are not editable

Row data in `cms_*` is editable through generated forms, as the brief requires. Three columns are not,
and the control is in the database, not the form generator:

| Column | Control |
|---|---|
| `cms_asset.storage_path` | generated column — no statement can write it (check 11) |
| `cms_asset.sha256` | `trg_cms_asset_sha_immutable` → `SKW_E_DM_COLUMN_IMMUTABLE` |
| `cms_download_code.code_hash`, `code_selector` | `trg_cms_download_code_hash_immutable` |

Plus `cms_page.body_html`'s I8 CHECK and `cms_audit`'s two append-only triggers. Every other `cms_*`
column is editable, and `u_*` columns are editable through the same forms with Kysely-generated types.

### 9.4 The table builder

Off by default (`SKW_SCHEMA_EDIT=off` hides it entirely — no disabled button, because a disabled button
invites a support ticket). When on, every operation goes through the AST in §4.4 and this sequence:

```
BEGIN IMMEDIATE
  ≤ 8 statements, emitted from templates only
  cms_table_registry row + cms_audit row, same transaction
  postcondition: no table outside cms_|u_|p_|sqlite_
COMMIT            → on any failure: ROLLBACK, discard the connection
```

The connection is **discarded, not returned to the pool**, after any DDL: a connection that has executed
a schema change may hold a stale prepared-statement cache, and a pooled handle that once had
`foreign_keys` toggled is exactly the kind of state a permission boundary cannot afford.

### 9.5 Health and readiness

| Endpoint | Touches | Used by |
|---|---|---|
| `/healthz` | nothing — returns `{build, uptime}` | the compose healthcheck, and `SKW_BUILD_ID` reporting |
| `/readyz` | opens `control.db`, reads a revision, performs one scratch write | the release gate; never the compose healthcheck |
| `/admin/api/tenants/<key>/health` | that tenant's file, cached 30 s | the operator's dashboard, alert-driven |

A liveness probe that touches a database is a restart loop waiting for a lock. A readiness probe that only
reads cannot tell a read-only filesystem from a healthy one.

### 9.6 Audit (C-21)

> `cms_audit` rows are hash-chained (`prev_hash`, `hash` over the canonical row) inside `site.db` and written in
> the same transaction as the change they record; one `audit_seal` row per tenant per UTC **day segment** is
> written to `control.db` — `(tenant_key, day, first_id, last_id, rows_in_day, head, anchor, sealed_at, late)`
> — where `[first_id, last_id]` is that day's own id range, `rows_in_day` is how many rows are in it, `head` is
> the last hash **inside that range**, and `anchor` is the hash of the row immediately **before** it (`''` when
> the segment begins at the chain's first row); the verifier walks that range only, starting from `anchor`, and
> raises `SKW_E_SEC_AUDIT_SEAL` when the anchor, a link, `rows_in_day` or `head` disagrees. A day that was never
> sealed stays **visibly unsealed**, and a day sealed after the fact carries `late = 1`.

> Amended by 02-errata.md E-20.

### 9.6a The day segment: what a seal covers, and what verifying one reads

**Why the seal is a segment and not a snapshot.** A snapshot of the whole file (`count`, head) is a statement
about the file at one instant, and every later audit write falsifies it. That is not tamper — it is the
product working. A seal must therefore cover an **id range that never changes again**, and the only such
range is the day: rows are append-only, `ts` is written by the writer and never updated, and no row of an
earlier day can be added later without its id falling outside that day's range.

**The seal is written for a day that has ended, by one procedure, in one transaction.**

Sealing day `D` at instant `T` (`T` is the writer's clock; `utcDay(T)` is `D + 1` for an on-time seal):

1. **The day must be over.** `D < utcDay(T)`, else `SKW_E_SEC_AUDIT_SEAL` with `reason = 'day_not_over'`.
   Sealing a day that can still grow writes a segment that is wrong by construction — the defect this item
   exists to remove, in its smallest form.
2. **The segment is the day's rows.** With `P = substr(ts, 1, 10) = D`:
   `first_id = MIN(id)`, `last_id = MAX(id)`, `rows_in_day = COUNT(*)` over `P`. Zero rows: **write no
   seal** and report `empty` (a day with no audit rows has nothing to anchor, and a seal with
   `rows_in_day = 0` would have no `head`).
3. **The segment must be contiguous by id.** `COUNT(*) WHERE id BETWEEN first_id AND last_id` must equal
   `rows_in_day`. A day whose rows are interleaved with another day's (a clock step backwards, a restored
   backup) has no id-range that expresses it; refuse with `reason = 'not_contiguous'` rather than write a
   seal that would verify the wrong set.
4. **The anchor is the predecessor's hash.** `anchor = (SELECT hash FROM cms_audit WHERE id < first_id ORDER
   BY id DESC LIMIT 1)`; `''` when that row does not exist. If `first_id > 1` and no predecessor hash is
   readable, refuse with `reason = 'anchor_missing'` — a segment whose left edge is not anchored is a
   snapshot of a prefix, which is the thing this design refuses.
5. **The head is inside the segment.** `head = (SELECT hash FROM cms_audit WHERE id = last_id)`.
6. **Never anchor a broken chain.** A full `verifyChain` walk must be ok first, or refuse with
   `reason = 'chain_broken'` naming `brokenAt`. Once a day, a 10,000-row walk costs 37 ms (§9.6's own
   measurement) and it stops a break from being sealed as if it were history.
7. **`late` is computed, not asserted.** `late = 1` unless `substr(T, 1, 10) = date(D, '+1 day')` — an
   on-time seal is written on the day **after** the one it covers, because the tick that seals `D` fires at
   `00:00` on `D + 1` (§9.6's scheduler seals `utcDay(tick - 1000)`). `sealed_at` is always the real instant,
   never backdated: `late` is the
   durable fact and `sealed_at` is the clock, and a verifier that has to subtract dates to guess which one
   it is looking at has neither.

**Verifying day `D` reads only the segment.** `skwctl audit verify --day D`:

1. Read the seal. No row **and** the day has rows → `SKW_E_SEC_AUDIT_SEAL`, `reason = 'unsealed'`, message
   names the day and how many rows are on it. No row and no rows → `reason = 'empty'`, **exit 0**: there is
   nothing to verify and nothing is wrong.
2. `anchor` must equal the hash of the row immediately before `first_id`, and `''` must mean there is no
   such row. A mismatch is `reason = 'anchor_mismatch'` — a row was deleted, or inserted before the
   segment, after the seal was written.
3. Walk `SELECT … FROM cms_audit WHERE id BETWEEN first_id AND last_id ORDER BY id`, starting with
   `prev = anchor`, recomputing `auditHash(prev, row)` for each and requiring `row.prev_hash = prev` and
   `row.hash = auditHash(prev, row)`. The first disagreement is `reason = 'broken_at'` with the id.
4. Rows walked ≠ `rows_in_day` → `reason = 'count_mismatch'`.
5. Last recomputed hash ≠ `head` → `reason = 'head_mismatch'`.
6. **Rows with `id > last_id` are not read.** That is the entire fix: a later day's traffic cannot make an
   earlier day fail, and a later day's tampering is the later day's verdict.

**A whole-file walk is a different command and answers a different question.** `skwctl audit verify --chain
--tenant <key>` walks every link with no seal and reports the first break (`reason = 'chain_broken'`, with
`brokenAt`) or `ok`. It is what an operator runs after a refusal, and it is the only path that reads past a
segment.

**Four rules about the series, each a refusal rather than a convention.**

**(a) A sealed day is sealed.** Inserting a second `audit_seal` row for `(tenant_key, day)` is refused —
`reason = 'already_sealed'` — whether or not the computed `head` matches the stored one, and the stored row
is **never** updated (`trg_audit_seal_immutable`, below). A re-seal that happened to match would be
harmless; a re-seal path that can write at all is the laundering route the seal exists to close, and a rule
that distinguishes the two cases is a rule with a branch an attacker can aim at. Re-running the daily job
therefore reports `already_sealed` as a **non-failure**: `skwctl audit seal` prints the stored
`sealed_at`/`late` and exits 0, because "this day is anchored" is the outcome the operator wanted.

**(b) Backfilling a past day computes that day's segment.** `skwctl audit seal --day D` for an unsealed
`D < today` runs exactly the procedure above against `D` — `first_id`/`last_id`/`rows_in_day`/`head` are
`D`'s, the anchor is the row before `D`'s first, `late = 1`, and `sealed_at` is the real instant of the
backfill. `--heal` seals every unsealed day from `D` through yesterday, one seal and one `audit_log` row
(`action = 'audit.seal_backfill'`) per day. A backfilled seal is a **correct** seal of a **late** day; it is
never a snapshot of today wearing yesterday's date, which is what `S2-qa.md` §5.2 measured.

**(c) A missed day is visibly unsealed.** The tick does not heal. At every tick, before sealing the day it
owns, `sealDay` scans the series: for each day from the tenant's first audit day through the last day that
has ended, that has no seal row, a day with rows is reported `UNSEALED` and a day without rows is reported
`empty`.
Each unsealed day produces one console line and one `control.db` `audit_log` row
(`action = 'audit.seal_gap'`, `target_kind = 'audit_seal'`, `target_id = '<tenant>/<day>'`) — so a gap is
recorded in the control plane at the first tick that can see it, and it is reported again at every
subsequent tick until somebody seals it. **The tick does not heal its own gap**, because a job that silently
repairs makes `late = 1` indistinguishable in the operator's memory from a normal seal, and the fact that a
day went unanchored for six hours is exactly what an operator needs to know.

**(d) What an operator sees.** Three surfaces: the CLI reads the control plane and one tenant file; the
health field is served from the `30 s` cache that endpoint already keeps; and `/healthz` is untouched — a
liveness probe that opens a database is a restart loop waiting for a lock (§9.5).

```
$ skwctl audit status --tenant acme --days 5
tenant=acme chain=ok
2026-10-16 sealed    rows_in_day=12  first_id=41  last_id=52  late=no
2026-10-17 sealed    rows_in_day=3   first_id=53  last_id=55  late=yes  sealed_at=2026-10-19T02:14:07.512Z
2026-10-18 UNSEALED  4 rows on that day; no seal
2026-10-19 empty     0 rows on that day; no seal is required
2026-10-20 sealed    rows_in_day=7   first_id=56  last_id=62  late=no
```

`audit status` exits 0 only when `chain=ok` and no day is `UNSEALED`; otherwise exit 1. `audit verify`
distinguishes its refusals by name on stderr — `REFUSAL: AUDIT_SEAL_UNSEALED` (no seal, rows exist),
`REFUSAL: AUDIT_SEAL_MISMATCH` (anchor, link, count or head), `REFUSAL: AUDIT_SEAL_EMPTY` (nothing to
anchor, exit 0) — because QA's week-one failure is an operator reading one string for two events. And
`/admin/api/tenants/<key>/health` (§9.5, already cached 30 s) gains one field:
`"seal": {"last_sealed_day": "2026-10-20", "unsealed": ["2026-10-18"], "late_days": 1}`.

Why a chain alone is not enough, measured both ways: delete all 10,000 rows and `verify()` returns
`mismatch=null` — a vacuous chain; delete the tail and the remaining prefix verifies. Tamper row 2 and
recompute, and the unanchored chain verifies. The seal is one row per tenant per **day**, not per action,
so DM's objection ("two sources of truth for one action can disagree") does not apply: a missing digest is
itself the evidence.

Measured here (check 25): 10,000 rows chained in **60 ms**, verified in **37 ms**, seal written in **60 µs**;
after deleting the last 5 rows the chain still verifies and the seal comparison fails, and after appending
rows for the next day the earlier day still verifies. 32.1 KB per
tenant-year.

The control plane keeps `audit_log` **unchained** on purpose: it is the fleet's record, it never travels in
a bundle, and its tamper evidence is the operator's backup, not a digest a compromised app could rewrite.
No action writes to both planes.

---

## 10. Editor and authoring rules

### 10.1 What "authored for the editor" means

Every site we build is written in the vocabulary the editor emits: GrapesJS component types from
`schema/component-registry.json`, one stylesheet per page (`cms_page.body_css`), one reset, and no utility
classes inside a page body (Tailwind stays in the admin UI — a Tailwind-classed body round-trips badly).

### 10.2 One registry entry, three parts

`cms_component_registry` (image-owned, upserted at boot) is the single registration point. Each row names
`renderer`, `bindings_json`, `props_schema_json` and, for `list`, `repeat_child` + `limit_max`. The three
consumers read it:

| Consumer | Reads | A missing entry means |
|---|---|---|
| the editor | `kind='block'` / `'list'` / `'island'` | the block is not draggable at all |
| the SSR renderer | `renderer`, `bindings`, `props_schema` | a hard 500 at render — the publish gate should have refused it |
| the exporter | all of it | the bundle is self-describing and `install.sh` can refuse a page whose component the image lacks |

Adding a component is one file plus one JSON row plus an image release. That is the honest cost of D21 as
amended: a bespoke interaction is a component release, not a content edit (CEO-2).

### 10.2a The registry's editor fields (S4a)

`schema/component-registry.json` v4 carries the editor half of every entry beside the four columns
the table holds: `type` (the `data-gjs-type`, always the entry's `name`), `label` and `category`
(the palette), `editable` (the `data-prop` fields the settings panel may write), `allowed_children`
(the nesting rule), `html` (the block the palette inserts and the renderer emits) and `css` (one
rule set per component; `cms_page.body_css` is their concatenation). `cms_component_registry` does
not hold them: they describe the **editor**, not the render, and a column per editor detail would
make every palette change a migration on a protected table.

Three refusals are boot gates, not conventions, because each one is silent otherwise:

| a registry that… | is refused with | because |
|---|---|---|
| names a `type` that is one of GrapesJS's own (`image`, `link`, `table`, …) | `SKW_E_PLT_INTERNAL`, naming the entry | `addType('image', …)` does not replace the built-in model, which writes `src="data:image/svg+xml;base64,…"` into the body on save (measured, R2 Runtime M1/M2) |
| declares an `editable` prop its own `html` does not carry | `SKW_E_PLT_INTERNAL`, naming the entry | the settings panel would offer a field that edits nothing |
| allows a child that is not registered, or is a shell | `SKW_E_PLT_INTERNAL`, naming the entry | `allowed_children` **is** the nesting rule; a typo would silently forbid or silently permit |

The palette is a projection of the file (`palette()` in `app/editor/registry.ts`), never a second
list: a test adds an entry and the palette grows with no other edit.

### 10.3 The round-trip gate is a fixpoint

```
canon(load(save(load(page)))) == canon(load(page))
```

`canon` = Prettier on the HTML plus a fixed attribute order plus whitespace normalisation. The gate runs
over every page of the fixture site in `roundtrip.test.ts` and is a merge blocker. An **empty diff** on
pass 1 is not the gate, because GrapesJS normalises on load: 8 of 9 fixtures differ at pass 1, and
requiring zero would mean shipping no pages.

A page that cannot reach a fixpoint is not shippable, and the failure names the page and the first
divergent node.

### 10.4 Templates are slugs (C-23)

> `cms_page.template` is a slug (`CHECK(template GLOB '[a-z][a-z0-9-]*')`) resolved against the image's shell
> registry at publish; an unknown shell is `422 SKW_E_RT_TEMPLATE_UNKNOWN` naming the shell and the page, and
> adding a shell is an image release, never an `ALTER TABLE`.

The shipped enum (`page`, `landing`, `post`, `index`) meant the fifth client's "docs" layout required a
migration on a protected table — an image release we perform, for a product sold as self-service. A DB enum
also pretends the database constrains something it does not: the renderer knows four shells because the
image knows four shells. A slug plus a registry puts the constraint where the code is and turns the failure
into a publish-time refusal instead of a raw SQLite error.

**No foreign key on `template`.** A `REFERENCES cms_component_registry(name)` would accept a *block* name as
a template, and the filtered alternative (a partial unique index on `kind='shell'`) cannot be an FK parent —
`make test` check 4 measures exactly that mismatch.

**Rejected alternative:** tenant-authored shells. That is a template editor, i.e. tenant layout code on
every render, refused in v1 for the same reason as `function` data sources.

### 10.5 CSP and the script that is not there (C-12)

> A page body contains no `<script`, `<style`, `<!--` or `on<name>=` (enforced at write by a validator and a
> `CHECK`); the renderer emits every island as `<script type="module" src="/islands/<name>.<sha8>.js">`; the
> `Content-Security-Policy` is `default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr
> 'unsafe-inline'; img-src 'self' data: https:; frame-src <declared per tenant>; frame-ancestors 'none';
> base-uri 'none'; object-src 'none'` and is byte-identical in the CMS, Astro and static targets; island props
> are JSON-encoded into `<script type="application/json" data-island-props>` with `<`, `>`, `&`, U+2028 and
> U+2029 escaped, and validated against the island's declared prop schema at save.

Split, honestly:

| Layer | Covers | Cannot |
|---|---|---|
| DB `CHECK` on `cms_page.body_html` | `<script`, `<style`, `<!--`, `javascript:`, `srcdoc` — case-insensitive because SQLite's `LIKE` folds ASCII | `on<name>=`: SQLite has no regex, and a LIKE list of 70 handler names is not a control |
| write validator (`editor/validate.ts`) | the four classes **plus** `on<name>=` and the 19-statement injection corpus | anything after the row exists — this is a write-time gate |

`make test` check 26 proves the five DB vectors are rejected. A nonce is not used: there is no stored
script to carry one (GrapesJS deletes `<script>`, comments and `<style>` — measured), so nonce machinery
would be dead code a reviewer mistakes for a control. A render-time hash costs 0.044 ms/page on an 83 KB
body — +34 % of a 0.13 ms render — for no gain once no inline script exists.

### 10.6 Hand-edited pages

`cms_page.managed_by ∈ {editor, hand}`. A `hand` page opens read-only in GrapesJS, because once a designer
hand-edits a page the next person to drag a block re-serialises the model and the hand edit disappears
silently. `cms_page_revision` makes that loss recoverable, not prevented.

---

## 11. Export pipeline

Three SKUs, one content model, one generator. The picture is `docs/sds/diagrams/export-pipeline.png`.

### 11.1 What each target contains

| Capability | CMS bundle | Astro project | Static HTML/JS |
|---|---|---|---|
| Pages, slugs, nav | live DB | generated `.astro` + content JSON | rendered `.html` |
| Data Sources | live queries | enumerated snapshots | enumerated snapshots |
| Editor + admin | yes | no | no |
| Forms | stored submissions | post to a configured endpoint | same |
| Gated downloads | yes | **refused** | **refused** |
| Watermarking | yes | n/a | n/a |
| Runtime on the client box | `docker compose up` | `npm ci && npm run build` | none — copy files |
| Target install time | ≤ 5 min (bracketed, §1.2) | ≤ 3 min | ≤ 1 min |

**CMS bundle file list:** `docker-compose.yml` (3 services, pinned digests) · `.env` (generated secrets,
**not** populated in the bundle — `install.sh` writes it) · `data/site.db` · `data/control.seed.json` ·
`content/media/**` · `content/public/**` (relative symlinks) · `plugins/**` (installed packages) ·
`install.sh` · `BUNDLE.json` · `EXPORT-NOTES.md`.

**Astro project file list:** `package.json` · `package-lock.json` (the one the exporter resolved) ·
`astro.config.mjs` · `src/pages/*.astro` · `src/content/*.json` · `src/components/**` ·
`src/islands/**` · `public/**` · `README.md` with the exact deploy commands.

**Static file list:** `index.html` · one directory per path · `assets/**` · `robots.txt` · `sitemap.xml` ·
`EXPORT-NOTES.md`.

### 11.2 The projection is a union over the live database (C-5)

> `make test` asserts `set(tables in sqlite_master) == core_tables ∪ plugin_tables`, where `core_tables` is
> `schema/export-projection.json` and `plugin_tables` is the union of every installed manifest's
> `tables[].name`, and every member carries a class in `{rows, empty, filtered}`; a table present in the
> database and absent from both is a build failure, and a plugin table whose class is absent is refused at
> install with `SKW_E_PL_NO_EXPORT_CLASS`.

The older rule ("a table in the DDL and not in the file fails the build") read the **text** of `site.sql`,
and it was already false: the amended schema a tenant runs has 21 tables, the projection classified 20, and
the missing one was `cms_trigger_registry`. It could never see a `p_*` table, because a plugin table is
created at runtime by a migration the publisher wrote. The check moves to the database the tenant runs —
the only artifact that can contain a runtime table — and it becomes stricter, because it now catches the
amendment files too.

Check 23 runs it: 29 live tables (27 core + one `u_` + one `p_`), all classified, modes
`{rows, empty, filtered}`, and a manifest with no `export` class produces
`SKW_E_PL_NO_EXPORT_CLASS` for exactly that table.

`empty` means the table exists in the bundle and carries no rows: `cms_download_code`, `cms_download_event`,
`cms_watermark_render`, `cms_form_submission`, `cms_audit`, `cms_download_code_archive`,
`cms_plugin_revoked`. A sold bundle has no issuers, no buyers and no prospects.

### 11.3 Pre-flight refusals — six, and none of them is a note

| # | Condition | Refusal | Exit |
|---|---|---|---|
| 1 | a gated asset is present (Astro/static) | `SKW_E_EXP_GATED_ASSETS`, naming every key | 21 |
| 2 | a gated asset's media graph is open (a `cms_asset_link` from a gated asset to a public owner) | `SKW_E_EXP_MEDIA_GRAPH_OPEN` | 21 |
| 3 | a `free` parameter appears in a link on any exported page | `SKW_E_EXP_PARAMETERISED`, naming the source and the link | 22 |
| 4 | a form with `mode='forward'` has no `action_url` | `SKW_E_PL_EXPORT_FORWARD_NO_TARGET` | 23 |
| 5 | quiescence counts disagree after 5 attempts | `SKW_E_EXP_NOT_QUIESCENT` | 24 |
| 6 | the destination lacks room for `2 ×` the projected bundle | `SKW_E_EXP_INSUFFICIENT_DISK` | 25 |

"Freeze at the default and write it in `EXPORT-NOTES.md`" is **deleted** (C-22): a note is not a site. The
cheapest SKU shipping a 404 where the CMS has content, permanently, is discovered by the client's customer
rather than by us. A refusal is a sales conversation; a note is a refund (CEO-3).

### 11.4 Quiescence is counted by the producer (O-19)

Every exported table is counted **three times**: on the source before the snapshot, on the source after the
snapshot, and inside the snapshot. All three must agree, within 5 attempts, or the export refuses. The
counts ship in `BUNDLE.json.source_counts` and `install.sh` compares them on the client's box.

Why producer-side and not a verifier: a `cp`-built bundle with a manifest measured from the copy passed
**27/27** checks and served 201 pages where the source had 241. A verifier that reads the same broken file
cannot detect the loss; only a number the producer wrote before the copy can.

### 11.5 `BUNDLE.json`, exactly

```json
{
  "schema": "skunkworks/site-bundle/v3",
  "created_at": "2026-10-20T12:00:00.000Z",
  "export_now": "2026-10-20T12:00:00.000Z",
  "tenant": {"key": "acme", "mode": "production", "db_version": 3},
  "hosts": ["acme.com", "www.acme.com"],
  "image": {"app_digest": "sha256:…"},
  "projection_version": 2,
  "source_counts": {"cms_page": 241, "cms_page_revision": 501, "u_product": 10, "p_contact_message": 0},
  "files": [{"path": "data/site.db", "bytes": 372736, "sha256": "…", "class": "db"}],
  "plugins": [{"id": "contact", "version": "1.4.0", "root": "3addd03d…", "signature": "valid", "export_class": "rows"}],
  "refusals": [],
  "notes": [{"code": "SNAPSHOT_FROZEN", "subject": "posts", "rows": 60}]
}
```

`class ∈ {content, media, pii, secret, db, infra}`. `source_counts` covers **every** table in the snapshot.
`refusals` is non-empty only when the exporter wrote a bundle anyway (it never does for a refusal — §11.3).
`notes` is the machine-readable half of `EXPORT-NOTES.md`, which is generated from it. A bundle without
`BUNDLE.json`, or with a file whose sha256 does not match, is refused by `install.sh --verify` (exit 12).

### 11.6 Install

> A bundle carries `data/control.seed.json` — one tenant with `mode='production'`, its hosts, one
> `owner` user marked **unclaimed**: `must_change=1`, `totp_secret` NULL, and a `password_hash` that is
> a real argon2id hash of 32 random bytes discarded at export, so a verification costs exactly what a
> real one costs and can never succeed — `db_version` and settings — and `install.sh` applies
> `schema/control.sql` and seeds exactly those rows in one transaction before `compose up`; no bundle
> contains `data/control.db`, `data/site.db-wal`, `data/site.db-shm`, `content/protected/wm/`,
> `content/sources/`, a populated `.env`, or a non-NULL `totp_secret` (a §11.3 preflight refusal, so a
> bundle can never ship a working second factor). The seeded row is a **claim marker, not a
> credential**: `install.sh` runs `skwctl admin bootstrap` (§11.6a) between `bundle_verify` and
> `compose up`, so the box has exactly one operator who can log in, and has one before the admin
> surface is reachable.

> Amended by 02-errata.md E-19.

### 11.6a The first operator: `skwctl admin bootstrap`

An empty `SKW_ADMIN_ALLOWLIST` makes TOTP mandatory (§9.1), and a row with no `totp_secret` can never
authenticate. Nothing in a bundle creates either a secret or a password a human holds, so this command
is the only way into a fresh install, and it runs on the box before the surface exists:

    docker compose run --rm --no-deps --entrypoint node app dist/cli/skwctl.js admin bootstrap \
      --generate-password --enrolment-out /srv/data/first-login.txt

**What it does, in one transaction.** It claims the seeded row: sets `password_hash` (argon2id,
`m=19456,t=2,p=1`, through the same 4-slot semaphore), sets `totp_secret` to 20 fresh random bytes
rendered as unpadded base32 (32 characters), sets `must_change=0`, revokes every live session for that
user, and writes one `audit_log` row (`action='admin.bootstrap'`, `actor_label='install'`). If no user
row exists at all it creates one `owner` for the single `mode='production'` tenant, and `--tenant <key>`
is required when there is more than one. It never creates a `fleet_admin`, and refuses to when
`SKW_FLEET_MODE=0`.

**What it prints, and where.** The secret goes to `--enrolment-out` and nowhere else: one file created
`0600` with `O_EXCL` (it will not overwrite an earlier enrolment) holding the admin URL, the email, the
password when it generated one, the base32 secret in groups of four, the parameters, and the URI

    otpauth://totp/Skunkworks:<email>?secret=<base32>&issuer=Skunkworks&algorithm=SHA1&digits=6&period=30

whose parameters are the normative ones — RFC 6238 defaults, SHA-1, 6 digits, 30 s, one step either side
accepted. Stdout carries the path and the login URL only. **It refuses to write a secret to a
non-terminal stdout** (`REFUSAL: SECRET_NOT_PRINTABLE`) unless `--enrolment-out` is given, because
`install.sh` logs its own output and a TOTP secret in an install log is a secret in a support bundle;
`--enrolment-out -` is refused for the same reason. No secret reaches `audit_log`, `BUNDLE.json`,
`control.seed.json` or a log line.

**What it refuses to do.** If a user row exists that is not claimable — `totp_secret IS NOT NULL`, or
`must_change=0`, or `last_login_at IS NOT NULL` — it writes nothing, exits **3**, and prints
`REFUSAL: ALREADY_BOOTSTRAPPED` naming the two commands that would change it:

    skwctl admin reset-totp      --email <email> --enrolment-out <path>
    skwctl admin reset-password  --email <email> (--password-stdin | --generate-password)

Exit 3 is the only benign refusal, so `install.sh` can tell "this box is already set up" from "this
install failed": 0 and 3 continue (3 with a printed note and nothing changed), any other non-zero exits
**16**. A second `./install.sh` therefore changes no user row, and a `--generate-password` run never
rotates a secret it did not create. Every other refusal exits 1 with `REFUSAL: <REASON>` on stderr:
`NO_CLAIM_TARGET`, `AMBIGUOUS_TARGET`, `TENANT_UNKNOWN`, `FLEET_ADMIN_DISABLED`, `SNAPSHOT_MODE`
(`SKW_RENDER_MODE=snapshot` must not write `control.db`), `SCHEMA_VERSION_UNKNOWN`,
`SECRET_NOT_PRINTABLE`, `PASSWORD_TOO_SHORT` (16 characters).

**Why there are no recovery codes.** Recovery is `reset-totp` over shell access on the box, and that is
not an escalation: whoever can run it can read `SKW_SESSION_KEY` out of `.env` and mint a session
directly. A recovery code would be a long-lived second factor that has to be stored — a table, a hash, a
single-use rule, a rate limit — to solve a problem root on the same box already solves, and two factors
that both live on the same box are one factor. `--generate-password` is why the file says "delete this
after enrolling": it is the only copy.

**Why `must_change` is not the control.** A forced first-login change needs a code for "password
expired" and a rule that scopes the session to the change route; v1 has neither, and inventing a second
code for it is a bigger change than the gap. The column keeps its meaning as the seed's claim marker and
the claim clears it; the install report tells the operator to change the password, and the file is
`0600` and deleted.

Sequence, with the measured bracket: `tar xf` → `./install.sh` (DNS check 0.3 s, `control.sql`, seed, `.env`
generation, `bundle_verify` on every sha256 and every symlink target) → `docker compose up -d` (18.2 s warm,
29.8 s cold-pull) → certificate (≤ 16.0 s once DNS and port 80 are correct, and `certificate: pending` if
not) → tenant marked active. A wrong A record exits **11** in 0.3 s. A failed verify exits **12**. A
`control.db` migration failure exits **15**.

**Why a seed and never the fleet file.** Seeding from a projection gives 1 tenant / 2 domains / 1 admin / 0
sessions / 0 audit rows and forces `mode=production`; shipping the fleet file gives 3 tenants / 48 domains /
3 users / 2 live sessions / 120 audit rows — 46 foreign domains and our operators' audit rows in a bundle
handed to a third party. The schema already fails closed on the dangerous half: `tenant.mode` has no
default, and `CHECK(mode <> 'demo' OR demo_expires_at IS NOT NULL)` means a seed that forgets `mode` errors
instead of defaulting to `demo` — which would apply TTL auto-expiry to the site the client just bought.

---

## 12. Deployment topology

### 12.1 Compose

```yaml
services:
  nginx:          image: nginx:1.31-alpine
                  ports: ["80:80", "443:443"]
                  volumes: [./nginx/conf.d:/etc/nginx/conf.d:ro, ./snippets:/etc/nginx/snippets:ro,
                            ./content:/srv/content:ro, ./certs:/etc/nginx/certs:ro]
  app:            image: ghcr.io/skunkworks/app@sha256:…      # D10: a digest, never a tag
                  expose: ["3000"]                            # no published port (C-11)
                  read_only: true
                  tmpfs: [/tmp]
                  mem_limit: 1024m                            # the only ceiling a plugin has (§13.3.6)
                  volumes: [./data:/srv/data, ./content:/srv/content]
                  environment: [SKW_DATA_DIR=/srv/data, …]    # §4.3, and nothing else
  acme:           image: nginxproxy/acme-companion
                  volumes: [./certs:/etc/nginx/certs, /var/run/docker.sock:/var/run/docker.sock:ro]
```

**Three services.** `IDEA.md` §3 said three, C-8 added a fourth (`plugin-runner`), and D36 deleted it
again: plugins are modules inside `app` (§13.3), so there is nothing for a runner to run and no socket to
bind. `mem_limit: 1024m` on `app` is now the only memory ceiling any plugin has — an OOM kill of `app` takes
every tenant down, which is why §13.3.6 states the absence of a per-plugin ceiling rather than implying one.
There is no `migrate` service: `app` runs the migration itself and reports per tenant (§2.3), because a
one-shot gate makes one tenant's corruption a fleet-wide outage.

### 12.2 Volumes

| Host path | Mount | Mode | Why |
|---|---|---|---|
| `./data` | `/srv/data` | rw | `control.db`, `tenants/`, `backups/`, `plugins/`, `trust/`, `logs/` |
| `./content` | `/srv/content` | rw | the one byte tree (§7.1) |
| `./data/plugins` | — | not mounted separately | inside `./data`; the app reads a package and never writes it after install, and the load path re-checks the root hash (§13.3.2) |
| `./certs` | `/etc/nginx/certs` | ro in nginx | acme-companion writes it |
| root filesystem | — | **read_only: true** + `tmpfs /tmp` | nothing the app runs needs to write outside the two volumes |

A read-only tenant mount is **not available** (O-03): SQLite returns `SQLITE_READONLY_DIRECTORY` on a `:ro`
mount even for the render path, and the root filesystem being read-only does not change that. There is
therefore no "cheap" middle isolation option between a rw volume and a separate process, and the SDS says so
instead of implying one exists.

### 12.3 The edge

> Amended by 02-errata.md E-5.

```nginx
# 00-default.conf — 404 from a location, never from server scope
server { listen 80 default_server; server_name _;
         location / { return 404; } }

# 10-app.conf — generated from control.db by tools/nginx_gen.ts.
# One server block per tenant; all of that tenant's hosts share one server_name line, because
# `map $host $tenant` carries host -> tenant, not the block. Adding a host changes the map and
# the line, never the number of blocks.
map $host $tenant { hostnames; default ""; acme.com acme; www.acme.com acme; }

limit_req_zone $tenant zone=tenant:10m rate=4r/s;    # derived, see below

server {
  listen 80; listen 443 ssl; server_name acme.com www.acme.com;
  location / {
    limit_req zone=tenant burst=8 nodelay;
    include /etc/nginx/snippets/skunk-proxy.conf;
    proxy_pass http://app:3000;
  }
  location /media/ { alias /srv/content/public/; try_files $uri =404;
                     add_header Cache-Control "public, max-age=31536000, immutable"; }
  location /__protected/ { internal; alias /srv/content/media/;
                     location ~ "^/__protected/[0-9a-f]{64}\.[a-z0-9]{1,5}$" { limit_rate 1m; } }
}

# demos.<domain> — the only host that serves /demo/ (C-25). No per-demo server block.
server {
  listen 80; listen 443 ssl; server_name demos.skw.test;

  # The slash-less form FIRST. If the proxying location below is the only one, it matches
  # /demo/<key> with an empty suffix, the rewrite does not fire, and an unstripped path reaches
  # the app, which is forbidden to strip it (C-2) and 404s.
  location ~ "^/demo/(?<demo_key>[a-z0-9][a-z0-9-]{0,39})$" {
    return 301 /demo/$demo_key/$is_args$args;
  }

  location ~ "^/demo/(?<demo_key>[a-z0-9][a-z0-9-]{0,39})(/.*)$" {
    rewrite "^/demo/[a-z0-9][a-z0-9-]{0,39}/(.*)$" /$1 break;
    include /etc/nginx/snippets/skunk-proxy.conf;
    proxy_set_header X-Skunkworks-Tenant $demo_key;
    proxy_set_header X-Forwarded-Prefix "/demo/$demo_key";
    proxy_pass http://app:3000;
  }

  location / { return 404; }
}

# admin.<domain> — the only host that serves /admin (E-2, §9.1). No /demo/, no /media/.
server {
  listen 80; listen 443 ssl; server_name admin.skw.test;
  location / {
    include /etc/nginx/snippets/skunk-proxy.conf;
    proxy_pass http://app:3000;
  }
}
```

Every `location` regex is quoted, so `{` is part of the pattern and not a block delimiter. The demo key
grammar is `[a-z0-9][a-z0-9-]{0,39}` — the same 40-character maximum as `control.db`'s
`tenant.key` CHECK, so every key the control plane accepts is reachable through `/demo/`. `listen 80`
is on every block because §12.5 promises a host serves on 80 while its certificate is
`certificate: pending`, and `listen 443 ssl` is emitted **only** for a host whose
`domain.cert_state = 'issued'` — a block that listens on 443 without a certificate fails `nginx -t`,
so the pending state must be a generated property of the block and not a comment. The admin session
cookie is `Secure`, so the admin is unusable over 80 by construction. The admin vhost carries no
`limit_req` zone: C-20's derived rate is per tenant and the admin surface is authenticated,
single-operator and CSRF-bound (S2's lockout, §16).

> Each tenant's edge rate is `rate = min(20r/s, floor(SKW_BOX_RPS / hot_tenants))` with `burst = 2 × rate`,
> where `SKW_BOX_RPS` is the box's measured four-source page throughput and `hot_tenants` is the count of
> tenants with a request in the last 60 s; one box serves at most 50 hot tenants at the 4 ms page budget, and
> a tenant that needs more than 20 r/s is deployed on its own box.

The measured box does 192 r/s on a 2.3 ms page at 50 connections. A fixed 20 r/s per tenant on a 50-tenant
box would permit 1,000 r/s against a 192 r/s ceiling — 5.2× over, with every dashboard green. On a 50-tenant
box the derived rate is 4 r/s, burst 8.

`default_server` answers from `location / { return 404; }`. A `return 404` in **server scope** was measured
to swallow the health location and make the edge `(unhealthy)` — a config that reports itself broken.

### 12.4 Boot gate, split by plane (C-10)

> `migrate` exits 0 with a JSON report naming every tenant it migrated and every tenant it could not; `app`
> starts regardless; a tenant whose `user_version` is below `tenant.db_version` serves
> `503 SKW_E_DM_SCHEMA_STALE` with `Retry-After: 5` on every route and is repaired lazily on the next request;
> a failure to migrate `control.db` prevents startup with exit 15 and a message naming the migration.

The asymmetry is the decision: every request needs `control.db`, so an app that boots on a half-migrated
control plane would 404 everything — a silent outage is worse than a loud refusal. No request needs another
tenant's file, so one locked file at 03:00 must not stop 199 healthy sites from serving.

### 12.5 TLS

> Amended by 02-errata.md E-29.

Per-host HTTP-01 certificates, no wildcard (D7): a wildcard needs DNS-01 plus registrar API credentials;
HTTP-01 needs one A record. Let's Encrypt allows 50 certificates per registered domain per week, far more
than a sales pipeline of demos. The certificate never gates an install: a bundle that cannot yet obtain one
reports `certificate: pending` and serves on 80. Measured: 16.01 s of issuance with Pebble and
`PEBBLE_VA_ALWAYS_VALID=1`, excluding DNS, port 80 and rate limits — which is why the promise is bracketed.

The ACME `ask` endpoint is **dropped** (O-25): with a generated server block per known host, on-demand TLS
has nothing to ask about, and an `ask` endpoint is a way to make the box issue certificates for arbitrary
hosts.

### 12.6 Upgrade

`/healthz` reports `SKW_BUILD_ID`; `BUNDLE.json` carries `image.app_digest`. The `runner_digest` field is
**deleted** with the runner (E-31): a second image digest is a second thing to pin, and there is no second
image. A bundle written before the change is refused by `bundle_verify.ts` with `SKW_E_EXP_*` naming the
unknown key rather than ignored.
`install.sh --upgrade` pulls the new digest, runs `migrate`, and restarts; a second run is a no-op
(measured 7.5 s). A CVE *notification* channel, a version endpoint for clients, and automatic rollback are
**deferred** with a named experiment (§18.1).

---

---

## 13. Security model, and the in-process plugin boundary

The honest promise, in one paragraph: **tenant isolation is a permission boundary inside one Node
process, not a construction — and since D36 that same process also runs third-party plugin code.** A
construction would be a process or a syscall per tenant; we do not have that, and saying "no
cross-tenant query path exists by construction" was falsified four times in the debate — a readonly
handle can `ATTACH` a sibling and `VACUUM INTO` the public tree. What we do have is five permissions,
each tested, and four named paths that can break them. One of those paths is now the feature: a plugin
is a module imported into the app process, so the sentence "no code we did not ship runs in the
process" is false by design and P3 has been rewritten to say what actually holds — a signature, which
buys *identity* and *tamper detection*, not containment.

### 13.1 P1–P5: what is actually enforced

| # | Permission | Enforced by | Break it and you have | Tested by |
|---|---|---|---|---|
| **P1** | No statement that names a file | `render-read` is never handed SQL text; only `exportSnapshot()` opens an `exporter` connection | `ATTACH` from a pooled handle — `query_only` does **not** close it (measured: `main,temp,other`) | check 27 |
| **P2** | No write outside the tenant directory | `readonly: true` **and** `PRAGMA query_only=1` on every render handle, asserted on checkout | `VACUUM INTO` into `content/public/` — measured to publish a tenant's database under the web root | checks 2, 27 |
| **P3** | **The only third-party code in the process is code whose bytes a key we trust signed** | signature verified over the package root at install **and again at load**; root hash recorded in `cms_plugin_installed.root_hash`; a package whose bytes moved refuses to load with `SKW_E_PL_SIGNATURE` | an unsigned or mutated package running with the app's own privileges — which is every plugin anyway, once loaded (§13.3.7) | signature matrix; `test/plugin-load.test.ts` L1–L4 |
| **P4** | No caller-controlled path segment | a tenant key never becomes a path: the file path is `tenants/<key>/site.db` with `<key>` from a `control.db` row that matched `^[a-z0-9][a-z0-9-]{0,62}$`; asset bytes are addressed by `sha256`; a plugin id is matched against `^[a-z][a-z0-9]{1,19}$` before it becomes `data/plugins/<id>` | a key, a `storage_path` or a plugin id reaching `fs` — which is why `storage_path` is generated (check 11) | checks 11, 12; `L2` |
| **P5** | **No plugin is handed a `Database`, the control-plane handle, or SQL text** | the per-request context (§13.3.5) is built per request from a facade whose method set has no `exec`, `prepare`, `attach`, `pragma` or `db`; `control.db` is opened in `app/main.ts` and appears in no plugin context; every plugin-originated statement is compiled from the declared grammar, and the connection it runs on is asserted to have exactly one attached database | a plugin holding a raw handle can `ATTACH` a sibling tenant's file, or `VACUUM INTO` one — the two measured escapes behind P1 and P2 | `test/plugin-scope.test.ts` S1–S6 |

**P3 used to read "no code we did not ship runs in the process."** D36 deleted that sentence, not by
weakening it but by deciding the product needs plugins more than it needs the sentence. What is left is
an *identity* permission: we can say whose code it is and that it has not changed since they signed it.
We cannot say what it will do. §13.3.7 is the paragraph a security reviewer should read first.

The four paths that can break P1–P5, named so a reviewer can look for them:

1. **The DDL runner.** It emits SQL from a template and runs it on `admin-write`. A new operation, or a
   caller-supplied reference object, is a new SQL-executing extension point (register R1).
2. **Any `ATTACH`-capable handle.** `query_only` does not stop `ATTACH`. The only defence is that no
   render handle receives text; a dependency that opens its own handle to `site.db` defeats it entirely.
3. **Any `import()` of a plugin package — which now exists, deliberately.** The path is
   `data/plugins/<id>/` (D26: runtime-loaded, never compiled into the image); the package root is
   hashed and the `realpath` of the entry point must stay under that root, both checked at load, so the
   bytes we import are the bytes that were signed. What that check does **not** do is bound what the
   code may reach once it runs: in-process, `node:fs`, `node:child_process`, `node:net` and a fresh
   `better-sqlite3` handle to `data/control.db` are all one `import` away. §13.3.6 states the cost.
4. **A dependency of the app that opens its own handle** to `site.db` or `control.db`. Nothing in this
   design detects it; the answer would be a process boundary whose cost (10 GB at 200 tenants) we have
   already declined (C-8).

**What this is not.** It is not protection against a hostile *plugin* — there is no such protection in
this model, and §13.3.7 says so on the install screen in those words. It is not protection against a
hostile dependency, against a root operator, or against a filesystem-level bug in SQLite. A dependency
that opens its own handle to `site.db` makes P2 decorative, and the answer would be a process boundary
whose cost we have already declined (C-8).

### 13.1a An exclusive witness for every security gate

A gate is a test that can fail for the reason it is named for and for no other. Three rules, and they apply
to every acceptance criterion in §16 that names a security control:

1. **Exclusivity.** There is at least one test that goes **red when that gate's own mechanism is disabled**
   and stays green when a neighbouring check is disabled in its place. If two mechanisms produce the same
   code, the same detail and the same message, the test cannot tell them apart and it is not a witness for
   either. Where two checks legitimately overlap — the plan rule and the index rule do — each gets a case
   the other cannot refuse.
2. **The mechanism names its witness.** The source comment above the mechanism carries the test's file and
   its exact name, e.g. `Exclusive witness: test/sources.test.ts S2E-11`. A comment that names a test which
   has been renamed is a lie the build cannot see, so `test/witness.test.ts` holds one table of
   `mechanism → {file, test name}`; it asserts that the named test exists in the named file **and** that the
   mechanism's comment contains the name. Adding a security mechanism without a row there fails the suite.
3. **A positive control in the same suite.** Every gate that asserts a refusal also asserts the acceptance
   that the refusal is supposed to be distinguished from: the same input with the offending property removed
   succeeds. A suite that only asserts refusals cannot tell a working control from one that refuses
   everything, which is exactly how B1 (§9.6) shipped: every verification of a past day refused, and every
   test expected it to.

**What a mutation record is.** "The gate was seen to fail" is evidence, not a claim: for each new or changed
gate the build report records the mutation applied (the exact edited expression), the gate that went red,
the gate that stayed green, and the file's SHA-256 before and after. This is the method `S2-qa.md` §3 used;
it becomes the Builder's obligation rather than the reviewer's discovery.

**The rule this section now has to carry alone.** Two gates used to be two witnesses for one claim: the
runner refused an operation outside the grant *before* the host was asked, and the host validated the
operation against the manifest. With one process there is one check, so "defence in depth" is not a
property of §13.3.7 and must not be written as one. What replaces the second layer is a **mutation of the
first**: delete the capability comparison in `app/plugins/context.ts` and `test/plugin-scope.test.ts` S3
must go red with the undeclared table named, while S1–S2 (which test the tenant binding) stay green. A
single layer with an exclusive witness is a gate; a single layer with a test that would pass either way is
a comment.

> Amended by 02-errata.md E-22, E-33.

### 13.2 The browser half, which is not proven here

No browser exists on this box. Three behaviours are **specified but unverified**, and each has a
compensating server-side test that is real:

| Behaviour | RFC/spec basis | Compensating test |
|---|---|---|
| `__Host-` prefix rejection | RFC 6265bis §4.1.3: `Path=/`, no `Domain`, `Secure` | the header is asserted exactly (§7.4); a cookie the browser rejects is caught by a CI Chromium test in S3 |
| CSRF token theft from a same-origin demo page | cookies ignore ports; CORS does not block same-origin reads | C-25 removes the same-origin case entirely (separate demo host) |
| island props breakout in a real UA | JSON escaping of `<`, `>`, `&`, U+2028, U+2029 | the escaping is a unit test; the UA test is a CI Chromium test in S4 |

Stating this is not modesty; it is the difference between a spec a Builder can trust and a claim that
collapses on the first phone.

### 13.3 The in-process plugin model (D36)

> Amended by 02-errata.md E-31, E-32.

A plugin is a module imported into the app process that registers hooks, endpoints, admin screens and
owned tables. There is no `plugin-runner`, no socket, no second container, no RPC enum. This is the
WordPress model, chosen deliberately: it is the only plugin architecture that fits a box we sell, because
a process boundary costs 49.8 MB and 34 ms per tenant (C-8) and a per-instance boundary costs more than
the product. The cost is stated in §13.3.6 and repeated nowhere else: **a synchronously hanging plugin
cannot be timed out in-process.**

#### 13.3.1 What survives from the manifest, and what a capability now means

`plugin.json` is still the contract (§8.1), validated at install and stored verbatim in
`cms_plugin_installed.manifest_json`. Fields and their status under D36:

| Field | Status | What it does at runtime |
|---|---|---|
| `id`, `version`, `publisher {id, key_id}` | survives | identifies the package and the key that signed it; `id` must match `^[a-z][a-z0-9]{1,19}$` before it becomes a path segment |
| `cms` (range) | survives | checked at install **and** at load: a module whose declared range excludes the running build refuses to load (`SKW_E_PL_SCHEMA`), because an in-process ABI mismatch is a 500 on a page, not a 503 on an endpoint |
| `main` | **new, required** | the entry file, relative to the package root, `index.mjs` by default; this is what `import()` loads. A manifest without `main` is refused at install — under the runner the supervisor knew where the code was; the app must be told |
| `hooks` | **new, required** | the hook names the plugin intends to register (§13.3.4). A plugin may register only a declared hook; an undeclared `ctx.on()` is refused at activation with `SKW_E_PL_REJECTED`. This is a contract check, not containment: it makes the install screen able to list what the plugin touches |
| `tables` + `export` class | survives | created by the host executor (§8.2); the only tables the facade will name |
| `settings` | survives | typed, `secret` write-only; read through the facade, never from `process.env` |
| `admin` | survives, **declarative only** | a declared screen (list/form against a declared table). No plugin markup in the admin origin — the escape hatch is a data hook, not HTML (§13.3.4) |
| `public` | survives | declared paths and methods; mounted in the app router; body cap and spam controls are core, not plugin-supplied (§8.6) |
| `capabilities` | survives **as disclosure** | listed on the install screen, in plain words, beside the key fingerprint. They gate the facade methods a plugin may call (§13.3.7) and nothing else. They are not a sandbox and the UI says so |
| `tests {entry, timeout_s}` | survives, re-based | runs at package time against a scratch `site.db` **in the app image**, and the report records the app image digest; a report from another digest is `SKW_E_PL_TESTS_STALE` (§8.5) |
| `cron` | survives as `"none"` | the only legal value in v1 (O-43 deferred). There is no scheduler to register with |

A table without an `export` class is still refused at install (`SKW_E_PL_NO_EXPORT_CLASS`). What is gone
from the manifest's meaning: the old `capabilities` array was the *grant* the runner enforced; it is now
the list of facade methods the host will answer, and the difference is the whole of §13.3.7.

#### 13.3.2 The load path

```
enable(tenant, id):
  1. read the installed row; refuse if status='failed' without an operator ack
  2. re-verify the signature over the package root; refuse SKW_E_PL_SIGNATURE if the bytes moved
  3. check manifest.cms against the running build; refuse SKW_E_PL_SCHEMA
  4. entry = realpath(data/plugins/<id>/<manifest.main>); refuse unless it is under the package root
  5. namespace = await import(pathToFileURL(entry).href
                              + '?tenant=' + encodeURIComponent(tenant)
                              + '&act='    + String(row.activation_seq + 1))
  6. assert typeof namespace.activate === 'function'; refuse SKW_E_PL_LOAD otherwise
  7. ctx = makeContext(tenant, id, row.manifest, {activationOpen: true})
  8. await namespace.activate(ctx)                     # registration happens here, and only here
  9. ctx.closeActivation(); registry.commit(tenant, id, ctx.registrations)
 10. status='enabled', activation_seq += 1, audit row
```

**Why the cache-buster is not optional.** Node's ESM cache is keyed by URL. Without `?act=`, a
disable→enable cycle returns the *previous* module namespace: module-level state survives, a top-level
`setInterval` from the first activation still runs, and "not loaded" is a lie the admin UI tells. The
activation counter is monotonic per (tenant, plugin) and is the only thing that changes between loads.

**Why the tenant is in the URL.** One module instance per (tenant, plugin, activation) means a
module-level variable cannot carry a value from tenant A to tenant B by accident. WordPress is
single-tenant and never faces this; we do. The cost is one module instance per enabled (tenant, plugin)
pair — small for a normal package, and the number to *measure* at S4 rather than assume (§13.4 item 6).
A plugin can still reach `globalThis` deliberately, so this is an accident-preventer, not a boundary.

**State.** Module-level state does not survive disable/enable, by design: the second activation is a new
module instance with an empty scope. Settings (`cms_plugin_settings`) and `p_*` rows are the only durable
state, which is exactly what export carries (§11.1).

#### 13.3.3 The registry, and why it is per tenant

One registry in the app process:

```
registry: Map<tenantKey, Map<pluginId, {
  hooks:     Map<hookName, HookFn[]>,
  endpoints: Map<'METHOD /path', Handler>,
  screens:   Map<screenPath, DeclarativeScreen>,
  activationSeq: number
}>>
```

- **Per tenant** because a plugin is enabled per tenant (§8.6): tenant A enabling `contact` must not
  make it run on tenant B, and a dispatch must never have to ask "which tenant is this for" — the key
  already answered.
- **Prunable** because disable is `registry.delete(tenant, id)` in one operation. There is no partial
  unregistration and no path where a disabled plugin's hook still fires: dispatch reads the map, and a
  map that has no entry has no callbacks.
- **Snapshot on dispatch.** A render takes `snapshot(tenant)` once, at the top, and iterates a frozen
  array. A disable that lands mid-render therefore cannot mutate the array being iterated; the request
  finishes on the callbacks it started with, which is the honest boundary of "disable takes effect
  immediately" (§13.3.8).
- **Registration is closed after activation.** `ctx.on()` refuses once `closeActivation()` has run, so a
  hook cannot be added later from a timer or a promise callback. That is what makes pruning complete
  rather than best-effort.
- **Cost.** One `Map.get` per dispatch (two for the plugin). Measured at S4; it is a lookup, not an
  allocation, and the snapshot is one `Array.of` per hook per request.

#### 13.3.4 The hook surface, and what a return value may change

Twelve hooks, frozen. Six filters (the return value replaces the value handed in) and six actions (the
return value is discarded). A hook not on this list does not exist; `ctx.on()` refuses it.

| Hook | Kind | Signature | What a return value may change |
|---|---|---|---|
| `content.render.html` | filter | `{tenant, path, page} → html` | the page body html, and only that. It cannot change status, headers, cookies or the resolved route; there is no parameter for them |
| `page.head` | filter | `{tenant, path} → html` | extra `<meta>`/`<link>` markup in `<head>`, string ≤ 4 KiB |
| `asset.url` | filter | `{tenant, key, url} → url` | the URL emitted for one asset; must be root-relative or `https://` absolute, else the original is used and the hook counts as failed |
| `form.validate` | filter | `{tenant, form, values} → {ok:true} \| {ok:false, errors[]}` | may **refuse** a submission that core accepted. May not accept one core refused: core's own rules run first and `ok:true` cannot resurrect them |
| `admin.menu` | filter | `{tenant, items} → items` | may add an entry pointing at a **declared** admin screen; an entry pointing anywhere else is dropped |
| `mail.template` | filter | `{tenant, template, vars} → vars` | may add or change template variables. Not the recipient: `mail.send`'s `to` rule (§8.3, retained) still decides who receives |
| `page.rendered` | action | `{tenant, path, status, ms}` | nothing — return ignored |
| `form.submitted` | action | `{tenant, form, submissionId}` | nothing — runs after commit, side effects only |
| `download.redeemed` | action | `{tenant, codeId, assetKey, jti}` | nothing. Observe only: a plugin can never grant a download |
| `admin.login` | action | `{tenant, operatorId}` | nothing — post-authentication |
| `plugin.enabled` | action | `{tenant}` | nothing — the plugin's own lifecycle |
| `plugin.disabled` | action | `{tenant}` | nothing |

**The rules that make a filter a filter.**

1. A filter's return value replaces **only the named value**. Status, headers, `Set-Cookie`, redirects and
   the route are not in the signature and cannot be produced by returning something clever. This is why
   `download.authorize` is absent: a hook that could grant a paid download is a hook that turns a plugin
   bug into a revenue leak.
2. `undefined`/`null` means "no change" — pass the original through. It never means "delete", and it never
   means "empty string": a plugin that wants to empty a value returns `''`.
3. A wrong type is a **failure**, not a coercion: the original value is used, the hook is skipped for this
   dispatch, and the failure counts toward auto-disable (§13.3.6). A filter that returns a `Promise` of the
   wrong type is the same failure.
4. A throw is caught at the dispatch site; the request continues with the value passed in. A page never
   500s because a plugin filter did.
5. Hooks run in registration order, one after another, awaited. A hook may not call another hook
   re-entrantly (same tenant, same hook, already on the stack): the inner call is refused and counted, so a
   filter cannot recurse the render path into a stack overflow.

**Absent by decision**, each absence a control: `download.authorize`, `download.issue`, `route.resolve`
(a plugin may not shadow a tenant's path), `admin.render.html` (no plugin markup in the admin origin),
`admin.session`, `db.*`, `sql`, `fs.*`, `net.*`, `http.*`, `fetch`, `env`, `tenant.*`, `cms.*`,
`cron` (O-43), `worker`, `spawn`, `stream`. The first three are absent because they would each be a way to
change an outcome the host owns; the rest are absent because in-process they would be theatre — a plugin
can `import('node:fs')` itself, and §13.3.7 says so.

#### 13.3.5 The per-request scope: which handle, bound to what

A context object is built **per request**, frozen, and contains no `Database`, no `control` handle, no
filesystem path and no `process.env`:

| Context | Facade given | Connection behind it | Write? |
|---|---|---|---|
| render (a page, block or island) | `store.read`, `settings.get`, `assets.resolve`, `mail.send`, `log.write`, `util.*` | `render-read` for the tenant resolved by this request (`readonly:true`, `PRAGMA query_only=1`) | **no.** `store.write` is absent from the object, not disabled on it |
| public endpoint | the render facade **plus** `store.write` | `admin-write` for that tenant | only `INSERT` into declared `p_*` tables, through the declared-column grammar |
| admin screen | the render facade plus `store.write`, `store.update`, `store.delete` | `admin-write` for the session's tenant | declared `p_*` tables only; **no DDL** — migrations are the host executor at install (§8.2), never a runtime call |
| activation / deactivation | `settings.get`, `log.write`, `util.*`, declared-table reads | `admin-write` (the install transaction already holds it) | no writes at activation: a plugin that needs a row writes it on first use |

**Bound to the current tenant, and only that.** The tenant is closed over by the facade; there is no
tenant parameter in any method. A call that passes one is refused `SKW_E_PL_REJECTED` and audited, because
the attempt is the signal. The tenant comes from `resolveTenant()` (host-routed) or `resolveAdminTenant()`
(session only) — never from a header, a body or a query string — so the plugin inherits the same binding
the page did.

**`ATTACH` is refused, and the refusal is structural.** The facade has no method that takes SQL, so
`ATTACH`, `DETACH` and `PRAGMA` are not expressible through it. On top of that, the connection a plugin
call runs on is asserted to have exactly one attached database (`PRAGMA database_list` = `main`) before the
statement is issued; a second entry refuses the call with `SKW_E_PL_REJECTED` and disables the plugin,
because the only way it can appear is a path we did not write. The facade never exposes the connection
object, and the context is frozen, so a plugin cannot reach through it.

**Never the control plane.** `control.db` is opened in `app/main.ts`; it is not a field of any context and
not reachable from one. `tenants/<other>/site.db` is likewise not reachable *through the facade* — the
facade's connection is already open on one file. A plugin that opens its own handle by path can read
anything the process can (§13.3.7); that is the cost of the model, not a gap in this paragraph.

**Lifetime is the request.** The facade closes over a request-scoped connection and a `closed` flag; both
are released on response end. A plugin that stashes the object and calls it later gets
`SKW_E_PL_CONTEXT_ENDED` rather than a handle into a reused connection — the one failure mode that would
otherwise turn a cache into a cross-tenant read.

#### 13.3.6 The failure model, and the hang that cannot be timed out

**Load time.** Steps 2–9 of §13.3.2 run inside one `try/catch`. A package that throws at import, whose
`activate` throws, or whose export shape is wrong is marked `status='failed'`, `enabled=0`, and an admin
notice names the code and the plugin. The site keeps serving: the registry never received its hooks.

**Per request.** Every dispatch and every endpoint call is `try/catch` plus an `await Promise.race` against
`SKW_PLUGIN_HOOK_TIMEOUT_MS` (default 2000). That race catches **a promise that never settles** — an
async hang costs one request and the timeout reclaims it. It does **not** catch a synchronous infinite
loop, because the timer needs the event loop that the loop is blocking.

> **The synchronously hanging plugin cannot be timed out in-process. This is the accepted cost of the
> model and nothing in this design mitigates it at runtime.** A `while (true)` in a hook stops every
> tenant on the box, not just the one that installed it. There is no watchdog, no worker thread, no
> `vm.Script` timeout, and no signal that can interrupt a running function in the same thread. A document
> that implies otherwise is lying to the operator who has to explain the outage.

Three things reduce the *frequency*, and none of them is a timeout:

1. **The install gate.** `manifest.tests` must pass in the app image, against a scratch `site.db`, with the
   report's digest matching the running image (§8.5). A package that hangs its own test suite is refused
   before it is installed.
2. **The publisher gate.** A third-party package needs a key the tenant owner imported, with the
   fingerprint shown beside every capability (§8.5, D27). That is a human trust decision, made once.
3. **The recovery path, which is a separate process.** `skwctl plugin disable <id> --tenant <key>` writes
   the flag; boot reads it and never imports the module. So a box that will not finish booting is
   recoverable from a shell without a working app — this is the only reason the flag is read from the
   database at load time rather than from memory.

**Failure counting.** Three failures within 60 s for one (tenant, plugin) — a throw, a wrong-type return,
a hook timeout, an undeclared capability call — set `status='failed'`, `enabled=0`, prune the registry,
and raise an admin notice. This is a counter, not a circuit breaker with a half-open state: recovery is an
operator action (`skwctl plugin enable`, or the admin screen's "retry"), because a plugin that failed
three times in a minute is not entitled to a fourth attempt on its own schedule.

**What a broken plugin looks like from outside.**

| State | Its endpoints | A page that calls its hooks |
|---|---|---|
| `disabled` | `503 SKW_E_PL_UNAVAILABLE` | renders normally; the hooks are not in the snapshot |
| `failed` | `503 SKW_E_PL_UNAVAILABLE` | renders normally; the failing hook is skipped and the value passed in is used |
| mid-request failure | the current request finishes on the snapshot it started with | 200, with core behaviour for that hook |
| uninstalled | `404` | renders normally |

**Memory.** There is no per-plugin ceiling, because there is no cgroup per plugin: every plugin shares the
app container's memory. `mem_limit` on `app` is the only ceiling, and an OOM kill takes the whole site
down, not one package. `SKW_E_PL_OOM` is **withdrawn** — it named a per-package cgroup that no longer
exists. An operator sizes the box for the plugins they install, and the install screen says so.

#### 13.3.7 What replaces the two-layer capability proof, and what a signature does not buy

**The old proof, for the record.** Two layers: the runner refused an operation outside `binding.granted`
*before* the host was asked (`runner/server.mjs:421`), and the host validated the operation against the
manifest (`app/plugins/ops.ts`). The comment in `app/plugins/endpoint.ts:97–99` said the quiet part out
loud — "the two layers see one value and the second one does not depend on the first." That is what
defence in depth means, and it is gone.

**What replaces it is one enforced layer and one witness.**

- **The layer.** Every capability crossing is a facade method. Its first act is to read the grant from
  `cms_plugin_installed.manifest_json` **inside the current request** — not from a manifest object the
  plugin holds, not from a value the plugin passes — and compare it to the method being called. A miss is
  `SKW_E_PL_REJECTED`, raised before the connection is touched. The check is in one place
  (`app/plugins/context.ts`), and the facade is the only way to reach a tenant's data, so "one place" is
  not a hope: there is no second door to leave unlocked.
- **The witness.** Because there is no second layer to catch a bypass, the gate must be a mutation of the
  check, not an observation of the plugin: delete the comparison, and `test/plugin-scope.test.ts` S3 must
  go red naming the undeclared table, while S1–S2 (tenant binding) stay green. A test that passes because
  the plugin happens not to try is not a witness (§13.1a).
- **What the layer is for.** It stops accidents, contract violations and a compromised *package* that
  only uses the API. It does not stop a hostile plugin, because a hostile plugin does not use the API. That
  is the single sentence the install screen must not blur.

**Capabilities are disclosure.** The manifest's `capabilities` array is shown to the operator in plain
words, beside the publisher fingerprint, before enable. It is not a sandbox and the screen says so, in
these words:

> Capabilities describe what this plugin asks the CMS for. They do not limit what its code can do: a
> plugin runs inside the site's process, with the site's own access to its files and databases.

**A signature buys author identity and tamper detection. It does not buy containment — not even a
little.** What it gives:

| Claim | True? | Why |
|---|---|---|
| these bytes were signed by the holder of this key | **yes** | Ed25519 over the package root and file list (`app/plugins/trust.ts`); verified at install and again at load, so a package edited on disk refuses to load |
| the package has not changed since it was signed | **yes** | root hash recorded and re-checked at every load |
| this plugin will not read another tenant's database | **no** | it is in the process; `import('better-sqlite3')` and a path are all it takes |
| this plugin will not block the event loop | **no** | there is no timeout that can interrupt it (§13.3.6) |
| this plugin will only use the capabilities it declared | **no** | the facade enforces the declaration; the code can ignore the facade |

A signed plugin and an unsigned one have identical power at runtime. The difference is that we can say
who wrote it, and that nobody else has modified it since.

#### 13.3.8 Enable, disable, uninstall, without a restart

No restart, no compose change, no socket to rebind. Every row below is a database write plus a registry
operation in the running process.

| Action | Mechanism | Data | In-flight requests | Public endpoint |
|---|---|---|---|---|
| **Enable** | §13.3.2 steps 1–10, all-or-nothing: any failure rolls the registry back and sets `failed` | untouched | the next request sees the hooks; requests already rendering do not | live on the next request |
| **Disable** | `plugin.disabled` action (bounded, `try/catch`) → `registry.delete(tenant, id)` → drop the namespace reference → `status='disabled'` | untouched | finish on the snapshot they started with | `503 SKW_E_PL_UNAVAILABLE` |
| **Uninstall** | drain → disable → `VACUUM INTO` the whole-tenant archive (§8.2) → drop `p_*` tables, registry rows, package dir | archived first, then dropped; the archive is whole-file, so restoring it rolls back every other change since (O-40) | drain waits for the tenant's in-flight count to reach 0, bounded at 5 s, then refuses `SKW_E_PL_BUSY` rather than drop a table under a live request | `404` |
| **Upgrade** | uninstall-then-install only (no downgrade, §8.2) | archive first | as uninstall | as install |

Two semantics worth stating because they are easy to get wrong:

- **Disable is not "the hooks are skipped".** They are *removed*. There is no branch that checks
  `enabled` and returns early, because that branch is one refactor away from being inverted. The map has no
  entry.
- **Module-level state dies on disable.** The next enable is a new module instance with a new cache key
  (§13.3.2). A plugin that needs to survive its own disable writes a row.

#### 13.3.9 The retirement list

What D36 deletes, and what happens to the gate that used to prove it. The full reader-facing version is
`docs/sds/13-plugin-model-delta.md`; this table is the operative one.

| Artefact | What it was | Disposition | Gate |
|---|---|---|---|
| `plugin-runner` service (`docker-compose.yml`) | fourth container, `network_mode:none`, `read_only`, `cap_drop`, `pids_limit:64`, `mem_limit:384m` | **deleted** — three services again | §16 S1 "compose has exactly 4 services" is **withdrawn**, replaced by "exactly 3; `app` publishes no port" |
| `runner/server.mjs` (638 lines) | socket server, supervisor, per-child spawn, op timeout, OOM classification | **deleted** | `test/runner-memory.test.ts` M1–M4 **withdrawn**: there is no per-package cgroup to assert |
| `runner/child.mjs` (127 lines) | `node --permission` entry point per package, local ops, bound host channel | **deleted** | replaced by `test/plugin-load.test.ts` L1–L4 (import, shape, signature, context) |
| `runner/Dockerfile`, `runner/package.json` | the runner image | **deleted** | image build gate loses this target |
| `run/plugin.sock`, the JSON-lines frame protocol (`plugin.invoke`, `granted[]`, host-op callbacks) | the wire between app and runner | **deleted** — `protocol.ts` keeps the manifest grammar and loses the frame types | protocol round-trip tests **withdrawn**; nothing crosses a process |
| Runner-side capability enforcement (`runner/server.mjs:421`, `binding.granted`) | the first of two layers | **deleted** — see §13.3.7 | the gate is re-pointed to a mutation of the *remaining* check; the "two layers see one value" comment is deleted with `endpoint.ts`'s socket error-lifting block |
| `app/plugins/host.ts` (262 lines) | socket client, 2 s per-op timeout, cross-process circuit breaker, `PL_UNAVAILABLE` when the socket is absent | **deleted**, replaced by `runtime.ts` (load/activate), `registry.ts` (per-tenant maps), `context.ts` (facade + capability check) | new: `test/plugin-scope.test.ts` S1–S6; `test/plugin-load.test.ts` L1–L4 |
| `SKW_E_PL_OOM` | a package killed at its own cgroup | **withdrawn** from the taxonomy | no gate: the mechanism is gone |
| `§13.4` item 2, "the composed plugin path across two containers" | an unmeasured 37 µs sum | **withdrawn**; the composed path is now one process and is measured directly | — |

**Gate accounting, stated plainly:** three gates are withdrawn rather than passed — the four-service
compose assertion, the per-package memory assertions M1–M4, and the two-container composed-path claim.
Two are re-pointed (the `asset_key` delete guard and the test-report digest, which now names the app
image). Nothing is claimed green that has not run.

### 13.4 What is not proven anywhere in this document

1. **ACME against a production CA.** Measured against Pebble with validation short-circuited only.
2. **A 1 GiB bundle transfer.** 6.8 min at 20 Mbps is arithmetic over a measured bundle size, not a link
   test. The promise excludes transfer and caps the bundle.
3. **Browser behaviours** (§13.2).
4. **PII retention after a demo expires.** O-31 sets the 30-day soft delete and the final archive; how long
   the archive is kept is a legal decision, not an SDS contract.
5. **The absence of containment.** There is no measurement of a boundary because there is no boundary. A
   plugin that reads `data/control.db` is five lines; we have not written it as a test, because a test that
   demonstrates the absence of a control is a demonstration, not a gate. A reviewer should treat §13.3.7 as
   the statement of record, not as a proof by omission.
6. **The memory cost of one module instance per enabled (tenant, plugin) pair.** It is a budget to
   measure at S4, not a number this document knows. It is the price of the per-tenant cache key in
   §13.3.2, and if it is wrong the alternative is one instance per plugin with a documented rule that
   module-level state must not be tenant-specific — a rule no test can enforce.

---

## 14. Failure modes and risk register

Ranked by expected damage, not by likelihood. Every row names the detection and the mitigation, because a
failure mode with no detector is a rumour.

| # | Failure | Detected by | Mitigation | Accepted in |
|---|---|---|---|---|
| **F1** | A missing farm symlink for a *gated* asset, so `/media/<key>` serves paid bytes | the mandatory link-absence test on every bundle: `find content/public -lname "*<gated sha>*"` empty, `GET /media/<key>` 404, direct `/__protected/…` 404 | `/__protected/` is `internal` with a 64-hex guard; the farm regenerator refuses a gated row; the test runs per bundle, not once | C-17 |
| **F2** | An exporter path that is not `exportSnapshot()`, so a bundle is built from a live file | `BUNDLE.json.source_counts` compared by `install.sh`; a `-wal` in the tree is a build failure | quiescence counts before/after/in-snapshot; `VACUUM INTO` is the only copy primitive; the exporter is the only caller of the `exporter` class | O-18, O-19 |
| **F3** | A fourth SQL-executing extension point (or a dependency with its own handle), breaking P1/P2 | code review plus the `no-restricted-imports` rule; a runtime assert on pool checkout that `query_only=1` is set | three classes, one factory module, no SQL text on a pooled handle | C-15, R1 |
| **F4** | A plugin — hostile or merely wrong — blocking the event loop, so every tenant's pages stop | **nothing at runtime**: the app stops answering `/health`, request latency alerts fire, and the operator has no in-process signal that distinguishes a plugin from a slow query | the install test gate and the publisher key reduce the frequency; recovery is `skwctl plugin disable <id> --tenant <key>` from a shell, and boot reads the flag from the database. **No timeout, watchdog or worker exists** — this is the accepted cost of D36, stated in §13.3.6 | D36, §13.3.6 |
| **F4a** | A plugin reading another tenant's database, or `control.db`, through its own handle | **nothing**: it is the same process with the same credentials | none — no containment is claimed. The facade (§13.3.5) closes the accidental path; the deliberate one is out of scope by decision | D36, §13.3.7 |
| **F4b** | A plugin holding the app's memory until the kernel kills `app` | the container's `mem_limit`, and the OOM kill in `docker events` | one ceiling for the whole app: an OOM takes every tenant down. `SKW_E_PL_OOM` is withdrawn — there is no per-package cgroup to name | E-30 **withdrawn by E-31**, §13.3.6 |
| **F5** | A demo page escalating to admin on a shared origin | the admin listener's `421` for a demo `Host`; the separate demo hostname | C-25's separate host; CSRF bound to the session; `Origin` exact match | C-25 |
| **F6** | A code redeemed 4× because `Range` requests each spend a use | reconciliation: `count(kind='first')` vs `uses` per code; an alert when they disagree | insert-first, one `jti` per redemption, partial unique index | C-7 |
| **F7** | One tenant's migration failure taking the fleet down at 03:00 | `migrate`'s per-tenant JSON report; `/admin/api/tenants/<key>/health` | split gate: control-plane failure exits 15, tenant failure 503s that tenant only | C-10 |
| **F8** | A rename of a referenced asset key stalling every writer | `409 SKW_E_DM_KEY_IN_USE` with a reference count; `pg`-style lock waits do not exist here, so the symptom is `SQLITE_BUSY` | `ON UPDATE RESTRICT` + a bounded audited `repoint` | C-3 |
| **F9** | Disk full on the tenant volume | `SKW_E_DM_QUOTA` (507) at the quota, and `statvfs` before any export/write | per-tenant byte quota; export refuses with `SKW_E_EXP_INSUFFICIENT_DISK` | §7, §11.3 |
| **F10** | Watermark renderer hangs, blocking downloads | 2000 ms budget → `SKW_E_SEC_WATERMARK_FAILED`; render worker queue depth | off-loop worker, per-tenant semaphore of 8, fail closed, event row | C-16 |
| **F11** | A certificate never issues, install "succeeds" but 443 is dead | `cert_state` in `domain`, and the printed install report | `certificate: pending`, install does not gate on it; `install.sh` exits 11 on a wrong A record in 0.3 s | §12.5 |
| **F12** | A static bundle with a 404 where the CMS has content | preflight refusal 3 (`free` parameter in a link) | enumeration + refusal, never freeze-at-default | C-22 |
| **F13** | A tampered or truncated audit log going unnoticed | the daily seal comparison (`count` + head) | chain + seal; `SKW_E_SEC_AUDIT_SEAL` | C-21 |
| **F14** | A bundle carrying our customers' data | `BUNDLE.json` per-file `class`; `--include-pii` off by default and audited | projection classes (`empty` for codes, events, submissions, renders, audit) | O-20 |
| **F15** | A plugin upgrade that destroys data | `SKW_E_PL_DESTRUCTIVE_UPGRADE` before any SQL; the migration grammar has no `drop_table` | four-op forward-only grammar; uninstall archives the whole file first | §8.2 |
| **F16** | A stale tenant serving wrong content instead of a 503 | the connection factory's `user_version` check on every open | `503 SKW_E_DM_SCHEMA_STALE` + `Retry-After: 5` + lazy repair | C-10 |

### 14.1 The risks that survive this design (register R1–R6)

| # | Survives because | What would make it a problem |
|---|---|---|
| R1 | Isolation is a **permission** boundary in one process (P1–P5), and P5 is a facade rather than a construction | a fourth SQL-executing extension point, a dependency opening its own handle, or a plugin that bypasses the facade with its own `better-sqlite3` handle — which is five lines and explicitly out of scope (D36) |
| R2 | **No containment at all is claimed**: a plugin runs in the app process, and a plugin that blocks the loop or reads another tenant's file is not defended against | a plugin that must DoS for a living, ten plugins on a 1 GB box, or one plugin with a `while (true)` — §13.3.6, accepted cost |
| R3 | "Fully drag-and-droppable on day one" is now "fully draggable **within the shipped registry**" | the first client asks for a widget we did not ship |
| R4 | Export correctness rests on a **producer** rule (quiescence counts), not a verifier | any exporter path that is not `exportSnapshot()` |
| R5 | Access codes are 16 characters, not 12, because the selector removed the only fleet-wide secret | a client refuses a 16-character code — the fallback is a pepper and a rotation runbook |
| R6 | "A gated asset is absent from the public tree" is a **link-absence test**, not a missing directory | someone copies `content/media/` into `content/public/`, or the verifier is skipped for one bundle |

### 14.2 The five-minute walk (what a new operator does in the first five minutes)

1. `curl /healthz` → `{build, uptime}`; no database touched.
2. `curl /readyz` → 200 only if `control.db` opens, a revision reads, and one scratch write lands.
3. `psql`-free: `sqlite3 data/control.db 'select key,mode,status,db_version from tenant'`.
4. `docker compose logs app | grep SKW_E_` → every refusal since boot, with its code.
5. `ls data/tenants/*/site.db && sqlite3 … 'pragma user_version'` → every tenant at 3 or a named report.

If any of the five is surprising, the install is not done.

---

## 15. Performance budgets

Two kinds of number: **measured here** (by `make test`, reproducible on this box) and **measured in the
corpus** (a debate paper's run, cited because the SDS depends on it). "Fast" is not a spec.

### 15.1 Measured here

| Quantity | Value | Source |
|---|---|---|
| argon2id verify, `m=19456,t=2,p=1` | 23.5–28.5 ms median across four runs, one 33.7 ms outlier under load | checks 17, 21 |
| argon2id verify, `m=65536,t=3,p=1` | 124.3–139.3 ms — **5.4× the cost** | check 17 |
| equality scan of 5,000 argon2 hashes | 356–423 s across runs — the reason a selector exists | check 7 |
| selector seek, 5,000 codes | 5.5–6.1 µs p50 over 1,000 lookups, `SEARCH` in the plan | check 21 |
| selector collisions per 5,000 issuances | 8–12, resolved by retry | check 21 |
| 24 concurrent redemptions, one `jti` | `uses=1`, one `first` row | check 22 |
| audit: 10,000 rows chained / verified / sealed | 60–87 ms / 35–49 ms / 45–81 µs across four runs | check 25 |
| audit storage | 32.1 KB per tenant-year | register C-21 |
| asset delete guard, 200k references | 7.1–7.8 ms unindexed vs 0.021–0.024 ms indexed | check 19 |
| empty `control.db` / `site.db` after VACUUM | 110,592 B / 319,488 B | `validate_schema.py` |
| schema size | 35 tables, 298 columns, 21 FK clauses, 26 explicit indexes, 5 triggers | `validate_schema.py` |
| `make test` wall clock | 27 checks, one run | `01-verification.md` |

### 15.2 Measured in the corpus, and what depends on it

> Amended by 02-errata.md E-32.

| Quantity | Value | What it decides |
|---|---|---|
| four-source page throughput, 2.3 ms page, 50 connections | 192 r/s (p50 148 ms, p99 2,710 ms) | `SKW_BOX_RPS` default and the derived per-tenant rate (C-20) |
| page render, 83 KB body | 0.13 ms; a render-time CSP hash would add 0.044 ms (+34 %) | no hash, no nonce (C-12) |
| ~~plugin runner idle / per child / IPC~~ **withdrawn (E-31)** | ~~47.4–48.0 MB / 38.2–42.8 MB / 22 µs~~ | there is no runner; these numbers are history, kept in §8.4 as the price the model declined to pay |
| per-tenant process (rejected) | 49.8 MB peak, 34 ms cold start → ~10.0 GB at 200 tenants | why there is no process per tenant |
| watermark, 40-page PDF | 51.9 ms cold / 23.4 ms warm, +60 % bytes | 2000 ms budget, off-loop (C-16) |
| `count(*)` over 90 k rows | 1,990 µs indexed / 4,374–5,020 µs unindexed | aggregate grammar + publish gate (C-18) |
| migration fan-out / pooled handle | 4.05 ms per tenant / 185 KB per handle | `SKW_DB_POOL_MAX=64` ≈ 11.8 MB |
| `CASCADE` rename at 200k references | 439 ms settled / 2,412 ms in-transaction | `ON UPDATE RESTRICT` (C-3) |
| bundle, sealed vs naive | 224,983 B vs 8,739,862 B on one fixture | the exclusion list (§11.5) |
| snapshot per combination | 561 B raw / 103 B gzip; 500 combos = 274 KB | `SKW_SNAPSHOT_MAX_COMBOS=1024` (C-22) |
| `astro build` for 1,024 pages | ≈ 50 s | inside the ≤ 3 min Astro target |
| install | 18.2 s warm / 29.8 s cold-pull / 7.5 s re-run / +16.0 s TLS | the bracketed promise (§1.2) |

### 15.3 The budgets a Builder must not exceed

| Path | Budget | Refusal if exceeded |
|---|---|---|
| any synchronous work on the event loop | **5 ms** (I15) | `monitorEventLoopDelay` p99 > 50 ms → `503 SKW_E_RT_LOOP_CONGESTED` |
| a Data Source at render | 1.5 ms worst-case (published), 4 ms page total | `SKW_E_RT_SOURCE_BUDGET` at publish |
| a watermark render | 2000 ms wall, off-loop, semaphore 8 | `SKW_E_SEC_WATERMARK_FAILED` |
| a plugin RPC op | 2 s | circuit breaker → `SKW_E_PL_UNAVAILABLE` |
| a page body | 83 KB typical, no hard cap; the publish gate measures cost, not size | — |
| a snapshot | 1024 combinations, 2 MB per source | `SKW_E_EXP_PARAMETERISED` |
| a bundle | size capped and printed at export | `SKW_E_EXP_INSUFFICIENT_DISK` at 2× |

---

## 16. Delivery slices

> Amended by 02-errata.md E-15, E-2, E-8, E-25, E-28.

Four slices, each with acceptance criteria and the gate that proves it. A slice is done when its gate
is green in CI, not when its code is written.

**The gates declare their interpreter.** `make test` runs `scripts/model/verify_claims.py` on
`PYTHON ?= /usr/bin/python3`; that pin is deliberate and deterministic, and it is **not** a claim that
`/usr/bin/python3` ships `argon2-cffi` on Linux — it does not. `make verify-toolchain` runs first and
asserts that the chosen interpreter imports `argon2` and `sqlite3`, failing with the package name
(`argon2-cffi`) and the interpreter path it tried. A **skip is a failure** in `verify_claims.py`
unless the gate was invoked with `--allow-skip`, and the Makefile never passes it. CI runs the claims
gate twice: once on `/usr/bin/python3`, and once on an interpreter whose SQLite is **≥ 3.50**, so the
amendment chain is exercised on the version that re-parses triggers instead of only on the one that
tolerated the defect.

### S1 — Hosting core (2 wk)

**Contains:** Astro SSR shell, tenant resolution (host + path prefix + admin session), `control.db`,
nginx config generation, acme, compose, one hand-built page rendering, the boot order of §2.3.

| Acceptance criterion | Gate |
|---|---|
| `GET /pricing` on a mapped host renders the tenant's page | integration test, 3 hosts |
| the 10 resolution steps produce the 10 documented outcomes, one test each | `tenancy/resolve.test.ts`, 10 cases |
| a client-supplied `X-Skunkworks-Tenant` is inert on a host-routed location | same suite, cases 1–5 |
| `/demo/<key>/whoami` returns `path=/whoami` and `tenant_header=<key>`, query preserved, slash-less form 301s | prefix test, including a **POST with a body** under `/demo/` |
| a demo `Host` cannot reach the admin surface: `/admin/…` is `404` with the same body as an unknown path, and no admin route is mounted on a public listener | listener test, positive and negative |
| compose has exactly **3** services (`nginx`, `app`, `acme`), `plugin-runner` is **absent by name**, and `app` publishes no port | `docker compose config` assertion (`test/compose.test.ts`): the three-name list, plus `services['plugin-runner'] === undefined` — **the old "exactly 4 services" row is withdrawn, not passed** (E-31) |
| `migrate` exits 0 with a per-tenant report; a broken tenant 503s alone | migration test with one corrupt fixture |
| boot refuses any `^SK_|^SKUNK_` env key, naming it, and the gate cannot hang | env test: `spawnSync` with `{timeout: 5000, killSignal: 'SIGKILL'}`; `ETIMEDOUT` is a named failure ("the process booted instead of refusing: <key>"), never a wait; the suite also runs under `node --test --test-timeout=15000`, so a regression is red in under 20 s; the child's stdout must not contain "listening" |
| `make test` stays green | the same command |

### S2 — Admin + data plane (2–3 wk)

**Contains:** auth (argon2id, TOTP when the allowlist is empty), sessions, CSRF, CRUD forms for `cms_*`,
the table builder and DDL runner for `u_*`, the Data Source registry + resolver + publish gate, the
`render-read` connection class, preview.

| Acceptance criterion | Gate |
|---|---|
| every non-GET without a valid CSRF token is `403 SKW_E_SEC_CSRF` | 12-case suite |
| `Origin` mismatch on a non-GET is `403` | same |
| the DDL AST refuses the two statements SQLite refuses, before any SQL | `test/ddl-runner.test.ts` `O2.` (the connection's `open` throws if called, so no SQL ran) and `O3.` (`rebuild_required`); no `test/ddl.test.ts` exists and none is created |
| a `u_*` table with an `asset_key` gets its guard trigger in the same transaction | schema assertion after the runner |
| a `query` source with a `SCAN` in its plan is refused at publish | `test/sources.test.ts` `S2E-1` (the index rule) **and** `S2E-11` (the plan rule). `S2E-11` is the exclusive witness: every column indexed, the plan still `SCAN`, refused with `detail.reason='plan_scan'`; disabling `refusePlan` leaves `S2E-1` green and makes `S2E-11` red |
| two parameter sets inside one TTL return their own rows | cache test, both orders |
| a preview token is accepted only for `status='draft'`, 30 min, `no-store` | O-29 test |
| `SKW_SCHEMA_EDIT=off` hides the builder entirely | UI assertion, no disabled control |
| a fresh seeded `control.db` and nothing else yields exactly one operator, and a TOTP code from the printed enrolment URI logs in | `test/cli-bootstrap.test.ts`, end to end through the login route |
| a second bootstrap writes nothing: exit 3, and `password_hash` / `totp_secret` / `must_change` are byte-identical | same suite, idempotence case |
| no TOTP secret or password reaches stdout, `audit_log`, `BUNDLE.json` or `control.seed.json` | grep assertion over the four artefacts |
| a day sealed on the 20th still verifies after the chain grows on the 21st, while a row tampered inside that day, a row deleted before it, or a truncated segment each refuse with their own reason | `test/audit-seal.test.ts` `B1-1`…`B1-11`; the positive control is `B1-1` and it is the one that was missing |
| a `view` source is anchored to its definition: re-pointing the view out of band refuses with `reason='view_checksum'` instead of serving another table, a DDL op that changes a published view un-publishes its sources in the same transaction, and the checksum is hashed once per schema stamp, not once per request | `test/sources.test.ts` `V1-1`…`V1-4` |

> Amended by 02-errata.md E-16, E-17, E-18, E-19, E-20, E-21, E-22, E-23.

### S3 — Assets + gated downloads (2–2.5 wk)

**Contains:** content-addressed storage, media library, renditions, link graph, `site.asset()`, the public
download path, code issuance (single, CSV, webhook), redemption, tokens, `X-Accel-Redirect`, watermark
spec + render worker + fail-closed, the access-code reissue path.

| Acceptance criterion | Gate |
|---|---|
| 8 parallel `Range` requests under one token spend **one** use | concurrency test (mirrors check 22) |
| two different tokens spend two | same |
| `Range: bytes=1-` cannot bypass the counter | same |
| an unknown selector and a wrong secret are indistinguishable in status, body and time | 1,000-trial timing test, medians within 20 % |
| an oversized/garbage token returns 401, never 500 (MAC length check) | 6-case token suite |
| `报告.pdf` downloads with `filename*=UTF-8''…` and status 200 | O-07 test |
| watermark timeout denies with 503 and writes `denied_watermark`; no un-stamped byte is served | forced-timeout test |
| an `encrypted=1` asset is refused at **issue** with the asset named | issue-form test |
| a render file is deleted at token expiry + grace and never appears in a bundle | sweep test + bundle grep |
| `bytes_declared` matches the authorised `Content-Length`; `bytes_sent` is NULL | row assertion |

### S4 — Editor + export (3.5–4.5 wk)

**Contains:** GrapesJS integration, the registry, page/slug management, the `list` component and the SSR
loop, `roundtrip.test.ts`, the three exporters with preflight refusals, `install.sh`, the measured install
proofs, plugin install / enable / hook dispatch (§13.3), the bundle verifier.

| Acceptance criterion | Gate |
|---|---|
| every fixture page reaches `canon(load(save(load))) == canon(load)` | `roundtrip.test.ts`, 9 fixtures, merge blocker |
| a `list` with two `[data-repeat]` children is refused at save | validator test |
| a page whose shell is unknown is `422 SKW_E_RT_TEMPLATE_UNKNOWN` at publish | publish test |
| the CSP header is byte-identical in all three targets | export test, string equality |
| the three targets come from one generator and one projection | diff of the projection digests |
| two exports at one `SKW_EXPORT_NOW` are byte-identical; at two clocks they are not | export test (mirrors check 16) |
| a `free` parameter in a link refuses with exit 22 | preflight test |
| a `cp`-built bundle fails `--verify` and a `VACUUM INTO` one passes | verifier test, both fixtures |
| no bundle contains `control.db`, `-wal`, `-shm`, `content/protected/wm/`, `content/sources/` | tar listing assertion |
| a third-party plugin with no test report is refused; with a stale digest, refused (digest = the **app** image, E-31) | install matrix |
| a plugin `asset_key` delete is blocked with `foreign_keys=OFF` | in-process integration test; the guard trigger is created by the host executor (§8.2), so the test no longer needs a runner |
| a hook that throws does not 500 the page: the value passed in is used, the failure is counted, and the third failure in 60 s disables the plugin with an admin notice | `test/plugin-load.test.ts` L5–L7 |
| a disabled plugin's hook does not run, and re-enabling it produces a **new module instance** (a module-level counter starts at 0) | `L8`–`L9`, the cache-buster's exclusive witness |
| a plugin calling a facade method for a table it did not declare is refused `SKW_E_PL_REJECTED` before the connection is touched; deleting the capability comparison turns this row red and leaves the tenant-binding rows green | `test/plugin-scope.test.ts` S3, mutated per §13.1a |
| install on a clean host: ≤ 5 min with images present, `certificate: pending` allowed | measured install, recorded in CI |

**Withdrawn from this slice by D36 (E-31), so no Builder inherits them as work:** the four-service compose
assertion in S1 (replaced by three), the runner memory assertions M1–M4 in `test/runner-memory.test.ts`
(no per-package cgroup exists), and the two-container composed-path claim that was `§13.4` item 2. They are
withdrawn rather than passed: there is nothing to run. — the deferred four (after the first client box)

O-27 (upgrade channel), O-39 (public upload intake), O-40 (table-scoped uninstall archive), O-43 (scheduled
plugin work). Each has a named experiment in §18 and none of them ships before S4's release gate.

---

## 17. Traceability

Every conflict and every objection in the register, with the section that implements it and the gate that
proves it. `MT` = proved by `make test` today. `S1–S4` = the slice's acceptance gate in §16.

### 17.1 Conflicts C-1 … C-25

> Amended by 02-errata.md E-2 (row C-25).

| ID | Verdict | Implemented in | Proved by |
|---|---|---|---|
| C-1 | B's mechanism, A's status rule rejected for the empty case | §5.1, §5.2, §5.3 | S1 (10 cases) |
| C-2 | nginx strips, the app emits | §5.5, §12.3 | S1 (prefix incl. POST) |
| C-3 | `ON UPDATE RESTRICT` + bounded `repoint` | §7.1, §4.1 | MT check 3; S3 (cap + audit row) |
| C-4 | the `list` component, not a block table, not an island | §6.3, §4.1 | MT check 26; S4 fixpoint |
| C-5 | projection is a union over the live DB | §11.2, §4.1 | MT check 23 |
| C-6 | selector + argon2, 16 chars, `m=19456,t=2,p=1`, semaphore 4 | §7.2, §4.5 | MT checks 21, 7, 17 |
| C-7 | the redemption (`jti`) is the unit, insert-first | §7.3 | MT checks 14, 22 |
| C-8 | **withdrawn by D36** — the fourth service bought a process boundary the product does not need at 200 tenants; plugins run in-process and containment is not claimed | §8.4, §13.3.6 | §16 S1 (three services) — the runner probe is deleted with the runner |
| C-9 | no publisher CA (D27) | §8.5 | S4 (signature matrix) |
| C-10 | split boot gate by plane | §12.4, §2.3 | S1 (migration report) |
| C-11 | `/admin/t/<key>/…`, session only | §9.2 | S2 (resolver test) |
| C-12 | `script-src 'self'`, islands emitted by the renderer | §10.5 | MT check 26; S4 (CSP equality) |
| C-13 | the seven-op AST, FK target from the type | §4.4, §4.1 | MT (validate negatives); S2 corpus |
| C-14 | `bytes_declared` vs `bytes_sent` | §7.4, §4.1 | MT check 15; S3 (log ingest) |
| C-15 | three connection classes | §2.2 | MT check 27 |
| C-16 | fail closed, bounded transient, encrypted refused at issue | §7.5 | S3 (timeout, issue refusal) |
| C-17 | one byte tree, `storage_path` generated | §7.1 | MT checks 11, 12; S4 (link absence) |
| C-18 | `function` removed, aggregates as grammar | §6.1, §6.2 | MT (validate kind); S2 (publish gate) |
| C-19 | one prefix, one taxonomy, one name per concept | §4.3 | MT (taxonomy scan); S1 (boot guard) |
| C-20 | derived rate limit, 50 hot tenants per box | §12.3 | S1 (nginx_gen) + release gate |
| C-21 | split audit + daily seal | §9.6, §4.1 | MT check 25 |
| C-22 | enumerate, cap, refuse, pin the clock | §6.4, §11.3, §11.4 | MT check 16; S4 (reproducibility) |
| C-23 | `template` is a slug against the shell registry | §10.4, §4.1 | MT check 26; S2 (publish refusal) |
| C-24 | a seed, never the fleet file | §11.6, §4.1 | S4 (install + content assertion) |
| C-25 | demo host ≠ admin host | §5.6, §9.1, §12.3 | S1 (listener/Host test, absence of the admin surface on every tenant Host) |

**25/25 conflicts mapped.**

### 17.2 Objections O-1 … O-44

| ID | D | Verdict | Implemented in | Proved by |
|---|---|---|---|---|
| O-01 | D-09 | REJECTED as a v1 defect | §5.5 (recorded CDN constraint) | recorded, no gate (v1 has no CDN) |
| O-02 | D-15 | ACCEPTED | §6.1, §12.2 (`content/sources/` never shipped) | S4 (bundle listing) |
| O-03 | D-18 | ACCEPTED | §12.2 (rw volumes, ro root fs) | S1 (compose assertion) |
| O-04 | D-25 | ACCEPTED | §4.1, §9.3 (triggers + registry) | MT checks 12, 24 |
| O-05 | D-26 | ACCEPTED | §4.5 (`foreign_keys=OFF` outside the txn) | MT check 13 |
| O-06 | D-27 | ACCEPTED | §4.5 (`sqlite_sequence` carry-forward) | MT check 5 |
| O-07 | D-40 | ACCEPTED | §7.4 (`filename*=UTF-8''…`) | S3 (`报告.pdf`) |
| O-08 | D-42 | ACCEPTED | §7.5, §11.5 (wm excluded, class `pii`) | S4 (bundle grep) |
| O-09 | D-43 | ACCEPTED | §11.6 (relative links, regex check) | S4 (`bundle_verify`) |
| O-10 | D-50 | ACCEPTED | §6.2 (cache key includes params) | S2 (both orders) |
| O-11 | D-51 | ACCEPTED | §3 (`addContentTypeParser`, mount seam) | S1 (1 MiB JSON POST) |
| O-12 | D-52 | ACCEPTED | §15.3 (5 ms loop budget, off-loop worker) | S3 (forced stall test) |
| O-13 | D-53 | ACCEPTED | §10.6 (`managed_by`) | S4 (read-only open) |
| O-14 | D-57 | ACCEPTED | §6.2 (`cost_ms_max`, plan before measure) | S2 (publish gate) |
| O-15 | D-60 | ACCEPTED | §4.2 (path predicate) | MT check 10 |
| O-16 | D-61 | ACCEPTED | §4.2 (`to_path` internal-only) | MT check 10 |
| O-17 | D-62 | ACCEPTED | §6 (`site.page(path)`) | S2 (nested-path test) |
| O-18 | D-63 | ACCEPTED | §2.2, §11.4 (`VACUUM INTO` on `exporter`) | MT checks 2, 27 |
| O-19 | D-64 | ACCEPTED | §11.4 (producer-side counts) | S4 (two fixtures) |
| O-20 | D-66 | ACCEPTED | §11.2, §11.5 (`empty`, `pii`, `secret` classes) | MT check 16; S4 |
| O-21 | D-69 | ACCEPTED | §11.6 (`readlink` + regex, `find -L` banned) | S4 (`bundle_verify`) |
| O-22 | D-70 | ACCEPTED | §11.6 (ship cold, verify `immutable=1`) | S4 (verifier) |
| O-23 | D-71 | ACCEPTED | §1.2, §11.6 (bracketed promise) | S4 (measured install) |
| O-24 | D-72 | ACCEPTED | §11.1 (lockfile + CI build) | S4 (`npm ci && build`) |
| O-25 | D-73 | ACCEPTED | §12.3 (generated blocks, no nginx-proxy) | S1 (nginx_gen) |
| O-26 | D-76 | ACCEPTED | §9.5 (three endpoints) | S1 (health tests) |
| O-27 | D-80 | **DEFERRED** | §18.1 | S5 experiment |
| O-28 | D-81 | ACCEPTED | §7.6 (SMTP, `off`, reissue) | S3 (webhook 201 body) |
| O-29 | D-82 | ACCEPTED | §3, S2 (preview token) | S2 (preview test) |
| O-30 | D-83 | ACCEPTED | §8.6 (core intake = plugin contract) | S2 (spam cases) |
| O-31 | D-84 | ACCEPTED | §14 (expiry cascade) | S4 (expiry test) |
| O-32 | D-85 | ACCEPTED | §5.4 (own `site.db` per demo) | S1 (demo provisioning) |
| O-33 | D-86 | ACCEPTED | §9.1 (`SKW_FLEET_MODE=0`) | S2 (role refusal) |
| O-34 | D-87 | ACCEPTED | §4.1 (`cms_download_code_archive`) | schema; S3 (prune test) |
| O-35 | D-91 | ACCEPTED | §4.1 (`cms_plugin_*`, `p_` exclusive) | MT validate (`p_` grammar) |
| O-36 | D-92 | ACCEPTED | §8.2 (guard per `asset_key` column) | MT check 24 |
| O-37 | D-93 | ACCEPTED | §8.5 (test report + digest) | S4 (install matrix) |
| O-38 | D-94 | ACCEPTED as a limitation | §8.4, §13.3, §10.2 | stated on the install screen |
| O-39 | D-95 | **DEFERRED** | §18.2 | S5 experiment |
| O-40 | D-96 | **DEFERRED** | §18.3 | S5 experiment |
| O-41 | D-97 | ACCEPTED | §8.5 (bundles ship plugins, local revocation) | S4 |
| O-42 | D-98 | ACCEPTED | §6.1, §11 (only via a `query` source) | S4 (static export test) |
| O-43 | D-99 | **DEFERRED** | §18.4 | S5 experiment |
| O-44 | D-100 | ACCEPTED | §8.1, §11.2 (`cms_plugin_setting`, `secret = 0`) | MT check 23; S4 |

**44/44 objections mapped. 69/69 register entries mapped — 100 %.**

Of the 69, **25 are proved by `make test` today** (15 conflicts and 10 objections — every row above whose
"Proved by" cell starts with `MT`). The other 44 are proved by the named slice gate in §16, which is the
honest split: a SQL engine cannot prove a CSP header, an ACME issuance or a browser cookie rule, and
pretending otherwise is how a spec loses a Builder's trust.

---

## 18. Open items

Four deferrals and nothing else. Each names the experiment that would settle it, the owner, the slice, and
the measurement that decides. A deferral without an experiment is a silent drop, so none of these is one.

### 18.1 O-27 — upgrade channel

**Decision.** v1 ships a documented upgrade path, not an update service: `/healthz` reports `SKW_BUILD_ID`;
`BUNDLE.json` carries `image.app_digest` and `image.runner_digest`; `install.sh --upgrade` pulls the new
digest, runs `migrate`, and restarts — the idempotent second run is measured at 7.5 s. A CVE
**notification** channel, a version endpoint for clients, and automatic rollback are deferred.

**Deciding experiment.** Take a bundle at digest A with `user_version=2`, point it at digest B carrying a v3
migration, run `install.sh --upgrade` against a populated prefix: assert exit 0, `user_version=3`, the site
serves, and a second run is a no-op. **Owner:** Platform. **Slice:** S5. **Why not now:** the experiment
needs a second image digest, which does not exist until S4's release gate.

### 18.2 O-39 — public upload intake

**Decision.** v1 refuses plugin uploads (`accepts_upload` is not in the manifest, `file` is not a field
kind). The core gains a public intake in S5: cap → magic-byte sniff → re-encode → quarantine → `cms_asset`
row with `access_class='linked-private'` → the key handed to the plugin in the form payload.

**Deciding experiment.** A 10 MiB JPEG and a 10 MiB PDF-with-appended-PHP through the intake under
`--cpus=1`, measuring p95 latency, peak RSS, and that the stored bytes contain neither the PHP tail nor EXIF
GPS. Sniff-only storage is already measured to fail (a 157 B polyglot survives; re-encode gives 68 B and no
payload). **Owner:** Security (sniff/re-encode) + Platform (quota, temp dir). **Slice:** S5. **Why not now:**
it is a new public write surface, and shipping it in S3 would put it in the same slice as the gated-download
flow — a bug in either is a paid-asset incident.

### 18.3 O-40 — table-scoped uninstall archive

**Decision.** v1 accepts whole-file `VACUUM INTO` for uninstall, and states the consequence: restoring that
archive rolls back every other change made since. A table-scoped format is deferred.

**Deciding experiment.** Design a per-table dump (`{table, ddl, rows, checksum}` JSONL) for a plugin with
three tables and 50,000 rows; restore it into a DB where another table has changed since; assert the restore
touches only the three tables and that a partial restore is detectable. **Owner:** Data Model. **Slice:**
S5. **Why not now:** no client has uninstalled a plugin, and the whole-file path is correct, only coarse.

### 18.4 O-43 — scheduled plugin work

**Decision.** `"cron": "none"` is the only legal value in v1. A plugin cannot wake itself.

**Deciding experiment.** A host job table with a lease: two processes race one due job, assert exactly one
runs; kill the lease holder mid-job, assert the job is retried after the lease expires and not before; a job
that misses three windows is marked failed once, not three times. **Owner:** Runtime. **Slice:** S5. **Why
not now:** a job table needs an overlap rule and a catch-up policy, and getting them wrong is a
duplicate-email incident, not a missing feature.

### 18.5 CEO decisions already taken as defaults

The register's §6 lists four decisions that are the CEO's. Each was adopted as the SDS default, and each is
reversible up to the slice named — none of them blocks a Builder:

| # | Decision | Default adopted | Reversible until |
|---|---|---|---|
| CEO-1 | the plugin runner is a fourth service | yes (§8.4, §12.1) | S4 compose freeze |
| CEO-2 | "fully drag-and-droppable" restated as "within the shipped registry" | yes (§10.2, D21) | any time — it is a sentence |
| CEO-3 | the static SKU refuses a site with a search box | yes (§11.3) | S4 export freeze |
| CEO-4 | access codes become 16 characters | yes (§7.2) | S3 code issuance |

Two questions are deliberately **not** put to the CEO: the publisher-CA question (C-9, decided by D27) and
the indemnity wording for third-party plugins (O-41, legal work outside the SDS).


### 17.3 Rejected positions, and what would overturn each verdict

A decision without a rejected alternative is not a decision, and a verdict without an overturn condition is
a prejudice. The register supplies both; this table is the one a Builder reads when they find evidence that
a verdict is wrong.

| ID | Position rejected | What would overturn the verdict |
|---|---|---|
| C-1 | a 400 on an empty `X-Skunkworks-Tenant` | a measured path where a client-supplied tenant header reaches the app with a valid edge token without traversing nginx |
| C-2 | the app strips the prefix | a measured case where nginx's `rewrite … break` changes the URI in a way the app can observe (double-decoding, a trailing-slash `proxy_pass`) |
| C-3 | `ON UPDATE CASCADE` | `CASCADE` completing under 50 ms at the largest real reference count **and** an audit design with O(1) rows, not O(references) |
| C-4 | a template language, or loops-as-islands | a registered component that round-trips a loop without a `[data-repeat]` child, or a list needing a computed or nested binding |
| C-5 | a projection checked against `site.sql`'s text | a plugin mechanism that creates a table without a manifest declaration, or a core migration path outside `schema/*.sql` |
| C-6 | an HMAC `code_lookup` with a pepper; 64 MiB argon2 | an unknown selector distinguishable from a wrong secret in status, body or wall time; a client demanding 12-character codes; a measured 2 GB container limit |
| C-7 | decrement-on-first-byte; update-first ordering | a client minting several tokens per purchase, or a case where one `jti` must legitimately spend two uses |
| C-8 | a process per tenant | a plugin able to degrade a *page*, or a per-plugin memory ceiling the single cgroup cannot meet |
| C-9 | a root key signing publisher keys | a commercial decision to run a publisher directory (a store, a review, an indemnity) |
| C-10 | a hard `migrate` gate for every plane | a query path that reads a changed table shape without checking `user_version` (the factory check is the guard) |
| C-11 | host-based tenant resolution on the admin listener | a requirement for one session managing several tenants with a non-URL switcher — even then the URL stays the authority |
| C-12 | a per-response nonce, or a save-time hash list | a client requirement for hand-authored inline `<script>`, which reopens the stored-XSS surface |
| C-13 | a `TableSpec` with a named `ref` target | a real requirement for a column type outside the closed set; each addition is a new emitter path and a new line in the injection corpus |
| C-14 | `bytes_sent NOT NULL DEFAULT 0` | an nginx→app completion signal measured to fire per response (`post_action`, `log_by_lua`, an `X-Accel` trailer) |
| C-15 | one readonly pool for every path | a dependency that opens its own handle to `site.db`, or a route that resets `query_only` on a pooled connection |
| C-16 | a per-purchaser render cache | a re-render cost above the download's own latency budget on the target box (a 400-page PDF at 1 vCPU) |
| C-17 | gated bytes in a separate tree | a second byte root that keeps the generated column by depending on a column that never changes — a schema change of equal size |
| C-18 | `function` sources, or no aggregates at all | a measured aggregate the grammar cannot express (window function, correlated subquery, multi-table join) |
| C-19 | four env prefixes and two names per concept | nothing in the corpus; sunk cost is not an argument |
| C-20 | a fixed 20 r/s per tenant | a measured page cost below 0.5 ms at production row counts, which raises `SKW_BOX_RPS` and every derived rate |
| C-21 | a chain with no anchor; audit in `control.db` | a tenant-plane audit living outside the tenant's writable tree, or the seal contending at fleet scale |
| C-22 | freeze-at-default plus a note in `EXPORT-NOTES.md` | a client needing more than 1,024 combinations, or `astro build` above ~150 ms/page |
| C-23 | a frozen template enum; tenant-authored shells | a requirement that tenants author their own shells — a different product decision, refused in v1 |
| C-24 | shipping `control.db`, or a default tenant row | a product decision to sell a fleet in one install — the seed becomes an array; the "never ship `control.db`" rule does not change |
| C-25 | a path-prefix demo on the admin origin | evidence that a demo tenant is never adversarial, which contradicts D24 shipping the editor to the client |

---

*End of SDS v3.0. The register (`00-adjudication.md`) is the authority for every verdict quoted here; the
schema (`schema/*.sql`) is the authority for every column; `make test` is the authority for every number
marked measured here.*
