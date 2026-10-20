# R2 — Platform

Round 2. Round 1 left me three unsolved things: an export that loses data while passing every check
we have, a bundle that carries no control plane, and an ACME/DNS term inside the 5-minute promise I
had never measured. All three are now measured, and two of my own Round-1 mechanisms are wrong.

Environment for every number below: macOS 15.7.4, Docker 29.7.2, Compose v5.3.1, images pinned
`python:3.12-alpine@sha256:1b668429…ab4` (SQLite 3.53.4) and `nginx:alpine@sha256:892bb215…d33`
(nginx 1.31.7), host SQLite 3.43.2, probe tree `~/.hermes/profiles/ceo/cache/scratch/r2probe/`.
The fixture is built from the **real** `schema/control.sql` and `schema/site.sql` +
`schema/r2-amendments.sql` (site.db at `user_version=2`), not from a mock schema.

---

## 1. Attacks on my domain — verdicts

| # | Attack | Source | Verdict | Reason | Fix shape |
|---|---|---|---|---|---|
| 1 | The bundle carries no `control.db`, so the sold site has no tenant, no domain, no admin user, and may inherit a demo TTL that deletes it | Red Team O2 | **ACCEPT** | Measured: seeding from a projection gives 1 tenant / 2 domains / 1 admin / 0 sessions / 0 audit rows and forces `mode=production`; shipping the fleet file gives 3 tenants / 48 domains / 3 users / 2 sessions / 120 audit rows (§5 M7). A bundle with neither installs to a wall of 404s behind a green `compose ps` | `data/control.seed.json` + `tools/seed_control.py`, one transaction, exit 15; `mode` forced to `production` unless `--keep-demo` |
| 2 | "Export has nothing to filter" — a demo tenant ships form submissions, download codes and the per-buyer watermark archive | Red Team O3 | **ACCEPT (in part)** | Measured: naive bundle 8,739,862 B vs sealed 224,983 B; the 8.5 MB delta is `content/protected/wm/` — 50 per-buyer files, 170 KB each for a 150 KB asset (+13 %). It has no owner and no eviction. The tenant's *own* submissions and codes are a product/legal call, not mine | `content/protected/wm/` excluded from all three targets; manifest class `pii`; `--include-pii` default **off** for a demo-origin export; row counts printed in `EXPORT-NOTES.md`. Submissions/codes in a client's own CMS bundle: **DEFER** to Architect |
| 3 | nginx-proxy derives vhosts at container creation, so adding a tenant recreates `app` and blips every tenant; `ask` contradicts per-host HTTP-01 | Red Team O7 | **ACCEPT** the label problem, **REJECT** the contradiction | Labels: correct, and it is why PD5 exists. Contradiction: measured issuance through the real stack took 16.01 s and reloaded the proxy on cert write (§5 M6) — no container recreate. Adding a *hostname* needs one generated `server` block + `nginx -s reload` (milliseconds), which is not the same failure as recreating the app | No nginx-proxy in the data path. Host routing: one generated `server` block per host (TLS needs SNI + a cert path), `map $host $tenant` for the app, path-prefix demos need **no** server block. `ask` is dropped, not reconciled |
| 4 | The 5-minute walk: Docker absent, tar size, DNS, pull, ACME, `control.db`, admin login | Red Team §4 | **ACCEPT** | Measured: 18.2 s warm / 29.8 s cold-pull / 7.5 s re-run for a 3.1 MB bundle (§5 M3). Their transfer arithmetic stands and is *outside* every number I have: 1 GB at 20 Mbps ≈ 6.8 min | Pre-flight refusals 10/11/13/17 before anything is written; a stated bundle size ceiling; `--offline image.tar` |
| 5 | The catch-all vhost passes a client-supplied tenant header to the app | Security A-1 | **ACCEPT** | Reproduced in R1 (T7/T8b: `tenant_header:"victim"`, `host:"app"`). Fix measured now: unknown host → 404 **and** unknown host + `X-Skunkworks-Tenant: acme` → 404, both in the install smoke (§5 M3) | Snippet clears the header on every proxying location; `location / { return 404; }` in the default server — a **server-level** `return` runs before location selection and swallows the health location (§5 M9) |
| 6 | `proxy_ignore_headers X-Accel-Redirect` on any location proxying to a non-app upstream | Security §3.3 | **ACCEPT** | One line; a compromised sidecar must not be able to mint an offload | Add to the base snippet, unconditionally |
| 7 | `proxy_pass` with no trailing slash; clear the inbound tenant header before setting it | Runtime §3.8.1 | **ACCEPT** | Already PD1. Re-measured in the installed stack: `Host` preserved, tenant header empty on host routes, `/media/` never reaches Node | Keep as written; the smoke test asserts it |
| 8 | Export and backup must be `VACUUM INTO`, never `cp` | Runtime §3.8.3, Data A3 | **ACCEPT**, and the claim is too weak | Measured: `cp` of main-only and `cp` across a checkpoint both lose 40 pages / 60 rewrites / 500 revisions **while passing `integrity_check`, `application_id` and `user_version`** (§5 M1). And a bundle built that way, with the manifest measured from the copy, passes 27/27 of my own checks and installs clean (§5 M4) | `VACUUM INTO` **plus** counts agreeing on both sides of the snapshot (`before == after == snapshot`, ≤5 attempts, else exit 23), and `source_counts` in the manifest so install asserts them |
| 9 | `install.sh` should run `PRAGMA journal_mode=WAL; PRAGMA integrity_check` before marking a tenant active | Runtime §3.8.4 | **REJECT the order**, accept the checks | Measured: a WAL-mode file with no `-shm` **cannot be opened `mode=ro` at all** — `OperationalError: unable to open database file`; `immutable=1` works; delete mode works; WAL works only after an `-shm` exists (§5 M2). An installer that sets WAL first and then verifies from a read-only mount cannot read its own database | Ship cold (delete mode, which `VACUUM INTO` already produces) → verify with `immutable=1` → gate → **then** `journal_mode=WAL` (measured 4.8 ms in the gate) |
| 10 | The tenant volume must be read-write even for the render path, because WAL needs `-shm` | Data §3.3 (M16) | **ACCEPT** | Confirmed twice: `SQLITE_READONLY_DIRECTORY` on a `:ro` mount, and the file-level variant in §5 M2. There is no read-only deployment of a WAL tenant | `./data` rw, `./content` rw (uploads), root filesystem `read_only: true` + `tmpfs` |
| 11 | `/healthz` must report `{db:'ok', tenants_pending_migration:N}` | Data §3.3 | **REJECT** | Measured in R1 T13: `/healthz` 200, `/readyz` 503, container still `(healthy)` — the *point* of separating them. Merging DB state into liveness means one tenant's broken file restarts the fleet. And an nginx probe that proxies to the app turned the edge `(unhealthy)` when the app stopped (R1 T14) | Three answers: `/healthz` liveness only; `/readyz` = control.db opens + write probe; `/admin/api/tenants/<key>/health` per tenant, alert-driven. nginx checks a static byte of its own |
| 12 | The watermark render cache is an archive with no eviction, and it travels in the bundle | Red Team O12 | **ACCEPT** | Measured: 8.5 MB / 50 copies inside an 11.7 MB fixture, +13 % per copy for a 150 KB asset (their +60 % was their stamp spec). Nothing deletes a row | Excluded from every bundle; no PD covers retention yet — the SDS needs one (byte ceiling + LRU, charged to the tenant's quota) |
| 13 | The Astro SKU ships without a lockfile and is never built by the exporter | Red Team O11 | **ACCEPT** | Their `npm ci` exit 1 is decisive; my R1 T19 measured 38.5 s cold for a 10-page site with **no CMS at all**. A generated project that has never been built ships its first compile error to the buyer | One manifest schema, three targets. Astro bundle ships the `package-lock.json` the exporter resolved, and CI builds the generated project before the bundle may ship; `deploy.sh` for Astro, none for static |
| 14 | Admin on a separate port has no defined tenant-selection path; audit rows carry no tenant | Runtime A5 | **ACCEPT** | In a bundle there is exactly one tenant and the seed carries it, so the ambiguity only exists on the fleet — but the fleet is where a cross-tenant *write* would happen | Bundle: admin URLs `/admin/...`, tenant constant from the seed, every `cms_audit` row carries it. Fleet: `/admin/t/<key>/...`, `resolveAdminTenant(session)` is the only source, admin ignores `Host` |
| 15 | "A bundle is a closed world, verified before it is written" — and the check is `find -L bundle -type l` | **mine, R1 P3** | **SELF-REJECT** | Measured: `find -L` reports **only the broken** absolute link; an absolute link whose target still exists is reported as a regular file, so the check passes on the exporter's machine and the bundle 404s on the client's (§5 M5, §6) | `readlink` on every link + `^\.\./media/[0-9a-f]{2}/[0-9a-f]{64}\.[a-z0-9]{1,5}$`, and the target must resolve inside the bundle. Implemented in `tools/bundle_verify.py` (`farm.relative_and_closed`) |
| 16 | A read-only handle is not an isolation boundary; `function` datasources are in-process code in a writable tree | Security S-2, Data A2, Runtime A3 | **ACCEPT** — but not mine to fix | Three papers measured the same thing. My addition: the export makes it worse, because `content/sources/` ships to a third party and is imported in the process that holds every HMAC key | v1 bundles ship **no** `content/sources/`; the exporter refuses (exit 22) if a tenant uses a `function` source. The SDS must stop claiming "by construction" (§3, conflict 3) |
| 17 | `cms_asset.storage_path` is row data, so a CRUD form turns an asset edit into arbitrary file read | Red Team O5 | **ACCEPT** — already fixed upstream | The R2 amendment makes `storage_path` a **generated** column (`content/media/<hh>/<sha>.<ext>` from `mime`), so there is nothing to write. Verified by building the fixture: `INSERT … storage_path` is rejected by SQLite (`cannot INSERT into generated column`) | Keep the generated column. My farm verifier is the second control; see §3 conflict 2 for what it costs Security |

---

## 2. My counter-designs for the other domains (at least 3: claim | counter-design | severity | evidence needed)

**C1 — Data model: postchecks prove the file is *valid*, not that it is *current*.**

| | |
|---|---|
| Claim attacked | DM8: `VACUUM INTO` + `application_id` + `user_version` + `integrity_check` + `foreign_key_check` + `journal_mode` means "the file says what it is" |
| Counter-design | The export must prove **quiescence**, not validity: count every exported table on the source *before* the VACUUM, again *after*, and read them from the snapshot; accept only when all three agree, retry ≤5, else `REFUSED EXPORT_NOT_QUIESCENT` (exit 23). Carry `source_counts` in the bundle manifest and have `install.sh` compare the installed rows to them |
| Severity | **Blocker.** Measured: a `cp`-built bundle whose manifest was measured from the copy passes 27/27 checks, installs in 18.5 s, prints "served rows match the exported snapshot", and serves 201 pages where the source had 241 — 40 pages and 60 rewrites gone, `/new/39` 404 (§5 M4) |
| Evidence needed | An exporter test that runs a writer during export and asserts either equality or refusal. My probe does exactly that and converges on attempt 1 when the writer is between bursts |

**C2 — Security: S-6 cannot be "absent by construction" once `storage_path` is generated.**

| | |
|---|---|
| Claim attacked | Security S-6: "a gated asset is absent from the public tree by construction, not by permission" — falsified by `find content/public -lname "*<sha256>*"` |
| Counter-design | Accept one byte tree (`content/media/`) and separate by **location**, not by directory: `/media/` aliases `content/public/` (farm only) and `/__protected/` aliases `content/media/` with `internal` + a 64-hex guard. The invariant becomes: *no farm link exists for a gated asset, and `/media/<key>` is 404* — enforced by the readlink audit plus a request test |
| Severity | **Major.** It is a real weakening: a missing symlink is a weaker guarantee than a missing directory, and it needs a test that someone can forget to run |
| Evidence needed | On the installed bundle: `GET /media/ebook.pdf` → 404 and `find content/public -lname '*<gated sha>*'` → 0 hits (both measured, §5 M10); the offload itself — `X-Accel-Redirect: /__protected/<sha>.pdf` → 200 with bytes — is R1 T2, and a *direct* GET of that same path is 404 by design (`internal`), also measured |

**C3 — Runtime: `cost_ms` measured at publish on a developer machine is not a client number.**

| | |
|---|---|
| Claim attacked | D-R6: publishing a source runs it 20× and stores p95; the ≤4 ms budget is then a property of the page |
| Counter-design | Measure inside the pinned image, under the production CPU limit (`--cpus`, `--memory`), with a cold page cache; store the vCPU class next to `cost_ms`; refuse to publish when p95 > budget × (vCPU/2). A 6.7 µs indexed query on an M1 is not evidence about a 1-vCPU VPS |
| Severity | **Major** — the promise targets a 2 GB VPS, and the client's box is the one that must hold the number |
| Evidence needed | The same two queries at `--cpus=1` vs `--cpus=2`, with the ratio recorded in the registry. If the ratio is <1.5× the counter-design is over-engineering and I withdraw it |

**C4 — Security: the admin IP allowlist cannot ship, and the alternative is not "no allowlist".**

| | |
|---|---|
| Claim attacked | D9: admin on a separate origin/port **with an IP allowlist**, asserted as a control |
| Counter-design | In a sold bundle `SKUNK_ADMIN_ALLOWLIST` defaults **empty** (deny-by-nothing, not deny-all), admin is reachable only through nginx (`expose`, never `ports`), auth is argon2id + per-IP `limit_req` + optional TOTP + a 30-minute idle session. The fleet keeps its allowlist |
| Severity | **Major** — the allowlist is a support ticket per client per network, forever, on a product sold as self-service |
| Evidence needed | Login from a second network with no VPN succeeds; `/admin` is absent from every published port (`docker port` shows only 80/443); 5 wrong passwords in 15 min → 429 |

**C5 — Red Team: "nothing to filter" needs a manifest class, not a grep.**

| | |
|---|---|
| Claim attacked | Red Team O3's remedy ("grep the bundle for `@`") is a post-hoc audit |
| Counter-design | Every file in `BUNDLE.json` carries `class ∈ {content, media, pii, secret, db, infra}`; `pii` files require `--include-pii`; the exporter prints the row counts it is about to ship (`cms_form_submission`, `cms_download_code`, `cms_download_event`) and writes them into `EXPORT-NOTES.md` |
| Severity | **Major** — the difference between a support question and a notifiable incident |
| Evidence needed | `grep -r '@' bundle` = 0 hits on a demo-origin export; ≥1 with `--include-pii`; the counts in `EXPORT-NOTES.md` equal `SELECT count(*)` on the installed db |

---

## 3. Conflicts I detect between OTHER domains (proposed resolution)

**3.1 Loops: DM5 (one document, no block tree) × Runtime I8 (no `<script>` in the body) × Red Team O4
(a placeholder div must become N articles).** This is the conflict most likely to sink the SDS. DM5 is
right for the empty-diff gate and Runtime is right that GrapesJS destroys `<script>`; together they
leave the stored document unable to express repetition, and "resolve placeholders at SSR" is a
template language nobody has specified — with its own escaping policy, on pages that accept
client-authored HTML. **Proposed resolution:** loops are **islands**, not markup —
`<div data-island="post-list" data-props='{"source":"products","limit":3}'>` — the resolver never
clones DOM, the island renders N children client-side or at SSR from a resolved prop. Consequence for
my domain, and why I am raising it: the static and Astro bundles must then ship the island's JS **and
its data snapshot**, which changes the bundle file list and means a page whose island needs request
data cannot be exported (exit 22). A repeat directive would have been exportable as HTML; an island is
not. If the Architect chooses a repeat directive instead, my refusal code 22 goes away and the
escaping problem moves into the renderer — I will implement either, but the SDS must pick one.

**3.2 `storage_path` generated (DM R2 amendment) × Security S-6 × my `/media/` alias.** The generated
column puts every asset, public or gated, under `content/media/`; S-6 assumes gated bytes live
somewhere else; PD4 aliases `/media/` at `content/public/`. Resolution in C2: one byte tree, serving
split by location, S-6 restated as a link-absence test. Owner: me (the nginx config and the verifier).

**3.3 readonly ≠ isolation (Security S-2, Data A2/I5, Runtime A3) × one process (D1) × a 2 GB target
box.** Every paper measured that a `{readonly:true}` handle can `ATTACH` a sibling tenant and that
`VACUUM INTO` from a render handle is an exfiltration primitive. The only fix that makes it structural
is a process boundary; Security's own estimate is ~40 MB RSS per worker, so 200 tenants ≈ 8 GB of RSS
against a 2 GB box — 4× its RAM, and more than its disk. **Resolution:** the SDS states
"tenant isolation is a permission boundary, not a construction" and lists the three code paths that can
break it (DDL runner, `function` sources, any `ATTACH`-capable handle). I will not pretend otherwise in
the platform section, and the exporter refuses `function` sources so a bundle cannot carry the worst
one. What would overturn this: a per-tenant worker measured under 8 MB RSS, which nobody has.

**3.4 CSP nonce (Security DS-11) × export (Runtime A2) × the bundle.** A per-request nonce cannot
survive a static export: either the exported HTML carries a nonce the client's nginx never echoes (every
island is blocked) or the CSP is dropped. **Resolution:** hash-based CSP computed **at export** from the
final serialised HTML, emitted into the bundle's `nginx/conf.d` `add_header` and (for the static target)
a `<meta http-equiv>`; no nonce anywhere in stored markup. Owner: the exporter, because the header has
to travel with the artifact — which is my file list, not Security's route table.

**3.5 Audit split (DM7) × admin tenant resolution (Runtime A5) × a single-tenant install.** DM7 says no
action writes both tables; A5 says the admin needs a second resolution path. In a bundle the tenant is a
constant from the seed, so the second path collapses: `cms_audit` only, `control.audit_log` present but
empty, and the fleet never receives a bundle. Resolution: adopt both, with the bundle's `tenant_id`
fixed at seed time and asserted by `db_gate`.

---

## 4. Revised invariants after round 1 (include the honest version of the install-time promise)

**P1 — Tenancy is declared by the edge, and a client header is inert.** Unchanged, but the mechanism is
narrower than R1 claimed: the snippet's `proxy_set_header X-Skunkworks-Tenant ""` must be in *every*
proxying location, and the default server must answer 404 from a **location**, not from server scope
(measured: a server-level `return` swallows the health-check location and makes the edge unhealthy).
*Falsified by:* a 200 on an unknown `Host` with a spoofed tenant header — measured 404 in the installed
stack.

**P2 — No tenant's bytes are reachable through another tenant's URL.** Unchanged. The farm is
`readlink`-audited on every bundle, and `/__protected/` is `internal` + 64-hex-guarded. *Falsified by:*
a 200 for a key that exists only in another tenant, or a non-404 for any traversal string.

**P3 — A bundle is a closed world of *paths*.** Revised: containment is checked with `readlink` +
regex, never `find -L` (which cannot see an absolute link whose target exists — measured). P3 says
nothing about data; that is P9.

**P4 — Health means the thing it protects works, and one tenant's sickness cannot restart the fleet.**
Three endpoints, as §1 row 11. nginx's own probe never proxies to the app.

**P5 — Nothing waits on a default timeout.** Unchanged (2 s connect, 20 s read, `proxy_next_upstream off`).

**P6 — A backup never blocks a writer, and a restore is proven before it replaces anything.**
Unchanged, and now the same mechanism is the export (P9).

**P7 — Install time is a property of an artifact, printed by the installer, and bounded by what we
control.** Replaced by §4.3.

**P8 — The edge moves the bytes; the app makes the decision.** Unchanged.

**P9 (new) — No bundle's database is produced by copying a file.** Export is `VACUUM INTO` on a
connection that is not in a transaction, with counts agreeing before, after and inside the snapshot, or
the export refuses (exit 23). *Falsified by:* a `cp`-built bundle that passes verify — measured to pass
27/27, which is why this is a **producer** invariant and not a check.

**P10 (new) — A bundle is immutable; runtime state lives in `--prefix`.** The artifact is never written
to: `.env`, `control.db`, the tenant db and the rendered vhost all live in the prefix. *Falsified by:*
a second `install.sh` run that refuses (measured before the split: exit 12, `data/control.db` and
`data/tenants/acme/site.db` reported as "extra files"). With the split: second run exit 0 in 7,517 ms,
tenant db and secrets byte-identical.

**P11 (new) — Ship cold, verify cold, run warm.** `site.db` ships in `delete` mode; verification opens
`immutable=1`; `journal_mode=WAL` is set inside the gate. *Falsified by:* `mode=ro` on a shipped WAL
file — measured `OperationalError: unable to open database file`.

**P12 (new) — `control.db` is never in a bundle.** A bundle carries `control.seed.json`: one tenant, its
domains, one admin, settings, `db_version`, and nothing from `session`, `audit_log`, `deploy_token` or
any other tenant. *Falsified by:* `grep -rl 'beta@example.com\|fleet@skunkworks' bundle` returning
anything — 1 file in the fleet variant, 0 in the sealed one.

### 4.1 The bundle spec — a file list, not prose

```
site-bundle.tar.gz
├── BUNDLE.json                        infra    schema "skunkworks/site-bundle/v2"; tenant; domain;
│                                               image digests; source_counts (every exported table +
│                                               user_version + application_id); per-file
│                                               {path, bytes, sha256, class}; refusals; notes
├── install.sh                         infra    the only entry point; exits 0/10/11/12/13/14/15/16/17
├── .env.template                      infra    every secret EMPTY — install generates, never ships
├── docker-compose.yml                 infra    image by digest; no build:; read_only; tmpfs /tmp;
│                                               user 10001; expose only; no published app port
├── nginx/nginx.conf                   infra    worker 1; include conf.d/*.conf
├── nginx/conf.d/site.conf.tmpl        infra    __DOMAIN__ rendered by install.sh; default_server
│                                               answers 404 from a location; /media/ alias;
│                                               /__protected/ internal + 64-hex guard
├── tools/control.sql                  infra    the exact control schema the image expects
├── tools/bundle_verify.py             infra    run inside the pinned image; 27 checks; exit 12
├── tools/seed_control.py              infra    materialise control.db from the seed; exit 15
├── tools/db_gate.py                   infra    5 pragma gates + expected user_version; exit 15
├── data/site.db                       db       VACUUM INTO output, journal_mode=delete,
│                                               application_id 0x534B5701, user_version=2
├── data/control.seed.json             db       1 tenant (mode forced production), its domains,
│                                               1 admin (argon2id), settings; not_exported list
├── content/media/<hh>/<sha>.<ext>     media    every byte, public and gated
├── content/public/<key>.<ext>         content  relative symlink ../media/<hh>/<sha>.<ext> ONLY
├── EXPORT-NOTES.md                    content  frozen sources + row counts + refusals + pii inventory
└── deploy.sh                          infra    astro target only; the static target ships no script

NEVER IN ANY BUNDLE
    data/control.db                     the fleet: other tenants' domains, users, sessions, audit
    data/site.db-wal, -shm, -journal    a hot file; a bundle is a cold artifact
    content/protected/wm/               per-buyer stamped renders (8.5 MB / 50 files in the fixture)
    content/sources/                    in-process tenant JS; v1 refuses function sources (exit 22)
    .env                                secrets are generated at install, never carried
```

Measured: 33 files, 3,111,879 B unpacked, 224,983 B tar.gz for the fixture site (241 pages, 11 assets,
501 revisions). The naive bundle of the same site is 83 files / 11,566,228 B / 8,739,862 B — 39× larger,
because it carries the watermark archive.

### 4.2 The install sequence

Phases as implemented and measured in §5 M3. Every phase is a refusal point, not a log line.

```
P0  preflight            docker present + daemon up; compose ≥2.20; bundle manifest present;
                         disk ≥ 2× unpacked + 1 GB; domain from --domain | prefix .env | manifest
P0b dns (exit 11)        A record resolves AND equals this box's public IP; --skip-dns bypasses;
                         port 80 inbound is NOT tested from here and is reported as untested
P1  verify (exit 12)     run INSIDE the pinned image, bundle mounted :ro — hashes, no hot files,
                         farm links relative+closed, no wm/, no sources/, db cold+app_id+version,
                         counts == manifest, control plane is a seed
P2  stage                payload copied to --prefix; content hardlinked; the artifact is untouched
P3  secrets (14)         only the empty keys are generated (32 bytes); .env chmod 600 in the prefix
P4  chown (14)           data/ → 10001:10001 with the same image, before any service starts
P5  control (exit 15)    schema if absent; one transaction seeds tenant + domains + admin;
                         mode forced production; asserts 1 tenant / 0 sessions / 0 audit
P6  dbgate (exit 15)     integrity, foreign_key_check, application_id, user_version, then WAL
P7  up (exit 16)         docker compose up -d --wait; on failure print ps + logs and die
P8  smoke (exit 16)      / and /about 200; /nope 404; unknown Host 404; spoofed header 404;
                         /media/<key> 200 with bytes; /__protected/<hex> 404; /__stats counts ==
                         manifest   ← this is the test that A2 asked for
P9  cert (never gates)   certificate: pending; exit 0; install-report.txt written with per-phase ms
```

### 4.3 What the 5-minute promise can honestly be

Not "5 minutes". This:

> **≤ 5 minutes, measured, from a Docker host (≥ 2 vCPU / 2 GB / Compose ≥ 2.20) whose images are
> pullable or supplied with `--offline`, an A record for the client's domain already pointing at the
> box, and TCP/80 reachable from the internet.**
>
> Our part, measured: **18.2 s** first install with images warm, **29.8 s** with both images pulled
> cold, **7.5 s** re-run. TLS issuance adds **16.0 s** once DNS and port 80 are already correct.
> Bundle transfer is **excluded** and must be capped: 1 GB at 20 Mbps is ≈ 6.8 minutes of arithmetic
> before `install.sh` starts.

Consequences the SDS must carry:

- **IDEA §1.1's sentence changes.** "running in ~5 minutes without drama" becomes "running in ~5
  minutes once DNS and port 80 are ready" for the CMS SKU. The other two keep their own numbers:
  static ≤1 min (copy files behind a web server the client already has), Astro ≤3 min (lockfile in the
  bundle, `npm ci` + `build` ≈ 45 s on the measured 38.5 s + 1.9 s basis).
- **A wrong DNS record must refuse in 0.3 s, not wait.** The phase costs one resolve (7–15 ms) plus one
  public-IP echo (266 ms); NXDOMAIN is 1.9 ms. It exits 11 with both IPs in the message, before a single
  file is written.
  Waiting is not a strategy: `acme-companion` logs `Sleep for 3600s` after a failed issuance (§5 M6),
  so a client who fixes DNS at minute 6 waits an hour for the retry — that is the real "25 minutes
  turns into tomorrow".
- **The certificate never gates the install.** The site serves HTTP with `certificate: pending` in the
  report; HTTPS is a second, observable event (`cert-watch` alerts on `notAfter < 14d`).
- **The promise is per artifact and printed.** `install-report.txt` carries per-phase milliseconds;
  a claim without a report does not exist.

---

## 5. Measurements I ran this round (command + real output)

### M1 — Four exporters, one live WAL database

```
$ python3 snapshot.py
live: pages 241, new_pages 40, revised 60, revisions 501
      main=335872  -wal=131872  -shm=32768
timings_ms: A1_cp_main_only 0.44 | A2_cp_then_race 18.94 | A3_cp_back_to_back 1.75 | B_vacuum_into 13.9

A1  cp main only (the bundle shape in IDEA 5)   pages=201 new=0   revised=0  revs=1
    integrity=ok fk=0 application_id=0x534b5701 user_version=2 journal_mode=wal  install_gate=PASS
A2  cp main, checkpoint, cp -wal (the race)     pages=201 new=0   revised=0  revs=1
    integrity=ok fk=0 application_id=0x534b5701 user_version=2 journal_mode=wal  install_gate=PASS
A3  cp main + -wal back-to-back                 pages=241 new=40  revised=60 revs=501
    integrity=ok fk=0 application_id=0x534b5701 user_version=2 journal_mode=wal  install_gate=PASS
B   VACUUM INTO                                 pages=241 new=40  revised=60 revs=501
    integrity=ok fk=0 application_id=0x534b5701 user_version=2 journal_mode=delete install_gate=PASS
B_postcheck_and_wal_ms: 1.78   (integrity + fk + set WAL on the exported file)
```

Every gate passes on the two bundles that lost 40 pages and 60 rewrites. A3 passing is the point: the
same `cp` is correct or broken depending on the interleaving, and no post-hoc check can tell which.

### M2 — A shipped WAL file cannot be verified read-only

```
$ python3 - <<'EOF'   # same file, four opens
WAL, no -shm, mode=ro                  OperationalError: unable to open database file
WAL, no -shm, immutable=1              OK rows=201
DELETE mode, mode=ro                   OK rows=201
WAL after an rw open created -shm      OK rows=201
files: ['del.db', 'wal.db', 'wal.db-shm']
```

### M3 — Three bundles from one fixture, verifier verdict, install, second run

```
$ bash measure_all.sh
== fixture: {"bytes":11692545,"control_db":114688,"site_db":335872,"wm_bytes":8501640,"wm_files":50}
== live:    {"pages":241,"new_pages":40,"revised":60,"revisions":501,
              "sizes":{"":335872,"-wal":131872,"-shm":32768}}

naive   tar=  8739862B files= 83 unpacked= 11566228B export=cp site.db                                     pages=241 revs=501
fleet   tar=   229574B files= 33 unpacked=  3225752B export=VACUUM INTO + postchecks, shipped in delete mode pages=241 revs=501
sealed  tar=   224983B files= 33 unpacked=  3111879B export=VACUUM INTO + postchecks, shipped in delete mode pages=241 revs=501

naive   FAIL farm.relative_and_closed [(team-abs.png, /Users/cyberdeth/…/media/1f/…png)]
        FAIL content.no_watermark_archive  FAIL content.no_function_sources
        FAIL count.cms_page bundle 201 != source 241
        FAIL count.cms_page_revision bundle 1 != source 501
        FAIL control.seed_present data/control.seed.json missing
        17/23 checks passed; farm links=10; files=83   exit=12
fleet   FAIL control.seed_present  FAIL control.no_fleet_db data/control.db present
        21/23 checks passed; farm links=10; files=33   exit=12
sealed  27/27 checks passed; farm links=10; files=33   exit=0

  preflight      863ms
  verify: 27/27 checks passed; farm links=10; files=33
  verify        3703ms
  stage           66ms
  first login: ops@acme.com / d09aaf75853c408ffb0401b0   (printed once; change on first login)
  secrets        120ms
  chown          267ms
  control: {"fresh":true,"tenants":1,"domains":2,"users":1,"sessions":0,"audit_rows":0,
            "mode":"production","application_id":"0x534b5700","bytes":98304,"ms":54.5}
  control        475ms
  tenant:  {"integrity":"ok","fk_violations":0,"application_id":"0x534b5701","user_version":2,
            "journal_mode_before":"delete","journal_mode_after":"wal","ms":4.8,"pass":true}
  dbgate         720ms
  up           11545ms
  smoke: served rows match the exported snapshot
  smoke          154ms
TOTAL 18168ms
serving: pages 200=7 nonzero=0
media:   200 262400B
protected direct: 404      unknown host: 404      spoofed header: 404
stats: {"tenant":"acme","cms_page":241,"new_pages":40,"revised":60,"cms_page_revision":501,
        "u_product":10,"cms_form_submission":40,"journal_mode":"wal",
        "application_id":"0x534b5701","user_version":2}

== second run, same prefix
  preflight 738 | verify 3868 | stage 58 | secrets 41 | chown 349 | control 386 | dbgate 432
  up 1208 | smoke 155        TOTAL 7517ms
tenant db: UNTOUCHED        secrets: UNTOUCHED

== DNS pre-flight against a domain that does not point here
REFUSED [11] acme.com -> 184.23.246.145 but this box is 124.168.71.98; the HTTP-01 challenge will
fail and acme retries in 3600s          exit=11
```

The naive row's `pages=241` is its **manifest's** claim, counted from the live source; the file it
actually ships has 201 — which is the `count.cms_page` FAIL three lines below. That is the whole
defect in one line: the bundle disagrees with itself and only the manifest knows.

The cold-registry run (both images removed first) measured 29,758 ms:
`preflight 822 | verify 7186 | stage 73 | secrets 110 | chown 296 | control 557 | dbgate 671 |
up 19628 | smoke 155`.

### M4 — The bundle that passes every check and ships a stale site

`mkstale.py` takes the sealed bundle, replaces `data/site.db` with a `cp` of the live WAL database,
and recomputes the manifest **from the copy** — which is what a naive exporter does.

```
$ python3 mkstale.py
counts_in_manifest: cms_page 201, cms_page_revision 1, cms_asset 11, cms_download_code 5,
                    cms_form_submission 40, u_product 10, u_order 60, user_version 2
tarball_bytes: 211979

$ ./install.sh --skip-dns --prefix /tmp/skw-stale
  verify: 27/27 checks passed; farm links=10; files=33
  verify        3964ms
  smoke: served rows match the exported snapshot
  smoke          200ms
TOTAL 18485ms        exit=0

stats: {"cms_page":201,"new_pages":0,"revised":0,"cms_page_revision":1, …}
GET /new/39 -> 404
GET /p/1 body: <section class="p1"><h1>Page 1</h1>…      (the pre-publish body, not "REVISED 1")
```

Source: 241 pages / 40 new / 60 rewritten. Installed: 201 / 0 / 0. Install reported success.

### M5 — `find -L` is blind to the link that matters

```
$ ln -s ../media/ab/real.bin b/content/public/rel.bin
$ ln -s /tmp/linkchk/b/content/media/ab/real.bin b/content/public/abs-ok.bin
$ ln -s /tmp/does-not-exist.bin b/content/public/abs-broken.bin
$ find -L b -type l
b/content/public/abs-broken.bin
[end]
$ readlink each:
rel.bin     -> ../media/ab/real.bin
abs-ok.bin  -> /tmp/linkchk/b/content/media/ab/real.bin
$ tar tzvf b.tgz | grep public
lrwxr-xr-x  0 cyberdeth wheel  0 ./content/public/rel.bin        -> ../media/ab/real.bin
lrwxr-xr-x  0 cyberdeth wheel  0 ./content/public/abs-ok.bin     -> /tmp/linkchk/b/content/media/ab/real.bin
lrwxr-xr-x  0 cyberdeth wheel  0 ./content/public/abs-broken.bin -> /tmp/does-not-exist.bin
```

### M6 — ACME: nginx-proxy 1.6 + acme-companion 2.5 against Pebble

```
$ bash acme/run.sh          # pebble with PEBBLE_VA_ALWAYS_VALID=1 (validation short-circuited)
CERT_ISSUED after 16.01s
-rw-r--r--  1 root root 1220 Oct 20 00:52 cert.pem
-rw-r--r--  1 root root  660 Oct 20 00:52 chain.pem
-rw-r--r--  1 root root 1880 Oct 20 00:52 fullchain.pem
subject: ()   issuer : ((('commonName', 'Pebble Intermediate CA 23bd5b'),),)
notBefore: Oct 20 00:51:57 2026 GMT   notAfter: Oct 26 00:51:56 2026 GMT
acme log: [00:52:02] Cert success.  …  Reloading nginx proxy (p_proxy)…  Sleep for 3600s
```

First attempt without the CA bundle: `Error registering account`, `unable to get local issuer
certificate` — the companion does not trust a private ACME CA unless `CURL_CA_BUNDLE` is mounted.
That is a real deployment detail for a client who wants their own CA, and it costs one env var.

What 16.01 s **excludes**: public DNS propagation, inbound port 80, Let's Encrypt production
validation and rate limits, and the 3600 s retry after any failure.

### M7 — What "no control.db" and "the whole control.db" each mean

```
fleet : tenants ['acme','beta','gamma'] | domains 48 (foreign 46) | users
        ['fleet@skunkworks.dev','ops@acme.com','beta@example.com'] | sessions 2 | audit 120
sealed: tenants ['acme'] | mode production | domains ['acme.com','www.acme.com'] | users ['ops@acme.com']
        | sessions 0 | audit 0 | not_exported ['session','audit_log','deploy_token','other tenants','acme_state']
grep -rl 'beta@example.com|site7.example|fleet@skunkworks' over the bundle: fleet 1 file, sealed 0
```

### M8 — DNS pre-flight cost

```
('acme.com','184.23.246.145',None,14.7 ms)
('example.com','104.20.23.154',None,7.2 ms)
('no-such-tenant-9f3a.invalid',None,'gaierror',1.9 ms)
public ip 124.168.71.98 in 266.2 ms   (api.ipify.org; --offline degrades to "A-record unverified")
```

### M9 — A server-level `return` in nginx swallows a location

The default server first shipped with `location = /healthz-nginx { return 200 "ok"; }` **and** a
server-level `return 404;`. The health check failed, the edge went `(unhealthy)`, and `compose up
--wait` refused the install (exit 16) — with a config that `nginx -t` accepted.

```
$ docker compose exec -T edge wget -q -O /dev/null http://127.0.0.1/healthz-nginx
wget: server returned error: HTTP/1.1 404 Not Found
$ docker inspect --format '{{json .State.Health}}' run-edge-1
{"Status":"unhealthy","FailingStreak":3,"Log":[{"ExitCode":1,"Output":"wget: server returned error:
 HTTP/1.1 404 Not Found\n"}, …]}
$ curl -s -o /dev/null -w '%{http_code}' -H 'Host: acme.com' http://127.0.0.1:8080/    → 404
```

Fix: the 404 lives in `location / { return 404; }`. The install then reaches `up 11545ms` and the
smoke passes. Server-level rewrite directives run before location selection, so an unconditional
`return` there is a catch-all — including for the health endpoint that is supposed to prove the edge
is alive.

### M10 — Gated bytes on the installed bundle

```
gated sha = 823915f3…a392, 150009 B on disk under content/media/82/
GET /media/ebook.pdf          -> 404        (no farm link exists for a gated asset)
GET /media/banner-home.png    -> 200 262400B
GET /__protected/<real sha>.pdf -> 404      (internal: a direct request is refused even for a real file)
find content/public -type l -lname "*<gated sha>*" | wc -l -> 0
```

The 404 on `/__protected/` is the correct result and it is also why this test cannot prove the offload
works: only `X-Accel-Redirect` can reach an `internal` location, which is R1 T2's measurement.

---

## 6. What I concede, and what would change my mind

**Conceded.**

1. **My R1 P3 check is wrong.** `find -L bundle -type l` reports only broken links; an absolute link
   whose target still exists passes it (M5). The check that works is `readlink` + regex, and it is what
   ships now. I asked the other domains to accept a falsifier I had not run; that is the same mistake I
   attacked in Data's M1.
2. **"`cp` loses data" was under-specified.** `cp` main + `-wal` back-to-back reproduced 241/40/60
   exactly (M1, A3). The honest statement is worse than the one I made: the result depends on
   interleaving, so the same code is correct on a quiet site and wrong on a publishing one, and nothing
   in the artifact records which happened. Data's M1 and my T17b were the same defect at two
   interleavings, not two defects.
3. **My R1 install floor of 22.8 s measured the wrong thing.** It was two pulls and `up --wait`, with
   no database, no control plane, no gate, no smoke. The real sequence is 18.2 s warm / 29.8 s cold for
   a **3.1 MB** bundle, and 11.5 s of that is `compose up --wait` — which I only got down from 16.5 s
   by cutting health-check intervals from 5 s to 2 s. That is a trade against flapping sensitivity that
   is defensible on 2 vCPU and questionable on 1.
4. **A bundle cannot verify its own completeness.** M4 is the concession that matters: 27/27 checks,
   exit 0, "rows match", and a stale site. I spent Round 1 designing checks; the answer is a producer
   rule (P9) plus a manifest, and the checks only catch exporters that disagree with themselves.
5. **I shipped the same class of bug in my own installer twice** — a sentinel collision that
   regenerated every secret on the second run, and an installer that wrote into the artifact it had
   just verified (exit 12 on re-run). Both were found by running it twice, which is now a required
   test, not a nice-to-have.
6. **Security's S-6 cannot survive the generated `storage_path`.** I am the one proposing the weaker
   invariant (C2), so I own the regression: "absent by construction" becomes "absent by a test".

**What would change my mind.**

- **A measured 1 GB bundle transfer.** If tar + transfer dominates at realistic media sizes, the
  promise needs a size ceiling (say ≤200 MB) or a resumable fetch, and "5 minutes" becomes "5 minutes
  after the bytes are on the box". My arithmetic says 6.8 min at 20 Mbps; I have not measured a link.
- **A read-only mount where `-shm` can be created.** If a Linux bind mount lets a WAL file open
  read-only (some filesystems allow the `-shm` in a writable overlay), P11's "ship cold" rule is
  unnecessary complexity and I will drop it — on this box it is not true.
- **`docker save` image sizes.** If `--offline` payloads are ~300 MB, the offline path changes the
  promise's character and must be priced separately, as R1 Q2 said.
- **A per-tenant worker under ~8 MB RSS.** Then the process boundary is affordable on a 2 GB box, S-2
  becomes structural, and my P2 gains a second wall I would rather have than my current one.
- **Evidence that acme-companion can be made to retry faster than 3600 s without hammering the CA.**
  If a 60 s retry with backoff is safe, the DNS failure mode stops being "tomorrow" and the pre-flight
  refusal becomes a convenience rather than a necessity.
