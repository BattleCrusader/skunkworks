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
