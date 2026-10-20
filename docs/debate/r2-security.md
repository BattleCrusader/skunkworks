# R2 — Security

Position after round 1: the storage topology is structural, but **isolation is permission-based and must be
described as such**. Round 1 produced the same proof, measured independently in three papers, that a read-only handle is a
write barrier and nothing more; I accept all four, and I am withdrawing the invariant I wrote in R1 §1 (S-2) that claimed
otherwise while my own §6.1 showed it was false. Everything below is either a verdict on someone else's
attack, a counter-design, or a measurement — nothing is restated from R1 without a reason.

## 1. Attacks on my domain — verdicts

(table: attack | source paper | ACCEPT/REJECT/DEFER | reason | fix shape)

| # | Attack | Source paper | Verdict | Reason | Fix shape |
|---|---|---|---|---|---|
| 1 | `cms_download_code.code_hash` is argon2id (salted), so `WHERE code_hash = ?` matches nothing; redemption degenerates to a scan-verify | Data Model A1, Red Team O1 | **ACCEPT — blocker, mine** | I specified the hash as the only representation and never specified how the row is found. At 5,000 codes the scan is 358 s–1.6 h per attempt against a 600 s token; the endpoint cannot answer one request. | An indexed lookup column. Mechanism contested below (C-2 selector/verifier vs DM12 HMAC-pepper); the *requirement* is accepted either way. |
| 2 | A `{readonly:true}` handle `ATTACH`es a sibling tenant's DB and `control.db` and reads rows | Data Model A2, Runtime A3 | **ACCEPT** | Re-measured this round: acme→beta returns `buyer@beta.example`, acme→`control.db` returns the session row. `readonly` blocks writes to any attached DB and blocks nothing else. | `function` datasource kind removed in v1; render handle opened `readonly` **plus** `PRAGMA query_only=1`; in-transaction postcondition `count(pragma_database_list)=1`; DDL connections never pooled. |
| 3 | `VACUUM INTO '<path>'` from a readonly handle writes the whole tenant DB anywhere the process can write | Runtime A3 | **ACCEPT — and it is worse than stated** | Measured: a readonly handle wrote 16,384 B to `tenants/beta/planted.db` and to `content/public/backup.db`. The second one publishes the tenant's entire database as a static, cacheable file under the web root, with no write to any table. | `PRAGMA query_only = 1` on every render handle: measured to block `VACUUM INTO`, so this channel closes for one line of code. `readonly:true` alone does not. |
| 4 | `CREATE TEMP TRIGGER` survives on a pooled connection and fires inside a later request | Runtime A3 | **ACCEPT** | Measured: a temp trigger created in "request 1" fired on request 2's insert into `cms_pages` (`sink = [101]`). `readonly` permits it. | Same `query_only` (measured to block temp table and temp trigger creation); plus no pooled connection ever sees non-template SQL. |
| 5 | `__Host-dl-<key>` with `Path=/d/<key>` violates the prefix contract and is discarded by the browser | Runtime A4, Platform A3, Red Team O9 | **ACCEPT — confirms DS-10** | RFC 6265bis §4.1.3 requires `Path=/` for `__Host-`. My DS-10 already moved to `__Host-sk-dl; Path=/`; three papers converged independently, so the SDS needs no further debate. | `__Host-sk-dl`, `Path=/`, token bound to `(aid, cid, jti, iph, uah)`. |
| 6 | Admin has no defined tenant-selection path: two listeners, two Host spaces, session carries no tenant | Runtime A5 | **ACCEPT — hole in my DS-11** | My session row had `user_id` but no `tenant_id`, and nothing said which DB an admin route reads. The failure is an operator editing tenant B while looking at tenant A's page list — a cross-tenant write by a trusted user. | Session carries `tenant_id` + `role`; `resolveAdminTenant(session)` is the only source; URL shape `/admin/t/<key>/…`; admin listener ignores `Host` and `X-Skunkworks-Tenant` for tenant resolution, and returns 421 if a tenant header is present at all. |
| 7 | `cms_asset.storage_path` is row data exposed by the CRUD forms and consumed by the symlink farm → `/media/<key>.txt` serves `/etc/passwd` | Red Team O5 | **ACCEPT — major** | My S-6 defended the *tree*, not the *column*. Platform measured nginx following a link to `/etc/hostname` (200, 13 B). The exploit runs no DDL and writes a normal audit row. | Per-column write policy in the CRUD generator; `storage_path`, `sha256`, `uses`, `code_hash`, `is_public`, `gated` immutable; farm target derived from `sha256` only (hex-validated), never from `storage_path`. |
| 8 | Tenant identity trusted from the header ahead of `Host`, and the admin port is reachable | Red Team O6 | **ACCEPT — half-fixed in R1** | DS-4 fixes the public listener. Nothing in my paper bound the admin listener to the compose network, and Red Team is right that `expose` vs `ports` is a security control owned by the compose file. | `expose` only (Platform PD3 already does this), nginx the only published surface, 421 on a tenant header from a non-proxy peer, and a `docker compose config` audit in CI. |
| 9 | One gated download spends one `use` per HTTP request (uses=4 after 3 ranges) | Platform A1, Red Team O8 | **ACCEPT finding / REJECT fix** | Measured again: 8 parallel ranges on `max_uses=3` drive `uses` to 3 and deny the last five. Platform's fix (count only when `Range` is absent or starts at 0) is defeated by omitting the header: every request then mints a fresh use, so the cap becomes client-controlled. | `jti` claim (DS-5). Measured: 8 parallel ranges → `uses=1`, one `first` event, then 8 further ranges → `uses` still 1 with 8 `range` events recorded. |
| 10 | The admin IP allowlist makes the sold bundle unsupportable (dynamic IPs, CGNAT, phones) | Platform A3 | **ACCEPT** | I defended the allowlist in IDEA §9 without costing it. A client who cannot log in cannot fix it themselves, which breaks the platform non-negotiable that a client runs their box without us on the phone. | Allowlist becomes opt-in and empty in exported bundles; when it is empty TOTP is mandatory, idle drops to 15 min; per-IP `limit_req` stays at the edge. |
| 11 | Export carries live code hashes, buyer emails and other purchasers' watermarked files | Red Team O3 | **ACCEPT — major** | I defined `cms_download_code`, `cms_download_event` and the per-purchaser watermark cache key; none of the three had an export class, and IDEA §5 ships `content/` wholesale. | Export manifest with a PII class per table; codes, events and `content/protected/wm/**` excluded from every bundle; submissions only behind an explicit flag; codes reissued at install if a CMS bundle keeps gated downloads. |
| 12 | Watermark stamping is 51.9 ms of synchronous CPU on the shared loop; a stall is every tenant's latency | Platform A4, Red Team O10 | **ACCEPT** | Fail-closed is only safe if the failure is bounded. On the loop, a 40-page stamp blocks 20/20 unrelated requests for 510–514 ms (Platform T22). | Stamp in a worker or child with a 2 s wall budget; timeout is `503 E_WATERMARK_FAILED`, never an un-stamped serve. |
| 13 | The watermark render cache is per-purchaser with no eviction, so it is an archive | Red Team O12 | **ACCEPT — mine** | Per-purchaser `spec_sha` makes the hit rate ≈1 and nothing deletes a render; 1,000 buyers × a 5 MB book × +60% is ~8 GB no policy removes. | Delete renders at token TTL + 24 h; LRU to a byte ceiling; the cache exists to keep `Range` byte-stable, not to store. Re-render is 52 ms, so deletion is cheap. |
| 14 | Encrypted PDFs are denied by fail-closed although they are not corrupt | Red Team O16 | **ACCEPT** | "Corrupt" and "cannot be stamped" were conflated. The buyer's product becomes 100% undeliverable and the admin sees our error code, which reads as our bug. | Detect `isEncrypted` at upload, mark `watermarkable=0`, and refuse to *gate* the asset at issue time with the reason in the UI — fail closed at the earliest point, not the worst one. |
| 15 | Argon2id parameters frozen at `m=65536, t=3, p=1` (64 MiB) | Data Model DM12.2 | **ACCEPT one-verify rule / REJECT the freeze** | Measured: 8 concurrent verifies at 64 MiB peak at 687 MB RSS, 16 at 1.44 GB, inside Platform's 1 GB container with a 768 MB heap cap. That OOM kills every tenant on the box — a worse failure than a weaker hash. | One budget for params and concurrency: `max_concurrent × m ≤ 25%` of the container. See §3 X-3 for the numbers. |
| 16 | Tenant-plane audit lives in the tenant's own writable file | Data Model DM7 | **ACCEPT the split / REJECT "no second write"** | A hash chain cannot detect truncation: measured, deleting every `cms_audit` row leaves a vacuously valid chain, and deleting the tail leaves a valid prefix. The tenant admin can edit that file through the CRUD forms. | Chain the rows **and** write one seal row per tenant per day into `control.db` (measured 455 µs, 32 KB/tenant/year). Detects edit, truncation and deletion. See C-1. |
| 17 | A per-response CSP nonce cannot survive export | Runtime A2 | **DEFER — Architect ruling** | Runtime is right about export and wrong about live: a live CMS render is `no-store`, so a per-request nonce never leaves the response. I am right about live and had no export answer. | One function, two modes: `cspFor(html, mode)` — nonce for `live`, SHA-256 hash for `static`/`astro`. The nonce is injected at SSR and never stored, so the round-trip gate is untouched. |
| 18 | A path-prefix demo shares the parent origin with admin; tenant-authored JS can fetch an admin page and read the CSRF token | Red Team O9 | **ACCEPT** | HttpOnly blocks `document.cookie`, not requests, and same-origin means the demo page can read the admin page's HTML and lift the token out of the DOM. Port-based `Origin` equality saves a separate-port admin, not a same-port path demo. | Demos live on a host that serves no admin. See C-4. |

## 2. My counter-designs for the other domains (at least 3: claim | counter-design | severity | evidence needed)

### C-1 — Data Model: the tenant-plane audit needs a seal in `control.db`, not a second row per action

**Claim.** DM7 splits audit into `control.db.audit_log` (fleet) and `site.db.cms_audit` (tenant) and forbids
any action writing to both, because two sources of truth would disagree. The split is right for cost: DM7
measured that `busy_timeout=0` lost 150 of 200 writes under four writers, so putting content edits on the
file that answers every request is a fleet-wide bottleneck.

**Failure the split leaves open.** `site.db` is the file the tenant owns, uploads, downloads and — per
Red Team O5 — can edit row-by-row through the CRUD forms. An audit table in that file is not evidence
against the tenant's own admin. A hash chain fixes in-place edits only; it cannot fix deletion, because a
shortened chain is still a valid chain. Measured in M7: after deleting all 10,000 rows, `verify()` returns
`mismatch=null`.

**Counter-design.** Keep DM7's split, chain `cms_audit` with `(prev_hash, hash)` exactly as my R1 §3.1 requires
for `audit_log`, and write **one** additional row per tenant per day into `control.db`:
`audit_seal(tenant, day, rows, head, PRIMARY KEY(tenant, day))`. The seal is not a per-action row, so DM7's
objection (two rows for one action, possibly disagreeing) does not apply — it is a *digest*, and a missing
or mismatched digest is itself the alert. Verification is a query, not a job: compare `count(cms_audit)`
and the recomputed head to the seal for that day.

**Severity: high** — non-negotiable 3 says every privileged action is auditable with actor and
before/after. Without the seal, "auditable" means "auditable until the tenant edits the file", and the
first place that matters is a chargeback or a departing employee, months after the fact.

**Evidence needed.** Already run (M7): 10,000 rows chained in 36 ms inside one transaction, verified in
17 ms, seal written in 455 µs, 32.1 KB per tenant-year. Attacks: in-place edit detected at row 5000 by the
chain; tail deletion (`rows=9990` vs `seal.rows=10000`) and full deletion (`rows=0`) detected by the seal
alone. What still needs measuring is the *end-to-end* case: delete a row through the admin CRUD form and
assert the next day's seal verifier flags the tenant rather than the tenant's own UI.

### C-2 — Data Model: replace `code_lookup = HMAC(pepper, code)` with selector/verifier

**Claim (DM12).** Redemption needs an indexable column: `code_lookup TEXT UNIQUE` =
`hex(HMAC-SHA256(SKW_CODE_PEPPER, normalized_code))`, alongside the argon2id `code_hash`. DM12's alternative
4 rejects a plain SHA-256 lookup because "a DB leak then allows an offline dictionary over the 60-bit space
with no server secret involved", so the pepper is the thing that makes the column safe.

**Where the pepper argument actually lands.** If outstanding codes must keep working after export,
`SKW_CODE_PEPPER` has to travel in the bundle's `.env` beside `data/site.db`, and DM12's "a stolen file
alone is not enough" is false for every sold instance; rotating it on export is not available either,
because `code_lookup` cannot be recomputed without the plaintext code. If instead the export projection
excludes `cms_download_code` entirely — which §1 row 11 requires, and which is the only defensible PII rule
— then the pepper never ships and the HMAC mechanism is adequate as a lookup. So its safety rests on two
things that are not properties of the mechanism: a projection rule that must hold for every export path
forever, and a fleet-wide secret that must never rotate. DM12's own open question 5 ("who owns
`SKW_CODE_PEPPER` rotation?") is a symptom of the second. My objection is narrowed to those two, and the
selector removes both at the cost of four characters.

**Counter-design.** Split the code instead of keying it. A 16-character Crockford code is
`<selector:4><secret:12>` = 20 + 60 bits. Store `code_selector` plaintext (unique, indexed) and
argon2id over the **full 16 characters** in `code_hash`. Redemption: index seek on the selector
(2–5 µs measured over 5,000 rows), then one argon2 verify of the whole code against that row. Properties:

- No server secret is involved in lookup, so nothing has to be exported, rotated or protected beyond the
  argon2 hash itself. The secret-management surface shrinks by one fleet-wide key.
- A stolen file contains a 20-bit selector and an argon2 hash of a 60-bit secret. Offline cost measured at
  4.46×10⁸ core-years (`m=19456`) to 3.45×10⁹ (`m=65536`) — the file alone is genuinely not enough.
- Unknown-selector and wrong-verifier must be indistinguishable: one uniform `401 E_CODE_INVALID`, one
  dummy verify at the same params, one event row. That is the whole security obligation, and it is
  testable.
- The rate-limit bucket key becomes `code_selector`, which removes my DS-6 need for `SK_RATE_KEY`
  (a second secret I invented in R1 purely to name a bucket).

**Cost, honestly.** Codes grow from 12 to 16 characters (typed, and shown once); 5,000 issuances hit 11–12
selector collisions in the 2²⁰ space and need a retry loop (measured); and a selector tells anyone holding
the file how many codes a tenant issued — business intel, not a break. If a client insists on 12
characters, the secret part drops to 40 bits and the design collapses back to needing a pepper; that is a
product decision, not a crypto one.

**Severity: medium.** Neither design is breakable offline at 60 bits; the difference is one fewer
fleet-wide secret to protect and rotate, and no dependence on an export-projection rule for the lookup
column's safety.

**Evidence needed.** (a) The enumeration test: 1,000 requests with random selectors, one with a valid
selector and a wrong secret — same status, same body, and a wall-time delta under the noise floor
(the dummy verify must use the *same* params; at 12.8 vs 118 ms a mismatched dummy is a beacon).
(b) The issue path: 100,000 codes generated, collision rate and retry count, to confirm the 2²⁰ selector
space holds at a real tenant's scale. (c) A UX test of a 16-character code on a phone keyboard.

### C-3 — Runtime: `worker_threads` is a latency control, not a containment boundary; the only containment available is a permission-model child with no addons

**Claim (Runtime D-R7, A3).** Sources measured at ≥0.5 ms are executed in a per-tenant `worker_threads`
worker "with the same readonly handle", and Runtime lists this as fix option (a) for the tenant-isolation
break: "run function sources in a worker whose `process.cwd()` is the tenant's content dir with an fs
policy, plus an `ATTACH`-denial test".

**Failure.** A worker thread shares the process, the uid, the file descriptors and the address space. It
has no fs policy and no `cwd` containment — `process.cwd()` is advisory, not enforced. A worker with "the
same readonly handle" can `ATTACH` a sibling tenant exactly as the main thread can (M1). Describing it as
containment would put a false sentence in the SDS, which is the failure mode I care about most.

**Counter-design.** If tenant-authored code must run, run it in a **child process** under Node's permission
model, and do not give it a database handle:

```
node --permission \
     --allow-fs-read=<tenant content dir> \
     [no --allow-fs-write] [no --allow-child-process] [no --allow-addons] \
     runner.mjs        # receives a query spec, returns rows over IPC
```

Measured (M4), and the result is not the one I expected:

- Under `--permission` **without** `--allow-addons`, `better-sqlite3` cannot even load:
  `ERR_DLOPEN_DISABLED: Cannot load native addon because loading addons is disabled`. With SQLite
  unloadable there is no `ATTACH` and no `VACUUM INTO` — the two primitives that defeat every other control
  are simply absent.
- Under `--permission` **with** `--allow-addons`, Node prints its own warning ("could invalidate the
  permission model") and it is right: `fs.readFileSync` of a sibling tenant is `ERR_ACCESS_DENIED`, but
  `ATTACH` to that same file **succeeds and returns rows**, `ATTACH control.db` succeeds, and `VACUUM INTO`
  writes into another tenant's directory. SQLite's C VFS does its own `open(2)`; the permission model
  patches Node's `fs`, not the kernel.

So the boundary is real only in the configuration where the child cannot hold a database at all. That is
not a limitation to work around — it is the design: **tenant code gets rows, never a handle.** It also
means a `function` datasource cannot run SQL, so its useful surface shrinks to post-processing rows the
resolver already fetched. My recommendation is therefore the same as Data Model A2's: drop `function` from
v1 and extend the `query` spec's operator set (count/sum/group-by) instead.

**Severity: high.** Runtime's fix, as written, would be recorded in the SDS as containment and would not
be. The correct sentence is shorter and costs one feature.

**Evidence needed.** A test that spawns the child with the flags above and asserts each of the six
attempts in M4 fails or succeeds as listed; plus a test that the child's IPC payload is schema-validated
before it reaches the renderer (a compromised child returning 10⁶ rows or a 50 MB string is a DoS inside
the parent). Also unmeasured: whether a native addon loaded in the *parent* can be reached from the child
through a shared `SharedArrayBuffer` — I assume not, and the design does not rely on it.

### C-4 — Platform: a path-prefix demo must not share an origin with the admin, which costs one DNS record

**Claim (Platform PD5, IDEA D7/§3.1).** Path-prefix demos exist so a demo needs "no DNS and no cert": one
`location /demo/`, a `map` on `$request_uri`, a tenant row. The demo site therefore lives at
`company.com/demo/acme/`, on the same host and port as the admin at `company.com/admin`.

**Failure.** A demo tenant's page body is tenant-authored HTML with JavaScript in it (that is the product,
IDEA §8). Same origin means: it can `fetch('/admin/pages')` with the operator's `__Host-sk-sess` cookie
attached; CORS does not block reading a same-origin response; the admin page contains the CSRF token
because the admin UI must render it; so the demo page reads the token and posts a privileged change. My
DS-11 CSRF control is bound to the session and compared against `SK_ADMIN_ORIGIN` — and in this
deployment the origin *is* the admin origin, so the comparison passes. Red Team O9 reached the same place
from the cookie direction; the CSRF-token direction is worse because it defeats the control I added.

A separate **port** does save it (`Origin` carries the port, so `https://company.com:443` ≠
`https://company.com:8443`), but only while the demo and the admin are on different ports — and a
path-prefix demo on a non-default port is not a URL anyone will hand a prospect.

**Counter-design.** Demos get one host of their own: `demos.company.com/demo/<key>/`. One DNS record, one
cert, **no per-demo config** — Platform PD5's `location`, `map`, `rewrite` and `proxy_set_header` block move
unchanged, and PD5's "adding a demo changes no config" property survives intact. Admin stays on
`admin.company.com` (or the apex with no demo paths). The rule for the SDS: **a host that serves
tenant-authored HTML never serves the admin listener**, and the admin listener rejects any request whose
`Host` is a demo host.

**Severity: high.** It is privilege escalation from "can edit a demo page" to "can mint an admin", and it
is reachable by a *prospect's* tenant against the platform operator — the exact boundary non-negotiable 1
is about.

**Evidence needed.** A browser test is required and this box has none (§R1 Q8): load a demo page containing
`<script>fetch('/admin/pages').then(r=>r.text()).then(t=>/* extract csrf */)</script>` on the shared host and
assert the follow-up POST is 403. Then the same test against `demos.company.com` and assert the response
is unreadable (cross-origin, no CORS grant) so the token cannot be lifted. Note the cookie *is* still
attached — `demos.company.com` and `admin.company.com` are same-site, so `SameSite=Lax`
does not suppress it — and that is why the separation only works because (a) SOP blocks reading the admin
page and (b) the `Origin` check rejects the demo origin on the POST. The server-side half is testable
today: a POST to the admin listener with `Origin: https://demos.company.com` must be 403 regardless of
session.

### C-5 — Platform/Runtime: one header and one env namespace, or the builder wires the wrong one

**Claim.** Platform PD1 injects `X-Skunkworks-Edge: <token>` and clears `X-Skunkworks-Tenant`; Runtime D-R2
requires `X-Skunkworks-Proxy-Token` plus `SKUNKWORKS_TRUSTED_PROXY_CIDRS`; Platform PD5 sets the tenant
header from a `map`; Runtime D-R2 calls the same env `SKUNKWORKS_PROXY_TOKEN`. Four papers, four naming
schemes for the same three secrets (measured by grep, M8): 38 distinct env-var names across the four papers,
with four concepts carrying two spellings each (`CONTROL_DB`, `TENANTS_DIR`, `DB_BUSY_TIMEOUT_MS`,
`TENANT_HEADER`), and the download token key existing as both `SK_DOWNLOAD_TOKEN_KEY` and
`DOWNLOAD_HMAC_KEY`.

**Failure.** Two different header names for the edge token means whichever the app checks, the other is dead
config. A builder who implements Platform's snippet and Runtime's check gets a fleet where every request
is 421 (loud, recoverable) — or, worse, implements Platform's *empty-header default* and Runtime's *trusted
CIDR* and concludes the token is redundant, leaving the CIDR as the only factor, which is a single
misconfigured `proxy_set_header` away from caller-controlled tenancy.

**Counter-design.** One prefix (`SK_`), one header (`X-Skunkworks-Edge`), one token (`SK_EDGE_TOKEN`), and
the CIDR check as a *second* factor that is never load-bearing alone. The app's boot sequence fails if any
required var is absent, and a single `env.schema.ts` (zod) is the only place a name appears. The canonical
table is 14 rows, not 38, because seven of the current names are aliases.

**Severity: medium** (configuration correctness, loud failure) **escalating to high** for the edge token,
because a weaker-than-specified check there is caller-controlled tenancy — the defect this whole round is
about.

**Evidence needed.** A `grep -rE '\bSK_?[A-Z_]+' docs/sds` that returns only names in the canonical table,
and a boot test that deletes each required var in turn and asserts the process refuses to start with a
message naming it. Cheap, and it is the only defence against documentation drift in a 14-row contract.

## 3. Conflicts I detect between OTHER domains (proposed resolution)

**X-1 — Data Model DM3 (`ON UPDATE RESTRICT`) vs Runtime 3.6.5 (`ON UPDATE CASCADE` fires and rewrites `u_*` rows).**
DM3 makes a referenced asset key immutable by declaring the FK `ON UPDATE RESTRICT`; Runtime's contract
requires CASCADE, argues that a `u_*` rewrite triggered by an admin action must be "in the same
transaction and audited", and cites a measurement showing `foreign_keys` is on by default (true, but that
only proves the pragma works, not that the schema should cascade). Both cannot hold.
**Resolution: DM3 wins.** A rename that rewrites 200,000 user rows under a write lock (439 ms settled,
2,412 ms inside the inserting transaction — DM M8) is a self-inflicted outage, and it also means the
rename's audit row cannot describe what changed without a diff of every referencing table. Runtime's real
requirement — that any write to `u_*` is transactional and audited — is satisfied by the two-step (alias
row + re-point through a declared operation) instead.

**X-2 — Data Model DM10 (DDL connections never pooled) vs Runtime D-R4 (one readonly LRU pool, refcounted).**
Runtime specifies exactly one pool and never mentions the write path; DM10 requires a connection that ran
DDL to be discarded. The gap is where the admin's writes live, and a builder reading only Runtime will put
admin writes on the render pool.
**Resolution: two named pools in the SDS.** `readPool` (Runtime's LRU 64, `readonly:true` + `query_only=1`,
`foreign_keys=1`, `busy_timeout`) and `writePool` (admin only, read-write, `foreign_keys=1`, never handed to
a render, connections discarded after any DDL or after any statement not emitted from a template). The
refcount belongs to `readPool`; a discarded `writePool` connection has no refcount to leak.

**X-3 — Data Model DM12.2 (argon2 `m=65536,t=3`) vs Platform PD8 (1 GB container, 768 MB heap) vs my DS-6 (8 concurrent verifies).**
Eight concurrent verifies at 64 MiB measured **687 MB peak RSS** (16 → 1.44 GB); at 19 MiB, **349 MB**. The
container is 1 GB with a 768 MB V8 cap, so DM12's params plus my semaphore is an OOM that kills every
tenant on the box. There is also a hidden cap nobody specified: `@node-rs/argon2` runs on the libuv
threadpool, so at the default `UV_THREADPOOL_SIZE=4` only four verifies are ever in flight (measured:
269.6 ms wall, 434 MB ≈ baseline + 4 × 64 MiB) and the semaphore's queue never becomes visible — the `503 E_BUSY` this control exists to
emit cannot fire.
**Resolution: one budget, three numbers.** `SK_ARGON2_MAX_CONCURRENT=4`, `UV_THREADPOOL_SIZE=4` (asserted at
boot), `m=19456, t=2, p=1` → 193 MB peak, 44 ms wall for eight concurrent requests on four lanes. That leaves
800 MB for V8, page cache and `sharp`. The hash is ~4× cheaper per verify under concurrency than DM12's
(35.5 ms vs 8.7 ms per op); the counter-argument is offline resistance, and the answer is that the code space (2⁶⁰) plus a 10-minute token is what protects the asset, not the argon2
cost — 4.46×10⁸ core-years at `m=19456` is not a number an attacker improves by waiting.

**X-4 — Data Model A2 / DM §3.5 (remove `function` from `cms_datasource.kind`) vs Runtime D-R7/A3 (worker for function sources) vs IDEA §4 (function is a documented kind).**
Three positions, and the third is the spec. DM and I want it gone in v1; Runtime wants it contained.
**Resolution: removed in v1, kind reserved, and the containment documented for v2.** The kind stays in the
enum with a `CHECK` that refuses it; a pre-existing row fails resolution with a named error rather than
returning rows. If v2 reintroduces it, C-3's shape is the only one that counts as containment: a child
process with `--permission`, no addons, rows over IPC.

**X-5 — Platform PD5 / IDEA D7 (path-prefix demo on the parent host) vs Runtime D9 + DS-11 (admin separated by origin, CSRF bound to origin).**
Resolved by C-4: demos get `demos.company.com`, admin keeps its own host. Platform's "no per-demo config"
property survives; what changes is one DNS record and one cert.

**X-6 — Platform PD1 (`X-Skunkworks-Edge`, empty default, 421) vs Runtime D-R2 (`X-Skunkworks-Proxy-Token`, CIDR, 404 `NO_TENANT`).**
Two mechanisms and two status codes for the same condition.
**Resolution: one mechanism, one code.** Header `X-Skunkworks-Edge`, env `SK_EDGE_TOKEN`, CIDR as a second
factor, and **421 `EDGE_TOKEN_INVALID`** — not 404 — when a non-empty tenant header arrives without a valid
token. 421 is correct because the request was addressed to the wrong place, and a 404 would hide a
misconfiguration that Platform's CI wants to catch loudly. A request with *no* tenant header and an
unmapped `Host` stays 404 (Runtime I2, no host-enumeration oracle).

**X-7 — Data Model 3.4 (`DM_E_DATASOURCE_PRIVATE` → 404) vs Runtime 3.3 (`SOURCE_NOT_PUBLIC` → 500).**
Both are right about different situations and both are wrong about the other's. A `/__data/<key>` request
for a non-public source must be 404 (a 403 confirms the key exists). A template that names a non-public
source is an operator error caught at publish, not at request time, and must be a **publish-time refusal
with the template and source named** — not a 500 in front of a visitor.
**Resolution: 404 at request time, publish-time refusal before that, 500 only as the last-resort catch.**

**X-8 — Platform P8 (`cms_download_event.bytes_sent` within 1% of nginx `$body_bytes_sent`) vs Platform §3.9 (the nginx log is "the only place `bytes_sent` is trustworthy") vs my A-3 (the app never sees a byte after `X-Accel-Redirect`).**
P8 is a falsifier that cannot pass as written, because the column cannot be filled by the process that
writes the row.
**Resolution: drop `bytes_sent` from `cms_download_event` in v1** and make the nginx JSON line the
authoritative record, ingested daily into `cms_download_bytes(code_id, jti, bytes, ts)`. If a dispute needs
byte counts, it needs the log, and pretending the app knows is worse than not recording it.

## 4. Revised invariants after round 1

**Isolation is permission-based, not structural.** Stated plainly, for the SDS to copy:

> Tenant isolation in this system is enforced by permissions inside one Node process, not by a kernel or
> process boundary. What *is* structural is the storage topology — one SQLite file per tenant, and no request
> value ever becomes a path segment — and it is structural only against the statement classes the DDL
> runner and the Data Source resolver can emit. It does not survive code execution inside the process.
> Therefore: `function` datasources are excluded from v1, no file under a tenant's writable tree is ever
> `import()`ed, and the render handle holds no capability that can name another file.

The four permissions, each with the test that fails if it is not held:

| # | Permission | How it is held | Failing test |
|---|---|---|---|
| P1 | No statement that names a file (`ATTACH`, `VACUUM INTO`, `VACUUM`, `.dump`) | No SQL text from a request; `TableSpec` → template-emitted DDL; render handle has `query_only=1` | A fuzzed `TableSpec` corpus of 10,000 whose emitted SQL contains no `attach` or `vacuum` token anywhere, plus `count(pragma_database_list)=1` inside every DDL transaction |
| P2 | No write outside the tenant's directory | `readonly:true` **and** `PRAGMA query_only=1` on every render handle; `readonly` alone is insufficient (M1) | `VACUUM INTO`, `CREATE TEMP TABLE`, `CREATE TEMP TRIGGER` each raise `SQLITE_READONLY` on a render handle |
| P3 | No code in the process that we did not ship | No `function` kind in v1; `import()` only for a file whose sha256 is in `deploy-manifest.json`; `content/sources/` mounted read-only | An fs audit (`fs_usage`/`strace -f -e openat,rename`) shows every write resolving under `content/media/**`; an `import()` of an unmanifested file throws |
| P4 | No caller-controlled path segment | `tenantDbPath(tenant)` is the only path construction; asset keys CHECK-constrained (DM3); farm target derived from `sha256` | A request with `X-Skunkworks-Tenant: ../beta` or `Host: ../beta` returns 421/404 and never opens a file; `find content/public -type l -lname '*..*'` is empty |

**S-1 (unchanged, strengthened).** No SQL text from a browser, and no statement class the generator cannot
emit. Added: the DDL transaction asserts `count(pragma_database_list)=1` **before** `COMMIT` and discards
the connection on failure, because `ROLLBACK` does not undo `ATTACH` (M1: `database_list=['main','v2']`
after rollback, same handle still reading the victim's rows; `DETACH` is what removes it).

**S-2 (withdrawn and replaced).** R1's "a request served for tenant A cannot touch a byte outside
`tenants/A/`" is false as an absolute claim — I measured it false in R1 §6.1 and still wrote it as an
invariant. Replaced by P1–P4 above, which are claims about *permissions* and are each testable.

**S-3 (amended).** No bearer secret in a URL, a log, an audit row, an error body, or a plaintext column.
With C-2, `cms_download_code` holds a 20-bit `code_selector` and an argon2 hash — no pepper, so there is no
fleet-wide secret whose loss weakens every tenant at once. Falsifier unchanged, plus
`SELECT count(*) FROM cms_download_code WHERE code_hash NOT LIKE '$argon2id$%'` = 0 and no column named
`code`, `code_plain`, `code_prefix` or `last4`.

**S-4 (amended).** Every privileged action produces exactly one audit row, **in the same file and the same
transaction as the change**, and no app path can alter or delete an audit row afterwards — which, for the
tenant's file, is only true if the daily seal exists (C-1). Two audit tables, two chains, one seal per
tenant per day.

**S-5 (amended).** Fail closed on anything that protects a paid asset, and fail *early* where possible:
encrypted or unstampable assets are refused at **issue** time, a stamping timeout in the worker is a
denial (`503 E_WATERMARK_FAILED`), and a fault injected into the renderer, the token key or a locked DB
produces zero asset bytes and no `X-Accel-Redirect`.

**S-6 (amended).** A gated asset is absent from the public tree by construction, **and the render path
cannot create a file there**. M1 showed `VACUUM INTO 'content/public/backup.db'` succeeding from a readonly
handle; `query_only=1` closes it (measured), and the P2 test is the proof.

**S-7 (unchanged, now proven).** One redemption consumes exactly one use regardless of how many HTTP
requests deliver the bytes. Measured this round: 8 parallel ranges → `uses=1` with the `jti` claim; 8
further range requests → `uses=1`, 8 `range` events. The naive per-request form drives `uses` to
`max_uses` on a single download (M6).

**S-8 (split).** Public: tenant identity comes from the vhost nginx matched, never from a client-supplied
header value, and a non-empty tenant header without a valid edge token is 421. Admin: tenant identity comes
from the **session row only** — the admin listener ignores `Host` and `X-Skunkworks-Tenant` for tenant
resolution, and the URL carries `/admin/t/<key>/`.

**S-9 (new).** No code we did not ship runs in the process, and tenant code never receives a database
handle. Falsified by any `import()` of a file under `tenants/<key>/content/` whose sha256 is absent from the
deploy manifest, or by any IPC message to a sandboxed child that carries a path or a handle instead of rows.

**The D1 cost, stated so the Architect hears the conflict and not a compromise.** If non-negotiable 1 is
read as "prove isolation structurally", the only structural mechanism in this stack is one process per
tenant (or a per-tenant uid with Landlock/seccomp — same cost, more platform work). Measured on the
smallest possible tenant process (better-sqlite3, one query, no Fastify, no Astro): **49.8 MB peak RSS** and
a **34 ms median cold start** (31–47 ms across ten runs). That is ~19 tenant processes per 1 GB container
before anything else runs, and ~10.0 GB at 200 tenants; it also invalidates the LRU-handle design (DM10 /
D-R4) and adds a per-tenant process to every export's install surface. I am **not** asking for it in v1. I
am asking the SDS to record that the price exists and that the promise was reduced to P1–P4 to match it.

## 5. Measurements I ran this round (command + real output)

All commands run 2026-10-20 on macOS 15.7.4, Node v22.23.1, better-sqlite3 13.0.3, `@node-rs/argon2` 2.2.x,
sqlite3 CLI 3.43.2. Scripts are committed at `scripts/debate/r2-security/` and re-run end to end with
`SK_R2_REQUIRE=<package.json with the two deps> ./run.sh`; `SK_R2_BASE` defaults to `/tmp/sk-r2sec`.
Output below is verbatim from that runner.

**M1 — what a readonly handle can still do, and what `query_only` closes.**

```
$ node p1-ro.mjs
=== A. readonly handle (render path) ===
  ATTACH beta site.db     : OK attached
  read v.cms_download_code: [{"issued_to_email":"buyer@beta.example"}]
  ATTACH data/control.db  : OK attached
  read ctl.sessions       : [{"id":"s0","tenant":"beta"}]
  INSERT ctl.sessions     : SQLITE_READONLY attempt to write a readonly database
  VACUUM INTO other tnt  : OK wrote tenants/beta/planted.db (16384 B)
  VACUUM INTO public tree : OK wrote content/public/backup.db (16384 B)
  CREATE TEMP TABLE       : OK
  CREATE TEMP TRIGGER     : OK
  write main table        : SQLITE_READONLY attempt to write a readonly database

=== B. PRAGMA query_only=1 on a read-write handle (the proposed substitute) ===
  INSERT main             : SQLITE_READONLY attempt to write a readonly database
  ATTACH data/control.db  : OK attached
  read ctl2.sessions      : "read ok"
  VACUUM INTO other tnt  : SQLITE_READONLY attempt to write a readonly database
  database_list now       : ["main","ctl2"]

=== C. ROLLBACK does not undo ATTACH; the in-transaction postcondition does catch it ===
  postcondition inside txn: count(pragma_database_list)=2 (must be 1) -> REJECT
  reads attacker rows     : [{"issued_to_email":"buyer@beta.example"}]
  database_list after ROLLBACK: ["main","v2"] <- ATTACH survived the rollback
  same handle reads again : [{"issued_to_email":"buyer@beta.example"}]
  DETACH                  : detached
  after DETACH            : SQLITE_ERROR no such table: v2.cms_download_code

=== D. a TEMP TRIGGER outlives the request that created it (pooled connection) ===
  request 2 insert fires trigger left by request 1: [{"x":101}]

=== E. readonly + PRAGMA query_only=1 on the RENDER handle (the proposed control set) ===
  SELECT (must still work) : {"n":11}
  ATTACH beta site.db      : OK attached
  CREATE TEMP TABLE        : SQLITE_READONLY attempt to write a readonly database
  CREATE TEMP TRIGGER      : SQLITE_READONLY attempt to write a readonly database
  VACUUM INTO public tree  : SQLITE_READONLY attempt to write a readonly database
  INSERT main              : SQLITE_READONLY attempt to write a readonly database

files now inside tenants/beta: ["planted.db","planted2.db","site.db"]
```

Two findings that change controls: `readonly` alone permits the two file-naming primitives, and
`query_only=1` closes both **plus** temp objects at zero cost to reads — but leaves `ATTACH` open, which
only a no-text/no-handle rule can close.

**M2 — argon2id parameters against a 1 GB container.**

```
$ for cfg in "1 19456 2 1" "8 19456 2 1" "1 65536 3 1" "8 65536 3 1"; do UV_THREADPOOL_SIZE=8 \
    /usr/bin/time -l node p2-argon-child.mjs $cfg; done
{"N":1,"m":19456,"t":2,"p":1,"allOk":true,"wallMs":12.8,"perOpMs":12.8}
            87785472  maximum resident set size
{"N":8,"m":19456,"t":2,"p":1,"allOk":true,"wallMs":69.3,"perOpMs":8.7}
           348536832  maximum resident set size
{"N":1,"m":65536,"t":3,"p":1,"allOk":true,"wallMs":118.1,"perOpMs":118.1}
           153567232  maximum resident set size
{"N":8,"m":65536,"t":3,"p":1,"allOk":true,"wallMs":283.9,"perOpMs":35.5}
           687079424  maximum resident set size
--- default UV_THREADPOOL_SIZE (4) ---
N=8 m=19456 t=2 p=1
{"N":8,"m":19456,"t":2,"p":1,"allOk":true,"wallMs":44.2,"perOpMs":5.5}
           192954368  maximum resident set size
N=8 m=65536 t=3 p=1
{"N":8,"m":65536,"t":3,"p":1,"allOk":true,"wallMs":269.6,"perOpMs":33.7}
           434028544  maximum resident set size
--- 16 concurrent at 64 MiB, pool 16 ---
{"N":16,"m":65536,"t":3,"p":1,"allOk":true,"wallMs":758.5,"perOpMs":47.4}
          1438105600  maximum resident set size
```

(Run-to-run spread on this box is ±25%: a second run gave 94.4 ms for the 64 MiB single verify. The memory
figures are stable to ~1 MB and they are the ones the argument rests on.)

**M3 — selector/verifier lookup cost and the offline attack it leaves.**

```
$ node p3-selector.mjs
codes issued                     : 5000
4-char selector space            : 32^4 = 1048576 (20 bits); collisions + retries: 12
total code length                : 16 chars = 80 bits; secret part 12 chars = 60 bits
selector lookup over 5,000 rows  : 2.02 us/query (n=10000)
EXPLAIN                          : [{"detail":"SEARCH cms_download_code USING COVERING INDEX sqlite_autoindex_cms_download_code_1 (code_selector=?)"}]
HMAC-SHA256 (new object)         : 703,302/s -> 2^60 = 5.20e+4 core-years
offline 2^60 argon2 @ m=19456,t=2      : 4.46e+8 core-years
offline 2^60 argon2 @ m=65536,t=3      : 3.45e+9 core-years
```

(Three runs put the lookup at 2.02, 3.15 and 4.71 µs; all plans are a covering-index `SEARCH`.)

**M4 — Node's permission model as a boundary for tenant code.**

```
$ node --permission --allow-fs-read=<acme dir> --allow-fs-read=<node_modules> p4-perm-child.mjs
permission model active: true
  fs.readFileSync(control.db): DENIED  [ERR_ACCESS_DENIED] Access to this API has been restricted.
  fs.readFileSync(tenant/beta/site.db): DENIED  [ERR_ACCESS_DENIED] Access to this API has been restricted.
  fs.readFileSync(tenant/acme/site.db): ALLOWED -> 8192 B
  fs.writeFileSync(into beta dir): DENIED  [ERR_ACCESS_DENIED] Access to this API has been restricted.
  child_process.execSync(id): DENIED  [ERR_ACCESS_DENIED] Access to this API has been restricted.
  load better-sqlite3 and open acme site.db: DENIED  [ERR_DLOPEN_DISABLED] Cannot load native addon because loading addons is disabled.
  open beta site.db via sqlite (native): DENIED  [ERR_DLOPEN_DISABLED] Cannot load native addon because loading addons is disabled.
  ATTACH beta via sqlite: DENIED  [] no handle
  ATTACH control.db via sqlite: DENIED  [] no handle
  VACUUM INTO beta dir: DENIED  [] no handle

$ node --permission --allow-addons --allow-fs-read=<acme dir> --allow-fs-read=<node_modules> p4-perm-child.mjs
(node:24151) SecurityWarning: The flag --allow-addons must be used with extreme caution. It could invalidate the permission model.
  fs.readFileSync(tenant/beta/site.db): DENIED  [ERR_ACCESS_DENIED] Access to this API has been restricted.
  fs.writeFileSync(into beta dir): DENIED  [ERR_ACCESS_DENIED] Access to this API has been restricted.
  child_process.execSync(id): DENIED  [ERR_ACCESS_DENIED] Access to this API has been restricted.
  load better-sqlite3 and open acme site.db: ALLOWED -> handle open
  open beta site.db via sqlite (native): DENIED  [ERR_ACCESS_DENIED] Access to this API has been restricted.
  ATTACH beta via sqlite: ALLOWED -> [{"issued_to_email":"buyer@beta.example"}]
  ATTACH control.db via sqlite: ALLOWED -> {"n":1}
  VACUUM INTO beta dir: ALLOWED -> wrote file
```

Node's own warning is accurate: with addons allowed, the native VFS bypasses the fs policy entirely, and
the only configuration that holds is the one where SQLite cannot load.

**M5 — what the process boundary D1 forbids would cost.**

```
$ node p5-proc.mjs
spawn -> first query answered: 31, 31, 32, 33, 33, 34, 35, 35, 36, 47 ms
median 34.0 ms, min 31.0, max 47.3
$ /usr/bin/time -l node p5-proc-child.mjs
READY
            49807360  maximum resident set size
```

49.8 MB per tenant process → ~19 per 1 GB container, ~10.0 GB at 200 tenants.

**M6 — the accounting unit, proved.**

```
$ node p6-jti.mjs
naive per-request consume : 8 parallel ranges -> [1,1,0,0,0,0,1,0] uses=3  (max_uses=3)
jti-claim, 8 parallel      : [{"ins":1,"inc":1},{"ins":0,"inc":0},{"ins":0,"inc":0},{"ins":0,"inc":0},{"ins":0,"inc":0},{"ins":0,"inc":0},{"ins":0,"inc":0},{"ins":0,"inc":0}]
  state after 8 ranges     : uses=1 events=[{"kind":"first","n":1}]
  8 more Range requests    : uses=1 events=[{"kind":"first","n":1},{"kind":"range","n":8}]  <- still one redemption
```

One download, 16 HTTP requests, one use — and the range events are still recorded, because the unique index
is partial (`WHERE kind='first'`).

**M7 — is `cms_audit` evidence without a seal?**

```
$ node p7-audit.mjs
append 10,000 audit rows (chain+txn): 36 ms
verify the chain                    : 17 ms, rows=10000, mismatch=null
head hash                            : 8d73fdcb848d64e790ddce26…
daily seal write                     : 455 us (one row per tenant per day)
A1 edit row 5000                    : {"id":5000,"why":"hash"} -> detected by the chain
A2 delete the last 10 rows           : chain=null, rows=9990 vs seal.rows=10000 -> detected by the seal
A3 delete every row                  : chain valid=true (vacuous), rows=0 vs seal.rows=10000 -> detected by the seal
seal storage                         : 365 rows/year/tenant x ~90 B = 32.1 KB
```

**M8 — the env-var and header surface the five papers actually specify.**

```
$ python3 - <<'EOF'   # extract names matching (SK|SKW|SKUNK|SKUNKWORKS)_[A-Z0-9_]+ from the R1 papers
distinct env-var names across the five R1 papers: 38
  r1-security.md         10  SK_ADMIN_ORIGIN, SK_ARGON2_MAX_CONCURRENT, SK_DDL_MAX_STATEMENTS, SK_DOWNLOAD_TOKEN_KEY, SK_IP_HASH_KEY, SK_RATE_KEY, SK_SESSION_KEY, SK_TENANT_HEADER, SK_TRUST_PROXY, SK_WEBHOOK_SECRET_
  r1-data-model.md        5  SKW_CODE_PEPPER, SKW_DATA_DIR, SKW_DB_BUSY_TIMEOUT_MS, SKW_DB_POOL_MAX, SKW_FLEET_MODE
  r1-runtime.md          12  SKUNKWORKS_ADMIN_PORT, SKUNKWORKS_BUILD_ID, SKUNKWORKS_CONTROL_DB, SKUNKWORKS_PROXY_TOKEN, SKUNKWORKS_PUBLIC_PORT, SKUNKWORKS_RENDER_MODE, SKUNKWORKS_SOURCE_HARD_MS, SKUNKWORKS_SOURCE_P95_MS, SKUNKWORKS_TENANTS_DIR, SKUNKWORKS_TENANT_CONN_LRU, SKUNKWORKS_TENANT_HEADER, SKUNKWORKS_TRUSTED_PROXY_CIDRS
  r1-platform.md         11  SKUNK_ADMIN_ALLOWLIST, SKUNK_BACKUP_DIR, SKUNK_CONTROL_DB, SKUNK_DB_BUSY_TIMEOUT_MS, SKUNK_EDGE_TOKEN, SKUNK_MODE, SKUNK_PUBLIC_ORIGIN, SKUNK_RENDER_TIMEOUT_MS, SKUNK_SCHEMA_EDIT, SKUNK_TENANTS_DIR, SKUNK_TENANT_KEY

SAME CONCEPT, DIFFERENT NAMES: CONTROL_DB -> ['SKUNKWORKS_CONTROL_DB', 'SKUNK_CONTROL_DB']
SAME CONCEPT, DIFFERENT NAMES: DB_BUSY_TIMEOUT_MS -> ['SKUNK_DB_BUSY_TIMEOUT_MS', 'SKW_DB_BUSY_TIMEOUT_MS']
SAME CONCEPT, DIFFERENT NAMES: TENANTS_DIR -> ['SKUNKWORKS_TENANTS_DIR', 'SKUNK_TENANTS_DIR']
SAME CONCEPT, DIFFERENT NAMES: TENANT_HEADER -> ['SKUNKWORKS_TENANT_HEADER', 'SK_TENANT_HEADER']
edge/proxy token spellings  : ['SKUNKWORKS_PROXY_TOKEN', 'SKUNKWORKS_TRUSTED_PROXY_CIDRS', 'SKUNK_EDGE_TOKEN', 'SK_TRUST_PROXY']
$ grep -n "DOWNLOAD_HMAC_KEY\|SESSION_KEY" r1-platform.md
381:**Decision.** `install.sh` writes `.env` from a template with 32-byte random values (`SKUNK_EDGE_TOKEN`,
382:`SESSION_KEY`, `DOWNLOAD_HMAC_KEY`), `chmod 600`, owner 10001.
```

Four prefixes, 38 names, four concepts with two spellings each, two headers for the edge token, two names
for the download HMAC key.

## 6. What I concede, and what would change my mind

**I concede the isolation claim.** R1 S-2 said "a request served for tenant A cannot touch a byte outside
`tenants/A/`", and my own §6.1 showed a readonly handle reading `control.db`. Writing that as an invariant
while holding the counter-evidence is the worst thing in my paper: an invariant that the author has already
falsified is worse than no invariant, because the SDS would have inherited it. The replacement is P1–P4 —
four permissions, four tests, and the plain sentence that isolation is permission-based. Non-negotiable 1
("prove it structurally") cannot be met inside D1, and the Architect should record that the promise was
reduced rather than let a builder discover it.

**I concede the code-lookup blocker.** I specified argon2id as the *only* representation of a code and never
specified how a row is found. Data Model and Red Team both found it, and it would have been found by the
first developer to write the redemption endpoint — after the schema, the issuance path and the rate limiter
were all built against it.

**I concede that I stopped one control short.** I had "readonly + no text" and never tested `VACUUM INTO`,
temp triggers, or `PRAGMA query_only`. Runtime found the first two; the third closes both for one line of
code (M1) and should have been in R1.

**I concede the admin allowlist.** I defended it in IDEA §9 as a control without costing it. Platform is
right that it is unsupportable in a sold bundle, and Red Team is right that an empty allowlist is not a
control at all. TOTP plus a shorter idle timeout is the honest replacement.

**What would change my mind:**

1. **A way to turn `query_only` off from a path that reaches the render handle.** If a dependency can open
   its own handle to the same file, or a route can call `pragma('query_only = 0')` on a pooled connection,
   P2 is decorative and I would move to a process boundary even at 19 tenants per GB.
2. **A tenant count under ~15 per host.** Then per-tenant processes are affordable, isolation becomes
   structural, and I would withdraw "permission-based" entirely rather than defend it. At 200 tenants on a
   1 GB container it is ~10.0 GB and the answer is no.
3. **A demonstration that the selector is an existence oracle.** If a builder cannot make "unknown
   selector" and "wrong secret" indistinguishable in status, body and time (with a dummy verify at the
   *same* params), the 2²⁰ selector leaks which codes exist and DM12's keyed lookup is the better design.
   This is the one part of C-2 I would trade away first.
4. **A test that proves the pepper never ships.** If the export projection excludes `cms_download_code`
   (row 11) and a bundle-content test asserts that no `SK_*` secret appears in any bundle, then DM12's
   HMAC lookup is adequate and the selector's remaining benefit is one secret that never has to rotate.
   I would take that trade.
5. **A client requirement that codes stay at 12 characters.** That drops the secret to 40 bits and the
   selector design collapses; the pepper comes back, and with it DM12's rotation problem.
6. **A measurement showing argon2 at 64 MiB fits the container** — e.g. a 2 GB limit, or a fleet small
   enough that 687 MB peak is acceptable. Then DM12's params stand and only the semaphore changes.
7. **Evidence that a demo tenant is never adversarial.** If demos are only ever built by us and never
   edited by a prospect, C-4's origin split is over-engineering. I do not believe that is the product
   being sold (IDEA §8, D24 ship the editor to the client), so I am not relying on it.
