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
