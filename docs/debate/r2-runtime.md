# R2 — Runtime

Round 1 left me owning three unsolved things: behaviour can only live in registered islands
(cost it against §8.1), a page's cost budget must be enforced at publish (not monitored), and
parameterised Data Sources must be snapshotted honestly or D22's three SKUs are marketing. This
paper costs the first, makes the second a state transition, and makes the third a rule with a
cap. It also accepts seven corrections to my own R1 paper, one of which is a measured defect in
the mount seam I claimed was settled.

Box: Apple M1, macOS 15.7.4, Node 22.23.1, grapesjs 0.23.8 + jsdom 30.1.3, fastify 5.12.7,
astro 7.4.1 (`@astrojs/node` 11.1.9), better-sqlite3 13.0.3 (SQLite 3.53.4). Every number in §5
is from this box today, single process, no container. Probes:
`~/.hermes/profiles/ceo/cache/scratch/probe/{gjs,sql,astro}/`.

---

## 1. Attacks on my domain — verdicts

| # | Attack | Source | Verdict | Reason | Fix shape |
|---|---|---|---|---|---|
| R1 | A `data-source` placeholder must become N sibling elements; GrapesJS has no repeat concept | Red O4 | **ACCEPT** | Nothing in the editor clones a subtree per row — a registered island round-trips (M2: pass2≡pass1 at 8 islands) but a placeholder div is inert markup. The repeat contract is mine and was undefined. | D-R10: one `list` component, exactly one `[data-repeat]` child, `data-bind` text/attr bindings only, `data-empty` child, `limit` clamp; SSR clones the child per row. No expressions, no mustache. |
| R2 | TTL cache is keyed per source, not per parameter | Red O13 | **ACCEPT** | `site.source('posts',{limit:3})` and `{limit:50}` collide; the first writer wins for `ttl_s`, so a sidebar shows 50 rows. It is a key definition, not a measurement. | Result-cache key = `(tenantKey, sourceKey, specRev, sha256(canonicalParams))`; single-flight per key; test renders both orders inside one TTL. |
| R3 | Fastify and Astro both want the request body | Red §2 | **ACCEPT — and worse than stated** | Measured M6: on a 404 Fastify has already parsed the body (`req.is404=true`, `typeof req.body === 'object'`, raw stream **0 bytes**) for `application/json`, and drains `text/plain` too. Form-encoded survives (22 B). So an Astro-owned JSON POST arrives empty. D-R1 as written was never body-tested. | D-R12: `addContentTypeParser(['application/json','text/plain'])` with `if (req.is404) return done(null, payload)`. Measured M6b: JSON body reaches the handler intact (14 B), `/api/echo` still parses. |
| R4 | One process: a 600 ms synchronous block stalls 20/20 concurrent requests | Platform A4 | **ACCEPT** | Platform T22 measured min 510 / p95 513 ms against a 0.5 ms baseline. My D-R7 offloads sources ≥0.5 ms only; pdf-lib stamping, a 300 KB `JSON.parse`, and GrapesJS normalisation are uncovered. | I15 loop budget: no request may block >5 ms; sources ≥0.5 ms and watermark render off-loop with a 2 s cap; `monitorEventLoopDelay` p99 >50 ms → `503 RT_E_LOOP_CONGESTED`; per-tenant semaphore. |
| R5 | `function` sources are in-process code in a tenant-writable tree | Security A-5, DM A2 | **ACCEPT** | The file lives under `tenants/<key>/content/sources/`, is tarred into the bundle, and runs where every HMAC key lives. "Cannot be created from the admin UI" constrains the UI, not the filesystem. | v1 removes `kind='function'` (DM §3.5 already asks). A v2 reinstatement requires deploy-manifest sha256 **and** a worker with no fs and no `ATTACH` — my A3, in that order. |
| R6 | The render path must not share a process with the DDL runner | Security 3.2.2 | **REJECT** | The threat has two halves: a DDL bug reaching the render handle, and tenant JS in-process. The first is connection hygiene (DM2/DM10 discard the handle; postcondition asserts one `main`); the second disappears with R5. A second process adds a second SQLite writer and a revision channel; per-tenant processes cost ~40 MB × N (Security's own Q4). | Substitute: DDL on a dedicated discarded connection, `BEGIN IMMEDIATE`, ≤8 statements, per-tenant mutex; the render path never holds a DDL-capable handle. |
| R7 | A per-response CSP nonce cannot survive export, and presumes stored `<script>` | Security DS-11, my A2 | **REJECT as designed** | There is no stored script to carry a nonce — GrapesJS deletes it (R1 §6.8) and I8 forbids it — and a static bundle has no server to emit the matching header. "Rewrite a nonce onto every stored `<script>`" is a no-op on markup that cannot contain one. | C2: `script-src 'self'`, islands emitted by the renderer as hashed module URLs, identical CSP in all three SKUs. The hash alternative costs 0.044 ms/page on 83 KB (M8) for no gain. |
| R8 | A request-scoped `BEGIN` pins the WAL (12.4 MB WAL vs 8 KB main) | DM A5, DM 3.1.2 | **ACCEPT** | Real and silent: `wal_checkpoint(PASSIVE)` cannot truncate while a snapshot is open. My R1 never said a request is one transaction; it has to say it is not. | I12: `source()` in autocommit; `db.inTransaction === false` on entry and between sources; `rg wal_autocheckpoint src/` empty; a test asserts `wal_checkpoint(TRUNCATE)` returns to 0 after a render. |
| R9 | `is_public=0` is a 500 in my contract, a 404 in DM's | DM 3.1.4 | **ACCEPT DM's** | A 500 confirms the key exists by reporting a fault on it; a 404 is uniform with a missing key. Same reasoning I already applied to `SOURCE_UNKNOWN`, applied inconsistently. | 404 `RT_E_SOURCE_UNKNOWN` for missing **and** private; no body detail; one log line. |
| R10 | Path lookup must be exact/NOCASE with redirect, and the app must not re-normalise | DM 3.1.5 | **ACCEPT with amendment** | Measured M7: Astro 7.4.1 serves `/blog/a` and `/blog/a/` both as 200 and 301s `/blog/a//` — two URLs per page — until `trailingSlash:'never'`, which 301s `/blog/a/`→`/blog/a`. Static segments are case-sensitive (`/Blog/A` 404) but a catch-all accepts any case (`/blog/A` 200), so Astro's file router cannot be the page lookup. | One route `[...path].astro`; resolver: exact → NOCASE (301 canonical) → `cms_redirect` → 404; `trailingSlash:'never'`; `cms_page.path` stays NOCASE-unique (DM). |
| R11 | `source()` must be one statement against a cache keyed by `(tenantId, kind, specHash)` | DM 3.1.3 | **ACCEPT with amendment** | `specHash` alone collides across parameter values — O13 in a different layer. The prepared statement is safe (params bound); the *result* cache is not. | Statement cache `(tenant, kind, specHash)`; result cache adds canonical params + `specRev`; both invalidated on `cms_datasource.rev`. |
| R12 | A read-only handle is not an isolation boundary (`ATTACH`, `VACUUM INTO`) | my A3, restated by DM I5 / Security S-2 | **ACCEPT** | Measured in R1 §6.3 on a `readonly` handle. But my worker+fs-policy fix is weaker than removal once `function` is gone: with no tenant-authored code there is no path from a template to `ATTACH`. | v1 ships no `function`; the `ATTACH`-denial test stays as a regression guard on any future code path that gains a connection. |
| R13 | Admin on a separate port has no defined tenant-selection path | my A5, Red O6 | **ACCEPT (mine, unresolved)** | Two listeners are two Host spaces; a session-scoped tenant beside a host-scoped tenant is two sources of truth, and the audit row records an actor but no tenant. | `/admin/t/<key>/*` in every admin URL; `resolveAdminTenant(session)` is the only source; the admin listener ignores `Host`; every audit row carries `tenant_id`. |
| R14 | A published app/admin port bypasses nginx, so a spoofed tenant header is never cleared | Red O6 | **ACCEPT** | D-R2's proxy token + CIDR makes a client header inert *only if* the request came through the proxy. A published port is a direct socket with a valid-looking token-free header. | Compose `expose` only, no `ports`, for `app`; boot refuses when `SKW_TRUST_PROXY=nginx` and a public listener is bound; `X-Skunkworks-*` stripped from untrusted peers. |
| R15 | The Astro SKU ships no lockfile and the exporter never builds its own output | Red O11 | **ACCEPT** | `npm ci` exits 1 without a lockfile (Red measured it), and an unbuilt generated project compiles for the first time on the client's box, on their registry and Node version. | Exporter emits a lockfile it resolved; release gate runs `npm ci && npm run build` of the generated project per target in CI and records the build id in the manifest. |
| R16 | Static export freezes parameterised sources at defaults; page 2 of the blog does not exist | Platform A5, my A1 | **ACCEPT** | A note in `EXPORT-NOTES.md` is not a site. The cheapest SKU then ships with a 404 where the CMS has content, and "reproducible bytes" makes it permanent. | I14 snapshot rule: declared domains, enumerated at publish, capped, refuse when not enumerable (§4). |
| R17 | `X-Forwarded-Prefix` is the only prefix source; a hardcoded `/media/...` is a bug | Platform 3.1 | **ACCEPT** | Matches I11, and settles my R1 open question 1 the other way: Platform PD5 measured nginx stripping the prefix end-to-end (T24), which is what IDEA §3.1's own table already showed. | nginx strips (`rewrite … break`) and sets `X-Forwarded-Prefix`; the app never rewrites the inbound path; `tenant.prefix` is used only by `site.url()`. My 3.1 contract ("the prefix is stripped by the app, nginx must not rewrite") is **withdrawn**. |
| R18 | Custom response headers do not survive `X-Accel-Redirect`, and a missing target discards the app's 200 | Platform 3.2 | **ACCEPT** | Measured by Platform (T2/T4). The app's 200 is thrown away and the user sees 404 on a file the app believed existed. | `/d/:key/file` stats the target before emitting the header; nothing depends on a custom header on an offload response; a stat miss is `503 RT_E_ASSET_MISSING`, not a silent 404. |
| R19 | `/readyz` must probe a write; `/healthz` must not touch a DB | Platform 3.6 | **ACCEPT** | A read-only probe passes on a full disk — the exact failure it exists to catch. A health check that opens a tenant DB turns one corrupt tenant into a fleet restart. | `/healthz` process only; `/readyz` = control.db open + revision read + one scratch write; per-tenant health separate, cached 30 s, never in the compose healthcheck. |
| R20 | Argon2 verification is an in-process resource that can starve the loop and the threadpool | Security DS-6 | **ACCEPT with a runtime obligation** | `@node-rs/argon2`'s async path occupies libuv threadpool slots, which also serve `fs` and DNS; the default pool is 4. A semaphore bounds verifications, not pool slots, and a saturated pool stalls media writes. | `UV_THREADPOOL_SIZE=8`; `SKW_ARGON2_MAX_CONCURRENT ≤ 4` (half the pool); 2 slots reserved for session-holding requests; queue 32 then 503. |

No silent drops: 20 attacks on my domain, 15 accepted, 1 rejected with a substitute, 1 rejected as
designed, 3 accepted with amendments.

### 1.1 The island bill, itemised

I8 forces every behaviour into a registered component. Measured cost:

| Item | Measured | Basis |
|---|---|---|
| Registry boot, 24 types | 0.8 ms (0.03–0.04 ms/type); 48 types = 1.8 ms | M1, median of 5, `addType` + `Blocks.add` |
| Editor load, per island | **0.46–0.66 ms marginal** (3.8 ms for 1, 8.4 ms for 8, 16.5 ms for 24, 27.5 ms for 48) | M2, islands-only page, median of 5 |
| Editor save, per island | **0.01–0.13 ms** (0.5 ms for 48 islands) | M2 |
| Stored bytes, per island | **135–138 B** for the minimal island (+109 B over a 26 B bare div); **150 B** marginal for the props-bearing variant | M2/M3, M1 |
| One unregistered type | `data-gjs-type` **stripped**, island becomes an editable div | M1 |
| A registered type whose `model.defaults` omits the attribute | **also stripped** — the lock is a model default, not a parse artefact | M2 vs M3 (`135 B` vs `110 B`) |
| Engineering, per behaviour | **1.1–1.4 days** (est.) | IDEA §10 S4 = 17.5–22.5 d for ~8 blocks (§8.2) + 3 exporters; half of S4 is editor+registry → 8.75–11.25 d ÷ 8 |
| Client JS bytes / chunk count | **not measured** — determined by Astro's `client:*` chunking, which is S4's build to verify | — |

Verdict on §8.1's promise: **"fully drag-and-droppable on day one" is true only inside the
registry.** DnD coverage equals registry coverage, and the registry is closed at build time. The
performance cost is nil (sub-millisecond); the cost is that a client request for an interaction we
did not ship is an image rebuild and a redeploy — for the CMS SKU, a deploy by us, which contradicts
the "no SSH, no ticket" spirit of Platform PD5. The alternative is worse: allowing inline `<script>`
means storing it, and GrapesJS deletes it on the first save (R1 §6.8) *and* Security A-2 turns any
stored script into an admin-CSRF primitive on a port-shared origin. So the island requirement is
forced by the editor, and the only free parameter is how many behaviours we build before the first
client.

**§8.1 amendment request:** replace "fully drag-and-droppable on day one" with "fully
drag-and-droppable within the shipped component set; the set is versioned with the image, and a
new interaction is a component release, not a content edit."

### 1.2 The publish gate is affordable, and my R1 estimator was wrong

| Gate step | Measured | Basis |
|---|---|---|
| `EXPLAIN QUERY PLAN`, one source | 0.015 ms | M4b, 200 iterations |
| 200 executions, one indexed source | 2.8 ms (22.5 ms for 8) | M4b |
| Full gate, 8 sources, n=200 | **23.7 ms** (1.19 ms plans + 22.5 ms execs) | M4b |
| Gate if the plan is checked first, unindexed source | **0.015 ms** to reject vs **1,304 ms** if you measure first | M4b |
| p95 estimated from n=20 vs truth (n=400) | **0.29×–13.97×** the true p95 (two runs, 100 windows each) | M4 |
| p95 estimated from n=200 | 0.78×–2.31× | M4 |

Two consequences. (1) The gate must check the plan **before** it measures, or an unindexed source
costs 1.3 s of publish time to reject — the difference between a save that feels instant and one
that hangs. (2) **D-R6's "run it 20× and store p95" is not an estimator**: at 20 samples the p95
lands anywhere from 0.69× to 14× the truth, and in practice it captures the cold first execution
(0.879 ms in M4 A against 0.019 ms of steady state). The gate stores **max of 200** (a bound, always
≥ truth) and p95 of 200 as the second number, and the budget compares against max.

---

## 2. My counter-designs for the other domains

### C1 — Data Model: the asset-alias 301 has no owner at the edge

| | |
|---|---|
| **Claim** | DM3: a renamed key's old name "lands in `cms_asset_alias` and 301s at `/media/<old-key>`", so renames do not break live pages. |
| **Counter-design** | `location /media/ { alias …; }` answers 404 itself (Platform T4/T11e) and never proxies, so the 301 is unreachable — the alias table is written and never read on the path that matters. Add `error_page 404 = @media_alias;` inside the media location; `@media_alias` proxies **GET/HEAD only** to the app, which looks up `cms_asset_alias` and returns 301 or 404. Cost: only misses reach the app (a stale stored URL), never a normal image request. `site.asset()` also resolves aliases at render, so a republish rewrites the URL and the 301 path is only for pre-existing HTML. |
| **Severity** | Major — every rename silently breaks images in already-published pages, and the FK story (`RESTRICT`) makes renames rare enough that nobody would test this. |
| **Evidence needed** | Rename a key referenced by 0 rows but present in a stored `body_html`; `GET /media/<old-key>` through the shipped nginx config must be 301, not 404. Then rename a referenced key and assert `409 DM_E_KEY_IN_USE` (DM3's guarantee). |

### C2 — Security: there is no nonce, because there is no stored script

| | |
|---|---|
| **Claim** | Security DS-11: public CSP carries `script-src 'nonce-<per-request>'` and "the renderer **rewrites a per-request nonce onto every stored `<script>` at SSR**". |
| **Counter-design** | Delete the inline-script class instead of authorising it. I8 is enforced at write (server validator + DB `CHECK`), so no stored body can contain `<script>`. Islands are emitted **by the renderer**, not stored, as `<script type="module" src="/islands/<name>.<sha8>.js">` — hashed filename, immutable cache, `script-src 'self'` in every SKU. The header is then byte-identical in the CMS bundle, the Astro project and the static site, which is the only way the CSP promise survives the export. Embed blocks get an explicit `frame-src` allowlist per tenant (a YouTube iframe is not an island and must not be forced into one). |
| **Severity** | Blocker for SKUs 2 and 3 — a nonce cannot exist in a file on a client's nginx, so either the islands do not hydrate or the exported bundle ships no CSP. |
| **Evidence needed** | Export a fixture with two islands, serve it from the bundle's own nginx with `script-src 'self'`, load it: both islands hydrate, zero `script-src` violations. Then diff the `Content-Security-Policy` header across the three SKUs — must be equal. |

### C3 — Security: `code_lookup` is a keyed MAC, not a representation of the code

| | |
|---|---|
| **Claim** | Security 3.1: "`cms_download_code`: `code_hash` must be the only representation of the code. No `code`, `code_plain`, `code_prefix`, or `last4`." That is incompatible with DM12's `code_lookup` column, and without a lookup column redemption is a scan (DM M15: 358 s–1.6 h at 5,000 codes). |
| **Counter-design** | Amend the rule rather than the schema: `code_lookup = HMAC-SHA256(SKW_CODE_PEPPER, crockfordNormalise(code))` is permitted **iff** five conditions hold — the pepper is not in the bundle, the column is never `SELECT`ed except as the redemption `WHERE`, it never enters a log/audit/error body/export manifest, it is `CHECK(length(code_lookup)=64)` and unique, and the admin search does not accept a partial. `code_hash` remains the only *verifier*; `code_lookup` is a bucket key. |
| **Severity** | Blocker — the gated-download feature cannot serve one request as Security's rule is written. |
| **Evidence needed** | 5,000 seeded codes, one valid redemption <200 ms (DM12's target); `grep -r <any code_lookup value> site-bundle/` = 0 hits; a DB leak with the pepper absent leaves 2^60 offline work. |

### C4 — Data Model + Platform: remove `storage_path`; the farm target is a pure function of `sha256`

| | |
|---|---|
| **Claim** | DM I7 allows `cms_asset.storage_path` as a *derived* column; Red O5 shows a CRUD form can set it to `../../../../etc/passwd`, after which nginx follows the symlink (Platform T11g: `/etc/hostname` served, 200, 13 bytes). Platform PD4's containment rule is "only the app writes the farm". |
| **Counter-design** | Make the exploit unrepresentable instead of policing the writer: **no path column exists.** The symlink target is computed at write as `../media/<sha[0:2]>/<sha>.<ext>` from `cms_asset.sha256`, which is immutable, `CHECK(sha256 GLOB '[0-9a-f][0-9a-f]…[0-9a-f]')` at 64 chars, and set only by the re-encoder (Security DS-8). The CRUD generator has no path field to expose, so no per-column write-policy subsystem is needed for the file path. |
| **Severity** | Major — arbitrary file read through nginx for any phished admin, in a product sold to third parties. |
| **Evidence needed** | `POST /admin/assets {key:'x', sha256:'../../etc/passwd'}` → 422; then `find -L content/public -type l` resolves only inside `content/media`, and `GET /media/x.txt` for a poisoned row is 404. |

### C5 — Data Model: the round-trip gate is a fixpoint, not an empty diff

| | |
|---|---|
| **Claim** | DM5 justifies storing one document instead of a block tree because "the gate is an **empty diff**" — i.e. `load(save(html)) === html`. §8.1 says the same. Measured, that gate fails on 8 of 9 hand-authored constructs at pass 1 (R1 §6.8) and on 8/8 island fixtures (M2: `pass1==input false`, `pass2==pass1 true`). |
| **Counter-design** | Gate on a fixpoint over the canonical form: `canon(load(save(load(html)))) === canon(load(html))`, plus a third pass for stability. `cms_pages.body_sha` is computed over the **canonical post-first-save** body, and `cms_page_revision` stores the serialised form, so the stored artefact is always editor-native. The literal empty-diff is retained only for the fixture set we author ourselves, as a warning, not a gate. |
| **Severity** | Major — the specified gate is unachievable, so it gets waived on day one and then stops protecting anything. |
| **Evidence needed** | 9 hand-authored fixtures: 8 fail empty-diff at pass 1, 9/9 pass the fixpoint gate at pass 2. If any fixture is unstable at pass 2 *with the full registry loaded*, that page is genuinely unshippable and I accept the stricter gate. |

### C6 — Platform: the answer to one process is a breaker, not N processes

| | |
|---|---|
| **Claim** | Platform A4/§5 Q3: one Node process couples tenants, so "one process or N" is a real fork; the requirement is that the runtime "states a per-page CPU budget it will not exceed". |
| **Counter-design** | Stay at one process, add three controls with numbers: (a) every source invocation gets a 250 ms wall-clock budget in a worker (D-R7), overflow → `503 RT_E_SOURCE_TIMEOUT`; (b) `monitorEventLoopDelay` sampled at 10 ms, and when p99 > 50 ms the process sheds load — new renders get `503 RT_E_LOOP_CONGESTED` + `Retry-After: 1` instead of queueing behind the block; (c) a per-tenant semaphore (8 concurrent renders) so one tenant's burst cannot occupy the queue. The breaker converts "every tenant suffers" into "the offending tenant and the overload window suffer", at zero extra RSS. |
| **Severity** | Major — availability, not correctness; the first client-authored mistake becomes a fleet outage. |
| **Evidence needed** | Repeat Platform T22's 600 ms block with the breaker armed: an unrelated path must return `503 RT_E_LOOP_CONGESTED` in <10 ms, and after the block clears p95 must return to baseline within one sampling window. |

---

## 3. Conflicts I detect between OTHER domains

### X1 — Security DS-4 and Platform PD1 400 every host-routed request (blocker)

Platform PD1 puts `proxy_set_header X-Skunkworks-Tenant "";` in the snippet **included by every
proxying location**, and Security DS-4 requires the app to return `400 E_TENANT_HEADER` when the
header is "missing, **empty**, or fails `/^[a-z0-9][a-z0-9-]{0,62}$/`". Combined, 100 % of
host-routed traffic is a 400 — including every production page. Neither paper is wrong alone: PD1 is
right that an empty header must overwrite a client value, and DS-4 is right that an unvalidated
header is a tenancy hole.

**Resolution.** Empty is a legal value meaning "no edge assertion — resolve from `Host`". Rules:
missing/empty on the **public** listener → resolve by `Host`; non-empty without a valid
`X-Skunkworks-Edge` token → `421 EDGE_TOKEN_INVALID` (never render); non-empty failing the regex, or
containing a comma (duplicate join) → `400`; missing header on the **admin** listener → `400` (the
admin never takes a tenant from the URL). **Owner: Security to restate DS-4; Platform's snippet is
unchanged.**

### X2 — Data Model removes `kind='function'`; Security specifies its constraint

DM §3.5: "`cms_datasource.kind` loses `function`". Security 3.1: a CHECK that "`kind='function'`
implies `spec_json` is a path present in the deploy manifest". One deletes the value, the other
constrains it, and a builder reading both will implement whichever they read last.

**Resolution.** v1 has no `function` value (Security's own A-5 says it is reachable by design in the
export direction). Security's manifest CHECK is retained in the SDS as a **dormant** constraint with
a comment naming v2, so reinstatement has a written precondition instead of a debate. **Owner:
Data Model.**

### X3 — Two different fixes for `max_uses`, and one assumes a table that does not exist

Platform A1 fixes per-request accounting by decrementing "only when the request has no `Range`
header or `Range` starts at byte 0, and record `first_byte_at` **on the token row**". Security DS-5
fixes it with a `jti` and a unique `(jti, kind)` event row. Platform's version double-counts a
retried `Range: bytes=0-` (download managers do exactly this) and refers to a token row that does
not exist — Security §3.4's token is a stateless HMAC (`v1.<payload>.<mac>`), so there is nothing to
write `first_byte_at` on.

**Resolution.** Security DS-5 wins: consume on the first successful byte response for a `jti`, then
`INSERT cms_download_event(jti, kind) ON CONFLICT DO NOTHING`; the unique index is the ledger. If a
"first byte" timestamp is wanted, it is a column on the event row, not on a token. **Owner:
Security; Platform's A1 becomes supporting evidence, not a design.**

### X4 — DM2's DDL op set contains two operations SQLite cannot perform

DM2's `DdlOp` union includes `add_column` with `nullable:false` and `drop_column`. Red O14 measured
both failing on legal input: `ADD COLUMN price NUMERIC NOT NULL` → `Cannot add a NOT NULL column with
default value NULL`; `DROP COLUMN cover` after `CREATE INDEX ix_cover` → `error in index ix_cover
after drop column: no such column`. Two of seven ops fail, and DM2 says the compiler emits the SQL
itself — so the failure surfaces as raw SQLite text in a modal after the operator has described the
change.

**Resolution.** The op set stays, the *capability* is checked first: `add_column` with
`notNull && !default` → `422 DM_E_DDL_REJECTED reason:'default_required'`; `drop_column` on an
indexed or FK-referenced column → `reason:'rebuild_required'`, and the UI disables the control with
that reason rather than offering a button that throws. The rebuild path is DM4's 12-step procedure,
including the `sqlite_sequence` restore (DM M5). **Owner: Data Model; the UI states are S2's.**

### X5 — The bundle has no control plane, and three papers each assume another one created it

Red O2: `control.db` is "never exported", so a bundle arrives with no tenant row, no domain, no
admin user, no `mode`. DM1 puts all three in `control.db`. Platform PD9 defines the bundle as
`docker-compose.yml` + `.env` + `data/` + `content/` + `install.sh` — and §3.3's mapping
(`data/site.db` → `tenants/<key>/site.db`) presupposes the tenant row that nothing creates.

**Resolution.** The bundle carries `control.seed.json`
(`{tenantKey, hosts:[…], mode:"production", admin:{email, password_hash, must_change:1}}`) and
`install.sh` runs `control:migrate` then `control:seed` **before** `compose up`; `mode` is forced to
`production` and demo TTL fields are rejected at seed time. `data/site.db` stays a clean
single-tenant file, so the "export has nothing to filter" property is preserved. **Owner: Platform
(bundle), Data Model (seed schema), Runtime (the `mode` resolver must treat a missing row as fatal,
not as a default — my I2).**

### X6 — Four env-var prefixes and four error-code namespaces

`SKUNKWORKS_*` (runtime, 14 vars), `SKW_*` (DM, 5), `SKUNK_*` (Platform, 10), `SK_*` (Security, 9).
`SK_...` and `SKUNK_...` differ by three characters, and both are rendered into the same `.env` by
`install.sh`. Error codes are `SOURCE_BUDGET_EXCEEDED` (runtime, no prefix), `DM_E_*` (DM), `E_*`
(Security), `EDGE_TOKEN_INVALID`/`TENANT_UNKNOWN` (Platform) — four conventions in one HTTP body.

**Resolution, before S1 writes a single `.env`:** one prefix `SKW_` for the environment; one code
registry `SKW_E_<AREA>_<NAME>` with `AREA ∈ {RT, DM, SEC, PLT, DEP}`; startup fails if any key
matching `^SK_|^SKUNK` exists, printing the rename. Cost today: a find-and-replace across five
documents. Cost after S2: a migration script and a support page. **Owner: Architect.**

### X7 — Three download-cookie designs, two of which the browser rejects

Red O9: drop the `__Host-` prefix, use `Path=/d/<key>`. Security DS-10: `__Host-sk-dl` with
`Path=/`. Platform A3: `__Host-skunk-<tenant>-dl`. Red's is the one RFC 6265bis rejects if the
prefix is kept, and a non-prefixed path-scoped cookie on a shared origin can be overwritten by a
sibling tenant on a path-prefix demo.

**Resolution.** `__Host-sk-dl-<tenantKey>; Path=/; Secure; HttpOnly; SameSite=Lax`, 10-minute TTL,
token bound to `aid` + `cid` + `jti`. The tenant key in the **name** is what prevents shadowing on a
shared origin; `Path=/` is what makes the prefix legal. **Owner: Security; Platform's naming
convention is superseded.**

### X8 — Two "frozen" argon2id parameter sets, 3.4× apart

Data Model 3.2.2: "argon2id parameters are **frozen** at `m=65536, t=3, p=1`". Security DS-6:
"Params `m=19456, t=2, p=1`". Both papers declare the parameter set immutable and neither mentions
the other. The difference is not cosmetic: 64 MiB per verify versus 19 MiB decides how many
concurrent verifications fit in a 1 GB container (Security's own arithmetic: 128 × 19 MiB = 2.4 GiB;
at 64 MiB it is 8 GiB), and it decides the measured verify cost (DM M15: 70 ms–1.13 s; Security §6.7:
27 ms) that the redemption path's latency budget and my threadpool sizing both depend on.

**Resolution.** One set, chosen by measurement, recorded in the SDS with the numbers it implies:
`m=65536, t=3, p=1` (DM12's, because the code space is 2^60 and an offline attacker with a leaked
file should not get 27 ms guesses), `SKW_ARGON2_MAX_CONCURRENT=4` (256 MiB of a 1 GB container leaves
headroom for render), `UV_THREADPOOL_SIZE=8` so 4 verifications cannot starve `fs`/DNS.
**Owner: Security, with DM's number; the semaphore is resized to the chosen memory, not inherited.**

---

## 4. Revised invariants after round 1

| # | Invariant | Falsifier |
|---|---|---|
| I1 | One request, one handler; Fastify routes first, Astro owns the tail | any URL 200 from two handlers, or `/admin` served by Astro |
| I2 | No tenant, no render — 404, never a default tenant | `Host: unknown.example.com` → 200 |
| I3 | Templates receive resolved data, never a handle | a template import of `better-sqlite3`/Drizzle/Kysely passes the build |
| I4 | `site.source()` is async on every path | a source accessor whose return is not a Promise |
| I5 | The renderer never writes, and `readonly` is not sold as isolation | any write/`ATTACH`/`VACUUM INTO` from a render connection |
| I6 | **Revised** page cost budget: ≤8 sources, ≤12 statements, summed source p95 ≤4 ms, worst source p95 ≤1.5 ms, page CPU **max ≤3 ms over 50 renders**, hard 12 ms → 503; every figure is **max of 200** samples for a source, never p95 of 20 | a published page whose registry-measured max exceeds the table |
| I7 | **Revised** round-trip is a **fixpoint** over the canonical form, 3 passes, full registry loaded | any fixture unstable at pass 2, or a `body_sha` computed over the pre-save form |
| I8 | **Hardened** page bodies contain no `<script>`, `<!--`, `<style>`, and no `on*=` attribute — enforced at **write** by a validator and a DB `CHECK`, not by the editor's behaviour | a stored `body_html` matching `/<script\|<!--\|<style\|\son[a-z]+\s*=/i`, or a save that bypasses the validator |
| I9 | Island props are serialised at SSR; islands never fetch; props carry no checksum and no filesystem path | an island-originated request during render, or a `?v=`/path in a prop |
| I10 | Tenant resolution is a pure function of (trusted header, normalised Host, prefix, revision) | two consecutive resolutions disagree, or an untrusted header changes the tenant |
| I11 | No absolute URL literal in stored HTML; every emitted URL goes through `site.url()`/`site.asset()` | a stored body containing `="/` outside a `data-` attribute |
| **I12** | **New** No request-scoped transaction: `source()` runs in autocommit, `db.inTransaction === false` on entry and between sources; nothing sets `wal_autocheckpoint` | a render that holds a snapshot across two sources, or `rg wal_autocheckpoint src/` non-empty |
| **I13** | **New** Behaviour ⊆ registry: every interactive behaviour is a registered component; the registry is closed at build time and every type re-emits `data-gjs-type` in its model defaults | a behaviour in a page that no registry entry renders, or a saved island whose `data-gjs-type` was stripped |
| **I14** | **New** A snapshot is **enumerated, not frozen** (rule below) | an exported Astro/static bundle where a URL the CMS serves 404s, or two exports of one DB at one pinned instant differing in a byte |
| **I15** | **New** No request blocks the loop >5 ms; sources ≥0.5 ms and watermark renders run off-loop with a 2 s cap; loop-delay p99 >50 ms sheds load | a 600 ms block that does not produce `503 RT_E_LOOP_CONGESTED` on an unrelated path |
| **I16** | **New** Publishing is a state transition gated on measurement: `status='published'` requires every source on the page measured at the current `specRev`, `EXPLAIN` containing `SEARCH`, page render max ≤3 ms over 50 runs, and a snapshot domain within cap when a static target exists | a published page with `cost_measured_at < spec.rev`, or with a `SCAN` in its plan |

### I6 — the numbers, and why 20 samples was wrong

Unchanged: ≤8 sources, ≤12 statements, summed source p95 ≤4 ms, worst single source ≤1.5 ms, ≤1
source above 0.5 ms, 12 ms hard → `503 RT_E_SOURCE_BUDGET`. Added: **page CPU max ≤3 ms**, measured
by rendering the page 50× at publish with `process.hrtime` around the SSR call only, discarding the
first 5 renders as warm-up. Changed: the estimator. M4 shows p95 from 20 samples spans 0.29×–13.97× the truth across two runs (n=200:
0.78×–2.31×), so a source stores `cost_ms_max` (max of 200 — a bound, never below truth) and
`cost_ms_p95` (p95 of 200), and the gate refuses on **max**, not p95. The 4 ms sum budget is
compared against the p95 of 200, because a sum of maxima over 8 sources overstates the page.

Cost of the gate: 23.7 ms for 8 sources at n=200 (M4b), plus 50 renders at ~0.13 ms = 6.5 ms →
**≈30 ms per page publish**, against a save path that already writes a page row and a revision row.
Plan-first ordering is mandatory: rejecting an unindexed source costs 0.015 ms before measurement
and 1.3 s after it.

### I13 — the island contract, and the repeat component (D-R10)

A page body may contain, from the editor: registered component types only, each of which re-emits
`data-gjs-type` in `model.defaults.attributes` (M1/M2: a type without it is silently downgraded to an
editable div). Behaviour is a **`list` component** with exactly one `[data-repeat]` child:

```html
<div data-gjs-type="list" data-island="list" data-source="posts" data-limit="3">
  <article data-repeat data-bind-title="title" data-bind-href-slug="slug"><h2></h2></article>
  <p data-empty>No posts yet.</p>
</div>
```

Rules: the child is cloned once per row; `data-bind-<attr>-<col>` writes a **text node**; `data-bind-href-<col>`
writes `href` through `site.url()`; `data-bind-asset-<col>` writes `src`/`srcset` through
`site.asset()`; no binding may target `class`, `style`, `on*`, or any `data-*` the registry does not
own; 0 rows renders the `data-empty` child only; `limit` is clamped to `limit_max` and a `data-truncated`
attribute is set. The list itself is not a hydrating island — it is server-rendered, so it costs no
client JS.

### I14 — the snapshot rule (D-R11): enumerate, cap, refuse

**Declared.** Every `query` source declares each param's domain in `spec_json.params`:
`{kind:'enum', values:[…]}` | `{kind:'int', min, max, step}` | `{kind:'page', limit}` |
`{kind:'bound', from:'path'}` | `{kind:'free'}`. A param with no declaration is a validation error,
not a default.

**Enumerated at publish.** For any page that must also ship to Astro/static, the runtime enumerates
the cross product of the non-`free` domains: `enum` as listed, `int` as `min..max step`, `page` as
`1..ceil(rows(limit)/limit)` computed against the tenant DB at publish, `bound` as one value per
published page path. Each combination becomes a snapshot file keyed
`sha256(sourceKey ‖ 0x00 ‖ canonicalParams)` at `src/content/sources/<key>/<hash>.json` (Astro) or
`_data/<key>/<hash>.json` (static). The generated `.astro` page imports the **literal** file for its
own params, so pagination is real in the exported SKU rather than a runtime lookup that has no server.

**Capped.** `SKW_SNAPSHOT_MAX_COMBOS` default **1024**, `SKW_SNAPSHOT_MAX_BYTES` 2 MB per source.
Basis from M5: a 10-row/4-col source is 561 B raw / 103 B gzip per combination; 60 combos = 33 KB raw
/ 6 KB gzip and 0.07 ms per file write; 500 combos = 274 KB / 50 KB; 4,000 = 2.2 MB / 402 KB. At
Platform's measured `astro build` rate (10 pages in 495 ms, T19), 1,024 generated pages ≈ 50 s, still
inside the ≤3 min Astro target; 4,000 would not be.

**Refused.** A `free` param cannot be snapshotted. If any rendered link in the exported page set
carries a `free` param, the export refuses with `PARAMETERISED_SOURCE` (Platform's exit 22) — that is
Platform A5's "page 2 does not exist" made impossible rather than noted. A page that *consumes* a
`free` param while nothing links to it exports at the declared default with a note naming the param
and the frozen row count.

**Pinned.** `SKW_EXPORT_NOW` (ISO 8601) is written into the bundle manifest and is the only clock
used for relative text; `SKW_RENDER_MODE=snapshot` disables the per-source TTL cache and refuses any
source marked `volatile: true`. Two exports of the same DB at the same pinned instant are
byte-identical — which is what §5.1 actually promises, and what A1 showed was false without this rule.

**Does D22 hold?** CMS: yes, unchanged. Astro: yes, for every site whose param space is enumerable —
pagination included. Static: yes under the same condition, and honestly refused otherwise. The SKU
that cannot hold is "a static site with a search box", and it is refused at export rather than
discovered by the client.

---

## 5. Measurements I ran this round

All commands are `$ node <script>` run from the probe directory named in each heading
(`~/.hermes/profiles/ceo/cache/scratch/probe/{gjs,sql,astro}/`), on the box described above. Output
is verbatim; nothing is averaged or recomputed by hand except where a line explicitly says
"marginal" or "ratio", which is arithmetic over the printed figures. Re-run before delivery, every
**structural** figure reproduced exactly — byte counts, booleans, `EXPLAIN` strings, HTTP statuses,
body byte counts. Sub-millisecond timings and the p95 ratio bounds move run to run (M1's 24-type
registration 0.5–0.8 ms; M4b's gate 23.7–20.8 ms); M4 records both runs' bounds rather than one.

### M1 — registry and island cost (`islandcost.mjs`)

```
--- registry boot cost (median of 5, headless jsdom, addType+Blocks.add) ---
types= 0  register=0.0 ms  per-type=Infinity ms
types= 8  register=0.3 ms  per-type=0.03 ms
types=24  register=0.8 ms  per-type=0.03 ms
types=48  register=1.8 ms  per-type=0.04 ms

--- page with 40 plain blocks + K islands (median of 5) ---
islands= 0  in=  3720B  out=  3720B  load=59.4ms  save=0.7ms  stable=true
islands= 1  in=  3896B  out=  3896B  load=72.1ms  save=2.1ms  stable=false
islands= 8  in=  5128B  out=  5128B  load=106.8ms  save=0.9ms  stable=false
islands=24  in=  7986B  out=  7986B  load=106.1ms  save=1.0ms  stable=false

--- stored bytes per island (attribute payload) ---
bare div            : 26 B
registered island   : 176 B
marginal per island : 150 B

--- unregistered type (one missing addType) ---
in  : <div class="island" data-gjs-type="island-0" data-island="b0" data-props='{"sku":"x"}'></div>
out : <div data-island="b0" data-props="{&quot;sku&quot;:&quot;x&quot;}" class="island"></div>   data-gjs-type kept? false
with registry: <div data-gjs-type="island-0" data-island="b0" data-props="{&quot;sku&quot;:&quot;x&quot;}" class="island"></div>   data-gjs-type kept? true
```

### M2 — per-island marginal cost and the fixpoint (`islandcost2.mjs`)

```
--- islands-only page: marginal editor cost per island (median of 5) ---
islands= 1  bytes=  110  load=5.9ms (5.86/island)  save=0.2ms (0.19/island)
islands= 8  bytes=  880  load=25.4ms (3.17/island)  save=0.3ms (0.03/island)
islands=24  bytes= 2668  load=28.0ms (1.17/island)  save=0.4ms (0.02/island)
islands=48  bytes= 5346  load=52.7ms (1.10/island)  save=0.6ms (0.01/island)

--- fixpoint, 8 islands ---
pass1==input : false
pass2==pass1 : true
pass3==pass2 : true
in  : <div class="island" data-gjs-type="island-0" data-island="b0" data-props="{&quot;k&quot;:0}"><span class="island__label" ...
out1: <div data-island="b0" data-props="{&quot;k&quot;:0}" class="island"><span class="island__label">W</span></div><div data- ...
```

Note the output: `data-gjs-type` is **absent** even though the type is registered, because this
variant's `model.defaults` does not re-emit it. That is the second way to lose the lock.

### M3 — the same page with the attribute re-emitted (`islandcost3.mjs`, one-line diff: `model.defaults.attributes = {'data-gjs-type': …}`)

```
--- islands-only page: marginal editor cost per island (median of 5) ---
islands= 1  bytes=  135  load=3.8ms (3.80/island)  save=0.1ms (0.13/island)
islands= 8  bytes= 1080  load=8.4ms (1.05/island)  save=0.3ms (0.03/island)
islands=24  bytes= 3282  load=16.5ms (0.69/island)  save=0.4ms (0.02/island)
islands=48  bytes= 6574  load=27.5ms (0.57/island)  save=0.5ms (0.01/island)

--- fixpoint, 8 islands ---
pass1==input : false
pass2==pass1 : true
pass3==pass2 : true
out1: <div data-gjs-type="island-0" data-island="b0" data-props="{&quot;k&quot;:0}" class="island"><span class="island__label" ...
```

Marginal: (8.4−3.8)/7 = 0.66 ms/island; (16.5−8.4)/16 = 0.51; (27.5−16.5)/24 = 0.46. Bytes:
(1080−135)/7 = 135; (3282−1080)/16 = 137; (6574−3282)/24 = 137.

### M4 — the publish gate, p95 estimator error, and plan-first ordering (`gate.cjs`)

```
=== A. publish-time gate: plan check + 20 executions, per source ===
plan (indexed)  : ["SEARCH u_posts USING INDEX idx_posts_pub (status=?)"]
gate: plan=1 rows, 20 exec, total=1.61 ms, p95=0.879 ms, max=0.879 ms
gate for a 8-source page: 12.9 ms (measured shape, same db)

=== B. can 20 samples estimate p95 for a microsecond query? ===
p95 over n=400: 0.019 ms   (median sample 0.013 ms)
p95 estimated from n=20  (100 windows): 0.013–0.268 ms   ratio to truth: 0.69×–13.97×
p95 estimated from n=200 (100 windows): 0.015–0.044 ms   ratio to truth: 0.78×–2.31×

=== C. unindexed variant (same SQL, index dropped on a copy) ===
plan (unindexed): ["SCAN u_posts","USE TEMP B-TREE FOR ORDER BY"]
gate: 20 exec, total=148.8 ms, p95=15.9 ms
```

Second run of the same script, same box: `p95 over n=400: 0.047 ms`; `n=20: 0.013–0.476 ms, ratio
0.29×–10.14×`; `n=200: 0.014–0.025 ms, ratio 0.87×–1.52×`; gate `total=2.60 ms` for one source,
`20.8 ms` for eight; unindexed `152.6 ms`, `p95=15.6 ms`. The conclusion is stable (n=20 is out by
up to an order of magnitude; n=200 is within 2.3×), the bounds are not.

### M4b — gate at n=200, and the cost of checking the plan first

```
8 sources: plan check all = 1.19 ms; 200 execs x8 = 22.5 ms; gate total = 23.7 ms
single plan check: 0.015 ms
unindexed, 200 execs: 1304 ms
unindexed, plan check only x200: 0.017 ms each
```

### M5 — snapshot domain size and write cost (`gate.cjs` §D)

```
=== D. parameterised source: snapshot domain size ===
10 rows x 4 cols, JSON: 561 B  gzip: 103 B
pages=1 x tags=1 = 1 combos -> raw 1 KB, gzip ~0 KB, files 1
pages=12 x tags=5 = 60 combos -> raw 33 KB, gzip ~6 KB, files 60
pages=50 x tags=10 = 500 combos -> raw 274 KB, gzip ~50 KB, files 500
pages=200 x tags=20 = 4000 combos -> raw 2191 KB, gzip ~402 KB, files 4000
write 60 snapshot files: 4.2 ms (0.07 ms/file)
read+parse 60 snapshot files: 0.9 ms
```

### M6 — the mount seam loses request bodies (`bodysseam.mjs`)

```
--- POST /contact (no Fastify route) -> setNotFoundHandler + hijack ---
A. handler never touches req.body              status=200 body={"handler":"astro-side","bytes":0,"first":""}
B. handler reads req.body first                status=200 body={"handler":"astro-side","bytes":0,"first":""}
C. /api/echo still parses JSON           status=200 body={"got":{"a":1}}
C. /contact form-encoded reaches handler  status=200 body={"handler":"astro-side","bytes":22,"first":"code=ABC&email=a%40b.c"}
D. 1 MiB multipart through the seam       status=200 bytes=1048576 ms=1.8
```

Proof it is Fastify's parser and not the harness:

```
{"is404":true,"bodyType":"object","body":{"name":"Ada"},"rawBytes":0}
```

### M6b — the guard, measured (`bodysseam2.mjs`)

```
=== stock Fastify (default JSON parser) ===
  JSON  -> /contact   status=200 {"handler":"astro-side","bytes":0,"first":""}
  JSON  -> /api/echo  status=200 {"got":{"a":1}}
  form  -> /contact   status=200 {"handler":"astro-side","bytes":8,"first":"code=ABC"}
  text  -> /contact   status=200 {"handler":"astro-side","bytes":0,"first":""}

=== WITH is404 guard in the JSON parser ===
   [parser] is404=true url=/contact -> passing raw stream
  JSON  -> /contact   status=200 {"handler":"astro-side","bytes":14,"first":"{\"name\":\"Ada\"}"}
  JSON  -> /api/echo  status=200 {"got":{"a":1}}
  form  -> /contact   status=200 {"handler":"astro-side","bytes":8,"first":"code=ABC"}
  text  -> /contact   status=200 {"handler":"astro-side","bytes":0,"first":""}
```

`text/plain` still arrives empty (0 of 5 bytes) until the same guard covers it — using
`addContentTypeParser(['application/json','text/plain'], …)` with the identical `is404` branch gives
`guard[text/plain] -> /contact 200 {"bytes":3}` for a 3-byte payload, and `/api/echo still parsed: 200 {"got":{"a":1}}`.

### M7 — Astro's trailing-slash and case behaviour (`routes.mjs`, built dist)

Default config (`trailingSlash` unset → `ignore`):

```
/blog/a        -> 200
/blog/a/       -> 200
/Blog/A        -> 404
/blog/A        -> 200
/blog/a//      -> 301  Location=/blog/a/
/blog/a?x=1    -> 200
```

With `trailingSlash: 'never'`:

```
/blog/a        -> 200
/blog/a/       -> 301  Location=/blog/a
/Blog/A        -> 404
/blog/A        -> 200
/blog/a//      -> 301  Location=/blog/a
/blog/a?x=1    -> 200
```

Two URLs become one; `/blog/A` still 200s because `[slug].astro` accepts any case — which is why the
page lookup cannot be Astro's file router.

### M8 — write-time body validation and CSP hash cost

```
12 blocks   2.1 KB  forbidden-scan=0.0022 ms  sha256(csp)=0.0052 ms
480 blocks  83.0 KB  forbidden-scan=0.0317 ms  sha256(csp)=0.0443 ms
```

The I8 validator costs 0.03 ms on an 83 KB body — free at save time. The hash-based CSP alternative
costs 0.044 ms per render, i.e. **+34 % of a 0.13 ms render**, which is the number that decides C2 in
favour of `script-src 'self'`.

---

## 6. What I concede, and what would change my mind

1. **`ON UPDATE CASCADE` is withdrawn.** My §3.6.5 said an asset rename rewrites `u_*` rows because
   FK cascade is on by default. DM3's `ON UPDATE RESTRICT` is better on its own measurement (439 ms
   of write lock for 200k references, 2,412 ms inside the inserting transaction): a rename button
   that stalls the tenant is worse than a 409. Consequence I must carry: `cms_asset_alias` now only
   covers unreferenced renames and URLs already frozen in stored HTML, which is why C1 (the nginx
   miss path) is no longer optional.

2. **`SOURCE_NOT_PUBLIC` is a 404, not a 500.** DM's reasoning is mine, applied inconsistently.

3. **nginx strips the `/demo/<key>` prefix.** My R1 open question 1 is resolved against my own
   preference: Platform measured the stripping configuration end-to-end (T24), and IDEA §3.1's table
   already assumed it. The app emits prefixes; it does not strip them.

4. **"Run it 20× and store p95" was wrong.** M4: at n=20 the p95 estimate spans 0.29×–13.97× the
   truth across two runs, and it mostly measures the cold first execution. The gate stores max of 200.

5. **The mount seam I called settled eats request bodies.** M6: JSON and text/plain POSTs to
   Astro-owned paths arrive with 0 bytes because Fastify parses before `setNotFoundHandler`. I tested
   status codes and throughput across three mounts in R1 and never tested a body — the body/stream
   detail the red team flagged for this domain, on the opposite content type to the one they
   predicted (form-encoded survives; JSON is the one lost).

6. **`function` Data Sources leave v1.** I proposed a worker plus an fs policy; removal is stronger
   and cheaper, and Security A-5's export-direction argument is decisive.

7. **§8.1's "fully drag-and-droppable on day one" cannot be literally true** once behaviour is
   registry-bound. The honest claim is "fully draggable within the shipped component set", and the
   set is a release artefact.

**What would change my mind**

- A real Astro build of a 40-block page measuring p95 above 3 ms of SSR CPU would break I6's page
  budget — my 0.13 ms render figure is derived, not measured on a production-shaped page. I would
  raise the CPU budget and shrink the island budget rather than move data off the page.
- If a client's blog needs more than 1,024 snapshot combinations, I14's cap refuses a normal site. I
  would then make pagination a first-class generated route (one page per `page` value, no cross
  product with tags) rather than raise the cap into a 4,000-file build.
- If `data-gjs-type` can be made durable by a GrapesJS option rather than a per-type default (M2 vs
  M3), the registry's correctness cost drops, but the expressiveness bound does not move.
- If someone demonstrates a tenant-authored interaction that survives a round trip *without* a
  registry entry, I13 is wrong and the editor is more capable than I measured.
- If `req.is404` stops being readable inside a content-type parser (a Fastify change), D-R12 becomes
  a wildcard route with a per-route parser — same behaviour, different seam. The integration test
  that asserts a 1 MiB JSON POST reaches the Astro handler with its bytes intact is the thing that
  must exist either way.
