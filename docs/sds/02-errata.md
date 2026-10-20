# 02 — SDS errata (post-S1)

**Status:** amendment of record for `docs/sds/SDS.md`, issued after independent QA returned
**NO-GO** on slice S1 (`docs/build/S1-qa.md`) and the builder disclosed 10 defects in the SDS while
implementing it (`docs/build/S1-report.md` §4–§5).

**Date:** 2026-10-20. **Author:** Architect. **Scope:** the specification, not the code. No
implementation file is edited by this pass.

---

## 1. Why this file exists and how it relates to SDS.md and 00-adjudication.md (precedence order, stated explicitly)

S1 was built against `SDS.md` as written. Two of its defects are blockers — they produce a live
security hole and a control that does nothing until restart — and both were faithfully implemented,
because that is what the frozen text said. The builder's ten disclosed defects are not builder
errors either: nine of them are places where the SDS is unsatisfiable, self-contradictory, or silent
on a mechanism it assumes. Correcting the code without correcting the text ships the next slice into
the same two holes, and S2 is the slice that adds `session.tenant_id` to the surface B1 opened.

**Precedence, highest first, stated explicitly:**

1. **`docs/sds/02-errata.md` (this file)** wins over every other SDS artefact — but **only for the
   text it replaces**. It is silent on everything else, and its silence is not a decision.
2. **`docs/sds/00-adjudication.md` §4 (frozen contracts)** wins over `SDS.md` wherever the two
   differ — **except** in the exact places this file marks `SUPERSEDES`. There are five such
   markers: E-1 (the §4.1 step table), E-2 (the C-25 second clause), E-4 (the §4.2 code lists), E-11
   (the §4.1 snippet) and E-13 (the §4.2 body-shape sentence, for scope only). Each marker names the
   frozen text it replaces and the single reason the replacement is not a re-opening of the
   adjudication.
3. **`docs/sds/SDS.md`** wins over everything below it, for all text this file does not replace.
4. **`docs/sds/01-verification.md`, the build reports, and the tests** are evidence, not authority.
   Where a test contradicts this file, **the test is wrong** — including the test the builder wrote
   to assert B1 as intended behaviour.

**How SDS.md is amended.** `SDS.md` is not rewritten in this pass, deliberately: section numbers are
cited by the register, by the build reports and by the tests, and renumbering them would invalidate
every citation in `S1-qa.md`. Instead, each item below carries the replacement text **verbatim**, and
the last item of §4 has the builder paste it into the named section and add one pointer line at the
head of that section: `> Amended by 02-errata.md E-n.` No other edit to `SDS.md` is permitted.

**How to read an item in §2.** Every item has exactly four labelled parts: the **defect** (the SDS
section, and the QA/report finding that proves it), the **corrected text** (drop-in, implementable as
written), the **test that must change**, and the **severity**. Items are numbered E-1…E-15 and
nothing in this file refers to an item by anything else.

---

## 2. Errata E-1..E-15 — each: the defect (SDS section + report/QA finding) | the corrected text, VERBATIM, drop-in | what test must change | severity

### E-1 — §5.3's resolution table is not jointly satisfiable as ordered; step 8 is unreachable

**Defect.** `SDS.md` §5.3, table rows 5, 7 and 8 — and the identical table in
`00-adjudication.md` §4.1. Row 5 consumes every non-empty valid header, so row 8's predicate
("`hdr` present at all") can never be reached in numeric order; row 7 ("`hdr` absent or `\"\"`") and
row 8 ("present at all") contradict each other for the empty header. Proven by
`S1-qa.md` §5.1 (measured: the admin vhost never reaches 421, because nginx omits an empty
`proxy_set_header` value) and disclosed by the builder as `S1-report.md` §5.1 (who reordered step 8
before step 5 to make it reachable — a correct implementation of an incorrect table).

**Corrected text — drop-in for `SDS.md` §5.3, replacing the definitions line, the table, and the
status table.** `SUPERSEDES 00-adjudication.md §4.1`'s step table for **ordering and numbering
only**; every condition→outcome pair below is the frozen pair, and the one semantic choice is
stated in the paragraph after the table.

```markdown
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
```

**A second correction carried by the same table.** `schema/error-codes.json` — the frozen taxonomy —
maps `SKW_E_PLT_TENANT_UNAVAILABLE` to `Retry-After: 5`, and §5.3's table omitted the header. The
JSON is the authority for the HTTP mapping (§4.3), so the table above now carries it. Neither report
caught this; it is visible in `retry_after` in `schema/error-codes.json`.

**Test that must change.** `test/tenancy/resolve.test.ts` — the 10 cases must assert the **row number
the resolver reports**, and the numbering changes: the admin-plus-header case becomes row 1 (both the
non-empty and the empty value), the host case row 8, the session case row 7. Add: (a) an empty
`X-Skunkworks-Tenant` on the admin listener over a direct connection → row 1, 421; (b) the same
request through the real edge → row 7, 404, because nginx omits the empty header — this is the case
that distinguishes the two, and it needs `test/nginx-e2e.test.ts`; (c) no request with
`listener='public'` may report rows 1 or 7.

**Severity: major.** The S1 ten-case gate is written against this table; a right status from the
wrong row is already treated as a defect by that suite.

---

### E-2 — "the admin listener" has no mechanism; the implemented one makes every tenant host an admin

**Defect.** `SDS.md` §5.3 uses `listener` and never defines it; §9.1 says only that the admin surface
is a hostname; the mechanism that identified the listener was removed with the port (§9.1: "the admin
surface is a **hostname**"). The builder filled the gap with a path rule
(`S1-report.md` §5.2), which `app/main.ts:58` implements as
`pathname === '/admin' || pathname.startsWith('/admin/') → 'admin'` **on any Host** — so every
production tenant's own hostname serves the admin surface, contradicting §5.6 and §9.2, and
`test/admin-listener.test.ts:66–71` asserts it as intended. `S1-qa.md` §0 B1, §4 B1 and §5.2.
B1 is verified in the code, not alleged: `main.ts:58` and the assertion at
`test/admin-listener.test.ts:68`.

**Corrected text — drop-in for `SDS.md` §9.1, replacing the first paragraph, plus the §5.6, §16 and §17 replacements below.**
`SUPERSEDES 00-adjudication.md §2 C-25`'s **second clause** (the 421 for a demo `Host`) and the
identical sentence in `SDS.md` §5.6. One sentence why: C-25's first clause — *a host that serves
tenant-authored HTML never serves the admin listener* — is strengthened from "demo hosts" to **every**
tenant host, and the 421 it used to carry becomes unreachable and would be an oracle; the
adjudication's purpose (no tenant-authored HTML on the admin origin) is met more strongly, not less.

```markdown
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
```

**Also replaced — `SDS.md` §16, S1 acceptance criterion 5.** The old row ("a demo `Host` gets `421`
from the admin listener") no longer describes a reachable state. New row:

```markdown
| a demo `Host` cannot reach the admin surface: `/admin/…` is `404` with the same body as an unknown path, and no admin route is mounted on a public listener | listener test, positive and negative |
```

**Also replaced — `SDS.md` §17.1, row C-25**, column *Proved by*: `S1 (listener/Host test, absence of
the admin surface on every tenant Host)`. The verdict column is unchanged: **demo host ≠ admin host**.

**Also replaced — `SDS.md` §5.6**, second sentence. Drop-in:

```markdown
> A host that serves tenant-authored HTML never serves the admin listener: demos live at
> `demos.<our-domain>/demo/<key>/`, admin at `admin.<our-domain>`, and the admin surface is mounted on
> no other Host — so a demo page cannot reach it at all, and neither can a production tenant's page.
> `mode='demo'` no longer participates in that decision (§9.1 rule 4).
```

**Test that must change.** `test/admin-listener.test.ts`, wholesale:
(a) a `listenerFor` table — `('/admin/t/acme/pages','acme.test')` → `public`;
`('/admin','acme.test')` → `public`; `('/adminish','acme.test')` → `public`;
`('/admin/t/acme/pages','admin.skw.test')` → `admin`; `('/pricing','admin.skw.test')` → `admin`;
`('/admin', null)` → `public`; `('/admin','ADMIN.SKW.TEST.')` → `admin`;
`('/admin','admin.skw.test:8443')` → `admin` (case, trailing dot and port folding).
(b) HTTP, tenant host: `/admin/t/acme/pages` on `acme.test` → 404 `SKW_E_RT_PAGE_NOT_FOUND`, body
deep-equal to `/no-such-page` on the same Host after normalising `requestId`, **no** `Set-Cookie`.
(c) HTTP, demo host: the same path on `acme-demo.test` → the same 404, **not** 421.
(d) HTTP, admin host: `/admin/t/acme/pages` with no session → 404 `SKW_E_PLT_TENANT_UNKNOWN`;
`/pricing` on the admin host → 404 `SKW_E_PLT_TENANT_UNKNOWN`.
(e) generator: a `domain` row equal to the admin host or the demos host is refused by name
(`test/nginx-config.test.ts`).

**Severity: blocker (B1).** S2 lands `session.tenant_id` and `__Host-sk-sess` on this surface; with
the path rule, every tenant's own site is the surface.

---

### E-3 — §5.4's version stamp cannot see an update, a status change, or a domain deletion

**Defect.** `SDS.md` §5.4: the stamp is `MAX(control_migration.id) || tenant count`.
`app/tenancy/cache.ts:46–56` implements it verbatim. A tenant suspended or archived, a `mode` flip, a
`db_version` raise and a deleted `domain` row move neither term, so §5.3 row 9 never fires at runtime
and a deleted host keeps routing. Measured: `S1-qa.md` §3.6 (HTTP 200 after `status='suspended'`) and
§4 B2; disclosed by the builder as `S1-report.md` §5.5. The builder's own suggested fix
(`tenant.updated_at`) misses `domain`, which is the case that leaves a deleted host routing.

**Corrected text — drop-in for `SDS.md` §5.4, first paragraph, plus a new §5.4a.**

`````markdown
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

### 5.4a What happens when the counter moves mid-request

The stamp is read **exactly once per request**, before the map is consulted, and the generation it
selects is immutable for the rest of that request: the resolver never re-reads the stamp, never reads
a second generation, and never mixes a tenant row from one generation with a host list from another.
A write that commits while a request is in flight is therefore observed by the **next** request and
never by the one in flight; a request may serve from a generation one revision stale, and that window
is bounded by one request rather than by a restart. After a bump, concurrent requests perform **one**
rebuild and share it (single-flight); the rest wait on that rebuild instead of each running their own.
`````

**Schema and gate consequences (part of this item, not a separate one).** `schema/control.sql` gains
the table and the six triggers and is **regenerated** — `scripts/model/gen_schema.py`'s
`CONTROL_VERSION` becomes `3` and its `CONTROL` spec gains `control_revision`. A new
`schema/control-r3.sql` (hand-written, like `control-r2.sql`) carries the v2→v3 delta for an existing
box, and sets `PRAGMA user_version = 3`. `SDS.md` §4.5's chain block becomes:

```
v1 site.db   ──r2-amendments.sql──► v2 ──r3-amendments.sql──► v3  ==  schema/site.sql
v1 control.db ──control-r2.sql──► v2 ──control-r3.sql──► v3  ==  schema/control.sql
```

and §4.6's table gains one row: `schema/control-r3.sql` | hand-written | edited only with a check that
proves the change. Check 20 (E-14) covers both planes at v3.

**Test that must change.** New `test/tenancy/cache.test.ts`, reproducing `S1-qa.md` §3.6 as assertions:
for each of `UPDATE tenant SET status='suspended'`, `… archived`, `… mode='demo'`,
`… db_version=9`, `DELETE FROM domain`, `INSERT INTO domain`, `INSERT INTO tenant` — applied by a
**second** connection while the app is serving — the next request over the socket must show the new
state (404, or the new host served, or 503 for the raised `db_version`). Plus: two consecutive
`stamp()` reads with no write between them are equal (no rebuild); the stamp differs after each
mutation above. Plus: a request-scoped stamp read counter proves exactly one read per request.
`test/migrate.test.ts` gains: a control.db at v2 migrates to v3 and `control_revision` holds one row.

**Severity: blocker (B2).** "Suspend" is the one control an operator reaches for during an incident.

---

### E-4 — §4.3 has no code for a missing page in a resolved tenant, for a framework 4xx, or for a 500

**Defect.** `SDS.md` §4.3 (67 codes, 47 HTTP mappings). The only 404 is
`SKW_E_PLT_TENANT_UNKNOWN` ("no tenant"), so a resolved tenant with no `cms_page` row must answer "no
tenant", which is false; there is no code at all for an unhandled 500. Separately, `app/errors.ts`
answers every non-`AppError` with `SKW_E_PLT_TENANT_UNAVAILABLE` at whatever status the framework
chose, so a 400 (bad JSON) and a 413 (>16 MiB) carry a code the frozen map defines as 503.
`S1-qa.md` §5.4 and §0 M2; disclosed by the builder as `S1-report.md` §5.4.

**Corrected text — drop-in for `SDS.md` §4.3, the paragraph after the taxonomy, plus four rows added
to the area table.** `SUPERSEDES 00-adjudication.md §4.2`'s "Codes (complete for v1)" lists by
addition only: no code is removed or renamed, the count moves 67 → 71, and the pattern is unchanged.

```markdown
`schema/error-codes.json` holds the **71** codes, their HTTP mapping and their `Retry-After` values.
`validate_schema.py` asserts that every `SKW_E_*` string raised by `schema/*.sql` is a member and
matches the shape — so a trigger cannot raise a code the app has no mapping for. Two codes are raised
from inside the database today: `SKW_E_DM_ASSET_IN_USE` and `SKW_E_DM_COLUMN_IMMUTABLE`.

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
```

Area-table rows become `RT`: `…, ASSET_MISSING, PAGE_NOT_FOUND`; `PLT`: `…, DISK_FULL, INTERNAL,
REQUEST_INVALID, BODY_TOO_LARGE`. `schema/error-codes.json` gains the four `http` entries and **no**
`retry_after` entries.

**Test that must change.** `test/error-codes.test.ts` (app map equals the JSON — it fails until both
are updated, which is the gate). `test/integration/three-hosts.test.ts` test 5 must assert
`SKW_E_RT_PAGE_NOT_FOUND`, not `TENANT_UNKNOWN`, and must assert `no-store` on that 404. Add: malformed
JSON body → 400 `SKW_E_PLT_REQUEST_INVALID`; a 17 MiB body direct to the app → 413
`SKW_E_PLT_BODY_TOO_LARGE`; a route that throws → 500 `SKW_E_PLT_INTERNAL` with `requestId`, no stack,
no path, no SQL.

**Severity: major.** Every route added in S2–S4 inherits this mapping; the borrowed 503 code is also
a wrong status on the wire.

---

### E-5 — §16 S1 requires a slash-less 301 that §12.3 does not produce, and §12.3's demo regex does not load

**Defect.** `SDS.md` §12.3 and §16 S1 criterion 4. Three independent faults in the same fragment:
(a) the regex `^/demo/(?<demo_key>[a-z0-9][a-z0-9-]{0,31})(/.*)?$` matches `/demo/acme` with an empty
suffix, but the `rewrite` needs a trailing slash, so nothing is stripped and the app 404s — while §16
demands a 301; (b) the `{0,31}` is **unquoted** and nginx's tokenizer reads `{` as a block delimiter,
so the config does not load at all (`pcre2_compile() failed: missing closing parenthesis`); (c) the
`location` is shown outside any `server` block. `S1-qa.md` §5.3, `S1-report.md` §5.3 and §4.2. A
fourth fault, measured by QA as m4: the demo key is capped at 32 characters while `tenant.key` allows
40 (`schema/control.sql`: `length(key) BETWEEN 2 AND 40`), so keys of 33–40 characters are legal and
unreachable through `/demo/`.

**Corrected text — drop-in for `SDS.md` §12.3, the whole fenced config block.**

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
cookie is `Secure`, so the admin is unusable over 80 by construction. The admin vhost carries no `limit_req` zone: C-20's derived rate is per tenant and the
admin surface is authenticated, single-operator and CSRF-bound (S2's lockout, §16).

**Test that must change.** `test/nginx-config.test.ts` — the drift gate compares the committed
`nginx/conf.d/10-app.conf` to the generator's output, so both move together; add an assertion that no
unquoted `{` appears in a `location` line. `test/nginx-e2e.test.ts` — `/demo/beta` → **301**
`/demo/beta/` with the query preserved, through real nginx; `/demo/<40-char key>` reaches the app
(404 `SKW_E_PLT_TENANT_UNKNOWN` from the app, **not** 404 from nginx — the distinction is the point);
`/demo/acme` with no trailing slash does not reach the app at all.

**Severity: major.** §16's S1 criterion 4 cannot be green against the spec text, and the config as
written does not load.

---

### E-6 — the frozen v3 chain needs `PRAGMA legacy_alter_table = ON`; reorder it instead

**Defect.** `SDS.md` §4.5's frozen `r3-amendments.sql`: A1 drops `cms_download_code` while
`trg_cms_asset_delete_guard` and `trg_cms_download_code_hash_immutable` still name it, then renames
`cms_download_code_r3`. SQLite ≥ 3.25 re-parses every trigger on a `RENAME` and fails with
`error in trigger trg_cms_asset_delete_guard: no such table: main.cms_download_code`. Disclosed by the
builder as `S1-report.md` §4.1, judged legitimate-but-ungated by `S1-qa.md` §6.1, and invisible to the
default gate because `make test` pins the one interpreter whose SQLite never needed the fix
(`S1-qa.md` m7).

**Decision: reorder the migration; the pragma is not set anywhere.** Achievable, and measured in this
pass, not assumed: on SQLite **3.53.4** with `legacy_alter_table` at its default, a v1 file through
`r2` then a `r3` whose two `DROP TRIGGER` statements are moved ahead of `DROP TABLE cms_download_code`
applies cleanly and matches `schema/site.sql` on the table set, the `(name,type,notnull)` set per
table, the set of CHECK-bearing tables and the **body text of every trigger**; `integrity_check` ok,
`foreign_key_check` 0 rows. The as-written file fails on the same engine with the error above, and
passes with the pragma on — so the reorder is what removes the dependency, not a changed assertion.

**Why the reorder over the pragma.** (1) `legacy_alter_table` is connection-global state that changes
the semantics of *every* rename in the chain: it also disables the reference rewriting a future
migration may be relying on, so a view or trigger would silently keep a name that no longer exists —
and the convergence check, which compares names, would not see it. (2) The pragma makes the migration's
outcome depend on a session setting, so the same file produces different schemas depending on who ran
it. (3) The reorder is version-independent and its correctness is *exactly* what E-14's convergence
comparison proves, so the safety argument moves from "we set a flag" to "we compared the result".

**Corrected text — drop-in for `SDS.md` §4.5, the paragraph beginning "The four rebuilds".**

```markdown
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
```

**Test that must change.** `test/migrate.test.ts` test 3 must run the chain with
`legacy_alter_table` **unset** — the test never sets it — and assert `sqlite_master` convergence
(E-14's stronger comparison). Add one source assertion: the string `legacy_alter_table` appears
nowhere in `app/db/migrate.ts` or `scripts/model/verify_claims.py`, so the workaround cannot come back
by habit. `scripts/model/verify_claims.py`: delete the `PRAGMA legacy_alter_table = ON` from
`apply_chain()`; checks 10/12/15/20/22/26 must stay green on SQLite ≥ 3.50. `app/db/migrate.ts:98`
and `:158`: delete the pragma.

**Severity: major.** A frozen artefact currently applies only under a non-default pragma, on the
interpreter the default gate happens to pin.

---

### E-7 — the frozen `Retry-After` clause has no gate; suppressing the header leaves 40/40 green

**Defect.** `SDS.md` §5.3 freezes `503 + Retry-After: 5` (`SKW_E_DM_SCHEMA_STALE`),
`503 + Retry-After: 1` (`SKW_E_DM_BUSY`) and, per `schema/error-codes.json`,
`503 + Retry-After: 5` (`SKW_E_PLT_TENANT_UNAVAILABLE`). Nothing asserts the header over HTTP: the
unit test asserts `err.retryAfter` on the error object. `S1-qa.md` §2.6 measured that suppressing the
header in `sendError()` leaves 40/40 green.

**Corrected text — drop-in, appended to `SDS.md` §5.3 after the status table.**

```markdown
**Every `Retry-After` in the taxonomy is asserted on the wire.** `SKW_E_DM_SCHEMA_STALE` carries
`Retry-After: 5`, `SKW_E_DM_BUSY` carries `Retry-After: 1` and `SKW_E_PLT_TENANT_UNAVAILABLE` carries
`Retry-After: 5`; **no other code carries the header**. The value is a delta-seconds integer, never an
HTTP-date. The gate asserts `response.headers['retry-after']` on the HTTP response for each of the
three, and asserts the header's **absence** for every other code that appears in the S1 suites.
Asserting a field on the error object is not the gate: the header is the contract, and it is the only
part a proxy or a client acts on.
```

**Test that must change.** `test/tenancy/resolve.test.ts` row-10 case asserts
`res.headers['retry-after'] === '5'` and `'1'` for the two 503s it produces; add a table-driven test
over `schema/error-codes.json`'s `retry_after` map — every entry must appear on the wire with its
value, and a sampled set of codes without an entry must carry no header.

**Severity: minor (gate).** A one-line regression ships silently today.

---

### E-8 — the env gate fails by hanging instead of reporting

**Defect.** `SDS.md` §16 S1's "boot refuses any `^SK_|^SKUNK_` env key" row. `test/env.test.ts:97`
calls `spawnSync` with **no timeout**, so when the refusal regresses the child boots, listens and the
parent waits until the job dies: `S1-qa.md` §2.4 measured >180 s and m3. A CI job timeout is not a red
test with a message.

**Corrected text — drop-in for `SDS.md` §16, S1, the env row.**

```markdown
| boot refuses any `^SK_|^SKUNK_` env key, naming it, and the gate cannot hang | env test: `spawnSync` with `{timeout: 5000, killSignal: 'SIGKILL'}`; `ETIMEDOUT` is a named failure ("the process booted instead of refusing: <key>"), never a wait; the suite also runs under `node --test --test-timeout=15000`, so a regression is red in under 20 s; the child's stdout must not contain "listening" |
```

**Test that must change.** `test/env.test.ts:97` — add the timeout and the `ETIMEDOUT` branch with the
message above; assert `status !== 0` and the stderr regex; add a case where the app is given a free
port and would boot, so the timeout path is exercised rather than assumed.

**Severity: minor (gate).** In CI today this is an unbounded wait.

---

### E-9 — §2.3 step 2 asserts `UV_THREADPOOL_SIZE` at boot although the pool is fixed before boot

**Defect.** `SDS.md` §2.3 step 2: "Assert `SKW_ARGON2_MAX_CONCURRENT=4` and `UV_THREADPOOL_SIZE=8`".
libuv sizes the thread pool when the process starts; reading `process.env` in `loadEnv()` cannot
change it, so the sentence describes a control that cannot do what it says. Disclosed by the builder
as `S1-report.md` §5.6, judged real by `S1-qa.md` §5.6.

**Corrected text — drop-in for `SDS.md` §2.3, step 2.**

```markdown
2. Assert `SKW_ARGON2_MAX_CONCURRENT=4`. `UV_THREADPOOL_SIZE` is **set by the image** —
   `Dockerfile.app` (`ENV UV_THREADPOOL_SIZE=8`), `docker-compose.yml` and `.env.example` — and the
   process refuses to start unless the inherited value is `8`; absent counts as not 8. libuv sizes the
   pool when the process starts, so a value exported after launch cannot resize it: this is a check
   that the image did its job, and it must **fail** rather than pass when an operator supplies the
   variable late. (C-6: 8 × 64 MiB peaks at 687 MB inside a 1 GB container; 4 × 19 MiB is 76 MiB.)
```

**Test that must change.** `test/env.test.ts` — the existing "must be 8" and "absent refuses" cases
stand; the failure message must name `UV_THREADPOOL_SIZE` and say it is fixed at process start (assert
the message text, so the next reader learns why).

**Severity: minor.** No behaviour change; the sentence is the defect.

---

### E-10 — §3 lists S4's files as files a Builder creates in S1

**Defect.** `SDS.md` §3 lists `Dockerfile.runner`, `runner/**` and `app/plugins/**` under "Every path a
Builder creates" with no slice column, and §16 puts plugin install/enable/RPC in S4. Disclosed by the
builder as `S1-report.md` §5.10, confirmed by `S1-qa.md` §5.6.

**Corrected text — drop-in for `SDS.md` §3, paragraph after the fence.**

```markdown
§3 lists every path in the build, across all four slices; **§16's `Contains` list is the per-slice
authority** for who creates a path in which slice. `Dockerfile.runner`, `runner/**` and
`app/plugins/**` are **S4** (plugin install, enable, RPC). A builder creates neither a stub nor a
placeholder for a path outside its slice's `Contains` list, and a boot log line that names a deferred
step is the requirement, not a gap.
```

**Test that must change.** None — documentation. The check that matters is `test/compose.test.ts`
remaining green without a runner image built.

**Severity: minor.**

---

### E-11 — `X-Forwarded-Prefix` is not cleared at the edge, so a client sets `tenant.prefix`

**Defect.** `SDS.md` §5.1, §5.2 and §5.5. The snippet clears the tenant header on host-routed
locations but not the prefix; §5.5 says the prefix is "taken from `X-Forwarded-Prefix` and from nowhere
else" and that every emitted URL is prefixed exactly once. Measured through real nginx:
`GET /whoami Host: acme.test X-Forwarded-Prefix: /demo/evil` → `prefix: "/demo/evil"`. `S1-qa.md` §0
M1 and §3.9.

**Corrected text — drop-in for `SDS.md` §5.2, the snippet.** `SUPERSEDES 00-adjudication.md §4.1`'s
snippet by **one added line** (and the same line in §5.2's frozen text); no header name, timeout or
override changes.

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

**Corrected text — drop-in for `SDS.md` §5.5, appended to the block quote.**

```markdown
`tenant.prefix` is `/demo/<key>` when and only when the request resolved `via='header'` at a path-prefix
location; on `via='host'` and `via='session'` it is `""`. An `X-Forwarded-Prefix` that arrives on a
host-routed request is **ignored** — not honoured and not refused: honouring it puts
`/demo/<attacker>/…` on every link the site emits, refusing it would 400 real traffic behind a second
proxy that sets the header for its own reasons, and ignoring it can produce neither.
```

**Test that must change.** `test/nginx-e2e.test.ts` — a client sending
`X-Forwarded-Prefix: /demo/evil` to `acme.test` must be answered with `prefix` absent or `""`;
`test/prefix-demo.test.ts` — the app-level twin asserts the resolver ignores the header on
`via='host'`; `/demo/acme/whoami` still asserts `prefix: "/demo/acme"`.

**Severity: major.** `/whoami` is the only consumer today, but S3/S4 build `site.url()` on this value.

---

### E-12 — §5.4 promises a new host is served "on the next request", but the edge never learns it

**Defect.** `SDS.md` §5.4 ("picked up on the next request without a restart") and §12.3. nginx's
`server_name` list is generated at install and nothing reloads it, so a tenant or domain added to
`control.db` 404s at the edge until someone re-runs `tools/nginx_gen.ts` and reloads — while the app's
cache refresh creates the illusion that the change is live. Measured: `S1-qa.md` §3.7 and §0 M3, "the
week-one failure".

**Corrected text — drop-in for `SDS.md` §5.4, the paragraph after the cold-cache numbers.**

```markdown
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
```

**Test that must change.** New `test/onboarding.test.ts` (or a named case in
`test/nginx-e2e.test.ts`): start the edge with the fixture config; insert a `domain` row; assert the
new host 404s **at the edge**; run the generator, `nginx -t`, reload; assert 200 through the edge and
that the served body is the right tenant's. `test/nginx-config.test.ts` keeps the drift gate.

**Severity: major.** The first paying customer's new domain is the first 404.

---

### E-13 — "a body is always JSON `{error:{code}}`" is false for four classes of response

**Defect.** `SDS.md` §4.3 asserts every body is a JSON taxonomy body. Measured: a >16 MiB body through
the edge is nginx's **HTML** 413 (`S1-qa.md` m5), and an HTTP/1.1 request with no `Host` at all is
`{}` with a 400 from Node before the app (`S1-qa.md` m6). Neither can carry a taxonomy code — the app
never sees the request — so a gate written to the sentence as written can only fail or be weakened.

**Corrected text — drop-in for `SDS.md` §4.3, the sentence beginning "A body is always JSON".**
`SUPERSEDES 00-adjudication.md §4.2`'s identical sentence **for scope only**: the body shape, the
pattern and the prohibition on stacks, paths, SQL and keys are unchanged; what is added is the list of
responses the app never sees. The alternative — requiring nginx to render taxonomy bodies — would put
an error-code registry in two places.

```markdown
**Every response the app emits** has a JSON taxonomy body — `{error:{code, message?, requestId,
detail?}}` — and never a stack, a path, a SQL fragment or a key. Four classes of response are
generated before or outside the app, and they are named here so that no gate asserts a body the app
cannot produce: nginx's `default_server` 404 for a `Host` that maps to nothing; nginx's 413 when
`client_max_body_size 16m` is exceeded; nginx's 400 for a request it cannot parse; and Node's 400 for
an HTTP/1.1 request with no `Host`. Those carry the server's own body. They are the **only**
exceptions, each is asserted as such (status and `Content-Type`), and any other response that is not a
taxonomy body is a defect.
```

**Test that must change.** `test/nginx-e2e.test.ts` — the 17 MiB body through the edge asserts status
413, `Content-Type: text/html`, and **no** taxonomy code; a 16 MiB body passes; the same 17 MiB body
direct to the app asserts 413 `SKW_E_PLT_BODY_TOO_LARGE` (E-4). `test/integration/three-hosts.test.ts` —
HTTP/1.1 with no `Host` asserts status 400 and no tenant, and asserts nothing about the body.

**Severity: minor.** Contract accuracy; it also stops M2's 413 from being "fixed" by borrowing a 503
code.

---

### E-14 — the convergence gate compares names, not CHECKs or trigger bodies

**Defect.** `SDS.md` §4.5 claims check 20 compares "the table set, the `(name, type, notnull)` set per
table and the trigger set". `test/migrate.test.ts` compares `SELECT type, name FROM sqlite_master`
only, so a missing `CHECK` — the entire point of r3 — passes, and the report's "identical (53 objects)"
claim is stronger than the check. `S1-qa.md` m1 and §6.1.

**Corrected text — drop-in for `SDS.md` §4.5, the paragraph beginning "Check 20 compares".**

```markdown
Check 20 compares, on both planes and in both directions: the table set; `PRAGMA table_info` per table
as `(name, type, notnull)`; the `sqlite_master.sql` text of every table, which is where `CHECK`
constraints live; the trigger set; and the `sqlite_master.sql` text of every trigger — normalising only
identifier quoting (`"x"` and `x` are the same identifier) and runs of whitespace. Column *order* and
defaults are still not compared, for the two reasons below. A name-set comparison is **not** this
check: a table that lost a `CHECK` passes `(type, name)`, and a trigger body that lost a column passes
a trigger-name comparison. `test/migrate.test.ts` uses the same comparison against
`schema/site.sql` and reports the differing object by name.
```

**Test that must change.** `test/migrate.test.ts` test 3 and `scripts/model/verify_claims.py` check 20:
compare `sqlite_master.sql` with quoting and whitespace normalised, and fail naming the object. Add a
negative control: drop one `CHECK` from the migrated file in a scratch copy and assert the comparison
goes red (the gate must be shown to have teeth, not assumed).

**Severity: major (gate).** E-6 moves the migration's safety argument onto exactly this comparison; a
name-set check cannot carry it.

---

### E-15 — the model gate has undeclared interpreter prerequisites, and its pin hides E-6

**Defect.** `SDS.md` §16's "a slice is done when its gate is green in CI" and §3's `Makefile` line.
`make verify-claims` needs a `python3` with `argon2-cffi` (checks 17 and 21 skip without it, and
`verify_claims.py` exits 2 on a skip) and, before this errata, one whose SQLite applies the frozen
amendment chain as written. The Makefile's comment ("`/usr/bin/python3` on macOS/Linux ships it") is
false on most Linux distributions, and pinning `/usr/bin/python3` means the default gate runs on the
one SQLite that never needed the pragma — so E-6's regression is invisible to `make test`.
`S1-qa.md` m7 and §6.2; `S1-report.md` §5.9.

**Corrected text — drop-in for `SDS.md` §16, the paragraph under the heading.**

```markdown
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
```

**Test that must change.** `Makefile` — a `verify-toolchain` target that `test` and `verify-s1` depend
on, and the corrected comment. `scripts/model/verify_claims.py` — `--allow-skip` is the only way a skip
passes. CI — the second `verify-claims` run on a modern interpreter.

**Severity: minor (gate).** Load-bearing for E-6: without the second interpreter the reorder's
regression is invisible.

---

## 3. What this errata does NOT change (so the builder does not re-litigate settled ground)

Settled ground. Do not re-open any of it in the S1 rework, and do not re-litigate it in review:

- **The three tenancy headers and their names.** `X-Skunkworks-Tenant`, `X-Skunkworks-Edge`,
  `X-Forwarded-Prefix`, and the rule that no other header carries tenancy (§5.1). E-11 adds one `""`
  clear line; it does not rename, add or remove a header.
- **The empty-header semantics.** An absent or empty tenant header is *no assertion*, never a 400
  (§5.1). E-1 only decides which row sees the empty value.
- **`normalise(Host)`** — lowercase, strip port, strip trailing dot, `domainToASCII`, reject anything
  not `[a-z0-9.-]`. `Host` is parsed once, by the resolver.
- **The 22 environment names.** No variable is added by this errata: E-2 uses the host component of
  the existing `SKW_ADMIN_ORIGIN`; E-4's 16 MiB body limit is a constant, not a setting. `^SK_|^SKUNK_`
  stays a boot refusal.
- **The error-code pattern** `^SKW_E_(RT|DM|SEC|PLT|EXP|PL)_[A-Z0-9_]+$`, the JSON body shape, and the
  rule that the area is the domain that owns the decision. Four codes are added; none is renamed.
- **The three connection classes** (`render-read`, `admin-write`, `exporter`), the DDL AST and its five
  refusals, the export manifest, the plugin RPC surface, the download accounting unit. Untouched.
- **`schema/error-codes.json`'s `retry_after` values** — 5, 1, 5. E-7 adds the assertion, not the
  numbers.
- **The S1/S4 boundary.** §2.3 step 6 (bind `plugin.sock`, one child per enabled package) is **S4's**.
  The builder's logged skip is the specified behaviour; nothing in §16 changes for it. (The builder's
  `S1-report.md` §5.8 raised this as a defect; it is not one — see §5.)
- **The slice order S1…S5, the derived rate limit (C-20), per-host TLS with no wildcard (D7), and the
  four-service compose.** Untouched.
- **`mode='demo'`'s CHECK, `demo_expires_at` and quota meaning.** It keeps all of them; what it loses
  is a role in deciding the listener (E-2 rule 4), because that role was itself the second source of
  truth §9.2 forbids.

---

## 4. Builder checklist for S1 rework — ordered, each item naming the file and the gate that proves it

Each item names the files to change and the gate that proves it. Do them in this order — E-4 before
E-2 because E-2's 404 body is a code that does not exist yet; E-6 before E-14's negative control
because the reorder is what the convergence check now carries.

| # | Item | Files | Gate that proves it |
|---|---|---|---|
| 1 | **E-4** add the four codes | `schema/error-codes.json`, `app/errors.ts` | `test/error-codes.test.ts` (app map == JSON), plus the 400/413/500 cases in `test/integration/three-hosts.test.ts` |
| 2 | **E-2** listener is the admin host; admin routes mounted only there; `domain` rows refused for the admin and demos hosts | `app/main.ts`, `app/tenancy/resolve.ts` (listener), `tools/nginx_gen.ts` (refusal) | rewritten `test/admin-listener.test.ts` (a)–(e); `test/nginx-config.test.ts` |
| 3 | **E-1** resolution rows 1–10 as tabled | `app/tenancy/resolve.ts` | `test/tenancy/resolve.test.ts`, 10 cases asserting the row number; `test/nginx-e2e.test.ts` for the empty-header-through-the-edge case |
| 4 | **E-11** clear the prefix at the edge; prefix only on `via='header'` | `snippets/skunk-proxy.conf`, `app/tenancy/resolve.ts` | `test/nginx-e2e.test.ts` (client prefix inert), `test/prefix-demo.test.ts` |
| 5 | **E-3** revision counter, triggers, stamp, mid-request rule | `schema/control.sql` (regenerate), `schema/control-r3.sql` (new), `scripts/model/gen_schema.py`, `app/tenancy/cache.ts`, `app/db/migrate.ts` | new `test/tenancy/cache.test.ts` (QA §3.6 matrix, one stamp read per request); `test/migrate.test.ts` control chain to v3 |
| 6 | **E-6** reorder r3's trigger drops; remove the pragma everywhere | `schema/r3-amendments.sql`, `app/db/migrate.ts`, `scripts/model/verify_claims.py` | `test/migrate.test.ts` with `legacy_alter_table` unset; `verify_claims.py` 27/27 on SQLite ≥ 3.50 |
| 7 | **E-14** convergence compares CHECKs and trigger bodies | `test/migrate.test.ts`, `scripts/model/verify_claims.py` | check 20 + the negative control (one dropped `CHECK` goes red) |
| 8 | **E-5** the §12.3 config: quoted regexes, demos server block, slash-less 301, 40-char key, admin vhost, `listen 80` | `tools/nginx_gen.ts`, `nginx/templates/server.tmpl`, `nginx/conf.d/10-app.conf` (regenerated) | `test/nginx-config.test.ts` (drift + no unquoted `{`), `test/nginx-e2e.test.ts` (`/demo/beta` → 301; `/demo/<40 chars>` reaches the app) |
| 9 | **E-12** onboarding order, gated including the negative | `tools/nginx_gen.ts` (unchanged shape), new test | new `test/onboarding.test.ts`: 404 at the edge before reload, 200 after |
| 10 | **E-13** scope the always-JSON sentence; assert the four exceptions | `app/main.ts` (16 MiB body limit), `app/errors.ts` (mapping), `test/nginx-e2e.test.ts` | the edge-413 assertion (`text/html`, no taxonomy code) and the no-`Host` 400 |
| 11 | **E-7** `Retry-After` on the wire | `test/tenancy/resolve.test.ts` (+ a table test) | header asserted for all three codes, absent for the rest |
| 12 | **E-8** the env gate cannot hang | `test/env.test.ts` | 5 s `spawnSync` timeout, `ETIMEDOUT` named failure, `--test-timeout=15000` |
| 13 | **E-9** §2.3 step 2 wording and the refusal message | `app/env.ts` (message text) | `test/env.test.ts` asserts the message names the variable and "process start" |
| 14 | **E-15** toolchain preflight and the second interpreter run | `Makefile`, `scripts/model/verify_claims.py`, CI | `make verify-toolchain`; two `verify-claims` runs |
| 15 | **E-10** slice marking in §3, then paste every drop-in into `SDS.md` with its pointer line | `docs/sds/SDS.md` | `make test` (the frozen-quotes gate) and the drift gate; no code change |

**Definition of done for the rework.** `make test` and `make verify-s1` green **after** items 1–15,
on both interpreters, with each rewired gate shown to go red when its behaviour is broken (the QA
method: mutate, run, restore, re-hash). A green suite whose new gate has not been seen to fail is not
evidence.

---

## 5. Traceability — E-n to the QA/report finding it closes

| E | Closes | Source |
|---|---|---|
| E-1 | unreachable step 8; steps 5/7/8 contradiction; the missing `Retry-After` on `TENANT_UNAVAILABLE` found in this pass | `S1-qa.md` §5.1; `S1-report.md` §5.1 |
| E-2 | **B1** — `/admin/*` on any Host is the admin listener; the test that asserts it | `S1-qa.md` §0 B1, §4 B1, §5.2; `S1-report.md` §5.2; `app/main.ts:58`; `test/admin-listener.test.ts:66–71` |
| E-3 | **B2** — suspend/archive/mode/`db_version`/domain-delete invisible until restart | `S1-qa.md` §0 B2, §3.6, §4 B2, §5.5; `S1-report.md` §5.5; `app/tenancy/cache.ts:46–56` |
| E-4 | no code for a missing page or a 500; framework errors borrowing a 503 code | `S1-qa.md` §5.4, §0 M2; `S1-report.md` §5.4 |
| E-5 | slash-less 301 not produced; regex does not load; `location` outside `server`; 32-vs-40-char demo key | `S1-qa.md` §5.3, §0 m4; `S1-report.md` §5.3, §4.2 |
| E-6 | frozen v3 chain needs a non-default pragma; the pragma hides the class of defect the gate under-checks | `S1-report.md` §4.1; `S1-qa.md` §6.1, §0 m7 |
| E-7 | frozen `Retry-After` clause has no gate (40/40 green with the header suppressed) | `S1-qa.md` §2.6, §0 m2 |
| E-8 | the env gate fails by hanging (>180 s) instead of reporting | `S1-qa.md` §2.4, §0 m3 |
| E-9 | §2.3 step 2 asserts a variable that cannot be set at boot | `S1-report.md` §5.6; `S1-qa.md` §5.6 |
| E-10 | §3 lists `Dockerfile.runner`, `runner/`, `plugins/` as S1 work | `S1-report.md` §5.10; `S1-qa.md` §5.6 row 5.10 |
| E-11 | **M1** — client-chosen `X-Forwarded-Prefix` becomes `tenant.prefix` through real nginx | `S1-qa.md` §0 M1, §3.9 |
| E-12 | **M3** — a new tenant/domain is not routed at the edge; nothing reloads nginx | `S1-qa.md` §0 M3, §3.7 |
| E-13 | edge 413 is HTML, no-`Host` 400 is `{}` — both outside the "always JSON" claim | `S1-qa.md` §0 m5, §0 m6, §3.2, §3.8 |
| E-14 | "converges exactly (53 objects)" is a `(type,name)` comparison; a missing CHECK passes | `S1-qa.md` §0 m1, §6.1 |
| E-15 | undeclared `argon2-cffi` / SQLite prerequisites; the pin hides the r3 regression; the comment is false on Linux | `S1-qa.md` §0 m7, §6.2; `S1-report.md` §5.9 |
| — | **declined:** §16 S1 "the boot order of §2.3" is said to include step 6, which is S4's | `S1-report.md` §5.8 — judged **not a defect** by `S1-qa.md` §5.6 and by this pass: §16's S1 `Contains` list names no plugin work, C-8 makes the runner a separate container, and the builder's logged skip is the specified behaviour. No contract changes, and §3 above records the boundary as settled. |


---

## 6. Errata E-16..E-19 (post-S2a)

**Status:** amendment of record for `docs/sds/SDS.md`, issued after S2a went green
(`docs/build/S2a-report.md`, 145/145) with **four** of its eleven disclosed gaps marked as blocking S2b.
**Date:** 2026-10-20. **Author:** Architect. **Scope:** the specification. No implementation file is
edited by this pass.

**Four proposed, four accepted, none declined.** Each was verified against the text before it was
accepted, and each is a place where the SDS is silent or unsatisfiable rather than a place the builder
missed: there is no login error code in §4.3's taxonomy (§7.1); the allowlist has no storage and no
name in §4.3 or §9.1 (§7.4); the session table has no cap and no column to hold one (§7.6); and a
fresh bundle cannot produce a first operator (§7.5, and see E-19 for the second, unstated reason).

**Two more of the eleven are genuine gaps and are not closed here**, so that this section is not read
as a complete answer to §7: **item 2** (no CSRF header name — §9.1 names no wire name) and **item 7**
(`fleet_admin` has no login URL under §9.2's `/admin/t/<key>/…` shape). Both are one-line freezes of
different subjects, both are recorded as open in §8, and neither blocks S2b.

**Precedence, and the supersessions this section relies on** (§1's order is unchanged):

1. **E-16** `SUPERSEDES 00-adjudication.md §4.2`'s `SEC` list and the 71-code count — **by addition
   only**, exactly as E-4 did for four codes: nothing is removed or renamed, the pattern is unchanged,
   and the count moves 71 → 72.
2. **E-17** `SUPERSEDES 00-adjudication.md §4.2`'s sentence "Twenty-two names, and this table is the
   complete list" — by **one addition and no deletion**, so the table becomes twenty-three names and
   every existing name keeps its meaning. It also **amends §3 of this file**, whose bullet *"The 22
   environment names. No variable is added by this errata"* was true when it was written and is not
   true now. §3 is a list of settled ground, not a frozen contract, and this is the amendment.
3. **E-19** replaces `SDS.md` §11.6's block quote. The identical sentence lives in
   `00-adjudication.md` **§2** under C-24 — the conflict register, not §4's frozen contracts — so this
   is the correction of a verdict's restatement, not a reopening of the adjudication: C-24's decision
   (*a seed, never the fleet file*) is untouched, and what is added is the step that makes the seeded
   row usable.
4. **E-17's carried correction to E-13** `SUPERSEDES 00-adjudication.md §4.2`'s "they are the **only**
   exceptions" sentence by **one named class** — nginx's `403` for a peer outside the allowlist — for the
   same reason E-13 gave; nothing else in the sentence changes.

**§1's count of markers is now stale, deliberately.** "There are five such markers: E-1 … E-13" counts
the items of §2; this section adds three more (E-16, E-17, E-19) and one carried amendment to E-13, each
marked `SUPERSEDES` where it occurs. No other count in §1 changes.

**E-18 replaces no frozen text.** It decides a silence in §9.1's table: §1 says this file's silence is
not a decision, and the SDS's silence on session lifetime is exactly what this item decides. The one
number it fixes that the SDS never fixed — the populated-allowlist idle window — is report item 3,
folded in rather than carried as a fifth item.

---

### E-16 — a failed admin login borrows the paid-download code, so two unrelated decisions share one counter

**Defect.** `SDS.md` §4.3 (the `SEC` area: `CSRF`, `CODE_INVALID`, `RATE_LIMITED`, `TOKEN_INVALID`,
`TOKEN_MISMATCH`, `USES_EXHAUSTED`, `WATERMARK_FAILED`, `AUDIT_SEAL`, `ROLE_DISABLED`,
`UPLOAD_REJECTED`) and `schema/error-codes.json` (71 codes, 51 HTTP mappings, frozen). There is no code
for a credential login failure, so S2a raised `SKW_E_SEC_CODE_INVALID` at all three failure sites —
`app/admin/auth.ts:255` (unknown email), `:278` (wrong password), `:294` (wrong or missing TOTP) —
and that code is C-6's decision about a **paid download access code** (§7.2: a selector that matches no
row, a secret that does not verify, a revoked code). Disclosed by the builder as `S2a-report.md` §7.1,
who declined to add a code because `test/error-codes.test.ts:56` pins the count at 71.

The consequence is not cosmetic. A dashboard counting `CODE_INVALID` adds a mistyped download code to a
password-guessing run against the admin surface, and neither alert can be written: the two events have
different owners, different rates and different responses. The borrowed code also makes the emitter
lie — S2a passes the message `invalid credentials`, which is not what `CODE_INVALID` means anywhere
else in the taxonomy.

**Corrected text — drop-in for `SDS.md` §4.3: the code-count paragraph, a new paragraph and table row
after it, and the `SEC` area row.** `SUPERSEDES 00-adjudication.md §4.2`'s `SEC` list and count **by
addition only**.

```markdown
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
```

Area-table row becomes `SEC`: `AUTH_INVALID, CSRF, CODE_INVALID, RATE_LIMITED, TOKEN_INVALID,
TOKEN_MISMATCH, USES_EXHAUSTED, WATERMARK_FAILED, AUDIT_SEAL, ROLE_DISABLED, UPLOAD_REJECTED`.
`schema/error-codes.json` gains `AUTH_INVALID` in `areas.SEC` and
`"SKW_E_SEC_AUTH_INVALID": 401` in `http`, and **no** `retry_after` entry.

**What this does not change.** The lockout remains an intentional oracle after the fifth failure: a
locked account answers `429 SKW_E_SEC_RATE_LIMITED` and an unknown email cannot lock, so the status
diverges only after an attacker has already made five guesses against a real account
(`S2a-report.md` §7.9). That divergence is accepted, is not a defect, and is not re-opened here.

**Test that must change.** `test/error-codes.test.ts:56` — the total becomes 72 and the comment cites
E-16; the app-map-equals-JSON assertion then fails until both files are updated, which is the gate.
`test/admin-auth.test.ts` — the three assertions at `:121`, `:125` and the TOTP case become
`SKW_E_SEC_AUTH_INVALID`; the timing test (`ok 6`) compares **three** causes, not two, and its body
check compares all three scrubbed bodies byte for byte; a new assertion counts TOTP computations per
attempt and requires the count to depend on `totpRequired` only. Negative control: a mutant that moves
the TOTP computation back behind `if (!passwordOk) return` must go red on the third-cause timing ratio,
not merely on the code.

**Severity: major.** Every installed bundle's login path carries this code, and every dashboard an
operator writes about the admin surface counts it.

---

### E-17 — D9's allowlist has neither a name nor a storage location, so the control cannot be implemented at all

**Defect.** `SDS.md` §9.1's control table — "IP allowlist | opt-in, empty in every exported bundle;
**when empty, TOTP is mandatory and idle drops to 15 min**" — and D9 (`00-adjudication.md`: "the IP
allowlist is opt-in and empty in exported bundles; when it is empty, TOTP is mandatory and idle drops to
15 min"). §4.3's table is complete at twenty-two names and
names no allowlist variable; `schema/control.sql` has no table for it; and §12.3's generated admin vhost
carries no access directive. Disclosed by the builder as `S2a-report.md` §7.4, who took the value as
`BuildAppOptions.adminAllowlist` with a default of `[]` and **declined to enforce it in the app** —
correctly: with `trustProxy: false` the app sees nginx's address, and an allowlist it cannot trust is
worse than none.

The gap is therefore two gaps wearing one coat: there is nowhere to put the value, and no component
that can see the peer address well enough to act on it.

**Corrected text — drop-in for `SDS.md` §9.1, a new §9.1a, the §4.3 environment paragraph and table,
and the §12.3 admin block.** `SUPERSEDES 00-adjudication.md §4.2`'s "Twenty-two names, and this table
is the complete list" **by one addition and no deletion**; **amends §3 of this file** (see the
preamble).

```markdown
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
```

Drop-in for §4.3's environment paragraph and table (one row, after `SKW_EMAIL_MODE`):

```markdown
**Environment: one prefix, `SKW_`. Twenty-three names, and this table is the complete list.**
```

| Var | Default | Required | Meaning |
|---|---|---|---|
| `SKW_ADMIN_ALLOWLIST` | (empty) | no | comma-separated CIDRs allowed to reach the admin host; enforced by nginx, read by the app for §9.1's two consequences (§9.1a) |

Drop-in for §9.1's table row:

```markdown
| IP allowlist | opt-in, empty in every exported bundle; **when empty, TOTP is mandatory and idle drops to 15 min**; stored in `SKW_ADMIN_ALLOWLIST` and enforced by nginx on the admin host, never by the app (§9.1a) |
```

Drop-in for §12.3's admin server block (the directive lines only; the rest of the block is unchanged):

```nginx
# admin.<domain> — the only host that serves /admin (E-2, §9.1). No /demo/, no /media/.
server {
  listen 80; listen 443 ssl; server_name admin.skw.test;
  allow 203.0.113.0/24;          # one line per SKW_ADMIN_ALLOWLIST block
  allow 2001:db8::/32;           # IPv6 rendered as given; no expansion, no reordering
  deny  all;                     # emitted only when the list is non-empty
  location / {
    include /etc/nginx/snippets/skunk-proxy.conf;
    proxy_pass http://app:3000;
  }
}
```

With an empty list those three lines are absent, so the default is the app's own authentication and
never an accidental `deny all`.

**Carried by the same item: two environment names the generator invented are deleted.**
`tools/nginx_gen.ts:176–177` reads `SKW_ADMIN_HOST` and `SKW_DEMOS_HOST`; neither is in §4.3's table,
and §4.3 says the table is the complete list while §9.1 says the admin host **is** the host component
of `SKW_ADMIN_ORIGIN`. Freezing a twenty-third name beside two undeclared ones would make the table a
lie in the same edit, so both are deleted and both hosts are derived:

```
adminHost = normalise(host(SKW_ADMIN_ORIGIN))
demosHost = adminHost with its first label replaced by "demos"     # admin.cms.example.com -> demos.cms.example.com
```

Neither derivation is a variable. `--admin-host` and `--demos-host` stay as test-only flags and default
to the derived values.

**Test that must change.** `test/env.test.ts` — six parsing cases: unset → empty; `""` → empty; `" , "`
→ empty; two IPv4 blocks → two entries; a v4 and a v6 block → two entries; a non-empty malformed value
→ boot refusal naming the token, with `status !== 0` under the 5 s `spawnSync` (E-8).
`test/nginx-config.test.ts` — the admin block carries `allow`/`deny` iff the list is non-empty; **no**
tenant block carries either, ever; with the list empty the string `deny` does not appear in
`10-app.conf`. `test/nginx-e2e.test.ts` — a request to the admin host from outside the list is 403 from
nginx with `Content-Type: text/html`, no taxonomy code and no `Set-Cookie`, and the app's log shows no
request; the same request from inside the list reaches the app. Plus: with `SKW_ADMIN_HOST` set to
something else, the generated config is unchanged (the derived host wins).

**Severity: major.** D9 sells this control in writing, and today the value has nowhere to live and
nothing that can enforce it.

**Carried correction to E-13 — the fifth exception.** E-13 names four classes of response the app never
sees and says they are "the **only** exceptions". A denied peer is a fifth: nginx's `403` from `deny
all;` on the admin host, generated before the app is reached. Drop-in for `SDS.md` §4.3, replacing the
closing sentence of that paragraph — `SUPERSEDES 00-adjudication.md §4.2`'s identical sentence by the
addition of one named class, for the same reason E-13 gave: the alternative is an error-code registry
in two places.

```markdown
Those four, and **nginx's `403` for a peer outside `SKW_ADMIN_ALLOWLIST` on the admin host** (§9.1a),
are the only exceptions; each is asserted as such (status and `Content-Type`), and any other response
that is not a taxonomy body is a defect. The denied peer's body is nginx's on purpose: a taxonomy body
there would publish the product's error registry to an unauthenticated network peer.
```

---

### E-18 — there is no absolute session lifetime, and rotation resets the little there is

**Defect.** `SDS.md` §9.1's table ("Session id | 32-byte random hex, stored as a row in
`control.db.session`, rotated on privilege change") and `schema/control.sql`'s `session` table, which
carries `created_at`, `expires_at`, `rotated_from` and `revoked_at` and no `last_seen_at`. Idle expiry is
therefore implemented by sliding `expires_at` on every authenticated request
(`app/admin/session.ts:19–21`, `:238`), so a session in continuous use never expires — and
`session/rotate` inserts a **new** row with a fresh `created_at` and a fresh `expires_at`
(`session.ts:268`), so even a session that does reach a deadline can be replaced by an indefinite
succession of children. Disclosed by the builder as `S2a-report.md` §7.6, who called it "a real gap"
and left the model to this pass.

The secondary hole is the one the report only half-names: an operator with a polling dashboard tab is
*always* in continuous use, so "idle" in practice means "the browser tab was closed", not "the operator
walked away".

**Corrected text — drop-in for `SDS.md` §9.1, a new §9.1b, and the session row of the control table.**
No DDL delta is written, because no column is needed: no control-plane migration, no `control-r4.sql`,
no `gen_schema.py` bump and no re-baselined check 20.

```markdown
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
```

Drop-in for §9.1's session row:

```markdown
| Session id | 32-byte random hex, stored as a row in `control.db.session`, rotated on privilege change; the lineage dies 12 h after `created_at`, however continuously it is used (§9.1b) |
```

**Test that must change.** `test/admin-session.test.ts` — the six existing cases stand, and four are
added: (a) a session touched every 5 minutes is refused at `created_at + 12 h` exactly, with 404 and no
`Set-Cookie`; (b) the slide clamps — after the cap, `expires_at` never exceeds
`created_at + SESSION_ABSOLUTE_MS`, asserted on the stored value, not on the response; (c) a rotate at
11 h 59 m yields a child whose `created_at` equals the parent's and which is refused one minute later;
(d) a session expired by idle but inside the cap is refused and its `expires_at` is unchanged by the
attempt. `test/admin-auth.test.ts:156` keeps asserting the populated window against
`IDLE_MS_WITH_ALLOWLIST`, which is now a frozen number rather than an implementation choice (report item
3 is closed by that constant having a value the SDS states).

**Severity: major.** The cap is the only thing that ends the session of an operator who never closes
the tab, and rotation currently resets even the idle window.

---

### E-19 — a freshly installed bundle has no way in: the seeded operator is unclaimable and has no TOTP secret

**Defect.** `SDS.md` §11.6's block quote (the seed "carries … one `owner` user with an argon2id hash and
`must_change=1`"), §9.1's table ("when [the allowlist is] empty, TOTP is mandatory"), and
`schema/control.sql`'s `user_account.totp_secret` (nullable, default NULL). Nothing in the SDS creates a
TOTP secret, prints an enrolment URI, or sets a password a human holds. Disclosed by the builder as
`S2a-report.md` §7.5 ("S2b needs one or every operator is locked out of a fresh bundle") and §8.

Two verified facts make this a hard deadlock rather than an inconvenience:

1. **`totp_secret IS NULL` cannot authenticate when TOTP is mandatory** — `app/admin/auth.ts:285` leaves
   `totpOk = false` when the row has no secret, which is the correct fail-closed behaviour and precisely
   why a bundle with an empty allowlist has no way in.
2. **Nobody holds the seeded password.** The seed ships "an argon2id hash"; the preimage is in no
   artefact the bundle carries (§11.5's `BUNDLE.json` has no field for it, and no other file could), and
   `must_change=1` assumes a change-password flow that the SDS never defines and that cannot run before
   a login. So a bundle is unreachable **even with the allowlist populated** — the TOTP rule only makes
   it unreachable sooner.

This is the commercial blocker: the five-minute promise (§0, O-23, measured bracket in §11.6) ends at a
login screen nobody can pass.

**Corrected text — drop-in for `SDS.md` §11.6's block quote, a new §11.6a, two lines of §3's layout,
and four §16 rows.**

```markdown
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
```

Two lines of §3's layout change — the `install.sh` line and one new path:

```
│   ├── cli/skwctl.ts                  admin bootstrap / reset-totp / reset-password (§11.6a)
├── install.sh                         verify → control.sql → seed → .env → bootstrap → compose up; exit 11/12/15/16
```

`§16 S2` gains three rows and `§16 S4`'s install row is replaced; both are tabled in §7 with the other
drop-ins, so they are pasted in one pass.

**Test that must change.** New `test/cli-bootstrap.test.ts`, ten cases: a fresh seeded `control.db` +
nothing else yields exactly one `owner`, and a TOTP code computed **from the printed URI's secret** logs
in through the real login route; a second run exits 3 and leaves `password_hash`, `totp_secret` and
`must_change` byte-identical; a claimed user exits 3 and the file is not written; zero user rows with one
production tenant creates one, and with two tenants and no `--tenant` refuses `AMBIGUOUS_TARGET`; a
`fleet_admin` target with `SKW_FLEET_MODE=0` refuses; `SKW_RENDER_MODE=snapshot` refuses; a non-TTY
invocation without `--enrolment-out` refuses and writes nothing anywhere; the written file is mode 0600
and a second `--enrolment-out` to the same path refuses (`O_EXCL`); and a grep over the DB, the audit
row, stdout and the file proves the secret appears in the file and in no other artefact.

**Severity: blocker (commercial).** A bundle that cannot be logged into is not a product, and the
five-minute promise ends at the login screen.


---

## 7. Builder checklist for S2b — ordered, each item naming the file and the gate that proves it

Same shape as §4. Do them in this order. **E-16 before E-18** because both rewrite assertions in
`test/admin-auth.test.ts` and the login code has to exist before an expiry test can expect a 404 from a
route that a wrong credential would otherwise 401; **E-17 before E-19** because the bootstrap prints
whether TOTP is required, which it reads from the allowlist parser, and E-19's gate needs that parser to
have one answer; **E-19 last** because it is the only new executable in the slice.

| # | Item | Files | Gate that proves it |
|---|---|---|---|
| 1 | **E-16** add `SKW_E_SEC_AUTH_INVALID` (401, no `Retry-After`) and stop borrowing the download code | `schema/error-codes.json`, `app/errors.ts`, `app/admin/auth.ts` (three sites: 255, 278, 294) | `test/error-codes.test.ts` (total 72, app map == JSON); `test/admin-auth.test.ts` (three causes, one code) |
| 2 | **E-16** the work-shape rule: one TOTP computation per attempt when mandatory, before the password verdict, against a dummy secret when the row has none | `app/admin/auth.ts` | `test/admin-auth.test.ts` — three-cause timing within 20 %, bodies byte-equal, TOTP-computation count a function of `totpRequired` only; the "TOTP after the verdict" mutant goes red on timing |
| 3 | **E-18** the cap: `SESSION_ABSOLUTE_MS`, the clamp, rotation inherits `created_at`, dead → row 7 with no slide and no write | `app/admin/session.ts` (`idleMsFor`, `get`, `touch`, `rotate`) | `test/admin-session.test.ts` — four new cases (12 h under continuous use, clamp on the stored value, rotate at 11 h 59 m dies at 12 h, dead-by-idle → 404/no `Set-Cookie`/no slide) |
| 4 | **E-18** fix the populated-allowlist window at 60 min (report item 3) | `app/admin/session.ts` | `test/admin-auth.test.ts:156` asserted against the named constant, not a literal |
| 5 | **E-17** the name, one parser, and the boot refusal | `app/admin/allowlist.ts` (new, the shared parser), `app/env.ts`, `.env.example`, `docker-compose.yml` | `test/env.test.ts` — six parsing cases incl. malformed → refusal naming the token under the 5 s `spawnSync` |
| 6 | **E-17** edge enforcement in the admin block only | `tools/nginx_gen.ts`, `nginx/conf.d/10-app.conf` (regenerated) | `test/nginx-config.test.ts` (admin only; absent when empty); `test/nginx-e2e.test.ts` (outside → nginx 403, no taxonomy code, no `Set-Cookie`, no app request) |
| 7 | **E-17** delete `SKW_ADMIN_HOST` / `SKW_DEMOS_HOST`; derive both hosts from `SKW_ADMIN_ORIGIN` | `tools/nginx_gen.ts:176–177` | `test/nginx-config.test.ts` — a set `SKW_ADMIN_HOST` does not change the output; `demos.` derivation asserted for a multi-label admin host |
| 8 | **E-17** E-13's fifth exception, in the §4.3 drop-in and in the edge test | `test/nginx-e2e.test.ts` (assertion only), `docs/sds/SDS.md` (paste) | the denied-peer 403 asserted as `text/html` with no taxonomy code, alongside the four existing exceptions |
| 9 | **E-19** `skwctl admin bootstrap` / `reset-totp` / `reset-password` | `app/cli/skwctl.ts` (new), `package.json` (build), `tsconfig.json` | new `test/cli-bootstrap.test.ts` — ten cases, incl. a real TOTP code from the printed URI logging in, exit 3 on the second run with byte-identical rows, and the secret-in-one-artefact grep |
| 10 | **E-19** the seed is a claim marker and the bundle cannot carry a working factor | `schema/control.seed.json` (the projection's user object), `app/export/preflight.ts` (§11.3), `tools/seed_control.py` | export preflight refuses a non-NULL `totp_secret`; `test/migrate.test.ts`/seed test asserts the seeded row is `must_change=1`, `totp_secret IS NULL`, and unauthenticable |
| 11 | **E-19** wire it into the install sequence | `install.sh` (S4), `docs/sds/SDS.md` §3's `install.sh` line | S4's measured install: the printed password **and** a code from the printed URI produce an authenticated admin session on a clean host; a second `./install.sh` exits 0 with no row change; a bootstrap failure exits 16 |
| 12 | **E-16..E-19** paste every drop-in into `SDS.md` with its pointer line (`> Amended by 02-errata.md E-n.`), and add the four §16 rows below | `docs/sds/SDS.md` | `make test` (the frozen-quotes gate) and the drift gate; no code change |

`§16 S2` gains three rows:

```markdown
| a fresh seeded `control.db` and nothing else yields exactly one operator, and a TOTP code from the printed enrolment URI logs in | `test/cli-bootstrap.test.ts`, end to end through the login route |
| a second bootstrap writes nothing: exit 3, and `password_hash` / `totp_secret` / `must_change` are byte-identical | same suite, idempotence case |
| no TOTP secret or password reaches stdout, `audit_log`, `BUNDLE.json` or `control.seed.json` | grep assertion over the four artefacts |
```

`§16 S4`'s install row is replaced:

```markdown
| install on a clean host: ≤ 5 min with images present, `certificate: pending` allowed, and the printed credentials plus the printed TOTP URI produce an authenticated admin session without any other step | measured install, recorded in CI, ending in a real login |
```

**Definition of done for S2b.** `make test` and `make verify-s1` green after items 1–12, with each new
gate shown to go red when its behaviour is broken (mutate, run, restore, re-hash — the method §6 of the
S2a report used, and the reason its own C1 was re-run). Two specifics: the TOTP-timing gate must be seen
to fail with the computation moved back behind the password verdict, and the bootstrap gate must be seen
to fail with `--enrolment-out` writing to stdout instead of the file. A green suite whose new gate has
not been seen to fail is not evidence.

**Not in this slice.** The measured five-minute install is S4's gate (item 11's second half); S2b proves
the command and the login it enables, not the install. The multi-operator surface (invites, roles,
`reset_token_hash`) stays in S2b's CRUD work and does not use the CLI.

---

## 8. Traceability — E-16..E-19 to the S2a finding each closes

| E | Closes | Source (verified in this pass) | Severity |
|---|---|---|---|
| E-16 | no credential-login code; a login failure and a paid-download code share `SKW_E_SEC_CODE_INVALID` | `S2a-report.md` §7.1; `app/admin/auth.ts:255,278,294`; `schema/error-codes.json` (`SEC`, 71 codes); `test/error-codes.test.ts:56` | major |
| E-17 | D9's allowlist has no storage and no name, and no component can enforce it | `S2a-report.md` §7.4; `SDS.md` §9.1 table; `00-adjudication.md` D9; `schema/control.sql` (no table); `tools/nginx_gen.ts:176–177` (two undeclared names, found in this pass) | major |
| E-18 | no absolute session lifetime; `expires_at` slides forever and rotation restarts it | `S2a-report.md` §7.6, and §7.3 for the idle window (folded in); `schema/control.sql` `session`; `app/admin/session.ts:19–21,238,268` | major |
| E-19 | a fresh bundle has no way in: no TOTP secret is created, and no password a human holds exists | `S2a-report.md` §7.5 and §8; `SDS.md` §11.6; `app/admin/auth.ts:285`; `schema/control.sql` `user_account.totp_secret` | blocker (commercial) |
| — | **carried, not separate items:** E-13's "only exceptions" gains the denied-peer 403 (inside E-17); §3's `install.sh` line and file layout gain the bootstrap step (inside E-19); `SKW_ADMIN_HOST`/`SKW_DEMOS_HOST` deleted (inside E-17) | E-17, E-19 above | — |
| — | **open, not closed here:** the CSRF header has no frozen wire name (§9.1 names none; S2a chose `X-CSRF-Token`, which is compatible with §5.3 row 2's `X-Skunkworks-*` refusal) | `S2a-report.md` §7.2 | one-line freeze, does not block S2b |
| — | **open, not closed here:** `fleet_admin` has no login URL under §9.2's `/admin/t/<key>/…` shape; S2a's global-row fallback authenticates the role but gives it no surface | `S2a-report.md` §7.7 | needs a decision, does not block S2b |
| — | **not defects, left as implemented:** `ip_hash`/`ua_hash` stored for audit and not compared (report §7.8 — binding to either breaks CGNAT and every browser update); lockout's post-fifth-failure 429 divergence (§7.9 — accepted above); `/admin` and `/admin/` as row 7's 404 (§7.10); `npm test` not routing through the skip-enforcing runner (§7.11) | `S2a-report.md` §7 | — |

---

## 9. What this section does NOT change (so S2b does not re-litigate it)

- **The CSRF mechanism.** One token, session-bound, header name `X-CSRF-Token`, exact `Origin` on every
  non-GET, and no second path for form posts. E-16 changes the code a failed login returns, not how a
  login request is refused.
- **The three connection classes, the DDL AST, the five refusals, the export manifest, the plugin RPC
  surface, the download accounting unit.** Untouched.
- **`schema/control.sql` in this slice.** E-18 needs no column and E-19 needs none: `created_at` anchors
  the cap and `totp_secret` holds the secret. The schema stays at v3, and no `control-r4.sql` exists.
- **The 71 existing codes, their names, their statuses and their `Retry-After` values.** E-16 adds one
  (71 → 72); nothing is renamed, removed or re-mapped.
- **Every existing environment name and its meaning.** E-17 adds one and deletes two names that were
  never in the table; `^SK_|^SKUNK_` stays a boot refusal.
- **The lockout, the 429, and its divergence from an unknown email after five failures.** Accepted in
  E-16's last paragraph, not re-opened.
- **The seed and never the fleet file (C-24).** E-19 changes what the seeded row *means* — a claim
  marker instead of an unusable credential — and not what travels in a bundle.

---

## 8. Errata E-20..E-23 (post-S2-QA)

**Status:** amendment of record for `docs/sds/SDS.md`, issued after independent QA returned **NO-GO** on
slice S2 (`docs/build/S2-qa.md`, tree `b1aec3e`): one blocker (B1, §5.3 of that report), four majors, six
minors — and a verdict whose most damning sentence is not about code: *"the risk that stops S2 lives
outside the table QA was told to grade."*

**Date:** 2026-10-20. **Author:** Architect. **Scope:** the specification. No implementation file is edited
by this pass; every SQL statement below is text the Builder applies.

**Four proposed, four accepted, none narrowed.** E-20 is the blocker, and its subject is *coverage*, which
is a specification decision before it is a line of code: the seal covers the whole file, so it can never
verify a day that has a successor, and the only way to use it produces a false accusation. E-21 is the
major QA refused to let the Builder defer to S4 (`S2-qa.md` §7 item 2, "**Reject the deferral**"):
`cms_view_registry.checksum` exists, is written, and is never read, so a published `view` source is not
anchored to anything. E-22 is the gate-quality rule whose absence let both B1 and D3 read as passes. E-23
is the register: E-16..E-19 were never pasted into `SDS.md`, and §6.2's "re-checked at render" is true of
exactly one rule out of eight.

**Numbering.** This section keeps the number it was issued with. The S2a section above already occupies
§7–§9, so a citation to this section is written `§8 (post-S2-QA)` or `§9 (post-S2-QA)`, and no citation
above this line changes.

**Precedence, and the supersessions this section relies on** (§1's order is unchanged):

1. **E-20** `SUPERSEDES 00-adjudication.md` §2 **C-21**'s "sentence the SDS adopts", and only that
   sentence. C-21's *verdict* — a per-day digest in the second file is what makes a chain tamper-evident —
   is untouched. What changes is what a digest **covers**, because a whole-file digest cannot distinguish
   tamper from the next day's traffic, which is the one property the verdict was bought for. This is the
   same shape as E-19: the decision stands, its restatement was too coarse to implement.
2. **E-20 also amends E-18's closing line** ("no `control-r4.sql` exists"). True when written, false now:
   E-20's column set is a control-plane delta, so `schema/control-r4.sql` exists and `control.sql` moves to
   **v4**. E-18's decision — no new column for the session cap — is untouched.
3. **E-21 decides a silence in §6.1**, which names `cms_view_registry` and never says what its `checksum`
   is *for*. No frozen text is replaced; the registry gains its rule.
4. **E-22 decides a silence in §13 and §16**: nothing in the SDS says what makes a gate a gate, which is
   why two dead gates passed review as green.
5. **E-23 replaces §16 S2's table and §6.2's "re-checked at render" sentence.** Both are the SDS's own
   text, not the register's; no supersession.

---

### E-20 — the seal covers the whole file, so it can never verify a day that has a successor

**Defect.** `SDS.md` §9.6's block quote — and the identical sentence it quotes from
`00-adjudication.md` §2 C-21 under *"The sentence the SDS adopts"*: `audit_seal(tenant_key, day, rows,
head)`, where `rows = count(cms_audit)` and `head` is the chain's last hash, and "the verifier compares
`count(cms_audit)` and the recomputed head to the seal". `app/audit/chain.ts` implements it literally:
`sealNow` (`:218–231`) writes `report.rows`/`report.head` from a **whole-file** `verifyChain`, and
`verifyAgainstSeal` (`:252–277`) compares the seal to a whole-file report of the file *as it is now*. A
seal is therefore verifiable only in the interval between its own write and the next audit row.

QA measured it (`S2-qa.md` §5.3): three days, five verifications, and every day that has a successor
refuses with `SKW_E_SEC_AUDIT_SEAL — the chain disagrees with the seal for <day>`, which is the exact
string a real tamper produces (§9 of that report). Four consequences, of which the first is the one that
matters: **the control has no discriminating power for history** — a signal that always fires is not a
signal, and the operator's rational response after the third false alarm is to stop running it. S3 makes
the failure certain rather than likely: gated downloads write `cms_download_event` and audit rows
continuously, so from S3's first day every prior seal mismatches.

Two adjacent facts are the same defect seen from other angles, and are closed by the same text:

- **The backfill records the wrong day** (§5.2): `sealNow` is cumulative, so a seal for the 21st written on
  the 22nd records `rows=2` where one of those rows is the 22nd's; only `sealed_at > day` betrays it, and
  nothing checks that.
- **The gates can only pass in the failing direction.** `S2E-21` asserts that a chain which moved after
  the seal must fail — correct for tamper, equally true of every new day's traffic — and
  `verify_claims.py` check 25 deletes the tail and asserts the mismatch, never that an *untouched, grown*
  chain still verifies. Both were green on a control that cannot work. E-22 states the rule; this item
  supplies the missing positive control.

**Corrected text — drop-in for `SDS.md` §9.6's block quote, replacing it entirely, followed by the new
§9.6a.** `SUPERSEDES 00-adjudication.md §2 C-21`'s adopted sentence (see the preamble), and
`scripts/model/check_frozen.py` must gain the matching `SUPERSEDED` entry — that check requires the retired
C-21 sentence to be **absent** and its replacement **present**, so without the entry the whole gate goes
red the moment this text is pasted.

````markdown
### 9.6 Audit (C-21)

> `cms_audit` rows are hash-chained (`prev_hash`, `hash` over the canonical row) inside `site.db` and written in
> the same transaction as the change they record; one `audit_seal` row per tenant per UTC **day segment** is
> written to `control.db` — `(tenant_key, day, first_id, last_id, rows_in_day, head, anchor, sealed_at, late)`
> — where `[first_id, last_id]` is that day's own id range, `rows_in_day` is how many rows are in it, `head` is
> the last hash **inside that range**, and `anchor` is the hash of the row immediately **before** it (`''` when
> the segment begins at the chain's first row); the verifier walks that range only, starting from `anchor`, and
> raises `SKW_E_SEC_AUDIT_SEAL` when the anchor, a link, `rows_in_day` or `head` disagrees. A day that was never
> sealed stays **visibly unsealed**, and a day sealed after the fact carries `late = 1`.

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
````

**The DDL delta — `schema/control-r4.sql` (new, v3 → v4).** The old rows cannot be expressed in the new
shape — they carry no id boundary, so no row of them is a segment — and they are provably useless (§5.3):
their evidence is preserved in `audit_log` before the table is replaced, and the days they covered become
**visibly unsealed** under rule (c), which is the truthful state. Acceptable **now** because S2 has not
shipped; once a box is live, a model change must migrate anchors, not replace them.

```sql
-- schema/control-r4.sql — the v3 -> v4 delta for the control plane (02-errata E-20).
-- Applies to a control.db at PRAGMA user_version = 3 and yields 4 == schema/control.sql.
-- Convergence is asserted by verify_claims.py check 20 and by test/migrate.test.ts.
PRAGMA foreign_keys = OFF;
BEGIN IMMEDIATE;

-- 1. The cumulative anchor rows are not expressible as segments. Record each one, then replace.
INSERT INTO audit_log (tenant_id, actor_user_id, actor_label, action, target_kind, target_id,
                       before_json, after_json)
SELECT NULL, NULL, 'migration', 'audit.seal_discarded', 'audit_seal', s.tenant_key || '/' || s.day,
       json_object('rows', s.rows, 'head', s.head, 'sealed_at', s.sealed_at), NULL
  FROM audit_seal s;

-- 2. Replace the table. A DROP, not an ALTER: every surviving column changes meaning.
DROP INDEX IF EXISTS ix_seal_day;
DROP TABLE audit_seal;

CREATE TABLE audit_seal (
  tenant_key  TEXT NOT NULL CHECK(length(tenant_key) BETWEEN 2 AND 40),
  day         TEXT NOT NULL CHECK(day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
                                     AND date(day) IS NOT NULL),
  first_id    INTEGER NOT NULL CHECK(first_id >= 1),
  last_id     INTEGER NOT NULL CHECK(last_id >= first_id),
  rows_in_day INTEGER NOT NULL CHECK(rows_in_day >= 1),
  anchor      TEXT NOT NULL CHECK(length(anchor) IN (0, 64)),
  head        TEXT NOT NULL CHECK(length(head) = 64),
  sealed_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  late        INTEGER NOT NULL DEFAULT 0 CHECK(late IN (0, 1)),
  PRIMARY KEY(tenant_key, day),
  -- an on-time seal is written on the day AFTER the day it covers; anything else is late.
  -- The first CHECK is not decoration: date() returns NULL for an impossible day, and a
  -- CHECK that compares to NULL PASSES — so a single comparison would admit '2026-13-01'.
  CHECK(date(day) IS NOT NULL),
  CHECK(late = 1 OR substr(sealed_at, 1, 10) = date(day, '+1 day'))
);
CREATE INDEX ix_seal_day ON audit_seal(day);
CREATE INDEX ix_seal_late ON audit_seal(tenant_key, late);

-- 3. The anchor is immutable. A re-seal is a refusal in the app and an ABORT in the database,
--    because the app is not the only thing that can write this file.
CREATE TRIGGER trg_audit_seal_immutable BEFORE UPDATE ON audit_seal
BEGIN
  SELECT RAISE(ABORT, 'SKW_E_SEC_AUDIT_SEAL');
END;

PRAGMA user_version = 4;
COMMIT;
PRAGMA foreign_keys = ON;
```

`schema/control.sql` is **regenerated** from `scripts/model/gen_schema.py` with `CONTROL_VERSION = 4` and an
`audit_seal` spec whose `checks=[…]` are the two table-level CHECKs above verbatim; a `DROP` in a delta file
and a fresh `CREATE` in the generated file must produce the same `sqlite_master.sql` text, which is what
check 20 compares. §4.5's chain block gains one step (`v3 --control-r4.sql--> v4`) and §4.6's table gains
one row: `schema/control-r4.sql` | hand-written | edited only with a check that proves the change.

**Also — `§16 S2` gains one row** (the count after this item, E-21 and E-23 is stated once, in E-23):

```markdown
| a day sealed on the 20th still verifies after the chain grows on the 21st, while a row tampered inside that day, a row deleted before it, or a truncated segment each refuse with their own reason | `test/audit-seal.test.ts` `B1-1`…`B1-8`; the positive control is `B1-1` and it is the one that was missing |
```

**Test that must change.** The current suite is not weakened, it is *inverted in one place and replaced in
another*:

- `test/audit-seal.test.ts` — `A3`/`A5`/`A7` are rewritten for the segment shape (`A5`'s "deleted tail" case
  becomes a deleted row *inside* the segment, because deleting the tail no longer touches an earlier day's
  verdict), and `A7`'s idempotence assertion becomes the refusal of (a). Eight new cases:
  `B1-1` an untouched chain that grew on the next day still verifies for the earlier day (**the positive
  control** — it must fail against today's code, which is how this item is proved); `B1-2` a row deleted
  before the segment → `anchor_mismatch`; `B1-3` a row tampered inside the segment → `broken_at`, with the
  later day's rows deliberately corrupted too and day `D` still green (proves the range bound); `B1-4` a
  segment truncated on disk → `count_mismatch`; `B1-5` sealing a day that has not ended → `day_not_over`;
  `B1-6` a second seal → `already_sealed`, the row byte-identical, and a direct `UPDATE audit_seal` refused
  by the trigger with `SKW_E_SEC_AUDIT_SEAL`; `B1-7` a backfill → `late = 1`, `sealed_at` = the real
  instant, `first_id`/`last_id` on that day's ids only; `B1-8` the tick reports a gap and writes one
  `audit_log` row, and does **not** seal it.
- `test/seal-scheduler.test.ts` — `S2E-18`'s "a second run with the same head is idempotent" becomes "a
  second run is refused as `already_sealed` and the row is unchanged"; `S2E-21`'s "fails after the chain
  moves" is the defect stated as a criterion and becomes **two** cases: passes after the chain grows,
  fails after a row inside the day is altered.
- `scripts/model/verify_claims.py` check 25 keeps its number and its subject, and gains the assertion that
  was missing: after appending rows for day `D + 1`, day `D` still verifies; and after deleting a row
  inside `D`, it refuses. A check that only proves the failing direction is the bug (E-22).
- `scripts/model/check_frozen.py` — `SUPERSEDED["C-21 seal"]` with `item="E-20"`, the `marker` string, the
  retired sentence and the replacement, so the C-21 quote check moves with the text instead of failing.
- `scratch/s2-qa/seal-history.ts` (QA's own probe) is kept as the reproduction: its five verifications
  become five expected verdicts, and it is the fastest way to see the item is closed.

**Severity: blocker (B1).** This is the integrity anchor of §9.6 shipped in a state where the only way to
use it accuses an innocent file. It is not a data-exposure defect; it is the control that is supposed to be
trustworthy after everything else has been rewritten.

---

### E-21 — a `view` source is not anchored to its definition, so re-pointing the view serves another table

**Defect.** `SDS.md` §6.1 and `schema/site.sql`'s `cms_view_registry` (`name`, `checksum`, `created_at`):
the registry exists, the checksum column exists, and **nothing reads it**. `app/sources/registry.ts:89–100`
checks that the relation is registered and that it exists, then takes the column allowlist from
`PRAGMA table_xinfo` — a live read of whatever the view is *now*. `app/sources/resolve.ts` never looks at
the checksum either.

QA defeated it in one statement (`S2-qa.md` §4 A5): publish a `view` source over `cms_v_posts_public`,
then `DROP VIEW` + `CREATE VIEW … AS SELECT path AS title, slug FROM cms_page`, and the published source
**resolves `cms_page` rows** — `[{"title":"/pricing","slug":"pricing"},{"title":"/soon","slug":"soon"}]` —
with no republish, no audit row and no refusal. The allowlist does not notice, because `path AS title`
satisfies it. The builder proposed deferring the checksum half to S4 (`S2e` §7 item 2); QA rejected the
deferral (`S2-qa.md` §7), correctly: the gate is a resolve-time hash of `sqlite_master.sql`, it is writable
today, and it is the only thing that makes a `view` source an object rather than a name.

The same report measured the sibling hole: the plan, index and budget rules run only
`if (kind === 'query')` (`app/sources/publish.ts:189–194`), so a `view` source published with an unindexed
`order` column and an over-large `limit_max` — while §6.2's table said "table/view". E-23 narrows the
sentence to what is true and adds the one bound a view must still meet (cost); this item supplies the
anchor that makes the narrowing safe.

**Corrected text — a new `SDS.md` §6.1a, after §6.1's closing paragraph.** No frozen text is replaced and
**no column is added**, so there is no site.db DDL delta for this item: `cms_view_registry.checksum` already
exists and `NOT NULL`. A shape CHECK on it would require rebuilding the registry table in the tenant chain
to buy a property the single writer already guarantees, so it is deliberately not added.

```markdown
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
```

**Also — `§16 S2` gains one row:**

```markdown
| a `view` source is anchored to its definition: re-pointing the view out of band refuses with `reason='view_checksum'` instead of serving another table, a DDL op that changes a published view un-publishes its sources in the same transaction, and the checksum is hashed once per schema stamp, not once per request | `test/sources.test.ts` `V1-1`…`V1-3` |
```

**Test that must change.** `test/sources.test.ts` gains three cases, and `S2E-5`'s "a column outside the
allowlist is refused at publish AND at resolve time" keeps its shape with `kind='view'` covered too:
`V1-1` reproduces A5 exactly — publish over the view, `DROP` + re-`CREATE` out of band, resolve → `422
SKW_E_RT_SOURCE_UNKNOWN`, `reason='view_checksum'`, zero rows; `V1-2` runs `ALTER TABLE u_posts RENAME TO
u_posts_2` **through the runner** on a fixture whose view selects from `u_posts`, and asserts (i) the view's
`sqlite_master.sql` now names `"u_posts_2"` (SQLite rewrote it — measured, not assumed), (ii)
`cms_view_registry.checksum` moved, (iii) `cms_datasource.published_at IS NULL` for the view source, (iv)
one `cms_audit` row with both digests, (v) the next resolve refuses `not_published`, and (vi) republishing
succeeds and resolves; `V1-3` asserts the counter — add `viewChecksumHashes` to the resolver's stats, then
100 resolves under one stamp increase it by **1** and one DDL increases it by 1 again. Negative control for
the item: with the step-5a comparison deleted, `V1-1` must go red by *serving rows* — the assertion is on
the row set, not only on the code, so a test that refuses for another reason cannot pass in its place.

**Severity: major (M1).** A published source is a promise about a relation; without the checksum the
promise is about a *name*, and one `CREATE VIEW` repoints it.

---

### E-22 — a gate that cannot fail when its mechanism is removed is not a gate

**Defect.** Nothing in `SDS.md` says what makes an acceptance criterion a *gate* rather than a passing test
that sits near the code, and S2 shipped two gates that cannot witness the check they are named for.

Measured, `S2-qa.md` §3 NC1, on `app/sources/publish.ts` and `app/sources/plan.ts`:

| Mutation | Gate `S2E-1` |
|---|---|
| `if (report.scan) refusePlan(...)` → `if (false)` | **`ok 1` — still green** |
| `culpritColumn` skips its `where` loop | `not ok 1` — the refusal names the wrong column |
| `refusePlan` **and** `assertIndexedColumns` both disabled | `not ok 1` — refused |

With `refusePlan` disabled, `assertIndexedColumns` throws the same code, the same `detail.column` and a
`plan` array that still matches `/SCAN/`, so `S2E-1` cannot tell whether `EXPLAIN QUERY PLAN` ran at all. The
behaviour is still refused and the row's headline check has no witness. The same shape is B1: `S2E-21` and
`verify_claims.py` check 25 assert only that a moved chain fails, which is true of a legitimate new day —
both go red on tamper and on Tuesday.

This is not two mistakes in two files, it is one missing rule, and it is the rule that decides whether the
269-green number means anything.

**Corrected text — a new `SDS.md` §13.1a, inserted between §13.1 and §13.2.**

```markdown
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
```

**Applied to the SCAN refusal — the mechanism, the shape, and the witness.** Two changes in
`app/sources/plan.ts`, both required by rule 1 because the two checks currently emit an identical detail:

- `refusePlan` adds `reason: 'plan_scan'` and `role: 'plan'` to its `detail`; `assertIndexedColumns` keeps
  `role: 'where' | 'order' | 'group_by'` and never emits `reason`. The two refusals become distinguishable
  by shape, which is what lets a test name one of them.
- A case the index rule **cannot** refuse: every `where`/`order`/`group_by` column is indexed and the plan
  still contains `SCAN`. Measured on SQLite 3.53.1 against the S2 fixture: a single
  `where: [{col: 'status', op: '!=', param: 'status'}]` over the indexed `status` column plans as
  `["SCAN u_posts"]` — an inequality does not start a `SEARCH` — so `assertIndexedColumns` passes and only
  `refusePlan` can refuse. A second, independent instance of the same shape is `order` on an indexed column
  with no `where` at all: `["SCAN u_posts USING INDEX ix_posts_published_at"]`.
- In that case there is no culprit column to name: `culpritColumn` skips every indexed `where`/`order`/
  `group_by` column and falls through to `spec.columns[0]`, so the operator would be told
  `column "title" has no usable index` — false, and pointing at the wrong thing. So: when `scan` is true and
  no `where`/`order`/`group_by` column is unindexed, `culpritColumn` returns `null`, `refusePlan` sets
  `detail.column = null`, and its message becomes

      the plan for source u_posts contains SCAN although every referenced column is indexed;
      the predicate does not start a SEARCH

  A null column is a fact, not a gap: the plan is the evidence, and the fix is the predicate, not an index.

Both mutations then have a witness, and neither test can pass in place of the other:

| Mechanism disabled | `S2E-1` | `S2E-11` |
|---|---|---|
| `refusePlan` | green — `S2E-1`'s own spec is refused by the index rule | **red** — the source publishes |
| `assertIndexedColumns` | **red** — "an unindexed filter column must be refused" | green (the index rule never refuses this spec) |

**Test that must change.** `test/sources.test.ts` gains `S2E-11. a plan-only SCAN is refused even when every
column it names is indexed, and the refusal names the plan (exclusive witness for refusePlan)` — it asserts
`detail.reason === 'plan_scan'`, `detail.role === 'plan'`, `detail.column === null`, `detail.plan` matching
`/SCAN/`, the message quoted above, and that the publish wrote **zero** `cms_datasource` rows. The `status`
column is indexed in the
fixture, which the test asserts explicitly, so the case cannot silently degrade into `S2E-1`. New
`test/witness.test.ts` with the `WITNESSES` table seeded from the mechanisms that exist today —
`refusePlan → S2E-11`, `assertIndexedColumns → S2E-1`, `verifyAgainstSeal → B1-1`/`B1-3`,
`isPublic → S2E-4`, `previewTokenStatus → S2E-12`, `writeSeal → B1-6`, `viewChecksum → V1-1` — and an
assertion that each named test exists. Negative control: rename `S2E-11` in the test file without touching
`plan.ts` and `test/witness.test.ts` must go red, which proves the comment-to-test link is checked and not
decorative.

**Also — `§16 S2` row 5's gate cell is replaced** (no row is added; the subject is already that row):

```markdown
| a `query` source with a `SCAN` in its plan is refused at publish | `test/sources.test.ts` `S2E-1` (the index rule) **and** `S2E-11` (the plan rule). `S2E-11` is the exclusive witness: every column indexed, the plan still `SCAN`, refused with `detail.reason='plan_scan'`; disabling `refusePlan` leaves `S2E-1` green and makes `S2E-11` red |
```

**Severity: major (gate).** Two dead gates passed a review that ran 269 tests; the rule is what makes the
next 269 mean something.

---

### E-23 — §16 S2 is eight rows of eleven, and §6.2's "re-checked at render" is true of one rule

**Defect.** Two register failures, both measured in `S2-qa.md` §2 and §6.

**(M2 / D2 — the rows are missing.)** Errata checklist item 12 (§7 above) requires three new `§16 S2` rows
and they were never pasted: §16 S2 has **8** rows, not 11, and `grep -n "Amended by 02-errata" docs/sds/SDS.md`
returns **0** pointers for E-16..E-19 against **14** for E-1..E-15. None of `SKW_E_SEC_AUTH_INVALID`,
`SKW_ADMIN_ALLOWLIST`, `SESSION_ABSOLUTE_MS` or `skwctl admin bootstrap` appears in the SDS at all. The gates
exist and are green — QA ran them (§2.1 of that report) and judged all three **PASS** — so the product is
right and the register is wrong, which is the failure mode that makes a register worthless one slice later.
The errata's own text also says "add the **four** §16 rows below" and then lists three; it is three.

**(M4 / D4 — the sentence overclaims.)** §6.2 says "Rules, all enforced at publish and re-checked at
render", and its table is introduced under a `query` heading while the first row says "table/view". Measured:
`app/sources/resolve.ts` re-checks the **column allowlist only**; the plan, index and budget rules run at
publish (`publish.ts:189–194`) and only `if (kind === 'query')`, so a dropped index or a re-pointed view
serves without republication. A builder reading §6.2 implements three checks at render that the SDS does not
require and the page budget cannot afford; a reviewer reading it believes a re-check that does not happen. The
honest sentence is narrower and stronger because each rule now names the moment it is enforced.

**(Carried — the row whose gate does not exist.)** §16 S2 row 3's gate cell names `ddl.test.ts` over a
19-statement corpus. There is no `test/ddl.test.ts` in S2, and the 19-statement corpus belongs to the write
validator (§10, S4). The behaviour is gated — `test/ddl-runner.test.ts` `O2.` refuses
`ADD COLUMN … NOT NULL` with no default on a connection whose `open` throws if it is called, and `O3.` refuses
`DROP COLUMN` on an indexed column with `rebuild_required` — so the cell is corrected rather than the row.

**Corrected text — drop-in for `SDS.md` §16 S2's table, replacing all eight rows with eleven.** The three
added rows are §7's, verbatim; row 3's and row 5's gate cells are replaced by this item and by E-22. With
E-20's and E-21's rows pasted in the same pass the table is **thirteen** rows, and the count of amendments to
§16 S2 is five, not three — stated here so the numbers in this file and in `SDS.md` agree on the day it is
pasted.

```markdown
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
```

**Corrected text — drop-in for `SDS.md` §6.2, replacing the sentence "Rules, all enforced at publish and
re-checked at render:" and the table beneath it.**

```markdown
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
```

**Test that must change.** No new behaviour except the `limit` coercion, which is `D5` made a rule:
`test/sources.test.ts` gains one case — `limit: '5'` → `422 SKW_E_RT_SOURCE_UNKNOWN`,
`reason='param_invalid'`, `detail.param='limit'` — the same code, reason and detail every other invalid
parameter already produces (`compile.ts:63,73,81,96,141`), which is why this is a code fix and not a taxonomy
change; `limit: 2.7` → floors to 2, as today. The `view`-kind rows are already covered by
`V1-1`/`V1-2` (E-21) and a publish-time cost case for a view source (a view with a deliberately expensive
body → `SKW_E_RT_SOURCE_BUDGET`). For the register half, `scripts/model/check_frozen.py` gains a **second
phase**, because the gate it runs today compares quotes and cannot see a missing row — which is precisely why
`make test` was green with E-16..E-19 absent:

```python
# 02-errata's checklist claims these; a quote check cannot see a missing row or a missing table.
S2_ROWS = 13
S2_REQUIRED = (
    "a fresh seeded `control.db` and nothing else yields exactly one operator",
    "a second bootstrap writes nothing",
    "no TOTP secret or password reaches stdout",
    "a day sealed on the 20th still verifies after the chain grows on the 21st",
    "a `view` source is anchored to its definition",
)
# every item that must have landed a pointer line in SDS.md
POINTERS = tuple(f"E-{n}" for n in range(1, 24))
```

and it fails naming the missing row, the missing string or the missing pointer. **`POINTERS` is the whole
list, not this section's four** — the point of the check is that a pointer cannot be forgotten in the next
pass either.

**Severity: major (process).** A slice whose acceptance table is eight rows of thirteen, in a document that
says "a slice is done when its gate is green in CI", is a slice that will be declared done at the wrong size.

---

## 9. Builder checklist for the S2 fix — ordered, each item naming the file and the gate that proves it

Same shape as §4 and §7. **The order is the dependency order, not the severity order.** E-20's DDL comes
first because every other seal item is written against the new column set, and a sealer built against the old
one would be rewritten. E-21 comes before E-23 because §6.2's corrected table cites `§6.1a`, and a document
that cites a section that does not exist yet is the defect this errata is here to stop repeating. E-22 comes
before the new gates are *credited* rather than before they are written: it defines what "gated" means, and
its witness table cannot be filled until the tests it names exist.

| # | Item | Files | Gate that proves it |
|---|---|---|---|
| 1 | **E-20** schema v4: `audit_seal` rebuilt as a segment, the immutability trigger, the two table CHECKs; regenerate `control.sql` | `scripts/model/gen_schema.py` (`CONTROL_VERSION = 4`, the `audit_seal` spec), `schema/control.sql` (regenerated), `schema/control-r4.sql` (new) | `test/migrate.test.ts` — a v1 control.db migrates through r2/r3/r4 to v4, `audit_seal` has the nine columns and the trigger, and check 20's `sqlite_master.sql` comparison finds the migrated file identical to the generated one |
| 2 | **E-20** the sealer: segment scan, contiguity / `anchor_missing` / `day_not_over` / `chain_broken` refusals, `late` computed from the seal instant | `app/audit/chain.ts` (`writeSeal`, `sealNow`, `readSeal`, `SealRow`) | `test/audit-seal.test.ts` `B1-5` (`day_not_over`), `B1-6` (`already_sealed`, row byte-identical, direct `UPDATE` aborted by the trigger), `B1-7` (backfill: `late=1`, real `sealed_at`, that day's ids) |
| 3 | **E-20** the verifier reads only `[first_id, last_id]`; `--chain` is the whole-file walk; `SealVerification` becomes a segment report | `app/audit/chain.ts` (`verifyAgainstSeal`, `verifyChain`), `app/cli/skwctl.ts` (`audit verify`) | `test/audit-seal.test.ts` `B1-1` (the positive control: grew by a day, still verifies), `B1-2` (anchor mismatch), `B1-3` (tamper inside, later day also corrupted, day `D` still green), `B1-4` (count mismatch) |
| 4 | **E-20** the tick: no idempotence, the gap scan, one `audit_log` row per tenant-day gap, the health field | `app/audit/scheduler.ts` (`sealDay`), `app/main.ts` (health payload) | `test/seal-scheduler.test.ts` — `S2E-18` rewritten (a second run is `already_sealed` and changes nothing), `S2E-19` kept, `S2E-21` split into "passes after the chain grows" and "fails after a row inside the day is altered"; `B1-8` (gap reported, one `audit_log` row, **not** sealed) |
| 5 | **E-20** the operator surface: `audit status`, `seal --heal`, distinct refusal names, exit codes | `app/cli/skwctl.ts` | new `test/cli-audit.test.ts` — the three status lines (`sealed` / `UNSEALED` / `empty`), exit 0 vs 1, `--heal` writing `late=1` for every gap with one `audit_log` row each, and `REFUSAL: AUDIT_SEAL_UNSEALED` vs `REFUSAL: AUDIT_SEAL_MISMATCH` as distinct strings |
| 6 | **E-20** the claims gate: check 25 gains the direction it never tested; `check_frozen.py` gains the C-21 `SUPERSEDED` entry | `scripts/model/verify_claims.py`, `scripts/model/check_frozen.py` | `make verify-claims-modern` 27/27 — check 25 asserts both that a grown chain still verifies for the earlier day **and** that a row deleted inside it refuses; `make test` green, which proves the retired C-21 sentence is absent and its replacement present |
| 7 | **E-21** the checksum: written at publish, verified at resolve as step 5a, cached under `user_version:schema_version` | `app/sources/publish.ts`, `app/sources/registry.ts` (the `view` branch and the stamp-keyed verdict map), `app/sources/resolve.ts` | `test/sources.test.ts` `V1-1` (A5 reproduced: re-point out of band → `422`, `reason='view_checksum'`, zero rows), `V1-3` (`viewChecksumHashes` +1 per schema stamp, not per resolve) |
| 8 | **E-21** the DDL postcondition: a changed view body refreshes the checksum, un-publishes its sources and writes one `cms_audit` row, all in the same transaction | `app/ddl/run.ts` (the postcondition), `app/sources/registry.ts` | `V1-2` — the rename rewrote the view body, the checksum moved, `published_at IS NULL`, one audit row, next resolve `not_published`, republish resolves; plus a `view` cost case → `SKW_E_RT_SOURCE_BUDGET` |
| 9 | **E-22** distinct refusal shapes and the witness comments | `app/sources/plan.ts` (`refusePlan` gains `reason:'plan_scan'`, `role:'plan'`; both functions' comments name their test) | `test/sources.test.ts` `S2E-11` — the indexed-column-but-SCAN case, refused with `reason='plan_scan'`, zero `cms_datasource` rows, and `status` asserted indexed so the case cannot degrade into `S2E-1` |
| 10 | **E-22** the witness table | new `test/witness.test.ts` | itself: every `mechanism → {file, test}` row names a test that exists and a comment that contains the name; renaming `S2E-11` alone turns it red |
| 11 | **E-23** paste every drop-in with its pointer line; §16 S2 to 13 rows; §6.2's table replaced; `check_frozen.py`'s second phase | `docs/sds/SDS.md`, `scripts/model/check_frozen.py` | `make test` — the quote phase (no retired sentence present, every replacement present) **and** the completeness phase (`S2_ROWS = 13`, the five required strings, every `POINTERS` entry) |
| 12 | **Evidence** the mutation record for items 1–11 | `docs/build/S2-fix.md` | one row per gate: the edited expression, the gate that went red, the gate that stayed green, SHA-256 before/after; plus the five negative controls of `S2-qa.md` §3 re-run and all five red |

**Definition of done for the S2 fix.** `make test`, `make verify-s1` and `make verify-claims-modern` green
after items 1–12, on both interpreters (§16's preamble), with:

- **`B1-1` shown red against `b1aec3e` and green after item 3.** It is the only test that proves the blocker
  is closed, and it is the one test the old suite cannot contain.
- **Every new gate shown red under its named mutation** — `refusePlan` → `S2E-11`; the step-5a comparison →
  `V1-1`; `writeSeal`'s `already_sealed` branch → `B1-6`; the range bound in the verifier → `B1-3`;
  the postcondition in `run.ts` → `V1-2`. A green suite whose new gate has not been seen to fail is not
  evidence (§13.1a).
- **The five hashes of `S2-qa.md` §10 unchanged**, so the proof that nothing else moved is the same proof QA
  used.
- **§16 S2 counted, not eyeballed**: 13 rows, and `grep -c "Amended by 02-errata" ` no longer returns 14 for
  15 items — E-20..E-23 land four pointers of their own.

**Not in this fix, and why.** `D6` (a raw `SQLITE_ERROR` on out-of-band column drift) is a resolver
catch-all with no specification question — §6.2's allowlist is already the intended detector and
`SKW_E_RT_SOURCE_UNKNOWN` the intended code — so it is queued for S3's error-surface work rather than
written into a sentence it does not need. `D10` (§17 claims S2 proof for O-17, O-30 and C-23, none of which
exists) is a register correction that belongs with the §17 pass, not with this one; it is recorded as open in
§10 below so it cannot be lost. `D5`'s `limit` coercion is **in** this fix (E-23), because the `list`
component in S4 will produce it on day one and a silently ignored parameter is a rule with two answers.

---

## 10. Traceability — E-20..E-23 to the S2-QA finding each closes

| E | Closes | Source (verified in this pass) | Severity |
|---|---|---|---|
| E-20 | **B1** — a seal older than the latest audit row can never verify; the backfill records the next day's rows; both gates test only the failing direction | `S2-qa.md` §5.3 (five verifications), §5.2 (the backfilled `rows=2`), §9 (the week-one failure), §6 B1; `app/audit/chain.ts:197–215, 218–231, 252–277`; `test/seal-scheduler.test.ts` `S2E-21`; `scripts/model/verify_claims.py` check 25 | blocker |
| E-21 | **D1 / M1** — `cms_view_registry.checksum` is written and never read, so a re-pointed view serves another table through a published source | `S2-qa.md` §4 A5 (the resolved `cms_page` rows), §6 D1, §7 item 2 ("**Reject the deferral**"); `app/sources/registry.ts:89–100`; `schema/site.sql` `cms_view_registry` | major |
| E-22 | **D3 / M3** — the SCAN refusal has no exclusive witness; disabling `refusePlan` leaves `S2E-1` green; and the general rule whose absence made that invisible | `S2-qa.md` §3 NC1 (the three mutations), §2 row 5, §6 D3 | major (gate) |
| E-23 | **D2 / M2** — E-16..E-19 never pasted; §16 S2 has 8 rows of 11; 0 pointers against 14 — and **D4 / M4** — §6.2's "re-checked at render" is true of the column allowlist alone, and "table/view" is true of neither mechanism | `S2-qa.md` §2 (8/8 PASS and the 8-row tally), §2.1 (the three gate rows, adjudicated PASS), §6 D2/D4, §7 | major (process) |
| — | **carried, not separate items:** C-21's adopted sentence retired (inside E-20); E-18's "no `control-r4.sql` exists" amended (inside E-20); §16 S2 row 3's non-existent `ddl.test.ts` corrected (inside E-23); §16 S2 row 5's gate cell replaced (inside E-22); `check_frozen.py`'s `SUPERSEDED` entry and its completeness phase (inside E-20 and E-23) | E-20, E-22, E-23 above | — |
| — | **declined — not a defect:** `D7`, "`scratch/s2d/` and `scratch/s2e/` are said to be uncommitted and are committed". It is a sentence in a **build report**, not in the SDS: no contract, no control, no gate depends on it, and correcting it changes nothing a Builder or a reviewer would do differently. The reports are evidence, and errors in evidence are corrected by the next report | `S2-qa.md` §6 D7 | none |
| — | **declined — not a defect:** `D9`, "CI has never run". A fact about the pipeline's provisioning, not about any sentence in the specification. It is carried as the S1 gate finding G4 and is closed by running the workflow once, not by an errata item — and this pass cannot make a workflow run | `S2-qa.md` §6 D9, §1 | none (carried) |
| — | **declined — not a defect:** "no S2 shell calls `data.source`, so publish→page→rows has no end-to-end gate". True, and not a specification gap: no §16 S2 criterion claims a template consumer, §6.3 puts the `list` component in S4, and this errata does not invent an S2 integration to make a diagram look complete. It is recorded in §16 S4's scope as the first consumer, where it already is | `S2-qa.md` §4 A3 note, §8 | none |
| — | **not a new item — already specified:** `D8`, "no session sweeper". E-18 already requires one in writing ("the sweeper deletes a row when either deadline has passed, and deletes a revoked row once the cap has passed"), so this is a build gap against frozen text, not a specification gap; S2b's checklist item 3 is where it is proved | `S2-qa.md` §6 D8; E-18 above | minor (build) |
| — | **open, not closed here:** `D6` (a raw `SQLITE_ERROR` when a `query` source's table loses a column out of band — a 500 on a public render) is a resolver catch-all, queued for S3's error-surface work; `D10` (§17 attributes S2 proof to O-17, O-30 and C-23) is a register correction belonging to the §17 pass | `S2-qa.md` §4 A5b, §2.1, §6 D6/D10 | minor |

---

## 11. Errata E-24, E-25 (post-S2-closeout)

**Status:** amendment of record for `docs/sds/SDS.md`, issued after `docs/build/S2-closeout-report.md`
(tree `d77a8c3`) closed M5, M6 and D12 and flagged two contradictions instead of resolving them silently
(§6, open items 1 and 2 of that report).

**Date:** 2026-10-20. **Author:** Architect. **Scope:** the specification. No implementation file is edited
by this pass; both items are text, and both corrected texts are what a Builder or a reviewer applies.

**Two items, and each is a sentence the document can no longer keep.** E-24: §6.2 refuses a non-integer
`limit` and, two sentences later, floors one — one rule with two answers in one paragraph, where the code has
already chosen the refusal (M5, witnessed by `M5-1` and its mutation). E-25: the frozen suite budget
`--test-timeout=15000` is 1.46× the pre-split worst file, so 6× CPU load failed a file whose every test
passed; the perf split moved that file out, and the budget is `40000`, derived 4.4× from the worst file that
remains. **Neither item decides a behaviour that is not already implemented and measured**, which is why
neither is a narrowing: E-24 retires a sentence that contradicted the row above it, and E-25 records a
derivation that was already applied.

**Numbering.** §10 above is the traceability table for §8 (post-S2-QA). This section is §11, and no citation
above this line changes.

**Precedence, and the supersessions this section relies on** (§1's order is unchanged):

1. **E-24 `SUPERSEDES SDS.md §6.2's "The clamp is Math.floor on a number" sentence`** — that sentence, and
   only that sentence. The paragraph's opening rule, the table row above it, §6.1a and §6.3 are untouched.
   The sentence reads as a licence to floor because it names `Math.floor` as "the clamp"; the clamp is
   `limit_max`, and flooring is not clamping.
2. **E-24 also retires E-23's own test sentence** "`limit: 2.7` → floors to 2, as today" (§8 (post-S2-QA),
   E-23, "Test that must change"). That sentence is errata text, not adopted contract, so it takes no
   `check_frozen.py` entry: it is replaced in effect by E-24's matrix, and this line is the only pointer E-23
   keeps. E-23's block is otherwise as issued — the precedent is E-20's amendment of E-18's closing line,
   where the amendment is declared and the historical block is not rewritten.
3. **E-25 `SUPERSEDES SDS.md §16 S1's env row (--test-timeout)`** — the clause, never the row: the 5 s
   `spawnSync`, the `ETIMEDOUT` named failure and the stdout assertion are E-8's and stay word for word. The
   same clause in E-8's drop-in (§2) and in §4's item 12 gate cell is superseded by the same sentence.
   `make verify-frozen` is green on this row today because `check_frozen.py` does not quote it (S2-closeout
   §3.3); E-25's test row below puts the replacement under quote so the retired number cannot return.
4. **Neither item supersedes `00-adjudication.md`.** E-24 decides a sentence §6.2 got wrong about a rule the
   contract already states ("a rule with two answers is not a rule"); E-25 decides a budget the SDS stated as
   a number and now states as a derivation. No adjudicated decision moves.

---

### E-24 — §6.2 refuses a non-integer `limit` and, two sentences later, floors one

**Defect.** `SDS.md` §6.2 (pasted from E-23) carries three statements of one rule, and the second and third
contradict the first:

- the table row (`SDS.md:1072`): "`limit` clamped to `limit_max`, and a non-integer `limit` is refused, never
  ignored … a non-integer is `422 SKW_E_RT_SOURCE_UNKNOWN`, `reason='param_invalid'`, `detail.param='limit'`";
- the paragraph (`SDS.md:1082–1084`): "**A `limit` that is not an integer is refused, not ignored.** … The
  clamp is `Math.floor` on a number, and anything else is `param_invalid`" — which says the opposite: a
  number that is not an integer is still a *number*, and is floored;
- E-23's own test paragraph: "`limit: 2.7` → floors to 2, as today."

A Builder applying the paragraph verbatim restores D5: `'5'` falls through to `limit_default`, `5.5` floors,
and only a negative refuses — three answers for one rule. The implementation refuses all four shapes
(`S2-closeout.md` §2): `requestLimit` (`app/sources/compile.ts:126–134`) is `typeof value !== 'number' ||
!Number.isInteger(value)` → refusal, then `value < 1` → refusal; `asLimit` (`app/sources/spec.ts:139–148`)
applies the same predicate to the spec's two fields with `detail.field` naming which. Witnessed by
`test/sources.test.ts` `M5-1` — the four shapes QA measured, each at publish **and** at resolve, asserting
code + reason + `detail.param`, **zero** `cms_datasource` rows written, and the positive control `limit: 2`
resolving with `limit === 2` — and by one mutation (the `Number.isInteger` clause removed → `M5-1` red,
`'resolve must refuse 5.5 (a fractional number)'`; `compile.ts` sha256 `d11dd76e…` before and after).
**No test ever asserted flooring** (S2-closeout §2, closing sentence), so retiring it weakens nothing.

**The decision, and why.** A non-integer `limit` is **refused, never floored**. Flooring is silent: it turns
a caller's bug into a page with the wrong number of rows and no signal. `2.7` is not "a bit more than two
rows" — it is a caller who computed a limit wrongly, and the product's answer to a caller bug is a refusal
that names the parameter, which is the answer `'abc'` already gets. The CEO fixed this direction for this pass
and it is the implemented one; the errata's job is to stop the document saying both.

**Corrected text — drop-in for `SDS.md` §6.2, replacing the paragraph "A `limit` that is not an integer is
refused, not ignored." and nothing else.**

```markdown
**A `limit` is an integer or it is refused — never floored, rounded or ignored.** `data-limit` is an HTML
attribute and therefore always a string; the component that owns the attribute parses it (§6.3's `list` is
the first caller) and passes a number, and the source accepts a number or refuses. The refusal is
`422 SKW_E_RT_SOURCE_UNKNOWN`, `reason='param_invalid'`, `detail.param='limit'` — the code, reason and detail
every other invalid parameter already produces. `Math.floor` appears nowhere in this rule: a value that would
need it is not a number of rows, and a floored limit answers a caller's bug with a page that has the wrong
number of rows and no signal.

**One predicate, two moments.** At **render** it is applied to the request's `limit`; at **publish** to the
spec's `limit_max` and `limit_default`, with `detail.field` naming which of the two was wrong. Every
"refused" below is the identical response — same code, same `reason`, same `detail.param` — and writes
nothing: no `cms_datasource` row at publish, no rows at render.

| Value | Render — the request's `limit` | Publish — the spec's `limit_max` / `limit_default` |
|---|---|---|
| **absent** | the spec's `limit_default` (10 when the spec sets none); `truncated=false`, no `data-truncated` | the field's default: `limit_max` → 50, `limit_default` → `min(10, limit_max)` |
| **integer** `n ≥ 1` | used as `n`; if `n > limit_max` it is clamped to `limit_max` with `truncated=true` → `data-truncated` — a clamp, not a refusal | accepted when `1 ≤ n ≤ 500` (`MAX_LIMIT`); `limit_max` is the ceiling itself, so nothing clamps it |
| **numeric string** `'5'` | refused | refused |
| **float** `5.5` | refused — **not floored, not rounded** | refused |
| **negative** `-1`, and `0` | refused | refused |
| **non-numeric** `'abc'`, `null`, `true`, array, object | refused | refused |

"Refused" is not "ignored" and not "defaulted": a caller who sends `'5'` gets an error naming the parameter,
because accepting it for one caller and dropping it for another is the rule with two answers this paragraph
exists to forbid.
```

**Test that must change.** None. `M5-1` is the gate and already asserts the four shapes QA measured at both
moments plus the integer positive control; the mutation that removes `Number.isInteger` is its exclusive
witness. `0` and the non-scalar values fall under the same two branches (`typeof !== 'number' ||
!Number.isInteger`, then `< 1`) that `M5-1` already exercises, so this item **does not invent an assertion**
for them — a second test over a branch another test owns is the false precision E-22 forbids. The change owed
is textual: the flooring sentence out of `SDS.md` §6.2 and out of E-23's test paragraph.

**Recorded, not closed — the default path is not clamped.** Read while checking the matrix against the code: a
`limit_default` greater than `limit_max` is accepted at publish (`asLimit` checks only `1…500`, `spec.ts:141`)
and a render that sends **no** `limit` uses `spec.limitDefault` without the clamp (`compile.ts:161–172` — the
clamp branch runs only when a `limit` is present), so `{limit_max: 5, limit_default: 50}` serves 50 rows and
contradicts the row that says `limit` is clamped to `limit_max`. Nothing stops it: `cms_datasource.spec_json`
is checked for `json_valid` only. This is a **separate item, not part of E-24** — the fix is either a publish
refusal (`param_invalid`, `detail.field='limit_default'`) or a render clamp, and the first is the shape this
item just chose for flooring, but it changes behaviour nothing has measured and E-24's subject is the flooring
sentence. Flagged for the next errata rather than decided here.

**Severity: major (specification).** The sentence and the row it sits under cannot both be implemented, and
the sentence names the exact operation (`Math.floor`) a Builder would reach for. Applied as written it
re-opens D5 — the defect M5 closed in this pass.

---

### E-25 — the frozen `--test-timeout=15000` is false, because 1.46× was never headroom

**Defect.** `SDS.md` §16 S1's env row says "the suite also runs under `node --test --test-timeout=15000`, so
a regression is red in under 20 s". Measured (`S2-closeout.md` §3.3):

- node applies `--test-timeout` to **each test and to the file-level subtest**, so a file whose total exceeds
  it fails even when every test inside it passes — measured on two 700 ms tests with a 1000 ms budget:
  `ok 1 - a`, `not ok 1 - <file>`;
- the pre-split worst idle file was `test/sources.test.ts` at **10 264 ms** — **1.46×** under 15 000;
- at 6× CPU load the unmodified file exited `not ok 1 - test/sources.test.ts   duration_ms: 15009.712459`
  with every test inside it green (a `git worktree` at `639763e`, `load-run.sh 6`).

So the number was true only of an idle box, which is not the box a gate runs on. The **split** is what fixed
it — the same file under the same 15 000 ms cap at the same 6× load passes 16/16 in 364.7 ms once its rate
assertions moved to `make test-perf` — and the budget is the second half, not the first.

**Corrected text, site 1 — a new paragraph in `SDS.md` §16's preamble, after "The gates declare their
interpreter."** This is where the derivation lives, so a future reader re-derives instead of widening.

```markdown
**The gates declare their time budget, and it is derived from a measurement.** `make test` runs under
`TEST_TIMEOUT_MS`, which is **40 000** ms today and is re-derived — never raised to make a red test green —
whenever the file set changes. The derivation has four steps, and the `Makefile` carries all four beside the
number: (1) **split first**, because node applies the budget to each test *and* to the file-level subtest, so
the number that matters is the worst **per-file** runtime, not the worst test; (2) **measure that runtime
idle**, `node --test --test-concurrency=1 <file>` on a box running nothing else, reading `duration_ms` from
the TAP summary; (3) **multiply by 4.4**, the load headroom this project has measured — 6× and 14× CPU load
both green at 306/306 — where the retired 1.46× went red at 6× load; (4) **put the measurement beside the
number**: the file, its `duration_ms`, and the date. At this writing: worst idle file
`test/ddl-runner.test.ts` **9 036 ms** (S2 closeout, 2026-10-20) × 4.4 = 39 758 ms, rounded up to 40 000. The
per-file table that derivation reads, after the split, is `ddl-runner` 9 036, `nginx-e2e` 8 446, `env` 5 519,
`onboarding` 2 372, `cli-bootstrap` 1 665 ms. **Assertions about time do not live in this gate at all** —
every assertion that compares a duration or a rate belongs to `make test-perf`, which is why this budget can
be a multiple of the slowest file instead of a number a slow test drifts into.
```

**Corrected text, site 2 — the §16 S1 env row, replacing its `--test-timeout=15000` clause and nothing else.**

```markdown
| boot refuses any `^SK_|^SKUNK_` env key, naming it, and the gate cannot hang | env test: `spawnSync` with `{timeout: 5000, killSignal: 'SIGKILL'}`; `ETIMEDOUT` is a named failure ("the process booted instead of refusing: <key>"), never a wait — the 5 s child budget bounds *this* case; `make test` runs under `TEST_TIMEOUT_MS`, derived per §16's preamble, so a regression anywhere is a named red test and never a CI job timeout; the child's stdout must not contain "listening" |
```

**Which gate owns time-based assertions now: `make test-perf`.** It runs `test/perf/*.perf.test.ts` only, and
it runs behind `scripts/perf-preflight.mjs`, which prints the core count and 1-minute load average, **refuses**
(exit 2) above the core count, warns above half, and honours `SKW_PERF_FORCE=1` with a banner saying the
numbers are not a measurement. `make test` asserts **no wall-clock value at all**. Four assertions moved, and
each keeps a structural witness in `make test` (`S2-closeout.md` §3.1–§3.2):

| Moved out of `make test` | Now | Structural witness that stayed in `make test` |
|---|---|---|
| `S2E-2` `cost_ms_max <= 1.5` (worst of 200) | `P-1`, drift alarm on the **median** | `S2E-2` still asserts the measurement happened: `typeof cost_ms_max === 'number'`, finite, `> 0`, `cost_rows`, the stored row's columns |
| `V1-4` an expensive view body refused by the real 1.5 ms ceiling | `P-2` (refuses at 26.1–37.7 ms) | `V1-4`'s monotone `budgetMsMax: 0` form (same code, `limit_ms === 0`) plus its positive control `cost_ms_max > 0` |
| `S2E-22` `published.cost_ms_max <= 1.5` over HTTP | `P-3` | `S2E-23` (C-18 refusal through the route), `S2E-24` (CSRF) |
| `admin-auth` case 4, three login medians within 20 %, n=60 | `P-4` | case 4's status 401 / `SKW_E_SEC_AUTH_INVALID` / no cookie / no `Location` / byte-identical scrubbed bodies, and `4b`'s TOTP-computation count |

**Three things that look like time and are not, and must not be dragged into the perf gate.** (1) Clock
arithmetic computed from configuration — `expiresAt − now ≈ 60 min ±5 s` in `admin-auth` case 3 and the 15 min
expiry in `admin-session`; the slack is 5 s on 60 min and no load moves it. (2) Harness **deadlines** that
bound a wait and fail with a message — nginx up to 15 s, `spawnSync` 5 s, and the 17 MiB body's attempts
(3 → 8, count in the failure message). (3) Structural contention — `ddl-runner` `C7`'s `waitedFor >= 1`, where
more load means more contention, not less. Moving any of these would make the deterministic gate wait on the
clock to learn nothing.

**This does not weaken any correctness assertion.** Evidence, all of it measured (`S2-closeout.md`
§3.4–§3.6, §5):

- `make test` **306/306** at idle (38.7 s), at **6×** CPU load (47.0 s) and at **14×** (48.8 s) — 14× being
  the level at which QA lost the 17 MiB response and recorded 13 of 300 red in `hermes verify`.
- `SKW_ALLOW_SKIP` was never set, and `scripts/run-node-tests.mjs` still makes a skip a failure (E-8, E-15).
- The one measurement that got **stronger** is a fixture: the 14× run found `V1-1` failing with
  `cost_ms_max 12.358 ms exceeds the 1.5 ms budget`, because `POSTS_VIEW` still published against the default
  ceiling; it now states `budgetMsMax: 1_000` like `POSTS`. A flake found by measuring, not a band widened to
  hide one.
- The one regression only `make test-perf` can see is **named rather than deleted**: an unknown email that
  skips the argon2 verify entirely — identical body, identical code, identical TOTP count, only the medians
  move; `P-4` is its only witness. That is why the gate exists.
- `make test-perf` is **not** a CI check and must not become a required one until CI has an idle runner: it
  measures the box, and the best window available for this pass was a **warning** run at load 4.26 of 8 cores
  — stated as a warning, not called idle.

**Test that must change.** No test file changes: `Makefile`'s `TEST_TIMEOUT_MS` is already 40 000 and `make
test` already passes `--timeout=$(TEST_TIMEOUT_MS)` to the single runner. The gate that must change is the
**frozen-quote** gate, because it cannot see this row today — `check_frozen.py` does not quote §16 S1's env
row, which is why `make verify-frozen` was green with a false number in the SDS. The builder item below adds the
row to the quoted set under the marker `SUPERSEDES SDS.md §16 S1's env row (--test-timeout)`, asserting the
retired clause absent and the replacement present. `POINTERS` (`check_frozen.py:206`, `range(1, 24)`) also
moves to `range(1, 26)` when E-24's and E-25's pointer lines land.

**Recorded, not closed — three invocation paths, three budgets.** `make test` passes 40 000. A bare
`node scripts/run-node-tests.mjs <files>` still defaults to **15 000** (`run-node-tests.mjs:34`, and its header
comment says "default 15000"), so the retired number survives on the path that is meant to be "exactly one
way the suite is invoked". `npm test` — what `hermes verify` runs — does not go through the runner at all and
therefore has no `--test-timeout` and no skip-is-failure (pre-existing, recorded in §8's "not defects" list,
unchanged here). And the `Makefile` comment's derivation cites "8.99 s" for `ddl-runner`, which is that
file's **pre-split** figure; the post-split measurement is **9 036 ms** (§3.3's second column). None of the
three changes a verdict — 40 000/9 036 = 4.43× and 40 000/8 990 = 4.45× — but a reader re-deriving from the
comment would copy the wrong column, so the corrected figure is stated here and the comment is a one-line
builder correction, not a spec change.

**Severity: minor (specification), load-bearing.** The frozen sentence was false and believing it is how the
gate was narrowed into a flake; the code already carries the derived budget, so no work is blocked by the text
being a pass late.

---

### Builder items this section owes — ordered, each naming the file and the gate that proves it

| # | Item | Files | Gate that proves it |
|---|---|---|---|
| 1 | **E-24** paste the §6.2 drop-in in place of the "A `limit` that is not an integer is refused, not ignored." paragraph; the `Math.floor` sentence is retired by that replacement, and E-23's "floors to 2" sentence is retired in effect (no `SDS.md` text carries it) | `docs/sds/SDS.md` §6.2, plus its pointer line (`> Amended by 02-errata.md E-24.`) | `make test`'s quote phase — the retired sentence absent, the replacement present verbatim |
| 2 | **E-25** paste the §16 preamble paragraph and the corrected S1 env row, with its pointer line (`> Amended by 02-errata.md E-25.`) | `docs/sds/SDS.md` §16 preamble and S1's table | same quote phase; the retired clause absent, the replacement present |
| 3 | **E-24, E-25** register the two supersessions in the checker: `item='E-24'` with marker `SUPERSEDES SDS.md §6.2's "The clamp is Math.floor on a number" sentence`, and `item='E-25'` with marker `SUPERSEDES SDS.md §16 S1's env row (--test-timeout)`; add the env row to the quoted set, which is the row the checker cannot see today | `scripts/model/check_frozen.py` | `make verify-frozen` green, **and** re-inserting `--test-timeout=15000` into that row turns it red (prove it red once, then restore) |
| 4 | **E-24, E-25** extend the pointer range to `range(1, 26)` | `scripts/model/check_frozen.py:206` | the pointer phase reports 25/25; renaming one pointer line turns it red |
| 5 | **E-25**'s recorded correction: the derivation comment cites 8.99 s, which is `ddl-runner`'s **pre-split** figure; the post-split measurement is 9 036 ms | `Makefile:92–94` (comment only) | **none — and said plainly:** a comment is not a gate. The number a reader re-derives is the one in §16's preamble, and 8.99 s would put them one column to the left |

Items 1 and 2 are independent; 3 requires both (it quotes their output), and 4 requires 3.

---

### Traceability — E-24, E-25

| E | Closes | Source (verified in this pass) | Severity |
|---|---|---|---|
| E-24 | §6.2's flooring sentence contradicts the refusal row two sentences above it and E-23's own test sentence; applied verbatim it re-opens D5, and a floored `limit` returns a page with the wrong number of rows and no signal | `S2-closeout.md` §2 (the four shapes at publish and resolve, `M5-1`, the `d11dd76e…` mutation), §6 item 1; `SDS.md:1072` (the row) and `:1082–1084` (the paragraph, quoted above); `02-errata.md` §8 (post-S2-QA) E-23, "Test that must change"; `app/sources/compile.ts:126–134`; `app/sources/spec.ts:139–148,222–223` | major (specification) |
| E-25 | the frozen suite budget is 1.46× the file it has to cover, so 6× load fails a file whose every test passes; the number is now derived (4.4× the worst remaining idle file) instead of asserted | `S2-closeout.md` §3.3 (per-file table both columns, `duration_ms 15009.712459`, the 4.4× derivation), §3.4 (306/306 at 6× and 14×), §5, §6 item 2; `SDS.md:2489`; `Makefile:86–97`; `scripts/run-node-tests.mjs:34`; `scripts/perf-preflight.mjs` | minor (specification) |
| — | **carried, not separate items:** §16 S1's env row goes under `check_frozen.py`'s quote phase (inside E-25); `POINTERS` to `range(1, 26)` (inside E-25); E-23's "floors to 2" test sentence retired in effect (inside E-24); the `Makefile` comment's 8.99 s corrected to 9 036 ms (inside E-25) | E-24, E-25 | — |
| — | **open, not closed here:** `limit_default > limit_max` is accepted at publish and unclamped on a render that sends no `limit`, so the clamp row is false for the default path — needs its own item and a decision between a publish refusal and a render clamp | `app/sources/spec.ts:141`; `app/sources/compile.ts:161–172`; `schema/site.sql` `cms_datasource.spec_json` (`json_valid` only) | minor (specification) |
| — | **open, not closed here:** the runner's bare-invocation default stays 15 000 and `npm test` has no budget at all, so "the suite runs under a derived budget" is true of `make test` only | `scripts/run-node-tests.mjs:34`; `package.json`; `S2-closeout.md` §3.6 | minor (build) |

---

## 12. Errata E-26..E-28 (post-S3)

**Status:** amendment of record for `docs/sds/SDS.md` and `docs/sds/00-adjudication.md`, issued after
`docs/build/S3c-report.md` §8.3 and `docs/build/S3d-report.md` §8.5 declined to resolve a frozen contradiction
in their own slices and §9.2 of the later report handed it back, and after `S3d-report.md` §2.10 disclosed a
third defect of a different kind: **every gate in the tree would have passed while every production download
was a 503.**

**Date:** 2026-10-20. **Author:** Architect. **Scope:** the specification. No implementation file is edited by
this pass. Each item carries the corrected text verbatim; a Builder applies it and adds the pointer line.

**Three items.** E-26 and E-27 formalise decisions the CEO has already taken — `IDEA.md` §2 **D32** and **D33** —
which the SDS has not absorbed; in both places the code chose the older sentence, correctly, because the older
sentence was the frozen one. E-28 is not a decision but a **missing gate**: it adds the rule whose absence let a
`.ts`-only worker URL reach production (`S3d-report.md` §2.10) with 404/404 green. None of the three weakens a
frozen control. E-26 keeps the ten-minute authorisation expiry as the gate on every *new* redemption and makes
the grace a strictly narrower permission that cannot spend a use; E-27 adds a bound and removes none; E-28 adds
a gate and retires none.

**Numbering.** §11 above is E-24 and E-25. This section is §12, and no citation above this line changes.
`check_frozen.py`'s `POINTERS` is `range(1, 24)` today (`scripts/model/check_frozen.py:206`) and the check
reports `pointers: 23/23`, so the pointer lines E-24 and E-25 owe were never pasted into `SDS.md`; item 8 below
moves the range to `range(1, 29)` and lands all five, because a pointer range that stops at 23 is the same
defect as a gate that stops at the slices it was written for.

**Precedence, and the supersessions this section relies on** (§1's order is unchanged):

1. **E-26 `SUPERSEDES 00-adjudication.md §4.4's payload line`** — the payload gains `"cexp"`. A second expiry
   cannot live in configuration alone: the grace is a property of the *token* (a leaked one must know its own
   end), and a settings edit must not retroactively shorten or extend a token already in a buyer's browser.
   `check_frozen.py` does not quote the payload line — its `"token wire format"` block is the `v1.…` line only —
   so no `SUPERSEDED` entry is required and `make verify-frozen` stays green; the marker is here because §4.4
   is a frozen contract and precedence rule 2 requires the marker, not because a checker would notice.
2. **E-26 `SUPERSEDES 00-adjudication.md §4.4's cookie clause "600 s"`** — the clause becomes `cexp − iat`.
   The quoted block is `__Host-sk-dl-<tenantKey>=<token>; Path=/; Secure; HttpOnly; SameSite=Lax` with no
   `Max-Age`, so the block is untouched; the clause is prose, and prose is where the number lived.
3. **E-26 `SUPERSEDES R5b's sentence "An expired token: `exp - iat` is still 600, so only the clock can refuse
   it"`** (`test/download-redeem.test.ts:341`, quoted as the rule in `S3c-report.md` §3.4 and relied on in
   `S3d-report.md` §8.5). The **assertion** it guards survives for the token R5b actually builds; the
   **sentence** does not, because `exp` stops being a verification-time refusal and becomes an
   authorisation-time one. The security intent is preserved and narrowed: an expired token still cannot create
   a redemption, and can now only continue one that a live token already created, on the same IP/UA pair,
   until `cexp`. This is the one supersession in this item that is a *code* change as well as a text change
   (`app/download/token.ts:134`).
4. **E-26 `SUPERSEDES SDS.md §7.5's clause "after the token that produced it expires"`** — "the token expires"
   now means `cexp`, the last instant a request against it may be served, not `exp`. A render's `expires_at`
   is `cexp + download.continuation_grace_s` (43 200 s from mint at the defaults). The alternative — keeping
   `exp + grace` — deletes the file 6 h 10 min after mint while the last permitted request is at 6 h 00 min
   and a transfer it starts may run 1 024 s, i.e. it deletes a render under a running transfer, which is the
   failure W7's re-stamp would mask as a slow download.
5. **E-27 supersedes nothing.** It replaces a sentence of `SDS.md` §7.5 with a longer one and adds three
   paragraphs; no register artefact moves.
6. **E-28 supersedes nothing.** It adds a paragraph to §16's preamble and extends §13.1a's rule 2 to a second
   class of witness; the existing witness table (`test/witness.test.ts`) keeps its shape, because its `W5`
   row asserts `file` matches `^test/.*\.test\.ts$` and the dist gate is not a `test/` file.
7. **§1's marker count moves.** §1 says "There are five such markers: E-1, E-2, E-4, E-11 and E-13". E-26 adds
   four (numbers 1–4 above). The builder item 9 replaces that sentence; until it lands, the sentence is wrong
   by four and no checker can see it.

---

### E-26 — §7.4 promises a continuation grace while every gate refuses an expired token; one token now carries two expiries

**Defect.** Three texts, one behaviour, and they cannot all hold:

- `SDS.md:1282–1286` (**Continuation grace**): "A request with an expired token is served without consuming
  **iff** the MAC verifies, `iph`/`uah`/`aid` match, a `cms_download_event` row exists with that `jti` and
  `kind='first'`, the code is not revoked, and `now - iat ≤ download.continuation_grace_s` (default 21,600)."
- `SDS.md:1260–1264` (verification order), identical to `00-adjudication.md` §4.4: "(5) `exp - iat = 600`
  **and** `iat ≤ now + 30`; (6) `iph`/`uah` match; (7) `aid` matches the route; (8) DB consume." Step (5)
  contains **no** `now ≤ exp` test — the frozen contract never said an expired token is a verification
  failure.
- `S3c-report.md` §3.4 and the gate it quotes, `test/download-redeem.test.ts:341–345`: "An expired token:
  `exp - iat` is still 600, so only the clock can refuse it" → `401 SKW_E_SEC_TOKEN_INVALID`.

The Builder implemented the third. `app/download/token.ts:134` is `if (claims.exp < nowS) return { ok: false,
reason: 'claims' }`, so a request with an expired token never reaches step (8), and §7.4's grace is
unreachable code. `S3c-report.md` §8.3 states it ("Continuation grace is not implemented"), `S3d-report.md`
§8.5 states the consequence ("a download resumed after 600 s needs a fresh redemption, while its render stays
on disk for 6 hours"), and §9.2 of that report hands the contradiction back rather than choosing. `S3d-report.md`
§8.5 is right that the two sentences cannot both be implemented, and `S3c-report.md` §8.3 is right that the
grace is simply not wired. The resolution is **D32**, and it is not "delete the grace": it is "one token, two
expiries".

**The decision, and why.** D32 (`IDEA.md` §2): a download token carries an **authorisation expiry** (`exp`,
`iat + 600`, unchanged) and a **continuation expiry** (`cexp`, `iat + download.continuation_grace_s`, default
21 600). `exp` gates every *new* redemption — it is the only expiry that can spend a use. `cexp` permits
*only* the continuation of a redemption that already exists, on the same IP/UA pair, and nothing else. The
narrower permission is what makes a six-hour grace safe: a leaked token can never create a use, never write a
`first` row and never reach a file it did not already buy; it can finish a transfer that was already
authorised, and it dies at `cexp` whatever the buyer does. The case that needs it is §7.4's own: 1 GiB at
`limit_rate 1m` is 1 024 s, which is longer than the ten-minute window, and re-entering the code mid-transfer
is the UX that produces refund requests (D32's rationale). A mint is idempotent per (code, asset, IP, UA)
inside the grace window so that re-entering the code returns the same `jti` and spends no second use.

**Corrected text — drop-in for `SDS.md` §7.4, replacing (i) the wire-format block, (ii) the "Verification
order" paragraph, (iii) the "Continuation grace" paragraph and (iv) the `600 s` clause of the "Cookie"
paragraph, and nothing else.**

```markdown
~~~
v1.<base64url(payload)>.<base64url(HMAC-SHA256(SKW_DOWNLOAD_TOKEN_KEY, "v1." + payload))>
payload = {"jti":"<128-bit hex>","cid":<code id>,"aid":<asset id>,"iat":<unix s>,"exp":<unix s>,
           "cexp":<unix s>,"iph":"<22 chars>","uah":"<22 chars>"}
~~~

`exp = iat + 600` is the **authorisation expiry**: the only expiry that permits a use to be spent.
`cexp = iat + download.continuation_grace_s` (default 21 600, ceiling 86 400; `cexp ≥ exp`, so a grace of 0 is
legal and makes the second window empty) is the **continuation expiry**: it permits a request to finish a
redemption that `exp` already authorised, and nothing else. One token, two permissions, and the narrower one is
deliberately the longer one.

Verification order, each step a contract: (1) split on `.`, exactly three parts; (2) require `v1`; (3)
base64url-decode the MAC and require **exactly 32 bytes before comparing** (a length mismatch makes
`timingSafeEqual` throw `ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH`, which surfaces as 500 instead of 401); (4)
`timingSafeEqual`; (5) `exp - iat = 600`, `cexp ≥ exp`, `cexp - iat ≤ 86 400` **and** `iat ≤ now + 30`; (6)
`iph`/`uah` match; (7) `aid` matches `cms_download_code.asset_id`, not the route; (8) authorise against the
clock and the ledger, in the two windows below. **No `JSON.parse` before step 4.** Step (5) contains **no**
`now ≤ exp` test on purpose: whether an expired token may be served is a question about the ledger, and step
(8) is where the ledger is. The 86 400 s ceiling is this errata's addition: without it the grace is whatever a
`cms_settings` row says, and "a leaked token buys one asset for at most six hours" becomes a claim about
configuration rather than about the token. A token minted before a grace increase keeps its own `cexp`; the
check is against the claim, never against the current setting.

| `now` | Permission | What the server may do | What it must never do |
|---|---|---|---|
| `now ≤ exp` | **authorisation**, and continuation | `INSERT … 'first'` (one use, §7.3) and serve; or, if this `jti` already has an `ok` `first` row, serve as a continuation and spend nothing | serve without the stat, stamp and range checks of §7.4's order |
| `exp < now ≤ cexp` | **continuation only** | serve **iff** the MAC verified, `iph`/`uah` matched, `aid` is this code's asset, a `first` row exists for this `jti` with `outcome='ok'`, and the code is not revoked; no use is spent and no event row is written | insert a `first` row, move `uses`, or create a redemption of any kind — a token past `exp` can continue a purchase, never make one |
| `now > cexp` | none | `401 SKW_E_SEC_TOKEN_INVALID`, `reason='continuation_expired'`, cookie cleared | reach the database |

A request in the middle window whose `jti` has no `ok` `first` row is `401 SKW_E_SEC_TOKEN_INVALID`,
`reason='no_redemption'`: the token is authentic and names a purchase that never happened, so it is not a
continuation and it cannot become one. **Denial is still not a continuation** — a `first` row with
`outcome != 'ok'` refuses in both windows (C-4), and a quota denial is not a licence to retry.

| Endpoint | Reads the cookie? | Expiry it checks | What it answers when that expiry fails |
|---|---|---|---|
| `GET /d/<key>` — the form | no | none: a token is never parsed on this route | nothing to fail — `200` and the form. An invalid or expired cookie cannot turn the form into an error page. |
| `POST /d/<key>` — redeem and mint | no | none: it **sets** `exp` and `cexp` | `401 SKW_E_SEC_CODE_INVALID` for a bad, revoked or expired *code*, `429 SKW_E_SEC_RATE_LIMITED` for the limiter. Neither is a token expiry. |
| `GET /d/<key>/file` — the download | yes | `cexp` at step (5), then `exp` at step (8) | `401 SKW_E_SEC_TOKEN_INVALID` (`continuation_expired`, or `no_redemption` in the middle window), `401 SKW_E_SEC_TOKEN_MISMATCH` for `iph`/`uah`/`aid`, `410 SKW_E_SEC_USES_EXHAUSTED` in the first window only; `303` to `/d/<key>` when there is no cookie at all, which is a browser that has not redeemed yet and not a failure |

**Minting, and why a resume spends no second use.** `POST /d/<key>` sets both expiries and chooses `jti` as
follows: if a `cms_download_event` row exists with `kind='first'`, `code_id = cid`, `asset_id = aid`,
`ip_hash = iph`, `ua_hash = uah`, `outcome = 'ok'` and `now − ts ≤ download.continuation_grace_s`, that row's
`jti` is reused; otherwise the mint takes a fresh 128-bit `jti`. A row exists exactly when a use was spent, so
the lookup costs nothing when there is nothing to reuse, and it is a seek on `ix_ev_code_ts` plus a filter over
one code's rows (`cms_download_code.max_uses ≤ 100`). A re-typed code, from the same IP and User-Agent, inside
the window therefore yields the same `jti`, which `consumeUse` sees as a continuation through
`ux_ev_jti_first` — the resume spends nothing. `iat`, `exp` and `cexp` are re-stamped at every mint: the
authority to mint is the **code**, never the token, so a leaked token cannot mint and cannot extend itself.

**Cookie.** `__Host-sk-dl-<tenantKey>=<token>; Path=/; Secure; HttpOnly; SameSite=Lax`, `Max-Age = cexp − iat`
(`download.continuation_grace_s`, default 21 600). `__Host-` requires `Path=/` and no `Domain`; the tenant key
in the **name** prevents shadowing on a shared origin, and `Path=/` is what makes the prefix legal. The asset
binding is in the token (`aid`), not in the cookie path. The cookie lives as long as the narrower permission;
it is the authorisation inside it, not the cookie, that dies in ten minutes.
```

**Test that must change.**

1. **`test/download-redeem.test.ts` `R5b`** — its `claims` object (`:325`) gains `cexp: nowS + 21_600`,
   otherwise every token it mints is refused at step (5) as a missing claim and the case passes for the wrong
   reason. Its third block (`:341–345`) keeps the assertion `401 SKW_E_SEC_TOKEN_INVALID`, but the token it
   builds is now a **no-redemption** case — that `jti` has no `first` row and the code was only issued, never
   downloaded — so the asserted `detail.reason` is `no_redemption`, and the comment "only the clock can
   refuse it" is deleted. The sentence is superseded by this item; the assertion is not.
2. **New `R13` in the same file — the window table, six cases.** (a) live token → `200`, one use; (b) the same
   token with the clock past `exp` and its `first` row present → `200`, `uses` unchanged, no new row; (c) past
   `cexp` → `401`, `detail.reason='continuation_expired'`, no use; (d) past `exp`, no `first` row → `401`,
   `no_redemption`; (e) past `exp`, another IP or User-Agent → `401 SKW_E_SEC_TOKEN_MISMATCH`; (f)
   `cexp - iat = 86_401` → `401` at step (5). Case (b) is the one that makes the grace a fact rather than a
   reachable paragraph.
3. **New `R14` — mint idempotency.** Two `POST /d/<key>` from one IP/UA inside the window return two tokens
   with equal `jti` and different `iat`; the first download spends one use and the second token's download
   spends none; `uses = 1` and exactly one `first` row.
4. **New `W13` in `test/download-watermark.test.ts` — the render's lifetime follows `cexp`.** After a
   successful download, `cms_watermark_render.expires_at = token cexp + download.continuation_grace_s`; and a
   request past `cexp` is refused before the stamp, so it writes no render row. `W7` keeps its forced-past
   case untouched — it sets the column itself and asserts the sweep, not the arithmetic.
5. **No existing test goes red by accident.** No test asserts the download cookie's `Max-Age` (`R1` asserts
   `; Path=/; Secure; HttpOnly; SameSite=Lax` and stops there) and no test asserts a render's `expires_at`
   value; both were checked before this item was written.

**Recorded, not closed — the resume key is the client, not the code.** A buyer who changes network or browser
mid-transfer gets a new `jti` and spends a use for the resume, because the mint lookup is keyed by
`ip_hash`/`ua_hash`. That is D32's own key ("per (code, asset, IP, UA)") and is not narrowed here. The
alternative — keying on the code alone — would let a code shared in a chat be resumed from any client, which
is exactly the leak `iph`/`uah` exist to close.

**Severity: major (specification).** §7.4's grace is unreachable as implemented, so the document promises a
resume it cannot deliver while the gate that refuses it is green; and D32 is a CEO decision the SDS has not
absorbed in either direction. The security posture is unchanged by the fix and is in one respect stronger: one
expiry now means one permission instead of two implied ones.

---

### E-27 — §7.5 caps eight renders per tenant and nothing at the box, so N busy tenants are 8 × N workers on a machine that also serves pages

**Defect.** `SDS.md:1296–1299` ends its measurement paragraph with "hence: off-loop, 2 s cap, per-tenant
semaphore of 8", and that is the whole concurrency rule: `STAMP_CONCURRENCY = 8`
(`app/download/render.ts:58`) is a per-tenant `Semaphore` created lazily per tenant key (`:207–213`). On a
one-tenant box that is correct. On the box this product is sold as — several tenants, one Node process, one
nginx — the ceiling is `8 × active tenants` workers of ~50 MB each (D33's round-2 measurement), and the
`Semaphore` has no notion of a second bound (`app/admin/auth.ts:71–102`). `S3d-report.md` §8.8 states it
plainly: "One worker per stamp means up to 8 × tenants workers. The cap is per tenant by spec. A box with many
simultaneously-active tenants has a memory ceiling that is 8 × N, not 8." And the budget does not bound the
wait: the 2 000 ms timer starts **inside** the acquired slot (`render.ts:341`), so a request queued behind a
saturated tenant waits without any deadline at all, and only then starts its two seconds.

**The decision, and why.** D33 (`IDEA.md` §2): per-tenant **8**, process-global **`max(4, cores)`**, and the
global one binds. The per-tenant cap exists because one tenant's burst must not starve the others; the global
cap exists because the box's memory is the box's, not a tenant's, and a busy night must not become an OOM on a
machine that is also serving pages. "Cores" is defined here as `os.availableParallelism()` — the CPUs this
process may actually use — because `os.cpus().length` reports the host inside a container with a CPU quota
(`--cpus=2` on a 16-core host would size the cap at 16 × 50 MB), and the cap exists to bound RSS on the box
that runs it. The floor of 4 is D33's and is kept: a two-core box may run four renders (~200 MB) because a cap
of one or two turns two simultaneous buyers into a queue that fails both.

**Corrected text — drop-in for `SDS.md` §7.5, replacing the final sentence of the "Numbers:" paragraph
("hence: off-loop, 2 s cap, per-tenant semaphore of 8.") with the first paragraph below, and inserting the
three paragraphs that follow it after that paragraph; nothing else in §7.5 changes.**

```markdown
**Two semaphores, and the global one binds.** Stamping runs under a **per-tenant** semaphore of **8** and a
**process-global** semaphore of **`max(4, os.availableParallelism())`** — the CPUs this process may actually
use, not the host's core count, because a container with a CPU quota must not size its memory ceiling from
cores it cannot run on. The effective concurrency for one tenant is `min(8, max(4, availableParallelism()))`
and for the box is `min(8 × active tenants, max(4, availableParallelism()))`: at eight usable cores eight
stamps run at once however many tenants are busy, and one tenant on a quiet box still gets all eight. At the
measured ~50 MB per worker (D33) the global cap is the box's memory ceiling, which is the point.

**Acquisition order is tenant, then global; release is the reverse.** The order is fixed and total, so no
request can hold one semaphore and wait for the other in the opposite order, and there is no deadlock to
reason about. A tenant's requests queue on its own eight slots; the box's slots are taken last, so no request
occupies a scarce box slot while waiting for a tenant that is already full.

**The 2 000 ms budget is the request's, not the renderer's.** It starts when the request reaches the stamp
stage — before either acquisition — and covers queueing, both acquisitions, worker start and render. A request
still queued when the budget expires is refused **without a worker being started**: `503
SKW_E_SEC_WATERMARK_FAILED`, `detail.reason='queue'`, `detail.budget_ms`, `detail.queued_ms`, no render row, no
file, no `X-Accel-Redirect`, and exactly one `cms_download_event` row with `kind='first'`,
`outcome='denied_watermark'`, `bytes_declared=0`, `bytes_sent` NULL, the token's `jti`, `ip_hash` and
`ua_hash`; `uses` is not moved. A request that acquires its slot at 1 990 ms has ten milliseconds left and
times out with `detail.reason='timeout'` — that is the same budget doing its job, not a second one. Because
the denied row is a `first` row with `outcome != 'ok'`, a retry under the same `jti` is refused again (C-4:
a denial is not a continuation); the buyer recovers by redeeming the code again, which mints a fresh `jti` and
spends nothing extra.

**Where the global semaphore lives, and what the counters count.** One per process, created once at boot by
the module that owns the store and shared by every tenant's render path; `buildApp`'s injected
`WatermarkStore` takes it as an option so a test can size it, and production has no option that creates a
second one — two stores in one process would be two global caps, the same defect at a smaller scale. The
in-flight and peak counters the gates read count **renders**, not queued requests, so "peak 8" continues to
mean eight workers.
```

**What happens to a request that waits past the budget while queued, and what the ledger records.** It is
refused at the deadline: `503 SKW_E_SEC_WATERMARK_FAILED` with `detail.reason='queue'`,
`detail.queued_ms` and `detail.budget_ms=2000`; no worker is created, so no worker is terminated and no render
row and no file are produced; the ledger gets one `first` row with `outcome='denied_watermark'`,
`bytes_declared=0`, `bytes_sent` NULL, the token's `jti` and the request's `ip_hash`/`ua_hash`; `uses` is
untouched, and a retry under the same `jti` writes no second row. The render cache records nothing, because
nothing was rendered.

**Test that must change.**

1. **`test/download-watermark.test.ts` `W6`** — extend from one tenant to two against an injected global
   capacity of 4: 8 requests per tenant, all 16 settle, the peak **across both tenants** is ≤ 4 and each
   tenant's own peak is ≤ 4. A sleeping renderer, no wall clock, so it belongs in `make test`. With the
   global semaphore removed the peak is 8 and the case is red; that mutation is the negative control.
2. **New `W14` — the queue deadline.** Global capacity 1 held by a renderer that does not settle, budget
   40 ms (the precedent is `W5`), second request → `503` with `reason='queue'`, one `denied_watermark` row
   with `bytes_declared=0`, `uses=0`, no `cms_watermark_render` row, no file, no `X-Accel-Redirect`; and a
   retry under the same `jti` is still a denial, so the ledger holds one row and not two. Second mutation:
   start the budget at acquisition (`render.ts:341`'s current placement) instead of at arrival → `W14` red
   and `W6` green.
3. **`test/perf/watermark-concurrency.perf.test.ts` `P-S3d-1`** — keep "exactly the cap", but state the cap as
   `min(8, max(4, availableParallelism()))` and print both numbers. On this 8-core box that is 8 and the case
   is unchanged; on a 2-core box the old `8` would have been red for the wrong reason. No third perf case is
   added: a cross-tenant case that injects its capacity is a deterministic test and belongs in `W6`, where it
   cannot flake on the box.

**Recorded, not closed — ~50 MB per worker is round 2's measurement, not this slice's.** Neither `make test`
nor `make test-perf` measures RSS, and this item does not propose one: a memory assertion in `make test` is a
flake and one in `make test-perf` measures the box. The cap is the control; RSS is the operational thing to
watch, and `S3d-report.md` §8.8 is where that was first said.

**Severity: major (specification), correctness of the bound.** The per-tenant-only ceiling is 8 × N on a
machine that also serves pages, and the budget that was supposed to bound the wait starts after the wait. The
code is not wrong about the number it was given; the number it was given is not a box bound.

---

### E-28 — every gate runs the TypeScript source, so a path that resolves only under type stripping is invisible

**Defect.** `S3d-report.md` §2.10: under the test runner `import.meta.url` ends in `.ts`, so
`new URL('./stamp-worker.ts', …)` resolves, every test passes — and from `dist/` the same line names a file
that does not exist, every stamp throws, and **every paying download is a 503**. The fix is in the tree
(`stampWorkerUrl` follows the module's own extension, `app/download/render.ts:130–132`). The gap is not:
nothing in `make test` executes one line of `dist/`. `make verify-s1` is `build typecheck` then
`scripts/run-node-tests.mjs` over `test/**/*.test.ts` (`Makefile:107–108`), i.e. the modules are imported from
`app/`, and `npm test` (`package.json:13`) is the same runner with no build at all.

Measured this pass, importing the built modules as a `dist` consumer does:

```
stampWorkerUrl(dist/app/download/render.js)  ->  …/dist/app/download/stamp-worker.js    exists: true
the same directory's `.ts` sibling           ->  …/dist/app/download/stamp-worker.ts    exists: false
REPO  in dist/test/helpers/fixture.js        ->  …/skunkworks/dist
SCHEMA from the same file                    ->  …/skunkworks/dist/schema                 exists: false
```

The `.ts` form is a 503 on every stamp and no gate in the tree reddens. `W3`
(`test/download-watermark.test.ts:303–317`) is the twin that made it invisible: it calls the *function* twice
and asserts the string it returns ends in `stamp-worker.js` — it never checks that the file exists and never
starts a worker. `scratch/s3d/probe-dist.mjs` proved the fact by hand (`S3d-report.md` §2.10), and `scratch/`
is not a target: by §1 rule 4 a build report is evidence, not authority, and a probe is not a gate.

**Second instance, measured this pass, same class.** `tools/regen_conf.ts:8–13` imports `REPO` and
`makeFixture` from `test/helpers/fixture.ts`, and `REPO` is
`join(dirname(fileURLToPath(import.meta.url)), '..', '..')` (`test/helpers/fixture.ts:11`). Compiled, that file
is `dist/test/helpers/fixture.js`, so `REPO` is `…/dist` and `SCHEMA` is `…/dist/schema`, which does not exist
— `node dist/tools/regen_conf.js` cannot work, and no gate runs it. It is not shipped (`Dockerfile.app` copies
`app`, `tools`, `schema` in the build stage and only `dist`, `build`, `schema` into `/srv/app`), which is
exactly why it survived: a developer's afternoon, not a customer's download. The rule below covers it anyway,
because the class is the resolver, not the blast radius.

**The rule — drop-in for `SDS.md` §16's preamble, a new paragraph after E-25's budget paragraph.**

```markdown
**A path or URL computed at runtime is proved on the built artefact, never on the source.** Any code path that
resolves a URL or a path from a value that differs between `app/**/*.ts` and `dist/app/**/*.js` —
`import.meta.url`, `process.argv[1]`, `process.cwd()`, `require.resolve`, and any relative join against one of
them — must have **at least one gate that runs the built artefact**: `make verify-dist`, which builds first
and then executes `dist/` as a child process. A gate that imports the `.ts` module and calls the function is a
*source* gate: it proves the function's logic and is blind to the resolution, because under Node's type
stripping `import.meta.url` ends in `.ts` and every `.ts`-relative sibling exists. The class boundary is the
resolver, not the I/O: a path assembled from an absolute configured root (`SKW_DATA_DIR`, the app's
`contentRoot`) and a database value computes the same string in both worlds and is covered by the ordinary
suite; a path assembled from the module's own URL is not. A new site in this class is a new row in the
register and a new `D<n>` assertion in `make verify-dist`, or it is a `DIST_EXEMPT` entry with a reason — there
is no third option, and "the test suite passes" is not one of them.
```

**Where the gate lives: `make verify-dist`, a new target, wired into `verify` so `make test` runs it.**

```make
verify-dist: build
	@node scripts/dist-gate.mjs
```

It is **not** a `test/**/*.test.ts` file, deliberately: `npm test` is the bare runner (`package.json:13`) and
does not build, so a dist case inside `test/` would either fail on a clean tree or be given a skip — and a skip
is a failure here (E-8, E-15). It needs no nginx and no Docker: the app is the system under test and
`X-Accel-Redirect` is asserted on the header, not on the bytes.

| id | the gate runs | the site it proves |
|---|---|---|
| **D1** | `node dist/app/main.js` with the six boot keys and a scratch `SKW_DATA_DIR`; `GET /healthz` → `200` within 15 s | `isMain` (`app/main.ts:672`), `schemaDirFrom`/`findProjectRoot` (`app/main.ts:147`, `app/db/migrate.ts:231`) — the boot path, in the layout the image has (`dist/` beside `schema/` and `build/`, `Dockerfile.app:16–23`) |
| **D2** | `GET /` → `200` with a rendered page | `astroHandler`'s `build/astro/server/entry.mjs` (`app/main.ts:443`) — reached only on the first page render, never by `/healthz` |
| **D3** | one redemption end to end: `POST /d/<key>` → `303` + cookie, `GET /d/<key>/file` → `200`, `x-accel-redirect: /__protected/wm/…`, the named file exists and is not the blob | `stampWorkerUrl` (`app/download/render.ts:130–132`) and `new Worker(…)` (`:141`) — the defect of §2.10, and the only assertion that would have been red |
| **D4** | `node dist/app/db/migrate.js --tenant all` on a scratch data dir → exit 0, `user_version` as the schema expects | `migrate.ts`'s `isMain` (`:246`) — the command `npm run migrate` ships |
| **D5** | `node dist/app/cli/skwctl.js admin bootstrap` on a scratch dir → the documented exit codes and the 0600 file | `skwctl.ts`'s `isMain` (`:693`) — the command `install.sh:167` runs, on the one box where nobody is watching |
| **D6** | `node dist/tools/nginx_gen.js --data-dir <fixture> --out <tmp>`, byte-compared with `nginx/conf.d/10-app.conf` | `nginx_gen.ts`'s `isMain` (`:257`) — the command `test/nginx-config.test.ts:188` names in its failure message and no gate has ever run |

D1–D3 run against the suite's own fixture — `makeFixture()` writes a `control.db` with one tenant and its
`site.db` into a temp directory (`test/helpers/fixture.ts`) — copied into a scratch `SKW_DATA_DIR`; the gate
never reads or writes `data/` or `content/`, so it cannot damage a developer's tree. The fixture is built by
the gate process, not by the artefact: the app under test is `dist/`, which is the only thing D1–D6 relax.

**How the existing suites are audited against the rule.** Two halves, and the second is what keeps it true.

*One-time audit.* Every occurrence of `import.meta.url`, `process.argv[1]`, `process.cwd()` and
`require.resolve` under `app/` and `tools/` was read, and each was either given a `D<n>` above or listed in
`DIST_EXEMPT`. There are **eight rows over five files** in the class today — the worker URL
(`render.ts:130–132`, `:141`), the schema dir (`main.ts:147`), the Astro entry (`main.ts:443`), the app's own
entry detection (`main.ts:672`), `migrate`'s `findProjectRoot` and `isMain` (`migrate.ts:231`, `:246`),
`skwctl`'s `isMain` (`skwctl.ts:693`) and the nginx generator's `isMain` (`nginx_gen.ts:257`) — mapped onto the
six assertions above. The ninth occurrence is `tools/regen_conf.ts`, and it is the `DIST_EXEMPT` entry with a
reason: its `REPO` is module-relative and wrong in `dist` (measured above), it is not copied into the runtime
image, and item 7 fixes it by taking the project root from `findProjectRoot` instead of from a test helper;
until then it may not claim a `D` row, because a gate over a tool nobody ships would be a gate over nothing.
It is also the instance that proves a green suite is not an audit.

*Ongoing register — `test/dist-witness.test.ts`, a `DIST_SITES` table of `{site, source, resolvedBy, gate}`.*
Three assertions, mirroring §13.1a's witness table: (1) every row's `gate` is an id that appears in
`scripts/dist-gate.mjs`, and `make verify-dist` prints each id with its site on success, so the link is a
transcript rather than a comment; (2) every occurrence of the four markers under `app/` and `tools/` is
claimed by a row or listed in `DIST_EXEMPT` with a reason (`new URL(req.url, …)` is request parsing; a test
helper's `import.meta.url` is not shipped); (3) an unclaimed occurrence fails, so the class cannot grow
silently — the half a one-directional table cannot see, exactly as `W3` of the existing witness table exists
for. The register lives in `make test` (it reads files and needs no `dist/`); the gate it points at lives in
`make verify-dist` (it needs `dist/` and a child process).

### E-28 audit — which existing gates satisfy the rule, and which need a built-artefact twin

| Gate, as it exists today | What it executes | Sites in the class it can see | Verdict |
|---|---|---|---|
| `make verify-s1` → `scripts/run-node-tests.mjs` over `test/**/*.test.ts` (`Makefile:107–108`), 404/404 at `S3d-report.md` §10 | the TypeScript modules, in-process, under type stripping | **0 of 8** | **fails** — needs the twin, for every site |
| `npm test` — the bare runner (`package.json:13`), also the path `hermes verify` uses | the same | **0 of 8** | **fails** — same twin, and no build at all |
| `make test-perf` (`Makefile:114–117`) | the same, plus wall-clock assertions | **0 of 8** | **fails** — it measures the stamped path *from source*, which is the path that was wrong (`P-S3d-2` is a source render) |
| `make build` (`Makefile:77–78`) | `tsc` → `dist/`, `astro build` | produces the artefact | **fails as a gate** — necessary, not sufficient; nothing executes what it emits |
| `make typecheck` (`Makefile:80–82`) | `tsc --noEmit`, twice | **0 of 8** | **fails** — a `.ts`-relative sibling is type-valid, which is why the defect compiled |
| `make verify-schema` | `scripts/model/gen_schema.py`, `validate_schema.py` | **0 of 8** — it reads `schema/` from the repo and never goes through `schemaDirFrom` | **fails** for the schema site, and is out of scope for the rest |
| `make verify-claims` | python: re-runs the register's measurements | none — no resolution site | **not applicable** (asserts nothing about paths) |
| `make verify-frozen` | python: quotes `SDS.md` against the register | none | **not applicable** |
| `make verify-gitignore` | shell + `git check-ignore` | none (`dist/app.js` is a literal in a list, `scripts/verify-gitignore.sh:17`) | **not applicable** |
| `W3` — `test/download-watermark.test.ts:303–317` | the *function*, twice, as strings; no `existsSync` on the dist worker and no worker started | the worker site, as a string | **fails** — this is the twin whose green hid a 100 % download outage |
| `hermes verify` (harness; recorded in both S3 reports, no `make` target) | `npm run build`, `npm run typecheck`, `npm test`, `make test`, `make build`, then boots `node dist/app/main.js` and polls `/` | **3 of 8** — the boot class (`isMain`, the schema dir, the Astro entry) | **partial** — the only gate that runs the built entry, and it cannot see the download: readiness never reaches `/d/<key>/file`, so D3 is exactly the assertion it lacks |
| `scratch/s3d/probe-dist.mjs` (`S3d-report.md` §2.10) | the compiled module and its compiled worker | the worker site | **evidence, not a gate** — not a target, never in CI, and §1 rule 4 says a report is not authority |
| `make verify-dist` (this item) | `dist/` only, as a child process | **8 of 8** | **satisfies** — and it is the only one that does |

**Which existing gates already satisfy E-28: none of the code-executing ones.** `hermes verify`'s boot is the
only partial — it runs the built entry, so the boot class is covered there and nowhere else — and it is not a
`make` target, so nothing in `make test` inherits it. Every other gate either never executes code
(`verify-claims`, `verify-frozen`, `verify-gitignore`) or executes the source (`verify-s1`, `npm test`,
`test-perf`, `typecheck`), and `build` emits the artefact without running it.

**Test that must change.**

1. **New `scripts/dist-gate.mjs` and `make verify-dist`** (the target above), added to `verify` so `make test`
   is `verify-toolchain → verify-gitignore → verify-schema → verify-claims → verify-frozen → verify-s1 →
   verify-dist`. `Makefile`'s `help` text gains the target.
2. **New `test/dist-witness.test.ts`** — the register and its three assertions, above.
3. **The negative control, recorded here so it is a gate and not a claim.** Restore
   `new URL('./stamp-worker.ts', metaUrl)` in `stampWorkerUrl`: `make verify-dist` must go **red at D3** and
   `make test` must stay **green at 404/404**. If `make test` also goes red, this item has not proved the gap —
   it has proved some other gate already covered it, and the claim must be withdrawn rather than reworded.
   Files restored byte-identical afterwards, as in `scratch/s3d/mutations.ts`.
4. **`test/nginx-config.test.ts:188`** — its failure message names `node dist/tools/nginx_gen.js`, a command no
   gate ran. D6 makes the message true; the message text does not change.
5. **`scripts/model/check_frozen.py:206`** — `POINTERS` moves from `range(1, 24)` to `range(1, 29)`, landing the
   pointer lines for E-24, E-25, E-26, E-27 and E-28. This also closes E-24/E-25's owed item 4, which the tree
   has not applied (the check reports `pointers: 23/23` today).
6. **Paste the three drop-ins into `SDS.md`**, each with its pointer line: §7.4 gains E-26's
   (`> Amended by 02-errata.md E-26.`), §7.5 gains E-27's, and §16's preamble gains E-28's.
   `make verify-frozen` is the gate; it quotes none of the three blocks, so the proof is that the retired
   sentences are absent and the replacement paragraphs are present verbatim.

**Recorded, not closed — `dist/` carries the test tree into the image.** `tsconfig.json`'s `rootDir` is `.`
and `tools/regen_conf.ts` imports `test/helpers/fixture.ts`, so `tsc` emits `dist/test/…`, and
`Dockerfile.app:18` copies all of `dist/` into `/srv/app`. That is a packaging and surface question for S4,
not a resolution question; it is named here because D1–D6 make `dist/` the thing that ships and therefore the
thing worth keeping small.

**Severity: major (build), and the highest of the three for the customer.** The one measured instance was a
100 % download outage with a green suite, and the class includes the worker, the schema directory, the SSR
entry, both process entry points and the nginx generator.

---

### Builder items this section owes — ordered, each naming the file and the gate that proves it

| # | Item | Files | Gate that proves it |
|---|---|---|---|
| 1 | **E-26** paste the §7.4 drop-in (wire format, verification order, the two windows, the endpoint table, the mint, the cookie) and its pointer line | `docs/sds/SDS.md` §7.4 | `make verify-frozen` green; `R13`/`R14` name the windows and the mint |
| 2 | **E-26** implement `cexp`: the claim and its three step-(5) checks; the 86 400 s ceiling on the setting; `maySpend` into the consume so the middle window performs no insert; the `jti` reuse at mint | `app/download/token.ts`, `app/download/plane.ts`, `app/download/ledger.ts`, `app/download/code.ts` (the setting's bound) | `R5b`, `R13`, `R14`; mutation — delete the `maySpend` guard → `R13(c)` spends a use → red |
| 3 | **E-26** render lifetime on `cexp`, not `exp` | `app/download/plane.ts` (`ensure({ expiresAt })`) | new `W13` |
| 4 | **E-27** the global semaphore, the fixed acquisition order, and the budget measured from arrival | `app/download/render.ts`, `app/main.ts` | `W6` (two tenants, injected capacity 4), new `W14` (queue denial); mutations — no global → `W6` red, budget from acquisition → `W14` red |
| 5 | **E-27** paste the §7.5 drop-in and its pointer line | `docs/sds/SDS.md` §7.5 | `make verify-frozen`; `W3`/`W6` assert the numbers the text now names |
| 6 | **E-28** `make verify-dist` and its six assertions | `Makefile`, `scripts/dist-gate.mjs` | the negative control: `.ts` worker URL → `verify-dist` red at D3, `make test` green at 404/404 |
| 7 | **E-28** the register | `test/dist-witness.test.ts` | an unclaimed `import.meta.url` under `app/` turns it red; renaming a `D<n>` in the gate turns it red |
| 8 | **E-26/E-27/E-28** pointer lines and the range | `scripts/model/check_frozen.py:206` | pointer phase reports 28/28; renaming one pointer line turns it red |
| 9 | **§1's marker count** — "There are five such markers: E-1, E-2, E-4, E-11 and E-13" becomes nine, naming E-26's four | `docs/sds/02-errata.md` §1 | **none — and said plainly:** no checker counts markers. A count in prose is kept true by the reader, which is why it is listed rather than quietly left wrong. |

Items 1–2 are one change to the spec and one to the code and can land in either order; 3 depends on 2; 4–5 are
independent of 1–3; 6–7 are independent of all of them; 8 requires every pointer line to exist, so it is last.

---

### Traceability — E-26..E-28

| E | Closes | Source (verified in this pass) | Severity |
|---|---|---|---|
| **E-26** | §7.4's continuation grace is unreachable because `verifyToken` refuses every expired token; `R5b`'s sentence states the rule the frozen step (5) never contained; the payload and the cookie's `600 s` are the two frozen clauses that have to move; D32 is the decision | `S3c-report.md` §3.4 (the `R5b` case and its quote), §8.3 ("Continuation grace is not implemented"); `S3d-report.md` §8.5 (the consequence), §9.2 (handed back); `SDS.md:1252–1286`; `00-adjudication.md` §4.4 (`:1404–1443`); `IDEA.md` D32 (`:111`); `app/download/token.ts:131–134`; `test/download-redeem.test.ts:321–346`; `schema/site.sql:204` (`ix_ev_code_ts`) | major (specification) |
| **E-27** | per-tenant 8 is 8 × N on a multi-tenant box and the 2 s budget starts after the queue, so a queued request has no deadline; D33 bounds the box and this item bounds the wait | `S3d-report.md` §2.6 (`P-S3d-1`), §8.8 ("8 × tenants workers"), §9.4 (disk growth); `IDEA.md` D33 (`:112`); `SDS.md:1296–1299`; `app/download/render.ts:55–58`, `:207–213`, `:330–341`; `app/admin/auth.ts:71–102` (`Semaphore` has no deadline) | major (specification) |
| **E-28** | every gate executes the TypeScript source, so a resolution that only works under type stripping is invisible; the measured instance is a 503 on every production download with 404/404 green | `S3d-report.md` §2.10 (the defect and the probe), §10 (`make test` 404/404); `Makefile:77–78`, `:107–117`; `package.json:10–13`; `test/download-watermark.test.ts:303–317`; `tools/regen_conf.ts:8–13`; `test/helpers/fixture.ts:11`; `Dockerfile.app:16–23`; measured — `stampWorkerUrl(dist) → …/stamp-worker.js`, `exists: true`; the `.ts` sibling, `exists: false`; `REPO` in `dist/test/helpers/fixture.js` = `…/dist` and `…/dist/schema`, `exists: false` | major (build) |
| — | **carried, not separate items:** `POINTERS` to `range(1, 29)` (item 8); §1's marker count (item 9); E-24/E-25's owed pointer lines, which item 8 lands | E-26..E-28 | — |
| — | **open, not closed here:** a token refusal on `GET /d/<key>/file` writes no `denied` row — `verifyToken` fails and throws before the tenant database is opened (`app/download/plane.ts`, the `!verified.ok` branch), while `docs/sds/diagrams/gated-download.puml:59` says "401 … + one `kind='denied'` event row (jti may be NULL)". The only `'denied'` insert in `app/` is the redeem path (`plane.ts:341`). Needs its own item against §7.3 and the diagram — not E-26's, because the window change does not touch it | `app/download/plane.ts` (`!verified.ok`), `docs/sds/diagrams/gated-download.puml:59` | minor (specification) |
| — | **open, not closed here:** E-26's resume key is `(code, asset, IP, UA)`, so a client that changes network or browser spends a use to resume; that is D32's own key, and narrowing it is a product decision, not an errata's | `IDEA.md` D32; E-26 "Recorded, not closed" | minor (specification) |
