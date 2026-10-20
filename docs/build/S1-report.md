# S1 — Hosting core: build report

Slice: **S1** (SDS §16). Status: **9 of 9 acceptance criteria green**, `make test` exit 0.
Tree is dirty by instruction; nothing is committed.

Environment: macOS 15.7.4, Node v22.23.1, Docker 29.7.2 (daemon present), nginx 1.31.7 (in
`nginx:1.31-alpine`), SQLite via `better-sqlite3` 13.0.3.

---

## 1. What was built

Every path below exists in the working tree. Paths marked *(not in §3)* are additions this slice
needed and are called out with their reason.

```
docker-compose.yml            4 services; app publishes no port (§12.1)
Dockerfile.app                multi-stage, node:22-bookworm-slim, uid 10001, UV_THREADPOOL_SIZE=8
.env.example                  the 22 SKW_ names (§4.3) plus UV_THREADPOOL_SIZE and ACME_EMAIL
package.json                  build / test / typecheck / migrate / start
tsconfig.json                 strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes
tsconfig.test.json            *(not in §3)* typecheck-only config so tests are type-checked without
                              being emitted into dist/
astro.config.mjs              *(not in §3)* Astro in middleware mode, srcDir app/render,
                              outDir build/astro
Makefile                      verify-s1 / build / typecheck added; verify now includes verify-s1

snippets/skunk-proxy.conf     the one include; X-Skunkworks-Tenant "" on every host-routed location
nginx/nginx.conf              includes conf.d; gzip; client_max_body_size 16m
nginx/conf.d/00-default.conf  404 from location /, never from server scope
nginx/conf.d/10-app.conf      generated sample (drift-gated by test/nginx-config.test.ts)
nginx/templates/server.tmpl   the generator's shape
tools/nginx_gen.ts            control.db hosts -> map, per-tenant blocks, demos vhost, admin vhost

app/main.ts                   boot order §2.3 steps 1-5 (+ step 6 explicitly deferred), Fastify,
                              Astro middleware mount via reply.hijack()
app/env.ts                    SKW_ parse, ^SK_|^SKUNK_ refusal, argon2/threadpool asserts
app/env-deleted.ts            deleted name -> replacement, for the refusal message
app/errors.ts                 AppError, HTTP + Retry-After map, {error:{code,message?,requestId}}
app/tenancy/resolve.ts        the 10 steps, in order, plus peerInCidrs()
app/tenancy/normalise-host.ts lowercase -> strip :port -> strip dot -> domainToASCII -> [a-z0-9.-]
app/tenancy/resolve-admin.ts  resolveAdminTenant(session) — session.tenant_id only
app/tenancy/cache.ts          TenantMap, MAX(control_migration.id)||count version stamp
app/db/classes.ts             render-read | admin-write | exporter, assertClass, RenderPool LRU
app/db/migrate.ts             control.db gate (exit 15), per-tenant fan-out, v1->v2->v3 chain
app/db/snapshot.ts            exportSnapshot(), the only exporter entry point
app/render/page.ts            path -> cms_page; render-read only
app/render/components/shells/page.astro   the shell
app/render/pages/[...path].astro          *(not in §3)* the SSR entry the Fastify mount renders
app/render/pages/index.astro              *(not in §3)* '/'
app/render/public/                        Astro's publicDir (empty)

test/tenancy/resolve.test.ts      16 tests (10 steps + 5 inert + CIDR)
test/integration/three-hosts.test.ts
test/prefix-demo.test.ts          app-boundary prefix contract (edge emulated)
test/nginx-e2e.test.ts            the same contract through a real nginx container
test/admin-listener.test.ts
test/migrate.test.ts
test/env.test.ts
test/compose.test.ts
test/nginx-config.test.ts
test/error-codes.test.ts          *(not in §3)* keeps app/errors.ts equal to schema/error-codes.json
test/helpers/{fixture,http,edge}.ts
```

`app/render/pages/*` is not in §3 because §3 lists no Astro route: the editor (§10) was assumed to own
page bodies. An Astro app in middleware mode still needs at least one route to render, so there is one
catch-all route and one root route, both of which render the shell with a page the app already loaded.

---

## 2. Acceptance criteria

### 2.1 `GET /pricing` on a mapped host renders that tenant's page (3 hosts)

```
$ node --test test/integration/three-hosts.test.ts
ok 1 - acme.test renders Acme's /pricing from its own site.db
ok 2 - www.acme.test (an alias) renders the same tenant
ok 3 - beta.test renders Beta's /pricing, not Acme's
ok 4 - an unmapped Host is 404 SKW_E_PLT_TENANT_UNKNOWN, with no default tenant
ok 5 - a path with no cms_page row is 404 and never falls through to another tenant
ok 6 - the page response is no-store (v1 has no CDN, §5.5)
ok 7 - /healthz reports SKW_BUILD_ID and touches nothing (§9.5)
# tests 7
# pass 7
# fail 0
```

Three real `site.db` files built from `schema/site.sql`, three `Host` headers, one process, one Astro
mount. `beta.test` asserts `doesNotMatch(/Acme pricing/)`, so a cross-tenant read fails the gate.

Proven again through a real nginx — `test/nginx-e2e.test.ts`, test 4: `acme.test` → `Acme pricing`,
`beta.test` → `Beta pricing`.

The built artefact also serves, not just the TS source (`node dist/app/main.js`, `PORT=3999`):

```
STATUS 200 acme-rendered true
STATUS 200 beta-rendered true
BROKEN 503 {"error":{"code":"SKW_E_PLT_TENANT_UNAVAILABLE","requestId":"330d8083-…"}}
```

### 2.2 The 10 resolution steps produce the 10 documented outcomes

```
$ node --test test/tenancy/resolve.test.ts
  step 1 — an untrusted peer that asserts any X-Skunkworks-* header is 421
  step 2 — a non-empty tenant header without the edge token is 421
  step 3 — a tenant header that is not a tenant key is 400
  step 4 — a tenant header that disagrees with X-Forwarded-Prefix is 400
  step 5 — a valid header from the edge selects that tenant (via header)
  step 6 — no header on the public listener resolves from the normalised Host
  step 7 — no header on the admin listener resolves from session.tenant_id only
  step 8 — the admin listener refuses a tenant header that is present at all
  step 9 — a resolved tenant that is suspended or archived is 404
  step 10 — a resolved tenant whose database is unusable is 503, one code per cause
# tests 16
# pass 16
# fail 0
```

Each case asserts the **step number the resolver reports**, not only the status: a right status from
the wrong step is a defect. Step 10 asserts three distinct codes (`SCHEMA_STALE` + `Retry-After: 5`,
`TENANT_UNAVAILABLE`, `DM_BUSY` + `Retry-After: 1`).

One ordering change is load-bearing and is recorded as a defect in §5.1 below: **step 8 is evaluated
before steps 5 and 7**, because as written it is unreachable.

### 2.3 A client-supplied `X-Skunkworks-Tenant` is inert on a host-routed location (cases 1-5)

```
  inert 1 — a client header with no edge token is refused, not honoured
  inert 2 — a client header with a guessed edge token is refused, not honoured
  inert 3 — an empty header is no assertion: the Host decides
  inert 4 — a malformed claim is a 400, never a silent fallback
  inert 5 — a valid claim with a valid token still cannot cross a prefix mismatch
```

Every case sends `Host: acme.test` (→ acme) with a header claiming `beta`; none resolves to beta and
none resolves `via: 'header'`.

The edge half is measured on a real nginx (`test/nginx-e2e.test.ts`, test 5): a client sends
`X-Skunkworks-Tenant: beta` to `acme.test`, the snippet overwrites it with `""`, and the response is
`Acme pricing`, not `Beta pricing`.

### 2.4 `/demo/<key>/whoami` — path, tenant header, query, slash-less 301, POST with a body

Through a real `nginx:1.31-alpine` running the generated config and the rendered snippet:

```
$ node --test test/nginx-e2e.test.ts
ok 1 - through real nginx: GET /demo/acme/whoami strips to /whoami and keeps the query
ok 2 - through real nginx: POST /demo/acme/whoami delivers its body
ok 3 - through real nginx: /demo/beta 301s to /demo/beta/ and keeps the query
ok 4 - through real nginx: a host-routed page renders the right tenant
ok 5 - through real nginx: a client-supplied tenant header is stripped by the snippet
ok 6 - through real nginx: an unknown demo key is 404, not a rendered page
# tests 6
# pass 6
# fail 0
```

What nginx actually forwarded, captured from an echo server with the same config (kept here as the
evidence that the strip and the two overrides are real, not asserted):

```
peer=::ffff:127.0.0.1 family=IPv6 GET /whoami?x=1&y=two
{
 "host": "demos.skw.test",
 "x-forwarded-proto": "http",
 "x-forwarded-host": "demos.skw.test",
 "x-skunkworks-edge": "test-edge-token-0123456789abcdef",
 "x-skunkworks-tenant": "acme",
 "x-forwarded-prefix": "/demo/acme"
}
```

The app-level twin (`test/prefix-demo.test.ts`, 6 tests) replays the same two nginx rules so the
contract is still gated on a box without Docker.

The slash-less form is a 301 whose `Location` is absolute (`http://demos.skw.test/demo/beta/?x=1`)
because nginx defaults to `absolute_redirect on`; the path and query are what the test fixes.

### 2.5 A demo `Host` gets 421 from the admin listener

```
$ node --test test/admin-listener.test.ts
ok 1 - a demo Host is 421 on the admin listener
ok 2 - a demo Host is 421 even with a valid tenant header
ok 3 - the admin listener refuses a tenant header that is present at all
ok 4 - the admin listener ignores Host for tenant resolution (no session -> 404, not acme)
ok 5 - the public listener is not the admin listener
# tests 5
# pass 5
# fail 0
```

Honest scope note: this is proven at the app boundary. Through the real nginx the `demos.<domain>`
vhost has no `/admin/` location at all, so nginx answers 404 before the app is reached; C-25's 421 is
the second line of defence for a misroute or a direct connection. Both behaviours are correct; the 421
is what is gated here, and §5.6's `demos.<domain>` vhost shape is pinned by the generated config.

### 2.6 `docker compose config`: exactly 4 services, `app` publishes no port

```
$ docker compose --env-file .env.example config --services
app
nginx
plugin-runner
acme

$ docker compose --env-file .env.example config --format json | … 
services: ['acme', 'app', 'nginx', 'plugin-runner']
app.ports: <none>
app.expose: ['3000']
runner.network_mode: none

$ node --test test/compose.test.ts
# tests 8
# pass 8
# fail 0
```

The suite also asserts: `nginx` is the only service with published ports (**80** and **443**),
`plugin-runner` has `network_mode: none`, `cap_drop: [ALL]`, `pids_limit: 64`, `app` is
`read_only: true` with a `/tmp` tmpfs and exactly three volumes, `app`'s environment carries
`UV_THREADPOOL_SIZE=8` and **no** `^SK_|^SKUNK_` name, and there is no `migrate` service.

### 2.7 `migrate` exits 0 with a per-tenant report; one corrupt tenant 503s alone

Real CLI run against a fixture where acme/beta/demo-acme have no `site.db` at all and `broken` holds
garbage:

```
$ node app/db/migrate.ts --tenant all --data-dir <fixture>
EXIT 0
{
  "ok": true,
  "control": { "path": "control.db", "from": 2, "to": 2, "action": "skipped", "ok": true },
  "tenants": [
    { "key": "acme",      "from": 0, "to": 3, "action": "created", "ok": true },
    { "key": "beta",      "from": 0, "to": 3, "action": "created", "ok": true },
    { "key": "broken",    "from": 0, "to": 3, "action": "failed",  "ok": false, "error": "SQLITE_NOTADB" },
    { "key": "demo-acme", "from": 0, "to": 3, "action": "created", "ok": true }
  ],
  "migrated": ["acme", "beta", "demo-acme"],
  "failed": [{ "key": "broken", "error": "SQLITE_NOTADB" }]
}
```

```
$ node --test test/migrate.test.ts
ok 1 - migrate creates every missing site.db from site.sql and reports per tenant, exit 0
ok 2 - control.db is created when absent, and a second run is a no-op
ok 3 - a v1 site.db is migrated through the frozen chain to v3
ok 4 - a control.db that cannot be migrated exits 15 and names the migration
ok 5 - the app refuses to boot on a control.db it cannot migrate, exit 15
ok 6 - one corrupt tenant 503s alone; the other three serve
# tests 6
# pass 6
# fail 0
```

Test 3 is stronger than a version check: after `v1-baseline.sql → r2 → r3` it compares
`sqlite_master` (type, name) against a database built directly from `schema/site.sql` and requires
them **identical** (53 objects). Test 6 asserts `broken.test` → 503 and `acme.test`/`beta.test` → 200 in
the same process.

### 2.8 Boot refuses any `^SK_|^SKUNK_` env key, naming it

```
$ SKUNK_EDGE_TOKEN=legacy SK_DDL_MAX_STATEMENTS=8 node app/main.ts
EXIT 1
STDERR:
refusing to start: deleted environment prefix in use (^SK_|^SKUNK_)
SKUNK_EDGE_TOKEN -> SKW_EDGE_TOKEN
SK_DDL_MAX_STATEMENTS -> SKW_DDL_MAX_STATEMENTS
STDOUT: ""
```

```
$ node --test test/env.test.ts
# tests 8
# pass 8
# fail 0
```

The suite also asserts: the replacement is named for every offender, the list is sorted, a missing
required key is named, `UV_THREADPOOL_SIZE` must be 8, `SKW_ARGON2_MAX_CONCURRENT` must be 4, and the
real process exits before it ever prints "listening".

### 2.9 `make test` stays green

```
$ make test
…
PASS the SDS quotes the register
…
# tests 75
# pass 75
# fail 0
EXIT=0
```

29 `PASS` verdict lines: 4 pre-existing gates (gitignore, schema, claims 27/27, frozen contracts) and
the 9 new S1 suites. `verify-s1` runs `npm run build` (tsc + `astro build`) and `typecheck`
(`tsconfig.json` + `tsconfig.test.json`) before `node --test`, so the Astro asset under test is always
the one just built.

One environment fix was needed to make this green at all: `verify-claims` check 7 *skips* without
`@node-rs/argon2`, and `verify_claims.py` exits 2 on a skip. `@node-rs/argon2` is now a
devDependency, so the check runs instead of skipping (27/27). Nothing in the measurement was changed.

---

## 3. Criteria I could not prove, and why

| Not proven | Why |
|---|---|
| `plugin.sock` bind + one permission child per package (§2.3 step 6) | §16 puts plugin install/enable/RPC in **S4**. `app` logs `plugin.sock: not bound (S4 owns the plugin runner…)` at boot. The boot order is implemented 1-5 and stops there deliberately. |
| Certificate issuance, `certificate: pending` (§12.5) | The `acme` service is wired in compose (image, certs volume, docker socket ro, `DEFAULT_EMAIL`), but issuance is `install.sh`'s job and §16 puts `install.sh` in S4. No ACME challenge path exists yet. |
| Admin session resolution end-to-end (§5.3 step 7, §9.2) | Auth is S2. The resolver implements step 7 and is unit-tested with an injected session; `main.ts` passes `session: null`, so `/admin/…` answers 404 today. |
| `/media/` and `/__protected/` byte serving (§12.3) | nginx has both locations in the generated config; there is no byte tree yet (§16 S3). Nothing serves or asserts bytes. |
| A running compose stack | The gate is `docker compose config`, as §16 S1 specifies. Two services reference digest-pinned images that do not exist yet (`ghcr.io/skunkworks/app`, `…/runner`), so `up` is not a meaningful test in S1. |
| `SKW_BOX_RPS`-derived rate against a real box | The formula `min(20, floor(SKW_BOX_RPS / hot_tenants))` is implemented and unit-tested (3 tenants → 20 r/s burst 40; 50 → 3 r/s burst 6). The 192 r/s figure is the register's measurement, not re-measured here. |

---

## 4. Verified defects in the frozen artefacts

These were found by running the real thing, not by reading it. Each has a gate that would fail if the
workaround were reverted.

1. **`schema/r3-amendments.sql` does not apply on a modern SQLite** (§4.5, C-6).
   `A1` does `DROP TABLE cms_download_code` while `trg_cms_asset_delete_guard` still names it, then
   `ALTER TABLE cms_download_code_r3 RENAME TO cms_download_code`. SQLite ≥ 3.25 re-parses every
   trigger on that rename and fails:
   `SQLITE_ERROR error in trigger trg_cms_asset_delete_guard: no such table: main.cms_download_code`.
   SQLite 3.43 tolerated it; `better-sqlite3` and `python3` with SQLite ≥ 3.50 do not. `migrate`
   therefore sets `PRAGMA legacy_alter_table = ON` on the migration connection — the rename semantics
   the file was written for. `test/migrate.test.ts` proves the chain still **converges exactly** on
   `schema/site.sql` (53/53 objects), so the workaround does not change the outcome. The frozen file
   was not edited.

   The repo's own gate had the same bug and it only showed up when a different `python3` was first on
   PATH: `scripts/model/verify_claims.py` applied the chain with a bare `executescript`, so checks
   20/22/26 failed on SQLite 3.53 (Homebrew python) and passed on SQLite 3.43 (Apple python). Fixed by
   applying the same pragma in one `apply_chain()` helper; no assertion or measurement was changed —
   the convergence comparison is identical, and 27/27 still pass on the 3.43 interpreter.

2. **§12.3's demo `location` regex does not load in nginx.** As written,
   `location ~ ^/demo/(?<demo_key>[a-z0-9][a-z0-9-]{0,31})(/.*)?$` fails at startup:
   `pcre2_compile() failed: missing closing parenthesis in "^/demo/(?<demo_key>[a-z0-9][a-z0-9-]"`.
   nginx's config tokenizer treats the unquoted `{` of `{0,31}` as a block delimiter. The generator
   quotes the regex; the e2e suite loads the config in `nginx:1.31-alpine` and would fail otherwise.

3. **`demos.<domain>` must not also be a `domain` row.** §5.6 says demos live at
   `demos.<our-domain>/demo/<key>/`, and `domain.kind` includes `'demo-path'`, which reads as an
   invitation to insert one. Doing so emits a per-tenant `server` block whose `server_name` is the same
   as the demos vhost; nginx keeps the first and logs
   `conflicting server name "demos.skw.test" … ignored`, silently disabling the `/demo/` rewrite
   (measured: every demo URL then 404s). `generateAppConf` now refuses the collision by name, with a
   test.

4. **§5.2's snippet placeholder appears in a comment as well as on the directive.** `install.sh`
   (S4) must substitute **all** occurrences; a single `String.replace` renders the comment and leaves
   `X-Skunkworks-Edge "__SKW_EDGE_TOKEN__"` in place, which surfaces as a 421 on every demo request.
   Hit here while writing the e2e harness; the comment was reworded so the placeholder occurs once,
   and the harness asserts no placeholder survives.

---

## 5. SDS defects and ambiguities

Numbered against the SDS; none was silently resolved — each has the implementation choice stated.

### 5.1 §5.3 steps 5, 7, 8 are not jointly satisfiable as ordered

The table orders step 5 (valid header → `via='header'`) before step 8 (admin + header present → 421),
so any valid header is consumed by 5 and step 8 can never fire; step 7's "`hdr` absent or `""`" branch
also contradicts §9.2's "present at all". Implemented as: steps 1-4 in numeric order, then **step 8
before 5 and 7** (so an empty header on the admin listener is also 421, per §9.2 and C-25), then 5, 6,
7, 9, 10. The unit test asserts `step === 8` for both the non-empty and the empty case.

### 5.2 §5.3 has no mechanism for "listener is admin"

§9.1 removes the port ("the admin surface is a hostname … cookies ignore ports") and nginx sets only
`Host`, so one process on one port has no way to know which vhost a request came from. Implemented as:
`listener === 'admin'` when the path is `/admin` or starts with `/admin/` (§9.2: "Every admin URL is
`/admin/t/<key>/…`"), or when `Host` equals the host of `SKW_ADMIN_ORIGIN`. The path rule is what makes
C-25's rule reachable: a demo-origin page calling `fetch('/admin/pages')` is exactly a demo `Host` on an
`/admin/` path.

### 5.3 §16 S1 requires a slash-less 301 that §12.3 does not produce

The gate says "slash-less form 301s", and C-2 records Platform's measurement, but the config in §12.3
has no rule for it: `location ~ ^/demo/(?<key>[a-z0-9][a-z0-9-]{0,31})(/.*)?$` matches `/demo/acme`, the
`rewrite` requires a trailing slash and does not fire, so the app would receive `/demo/acme` and 404.
The generator emits an explicit
`location ~ "^/demo/(?<demo_key>…)$" { return 301 /demo/$demo_key/$is_args$args; }` before the proxy
location. Not in the SDS; needs a line in §12.3.

### 5.4 §4.3 has no error code for "page not found in a resolved tenant", nor for an unhandled 500

Every response body must carry a code from the 67-code taxonomy, and the only 404 code is
`SKW_E_PLT_TENANT_UNKNOWN`, which means "no tenant". A resolved tenant with no `cms_page` row
therefore answers `404 SKW_E_PLT_TENANT_UNKNOWN`; an unexpected exception answers
`500 SKW_E_PLT_TENANT_UNAVAILABLE` (the only PLT 5xx available) rather than inventing a code. Both are
wrong-ish in the same way and both need a code (`RT_PAGE_NOT_FOUND`, `PLT_INTERNAL`).

### 5.5 §5.4's version stamp cannot see an update

`MAX(control_migration.id) || tenant count` does not change when `tenant.status` flips to `suspended`,
when a `domain` row is deleted, or when `tenant.db_version` is raised. A suspended tenant keeps serving
until the process restarts or an unrelated migration row appears. Implemented exactly as specified; the
security-relevant half of this (C-25, C-11) deserves a `tenant.updated_at` or a `PRAGMA data_version`
comparison in §5.4.

### 5.6 §2.3 step 2 asserts `UV_THREADPOOL_SIZE` at boot, which cannot change the pool

libuv sizes the thread pool when the process starts; reading `process.env` in `loadEnv()` can only
confirm that the image set it, and an operator who exports it after launch gets a passing assertion and
a 4-thread pool. Implemented as a hard boot refusal when it is not `8` (it defaults to absent, so the
refusal fires on a bare shell), and it is set in `.env.example`, compose and `Dockerfile.app` where it
actually takes effect. §2.3 should say "the image sets" rather than "the process asserts".

### 5.7 "one block per host" (§2.3, §3) versus `server_name acme.com www.acme.com;` (§12.3)

The prose says one server block per host; the sample groups a tenant's hosts into one block, and the
`map` is what carries host → tenant. Implemented per the sample (one block per tenant, all hosts on
`server_name`), because that is the part that compiles.

### 5.8 §16 S1 says "the boot order of §2.3" but §2.3's step 6 is S4 work

Step 6 (bind `run/plugin.sock`, one child per enabled package) is the plugin runner, which §16 assigns
to S4 and C-8 makes a separate container. Implemented steps 1-5 and a logged, explicit skip for step 6.

### 5.9 The verification gate has undeclared interpreter prerequisites

`make verify-claims` needs a `python3` that has `argon2-cffi` (checks 17 and 21 **skip** without it,
and `verify_claims.py` exits 2 on any skip) and, before the fix in §4.1, one whose SQLite applies the
frozen amendment chain as written. Neither is stated anywhere, so `make test` was green or red
depending on which `python3` PATH resolved — measured here: Apple `/usr/bin/python3` 3.9.6/SQLite
3.43.2 → 27/27; Homebrew `python3` 3.14.6/SQLite 3.53.4 → 18/27 before the fix, 25/27 (2 skips) after
it. The Makefile now pins `PYTHON ?= /usr/bin/python3` (overridable) with a comment naming the
dependency; the durable fix is to take argon2 from `@node-rs/argon2`, which `package.json` already
guarantees, instead of from pip.

### 5.10 Minor: §3 lists `Dockerfile.runner`, `runner/` and `plugins/` as files "a Builder creates"

They belong to S4's plugin work. `Dockerfile.app` exists and is complete; the runner image is
referenced by digest only, as §12.1 does. No stub was created for a file that would not build.

---

## 6. How to run it

```
make test          # everything: the 4 pre-existing gates + 9 S1 suites (75 tests)
make PYTHON=python3 test             # same, with whatever python3 is on PATH (see §5.9)
make verify-s1     # build + typecheck + the 9 S1 suites only
make build         # tsc -> dist/, astro -> build/astro/
make migrate       # node dist/app/db/migrate.js --tenant all   (needs SKW_DATA_DIR)
SKW_SKIP_DOCKER=1 make verify-s1   # skip test/nginx-e2e.test.ts on a box with no daemon
```

`make verify-s1` needs `docker` (for `docker compose config` and the nginx e2e), Node 22, and the
`node_modules` installed by `npm install`. The model gates need a `python3` with `argon2-cffi`.

Last recorded full run: `hermes verify --json` → `ok: true`, phases bootstrap/build/typecheck/
`npm run test`/`make test`/`make typecheck`/`make build` all exit 0.

---

## 7. What S2 should build first

**Admin auth + session, because step 7 is the only resolution path with no source of truth yet.** The
resolver, `resolveAdminTenant`, the listener split and the 421 rules are all in place and tested, but
`main.ts` passes `session: null`, so every `/admin/…` request is a 404. The first S2 commit should be
`app/admin/session.ts` + `auth.ts` (argon2id, `__Host-sk-sess`, rotation, CSRF) so that
`session.tenant_id` exists and the admin listener becomes real; then the `render-read` connection class
is already there for the first CRUD read, and the CSRF matrix (§16 S2, 12 cases) can be written against
a route that actually resolves a tenant.

---

## 8. S1 rework against errata 02

**Date:** 2026-10-20. **Scope:** `docs/sds/02-errata.md` E-1 … E-15, in the order §4 of that file
prescribes. **Tree:** dirty, uncommitted. Every rewired gate was shown to go red with the behaviour
broken and green after restore, by hash — QA's method, applied to the gates that were **changed**, not
only the ones that were added.

### 8.1 The fifteen items

| # | Item | What changed (files) | Gate that proves it | Red → green |
|---|---|---|---|---|
| 1 | **E-4** four codes, one decision per response | `schema/error-codes.json` (71 codes: RT gains `PAGE_NOT_FOUND`, PLT gains `INTERNAL`, `REQUEST_INVALID`, `BODY_TOO_LARGE`); `app/errors.ts` (`HTTP`, `frameworkCode`); `app/main.ts` (`sendError` maps a framework failure by status class, sends that code's status, and sets `no-store` on every taxonomy body); `app/render/page.ts` (`pageMiss` → `SKW_E_RT_PAGE_NOT_FOUND`) | `test/error-codes.test.ts` (app map == JSON; 71 codes; no `retry_after` on the four) + `test/integration/three-hosts.test.ts` (400 `REQUEST_INVALID`, 413 `BODY_TOO_LARGE`, 500 `INTERNAL` with `requestId`, page miss `RT_PAGE_NOT_FOUND` + `no-store`) | 8.2.1, 8.2.16 |
| 2 | **E-2** the listener is the admin host; no admin surface on any tenant host | `app/main.ts` (`listenerFor(host, adminHost)` — the path branch is gone; §9.1 rule 2 for paths outside `/admin…`; the demo-mode 421 guard removed because `mode` no longer gates the listener); `app/tenancy/resolve.ts` (row 1); `tools/nginx_gen.ts` (reserved-host refusal kept) | rewritten `test/admin-listener.test.ts` (a)–(e) + `test/nginx-config.test.ts` (generator refusal by name) | 8.2.2, 8.2.15 |
| 3 | **E-1** resolution rows 1–10 as tabled | `app/tenancy/resolve.ts` (row 1 first, so rows 3–6 run only on a public listener; row 6 prefix defaults to `""`; row 7 session; row 8 host; the old step-8 branch deleted) | `test/tenancy/resolve.test.ts` — 10 row cases asserting **the row number**, plus E-1 (a) and (c); `test/nginx-e2e.test.ts` for the empty-header-through-the-edge case (E-1 b) | 8.2.3 |
| 4 | **E-11** the prefix is cleared at the edge and set only by the two overrides | `snippets/skunk-proxy.conf` (one added `proxy_set_header X-Forwarded-Prefix "";`); `app/tenancy/resolve.ts` (`prefix` is `string`, `""` on `via='host'` and `'session'`) | `test/nginx-e2e.test.ts` (client prefix inert through real nginx), `test/prefix-demo.test.ts` (the app-level twin) | 8.2.4 |
| 5 | **E-3** revision counter, six triggers, new stamp, mid-request rule | `scripts/model/gen_schema.py` (`CONTROL_VERSION=3`, `control_revision` in the spec, six triggers emitted); `schema/control.sql` (regenerated); `schema/control-r3.sql` (new, hand-written); `app/tenancy/cache.ts` (`stamp()` = `rev:user_version`, one prepared SEARCH + one pragma, immutable generation, `stats.stampReads`/`rebuilds`); `app/db/migrate.ts` (control v2→v3) | new `test/tenancy/cache.test.ts` (the QA §3.6 matrix applied over a **second connection**, one stamp read per request, one rebuild per bump) + `test/migrate.test.ts` (control v2→v3, one revision row, six triggers) | 8.2.5 |
| 6 | **E-6** r3's trigger drops before the `DROP TABLE`; the pragma is gone everywhere | `schema/r3-amendments.sql` (A1 drops `trg_cms_asset_delete_guard` and `trg_cms_download_code_hash_immutable` before `DROP TABLE cms_download_code`); `app/db/migrate.ts` (both pragmas deleted); `scripts/model/verify_claims.py` (`apply_chain` no longer sets it) | `test/migrate.test.ts` (chain applies with the pragma unset; a source assertion that the string appears nowhere in `migrate.ts` or `verify_claims.py`) + `verify_claims.py` check 20 on SQLite 3.53.4 | 8.2.6 |
| 7 | **E-14** convergence compares CHECKs and trigger bodies | `scripts/model/verify_claims.py` (`canon_table`, `canon_trigger`, `plane_shape`, `compare_planes`; both planes, both directions); `test/helpers/schema.ts` (the same comparison in TS); `test/migrate.test.ts` (uses it and names the object) | check 20 + `test/migrate.test.ts` + the negative control (one CHECK removed in a scratch copy → red naming `cms_download_code`) | 8.2.7 |
| 8 | **E-5** the §12.3 config: quoted regexes, 40-char key, slash-less 301, demos vhost, `listen 80`, 443 only when issued | `tools/nginx_gen.ts` (`DEMO_KEY` constant, `listen 80; listen 443 ssl;` per block, 443 only for `cert_state='issued'`, demos `location / { return 404; }`); `nginx/templates/server.tmpl`; `nginx/conf.d/10-app.conf` (regenerated); new `tools/regen_conf.ts` | `test/nginx-config.test.ts` (drift, every regex quoted, pending cert = 80 only) + `test/nginx-e2e.test.ts` (`/demo/beta` → 301; a 40-char key reaches the app as JSON) | 8.2.8 |
| 9 | **E-12** onboarding order, gated including the negative | new `test/onboarding.test.ts` (real nginx, the generator CLI, `nginx -t`, `nginx -s reload`); no production file changed | 404 at the edge **before** the reload, 200 after, body from the right tenant | 8.2.9 |
| 10 | **E-13** the always-JSON sentence scoped; the four exceptions asserted | `app/errors.ts` (docstring); `app/main.ts` (16 MiB body limit already present; the framework mapping from E-4); SDS §4.3 | `test/nginx-e2e.test.ts` (17 MiB through the edge → 413 `text/html`, no taxonomy code; 16 MiB passes) + `test/integration/three-hosts.test.ts` (no-`Host` 400 names no tenant; 17 MiB direct → 413 `BODY_TOO_LARGE`) | 8.2.10 |
| 11 | **E-7** `Retry-After` on the wire | `app/main.ts` already emitted it; the **gate** is new | `test/tenancy/resolve.test.ts` — a table over `schema/error-codes.json`'s `retry_after` map (all three on the wire with the JSON's value) plus absence for four codes without an entry. `SQLITE_BUSY` is a real exclusive lock on a rollback-journal file, not a mock | 8.2.11 |
| 12 | **E-8** the env gate cannot hang | `test/env.test.ts` (5 s `spawnSync` + `SIGKILL`, `ETIMEDOUT` named failure, a free port so the child would boot, and a control that proves the timeout path itself); `Makefile` (`--test-timeout=15000`) | `test/env.test.ts` | 8.2.12 |
| 13 | **E-9** §2.3 step 2 and the refusal message | `app/env.ts` (the message names the variable and "fixed at process start"); SDS §2.3 step 2 rewritten | `test/env.test.ts` asserts both halves of the message | 8.2.13 |
| 14 | **E-15** declared interpreter, preflight, two runs, skip-is-failure | `Makefile` (`verify-toolchain`, `verify-claims-modern`, corrected comment, `--test-timeout`); `scripts/model/verify_claims.py` (`--allow-skip` is the only way a skip passes); `.github/workflows/gate.yml` (new) | `make verify-toolchain`; `make test` on `/usr/bin/python3` **and** on SQLite 3.53.4 | 8.2.14 |
| 15 | **E-10** slice marking, then every drop-in pasted into the SDS | `docs/sds/SDS.md` (§2.3, §3, §4.3, §4.5, §4.6, §5.2, §5.3, §5.4, §5.4a, §5.5, §5.6, §9.1, §12.3, §16, §17.1 — each with its `> Amended by 02-errata.md E-n.` line); `scripts/model/check_frozen.py` (two **named** supersession entries) | `make verify-frozen` + `make test` | 8.2.15 |

No item was skipped. Two items gained work the errata does not name but its own gates demanded — see
8.4 items 3 and 8.

### 8.2 Red-then-green evidence

Method, identical for every control: copy the file, `shasum -a 256` it, mutate the **behaviour** (never
the test), run the named gate, restore from the copy, re-hash, run again. No file was left modified;
each `restored_sha` below is the post-restore hash prefix.

#### 8.2.1 E-4 — a code the app raises is missing from its map, and the old catch-all restored

```
$ node --test --test-timeout=15000 test/error-codes.test.ts
not ok 4 - the codes S1 raises are all mapped, and the four E-4 additions are part of the taxonomy
# fail 1
# red rc=1   (files restored: 868a3181552a)

$ node --test --test-timeout=15000 test/error-codes.test.ts        # after restore
# skipped 0
# todo 0
# duration_ms 80.628834
# green rc=0 ok=True
```

The old catch-all, restored verbatim (QA's M2), takes all three new cases red at once:

```
$ node --test --test-timeout=15000 test/integration/three-hosts.test.ts
not ok 6 - a malformed JSON body is 400 SKW_E_PLT_REQUEST_INVALID, not a borrowed 503 (§4.3 E-4)
not ok 7 - a 17 MiB body direct to the app is 413 SKW_E_PLT_BODY_TOO_LARGE (§4.3 E-4)
not ok 8 - a route that throws is 500 SKW_E_PLT_INTERNAL with a requestId and no stack, path or SQL (§4.3 E-4)
# fail 3
# red rc=1   (files restored: 399dc59f32fc)

$ node --test --test-timeout=15000 test/integration/three-hosts.test.ts        # after restore
# skipped 0
# todo 0
# duration_ms 586.203792
# green rc=0 ok=True
```

#### 8.2.2 E-2 — the path selects the listener again (B1, verbatim)

With the path rule back, `/admin/t/acme/pages` on `acme.test` is the admin listener again: the tenant
host answers `SKW_E_PLT_TENANT_UNKNOWN` instead of the byte-identical page-miss body, and the demo host
answers 421 instead of 404.

```
$ node --test --test-timeout=15000 test/admin-listener.test.ts
not ok 2 - (b) /admin/t/acme/pages on a tenant host is the same 404 as an unknown path, with no Set-Cookie
not ok 3 - (c) the same path on a demo host is the same 404, not a 421
# fail 2
# red rc=1   (files restored: 399dc59f32fc)

$ node --test --test-timeout=15000 test/admin-listener.test.ts        # after restore
# skipped 0
# todo 0
# duration_ms 253.926166
# green rc=0 ok=True
```

#### 8.2.3 E-1 — row 1 removed

With row 1 gone, an admin request carrying a tenant header resolves through the later rows. The row-1
case and its empty-header twin (E-1 a) both go red while rows 9/10 and the public-listener invariant
(E-1 c) stay green — the failure is localised to the row that moved.

```
$ node --test --test-timeout=15000 test/tenancy/resolve.test.ts
# Subtest: row 1 — the admin listener refuses a tenant header present at all (non-empty and empty)
not ok 1 - row 1 — the admin listener refuses a tenant header present at all (non-empty and empty)
# Subtest: row 10 — a resolved tenant whose database is unusable is 503, one code per cause
ok 10 - row 10 — a resolved tenant whose database is unusable is 503, one code per cause
# Subtest: E-1 (a) — an empty X-Skunkworks-Tenant on the admin listener is row 1, 421
not ok 11 - E-1 (a) — an empty X-Skunkworks-Tenant on the admin listener is row 1, 421
# Subtest: E-1 (c) — no public-listener request reports row 1 or row 7
ok 12 - E-1 (c) — no public-listener request reports row 1 or row 7
# fail 2
# red rc=1   (files restored: b3d8aa4cc4ad)

$ node --test --test-timeout=15000 test/tenancy/resolve.test.ts        # after restore
# skipped 0
# todo 0
# duration_ms 604.5545
# green rc=0 ok=True
```

#### 8.2.4 E-11 — the prefix clear removed at the edge *and* the app made to honour it

The property has two implementations — the snippet and the resolver — so the control breaks both,
exactly as QA's §2.1(a)+(b) had to. Either alone leaves the other one holding.

```
$ node --test --test-timeout=15000 test/nginx-e2e.test.ts test/prefix-demo.test.ts
not ok 8 - E-11: a client X-Forwarded-Prefix is cleared at the edge
    a client-chosen prefix must never become tenant.prefix
# Subtest: POST /demo/acme/whoami carries its body through the prefix location
ok 13 - POST /demo/acme/whoami carries its body through the prefix location
# Subtest: the app never strips a prefix itself: /demo/acme at the app is 404, not /
ok 16 - the app never strips a prefix itself: /demo/acme at the app is 404, not /
not ok 18 - E-11 — a client X-Forwarded-Prefix is ignored on a host-routed request
  location: '/Volumes/Backup/Development/skunkworks/test/prefix-demo.test.ts:113:1'
    a client prefix must not become tenant.prefix
    TestContext.<anonymous> (file:///Volumes/Backup/Development/skunkworks/test/prefix-demo.test.ts:123:10)
# fail 2
# red rc=1   (files restored: aab23b5ca5e2,b3d8aa4cc4ad)

$ node --test --test-timeout=15000 test/nginx-e2e.test.ts test/prefix-demo.test.ts        # after restore
# skipped 0
# todo 0
# duration_ms 6995.650625
# green rc=0 ok=True
```

#### 8.2.5 E-3 — the count-based stamp restored (B2, verbatim)

Seven cases go red, including the three QA measured by hand: a suspended tenant serving, a deleted host
routing, and a raised `db_version` not producing a 503.

```
$ node --test --test-timeout=15000 test/tenancy/cache.test.ts
not ok 2 - UPDATE tenant.status = suspended is visible on the next request (§5.3 row 9)
not ok 3 - UPDATE tenant.status = archived is visible on the next request
not ok 4 - UPDATE tenant.mode = 'demo' moves the stamp and no longer changes routing (E-2 rule 4)
not ok 5 - UPDATE tenant.db_version = 9 is 503 SKW_E_DM_SCHEMA_STALE with Retry-After: 5
not ok 6 - DELETE FROM domain stops the host routing on the next request
not ok 7 - INSERT INTO domain makes the new host serve on the next request
not ok 9 - §5.4a — exactly one stamp read per request, and one rebuild per bump
# fail 7
# red rc=1   (files restored: fa12cf1b2571)

$ node --test --test-timeout=15000 test/tenancy/cache.test.ts        # after restore
# skipped 0
# todo 0
# duration_ms 471.268209
# green rc=0 ok=True
```

#### 8.2.6 E-6 — the trigger drops moved back after `DROP TABLE` (the as-written file)

```
$ node --test --test-timeout=15000 test/migrate.test.ts
not ok 3 - a v1 site.db is migrated through the frozen chain to v3
not ok 4 - E-14 negative control — dropping one CHECK from the migrated file makes the comparison go red
# fail 2
# red rc=1   (files restored: 9501211c3020)

$ node --test --test-timeout=15000 test/migrate.test.ts        # after restore
# skipped 0
# todo 0
# duration_ms 994.181875
# green rc=0 ok=True
```

The same defect on the interpreter whose SQLite re-parses triggers (3.53.4), through the model gate:

```
$ /Users/cyberdeth/.hermes/profiles/ceo/cache/scratch/py-modern/bin/python scripts/model/verify_claims.py
PASS  2 cp loses data, VACUUM INTO keeps it                    cp=no such table; VACUUM INTO rows=1000 user_version=9 views=1 jm=delete wal_before=28872B
FAIL  10 root path '/' is insertable                           OperationalError: error in trigger trg_cms_asset_delete_guard: no such table: main.cms_download_code
FAIL  11 storage_path is generated, sha256 immutable           OperationalError: database is locked
FAIL  12 asset delete guard holds with foreign_keys=OFF        OperationalError: error in trigger trg_cms_asset_delete_guard: no such table: main.cms_download_code
FAIL  15 (jti) WHERE kind='first' tolerates NULL               OperationalError: error in trigger trg_cms_asset_delete_guard: no such table: main.cms_download_code
FAIL  20 migration chain v1->v3 converges on site.sql          OperationalError: error in trigger trg_cms_asset_delete_guard: no such table: main.cms_download_code
FAIL  22 redemption on the v3 tables (C-7)                     OperationalError: error in trigger trg_cms_asset_delete_guard: no such table: main.cms_download_code
FAIL  26 body ban + list loop contract (C-12/C-4)              OperationalError: error in trigger trg_cms_asset_delete_guard: no such table: main.cms_download_code
# red rc=1   (files restored: 9501211c3020)

$ /Users/cyberdeth/.hermes/profiles/ceo/cache/scratch/py-modern/bin/python scripts/model/verify_claims.py        # after restore
PASS  27 connection classes: query_only is not tenancy (C-15)  query_only: VACUUM INTO -> attempt to write a readonly database; temp trigger -> attempt to write a readonly database; ATTACH -> ALLOWED: main,temp,other; exporter class wrote 8192 B

27/27 passed, 0 skipped, 0 failed
# green rc=0 ok=True
```

Seven checks fail with the exact `no such table: main.cms_download_code` the errata quotes, and the gate is
green again with the drops moved ahead of the `DROP TABLE` — no pragma anywhere.

#### 8.2.7 E-14 — one `CHECK` removed from the r3 rebuild

This is the case the old gate could not see: the table set, the column sets and the trigger sets are all
identical. Only the table text differs — and the gate names the table. `test/migrate.test.ts` also
carries the in-suite negative control (a scratch copy with the `length(code_selector) = 4` CHECK
dropped), which asserts the same red without touching the migration.

```
$ node --test --test-timeout=15000 test/migrate.test.ts
not ok 3 - a v1 site.db is migrated through the frozen chain to v3
  error: 'site.db v1->v3: table text drift (CHECK constraints live here): cms_download_code'
not ok 4 - E-14 negative control — dropping one CHECK from the migrated file makes the comparison go red
# fail 2
# red rc=1   (files restored: 9501211c3020)

$ node --test --test-timeout=15000 test/migrate.test.ts        # after restore
# skipped 0
# todo 0
# duration_ms 897.625875
# green rc=0 ok=True
```

#### 8.2.8 E-5 — the demo key grammar back to 32 characters

The drift gate and the shape assertion both fire. Regenerating with the old grammar and running the e2e
additionally fails the 40-character case, with nginx's own 404 instead of the app's JSON 404.

```
$ node --test --test-timeout=15000 test/nginx-config.test.ts
not ok 2 - the demo location rewrites, then overrides exactly the two tenant lines
not ok 11 - the committed nginx/conf.d/10-app.conf is the generator output for this fixture
# fail 2
# red rc=1   (files restored: 80d1ad60772a)

$ node --test --test-timeout=15000 test/nginx-config.test.ts        # after restore
# skipped 0
# todo 0
# duration_ms 132.925875
# green rc=0 ok=True
```

#### 8.2.9 E-12 — the regeneration step skipped

The test is the negative half of the contract: with the rows committed but the config not regenerated,
the new host is still 404 at the edge and the gate says so.

```
$ node --test --test-timeout=15000 test/onboarding.test.ts
not ok 1 - E-12: a new tenant 404s at the edge until the generator runs and nginx reloads
# fail 1
# red rc=1   (files restored: fd70d7248d3c)

$ node --test --test-timeout=15000 test/onboarding.test.ts        # after restore
# skipped 0
# todo 0
# duration_ms 3442.373125
# green rc=0 ok=True
```

#### 8.2.10 E-13 — the edge limit raised, so a 17 MiB body reaches the app

Now the 413 that comes back is the app's taxonomy body rather than nginx's HTML, and the assertion that
fails is exactly the one that distinguishes the two (`text/html`).

```
$ node --test --test-timeout=15000 test/nginx-e2e.test.ts
not ok 10 - E-13: a 17 MiB body through the edge is nginx's HTML 413, with no taxonomy code
# fail 1
# red rc=1   (files restored: 31e1662217c1)

$ node --test --test-timeout=15000 test/nginx-e2e.test.ts        # after restore
# skipped 0
# todo 0
# duration_ms 6630.758042
# green rc=0 ok=True
```

#### 8.2.11 E-7 — `Retry-After` suppressed in `sendError` (QA's m2, verbatim)

The table test stops on the first code whose header is missing. With the header restored, all three
entries in `schema/error-codes.json` arrive with the JSON's value and four codes without an entry carry
no header.

```
$ node --test --test-timeout=15000 test/tenancy/resolve.test.ts
not ok 19 - E-7 — every code with a retry_after entry carries the header, with that value
    SKW_E_DM_SCHEMA_STALE retry-after on the wire
# fail 1
# red rc=1   (files restored: 399dc59f32fc)

$ node --test --test-timeout=15000 test/tenancy/resolve.test.ts        # after restore
# skipped 0
# todo 0
# duration_ms 557.294709
# green rc=0 ok=True
```

#### 8.2.12 E-8 — the boot refusal removed: the gate reports in 5 s instead of hanging

Measured duration of the failing case: **5,040.9 ms**, and the message is the named failure the errata
asks for — not a >180 s wait. `--test-timeout=15000` is on `make verify-s1` as a second belt.

```
$ node --test --test-timeout=15000 test/env.test.ts
not ok 1 - a deleted SKUNK_ key refuses the boot and names both the key and its replacement
not ok 2 - a deleted SK_ key refuses the boot and names it
not ok 3 - the refusal lists every offending key, sorted, each with its replacement
not ok 7 - the real process refuses to start and exits non-zero, naming the key on stderr
  error: 'the process booted instead of refusing: SKUNK_EDGE_TOKEN (the ^SK_|^SKUNK_ refusal regressed)'
# fail 4
# red rc=1   (files restored: 6ddf163e1b42)

$ node --test --test-timeout=15000 test/env.test.ts        # after restore
# skipped 0
# todo 0
# duration_ms 5579.567666
# green rc=0 ok=True
```

#### 8.2.13 E-9 — the refusal message loses the process-start clause

```
$ node --test --test-timeout=15000 test/env.test.ts
not ok 5 - E-9 — UV_THREADPOOL_SIZE must be 8, and the message says why it cannot be set late
    The input did not match the regular expression /fixed at process start/. Input:
# fail 1
# red rc=1   (files restored: 6ddf163e1b42)

$ node --test --test-timeout=15000 test/env.test.ts        # after restore
# skipped 0
# todo 0
# duration_ms 5445.278375
# green rc=0 ok=True
```

#### 8.2.14 E-15 — the preflight, and a skip as a failure

Not a mutation control: the red run is the **unmutated** gate pointed at an interpreter that does not
ship `argon2-cffi` (`/opt/homebrew/bin/python3`, 3.14.6 / SQLite 3.53.4), which is the exact case the old
comment claimed could not happen.

```
$ make verify-toolchain PYTHON=/opt/homebrew/bin/python3
verify-toolchain: /opt/homebrew/bin/python3 cannot import argon2 — install argon2-cffi
  tried: /opt/homebrew/bin/python3
  (checks 17 and 21 skip without it, and a skip is a failure here — E-15)
make: *** [verify-toolchain] Error 1
# rc=2

$ /opt/homebrew/bin/python3 scripts/model/verify_claims.py ; echo "EXIT=$?"
…
25/27 passed, 2 skipped, 0 failed
FAIL  17 argon2 parameter cost on this box: pip install argon2-cffi, 21 selector seek + argon2 verifier (C-6): pip install argon2-cffi  (a skip is a failure without --allow-skip; E-15)
EXIT=1
```

Green on the declared interpreter and on a second one whose SQLite is ≥ 3.50:

```
$ make verify-toolchain
verify-toolchain: /usr/bin/python3 -> python 3.9.6, sqlite 3.43.2, argon2 ok

$ make verify-claims-modern MODERN_PYTHON=…/py-modern/bin/python
verify-toolchain: …/py-modern/bin/python -> python 3.14.6, sqlite 3.53.4, argon2 ok
27/27 passed, 0 skipped, 0 failed
```

`--allow-skip` exists and is the only way a skip passes; the Makefile never passes it.

#### 8.2.15 E-2 / E-11 — the `check_frozen` supersession is explicit, load-bearing and tight

Three controls, because the risk with a supersession is that it becomes a blanket exemption.

```
$ python3 scripts/model/check_frozen.py
  BAD SUPERSESSION: C-25: the retired text is STILL in SDS.md — the supersession was not applied
  BAD SUPERSESSION: C-25: the retired text is STILL in SDS.md — the supersession was not applied
FAIL the SDS paraphrases the register
# red rc=1   (files restored: a22a2c8b8537)

$ python3 scripts/model/check_frozen.py        # after restore
PASS the SDS quotes the register
# green rc=0 ok=True
```

```
$ python3 scripts/model/check_frozen.py
  BAD SUPERSESSION: C-25: the E-2 replacement is not verbatim in SDS.md
  BAD SUPERSESSION: C-25: the E-2 replacement is not verbatim in SDS.md
FAIL the SDS paraphrases the register
# red rc=1   (files restored: 7551eed638e8)

$ python3 scripts/model/check_frozen.py        # after restore
PASS the SDS quotes the register
# green rc=0 ok=True
```

```
$ python3 scripts/model/check_frozen.py
  MISSING C-25: A host that serves tenant-authored HTML never serves the admin listener: demos live at `demos.<our-domain>/demo/<key>/`, admin at `admin.<our-domain>`, and the …
FAIL the SDS paraphrases the register
# red rc=1   (files restored: f93394c34585)

$ python3 scripts/model/check_frozen.py        # after restore
PASS the SDS quotes the register
# green rc=0 ok=True
```

Green, after restore, with the entries in place:

```
$ python3 scripts/model/check_frozen.py
adopted sentences: 24/25 verbatim in SDS.md; 1 superseded by 02-errata
  SUPERSEDED by E-2 (asserted)
frozen §4 blocks: 11/12 verbatim; 1 superseded by 02-errata
  SUPERSEDED by E-11 (asserted)
resolution steps: 5/5 present; env names: 29/29 present

PASS the SDS quotes the register
```

The entry is not a relaxed pattern and not a removed assertion: for a superseded artefact the check
requires the **old text to be absent**, the **replacement to be present verbatim**, and the errata item
to exist and to carry the `SUPERSEDES` marker naming the artefact. The third control shows the entry is
load-bearing — delete it and the artefact is simply missing again.

### 8.3 Gates that changed shape

| Gate | Before | After | Why |
|---|---|---|---|
| `test/admin-listener.test.ts` | asserted `listenerFor('/admin/t/acme/pages','acme.test') === 'admin'` | an 8-row listener table + tenant-host body equality, demo-host 404, admin-host 404 on every path, header-at-all → 421 | the old test asserted B1 as intended behaviour |
| `test/tenancy/resolve.test.ts` | 10 cases asserting the **outcome** | 10 cases asserting the **row**, + E-1 (a)/(c), + the E-7 wire table | a right status from the wrong row is a defect (E-1) |
| `test/migrate.test.ts` | `(type, name)` set comparison | `comparePlanes` (table text, trigger bodies, columns, indexes) + the negative control + the E-6 source assertion + control v3 | E-14: a missing CHECK passed the old check |
| `test/nginx-config.test.ts` | `locationBlocks` by the regex `[^{]*` | a quote-aware block scanner; 40-char grammar; unquoted-brace assertion; pending-cert assertion; demos 404 assertion | the quoted `{0,39}` broke the old helper, which is itself the E-5 point |
| `test/nginx-e2e.test.ts` | 6 cases | 11: 40-char key, client prefix, empty header through the edge, 17 MiB HTML 413, 16 MiB pass | E-5 / E-11 / E-1(b) / E-13 |
| `test/env.test.ts` | `spawnSync` with no timeout | 5 s + SIGKILL, `ETIMEDOUT` named failure, a free-port boot case, a timeout-path control | E-8 |
| `test/helpers/http.ts` | `call()` only | + `postRaw()` (raw socket, 3 attempts, stops writing when the response starts) | `ClientRequest` surfaces the edge's EPIPE as an uncaught exception; the wire test needs a client that survives a 413 mid-upload |
| `test/helpers/fixture.ts` | `cert_state` always `none` | per-spec `certState`, default `issued` | E-5 needs both the issued and the pending block |
| `Makefile` | `test: verify` | `test: verify-toolchain verify`; `verify-s1: verify-toolchain …`; `--test-timeout=15000`; `verify-claims-modern` | E-15, E-8 |
| `scripts/model/check_frozen.py` | 25 adopted sentences + 12 blocks, all mandatory | the same, plus a named `SUPERSEDED` table with three assertions per entry | E-2 / E-11 supersede frozen text |

### 8.4 Where the errata was silent or wrong, and what I did

1. **E-1's status table has no row for a row-6 miss.** A well-formed `X-Skunkworks-Tenant` naming a
   tenant that is not in `control.db` matches row 6's condition and has no `domain` row to fall back on;
   the status table names `TENANT_UNKNOWN` only for "row 7 with no session, row 8 with no `domain` row,
   row 9". I implemented the only defensible answer — `404 SKW_E_PLT_TENANT_UNKNOWN`, reported at **row
   6** — and `test/tenancy/resolve.test.ts` asserts it. That is a gap in the table, not a disagreement
   with an instruction; the alternatives are a 500 or a 404 that lies about which row fired.
2. **E-3's test list and E-2's rule 4 collide on `mode='demo'`.** E-3 asks that "the next request over
   the socket must show the new state" for a mode flip; after E-2 a mode flip has no routing effect at
   all, which is rule 4's point. The cache gate therefore asserts what is still true and still
   load-bearing: the flip **moves the stamp**, and the tenant keeps serving. Asserting a 404 there would
   re-introduce the listener decision keyed on tenant mode that §9.1 rule 4 forbids.
3. **E-14's gate found three real constraint drifts the old check could not see, and fixing them was
   not in the errata's file list.** On the v1→r2→r3 chain, `cms_redirect.from_path` was missing
   `NOT GLOB '//*'` (O-16's shared predicate), `cms_form_submission.state` was missing `'suppressed'`
   (O-30's honeypot), and `cms_datasource.cost_ms_p95` had lost `CHECK(… >= 0)` because A5's `RENAME
   COLUMN` carried v2's constraint-free column forward. All three are invisible to `(type, name)` and all
   three are exactly what E-14 exists to catch, so `schema/r3-amendments.sql` gained **A8b**: three
   12-step rebuilds whose definitions are copied from `schema/site.sql`. Nothing else in r3 changed. If
   the Architect would rather carry these as a separate item, A8b is the only block to move.
4. **E-6 forbids the string `legacy_alter_table` in `verify_claims.py`**, so the gate cannot even name
   the pragma it is proving unnecessary. I dropped a stronger sub-case I had written (run the chain again
   with the pragma explicitly `OFF` and compare) because it would have put the literal back in the file.
   The convergence comparison plus the control in 8.2.6 carry the claim instead.
5. **E-5 lists `nginx/templates/server.tmpl` as a file to change**, but no generator reads it:
   `generateAppConf()` builds the text directly and nothing renders this template. I updated it to the
   same shape (with a `{{TLS_LISTEN}}` placeholder) so a reader is not misled, but it is not
   load-bearing and no gate covers it.
6. **E-10 permits only the paragraph after §3's fence to change**, so §3's `Makefile` line still lists
   `test / verify / verify-schema / verify-claims / verify-gitignore`. The Makefile now also has
   `verify-toolchain` and `verify-claims-modern`; the fence is stale by the errata's own restriction, not
   by omission.
7. **E-15 asks for "CI — the second `verify-claims` run", and this repository has no CI.** I added
   `.github/workflows/gate.yml` with both runs and a hard assertion that the second interpreter's SQLite
   is ≥ 3.50, so the job cannot silently prove nothing. **It has never executed** — there is no runner
   here, and I am not claiming it green.
8. **`app/main.ts` now exposes `tenants` on `AppHandle`.** §5.4a's "exactly one stamp read per request"
   is only assertable against the map the request path actually uses; a second `TenantMap` would prove
   nothing about the request path. That is the one production-surface addition in this rework, it is
   read-only, and it changes no behaviour.
9. **E-2's five-row listener table is implemented with the Host as the only input.** `listenerFor()` no
   longer takes a pathname at all, so the path *cannot* select the listener; the test keeps the path in
   each row as documentation and evaluates the Host alone.
10. **E-8's "the child's stdout must not contain `listening`"** is asserted, but a child that regresses
    can also exit early on `EADDRINUSE` when the fixture port is taken. Giving the case a free port is
    what makes the timeout path the one that fires (5,040.9 ms, named failure). Both are red with a
    message; neither is a wait.

### 8.5 Final runs

```
$ make test                     # /usr/bin/python3 3.9.6 / SQLite 3.43.2
… 27/27 claim checks PASS, 0 skipped
PASS the SDS quotes the register
# tests 106  # pass 106  # fail 0  # skipped 0
EXIT=0

$ make verify-s1
# tests 106  # pass 106  # fail 0  # skipped 0
EXIT=0

$ make test PYTHON=…/py-modern/bin/python      # 3.14.6 / SQLite 3.53.4
verify-toolchain: … -> python 3.14.6, sqlite 3.53.4, argon2 ok
… 27/27 passed, 0 skipped, 0 failed
PASS the SDS quotes the register
# tests 106  # pass 106  # fail 0
EXIT=0
```

The 106 node tests include both real-nginx suites (`nginx-e2e` 11, `onboarding` 1) and report
`# skipped 0`: the Docker daemon was present and both ran.

`make verify-s1` needs `docker`, Node 22 and `node_modules`. The model gates need a `python3` with
`argon2-cffi`; `make verify-toolchain` now says so in one line instead of a silent 25/27.
