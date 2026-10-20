# R2 — Red Team audit

Round 2 remit: not to raise a fresh set of objections, but to audit what Round 1 left standing. Five R1
papers exist; four of them answer each other in places and talk past each other in others. An objection
is **orphaned** when (a) no paper's owner converted it into a decision, contract, column, or test, and
(b) it is aimed at a domain that wrote a paper and did not mention it. Silence in a domain paper is
stronger evidence of an orphan than silence in `IDEA.md`, because the domain paper is where the owner
was supposed to close it.

Evidence discipline: every number below is quoted from an R1 §6 measurement table with its paper and
section. The only numbers I originate are sums and ratios of those quoted figures, and each shows its
operands. Nothing here was measured for this paper. Claims checked against `schema/site.sql` and
`schema/control.sql` as shipped are marked **(DDL)** — those files, not the prose, become the contract.

---

## 1. Objections nobody adopted — from my r1 list and from the attacks in the four domain papers, name every objection that is now orphaned (claim | owning domain | why silence is dangerous | severity)

### 1.1 From `r1-red-team.md` — what four domain papers did not pick up

| # | Orphaned claim | Owner | Scenario if it stays silent | Sev | R1 ref |
|---|---|---|---|---|---|
| A1 | The exported CMS bundle contains no `control.db`, therefore no tenant, domain, user, session, or `mode` — and nothing says who creates them. | Platform + Data Model | `install.sh` unpacks, compose reports healthy, `migrate --tenant all` finds no tenant row and does whatever nobody specified (exit 0 silently, or fail with no remedy in the bundle), and every request 404s because Runtime I2 forbids a default tenant. The buyer's site is a 404 with a green dashboard. Platform PD9 defines `data/` + `.env` + `install.sh` and never names `ADMIN_EMAIL`, a tenant key, a domain row, or `mode=production`. | **blocker** | r1-red-team §1 O2; r1-platform §2 PD9, §3.3; r1-runtime §1 I2 |
| A2 | A CMS-bundle export carries `cms_form_submissions`, `cms_download_code`, `cms_download_event.ip_hash`, `content/protected/wm/**` (one stamped copy per purchaser), and `cms_audit` rows naming our own operators. Only the static/Astro path got a refusal rule. | Platform + Data Model | A demo used for two weeks of prospecting is sold: the client receives our sales pipeline, other buyers' watermarked books, and our staff's names in their audit log. `DM_E_EXPORT_UNSAFE` covers gated assets, not people. | **major → notifiable** | r1-red-team §1 O3; r1-data-model §2 DM7/DM8, §3.4; r1-platform §3.7 |
| A3 | Nothing defines how `<div data-source="posts" data-limit="3">` becomes N sibling elements, what escapes injected values, or what 0/50 rows render. DM5 deleted `cms_page_blocks` without supplying a replacement for repetition. | Runtime + Data Model | The first block a prospect asks for ("latest three posts") renders exactly one card. The fix changes the stored markup shape of every block, so it rewrites the block registry, the SSR renderer and all three exporters — in S4, after each was built. RT's round-trip measurement preserves the attribute (r1-runtime §6.8), which makes the gap look solved. | **blocker** | r1-red-team §1 O4; r1-data-model §2 DM5; r1-runtime §1 I7, §6.8 |
| A4 | No per-column write policy exists for CRUD forms. `cms_asset.storage_path` and `sha256` are row data, editable through the forms the brief requires, and they feed the symlink farm. | Security + Data Model + Platform | Set `storage_path=../../../../etc/passwd` on an asset with key `leak`, `.ext=txt`; the farm writes `content/public/leak.txt`; Platform measured that nginx follows a link anywhere and returned `/etc/hostname` **200, 13 bytes** (r1-platform §6 T11g). A file-disclosure surface in a product sold to third parties, reached from the admin UI. | **major** | r1-red-team §1 O5; r1-data-model §1 I7; r1-platform §2 PD4 |
| A5 | Adding a production host at runtime has no path. PD5 solves path-prefix demos with one `location` + `map`; nothing adds a `server_name` or a cert for a new client TLD without recreating `app`. | Platform | A sale closes, the domain is pointed at the box, and the site is unserved (or served by whichever block nginx loaded first) until a container recreate — the all-tenant blip O7 described, still present for the TLD case. | **major** | r1-red-team §1 O7; r1-platform §2 PD5, PD6 |
| A6 | Path-prefix demos share the parent origin, and `__Host-`/`Path=/` gives no path isolation; the admin session cookie is sent to tenant-authored islands on `/demo/<key>/`. Security's CSRF+`Origin` check is the only control and Runtime says the admin tenant-selection path is undefined. | Security + Runtime | A demo island (`data-island` survives the round-trip, r1-runtime §6.8) issues a same-site POST to the admin port with the operator's cookie attached. Cookies ignore ports — measured, `127.0.0.1:19101` cookie sent to `:19102` (r1-security §6.8). | **major** | r1-red-team §1 O9; r1-security A-2, DS-11; r1-runtime A5 |
| A7 | Watermark rendering has no owner in the process model. Platform measured a 600 ms synchronous block stalling 20/20 concurrent requests (510–514 ms vs 0.5 ms baseline); Runtime D-R7 offloads *sources* only. | Runtime | Two buyers redeem at once; the second waits on `pdf-lib` (51.9 ms cold per 40-page PDF, IDEA §7.8) on the same loop as every tenant's render. `X-Accel-Redirect` does not help: stamping happens before the redirect. | **major** | r1-red-team §1 O10; r1-platform A4/§6 T22; r1-runtime D-R7 |
| A8 | The Astro SKU ships no lockfile and is never built by the exporter. Measured: `npm ci` without a lockfile exits 1; a cold `npm install` for a ten-page site is 38.5 s / 154 MB `node_modules`. | Platform | The client's box compiles our generated project for the first time, behind their proxy, on their Node version. One of three sellable outcomes fails in front of the buyer. | **major** | r1-red-team §1 O11; r1-platform §6 T19, PD9 |
| A9 | The watermark render cache has no eviction. `cms_watermark_render` is `UNIQUE(spec_sha, source_sha)` with `bytes` but no `last_used_at`, no `hits`, no ceiling **(DDL)**. | Data Model + Platform | 1,000 buyers × a 5 MB book at the measured +60% stamp growth ≈ 7.8 GB, inside the exported tar, on a box whose only quota is a byte counter with no deletion policy. First symptom is `SQLITE_FULL` on the writes that would let the admin announce the outage. | **major** | r1-red-team §1 O12; r1-platform A4; schema/site.sql |
| A10 | The Data Source result cache has no defined key. `site.source('posts',{limit:3})` and `{limit:50}` are the same source; DM's only cache key contract is for *prepared statements* `(tenantId, kind, specHash)` (r1-data-model §3.1.3), not results. | Runtime | The homepage warms 50 rows; the sidebar renders 50 for one `ttl_s`. Silent wrong content on a live site, and it depends on which page was hit first. | **major** | r1-red-team §1 O13; r1-data-model §3.1 |
| A11 | The admin `ALTER` surface is a partial function with raw SQLite errors surfacing in a modal: `ADD COLUMN … NOT NULL` without a default is refused; `DROP COLUMN` on an indexed column is refused. Security's `TableSpec` accepts `notNull` with an optional `default`, so the API permits exactly the refused case. | Data Model + Security | An operator describes a change, submits, and gets raw SQLite text in a modal with the change abandoned — the builder looks like a SQL console with extra steps, which the brief forbids. | **minor → major** | r1-red-team §1 O14; r1-data-model §2 DM2; r1-security §3.1 |
| A12 | Owner-password PDFs are refused by the fail-closed watermark rule and are not "corrupt", while the issue-screen warning list covers only video/audio. | Security + Data Model | A publisher's InDesign ebook is 100% undeliverable, and the admin panel reports it as our watermark bug. Every download 503s; Security DS-7's boot health check stamps an unencrypted fixture and passes. | **minor (major for that tenant)** | r1-red-team §1 O16; r1-security DS-7 |
| A13 | Email transport for access codes is unspecified: no SMTP/provider, from-address, SPF/DKIM, bounce handling, or redelivery path. | Platform + Security | The first Stripe webhook issues a code and emails nothing; codes are "shown once, never recoverable", so the remedy is reissue, which revokes a code the buyer may already hold. | **blocker for the first sale** | r1-red-team §6.1; r1-security §3.3 (webhook secret only) |
| A14 | "Hand-edited HTML always wins" has no editor-managed flag, and the round-trip gate now blesses divergence: measured 8/9 fixtures differ from the hand-authored input at pass 1, all stable at pass 2. | Runtime + Data Model | A designer fixes a typo in code view; the next person drags a block; the edit is silently replaced and the gate reports pass because it only checks fixpoint. Revisions make it recoverable, not prevented. | **major** | r1-red-team §6.5; r1-runtime §1 I7, §6.8; r1-data-model DM5 |
| A15 | `linked-private` (IDEA §7.2) implies a preview session; no preview token, route, or TTL exists. `cms_page.status` is `draft|published|hidden` and Runtime routes `status != published` to 404 **(DDL)**. | Security + Runtime | The client asks to show the boss a change before it goes live. The only primitive is a second tenant with content copied by hand. | **major** | r1-red-team §6.4; r1-runtime §3.3; schema/site.sql |
| A16 | Form spam: no captcha, honeypot, or per-IP limit on `/forms/*`. Platform's controls are `client_max_body_size` and `limit_req` per tenant. | Platform + Security | The first public contact form collects a few hundred rows in a week and the client reads them; the submissions table is also in the export (A2). | **major** | r1-red-team §6.6; r1-platform PD8 |
| A17 | Demo expiry cascade and tenant departure: `tenant` requires `demo_expires_at` for demos **(DDL)**, but nothing defines what happens to media, watermark renders, submissions, DNS, or the client's handover copy. | Platform | A demo expires mid-negotiation, or a client leaves: the bytes stay forever, the DNS record points at a box that 404s, and nobody can produce a final archive. | **major** | r1-red-team §6.7; r1-platform Q7 |
| A18 | No upgrade channel: D10 pins an image digest, and there is no version endpoint, update procedure, or CVE path for a client's box. | Platform | A base-image CVE lands; every client install is frozen at the digest we shipped, and the fix requires them to edit compose. | **minor → major** | r1-red-team §6.3; r1-platform PD9 |

### 1.2 From the four domain papers — attacks and open questions no owner closed

| # | Orphaned claim | Owner | Scenario if it stays silent | Sev | R1 ref |
|---|---|---|---|---|---|
| B1 | The `view` Data Source kind has no creation path. The DDL AST has no `create_view`; `cms_view_registry` only makes *unregistered* views a postcondition; `cms_datasource.kind` is `CHECK(kind IN ('view','query'))` **(DDL)**. | Data Model + Runtime | A client wants a projection that hides internal columns; the only DB-enforced safe kind cannot be created from the admin, and the sold bundle has no migration tool. `view` is advertised first in IDEA §4 and is unavailable in practice. | **major** | r1-data-model §2 DM2, §3.5; r1-security DS-1; schema/site.sql |
| B2 | Removing `function` (already absent from the DDL) and refusing `count(*)` (1,990.2 µs indexed / 5,019.6 µs unindexed on 90k rows) leaves no aggregate or join path in v1. | Architect + Data Model | "How many products?" and "latest post per category" have no supported source. The developer answer is a migration, which a sold bundle cannot run. | **major** | r1-data-model §3.5; r1-runtime Q2, §6.4; schema/site.sql |
| B3 | Demo tenancy: own `site.db` per demo, or a shared template with copy-on-write? DM states the cost (4.05 ms/tenant fan-out, 185 KB RSS/handle) and asks Platform; Platform never answers. | Platform | 200 demos × migration fan-out and pool pressure, or a shared file where one demo's table builder is a fleet-wide weapon. Either answer changes the pool size, the disk model, and the export. | **major** | r1-data-model §5 Q2; r1-platform §2 PD8 |
| B4 | The snapshot format for `u_*` rows and parameterised sources in the Astro/static SKUs is undefined (one JSON per source? per table? with what params?). | Runtime + Platform | The Astro SKU ships without the data its pages render, or with a format nobody designed and the exporter has to invent at S4. | **major** | r1-data-model §5 Q1; r1-platform A5 |
| B5 | `cms_download_event` retention versus E1 reconciliation: events are append-only, `uses` is reconciled from them, and no deletion policy exists. | Data Model + Security | Someone prunes the table (or a tenant's disk fills); `uses` becomes unreconcilable and the only detector of `max_uses` drift dies with it. | **major** | r1-data-model Q4, DM6 E1 |
| B6 | Is the tenant admin an adversary? Security assumes yes; Data Model's table builder assumes a trusted operator; nobody recorded the answer. | Architect | If hostile-on-demand (a phished password), the whole DDL and CRUD threat model must be type-enforced; if trusted, half of DS-1 is unnecessary cost. The SDS cannot be written without this line. | **blocker (scope)** | r1-security Q1; r1-data-model DM2 |
| B7 | Is there a process boundary per tenant, or does the SDS state "isolation is a permission boundary"? Security asks; Platform asks; DM M16 rules out the cheap substitute. | Architect | Whichever is assumed silently, §9's "no cross-tenant query path by construction" is either true or marketing, and the Builders code to the assumption. | **blocker (§9 text)** | r1-security Q4; r1-platform Q3; r1-data-model §6 M16 |
| B8 | Who may write `tenants/<key>/content/sources/` at runtime? Platform mounts `./data` read-write for the app; Runtime lists the path; Security calls any writer a fleet compromise. | Platform | An import path, a restored backup, or an export/install round-trip yields `import()` of tenant-controlled code in the process holding every handle and every HMAC key. | **critical if any writer exists** | r1-security A-5, Q3; r1-runtime §3.5; r1-platform PD3 |
| B9 | Does the CMS bundle export `cms_download_event` (IP hashes) and `cms_download_code` (argon2 hashes)? Security gives a preference; DM8's "must be 0" applies only to static/Astro. | Platform + Data Model | The client receives argon2 hashes of live codes and HMAC'd IPs from our prospecting, or loses their own redemption history depending on which paper is read. | **major** | r1-security Q6; r1-data-model §3.3 DM8 |
| B10 | Path case: `cms_page.path` is `COLLATE NOCASE` **(DDL)**; no component in front is confirmed not to fold case. | Platform | A CDN folds `/Pricing` to `/pricing`; two pages cannot coexist, or one 404s depending on the edge. | **minor** | r1-data-model Q3; schema/site.sql |
| B11 | No browser in CI. Two invariants (`__Host-` rejection, the CSRF path that stops A-2) are spec-only, and one paper says so explicitly. | Platform + CEO | The cookie rule is implemented as "the RFC says so" and the compensating control (CSRF) is never exercised end-to-end; the first real UA finds it. | **minor, but unverified** | r1-security Q8, DS-10 note; r1-platform §6 "not measured" |
| B12 | No request-scoped transaction contract. DM requires `db.inTransaction === false` on entry to `source()` and bans `wal_autocheckpoint=0`; Runtime never states either. | Runtime | One `BEGIN` at request start pins the WAL for the request's life (12.4 MB WAL against an 8 KB main file, measured) and one backup helper that sets `wal_autocheckpoint=0` makes it unbounded. | **minor** | r1-data-model §3.1.2, A5 |
| B13 | Runtime's contracts have no storage: `control_rev` (D-R3 invalidation) is absent from `control.sql`; `cms_datasource.cost_ms/cost_rows/cost_measured_at` (D-R6) absent from `site.sql`; `cms_page.body_css/rev/body_sha` (D-R9, §3.6.1) absent (`css`, no `rev`, no `body_sha`) **(DDL)**. | Data Model | The tenant-map cache has no way to learn a domain was added except the 1 s poll; publish-time cost measurement has nowhere to write; the CSS layer has no column. Builders will add columns ad hoc or skip the features. | **major** | r1-runtime D-R3, D-R6, §3.6; schema/control.sql, schema/site.sql |
| B14 | `bytes_sent` cannot be filled by the app after `X-Accel-Redirect`, and the DDL makes it `NOT NULL DEFAULT 0` — a zero that passes every check **(DDL)**. | Data Model + Platform | A chargeback dispute is answered with fabricated byte counts. Platform says the nginx log is the only truth; nobody decided whether the column is deleted or ingested. | **minor (audit integrity)** | r1-security A-3; r1-platform §3.9; schema/site.sql |
| B15 | `fleet_admin` (`user_account.tenant_id IS NULL`) exists in the schema and has no story in a single-tenant sold install; three papers spell the mode env three ways (`SKW_FLEET_MODE`, `SKUNK_MODE`, none). | Architect + Platform | A client install either carries a role that must never be usable, or the check that prevents it lives in a variable nobody set. | **minor → major** | r1-data-model Q6; r1-platform §3.4 |
| B16 | Pepper rotation has no owner, and rotation kills every outstanding code. | Security | A rotation runbook is written by whoever is on call, after the first incident, and 400 live buyers lose their downloads. | **minor** | r1-data-model Q5, DM12 |

Count: 34 orphans. Of my 16 numbered objections, five were adopted outright (O1, O6, O8, the
`__Host-`/`Path=/` half of O9, O15) and five more were adopted only as an attack with no owning decision (O3,
O7, the shared-origin half of O9, O10, O14) — the surviving half of each of those ten is listed above. One of my
seven §6 silences was taken (backups, by Platform PD7 and Data Model DM8), one partially (hand-edit, as
revisions only); five stand.

---

## 2. Claims that are measured but not yet designed for (what the design must change, not what the measurement says)

Each item states the measurement, then the design change it forces. The measurement is already correct;
the failure is that no paper carries its consequence into a contract.

**2.1 — Connection classes.** Measured: a `{readonly:true}` handle blocks INSERT/UPDATE/DELETE/CREATE/DROP
but **allows** `ATTACH`, `VACUUM INTO`, `CREATE TEMP TABLE`, `CREATE TEMP TRIGGER`, `PRAGMA writable_schema=ON`
(r1-runtime §6.3); `ROLLBACK` does not undo `ATTACH` (r1-data-model §6 M9b, `dbs: [main, other]`); a WAL file
needs a **writable directory** even for a readonly open, `SQLITE_READONLY_DIRECTORY` on a `:ro` mount
(r1-data-model §6 M16). Design change: the SDS must name exactly three connection classes with a capability
matrix and one test each — `render-read` (ATTACH and VACUUM INTO rejected by the statement wrapper or an
authorizer, no temp objects, `query_only=ON` as defence in depth, not as the control),
`admin-write`, `exporter-write` (short-lived, never pooled, never inside a transaction, per M21). Today DM10
defines a pool plus "DDL never pooled"; Runtime D-R4 defines render handles; Platform PD7 backs up on "a read
connection", which is the class that must not have `VACUUM INTO`. Nobody has written the matrix.

**2.2 — The rename flow.** Measured: `ON UPDATE RESTRICT` makes a referenced key immutable (`FOREIGN KEY
constraint failed`, M4); the CASCADE alternative costs 439 ms of write lock on a settled DB and 2,412 ms
inside the inserting transaction with 200,000 references (M8). Design change: the admin rename must be
specified as **refused while referenced**, with a separate, explicit re-point operation (new key + transactional
rewrite + audit + alias) for the case a client actually wants. And `cms_asset_alias`'s purpose must be
restated: under RESTRICT it only ever records renames of *unreferenced* keys, so IDEA §7.3's "changing the key
cascades to every reference, and writes an alias row" is false as shipped.

**2.3 — The export stage belongs to someone.** Measured: `VACUUM INTO` is a consistent snapshot against a live
writer and excludes uncommitted rows (M21: copy 500, uncommitted 0); it fails on a connection holding a
transaction; it comes out in `journal_mode=delete` and can carry a stale `auto_vacuum` relative to the live
handle (M13); `wal_checkpoint(TRUNCATE)` is 104 ms and `integrity_check` 276 ms at 398 MB (M12); 0.73 s for
240 MB under 400 concurrent inserts with 0 writer errors (r1-platform §6 T17a). Design change: one named
`exportSnapshot(tenant)` with an ordered body — checkpoint, fresh connection, `VACUUM INTO`, reopen the copy,
assert `application_id`/`user_version`/`journal_mode=WAL`/`integrity_check`/`foreign_key_check` — owned by
Platform's exporter and called by all three targets. Nothing in R1 assigns the function or says what happens
when a long admin transaction is in flight — M8's rename inside an inserting transaction took 2,412 ms, and the
copy silently omits whatever that transaction has not committed (M21).

**2.4 — A CPU budget, not just a query budget.** Measured: one 600 ms synchronous block made 20/20 concurrent
requests on an unrelated path wait 510–514 ms against a 0.5 ms baseline (r1-platform §6 T22); a page with
2.3 ms of synchronous work served 192 req/s at 50 connections with p99 2.71 s (r1-runtime §6.7). Runtime I6
budgets **query** milliseconds (≤4 ms p95, 12 ms hard) and says nothing about CPU spent in the renderer,
`JSON.parse`, regex, or stamping. Design change: add a per-page CPU budget, an event-loop lag sampler with a
threshold that produces `RENDER_OFFLOAD_DEGRADED`, and delete D-R7's "degrade to in-process above 4 workers"
or bound it by measured page cost — the degradation path is the exact failure T22 measures.

**2.5 — Rate limit derived from capacity.** Platform PD8 sets `rate=20r/s` per tenant. Runtime measured 192
req/s box-wide for a four-source page (r1-runtime §6.7, `/trace`, 50 connections). Design change: per-tenant
rate must be derived (`page_cost × cores ÷ safety`), and the SDS must state a maximum tenants-per-box at the
declared page budget. 20 r/s × the 50-tenant demo fleet RT D-R4 sizes the LRU for = 1,000 r/s of *allowed*
traffic against a 192 r/s measured ceiling — 5.2× over.

**2.6 — The download accounting unit and the event schema.** Measured: one plain request plus three `Range`
requests produced `uses = 4` (r1-platform §6 T16); `Range: 100-200` on an 18-byte file returns **416 with a
197-byte body** (r1-security §6.4), i.e. a request can be answered, consume a use, and deliver zero bytes.
Design change: one unit (redemption), one place that increments, and an explicit rule for a request that
returns 416/404/503 after the consume. Also decide the event schema: the DDL has `outcome IN
('ok','denied_*')`, `ranged`, and **no** `jti` and **no** `kind` **(DDL)**, while Security DS-5 adds both.

**2.7 — A memory budget.** Measured components: 19 MiB per in-flight argon2 verify at `m=19456` (r1-security
§6.7), 185 KB per open handle (`200 handles … 36.1 MB`, r1-data-model M11), 10–30 MB per worker (r1-runtime
D-R7), 10.76 MiB idle app (r1-platform T21), `--max-old-space-size=768` inside a 1 GB limit (PD8). Design
change: one budget table in the SDS and a container limit derived from it. With Security's own parameters the
ceilings sum to 983–1,063 MB against a 1,024 MB limit; with Data Model's frozen `m=65536` they sum to
1,343–1,423 MB. The limit as chosen cannot hold the design as specified.

**2.8 — Snapshot semantics for the two static SKUs.** Not a measurement but a measured consequence:
IDEA §5.1 pre-flight 3 states that parameterised Data Sources are frozen at their default parameters, while the
same section claims the export is reproducible from the same DB state — Runtime A1 shows those two sentences
contradict each other whenever a source's parameter appears in a rendered link. Design change: one snapshot file
per public source (`{source, params, rows, hash}`), the frozen params recorded in the manifest, and Platform's
refusal code 22 adopted as the single rule for a parameterised source that backs a linked route. The Astro SKU's
`u_*` rows also need this format; DM's Q1 is unanswered.

**2.9 — Watermark execution and cache policy.** Measured: 51.9 ms cold / 23.4 ms warm to stamp 40 pages; bytes
+60%; per-purchaser text forks output so hit rate ≈1 (IDEA §7.8); the cache table has no LRU columns **(DDL)**.
Design change: stamp in a worker with a hard wall-clock budget (Platform A4's 2 s), key as specified, and pick
one bounded policy — byte-ceiling LRU needs `last_used_at`/`hits` columns, and per-purchaser specs are better
served by regenerate-on-demand with zero retained copies.

**2.10 — Indexes the publish gate will demand.** Measured: a child FK column with no index scans at 21.55 ms
vs 0.43 ms indexed (50×, M18); an unindexed `ORDER BY` is 6,714 µs vs 6.7 µs (r1-runtime §6.4), and D-R6
refuses to publish a source whose plan contains `SCAN`. Design change: the DDL runner must auto-create an
index for every FK child column and for every `order`/`where` column a `query` source publishes — otherwise
the publish gate refuses every realistic client table and the operator's only remedy is a manual index the
admin UI cannot create.

**2.11 — `bytes_sent` is a decision, not a column.** Measured: after `X-Accel-Redirect` the app's response body
is discarded and no completion callback fires (r1-security A-3); nginx's `$body_bytes_sent` is the only
trustworthy figure (r1-platform §3.9). Design change: either ingest the access log into
`cms_download_event.bytes_sent` (a pipeline nobody has scoped) or drop the column. Leaving
`NOT NULL DEFAULT 0` in the DDL while knowing it is a lie is the worst of the three.

**2.12 — Storage for the runtime's own contracts.** **(DDL)** `control.sql` has no revision row, so D-R3's
invalidation is unsupported; `cms_datasource` has no `cost_*` columns, so D-R6's publish measurement has
nowhere to write; `cms_page` has `css` but no `body_css`, no `rev`, no `body_sha`, so the CSS layer and the
round-trip diff key do not exist; `cms_page.slug` is not unique, so `site.page(slug)` (D-R5) is ambiguous on a
nested site (`/blog/hello` and `/about/hello`). Design change: amend `schema/*.sql` and the ER diagram before
they are declared 1:1, or amend the runtime contracts. Whichever moves, one of them must.

---

## 3. New objections raised by the measurements themselves (things that only became visible after round 1's evidence)

**N1 — `VACUUM INTO` on a render handle plus a public media directory is a whole-tenant database dump.
BLOCKER while any code path can run SQL there, major otherwise.**
The chain needs two separately-measured facts. (i) A readonly handle may run `VACUUM INTO '<arbitrary path>'`
— allowed, 49.0 ms for an 8.6 MB tenant DB (r1-runtime §6.3, A3). (ii) nginx serves any file reachable under
`content/public/`, including through a symlink that points anywhere — `/etc/hostname` returned 200, 13 bytes
(r1-platform §6 T11g). Scenario: any code executing on the render handle writes
`VACUUM INTO '/srv/data/tenants/acme/content/public/dump.db'`, then `GET /media/dump.db` returns the tenant's
whole DB: argon2 hashes, buyer emails, `order_ref`, IP hashes, form submissions. No cross-tenant boundary is
crossed, so every tenancy invariant in every paper stays green. The only thing that closes it is the absence of
any SQL-executing extension point (`function` is already out of the DDL, `kind IN ('view','query')`), and no
paper states that absence as the control. Design change: deny `VACUUM INTO` and `ATTACH` on the render class
(authorizer or connection-level allowlist), and add a test that a render handle cannot create a file anywhere.

**N2 — The XSS surface moved from `<script>` to `data-props`, and nobody noticed. MAJOR.**
Measured: GrapesJS deletes `<script>`, comments and `<style>` from a body, but preserves an island as
`data-island="cart" data-props="{&quot;sku&quot;:&quot;x&quot;}"` and strips `data-gjs-type` unless the type
is registered (r1-runtime §6.8). Runtime I8 therefore bans the tag that Security DS-11's CSP nonce machinery
was written to rewrite — the surviving script surface is the island hydration payload, which is stored
tenant-authored content. Scenario: a page body carries
`data-props='{"x":"</script><script>fetch(...)</script>"}'`; SSR un-escapes it into the hydration JSON and the
payload breaks out of its `<script type="application/json">`, executing as first-party script on an origin
where the admin session cookie is also sent (cookies ignore ports, r1-security §6.8). Severity major; blocker if
the demo is path-prefixed. Design change: define the island props serialiser (JSON-encode, escape `<`, `>`, `&`,
U+2028/9), a per-island props schema, and a CSP that does not rely on `unsafe-inline`. Nothing in R1 specifies
the serialiser, and Security's nonce contract assumes a script tag that cannot exist.

**N3 — A code can be exhausted without delivering a byte. MAJOR.**
`Range: 100-200` against an 18-byte file returns 416 **with a body** (r1-security §6.4), and every request
increments `uses` under the current flow (r1-platform T16 measured 4 uses for one download). Scenario: three
out-of-range or aborted chunk requests — a viewer reconnecting, a proxy retrying, or a buyer's failing network
— exhaust a 3-use code with zero bytes served, and the admin panel shows three successful redemptions. Support
cannot distinguish this from theft, and the reconciliation (DM6 E1) counts the same three as `ok`.

**N4 — Non-Latin filenames 500 the download route, and the cp1252 decision was applied to the wrong surface.
MAJOR (blocker for any CJK/Arabic client).**
Measured: building `Content-Disposition: attachment; filename="报告.pdf"` throws
`Cannot convert argument to a ByteString` (r1-security §6.6); the same class of character was carefully
sanitised for watermark text under D23, and left unhandled on the one route that echoes an original filename
(IDEA §7.4 step 4). Scenario: a Japanese publisher uploads a book, a buyer redeems a valid code, and gets a 500
from the header builder — the watermark path never runs, so the failure is attributed to gating.

**N5 — The cheapest isolation option is measured unavailable. MAJOR.**
A WAL database needs a writable directory even for `readonly:true`; a `:ro` bind mount fails with
`SQLITE_READONLY_DIRECTORY` (r1-data-model M16). Every "just mount the tenant dir read-only for the render
process" mitigation that the debate will otherwise assume is therefore off the table, which removes the middle
option between "one process with permissions" and "a process per tenant". Design change: the SDS must say so
explicitly, because it converts Security Q4 from a preference into a forced choice.

**N6 — The declared resource ceilings exceed the container limit before a page renders. MAJOR.**
Arithmetic on measured figures with Data Model's frozen argon2 parameters (`m=65536,t=3,p=1`): 8 concurrent
verifies × 64 MiB = 512 MiB, plus the 768 MB heap ceiling, plus 64 handles × 185 KB ≈ 11.6 MB (M11), plus 4
workers × 10–30 MB, plus 10.76 MiB idle (T21) = **1,343–1,423 MB against a 1,024 MB container limit**. With
Security's parameters (`m=19456`) the same sum is 983–1,063 MB — already over at the top of the worker range.
Scenario: a modest redemption burst OOM-kills the process and takes every tenant on the box down, which is the
availability failure O10 described but now has a number and a cause.

**N7 — The page template list is a frozen enum in a protected table. MAJOR.**
`cms_page.template TEXT CHECK(template IN ('page','landing','post','index'))` **(DDL)**, and `cms_*` DDL is
refused by the runner (D8). The component registry is extensible by design; the page shell is not. Scenario:
the fifth client needs a "docs" layout; that is an `ALTER TABLE` on a protected table, i.e. a migration, i.e. an
image release we perform — for a product sold as self-service. The same shape applies to `status`
(`draft|published|hidden`) when A15 adds preview.

**N8 — Allowed aggregate traffic is 5× the measured capacity, by construction. MINOR–MAJOR (capacity).**
PD8's 20 r/s per tenant, measured against Runtime's 192 r/s box-wide for a four-source page: at the 50-tenant
demo fleet D-R4 sizes for, the edge permits 1,000 r/s. Scenario: a launch day on one demo plus normal traffic on
nine others saturates the box while every per-tenant limit reports headroom; the operator's only signal is
latency, and the only remedy is a restart.

---

## 4. Conflicts between domains that neither side can see from inside its own paper

**X1 — The FK action on `cms_asset.key` is specified as both RESTRICT and CASCADE.**
Data Model DM3: `ON UPDATE RESTRICT … is the whole trick`, measured M4 (`FOREIGN KEY constraint failed`) and
M8 (439 ms / 2,412 ms for CASCADE). Runtime §3.6.5: "`ON UPDATE CASCADE` from `u_*` to `cms_asset(key)`
genuinely fires, and a rename rewrites user rows. That is a **write to a `u_*` table** triggered by an admin
action, which must be in the same transaction and audited." Data Model cites M4/M8 for the action; Runtime's
claim rests on §6.9's `foreign_keys` default, which says nothing about which action is declared. The column can
have one action. Scenario: the schema is frozen with RESTRICT, a Builder implements Runtime's audited-cascade rename,
and the rename silently fails for every referenced asset — or the reverse, and every rename stalls all writers
for 439 ms. Severity **blocker (schema freeze)**. Architect must pick, and the loser's contract must be
rewritten in the same edit.

**X2 — The rule that fixes range-request accounting is the bypass Security rejected.**
Security DS-5: consume once per redemption, keyed by a random `jti` in the token, deduped by
`UNIQUE(jti, kind)`, and it explicitly rejects "exempt Range requests from counting — that removes the cap
entirely for anyone who sends `Range: bytes=0-`". Platform A1: "decrement only when the request has no `Range`
header or `Range` starts at byte 0". Scenario: a client sends `Range: bytes=1-` on every request; under
Platform's rule `uses` never increments and one code downloads the asset indefinitely — with `max_uses=3` and
per-tenant bandwidth caps as the only remaining limit. Severity **blocker (paid feature)**. One of the two
rules must be deleted, not merged.

**X3 — The `uses` reconciliation query will fire on every legitimate download.**
Data Model DM6 E1 defines the detector as `GROUP BY c.id HAVING c.uses <> count(e.id)` with `outcome='ok'`, and
states the alert threshold is "any row — not a percentage". Security DS-5 writes **one event per HTTP request**
(`kind ∈ {'first','range','denied'}`) while incrementing `uses` once per redemption. Scenario: the first buyer
whose PDF viewer seeks produces 1 use and 2 events; the reconciliation reports drift; within a week the alert is
muted; the only detector of `max_uses` decay is gone, which is the failure DM6 says would make `max_uses`
decorative. The DDL currently has `outcome` and no `jti`/`kind`, so Security's schema is also unimplementable
as shipped. Severity **major**. Resolution: one event per request is right for forensics; E1 must count
`kind='first'` (or a `consumed` flag), and the columns must be added.

**X4 — Three incompatible definitions of "the edge proved the tenant".**
Security DS-4: nginx `map` + `proxy_set_header` in every server block including `default_server`; the app
returns **400 `E_TENANT_HEADER`** when the header is missing, empty, or contains a comma; no edge token exists.
Platform PD1: one snippet included per `location`, header defaults to `""`, and the app honours a non-empty
header only when `X-Skunkworks-Edge` matches `SKUNK_EDGE_TOKEN`, else **421 `EDGE_TOKEN_INVALID`**. Runtime
D-R2: header honoured only if the peer is in `SKUNKWORKS_TRUSTED_PROXY_CIDRS` **and**
`X-Skunkworks-Proxy-Token` matches `SKUNKWORKS_PROXY_TOKEN`, else 404. Scenario: Platform's nginx sends
`X-Skunkworks-Edge`; Runtime's app requires `X-Skunkworks-Proxy-Token`; the header path never applies, so
host-routed tenants still work and every path-prefix demo 404s (it has no distinct `Host` to fall back to) — or
the Builders "fix" it by trusting the header, reopening the spoof. Worse, Platform T8b measures that a `location`
declaring any `proxy_set_header` of its own **drops the entire server-scope set** — so Security DS-4's mechanism
is falsified by Platform's own measurement, on `/api/`, which is exactly where the spoof was observed. Severity
**blocker (path-prefix demos and the security contract)**.

**X5 — Two incompatible DDL ASTs, both presented as the contract.**
Security §3.1 `TableSpec`: `type ∈ {text,integer,real,blob,datetime,asset}`, `ref` only to `cms_asset.key`,
`notNull?` with an optional literal default, max 40 columns, 8 indexes. Data Model DM2 `DdlOp`: seven operations
(create table, add/drop column, rename table, create/drop index, drop table), `ColumnSpec.type ∈ {TEXT,INTEGER,REAL,BLOB,NUMERIC,BOOLEAN,DATE,ASSET,PAGE,RELATION}`,
FK targets `cms_asset`, `cms_page`, `u_*`. Scenario: the Builder writes `applyDdl` to Security's signature and
Data Model's runner rejects `PAGE`/`RELATION`, or writes it to Data Model's and the admin form cannot express a
page reference; and `notNull` without a default is the exact `ALTER` that fails per my O14 measurement. Severity
**blocker (S2)**. One union must be authoritative and the other paper's §3 deleted.

**X6 — Path-prefix demos: nginx strips, the app expects to strip.**
Runtime D-R2/§3.1: the resolver matches `^/demo/([a-z0-9-]{1,32})(?=/|$)`, "the prefix is stripped by the
**app** (nginx must not rewrite)", and `tenant.prefix` is what `site.url()` prepends. Platform PD5 rewrites
`^/demo/<key>/(.*)$ → /$1` in nginx, measures `path=/whoami`, and passes `X-Forwarded-Prefix`. Scenario: PD5 ships,
the app never enters its prefix branch, `tenant.prefix` is null, `site.url()` emits unprefixed URLs, and every
link and asset on a demo escapes `/demo/<key>/` — while the demo's HTML looked correct in the editor. Runtime
§6.5 measured that Astro ignores `X-Forwarded-Prefix` and emits `/blog/a`, `/media/…` verbatim, so nothing
downstream repairs it. Severity **major (the no-DNS sales path)**.

**X7 — CSP: nonce versus hash, and the script the nonce was for does not exist.**
Security DS-11: per-request nonce, "the renderer **rewrites a per-request nonce onto every stored `<script>` at
SSR**", and it rejects hash-based CSP because a save-time hash list goes stale. Runtime I8: stored bodies contain
no `<script>` at all (measured — GrapesJS removes it). Runtime A2: a per-request nonce cannot survive export, so
every island in the static/Astro SKUs is blocked or the CSP is absent; counter-proposal is a hash computed from
the final serialised HTML at render and export. Scenario: the export ships with `Content-Security-Policy` naming
a nonce that exists only in the live response, and every island fails to hydrate on the client's box — SKUs two
and three are dead on arrival. Security's rejection targets save-time hash *lists*, not Runtime's render-time
hash, so the two papers never actually disagree on the mechanism they each think the other proposed. Severity
**major (S4/export)**. Pick hash-at-render; delete the nonce-rewrite contract.

**X8 — A single stale tenant blocks the whole fleet's start, and the 503 branch is unreachable.**
Data Model DM11: a `site.db` below the required `user_version` serves `503 DM_E_SCHEMA_STALE` and triggers a
lazy repair for that tenant. Platform PD3: `app` declares
`depends_on: {migrate: {condition: service_completed_successfully}}`, `migrate` exits non-zero on failure and
`restart: "no"`. Scenario: one tenant's DB is locked or corrupt at deploy; `migrate` exits 1; compose never
starts `app`; every tenant is down and no 503 is ever served. Severity **major**. One of the two failure
semantics has to go — either `migrate` continues per tenant and reports, or DM11's 503 is deleted.

**X9 — The backup runs on the connection class that must not have `VACUUM INTO`.**
Platform PD7: `backupTenant(key)` "runs `VACUUM INTO` on a read connection". Runtime A3: `VACUUM INTO` from a
readonly handle is a full-DB exfiltration primitive and must be denied. Scenario: closing N1 means denying
`VACUUM INTO` on render handles; PD7 then breaks, and the obvious repair is to grant it back, reopening N1.
Severity **major**. Resolution: a third connection class (`exporter-write`) owned by the backup/export process,
never in the render pool, never in a transaction.

**X10 — Four env namespaces, two busy timeouts, and table names that do not exist in the DDL.**
Data Model uses `SKW_*` (`SKW_DATA_DIR`, `SKW_DB_POOL_MAX`, `SKW_DB_BUSY_TIMEOUT_MS=5000`, `SKW_CODE_PEPPER`,
`SKW_FLEET_MODE`). Security uses `SK_*` (`SK_DOWNLOAD_TOKEN_KEY`, `SK_SESSION_KEY`, `SK_IP_HASH_KEY`,
`SK_RATE_KEY`, `SK_ARGON2_MAX_CONCURRENT`) and names no code pepper at all. Runtime uses `SKUNKWORKS_*`
(`SKUNKWORKS_PROXY_TOKEN`, `SKUNKWORKS_TENANTS_DIR`, `SKUNKWORKS_SOURCE_HARD_MS`). Platform uses `SKUNK_*`
(`SKUNK_EDGE_TOKEN`, `SKUNK_TENANT_KEY`, `SKUNK_DB_BUSY_TIMEOUT_MS=2000`). Separately, Security DS-11 writes
sessions to `control.db.sessions` and Platform resolves against `domains`, while the DDL ships `session` and
`domain` (singular) **(DDL)**. Scenario: install.sh generates `SKUNK_*`, the app refuses to boot because
`SKW_CODE_PEPPER` is unset (r1-data-model §3.2, pepper contract item 5: refuse to start), and the operator's only clue is a variable
name that appears nowhere in the bundle. Severity **major (config drift, fail-closed)**.

**X11 — Two frozen argon2 parameter sets.**
Data Model DM12/§3.2.2: `argon2id(m=65536, t=3, p=1)`, frozen, verify 70 ms–1.13 s across eight runs (M15).
Security DS-6/§6.7: `m=19456, t=2, p=1`, verify 27.0 ms, 37.1 verifies/s/core, 19 MiB per verify, and the
semaphore is sized on 19 MiB. Scenario: the SDS adopts Data Model's parameters because DM12 owns the column and
states them as frozen (the DDL comment names argon2id but no parameters **(DDL)**), and the 8-slot semaphore
silently reserves 512 MiB instead of 152 MiB — N6 becomes an OOM under a burst. Or Security's win, and the
redemption latency budget quoted in DM12 is 3.4× too pessimistic — harmless there, but the two documents cannot
both be "frozen". Severity **major**. One set, one place, and the semaphore recomputed from it.

---

## 5. The smallest set of decisions the Architect must make to unblock the SDS (ordered, with the cost of deciding late)

D1–D3 are strictly blocking: no interface can be written before them. D4–D7 block one slice each and can run in
parallel, but each gets more expensive with every week it slips.

**1. One tenancy/trust contract.** One header name, one edge-proof mechanism (edge token *or* proxy token, not
both), one env prefix, one resolution order, one status code per failure (unknown host, missing proof, malformed
value). Supersedes Security DS-4, Platform PD1, Runtime D-R2; the loser's text is deleted, not reconciled.
*Blocks:* every route, the nginx snippet, health, the admin listener, and the four papers' invariants P1/S-8/I10.
*Cost late:* nothing agrees — Platform's nginx sends a header Runtime's app rejects, so path-prefix demos 404 or
the Builders trust the client header to make them work, which re-opens the measured spoof. Days lost now; a
security regression shipped if decided by whoever hits it first.

**2. The bundle contract.** What an exported CMS bundle contains and who creates `control.db`: `install.sh`
runs the migration, seeds a `tenant` row with `mode='production'` (a column, not an env var — the prefix is
D1), a `domain` row, and the first `user_account` from
`.env` (`ADMIN_EMAIL`, one-time password), then starts `migrate`. Decide single-tenant mode (`SKUNK_TENANT_KEY`,
Host ignored) versus a seeded domain row. *Blocks:* §1.1's flagship SKU, Platform PD3/PD9, A1, and the health
contract (a zero-tenant map must fail `/readyz`).
*Cost late:* schema and `.env` cannot be back-filled — there is no stored admin identity to migrate, and
`tenant.mode` has no safe default (`demo` requires `demo_expires_at` **(DDL)** and expires the site the client
bought).

**3. The FK action and rename semantics on `cms_asset.key`.** RESTRICT (DM3) or CASCADE (Runtime 3.6.5), and
what `cms_asset_alias` is for. *Blocks:* every `u_*` table's DDL, the asset form, the export's portability
claim, and X1.
*Cost late:* a schema change to every tenant DB after client DBs exist, plus either a broken rename button or a
439 ms write stall on every rename, plus an alias table whose rows nothing writes.

**4. The download accounting unit, event schema, and `bytes_sent` source.** One increment per redemption keyed
by `jti`; `cms_download_event` gains `jti` and a consume marker (or Security's `kind`); E1 counts consumed
events only; `bytes_sent` is either dropped or fed from the nginx log. *Blocks:* S3, the paid feature, the E1
detector, and the export manifest.
*Cost late:* a schema change to the table that holds live codes, an accounting rewrite in the one flow that
takes money, and a shipped bypass (X2) or a muted detector (X3).

**5. The repeat-region contract for stored page bodies.** The attribute grammar
(`data-source`/`data-limit`, child template, escaping, empty/overflow behaviour), whether the repeat lives in
`body_html` or a companion table, and how the three exporters materialise it. *Blocks:* S4, the block registry,
the SSR renderer, and all three exporters.
*Cost late:* rewrite of everything that reads `body_html`, plus a stored-markup migration for every page already
authored — the single most expensive late decision in the set (A3).

**6. The isolation claim and the process boundary.** Either a worker/process boundary for tenant-executed code
(or none exists) or an explicit SDS sentence that isolation is a permission boundary, with the three code paths
that can break it named. *Blocks:* §9's wording, the function-source decision, the watermark worker, and B6/B7.
*Cost late:* every invariant statement in the SDS is either false or unfalsifiable, and the security review
argues about adjectives instead of controls.

**7. The CSP model and the island props serialiser.** Hash-at-render for all three SKUs (live, Astro, static);
delete the nonce-rewrite contract; define the props encoding and per-island schema. *Blocks:* S4, export, and
N2.
*Cost late:* islands blocked in both export SKUs, or a stored-props XSS on the origin that carries the admin
cookie.

---

## 6. What is now settled and must not be re-opened

Each of these has at least two independent measurements or three independent papers behind it. Re-opening any of
them costs a round and buys nothing; the open questions are listed beside each so the Architect can see what is
*not* being closed.

1. **One SQLite file per tenant plus a global `control.db`** (D2). Settled by DM1's three mechanisms and by every
   paper building on it. Open: what a demo tenant is (B3) and what the export carries (A2/B9) — neither is an
   argument against per-tenant files.
2. **`VACUUM INTO` (or the backup API), never `cp`, with post-checks on the reopened copy.** Measured three
   times independently: `cp` → `no such table` / 1 row of 501 / `integrity_check: ok` (DM M1, Platform T17b,
   Runtime §6.9). Open: which connection class runs it (X9).
3. **argon2id cannot be found by equality; a keyed lookup column is required.** DM M15 (two hashes of the same
   code differ; 5,000-code scan 358–5,632 s) plus Security §6.7. `code_lookup` is already in the DDL. Open: the
   parameter set (X11) and the pepper's owner (B16).
4. **A client-supplied `X-Skunkworks-Tenant` is inert, and there is no default-tenant fallback.** All four
   papers agree (P1, S-8, I10, DS-4), and the spoof is measured (Platform T5–T8b, RT §6.6). Open: which proof
   mechanism (X4), not whether one is needed.
5. **`internal` + `X-Accel-Redirect` is the only path for gated bytes; the app is the only authoriser.** Measured
   direct hits return 404 (Security §6.4, Platform T1); the app's 200 is discarded on a missing target (T4).
   Open: how a missing target is pre-checked, and what a 416 means for the counter (N3).
6. **A `__Host-` cookie must have `Path=/`; the `Path=/d/<key>` form in IDEA §7.4 is dead.** Three papers
   independently: Security DS-10, Runtime A4, Platform A3. Open: the cookie *name* and whether the download
   cookie is scoped by tenant or by asset — not the prefix rule.
7. **A `readonly` handle is a write barrier, not a tenancy boundary.** Measured three times (DM I5/M9b, Security
   §6.1, Runtime §6.3). The replacement control is open (D6); the claim is not.
8. **The stored page body is the editor's document, verbatim — not a normalised block tree.** DM5's argument is
   confirmed by Runtime §6.8 (9/9 constructs pass-2 stable; nesting cannot be flattened). This does **not**
   settle repeat regions (A3) and must not be cited as if it did.
9. **cp1252-preserving sanitiser, not ASCII flattening** (D23). Measured on the encoder, and the alternative
   mangles `München`. Open: extending the same policy to filenames (N4) — an omission, not a reversal.
10. **Watermark failure is a denial: no un-stamped paid bytes, ever.** Non-negotiable 4 plus Security DS-7 and
    Platform A4. Open: encrypted PDFs (A12) and where the stamper runs (A7), not whether it fails closed.
11. **In-process `function` Data Sources on the render handle are not shippable.** All four papers converge
    (DM §3.5 removes the kind, Security A-5, Runtime A3, Platform A4), and the DDL already says
    `kind IN ('view','query')`. Open: whether a sandboxed kind returns, and what replaces aggregates (B2) — the
    in-process version is closed.
