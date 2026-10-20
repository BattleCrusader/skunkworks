# R1 — Red Team

Attacking `IDEA.md` (619 lines, D1–D24) as written. No domain papers exist yet, so every objection
targets a sentence in the spec and names the assumption the owning domain will have to make to
answer it. Measurements marked **measured** were run on this machine for this report; everything
else states what would settle it.

Measurement provenance: SQLite 3.43.2, Node 22.23.1, argon2-cffi 25.1.0 (argon2id t=3, m=64 MiB,
p=4), macOS 15.7.4.

---

## 1. Objections, ranked by cost-to-fix if found late (each: claim attacked / concrete failure scenario / severity / what would settle it)

### O1 — `cms_download_code.code_hash` is argon2id, so redemption cannot look a code up. It scans. **BLOCKER**

**Claim attacked.** §7.4 step 2: "verify. Rate limit 5 attempts / 15 min per IP **and** per code
hash; argon2id compare; on an unknown code perform a dummy compare". §7.6: codes are "only ever
stored as an argon2id hash".

**Failure scenario.** Argon2id is salted per row. Hashing the same code twice gives two different
strings (**measured**: `$argon2id$v=19$m=65536,t=3,p=4$C4NKzdcG…` vs `…$cN4aY3lo…`, identical =
False), so `WHERE code_hash = ?` cannot exist. Verification is therefore a sequential
argon2-verify against every issued code. At the shipped params a single verify is **91.4 ms median
measured**; 300 stored codes took **31,514 ms** for one wrong attempt (105 ms/row), which
extrapolates linearly to **263 s average / 525 s worst case at 5,000 codes**. The cliff arrives far
earlier than 5,000: 40 codes = 4 s per attempt, 200 codes = 21 s. One bulk-CSV campaign of 500 codes
makes the customer-facing download form time out at the gateway, and every wrong guess (there is no
per-code rate limit, because you cannot identify the code to bucket it) burns a full scan. The
"dummy compare so response time does not leak existence" is not just redundant — the scan already
leaks position by timing.

**Severity.** Blocker. Fix late = schema change + reissue of every outstanding code + rewrite of
issuance, redemption and the rate limiter, with live codes that cannot be migrated (you cannot
recompute a hash you never stored).

**Settles it.** Seed 1,000 codes, `time curl -X POST /d/<key>` with one wrong code. Fix direction:
add a deterministic keyed index column (`HMAC-SHA256(server_pepper, code)`, **measured** 2.4 µs per
compute) for lookup and rate-limit bucketing, keep argon2id as the constant-time verifier on the one
matched row.

---

### O2 — The exported bundle excludes `control.db`, so the sold site has no tenant, no domain, no admin, and possibly a demo TTL that deletes it. **BLOCKER**

**Claim attacked.** §5 export contents: `docker-compose.yml` · `.env` · `data/site.db` · `content/`
· `install.sh`. §6: control.db tables are "Global, **never exported**". install.sh "tenant marked
active".

**Failure scenario.** `tenants`, `domains`, `users`, `sessions` all live in control.db and are
explicitly never exported. The bundle therefore arrives with no row saying which host it answers to,
no `users` row to log in as, and no `tenants.mode`. install.sh's own described job — "tenant marked
active" — requires all four. `.env` carries "generated secrets, domain, ACME email" and no admin
principal, so there is no specified path to a first login. Two outcomes, both shipping: (a) the app
boots, `Host` lookup misses, every request 404s and the client's installer reports success because
nginx is up; or (b) install.sh seeds `mode` from a default, and if that default is `demo`, §5's
"TTL auto-expiry" applies to the site they just bought — it deletes itself weeks later. Same class:
the demo tenant's `noindex` / watermark banner settings travel in `cms_settings` while `mode` does
not, so a bundle exported from a demo can go live wearing the demo furniture.

**Severity.** Blocker — this is the SKU in §1.1, failing at minute four of a five-minute install.

**Settles it.** Unpack a bundle on a clean host, `docker compose up -d`, then answer three
questions from the artifacts alone: which hostname does this answer, what is the admin username,
what is `mode`. Fix direction: install.sh must run `drizzle migrate` to create control.db, then seed
tenant + domain + first admin from `.env` (`ADMIN_EMAIL`, `ADMIN_PASSWORD_ONCE`), and explicitly
force `mode=production`.

---

### O3 — "Export has nothing to filter" is false. The bundle ships other people's data. **MAJOR (breach-shaped)**

**Claim attacked.** §5: "Because the DB is per-tenant and user tables live in that same file, export
has **nothing to filter** — this is why D2 matters."

**Failure scenario.** D2 removes the *cross-tenant* filter; it does nothing about *intra-tenant*
transient data, and the bundle carries `data/site.db` and `content/` wholesale. A demo tenant used
for two weeks of prospecting contains `cms_form_submissions` (every prospect's name, email, message,
IP), `cms_download_code` (buyer emails, `order_ref`, live code hashes), `cms_download_event`
(`ip_hash`, `ua_hash`, bytes), `audit_log`, and `content/protected/wm/` — which per §7.8 is keyed
`<spec_sha>/<asset_sha>` and stores **one stamped file per purchaser**, each carrying a different
buyer's email in the footer. Export that to the client who buys the design and you hand them a
database of your sales pipeline plus a folder of other customers' watermarked copies. The size
compounds: 1,000 buyers × a 5 MB book × the measured +60% stamp growth ≈ 8 GB of archive that no
eviction policy removes, inside the tar they are told unpacks in five minutes.

**Severity.** Major, escalating to a notifiable incident the first time it ships.

**Settles it.** Export a demo that has 20 form submissions and 5 redemptions; then
`grep -r '@' site-bundle/` and `du -sh content/protected`. Fix direction: an explicit export
manifest — exclude `protected/`, and either refuse to export a tenant with submissions or emit them
to a separate `EXPORT-PII/` folder the operator must consciously delete.

---

### O4 — Stored GrapesJS HTML has no loop semantics, and nothing in 619 lines says how a Data Source becomes repeated markup. **BLOCKER for S4**

**Claim attacked.** §8.2: bindings "are inserted as placeholders (`<div data-source="posts"
data-limit="3">`) and resolved at SSR, so generated HTML stays static and readable." §8.1: "Astro
owns the shell… it does not own the page body."

**Failure scenario.** A placeholder div must become N sibling `<article>` elements. GrapesJS has no
concept of a repeat region — a designer drags a "Latest posts" block and gets *one* card; the SSR
pass must clone it per row, which means a template language (child selector? `data-template`
attribute? mustache inside?), an escaping policy for injected values, and a defined behaviour when
the source returns 0 rows or 50. None of that is specified. The two content models — `.astro` pages
with a `site.source()` frontmatter call, and stored HTML with a placeholder div — are not reconcilable
by "resolve at SSR"; one is a component render and the other is a mini template engine with its own
XSS surface. Builders will discover this in S4, after the editor, the block registry and the
round-trip gate are written against a body format that cannot express the first thing a prospect
asks for ("show my latest three posts").

**Severity.** Blocker. Found in week 6 this is a rewrite of the block registry, the renderer and the
exporters, because every block's stored markup changes shape.

**Settles it.** Author a three-post list in the editor on the fixture site, publish, and count
`<article>` elements in the served HTML. If the answer is 1, the design has no loop. Decide the
repeat contract before the SDS freezes `cms_page_blocks`.

---

### O5 — Protected tables protect *shape*, not *content*, and `cms_asset.storage_path` is content. Symlink farm turns a form edit into arbitrary file read. **MAJOR**

**Claim attacked.** §6: core tables are "Protected: the DDL runner refuses CREATE/ALTER/DROP. **Row
data is editable through the CRUD forms**, as the brief requires." §7.3/D18: `content/public/<key>.<ext>`
is a symlink to `media/<hh>/<sha256>.<ext>`, regenerated on create/rename/delete.

**Failure scenario.** `cms_asset.storage_path` is listed in §7.1 as an essential column and is row
data, so a CRUD form exposes it. The symlink regenerator reads that column. Set
`storage_path = ../../../../etc/passwd` on an asset with `key = leak`, `.ext = txt`; the farm creates
`content/public/leak.txt → ../../../../etc/passwd`, and `GET /media/leak.txt` is served by nginx with
`disable_symlinks` off (default). No DDL ran, no `u_*` table was touched, and the audit log records a
routine asset edit. Same vector on `cms_asset_variant.path`, and on `sha256` feeding
`X-Accel-Redirect`. In a sold bundle the admin is the client's marketing hire, which is exactly the
account that gets phished.

**Severity.** Major — a path-traversal in a product sold to third parties, reachable from the UI the
brief insists must exist.

**Settles it.** Set the field to `../../../../etc/passwd` through the asset form, request
`/media/<key>.txt`, read the response. Fix direction: a per-column write policy in the CRUD
generator (immutable / computed / form-editable), with `storage_path`, `sha256`, `uses`,
`code_hash`, `is_public` on the immutable side; assert every generated form against it in a test.

---

### O6 — Tenant resolution trusts `X-Skunkworks-Tenant` ahead of `Host`, and the admin needs a published port. One header reads another tenant. **BLOCKER if exposed**

**Claim attacked.** §3.1 resolution order: "(1) `X-Skunkworks-Tenant` injected by nginx → (2) exact
`Host` match in `control.db`". §9: "Tenancy: One DB per tenant; no cross-tenant query path exists by
construction." D9: admin on a separate origin/**port**.

**Failure scenario.** Priority 1 is a header the app cannot distinguish from one nginx set. D9 requires
a separate port for admin, so a port gets published; if the same resolver serves it, `curl -H
'X-Skunkworks-Tenant: acme' -H 'Host: irrelevant' http://box:3000/` renders acme's site — including
slugs hidden from nav and anything mid-edit — with no query crossing a boundary, because the resolver
chose the database by header. Point the same header at the admin listener and, with any valid session
cookie for that origin, it is acme's admin. The "by construction" claim is true of SQL and false of
the resolver, which sits *in front of* SQL.

**Severity.** Blocker if exposed; a three-line fix, which is precisely why it will be assumed rather
than written down.

**Settles it.** With nginx stopped, curl both ports with that header. Fix direction: app and admin
bind to the compose network or a unix socket only; nginx sets the header with `proxy_set_header`
(overwrite, never append); the app refuses to boot unless the peer is loopback or a configured proxy
CIDR, and strips any inbound `X-Skunkworks-*` from untrusted peers.

---

### O7 — nginx-proxy's vhosts are container-creation-time config; tenants are runtime rows. **MAJOR**

**Claim attacked.** §3.1/D7: "Host-based tenant routing is primary"; §5: "A demo created as a
subdomain needs one DNS `A` record and gets its cert automatically"; §9: on-demand TLS behind an
`ask` endpoint.

**Failure scenario.** `nginx-proxy` + `acme-companion` derive `server_name` and cert targets from
container env/labels at creation. There is one `app` container, so adding `newclient.com` means
recreating it with a new `VIRTUAL_HOST` — every other tenant on the box gets a connection-refused
window while the proxy re-resolves the upstream, and acme-companion re-walks issuance. The `ask`
endpoint in §9 is a *different* mechanism (on-demand TLS) that contradicts per-host HTTP-01 in D7;
whichever is built, the other sentence is wrong and the Builder will pick one at random. Worse, with
no catch-all `server_name _` block, a host that resolves to the box before its vhost exists lands on
whichever `server` block nginx loaded first — a prospect who points their domain at you early sees
another client's site on their own domain.

**Severity.** Major: cross-client content exposure on a stranger's domain, plus an all-tenant blip
per sales close.

**Settles it.** On a running two-tenant stack, add a third domain and time (a) the moment its site
resolves and (b) the 502s on tenants 1–2. Separately `curl -H 'Host: not-a-tenant.example' http://box/`
and see whose page comes back. Fix direction: one catch-all `default_server` returning 410, a
generated `conf.d/*.conf` include directory written by the app and `nginx -s reload`, and on-demand
TLS with the `ask` endpoint as the single mechanism.

---

### O8 — `max_uses` counts HTTP requests, not downloads. Range support burns the quota. **MAJOR**

**Claim attacked.** §7.4 step 4: atomic `UPDATE … SET uses = uses + 1 WHERE id = ? AND uses < max_uses`
then `X-Accel-Redirect`; D14: nginx "does the byte-shuffling, **with range support**".

**Failure scenario.** D14 puts Range at nginx, which means a ranged or resumed transfer is a *new
request* to `/d/<key>/file`, each passing through the app and each incrementing `uses`. The tenant
default is **3** (§7.6). One 80 MB PDF opened in Chrome preview: initial request, a Range re-request
when the viewer seeks, and one more on resume after a sleep → the customer's code is exhausted before
they reach page 40, and the third request is denied by their own download. A download manager with 8
parallel connections spends 8 uses on one click. `uses < max_uses` is atomic; it is atomic about the
wrong unit.

**Severity.** Major — the flagship feature (§1.2, "a customer buys a PDF book") fails on the default
configuration, in the customer's hands, with no error the admin can explain.

**Settles it.** `curl -r 0-1023` twice against a 1-use code and read `cms_download_code.uses`.
Fix direction: increment once when the 10-minute token is *first* exchanged for bytes, mark the token
"counted", and serve subsequent ranged requests under the same token without re-incrementing; the
`cms_download_event` row keeps `ranged` so the accounting still reconciles.

---

### O9 — `__Host-` cookies cannot be path-scoped. Both cookie designs in the spec are rejected by the browser. **MAJOR**

**Claim attacked.** §3.1: "every session cookie must be `__Host-` prefixed **and path-scoped**".
§7.4 step 3: `Set-Cookie: __Host-dl-<key>=…; …; Path=/d/<key>`.

**Failure scenario.** The `__Host-` prefix is only honoured when the cookie is `Secure`, has
`Path=/`, and carries no `Domain` (RFC 6265bis §4.1.3.2); a cookie named `__Host-dl-book` with
`Path=/d/book` is **discarded** by Chrome and Firefox, silently, with a console warning nobody reads.
Gated downloads then loop: POST succeeds, token is "set", the redirect to `/d/book/file` arrives with
no cookie, and the user is bounced back to the form forever — on every browser, only for path-prefixed
demos, which is the fallback nobody tests. The second half of the claim is worse: `__Host-` provides
**no isolation between paths on one origin**. On a path-prefixed deployment (§3.1, D7 fallback) the
parent origin's admin session cookie is sent to `/demo/acme/*` and `/demo/beta/*` — tenant-authored
HTML with JS in it, per §8 ("pure HTML/JS") — which is a session-theft path from a demo page to the
admin.

**Severity.** Major: a broken paid-download flow plus a cross-tenant session exposure, both created
by the fix that was supposed to prevent them.

**Settles it.** On `https://<origin>`, set both cookie forms and read `document.cookie` back; the
`Path=/d/<key>` one is absent. Fix direction: drop the prefix for the download token (use a random
name with `Path=/d/<key>` and `HttpOnly`), and treat path-prefix demos as untrusted-origin — no
admin cookie on the parent origin at all, or admin moves to its own hostname.

---

### O10 — D2's isolation is data-only; the process model makes it availability-blind, and §4 lets tenants run code in it. **MAJOR**

**Claim attacked.** D2 rationale "Blast-radius isolation, no cross-tenant leak by construction"; §3
"app (single Node process)"; §4 kind 3: `function` sources are "a trusted JS module … runs in-process
against a read-only handle".

**Failure scenario.** One process, no per-tenant worker, no request timeout, no memory ceiling. A
tenant's `sources/aggregate.js` with `while(true){}` — or just a 40k-row join under a cold cache —
stalls the event loop and every tenant on the box 502s. A memory leak in one source OOMs the container
and takes all 40 demo sites with it. "No cross-tenant query path exists by construction" remains true
and is irrelevant: the availability blast radius is the entire host, and the code that causes it is
authored by whoever edits `content/sources/`, which in a sold bundle is the client.

**Severity.** Major — the first client-authored bug becomes a whole-fleet outage and there is no
lever to stop it except restarting the process.

**Settles it.** Publish that source, hit the page, and watch a second tenant's `curl` time out.
Fix direction: hard `vm` timeout or a `worker_thread` per function invocation with a wall-clock cap,
plus a per-tenant concurrency semaphore; state the numbers in the SDS (e.g. 250 ms budget, 8
concurrent).

---

### O11 — The Astro SKU ships without a lockfile and is never built by the exporter. **MAJOR**

**Claim attacked.** §5.1: Astro project = `package.json`, `astro.config.mjs`, `src/pages/*.astro`,
`src/content/*.json`, `public/`, `src/components/`, "plus a README with the exact deploy commands";
"`npm ci && npm run build`"; "Target install time ≤ 3 min".

**Failure scenario.** `npm ci` refuses to run without a lockfile — **measured**, exit 1, verbatim:
`npm error code EUSAGE` / "The `npm ci` command can only install with an existing package-lock.json
or npm-shrinkwrap.json". The bundle contents list no `package-lock.json`, no `tsconfig.json`, and "islands carry
their own React/Vue dependencies", meaning the exporter synthesises a dependency set per site. Even
with a lockfile, nothing in §5 says the exporter ever *builds* the project it generates, so every
Astro SKU is untested code that compiles for the first time on the client's box, with their npm
registry, their Node version and their corporate proxy. §1.1's "running in ~5 minutes without drama"
becomes a screen of red.

**Severity.** Major — one of three sellable outcomes is broken on first use, and the failure surfaces
in front of the buyer.

**Settles it.** Export the fixture site, then `npm ci && npm run build` in a clean container with no
network cache. Fix direction: the exporter emits a lockfile it itself resolved, and the release gate
runs the generated project's build in CI before the bundle is allowed to ship.

---

### O12 — Watermark render cache is per-purchaser with no eviction, so it is an archive, not a cache. **MAJOR**

**Claim attacked.** §7.8: cache key `content/protected/wm/<spec_sha>/<asset_sha>.<ext>`, "recorded in
`cms_watermark_render` for quota accounting"; "A cache is an optimisation, not a requirement, but
keep it".

**Failure scenario.** Per-purchaser text means `spec_sha` differs per buyer, so cache hit rate is
≈1 and every redemption creates a permanent copy. Measured stamp growth is +60%
(32,782 → 52,432 B); a 5 MB book becomes ~8 MB, and 1,000 buyers leave ~8 GB on a box whose per-tenant
byte quota accounts for it (§7.7) but whose deletion policy does not. First symptom: a tenant's disk
fills mid-quarter, `SQLITE_FULL` on writes, and the admin panel cannot save the page that would let
them announce the outage. Second: the copies travel in the export (O3).

**Severity.** Major — silent capacity exhaustion with a paid-traffic trigger.

**Settles it.** Run 1,000 redemptions of one 5 MB asset and `du -sh content/protected`; then check
whether anything ever deletes a row. Fix direction: state the eviction rule in the SDS (LRU to a
byte ceiling, or regenerate-on-demand and keep zero copies for specs with per-user variables).

---

### O13 — The Data Source TTL cache key omits the parameters, so cached answers are served to the wrong question. **MAJOR**

**Claim attacked.** §4 enforcement: "Per-source TTL cache to absorb traffic spikes"; §4 kind 2 spec
carries `limit_default` / `limit_max` per call.

**Failure scenario.** The cache is described as *per-source*, and `site.source('posts', { limit: 3 })`
and `site.source('posts', { limit: 50 })` are the same source. A homepage warms the cache with 50
rows; the sidebar that asked for 3 renders 50 for the next `ttl_s`. Reverse order and the homepage
shows 3. No error, no log, wrong content on a client's live site, and it varies by which page was
hit first — the classic "it's fine on my machine, wrong in production" bug that costs two days to
believe. Same shape for any `where` param.

**Severity.** Major — silent wrong output, and it is the *published* page, not an edge case.

**Settles it.** Two pages, same source, different `limit`, hit in both orders within one TTL.
Fix direction: cache key = source key + canonicalised parameter hash + tenant; assert it in a test
that would fail if the key drops a param.

---

### O14 — The "transactional DDL runner" covers create and add-column; the rest of SQLite's ALTER surface is a refusal the admin UI has no model for. **MINOR**

**Claim attacked.** §6: `u_*` tables "Created/altered/dropped by the admin table builder, through a
transactional DDL runner"; types "regenerated on change".

**Failure scenario.** **Measured on SQLite 3.43.2**: `ALTER TABLE u_products ADD COLUMN price NUMERIC
NOT NULL` → `Cannot add a NOT NULL column with default value NULL`; `ALTER TABLE u_products DROP
COLUMN cover` after `CREATE INDEX ix_cover ON u_products(cover)` → `error in index ix_cover after
drop column: no such column: cover`. (Adding a column *with* `REFERENCES` does work, and the FK lands
in the schema.) So the builder's "alter" is a partial function whose refusals surface as raw SQLite
text in a modal, mid-flow, after the operator has already described the change. And "types regenerated
on change" writes a `.d.ts` the running process can never see — the runtime guarantee is zero.

**Severity.** Minor technically, but it is the difference between an admin UI and a SQL console with
extra steps, and the brief forbids the latter.

**Settles it.** Run the alteration matrix (add nullable, add NOT NULL, drop plain, drop indexed,
rename, change type) through the builder and assert each either succeeds or is disabled in the UI
with a reason.

---

### O15 — "Real referential integrity comes free" is conditional on a pragma that defaults off. **MINOR**

**Claim attacked.** §7.3: "SQLite enforces the FK to `cms_asset(key)` … **regardless of whether
Drizzle or Kysely created the table**, so you cannot orphan a cover image."

**Failure scenario.** **Measured**: `PRAGMA foreign_keys` on a fresh connection returns `0`; an
INSERT of `cover='no-such-key'` succeeded (`orphan inserted, rows=3`), and the same INSERT failed
(`FOREIGN KEY constraint failed (19)`) only after `PRAGMA foreign_keys=ON`. Every connection path
must set it — Drizzle's pool, Kysely's introspector, the read-only render handle, the DDL runner, any
future `better-sqlite3` shortcut, the watermark renderer. One that forgets turns the guarantee into a
comment, and the symptom (a page with a broken image) appears months later with no audit trail.

**Severity.** Minor, cheap to make true, expensive to discover.

**Settles it.** A test that opens every connection factory the codebase exports and asserts
`PRAGMA foreign_keys = 1` on each, plus a `CHECK` that `cms_asset.key` is UNIQUE (it is, but the FK
target requires it and nothing says so).

---

### O16 — Fail-closed watermarking has no exemption for encrypted PDFs, which are not corrupt. **MINOR**

**Claim attacked.** §7.8 fail policy: "Corrupt PDF or unencodable text denies the download"; "the
issue screen warns when the selected asset cannot be stamped" — the warning list covers video and
audio only.

**Failure scenario.** A publisher's own ebook exported from InDesign with an owner password is a
normal paid asset. `pdf-lib` cannot load it without the password, so every download is denied by the
fail-closed rule, and the issue screen said nothing because the asset is `kind=document`, not
`kind=video`. The client's product is 100% undeliverable and the admin panel reports it as a
watermark failure, which reads like our bug — it is, but of omission.

**Severity.** Minor frequency, major impact for that tenant.

**Settles it.** `PDFDocument.load()` an owner-password PDF and record the throw; then decide:
detect `isEncrypted` at upload and warn at issue time, or allow an explicit per-asset
"deliver unwatermarked, log it" flag.

---

## 2. Load-bearing optimism I expect from each domain (Data Model, Security, Runtime, Platform)

**Data Model.** Expect: "the DDL runner plus Kysely introspection gives `u_*` a real type system",
"the `asset` column type gets referential integrity for free", "prefix-protected tables make the core
schema safe to expose through CRUD", "transactional DDL means no half-migrated table".
The three-weeks item: **the `asset` column will be modelled as plain `TEXT` with an FK that only
exists on tables the builder created after that rule**, so pre-existing and hand-migrated tables drift
and the "cannot orphan a cover image" guarantee holds for an unknown fraction of the tenant DB — and
once a page stores a sha instead of a key (because TEXT FKs are awkward through Kysely's inferred
types), the export stops being portable and D17 quietly dies. Second: they will treat "regenerated
types" as a runtime boundary when it is editor autocomplete.

**Security.** Expect: "argon2id makes codes safe at rest" (true, and irrelevant to O1), "one DB per
tenant means no cross-tenant query path" (true, and defeated without a query — see **O6**: the
resolution order trusts `X-Skunkworks-Tenant` at priority 1, so on any published app or admin port
`curl -H 'X-Skunkworks-Tenant: other' http://box:3000/` renders another tenant's site),
"`internal` + `X-Accel-Redirect` is a boundary" (only while the app is unreachable except through
nginx — the compose file decides, not the security section), "the IP allowlist contains the DDL
surface" (for a sold bundle the client's staff are on dynamic IPs, so the allowlist is either empty —
and then it is not a control — or it locks out the buyer on day two). The three-weeks item is
**O1**: the entire gated-download feature is built on a hash that cannot be indexed, and every
downstream control (rate limiting per code, timing equalisation, "shown once") is written against
that assumption.

**Runtime.** Expect: "SSR per request is cheap" (true for markup), "the TTL cache absorbs spikes"
(O13: keyed wrong, and with no single-flight a cache miss on a cold tenant multiplies the query by
concurrency — publish invalidates, so the spike arrives exactly when the client is watching), "Astro
middleware mode composes with Fastify" (it does, until both want the body: Fastify parses JSON for
`/api` while Astro's form POST needs the raw stream, and a `preParsing` hook is the kind of detail
that eats a day). The three-weeks item is **O4**: they will write "resolve placeholders at SSR" as a
helper function, and it is a repeat-template engine with an escaping policy that has to be right on
the same pages that accept client-authored HTML.

**Platform.** Expect: "`docker compose up` is five minutes", "nginx-proxy handles new tenants because
it watches Docker", "the path-prefix fallback is one `location` block", "50 certs per registered
domain per week is plenty". The first and third are the expensive ones: adding a tenant is a container
recreate in a label-driven proxy (O7), and every URL the app emits — canonical, sitemap, form
`action`, redirect, asset — needs `X-Forwarded-Prefix` because Astro's `base` is build-time (§3.1 says
so and then does not budget for it; one missed helper is a 404 on a demo the prospect is looking at).
The three-weeks item is dynamic vhosts.

---

## 3. Coupling traps (two individually defensible decisions that combine badly)

**T1 — D14 (nginx owns Range) × D19/§7.4 (atomic per-request `uses` increment).** Each defence is
right alone; together, range support *is* the quota leak (O8). The unit of accounting is a request
where the product's unit is a download.

**T2 — D9 (admin on a separate origin/port) × §3 (tenant cache in memory with a version stamp).** If
"separate origin" is implemented as a second container or process (the only reading that gives a real
origin), the render process's cached tenant map has no way to see the admin's write except a shared
version stamp that does not exist. Add a domain, and the new site 404s until someone restarts the
renderer — hours, if nobody is watching. If instead it is one process on two ports, D9's protection
is a bind address and the allowlist, which is weaker than the section implies. Either way the coupling
was never decided.

**T3 — D7 path-prefix demos (shared origin) × §8 client-authored HTML/JS × origin-scoped cookies.**
Every cookie on the parent origin goes to every tenant on it. `__Host-` does not scope by path (O9),
so the "cookie consequence" in §3.1 is not a mitigation — it is a syntax error the browser rejects.
A demo page with a `<script>` can read `document.cookie`, and the admin cookie is on the same origin.

**T4 — D2 (per-tenant DB = blast-radius isolation) × D1/§3 (one Node process) × §4 `function`
sources (tenant JS in-process).** The isolation is claimed at the storage layer and consumed at the
availability layer. The paper will say "no cross-tenant leak by construction" and mean it, while a
single `while(true)` owns every tenant on the box (O10).

**T5 — D20 (per-purchaser watermark text forks the bytes) × D13/D18 (content-addressed, immutable,
`content/` ships wholesale in the bundle).** Per-purchaser content is incompatible with
content-addressed immutability by definition, so the "cache" becomes an unbounded archive (O12) and
the export carries other buyers' copies (O3). Both decisions are separately correct; the combination
has no owner.

---

## 4. The 5-minute install, walked step by step, with where it becomes 25 minutes

Target from §1.1/§5: `tar xf && ./install.sh && docker compose up -d`, "< 5 minutes, measured, not
asserted". Walked literally, on a fresh VPS, with a client who has never seen the product.

| # | Step | Nominal | Realistic | What blows it |
|---|---|---|---|---|
| 1 | Client has Docker + compose v2 | 0 s | 0 s – 20 min | Fresh Ubuntu has neither. install.sh cannot install Docker without assuming root and a package manager, and nothing says it does. `docker-compose` (v1) vs `docker compose` alone kills the script. |
| 2 | Bundle arrives and unpacks | 5 s | 30 s – 20 min | The tar is sized by the client's **media**, and §1.2 sells video and archives. 1 GB at 20 Mbps = ~6.8 min; 3 GB ≈ 20 min. Our five-minute clock is already spent before `install.sh` runs, in a channel we do not control. |
| 3 | `install.sh` generates secrets, writes `.env` | 2 s | 2 s | Fine. This part is honestly cheap. |
| 4 | DNS check | 5 s | 0 s – 60 min | The client changed the A record minutes ago. TTL 300–3600 s. The script can only block or warn, and both look like a hang to a non-technical operator. |
| 5 | `docker compose pull` (pinned image) | 20 s | 60 s – 3 min | Base `node:22-alpine` is **234 MB measured** here; with sharp's libvips, pdf-lib and a native sqlite/argon2 build, 350–450 MB on disk, ~150 MB compressed. At 20 Mbps ≈ 1 min, at 10 Mbps ≈ 2 min. Not the killer, but it is a hard floor of ~1 min that the 5-minute budget must contain. |
| 6 | acme issues the per-host cert (HTTP-01) | 10 s | 10 s – never | Needs inbound port 80 open **and** no redirect in front of it. A client behind Cloudflare with "Always Use HTTPS", a corporate firewall, or CGNAT fails validation; acme-companion retries on a ~60 s cadence, so the operator watches a loop that looks like progress. This is the branch that turns 5 minutes into 25 and then into a support call. |
| 7 | control.db bootstrap + first admin | unstated | undefined | §6 says control.db is "never exported" and §5 does not put it in the bundle (O2). install.sh must create it, migrate it, seed tenant + domain + admin — none of which is specified, and `.env` carries no admin identity. Without it: 404s with a green compose status. |
| 8 | Admin login | 10 s | blocked | D9's IP allowlist is empty (deny all) or set to our office IP (deny the client). Either way the last step of the install is a phone call. Nothing in §5 specifies how a self-installed bundle decides who may reach admin. |

**Where it becomes 25 minutes.** Step 6, then step 4, then step 7. The cert retry loop is the one
that *looks* like it is working, so it burns the full window before anyone diagnoses DNS. The honest
claim the SDS can make is: **≤5 minutes from a running Docker host with DNS already propagated, port
80 reachable, and the image already pulled — measured on our hardware**; everything outside that
bracket needs its own line in the install runbook, and install.sh should refuse early with a
pre-flight (DNS resolves to this box, port 80 answers from the internet, Docker version ≥ X) rather
than half-install and wait.

---

## 5. Things that are right and must not be re-litigated

**D2 — one SQLite file per tenant, plus a global control.db.** This is the correct call and it should
be frozen. Export-by-file-copy is real, the "no cross-tenant query path by construction" property is
real, and the shared-schema alternative would put a `WHERE tenant_id = ?` between every client and
every other client's data forever. Every objection above that touches tenancy (O2, O3, O7, O10) is
about the control-plane, the process model or the export manifest — none of them is an argument
against per-tenant files. Do not let the debate reopen the storage model in response to them.

Two more that are settled on evidence, not opinion:

- **D17/D13 — asset identity is the key, the checksum is only the address.** This resolves a genuine
  ambiguity that most CMSs get wrong (`storage_path` leaking into content), and it is what makes
  export portable. Keep it; fix the *writability* of `storage_path` (O5), not the model.
- **D23 — cp1252, not ASCII.** Measured, correct, and the alternative mangles `München` for no gain.

---

## 6. Silence — what nobody specified that a week-one client hits

1. **Email transport.** §7.6 has a Stripe webhook generate a code and email the purchaser; §11 never
   mentions SMTP, a provider, a from-address, SPF/DKIM, bounces or a retry. The first real sale ends
   with a paid buyer holding nothing, and "codes are shown once, never recoverable" means the only
   remedy is reissue — which revokes the code the customer may already have in an inbox. Decide the
   transport and a redelivery path before the first webhook is wired.
2. **Backups.** One file per tenant, no `VACUUM INTO`, no off-box copy, no restore test. A WAL-mode
   `cp site.db` is a torn file. The week-one trigger: someone deletes a page, or runs
   `docker compose down -v`.
3. **Upgrades.** D10 pins an image tag, so a CVE fix requires the client to edit compose. There is no
   update channel, no version endpoint, and no story for a Drizzle migration arriving at a DB that
   already holds `u_*` tables and a year of submissions.
4. **Draft / staging.** "Pages must be hideable" is the only draft primitive. A client asks to show
   the boss a change before it goes live, and the answer is a second tenant, hand-managed, with the
   content copied by hand. `linked-private` in §7.2 implies preview sessions; nothing defines them.
5. **Hand-edited HTML then the canvas.** §8.2 says "hand-edited HTML always wins" and "the canvas
   renders whatever is stored" — so the moment a designer fixes a typo in the code view, the next
   person to drag a block re-serialises GrapesJS's model and the hand edit disappears, silently. No
   "this page is editor-managed" flag exists.
6. **Form spam.** The brief says "safeguards against flooding"; §5.1 stores submissions per tenant.
   No captcha, no honeypot, no per-IP limit on `/forms/*`. The first public contact form gets a few
   hundred rows in a week and the client reads them.
7. **Tenant departure.** Demo `TTL auto-expiry` is named but its cascade is not: what happens to
   media, watermark renders, submissions and the DNS record when a demo expires mid-negotiation, and
   what the client receives when they leave. Nothing in §5 defines deletion, handover or a DNS
   cutover runbook.
