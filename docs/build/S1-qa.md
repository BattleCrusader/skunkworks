# S1 — Hosting core: independent QA

**Reviewer:** QA (independent of the builder). **Date:** 2026-10-20.
**Tree:** `/Volumes/Backup/Development/skunkworks`, uncommitted, as delivered.
**Verdict: NO-GO.** Two blockers (B1, B2). The 9/9 claim is true as written and every named
gate has teeth — I broke each behaviour and watched its test go red — but the listener split
and the tenant map both fail the slice's own frozen rules once the system is running, and one
of them is the rule C-25 exists to enforce.

Environment I measured on: macOS 15.7.4, Node v22.23.1, Docker 29.7.2, nginx `1.31-alpine`,
`/usr/bin/python3` 3.9.6 / SQLite 3.43.2, Homebrew `python3` 3.14.6 / SQLite 3.53.4.

---

## 0. Summary

| # | Severity | Defect |
|---|---|---|
| B1 | **blocker** | `listenerFor()` treats `/admin/*` on **any** Host as the admin listener. Every production tenant's own site serves the admin surface; §9.1 says one hostname, §5.6 says a host that serves tenant-authored HTML never serves the admin. The test suite asserts the hole (`admin-listener.test.ts:68`). |
| B2 | **blocker** | A tenant suspended (and, by the same branch, archived) or flipped to `mode='demo'`, a deleted domain and a raised `db_version` are invisible to the running process until a restart. Frozen step 9 says a suspended tenant is 404; measured 200. (§5.4's stamp is the cause — a spec defect the builder disclosed — but the runtime contradicts an S1 acceptance criterion.) |
| M1 | major | `X-Forwarded-Prefix` is not cleared on host-routed locations, so any client sets `tenant.prefix`. Measured through real nginx: `prefix: "/demo/evil"`. |
| M2 | major | Every non-`AppError` is answered with `SKW_E_PLT_TENANT_UNAVAILABLE` at whatever status the framework chose: a 400 (bad JSON) and a 413 (>16 MiB) both carry a code the frozen map defines as 503. §4.3 says a body is always JSON `{error:{code}}`, one code per failure. |
| M3 | major | A new tenant/domain added to `control.db` is not routed at the edge: nginx's `server_name` list is generated at install and nothing reloads it. §5.4 promises "picked up on the next request without a restart". Measured: edge 404 for a host the app would serve. |
| m1 | minor | The "converges exactly (53 objects)" assertion is a name/column comparison; `migrate.test.ts` compares `(type,name)` only. Full-SQL comparison shows 11 textual diffs (harmless quote-wrapping) — the *claim* is stronger than the *check*. |
| m2 | minor | `Retry-After` is never asserted over HTTP. Suppressing the header entirely leaves 40/40 S1 tests green. |
| m3 | minor | `env.test.ts:97` spawns the app with no timeout; with the boot refusal removed the suite **hung** (>180 s) instead of reporting red. |
| m4 | minor | Demo key length: nginx allows 32 chars (`{0,31}`), §5.1/§5.3 allow 63. Keys of 33–63 chars are valid to the app and unreachable through `/demo/`. |
| m5 | minor | A >16 MiB body through the edge is nginx's **HTML** 413, not a taxonomy body. |
| m6 | minor | HTTP/1.1 with no Host at all returns `{}` with 400 (Node/Fastify, before the app). |
| m7 | minor | The Makefile pin's comment ("/usr/bin/python3 on macOS/Linux ships it") is false on most Linux, and pinning to SQLite 3.43 means the `legacy_alter_table` fix is never exercised by the default gate. |

**The one thing most likely to break in week one of real traffic:** onboarding. Add a tenant
or a second domain to `control.db` and the host 404s at the edge until somebody re-runs
`tools/nginx_gen.ts` and reloads nginx — the app's cache refresh creates the illusion that the
change is live (M3, measured below). The first paying customer's new domain is the first 404.

---

## 1. The gates, run from a clean shell

Everything below was run with a scrubbed environment
(`env -i HOME=… PATH=/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin:/usr/sbin:/sbin`).

```
$ make test
…
PASS  13 must-ignore + 7 must-keep = 20 paths behave as intended
PASS  1 schema/ER parity + negative tests …
PASS  2 cp loses data, VACUUM INTO keeps it …
…  (27 claim checks, all PASS)
PASS  27 connection classes: query_only is not tenancy (C-15) …
PASS the SDS quotes the register
# tests 75
# pass 75
# fail 0
# skipped 0
EXIT=0
```
29 `PASS` verdict lines (27 claim checks — check 1 is the schema-parity line — plus the
gitignore and frozen-quotes gates), 75/75 node tests, 0 skipped — the nginx e2e really ran (a
skip would show as `# skipped 1`).

```
$ make verify-s1
# tests 75
# pass 75
# fail 0
# skipped 0
EXIT=0
```

Compose, checked myself rather than taken from the report:

```
$ docker compose --env-file .env.example config --services
acme
app
nginx
plugin-runner
$ docker compose --env-file .env.example config --format json | …
services ['acme', 'app', 'nginx', 'plugin-runner']
app.ports None
app.expose ['3000']
runner.network_mode none
nginx.ports [80/tcp, 443/tcp]
```

So the headline claim — 9/9, `make test` green — is **true**. The rest of this document is
about whether green means what the report says it means.

---

## 2. Negative controls — can the gates fail?

Method for every control: copy the file to a scratch baseline, `shasum -a 256` it, mutate,
run the named suite, restore from the copy, re-hash, run green. No file was left modified;
the six baselines are listed in §2.6.

### 2.1 Trust a client-supplied tenant header on a host-routed location

Two halves, because the property has two implementations.

**(a) the edge.** `snippets/skunk-proxy.conf`, the line that makes the claim inert:

```diff
-proxy_set_header X-Skunkworks-Tenant "";          # fail closed: a client claim never survives
+proxy_set_header X-Skunkworks-Tenant $http_x_skunkworks_tenant;
```

```
$ node --test test/nginx-e2e.test.ts
not ok 5 - through real nginx: a client-supplied tenant header is stripped by the snippet
  error: |-
    The input did not match the regular expression /Acme pricing/. Input:
    '<!DOCTYPE html>\n' +
      '<html lang="en" data-tenant="beta">\n' +
      '<title>Beta pricing</title>\n' …
# tests 6
# pass 5
# fail 1
```
*(the HTML body is trimmed with `…`; the full body was Beta's page, `<html lang="en" data-tenant="beta">`)*
A client sending `X-Skunkworks-Tenant: beta` to `acme.test` got **Beta's page**. That is a
cross-tenant read, and it is exactly the failure mode the criterion names.

**(b) the app.** Remove step 2 from `app/tenancy/resolve.ts` (`if (false && hdrNonEmpty && …)`):

```
not ok 2  - step 2 — a non-empty tenant header without the edge token is 421
  error: |-
    Expected values to be strictly equal:
    true !== false
not ok 11 - inert 1 — a client header with no edge token is refused, not honoured
not ok 12 - inert 2 — a client header with a guessed edge token is refused, not honoured
# tests 16
# pass 13
# fail 3
```

Restored: `78d68f77…` (snippet) and `660b6b88…` (resolve.ts); e2e 6/6 green, unit 16/16 green.

### 2.2 Make the app rewrite the inbound path under `/demo/` (double strip)

`app/main.ts`, in `resolveRequest()`:

```ts
let pathname = pathnameOf(req.url);
// NEGATIVE CONTROL: the app strips the prefix a second time (C-2's double strip).
if (req.headers['x-forwarded-prefix'] !== undefined && pathname !== '/') {
  pathname = pathname.replace(/^\/[^/]*/, '') || '/';
}
```

```
not ok 1 - GET /demo/acme/whoami -> path=/whoami, tenant_header=acme, query preserved
  error: |-
    Expected values to be strictly equal:
    '/' !== '/whoami'
not ok 2 - POST /demo/acme/whoami carries its body through the prefix location
# tests 6
# pass 4
# fail 2
```

Restored `343c6d15…`; prefix suite 6/6.

### 2.3 Let the admin listener accept a demo Host

`app/main.ts`, the C-25 guard:

```diff
-if (listener === 'admin' && host !== null) {
+if (false && listener === 'admin' && host !== null) {
```

```
not ok 1 - a demo Host is 421 on the admin listener
  error: |-
    Expected values to be strictly equal:
    404 !== 421
# tests 5
# pass 4
# fail 1
```

Restored `343c6d15…`; 5/5.

### 2.4 Remove the `^SK_|^SKUNK_` boot refusal

`app/env.ts`, `assertNoDeletedPrefixes()` made a no-op:

```
$ node --test --test-timeout=15000 test/env.test.ts
not ok 1 - a deleted SKUNK_ key refuses the boot and names both the key and its replacement
  error: 'Missing expected exception.'
not ok 2 - a deleted SK_ key refuses the boot and names it
  error: 'Missing expected exception.'
not ok 3 - the refusal lists every offending key, sorted, each with its replacement
  error: |-
    + []
    - [ 'SKUNK_MODE -> SKW_FLEET_MODE',
    -   'SK_DDL_MAX_STATEMENTS -> SKW_DDL_MAX_STATEMENTS' ]
not ok 7 - the real process refuses to start and exits non-zero, naming the key on stderr
  error: |-
    The input did not match the regular expression /SKUNK_EDGE_TOKEN/. Input:
    'migrate: tenant broken failed (SQLITE_NOTADB) — serving 503 alone\n' +
      'registry: tenant broken skipped (SQLITE_NOTADB)\n' +
      'refusing to start: EADDRINUSE\n'
# tests 8
# pass 4
# fail 4
```

**Finding inside the control (m3).** Without `--test-timeout` this suite did not fail — it
**hung** for >180 s (my run was killed at 180 s). `test/env.test.ts:97` calls `spawnSync` with
no timeout, so when the refusal regresses the child boots and listens and the parent waits
forever. In CI that is a job timeout, not a red test with a message.

Restored `c67cf7e9…`; 8/8.

### 2.5 Delete the slash-less 301 rule

Removed from both `tools/nginx_gen.ts` and the committed `nginx/conf.d/10-app.conf` (so the
drift gate would not mask the result):

```
$ node --test test/nginx-config.test.ts
not ok 3 - the slash-less demo form 301s to the slash form
  error: |-
    The input did not match the regular expression /return 301 \/demo\/\$demo_key\/\$is_args\$args;/
not ok 8 - the committed nginx/conf.d/10-app.conf is the generator output for this fixture
# tests 9
# pass 7
# fail 2

$ node --test test/nginx-e2e.test.ts
not ok 3 - through real nginx: /demo/beta 301s to /demo/beta/ and keeps the query
  error: |-
    Expected values to be strictly equal:
    404 !== 301
# tests 6
# pass 5
# fail 1
```

Restored `b603bfe5…` and `9912ed65…`; 15/15 across both suites.

### 2.6 An extra control the brief did not ask for: `Retry-After`

§5.3 freezes `SKW_E_DM_SCHEMA_STALE` as `503 + Retry-After: 5` and `SKW_E_DM_BUSY` as
`503 + Retry-After: 1`. Suppressing the header in `sendError()`:

```ts
// NEGATIVE CONTROL: Retry-After header suppressed.
if (false && err.retryAfter !== undefined) reply.header('retry-after', String(err.retryAfter));
```

```
$ node --test … test/tenancy/resolve.test.ts test/integration/three-hosts.test.ts test/migrate.test.ts …
# tests 40
# pass 40
# fail 0
```

**The frozen `Retry-After` clause has no gate.** The unit test asserts `err.retryAfter` on the
object; nothing asserts the HTTP header. A one-line regression here ships silently.

### 2.7 Restore proof

```
$ shasum -a 256 snippets/skunk-proxy.conf app/tenancy/resolve.ts app/main.ts app/env.ts tools/nginx_gen.ts nginx/conf.d/10-app.conf
78d68f77…  snippets/skunk-proxy.conf
660b6b88…  app/tenancy/resolve.ts
343c6d15…  app/main.ts
c67cf7e9…  app/env.ts
b603bfe5…  tools/nginx_gen.ts
9912ed65…  nginx/conf.d/10-app.conf
$ diff baseline.sha256 <(shasum -a 256 …)  &&  echo RESTORED
ALL SIX FILES RESTORED TO BASELINE
$ make test          # after every mutation was reverted
# tests 75 / # pass 75 / # fail 0 / EXIT=0
$ git status --short
(empty)
```

**Score: 5 of 5 named controls went red, 0 deadweight among them.** One of the five fails by
hanging rather than reporting (m3), and one frozen clause (Retry-After) has no control at all.

---

## 3. Attempts to defeat the implementation

Harness: the real app on a fixture `control.db`/`site.db` set **and** `nginx:1.31-alpine`
running the generated `10-app.conf` + the rendered snippet, exactly as the e2e suite does
(two substitutions: `listen 443 ssl` → `80`, `proxy_pass app:3000` → the host gateway).
Every request below is a raw socket, so `Host` and duplicate headers are exactly mine.

### 3.1 Header spoofing

| Sent | Got | Contract? |
|---|---|---|
| edge `acme.test` + `X-Skunkworks-Tenant: beta` | 200, `data-tenant="acme"` | ✅ inert |
| edge `acme.test` + `beta` + the **real** edge token | 200, `data-tenant="acme"` | ✅ inert (snippet overwrites after the include) |
| edge `acme.test` + `beta,beta` | 200, `acme` | ✅ |
| direct to app `acme.test` + `beta` + real token, loopback peer | 200, **`beta`** | ✅ by contract (edge proof), ⚠️ the app is one published port away from being wide open; it is not published |
| direct `acme.test` + `beta`, no token | 421 `SKW_E_PLT_EDGE_PROOF` | ✅ |

### 3.2 POST bodies under `/demo/`

| Sent | Got |
|---|---|
| `POST /demo/acme/whoami`, 1 MiB | 200, `path=/whoami`, `body_bytes=1048576`, `tenant_header=acme` ✅ |
| same, `Transfer-Encoding: chunked`, 5 B | 200, `body_bytes=5` ✅ |
| same, 17 MiB | **413 with nginx's HTML page** — not a taxonomy body (m5) |
| direct `POST /whoami`, 17 MiB | 413 `{"error":{"code":"SKW_E_PLT_TENANT_UNAVAILABLE"}}` — a 503 code on a 413 (M2) |

### 3.3 Traversal and key shape in the demo path

| Sent (`Host: demos.skw.test`) | Got | Reading |
|---|---|---|
| `/demo/../acme/whoami` | 404 | nginx normalises before matching; no traversal |
| `/demo/%2e%2e/acme/whoami` | 404 | decoded then normalised; no traversal |
| `/demo/acme/../acme/whoami` | 200 `path=/whoami` | normalises to the same demo path |
| `/demo/acme%2f..%2f..%2fadmin/t/acme/pages` | 404 | did not reach the admin |
| `/demo/acme%2Fwhoami` | 200 `path=/whoami` | encoded slash == slash; same tenant |
| `/demo/ACME/whoami` | 404 | no case folding ✅ (§5.5) |
| `/demo/a..b/whoami` | 404 | nginx regex excludes `.` |
| `/demo/` + 33 chars, `/demo/` + 63 chars | 404 at nginx | see m4: 33–63 is a legal key per §5.1 |
| `/demo/-abc/whoami` | 404 | ✅ |
| `/demo/acme%00/whoami` | 400 | ✅ |

### 3.4 Tenant-key shape (direct, with the real token)

`ACME`, `acmé`, 64 chars, `-acme`, `acme_1` → **400 `SKW_E_PLT_TENANT_HEADER`** each. ✅
Empty header → 200 via Host. ✅
`Host: ACME.TEST` → 200 acme; `acme.test.` → 200; `acme.test:8443` → 200; `acme.test@evil.example`
→ 400 at nginx. ✅ (case/port/dot folding is the documented normalisation)

### 3.5 Two domains → one tenant; one domain → two tenants

`www.acme.test` → acme (in the three-hosts suite). ✅
`INSERT INTO domain(host,tenant_id) VALUES('beta.test', 1)` → `SQLITE_CONSTRAINT_UNIQUE`. ✅
One host cannot map to two tenants.

### 3.6 A request during a tenant-map cache invalidation (M3 + B2)

App-direct, raw sockets, mutations applied by a second `control.db` connection while the app
is serving:

```
warm acme.test                                   | 200 OK acme
warm beta.test                                   | 200 OK beta
after DELETE domain acme.test                    | 200 OK acme          <- deleted host still routes
after INSERT domain new.test                     | 404 Not Found SKW_E_PLT_TENANT_UNKNOWN
after UPDATE beta.status = 'suspended'           | 200 OK beta          <- step 9 never fires
after UPDATE beta.db_version = 9                 | 200 OK beta
after UPDATE beta.mode = 'demo'                  | 200 OK beta          <- C-25's guard stays off
after INSERT tenant gamma (the stamp changes)    | 404 new.test  /  404 acme.test  /  404 beta.test
after UPDATE beta.key = 'beta-renamed'           | 404 (beta is suspended — masked, not proof)
```

The last three lines are the proof that the refresh *mechanism* works: the tenant-count change
made the process rebuild its maps, and the three earlier lies corrected themselves at once. A
clean run without the earlier suspension shows the same thing from the other side:

```
newhost.test before insert       404 SKW_E_PLT_TENANT_UNKNOWN
newhost.test after domain insert 404 SKW_E_PLT_TENANT_UNKNOWN   (stamp unchanged -> stale)
newhost.test after tenant insert 200 beta                        (stamp changed -> refreshed)
```

Everything that did not change `MAX(control_migration.id) || count(tenant)` stayed wrong:
a suspended tenant served, a deleted domain routed, a demo flip did not arm the C-25 guard.
Ten minutes of direct SQL, no attacker required.

### 3.7 Edge-level: new host after onboarding

Through real nginx, `Host: new.test` (a host the app serves once the stamp changes — measured
directly above: `200 beta`) → **404 with nginx's HTML**, because `10-app.conf` has no `server`
block for it. The app's cache refresh cannot help; nothing regenerates nginx. This is M3 and it
is the week-one failure.

### 3.8 Missing / unknown Host

```
edge  HTTP/1.0, no Host        | 404 (nginx default_server HTML)      ✅ no default tenant
direct HTTP/1.0, no Host       | 404 SKW_E_PLT_TENANT_UNKNOWN         ✅
direct HTTP/1.1, no Host       | 400 {}(empty JSON, before the app)   m6
edge  unknown Host             | 404 (default_server)                 ✅
direct Host: localhost         | 404 SKW_E_PLT_TENANT_UNKNOWN         ✅
```

### 3.9 The one that matters: `X-Forwarded-Prefix` (M1)

§5.1 says `X-Forwarded-Prefix` exists on **path-prefix locations only**; §5.5 says it is "the
only source of `tenant.prefix`" and that every URL is prefixed "exactly once". The snippet
clears the tenant header on host-routed locations but **not** the prefix:

```
edge   GET /whoami  Host: acme.test  X-Forwarded-Prefix: /demo/evil
       → 200 {"tenant":"acme","via":"host","prefix":"/demo/evil"}
direct GET /whoami  Host: acme.test  X-Forwarded-Prefix: /demo/acme
       → 200 {"tenant":"acme","via":"host","prefix":"/demo/acme"}
```

No token, no trusted peer, one header. Today the only consumer is `/whoami` (S1 renders a page
with no links), which is why this is a major and not a blocker — but the resolver is the thing
S3/S4 will build `site.url()` on, and a client-chosen prefix is `/demo/<attacker>/…` on every
link the site emits, plus the double-prefix 404 the SDS spends a paragraph forbidding.
**The fix belongs in `snippets/skunk-proxy.conf`** (clear it on host-routed locations, exactly
as it clears the tenant header), not in the app.

### 3.10 Demo Host vs the admin listener

```
edge   acme-demo.test  /admin/t/acme/pages  | 421 SKW_E_PLT_EDGE_PROOF  ✅
edge   demos.skw.test  /admin/t/acme/pages  | 404 at nginx (no /admin location) ✅
direct acme-demo.test  /admin/t/acme/pages  | 421 "a demo host never serves the admin listener" ✅
direct acme-demo.test  /admin%2Ft%2Facme    | 404 (not classified admin) ✅
direct acme-demo.test  /pricing             | 200 demo tenant ✅
```

The 421 half is genuinely built. The half that is missing is B1, below.

---

## 4. Blocker detail

### B1 — the admin listener is every tenant host

`app/main.ts:57-62`:

```ts
export function listenerFor(pathname: string, host: string | null, adminHost: string | null): Listener {
  if (adminHost !== null && host === adminHost) return 'admin';
  if (pathname === '/admin' || pathname.startsWith('/admin/')) return 'admin';
  return 'public';
}
```

A tenant server block proxies `location /` — every path, including `/admin/…` — with the
snippet. So `https://acme.test/admin/t/acme/pages` arrives with `listener='admin'`, and the
only host that is refused is one whose tenant has `mode='demo'`. The builder's own test states
it as intended behaviour (`test/admin-listener.test.ts:68`):

```
listenerFor('/admin/t/acme/pages', 'acme.test', 'admin.skw.test') === 'admin'   // asserted
```

Against the frozen text:

- §9.1: "The admin surface is a **hostname**, `admin.<domain>`, behind nginx." — the listener is
  identified by hostname, not by a path.
- §5.6: "A host that serves tenant-authored HTML **never serves the admin listener**." Every
  production tenant host serves tenant-authored HTML (that is the product). Not just demos.
- §9.2: "Two sources of truth for 'which tenant am I editing' is how an operator edits tenant B's
  homepage while looking at tenant A's page list — a cross-tenant **write** by a trusted user."
  With this rule, `acme.test/admin/t/beta/pages` is the admin listener (session decides the
  tenant) on a Host that is also a public tenant origin — the two sources, on one origin, in one
  request. The demo guard does not fire, because acme is not `mode='demo'`.
- §17 traceability: C-25 is an **S1** gate, "listener/Host test". The gate proves the demo case
  and enshrines the production case.

Why it is a blocker and not a nit: S2 puts `session.tenant_id` and `__Host-sk-sess` on this
listener. If the listener is every tenant host, then every tenant's own site is an admin
surface — the same-origin condition C-25 was written to prevent, one tenant-mode check away
from being live. It is invisible today only because `main.ts` passes `session: null`, so
`/admin/…` answers 404 everywhere (the builder says so in §3 of their report). The correct
shape is `listener = (Host === admin host)`, with C-25 as a separate guard on **any** request
whose Host maps to a tenant, not as a listener class. The builder's reason for the path rule
("it is what makes C-25's rule reachable") is satisfied by the guard alone — the guard already
runs before step 7 and does not need the listener to be `admin`.

### B2 — step 9 does not fire at runtime

§5.3 step 9: "tenant resolved but `tenant.status ∈ {suspended, archived}` → 404". Measured:
`UPDATE tenant SET status='suspended'` on a served tenant, next request → **200**. Same for
`archived`, for `mode='demo'`, for `db_version`, and for a deleted `domain` row (which keeps
routing). Cause: `TenantMap.stamp()` is `MAX(control_migration.id) || count(tenant)` (§5.4
verbatim), which none of those changes move.

The builder disclosed this as SDS defect 5.5 and implemented the spec as written, which is
correct behaviour for a builder and still leaves the slice unshippable in this area: "suspend"
is the one control an operator reaches for during an incident, and it does nothing until a
restart. The same blindness is what makes M3 invisible. The fix is one counter — a
`control_change` row bumped by triggers on `tenant`/`domain`, or `PRAGMA data_version` on the
control handle — and it belongs to the spec, not to a later slice.

---

## 5. Judging the five claimed SDS defects

### 5.1 §5.3 steps 5, 7, 8 are not jointly satisfiable as ordered — **REAL**, narrower than claimed

The claim is true as a matter of text. Steps 5, 7 and 8 have overlapping predicates in a table
the SDS calls an algorithm "in order":

- step 5 fires on `hdr` non-empty and valid, so a non-empty valid header never reaches step 8;
- step 8 fires on `hdr` "present at all" (which includes `""`), so an empty header on admin
  never reaches step 7's session branch.

Therefore step 8 is unreachable if the rows are executed in numeric order, and steps 7 and 8
contradict each other for the empty header. **Real.**

One correction to the builder's framing: the production impact is nil, and for a reason the
report does not state. nginx omits a header whose `proxy_set_header` value is `""` (documented
behaviour: an empty header field is not passed to the proxied server), so the admin vhost
presents *no* tenant header at all. Measured through the real edge — the app answers step 7
(session, 404), never step 8 (421):

```
edge admin.skw.test /admin/t/acme/pages | 404 SKW_E_PLT_TENANT_UNKNOWN   (not 421)
edge admin.skw.test /admin              | 404 SKW_E_PLT_TENANT_UNKNOWN
direct (no proxy) same request          | 404 SKW_E_PLT_TENANT_UNKNOWN
```

So the reorder changes behaviour only for a direct connection or a future proxy that forwards
empty headers — where it would 421 **every** admin request. Correct spec text: make the three
conditions disjoint ("listener is admin and a tenant header is present at all" as a **guard**
before 5; step 7 as "no header present at all"), and add the sentence "an empty
`proxy_set_header` value is omitted by nginx, so the admin vhost presents no header".

### 5.2 §5.3 has no mechanism for "listener is admin" — **REAL as a gap; the implementation's answer is B1**

The table uses `listener` and never defines it; §9.1 only says the admin surface is a hostname.
The builder's definition (path prefix **or** admin Host) is the wrong half of that gap: it
makes every tenant host an admin listener. Correct text: `listener = 'admin'` iff the request's
Host equals the host of `SKW_ADMIN_ORIGIN`; C-25 is enforced by a separate rule ("any request
whose Host maps to a tenant with `mode='demo'` is 421 on the admin listener"), not by widening
the listener.

### 5.3 §16 S1 requires a slash-less 301 that §12.3 does not produce — **REAL**

§12.3's regex is `^/demo/(?<demo_key>[a-z0-9][a-z0-9-]{0,31})(/.*)?$` — `/demo/acme` matches
with an empty suffix, so it enters the block, but `rewrite "^/demo/…/(.*)$" /$1 break;` needs a
trailing slash and does not fire, so `proxy_pass` forwards `/demo/acme` and the app 404s (the
app is forbidden to strip). The gate in §16 demands a 301. Two more defects in the same §12.3
fragment, which the report did not list: the `{0,31}` is unquoted and nginx's tokenizer reads
`{` as a block delimiter (**emerg** at load), and the `location` is shown outside any `server`
block. Correct text: add

```nginx
location ~ "^/demo/(?<demo_key>[a-z0-9][a-z0-9-]{0,31})$" { return 301 /demo/$demo_key/$is_args$args; }
```

before the proxying location, quoted, inside the demos `server`.

### 5.4 §4.3 has no code for "page not found in a resolved tenant" or an unhandled 500 — **REAL**

`schema/error-codes.json` holds 67 codes (`areas` sum) and 47 HTTP mappings; the 20 unmapped
ones are all `SKW_E_PL_*` (JSON-RPC, fine). The only 404 is `SKW_E_PLT_TENANT_UNKNOWN` and the
only PLT 5xx is `SKW_E_PLT_TENANT_UNAVAILABLE`. So a resolved tenant with no `cms_page` row
must answer "no tenant", which is false, and there is nothing for a 500. **Real.** Correct
text: add `SKW_E_RT_PAGE_NOT_FOUND` 404 and `SKW_E_PLT_INTERNAL` 500 to §4.3 and the JSON.

The implementation then makes it worse than the spec forces (M2): every non-`AppError` is
mapped to `SKW_E_PLT_TENANT_UNAVAILABLE` at *whatever* status the framework chose, so a 400 and
a 413 carry a code the frozen table defines as 503. Even without new codes, a framework error
should not borrow a code whose HTTP mapping disagrees.

### 5.5 §5.4's version stamp cannot see an update — **REAL, and I measured it**

`MAX(control_migration.id) || tenant count` does not move for a status flip, a mode flip, a
domain insert/delete, or `db_version`. Measured in §3.6: suspended tenant 200, deleted domain
200, demo flip 200, new host 404 — all corrected at once by an unrelated tenant insert. **Real.**
Correct text: a control-plane change counter incremented by triggers on `tenant` and `domain`
(read once per request, same cost as today's `count(tenant)`), or `PRAGMA data_version` on the
`control.db` handle. The builder's own §5.5 names `tenant.updated_at`; that misses `domain`,
which is the case that leaves a deleted host routing.

### 5.6–5.10, briefly

| Claim | Judgement |
|---|---|
| 5.6 `UV_THREADPOOL_SIZE` cannot be changed by a boot assert | **Real** and the right call (refuse). §2.3 should say "the image sets". |
| 5.7 "one block per host" vs one block per tenant with several `server_name`s | **Real**, cosmetic; grouped is what compiles. §2.3/§3 wording. |
| 5.8 §2.3 step 6 is S4 work | **Not a defect** — a slice boundary, correctly logged at boot. |
| 5.9 the gate has undeclared interpreter prerequisites | **Real.** Add: the pin hides the pragma it depends on (see §6). |
| 5.10 §3 lists `Dockerfile.runner`/`runner/`/`plugins/` in S1 | **Real**, harmless; those are S4. |

---

## 6. The two gate changes: legitimate, with one blind spot each

### 6.1 `PRAGMA legacy_alter_table = ON` in `scripts/model/verify_claims.py`

**Legitimate. It restores the semantics the frozen file was written for; it does not skip or
weaken an assertion.** I proved it is load-bearing rather than decorative — removed the pragma,
ran the gate on SQLite 3.53.4:

```
FAIL  10 root path '/' is insertable          OperationalError: error in trigger trg_cms_asset_delete_guard: no such table: main.cms_download_code
FAIL  12 asset delete guard holds …           (same)
FAIL  15 (jti) WHERE kind='first' …           (same)
FAIL  20 migration chain v1->v3 converges …   (same)
FAIL  22 redemption on the v3 tables …        (same)
FAIL  26 body ban + list loop contract …      (same)
EXIT=1
```

Restored (`fcd62b37…` verified by `shasum -c`); `/usr/bin/python3 scripts/model/verify_claims.py`
→ `27/27 passed, 0 skipped, 0 failed`, exit 0.

Why it is not a weakened assertion: `legacy_alter_table` only stops SQLite re-parsing unrelated
objects during `ALTER TABLE … RENAME`. The rebuild's end state still has to be the shipped
schema, and I checked the end state independently of the gate — a v1 file migrated to v3, then
`integrity_check`, `foreign_key_check`, all five trigger bodies, and the r3 CHECK:

```
migrate legacy: [{… "from":1,"to":3,"action":"migrated","ok":true}]
objects migrated=53 target=53 sql-text-diffs=11      (all `CREATE TABLE "x"` vs `CREATE TABLE x` from the rename)
cms_download_code CHECK present: true  (len 699)
integrity_check: ok
foreign_key_check: 0 rows
views 0, broken 0, triggers 5; two trigger bodies name cms_download_code and the table exists
```

So the workaround is sound. The blind spot is the *assertion*, and the report overstates it:

- `test/migrate.test.ts:99` compares `SELECT type, name FROM sqlite_master` only. A missing
  CHECK — the entire point of r3 — would pass. The report calls this "identical (53 objects)";
  it is a name-set comparison.
- `verify_claims.py:753` is stronger (table names, columns `(name, type, notnull)`, trigger
  **names**, FK check) but still not CHECKs or trigger bodies.

Recommended (not applied): compare `PRAGMA table_info` + the CHECK/trigger SQL text, ignoring
only identifier quoting.

**Does the app's migrate path need the same pragma? Yes — and it has it** (`app/db/migrate.ts:98`
for control, `:158` for tenants), so this is not a blocker. The app's path is what the test at
`migrate.test.ts:78` exercises, and that test passes on SQLite 3.50+ (my Homebrew run) and 3.43.

### 6.2 `PYTHON ?= $(shell test -x /usr/bin/python3 …)`

**Not a weakened assertion — an interpreter choice — but the comment is wrong and the choice is
convenient for the wrong reason.**

- It is what makes `make test` deterministic *on this box*: `/usr/bin/python3` is 3.9.6 with
  SQLite 3.43.2 and `argon2-cffi` present → 27/27, exit 0. Homebrew `python3` is 3.14.6 /
  SQLite 3.53.4 without `argon2-cffi` → `25/27 passed, 2 skipped, 0 failed`, **exit 2**, which
  `make test` treats as failure.
- `/usr/bin/python3 on macOS/Linux ships it` is false for most Linux distributions
  (`python3-argon2` is not in a default Debian/Ubuntu image). The pin moves a
  machine-dependent green/non-green from "whichever python3 is on PATH" to "whatever
  `/usr/bin/python3` is", which is more predictable but still undeclared.
- The pin also means the default gate runs on the one SQLite that never needed the fix, so
  §6.1's regression is invisible to `make verify-claims` unless someone overrides `PYTHON`. A
  second job on Homebrew python (or a `python3 -c 'import argon2'` preflight that fails loudly)
  would close both.

---

## 7. What I did not prove (and would not claim)

- No running compose stack. `docker compose config` is the S1 gate, and the two digest-pinned
  images do not exist. I did not attempt `up`.
- Nothing about S2/S3/S4: auth, sessions, byte serving, export, plugins. Where a finding
  depends on them (B1's exploit, M1's URL poisoning) I say so.
- The 192 r/s figure and the `SKW_BOX_RPS` derivation: unit-tested only.
- Load. Every request above was single-threaded; I did not measure rate limits or pool behaviour
  under concurrency.

---

## 8. Reproduction

```
cd /Volumes/Backup/Development/skunkworks
make test                     # 75/75, exit 0
make verify-s1                # 75/75, exit 0
node --test test/nginx-e2e.test.ts        # needs a docker daemon
```

The defeat harness and the cache/migration probes live outside the repo (scratch):
`defeats.ts` (app + real nginx), `cache2.mjs` (map cache, raw sockets), `newhost.mjs` (the
onboarding case), `followup.mjs` (oversized body, full-SQL migration comparison), `views.mjs`
(post-migration trigger/CHECK integrity). Logs: `make-test.log`, `make-test-final.log`,
`verify-s1.log`, `defeats.log`, `env-mut-2.log`, `baseline.sha256`, `verify_claims.sha256`.
The repo is byte-identical to the state I received: `git status --short` is empty and all six
baseline hashes match.

**Verification after the review** (negative-control mutations reverted): `hermes verify --json`
→ `ok: true`, every phase exit 0 (`bootstrap`, `build`, `typecheck`, `npm run test` 75/75,
`make test` 75/75, `make typecheck`, `make build`), readiness `http://127.0.0.1:4321/` → 200.
`git diff` over `app test nginx snippets tools schema Makefile package.json docker-compose.yml`
is empty; the only untracked file in the repo is this report.
