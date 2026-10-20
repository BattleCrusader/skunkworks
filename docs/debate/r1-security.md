# R1 — Security

Scope: threat model, authN/authZ, sessions, the runtime DDL surface, uploads, gated downloads,
secrets, tenant isolation. Every "measured" line in §6 was run on this box today; anything I
reasoned about without measuring is labelled as such.

Position in one line: **the plan's security model is a set of permission checks inside one Node
process, and one of those checks (the read-only handle) is not an isolation boundary — I measured
`control.db` being read through it.** The rest of this paper is what must change to make that untrue
by construction rather than by discipline.

---

## 1. Invariants I will defend (numbered, falsifiable)

**S-1 — No SQL text from a browser, and no statement class the generator cannot emit.**
The table builder accepts a typed `TableSpec` (JSON), never SQL. The generator emits from a closed
set of templates. A request cannot cause `ATTACH`, `PRAGMA`, `CREATE TRIGGER`, `CREATE VIEW`,
`CREATE TABLE … AS SELECT`, or a rewrite of `sqlite_master`.
*Falsified by:* any request body reaching `exec()`/`prepare()` as text; or emitted DDL containing a
quote-delimited literal that came from user input; or any of the five payloads in §2 DS-1 succeeding.
*Why it is stated this way:* "we validate the identifier with `^u_[a-z0-9_]+$`" is not this
invariant. `prepare('ATTACH DATABASE ? AS z')` is a **single, legal, fully-bound statement** — no
interpolation to validate — and better-sqlite3 accepts it (measured, §6.2). Prefix checks and
interpolation bans both miss it. Only statement-class rejection catches it.

**S-2 — A request served for tenant A cannot touch a byte outside `tenants/A/`.**
Holds even when the code executing the request is hostile — a `function` datasource, a compromised
dependency, a template bug. "Read-only" is not the property; "cannot open another file" is.
*Falsified by:* a handle opened for A successfully reading `control.db`. **It does today** (measured,
§6.1): a `{readonly: true}` handle attaches `data/control.db` and selects rows. S-2 is therefore
currently false, and no amount of code review makes it true inside one process with one uid.

**S-3 — No bearer secret in a URL, a log, an audit row, an error body, or a plaintext column.**
Access codes, download tokens, session ids, webhook secrets, HMAC keys.
*Falsified by:* a live code appearing in `access_log` or a `Referer` (test: submit the form with the
field moved to the query string — the app must 400 rather than read it), or
`SELECT count(*) FROM cms_download_code WHERE code_hash NOT LIKE '$argon2id$%'` returning > 0, or any
token string in any log line (test: mint 1,000 tokens, grep the log directory, expect 0 hits).

**S-4 — Every privileged action produces exactly one audit row, in the same transaction as the
change, and no app path can alter an audit row afterwards.**
*Falsified by:* any mutating admin route with zero audit rows; a 200 from any route that issues
`UPDATE`/`DELETE` against `audit_log`; or a forced-rollback test where the mutation persists without
its audit row (measured today that `db.exec()` of two statements leaves the first applied — §6.5 —
so this is a live risk, not a hypothetical).

**S-5 — Fail closed on anything that protects a paid asset.**
Any failure in code verification, token validation, watermark rendering, or a locked DB returns a
denial with zero asset bytes and no `X-Accel-Redirect` header.
*Falsified by:* fault injection (renderer throws, `SK_DOWNLOAD_TOKEN_KEY` unset, DB held in
`EXCLUSIVE` locking mode) producing 200 + bytes.

**S-6 — A gated asset is absent from the public tree by construction, not by permission.**
No symlink in `content/public/`, no non-`internal` location that can reach it.
*Falsified by:* `find content/public -type l -lname "*<sha256>*"` returning a hit, or a direct GET of
`/__protected/<sha>.pdf` returning anything but 404 (measured 404 on nginx 1.27.5, §6.4).

**S-7 — One redemption consumes exactly one use, regardless of how many HTTP requests deliver the
bytes; concurrency never over-grants.**
*Falsified by:* 24 concurrent redemptions against `max_uses = 3` granting ≠ 3 (measured 3, §6.3 — the
single-UPDATE form is correct), **or** one token with 8 parallel `Range` requests incrementing `uses`
by 8 (this is what the flow in IDEA §7.4 does today — the counter is right, the accounting unit is
wrong).

**S-8 — Tenant identity comes from the vhost nginx matched, never from a client-supplied header
value.**
*Falsified by:* a request to a `server_name` with no tenant mapping that still renders a tenant
because it carried `X-Skunkworks-Tenant: acme`. **It does today** (measured, §6.4): the catch-all
server passes the client's value through untouched, and duplicate headers arrive joined as
`acme, beta`.

---

## 2. Decisions — each: Decision / Alternatives rejected / Why they lost / Failure mode if wrong

### DS-1 — The table builder's input is a typed AST; the DDL runner rejects statement classes, not strings

**Decision.** `POST /admin/api/tables` takes a `TableSpec` object (§3). A generator emits
`CREATE TABLE`/`CREATE INDEX`/`ALTER TABLE … ADD COLUMN` from templates. Identifiers must match the
per-field regexes in §3 and are double-quoted with `"` doubled. Defaults may only be
`{kind:"literal", value:<string|number|boolean|null>}` — never an expression. The connection that
runs DDL is opened with `defensive` on (better-sqlite3's default, asserted at open) and the runner
refuses to run if `PRAGMA foreign_keys` is not `1`.

**The five things a "prefix check on the identifier" runner actually permits** (all measured, §6.2,
the whole string handed to one `exec`):

```sql
-- 1. copy a protected table's rows into a publishable one
CREATE TABLE u_exfil AS SELECT code_hash FROM cms_download_code;
-- 2. expose a protected table through the view datasource kind
CREATE VIEW u_public_codes AS SELECT id, code_hash FROM cms_download_code;
-- 3. run code on writes to a protected table
CREATE TRIGGER u_t AFTER INSERT ON cms_pages BEGIN
  INSERT INTO cms_download_code(code_hash) VALUES (NEW.body); END;
-- 4. drop the constraints off a core table (persists across reopen; integrity_check still 'ok')
PRAGMA writable_schema=ON;
UPDATE sqlite_master SET sql='CREATE TABLE cms_pages(id, slug, body)' WHERE name='cms_pages';
-- 5. reach another tenant's file (bound parameter, no interpolation at all)
ATTACH DATABASE 'data/control.db' AS ctl; INSERT INTO ctl.sessions VALUES('s1',1,'acme');
```

**Alternatives rejected.**
*(a) SQL text + identifier regex.* Loses on all five payloads: four of them satisfy
`^u_[a-z0-9_]+$` for the leading identifier, and #5 has no identifier to check.
*(b) SQL text + `sqlite3_prepare` to inspect the statement.* better-sqlite3's `prepare` correctly
rejects multi-statement strings ("The supplied SQL string contains more than one statement") — but
`ATTACH DATABASE ? AS ctl` is one statement and is accepted with a bound path. Parsing without an AST
walker buys nothing; the JS drivers expose no AST.
*(c) DEFENSIVE mode as the control.* Measured: it blocks payload #4 only ("table sqlite_master may
not be modified") and does **not** block ATTACH, CTAS, views or triggers.
*(d) Run DDL in a child process with a chroot/`openat2` view.* Correct, but it is a second runtime to
build and to ship in the export bundle; kept as the fallback if S-2 is bought (see §5 Q4).

**Why they lost.** Measured: all four SQL-text payloads execute, and `ATTACH DATABASE ?` needs no identifier at all — every string-shaped defence is defeated by a statement shape it cannot see. Only a generator that cannot express the shape removes the class.

**Failure mode if wrong.** A generator bug that interpolates a value — e.g. someone adds "raw default
expression" because a client wants `DEFAULT (datetime('now'))` — silently reopens the surface, and
the tests that pass are the ones that only send `TableSpec` objects. Mitigation: the golden test
asserts that for 10,000 fuzzed specs the emitted SQL matches `^[A-Za-z0-9_"(),\s]+$` (no single
quotes at all) and that no emitted statement matches
`/\b(attach|pragma|trigger|view|sqlite_master|as\s+select)\b/i`.

### DS-2 — Driver is better-sqlite3, pinned, defensive asserted at open; `node:sqlite` is banned in the app

**Decision.** `better-sqlite3` for both Drizzle and Kysely. At open, assert
`PRAGMA foreign_keys === 1` and prove DEFENSIVE by attempting the `sqlite_master` update once at
startup and requiring it to fail (a capability probe, not a hope).

**Alternatives rejected.**
*(a) `node:sqlite` (Node 22 built-in).* Attractive: zero native dependency, which matters for the
5-minute export install. Measured, it **rewrites `sqlite_master`** — and still does with
`{enableDefensive:true}` (§6.2). That makes DS-1's whole premise unenforceable on that driver.
*(b) `node:sqlite` for the export bundle only, better-sqlite3 on the server.* Two drivers, two
behaviours, and the client's instance is the one we cannot patch. Rejected.
*(c) No assertion, rely on the default.* A driver bump can change a default; the capability probe
costs one statement at boot.

**Why they lost.** Measured: `node:sqlite` rewrote `sqlite_master` with and without `enableDefensive`, so on that driver the DDL prefix check is decorative; and a native dependency is a build problem, not a security one.

**Failure mode if wrong.** better-sqlite3 is a native module: the Docker image needs prebuilds for
`linux/amd64` + `linux/arm64` and the client's box needs a matching Node ABI. If a prebuild is
missing, `npm ci` fails at install — the export promise breaks loudly, which is the correct failure.
Cost: ~8 MB image, ~0.2 s cold open per tenant handle.

### DS-3 — Every DDL change is one `BEGIN IMMEDIATE` transaction containing the change, the registry row and the audit row

**Decision.** The runner wraps `[DDL…, INSERT cms_table_registry, INSERT audit_log]` in
`BEGIN IMMEDIATE`/`COMMIT`, with `busy_timeout = 5000` and a hard cap of 8 statements per request.

**Alternatives rejected.** *(a)* One `db.exec()` per statement — measured: a two-statement
`exec("CREATE TABLE u_a(x); CREATE TABLE u_a(x);")` throws on the second and **leaves `u_a` in
place** (§6.5), so a half-applied schema is the default outcome. *(b)* A migration file per change —
the admin is a form, it cannot write files (D9 forbids it). *(c)* `BEGIN` deferred — upgrades to a
write lock mid-transaction and turns a concurrent write into `SQLITE_BUSY` at the worst moment;
`IMMEDIATE` fails at `BEGIN`, before any work.

**Why they lost.** Measured: `exec()` left `u_a` behind after the second statement failed — the default outcome is a half-applied schema, and a half-applied schema is an untested schema that the exporter will happily tar.

**Failure mode if wrong.** A long DDL (a 40-index table rebuild) holds the write lock for its
duration; readers continue (WAL) but every write in that tenant blocks up to 5 s and then 503s.
Bounded by the 8-statement cap and one-table-per-request.

### DS-4 — Tenant identity: nginx injects it on *every* server block; the app rejects the request if the header is absent, empty, or contains a comma

**Decision.** `map $host $sk_tenant { … default ""; }` plus
`proxy_set_header X-Skunkworks-Tenant $sk_tenant;` **in the `default_server` block too**, and the app
returns `400 E_TENANT_HEADER` when the header is missing, empty, or fails `/^[a-z0-9][a-z0-9-]{0,62}$/`.
Path-prefix demos are resolved by location, and nginx sets the header there from a literal, never from
`$1`.

**Alternatives rejected.** *(a)* Trust `Host` only — path-prefix demos have no distinct `Host`, and
`Host` is client-supplied anyway, so this only moves the problem. *(b)* Trust the header as it
arrives — measured: with a catch-all that does not set it, the client's own
`X-Skunkworks-Tenant: acme` arrives verbatim at the app, and duplicates arrive as `acme, beta`.
*(c)* Trust `X-Forwarded-Host` — same spoofability, and it is stripped by anything that does not set
it.

**Why they lost.** Measured: the catch-all delivered the client's own value (`tenantHeader: "acme"`) and duplicate headers arrived as `acme, beta`; `Host` and `X-Forwarded-Host` are equally client-supplied, so they are the same hole with more steps.

**Failure mode if wrong.** The day someone adds a vhost without the `proxy_set_header` line, every
request to it is a 400 — loud and total, rather than silent cross-tenant rendering. That is the
failure direction I want.

### DS-5 — Downloads are accounted per *redemption*, not per HTTP request: `jti`-deduped consume

**Decision.** The token payload carries a random 128-bit `jti`. `uses` is incremented on the first
successful file response for that `jti` (`UPDATE … WHERE uses < max_uses AND revoked_at IS NULL`, then
`INSERT cms_download_event(jti, …) ON CONFLICT DO NOTHING`). Subsequent requests carrying the same
`jti` — the 7 other Range chunks of a resuming download manager — serve bytes without consuming.
`cms_download_event` gains `jti TEXT NOT NULL` and a unique index on `(jti, kind)` where
`kind ∈ {'first','range'}`.

**Alternatives rejected.** *(a)* Consume per request (IDEA §7.4 as written) — measured: nginx serves
`Range: bytes=0-3` as `206` independently of the full request (§6.4), so an 8-connection download
manager burns 8 uses; with the shipped default `max_uses = 3` the buyer's legitimate download dies at
37% and they have no uses left. *(b)* Consume at token mint — a buyer who redeems and closes the tab
loses a use, and support cannot tell the difference from theft. *(c)* Exempt `Range` requests from
counting — that removes the cap entirely for anyone who sends `Range: bytes=0-`.

**Why they lost.** Measured: nginx answers `Range: bytes=0-3` with `206` and 4 bytes, independently of the full request — so per-request accounting makes the shipped default (`max_uses=3`) break a legitimate download manager, and the natural workaround (ignore ranges) removes the cap.

**Failure mode if wrong.** Inside a 10-minute window, one valid token can pull one asset unlimited
times. Bounded by: one asset, one code, `iph`+`uah` binding, 10-minute TTL, and an event row per
request (so the pattern is visible). If a client needs "one download, hard stop", the knob is
`tokens: single_use` and the cost is a broken download manager — make it a tenant setting, default
off.

### DS-6 — Argon2id verification runs behind a bounded semaphore, and the bound is a security control

**Decision.** `SK_ARGON2_MAX_CONCURRENT=8`, queue depth 32, then `503 E_BUSY` with `Retry-After: 2`.
2 of the 8 slots are reserved for requests that already hold a valid session cookie (so a paying
customer is not starved by a botnet). Params `m=19456, t=2, p=1`.

**Alternatives rejected.** *(a)* Unbounded inline verification — measured 27 ms and 19 MiB per
verify; 128 concurrent = 2.4 GiB and an OOM kill of the whole process (all tenants).
*(b)* Rate-limit only, no semaphore — measured: at 5 attempts/15 min/IP and 37 verifies/s/core,
**≈6,700 distinct IPs** saturate one core; a $200 proxy pool does that. Memory, not CPU, is the kill
shot. *(c)* Argon2 with lower memory (e.g. 4 MiB) — weakens the only thing standing between a
2^60 code space and an offline attack if a tenant DB leaks (measured code space: 1.15 × 10^18).

**Why they lost.** Measured: 19 MiB × concurrency is the amplifier, and 6,655 IPs (a $200 proxy pool) saturate one core at the specified rate limit; a lower memory cost weakens the only barrier left if a tenant file leaks.

**Failure mode if wrong.** A burst returns 503 to real buyers. Mitigated by the reserved lane and by
the fact that a redemption is once-per-purchase, not per-page-view.

### DS-7 — Watermark failure is a served status, and the file is never streamed un-stamped

**Decision.** On renderer error, unencodable text after cp1252 sanitisation, or a missing watermark
asset: `503 E_WATERMARK_FAILED`, no `X-Accel-Redirect`, one `cms_download_event(kind='denied')`, one
alert row, and the admin list shows it. No retry-with-no-watermark path exists in the code.

**Alternatives rejected.** *(a)* Serve un-stamped and log — violates non-negotiable 4 and turns a
renderer bug into free distribution of a paid asset. *(b)* Fall back to a static logo — a different
product promise than "licensed to {email}", and the buyer's receipt no longer identifies them.
*(c)* Retry the render 3× then serve — three retries of a deterministic failure burn 3 × 52 ms and
still fail; retry only helps for transient I/O, so retry once, on `EAGAIN`/`EBUSY` only.

**Why they lost.** Non-negotiable 4 forbids serving an un-stamped paid asset, so every alternative is a denial anyway; the only real choice is whether the denial is visible to the operator (it is: 503 + alert row) or silent.

**Failure mode if wrong.** Every paid download for a tenant becomes a 503 after a font/library
regression. Mitigation: a container health check that stamps a fixture PDF with a CJK email at boot
and fails the container if it cannot; the render cache means the failure surfaces on the first
download after deploy, not in month three.

### DS-8 — The stored bytes are the re-encoded bytes; the original is never written to disk

**Decision.** Sniff → decode → re-encode (sharp, pinned version) → store only the output at
`content/media/<hh>/<sha256>.<ext>`, where the hash is over the *stored* bytes. `cms_asset.sha256`
is the stored hash; `filename` is metadata only. PDFs and archives are not re-encoded; they are
stored as-is, never public unless explicitly marked, and never rendered inline (`Content-Disposition:
attachment`, `X-Content-Type-Options: nosniff`).

**Alternatives rejected.** *(a)* Sniff only, store the original — measured: a PNG with
`<?php system($_GET["c"]); ?>` appended sniffs as `image/png` and would be stored with the PHP tail
intact (§6.6). *(b)* Strip metadata only — same failure; the payload is not metadata.
*(c)* Sanitise SVG — rejected in v1 already; keep it.

**Why they lost.** Measured: a PNG+PHP polyglot sniffs as `image/png` and survives sniff-only storage; the re-encode removed both the PHP tail and the `script` payload (157 → 68 B). Sniffing names the file; re-encoding replaces it.

**Failure mode if wrong.** Re-encoding is lossy and version-dependent: a sharp upgrade changes output
bytes, so "the same file uploaded twice" stops deduping and `?v=` hashes churn — cache misses, not a
breach. Pin sharp, and dedupe on the *original* hash for the "already exists" prompt while addressing
by the stored hash.

### DS-9 — `ip_hash` is HMAC-SHA256 under a per-install key; SHA-256(ip) is banned

**Decision.** `ip_hash = base64url(HMAC-SHA256(SK_IP_HASH_KEY, tenant_key || ip))[0:22]`, key
generated at install, rotated on export (the exported instance must not be able to correlate its
events with ours).

**Alternatives rejected.** *(a)* `sha256(ip)` — measured 1,303,795 hashes/s/core, so the entire IPv4
space is enumerable in **54.9 minutes** on one core; a tenant admin (or anyone who gets the file) can
un-anonymise every download event, which is a GDPR problem and a cross-tenant correlation tool.
*(b)* No IP at all — loses abuse forensics and the "one code, 40 countries" signal.
*(c)* Store the raw IP — worse than (a).

**Why they lost.** Measured: a plain SHA-256 over the IPv4 space finishes in 54.9 minutes on one core, which turns the event table into a de-anonymisation tool for anyone who obtains the file — the one thing an audit table must not be.

**Failure mode if wrong.** Losing `SK_IP_HASH_KEY` makes historical events uncorrelatable. Acceptable;
they are forensics, not billing.

### DS-10 — Cookie shapes: one admin session cookie, one download cookie, both `__Host-` with `Path=/`

**Decision.**
`__Host-sk-sess=<id>; Path=/; Secure; HttpOnly; SameSite=Lax` on the admin host.
`__Host-sk-dl=<token>; Path=/; Secure; HttpOnly; SameSite=Lax` on the download host.
The token is bound to `aid`+`cid` in its payload, so one cookie cannot be replayed against another
asset.

**Alternatives rejected.** *(a)* `__Host-dl-<key>; Path=/d/<key>` — as written in IDEA §7.4, this is
an invalid cookie: RFC 6265bis requires `__Host-` cookies to have `Path=/` and no `Domain`, and a
conforming UA **drops it**. Result: every download 401s, and the obvious fix under deadline is to drop
the prefix and lose the protection. *(b)* Non-prefixed `dl-<key>` with a scoped path — works, but a
sibling tenant on a path-prefix demo can overwrite it (`Path` is not an isolation boundary against a
same-host writer), and it is not `Secure`-locked. *(c)* `SameSite=Strict` — breaks the top-level GET
that *is* the download when the buyer arrives from an email link.

**Why they lost.** `__Host-` plus a scoped `Path` is not a weaker cookie, it is an invalid one (RFC 6265bis §4.1.3); the deadline fix for an invalid cookie is to remove the prefix, which is how the protection is actually lost in practice.

**Failure mode if wrong.** The download cookie is sent to every path on that host. It is HttpOnly,
10-minute, IP/UA-bound and asset-bound, so the exposure is one asset for ten minutes.

*Not measured here, stated as spec:* I could not verify the `__Host-` rejection in a browser — this
machine has no Chrome/Chromium (§5 Q7). The rule is RFC 6265bis §4.1.3; the test is
`Set-Cookie: __Host-x=1; Path=/d/a; Secure` then read cookie storage, expect absent.

### DS-11 — The admin session is server-side, rotates on privilege change, and every non-GET carries a CSRF token; CSP is per-surface

**Decision.**
*Session.* `__Host-sk-sess` holds 32 random bytes. The row lives in `control.db.sessions`
(`id_hash`, `user_id`, `created_at`, `last_seen`, `ip_hash`, `ua_hash`, `rotated_from`). The id is
rotated — old row deleted, new row inserted, same transaction — on login, on any role change, and on
password change. Idle timeout 30 min, absolute 12 h.
*CSRF.* Every non-GET admin request needs `X-Sk-Csrf: HMAC-SHA256(SK_SESSION_KEY, session_id || "csrf")`
(double-submit, bound to the session, not to a cookie) **and** `Origin` exactly equal to
`SK_ADMIN_ORIGIN`. Missing/mismatched → 403 `E_CSRF`. No exception for `Content-Type: text/plain`,
which is the form-encoding bypass that makes "JSON only" worthless.
*CSP.* Admin: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:; frame-ancestors 'none'; base-uri 'none'; object-src 'none'` — GrapesJS's
inline styles are the only concession, and `script-src` has no `unsafe-inline` (if GrapesJS cannot run
under it, it runs in a sandboxed iframe on the admin origin, not by weakening the header).
Public: `default-src 'self'; script-src 'self' 'nonce-<per-request>'; style-src 'self';
style-src-attr 'unsafe-inline'; img-src 'self' data: https:; frame-ancestors 'none'; object-src 'none'`,
where the renderer **rewrites a per-request nonce onto every stored `<script>` at SSR**, not at save
time.

**Alternatives rejected.** *(a)* No CSP — the stored-`<script>` path in A-2 becomes the whole admin
compromise instead of a blocked request. *(b)* `script-src 'unsafe-inline'` on public pages — then the
header does nothing, because the tenant's editor output *is* inline HTML. *(c)* Hash-based CSP
(`script-src 'sha256-…'` computed when the page is saved) — correct in theory, but pages are also
edited by hand outside the CMS (D24 ships the source to the client), so the hash list goes stale and
the page silently stops executing its own scripts. A render-time nonce cannot go stale.
*(d)* CSRF via `SameSite=Strict` only — measured, "site" ignores port, so the admin port is same-site
with the public host (A-2); the cookie is attached to the forged request and only a bound token stops
it.

**Why they lost.** Rotation and a bound token are the only controls that survive an XSS on the same
host (A-2): the attacker can make the browser send the cookie, but cannot read the token out of a page
it cannot load. A nonce stamped per request is the only CSP form that works when the markup is written
by hand and stored.

**Failure mode if wrong.** A renderer that rewrites nonces with a regex instead of a parse pass will
miss a `<script>` inside an island's shadow DOM or a `<template>`, and that widget silently stops
running — a broken page, not a breach. Mitigation: parse with parse5, and stand up a CSP report
endpoint per tenant with a 72-hour alert on any `script-src` violation after a component change.

---

## 3. Interface contracts I require from other domains (signatures, routes, env vars, paths, error codes)

### 3.1 Data model (owner: Data Model)

```ts
// Admin → table builder. No `sql`, `statement`, `ddl` or `query` key is accepted anywhere in the
// body; presence of one is 400 E_SQL_TEXT_REJECTED before schema validation.
type Ident = string;                     // /^[a-z][a-z0-9_]{0,62}$/, not in RESERVED_WORDS
type TableSpec = {
  name: `u_${string}`;                   // /^u_[a-z0-9_]{1,58}$/
  columns: Array<{
    name: Ident;
    type: 'text'|'integer'|'real'|'blob'|'datetime'|'asset';
    notNull?: boolean;
    default?: { kind: 'literal'; value: string|number|boolean|null };   // never an expression
    unique?: boolean;
    ref?: { table: 'cms_asset'; column: 'key'; onDelete: 'RESTRICT'|'CASCADE' };  // only target allowed
  }>;                                    // max 40 columns
  indexes?: Array<{ name: Ident; columns: Ident[]; unique?: boolean }>;        // max 8
};
```

Required columns/tables:

- `cms_download_code`: `code_hash` must be the only representation of the code. No `code`, `code_plain`,
  `code_prefix`, or `last4`. A `code_prefix` column for admin search is acceptable **only** if it is
  the first 2 characters and the UI accepts that it identifies a batch, not a code.
- `cms_download_event`: add `jti TEXT NOT NULL`, `kind TEXT NOT NULL CHECK(kind IN
  ('first','range','denied'))`, `bytes_sent INTEGER` **nullable**; unique `(jti, kind)` where
  `kind='first'`.
- `cms_datasource`: `is_public INTEGER NOT NULL DEFAULT 0`; a `CHECK` that `kind='view'` implies
  `spec_json` matches `^v_[a-z0-9_]+$` and `kind='function'` implies `spec_json` is a path present in
  the deploy manifest (§4 A-5). A `u_`-named view must not be publishable (that is the DS-1 payload
  #2 made routine).
- `audit_log` (control.db): append-only; `before_json`, `after_json`, `actor_id`, `tenant_key`,
  `request_id`, `prev_hash`, `hash`. Hash chain over `(prev_hash || canonical_json(row))`.
- `cms_asset`: `is_public INTEGER NOT NULL DEFAULT 0`; gated is `is_public=0 AND gated=1`; there is no
  state in which a `cms_download_code` row exists for a gated asset while `content/public/<key>.*`
  exists — enforce with a test, since SQLite cannot express it.

### 3.2 Runtime (owner: Runtime)

```ts
// The only way DDL executes.
applyDdl(spec: TableSpec, actor: Actor, reqId: string): Promise<
  | { ok: true; table: string; version: number }
  | { ok: false; code: 'E_DDL_REJECTED'|'E_DDL_INVALID'|'E_TABLE_EXISTS'|'E_DDL_FAILED'|'E_LOCKED';
      detail: string }
>;
// Contract: opens its own connection (never the render handle), asserts defensive+foreign_keys,
// runs BEGIN IMMEDIATE, emits from templates, inserts registry + audit, COMMIT, closes.
// Must not accept a pre-built SQL string from any caller — the parameter type is TableSpec.

// The only way a template gets data.
source(key: string, params: Record<string, string|number|boolean>, opts: { reqId: string }): Promise<Row[]>;
// Contract: throws SourceNotPublic / SourceUnknown; never returns a column not in the allowlist;
// never sees a DB handle.

// The only way an asset URL exists.
asset(key: string): { url: string; srcset?: string; width?: number; height?: number; alt: string };
```

Process-level requirements I cannot enforce from my domain and therefore need in the SDS:

1. **No `function` datasource is loaded unless its file's sha256 is in a deploy manifest** that ships
   with the image, not with the tenant's content. If this is not adopted, §4 A-5 stands as a critical
   finding.
2. **The render path must not share a process with the DDL runner.** If that is rejected as
   unimplementable under D1's single-process constraint, then S-2 is unachievable and the SDS must say
   so in those words rather than claim isolation.
3. `unhandledRejection` and `uncaughtException` handlers must not return a response body containing a
   stack, a path, or a SQL fragment — `{error:{code:'E_INTERNAL',requestId}}` only.

### 3.3 Platform (owner: Platform)

nginx, all server blocks including `default_server`:

```nginx
map $host $sk_tenant { hostnames; acme.com acme; www.acme.com acme; default ""; }
proxy_set_header X-Skunkworks-Tenant $sk_tenant;   # "" strips a client-supplied value (measured)
proxy_set_header X-Forwarded-Host    $host;        # lowercased, port stripped, trailing dot stripped
proxy_set_header X-Forwarded-Prefix  $sk_prefix;   # only on path-prefix locations
proxy_ignore_headers X-Accel-Redirect;             # on any location proxying to a non-app upstream
```

Download plane, exactly:

```nginx
location /__protected/ { internal; alias /srv/protected/; add_header Accept-Ranges bytes; }
location = /d/          { return 404; }            # nothing lives here
```

- The app builds `X-Accel-Redirect` **only** as `/__protected/${sha256}.${ext}` from
  server-side values; it must never interpolate a request parameter, a filename, or a key into it.
- nginx must not be the thing that decides *whether* a file is gated. `content/protected/` and
  `content/public/` are separate mounts; the protected mount is not aliased anywhere without
  `internal`.

Required env vars (all 32-byte base64 unless noted):

| Var | Meaning | Failure if unset |
|---|---|---|
| `SK_DOWNLOAD_TOKEN_KEY` | HMAC key for download tokens | refuse to start (fail closed) |
| `SK_SESSION_KEY` | session id signing | refuse to start |
| `SK_IP_HASH_KEY` | `ip_hash` HMAC | refuse to start |
| `SK_WEBHOOK_SECRET_<TENANT>` | per-tenant issue-code webhook | webhook 503, admin issue still works |
| `SK_ADMIN_ORIGIN` | exact origin allowed for admin POSTs | refuse to start |
| `SK_TENANT_HEADER` | default `x-skunkworks-tenant` | 400 on every request |
| `SK_ARGON2_MAX_CONCURRENT` | default `8` | defaults apply |
| `SK_DDL_MAX_STATEMENTS` | default `8` | defaults apply |
| `SK_TRUST_PROXY` | `nginx`; anything else ⇒ ignore `X-Forwarded-*` | 400 (misconfiguration is fatal) |

### 3.4 Routes and error codes (mine, for the others to build against)

| Route | Success | Errors |
|---|---|---|
| `GET /d/<asset-key>` | 200 form | 404 `E_NO_ASSET`, 410 `E_GONE` |
| `POST /d/<asset-key>` (form: `code`, optional `email`) | 303 → `/d/<key>/file` + `Set-Cookie: __Host-sk-dl` | 400 `E_FORM`, 401 `E_CODE_INVALID` (uniform), 429 `E_RATE_LIMITED`+`Retry-After`, 503 `E_BUSY` |
| `GET /d/<asset-key>/file` | 200/206 via `X-Accel-Redirect` | 401 `E_TOKEN_INVALID`, 403 `E_TOKEN_MISMATCH` (asset/jti/IP/UA), 410 `E_USES_EXHAUSTED`, 503 `E_WATERMARK_FAILED`, 503 `E_BUSY` |
| `POST /api/hooks/<tenant>/issue-code` | 201 `{code_id, issued_to_email}` | 401 `E_SIG`, 409 `E_REPLAY`, 429 `E_RATE_LIMITED` |
| `POST /admin/api/tables` | 201 `{table, version}` | 400 `E_SQL_TEXT_REJECTED`, 400 `E_DDL_REJECTED`, 422 `E_DDL_INVALID`, 409 `E_TABLE_EXISTS`, 503 `E_LOCKED` |

Rate-limit buckets, because the second one needs a key that is not the argon2 hash:
`ip:<ip_hash>` at 5/15 min, and `code:<HMAC-SHA256(SK_RATE_KEY, normalize(code))[0:16]>` at 5/15 min —
the fast keyed hash exists only to name the bucket, is never stored, and is never logged. Attempts
against an unknown code consume both buckets, so an attacker cannot probe codes without paying the
same price as a legitimate buyer.

Token format (fixed, because the verifier's failure modes depend on it):

```
v1.<base64url(payload)>.<base64url(HMAC-SHA256(key, "v1."+payload))>
payload = { jti, cid, aid, iat, exp, iph, uah }
```

Verification order, and each step is a contract with the runtime: (1) split on `.`, require exactly 3
parts; (2) require `v1`; (3) decode the MAC and require **exactly 32 bytes before comparing** — a
length-mismatched `timingSafeEqual` throws `ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH` (measured, §6.7),
which would surface as a 500 instead of a 401; (4) `timingSafeEqual`; (5) `exp - iat ≤ 600` and
`iat ≤ now + 30`; (6) `iph`/`uah` match; (7) `aid` matches the route; (8) DB consume.

Rejection rule for the token body: **parse only after the MAC verifies.** Any `JSON.parse` before step
4 is a bug — it lets a 2 KB body reach the parser and lets `exp` be attacker-chosen for error text.

---

## 4. Attack points — at least 3 outside my domain (claim / failure / severity / settling evidence)

### A-1 (Platform) — The catch-all vhost makes tenant selection caller-controlled

**Claim.** §3.1 fixes the resolution order as `X-Skunkworks-Tenant` → `Host` → path prefix, and
nginx "injects" the header.

**Failure.** Injection is per-location, and a catch-all `server` block exists in practice — per-host
HTTP-01 needs one to answer for a host that has no vhost yet. Measured against a config with a mapped
vhost and a catch-all: a request to a
`server_name` that has no mapping arrives at the app with the client's own value intact —
`tenantHeader: "acme"` — because no `proxy_set_header` ran. With two headers, Node joins them:
`tenantHeader: "acme, beta"`. So:

```bash
curl -s -H 'Host: anything.invalid' -H 'X-Skunkworks-Tenant: acme' https://box/ -o /dev/null -w '%{http_code}'
# 200 + acme's homepage, no DNS record for acme, no cert for acme
```

**Severity: high.** It is an unauthenticated, DNS-free, cert-free way to render any tenant by key, and
it is the same header the app uses to pick the DB file. If `/admin` or `/api` runs behind the same
catch-all (it does in a single-process app with one Fastify instance), the header also selects whose
admin namespace answers — and on the path-prefix demo route, a same-origin island can send that header
with no preflight.

**Settling evidence.** Three assertions in a staging test: (1) a request with a spoofed header and an
unmapped `Host` returns 404 `E_TENANT_HEADER`, not 200; (2) `proxy_set_header … ""` in the catch-all
makes the app see `null` — measured, it does; (3) duplicate headers are rejected 400 (they arrive as
`acme, beta`, measured).

### A-2 (Runtime) — Stored HTML is rendered verbatim, and cookies ignore ports

**Claim.** §8.2 "Hand-edited HTML always wins — the canvas renders whatever is stored", plus D9's
"admin on a separate origin/port".

**Failure.** Two facts compose. (i) A tenant can store `<script>` in a page body — that is the product.
(ii) Cookies are scoped by host, not by port: measured, a `__Host-sk-sess` cookie set by
`127.0.0.1:19101` is sent to `127.0.0.1:19102` (§6.8). So for a client TLD where the admin lives on
`acme.com:8443` and the site on `acme.com:443`, a stored script on the *public* site runs on the same
host and can drive the admin port with the admin's cookie attached:

```html
<script>fetch('https://acme.com:8443/admin/api/tenants/acme/users', {method:'POST',
  body: JSON.stringify({role:'owner'}), credentials:'include'})</script>
```

CORS blocks *reading* the response, not the state change. `SameSite=Lax` does not help: "site" ignores
port and scheme, so this is a same-site request and Lax cookies are attached. HttpOnly does not help: it
stops `document.cookie`, not the request.

**Severity: high** (privilege escalation from "can edit a page" to "can mint an admin"), and it is
reachable by the *tenant* against the *platform operator*, which is the boundary we care about.

**Settling evidence.** With a browser: store the script on a tenant page, load it, assert the POST
arrives at `:8443` with a session cookie and is rejected 403 `E_CSRF`. Without a browser (this box):
assert the server-side half — a POST to `/admin/api/*` with a valid session cookie, a valid
`Origin: https://acme.com` and no CSRF token must be 403; and the admin must reject any `Origin` whose
host matches the public host. Cookie-port behaviour is already settled (§6.8).

### A-3 (Data model) — `cms_download_event.bytes_sent` and `ranged` cannot be filled by the app

**Claim.** §7.4 step 5: "Append `cms_download_event`" with `bytes_sent`, `ranged`, per redemption.

**Failure.** After `X-Accel-Redirect` the app has handed off and never sees a byte. Measured: with the
app returning `X-Accel-Redirect` and a body, nginx served the *file* (18 B, `200`) and discarded the
upstream body — the handler's response never reaches the client and no completion callback fires. So
`bytes_sent` can only be `Content-Length` (requested, not sent) or a guess. An operator who disputes a
chargeback with fabricated byte counts is worse off than one with none.

**Severity: medium.** Not a breach; an audit-integrity defect on the table that exists to prove what was
downloaded — and it will be discovered in a dispute, not in a test.

**Settling evidence.** One instrumented download: compare `cms_download_event.bytes_sent` to nginx
`$body_bytes_sent` in the access log for the same `$request_id`. If the column is decoration, drop it
in v1 and say so; if it is billing, the nginx log line is the source of truth and the app ingests it.

### A-4 (Data model) — The asset FK guarantee is a connection pragma, not a schema property

**Claim.** §7.3: "SQLite enforces the FK to `cms_asset(key)` … regardless of whether Drizzle or Kysely
created the table, so you cannot orphan a cover image or delete one that is in use."

**Failure.** SQLite's default is `foreign_keys = OFF`; measured, the `sqlite3` CLI reports **0**, and
better-sqlite3 reports **1** because it turns it on at open. So the guarantee holds only while every
connection that ever writes was opened by that driver. The export/install/repair paths are exactly
where that breaks: `sqlite3 site.db "DELETE FROM cms_asset WHERE key='banner-home'"` succeeds and
orphans the reference, and `VACUUM`/`.dump`-based repair flows silently produce a bundle that violates
its own constraint.

**Severity: medium-high.** Orphaned references in a sold export, and asset deletion that silently
breaks a page — the failure surfaces at the client, after the invoice.

**Settling evidence.** Two commands, both already run: `sqlite3 file.db 'PRAGMA foreign_keys;'` → `0`;
`DELETE` of an in-use asset on that connection → `1 row deleted` with an orphan present. SQLite has no
schema-level way to force the pragma, so the test is: every write path asserts
`PRAGMA foreign_keys === 1` at open (fail closed if not), and the bundle's `install.sh` never uses the
`sqlite3` CLI.

### A-5 (Runtime/export) — `content/sources/*.js` is in-process code in the tenant's writable tree

**Claim.** §4 kind 3: a `function` datasource is "a trusted JS module … cannot be created from the
admin UI".

**Failure.** "Cannot be created from the admin UI" constrains the *UI*, not the filesystem. The file
lives under `tenants/<key>/content/sources/`, which is inside the same tree the app writes to for media
and the same tree the exporter tars. Any write primitive that escapes `content/media/**` — an import
path, a repair tool, a restored backup, an export/install round-trip that copies a `sources/` file from
a client's bundle — yields `import()` of attacker-chosen code inside the process that holds every
tenant's DB handle and every HMAC key. That is not "one tenant compromised"; that is the fleet.

**Severity: critical if reachable, and it is reachable by design in the export direction** (the bundle
carries `sources/`, and the 5-minute install runs it).

**Settling evidence.** An fs-audit test (macOS `fs_usage` / Linux `strace -f -e trace=openat,rename`)
asserting every write the app performs resolves under `content/media/**` or `content/public/**`; plus a
test that `import()` is refused when the file's sha256 is absent from `deploy-manifest.json`. If the
runtime owner will not adopt the manifest, the mitigation is a read-only `sources/` mount and an
explicit "no function datasources in v1".

---

## 5. Open questions I cannot resolve alone

1. **Is the tenant admin an adversary or a customer?** The whole DDL threat model changes: if a tenant
   admin is trusted, `u_*` DDL is a convenience; if not — and a phished password makes them hostile on
   demand — then DS-1 is mandatory and the "no raw SQL" rule in D4 has to be enforced by type, not by
   review. I am assuming adversary. The Architect needs to record which.
2. **Does anything ever run two tenants on one host in production?** Path-prefix demos are documented
   as a fallback. If a paying client can be on a path prefix, the shared cookie jar (measured, §6.8)
   and the shared origin make A-2 a production risk, not a demo one.
3. **Who may write `content/sources/` at runtime on the shared instance?** Read-only mount (safe),
   deploy step (safe), or app-writable (A-5). Needs a platform answer before S3.
4. **Is a process boundary per tenant acceptable?** Cost estimate: ~40 MB RSS idle per Node worker, so
   200 tenants ≈ 8 GB and a cold start per tenant on first request. If yes, S-2 becomes structural and
   DS-1's fallback (d) applies to DDL only. If no, the SDS must state that tenant isolation is a
   *permission* boundary and list the three code paths that can break it.
5. **Is `bytes_sent` a billing input or decoration?** Decides whether S3 carries an nginx log ingest
   pipeline (A-3).
6. **Does the export include `cms_download_event` (IP hashes) and `cms_download_code` (argon2 hashes)?**
   My preference: events aggregated to counts, hashes included (they are unbreakable at 2^60), IP key
   rotated. This is a product/legal call, not mine.
7. **Admin IP allowlist vs. "the client edits their site from a hotel".** An allowlist means a VPN for
   every content editor. If the answer is "no allowlist", the admin needs device-bound sessions and a
   shorter idle timeout instead, and that is a different build.
8. **Can we require a browser in CI?** Two of my invariants (`__Host-` rejection, A-2's CSRF path) need
   a real UA; this box has none, so they are spec-only until CI has Chromium.

---

## 6. What I measured (command + observed output)

All commands run 2026-10-20 on macOS 15.7.4, Node v22.23.1, sqlite 3.43.2, better-sqlite3 13.0.3,
@node-rs/argon2 2.2.x, sharp 0.35.x, nginx 1.27.5 in Docker 29.7.2. Scratch dir:
`/Users/cyberdeth/.hermes/profiles/ceo/cache/scratch/r1sec`.

**6.1 A read-only handle is not an isolation boundary.**

```
$ node db2.mjs
=== C. same ATTACH on a READ-ONLY handle: which step fails? ===
  ATTACH 'data/control.db': OK attached
  SELECT ctl.sessions:      OK 1
  INSERT ctl.sessions:      SQLITE_READONLY attempt to write a readonly database
=== B. ATTACH path resolution + write, on a READ-WRITE tenant handle ===
  ATTACH 'data/control.db' (cwd-relative): OK attached
  INSERT INTO ctl.sessions: OK 1 row
```

Read-only stops the write; it does not stop the read, and it does not stop opening a second file.
Note the resolution: `'data/control.db'` is **cwd-relative**, so the exploit depends on the app's
working directory, not on where `site.db` lives — which is why the path in the payload is short.

**6.2 The four DDL escapes, and the driver difference.**

```
$ sqlite3 t2.db < probe2.sql
--- A. CTAS from a protected table          A rows copied:|1|hash-of-a-real-code
--- B. VIEW named u_* over a protected table B view rows:|1|hash-of-a-real-code
--- C. TRIGGER on a protected table          C trigger fired, codes now:|2
--- D. writable_schema rewrite of a core table
    D schema now:|CREATE TABLE cms_pages(id, slug, body)
$ sqlite3 t2.db "SELECT sql FROM sqlite_master WHERE name='cms_pages'; SELECT * FROM pragma_integrity_check;"
CREATE TABLE cms_pages(id, slug, body)
ok                      <- persists across reopen, integrity_check still passes
```

```
$ node db2.mjs
=== A. writable_schema ===
  PRAGMA writable_schema=ON: OK
  UPDATE sqlite_master:      SQLITE_ERROR table sqlite_master may not be modified
  -- after db.unsafeMode(true) --
  UPDATE sqlite_master:      OK
  schema readback:           CREATE TABLE u_posts(id INTEGER PRIMARY KEY, injected TEXT)

$ node nodesqlite.mjs
  no options               rewrote sqlite_master -> CREATE TABLE u_p(... b TEXT)
  {enableDefensive:true}   rewrote sqlite_master -> CREATE TABLE u_p(... b TEXT)

$ node -e '…better-sqlite3 prepare…'
  prepare(multi): The supplied SQL string contains more than one statement
  prepare(ATTACH ?): accepted (bound param)
```

Three facts: DEFENSIVE (better-sqlite3's default) blocks `sqlite_master` writes only; `unsafeMode()`
re-enables them; `node:sqlite` never blocks them, with or without `enableDefensive`. And ATTACH is a
single legal statement with a bound parameter, so "prepare only one statement" is not a control.

**6.3 The atomic consume is correct under concurrency.**

```
$ node db.mjs
=== 4. max_uses=3, 24 concurrent connections, one atomic UPDATE ===
  granted: 3  busy/error: 0  final uses: 3
```
D19 holds for the statement as written. The accounting unit (per request, not per redemption) is the
defect — see §6.4.

**6.4 nginx: internal reachability, traversal, ranges, header injection.**

```
$ bash probe.sh        # nginx 1.27.5, location /__protected/ { internal; alias /srv/protected/; }
direct /__protected/paid.pdf                      404
legit internal target   /__protected/paid.pdf     200  PAID-CONTENT-4f2a
traversal out of internal /__protected/../public/secret.txt        404
traversal, encoded dots   /__protected/%2e%2e/public/secret.txt    404
traversal, encoded slash  /__protected/..%2fpublic/secret.txt      404
double-slash prefix       //__protected/paid.pdf                   404
absolute URI              http://evil.example/__protected/paid.pdf 404
query appended            /__protected/paid.pdf?x=1                200  PAID-CONTENT-4f2a
escape to root            /__protected/../../etc/passwd            404

$ (Range through the same endpoint)
full             200 18B
Range: bytes=0-3 206 4B
Range: 100-200   416 197B
internal target missing 404
```

`internal` holds, traversal is rejected on this version, and each `Range` request is served
independently — which is why 8 chunks eat 8 uses.

```
$ (two vhosts + a default_server, header echo)
Host acme.test                     -> {"tenantHeader":"acme"}
Host ACME.TEST                     -> {"tenantHeader":"acme"}       (lowercased)
Host acme.test.                    -> {"tenantHeader":"acme"}       (trailing dot stripped)
Host unknown.test                  -> {"tenantHeader":null}
Host unknown + client hdr acme     -> {"tenantHeader":"acme"}       <- trusted
Host acme.test + client hdr beta    -> {"tenantHeader":"acme"}       (proxy_set_header wins)
two tenant headers                 -> {"tenantHeader":"acme, beta"} (duplicates join)
$ (catch-all with proxy_set_header X-Skunkworks-Tenant "")
Host unknown + client hdr acme     -> {"tenantHeader":null}          <- stripped, the fix works
```

**6.5 `db.exec()` is not atomic; a transaction is.**

```
$ node ddl.mjs
=== DDL atomicity: db.exec() with a failing second statement ===
  exec threw         : table u_a already exists
  u_a survives?      : true    <- partially applied, no transaction
  inside transaction : table u_b already exists
  u_b survives?      : false   <- rolled back
```

**6.6 Uploads: re-encode, not sniffing, is what kills a polyglot.**

```
$ node upload.mjs
  original png bytes      : 95
  polyglot bytes          : 157  tail contains php: true
  magic-byte verdict      : image/png
  sharp re-encode -> webp : 68   bytes; contains php: false ; contains "script": false
  truncated png           : rejected -> Input buffer has corrupt header
  jpeg named .php         : image/jpeg  (extension irrelevant)
  jpeg with injected APP1 : 304 bytes; contains "GPSLatitude": true
  re-encoded              : 270 bytes; contains "GPSLatitude": false ; contains "Exif": false
```

```
$ node -e '…Content-Disposition…'
"book.pdf"                 -> accepted
"a\"b.pdf"                 -> accepted
"a\r\nX-Injected: 1.pdf"   -> Headers.append: "attachment; filename="a\r\nX-Injected: 1.pdf"
"bürger.pdf"               -> accepted
"报告.pdf"                  -> Cannot convert argument to a ByteString
```

A non-Latin original filename throws while building the header, so `报告.pdf` becomes a 500 on the
download route unless the header is ASCII-fallback + RFC 5987 `filename*`.

**6.7 Argon2id, token plumbing, timing.**

```
$ node crypto.mjs
  OWASP  m=19456 t=2 p=1: hash 50.8 ms, verify 27.0 ms, ok=true, 37.1 verifies/s/core
  RFC9106 m=47104 t=1 p=1: hash 37.7 ms, verify 35.6 ms, 28.1 verifies/s/core
  heavy   m=65536 t=3 p=4: hash 64.2 ms, verify 69.5 ms, 14.4 verifies/s/core
  code space: Crockford base32, 12 chars = 2^60.0 = 1.15e+18 codes
  token len: 143  body 99  mac 43
  tampered payload -> mac matches? false
  timingSafeEqual with mismatched lengths throws: ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH
  Buffer.from("!!!", 'base64url') -> 0 bytes
  Buffer.from("a", 'base64url')   -> 0 bytes
  reference ===      : 0.010 us/op
  timingSafeEqual    : 0.081 us/op
  differs at byte 31 : 0.087 us/op
  differs at byte 0  : 0.081 us/op
```

Two corrections to the plan's assumptions. (i) The MAC comparison is not a realistic timing oracle at
0.08 µs/op — the real defects are the 500 on a length mismatch and any `JSON.parse` before the MAC
check. (ii) **Memory** is the DoS: 19 MiB per in-flight verify, and ≈6,700 IPs (at 5 attempts/15 min)
saturate one core. 128 concurrent verifies = 2.4 GiB.

**6.8 Cookies ignore ports.**

```
$ curl -s -c jar.txt http://127.0.0.1:19101/set          -> port=19101 cookie=(none)
$ curl -s -b jar.txt http://127.0.0.1:19101/admin/x      -> port=19101 cookie=__Host-admin=sess-abc
$ curl -s -b jar.txt http://127.0.0.1:19102/admin/api/tenants
                                                          -> port=19102 cookie=__Host-admin=sess-abc
$ cat jar.txt
#HttpOnly_127.0.0.1  FALSE  /  TRUE  0  __Host-admin  sess-abc
```

The same cookie is sent to a different port. "Separate origin/port" is a UI and allowlist separation,
not a cookie separation.

**6.9 `ip_hash` is reversible if it is a plain hash.**

```
$ node ddl.mjs
  sha256 over IPv4 strings: 1,303,795/s/core (767 ms for 1,000,000)
  full IPv4 space (2^32): 54.9 minutes on one core
```

**6.10 Driver defaults that the plan depends on without saying so.**

```
$ sqlite3 :memory: 'PRAGMA foreign_keys;'   -> 0        (library default)
$ node -e '…better-sqlite3 pragma…'         -> 1        (driver turns it on at open)
```

The asset FK guarantee in §7.3 is a driver default, not a schema property. That is A-4.