# R2 — Data Model

**Author:** Data Model Specialist · **Round 2 of 3** · 2026-10-20
**Read:** all five R1 papers, `.agents/DATA_MODEL.md`, `.agents/ARCHITECT.md`.
**Position:** round 1's schema shipped a homepage that cannot be inserted, and an integrity guarantee
that is a per-connection pragma rather than a schema property. Both are fixed in
`schema/r2-amendments.sql`, which applies to a populated `user_version=1` file and is exercised by
`scripts/model/verify_claims.py` (checks 9–19; **19/19 pass**, output in §5).

**Artefacts this round** (all runnable, all run):

| Path | Contents |
|---|---|
| `schema/r2-amendments.sql` | v1 → v2: path CHECK fix (page + redirect), `cms_page` rebuild, `cms_asset` rebuild with a generated `storage_path`, event `jti`/`kind`, datasource cost stamp, `cms_trigger_registry` + three guards |
| `schema/export-projection.json` | every table classified `rows`/`empty` with a reason; a table missing from it is a build failure |
| `scripts/model/verify_claims.py` | R1's 8 checks unchanged + 11 new ones (checks 9–19) |

---

## 1. Attacks on my domain — verdicts

Verdicts are about the **design consequence**, not the fact. Where R1 already measured the fact, the
row says so and the reason is about what I am changing because of it.

| # | Attack | Source | Verdict | Reason | Fix shape |
|---|---|---|---|---|---|
| 1 | `cms_download_event.bytes_sent`/`ranged` cannot be filled after `X-Accel-Redirect` | Sec A-3 | **ACCEPT** | The app hands off and never sees a byte; a NOT NULL column the app guesses into is a fabricated byte count in the table that exists to prove what was downloaded. | Split: `bytes_declared` (what the app authorised, NOT NULL) + `bytes_sent` (nullable, nginx `$body_bytes_sent`, ingested or NULL). `ranged` replaced by `kind`. Applied, A3. |
| 2 | The `cms_asset(key)` FK guarantee is a connection pragma, not a schema property | Sec A-4, RT O15 | **ACCEPT** | `foreign_keys` defaults to 0 and is per-connection; the paths where it is off are exactly export, install, repair and the CLI. My I6 said "enforced by the database" and R1 shipped a guarantee that lives in the factory. | A `BEFORE DELETE` trigger on `cms_asset` covering the three RESTRICT children, plus per-`u_*` guards, plus `cms_trigger_registry`. Derived rows (variants, renders, aliases) still CASCADE — a guard on those would make every image with a thumbnail undeletable. Measured with the pragma **off** and through the `sqlite3` CLI: blocked (check 12). |
| 3 | `code_hash` must be the only representation of the code | Sec §3.1 | **REJECT** | Equality lookup on a salted hash is impossible (R1 M15: 358 s–1.6 h per attempt at 5,000 codes). `code_lookup` is a keyed *fingerprint*, not a representation: 60-bit input, 32-byte secret, not invertible without the pepper, and excluded from every bundle by the projection. The rule as written makes the feature unbuildable. | Reword the rule to "no reversible representation and no prefix": falsifier becomes "no column contains the code or any substring of it, and `code_lookup` never appears in a bundle". (§2 C1 goes further and drops `code_hash` too.) |
| 4 | `cms_download_event.jti TEXT NOT NULL` + unique `(jti, kind)` | Sec §3.1 | **ACCEPT the design, REJECT `NOT NULL`** | A denied attempt against an unknown code is written *before* a token exists, so a NOT NULL `jti` makes the security-relevant rows unwritable. Measured (check 15): the partial index accepts many NULL-`jti` rows and still rejects the second `(jti,'first')`. | `jti TEXT` nullable + `CREATE UNIQUE INDEX … ON cms_download_event(jti) WHERE kind='first'`. Applied, A3. |
| 5 | One hash-chained `audit_log` in `control.db` for every privileged action | Sec §3.1, S-4 | **REJECT for tenant plane / ACCEPT for control plane** | Three reasons, one measured: (a) tenant writes would contend on the file that answers every request — `busy_timeout=0` lost 150 of 200 writes under four writers (R1 M7); (b) the chain is unverifiable in the file the attacker can write — tamper one row, recompute, chain still verifies (check 18); (c) an exported site must carry its own history or the client's instance starts blind. | `cms_audit` in `site.db` keeps one row per tenant action; the chain is optional and only counts if its head is anchored in `control.db` at export and at close-of-day. `control.db.audit_log` keeps the chain for fleet actions. §2 C3. |
| 6 | `cms_asset` should be `is_public` + `gated` booleans | Sec §3.1 | **REJECT** | Two booleans encode four states, one of which (`is_public=0, gated=0`) is undefined and has no CHECK that can be written against a state nobody named. `access_class ∈ {public, linked-private, gated}` is one closed enum with one CHECK, and it is already what the exporter and the symlink farm read. | Keep `access_class`. Their cross-domain invariant ("a code exists for a gated asset while `content/public/<key>` exists") is a test, not DDL — they said so themselves. |
| 7 | Publishable views must match `^v_[a-z0-9_]+$` | Sec §3.1 | **REJECT (cosmetic)** | `cms_v_*` cannot be mistaken for a table in a `sqlite_master` filter and is what the DDL postcondition already asserts; `v_users` reads like a table. | One-line change on their side; the CHECK stays `name GLOB 'cms_v_*'` and the registry is the authority. |
| 8 | `kind='function'` datasources are in-process code in a writable tree | Sec A-5, RT O10 | **ACCEPT (already done in R1)** | A `readonly` handle can `ATTACH` a sibling tenant (R1 M9b) and `VACUUM INTO` any writable path, so a function source is arbitrary code with a cross-tenant read primitive. | `cms_datasource.kind CHECK(kind IN ('view','query'))` — `function` is not representable. Shipped in R1 (`schema/site.sql:207–211`). |
| 9 | Argon2 params: `m=19456,t=2,p=1`, 8 concurrent | Sec DS-6 | **ACCEPT theirs over mine** | Two implementations agree: 24.5–29.9 ms median on this box across four runs vs 27.0 ms measured by Security; my `m=65536,t=3,p=1` is 127.4–153.6 ms median (check 17). With a deterministic lookup column the code entropy, not the KDF, is the barrier, so the memory is pure DoS amplification. | See §2 C1: drop the verifier entirely; if it survives review, it is 19456/2/1 behind a semaphore of 4, not 8. |
| 10 | `cms_pages(slug, body_html, body_css, rev, body_sha, status, updated_at)` | Run 3.6.1 | **ACCEPT** | `rev` is the only optimistic-concurrency token that survives two admins on one page; `body_sha` is the round-trip key. `etag` had no reader left once Runtime D-R8 set HTML to `no-store`, so it is deleted rather than kept as a derived column with a stale reason. | Table stays `cms_page` (singular, like every other `cms_*`); `css`→`body_css`; `rev`, `body_sha`, `managed_by` added; `etag` dropped. Applied, A1. |
| 11 | `cms_datasource` needs `cost_ms`, `cost_rows`, `cost_measured_at` | Run 3.6.2 | **ACCEPT, plus `cost_plan`** | The stamp is the publish gate's input and an operator disputing a refusal needs the `EXPLAIN` text that produced it, not a number. It is a cached measurement — exception E5, invalidated when the row count doubles. | Four columns; `params_json` added for Platform A5's static refusal. Applied, A4. |
| 12 | "For every ordered `query` source, `EXPLAIN QUERY PLAN` must show `SEARCH`, and if the DDL runner cannot create the index the source cannot be published" | Run 3.6.3 | **ACCEPT with one addition** | The runner can create `u_*` indexes; what it must *also* do is index every `ASSET` column whether or not the admin asked, because the delete guard's `EXISTS` probe and every join run through it. Measured: 7.69 ms → 0.024 ms per probe at 200,000 rows (check 19), and R1 M18 measured the same 50× on joins. | `create_table` with an `ASSET` column implies `CREATE INDEX ix_<table>_<column>`; publish refuses when `EXPLAIN` contains `SCAN`. |
| 13 | `cms_asset_alias(old_key, asset_id)` | Run 3.6.4 | **ACCEPT the requirement, REJECT the column name** | A second rename (a→b→c) needs both `a` and `b` to resolve, so the table is a key→asset map, not a rename log. `old_key` invites a row per rename and a chain nobody maintains. | `cms_asset_alias(key PK, asset_id)` — already shipped in R1; the alias is the URL-level answer, the FK is the model-level one (see 14). |
| 14 | `ON UPDATE CASCADE` from `u_*` to `cms_asset(key)`, with the rewrite audited in the same transaction | Run 3.6.5 | **REJECT** | R1 M8: 439 ms of write-lock on a settled DB, 2,412 ms inside the inserting transaction, for 200,000 references — and every writer on the tenant gets `SQLITE_BUSY` for the duration. Worse, their own condition ("must be audited") is unimplementable: an honest audit row for a 200,000-row rewrite is a 200,000-row audit row. | `ON UPDATE RESTRICT` stays. The case they actually care about — a URL inside `body_html` that no FK can see — is covered by `cms_asset_alias` + 301. The key freezes on first FK reference; a URL-level rename is an alias insert. |
| 15 | The round-trip gate must be `canon(load(save(load)))==canon(load)`, not an empty diff | Run I7, §6.8 | **ACCEPT — and my DM5 argument was wrong** | GrapesJS normalises on *load*, so 8 of 9 fixtures differ from the hand-authored input at pass 1 before any save. "Store the document verbatim ⇒ empty diff" is false; storing verbatim only makes the document a fixpoint after one round trip. The decision (one document, not a block tree) survives; the justification does not. | `body_sha` is computed over the canonical form; the gate is pass-2 stability. |
| 16 | Page bodies must contain no `<script>`, comments or `<style>` | Run I8 | **DEFER to Architect** | A `CHECK(body_html NOT GLOB '*<script*')` is cheap and catches the exact string Security A-2 exploits, but it cannot see `onclick=`, so it is a partial control that must not be mistaken for the CSP; and it changes §8.2's "hand-edited HTML always wins" promise, which is a product decision. | Ships only with the ruling. Meanwhile `managed_by ∈ {editor, hand}` (A1) stops the editor silently re-serialising a hand-edited page (RT silence #5). Deciding measurement: Security A-2's browser test with the CSP in place. |
| 17 | A worker runs a heavy source "with the same readonly handle" | Run D-R7 | **REJECT as unbuildable** | `better-sqlite3` `Database` objects cannot be used off the thread that opened them; a worker needs its own connection, which costs the 0.443 ms Runtime itself measured. | One connection per (worker, tenant), opened lazily, LRU beyond 4 workers. §2 C5. |
| 18 | `Cache-Control: no-store` on HTML, no page cache in v1 | Run D-R8 | **ACCEPT** | It removes the only consumer of `cms_page.etag`, which is why that column is deleted rather than defended as E3. | `etag` dropped; if 304 ever ships, the header is `"`+`body_sha`+`"`. |
| 19 | `cp site.db` and absolute farm links both produce bundles that verify and 404 | Plt A2 | **ACCEPT (cp was already settled in R1)** | R1 M1: main file 4,096 B, 1,000 rows in the WAL, copy answers `no such table`. The absolute-link half is fixed at the source if the link target cannot be written by a form. | Export is `VACUUM INTO` + the projection (§4 I10). The farm target is read from the **generated** `storage_path`, so a bundle can only contain `../media/<hh>/<sha>.<ext>`. |
| 20 | A static export silently freezes parameterised sources at defaults | Plt A5 | **ACCEPT as a schema change** | The exporter cannot refuse what it cannot enumerate. A source's parameters have to be declared data, or the refusal is a code comment. | `cms_datasource.params_json` (array; each param has `name` and `route_bearing`) — Platform's refusal code 22 reads it. Applied, A4. |
| 21 | `bytes_sent` must be within 1% of nginx's `$body_bytes_sent` | Plt P8 | **ACCEPT as a test on an ingest path, not as a column the app fills** | Same fact as row 1 from the other side: the app's number is the file size, nginx's is what left the box. | v1 ships `bytes_sent` NULL and the access log as the record; if billing needs the column, an ingest job fills it and the 1% test becomes meaningful. A NULL is honest; a duplicated `Content-Length` is not. |
| 22 | The `migrate` service is a hard `depends_on` gate | Plt PD3 | **REJECT** | One tenant's failed migration blocks every tenant's boot, at every restart, not just at upgrade. My DM11 already serves `503 DM_E_SCHEMA_STALE` for exactly one tenant. | §2 C4. |
| 23 | Export excludes `control.db`, so the bundle has no tenant, domain, admin or `mode` | RT O2 | **ACCEPT** | `tenants`, `domains`, `users`, `sessions` are all in `control.db`; `install.sh`'s own job ("tenant marked active") needs all four. The schema already fails closed here: `tenant.mode` has no default and `CHECK(mode<>'demo' OR demo_expires_at IS NOT NULL)`, so a seed that forgets `mode` errors instead of defaulting to `demo`. | `install.sh` applies `schema/control.sql`, then seeds exactly four rows (tenant `mode='production'`, primary domain, first admin, `control_migration`) from `bootstrap.json`; the exporter writes that file. |
| 24 | The bundle ships other people's data (submissions, codes, events, watermark copies) | RT O3 | **ACCEPT** | "Export has nothing to filter" is true across tenants and false inside one. A demo tenant is a two-week sales pipeline. | `schema/export-projection.json`: five tables `empty`, `cms_settings` filtered. Check 16 proves the projection is stable across volatile writes and sensitive to content writes. |
| 25 | `storage_path` is row data, a CRUD form exposes it, the farm reads it → arbitrary file read | RT O5 | **ACCEPT** | A per-column write policy in the CRUD generator is application code that a new form can forget. `storage_path` is a pure function of `(sha256, mime)`. | `storage_path` becomes `GENERATED ALWAYS AS (…) STORED`: INSERT and UPDATE are rejected by the engine from any driver (check 11). `sha256` is immutable by trigger (same check). Applied, A2. |
| 26 | The watermark render cache is a per-purchaser archive with no eviction | RT O12 | **ACCEPT** | `spec_sha` includes the buyer's email, so the hit rate is ≈1 and every redemption leaves a file. It is also the largest PII store in the tenant. | Projection marks it `empty`; eviction is FIFO on `created_at` to a byte ceiling in `cms_settings` (a cache with hit rate 1 does not need LRU), and the ceiling is checked at issue time so the failure is a refusal, not `SQLITE_FULL`. |
| 27 | The ALTER surface is a partial function (NOT NULL add, indexed drop) | RT O14 | **ACCEPT** | The AST already refuses what it cannot express; what it must also do is choose the *procedure*. `ADD COLUMN NOT NULL` needs a literal default; `DROP COLUMN` on an indexed column needs a rebuild. | `drop_column` compiles to a 12-step rebuild when the column is indexed or participates in a CHECK; every rebuild restores `sqlite_sequence` (A1/A2 do, and check 9 asserts it). The UI disables what the runner refuses, with the reason. |
| 28 | Encrypted PDFs are undeliverable under a fail-closed watermark rule with no warning | RT O16 | **ACCEPT (minor)** | The issue screen cannot warn about a property the database does not hold, and the failure is 100% of that tenant's downloads. | `cms_asset.encrypted INTEGER` set at upload sniff; the issue form refuses with a named reason. Applied, A2. |

---

## 2. My counter-designs for the other domains

### C1 — Against Security DS-6 **and my own DM12**: the lookup column is the whole barrier; the argon2 verifier is decoration that costs 26–146 ms and 19–64 MiB per redemption

**Claim attacked.** Security DS-6 sizes a semaphore, a queue and a memory budget to bound argon2
verification; my DM12 kept argon2id as the verifier beside an HMAC lookup. Both assume the argon2
hash is load-bearing.

**Counter-design.** It is not, and it cannot be. A row protected by
`code_lookup = HMAC-SHA256(pepper, normalise(code))` is only as strong as that column: an attacker
holding the file *and* the pepper enumerates the 2^60 code space by computing HMACs at the 2.4 µs
per compute Red Team measured — 2.8 × 10^12 seconds per core — and never needs to touch `code_hash`.
An attacker without the pepper cannot test a guess at all. So the memory-hard verifier sits behind a
fast keyed index in the same row and raises the cost of exactly nothing.

Delete it: one column (`code_lookup`), one 0.56–3.40 ms lookup per redemption (R1 M15's unique-index
seek), no 64 MiB allocation, no semaphore, no dummy-verify, no OOM class. The timing property Security
wanted from the dummy compare comes free: an unknown code costs the same seek as a known one.

**Severity: major.** It removes 26–146 ms and 19–64 MiB from every redemption, the entire
memory-amplification DoS, and the `503 E_BUSY` that a burst of real buyers would have seen.

**Evidence needed.** (a) A written attacker model confirming the pepper never ships — Platform PD10
already requires per-install secrets, and the projection marks `cms_download_code` `empty`, so no
bundle carries a fingerprint. (b) A review sign-off that a 12-character Crockford code is 60 bits and
that this is the stated strength of the product. (c) A test that 5,000 stored codes cannot be
enumerated: at the measured HMAC rate the space is 2.4 × 10^12 s/core, which is not a benchmark I
can run — it is an arithmetic consequence of the rate I did measure. If any of (a)–(c) fails, revert
to Security's 19456/2/1 with a semaphore of 4.

### C2 — Against Security DS-5: the dedupe row must be written **before** the counter, or the counter records requests and the event table records downloads

**Claim attacked.** DS-5: "`uses` is incremented on the first successful file response for that
`jti` (`UPDATE … WHERE uses < max_uses`, then `INSERT cms_download_event(jti,…) ON CONFLICT DO NOTHING`)."
The order is UPDATE-then-INSERT.

**Counter-design.** Invert it. The unique index on `(jti) WHERE kind='first'` *is* the gate; the
counter must only move when the gate was crossed. `INSERT … ON CONFLICT DO NOTHING`, then
`if changes() == 1: UPDATE … SET uses = uses + 1`. With their order, every concurrent request passes
the UPDATE and then discovers it was a duplicate.

**Severity: major.** Measured (check 14): 24 concurrent requests carrying one `jti` produce
`uses = 24` with `events = 1` under their order, and `uses = 1` with `events = 1` under mine. Their
design does not merely over-charge — it leaves the counter and the event log disagreeing, so the
reconciliation query in my E1 reports a mismatch that is an artefact of the write order, and the
detector is blinded by the bug it exists to find.

**Evidence needed.** The check is the evidence; the remaining question is whether the two writes must
be one transaction (they must: a crash between them either charges a download with no event or
records an event with no charge). Both statements in one `BEGIN IMMEDIATE`, insert first.

### C3 — Against Security S-4/§3.1: an audit hash chain in the file the attacker writes proves nothing unless its head is anchored outside that file

**Claim attacked.** `audit_log` (and by extension any audit table) carries `prev_hash` + `hash` as a
tamper-evidence mechanism, with the chain living in the same database as the rows.

**Counter-design.** Anyone who can `UPDATE` an audit row can also recompute every hash after it — the
chain is a self-consistent checksum, not evidence. Measured (check 18): tamper row 2, recompute the
chain, and the unanchored chain verifies; the anchored head mismatches on the first byte. So either
the head hash is recorded somewhere the writer cannot reach — `control.db` at export and at
close-of-day, and the export manifest — or the chain is deleted and the table is honest about being
append-only-by-policy.

**Severity: medium.** It is the difference between an audit trail that survives a dispute and one
that survives a `sed`.

**Evidence needed.** One export: record the head, tamper a row in the exported copy, recompute, and
show `install.sh` (or the client's own verification) rejects it against the manifest. If the head
lives only in the same bundle, it is theatre.

### C4 — Against Platform PD3: `migrate` as `service_completed_successfully` makes one tenant's corruption a fleet-wide boot failure

**Claim attacked.** PD3: a one-shot `migrate` service runs `--tenant all`, exits, and `app` depends on
`service_completed_successfully`; `restart: "no"` so a failure is visible.

**Counter-design.** `migrate` must exit 0 with a per-tenant report, and the app must boot. A tenant
whose `user_version` is below `tenant.db_version` serves `503 DM_E_SCHEMA_STALE` with `Retry-After`
and triggers a lazy repair of that one tenant (my DM11); `/healthz` reports
`tenants_pending_migration: N` as **degraded**, not down. The alternative — which PD3 specifies — is
that a single unreadable `site.db`, a full disk on one tenant volume, or one failing `ALTER` stops
every other tenant from serving, at every restart, not just at upgrade time.

**Severity: major.** The failure is correlated with the moment you are already having an incident.

**Evidence needed.** Corrupt one tenant's file (truncate it), run `migrate --tenant all`, bring the
stack up, and assert: the other tenants serve 200, the broken one 503s, `migrate` exits 0 with a
report naming it. If the platform owner insists on exit-non-zero, the app must still start —
otherwise the gate is a single point of failure by construction.

### C5 — Against Runtime D-R7: a worker cannot hold "the same readonly handle"

**Claim attacked.** D-R7: sources ≥0.5 ms "are executed in a per-tenant `worker_threads` worker with
the same readonly handle, over `MessagePort`".

**Counter-design.** `better-sqlite3` `Database` objects are bound to the thread that opened them; the
handle cannot be shared, only reopened. So the design is one connection per (worker, tenant), opened
lazily inside the worker, LRU'd with the worker, and it costs Runtime's own measured 0.443 ms on first
use per worker. This does not weaken I5 (the handle is still `readonly`) but it changes the resource
count from "64 handles" to "64 + 4 × hot tenants", which is what the pool sizing in my DM10 has to
cover.

**Severity: minor.** It is an implementability correction, not a design change to the offload
threshold.

**Evidence needed.** A ten-line probe: create a `Database`, `postMessage` it to a worker, call
`.prepare()` there, record the throw. I did not run it this round — this box has no `node_modules`
(§5), and I will not cite a number I did not produce. The structural fact is in the driver's
documented contract; the probe is what converts it from a claim to a measurement.

### C6 — Against Platform PD2/P8: the watermark boundary must be stated as "Node never writes to the client socket", not "no gated byte traverses Node"

**Claim attacked.** P8: "No `/media/` or gated byte traverses Node", falsified by "a gated download
whose `bytes_sent` … is not within 1% of nginx's".

**Counter-design.** The stamp is a transformation in Node (a worker) that produces a file; the
delivery is nginx's. The invariant that holds is: *Node never writes a gated byte to a client
socket.* As written, P8 forbids the watermark, and the only ways to satisfy it are to stamp in nginx
(impossible) or to ship un-stamped bytes (Security DS-7 forbids). The measurable form: the app
returns `X-Accel-Redirect` with an empty body **after** the stamped file exists, and the byte count
comes from the access log.

**Severity: medium.** It is a falsifier that fails on a correct system, which means it will be
deleted rather than fixed when it first trips.

**Evidence needed.** One instrumented download: assert the app's response body is 0 bytes, the
stamped file exists before the 200, and nginx's `$body_bytes_sent` equals the stamped file size.

---

## 3. Conflicts I detect between OTHER domains (proposed resolution)

### X1 — Platform A1's fix for the Range/`uses` bug contradicts Security DS-5, and Platform's version hands out free downloads

**The conflict.** Platform A1 proposes: "decrement only when the request has no `Range` header or
`Range` starts at byte 0". Security DS-5 proposes a `jti`-deduped consume. Both claim to fix the same
measured defect (Platform T16: `uses` 1→4 across three ranges; Security §6.4: eight chunks, eight
uses).

**Why Platform's loses.** Under the offset rule, a client that sends `Range: bytes=1000000-` never
consumes a use — so one token, ten minutes, unlimited resumption from any offset. The rule converts
an over-charge into an unbounded grant, and it does so for exactly the large-file case gating exists
for.

**Resolution.** Adopt Security DS-5 with C2's ordering. `jti` is the accounting unit because the token
is the thing the buyer was given; the offset is a property of the transfer, not of the purchase.

### X2 — Platform PD5 strips the demo prefix in nginx; Runtime 3.5 requires that it does not

**The conflict.** Platform PD5: `rewrite "^/demo/<key>/(.*)$" /$1 break;` and forwards
`X-Forwarded-Prefix`. Runtime 3.5: "the prefix is stripped by the **app** (nginx must not rewrite)",
and Runtime's open question 1 asks who strips.

**Why it must be the app.** Platform's own T18 shows the redirect surface is where this breaks:
without `proxy_redirect` the browser leaves the prefix, `proxy_redirect default` deletes the
`Location` header entirely, and the hand-written form has to be kept in sync with the rewrite by
hand. If nginx strips *and* the app strips, every demo URL is a 404; if nginx strips and the app
believes it owns the prefix, `site.url()` emits `/demo/acme/demo/acme/…`. One stripper, and it is
the one that has to know the prefix anyway to build URLs.

**Resolution.** nginx sets `X-Forwarded-Prefix: /demo/<key>` and `proxy_pass http://app;` with no
rewrite; the app strips and owns `site.url()`. One integration test either side can run:
`GET /demo/acme/blog/a` must reach the app as path `/blog/a` with prefix `/demo/acme`, and the
rendered page must contain no doubled prefix.

### X3 — Platform PD1 and Runtime D-R2 define two different edge-identity headers for the same purpose

**The conflict.** Platform: `X-Skunkworks-Edge: <token>` from `skunk-proxy.conf`, token in
`SKUNK_EDGE_TOKEN`. Runtime: `X-Skunkworks-Proxy-Token` equal to `SKUNKWORKS_PROXY_TOKEN`, plus a
trusted-CIDR check. Both are "prove the header came from the proxy"; neither owner mentions the
other's name.

**Why it matters.** A deployment that sets Platform's snippet and Runtime's env (or the reverse) fails
closed on *every* request — and each owner will read the 400/421 as a bug in the other's layer. Two
names for one secret is also two rotation runbooks.

**Resolution.** Platform's header and env var win (`X-Skunkworks-Edge`, `SKUNK_EDGE_TOKEN`) because
the value is rendered into the snippet at install, which is the only place that can guarantee it
exists. Runtime's CIDR check survives as a second gate. `SKUNKWORKS_PROXY_TOKEN` is deleted from the
SDS's env table. Security DS-4's "reject if absent, empty, or contains a comma" applies to the tenant
header, not this one.

### X4 — Security's argon2 concurrency bound and Platform's 1 GB container are inconsistent, and the heap cap does not cover the allocation

**The conflict.** Security DS-6: 8 concurrent verifies at 19 MiB = 152 MiB, and "128 concurrent =
2.4 GiB and an OOM kill". Platform PD8: `memory: 1g`, `--max-old-space-size=768`.

**Why it matters.** argon2 allocates outside the V8 heap, so `--max-old-space-size` does not bound it
and V8 will not GC under pressure it cannot see; the container is killed by the kernel, taking every
tenant's requests with it. At Security's own semaphore of 8 the numbers fit (152 MiB), but the
queue depth of 32 means a burst is answered with `503 E_BUSY` by the component that is supposed to be
protecting availability.

**Resolution.** Semaphore 4, queue 32, container 1 GB, and a test that 64 concurrent redemptions keep
RSS under 400 MiB. If C1 lands, the conflict disappears and the semaphore with it — which is one more
argument for C1.

### X5 — Security A-2, Platform A3 and Runtime D-R2 disagree about what protects the admin surface

**The conflict.** Security A-2: a stored `<script>` on the public site drives the admin port with the
admin's cookie attached, because cookies ignore ports (measured, §6.8) and `SameSite=Lax` treats a
different port as same-site. Platform A3: the IP allowlist makes the product unsupportable and must
be opt-in-empty. Runtime D-R2: one process, two listeners, admin selected by port.

**Resolution.** Neither the port nor the allowlist is the control. Security DS-11's session-bound CSRF
token plus exact `Origin` equality is the control, and it must be mandatory (no `text/plain`
exemption). Platform makes `SKUNK_ADMIN_ALLOWLIST` an opt-in defaulting to empty in bundles; Runtime
puts admin on a distinct **hostname** when the deployment has one, because "separate origin" via port
is a UI separation only. The path-prefix demo tier must never share an origin with admin — that is a
hard constraint on PD5, not a preference.

### X6 — Platform PD2 ("no gated byte traverses Node") and Security DS-7 ("never stream un-stamped") cannot both be literal

**The conflict.** PD2 offloads bytes at nginx and calls Node's role "authorise only"; DS-7 requires
the stamped file to exist before any bytes leave; Platform A4 forbids synchronous stamping on the
event loop. Three constraints, one path.

**Resolution.** A worker stamps into `content/protected/wm/<spec_sha>/<asset_sha>.<ext>`, the file is
fsync'd, and only then does the app return `X-Accel-Redirect` — Platform's own T4 shows what happens
if the target is missing (nginx returns 404 and discards the app's 200, so the user sees a broken
download rather than a denial). PD2's invariant is restated as C6's form: Node never writes a gated
byte to a client socket.

---

## 4. Revised invariants after round 1

Each is followed by the command or check that fails if it is false. Changed items say what changed and
why; unchanged ones are restated so the SDS has one list, not two.

**I1 — A connection belongs to exactly one tenant, and `control.db` is never open on a tenant
connection.** *(unchanged)*
One factory, `getTenantDb(tenantId, {mode})`, and `pragma_database_list` must yield exactly `['main']`
on every handle the pool hands out. *Falsifier:* a second row on any pooled handle (R1 M9b: `ATTACH`
survives `ROLLBACK`, so a discarded connection is the only safe response).

**I2 — No SQL text authored outside `src/db/` reaches the engine, and the AST cannot name a statement
class.** *(strengthened)*
The DDL runner accepts a typed AST and emits SQL itself; the AST has no free-text field for a table
name, a type name, or a default expression. An `ASSET` column's FK target is decided by the *type*,
not by a `ref` object the caller supplies — Security's `TableSpec.ref.table` is a validated string,
which is one forgotten allowlist away from `REFERENCES cms_page(path)`. *Falsifier:* any emitted
statement matching `/\b(attach|pragma|trigger|view|sqlite_master|as\s+select)\b/i`, or any emitted DDL
containing a single quote.

**I3 — Every `u_*` FK target is drawn from a closed set, and every `ASSET` column is indexed by the
runner whether or not the admin asked.** *(extended)*
Targets: `cms_asset(key)`, `cms_asset_bundle(key)`, `cms_page(path)`, `u_<name>(id)`. The index rule is
new and measured: an unindexed `ASSET` column turns every join and every guard probe into a scan —
21.55 ms → 0.43 ms on a join (R1 M18), 7.69 ms → 0.024 ms per guard probe at 200,000 rows (check 19).
*Falsifier:* parse `sqlite_master.sql` for every `u_*` table and assert both the FK targets and an
index whose leading column is each `ASSET` column.

**I4 — An export is `VACUUM INTO` plus the projection, and it is verified on a fresh connection.**
*(amended — the old wording demanded byte-identical files, which is false)*
The output must carry the same row counts, the same `sqlite_sequence`, zero `foreign_key_check`
violations, `application_id = 0x534B5701`, and the projection's `rows` tables must hash identically to
the source's. It is explicitly **not** file-byte-identical: two `VACUUM INTO` copies of an unchanged
source are (check 16), but one volatile row breaks file equality while leaving the projection digest
unchanged — and a live CMS always writes volatile rows. *Falsifier:* check 16.

**I5 — `readonly` is a write boundary and nothing else.** *(unchanged; the hole list grew)*
It stops INSERT/UPDATE/DELETE/DDL. It does not stop `ATTACH` (R1 M9b), `VACUUM INTO` (Runtime §6.3),
`CREATE TEMP TRIGGER`, or reading another file. No sentence in the SDS may use "readonly" as an
isolation argument. *Falsifier:* a `readonly` handle reading a foreign file, or `VACUUM INTO` writing
outside its directory.

**I6 — A reference key is canonical, lowercase, CHECK-constrained, and immutable while referenced —
by foreign key, with an alias for the URL-level case.** *(unchanged, plus two clauses)*
`ON UPDATE RESTRICT` freezes an FK-referenced key; `cms_asset_alias(key→asset_id)` keeps a renamed
URL alive inside `body_html`, which no FK can see. Path columns are reference keys too
(`cms_page.path` is an FK target from `u_*` PAGE columns), so they share one predicate emitted from
one function — two hand-copied GLOB strings diverged inside one round and the second one
(`cms_redirect.to_path`) admitted `//evil.example`, a protocol-relative open redirect. *Falsifier:*
`UPDATE cms_asset SET key='x'` while a `u_*` row references it must raise `FOREIGN KEY constraint
failed`; `/media/<old-key>` must 301; `/` must be insertable in `cms_page.path` and `cms_redirect`
`from_path`/`to_path` while `//x`, `/a/../b` and `/x/` are rejected (check 10).

**I7 — No table stores a filesystem path, a URL or a checksum as *content*, and `storage_path` is not
writable at all.** *(strengthened)*
`cms_asset.storage_path` is `GENERATED ALWAYS AS ('content/media/'||substr(sha256,1,2)||'/'||sha256||'.'||…) STORED`.
Any INSERT or UPDATE naming it is rejected by the engine, from any driver (check 11). `sha256` is
immutable by trigger, because it is the `X-Accel-Redirect` target and a form edit that changed it
would point a page at different bytes. *Falsifier:* an INSERT with `storage_path` in the column list
must fail with `cannot INSERT into generated column`.

**I8 — Every `cms_*` table is in 3NF with exactly four named exceptions, numbered E1/E2/E4/E5.** *(was
four, one of them different: E3 retired, E5 added)*
E1 `cms_download_code.uses` (atomic single-statement consume — D19); E2 `cms_asset.bytes`/`sha256`
(SQL cannot stat a file); E4 `cms_settings` (configuration, not content); E5 `cms_datasource.cost_*`
(a cached measurement the publish gate reads, invalidated at 2× row count). E3 (`cms_page.etag`) is
**gone**: Runtime removed the only reader, so the column is deleted. *Falsifier:* `schema/3nf-audit.sql`
listing any `(table, column, determinant)` not in E1/E2/E4/E5.

**I9 — Integrity that must survive a `foreign_keys=OFF` connection lives in a trigger, and every
trigger is in `cms_trigger_registry`.** *(new — replaces "there are no triggers")*
The delete guard on `cms_asset`, the per-`u_*` guards, and the immutability triggers for `sha256`,
`code_hash`, `code_lookup`. *Falsifier:* `SELECT count(*) FROM sqlite_master WHERE type='trigger'`
must equal the registry count, and a `DELETE` of a referenced asset with the pragma off must raise
`DM_E_ASSET_IN_USE` (check 12, including through the `sqlite3` CLI).

**I10 — Every table is classified in `schema/export-projection.json`, and the projection — not the
file — is the unit of reproducibility.** *(new)*
`rows` or `empty`, each with a written reason; a table in the DDL and not in the file fails the build.
*Falsifier:* check 16 (`20/20 tables classified`), and a bundle containing a row from an `empty`
table.

**I11 — Every table rebuild runs with `foreign_keys=OFF` outside the transaction and restores
`sqlite_sequence` inside it.** *(new — this was a data-loss bug, not a refinement)*
Measured (check 13): `DROP TABLE cms_page` with the pragma **on** cascade-deletes every
`cms_page_revision` row — the page history — because `DROP TABLE` performs an implicit `DELETE`.
With the pragma off the rebuild preserves all of it. `PRAGMA foreign_keys` inside a transaction is a
silent no-op (R1 M3b), so "off" must be set before `BEGIN`. *Falsifier:* a rebuild that changes a child
row count, or a `sqlite_sequence` value below its pre-rebuild value.

**I12 — A column that must never change after insert is immutable by trigger, not by a form policy.**
*(new)*
`cms_asset.sha256`, `cms_download_code.code_hash`, `cms_download_code.code_lookup`. *Falsifier:* an
`UPDATE` of any of them raising anything other than `DM_E_COLUMN_IMMUTABLE` (check 11).

---

## 5. Measurements I ran this round

Environment: macOS 15.7.4, Python 3.9.6, sqlite3 3.43.2 (both the module and the CLI), argon2-cffi
25.1.0, Node 22.23.1 present but **no `node_modules`** — so every check below uses the Python binding
or the CLI, and the one claim that needs `better-sqlite3` (C5) is stated as a spec fact with the probe
named, not measured.

### 5.1 The whole suite, verbatim

`make test` is the canonical entry point: it runs the `.gitignore` verdicts, applies both DDL files to
real SQLite with the negative tests, then this suite. The block below is one run of the last stage;
timings move with machine load (see §5.4), outcomes do not.

```
$ python3 scripts/model/verify_claims.py
PASS  1 schema/ER parity + negative tests                27 entities == 27 CREATE TABLE, png 129230 B
PASS  2 cp loses data, VACUUM INTO keeps it              cp=no such table; VACUUM INTO rows=1000 user_version=9 views=1 jm=delete wal_before=28872B
PASS  3 key immutable by FK, not by app                  referenced rename REJECTED, unreferenced rename ACCEPTED
PASS  4 partial unique index breaks FK parent            foreign key mismatch - "u_p" referencing "cms_asset"
PASS  5 sqlite_sequence survives restore, not rebuild    seq 5->3 across rebuild; restored -> next id 6
PASS  6 PRAGMA foreign_keys is a no-op in a txn          inside txn=1, after commit=1 (silently ignored)
PASS  7 argon2id equality lookup is impossible           verify=66.5ms, salted (different hashes) -> 5000-code scan=332s; hmac=0.617ms
PASS  8 readonly is not a tenancy boundary               readonly handle read 1 foreign row(s): buyer@acme.com
PASS  9  r2 amendments apply to a populated v1           user_version 2, integrity ok, fk_check 0, revisions=2, seq cms_page=3, 3 triggers all registered
PASS  10 root path '/' is insertable                     v1 REJECTED '/' (homepage uninsertable) and ACCEPTED to_path='//evil.example'; amended accepts '/', rejects '/a/', '/../x', '/x//y' and '//evil.example', '/a/../b', '/x/'
PASS  11 storage_path is generated, sha256 immutable     cannot INSERT into generated column "storage_path"; cannot UPDATE generated column "storage_path"; sha256 -> DM_E_COLUMN_IMMUTABLE
PASS  12 asset delete guard holds with foreign_keys=OFF  fk=0 python -> DM_E_ASSET_IN_USE; cli rc=19 -> Error: stepping, DM_E_ASSET_IN_USE (19); unreferenced delete OK with fk=1, derived rows cascaded {'cms_asset_variant': 0, 'cms_asset_alias': 0, 'cms_watermark_render': 0}
PASS  13 rebuild with fk=ON cascade-deletes children     revisions before=2; DROP with fk=ON -> 0 (cascade deleted); rebuild with fk=OFF -> 2
PASS  14 dedupe write order: 24 requests, 1 download     24 concurrent requests, one jti: update-first uses=24 (events=1); insert-first uses=1 (events=1)
PASS  15 (jti) WHERE kind='first' tolerates NULL         3 NULL-jti denials accepted; (J1,'first') twice -> UNIQUE constraint failed: cms_download_event.jti; (J1,'range') accepted; null=4
PASS  16 export projection is the reproducible unit      20/20 tables classified; vac==vac 7d1812f4fea3; after volatile rows file 733f8b1e6542 (differs) but projection 841c0c216798 (identical); content change -> 35d3d955296c (differs)
PASS  17 argon2 parameter cost on this box               m=19456,t=2,p=1 min=23.6 med=25.4ms; m=65536,t=3,p=1 min=128.6 med=137.2ms (5.4x)
PASS  18 an unanchored audit chain proves nothing        tamper row 2 + recompute chain -> unanchored chain verifies (True); anchored head mismatches (7885b109.. -> c57f64d3..)
PASS  19 delete-guard cost, indexed vs not               200k referencing rows, unreferenced delete: no index 7.69 ms, indexed 0.024 ms (n=5 each)

19/19 passed, 0 skipped, 0 failed
```

Two of these checks failed on their first run, and both failures are in the paper because they are
findings, not noise:

- **check 10** first failed with `amended CHECK accepted '/x//y'`, then — after I fixed that — with
  `CHECK constraint failed: to_path GLOB '/*' …` because the *new* redirect CHECK rejected `'/'`.
  That is the same GLOB mistake (`'/' GLOB '*/'` is true) made twice in one hour, in two hand-copied
  predicates. It is the strongest evidence in this paper that a path predicate must be emitted from
  one function, not retyped per column: the fix is correct, the *method* was the defect.
- **check 16** first failed with `projection digest moved on volatile-only rows` — because the fixture
  inserted a `cms_form` row *between* the two exports and `cms_form` is a `rows` table. The test was
  wrong, the projection was right; the form definition moved before the first export.

The amendment file was also applied to an empty `user_version=1` file (no rows, no `sqlite_sequence`
entries): `user_version 2, integrity ok, fk_check [], 3 triggers registered`, and a homepage inserts
afterwards. A newly provisioned tenant and an existing one migrate by the same path, which is the
property that matters when `install.sh` and the upgrade path share one migration.

### 5.2 The check that found the homepage bug

`cms_page.path` shipped as `CHECK(path GLOB '/*' AND path NOT GLOB '*..*' AND path NOT GLOB '*/')`.
In GLOB, `*` matches the empty string, so `'/' GLOB '*/'` is true and the root path is rejected:

```
$ python3 -c "…CREATE TABLE t(path TEXT CHECK(path GLOB '/*' AND path NOT GLOB '*..*' AND path NOT GLOB '*/'))…"
  '/'              REJECTED (CHECK constraint failed: path GLOB '/*' AND path NOT GLOB '*..*' AND path NOT GLOB '*/')
  '/home'          ACCEPTED
  '/blog/hello'    ACCEPTED
  '/a/'            REJECTED (CHECK constraint failed: …)
--- proposed fix ---
  '/'              ACCEPTED
  '/home'          ACCEPTED
  '/blog/hello'    ACCEPTED
  '/a/'            REJECTED
  '/../x'          REJECTED
```

`validate_schema.py`'s twelve negative tests are all of the form "this must be rejected"; not one of
them inserts a page. The suite certified the half of the schema that refuses and never touched the
half that must accept.

The same fixture found the second path column. `cms_redirect` shipped with
`CHECK(from_path GLOB '/*')` and `CHECK(to_path GLOB '/*')` — no `..` guard, no trailing-slash guard,
and `to_path='//evil.example'` accepted, which a browser resolves as a protocol-relative URL. That is
an open redirect on the client's own domain, set from an admin form, which is the same class as Red
Team O5: a privileged form writing a security-relevant value. A6 rebuilds the table with the shared
predicate and forbids a non-path target; an off-site link belongs in `cms_nav.href_kind='url'`, where
it is visible as a link rather than masquerading as a path.

I then made the same GLOB mistake in the *new* redirect CHECK (`'/' GLOB '*/'` is true, so `to_path='/'`
was rejected), and check 10 caught it on the next run. Two identical bugs in two hand-copied
predicates in one hour is the argument for I6's last clause: the predicate is emitted from one
function, because a CHECK that is retyped per column is a CHECK that diverges.

### 5.3 The cost of the delete guard, and why every `ASSET` column is indexed

The guard's `EXISTS` probe is the only new per-delete cost. Check 19 builds 200,000 referencing rows
in one child table and deletes an *unreferenced* key five times — so the probe scans the whole table
and finds nothing — with and without an index on the child column:

```
PASS  19 delete-guard cost, indexed vs not               200k referencing rows, unreferenced delete: no index 7.69 ms, indexed 0.024 ms (n=5 each)
```

7.7 ms per referencing table, and a tenant can add a dozen. That is why the runner creates the index
whether or not the admin asked (I3), and why a `DELETE` of an asset is not a hot path.

### 5.4 Argon2, five times, on the same box

Five runs of check 17, minutes apart, n=8 each (the fifth is the line in §5.1):

```
run 1: m=19456,t=2,p=1 min=23.7 med=26.1ms; m=65536,t=3,p=1 min=128.4 med=142.5ms (5.5x)
run 2: m=19456,t=2,p=1 min=27.5 med=29.9ms; m=65536,t=3,p=1 min=135.6 med=146.5ms (4.9x)
run 3: m=19456,t=2,p=1 min=23.6 med=24.5ms; m=65536,t=3,p=1 min=125.2 med=127.4ms (5.2x)
run 4: m=19456,t=2,p=1 min=23.7 med=25.2ms; m=65536,t=3,p=1 min=139.3 med=153.6ms (6.1x)
run 5: m=19456,t=2,p=1 min=23.6 med=25.4ms; m=65536,t=3,p=1 min=128.6 med=137.2ms (5.4x)
```

Median 24.5–29.9 ms for Security's parameters and 127.4–153.6 ms for mine; the ratio is 4.9–6.1×,
which is the number that matters for C1: ~5× the latency and 3.3× the memory for a verifier that
cannot raise the cost of the attack. Security measured 27.0 ms for the first set with
`@node-rs/argon2`; two implementations and five runs agree within 10% on the absolute figure, and the
spread across runs is the same load-dependence R1 M15 recorded (71.5 ms → 1,126 ms across eight runs
of a 64 MiB verify under load). No single number here should be quoted without its range.

### 5.5 What I did **not** measure

- **The worker-thread `Database` restriction (C5).** No `node_modules` on this box; the probe is named
  in C5 and the claim is labelled as the driver's documented contract.
- **Browser behaviour of anything.** No Chromium. Security's `__Host-` finding and Runtime's A2 are
  spec facts from RFC 6265bis, and I am not adding a second unmeasured opinion about them.
- **`migrate` under a corrupt tenant (C4).** The platform owner's stack is not in this repo; the
  assertion is written out in C4 so it can be run as one command.
- **Real HTTP concurrency against a built site.** Every concurrency number above is at the SQLite
  layer, which is where the invariant lives.

---

## 6. What I concede, and what would change my mind

**Conceded, in order of how much it costs me.**

1. **The shipped schema cannot insert a homepage.** `path NOT GLOB '*/'` rejects `/`. This is not a
   subtle constraint interaction; it is the first row of any site. It survived because my test suite
   only ever asserted rejection. A schema is not validated by the set of things it refuses — and I
   then made the identical mistake again in the fix for `cms_redirect`, which is why I6 now requires
   one emitted predicate instead of four hand-copied ones.
2. **"Integrity is enforced by the database, not by application code" was false as shipped.**
   `foreign_keys` is per-connection and defaults to off, and the connections where it is off are the
   ones that matter — export, install, repair, the CLI. R1 I6 described a guarantee that lived in a
   factory function. It is true now, but only because a trigger enforces it, and it took a reviewer
   from another domain to say so.
3. **My rebuild procedure was a data-loss bug.** `DROP TABLE` on a parent with `foreign_keys=ON`
   cascade-deletes its children — a `cms_page` rebuild silently destroys every revision. R1's DM4
   described the rebuild and the sequence carry-forward and never mentioned the pragma. Check 13 is
   now the gate.
4. **Argon2 next to a deterministic lookup column is decoration.** I argued for both in DM12 and did
   not notice that the fast column sets the ceiling. Dropping it is a simplification I should have
   proposed in round 1, and Security's parameter fight was a fight about the wrong variable.
5. **"Byte-identical export" is unachievable and I implied it was achievable.** The reproducible unit
   is a projection, and the projection had to be written down as data before the claim meant anything.
6. **Storing the document verbatim does not give an empty diff.** Runtime measured 8/9 fixtures
   differing at pass 1 because GrapesJS rewrites on load. My conclusion (no block table) survives; my
   reason did not.
7. **`bytes_sent NOT NULL DEFAULT 0` was a fabricated number in an audit table.** "0 because the app
   cannot know" and "0 because nothing was sent" are indistinguishable to a reader, and the table
   exists to be read in a dispute.

**What would change my mind.**

- **C1 dies if the pepper can leak with the file.** If `SKW_CODE_PEPPER` were ever baked into an
  image, a bundle, or a backup that travels with `site.db`, then `code_lookup` becomes an offline
  oracle and argon2 becomes the only remaining barrier — at which point Security's parameters and the
  semaphore are both mandatory. The projection excludes the codes, but a pepper in a backup is a
  Platform decision I do not own.
- **I6's freeze dies if a client needs `/Pricing` and `/pricing` as distinct pages.** The NOCASE
  unique index makes that impossible by construction. That is a product ruling, not a schema one.
- **I10 dies if the CMS bundle is expected to carry the operator's sales history.** If a demo tenant
  sold as a going concern must arrive with its submissions and codes, then the projection is a preset,
  not a rule, and the exporter needs a second reviewed mode with an audit row per use.
- **DM5 dies if GrapesJS is replaced** by an editor whose document is not HTML+CSS. Already stated in
  R1; Runtime's round-trip measurements make the dependency sharper, not weaker.
- **I11's cost dies if a tenant DB is large enough that a rebuild is not affordable inside one
  `BEGIN IMMEDIATE`.** At 398 MB, `VACUUM INTO` is 1.47 s (R1 M12) and a rebuild copies every row of
  one table under a write lock; above a few hundred MB the rebuild has to become an offline migration
  with the site in maintenance, and that changes the deploy story.
