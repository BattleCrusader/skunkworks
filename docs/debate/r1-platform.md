# R1 — Platform

Platform specialist position, round 1. Every number in §6 was produced on this box today
(Docker 29.7.2, Compose v5.3.1, nginx 1.31.7 in `nginx:alpine`, Node 22.23.1, sqlite 3.43.2).
Where I could not measure something, §5 or the attack says so instead of guessing.

Builds on `IDEA.md` §3.1 (host-header routing, measured), §5 (tenant/demo/resale), §5.1 (three
export targets), §7.7 (bandwidth). The parts I am re-opening are named explicitly.

---

## 1. Invariants I will defend (numbered, falsifiable)

**P1 — Tenancy is declared by the edge, not by the client, and the app can prove which.**
A request is attributed to a tenant only by (a) `Host` matched in `control.db`, or (b) a
`X-Skunkworks-Tenant` header that arrived with the matching `X-Skunkworks-Edge` token, set inside
an nginx `location` that also sets `Host`. A client-supplied tenant header is inert. For path-prefix
demos the key is derived by a `map` on `$request_uri`, so adding a demo changes no config (PD5).
*Falsified by:* one `curl -H 'X-Skunkworks-Tenant: victim'` that renders victim's site.
*Status today:* **falsified by the obvious config** — measured `tenant_header:"victim"` and
`host:"app"` on any location that declares a `proxy_set_header` of its own (§6, T7/T8b).
`IDEA.md` does not specify this; §3.1 only describes the happy path.

**P2 — No tenant's bytes are reachable through another tenant's URL.**
`/media/<key>` resolves inside exactly one tenant's `content/public`, and no request parameter can
change which tenant that is.
*Falsified by:* a 200 for a key that exists only in tenant B, requested on tenant A's host; or any
`/media/..%2f..%2f` variant that escapes the alias.
*Evidence form:* 200 keys × 2 tenants, 0 cross-hits, 0 non-404 for traversal strings.

**P3 — A bundle is a closed world, verified before it is written and before it is started.**
Every byte a bundle renders is inside the bundle, referenced by a bundle-relative path, and the
exporter refuses to emit a bundle whose media graph is not closed.
*Falsified by:* extract into an empty directory, render every page, get one 404 for `/media/`; or
`find -L` reporting a link that resolves outside the bundle root.
*Measured:* a relative link serves 200 B, the same link written absolute 404s inside a container
(T11d/T11e), and `tar` ships either target verbatim (T11f).

**P4 — Health means the thing it protects works, and one tenant's sickness cannot restart the fleet.**
`/readyz` fails when the serving path is broken; a single tenant's broken DB is reported per tenant
and never flips the process health or triggers a restart.
*Falsified by:* `docker compose ps` reporting `healthy` while a request to the site fails —
**measured exactly that** (T13): `/healthz` 200, `/readyz` 503, app still `(healthy)`.

**P5 — Nothing waits on a default timeout.**
Every proxying `location` declares connect/send/read timeouts, and the upstream peer is never
retried silently.
*Falsified by:* a request to a dead upstream taking 60 s — **measured 60.001 s → 504** (T14);
2.006 s with `proxy_connect_timeout 2s` (T15).

**P6 — A backup never blocks a writer, and a restore is proven before it replaces anything.**
*Falsified by:* any writer error during a backup, an `integrity_check` that is not `ok`, or a
restore whose smoke render fails. Measured: 240 MB DB, `VACUUM INTO` **0.73 s**, 400 concurrent
inserts, **0 writer errors**, `integrity_check ok` (T17a).
**Corollary that is load-bearing:** `cp site.db` is **not** a backup. Measured: 501 rows, copy has
**1 row**, 8,192 B, and `integrity_check` on the copy says **ok** (T17b). A valid database that is
silently two megabytes and five hundred rows behind is the worst failure shape we can ship.

**P7 — Install time is a property of an artifact, printed by the installer.**
`install.sh` writes `install-report.txt` with per-phase milliseconds; the ≤5 min claim holds only
for a pinned-digest CMS bundle on ≥2 vCPU / 2 GB with DNS already pointing at the box.
*Falsified by:* a time claim with no report, or a report over 300 s.
Measured floor: **22.8 s** from no images to both services healthy (T0). Unmeasured ceiling: DNS +
ACME (§5 Q1).

**P8 — The edge moves the bytes; the app makes the decision.**
No `/media/` or gated byte traverses Node.
*Falsified by:* any `/media/<key>` appearing in the app's request log, or a gated download whose
`bytes_sent` in `cms_download_event` is not within 1 % of nginx's `$body_bytes_sent`.
Measured: direct `/__protected/` = 404 (T1); offload streams 100,193 B (T2); a Range request returns
206 with 1,000 B (T3).

---

## 2. Decisions — each: Decision / Alternatives rejected / Why they lost / Failure mode if wrong

Platform decisions are `PD*` so they do not collide with `D1–D24`.

### PD1 — One proxy snippet, included by every proxying `location`; the tenant header defaults to empty

**Decision.** `/etc/nginx/snippets/skunk-proxy.conf` is included inside every `location` that
proxies, and it sets the tenant header to the empty string. A prefix-demo location overrides that
one line with the tenant key. The app only honours a non-empty tenant header when
`X-Skunkworks-Edge` matches `SKUNK_EDGE_TOKEN`.

```nginx
# snippets/skunk-proxy.conf — rendered by install.sh with the edge token baked in
proxy_http_version 1.1;
proxy_set_header Host               $host;
proxy_set_header X-Real-IP          $remote_addr;
proxy_set_header X-Forwarded-For    $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto  $scheme;
proxy_set_header X-Forwarded-Host   $host;
proxy_set_header X-Skunkworks-Edge  "<rendered token>";
# Fail closed: a client claim never survives to the app unless a location overrides this line.
proxy_set_header X-Skunkworks-Tenant "";
proxy_connect_timeout 2s;
proxy_send_timeout    20s;
proxy_read_timeout    20s;
proxy_next_upstream   off;
```

**Alternatives rejected.** (a) `proxy_set_header` at `server` scope and rely on inheritance;
(b) app trusts `X-Skunkworks-Tenant` because "only nginx can reach it"; (c) one `upstream` per tenant.

**Why they lost.** (a) is the trap I measured: nginx does **not** merge `proxy_set_header` across
scopes, so a `location` that adds one header of its own drops the entire server-scope set — the app
then received `tenant_header:"victim"` from the client **and** `host:"app"` (T8b). (b) fails for the
same reason and has no second line of defence. (c) needs an nginx reload per tenant and still cannot
express `/demo/<key>/`.

**Failure mode if wrong.** A new `location` that forgets the include fails closed: the tenant header
is empty, the app resolves from `Host`, a prefix demo 404s. The blast radius of a config mistake is a
404, not a breach. CI check: every `location` block containing `proxy_pass` must contain the include
(`grep -A20 'location ' | grep -c skunk-proxy` must equal `proxy_pass` count).

### PD2 — Gated bytes leave through `internal` + `X-Accel-Redirect`; the app is the only authoriser

**Decision.** The app answers `200` with no body and one of exactly two headers:

```
X-Accel-Redirect: /__protected/<64-hex>[.<ext>]
X-Accel-Redirect: /__protected/wm/<64-hex>/<64-hex>[.<ext>]
```

nginx serves those from a regex-matched `internal` location; anything else under `/__protected/`
is 404 by construction.

```nginx
# Reject anything under /__protected/ that is not a 64-hex asset name.
# The regex MUST be quoted: an unquoted {64} quantifier ends the token and nginx
# fails with pcre2_compile(): missing closing parenthesis (measured, T23).
location ~ "^/__protected/(?!(?:wm/[0-9a-f]{64}/)?[0-9a-f]{64}(?:\.[a-z0-9]{1,5})?$)" {
    internal;
    return 404;
}
location /__protected/ {
    internal;
    alias /srv/data/content/protected/;
    # nothing else: no add_header. The app already sends Cache-Control and nginx
    # already emits Accept-Ranges; adding either duplicates the header (T2, T23).
}
```

**Alternatives rejected.** (a) Node streams the file; (b) `auth_request` to the app; (c)
`secure_link` signed URL.

**Why they lost.** (a) 200 MB through a 1 GB container is an OOM at three concurrent downloads and
burns the event loop that every other tenant shares (T22). (b) `auth_request` fires per subrequest
and per Range chunk — it multiplies the accounting bug in A1 rather than fixing it. (c) `secure_link`
cannot make an atomic `uses = uses + 1` decision, which is the one thing that must happen server-side.

**Failure mode if wrong.** If the regex is looser than above, a guessed checksum serves a paid file.
Measured today: a direct hit on `/__protected/sample.pdf` is **404** (T1), and an offload to a
non-existent path returns **404** with the app's 200 discarded (T4) — so the edge fails closed.

### PD3 — `migrate` is a one-shot service; the app never migrates at boot

**Decision.** A `migrate` service runs `node migrate.mjs --tenant all`, exits, and `app` declares
`depends_on: {migrate: {condition: service_completed_successfully}}`. `install.sh` refuses Compose
< 2.20 (the condition syntax) and Docker < 24.

```yaml
services:
  migrate:
    image: ghcr.io/skunkworks/cms@sha256:<digest>
    command: ["node", "/srv/app/migrate.mjs", "--tenant", "all"]
    restart: "no"                 # a failure must be visible, not looped
    read_only: true
    user: "10001:10001"
    env_file: [.env]
    volumes: ["./data:/srv/data"]
  app:
    image: ghcr.io/skunkworks/cms@sha256:<digest>   # same digest as migrate, by definition
    restart: unless-stopped
    read_only: true
    tmpfs: ["/tmp:size=64m", "/run:size=1m"]
    user: "10001:10001"
    env_file: [.env]
    volumes: ["./data:/srv/data"]
    expose: ["3000"]              # no published port: only nginx can reach it
    depends_on:
      migrate: {condition: service_completed_successfully}
    healthcheck:
      test: ["CMD", "node", "/srv/app/healthcheck.mjs"]   # /readyz semantics, 3s timeout
      interval: 10s
      timeout: 3s
      retries: 3
      start_period: 20s
    deploy:
      resources:
        limits: {memory: 1g}
```

**Alternatives rejected.** Migrate-on-boot; a documented `docker compose run` step in the README.

**Why they lost.** Migrate-on-boot turns a failed migration into a crash-loop with a health check
that never passes and an operator who cannot see why; the manual step is a human in the middle of a
5-minute promise, which is the one thing `install.sh` exists to remove.

**Failure mode if wrong.** A migration that succeeds on one run and fails on a re-run (non-idempotent
DDL) blocks startup on every subsequent boot. Mitigation: `migrate` is required to be idempotent and
the install smoke test runs it twice.

### PD4 — Public media is a farm of **relative** symlinks, served by nginx, rebuilt by the app only

**Decision.** `content/public/<key>.<ext>` → `../media/<hh>/<sha256>.<ext>`, relative, regenerated on
create/rename/delete. nginx serves it with a bare `alias`; the app never sees the request.

```nginx
location /media/ {
    alias /srv/data/content/public/;
    add_header Cache-Control "public, max-age=31536000, immutable";
    access_log off;
}
```

**Alternatives rejected.** (a) Node serves `/media/` with cache headers; (b) URLs by checksum
(`/media/<sha>.webp`) with no key; (c) `X-Accel-Redirect` for public assets too.

**Why they lost.** (a) puts thumbnail traffic on the shared process — an image gallery is 30
requests/page and the app is one process for all tenants (T22). (b) contradicts D17 (identity is the
key) and cannot be renamed; a client's `banner-home` becomes `ab12cd…`, and nobody hand-edits that.
(c) an app round-trip per image for no decision that needs making.

**Failure mode if wrong.** Links written absolute work on the machine that wrote them and 404
everywhere else: measured 404 from inside a container for a link pointing at
`/Users/cyberdeth/.../data/protected/small.bin`, 200 for `../media/ab/deadbeef.bin` (T11d/T11e).
`tar` preserves the target string either way (T11f), so the bug ships. The farm must be written with
`os.symlink('../media/<hh>/<sha>.<ext>', ...)` and the exporter must assert every link matches
`^\.\./media/[0-9a-f]{2}/[0-9a-f]{64}\.[a-z0-9]+$`.

Note from the same run: nginx follows a symlink that points anywhere — `/etc/hostname` via a link in
the public tree returned **200, 13 bytes** (T11g). `disable_symlinks` is not usable (it would refuse
the farm itself), so the containment rule is "only the app writes the farm, and the directory is
read-only to everything else", not "nginx checks".

### PD5 — Every path-prefix demo is served by **one** `location /demo/`; the tenant comes from a `map`, not from per-demo config

**Decision.** A demo is a row in `control.db` plus this. Creating one requires no nginx reload and no
SSH.

```nginx
map $request_uri $demo_key {
    "~^/demo/(?<dk>[a-z0-9][a-z0-9-]{0,31})/"  $dk;
    default                                     "";
}

# /demo/acme  ->  /demo/acme/   (regex locations are evaluated before the prefix location)
location ~ "^/demo/(?<dk3>[a-z0-9][a-z0-9-]{0,31})$" {
    return 301 /demo/$dk3/;
}

location /demo/ {
    if ($demo_key = "") { return 404; }
    rewrite "^/demo/[a-z0-9][a-z0-9-]{0,31}/(.*)$" /$1 break;
    include /etc/nginx/snippets/skunk-proxy.conf;
    proxy_set_header X-Forwarded-Prefix  "/demo/$demo_key";
    proxy_set_header X-Skunkworks-Tenant $demo_key;
    proxy_redirect     / /demo/$demo_key/;
    proxy_pass http://app;
}
```

The app must **reject an unknown `$demo_key` with 404 itself**: nginx forwards any well-formed key,
measured `GET /demo/zzz/whoami` → **200** with `tenant_header:"zzz"` (T24). The edge validates the
*shape*; only `control.db` knows which tenants exist.

**Alternatives rejected.** (a) one `location /demo/<key>/` per demo, generated from `control.db`;
(b) make every demo a subdomain; (c) `proxy_redirect default`.

**Why they lost.** (a) needs a config write plus `nginx -s reload` for every demo, which is an SSH
step in a workflow that must be clickable in admin, and it puts a reload (a config re-read) on the
critical path of creating a sales asset. Measured equivalent: the single block served
`/demo/acme/whoami` as `tenant:"acme" path:"/whoami"` and `/demo/beta/whoami` as `tenant:"beta"`,
with no per-tenant config (T24). (b) still needs DNS, which is what path demos exist to avoid.
(c) measured: `proxy_redirect default` **deletes the `Location` header entirely** — a 302 with no
target, invisible to a status-code-only test (T18).

**Failure mode if wrong.** If the map's `rewrite` regex and the tenant regex disagree, a URL is
stripped but attributed to the wrong key, or attributed but not stripped — the app then serves the
wrong path under the right tenant (a 404, not a leak, because the tenant still comes from the map).
The smoke test asserts, for two demos: status 200, `tenant` correct, `path` free of `/demo/`, and
`Location` present with the prefix on a redirecting route.

Also measured while getting this right: every `{n}` quantifier inside `location ~` or `map` must be
quoted, or nginx stops with `unexpected "{"` / `pcre2_compile()` (T23, T24); and ~10 `proxy_set_header`
directives trip `could not build optimal proxy_headers_hash` until `proxy_headers_hash_max_size 2048;
proxy_headers_hash_bucket_size 128;` are set (T24).

### PD6 — TLS is per-host HTTP-01 with an `ask` gate; renewal is watched by a timer, not by hope

**Decision.** `acme-companion` label-driven per host. On-demand TLS points at
`GET /__acme/ask?domain=<host>` on the app, which returns 200 only for a host present in
`control.db.domains` and 404 otherwise. A `cert-watch` sidecar curls every active domain daily and
alerts when `notAfter < 14d` or the handshake fails.

**Alternatives rejected.** Wildcard + DNS-01 (registrar API credentials per client — the reason
wildcards looked hard in the first place, and they still do not cover client TLDs); one multi-SAN
cert (100-name limit; one client's DNS failure blocks everyone's renewal).

**Why they lost.** Per-host HTTP-01 needs one thing we already require for hosting — a DNS record
pointing at the box — and nothing else, which is the whole argument in `IDEA.md` §3.1. A wildcard
would make every client's demo contingent on us holding their registrar credentials, and it cannot
cover a client TLD at all, so it solves the demo case and fails the production case we actually sell.
The multi-SAN cert trades a per-client failure domain for a shared one: one client's lapsed DNS breaks
renewal for the other 99 names on the cert, and a single 100-name ceiling caps the business.

**Failure mode if wrong.** A silent renewal failure means an expired certificate and a browser
warning on a client's production site — the only outage class that is visible to their customers
before it is visible to us. The `ask` gate's failure mode is worse in the other direction: if it
returns 200 for anything, anyone can point a domain at the box and burn the 50-certs-per-week quota
for `company.com`.

### PD7 — Backup is `VACUUM INTO` + `integrity_check` + a restore drill; `cp` is banned

**Decision.** `backupTenant(key)` runs `VACUUM INTO '<dest>'` on a read connection, then
`PRAGMA integrity_check` on the copy, then records `{bytes, ms, integrity}` in `control.db`. Nightly
per tenant, 14 daily + 8 weekly retention. `install.sh --restore-drill` restores into a scratch
container and renders 3 pages before declaring success.

**Alternatives rejected.** `cp site.db`; the SQLite online-backup API via a native helper; filesystem
snapshots (not available on the client's VPS).

**Why they lost.** `cp` is measured wrong in the way that matters: 501 rows live, **1 row** in the
copy, 8,192 B, `integrity_check ok` (T17b) — the copy is a valid database that is silently stale, and
WAL means the main file alone is not the database. The native helper adds a compiled dependency to a
pure-TS stack for no capability `VACUUM INTO` lacks. Snapshots do not exist on the target hardware.

**Failure mode if wrong.** A restore that is days old, discovered during an incident. Mitigation is
the drill, not the backup: an unverified backup is a rumour. Measured cost: **0.73 s** for 240 MB, so
the drill is affordable nightly.

### PD8 — Per-tenant ceilings at the edge; one memory limit on the app

**Decision.** `limit_req_zone $skunk_tenant zone=tenant:10m rate=20r/s`, `limit_conn_zone
$skunk_tenant zone=conn:10m`, `limit_conn conn 8` on `/__protected/` and `/media/`, `limit_rate 1m`
on gated downloads, `client_max_body_size` per location (admin 25m, public forms 1m, `/api/` 2m).
The app gets `--max-old-space-size=768` and a 1 GB container limit.

```nginx
map $skunk_tenant $tenant_key { "" $host; default $skunk_tenant; }
limit_req_zone  $tenant_key zone=tenant:10m rate=20r/s;
limit_conn_zone $tenant_key zone=conn:10m;
```

**Alternatives rejected.** Quotas inside Node; a container per tenant.

**Why they lost.** In-app quotas die with the process they are meant to protect and cannot see a
request that never reaches the app. A container per tenant multiplies our image pull, our migration
path and our support surface, and SQLite on a shared volume gives no isolation win anyway.

**Failure mode if wrong.** If the `map` fallback is wrong, every host-routed tenant shares one zone
key and one tenant's burst throttles everyone. Test: two hosts, 100 r/s on A, assert B still gets
200s. Measured basis: `limit_rate 1m` held 10 MiB to **9.051 s / 1,158,458 B/s** (T10), so the
mechanism works; the keying is what needs the test.

### PD9 — The bundle carries a pinned image and a manifest; install verifies both before starting

**Decision.** `site-bundle.tar.gz` = `docker-compose.yml` (image by digest) + `.env` (fresh secrets) +
`data/` + `content/` + `install.sh` + `bundle.manifest.json` (sha256 of every file, plus the image
digest). `install.sh --verify` checks: Docker/Compose versions, ports 80/443 free, disk ≥ 3× bundle
size, DNS resolves to this host (or `--skip-dns`), manifest hashes, `docker manifest inspect` for the
digest, and that no symlink escapes the bundle root.

**Alternatives rejected.** Bundle with `build:` context (build from source on the client's box);
source tarball + README.

**Why they lost.** Measured: a cold `npm install` for a **ten-page Astro site with no CMS at all** is
**38.5 s**, 664 tarballs, 154 MB of `node_modules` (T19) — and that is before any of our code, any
`sharp`, any `pdf-lib`, any build step. A from-source CMS bundle is minutes of `npm ci` on hardware
we do not control, inside the 5-minute promise. The pinned-image path measured **22.8 s** including
both pulls (T0).

**Failure mode if wrong.** A digest that the registry has garbage-collected or that needs private
auth fails at pull, on the client's box, with a Docker error. Mitigation: `--offline` accepts an
`image.tar` in the bundle, and `--verify` fails early with a message naming the digest.

### PD10 — `.env` is generated per install; a bundle never carries a secret that was ever used

**Decision.** `install.sh` writes `.env` from a template with 32-byte random values (`SKUNK_EDGE_TOKEN`,
`SESSION_KEY`, `DOWNLOAD_HMAC_KEY`), `chmod 600`, owner 10001. The exporter refuses to write a
bundle whose `.env` values have less than 4 bits/char of entropy or match the template defaults.

**Alternatives rejected.** Secrets as compose environment literals; secrets baked into the image.

**Why they lost.** `docker inspect` prints environment literals to any local user, and a bundle is
shipped to third parties — a shared edge token across every client install means one client's bundle
is every client's key.

**Failure mode if wrong.** If the exporter ships our dev `.env`, a client holds the token that signs
tenant headers for our hosting fleet. The entropy check is the guard; the deeper guard is that the
edge token is per-install, so it has no cross-install value.

---

## 3. Interface contracts I require from other domains (signatures, routes, env vars, paths, error codes)

### 3.1 Edge → app (headers)

| Header | Set by | Present | App behaviour if absent |
|---|---|---|---|
| `Host` | snippet, `$host` | always | 400 — refuse to guess |
| `X-Real-IP`, `X-Forwarded-For` | snippet | always | use socket address; log `ip_source:"socket"` |
| `X-Forwarded-Proto` | snippet | always | assume `https` |
| `X-Skunkworks-Tenant` | snippet (empty) / prefix location (key) | always, may be empty | resolve tenant from `Host` |
| `X-Skunkworks-Edge` | snippet | always | **421** if a non-empty tenant header is present without it |
| `X-Forwarded-Prefix` | prefix location only | prefix routes only | treat as host route |

Rules I require of runtime: `X-Forwarded-Prefix` is the **only** source of a URL prefix. Astro `base`
must not be used for this (it is build-time; §3.1 already established it cannot be per-request). A
hardcoded absolute `/media/...` in a page body is a bug under a prefix route.

### 3.2 App → edge (the only legal offload)

```
X-Accel-Redirect: /__protected/<64-hex>.<ext>              status must be 200, empty body
X-Accel-Redirect: /__protected/wm/<64-hex>/<64-hex>.<ext>  status must be 200, empty body
```

Measured behaviour of that handoff (§6 T2/T3) — the app must design around it:

- `Content-Type`, `Content-Disposition`, `Cache-Control` **survive** from the app's response.
- Custom headers (`X-Download-Id`) **do not survive**. Nothing may depend on a custom response
  header on an offload response; the audit row is the record, not a header.
- nginx replaces `Content-Length` with the file's, adds `Last-Modified`/`ETag`, and honours `Range`
  (206, `Content-Range: bytes 1000-1999/100193`).
- The app's 200 is discarded if the target is missing (404 returned). So the app must confirm the
  file exists before redirecting, or accept a 404 the user sees as a broken download.

### 3.3 On-disk layout (installer and exporter both depend on this)

```
/srv/data/control.db
/srv/data/tenants/<key>/site.db            (+ -wal, -shm)
/srv/data/tenants/<key>/content/media/<hh>/<sha256>.<ext>
/srv/data/tenants/<key>/content/public/<key>.<ext>   -> ../media/<hh>/<sha256>.<ext>
/srv/data/tenants/<key>/content/protected/…          (gated + watermark renders)
/srv/data/tenants/<key>/content/sources/*.js
/srv/data/backups/<key>/<ISO8601>.db
/srv/data/logs/access-<yyyy-mm-dd>.jsonl
```

`content/` sits inside the tenant directory, which is what `IDEA.md` §3's diagram already shows. The
one place the layouts differ is the **bundle**: §5 lists `data/site.db` + `content/` at the bundle
root. `install.sh` is the mapping between the two (`data/site.db` → `tenants/<key>/site.db`,
`content/` → `tenants/<key>/content/`), and `exportSite` must be written against that mapping rather
than against the bundle shape, or the two drift.

### 3.4 Environment variables (defaults are the contract)

| Var | Default | Meaning |
|---|---|---|
| `SKUNK_MODE` | `production` | `production` \| `demo` \| `internal` |
| `SKUNK_TENANT_KEY` | — | single-tenant installs (exported bundle) |
| `SKUNK_EDGE_TOKEN` | generated | must match the rendered nginx snippet |
| `SKUNK_CONTROL_DB` | `/srv/data/control.db` | |
| `SKUNK_TENANTS_DIR` | `/srv/data/tenants` | |
| `SKUNK_BACKUP_DIR` | `/srv/data/backups` | |
| `SKUNK_PUBLIC_ORIGIN` | `https://$host` | used by the URL helper only |
| `SKUNK_SCHEMA_EDIT` | `off` | `on` enables the `u_*` DDL runner (IDEA §11 Q4) |
| `SKUNK_DB_BUSY_TIMEOUT_MS` | `2000` | must match the measured 1.45 s wait (T17a) |
| `SKUNK_RENDER_TIMEOUT_MS` | `5000` | per-page SSR budget; exceeding it logs `render_timeout` |
| `NODE_OPTIONS` | `--max-old-space-size=768` | |

### 3.5 HTTP status contract

| Condition | Status | Body code | Notes |
|---|---|---|---|
| Tenant header **non-empty**, edge token wrong/absent | 421 | `EDGE_TOKEN_INVALID` | never render |
| No tenant resolvable | 404 | `TENANT_UNKNOWN` | `X-Skunkworks-Reason` header |
| Unknown slug on a known tenant | 404 | `PAGE_NOT_FOUND` | must be the tenant's own 404 page |
| Body over the location's cap | 413 | nginx HTML | measured, T9 — clean 413, `Connection: close`, no reset |
| Rate/connection limit | 429 / 503 | nginx HTML | `limit_req`/`limit_conn` |
| `SQLITE_BUSY` after `busy_timeout` | 503 | `DB_BUSY` | `Retry-After: 2` |
| `SQLITE_FULL` / `SQLITE_IOERR` | 507 | `DISK_FULL` | page renders a tenant-visible banner |
| Upstream dead, connect timeout | 502 / 504 | nginx HTML | 2 s with PD1 timeouts, 60 s without |
| Migration not applied | 503 | `SCHEMA_STALE` | `migrate` gate failed |

### 3.6 Health endpoints — three questions, three answers

- `GET /healthz` → `200 {"ok":true}` always when the process is up. **Liveness only.** Never touches
  a database, never fails for a tenant.
- `GET /readyz` → 200 only if `control.db` opens, the tenant map loads, and a write probe to a
  scratch table in `control.db` succeeds (a read-only check passes on a full disk — that is the
  failure I want to catch). Checks the *serving path*, not a specific tenant.
- `GET /admin/api/tenants/<key>/health` → per-tenant: `site.db` opens, `PRAGMA quick_check` (cached
  30 s), page count, disk headroom. **Not** part of the container health check; it drives an alert.

nginx's own health check must **not** proxy to the app: measured, stopping the app turned nginx
`(unhealthy)` too (T14), so a single tenant-app fault would flap the edge and, under any autoheal
policy, restart the component that was still working. nginx checks that it can serve a static byte
from its own root; the app is checked by the app's health check; `depends_on: service_healthy` orders
startup only.

### 3.7 Export CLI (I need this signature from runtime/data-model)

```ts
exportSite(input: {
  tenant: string;
  target: 'cms' | 'astro' | 'static';
  out: string;                 // absolute path, must not exist
  includeDrafts?: boolean;     // default false
  onProgress?: (phase: string, pct: number) => void;
}): Promise<{
  bundle: string;
  bytes: number;
  ms: number;
  refusals: Array<{ code: RefusalCode; subject: string; detail: string }>;
  notes: Array<{ code: NoteCode; subject: string; rows?: number }>;
  manifestSha: string;
}>;

type RefusalCode =
  | 'GATED_ASSETS_PRESENT'      // → exit 20
  | 'MEDIA_GRAPH_OPEN'          // → exit 21
  | 'PARAMETERISED_SOURCE'      // → exit 22 when the target cannot represent it
  | 'INSUFFICIENT_DISK'         // → exit 23
  | 'TENANT_NOT_FOUND';         // → exit 24
```

Refusals abort before a byte is written (IDEA §5.1's pre-flight). Notes never abort: they are written
into `EXPORT-NOTES.md` and echoed to stderr as `WARN`. Frozen row counts appear in the note, not in a
log line nobody reads.

### 3.8 `install.sh` contract

```
install.sh [--verify] [--offline <image.tar>] [--skip-dns] [--non-interactive] [--restore-drill]
exit 0 ok · 10 preflight (docker/compose version, ports) · 11 dns · 12 manifest · 13 image pull
     · 14 secrets · 15 migrate · 16 smoke · 17 disk
```

Idempotent: re-running must reach exit 0 without touching `data/`. It writes `install-report.txt`:

```
preflight 412ms | pull 18400ms | secrets 9ms | chown 61ms | migrate 1180ms | up 2300ms | smoke 890ms | total 23.3s
```

First-boot trap I measured: a fresh named volume owned by root plus a non-root container user gives
`touch: /data/probe: Permission denied`; after a root one-shot `chown -R 10001:10001 /data` the same
write succeeds (T20). So `install.sh` must chown the data directory **before** `up`, and the
`install-report.txt` must contain that phase or nobody will believe it happened.

### 3.9 Log schema (bandwidth is a billing question, not a debugging question)

nginx `log_format json_combined escape=json '{"t":"$time_iso8601","tenant":"$tenant_key",
"host":"$host","req":"$request","status":$status,"bytes":$body_bytes_sent,"rt":$request_time,
"urt":"$upstream_response_time","range":"$http_range"}';`

That one line answers "which tenant used 400 GB" and "did that download resume", and it is the only
place `bytes_sent` is trustworthy (the app's count is the file size, nginx's is what left the box).

---

## 4. Attack points — at least 3 outside my domain (claim / failure / severity / settling evidence), including one on export fidelity and one on the operational cost of the security model

### A1 — Security: a gated download spends one `max_uses` credit per HTTP request, not per download

**Claim attacked.** `IDEA.md` §7.4 step 4: `GET /d/<asset-key>/file` validates the token, runs
`UPDATE cms_download_code SET uses = uses + 1 …`, then offloads. The implication is that one download
costs one use.

**Failure.** The consume runs per request, and a download is not one request. Measured (T16): one
plain request plus three `Range` requests produced **uses = 4**. Browsers, PDF viewers and video
players resume exactly like this. With the shipped default `max_uses = 3` (§7.6), a single download
that needs four chunks fails **mid-transfer** — the buyer has paid, the file is half-downloaded, and
the CMS reports the code as exhausted. It gets worse with watermarking on: the app mints the stamped
file per request, so each Range chunk re-stamps or re-reads a different cache entry.

**Severity.** Blocker for the "sell a 200 MB book/video" case, which is precisely the asset class
gating exists for. Minor for a 300 KB PDF.

**Settling evidence.** A code with `max_uses = 1`: the plain `GET` succeeds and increments; the first
`Range` request that follows must still succeed, because it is the same download — today it is denied.
Three sequential `Range` GETs on one code reproduce it without any client trickery.

**My proposed fix (contract, §3.2 unchanged).** Consume **once per session**; authorise the rest by
the token: decrement only when the request has no `Range` header or `Range` starts at byte 0, and
record `first_byte_at` on the token row. Then `max_uses` means "downloads", which is what the buyer
bought.

### A2 — Data model / export fidelity: `cp site.db` and absolute farm links both produce bundles that pass verification and 404 in production

**Claim attacked.** `IDEA.md` §5: "export has nothing to filter … because the DB is per-tenant", and
§7.3's farm is "regenerated on create/rename/delete". The implicit claim is that export is a copy.

**Failure.** Two independent mechanisms, both measured.
1. `cp site.db` on a live WAL database produced a copy with **1 row of 501**, 8,192 B instead of
   2,056,192 B, and `PRAGMA integrity_check` returned **ok** (T17b). Any exporter that copies the file
   (or tars the directory mid-write) ships a database that opens cleanly and is missing everything
   since the last checkpoint. Nothing in the bundle looks wrong.
2. A farm link written absolute serves 404 inside a container (T11e) while `tar` stores the target
   string verbatim (T11f), so the bundle reproduces our host path on the client's box. Every image on
   every page 404s, and `integrity_check`, the manifest and `docker compose up` all pass.

**Severity.** Blocker, both. These are the two failures that make a paying client's site look broken
on the day we hand it over, and neither is visible to any check we currently have.

**Settling evidence.** (a) Tar the tenant directory while a publish runs, extract, compare
`SELECT count(*)` to the live count — must differ by 0. (b) `find -L bundle -type l` must be empty;
`readlink` on every link must match `^\.\./media/`. (c) Render all pages from the extracted bundle in
a container and assert 0 nginx 404s. I will not accept an export that has not passed (c).

### A3 — Security, operational cost: the admin allowlist and the `__Host-` cookie rule make the sold product unsupportable — and one of them makes login impossible as written

**Claim attacked.** `IDEA.md` D9 (`admin on a separate origin/port with IP allowlist`) and §3.1
("every session cookie must be `__Host-` prefixed and path-scoped").

**Failure.** Two costs, one of them a specification contradiction:
1. **Allowlist.** Every exported CMS bundle ships an admin that only answers to an allowlisted IP. The
   client's staff work from home, from a phone, from a café, behind CGNAT. Each new IP is a support
   ticket to us on a product we sold as self-service, and the client cannot fix it themselves — which
   breaks the platform non-negotiable that a client can run the box "without us on the phone". It also
   fails shut on the demo→sale path: we demo from our office IP, the client installs and immediately
   cannot log in.
2. **`__Host-` + path scoping is impossible.** RFC 6265bis §4.1.3.2 requires a `__Host-` cookie to
   carry `Path=/` and no `Domain`. A `__Host-dl-<key>` cookie with `Path=/d/<key>` is rejected by the
   browser; the download token is never stored and every gated download loops back to the code form.
   The spec (`IDEA.md` §7.4 step 3 and §3.1's cookie consequence) asks for both.

**Severity.** (1) major — an operational cost that lands on every client, forever. (2) blocker for
path-prefix demos with gated downloads if built as written; nil for subdomain demos.

**Settling evidence.** (1) From a second network, `curl -I https://<client-site>/admin` → 403 while the
client is at home; and a count of "add my IP" tickets per client per quarter. (2) A browser test on a
`/demo/<key>/` route: `document.cookie` must not contain the download cookie after the POST; and
`curl -H 'Cookie: …'` will succeed where the browser fails, which is exactly why this survives CI.
**My proposal:** keep the separate port (cheap isolation, it works), replace the static allowlist with
argon2id + per-IP `limit_req` + optional TOTP, and make `SKUNK_ADMIN_ALLOWLIST` an opt-in env var that
defaults to empty in exported bundles and to our office range on our own fleet. Cookie names become
`__Host-skunk-<tenant>-dl` with `Path=/`, and the app binds the token to the tenant.

### A4 — Runtime: one Node process means one tenant's synchronous work is every tenant's latency

**Claim attacked.** `IDEA.md` D5 + §3: request-time SSR of every page of every tenant in a single
process. The paper treats "one process" as a deployment simplification; it is a latency coupling.

**Failure.** Measured (T22): a single 600 ms synchronous block in one request made **20 of 20**
concurrent requests on an unrelated path wait **510–514 ms**; baseline was 0.5 ms median. The block
does not have to be malicious: a 300 KB `JSON.parse` of a Data Source result, a pathological regex in
GrapesJS-normalised HTML, a `pdf-lib` watermark (51.9 ms cold per PDF, and it is synchronous CPU), or
a 40-page stamp on a gated download all live on that loop. On a demo day the prospect's own clicking
is the load.

**Severity.** Major. Not a rewrite, but it must be designed for now: `SKUNK_RENDER_TIMEOUT_MS` alone
cannot fix a blocked loop, because the timeout is also on that loop.

**Settling evidence.** The measurement above, plus a 60 s soak with one tenant at 50 r/s and another
at 1 r/s while asserting p95 on the quiet tenant. **My requirement:** watermarking and any
`function` Data Source run in `worker_threads` (or a child process) with a hard 2 s budget, and the
runtime states a per-page CPU budget it will not exceed. I will not ship a synchronous watermark on
the request path — and `X-Accel-Redirect` offload does not help, because the stamping happens before
the redirect.

### A5 — Runtime/data model: the static SKU silently changes the site it claims to be

**Claim attacked.** §5.1: the static export is "exactly the D5 publish snapshot … reproducible: the
same DB state must produce identical bytes".

**Failure.** Byte-reproducible is not behaviour-reproducible. A Data Source with a parameter
(`/blog?page=2`, `/products?tag=x`) is part of the *request contract*, and a static export freezes it
at default parameters (§5.1 pre-flight 3 acknowledges this and writes a note). The client buys the
cheapest SKU and discovers that page 2 of their blog does not exist, the tag filter 404s, and the
search box posts to nothing. Reproducible bytes, unreproducible site.

**Severity.** Major. It is the SKU most likely to be sold to a client who does not want a CMS, i.e.
the one with no admin to fix it later.

**Settling evidence.** Export a fixture with 50 posts / 10 per page; assert that every URL the CMS
serves with a query parameter has either a static equivalent or an entry in `EXPORT-NOTES.md` naming
it; count the divergences. My position: the pre-flight must **refuse** (code 22) when a parameterised
source backs a route that is linked from any page, rather than freeze it and note it.

---

## 5. Open questions I cannot resolve alone

1. **DNS + ACME time is unmeasured and it is inside the 5-minute promise.** A fresh `A` record plus
   HTTP-01 is 10 s on a good day and "not yet" on a bad one; `acme-companion` retries on a timer. Is
   the promise "install completes" or "site serves HTTPS"? I want the first, with the report printing
   `certificate: pending` and the site serving HTTP until issuance. Needs the Architect's ruling
   because it changes what we sell.
2. **Is the client's box allowed to reach the internet at install time?** If not, every bundle needs
   `docker save` payloads (≈300 MB) and the 5-minute number changes character. Nobody has said.
3. **One process or N.** A4 says one process couples tenants. Do we accept it for v1 with per-tenant
   `limit_req`, or reserve a per-tenant app container for whales? SQLite on a shared volume makes
   replicas cheap for reads and unsafe for writes, so this is a real fork.
4. **Backup retention and offsite.** 14 daily + 8 weekly per tenant on the same disk is not a backup
   against disk loss. Does the commercial model include offsite (S3/B2) or is that the client's job?
5. **`SKUNK_SCHEMA_EDIT` default in exported bundles** (IDEA §11 Q4 leans "off"). If off, the client
   cannot add a table — but our own demos need it on. Confirm the default is `off` and that the UI
   hides the table builder rather than showing a disabled button.
6. **Static SKU: does it ship `sitemap.xml`/`robots.txt` per tenant, and who owns the `404.html`?**
   Small, but it is the difference between a 1-minute install and a support call.
7. **Who deletes a demo when it expires?** TTL auto-expiry is a tenant field (§5), but expiry must
   stop serving *and* free the media bytes, and the second part is a decision about irrevocability.
   Do we soft-delete for 30 days, or is expiry a hard delete with a final backup?

---

## 6. What I measured (command + observed output)

Environment: Docker 29.7.2 (Desktop aarch64), Compose v5.3.1, nginx **1.31.7** from `nginx:alpine`,
`node:22-alpine`, Node 22.23.1 (host), sqlite 3.43.2. Probe stack: `nginx` + a plain-`node:http`
app that emits `X-Accel-Redirect`, run from
`~/.hermes/profiles/ceo/cache/scratch/skunkprobe/`; torn down at the end (`down -v`, no containers or
volumes left).

**T0 — cold install floor.**
```
$ docker rmi node:22-alpine nginx:alpine; docker compose up -d --wait
Image node:22-alpine Pulled … Container skunkprobe-nginx-1 Healthy
up --wait rc=0 elapsed=22.8s
SERVICE   STATUS
app       Up 8 seconds (healthy)
nginx     Up 2 seconds (healthy)
```
Digests used: `nginx@sha256:892bb215…c2d33d`, `node@sha256:0a7108bf…e2bc2e4`.

**T1–T4 — offload semantics.**
```
GET /__protected/sample.pdf            -> status=404 size=153
GET /dl                                -> 200, Content-Length: 100193, bytes_written=100193
   content-type: application/pdf · content-disposition: attachment; filename="Statement Q3.pdf"
   cache-control: private, no-store · Accept-Ranges: bytes  (twice — duplicate add_header)
   x-download-id: evt_123  -> ABSENT from the client response
GET /dl  Range: bytes=1000-1999        -> 206, Content-Length: 1000, Content-Range: bytes 1000-1999/100193
GET /dl-missing (X-Accel to no file)   -> 404 (app's 200 discarded)
```

**T5–T8b — tenancy header.**
```
Host: demo.abc.com                    -> {"tenant_header":"acme","host":"demo.abc.com"}
Host: nobody.example                  -> {"tenant_header":null}
Host: nobody.example + X-…-Tenant: victim  on /      -> {"tenant_header":null}          (blocked)
Host: nobody.example + X-…-Tenant: victim  on /api/  -> {"tenant_header":"victim","host":"app"}   ← spoof
```
`/api/` declares `proxy_set_header X-Real-IP` of its own, which drops the entire server-scope set.

**T9 — body cap.** `POST 2 MiB` and `POST 50 MiB` against `client_max_body_size 1m` →
`413 Request Entity Too Large`, `Connection: close`, curl `exitcode=0` (clean 413, no reset).

**T10 — bandwidth cap.** `limit_rate 1m; limit_rate_after 100k` on 10,485,760 B →
`time=9.051474s speed=1158458B/s`, status 200.

**T11d–T11g — symlink farm.**
```
public/banner-home.bin -> ../media/ab/deadbeef.bin        -> 200, 2048 bytes
public/abs-link.bin    -> /Users/cyberdeth/…/small.bin    -> 404
public/escape.txt      -> /etc/hostname                   -> 200, 13 bytes  (nginx follows links)
tar tzvf: both targets stored verbatim; after extraction elsewhere the relative link resolves
inside the new tree, the absolute one still points at /Users/cyberdeth/…
```

**T13 — health vs readiness.**
```
before: 200 healthz / 200 readyz
after (site.db moved away): 200 healthz / 503 readyz
docker compose ps -> app  Up 15 seconds (healthy)      ← declared healthy with no database
```

**T14–T15 — dead upstream.**
```
defaults:  attempt1 status=504 time=60.001170s · attempt2 status=502 time=1.819220s
           nginx -> (unhealthy) because its own probe proxies to the app
proxy_connect_timeout 2s:  2.006848s · 2.003532s · 2.006967s  (all 504)
```

**T16 — one download, three ranges.**
```
after Range bytes=0-999     -> {"uses":2}
after Range bytes=1000-1999 -> {"uses":3}
after Range bytes=2000-2999 -> {"uses":4}
```

**T17a — `VACUUM INTO` under load** (240 MB DB, 60,000 × 2 KB rows, 400 concurrent inserts):
```
VACUUM INTO rc=0 elapsed=0.73s ; writer errors: 0
integrity(backup): ok ; pages backup=60000 live=60000 ; u_posts backup=60001 live=60400
views survived export: v_public_posts ; sqlite_sequence survived: [('u_tickets', 5)]
VACUUM INTO during a held IMMEDIATE transaction: ok in 0.00s
concurrent INSERT during a held write: ok in 1.45s  (busy_timeout 2000)
```

**T17b — `cp` is not a backup** (WAL, 500 uncheckpointed writes):
```
after 500 writes: main=8192 wal=2068272 rows=501
cp site.db          -> rows in the copy: 1        size 8192      integrity_check: ok
VACUUM INTO         -> rows in the copy: 501      size 2056192   integrity_check: ok
```

**T18 — prefix demo redirect (three configs, same request).**
```
no proxy_redirect              -> Location: /somewhere-else          (browser leaves /demo/acme/)
proxy_redirect default         -> (no Location header at all)        (302 with no target)
proxy_redirect / /demo/acme/   -> Location: http://127.0.0.1/demo/acme/somewhere-else
```

**T19 — Astro SKU install cost** (10 pages, no CMS):
```
cold npm install (fresh cache): 38.5s, 664 tarballs, 233M cache, node_modules 154M
npm ci (warm cache, lockfile): 5.8s
astro build: 1.9s wall ("10 page(s) built in 495ms"), dist 40K
```

**T20 — first boot as non-root on a fresh volume.**
```
docker run -u 10001:10001 -v skunkprobe_vol:/data alpine touch /data/probe
  touch: /data/probe: Permission denied      rc=1
after root chown -R 10001:10001 /data        -> write ok
```

**T21 — idle footprint.** app `10.76MiB`, nginx `2.902MiB`, both `read_only: true` with `tmpfs /tmp`.

**T22 — shared fate.** baseline `/fast` median 0.5 ms; during one 600 ms synchronous block,
20 concurrent `/fast` requests: `min=510 p50=513 p95=513 max=514 ms; over-100ms=20/20`.

**T23 — the PD2 fragment, run before publishing it.** First write of the guard failed to start:
```
$ docker run --rm -v .../nginx.conf:/etc/nginx/nginx.conf:ro nginx:alpine nginx -t
nginx: [emerg] pcre2_compile() failed: missing closing parenthesis in
        "^/__protected/(?<skunk_prot>(?:wm/[0-9a-f]"  in /etc/nginx/nginx.conf:52
```
An unquoted `{64}` quantifier ends the token — nginx splits config on `{`. Quoting the regex fixes
it. Final form (negative lookahead guard + prefix alias), validated:
```
nginx -t                       -> test is successful
64-hex name via X-Accel        -> 200 bytes=100193   (Content-Disposition + Cache-Control survive)
64-hex name via Range          -> 206 bytes=1000
direct hit on the 64-hex name  -> 404      (internal)
non-hex name via X-Accel       -> 404      (guard)
```
Second observation from the same run: `add_header Cache-Control` inside the internal location made
`Cache-Control` appear **twice** (app's + nginx's), the same duplication class as `Accept-Ranges` in
T2. The internal location must add neither.

**T24 — the PD5 demo block, validated end to end.**
```
nginx -t                      -> test is successful, no warnings
                                 (needs proxy_headers_hash_max_size 2048; proxy_headers_hash_bucket_size 128;)
GET /demo/acme/whoami         -> {"path":"/whoami","tenant_header":"acme"}
GET /demo/beta/whoami?x=1     -> {"path":"/whoami?x=1","tenant_header":"beta"}
GET /demo/zzz/whoami          -> 200, tenant_header:"zzz"   ← edge checks shape only; app must 404
GET /demo/acme                -> 301, Location: http://127.0.0.1/demo/acme/
GET /demo/acme/redir2         -> Location: http://127.0.0.1/demo/acme/somewhere-else
GET /dup/whoami               -> tenant_header:"acme", x_real_ip:null
   (two proxy_set_header for the same name: last wins; and the location inherits nothing else)
```
Two failed attempts on the way, both worth knowing:
```
unquoted map regex      -> nginx: [emerg] unexpected "{" in /etc/nginx/nginx.conf:20
if ($uri !~ "/$") ...   -> every /demo/... request 301'd, query string included (abandoned for a
                           dedicated regex location that matches only the slash-less form)
```

**Not measured, and therefore not claimed:** ACME issuance and DNS propagation time (no domain
available), real browser cookie-prefix rejection (A3 cites RFC 6265bis, does not measure a browser),
Linux bind-mount ownership (Docker Desktop virtualises it — T20 uses a named volume instead), and
throughput of a real Astro SSR page under concurrency.
