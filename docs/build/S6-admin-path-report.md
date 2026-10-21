# S6 — admin on the tenant host (D37)

**Decision:** the user overruled **D9**. The admin surface is **not a hostname**. It is
`/admin` on **every tenant host**, WordPress-style: `abc123.com/admin`, `123abc.com/admin`,
`demo.abc123.com/admin`. The fleet console moved to `/fleet` and is a fleet operator's
surface on any host. One Docker instance, three hosts, per-host self-signed certificates —
unchanged.

**Status:** implemented, gate green. This file is the record: what was superseded, the
cookie table, the cross-host proof, everything that had to be re-pointed, and what still
depends on the old admin host.

---

## 1. What changed, in one table

| Before (D9 + §9.1/E-2) | After (D37) |
|---|---|
| `listener = 'admin'` iff `Host == host(SKW_ADMIN_ORIGIN)` | no listener; `/admin` on any tenant host is that host's admin |
| admin unmounted on every tenant host; `/admin/…` there is a page-miss 404 | `/admin` on a tenant host **is** the admin; a Host with no tenant is 404 `SKW_E_PLT_TENANT_UNKNOWN` |
| tenant from `session.tenant_id` (`resolveAdminTenant`), URL `/admin/t/<key>/…` | tenant from **`Host`**; `/admin/t/<key>/…` requires `key == host tenant key` |
| fleet console `GET /admin`, tenant switcher | fleet console `GET /fleet` + `POST /fleet/logout`; each entry links to `https://<tenant primary host>/admin` |
| cookie `__Host-sk-sess`; `Path=/`; `SameSite=Lax` | `__Secure-sk-sess-<tenantKey>`; `Path=/admin`; `HttpOnly; Secure; SameSite=Strict`; `__Secure-sk-fleet` at `Path=/fleet` |
| CSRF `Origin == SKW_ADMIN_ORIGIN` | `Origin == https://<normalised request Host>` |
| nginx: separate admin vhost + `default.crt` pair | no admin vhost; `location ~ "^/admin(/|$)"` inside every tenant block, allowlist emitted there |
| email lookup was global; two tenants sharing an email were *ambiguous* (401) | lookup scoped to the Host's tenant (+ fleet rows); one email on two hosts = two operators, two sessions |

Route map now:

```
GET  /admin                    this Host's tenant admin home
GET|POST /admin/login          the one login URL (D29 kept); a fleet row signs in here
                               and gets the /fleet cookie
POST /admin/password/reset     reset-token consumer (E-19)
.... /admin/t/<key>/<action>   tenant-scoped; <key> must equal the Host's tenant
GET  /fleet                    fleet console (fleet session only, any host)
POST /fleet/logout             end the fleet session
```

---

## 2. The D9 supersession, with D9's reasons stated rather than dropped

IDEA.md §13 D9 (line 739) said, and this is why:

> "Admin is a separate **hostname** (`admin.<domain>`) behind nginx with no published
> port; the IP allowlist is opt-in and empty in exported bundles; when it is empty, TOTP
> is mandatory and idle drops to 15 min; every non-GET carries a session-bound CSRF token
> and an exact `Origin` check."

D9 had replaced an earlier "separate origin/port" because *a port is not an origin
boundary — cookies ignore ports (measured)*. The separate **hostname** was doing two jobs,
and both are given up by D37 deliberately:

**(a) C-25: tenant-authored HTML and the admin were never same-origin.** A tenant can paste
script into a page; on `abc123.com` that script can now `fetch('/admin/pages')` and the
browser attaches the operator's cookie, and CORS does not block a same-origin read. Under
D9 that sentence was true because the admin lived on a different origin. D37 makes it
false. What replaces it:

- `SameSite=Strict` — a cross-site request never carries the cookie, so the attack has to
  run *inside* the admin's own site, which means inside tenant-authored HTML on the same
  host. That is the residual risk, and it is a real one: **an operator who previews
  tenant-supplied markup in the admin context is trusting that markup.** §10.3's body ban
  (`<script>`, comments, `javascript:`) still applies to stored page bodies at the
  database, so markup has to arrive through a plugin or an XSS in the renderer to be
  live; the ban is not a proof and was never claimed as one.
- The admin is JS-free by design (D28: the CSRF token is a header, forms are plain posts),
  so there is no admin-side script for a same-origin page to hook.
- The cookie is named per tenant and scoped to `/admin`, so a page served at `/pricing`
  on `123abc.com` has no cookie for `abc123.com`'s admin and cannot forge one.

**(b) `/admin` as an anti-oracle.** Under §9.1 rule 1, `/admin` on a tenant host was
byte-identical to a path with no page, with no `Set-Cookie`, no `Location`, no 421 — so no
probe could fingerprint the CMS. D37 makes that impossible to keep: `/admin` is now a real
surface on every tenant host and answers `200` with a login form. The promise is retired
for `/admin` **and kept where it is free**: a tenant owner who asks for `/fleet` gets
`serveNotFound` — the page-miss path — so the body is byte-identical to a missing page
(asserted, `test/admin-listener.test.ts` (e), and the probe output in §4).

What D9 got right and D37 keeps: the allowlist is still enforced **at the edge and nowhere
else**, TOTP is still mandatory with an empty allowlist, idle is still 15 min, and every
non-GET still carries a session-bound CSRF token plus an exact `Origin` check. The Origin
check's *value* changed because there is no single admin origin any more.

SDS.md §9 now carries a supersession note at its head listing exactly which sentences are
retired. The note adds text and deletes nothing: `scripts/model/check_frozen.py` asserts the
retired sentences are still quoted in the SDS (21/25 adopted sentences verbatim, 4
errata-superseded), so rewriting §9.1/§9.2 in place would have turned `make verify-frozen`
red. That gate is green with the note in place.

---

## 3. The cookie table

Name is a function of the **tenant key**, not of the host string, so an alias and the
primary share one namespace and two tenants never do.

| Host (real) | Tenant key | Cookie name | Path | Flags | Who gets it |
|---|---|---|---|---|---|
| `abc123.com` | `abc123` | `__Secure-sk-sess-abc123` | `/admin` | `HttpOnly; Secure; SameSite=Strict` | that tenant's operators |
| `demo.abc123.com` | `demo-abc123` (or an alias of `abc123` — see below) | `__Secure-sk-sess-demo-abc123` | `/admin` | `HttpOnly; Secure; SameSite=Strict` | that tenant's operators |
| `123abc.com` | `123abc` | `__Secure-sk-sess-123abc` | `/admin` | `HttpOnly; Secure; SameSite=Strict` | that tenant's operators |
| any host | — | `__Secure-sk-fleet` | `/fleet` | `HttpOnly; Secure; SameSite=Strict` | fleet operators (`tenant_id IS NULL`) |

Notes that are load-bearing:

- **`__Host-` is unavailable, and that is arithmetic.** `__Host-` requires `Path=/` and no
  `Domain`; the isolation now lives in the path, so the prefix must be `__Secure-`. This is
  the same erratum §7.4.3 records for `__Host-dl-<key>`.
- **No `Domain` attribute, ever.** One `Domain=.abc123.com` would hand `demo.abc123.com`'s
  cookie to `abc123.com` (or worse). `__Secure-` forbids it structurally; the generator and
  `test/admin-session.test.ts` both assert it is absent.
- **`SameSite=Strict`, not `Lax`.** Cost, stated rather than discovered: a link from an email
  into `abc123.com/admin` arrives with no cookie and gets the 404 an unauthenticated admin
  request gets (not a redirect). Sign in, then navigate.
- **Two hosts of the same tenant** (`abc123.com` and `www.abc123.com` are aliases) share the
  cookie *name*; the browser's host-only scoping keeps the cookies separate, and the name
  being equal is correct — it is the same tenant.
- **Scheme is fixed at `https`** for the Origin check. This is not a guess: the cookie is
  `Secure`, so a browser never attaches it to an `http` request — an http-origin POST has no
  session to abuse. A plain-http deployment cannot log in, which is the right answer for a
  product whose every host has a certificate.

---

## 4. The cross-host proof (the property the hostname gave for free)

Two tenants on one box with the **same email address**, one login each, then each cookie
presented to the other host. Real output, three tenants on one fixture, from a probe against
the built app (`test/integration/three-hosts.test.ts` asserts the same thing as a gate):

```
=== Set-Cookie per host (login as the same email on each) ===
acme.test        200  __Secure-sk-sess-acme=<id>.<mac>; HttpOnly; Secure; SameSite=Strict; Path=/admin
beta.test        200  __Secure-sk-sess-beta=<id>.<mac>; HttpOnly; Secure; SameSite=Strict; Path=/admin
acme-demo.test   200  __Secure-sk-sess-demo-acme=<id>.<mac>; HttpOnly; Secure; SameSite=Strict; Path=/admin

=== cross-host: each cookie presented to every other host ===
acme.test cookie      -> beta.test         404 SKW_E_PLT_TENANT_UNKNOWN
acme.test cookie      -> acme-demo.test    404 SKW_E_PLT_TENANT_UNKNOWN
beta.test cookie      -> acme.test         404 SKW_E_PLT_TENANT_UNKNOWN
beta.test cookie      -> acme-demo.test    404 SKW_E_PLT_TENANT_UNKNOWN
acme-demo.test cookie -> acme.test         404 SKW_E_PLT_TENANT_UNKNOWN
acme-demo.test cookie -> beta.test         404 SKW_E_PLT_TENANT_UNKNOWN

=== the forged name: acme value under beta's cookie name, sent to beta ===
404 SKW_E_PLT_TENANT_UNKNOWN

=== /fleet for a tenant owner vs a fleet operator ===
tenant owner GET /fleet      404 SKW_E_RT_PAGE_NOT_FOUND
tenant owner GET /no-such    404 SKW_E_RT_PAGE_NOT_FOUND
byte-identical bodies: true
```

There are **two independent refusals**, which is why the forged-name case is in the list:

1. **the name** — host B looks for `__Secure-sk-sess-<its tenant>` and never reads A's;
2. **the row** — if a caller rewrites the name (they can; a browser cannot cross hosts), the
   HMAC still verifies because `SKW_SESSION_KEY` is process-wide, and the refusal that holds
   is `session.tenant_id == host tenant id`. That is `AdminSurface.#assertTenantMatches`.

`test/integration/three-hosts.test.ts` (D37 tests 1–4) is the gate; it also proves the two
session rows are distinct and both survive the attempt (independence is not "revoke on
contact").

---

## 5. What had to be re-pointed

### Application

| File | Change |
|---|---|
| `app/tenancy/listener.ts` | **deleted** (`listenerFor` could only ever say "public" afterwards; leaving it exported is how the old rule comes back) |
| `app/tenancy/resolve.ts` | rows **1 and 7 removed**, `listener` and `session` inputs removed; surviving rows keep their numbers; `via` narrowed to `'header' \| 'host'` |
| `app/main.ts` | no admin-host rule, no session parse in the resolver; `/admin` handler resolves the tenant from `Host`; `/fleet` + `/fleet/*` registered; `/admin/api/tenants/:key/health` re-pointed; `/f/:key`'s old `listener !== 'public'` guard removed (it was the admin host's exclusion) |
| `app/admin/routes.ts` | `hostTenant()`, `handle()` (Host tenant, non-empty tenant header refused 421, `/admin/t/<key>` must match), `handleFleet()`, `#fleetConsole()` with per-tenant primary host, `#requireSession(req, tenant)`, `#assertOrigin` → request origin, cookie name/path per session kind, `#assertTenantMatches` re-documented, "All tenants" menu entry removed |
| `app/admin/session.ts` | `sessionCookieName(key)`, `cookieAttrs(path)`, `FLEET_COOKIE`, `ADMIN_COOKIE_PATH`, `FLEET_COOKIE_PATH`, `cookieHeader(name,value,path)`, `clearCookieHeader(name,path)`; `__Host-sk-sess` / `Path=/` / `Lax` gone |
| `app/admin/auth.ts` | `authenticate({scope, …})`: lookup scoped to the Host's tenant (+ fleet rows), ambiguity still refused *inside* a scope, `LoginFailureReason` now reports `ambiguous` only for >1 row in scope |
| `app/export/cms.ts` | `generateAppConf` call loses `adminHost`; the exported `/admin` location carries no access directive (empty allowlist in bundles) |
| `tools/nginx_gen.ts` | admin vhost + its `default.crt` pair deleted; `location ~ "^/admin(/|$)"` (quoted for E-5) with `limit_req` repeated and the allowlist inside it, in every tenant block; `adminHost` removed from `GenOptions`; only the demos name is reserved; `--admin-host` accepted and ignored |
| `tools/regen_conf.ts`, `nginx/conf.d/10-app.conf` | regenerated (243 lines, was 269) |
| `tools/install_check.mjs` | the probe's `Host` is the first tenant's primary `domain` row, not the enrolment file's admin URL (a probe sending a hostname the edge no longer serves would test nothing) |
| `install.sh` | the closing "Sign in at …" line prints the tenant host read from `control.db`, falling back to `$ADMIN_HOST` only when there is no tenant |
| `scripts/proof/allowlist-single-parser.mjs` | `generateAppConf` call loses `adminHost` |
| `docs/sds/SDS.md` | §9 supersession note (additive; the frozen sentences stay, see §2 above) |

### Tests superseded (rewritten, never weakened, each with a named note in the file)

| File | Old promise | New promise |
|---|---|---|
| `test/admin-listener.test.ts` | "a demo Host cannot reach the admin surface; `/admin/…` on a tenant host is byte-identical to an unknown path; no admin route on a public listener" | the tenant is the `Host`'s and nothing else; `/admin/t/<key>` cannot cross the Host; `/fleet` is a fleet operator's and a tenant owner gets the page-miss 404 byte for byte; a demo host still reaches nothing; header refusal relocated |
| `test/tenancy/resolve.test.ts` | row 1 (admin listener refuses the tenant header) and row 7 (admin listener resolves from `session.tenant_id`) | both rows are gone and the file says where each gate went; new test: "the Host is the only source: no input can name another tenant" |
| `test/admin-session.test.ts` | `__Host-sk-sess; Path=/; HttpOnly; Secure; SameSite=Lax` | `__Secure-sk-sess-acme; HttpOnly; Secure; SameSite=Strict; Path=/admin`, plus rejection cases under another tenant's name and the fleet name |
| `test/admin-operator.test.ts` | D29: `GET /admin` is the fleet console, the switcher changes the URL | D37: `GET /admin` is the Host's tenant home; `GET /fleet` is the console and links each tenant's own admin address |
| `test/login-ambiguity.test.ts` | two rows, one email → one 401 (`ambiguous`) | the scope decides: each host authenticates its own row; ambiguity still refused inside a scope |
| `test/nginx-config.test.ts` | admin vhost exists, reserved names include it, allowlist in the admin block only | no admin vhost; `/admin` location in every tenant block; allowlist on `/admin` and no other path; `admin.<domain>` is an ordinary hostname now |
| `test/nginx-e2e.test.ts` | empty tenant header on the admin host through the real edge is row 7 | same assertion on a tenant host through the real edge, plus "the old admin hostname reaches nothing"; the allowlist gates `/admin` on the tenant host |
| `test/admin-allowlist.test.ts` | `allow` at 4-space indent in the admin vhost | 8-space indent inside each tenant block's `/admin` location, once per tenant |
| `test/admin-auth.test.ts`, `test/plugin-hooks-wired.test.ts`, `test/admin-csrf.test.ts`, `test/csp.test.ts`, `test/admin-plugin-notices.test.ts` | `__Host-sk-sess…`, `origin: https://admin.skw.test`, `host: admin.skw.test` | the tenant's cookie name and the tenant's origin/host |
| `test/helpers/admin.ts` | `ADMIN_HOST = 'admin.skw.test'` | `ADMIN_HOST = 'acme.test'` (a tenant host) + `TENANT_HOST`/`hostForKey`; `login({key})` sends the tenant's own host |

The S1 sweep itself (110 host×path combinations, 0 × 421, 0 × `Set-Cookie`, byte-identical
bodies) lived in a scratch QA harness, not in the repo — its in-repo representative is
`test/admin-listener.test.ts` (b)/(c)/(d), which is where the sweep's assertions were, and
those are what were rewritten. A 110-row sweep asserting today's promise would now have to
assert the *opposite* for tenant hosts (`/admin` is 200/404-by-session, not a page miss), so
re-creating it as-is would be re-asserting the retired rule under a new name.

### Added

- `test/integration/three-hosts.test.ts` — 4 new tests (the cross-host proof, §4). It is the
  one file whose name already claims "one process, three hosts", and its budget row is below
  `staleCheckFloorMs` so adding to it does not invalidate a recorded measurement.
- `test/admin-listener.test.ts` — 8 tests replacing 6.
- `/fleet/logout` (a session you cannot end is a defect, not a scope decision).

---

## 6. What still depends on the old admin host

`SKW_ADMIN_ORIGIN` is still **required** and still parsed at boot (`app/env.ts`), and is now
read for exactly one thing:

| Where | What it does now | Status |
|---|---|---|
| `app/env.ts` `adminHostOf()` | host component of `SKW_ADMIN_ORIGIN` | kept; the value is only used to derive the demos host |
| `tools/nginx_gen.ts` `main()` | `demosHostOf(adminHost)` → `demos.<domain>` | kept — the demos vhost still needs a name derived from somewhere |
| `docker-compose.yml` | `SKW_ADMIN_ORIGIN: ${SKW_ADMIN_ORIGIN:?...}` | kept; the container still refuses to boot without it |
| `install.sh` | `--admin-host` / `$ADMIN_ORIGIN`; writes `SKW_ADMIN_ORIGIN` into `.env`; mints the **default** cert pair for `$ADMIN_HOST` and `$DEMOS_HOST` | kept; the closing sign-in line now prints the tenant host, not this one |
| `tools/install_certs.mjs --default-host` | SAN set of `default.crt` | still includes the admin host; only the **demos** vhost uses `default.crt` now, so the admin entry in that SAN set is dead but harmless |
| `tools/install_check.mjs` enrolment file | reads `admin:` for the human-facing address; **no longer** used as the `Host` | the line is still written by `skwc`/`install.sh`; the probe prints a note when it differs from the tenant host |
| `docs/DEPLOY.md` §"Sign in" | `https://admin.example.com/admin/login` | **stale text** — a docs fix, not a code dependency; deliberately left for the docs pass so this change does not touch deploy prose |
| `test/env.test.ts`, `test/install*.test.ts`, `test/onboarding.test.ts`, `test/plugin-revocation.test.ts` | fixtures still set `SKW_ADMIN_ORIGIN=https://admin.skw.test` and pass `--admin-host` | intentional: they assert the variable is still required |

**A tenant may now claim `admin.<domain>` as its own hostname.** The generator no longer
reserves the name (there is no admin vhost to shadow), and a test asserts that a config for
such a tenant emits a tenant block and no admin block. If that ever mattered, the fix is a
reserved-name list in `control.db`, not a vhost.

---

## 7. Costs and residual risks, stated

1. **C-25 is gone (§2a).** Same-origin admin means tenant-authored script in a served page
   can call `/admin` with the operator's cookie. Mitigations are `SameSite=Strict`, the
   per-tenant cookie name, `Path=/admin`, and the fact that the admin is JS-free — not a
   proof of isolation. The strongest statement available now is: *an operator who is signed
   in, viewing a page that contains live script on a host they administer, has given that
   script their admin session.*
2. **`/admin` is a fingerprintable surface** on every tenant host. Deliberate.
3. **`SameSite=Strict` costs a sign-in** when a link is followed from outside the site.
4. **A plain-http deployment cannot log in** (Secure cookie + `https` Origin rule). Every
   shipped host has a certificate, so this is a configuration error, not a use case.
5. **The login is now tenant-scoped**, so an operator with the right password on the wrong
   host gets a 401 identical to a wrong password. That is the anti-oracle half of the old
   design surviving where it is free.
6. **`/fleet` is discoverable** on a host the tenant already controls (its login form is at
   `/admin/login` like any other). Its *contents* are not; `GET /fleet` for a tenant session
   is the page-miss 404.
7. **Test budgets were re-measured, not hand-edited.** `test/timeout-budget.test.ts`
   checks the sha256 of every row ≥ 3000 ms, and this change edits both nginx e2e files.
   `node scripts/measure/test-file-budgets.mjs --files test/nginx-e2e.test.ts,
   test/nginx-media-e2e.test.ts,test/nginx-gated-e2e.test.ts --repeat 2` caught an idle
   window (load 7.16–7.86 on 8 cpus) and recorded real runs: nginx-e2e 8903 → **11263 ms**
   (two extra round trips: the empty-header case now goes to a tenant host, plus the
   old-admin-hostname 404), nginx-media-e2e 9212 → **9115 ms** (unchanged within noise —
   its only edit was dropping an option), nginx-gated-e2e 2633 → **2595 ms**.
   `TEST_TIMEOUT_MS` is still 4 × 31149 ms = 125000 ms from `first-boot-tls`, so neither
   file sets the budget. The `test/integration/three-hosts.test.ts` row (605 ms) is below
   `staleCheckFloorMs`, so its bytes are not checked and the four added tests cannot make a
   recorded measurement stale — the row is understated now, which is the honest state of a
   small file on a shared box whose load never sat at zero long enough to re-measure it.

---

## 8. Gate

`make test` (build + typecheck + every node test + `verify-dist` + `verify-no-leak`),
recorded at the end of the change:

```
27/27 passed, 0 skipped, 0 failed          (verify-claims)
PASS the SDS quotes the register           (verify-frozen)
# tests 621
# pass 621
# fail 0
# skipped 0
verify-dist: 6/6 passed — the artefact on disk is the one asserted
verify-no-leak: clean — 0 skw-* containers, 0 skw-* networks
exit=0
```

Baseline before this change was the same command: 617 tests, 617 pass, exit 0. The +4 is
arithmetic over per-file `# tests` counts, not an impression:

| File | Before | After | Δ |
|---|---|---|---|
| `test/integration/three-hosts.test.ts` | 11 | 15 | **+4** (the cross-host proof) |
| `test/admin-listener.test.ts` | 6 | 8 | **+2** (rewritten, two cases split out: `/fleet` for an owner, `/fleet` for a fleet session) |
| `test/tenancy/resolve.test.ts` | 20 | 18 | **−2** (rows 1 and 7 and E-1 (a) removed with their gates relocated; one D37 test added) |
| `test/login-ambiguity.test.ts` | 5 | 5 | 0 (one rewritten, one added, one removed) |
| everything else | — | — | 0 |

No test was deleted to make the suite green: every retired assertion is either rewritten in
place with a named note or replaced by a stronger one (two refusals instead of one), and
`SKW_ALLOW_SKIP` was never set. `git grep SKW_ALLOW_SKIP` in the change shows only the
runner's own error text.
