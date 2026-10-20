# 00 — Adjudication register (Phase A)

**Author:** Architect (chair, round 3) · **Phase:** A of 2 · 2026-10-20
**Consumes:** `IDEA.md` (704 lines, D1–D27), eleven debate papers, `schema/control.sql`, `schema/site.sql`,
`schema/r2-amendments.sql`, `schema/export-projection.json`, `make test`.
**Produces:** this register. Phase B writes `docs/sds/SDS.md` **from** it and may not re-open a verdict here
without a measurement that satisfies the named overturn condition.

**How to read this.** A conflict entry (`C-n`) is a place where two papers state incompatible contracts and
both have evidence. An objection entry (`O-n`) is a place where one paper attacks something and the owning
domain must accept, reject or defer it. Every defect in the corpus has exactly one ID (`D-01`…`D-100`) and
exactly one deciding entry. Nothing in this document says "we'll consider".

**Risk register (read this before the decisions, not after).**

| # | Risk that survives this register | Where it is accepted | What would make it a problem |
|---|---|---|---|
| R1 | Tenant isolation is a **permission** boundary inside one Node process, not a construction. Three code paths can break it: the DDL runner, any `ATTACH`-capable handle, and any `import()` from a tenant-writable tree. | C-15, C-18, O-03 | Someone adds a fourth SQL-executing extension point, or a dependency opens its own handle to `site.db`. |
| R2 | Third-party plugins require a **fourth service** and one shared cgroup; per-plugin memory is not enforceable, so a hostile plugin can starve its co-tenants inside the runner (never the host, never a page). | C-08, O-38 | A plugin that needs to DoS for a living, or a client who installs ten of them on a 1 GB box. |
| R3 | "Fully drag-and-droppable on day one" is now "fully draggable **within the shipped component registry**". A bespoke interaction is an image release. | C-04, C-23 | The first client asks for a widget we did not ship. |
| R4 | Export correctness rests on a **producer** rule (quiescence counts), not on a verifier. Measured: a `cp`-built bundle passes 27/27 checks and serves 201 pages where the source had 241. | O-18, O-19 | Any exporter path that is not `exportSnapshot()`. |
| R5 | Access codes are 16 characters, not 12, because the 20-bit selector removes the only fleet-wide secret from the design. | C-06 | A client refuses a 16-character code; the design falls back to a pepper and a rotation runbook. |
| R6 | "A gated asset is absent from the public tree" is now a **link-absence test**, not a missing directory, because `storage_path` became a generated column under one `content/media/` tree. | C-17 | Someone copies `content/media/` into `content/public/`, or the farm verifier is skipped for one bundle. |

---

## 1. Corpus inventory (papers read; how many distinct attacks exist across them; how you counted)

### 1.1 Papers read, in the order the mandate required

| # | Paper | Lines | Domain | What it is authoritative for |
|---|---|---|---|---|
| 1 | `docs/debate/r1-data-model.md` | 804 | Data Model | DDL, invariants I1–I8, `site.db`/`control.db` shape, export primitive |
| 2 | `docs/debate/r1-security.md` | 841 | Security | S-1–S-8, DDL statement classes, sessions, gated downloads, uploads |
| 3 | `docs/debate/r1-runtime.md` | 763 | Runtime | mount seam, tenant resolution, `site.source()`, publish budget, round-trip |
| 4 | `docs/debate/r1-platform.md` | 860 | Platform | nginx, proxy snippet, compose, backup, install, bundle |
| 5 | `docs/debate/r1-red-team.md` | 542 | Red Team | O1–O16, coupling traps T1–T5, the seven silences, the 5-minute walk |
| 6 | `docs/debate/r2-data-model.md` | 562 | Data Model | 28 verdicts, C1–C6, X1–X6, revised I1–I12, checks 9–19 |
| 7 | `docs/debate/r2-security.md` | 611 | Security | 18 verdicts, C-1–C-5, X-1–X-8, P1–P4, the D1 cost (M5) |
| 8 | `docs/debate/r2-runtime.md` | 605 | Runtime | R1–R20, C1–C6, X1–X8, I12–I16, D-R10/D-R11 |
| 9 | `docs/debate/r2-platform.md` | 540 | Platform | 17 verdicts, C1–C5, P9–P12, the bundle file list, §4.3 promise |
| 10 | `docs/debate/r2-red-team.md` | 448 | Red Team | 34 orphans, 12 measured-not-designed, N1–N8, X1–X11 |
| 11 | `docs/debate/r2-plugin.md` | 1647 | Plugin | manifest, RPC enum, containment, export semantics, Q1–Q14 |
| | **Total** | **9,523** | | |

Plus the DDL, which is ground truth and outranks every paper where they disagree:
`schema/control.sql` (7 tables, 63 columns), `schema/site.sql` (20 tables at `user_version=1`),
`schema/r2-amendments.sql` (v1→v2, 21 tables, 3 registered triggers), `schema/export-projection.json`
(20 tables classified).

### 1.2 How I counted, and the number

**Rule.** One *distinct defect* = one (artifact, failure mechanism) pair. Restatements across papers collapse
even when the measurements differ; a defect that a round-2 paper re-measures for a different consequence is
still one defect. An *attack statement* = one numbered or bulleted claim-against-a-claim, counted by section
heading, not by sentence. Design statements (invariants, decisions, question answers) are not counted as
attacks unless they assert that something else fails.

| Paper | Attack statements | Where they were counted |
|---|---|---|
| `r1-data-model.md` | 5 | §4 A1–A5 |
| `r1-security.md` | 5 | §4 A-1–A-5 |
| `r1-runtime.md` | 5 | §4 A1–A5 |
| `r1-platform.md` | 5 | §4 A1–A5 |
| `r1-red-team.md` | 28 | §1 O1–O16 (16) + §3 T1–T5 (5) + §6 silences 1–7 (7) |
| `r2-data-model.md` | 34 | §1 verdict rows (28) + §2 C1–C6 (6) |
| `r2-security.md` | 41 | §1 verdict rows (18) + §2 C-1–C-5 (5) + §3 X-1–X-8 (8) + §4 the D1 cost (1) + §5 M1–M8 findings that are claims (9) |
| `r2-runtime.md` | 34 | §1 R1–R20 (20) + §2 C1–C6 (6) + §3 X1–X8 (8) |
| `r2-platform.md` | 27 | §1 verdict rows (17) + §2 C1–C5 (5) + §3 conflicts 3.1–3.5 (5) |
| `r2-red-team.md` | 54 | §1 orphans A1–A18/B1–B16 (34) + §2 measured-not-designed 2.1–2.12 (12) + §3 N1–N8 (8) |
| `r2-plugin.md` | 12 | the cross-domain findings only: §5.1 projection, §4B aggregates, §4C assets/uploads, §12 Q1–Q10 (10) |
| **Total statements** | **250** | |

117 of the 250 are re-statements before the counter-designs are counted: 83 are round-2 verdict rows on an
attack already raised in round 1 or by another domain, and 34 are the red team's orphan list, which is
explicitly "what nobody adopted". Reduction: **250 statements → 100 distinct defects**, 2.5 : 1.

| Family | Defects | IDs | Example of the merge |
|---|---|---|---|
| A. Tenancy and the edge | 10 | D-01…D-10 | The tenant-header spoof is measured four times (Security A-1, Platform T8b, Runtime §6.6, Red Team O6) — one defect. |
| B. Isolation and connections | 8 | D-11…D-18 | `ATTACH` from a readonly handle appears in four papers — one defect. |
| C. Asset keys and files | 9 | D-19…D-27 | The FK action is DM3 vs Runtime 3.6.5, restated by Red Team X1 and Security X-1 — one defect. |
| D. Gated downloads | 11 | D-28…D-38 | The argon2 lookup defect: Data Model A1, Security #1, Red Team O1, Runtime C3 — one defect, four papers. |
| E. Watermark and media | 5 | D-39…D-43 | |
| F. Editor and render | 11 | D-44…D-54 | The repeat region: Red Team O4, Runtime R1, Platform 3.1, Red Team A3 — one defect. |
| G. Data plane | 8 | D-55…D-62 | |
| H. Export and bundle | 12 | D-63…D-74 | |
| I. Operations | 6 | D-75…D-80 | |
| J. Silences | 8 | D-81…D-88 | |
| K. Plugins | 12 | D-89…D-100 | |
| **Total** | **100** | | |

Of the 100: **56 are decided in the conflict register** (C-1…C-25) and **44 in the objection ledger**
(O-1…O-44). §7 is the reconciliation, and it is mechanical: every `D-nn` appears in exactly one entry.

### 1.3 What the corpus does not contain, and therefore what I did not decide from it

1. **No browser measurement anywhere.** `__Host-` prefix rejection, the CSRF-token theft path, and the island
   props breakout are RFC-6265bis/spec facts, not observations. Security §5 Q8 says so; Platform §6 says so;
   the plugin paper §11 says so. I decided the *server-side* half of each (a testable contract) and recorded
   the browser half as unverified. This is the largest evidence gap in the corpus and it is named in §7.
2. **ACME against a production CA is unmeasured.** Platform M6 used Pebble with `PEBBLE_VA_ALWAYS_VALID=1`
   and measured 16.01 s of issuance excluding DNS, port 80 and rate limits. The install promise in §5 is
   bracketed accordingly.
3. **The composed plugin path was never run across two containers.** The unix-socket hop (15 µs p50) and the
   child IPC hop (22 µs p50) are measured separately; their sum (~37 µs) is arithmetic.
4. **The 1 MiB+ bundle transfer is unmeasured.** Platform's 6.8 min at 20 Mbps for 1 GB is arithmetic over a
   measured bundle size, not a link test.

### 1.4 `make test`, run in this repo, verbatim (trimmed to the verdict lines)

```
$ make test
PASS  13 must-ignore + 7 must-keep = 20 paths behave as intended
control.sql: 7 tables, 7 explicit indexes, 5 FK clauses, integrity=ok, fk_check=0 violations, journal=wal, app_id=0x534b5700
site.db: 20 tables, 13 explicit indexes, 14 FK clauses, integrity=ok, fk_check=0 violations, journal=wal, app_id=0x534b5701
   ok asset key with ../: rejected (CHECK constraint failed)
   ok datasource kind=function: rejected (CHECK constraint failed)
   ok delete asset that is linked by a page: rejected (FOREIGN KEY constraint failed)
   ok both guards fire: cms_asset_link and cms_download_code each RESTRICT
PASS  1 schema/ER parity + negative tests                27 entities == 27 CREATE TABLE, png 129230 B
PASS  2 cp loses data, VACUUM INTO keeps it              cp=no such table; VACUUM INTO rows=1000 user_version=9 views=1 jm=delete
PASS  3 key immutable by FK, not by app                  referenced rename REJECTED, unreferenced rename ACCEPTED
PASS  4 partial unique index breaks FK parent            foreign key mismatch - "u_p" referencing "cms_asset"
PASS  5 sqlite_sequence survives restore, not rebuild    seq 5->3 across rebuild; restored -> next id 6
PASS  6 PRAGMA foreign_keys is a no-op in a txn          inside txn=1, after commit=1 (silently ignored)
PASS  7 argon2id equality lookup is impossible           verify=70.5ms, salted (different hashes) -> 5000-code scan=352s; hmac=1.797ms
PASS  8 readonly is not a tenancy boundary               readonly handle read 1 foreign row(s): buyer@acme.com
PASS  9  r2 amendments apply to a populated v1           user_version 2, integrity ok, fk_check 0, revisions=2, seq cms_page=3, 3 triggers all registered
PASS  10 root path '/' is insertable                     v1 REJECTED '/' (homepage uninsertable) and ACCEPTED to_path='//evil.example'
PASS  11 storage_path is generated, sha256 immutable     cannot INSERT into generated column "storage_path"
PASS  12 asset delete guard holds with foreign_keys=OFF  fk=0 python -> DM_E_ASSET_IN_USE; cli rc=19
PASS  13 rebuild with fk=ON cascade-deletes children     revisions before=2; DROP with fk=ON -> 0; rebuild with fk=OFF -> 2
PASS  14 dedupe write order: 24 requests, 1 download     24 concurrent requests, one jti: update-first uses=24 (events=1); insert-first uses=1
PASS  15 (jti) WHERE kind='first' tolerates NULL         3 NULL-jti denials accepted; (J1,'first') twice -> UNIQUE constraint failed
PASS  16 export projection is the reproducible unit      20/20 tables classified; volatile rows change the file digest, not the projection digest
PASS  17 argon2 parameter cost on this box               m=19456,t=2,p=1 min=22.3 med=22.9ms; m=65536,t=3,p=1 min=123.4 med=130.7ms (5.7x)
PASS  18 an unanchored audit chain proves nothing        tamper row 2 + recompute chain -> verifies (True); anchored head mismatches
PASS  19 delete-guard cost, indexed vs not               200k referencing rows, unreferenced delete: no index 7.22 ms, indexed 0.021 ms
19/19 passed, 0 skipped, 0 failed
```

**Two first-hand checks I ran for this register** (not quoted from a paper), because two decisions rest on
them:

```
$ apply schema/site.sql then schema/r2-amendments.sql to a fresh file
v1 '/' insert:           REJECTED -> CHECK constraint failed: path GLOB '/*' AND path NOT GLOB '*..*' AND path NOT GLOB '*/'
user_version:            2
tables:                  21
projection entries:      20
unclassified:            ['cms_trigger_registry']
v2 '/' insert:           ACCEPTED
to_path //evil.example:  REJECTED
to_path /a/../b:         REJECTED
to_path /x/:             REJECTED
triggers:                3, all 3 present in cms_trigger_registry
```

That is D-74 in one line: the amended schema a tenant actually runs has 21 tables, the projection classifies
20, and the missing one is `cms_trigger_registry`. The I10 gate as written ("a table in the DDL and not in
the file fails the build") is satisfied only because it reads `site.sql`'s text rather than the database.

---

## 2. Conflict register — C-1..C-25

Format: **domains | both positions with citation | VERDICT | rationale | what would overturn it | the exact
sentence the SDS will adopt.** Where a defect ID is listed, that defect is decided here and nowhere else.

**Mapping to the seven conflicts the mandate named, so nothing is hunted for:**

| Mandate | Register | One-line outcome |
|---|---|---|
| X1 tenancy header | **C-1** | Empty is legal and means "resolve from Host"; the edge token is the proof; 421/400/404 are distinct. |
| X2 path-prefix demo | **C-2** | nginx strips; the app emits the prefix; Runtime's §3.5 is withdrawn by its own author. |
| X3 `cms_asset.key` | **C-3** | `ON UPDATE RESTRICT`; a referenced rename is 409; a bounded audited `repoint` is the escape hatch. |
| X4 repeat regions | **C-4** | A registered `list` component with one `[data-repeat]` child, not a block table and not an island. |
| X5 export projection | **C-5** | The projection is a union of a core file and installed manifests, checked against the live DB. |
| X6 codes | **C-6** + **C-7** | 16-char selector + argon2 (no pepper); `max_uses` counts redemptions keyed by `jti`, insert-first. |
| X7 plugin capability | **C-8** | A fourth service, `plugin-runner`, `network_mode: none`, no addons; 48 MB once, not 49.8 MB per tenant. |

### C-1 — Tenancy header contract: an empty header is a 400 under one paper and the normal case under another (PLT · SEC · RT) — D-01, D-02, D-03

**Position A.** `r1-security.md` §2 DS-4: the app "returns `400 E_TENANT_HEADER` when the header is missing,
empty, or fails `/^[a-z0-9][a-z0-9-]{0,62}$/`", and nginx injects it "in the `default_server` block too".
Rationale: fail loud rather than render the wrong tenant.

**Position B.** `r1-platform.md` §2 PD1: one snippet is included by **every** proxying location and sets
`proxy_set_header X-Skunkworks-Tenant "";` — the empty value is the mechanism that *strips* a client-supplied
header, measured as the fix in R1 §6 T8b ("`Host unknown + client hdr acme → tenantHeader: null`").
`r1-runtime.md` §2 D-R2 adds a second proof (`X-Skunkworks-Proxy-Token` + `SKUNKWORKS_TRUSTED_PROXY_CIDRS`)
and returns 404 when it fails. `r2-runtime.md` §3 X1 composes the two: PD1's snippet sets the header to
`""` on every host-routed location, DS-4 rejects `""`, so **100 % of host-routed traffic is a 400**,
including every production page. `r2-red-team.md` §4 X4 adds the third mechanism and notes that Platform's
own T8b falsifies DS-4's server-scope assumption.

**VERDICT — B's mechanism wins; A's status rule is rejected for the empty case.** Empty is a legal value
meaning "no edge assertion". The header is honoured only when the edge proof verifies. Three failures get
three codes and no code is reused.

**Rationale.** An empty header is not evidence of an attack; it is the *absence* of an assertion, and after
PD1 it is the normal state of every host-routed request. A rule that 400s it converts a correct
configuration into a total outage — the loudest possible failure, aimed at the wrong layer. The proof
mechanism must be the token (a value nginx holds and a client cannot guess), because the CIDR check alone is
one misconfigured `proxy_set_header` away from caller-controlled tenancy (Security C-5's own failure
scenario). Both proofs are kept: token first, CIDR second, and neither is load-bearing alone.

**What would overturn it.** A measured request in which a client-supplied `X-Skunkworks-Tenant` reaches the
app with a valid `X-Skunkworks-Edge` value *without* having come through nginx — i.e. a path that leaks the
edge token to a client. In that case the token stops being a proof and the CIDR becomes primary.

**The sentence the SDS adopts.**
> `X-Skunkworks-Tenant` is `""` on every host-routed location and the tenant key on every path-prefix
> location; an absent or empty header means *no edge assertion* and the tenant is resolved from the
> normalised `Host`; a non-empty header is honoured only when `X-Skunkworks-Edge` equals `SKW_EDGE_TOKEN`
> **and** the peer address is inside `SKW_EDGE_TRUSTED_CIDRS`, and otherwise the request is
> `421 SKW_E_PLT_EDGE_PROOF`; a non-empty header that fails `^[a-z0-9][a-z0-9-]{0,62}$`, contains a comma,
> or disagrees with `X-Forwarded-Prefix` is `400 SKW_E_PLT_TENANT_HEADER`; a request for which no tenant can
> be resolved is `404 SKW_E_PLT_TENANT_UNKNOWN`, and a resolved tenant whose database cannot be opened is
> `503 SKW_E_PLT_TENANT_UNAVAILABLE`.

### C-2 — Path-prefix demo: nginx strips or the app strips, and doing both 404s every demo (PLT · RT · DM) — D-04, D-05, D-10

**Position A.** `r1-platform.md` §2 PD5: `location /demo/` runs
`rewrite "^/demo/[a-z0-9][a-z0-9-]{0,31}/(.*)$" /$1 break;`, forwards `X-Forwarded-Prefix: /demo/$demo_key`,
and measured end-to-end (T24): `GET /demo/acme/whoami → {"path":"/whoami","tenant_header":"acme"}`,
`GET /demo/acme → 301` to the slash form, query string preserved (`/demo/beta/whoami?x=1 → path=/whoami?x=1`).
It also measured that a *well-formed but unknown* key is forwarded (`/demo/zzz/whoami → 200`), so only
`control.db` can 404 it.

**Position B.** `r1-runtime.md` §3.1 and §3.5: "the prefix is stripped by the **app** (nginx must not
rewrite)", `tenant.prefix` is what `site.url()` prepends, and Runtime open question 1 asks who strips.
`r2-data-model.md` §3 X2 sides with Runtime: "if nginx strips *and* the app strips, every demo URL is a 404;
if nginx strips and the app believes it owns the prefix, `site.url()` emits `/demo/acme/demo/acme/…`".

**VERDICT — nginx strips; the app emits. Position B is withdrawn, and its own author withdrew it.**
`r2-runtime.md` §1 R17: "my 3.1 contract ('the prefix is stripped by the app, nginx must not rewrite') is
**withdrawn**", citing Platform's measured T24 and IDEA §3.1's own table.

**Rationale.** Exactly one component may remove the prefix, and it must be the component that already knows
it in order to route. nginx knows it from a `map` on `$request_uri`; the app knows it only as a header. The
app's job is the *other* direction: every URL it emits must carry the prefix, and Astro's `base` cannot do
that per request (measured: `X-Forwarded-Prefix: /demo/acme` in, `["/blog/a","/media/banner-home.webp?v=ab12cd"]`
out, Runtime §6.5). The double-strip failure is a 404 on a prospect's screen, and the double-prefix failure is
a link that 404s one click later — both are prevented by the single-stripper rule plus one integration test.

**What would overturn it.** A measured case where nginx's `rewrite … break` changes the URI in a way the app
can observe and care about — e.g. a double-encoded segment decoded once by nginx and again by Fastify, or a
`proxy_pass` with a trailing slash reintroducing a second strip. T24 covers query preservation and the
slash-less 301; a body-upload POST under `/demo/` is not covered and must be added to the test.

**The sentence the SDS adopts.**
> nginx strips the demo prefix (`rewrite ^/demo/<key>/(.*)$ /$1 break;`) and sets
> `X-Forwarded-Prefix: /demo/<key>`; the app never rewrites or strips an inbound path, and every URL it emits
> is produced by `site.url()` or `site.asset()`, which prepend `tenant.prefix` (taken from
> `X-Forwarded-Prefix` and from nowhere else) exactly once; a request under `/demo/` whose key is well-formed
> but absent from `control.db` is `404 SKW_E_PLT_TENANT_UNKNOWN`.

### C-3 — `cms_asset.key`: RESTRICT freezes a referenced rename, CASCADE rewrites user rows (DM · RT · SEC) — D-19, D-20, D-24

**Position A.** `r1-data-model.md` §2 DM3: `TEXT REFERENCES cms_asset(key) ON UPDATE RESTRICT ON DELETE
RESTRICT`, and "`ON UPDATE RESTRICT` (not CASCADE) is the whole trick". Measured: a referenced rename raises
`FOREIGN KEY constraint failed` (M4); with CASCADE, 200,000 references cost **439 ms** of write lock on a
settled database and **2,412 ms** inside the inserting transaction (M8), and every writer on the tenant gets
`SQLITE_BUSY` for the duration. Old keys land in `cms_asset_alias` and 301.

**Position B.** `r1-runtime.md` §3.6.5: "`ON UPDATE CASCADE` from `u_*` to `cms_asset(key)` genuinely fires
… a rename rewrites user rows. That is a **write to a `u_*` table** triggered by an admin action, which must
be in the same transaction and audited." Its evidence is the `foreign_keys` default (M §6.9), which proves
the pragma works and says nothing about which action to declare. `r2-red-team.md` §4 X1 calls it a schema
freeze blocker; `r2-security.md` §3 X-1 resolves it for DM.

**VERDICT — A wins: `ON UPDATE RESTRICT`.** Runtime conceded it in `r2-runtime.md` §6.1 ("`ON UPDATE CASCADE`
is withdrawn"). But A's *prose* is also wrong in two places, and those are fixed here: (i) IDEA §7.3's
"changing the key cascades to every reference" is false and is deleted; (ii) a referenced rename cannot simply
fail forever without an escape hatch, so an explicit bounded `repoint` operation is specified. `cms_asset_alias`
therefore records (a) unreferenced renames and (b) URL-level renames for keys already frozen inside
`body_html`, which no FK can see.

**Rationale.** A rename button that stalls every writer is a self-inflicted outage, and Runtime's own
"must be audited" condition is unimplementable at scale: an honest audit row for a 200,000-row rewrite is a
200,000-row audit row (DM's rebuttal, and it is correct). The requirement Runtime actually has — that any
write to `u_*` is transactional and attributable — is satisfied by the re-point: one `BEGIN IMMEDIATE`, one
audit row carrying the row count, a hard cap, and a refusal above it.

**What would overturn it.** A measurement showing the CASCADE completes under 50 ms at the largest reference
count a real tenant has, *and* an audit design whose row count is O(1) rather than O(references). Neither
exists in the corpus; DM M8 is the only measurement and it is 439 ms at 200k.

**The sentence the SDS adopts.**
> `u_*` asset columns are `TEXT REFERENCES cms_asset(key) ON UPDATE RESTRICT ON DELETE RESTRICT`; renaming a
> key that any row references is refused with `409 SKW_E_DM_KEY_IN_USE` naming the key and the reference
> count, and the only rename paths are (a) an unreferenced key, which also writes a `cms_asset_alias` row,
> and (b) the explicit `repoint` operation, which runs in one `BEGIN IMMEDIATE`, rewrites at most
> `SKW_REPOINT_MAX_ROWS` (default 5,000) referencing rows, and writes exactly one `cms_audit` row recording
> `{from, to, rows, tables}`.

### C-4 — Repetition in a stored page body: nothing turns `<div data-source="posts">` into N elements (RT · DM · PLT) — D-44, D-45, D-46

**Position A.** `r1-red-team.md` §1 O4: "A placeholder div must become N sibling `<article>` elements.
GrapesJS has no concept of a repeat region — a designer drags a 'Latest posts' block and gets *one* card; the
SSR pass must clone it per row, which means a template language (child selector? `data-template` attribute?
mustache inside?), an escaping policy for injected values, and a defined behaviour when the source returns 0
rows or 50." Severity: blocker for S4. `r1-data-model.md` §2 DM5 deleted `cms_page_blocks` without replacing
the loop; `r2-red-team.md` §1 A3 confirms nothing picked it up.

**Position B.** `r1-runtime.md` §1 I7/I8 measured that GrapesJS *preserves* `data-source` and `data-limit`
(only attribute order changes) and that `<script>`, comments and `<style>` are destroyed — so the placeholder
survives the editor and "the gap looks solved". `r2-platform.md` §3.1 proposes the opposite mechanism: "loops
are **islands**, not markup — `<div data-island="post-list" data-props='{"source":"products","limit":3}'>`
— the resolver never clones DOM".

**VERDICT — neither A's template language nor B's island. `r2-runtime.md` §2 D-R10's `list` component wins:
a registered component type, exactly one `[data-repeat]` child, `data-bind-*` text/attribute bindings with no
expressions, a `data-empty` child, and a clamped limit; SSR clones the child per row.**
`r2-data-model.md` §1 row 15 also concedes the gate argument used to justify the block table was wrong.

**Rationale.** Three constraints decide it. (i) D21 requires the markup to be authored for the editor, so the
repeat must be a *registered type* — an unregistered type loses `data-gjs-type` on save and degrades to an
editable div (measured, Runtime M1/M2: 176 B → 110 B). (ii) A static/astro export must carry the loop as HTML;
an island needs client JS plus a data snapshot, and Platform's own refusal code 22 then has to fire for any
page whose island needs request data — a larger export hole than the one it closes. (iii) A template language
inside a body that also accepts client-authored HTML is an XSS surface with no owner; `data-bind-title="title"`
writes a **text node**, which cannot inject markup, and `data-bind-href-*`/`data-bind-asset-*` go through
`site.url()`/`site.asset()`.

**What would overturn it.** A registered component that round-trips a loop *without* a `[data-repeat]` child
(which would make the child selector unnecessary), or a client whose list needs a binding the vocabulary
cannot express (a computed value, a nested loop) — that would push the design to a second-level component or
back to an island, and it changes the stored format of every page, so it must be decided before S4 starts.

**The sentence the SDS adopts.**
> Repetition is the `list` component: `<div data-gjs-type="list" data-source="posts" data-limit="3">
> <article data-repeat data-bind-title="title" data-bind-href-slug="slug"></article>
> <p data-empty>No posts yet.</p></div>`; SSR clones the single `[data-repeat]` child once per row, writes
> text through `data-bind-<col>`, `href` through `data-bind-href-<col>` and `src`/`srcset` through
> `data-bind-asset-<col>`, renders the `data-empty` child when the source returns zero rows, clamps
> `data-limit` to the source's `limit_max`, and sets `data-truncated` when it clamped.

### C-5 — Export projection: I10 says a missing table fails the build, but the amended schema already has one missing and a `p_*` table cannot be in a static file (DM · PLT) — D-74

**Position A.** `r2-data-model.md` §4 I10: "Every table is classified in `schema/export-projection.json` …
a table in the DDL and not in the file fails the build", enforced by a set difference over the **text of
`schema/site.sql`** (quoted in `r2-plugin.md` §5.1).

**Position B.** `r2-plugin.md` §5.1 measured against the schema a tenant actually runs
(`site.sql` + `r2-amendments.sql`, `user_version=2`): **21 tables in `sqlite_master`, 20 classified,
`unclassified=['cms_trigger_registry']`**; with one plugin installed, 23 tables and 3 unclassified
(`cms_trigger_registry`, `p_contact_message`, `p_contact_setting`). A `p_*` table is created at runtime by a
migration the publisher wrote, so "a static file in our repo" structurally cannot contain it. My own run
(§1.4) reproduces the 21/20 result.

**VERDICT — B wins on mechanism, A wins on intent. The projection becomes a union check evaluated against
the live database.** `cms_trigger_registry` gets an entry (`rows`, because the DDL postcondition reads it);
a `p_*` table's class comes from its installed manifest's `tables[].export` field, restricted to the same
closed set `{rows, empty, filtered}`.

**Rationale.** I10's intent — *a table cannot join the schema without someone deciding what it means for a
sale* — survives exactly. What changes is *who decides*: for core tables, whoever edits the JSON in our repo;
for plugin tables, the publisher, reviewed at install and shown on the install screen. The check moves from
"the DDL text" to "the database the tenant runs", which is the only artifact that can contain a runtime table.
The build failure is preserved and becomes stricter, not weaker: it now catches the amendment file too.

**What would overturn it.** A plugin mechanism that creates a table without a manifest declaration (which
P-14 forbids and the migration executor enforces), or a core migration path that adds a table outside
`schema/*.sql` (there is none — `make test` regenerates the DDL from one spec).

**The sentence the SDS adopts.**
> `make test` asserts `set(tables in sqlite_master) == core_tables ∪ plugin_tables`, where `core_tables` is
> `schema/export-projection.json` and `plugin_tables` is the union of every installed manifest's
> `tables[].name`, and every member carries a class in `{rows, empty, filtered}`; a table present in the
> database and absent from both is a build failure, and a plugin table whose class is absent is refused at
> install with `SKW_E_PL_NO_EXPORT_CLASS`.

### C-6 — Access codes: three incompatible storage designs and two frozen argon2 parameter sets (DM · SEC · RT) — D-28, D-35, D-36, D-78

**Position A.** `r1-data-model.md` §2 DM12: `code_lookup = hex(HMAC-SHA256(SKW_CODE_PEPPER, normalised code))`
for the index seek, plus `code_hash = argon2id(m=65536, t=3, p=1)` as verifier. `r2-data-model.md` §2 C1 goes
further: **delete the verifier** — "the memory-hard verifier sits behind a fast keyed index in the same row
and raises the cost of exactly nothing", because an attacker holding the file *and* the pepper enumerates at
2.4 µs/HMAC.

**Position B.** `r2-security.md` §2 C-2: replace the pepper with a **selector/verifier split** — a 16-character
Crockford code = `<selector:4><secret:12>` = 20 + 60 bits; `code_selector` plaintext and unique, argon2id over
the full 16 characters. Measured: 2.02 µs selector seek over 5,000 rows (covering index `SEARCH`), 12
selector collisions per 5,000 issuances (needs a retry loop), offline cost 4.46×10⁸ core-years at `m=19456`
and 3.45×10⁹ at `m=65536`. `r2-runtime.md` §3 X8 wants `m=65536`; `r2-security.md` §3 X-3 wants `m=19456`
with `SKW_ARGON2_MAX_CONCURRENT=4` because 8 × 64 MiB peaks at **687 MB** and 16 at **1.44 GB** inside a 1 GB
container; `r2-red-team.md` §3 N6 sums the ceilings at 1,343–1,423 MB with DM's parameters.

**VERDICT — B wins: selector + argon2 verifier, 16 characters, `m=19456, t=2, p=1`, semaphore 4. A's
"delete the verifier" is rejected; A's 64 MiB parameters are rejected.**

**Rationale.** C1's argument is correct *only while the pepper is secret*, and the pepper's residency is not a
property of the mechanism — DM's own "what would change my mind" says so: "C1 dies if the pepper can leak with
the file … the projection excludes the codes, but a pepper in a backup is a Platform decision I do not own."
A design whose offline resistance depends on an undecided secret-handling rule, and on a rotation that cannot
be performed (a `code_lookup` cannot be recomputed without the plaintext), is not a design I will freeze into
a paid feature. The selector removes the secret entirely: nothing has to travel, rotate, or be protected
beyond the argon2 hash. Deleting the verifier is then the one thing that cannot be done, because the selector
is plaintext and 20 bits — argon2 is the only barrier left, and it is a real one. On parameters: at 19 MiB the
offline cost is 4.46×10⁸ core-years, which is not a number an attacker improves by waiting, and 4 concurrent
verifies cost ~76 MiB instead of 256 MiB. That fits the container and the measured 1 GB limit.

**What would overturn it.** (a) A demonstration that an unknown selector and a wrong secret are distinguishable
in status, body or wall time with a dummy verify at the same parameters — then the 20-bit selector is an
existence oracle and the keyed lookup is better. (b) A client requirement that codes stay 12 characters, which
drops the secret to 40 bits and forces the pepper back. (c) A measured container limit of 2 GB, which would let
DM's 64 MiB parameters stand and change only the semaphore.

**The sentence the SDS adopts.**
> An access code is 16 Crockford-base32 characters (`<selector:4><secret:12>`); `cms_download_code` stores
> `code_selector` (the first four characters, plaintext, `UNIQUE`, `CHECK(length(code_selector)=4)`) and
> `code_hash` = argon2id(`m=19456, t=2, p=1`) over the normalised full 16 characters; there is no pepper
> column and no column that contains the secret in recoverable form; `SKW_ARGON2_MAX_CONCURRENT=4` and
> `UV_THREADPOOL_SIZE=8` are asserted at boot, the redemption path performs exactly one verify for a matched
> selector and exactly one dummy verify at the same parameters for an unmatched one, and both paths return the
> same status, the same body and one `cms_download_event` row.

### C-7 — The unit of `max_uses`: one download spends four uses, and the two proposed fixes disagree (SEC · PLT · DM) — D-29, D-30, D-31, D-32, D-33

**Position A.** `r1-platform.md` §4 A1: "decrement only when the request has no `Range` header or `Range`
starts at byte 0, and record `first_byte_at` on the token row". Measured basis T16: one plain request plus
three `Range` requests produced `uses = 4`; `r1-red-team.md` §1 O8 measured the same from the browser side.

**Position B.** `r1-security.md` §2 DS-5: a random 128-bit `jti` in the token, `uses` incremented on the first
successful file response for that `jti`, `INSERT cms_download_event(jti, …) ON CONFLICT DO NOTHING`, unique
`(jti, kind)`. Measured 8 parallel ranges → `uses=1`, one `first` event, then 8 further ranges → `uses` still 1
with 8 `range` events (`r2-security.md` §5 M6).

**VERDICT — B wins on the unit, and A is rejected as a bypass, not a fix.** `Range: bytes=1-` under A's rule
never increments, so one token downloads the asset indefinitely (`r2-red-team.md` §4 X2, `r2-data-model.md`
§3 X1). But B's **write order** is wrong and DM's C2 fixes it: `r2-data-model.md` §2 C2 measured 24 concurrent
requests carrying one `jti` producing `uses = 24` with `events = 1` under update-first, and `uses = 1` with
`events = 1` under insert-first. And B's schema as first written (`jti TEXT NOT NULL`) makes a denial against
an unknown code unwritable — `r2-data-model.md` §1 row 4 measured that a nullable `jti` plus a partial unique
index accepts many NULL rows while still rejecting a second `(jti,'first')`. Final: **insert first, then
update, in one `BEGIN IMMEDIATE`**, `jti` nullable, partial unique index.

**Rationale.** The counted unit is what the buyer was given: one redemption, i.e. one token. A `Range` offset
is a property of the transfer, not of the purchase. Ordering matters because the unique index *is* the gate —
if the counter moves before the gate is crossed, every concurrent request passes the `UPDATE` and then
discovers it was a duplicate. The same ordering is what makes DM's E1 reconciliation query meaningful: it must
count `kind='first'` rows only, or the first buyer whose PDF viewer seeks trips the alert (`r2-red-team.md`
§4 X3).

**What would overturn it.** A measured client that mints multiple tokens for one purchase (e.g. a store that
calls `/d/<key>` twice) — that would make the token the wrong unit and force a purchase-scoped id. Or a
measured case where a single `jti` must legitimately consume two uses (a bundle of two files delivered under
one token), which the current `cid`+`aid` binding forbids.

**The sentence the SDS adopts.**
> `max_uses` counts redemptions, not requests: `uses` is incremented exactly once per token `jti`, by
> `INSERT INTO cms_download_event(jti, kind, code_id, asset_id) VALUES(?, 'first', ?, ?) ON CONFLICT DO
> NOTHING` followed — only when `changes() = 1` — by `UPDATE cms_download_code SET uses = uses + 1 WHERE id =
> ? AND revoked_at IS NULL AND (max_uses IS NULL OR uses < max_uses)`, both inside one `BEGIN IMMEDIATE`;
> every other request under the same `jti` is served without consuming; a request whose `Range` is
> unsatisfiable is answered `416` without writing a `first` event and without incrementing `uses`.

### C-8 — Plugin containment: a fourth service, 48 MB, and D1's "one process" (PLT · SEC · IDEA) — D-89

**Position A.** `r2-plugin.md` §8: one `plugin-runner` container with `network_mode: none`, one
`node --permission` child per package (no addons, no child process, no worker, read-only package mount),
reached over a unix socket; measured 47.4–48.0 MB idle, 0.19 s cold start, 38.2–42.8 MB per child, 22 µs IPC.
`r2-plugin.md` §12 Q1 calls the compose change "the single blocking item" because `IDEA.md` §3 says
"Services in `docker-compose.yml`: `nginx`, `app`, `acme`. Nothing else."

**Position B.** `r2-security.md` §4's D1 cost: a per-tenant process is **49.8 MB peak RSS** and **34 ms median
cold start** — ~19 per 1 GB container, ~10.0 GB at 200 tenants. Security explicitly does **not** ask for it in
v1. `r1-security.md` §3.2.2 asks that the render path not share a process with the DDL runner; `r2-runtime.md`
§1 R6 rejects that as a second SQLite writer.

**VERDICT — A wins, and it does not violate D1.** D1 pins **TypeScript on Node 22 for the whole stack** and
one *app* process; it does not say "one process in the deployment". The plugin runner is one container for
**all** plugins, so its cost is 48 MB once, not 49.8 MB × tenants. Security's per-tenant process boundary
stays rejected (10 GB at 200 tenants is arithmetic, not an opinion). Runtime's rejection of a split
render/DDL process stands.

**Rationale.** Third-party code is the one thing in this system that must not share an address space with
every tenant's database handle and every HMAC key. Node's permission model does not cover the network —
measured twice: `fetch('http://127.0.0.1:…')` returned 200 and `net.connect` delivered a body with the flag on
(plugin §11 P6 A), and `ENETUNREACH` only with `--network none` (P6 F/G). So the containment is the netns plus
the absent addon: with `--allow-addons` off, `new Database()` fails `ERR_DLOPEN_DISABLED`, and with addons on,
`ATTACH` to a sibling tenant **succeeds** even though `fs.readFileSync` of the same path is denied (Security
§5 M4). The runner is the smallest configuration in which a plugin cannot name a file, a socket, or a tenant.

**What would overturn it.** A measurement that a plugin running in the runner can degrade a *page* (P-1 says no
plugin code is on the render path, so this would require a new coupling), or a per-plugin memory ceiling
requirement that the single cgroup cannot meet — the fix is container-per-plugin at ~48 MB each and one
compose service each, which is a compose change, not a redesign.

**The sentence the SDS adopts.**
> `docker-compose.yml` has four services — `nginx`, `app`, `plugin-runner`, `acme` — and `plugin-runner` runs
> with `network_mode: none`, `read_only: true`, `cap_drop: [ALL]`, `pids_limit: 64` and one
> `node --permission` child per installed package with `--allow-fs-read` limited to that package and its
> scratch directory and with no `--allow-addons`, `--allow-child-process` or `--allow-worker`; the app reaches
> it only over the unix socket `run/plugin.sock`, and the protocol is the operation enum in §4.3.

### C-9 — Publisher trust: the plugin paper assumes a root that signs publisher keys; D27 forbids a CA (PLT · CEO) — D-90

**Position A.** `r2-plugin.md` §3 Q12: "`publisher.id` + `publisher.key_id` resolve in
`data/trust/publishers.json` … **The fleet root key signs that file**; a bundle ships the subset that
authorised the plugins it carries." Revocation is `data/trust/revoked.json`, "signed by the root key".

**Position B.** `IDEA.md` D27: "**No publisher CA in v1.** First-party plugins are signed with a key baked into
the image and verify automatically; third-party plugins require the tenant owner to import the publisher's
public key (fingerprint shown) before enable. Running a CA means vouching for someone else's code and
carrying the liability when it misbehaves." `r2-plugin.md` §12 Q4 itself flags the conflict: "Q12 assumes *we*
hold an Ed25519 root and sign publisher keys … That is a commercial and legal decision … and it needs the
CEO."

**VERDICT — D27 wins.** There is no root key that signs a third-party publisher's key. `publishers.json` is a
per-install file written **only** by the tenant owner importing a key, with the fingerprint displayed beside
every capability. Our key verifies first-party packages only.

**Rationale.** A root that signs publisher keys is a CA with a different name, and it carries exactly the
liability D27 was written to avoid: if we sign `acme-labs`, we have asserted an identity and a review we did
not perform. The plugin paper's own containment argument makes the CA unnecessary — a compromised publisher
key yields a plugin that cannot read the site DB, cannot reach the network, cannot touch the filesystem, and
can only write rows in tables it declared. The trust decision is the tenant's, visibly, and it is reversible.

**What would overturn it.** A commercial decision to run a publisher directory (a store, a review process, an
indemnity). That is a CEO decision, not an architectural one, and it is listed in §6 only if it must be made
before Phase B — it does not: the SDS implements D27 either way.

**The sentence the SDS adopts.**
> There is no publisher CA: the image carries our public key and verifies first-party packages against it;
> `data/trust/publishers.json` is written only by the tenant owner importing a publisher public key (SPKI
> base64, fingerprint shown), and no key we hold signs, countersigns or revokes a third-party publisher's key;
> revocation is an operator action against a package root in `data/trust/revoked.json`, which is local to the
> install.

### C-10 — Boot ordering: `migrate` as a hard gate makes one tenant's corruption a fleet-wide outage (PLT · DM · RT) — D-75

**Position A.** `r1-platform.md` §2 PD3: a one-shot `migrate` service runs `--tenant all`, exits, `app` declares
`depends_on: {migrate: {condition: service_completed_successfully}}`, `restart: "no"`. Rationale: a failed
migration must be visible, not looped.

**Position B.** `r2-data-model.md` §2 C4 and §4 DM11: "`migrate` must exit 0 with a per-tenant report, and the
app must boot. A tenant whose `user_version` is below `tenant.db_version` serves `503 DM_E_SCHEMA_STALE` with
`Retry-After` and triggers a lazy repair of that one tenant." `r2-red-team.md` §4 X8: compose never starts
`app`, every tenant is down, and the 503 branch is unreachable.

**VERDICT — B wins for tenant databases, A wins for `control.db`.** Split the gate by plane. A control-plane
migration failure blocks startup (exit 15) because every request needs `control.db`; a tenant migration
failure is reported, the app boots, and that tenant alone serves 503 until repaired.

**Rationale.** A hard gate correlates the outage with the moment you are already having an incident: one
locked file, one full disk, one failing `ALTER` at 03:00 stops 199 healthy sites from serving, at every
restart. But an app that boots on a half-migrated `control.db` has no tenant map, so it would 404 everything
— a silent outage is worse than a loud refusal. The asymmetry is the whole decision.

**What would overturn it.** A measured case where serving a stale tenant produces wrong content rather than a
503 — i.e. a query path that reads a table whose shape changed without checking `user_version`. The connection
factory's version check is the guard; if it is bypassed anywhere, this verdict is void.

**The sentence the SDS adopts.**
> `migrate` exits 0 with a JSON report naming every tenant it migrated and every tenant it could not; `app`
> starts regardless; a tenant whose `user_version` is below `tenant.db_version` serves
> `503 SKW_E_DM_SCHEMA_STALE` with `Retry-After: 5` on every route and is repaired lazily on the next request;
> a failure to migrate `control.db` prevents startup with exit 15 and a message naming the migration.

### C-11 — Admin tenant selection: two listeners, two Host spaces, one session (RT · SEC · PLT) — D-06, D-07

**Position A.** `r1-runtime.md` §4 A5: "Two listeners means two Host spaces. On the admin port there is no
tenant `Host` to resolve, so tenant scope must come from the session — a *second* resolution path that nothing
in IDEA defines." `r2-security.md` §1 row 6 accepts it as "a hole in my DS-11": the session row had `user_id`
but no `tenant_id`.

**Position B.** `r2-platform.md` §3.5 argues that in a **bundle** the tenant is a constant from the seed, so
the second path collapses; `r1-platform.md` §2 PD3 puts the admin behind nginx with `expose` only, which
`r2-security.md` §1 row 8 accepts as the fix for a published port.

**VERDICT — A's mechanism, B's simplification, and one code path.** Every admin URL is `/admin/t/<key>/…`;
the admin listener resolves the tenant from the **session row only**, ignores `Host` for tenant resolution,
and returns `421` if `X-Skunkworks-Tenant` is present at all. In a bundle the key is the seeded constant, and
the URL shape is identical — no second resolver, no host-based fallback.

**Rationale.** Two sources of truth for "which tenant am I editing" is how an operator edits tenant B's
homepage while looking at tenant A's page list — a cross-tenant *write* by a trusted user, which is worse for
trust than an attacker. Making the bundle a special case (host resolution when there is one tenant) would
create exactly the second path the fleet needs to prohibit, and the bundle would then be the only place the
bug is untested. `expose`-only is kept: the app has no published port, so a direct socket cannot bypass the
proxy (Runtime R14, Security row 8).

**What would overturn it.** A requirement that one operator manage several tenants in one session with a
tenant switcher that is not URL-based. Even then the URL is the authority; only the UI changes.

**The sentence the SDS adopts.**
> Every admin URL is `/admin/t/<key>/…`; `resolveAdminTenant(session)` returns the tenant from
> `session.tenant_id` and is the only source; the admin listener ignores `Host` for tenant resolution and
> returns `421 SKW_E_PLT_EDGE_PROOF` if `X-Skunkworks-Tenant` is present at all; every `cms_audit` row carries
> the tenant key, and the app container publishes no port (`expose` only).

### C-12 — CSP and the script that is not there: nonce, hash, or `'self'` (SEC · RT) — D-47, D-48, D-49

**Position A.** `r1-security.md` §2 DS-11: the public CSP carries `script-src 'self' 'nonce-<per-request>'` and
"the renderer **rewrites a per-request nonce onto every stored `<script>` at SSR**"; hash-based CSP is rejected
because "a save-time hash list goes stale" when pages are hand-edited.

**Position B.** `r1-runtime.md` §4 A2: "a per-response nonce cannot survive export … either the export bakes a
nonce into HTML that the client's server never echoes in a header → every island script is blocked, or the
export omits the CSP". `r2-runtime.md` §1 R7 adds the decisive fact: there is **no stored script to carry a
nonce** — GrapesJS deletes `<script>`, comments and `<style>` (measured R1 §6.8), and `r2-runtime.md` §1 I8
makes that a hard ban enforced at write. `r2-red-team.md` §4 X7 notes the two papers never actually disagree
on the mechanism: Security rejected save-time hash *lists*, Runtime proposed a render-time hash.

**VERDICT — B wins, in its strongest form: `script-src 'self'`, no nonce, no hash, identical in all three
SKUs.** Islands are emitted **by the renderer**, not stored, as
`<script type="module" src="/islands/<name>.<sha8>.js">`. The I8 ban is enforced at write by a validator and a
DB `CHECK`, not by the editor's behaviour.

**Rationale.** A nonce machinery for a tag that cannot exist is dead code that a reviewer will mistake for a
control. The hash alternative costs 0.044 ms/page on an 83 KB body — +34 % of a 0.13 ms render — for no gain
once no inline script exists. `script-src 'self'` is byte-identical in the CMS bundle, the Astro project and
the static site, which is the only form of the CSP promise that survives export. The remaining script surface
is the island props payload, and that is closed by the serialiser below (Red Team N2).

**What would overturn it.** A client requirement for hand-authored inline `<script>` in a page body. That
reopens the stored-XSS surface Security A-2 exploits (a stored script on the public origin drives the admin
port with the cookie attached, because cookies ignore ports) and would require the island registry to be
bypassed — i.e. it is a product decision, not a header change.

**The sentence the SDS adopts.**
> A page body contains no `<script`, `<style`, `<!--` or `on<name>=` (enforced at write by a validator and a
> `CHECK`); the renderer emits every island as `<script type="module" src="/islands/<name>.<sha8>.js">`; the
> `Content-Security-Policy` is `default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr
> 'unsafe-inline'; img-src 'self' data: https:; frame-src <declared per tenant>; frame-ancestors 'none';
> base-uri 'none'; object-src 'none'` and is byte-identical in the CMS, Astro and static targets; island props
> are JSON-encoded into `<script type="application/json" data-island-props>` with `<`, `>`, `&`, U+2028 and
> U+2029 escaped, and validated against the island's declared prop schema at save.

### C-13 — The DDL AST: two incompatible contracts, and two operations SQLite refuses (SEC · DM · RT) — D-58, D-59

**Position A.** `r1-security.md` §3.1 `TableSpec`: `type ∈ {text,integer,real,blob,datetime,asset}`, a `ref`
object with `table:'cms_asset'`, `column:'key'`, `notNull?` with an optional literal default, max 40 columns
and 8 indexes.

**Position B.** `r1-data-model.md` §2 DM2 `DdlOp`: seven operations (`create_table`, `add_column`,
`drop_column`, `rename_table`, `create_index`, `drop_index`, `drop_table`),
`ColumnSpec.type ∈ {TEXT,INTEGER,REAL,BLOB,NUMERIC,BOOLEAN,DATE,ASSET,PAGE,RELATION}`, FK targets
`cms_asset(key)`, `cms_page(path)`, `u_<name>(id)`. `r2-red-team.md` §4 X5: "One union must be authoritative
and the other paper's §3 deleted", and notes both permit the exact `ALTER` that fails
(`r1-red-team.md` §1 O14: `ADD COLUMN price NUMERIC NOT NULL` → "Cannot add a NOT NULL column with default
value NULL"; `DROP COLUMN cover` on an indexed column → "error in index ix_cover after drop column").

**VERDICT — B wins, with A's `ref` object deleted and the capability check added.** The AST is Data Model's
seven-op union; the FK target is decided by the **type** (`ASSET` → `cms_asset(key)`, `PAGE` →
`cms_page(path)`, `RELATION` → `u_<name>(id)`), so a caller cannot name a target; `add_column` with
`notNull && !default` is `422 SKW_E_DM_DDL_REJECTED reason=default_required` **before** any SQL; `drop_column`
on an indexed or FK-referenced column compiles to the 12-step rebuild or is refused with
`reason=rebuild_required`, and the UI disables the control rather than offering a button that throws.

**Rationale.** A validated string that names an FK target is one forgotten allowlist away from
`REFERENCES cms_page(path)` on a column that is supposed to be an asset — DM's I2 says exactly this and it is
right. Deriving the target from a closed type set makes the bad statement unrepresentable rather than
rejected. The capability check is the second half: an AST that can express an operation SQLite refuses is an
AST whose refusals surface as raw SQLite text in a modal, mid-flow, after the operator has described the
change — which the brief forbids ("the CMS is not a SQL console"). `r2-runtime.md` §3 X4 and
`r2-data-model.md` §1 row 27 both ask for this shape.

**What would overturn it.** A real client requirement for a column type outside the closed set (a JSON column
with a path expression, a generated column). Each addition is a new emitter path and a new line in the
19-statement injection corpus (`r2-plugin.md` §11 P2 E); the corpus is the gate, not the type list.

**The sentence the SDS adopts.**
> The DDL runner accepts only Data Model's seven-operation `DdlOp` union with
> `ColumnSpec.type ∈ {TEXT,INTEGER,REAL,BLOB,NUMERIC,BOOLEAN,DATE,ASSET,PAGE,RELATION}`; the FK target is
> derived from the type and a caller-supplied reference object does not exist; `add_column` with `notNull` and
> no literal default is refused with `422 SKW_E_DM_DDL_REJECTED reason=default_required`;
> `drop_column` on an indexed or FK-referenced column is refused with `reason=rebuild_required` unless the
> caller asked for the rebuild, and the rebuild runs the 12-step procedure with `foreign_keys=OFF` outside the
> transaction and restores `sqlite_sequence` inside it.

### C-14 — `bytes_sent`: the app cannot know it, and the schema makes it a `NOT NULL` zero (SEC · PLT · DM) — D-34

**Position A.** `r1-security.md` §4 A-3: after `X-Accel-Redirect` "the app has handed off and never sees a
byte … nginx served the *file* and discarded the upstream body — the handler's response never reaches the
client and no completion callback fires". So `bytes_sent` can only be `Content-Length` or a guess.

**Position B.** `r1-platform.md` §1 P8 makes it a falsifier: "a gated download whose `bytes_sent` in
`cms_download_event` is not within 1 % of nginx's `$body_bytes_sent`" — and §3.9 says the nginx JSON line is
"the only place `bytes_sent` is trustworthy". `r2-data-model.md` §1 row 1 accepts the fact and splits the
column.

**VERDICT — B's falsifier is withdrawn; A's fact governs the schema.** `bytes_declared` (NOT NULL) is what the
app authorised; `bytes_sent` is nullable and is filled **only** by an ingest of the nginx access log, which
ships in v1 as a documented daily job but is not wired in S3 — so v1 writes NULL. P8 is restated against the
log line, not against the app's column.

**Rationale.** A `NOT NULL DEFAULT 0` byte count in the table that exists to prove what was downloaded is a
fabrication, and "0 because the app cannot know" and "0 because nothing was sent" are indistinguishable to a
reader in a dispute (`r2-data-model.md` §6 concedes exactly this). A NULL is honest. The falsifier as written
can never pass, so it would be deleted the first time it tripped — which is worse than not having it.

**What would overturn it.** A supported nginx→app completion signal (a `post_action`, a `log_by_lua`, or an
`X-Accel` trailer) that is measured to fire per response. If one exists, the ingest job becomes unnecessary
and the column is written directly.

**The sentence the SDS adopts.**
> `cms_download_event` records `bytes_declared INTEGER NOT NULL` (the `Content-Length` the app authorised),
> `bytes_sent INTEGER NULL` (filled only from the nginx access log; NULL in v1), `kind TEXT NOT NULL
> CHECK(kind IN ('first','range','denied'))` and `jti TEXT NULL` with a partial unique index
> `WHERE kind='first'`; no process writes a byte count it did not observe.

### C-15 — Connection classes: the backup runs on the class that must not have `VACUUM INTO` (RT · SEC · PLT · DM) — D-11, D-12, D-13, D-16, D-17

**Position A.** `r1-runtime.md` §1 I5 and §4 A3: a readonly handle allows `ATTACH`, `VACUUM INTO`,
`CREATE TEMP TABLE` and `CREATE TEMP TRIGGER` (measured §6.3); `r2-security.md` §5 M1 adds that a readonly
handle wrote 16,384 B to `tenants/beta/planted.db` **and to `content/public/backup.db`** — the second one
publishes the tenant's whole database under the web root. `r2-red-team.md` §3 N1: "No cross-tenant boundary
is crossed, so every tenancy invariant in every paper stays green."

**Position B.** `r1-platform.md` §2 PD7: `backupTenant(key)` "runs `VACUUM INTO '<dest>'` on a read
connection". `r2-red-team.md` §4 X9: "closing N1 means denying `VACUUM INTO` on render handles; PD7 then
breaks, and the obvious repair is to grant it back, reopening N1." `r1-data-model.md` §2 DM10 has a pool plus
"DDL never pooled"; `r1-runtime.md` §2 D-R4 has one readonly LRU. Neither describes the admin write path.

**VERDICT — three named classes, no fourth.** `render-read` (`readonly:true` **and** `PRAGMA query_only=1`;
no SQL text path, so `ATTACH`/`VACUUM` are unreachable rather than merely denied), `admin-write` (read-write,
`foreign_keys=1`, discarded after any DDL), `exporter` (short-lived, never pooled, never inside a transaction —
the only class that may run `VACUUM INTO`). Backup and all three export targets call `exportSnapshot()`, which
opens an `exporter` connection.

**Rationale.** Security's `VACUUM INTO` finding is the sharpest in the corpus: it needs no write to a table,
no cross-tenant query, and it lands a cacheable file under `/media/`. `query_only=1` closes it (measured: the
same statement raises `SQLITE_READONLY`), and it also closes temp tables and temp triggers, which `readonly`
alone permits — and a temp trigger created in request 1 was measured firing on request 2's insert
(Security M1 D). But `query_only` does **not** close `ATTACH` (measured: `database_list` shows `["main","ctl2"]`
after the pragma), so the no-SQL-text rule stays load-bearing. PD7 is not wrong to want `VACUUM INTO`; it is
wrong about the connection it runs on.

**What would overturn it.** A dependency that opens its own handle to `site.db` (then `query_only` is
decorative and a process boundary is the only answer), or a route that calls `pragma('query_only = 0')` on a
pooled connection (Security's own overturn condition, and the reason the pragma is set in the factory and
asserted on checkout).

**The sentence the SDS adopts.**
> Exactly three connection classes exist: `render-read` (`readonly:true` + `PRAGMA query_only=1` +
> `foreign_keys=1` + `busy_timeout`, never handed a statement built from text), `admin-write` (read-write,
> `foreign_keys=1`, discarded — not returned to the pool — after any DDL or any statement not emitted from a
> template), and `exporter` (a dedicated short-lived connection that is never in a transaction and is never
> pooled; the only class permitted to run `VACUUM INTO`); `exportSnapshot()` is the only function that opens an
> `exporter` connection, and `backupTenant()` calls it.

### C-16 — Watermark: where it runs, how long a render lives, and what an encrypted PDF does (PLT · SEC · DM) — D-37, D-38, D-39

**Position A.** `r1-security.md` §2 DS-7: fail closed — `503 E_WATERMARK_FAILED`, no `X-Accel-Redirect`, one
event row, one alert; no retry-without-watermark path exists. `r1-platform.md` §4 A4: a 600 ms synchronous
block made 20/20 unrelated requests wait 510–514 ms against a 0.5 ms baseline, and "`X-Accel-Redirect`
offload does not help, because the stamping happens before the redirect" — so stamping must run off-loop with
a 2 s budget.

**Position B.** `r1-data-model.md` §2 DM20/§7.8 keeps a per-purchaser render cache keyed
`content/protected/wm/<spec_sha>/<asset_sha>.<ext>`; `r1-red-team.md` §1 O12 measured that `spec_sha` includes
the buyer's email, so the hit rate is ≈1 and every redemption leaves a permanent file: 1,000 buyers × a 5 MB
book at +60 % ≈ 8 GB. `r2-platform.md` §1 row 12 measured 8.5 MB / 50 copies inside an 11.7 MB fixture.
`r1-red-team.md` §1 O16: an owner-password PDF is not corrupt, but `pdf-lib` cannot load it, so fail-closed
denies 100 % of that tenant's downloads and the issue screen warned about nothing.

**VERDICT — A's fail-closed policy stands; B's cache becomes a bounded transient; encrypted assets are
refused at issue, not at download.** Stamping runs in a worker with a 2000 ms wall budget; a render is deleted
`download.continuation_grace_s` after the token that produced it expires (default 21,600 s) and is excluded
from every bundle; `cms_asset.encrypted=1` (set at upload sniff) makes the asset un-gateable with a named
reason in the issue form.

**Rationale.** The cache exists to keep `Range` byte-stable within one download, not to store. At ~1.3 ms/page
(51.9 ms cold / 23.4 ms warm for 40 pages) a re-render is cheaper than any eviction policy that has to be
correct, and deletion at token expiry bounds the archive by *concurrent downloads* instead of by *lifetime
sales*. Failing at issue rather than at download moves the failure to the one moment a human is present.

**What would overturn it.** A measured re-render cost that exceeds the download's own latency budget on the
target box (e.g. a 400-page PDF at 10× the measured rate under a 1 vCPU limit), which would make a longer-lived
cache necessary and reinstate an eviction requirement.

**The sentence the SDS adopts.**
> Watermark stamping runs in a worker with a 2000 ms wall-clock budget and returns
> `503 SKW_E_SEC_WATERMARK_FAILED` on timeout, renderer error or unencodable text after cp1252 sanitisation; a
> render file is deleted `download.continuation_grace_s` (default 21,600 s) after the token that produced it
> expires and is excluded from every bundle; an asset with `encrypted=1` is refused for gating at issue time
> with `422 SKW_E_DM_ASSET_UNSTAMPABLE` naming the asset, and no code path serves an un-stamped gated byte.

### C-17 — "A gated asset is absent by construction" versus a generated `storage_path` under one media tree (SEC · PLT · DM · RT) — D-21, D-22, D-23, D-41

**Position A.** `r1-security.md` §1 S-6: "A gated asset is absent from the public tree by construction, not by
permission. No symlink in `content/public/`, no non-`internal` location that can reach it."

**Position B.** `r2-data-model.md` §1 row 25 makes `storage_path` a `GENERATED ALWAYS … STORED` column derived
from `sha256` and `mime`, which puts **every** asset — public or gated — under `content/media/`;
`r2-platform.md` §3.2 states the consequence plainly: "The generated column puts every asset, public or gated,
under `content/media/`; S-6 assumes gated bytes live somewhere else … **Resolution in C2:** one byte tree,
serving split by location, S-6 restated as a link-absence test." `r2-platform.md` §6 concedes: "Security's S-6
cannot survive the generated `storage_path`."

**VERDICT — B wins on the tree; A's guarantee is restated as a test, and the test is mandatory.** One byte
tree `content/media/`; `/media/` aliases `content/public/` (farm only, public assets only); `/__protected/`
aliases `content/media/` with `internal` and a 64-hex guard. The invariant becomes: *no farm link exists for a
gated asset, and `GET /media/<key>` is 404.*

**Rationale.** A generated column is the only control in the corpus that a CRUD form cannot defeat: measured,
`INSERT`/`UPDATE` naming `storage_path` is rejected by the engine from any driver *and* from the `sqlite3` CLI
(`make test` PASS 11). The cost is real — a missing symlink is weaker than a missing directory — so the test
replaces the construction claim and is run on every bundle. Platform M10 measured the observable half on an
installed bundle: `GET /media/ebook.pdf → 404`, `find content/public -lname "*<gated sha>*" → 0`, and a direct
`/__protected/<sha>.pdf → 404`.

**What would overturn it.** A second byte root (a separate `content/protected/` mount) that keeps the
generated column. That is possible — the generated path would need a `CASE access_class` term, which a stored
generated column cannot reference without becoming invalid on an `access_class` update — so the overturn is
"make the generated column depend on a column that never changes", which is a schema change of equal size.

**The sentence the SDS adopts.**
> `content/media/` is the only byte tree; `/media/<key>.<ext>` is served by nginx from `content/public/`, which
> contains one relative symlink per public asset and nothing else; `/__protected/` is `internal` and aliases
> `content/media/` behind a 64-hex guard; a gated asset has no farm link and `GET /media/<key>` is 404;
> `cms_asset.storage_path` is `GENERATED ALWAYS AS ('content/media/'||substr(sha256,1,2)||'/'||sha256||'.'||<mime ext>) STORED`
> and any `INSERT` or `UPDATE` naming it fails.

### C-18 — `function` data sources leave v1, and nothing replaces aggregates (DM · SEC · RT · IDEA) — D-14, D-55, D-56

**Position A.** `r1-data-model.md` §3.5 and `r2-data-model.md` §1 row 8: `cms_datasource.kind
CHECK(kind IN ('view','query'))` — `function` is not representable. `r1-security.md` §4 A-5: the file lives
under `tenants/<key>/content/sources/`, inside the tree the app writes and the exporter tars; "any write
primitive that escapes `content/media/**` … yields `import()` of attacker-chosen code inside the process that
holds every tenant's DB handle and every HMAC key". `r2-security.md` §5 M4 proves the containment shape: with
`--allow-addons` off the module cannot even load; with it on, `ATTACH` to a sibling tenant succeeds.

**Position B.** `IDEA.md` §4 kind 3 keeps `function` as a documented kind; `r2-red-team.md` §1 B2: "Removing
`function` … and refusing `count(*)` … leaves no aggregate or join path in v1. 'How many products?' and
'latest post per category' have no supported source. The developer answer is a migration, which a sold bundle
cannot run." `r1-runtime.md` §5 Q2 measured `count(*)` at 1,990 µs indexed / 4,374–5,020 µs unindexed on 90 k
rows and leans "refuse `count(*)` specs".

**VERDICT — A wins on removal; B's gap is closed by extending the `query` grammar, not by reinstating
`function`.** `kind ∈ ('view','query')`; `query` gains
`aggregate: {fn: count|sum|min|max, column}` with an optional `group_by` of at most two columns, every
referenced column indexed, and the publish gate refuses (`SKW_E_RT_SOURCE_UNINDEXED`) when `EXPLAIN QUERY PLAN`
contains `SCAN`. `join` is not expressible in v1 (see O-12).

**Rationale.** `function` is arbitrary code with a cross-tenant read primitive, one line long, and in the
export direction it is reachable *by design* — the bundle carries `sources/` and the 5-minute install runs it.
There is no version of that which is shippable. The aggregate gap is real but it is a grammar problem: a
`count` over an indexed column is 1,990 µs at 90 k rows (under the 4 ms page budget but over the 1.5 ms
worst-source budget), so it is publishable only with a covering index and only on a source whose budget allows
it — which is exactly what the publish gate already decides for `query` sources. Refusing `count(*)` outright
would leave operators with no answer and push them to migrations.

**What would overturn it.** A measured aggregate the grammar cannot express that a paying client needs (a
window function, a correlated subquery, a multi-table join). The remediations are, in order: extend the
grammar with a tested emitter path, then a migration-owned `cms_v_*` view, then — only in v2 — a sandboxed
child process that receives row sets, never a handle.

**The sentence the SDS adopts.**
> `cms_datasource.kind` is `CHECK(kind IN ('view','query'))`; a `function` value is not representable and a
> pre-existing row fails resolution with `SKW_E_RT_SOURCE_UNKNOWN`; a `query` source may declare
> `aggregate: {fn: count|sum|min|max, column}` and `group_by` of at most two columns, and is published only
> when `EXPLAIN QUERY PLAN` contains `SEARCH` and no `SCAN` and the measured worst-case cost is at most
> 1.5 ms.

### C-19 — Four environment prefixes, 38 names, two names for one secret (ALL · RT) — D-79

**Position A.** `r2-security.md` §5 M8 counted it: "distinct env-var names across the five R1 papers: 38 …
four prefixes, 38 names, four concepts with two spellings each, two headers for the edge token, two names for
the download HMAC key." `r2-red-team.md` §4 X10 adds that `install.sh` generates `SKUNK_*`, the app refuses to
boot without `SKW_CODE_PEPPER`, and the operator's only clue is a name that appears nowhere in the bundle.

**Position B.** `r2-runtime.md` §3 X6: "one prefix `SKW_` for the environment; one code registry
`SKW_E_<AREA>_<NAME>` … startup fails if any key matching `^SK_|^SKUNK` exists, printing the rename."

**VERDICT — B wins, and it is the one change that must land before S1 writes a `.env`.** One prefix `SKW_`,
one canonical table (§4.2), one code registry `SKW_E_<AREA>_<NAME>` with `AREA ∈ {RT, DM, SEC, PLT, EXP, PL}`
and one header name per concept. The header name is **not** configurable: `SKW_TENANT_HEADER` is deleted, so a
deployment cannot half-rename the contract.

**Rationale.** This is the cheapest decision in the register and the most expensive to defer: after S2 it is a
migration script and a support page, and before S1 it is a find-and-replace across five documents. Two names
for the edge token is not cosmetic — whichever the app checks, the other is dead config, and the failure mode
is every request 421 (loud) or a builder deleting the token because the CIDR "already works" (silent, and
caller-controlled tenancy).

**What would overturn it.** Nothing in the corpus. The only counter-argument is sunk cost in the papers, which
is not an argument.

**The sentence the SDS adopts.**
> Every environment variable begins `SKW_`; the table in §4.2 is the complete list; the process refuses to
> start when any environment key matching `^SK_|^SKUNK_` exists, printing the offending key and its
> replacement, and every error code matches `^SKW_E_(RT|DM|SEC|PLT|EXP|PL)_[A-Z0-9_]+$`.

### C-20 — Per-tenant rate limit of 20 r/s against a measured 192 r/s box (PLT · RT) — D-77

**Position A.** `r1-platform.md` §2 PD8: `limit_req_zone $skunk_tenant zone=tenant:10m rate=20r/s`.

**Position B.** `r1-runtime.md` §6.7: a four-source page served 192 req/s at 50 connections (p50 148 ms,
p99 2,710 ms); `r2-red-team.md` §3 N8 multiplies: "at the 50-tenant demo fleet D-R4 sizes for, the edge permits
1,000 r/s" against a 192 r/s ceiling — 5.2× over, and "every per-tenant limit reports headroom".

**VERDICT — B wins: the limit is derived, not fixed.** `rate = min(20r/s, floor(SKW_BOX_RPS / hot_tenants))`,
`burst = 2 × rate`, and the SDS states a hard ceiling of **50 hot tenants per 2 vCPU box** at the declared 4 ms
page budget. On a 50-tenant box that is 4 r/s burst 8 per tenant; a tenant that needs 20 r/s gets its own box.

**Rationale.** A per-tenant limit that sums above the box's measured capacity is not a limit; it is a queue
with a friendly name. The 192 r/s figure is for a page with 2.3 ms of synchronous work — the *degraded* case —
so 50 × 4 r/s leaves headroom for the 0.25 ms page and for static assets served by nginx. The number is
deliberately conservative because the failure it prevents (a launch day on one demo saturating the box while
every dashboard is green) is invisible until it happens.

**What would overturn it.** A measured page cost below 0.5 ms at production row counts, which would raise
`SKW_BOX_RPS` and therefore every tenant's derived rate. The publish gate's `cost_ms_max` is the input; the
formula reads it, so the limit improves automatically when the pages do.

**The sentence the SDS adopts.**
> Each tenant's edge rate is `rate = min(20r/s, floor(SKW_BOX_RPS / hot_tenants))` with `burst = 2 × rate`,
> where `SKW_BOX_RPS` is the box's measured four-source page throughput and `hot_tenants` is the count of
> tenants with a request in the last 60 s; one box serves at most 50 hot tenants at the 4 ms page budget, and
> a tenant that needs more than 20 r/s is deployed on its own box.

### C-21 — Audit: split by plane, chained in the tenant's own writable file (DM · SEC) — D-88

**Position A.** `r1-data-model.md` §2 DM7: `control.db.audit_log` for the fleet, `site.db.cms_audit` for the
tenant, and "**No action writes to both**", because two rows for one action can disagree.

**Position B.** `r1-security.md` §3.1 requires `prev_hash`/`hash` on `audit_log`; `r2-security.md` §2 C-1
measured that a chain alone cannot detect deletion: after deleting all 10,000 rows `verify()` returns
`mismatch=null` — a vacuous chain — and deleting the tail leaves a valid prefix. `r2-data-model.md` §2 C3
measured the same from the other side: tamper row 2 and recompute, the unanchored chain verifies.

**VERDICT — A's split stands; B's chain is kept and anchored by a daily seal.** `cms_audit` is chained inside
`site.db`; one `audit_seal(tenant_key, day, rows, head)` row per tenant per day is written into `control.db`.
Verification is a query: compare `count(cms_audit)` and the recomputed head to the seal. A missing or
mismatched seal is the alert.

**Rationale.** DM7's objection — two sources of truth for one action — does not apply to a digest: the seal is
one row per tenant per *day*, not per action, and a missing digest is itself the evidence. The cost is
measured: 10,000 rows chained in 36 ms, verified in 17 ms, seal written in 455 µs, 32.1 KB per tenant-year.
Without it, "auditable" means "auditable until the tenant edits the file they own", which is the exact file the
brief lets them edit through CRUD forms.

**What would overturn it.** A tenant-plane audit that lives outside the tenant's writable tree (i.e. audit
writes to `control.db`), which DM7 measured as a fleet-wide bottleneck — `busy_timeout=0` lost 150 of 200
writes under four writers. If the seal's daily write ever contends at fleet scale (200 tenants × 1 row/day is
200 writes/day, so it will not), the seal can move to an append-only log file.

**The sentence the SDS adopts.**
> `cms_audit` rows are hash-chained (`prev_hash`, `hash` over the canonical row) inside `site.db` and written in
> the same transaction as the change they record; one `audit_seal(tenant_key, day, rows, head)` row per tenant
> per UTC day is written to `control.db`; the verifier compares `count(cms_audit)` and the recomputed head to
> the seal and raises `SKW_E_SEC_AUDIT_SEAL` when either disagrees.

### C-22 — Static snapshot: "same DB state, identical bytes" versus a clock and a parameter (RT · PLT · DM) — D-67, D-68

**Position A.** `IDEA.md` §5.1: the static export is "exactly the D5 publish snapshot … Reproducible: the same
DB state must produce identical bytes", and pre-flight 3 freezes parameterised sources "at their default
parameters … lists each one in `EXPORT-NOTES.md`". `r1-platform.md` §4 A5: "Reproducible bytes, unreproducible
site" — page 2 of the blog does not exist and the tag filter 404s.

**Position B.** `r1-runtime.md` §4 A1 measured both halves: per-source TTL caches, `Date.now()`-relative text
and parameter-frozen sources all change output between two exports of the same DB. `r2-runtime.md` §4 I14
replaces the rule: **enumerate, cap, refuse** — declared parameter domains, a cross product up to
`SKW_SNAPSHOT_MAX_COMBOS` (1024), `SKW_EXPORT_NOW` as the only clock, and a refusal when a `free` parameter
appears in a link.

**VERDICT — B wins entirely. A's "freeze at defaults" is deleted; the refusal replaces the note.**

**Rationale.** A note in `EXPORT-NOTES.md` is not a site: the cheapest SKU ships with a 404 where the CMS has
content, and "reproducible bytes" makes it permanent. Enumeration is affordable — measured: a 10-row/4-column
source is 561 B raw / 103 B gzip per combination; 500 combinations = 274 KB and 500 files at 0.07 ms each;
1,024 generated pages ≈ 50 s at Platform's measured `astro build` rate, inside the ≤3 min Astro target. The
pinned clock is what makes the reproducibility claim true rather than approximately true: two exports of the
same DB at the same `SKW_EXPORT_NOW` are byte-identical (measured, DM check 16, once volatile rows are excluded
from the projection digest).

**What would overturn it.** A client whose blog needs more than 1,024 combinations — then pagination becomes a
first-class generated route (one page per `page` value, no cross product with tags) rather than raising the cap
into a 4,000-file build. Or `astro build` measuring above ~150 ms/page, which would blow the 3-minute target.

**The sentence the SDS adopts.**
> `SKW_EXPORT_NOW` (ISO 8601) is written into `BUNDLE.json` and is the only clock a snapshot may read; every
> `query` source declares each parameter's domain in `params_json` (`enum`, `int`, `page`, `bound` or `free`);
> the exporter enumerates the cross product of the non-`free` domains up to `SKW_SNAPSHOT_MAX_COMBOS` (1024)
> and `SKW_SNAPSHOT_MAX_BYTES` (2 MB per source), and refuses with `SKW_E_EXP_PARAMETERISED` when a `free`
> parameter appears in a link on any exported page; two exports of one database at one `SKW_EXPORT_NOW` are
> byte-identical.

### C-23 — `cms_page.template` is a frozen enum in a protected table (RT · DM) — D-54

**Position A.** `schema/site.sql` line 24:
`template TEXT NOT NULL DEFAULT 'page' CHECK(template IN ('page','landing','post','index'))`, and `cms_*` DDL is
refused by the runner (D8). `r2-red-team.md` §3 N7: "the fifth client needs a 'docs' layout; that is an
`ALTER TABLE` on a protected table, i.e. a migration, i.e. an image release we perform — for a product sold as
self-service."

**Position B.** `r1-runtime.md` §1 I6's publish gate already refuses a page whose registry-measured cost or
plan is unacceptable; nothing in Runtime requires the template to be an enum. No paper defends the enum.

**VERDICT — A is right that this is a defect and B is right that the fix is not an enum widening.** `template`
becomes a slug (`CHECK(template GLOB '[a-z][a-z0-9-]*')`) resolved against the image's shell registry at
publish; an unknown shell is `422 SKW_E_RT_TEMPLATE_UNKNOWN` at publish and `500` at render.

**Rationale.** The shell is a component in our source tree, versioned with the image, exactly like an island
type. A DB enum that must be widened by a migration pretends the database constrains something it does not: the
renderer only knows four shells because the image knows four shells. Making the column a slug and the registry
the authority puts the constraint where the code is, and it makes the failure a publish-time refusal instead of
a raw SQLite error on a protected table.

**What would overturn it.** A requirement that tenants author their own shells (a template editor). That is a
different product decision — it puts tenant-authored layout code on every render — and it is refused in v1 by
the same reasoning as `function` data sources.

**The sentence the SDS adopts.**
> `cms_page.template` is a slug (`CHECK(template GLOB '[a-z][a-z0-9-]*')`) resolved against the image's shell
> registry at publish; an unknown shell is `422 SKW_E_RT_TEMPLATE_UNKNOWN` naming the shell and the page, and
> adding a shell is an image release, never an `ALTER TABLE`.

### C-24 — A bundle has no control plane, and three papers each assume another created it (RT · PLT · DM · RUN) — D-65

**Position A.** `IDEA.md` §6: `control.db` tables are "Global, **never exported**"; §5's bundle contents are
`docker-compose.yml` · `.env` · `data/site.db` · `content/` · `install.sh`. `r1-red-team.md` §1 O2: the bundle
"arrives with no row saying which host it answers to, no `users` row to log in as, and no `tenants.mode`", and
`install.sh`'s own job — "tenant marked active" — needs all four.

**Position B.** `r2-platform.md` §1 row 1 and §4.1: `data/control.seed.json` + `tools/seed_control.py`,
measured — seeding from a projection gives 1 tenant / 2 domains / 1 admin / 0 sessions / 0 audit and forces
`mode=production`, while shipping the fleet file gives 3 tenants / 48 domains / 3 users / 2 sessions / 120 audit
rows. `r2-runtime.md` §3 X5 and `r2-data-model.md` §1 row 23 ask for the same thing from their sides.

**VERDICT — B wins: a seed, never the fleet file, and never a default.** `data/control.seed.json` carries one
tenant with `mode='production'` forced, its hosts, one `owner` user with an argon2id hash and `must_change=1`,
`db_version`, and settings; `install.sh` applies `schema/control.sql` and seeds exactly those rows in one
transaction before `compose up`.

**Rationale.** The schema already fails closed on the dangerous half: `tenant.mode` has no default and
`CHECK(mode <> 'demo' OR demo_expires_at IS NOT NULL)` means a seed that forgets `mode` errors instead of
defaulting to `demo` — which would apply TTL auto-expiry to the site the client just bought. The fleet file is
worse in the other direction: 46 foreign domains, 2 live sessions and our operators' audit rows in a bundle
handed to a third party.

**What would overturn it.** A product decision to sell a *fleet* (several sites in one install). That changes
the seed to an array and the admin to the fleet URL shape, both of which already exist for our own hosting; it
does not change the "never ship `control.db`" rule.

**The sentence the SDS adopts.**
> A bundle carries `data/control.seed.json` — one tenant with `mode='production'`, its hosts, one `owner` user
> with an argon2id hash and `must_change=1`, `db_version` and settings — and `install.sh` applies
> `schema/control.sql` and seeds exactly those rows in one transaction before `compose up`; no bundle contains
> `data/control.db`, `data/site.db-wal`, `data/site.db-shm`, `content/protected/wm/`, `content/sources/` or a
> populated `.env`.

### C-25 — A path-prefix demo shares an origin with the admin (SEC · PLT · RT) — D-08

**Position A.** `r1-platform.md` §2 PD5 and `IDEA.md` D7: `/demo/<key>/` exists so a demo needs "no DNS and no
cert"; the demo therefore lives on the same host and port as `/admin`.

**Position B.** `r2-security.md` §2 C-4: a demo page is tenant-authored HTML with JavaScript in it (that is the
product, IDEA §8); same origin means it can `fetch('/admin/pages')` with the operator's `__Host-sk-sess` cookie
attached, CORS does not block reading a same-origin response, and the admin page contains the CSRF token
because the admin UI must render it — "so the demo page reads the token and posts a privileged change". The
port-based `Origin` check saves a separate-port admin, not a same-port path demo. `r2-red-team.md` §1 A6
reached the same place from the cookie direction.

**VERDICT — B wins, at the cost of one DNS record.** Demos live at `demos.<our-domain>/demo/<key>/`; admin
lives at `admin.<our-domain>`; a host that serves tenant-authored HTML never serves the admin listener, and the
admin listener returns `421` for any request whose `Host` maps to a demo tenant. PD5's `location`, `map`,
`rewrite` and `proxy_set_header` block move unchanged — "adding a demo changes no config" survives.

**Rationale.** This is privilege escalation from "can edit a demo page" to "can mint an admin", reachable by a
*prospect's* tenant against the platform operator — the exact boundary the security mandate is about. The
cheap alternative (`__Host-` plus a path scope) is not a weaker cookie, it is an invalid one (§4.4), and
the CSRF control that would otherwise save it fails because the origin *is* the admin origin. One DNS record
and one cert is the smallest possible price for closing it.

**What would overturn it.** Evidence that a demo tenant is never adversarial — i.e. demos are only ever built
by us and never edited by a prospect. That is not the product being sold: D24 ships the editor to the client,
and §8.2 says hand-edited HTML always wins.

**The sentence the SDS adopts.**
> A host that serves tenant-authored HTML never serves the admin listener: demos live at
> `demos.<our-domain>/demo/<key>/`, admin at `admin.<our-domain>`, and the admin listener returns
> `421 SKW_E_PLT_EDGE_PROOF` for any request whose `Host` maps to a tenant with `mode='demo'`.

---

## 3. Objection ledger — O-1..O-44

One row per remaining defect (44 of the 100; the other 56 are decided in §2). Columns: defect | source paper +
heading | owner | verdict | fix shape, or the deciding experiment with its owner and slice. DEFERRED entries
carry a numbered prose block after the table, because a deferral without an experiment is a silent drop.

| # | D | Objection, and where it is stated | Owner | Verdict | Fix shape / experiment |
|---|---|---|---|---|---|
| O-01 | D-09 | Path case: `cms_page.path` is `COLLATE NOCASE`, no component in front is confirmed not to fold case — `r1-data-model.md` §5 Q3, `r2-red-team.md` §1 B10 | Platform | **REJECTED as a v1 defect** | nginx 1.31.7 does not fold case (Platform T24 shows `$request_uri` preserved); v1 has no CDN because HTML is `no-store` (Runtime D-R8). Recorded constraint: any future CDN must pass case through or the NOCASE index must be dropped first. |
| O-02 | D-15 | `content/sources/` is in-process code in the tenant's writable tree — `r1-security.md` §4 A-5, `r2-red-team.md` §1 B8 | Security | **ACCEPTED** | `content/sources/` is mounted read-only, is never in a bundle, and no `import()` exists in v1 (C-18). An fs audit (`fs_usage`/`strace -f -e trace=openat,rename`) asserts every app write resolves under `content/media/**`. |
| O-03 | D-18 | A tenant volume must be read-write even for the render path (`SQLITE_READONLY_DIRECTORY` on `:ro`) — `r1-data-model.md` §3.3 M16, `r2-platform.md` §1 row 10, `r2-red-team.md` §3 N5 | Platform | **ACCEPTED** | `./data` and `./content` are rw; the root filesystem is `read_only: true` with `tmpfs /tmp`; the SDS states that a read-only tenant mount is not available and therefore no "cheap" middle isolation option exists. |
| O-04 | D-25 | The asset FK guarantee is a connection pragma, not a schema property — `r1-security.md` §4 A-4, `r1-red-team.md` §1 O15, `r2-data-model.md` §1 row 2 | Data Model | **ACCEPTED** | `trg_cms_asset_delete_guard` + per-column immutability triggers, all registered in `cms_trigger_registry`; measured to fire with `foreign_keys=OFF` and through the `sqlite3` CLI (`make test` PASS 12). |
| O-05 | D-26 | A rebuild with `foreign_keys=ON` cascade-deletes children — `r2-data-model.md` §4 I11, check 13 | Data Model | **ACCEPTED** | Every rebuild sets `foreign_keys=OFF` before `BEGIN` (inside a transaction it is a silent no-op, R1 M3b) and restores `sqlite_sequence` inside it. |
| O-06 | D-27 | A table rebuild resets `sqlite_sequence`, reissuing ids — `r1-data-model.md` §2 DM4/M5 | Data Model | **ACCEPTED** | `UPDATE sqlite_sequence SET seq = :old WHERE name = :t` inside the rebuild transaction; `make test` PASS 5 (`seq 5→3` without it, `restored → next id 6` with it). |
| O-07 | D-40 | Non-Latin filenames throw `Cannot convert argument to a ByteString` on the download route — `r2-red-team.md` §3 N4 | Security | **ACCEPTED** | `Content-Disposition: attachment; filename="<ascii fallback>"; filename*=UTF-8''<pct-encoded original>`; a test downloads `报告.pdf` and asserts 200 and the exact header. |
| O-08 | D-42 | Per-purchaser watermark renders travel in the export — `r1-red-team.md` §1 O3, `r2-platform.md` §1 row 2 | Platform | **ACCEPTED** | `content/protected/wm/**` is excluded from **every** target; `BUNDLE.json` class `pii`; measured naive bundle 8,739,862 B vs sealed 224,983 B on the same fixture. |
| O-09 | D-43 | Farm links written absolute 404 in a container and `tar` stores the target verbatim — `r1-platform.md` §4 A2/T11d–f, `r2-platform.md` §1 row 15 | Platform | **ACCEPTED** | Farm links are `../media/<hh>/<sha>.<ext>` only; `bundle_verify` runs `readlink` on every link against `^\.\./media/[0-9a-f]{2}/[0-9a-f]{64}\.[a-z0-9]{1,5}$` and asserts the target resolves inside the bundle. `find -L` is banned as a check (M5: it reports only the broken link). |
| O-10 | D-50 | The Data Source result cache is keyed per source, not per parameter — `r1-red-team.md` §1 O13, `r2-runtime.md` §1 R2/R11 | Runtime | **ACCEPTED** | Result-cache key = `(tenantKey, sourceKey, specRev, sha256(canonicalParams))`; single-flight per key; a test renders `{limit:3}` and `{limit:50}` in both orders inside one TTL and asserts each row count. |
| O-11 | D-51 | The mount seam loses JSON and `text/plain` request bodies — `r2-runtime.md` §5 M6/M6b, `r1-red-team.md` §2 | Runtime | **ACCEPTED** | `addContentTypeParser(['application/json','text/plain'], …)` with `if (req.is404) return done(null, payload)`; measured: JSON body reaches the handler intact (14 B) and `/api/echo` still parses. A 1 MiB JSON POST through the seam is the regression test. |
| O-12 | D-52 | One 600 ms synchronous block stalls 20/20 unrelated requests — `r1-platform.md` §4 A4/T22, `r2-runtime.md` §1 R4 | Runtime | **ACCEPTED** | I15: no request may block the loop >5 ms; sources ≥0.5 ms and watermark renders run off-loop with a 2 s cap; `monitorEventLoopDelay` p99 >50 ms → `503 SKW_E_RT_LOOP_CONGESTED`; per-tenant semaphore of 8 renders. |
| O-13 | D-53 | "Hand-edited HTML always wins" with no editor-managed flag — `r1-red-team.md` §6.5, `r2-data-model.md` §1 row 10 | Data Model | **ACCEPTED** | `cms_page.managed_by ∈ {editor, hand}`; a `hand` page is opened read-only in GrapesJS; `cms_page_revision` makes the loss recoverable, not prevented. |
| O-14 | D-57 | `p95 of 20` is not an estimator (0.29×–13.97× the truth) — `r2-runtime.md` §5 M4, `r2-platform.md` §2 C3 | Runtime | **ACCEPTED** | The gate stores `cost_ms_max` (max of 200) and `cost_ms_p95` (p95 of 200) and refuses on **max**; the plan check runs **before** measurement (0.015 ms vs 1,304 ms to reject). |
| O-15 | D-60 | The shipped `cms_page.path` CHECK rejects `/` — `r2-data-model.md` §5.2, check 10; my own run in §1.4 | Data Model | **ACCEPTED** | `path = '/' OR (path GLOB '/*' AND NOT '*..*' AND NOT '*/' AND NOT '*//*')`; already applied in `r2-amendments.sql`. |
| O-16 | D-61 | `cms_redirect.to_path` accepted `//evil.example` (protocol-relative open redirect) — `r2-data-model.md` §5.2 | Data Model | **ACCEPTED** | Shared path predicate emitted from one function; `to_path` rejects `//*`, `*..*`, `*/` and `*//*`; an off-site link is `cms_nav.href_kind='url'`. |
| O-17 | D-62 | `cms_page.slug` is not unique, so `site.page(slug)` is ambiguous on a nested site — `r2-red-team.md` §2.12 | Runtime | **ACCEPTED** | `site.page(path)` replaces `site.page(slug)`; `slug` is display-only and never a lookup key. |
| O-18 | D-63 | `cp` of a live `site.db` loses everything since the last checkpoint, silently — `r1-data-model.md` §4 A3/M1, `r1-platform.md` §6 T17b, `r1-runtime.md` §6.9 | Platform | **ACCEPTED** | Export and backup are `VACUUM INTO` on the `exporter` class; `wal_checkpoint(TRUNCATE)` first; a `-wal` file inside a bundle is a build failure. |
| O-19 | D-64 | A `cp`-built bundle with a manifest measured from the copy passes 27/27 checks and serves 201 pages of 241 — `r2-platform.md` §5 M4 | Platform | **ACCEPTED** | Quiescence counts: every exported table counted on the source before, on the source after, and in the snapshot; all three must agree, ≤5 attempts, else `SKW_E_EXP_NOT_QUIESCENT`. `source_counts` ships in `BUNDLE.json` and `install.sh` compares. |
| O-20 | D-66 | The bundle ships submissions, codes, events and our operators' audit rows — `r1-red-team.md` §1 O3, `r2-security.md` §1 row 11, `r2-platform.md` §2 C5 | Platform | **ACCEPTED** | `export-projection.json` classes (`cms_download_code`, `cms_download_event`, `cms_watermark_render`, `cms_form_submission`, `cms_audit` = `empty`); `BUNDLE.json` per-file `class`; `--include-pii` off by default and audited when used. |
| O-21 | D-69 | `find -L` cannot see an absolute link whose target exists — `r2-platform.md` §5 M5 | Platform | **ACCEPTED** | `readlink` + regex, per O-09; the check runs inside the pinned image with the bundle mounted `:ro`. |
| O-22 | D-70 | `journal_mode=WAL` before verification makes a read-only verify impossible — `r2-platform.md` §5 M2 | Platform | **ACCEPTED** | Ship cold (`delete` mode, which `VACUUM INTO` produces), verify with `immutable=1`, then set WAL inside the gate (measured 4.8 ms). |
| O-23 | D-71 | The 5-minute promise contains DNS, ACME and a bundle transfer nobody measured — `r1-red-team.md` §4, `r2-platform.md` §4.3 | Platform | **ACCEPTED** | The bracketed promise adopted as the D-note for §5.1 in §5; `install.sh` exits 11 on a wrong A record in 0.3 s; the certificate never gates the install (`certificate: pending`); bundle size capped and printed. |
| O-24 | D-72 | The Astro SKU ships no lockfile and is never built by the exporter — `r1-red-team.md` §1 O11, `r2-runtime.md` §1 R15, `r2-platform.md` §1 row 13 | Platform | **ACCEPTED** | The exporter emits the `package-lock.json` it resolved; CI runs `npm ci && npm run build` of each generated target before a bundle may ship and records the build id in the manifest. |
| O-25 | D-73 | nginx-proxy derives vhosts at container creation; adding a TLD recreates `app` — `r1-red-team.md` §1 O7, `r2-platform.md` §1 row 3 | Platform | **ACCEPTED** | No nginx-proxy in the data path; one generated `server` block per host plus `nginx -s reload` (milliseconds), `map $host $tenant` for the app, path-prefix demos need no server block; `ask` is dropped. |
| O-26 | D-76 | `/healthz` must not touch a database; `/readyz` must probe a write — `r1-platform.md` §1 P4/T13, `r2-runtime.md` §1 R19 | Platform | **ACCEPTED** | Three endpoints: `/healthz` liveness only; `/readyz` = `control.db` open + revision read + one scratch write; `/admin/api/tenants/<key>/health` per tenant, cached 30 s, alert-driven, never in the compose healthcheck. nginx checks a static byte of its own. |
| O-27 | D-80 | No upgrade channel: D10 pins a digest and a CVE fix requires the client to edit compose — `r1-red-team.md` §6.3, `r2-red-team.md` §1 A18 | Platform | **DEFERRED** | See §3.1. |
| O-28 | D-81 | Email transport for access codes is unspecified — `r1-red-team.md` §6.1, `r2-red-team.md` §1 A13 | Runtime | **ACCEPTED** | One SMTP transport (`SKW_SMTP_URL`, from-address, one template) in S3; `SKW_EMAIL_MODE=off\|smtp`, default `off`; when `off`, `POST /api/hooks/<tenant>/issue-code` returns the code once in the 201 body and the store emails it; redelivery is `POST /admin/t/<key>/codes/<id>/reissue` (revoke + mint + send), never a re-send of a code we cannot read. |
| O-29 | D-82 | `linked-private` implies a preview session that does not exist — `r1-red-team.md` §6.4, `r2-red-team.md` §1 A15 | Runtime | **ACCEPTED** | Minimal preview in S2: `GET <path>?preview=<token>` where the token is `HMAC(SKW_SESSION_KEY, tenant\|path\|exp)`, minted in admin, 30-minute TTL, accepted only for `status='draft'`, `Cache-Control: no-store`, and logged once per render. No second tenant, no content copy. |
| O-30 | D-83 | No captcha, honeypot or per-IP limit on core `/forms/*` — `r1-red-team.md` §6.6, `r2-red-team.md` §1 A16 | Security | **ACCEPTED** | Core form submission uses the plugin endpoint contract verbatim: 16 KiB cap, 5/10 min per IP, intent token `_pt` (HMAC over tenant\|form\|ts, 30 min, min fill 1.5 s), honeypot `_hp` → 202 with the success body and no row. One implementation, two callers. |
| O-31 | D-84 | Demo expiry and tenant departure have no cascade — `r1-red-team.md` §6.7, `r2-red-team.md` §1 A17 | Platform | **ACCEPTED** | Expiry stops serving on the `demo_expires_at` day (404 with the tenant's own expired page), soft-deletes for 30 days, then archives `site.db` + `content/` to `backups/<key>/final-<ts>.tar.gz` and frees media. The archive path is printed in the admin and in the audit row. |
| O-32 | D-85 | Demo tenancy: own file or shared template file — `r1-data-model.md` §5 Q2, `r2-red-team.md` §1 B3 | Platform | **ACCEPTED** | Own `site.db` per demo, same as production. Basis: 4.05 ms/tenant migration fan-out and 185 KB per pooled handle; a shared file makes the table builder a fleet-wide weapon, which D2 exists to prevent. |
| O-33 | D-86 | `fleet_admin` exists in the schema and has no story in a sold install — `r1-data-model.md` §5 Q6, `r2-red-team.md` §1 B15 | Data Model | **ACCEPTED** | Role stays; every bundle sets `SKW_FLEET_MODE=0`; with 0 the app refuses to create or authenticate a `fleet_admin` (`403 SKW_E_SEC_ROLE_DISABLED`) and the seeded user is `owner`. |
| O-34 | D-87 | `cms_download_event` retention versus the E1 reconciliation — `r1-data-model.md` §5 Q4, `r2-red-team.md` §1 B5 | Data Model | **ACCEPTED** | v1 never deletes events and the admin UI offers no delete. If a tenant's disk policy requires pruning, `uses` is snapshotted into `cms_download_code_archive` in the same transaction as the delete, and E1 reads the archive for pruned ranges. |
| O-35 | D-91 | The plugin ledger is named `p_plugin_migration`, which collides with the plugin-table pattern — `r2-plugin.md` §5, §12 Q7 | Data Model | **ACCEPTED** | Core tables `cms_plugin_migration`, `cms_plugin_installed`, `cms_plugin_revoked`; the `p_` prefix is exclusively plugin-owned; the plugin id `plugin` is not reserved because it no longer needs to be. |
| O-36 | D-92 | A plugin table with an `asset_key` column has no delete guard — `r2-plugin.md` §4 C, §11 P1 §8 | Data Model | **ACCEPTED** | The migration emitter creates `trg_asset_guard_p_<id>_<table>` for every `asset_key` column, in the same transaction as the table, and registers it in `cms_trigger_registry` with `purpose='asset_delete_guard'`. Measured: without it a delete leaves a dangling key; with it, `DM_E_ASSET_IN_USE`. |
| O-37 | D-93 | A plugin can ship untested and be discovered by a client's contact form — `r2-plugin.md` §4 D | Plugin | **ACCEPTED** | `plugin.json.tests = {entry, timeout_s}`; the packager runs it inside the runner image against a scratch `site.db` and writes `test-report.json` with `runner_image_digest`; install refuses a missing report or a digest mismatch (`SKW_E_PL_TESTS_STALE`); `make test` gains `test-plugins` over `plugins.lock`. |
| O-38 | D-94 | Host-rendered blocks mean a plugin cannot produce arbitrary markup — `r2-plugin.md` thesis 1, §6 | Plugin | **ACCEPTED as a limitation** | A bespoke widget is refused for third-party packages; the escape hatch is an in-tree admin component, which is an image release. The limitation is stated in the install screen and in §6 of the SDS, not discovered at integration time. |
| O-39 | D-95 | A public upload intake does not exist, so a CV-upload form cannot be built — `r2-plugin.md` §4 C, §12 Q2 | Security + Platform | **DEFERRED** | See §3.2. |
| O-40 | D-96 | Uninstall archives the whole tenant file, not the plugin's tables — `r2-plugin.md` §3 Q8, §12 Q3 | Data Model | **DEFERRED** | See §3.3. |
| O-41 | D-97 | A sold CMS bundle shipping third-party plugins changes what the buyer supports and what we indemnify — `r2-plugin.md` §12 Q5 | CEO | **ACCEPTED** | Bundles ship plugins; the buyer's admin can disable or uninstall them; the install screen shows the publisher key fingerprint and every declared capability; revocation is local. Indemnity language is outside the SDS (see §6). |
| O-42 | D-98 | Whether a static/Astro bundle ever carries plugin rows — `r2-plugin.md` §9, §12 Q10 | Runtime | **ACCEPTED** | Only through an operator-created `query` Data Source over a `public_read: true` table; the operator's binding is the only door, and the snapshot rules of C-22 apply unchanged. |
| O-43 | D-99 | Cron / scheduled plugin work — `r2-plugin.md` §2 (absent table), §12 Q9 | Runtime | **DEFERRED** | See §3.4. |
| O-44 | D-100 | A plugin's `secret: true` setting must never leave the install — `r2-plugin.md` §4 E | Plugin | **ACCEPTED** | `secret` values are write-only: `settings.get` returns `null`, `settings.has` returns a boolean, the admin form shows `••••••`, an empty submit keeps the old value, and the exporter excludes the row from every bundle (class `secret`). |

### 3.1 O-27 (D-80) — Upgrade channel: deferred, with an experiment

**Decision.** v1 ships a documented upgrade path, not an update service: `/healthz` reports `SKW_BUILD_ID`;
`BUNDLE.json` carries `image.app_digest` and `image.runner_digest`; `install.sh --upgrade` pulls the new digest,
runs `migrate`, and restarts — the idempotent second run is already measured at 7.5 s (`r2-platform.md` §5 M3).
A CVE *notification* channel, a version endpoint for clients, and automatic rollback are deferred.
**Deciding experiment.** Take a bundle at digest A with `user_version=2`, point it at digest B carrying a v3
migration, and run `install.sh --upgrade` against a populated prefix: assert exit 0, `user_version=3`, the site
serves, and a second run is a no-op. **Owner:** Platform. **Deadline-slice:** S5 (before the first client box
is handed over). **Why not now:** the experiment needs a second image digest, which does not exist until S4's
release gate.

### 3.2 O-39 (D-95) — Public upload intake: deferred, with an experiment

**Decision.** v1 refuses plugin uploads (`accepts_upload` is not in the manifest, `file` is not a field kind).
The core gains a public intake in S5: cap → magic-byte sniff → re-encode → quarantine → `cms_asset` row with
`access_class='linked-private'` → the key is handed to the plugin in the form payload.
**Deciding experiment.** A 10 MiB JPEG and a 10 MiB PDF-with-appended-PHP through the intake under
`--cpus=1`, measuring p95 latency, peak RSS, and that the stored bytes contain neither the PHP tail nor EXIF
GPS. Sniff-only storage is already measured to fail (`r1-security.md` §6.6: 157 B polyglot survives;
re-encode gives 68 B and no payload). **Owner:** Security (sniff/re-encode) + Platform (quota, temp dir).
**Deadline-slice:** S5. **Why not now:** it is a new public write surface; shipping it in S3 would put it in
the same slice as the gated-download flow, and a bug in either is a paid-asset incident.

### 3.3 O-40 (D-96) — Table-scoped uninstall archive: deferred, with an experiment

**Decision.** v1 accepts whole-file `VACUUM INTO` for uninstall (documented in the plugin paper as "the
operation the export already uses"), and states the consequence: restoring that archive rolls back every other
change made since. A table-scoped archive format is deferred.
**Deciding experiment.** Design a per-table dump (`{table, ddl, rows, checksum}` JSONL) for a plugin with three
tables and 50,000 rows; restore it into a DB where another table has changed since; assert the restore touches
only the three tables and that a partial restore is detectable. **Owner:** Data Model. **Deadline-slice:** S5.
**Why not now:** no client has uninstalled a plugin, and the whole-file path is correct, only coarse.

### 3.4 O-43 (D-99) — Scheduled plugin work: deferred, with an experiment

**Decision.** `"cron": "none"` is the only legal value in v1. A plugin cannot wake itself.
**Deciding experiment.** A host job table with a lease: two processes race one due job, assert exactly one
runs; kill the lease holder mid-job, assert the job is retried after the lease expires and not before; a job
that misses three windows is marked failed once, not three times. **Owner:** Runtime. **Deadline-slice:** S5.
**Why not now:** a job table needs an overlap rule and a catch-up policy, and getting them wrong is a
duplicate-email incident, not a missing feature.

---

## 4. Frozen contracts (exact strings the Builders will implement)

These are the only strings that matter. Where a paper used a different name, the name here wins and the
paper's is dead; §5 lists every such replacement.

### 4.1 Tenancy: header name, edge proof, empty-vs-missing semantics, one status code per failure

**Headers, exactly three, and no others carry tenancy.**

```
X-Skunkworks-Tenant: <key>        # "" on every host-routed location; <key> on every path-prefix location
X-Skunkworks-Edge:   <token>      # SKW_EDGE_TOKEN, rendered into the snippet by install.sh
X-Forwarded-Prefix:  /demo/<key>  # path-prefix locations only; the only source of tenant.prefix
```

The header name is a constant. There is no `SKW_TENANT_HEADER` setting; a deployment cannot rename it.

**nginx snippet** (`snippets/skunk-proxy.conf`, included inside **every** `location` that contains
`proxy_pass` — a CI check asserts `count(location-with-proxy_pass) == count(skunk-proxy include)`):

```nginx
proxy_http_version 1.1;
proxy_set_header Host               $host;
proxy_set_header X-Real-IP          $remote_addr;
proxy_set_header X-Forwarded-For    $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto  $scheme;
proxy_set_header X-Forwarded-Host   $host;
proxy_set_header X-Skunkworks-Edge  "<SKW_EDGE_TOKEN rendered at install>";
proxy_set_header X-Skunkworks-Tenant "";          # fail closed: a client claim never survives
proxy_ignore_headers X-Accel-Redirect;            # on any location proxying to a non-app upstream
proxy_connect_timeout 2s;
proxy_send_timeout    20s;
proxy_read_timeout    20s;
proxy_next_upstream   off;
```

Path-prefix location overrides exactly two lines after the include:
`proxy_set_header X-Skunkworks-Tenant $demo_key;` and `proxy_set_header X-Forwarded-Prefix "/demo/$demo_key";`.
The `default_server` answers 404 from `location / { return 404; }` — **not** from server scope, which was
measured to swallow the health location and make the edge `(unhealthy)` (`r2-platform.md` §5 M9).

**Resolution algorithm, in order.** `peer` = `req.socket.remoteAddress`; `hdr` = `X-Skunkworks-Tenant`;
`edge` = `X-Skunkworks-Edge`.

| Step | Condition | Result |
|---|---|---|
| 1 | `peer ∉ SKW_EDGE_TRUSTED_CIDRS` **and** any `X-Skunkworks-*` header present | `421 SKW_E_PLT_EDGE_PROOF` |
| 2 | `hdr` non-empty **and** `edge ≠ SKW_EDGE_TOKEN` | `421 SKW_E_PLT_EDGE_PROOF` |
| 3 | `hdr` non-empty **and** (`hdr` fails `^[a-z0-9][a-z0-9-]{0,62}$` **or** contains `,`) | `400 SKW_E_PLT_TENANT_HEADER` |
| 4 | `hdr` non-empty **and** `X-Forwarded-Prefix` present **and** prefix key ≠ `hdr` | `400 SKW_E_PLT_TENANT_HEADER` |
| 5 | `hdr` non-empty **and** valid | tenant = `hdr`; `via='header'` |
| 6 | `hdr` absent or `""` **and** listener is public | tenant = `domain.host` = normalise(`Host`); `via='host'` |
| 7 | `hdr` absent or `""` **and** listener is admin | tenant = `session.tenant_id`; `via='session'` |
| 8 | `hdr` present at all **and** listener is admin | `421 SKW_E_PLT_EDGE_PROOF` (the admin never takes a tenant from a header) |
| 9 | tenant resolved but `tenant.status ∈ {'suspended','archived'}` | `404 SKW_E_PLT_TENANT_UNKNOWN` |
| 10 | tenant resolved but `site.db` cannot be opened / `user_version` stale / `SQLITE_BUSY` past timeout | `503 SKW_E_PLT_TENANT_UNAVAILABLE` or `503 SKW_E_DM_SCHEMA_STALE` |

`normalise(Host)` = lowercase → strip `:port` → strip trailing dot → `domainToASCII` → reject anything not
`[a-z0-9.-]`. No default tenant at any step. `Host` is never parsed twice: the resolver is the only reader.

**One status code per failure, and no code is reused.**

| Code | HTTP | Raised when |
|---|---|---|
| `SKW_E_PLT_EDGE_PROOF` | 421 | steps 1, 2, 8 |
| `SKW_E_PLT_TENANT_HEADER` | 400 | steps 3, 4 |
| `SKW_E_PLT_TENANT_UNKNOWN` | 404 | step 6/7 miss, step 9 |
| `SKW_E_PLT_TENANT_UNAVAILABLE` | 503 | tenant resolved, database unusable for a reason other than schema |
| `SKW_E_DM_SCHEMA_STALE` | 503 + `Retry-After: 5` | `user_version < tenant.db_version` |
| `SKW_E_DM_BUSY` | 503 + `Retry-After: 1` | `SQLITE_BUSY` after `busy_timeout` |
| `SKW_E_DM_QUOTA` | 507 | per-tenant byte quota exceeded |

### 4.2 Environment prefix, error-code taxonomy, table-prefix classes, export manifest

**Environment: one prefix, `SKW_`. Twenty-two names, and this table is the complete list.**

| Var | Default | Required | Meaning |
|---|---|---|---|
| `SKW_DATA_DIR` | `/srv/data` | yes | root; `control.db`, `tenants/`, `backups/`, `plugins/`, `trust/`, `logs/` derive from it |
| `SKW_DB_POOL_MAX` | `64` | no | LRU size of `render-read` handles |
| `SKW_DB_BUSY_TIMEOUT_MS` | `5000` | no | per-connection `busy_timeout`; 0 loses 150/200 writes (R1 M7) |
| `SKW_EDGE_TOKEN` | — | **yes** | the value in `X-Skunkworks-Edge`; boot fails without it |
| `SKW_EDGE_TRUSTED_CIDRS` | `127.0.0.1/32,172.16.0.0/12` | no | peer allowlist for the edge proof |
| `SKW_SESSION_KEY` | — | **yes** | session-id signing and the preview token |
| `SKW_DOWNLOAD_TOKEN_KEY` | — | **yes** | download token HMAC |
| `SKW_IP_HASH_KEY` | — | **yes** | `ip_hash` HMAC (plain SHA-256 over IPv4 is 54.9 min/core, R1 §6.9) |
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

Deleted names, with their replacements, so a reader of an old paper can find the survivor:
`SKW_DATA_DIR`←`SKUNKWORKS_CONTROL_DB`/`SKUNK_CONTROL_DB`; `SKW_DATA_DIR`←`SKUNKWORKS_TENANTS_DIR`/`SKUNK_TENANTS_DIR`;
`SKW_EDGE_TOKEN`←`SKUNK_EDGE_TOKEN`/`SKUNKWORKS_PROXY_TOKEN`; `SKW_EDGE_TRUSTED_CIDRS`←`SKUNKWORKS_TRUSTED_PROXY_CIDRS`/`SK_TRUST_PROXY`;
`SKW_DOWNLOAD_TOKEN_KEY`←`DOWNLOAD_HMAC_KEY`; `SKW_ARGON2_MAX_CONCURRENT`←`SK_ARGON2_MAX_CONCURRENT`;
`SKW_DDL_MAX_STATEMENTS`←`SK_DDL_MAX_STATEMENTS`; `SKW_IP_HASH_KEY`←`SK_IP_HASH_KEY`; `SKW_SESSION_KEY`←`SK_SESSION_KEY`/`SESSION_KEY`;
`SKW_ADMIN_ORIGIN`←`SK_ADMIN_ORIGIN`; `SKW_FLEET_MODE`←`SKUNK_MODE`/`SKUNK_TENANT_KEY`; `SKW_DB_BUSY_TIMEOUT_MS`←`SKUNK_DB_BUSY_TIMEOUT_MS`/`SKW_DB_BUSY_TIMEOUT_MS`.
Deleted with no replacement: `SK_CODE_PEPPER` (C-6), `SK_RATE_KEY` (the rate-limit bucket key is `code_selector`),
`SK_WEBHOOK_SECRET_<TENANT>` (per-tenant secrets live in `cms_settings` as `secret` rows), `SK_TENANT_HEADER`,
`SKUNKWORKS_PUBLIC_PORT`/`ADMIN_PORT` (the app listens on one port; the admin surface is a host, C-25).

**Error-code taxonomy.** `^SKW_E_(RT|DM|SEC|PLT|EXP|PL)_[A-Z0-9_]+$`. The area is the domain that owns the
decision, not the layer that reported it. A body is always JSON `{error: {code, message?, requestId, detail?}}`
and never contains a stack, a path, a SQL fragment or a key.

| Area | Codes (complete for v1) |
|---|---|
| `RT` | `SOURCE_UNKNOWN`, `SOURCE_UNINDEXED`, `SOURCE_BUDGET`, `SOURCE_TIMEOUT`, `LOOP_CONGESTED`, `TEMPLATE_UNKNOWN`, `BODY_FORBIDDEN`, `ROUNDTRIP_UNSTABLE`, `ASSET_MISSING` |
| `DM` | `TENANT_UNKNOWN` (unused; see `PLT`), `SCHEMA_STALE`, `DDL_REJECTED`, `DDL_POSTCONDITION`, `FK_VIOLATION`, `KEY_IN_USE`, `BUSY`, `QUOTA`, `COLUMN_IMMUTABLE`, `ASSET_IN_USE`, `ASSET_UNSTAMPABLE` |
| `SEC` | `CSRF`, `CODE_INVALID`, `RATE_LIMITED`, `TOKEN_INVALID`, `TOKEN_MISMATCH`, `USES_EXHAUSTED`, `WATERMARK_FAILED`, `AUDIT_SEAL`, `ROLE_DISABLED`, `UPLOAD_REJECTED` |
| `PLT` | `EDGE_PROOF`, `TENANT_HEADER`, `TENANT_UNKNOWN`, `TENANT_UNAVAILABLE`, `CERT_PENDING`, `DB_BUSY`, `DISK_FULL` |
| `EXP` | `GATED_ASSETS`, `MEDIA_GRAPH_OPEN`, `PARAMETERISED`, `NOT_QUIESCENT`, `INSUFFICIENT_DISK`, `TENANT_NOT_FOUND` |
| `PL` | `SCHEMA`, `NO_TABLE`, `NO_EXPORT_CLASS`, `NO_SETTING`, `SETTING_INVALID`, `ROW`, `QUERY`, `TOO_MANY`, `TOO_LARGE`, `CONTENT_TYPE`, `REJECTED`, `RATE`, `QUOTA`, `PLUGIN_ERROR`, `UNAVAILABLE`, `DOWNGRADE`, `DESTRUCTIVE_UPGRADE`, `ARCHIVE_FAILED`, `TESTS_STALE`, `SIGNATURE`, `REVOKED`, `BROKEN`, `EXPORT_REFUSE`, `EXPORT_FORWARD_NO_TARGET`, `EXPORT_SNAPSHOT` |

**Table-prefix classes. Four namespaces, no fifth, checked as a postcondition inside every DDL transaction.**

| Class | Pattern | Owner | DDL authority | Export class source |
|---|---|---|---|---|
| core | `cms_[a-z0-9_]+` | the image (Drizzle migrations) | image only; the runner refuses, and the builder's regex `^u_[a-z0-9_]+$` cannot even express it | `schema/export-projection.json` |
| user | `u_[a-z0-9_]+` | the tenant's admin | the DDL runner (typed AST, ≤8 statements, one `BEGIN IMMEDIATE`) | `schema/export-projection.json` (by prefix rule: `u_*` = `rows`) |
| plugin | `p_<id>_[a-z0-9_]+`, `id` matching `^[a-z][a-z0-9]{1,19}$` | the plugin's declarations, applied by the host | the migration executor only; the grammar excludes `drop_table`, `rename`, `drop_column` | the installed manifest's `tables[].export` |
| plugin-system | `cms_plugin_[a-z0-9_]+` | the image | image only | `schema/export-projection.json` |

The postcondition (run before `COMMIT`, connection discarded on failure):
`SELECT count(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'cms\_%' ESCAPE '\' AND name NOT
LIKE 'u\_%' ESCAPE '\' AND name NOT LIKE 'p\_%' ESCAPE '\' AND name NOT LIKE 'sqlite\_%' ESCAPE '\'` must be 0.
A `p_` prefix CHECK written as `GLOB 'p_*'` accepts the empty id `'p_'`; the emitter uses `GLOB 'p_?*'`
(measured, `r2-plugin.md` §11 P1 §5 — the same off-by-one that made `/` uninsertable).

**Export manifest: `BUNDLE.json`, schema `skunkworks/site-bundle/v3`. Required fields, all of them:**

```json
{
  "schema": "skunkworks/site-bundle/v3",
  "created_at": "2026-10-20T12:00:00.000Z",
  "export_now": "2026-10-20T12:00:00.000Z",
  "tenant": {"key": "acme", "mode": "production", "db_version": 3},
  "hosts": ["acme.com", "www.acme.com"],
  "image": {"app_digest": "sha256:…", "runner_digest": "sha256:…"},
  "projection_version": 2,
  "source_counts": {"cms_page": 241, "cms_page_revision": 501, "u_product": 10, "p_contact_message": 0},
  "files": [{"path": "data/site.db", "bytes": 372736, "sha256": "…", "class": "db"}],
  "plugins": [{"id": "contact", "version": "1.4.0", "root": "3addd03d…", "signature": "valid", "export_class": "rows"}],
  "refusals": [],
  "notes": [{"code": "SNAPSHOT_FROZEN", "subject": "posts", "rows": 60}]
}
```

`class ∈ {content, media, pii, secret, db, infra}`. `source_counts` covers **every** table in the snapshot.
`refusals` is non-empty only when the exporter wrote a bundle anyway (it never does for a refusal — see §5);
`notes` is the machine-readable half of `EXPORT-NOTES.md`, which is generated from it. A bundle without
`BUNDLE.json`, or with a file whose sha256 does not match, is refused by `install.sh --verify` (exit 12).

### 4.3 Plugin RPC surface: operation names and their bounds

One unix socket, `run/plugin.sock`, JSON lines, request/response only (no server-initiated messages). The host
binds `(tenant, plugin)` to the channel; a tenant field in a payload is ignored and logged. Every op has a
stable refusal code; an unknown op is `SKW_E_PL_REJECTED` and closes the channel.

| Op | Shape | Bound | Refusal |
|---|---|---|---|
| `store.insert` | `(table, row)` | row ≤ 32 KiB, ≤ 24 columns, declared columns only, types coerced and checked | `PL_ROW`, `PL_NO_TABLE` |
| `store.update` | `(table, id, patch)` | ≤ 24 columns, exactly one row | `PL_ROW` |
| `store.delete` | `(table, id)` | exactly one row; `delete_all` is an admin action, not an op | `PL_ROW` |
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

Absent by decision, each absence a control: `sql`, `exec`, `prepare`, `db`, `attach`, `fs.*`, `net.*`,
`http.*`, `fetch`, `env`, `require`/`import` outside the package, `worker`, `spawn`, `assets.write`,
`assets.upload`, `mail.raw`, `tenant.*`, `cms.*`, `store.raw`, `store.join`, `cron`, `stream`.

### 4.4 Download accounting unit, code storage columns, token claims

**The counted unit is one redemption = one token = one `jti`.** Not a request, not an issuance.

**Columns, exactly:**

```sql
-- cms_download_code (user_version 3)
code_selector TEXT NOT NULL UNIQUE CHECK(length(code_selector) = 4),   -- 20 bits, plaintext, index seek 2.02 µs
code_hash     TEXT NOT NULL,                                            -- argon2id(m=19456,t=2,p=1) over the full 16 chars
max_uses      INTEGER CHECK(max_uses IS NULL OR max_uses BETWEEN 1 AND 100),
uses          INTEGER NOT NULL DEFAULT 0 CHECK(uses >= 0),
expires_at    TEXT,  issued_to_email TEXT,  order_ref TEXT,  revoked_at TEXT,
last_used_at  TEXT,  created_at TEXT NOT NULL,
CHECK((asset_id IS NULL) <> (bundle_id IS NULL))

-- cms_download_event (user_version 3)
code_id INTEGER, asset_id INTEGER, jti TEXT, kind TEXT NOT NULL CHECK(kind IN ('first','range','denied')),
bytes_declared INTEGER NOT NULL, bytes_sent INTEGER, ip_hash TEXT, ua_hash TEXT, outcome TEXT NOT NULL, ts TEXT NOT NULL
CREATE UNIQUE INDEX ux_ev_jti_first ON cms_download_event(jti) WHERE kind = 'first';
```

Schema delta from `r2-amendments.sql`: `code_lookup` → `code_selector` (drop the 64-hex CHECK, add length-4);
`trg_cms_download_code_hash_immutable` covers `code_selector, code_hash`; `SKW_CODE_PEPPER` is deleted. The
`uses`-vs-events reconciliation counts `kind='first'` only.

**Phase B must ship `schema/r3-amendments.sql` with exactly three statements** — `ALTER TABLE
cms_download_code RENAME COLUMN code_lookup TO code_selector`, a rebuild of `cms_download_code` to replace the
length-64 CHECK with `CHECK(length(code_selector) = 4)`, and `DROP TRIGGER`/`CREATE TRIGGER` for
`trg_cms_download_code_hash_immutable` covering both columns — plus the `r3` entries in
`schema/export-projection.json` and `make test`. Until that file exists, a `user_version=2` database and this
contract disagree, and the register is the authority.

**Token, exact wire format.**

```
v1.<base64url(payload)>.<base64url(HMAC-SHA256(SKW_DOWNLOAD_TOKEN_KEY, "v1." + payload))>
payload = {"jti":"<128-bit hex>","cid":<code id>,"aid":<asset id>,"iat":<unix s>,"exp":<unix s>,
           "iph":"<22 chars>","uah":"<22 chars>"}
```

Verification order, and each step is a contract: (1) split on `.`, exactly three parts; (2) require `v1`;
(3) base64url-decode the MAC and require **exactly 32 bytes before comparing** (a length mismatch makes
`timingSafeEqual` throw `ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH`, which would surface as 500 instead of 401);
(4) `timingSafeEqual`; (5) `exp - iat = 600` **and** `iat ≤ now + 30`; (6) `iph`/`uah` match; (7) `aid` matches
the route; (8) DB consume. **No `JSON.parse` before step 4.**

**Consume, exact order, one transaction.**

```sql
BEGIN IMMEDIATE;
INSERT INTO cms_download_event(jti, kind, code_id, asset_id, bytes_declared, ip_hash, ua_hash, outcome)
     VALUES(?, 'first', ?, ?, ?, ?, ?, 'ok') ON CONFLICT DO NOTHING;
-- if changes() = 1:
UPDATE cms_download_code SET uses = uses + 1, last_used_at = ?
 WHERE id = ? AND revoked_at IS NULL AND (max_uses IS NULL OR uses < max_uses);
COMMIT;
```

If the `UPDATE` changes 0 rows after the insert succeeded, the redemption is denied (`410 SKW_E_SEC_USES_EXHAUSTED`)
and the event row is rewritten to `outcome='denied_quota'` in a second statement of the same transaction — the
`first` row is the ledger entry, and a ledger entry with no use is a denial, not a free download.

**Cookie.** `__Host-sk-dl-<tenantKey>=<token>; Path=/; Secure; HttpOnly; SameSite=Lax`, 600 s. `__Host-`
requires `Path=/` and no `Domain` (RFC 6265bis §4.1.3); the tenant key in the **name** prevents shadowing on a
shared origin, and `Path=/` is what makes the prefix legal. The asset binding is in the token (`aid`), not in
the cookie path.

**Continuation grace.** A request with an expired token is served without consuming **iff** the token's MAC
verifies, `iph`/`uah`/`aid` match, a `cms_download_event` row exists with that `jti` and `kind='first'`, the
code is not revoked, and `now - iat ≤ download.continuation_grace_s` (default 21,600). This is what lets a
1 GiB download finish under `limit_rate 1m` (1,024 s) without spending a second use, while a leaked token
still buys one asset for at most six hours on one IP/UA pair.

---

## 5. IDEA.md delta — every decision that measurement or adjudication has changed

**D-numbers are IDEA's. "Replacement text" is what the SDS will say; the SDS is authoritative and IDEA.md is
history.** Eleven decisions and six section-level statements change. Two decisions are reaffirmed against a
paper that contradicted them.

| D | What is now wrong | Replacement text |
|---|---|---|
| **D7** | "Path-prefix routing (`/demo/<key>`) is the no-DNS fallback" is right, but §3.1's reading ("everything the app emits must be prefixed from `X-Forwarded-Prefix`") left open who *strips*. | "Path-prefix demos are served by one `location /demo/`; nginx strips the prefix with `rewrite … break` and sets `X-Forwarded-Prefix`; the app never rewrites an inbound path and prefixes every emitted URL exactly once through `site.url()`." |
| **D8** | Two prefix classes (`cms_*`, `u_*`) cannot express a plugin table. | "Protected tables are enforced by prefix: core `cms_*` (image-owned), user `u_*` (DDL runner), plugin `p_<id>_*` (host migration executor), plugin-system `cms_plugin_*` (image-owned). No fifth namespace exists and a DDL transaction asserts it." |
| **D9** | "Admin on a separate origin/port with IP allowlist" is unsupportable in a sold bundle (dynamic IPs, CGNAT, phones) and a port is not an origin boundary (cookies ignore ports, measured). | "Admin is a separate **hostname** (`admin.<domain>`) behind nginx with no published port; the IP allowlist is opt-in and empty in exported bundles; when it is empty, TOTP is mandatory and idle drops to 15 min; every non-GET carries a session-bound CSRF token and an exact `Origin` check." |
| **D14** | "App validates, then hands off with `X-Accel-Redirect`" omitted that the app never sees a byte and that a missing target discards the app's 200. | "Gated downloads are authorise-then-offload: the app stats the target, validates the range, consumes the redemption atomically, then returns `200` with an empty body and `X-Accel-Redirect: /__protected/<sha256>.<ext>`; a missing target is `503 SKW_E_RT_ASSET_MISSING`, never a silent nginx 404." |
| **D15** | "Access codes are stored argon2id-hashed" cannot be looked up by equality (salted), and a pepper adds a fleet-wide secret whose residency is undecided. | "An access code is 16 Crockford-base32 characters (`<selector:4><secret:12>`); the selector is stored plaintext and unique, the full code is stored as argon2id(m=19456,t=2,p=1); there is no pepper." |
| **D17** | "Renaming a key cascades to references" is false under the FK action this design needs, and CASCADE costs 439 ms / 2,412 ms of write lock at 200k references. | "Asset identity is the key and the checksum is only the physical address. A referenced key cannot be renamed (`409`); an unreferenced rename writes a `cms_asset_alias` row and 301s; a bounded `repoint` operation rewrites at most 5,000 references in one audited transaction." |
| **D19** | "Enforcement stays atomic in a single UPDATE" is true but the *unit* was a request, and one download spends four. | "`max_uses` counts redemptions. `uses` increments once per token `jti`, by an insert-first, update-second pair inside one `BEGIN IMMEDIATE`; Range continuations under the same `jti` never consume; `NULL` means unlimited behind an explicit flag." |
| **D21** | "An empty-diff round-trip as a gate" is unachievable — GrapesJS normalises on load, 8 of 9 fixtures differ at pass 1 — and "fully drag-and-droppable" cannot be true for markup the registry does not know. | "Every site we build is authored for the editor: page bodies use the editor's own component vocabulary, the round-trip gate is a **fixpoint** (`canon(load(save(load))) == canon(load))`, and drag-and-drop is guaranteed **within the shipped component registry**; a new interaction is a component release, not a content edit. Repetition is the `list` component." |
| **D22** | "Three export targets, one content model" holds, but "the same DB state produces identical bytes" did not, and a `free` parameter could be frozen silently. | "Export target is a render mode. A snapshot is enumerated (declared parameter domains, cap 1024 combinations), pinned to `SKW_EXPORT_NOW`, and **refused** when a `free` parameter appears in a link on any exported page; two exports of one DB at one `SKW_EXPORT_NOW` are byte-identical." |
| **D26** | Holds, and is the reason C-8 exists. | "Third-party plugins are untrusted by default and run in a separate `plugin-runner` container with no network, no native addons, no filesystem write and no database handle, reached over a 14-operation RPC enum." |
| **D27** | Contradicted by `r2-plugin.md` §3 Q12 (a root key signing publisher keys). D27 wins. | "No publisher CA in v1. Our key verifies first-party packages; a third-party publisher's key is imported by the tenant owner, fingerprint shown beside every capability; revocation is local to the install." |
| **§3** | "Services in `docker-compose.yml`: `nginx`, `app`, `acme`. Nothing else." | "`docker-compose.yml` has four services: `nginx`, `app`, `plugin-runner`, `acme`." |
| **§6** | Lists `cms_page_blocks` (deleted, and nothing replaced its loop) and omits seven tables the DDL now has. | "Drizzle owns `cms_page` (one document per page, no block table), `cms_page_revision`, `cms_asset`, `cms_asset_variant`, `cms_asset_alias`, `cms_asset_link`, `cms_asset_bundle`, `cms_asset_bundle_item`, `cms_download_code`, `cms_download_event`, `cms_watermark_render`, `cms_form`, `cms_form_submission`, `cms_datasource`, `cms_view_registry`, `cms_table_registry`, `cms_trigger_registry`, `cms_audit`, `cms_redirect`, `cms_settings`, and `cms_plugin_migration` / `cms_plugin_installed` / `cms_plugin_revoked`." |
| **§5** | "Export has nothing to filter" is true across tenants and false inside one: a demo carries prospects' submissions, buyers' codes and per-purchaser watermarked files. | "Export has nothing to filter **across tenants**; inside a tenant it applies `schema/export-projection.json` (five tables `empty`, `cms_settings` filtered) plus each plugin manifest's export class; `content/protected/wm/`, `content/sources/`, `data/control.db` and any `-wal`/`-shm` are never in a bundle, and `--include-pii` is off by default." |
| **§5.1** | "Target install time ≤ 5 min (measured)" is not what was measured. | "≤ 5 minutes, measured, from a Docker host (≥ 2 vCPU / 2 GB / Compose ≥ 2.20) whose images are pullable or supplied with `--offline`, an A record already pointing at the box, and TCP/80 reachable. Our part: 18.2 s warm, 29.8 s cold-pull, 7.5 s re-run, +16.0 s for TLS once DNS and port 80 are correct. Bundle transfer is excluded and capped." |
| **§7.4.3** | `__Host-dl-<key>; Path=/d/<key>` is an invalid cookie — `__Host-` requires `Path=/`. | "`Set-Cookie: __Host-sk-dl-<tenantKey>=<token>; Path=/; Secure; HttpOnly; SameSite=Lax`, 600 s, bound in the token to `(cid, aid, jti, iph, uah)`." |
| **§9** | "Tenancy: one DB per tenant; no cross-tenant query path exists by construction" is a claim the corpus falsified four times: a readonly handle can `ATTACH` a sibling and `VACUUM INTO` the public tree. | "Tenant isolation is a **permission** boundary inside one Node process, not a construction. Structural: one SQLite file per tenant and no request value ever becomes a path segment. Permissions, each tested: no statement that names a file; no write outside the tenant directory (`query_only=1`); no code we did not ship in the process; no caller-controlled path segment. The three paths that can break it are the DDL runner, any `ATTACH`-capable handle, and any `import()` from a tenant-writable tree." |

**Reaffirmed, not changed, against a paper that contradicted them:** D2 (one file per tenant — `r2-red-team.md`
§6.1 says do not reopen it, and nothing in the corpus does), and D23 (cp1252-preserving sanitiser — `r2-red-team.md`
§6.9; the omission was applying it to filenames, which O-07 fixes).

**Largest blast radius of the delta: D21 + §6 (one document, registry-bounded, `list` component).** It changes
the stored shape of every page, the block registry, the SSR renderer, and all three exporters — the widest
surface in the build, and the one Red Team called "the single most expensive late decision in the set"
(`r2-red-team.md` §5 item 5). Second largest: D15/D19 (the paid feature's schema and accounting), which is
contained to S3 but touches the one table that holds live codes.

---

## 6. CEO decisions required

Four decisions are genuinely the CEO's — product scope, a public promise, a commercial refusal rule, and a
UX cost that lands on buyers. Each has exactly two options and one recommendation. **None of them blocks Phase
B:** the register adopts the recommendation as the SDS default, and each is reversible up to the slice named.

### CEO-1 — The plugin runner is a fourth service (reverses IDEA §3's "nothing else")

- **Option A.** Add `plugin-runner` to `docker-compose.yml` (`network_mode: none`, one cgroup, socket-only).
  Third-party plugins work as specified; the deployment grows one container and ~48 MB.
- **Option B.** Keep three services and ship plugins as **hosted-tier only** — no third-party plugin in a sold
  bundle, no runner in the artifact. The bundle loses the plugin feature entirely.
- **Recommendation: A.** Option B contradicts the constraint the CEO set on 2026-10-20 ("a plugin may be
  authored by a third party and installed into a running CMS") and makes D26 marketing. The cost is one
  container in a file we already generate, and the containment argument (§C-8) is the only one in the corpus
  that survives measurement.

### CEO-2 — Restate "fully drag-and-droppable on day one"

- **Option A.** Restate the promise as "fully draggable **within the shipped component registry**", and accept
  that a bespoke interaction is an image release (1.1–1.4 days per behaviour, measured estimate).
- **Option B.** Fund a bespoke editor so arbitrary hand-authored markup becomes draggable. That is the
  6-month product D6 rejected, and no measurement in the corpus suggests a shorter path.
- **Recommendation: A.** Option B re-litigates D6 without new evidence. Option A is honest and the cost is
  visible in the price of the next component, not in a failed demo.

### CEO-3 — The static SKU refuses a site with a search box

- **Option A.** Refuse at export (`SKW_E_EXP_PARAMETERISED`, exit 22) when a `free` parameter appears in a link
  on any exported page. The client is told before they pay, and the remedy is a design change or the Astro SKU.
- **Option B.** Freeze at the declared default and write it in `EXPORT-NOTES.md` (IDEA §5.1 pre-flight 3 as
  written). The cheapest SKU then ships with a 404 where the CMS has content, permanently.
- **Recommendation: A.** B is the "reproducible bytes, unreproducible site" failure Platform A5 measured, and it
  is discovered by the client's customer rather than by us. A refusal is a sales conversation; B is a refund.

### CEO-4 — Access codes become 16 characters

- **Option A.** 16 Crockford characters (`<selector:4><secret:12>`), no pepper, no rotation runbook, offline
  resistance 4.46×10⁸ core-years.
- **Option B.** Keep 12 characters (60 bits, better on a phone keyboard) and keep `SKW_CODE_PEPPER` as the
  lookup key, with a written rule that the pepper never travels in a bundle or a backup, and a rotation
  runbook that invalidates every outstanding code.
- **Recommendation: A.** B's safety rests on a secret-handling rule that no paper owns (DM's own overturn
  condition says so) and on a rotation nobody can perform without killing live codes. Four extra characters
  is the cheaper promise.

**Not put to the CEO, and why.** The publisher-CA question (C-9) is already decided by D27 and needs no new
input; the audit-seal design (C-21) and the connection classes (C-15) are engineering; the indemnity language
for third-party plugins (O-41) is legal work outside the SDS and does not change a contract.

---

## 7. Completeness check

### 7.1 Arithmetic

| Quantity | Count | Where |
|---|---|---|
| Papers read | 11 | §1.1 |
| Attack statements counted | 250 | §1.2 |
| Distinct defects | 100 | `D-01`…`D-100`, §1.2 family table |
| Defects decided in the conflict register | 56 | C-1…C-25 (C-1:3, C-2:3, C-3:3, C-4:3, C-5:1, C-6:4, C-7:5, C-8:1, C-9:1, C-10:1, C-11:2, C-12:3, C-13:2, C-14:1, C-15:5, C-16:3, C-17:4, C-18:3, C-19:1, C-20:1, C-21:1, C-22:2, C-23:1, C-24:1, C-25:1 = 56) |
| Defects decided in the objection ledger | 44 | O-1…O-44, one `D` each |
| **Total decided** | **100** | 56 + 44 |
| Verdict split | 25 conflicts + 44 ledger = 69 deciding entries; 4 ledger entries DEFERRED (O-27, O-39, O-40, O-43), each with an experiment, an owner and a slice | §3.1–§3.4 |
| Rejected positions inside conflicts | 14 | DS-4's 400-on-empty (C-1), Runtime §3.5 (C-2), CASCADE (C-3), islands-as-loops (C-4), static-file projection (C-5), delete-argon2 and 64 MiB (C-6), Platform's Range rule and update-first order (C-7), PD3's hard gate (C-10), the nonce (C-12), Security's `TableSpec` (C-13), S-6 as construction (C-17), freeze-at-defaults (C-22) |

A mechanical check was run over this file: every `D-nn` from `D-01` to `D-100` appears at least once, and no
`D-nn` appears in two deciding entries. The 25 conflict headings and 44 ledger rows are the only places a
verdict is stated.

### 7.2 What I consciously did not adjudicate, and why

| Not adjudicated | Why |
|---|---|
| **Browser-only behaviours**: `__Host-` rejection, the CSRF-token theft path, the island props breakout in a real UA | No browser exists on this box (Security §5 Q8, Platform §6, Plugin §11 all say so). I decided the server-side half of each (a testable contract) and recorded the browser half as unverified. The compensating test is specified for every one; a CI Chromium is a Builders' prerequisite, not a decision. |
| **ACME issuance against a production CA, DNS propagation, inbound port 80** | Unmeasured by every paper (Platform M6 used Pebble with validation short-circuited). I adopted Platform's bracketed promise (§5, D-note) and required `install.sh` to exit 11 on a wrong A record. Resolving it needs a real domain and a real CA, which is an operational action, not a design choice. |
| **Bundle transfer time** | Arithmetic only (1 GB at 20 Mbps ≈ 6.8 min). The promise excludes transfer and caps bundle size; a measured link test would only confirm the arithmetic. |
| **Per-tenant process isolation** | Decided *against* on measurement: 49.8 MB RSS and 34 ms cold start per tenant → ~10.0 GB at 200 tenants (Security M5). C-15 records the permission model and the three paths that break it, which is the honest version. Reversible only by a per-tenant worker under ~8 MB RSS, which nobody measured. |
| **PII retention outside the export** (how long we keep a demo's submissions after it expires) | A legal/product policy, not an SDS contract. O-31 sets the 30-day soft delete and the final archive; the retention schedule for the archive is the CEO's legal advisor's. |
| **Indemnity and support for third-party plugins** (O-41) | Commercial/legal. The technical contract (signature, capabilities, disable, uninstall, revocation) is frozen; what we promise a buyer is not an engineering decision. |
| **`cms_form` vs plugin form coexistence** (`r2-plugin.md` §4 A) | Not a conflict: the plugin paper decides "coexist", no paper contradicts it, and the static SKU depends on core forms for its only form story. Recorded here so it is not mistaken for an omission. |
| **Which of our own sites is a `demo` vs `internal`** | Deployment configuration, not design. |
| **The exact wording of the 5-minute marketing claim** | §5's replacement for §5.1 fixes the measured bracket; the sentence on the website is not the SDS's. |

### 7.3 What the Builders must not re-open

Each of these has at least two independent measurements or an explicit concession from the losing author:
one file per tenant (D2); `VACUUM INTO`, never `cp` (four measurements); a keyed/selector lookup is required
for codes (the row cannot be found by hash); a client-supplied tenant header is inert (four papers); `internal`
+ `X-Accel-Redirect` is the only gated-byte path; `__Host-` requires `Path=/`; `readonly` is a write barrier and
not a tenancy boundary; the stored page body is the editor's document, not a block tree; cp1252-preserving
sanitisation; watermark failure is a denial; in-process `function` data sources are not shippable.

A Builder who believes one of these is wrong must produce the measurement named in its entry, not an argument.

---

*End of Phase A register. Phase B (`docs/sds/SDS.md`) implements these sentences and may add diagrams, tables
and derived contracts; it may not alter a verdict, a status code, an env name, an RPC operation or a sentence
quoted in §2 or §4 without a new measurement satisfying the stated overturn condition.*
