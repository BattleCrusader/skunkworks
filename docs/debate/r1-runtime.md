# R1 — Runtime

Position: one Node process, one event loop, one mount seam. Astro is a renderer behind Fastify, not a
server. The runtime's job is to make every page's cost **countable before publish** and to make the
editor's output the only HTML the renderer ever sees.

Box: Apple M1, macOS 15.7.4, Node 22.23.1, Astro 7.4.1, `@astrojs/node` 11.1.9, Fastify 5.12.7,
better-sqlite3 13.0.3 (SQLite 3.53.4). Every number below is from this box, single process, no
container. Container CPU limits will be worse; treat these as upper bounds on throughput.

---

## 1. Invariants I will defend (numbered, falsifiable)

**I1 — One request, one handler.** Fastify owns `/admin/*`, `/api/*`, `/d/*`; Astro owns every other
path; no path is served by both. *Falsifier:* any URL that returns 200 from two different handlers, or
any `/admin` response produced by Astro. Measured today: the ownership matrix is identical across all
three mount strategies (§6.2), so this is achievable, not aspirational.

**I2 — No tenant, no render.** A request whose tenant cannot be resolved ends in 404, never in a
default tenant. *Falsifier:* `Host: unknown.example.com` returns 200. **It does today** — measured
`tenant=none status=200` (§6.6). That is the current defect and I am claiming the fix, not the state.

**I3 — Templates receive resolved data, never a handle.** `site.source()` returns plain JSON; no
`.astro` file can import `better-sqlite3`, Drizzle or Kysely and still build. *Falsifier:* a page that
imports a DB module passes the build, or a template calls `.prepare(`/`.query(`.

**I4 — `site.source()` is async, always, even where the implementation is synchronous.** This is what
makes the blocking-read escape hatch (worker offload, D-R7) a swap rather than a rewrite. *Falsifier:*
any source accessor in the render path whose return value is not a Promise.

**I5 — The renderer never writes.** The render path holds only `{ readonly: true }` handles; every
write goes through an admin path with its own connection. *Falsifier:* a write, `CREATE`, `DROP`,
`VACUUM INTO` or `ATTACH` originating from a render-path connection. Note §6.3: readonly blocks the
first three and **allows the last two**, so this invariant needs a second control (A3).

**I6 — Query budget per page, enforced at publish:**

| Budget | Value | Why this number |
|---|---|---|
| Data Source calls per render | ≤ 8 | 8 indexed sources = 54 µs, i.e. 40 % of a 0.13 ms render |
| SQL statements per render | ≤ 12 | views expand to 1, `query` to 1, `function` capped at 3 |
| Summed source time, p95, at production row counts | ≤ 4 ms | 50 concurrent × 4 ms ≈ 200 ms p50 (measured ratio below) |
| Worst single source, p95 | ≤ 1.5 ms | one source must not exceed a third of the page budget |
| Sources with measured cost > 0.5 ms | ≤ 1 | forces an index or a materialisation before publish |
| Over 12 ms hard | 503 `SOURCE_BUDGET_EXCEEDED` | a slow page must fail visibly, not quietly |

*Falsifier:* a published page whose registry-measured cost exceeds the table. The budget is **cost, not
count**, because §6.4 measured one unindexed `ORDER BY` at 6,714 µs against 6.7 µs indexed — a
1,000× spread that a count budget cannot see.

**I7 — A page that cannot round-trip is not shippable, where "round-trip" means fixpoint, not
equality.** `canon(load(save(load(html)))) === canon(load(html))`, with the full component registry
loaded. *Falsifier:* any fixture page unstable at pass 2. Measured: 9/9 constructs are pass-2 stable;
8/9 differ from the hand-authored input at pass 1 (§6.8). The literal "empty diff against the input"
in §8.1 is unachievable — the gate has to be restated or it will be waived on day one.

**I8 — Page bodies contain no `<script>`, no HTML comments, and no `<style>`.** All three are destroyed
by the editor (measured, §6.8); behaviour ships as a registered island component, CSS ships in the
page's CSS layer. *Falsifier:* a stored `cms_pages.body_html` matching `/<script|<!--|<style/`.

**I9 — Island props are serialised at SSR and islands never fetch.** *Falsifier:* an island-originated
request to `/api`, `/__data` or a websocket during a render, or a prop that is a function/Promise in the
serialised output.

**I10 — Tenant resolution is a pure function of `(trusted header, normalised Host, path prefix)` plus a
cached map with a monotonic revision.** Same inputs + same revision ⇒ same tenant, always. *Falsifier:*
two consecutive resolutions disagree, or a client-supplied `X-Skunkworks-Tenant` on an untrusted socket
changes the result (measured: the header *does* override `Host`, §6.6 — so trust must be enforced).

**I11 — No absolute URL literal in stored page HTML.** `src="/media/..."`, `href="/blog/..."` are
resolved through `site.asset()` / `site.url()` at render. This is the only thing that makes path-prefix
demos work at all: Astro ignores `X-Forwarded-Prefix` (measured, §6.5), so a literal `/media/x.webp`
escapes `/demo/acme/`. *Falsifier:* a stored body containing `="/` outside a `data-` attribute.

---

## 2. Decisions — each: Decision / Alternatives rejected / Why they lost / Failure mode if wrong

### D-R1 — Mount seam: Fastify-first, `setNotFoundHandler` + `reply.hijack()`, no `next`

**Decision.** Astro's middleware-mode handler is invoked from `app.setNotFoundHandler`, after
`reply.hijack()`, with `next` omitted. Fastify's routing table wins by definition; Astro sees only the
requests Fastify did not route. Public 404s are Astro's HTML 404 page; `/api` and `/admin` 404s stay
Fastify JSON.

```ts
app.setNotFoundHandler(async (req, reply) => {
  reply.hijack();
  const r = resolveTenant(req);                 // I10
  if (!r.ok) return send404(reply.raw, r.code); // I2, no fallback tenant
  await astroHandler(req.raw, reply.raw, undefined, {
    tenant: r.tenant, site: makeSite(r.tenant), url: makeUrl(r),
  });
});
```

**Alternatives rejected.** (a) `@fastify/middie` with `app.use('/', handler)` — middleware runs before
routing on *every* request including `/admin`, and because Astro calls `next()` for unmatched paths the
public 404 becomes Fastify's JSON `{"message":"Route GET:/nope not found"}`; measured, §6.2. (b) An
explicit `app.route({ url: '/*' })` + hijack — works, but requires a global `addContentTypeParser('*')`
passthrough to keep the raw body available, which breaks Fastify's own JSON parsing for `/api` because
content-type parsers are per-type and global. (c) Astro standalone in its own container behind nginx —
two processes, two tenant caches, two failure domains, and nginx would need two upstreams.

**Why they lost.** Not performance: single-connection `/trace` throughput across the three mounts was
341.7 / 367.3 / 331.0 req/s (§6.7) — a 10 % spread, while run-to-run variance at 50 connections is 1.8×.
Anyone choosing a mount on benchmarks is reading noise. They lost on semantics: only (a) makes the
public 404 JSON, and only (b) damages `/api` body parsing.

**Failure mode if wrong.** If `setNotFoundHandler` is not a stable mount point in a future Fastify, the
public site 404s wholesale on upgrade. Mitigation: one `mountPublic(app, opts)` function, one integration
test asserting `GET /` → 200 and `GET /nope` → 404 `text/html`, run against the pinned Fastify version.

### D-R2 — Tenant resolution order, and the header is only trusted from the proxy

**Decision.** `X-Skunkworks-Tenant` (only if `req.socket.remoteAddress` ∈ `SKUNKWORKS_TRUSTED_PROXY_CIDRS`
**and** `X-Skunkworks-Proxy-Token` equals `SKUNKWORKS_PROXY_TOKEN`) → exact normalised `Host` →
`/demo/<key>` prefix. Otherwise 404.

Normalisation: lowercase, strip `:port`, strip trailing dot, `domainToASCII` for IDN, reject anything
that is not `[a-z0-9.-]`.

**Alternatives rejected.** Path-prefix first (breaks canonical host routing, shares the parent origin's
cookies and CSP, and makes every URL depend on a helper — keep it as the no-DNS fallback only).
Subdomain-only (no demo without DNS, and D7 explicitly keeps the path fallback). Default-tenant fallback
(the single cheapest way to serve tenant A's page on tenant B's domain).

**Why they lost.** The measured behaviour of the header is that it beats `Host` outright (§6.6:
`Host: demo.abc.com` + `X-Skunkworks-Tenant: beta` → `tenant=beta`). That is correct for a proxy-injected
header and a tenant-spoofing vulnerability for a client-supplied one — the difference is entirely in
whether the header is trusted, so trust is the decision, not the order.

**Failure mode if wrong.** A misconfigured or missing `proxy_set_header` silently serves the wrong
tenant — the worst failure in the product. Mitigation: nginx **clears** the inbound header
(`proxy_set_header X-Skunkworks-Tenant "";` before setting it), the app rejects a header without the
proxy token, and a startup self-test asserts the token is present in the environment. A second failure
mode: `Host` with a port (`demo.abc.com:8443`) fails to match a `domains.host` row — hence port
stripping, tested.

### D-R3 — Tenant cache: immutable whole-map snapshot + revision stamp, never mutated in place

**Decision.** One `Map<host, TenantRef>` per process, replaced wholesale when the revision changes. The
revision is a single row (`control_rev.rev`, bumped in the same transaction as any `tenants`/`domains`
write) read once per request. Cold load = one `SELECT` of the join into a fresh map.

**Alternatives rejected.** (a) Per-key TTL cache — a rename leaves the old host live for the TTL, and
two keys written in one transaction can be observed in different states. (b) LRU eviction on the map —
an evicted demo tenant re-resolves differently mid-session, which is exactly the I10 violation.
(c) `PRAGMA data_version` polling — correct but per-connection semantics, and it fires for *any* commit
in `control.db` including audit rows, so it would rebuild on every admin request.

**Why they lost.** Rebuilding the whole map is cheaper than the bookkeeping needed to patch it safely:
0.371–3.169 ms for 1,000 domains (§6.4), i.e. one to three page renders, and it happens only when
`control.db` changes — not per request. A single-indexed-row revision read costs ~0.8 µs (§6.4, same
shape as the measured join).

**Failure mode if wrong.** A deleted domain keeps serving for up to the rebuild interval; a renamed host
serves the old name until the revision read sees the bump. Mitigation: a 1 s fallback poll, a 404 for the
old host after the bump (the alias table handles legitimate redirects), and an admin "reload tenants"
action that forces a rebuild.

### D-R4 — One readonly handle per tenant, LRU 64, refcounted

**Decision.** `Map<tenantKey, {db, refs, lastUsed}>`, `readonly: true`, `fileMustExist: true`, evicted
LRU beyond 64. A handle is closed only when `refs === 0`.

**Alternatives rejected.** Open per request (0.443 ms measured, §6.7, against a 0.13 ms render — the
open would be 3.4× the work it enables). One shared read-write handle for everything (loses the
readonly guarantee that I5 depends on, and puts admin writes and renders on one connection's lock
state). One handle per source call (same 0.443 ms, times the source count).

**Why they lost.** 64 handles × ~0.5 ms open is a 32 ms cold start for a fleet; 64 file descriptors is
nothing. The LRU is sized for the demo fleet (≤ 50 live tenants) with headroom, not for 1,000.

**Failure mode if wrong.** Above 64 hot tenants, every request pays a 0.443 ms reopen and throughput
drops ~25 % (§6.7 basis: 2.3 ms/request → 2.75 ms). Fix is an env bump; the refcount is what prevents
"close while a render is mid-flight" (which surfaces as `SQLITE_MISUSE`, not a clean error).

### D-R5 — `site.source()` returns frozen plain rows; the resolver is the only caller of SQL

**Decision.**

```ts
site.source(key: string, params?: Record<string, string | number>): Promise<ReadonlyArray<Row>>
site.asset(key: string): AssetRef | null          // { url, srcset, width, height, alt }
site.url(path: string): string                   // prefix-aware (I11)
site.page(slug: string): PageRef
```

Rows are `structuredClone`-free plain objects, frozen, with `asset`-typed columns already resolved to
`AssetRef`. No lazy getters, no builders, no cursor.

**Alternatives rejected.** Sync return (forecloses D-R7 without touching every template). Returning
Kysely/Drizzle query builders (that *is* handing a template a DB handle — I3). Lazy proxies (a template
could trigger a query after the response has started streaming, which is an unrecoverable 500 and a
half-written page).

**Why they lost.** Every alternative gives up the thing the budget needs: attribution. With an async
boundary the resolver can time each source, name it in the 503, and store `cost_ms` at publish (D-R6);
with a sync return the only observable is "the page took 6.7 ms", and the fix requires editing every
template that touches the slow source. The cost of the boundary is zero in practice — Astro's frontmatter
is already async, so `await site.source(...)` is the same number of characters as a sync call, and the
render path awaits nothing else.

**Failure mode if wrong.** Frozen rows cost a copy per row; a 50-row source with 8 columns is ~20 KB,
sub-100 µs. If freezing proves too slow at 200 rows, freeze at the array level only and document it —
never remove the boundary.

### D-R6 — Publish-time cost measurement is part of the registry, not a monitoring afterthought

**Decision.** `cms_datasource` carries `cost_ms`, `cost_rows`, `cost_measured_at`. Publishing a source
(`is_public = 1`) runs it 20× against the tenant's own DB and stores p95. A `query` source whose
`order`/`where` columns lack a supporting index cannot be published: the resolver checks
`EXPLAIN QUERY PLAN` for `SCAN` and refuses with `SOURCE_UNINDEXED`. Row-count doubling invalidates the
stamp (a re-measure is required at the next publish).

**Alternatives rejected.** Count-only budget (measures the wrong quantity, 1,000× error measured).
Runtime-only monitoring (the first person to see the 6.7 ms scan is a visitor). Automatic index creation
on user tables (the DDL runner owns `u_*`; a render-time `CREATE INDEX` is a write from the render path —
violates I5).

**Why they lost.** The measured `EXPLAIN QUERY PLAN` output is unambiguous: `SCAN u_posts` +
`USE TEMP B-TREE` vs `SEARCH u_posts USING INDEX idx_posts_pub (status=?)` — the former 6,714 µs, the
latter 6.7 µs (§6.4). A publish-time check catches it once, in front of an operator, with the table and
column named.

**Failure mode if wrong.** A source that is fast at 10 k rows and pathological at 500 k publishes clean
and degrades later. Mitigation: the row-count-doubling invalidation, plus a per-source p95 counter that
trips `SOURCE_BUDGET_EXCEEDED` (503) rather than silently serving 6.7 ms pages.

### D-R7 — Blocking reads stay on the loop, with a cost threshold that forces worker offload

**Decision.** Sources under 0.5 ms measured run synchronously in-process (the common path: 6.7 µs).
Sources at or above 0.5 ms are executed in a per-tenant `worker_threads` worker with the same readonly
handle, over `MessagePort`, behind the same async signature (I4).

**Alternatives rejected.** (a) Always offload — 76.4 µs round trip per source (§6.7) × 4 sources =
305 µs, against 27 µs of actual indexed query work: a 10× tax on every page. (b) Never offload — at
50 concurrent requests a page with 2.3 ms of synchronous work measured **p50 148 ms, p99 2.71 s,
192 req/s** (§6.7). Little's law agrees: 50 × 2.3 ms = 115 ms floor. (c) An async SQLite binding —
none is mature for SQLite in Node without a native thread pool of its own; the worker *is* that pool.

**Why they lost.** The tax and the stall are both real and the crossover is measurable: 76 µs is 1.5 %
of the 5 ms threshold, and 6.7 ms of blocking is 3× the entire 2.3 ms page. Threshold, not ideology.

**Failure mode if wrong.** A worker per heavy tenant costs ~10–30 MB RSS each (V8 isolate + page cache)
and one extra hop of serialisation per result set. Cap the worker pool at 4 per process, degrade to
in-process above that, and emit `RENDER_OFFLOAD_DEGRADED` so the operator sees the ceiling before the
site does.

### D-R8 — HTML is `no-store`; no rendered-page cache in v1

**Decision.** Public HTML: `Cache-Control: no-store`, `X-Robots-Tag: noindex` for `mode = demo`. No
in-memory HTML cache, no CDN cache in v1. Assets stay `immutable, max-age=31536000`; CSS/JS are
content-hashed and immutable.

**Alternatives rejected.** (a) In-memory LRU of rendered HTML keyed by `(tenant, slug)` — every
invalidation source multiplies: page save, asset rename, source TTL expiry, nav edit, settings change.
One missed hook is a stale page in front of a prospect. (b) ETag + 304 on a body hash — cheap and
correct, but it still requires rendering to compute the hash, so it saves bandwidth, not work; defer.
(c) A 5–60 s micro-cache — a demo where the operator edits a page and refreshes into the old version,
which is the one bug that destroys trust in the editor.

**Why they lost.** The render is 0.13 ms and a full page with 3 indexed sources is under 0.25 ms
(§6.1). Caching a 0.25 ms operation buys little and costs an invalidation graph that has to be perfect.
The expensive part is the data, and that already has a per-source TTL cache (§4 of IDEA) with a much
smaller blast radius.

**Failure mode if wrong.** A traffic spike costs CPU rather than cache hits: at 4,396 req/s measured for
a static-content page (§6.7) a single core saturates somewhere in the low thousands, and nginx
`limit_req` becomes the throttle. Acceptable for this product; revisit if a client site gets a front-page
link.

### D-R9 — One CSS layer per tenant, page CSS from the editor's composer minus defaults

**Decision.** `components.css` (registry-owned, versioned, content-hashed) + per-page CSS stored in
`cms_pages.body_css`, produced from `editor.getCss()` with GrapesJS's injected defaults stripped.
`<style>` is forbidden in page bodies (I8).

**Alternatives rejected.** Inline `<style>` inside the body (measured: GrapesJS hoists it out and it is
**gone** from `getHtml()` after one open/save, §6.8). Tailwind classes in page bodies (§8.1 already
rejects it; also unmeasurable through the round-trip). A single global stylesheet for all tenants (a
tenant's edit changes another tenant's rendering, and export would carry dead CSS).

**Why they lost.** `getCss()` always emits `* { box-sizing: border-box; } body {margin: 0;}` plus a
trailing `;` normalisation on every declaration (§6.8). Storing that verbatim per page means every page
carries two duplicate rules and a byte-diff that never converges; stripping it at save is one function.

**Failure mode if wrong.** A component whose CSS lands in the wrong layer (page vs component) renders
differently in the editor canvas than on the site. Mitigation: the round-trip test asserts
`canon(css_after_save) === canon(css_before_save)` per fixture page, and `components.css` is loaded in
the canvas iframe, so a missing layer shows up in the editor, not in production.

---

## 3. Interface contracts I require from other domains (signatures, routes, env vars, paths, error codes)

### 3.1 Tenant resolution

```ts
type TenantRef = {
  id: number; key: string;
  mode: 'production' | 'demo' | 'internal';
  host: string;              // canonical host for this request
  prefix: string | null;     // '/demo/acme' when resolved by prefix
  dbPath: string;            // tenants/<key>/site.db
  contentRoot: string;       // tenants/<key>/content
  revision: number;          // control_rev.rev at resolution
};

type TenantResolution =
  | { ok: true; tenant: TenantRef; via: 'header' | 'host' | 'prefix' }
  | { ok: false; code: 'NO_TENANT' | 'HOST_UNKNOWN' | 'TENANT_DISABLED'; host: string };

resolveTenant(req: { headers: IncomingHttpHeaders; socket: { remoteAddress?: string }; url: string }): TenantResolution
```

Rules the resolver guarantees: header ignored unless trusted socket **and** proxy token matches; `Host`
lowercased, port-stripped, trailing-dot-stripped, IDN→punycode; prefix form only matches
`^/demo/([a-z0-9-]{1,32})(?=/|$)`; the prefix is stripped by the **app** (nginx must not rewrite), and
`tenant.prefix` is what `site.url()` prepends.

### 3.2 The mount seam

```ts
mountPublic(app: FastifyInstance, opts: {
  handler: (req: IncomingMessage, res: ServerResponse, next?: Next, locals?: object) => Promise<void>;
  onResolve?: (r: TenantResolution) => void;
}): void
```

Contract: exactly one `setNotFoundHandler` per process; it calls `reply.hijack()` before touching
`reply.raw`; it never calls `next`; it never sets headers on `reply` after hijack; it returns 404 HTML
for `!ok`.

Ownership table (measured, §6.2):

| Path | Owner | 404 body |
|---|---|---|
| `/admin/*` | Fastify (admin listener only) | JSON |
| `/api/*` | Fastify | JSON `{"error":"not_found"}` |
| `/d/:key`, `/d/:key/file` | Fastify | uniform HTML (no existence oracle) |
| `/__data/:key` | Fastify | JSON |
| `/media/*` | nginx (`try_files` on `content/public`) | nginx 404 |
| `/__protected/*` | nginx `internal` | nginx 404 |
| everything else | Astro | Astro HTML 404 |

### 3.3 Routes and status codes

| Code | When | Body |
|---|---|---|
| 404 `NO_TENANT` / `HOST_UNKNOWN` | unresolved tenant | HTML 404 (public), JSON (api) |
| 404 `PAGE_NOT_FOUND` | slug absent or `status != published` | HTML 404 |
| 400 `SOURCE_PARAM_UNKNOWN` | `/__data` param not in the spec | JSON |
| 500 `SOURCE_NOT_PUBLIC` | template asked for a non-public source | HTML 500, no detail |
| 500 `SOURCE_UNKNOWN` | key not in registry | HTML 500, no detail |
| 503 `SOURCE_BUDGET_EXCEEDED` | hard 12 ms exceeded | HTML 503 + `Retry-After: 5` |
| 503 `TENANT_UNAVAILABLE` | `SQLITE_BUSY` past `busy_timeout`, disk full, corrupt | HTML 503 |
| 200 | everything else | HTML, `no-store` |

### 3.4 Env vars

```
SKUNKWORKS_CONTROL_DB=/data/control.db
SKUNKWORKS_TENANTS_DIR=/data/tenants
SKUNKWORKS_PUBLIC_PORT=4000
SKUNKWORKS_ADMIN_PORT=4001
SKUNKWORKS_TENANT_HEADER=X-Skunkworks-Tenant
SKUNKWORKS_PROXY_TOKEN=<32-byte hex>            # required; startup fails without it
SKUNKWORKS_TRUSTED_PROXY_CIDRS=127.0.0.1/32,172.16.0.0/12
SKUNKWORKS_TENANT_CONN_LRU=64
SKUNKWORKS_SOURCE_P95_MS=4
SKUNKWORKS_SOURCE_HARD_MS=12
SKUNKWORKS_RENDER_MODE=live|snapshot             # exporter sets snapshot
SKUNKWORKS_BUILD_ID=<git sha>
```

### 3.5 Paths

```
tenants/<key>/site.db
tenants/<key>/content/media/<sha[0:2]>/<sha>.<ext>
tenants/<key>/content/public/<asset-key>.<ext>        -> symlink into media/
tenants/<key>/content/protected/wm/<spec_sha>/<asset_sha>.<ext>
tenants/<key>/content/sources/<key>.js               # kind=function, developer-authored
```

### 3.6 What I require from Data Model

1. `cms_pages(slug, body_html, body_css, rev INTEGER, body_sha TEXT, status, updated_at)` — `rev`
   increments only on semantic change; `body_sha` = sha256 over canonical `body_html || body_css` and is
   what the round-trip gate diffs.
2. `cms_datasource(key, kind, spec_json, is_public, ttl_s, cost_ms, cost_rows, cost_measured_at)`.
3. An index the resolver can name: for every ordered `query` source, `EXPLAIN QUERY PLAN` must contain
   `SEARCH` and not `SCAN`. If the DDL runner cannot create that index, the source cannot be published.
4. `cms_asset_alias(old_key, asset_id)` so `site.asset('old-key')` still resolves after a rename
   (otherwise every hand-edited `/media/old-key` URL 404s, and a page rename breaks a live site).
5. `foreign_keys` is ON by default in better-sqlite3 13.0.3 (measured, §6.9) — so `ON UPDATE CASCADE`
   from `u_*` to `cms_asset(key)` genuinely fires, and a rename rewrites user rows. That is a **write to
   a `u_*` table triggered by an admin action**, which must be in the same transaction and audited.

### 3.7 What I require from Security

1. Render-path checks are O(1) and read-only. No audit write, no rate-limit counter write, no session
   touch on a public page render — the render connection is `readonly` and *cannot* write (I5).
2. `is_public` is checked in the resolver, not the template; a non-public source is a 500, never a 403
   (a 403 confirms the key exists).
3. CSP is **hash-based**, computed from the final serialised HTML at render/export time. No nonce in
   stored pages (see A2).
4. Gated-download cookies: `__Host-` requires `Path=/` (MDN, Set-Cookie §Cookie prefixes). §7.4's
   `__Host-dl-<key>` with `Path=/d/<key>` is rejected by browsers that enforce prefixes (A4).

### 3.8 What I require from Platform

1. nginx: `proxy_pass http://app:4000;` with **no trailing slash** (URI preserved — IDEA §3.1 measured),
   `proxy_set_header Host $host;`, and the inbound `X-Skunkworks-Tenant` cleared before it is set.
2. `/media/` served only by nginx `try_files`; the app must never serve an asset byte.
3. Export/backup uses `VACUUM INTO` (or the backup API), never `cp` (A1 — measured data loss).
4. `install.sh` runs `PRAGMA journal_mode=WAL; PRAGMA integrity_check;` before marking a tenant active,
   and fails loudly rather than starting on a corrupt DB.

---

## 4. Attack points — at least 3 outside my domain (claim / failure / severity / settling evidence), including one on the export pipeline and one on how security constrains rendering

### A1 — Export pipeline: "same DB state produces identical bytes" is false, and a plain copy loses data

**Claim (Platform §5.1, IDEA §5.1).** The static export is reproducible — the same DB state must produce
identical bytes — and because the DB is per-tenant, export is a file copy.

**Failure.** Two independent defects. (1) *Copy*: a WAL-mode DB copied with `cp` loses every transaction
still in the WAL. Measured: source 500 rows, `-wal` 144,232 B, main file 4,096 B → **`cp` then read gives
`no such table: cms_pages`**; `VACUUM INTO` gives 500; `cp` after `wal_checkpoint(TRUNCATE)` gives 500
(§6.9). An export taken while the tenant is live ships an empty or truncated site, silently. (2)
*Bytes*: the renderer is not pure — per-source TTL caches, `Date.now()`-relative text, and
parameter-frozen `query` sources all change output between two exports of the same DB. §5.1 already
admits parameterised sources are frozen at defaults, but it calls that a note in `EXPORT-NOTES.md`; it is
also a byte difference, which breaks the reproducibility claim the same document makes three lines above.

**Severity.** Major (blocker for the "sell the static site" SKU if a client diffs two exports; a data-loss
blocker if any code path uses `cp`).

**Settling evidence.** Run the exporter twice from the same DB with a page containing `?page=2` and an
"x days ago" string; byte-diff. And: `cp site.db copy.db && sqlite3 copy.db 'select count(*) from
cms_pages'` against a live tenant — I ran the equivalent above and it returned `no such table`.
Fix: exporter takes a `VACUUM INTO` snapshot first, pins the clock, and refuses when a parameterised
source is used with a non-default param that appears in a rendered link.

### A2 — Security constrains rendering: a per-response CSP nonce cannot survive export

**Claim (Security mandate §3, IDEA §9 "CSP").** Every response carries a CSP; a nonce is the standard way
to allow the inline bootstrap that islands need.

**Failure.** A per-request nonce exists only in a per-request header. The static export writes HTML once
and the client serves it from their own nginx with their own headers. So either (a) the export bakes a
nonce into HTML that the client's server never echoes in a header → every island script is blocked and
the site is dead on arrival, or (b) the export omits the CSP and the "hardened" promise is marketing. It
also pollutes the round-trip gate: a nonce attribute inside stored page HTML differs on every save, so
I7 can never reach a fixpoint. This is exactly the class of decision that must be settled before S4, not
after.

**Severity.** Major — it silently breaks the second and third SKUs (§5.1 Astro and static), which are the
products the brief is built around.

**Settling evidence.** Export a fixture page with one island, then serve the bundle and load it in a
browser with the bundle's own nginx config: check `Content-Security-Policy` against the `nonce=` value in
the HTML. If they differ, the island does not hydrate. My counter-proposal: hash-based CSP
(`script-src 'sha256-...'`) computed from the final serialised HTML at render and at export — the hash is
content, so it survives the snapshot and stays valid in the client's own headers.

### A3 — `function` data sources defeat tenant isolation by construction

**Claim (Security §1, Data Model §1, IDEA §4/§9).** One DB per tenant means no cross-tenant query path
exists by construction, and the render path's `{ readonly: true }` connection physically cannot write.

**Failure.** Readonly constrains *writes*, not *which database is read*. Measured on a `readonly: true`
handle: `ATTACH DATABASE '<other-tenant>.db' AS other` → **allowed**, and `SELECT * FROM other.secrets`
returned `[{"k":"other-tenant-pii"}]`. `VACUUM INTO '<arbitrary path>'` → also allowed (49 ms for
8.6 MB), which is a full-DB exfiltration primitive. `CREATE TEMP TABLE`/`CREATE TEMP TRIGGER` are allowed
too — a temp trigger on the shared connection can fire during another request's read. The vector is
`kind = 'function'`: a JS module in `tenants/<key>/content/sources/`, i.e. per-tenant, developer-authored
content that is copied into an exported bundle and edited by a client in the CMS SKU.

**Severity.** Blocker if function sources are ever tenant-authored or client-editable in an exported
instance (which §5.1 and D24 imply). Major otherwise — it requires code execution in the tenant's own
directory first, and code execution already owns the filesystem, so the *marginal* leak is the DB of a
sibling tenant on the same box.

**Settling evidence.** The probe is already the test: open readonly, `ATTACH` a sibling DB, assert the
statement throws. Today it does not. Fix options, in order: (a) run function sources in a worker whose
`process.cwd()` is the tenant's content dir with an fs policy, plus an `ATTACH`-denial test; (b) a SQLite
authorizer, which better-sqlite3 does not expose, so it would mean a fork or a different driver; (c)
declare function sources trusted code, say so in the SDS, and drop the phrase "by construction" from the
isolation claim. I want (a) with (c) as the documented fallback.

### A4 — Security: the gated-download cookie as specified is silently rejected by browsers

**Claim (IDEA §7.4 step 3).** `Set-Cookie: __Host-dl-<key>=…; HttpOnly; Secure; SameSite=Lax; Path=/d/<key>`.

**Failure.** A `__Host-` prefixed cookie must be set with `Secure`, **no `Domain`**, and **`Path=/`**
(MDN, Set-Cookie §Cookie prefixes: "the `Path` attribute must be set to `/`"). `Path=/d/<key>` violates
the prefix contract, so browsers that enforce prefixes discard the cookie. The user redeems a valid code,
gets a 200, and then the `/file` request has no token → 403. It presents as "the code doesn't work" and
will be debugged in the wrong layer for a day. Same trap for any admin session cookie that wants
path-scoping.

**Severity.** Major (paid-download flow is the commercial feature; it fails closed, so no leak — but it
fails).

**Settling evidence.** In a browser, redeem a code and read `document.cookie` / the devtools cookie jar:
the `__Host-dl-*` entry is absent. Fix: either `__Secure-dl-<key>` + `Path=/d/<key>` (keeps the path
scope, loses the host-binding guarantee), or keep `__Host-` with `Path=/` and rely on the per-asset name
plus HMAC token binding for scope. I prefer the second: `Path=/` is not a security boundary, the token
binding is.

### A5 — Admin on a separate origin has no defined tenant-selection path

**Claim (D9, Security §2).** Admin runs on a separate origin/port with an IP allowlist.

**Failure.** Two listeners means two Host spaces. On the admin port there is no tenant `Host` to resolve,
so tenant scope must come from the session — a *second* resolution path that nothing in IDEA defines. Two
sources of truth for "which tenant am I editing" is how an operator edits tenant B's homepage while
looking at tenant A's page list. The render path's `resolveTenant` (I10) does not cover it, and the audit
log (§9) records an actor but not a tenant.

**Severity.** Major (cross-tenant *write* by an operator — not an attacker, which is worse for trust).

**Settling evidence.** Send `GET /admin/pages` with `Host: a.example.com` and a session whose
`tenant_id` is B; assert which DB is read. If the answer is "whichever the code path looked at first",
the contract is missing. My requirement: `resolveAdminTenant(session) → TenantRef` is the only source,
the admin port ignores `Host` entirely, every admin URL carries the tenant key (`/admin/t/<key>/pages`),
and every audit row carries `tenant_id`.

---

## 5. Open questions I cannot resolve alone

1. **Who strips `/demo/<key>` — nginx or the app?** I have decided the app (so `site.url()` owns the
   prefix and nginx stays dumb), but Platform must confirm no `proxy_pass` rewrite, because the two
   together double-strip. Blocks: path-prefix demos, i.e. the no-DNS sales path.
2. **Is `count(*)` an allowed source?** Measured 1,990 µs indexed / 4,374–5,020 µs unindexed on 90 k
   rows — 300× a normal source, and it cannot be indexed away. Either Data Model maintains a counter
   column, or the resolver refuses `count(*)` specs. I lean refuse; needs a verdict.
3. **Is `<script>` really banned from page bodies?** I8 says yes (measured: GrapesJS drops it). That
   pushes every behaviour into a registered island, which changes S4's scope and the component registry
   contract. CEO/Designer call.
4. **Does admin share the process (and the loop) with render?** Same process is simpler and D1-compatible,
   but a 50 ms page save blocks every render for 50 ms. Two processes means two SQLite writers on the
   same file (legal under WAL, but one more failure mode). Unmeasured; I have no save-cost budget yet.
5. **404 or 421 for an unknown `Host`?** 404 avoids a host-enumeration oracle and is what I have
   specified; 421 is more honest to a human who misconfigured DNS. SEO and cert-issuance behaviour differ.
6. **Is the path-prefix demo tier in v1?** If yes, every component must route through `site.url()` (I11)
   and the editor must never emit an absolute URL — a registry-wide constraint, not a helper.
7. **Who owns `/__data/:key` rate limiting** — nginx `limit_req` (per IP, no source awareness) or the app
   (needs a counter store, and a write on a hot path)? Unresolved; affects whether `/__data` ships in v1.

---

## 6. What I measured (command + observed output)

### 6.1 Request trace — `GET https://demo.abc.com/blog/hello?utm=x`

Tenant `acme`, page `blog/hello`, three indexed sources, one image, one island.

| # | Hop | Work | Expected | Basis |
|---|---|---|---|---|
| 1 | nginx | TLS, `Host`→upstream, set/clear tenant header, `proxy_pass` without rewrite | 0.1–0.3 ms | not measured by me — Platform owns; excluded from app budget |
| 2 | Fastify router | no route match → `setNotFoundHandler` → `hijack()` | 0.02 ms | 20,520 req/s for a JSON route = 0.049 ms per full request, client included |
| 3 | Tenant resolve | trusted header hit → `Map.get` + revision row read | 0.001 ms | 27.1 ns map lookup; 0.8 µs indexed single-row read |
| 4 | Connection | LRU hit (miss = +0.443 ms once) | 0 ms | 0.443 ms measured open+first-query+close |
| 5 | Page row | `cms_pages` by slug, published only | 0.003–0.008 ms | indexed param query measured 6.7 µs |
| 6 | Sources ×3 | three indexed `query`/`view` sources | 0.020 ms | 3 × 6.7 µs |
| 7 | Render | Astro SSR, 12 blocks, one island placeholder | 0.13 ms | derived: 0.180 ms (5,543 req/s) − 0.049 ms (20,520 req/s) |
| 8 | Serialise + write | ~3 KB HTML, gzip by nginx | 0.02 ms | within the 0.049 ms JSON-route envelope |
| — | **App total** | | **≈ 0.19 ms** | sum of 2–8 |
| — | **p50 observed** | same shape, single connection | **2 ms** | measured `/trace` p50 2 ms / 341.7 req/s — includes the loopback client, so treat 2 ms as the harness floor, not the server cost |

Why the shape matters: the renderer is 68 % of the budget and the data is 10 %. Every performance
decision therefore lands on *sources*, not on rendering or the mount — which is exactly inverted from
where the architecture discussion has been. Degradations, all measured: one unindexed `ORDER BY`
+6.7 ms; one `count(*)` over 90 k rows +2.0 ms; cold tenant-map rebuild +0.4–3.2 ms; a tenant DB reopen
+0.44 ms; 50 concurrent requests at ≈2.2 ms of synchronous work → **p50 148 ms, 192 req/s**.

### 6.2 Astro middleware-mode mounting (`astro build` + three mounts into Fastify)

```
$ npx astro build            # 6 pages, output: server, adapter @astrojs/node (mode: middleware)
[build] Server built in 444ms. [build] Complete!
$ node server2.mjs
A: /admin=200 /api/ping=200 /blog/a=200 /nope=404(text/html)      locals[header]=acme POST=buyer@example.com
B: /admin=200 /api/ping=200 /blog/a=200 /nope=404(application/json; charset=utf-8)  locals[header]=acme POST=buyer@example.com
C: /admin=200 /api/ping=200 /blog/a=200 /nope=404(text/html)      locals[header]=acme POST=buyer@example.com
```

A = `setNotFoundHandler` + `hijack`; B = `@fastify/middie` `use('/')`; C = wildcard route + `hijack`.
The adapter's own README/source confirms the seam: `handler = options.mode === "middleware" ?
createMiddleware(app, options) : createStandaloneHandler(...)`, and the middleware calls `next()` when no
route matches — which is why B's public 404 is Fastify's JSON.

### 6.3 `better-sqlite3` readonly — what it actually blocks

```
$ node probe.cjs
open readonly ok, pragma query_only = 0
[BLOCKED] INSERT  -> SQLITE_READONLY: attempt to write a readonly database
[BLOCKED] UPDATE  -> SQLITE_READONLY: attempt to write a readonly database
[BLOCKED] DELETE  -> SQLITE_READONLY: attempt to write a readonly database
[BLOCKED] CREATE TABLE -> SQLITE_READONLY: attempt to write a readonly database
[BLOCKED] DROP TABLE   -> SQLITE_READONLY: attempt to write a readonly database
[ALLOWED] PRAGMA writable_schema=ON -> []
[ALLOWED] CREATE TEMP TABLE -> {"changes":0,"lastInsertRowid":0}
[ALLOWED] CREATE TEMP TRIGGER -> {"changes":0,"lastInsertRowid":0}
[ALLOWED] ATTACH other tenant file -> {"changes":0,"lastInsertRowid":0}
[ALLOWED] read via attached other -> [{"k":"other-tenant-pii"}]
[ALLOWED] VACUUM INTO -> {"changes":0,"lastInsertRowid":5}
[BLOCKED] PRAGMA journal_mode=DELETE -> SQLITE_IOERR_LOCK: disk I/O error
```

Readonly is a write barrier, not an isolation boundary. This is the evidence behind A3 and I5's caveat.

### 6.4 Query cost — the 1,000× spread that sets the budget

```
$ node bench.cjs
--- no index on (status, published_at) ---
query source, no index, limit 10: 6714.5 us/query  (n=300)
count(*), no index:               5019.6 us/query  (n=300)
--- with index idx_posts_pub(status, published_at DESC) ---
query source, indexed, limit 10:     6.7 us/query  (n=2000)
count(*), indexed:                1990.2 us/query  (n=2000)
EXPLAIN indexed: [{"detail":"SEARCH u_posts USING INDEX idx_posts_pub (status=?)"}]
EXPLAIN unindexed: [{"detail":"SCAN u_posts"},{"detail":"USE TEMP B-TREE FOR ORDER BY"}]
tenant map lookup: 27.1 ns/lookup (5,000,000 lookups, 1000 entries)      [wal.cjs]
control.db host lookup (indexed, 1000 domains): 0.8 us/query (n=5000)
boot-load 1000 domains -> Map: 3.169 / 1.243 / 0.389 / 0.371 / 0.398 ms (5 runs, cold→warm)
```

90,000 published rows of 100,000. `count(*)` is 300× a normal source and index-proof — hence open
question 2.

### 6.5 Path-prefix reality — Astro ignores `X-Forwarded-Prefix`

```
$ node server.mjs
--- prefix stripping probe (A, url=/ , prefix header) ---
emitted urls: ["/blog/a","/blog/b","/blog/c","/media/banner-home.webp?v=ab12cd"]
```

Request carried `X-Forwarded-Prefix: /demo/acme`; every emitted URL omits it. Astro's `base` is
build-time (IDEA §3.1 says this; this is the runtime confirmation), so a path-prefix demo needs the URL
helper on every emitted URL — invariant I11.

### 6.6 Host resolution over a raw socket (fetch cannot set `Host`)

```
Host=demo.abc.com                              -> tenant=acme status=200
Host=beta.example.com                          -> tenant=beta status=200
Host=unknown.example.com                       -> tenant=none status=200      <-- I2 violation
Host=demo.abc.com X-Skunkworks-Tenant=beta     -> tenant=beta status=200      <-- header wins
```

Two findings: the header overrides `Host` unconditionally (so trust is the decision, D-R2), and an
unknown host currently renders a 200 with no tenant (the defect I2 forbids).

### 6.7 Head-of-line blocking and mount comparison (autocannon)

```
$ node bench.mjs        # 50 connections, 3 s, two rounds
A hijack  /trace      (4 sources)  rps=   192 p50=148ms p99=2710ms
A hijack  /trace-slow (4 sources)  rps=    48 p50=369ms p99=3088ms
A hijack  /blog/a                  rps=4396.67 p50=  7ms p99=  34ms
A hijack  /api/ping (fastify only) rps= 16886 p50=  1ms p99=  19ms
B middie  /trace                   rps=   257 p50=158ms p99=1522ms
C wildcard/trace                   rps=   147 p50=184ms p99=2668ms
(round 2: A 168 / B 299 / C 299 on /trace; /api/ping 14,184; /blog/a 725)
$ # single connection, 3 s
A /trace 341.67 rps p50=2ms | B /trace 367.34 rps p50=2ms | C /trace 331.0 rps p50=2ms
A /blog/a 5543 rps | A /api/ping 20520 rps
```

`/trace` = 4 sources including `count(*)` (≈2.2 ms of synchronous work); `/trace-slow` = the same 4
sources on an unindexed DB (18.5 ms). Both collapse under concurrency exactly as a single-threaded
blocking reader should: 192 req/s and 48 req/s against 16,886 req/s for a route that touches nothing.
Mount mode is not the variable — the 3 mounts are within 10 % on a single connection and within run-to-run
noise at 50, which is why D-R1 is argued on semantics.

```
worker round-trip (postMessage+query+reply): 76.4 us (n=5000)
open+first-query+close: 0.443 ms (n=200, 8.6 MB db)
read-during-write latencies (ms): p50=0.010 p95=0.012 p99=0.018 max=0.035
wal bytes: 4,120,032 -> after checkpoint: 0
VACUUM INTO 8.6MB tenant db (readonly handle): 49.0 ms, out bytes 10,866,688
```

WAL does what the design needs: a render reading while an admin writes sees p99 18 µs, so D-R4's shared
readonly handles are not a lock risk. `VACUUM INTO` from a readonly handle is both the backup mechanism
and the exfiltration primitive (A3).

### 6.8 GrapesJS round-trip (`grapesjs@0.23.8` + `jsdom`, headless)

```
case              | pass1==input | pass2==pass1 | css emitted
semantic+classes  | true         | true          | (only defaults)
img+attrs         | false        | true          | (only defaults)
data-attrs        | false        | true          | (only defaults)
inline style      | false        | true          | .box{color:red;}
void mix          | false        | true          | (only defaults)
comment+entity    | false        | true          | (only defaults)
script in body    | false        | true          | (only defaults)
svg inline        | false        | true          | (only defaults)
unclosed p        | false        | true          | (only defaults)
```

Concrete losses on the first save, verbatim from the run:

```
in : <figure class="figure"><img ... loading="lazy"><figcaption ...>Cap</figcaption></figure>
out: <body><figure class="figure"><img ... loading="lazy"/><figcaption ...>Cap</figcaption></figure></body>
in : <div class="posts" data-source="posts" data-limit="3">...
out: <body><div data-source="posts" data-limit="3" class="posts">...        # attribute order changed
in : <!-- keep me --><p class="p">café &nbsp; &#8212; 5 &lt; 6</p>
out: <body><p class="p">café   — 5 &lt; 6</p></body>                        # comment gone, entities literal
in : <div class="x"><script>console.log(1)</script><p>after</p></div>
out: <body><div class="x"><p>after</p></div></body>                        # script gone
in : <div class="box"><style>.box{color:red}</style><p>styled</p></div>
out: <body><div class="box"><p>styled</p></div></body>                      # style hoisted to getCss()
in : <div class="island" data-gjs-type="island" ... data-props='{"sku":"x"}'>...
out: <body><div data-island="cart" data-props="{&quot;sku&quot;:&quot;x&quot;}" class="island">...
                                                                            # data-gjs-type STRIPPED
```

And with the island type registered (`Components.addType('island', { isComponent, model.defaults })`):

```
out : <div data-gjs-type="island" data-island="cart" data-props="{&quot;sku&quot;:&quot;x&quot;}" class="island">...
out2: <div data-gjs-type="island" data-island="cart" data-props="{&quot;sku&quot;:&quot;x&quot;}" class="island">...
EMPTY-DIFF pass1: false  pass2: true
```

So: the registry is load-bearing for the round trip itself (`data-gjs-type` survives only if the type is
registered — otherwise the lock is stripped and the island becomes a plain div), the gate must be a
fixpoint test (I7), and `<script>`, comments and `<style>` are structurally impossible in page bodies
(I8). `getCss()` always emits `* { box-sizing: border-box; } body {margin: 0;}` — strip it at save (D-R9).

### 6.9 Export/backup: a plain copy loses the WAL

```
$ node -e "... WAL mode, 500 rows ..."
source count: 500 | wal bytes: 144232 | main db bytes: 4096
plain cp -> no such table: cms_pages
VACUUM INTO count: 500
cp after TRUNCATE checkpoint count: 500
```

```
foreign_keys default = 1        # better-sqlite3 13.0.3
fk off -> child row: [ { k: 'banner-renamed' } ]
dangling insert blocked: SQLITE_CONSTRAINT_FOREIGNKEY
```

Two contract facts: `VACUUM INTO` is the only safe export primitive (A1), and FK cascade is genuinely on
by default, so an asset-key rename rewrites `u_*` rows inside the admin transaction (contract 3.6.5).
