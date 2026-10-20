# R2.5 — Plugins

**Author:** Plugin Architecture Specialist · **Round 2.5** · 2026-10-20
**Read:** `IDEA.md` D1–D25 + §1.2/§12, `.agents/ARCHITECT.md`, all five R1 and five R2 papers,
`schema/site.sql`, `schema/control.sql`, `schema/r2-amendments.sql`, `schema/export-projection.json`,
`Makefile`, `scripts/model/*`.
**Constraint that arrived mid-round (CEO, overriding my brief):** third-party plugins are a
requirement; a plugin may be written outside the company and built outside our tree; it is installed
into a *running* CMS. In-tree `plugins/<id>/` is not the primary path, and "first-party only" is not
an answer.

**Thesis.** A plugin is a **signed package of declarations** plus code that runs in a process we
control and that has no database, no filesystem and no network. Everything a plugin can *change*
about a site — its tables, its blocks, its settings, its admin pages, its endpoints — is declarative,
host-rendered, and reviewable before it executes. Code exists only where a decision is needed at
request time, and it is reached over an RPC contract whose operations are an enum.

**Three things most likely to be wrong, stated before the argument:**
1. Host-rendered blocks mean a plugin cannot produce arbitrary markup. A plugin that needs a bespoke
   widget is refused in v1 (I price this, §6 and §12 Q4). If the first client needs one, the design
   bends at the block layer, not the trust layer.
2. Per-plugin memory is **not** enforceable in the runner (one cgroup for all plugins). A hostile
   plugin can starve its co-tenants inside the runner. Container-per-plugin fixes it at 48 MB and
   one service each; I do not pay that in v1 (§8).
3. Migrations are declarations, so a plugin cannot use SQLite features the emitter does not model —
   no triggers, no generated columns, no views. That is a real ceiling and it collides with the
   core's own schema habits (§5, §12 Q13).

---

## 1. Invariants I will defend (numbered, falsifiable)

Each is followed by the observation that falsifies it. Where the observation can be run today, the
probe is named.

| # | Invariant | Falsifier |
|---|---|---|
| **P-1** | **No plugin code runs on the render path.** A page renders identically with every plugin process dead. | Kill all plugin children; `GET` every published page; any status or body difference. Probe: §11 P6 D (hung plugin → 50/50 `503` on the *endpoint*, pages untouched by construction), and the render path contains no RPC call by design (§10 step 1). |
| **P-2** | **No plugin holds a database handle and no plugin sends SQL.** Every row arrives over RPC, scoped to the plugin's own `p_<id>_*` tables. | Any plugin process that opens a database file. Measured today: the JS wrapper loads but `new Database()` fails `ERR_DLOPEN_DISABLED` (§11 P6 A) — the native addon is the barrier, not the `require`. The invariant breaks the day someone adds `--allow-addons`. |
| **P-3** | **Egress is a network property, not a runtime flag.** Containment of a plugin's ability to exfiltrate is the runner's network namespace. | A plugin process that completes a TCP connection to any address outside the runner. Measured: under `--permission` alone `fetch` returns **200** and `net.connect` posts a body to a listener — two hits (§11 P6 A). Under `--network none` the same connect is `ENETUNREACH` (§11 P6 F). |
| **P-4** | **Every table in the file is classified for export**, core declared statically, plugin tables declared in their own manifest, and `make test` checks the union. | A `p_*` table in a bundle with no declared class. Today the gate checks `site.sql`'s text only and already misses `cms_trigger_registry` (§11 P1 §2). |
| **P-5** | **Migrations are declarations applied by the host, additive, in one transaction with a ledger row and a checksum.** A package contains no DDL text. | Any `CREATE`/`ALTER`/`DROP` token in a package that is not inside a declared AST, or a `p_*` table whose `sqlite_master.sql` differs from the emitter's canonical output. Probe: §11 P2 A–E. |
| **P-6** | **Uninstall cannot lose data silently.** Drop is host-executed, after an archive, and never a plugin's own operation. | A `DROP TABLE p_*` executed by anything other than `plugin uninstall`, or an uninstall whose archive is missing (§5). |
| **P-7** | **A disabled plugin's blocks keep their identity.** | A page saved while a plugin is disabled whose block loses `data-plugin`. Measured: `data-gjs-type` is stripped when the type is unregistered, `data-plugin`/`data-view`/`data-props` survive, so the host must register a tombstone type (§11 P3 §2). |
| **P-8** | **Every public endpoint is bounded** by a payload cap, a per-IP bucket, a per-tenant budget, and a wall-clock deadline; a dead plugin answers in ≤ its deadline and never takes a page down. | A request to a plugin endpoint that exceeds 2× its declared `timeout_ms`, or a `2xx` from an endpoint whose plugin process is dead. Measured: 50 concurrent against a hung plugin → 50 × `503` at 253 ms, event-loop gap 2.7 ms (§11 P6 D). |
| **P-9** | **Version monotonicity.** The ledger's `version` is the authority; no downgrade is executable. | A package installed whose `version` is below the ledger's for that `id`. |
| **P-10** | **Settings are declared and typed.** No free-form JSON reaches a settings form or an export. | A setting absent from `settings[]`, or an untyped value in `p_<id>_setting`. |
| **P-11** | **Plugins never write bytes and never see a path.** Asset references are `cms_asset` keys, resolved by the host. | A plugin package containing binary payloads in its data path, or an RPC response carrying a filesystem path or a checksum. |
| **P-12** | **Export is a property of the declarations, not of the code.** CMS bundle ships code + tables + data; Astro/static ship host-rendered markup plus a declared degradation, or refuse. | An Astro/static bundle whose plugin form posts to a dead local path, or a bundle that silently drops plugin rows without a line in `EXPORT-NOTES.md`. |
| **P-13** | **Nothing runs unsigned.** Install verifies a publisher signature over a package root that covers every file, and a revocation list is checked at install and at boot. | A plugin in `data/plugins/index.json` whose `signature.valid` is false, or whose `root` appears in `revoked.json`, and still serves a request. Measured costs: 84 µs/verify, 11.9 ms to hash 200 files (§11 P7). |
| **P-14** | **The manifest is the whole surface.** No endpoint, table, block, setting or capability exists that the manifest does not name. | An RPC operation reaching a table outside `tables[]`, or an endpoint answering at a path not derived from `/_p/<id>/<key>`. |

Two invariants I explicitly **do not** claim:

- *"A plugin cannot read another tenant's data."* It holds by construction because the plugin never
  sees a tenant identifier it can act on (the host binds tenant+plugin to the RPC channel), not
  because anything sandboxes it. A plugin cannot *name* a tenant, which is weaker and testable.
- *"A plugin cannot DoS the host."* It cannot block the loop (P-8, measured), and it cannot exhaust
  the host's memory from inside the runner's cgroup — but it can exhaust the *runner's* memory and
  starve other plugins (§8, "what this cannot do").

---

## 2. The manifest contract

`plugin.json` at the package root. Shown as `jsonc` — the `//` comments are the justification, and
they are not part of the file. Every field is either read by the host (and therefore enforceable) or
it does not exist.

```jsonc
{
  "schema": "skunkworks/plugin/v1",          // versioned; an unknown schema is a refusal, not a warning
  "id": "contact",                            // ^[a-z][a-z0-9]{1,19}$ — no hyphen, no underscore, so
                                              // every table it owns is a bare SQLite identifier
  "name": "Contact form",                     // display only; never parsed
  "version": "1.4.0",                         // semver; the ledger's monotonic key (P-9)
  "publisher": {
    "id": "acme-labs",                        // ^[a-z][a-z0-9-]{1,31}$
    "key_id": "ed25519:9f2c…"                 // must resolve in data/trust/publishers.json
  },
  "requires": {
    "cms": "^2.0.0",                          // semver range against the running image
    "runner": "1",                            // RPC contract version — the plugin's real ABI
    "node": ">=22.6"                          // informational: the runner's Node is fixed by the image
  },

  // ---- tables it owns. The host creates them; the plugin never sees DDL or SQL. ----
  "tables": [
    {
      "name": "p_contact_message",            // must match ^p_<id>_[a-z0-9_]+$ — checked at install
      "columns": [
        { "name": "id", "type": "integer", "pk": true, "autoinc": true },
        { "name": "name", "type": "text", "not_null": true, "max": 120 },
        { "name": "email", "type": "text", "not_null": true, "max": 320, "format": "email" },
        { "name": "message", "type": "text", "not_null": true, "max": 4000 },
        { "name": "attachment", "type": "asset_key" },   // TEXT REFERENCES cms_asset(key) + auto index
                                                          // + a generated delete guard (§5)
        { "name": "state", "type": "enum", "values": ["new", "read", "spam"], "default": "new" },
        { "name": "ts", "type": "date", "default": "now" }
      ],
      "indexes": [{ "name": "ix_p_contact_message_ts", "columns": ["ts"] }],
      "export": "rows",                       // rows | empty | filtered — the same closed set as
                                              // schema/export-projection.json; no fourth value exists
      "pii": true,                            // counts into EXPORT-NOTES and the admin consent screen
      "public_read": false                    // true lets an operator bind a query Data Source to it (§4 B)
    }
  ],

  // ---- schema changes, as declarations. Additive only; the host emits the SQL. ----
  "migrations": [
    { "version": 1, "changes": [ { "op": "create_table", "table": "p_contact_message" } ] },
    { "version": 2, "changes": [ { "op": "add_column", "table": "p_contact_message",
        "column": { "name": "phone", "type": "text", "max": 32 } } ] }
  ],

  // ---- settings: typed, bounded, admin-rendered. No free-form JSON. ----
  "settings": [
    { "key": "notify_email", "type": "email", "default": "", "required": true },
    { "key": "max_per_hour", "type": "int", "default": 20, "min": 1, "max": 500 },
    { "key": "autoreply", "type": "bool", "default": false },
    { "key": "smtp_password", "type": "string", "max": 200, "secret": true }
  ],

  // ---- public surface: rendered by the host from these declarations, not by the plugin ----
  "blocks": [
    { "key": "form", "kind": "form",          // form | list | markup | link
      "fields": [                             // the same field vocabulary as admin forms (§6)
        { "name": "name", "kind": "text", "label": "Your name", "required": true, "max": 120 },
        { "name": "email", "kind": "email", "label": "Email", "required": true, "max": 320 },
        { "name": "message", "kind": "textarea", "label": "Message", "required": true, "max": 4000 }
      ],
      "submit": { "endpoint": "submit", "label": "Send" },
      "success": { "kind": "inline", "text": "Thanks — we will be in touch." }  // a declared string,
                                              // escaped by the host; never plugin HTML
    }
  ],

  "endpoints": [
    { "key": "submit", "methods": ["POST"],
      "auth": "anonymous",                    // anonymous | session (code reserved, refused in v1)
      "limits": { "bytes": 16384, "per_ip": 5, "window_s": 600, "per_tenant_hour": 200 },
      "timeout_ms": 800,                       // clamped to [100, 2000] by the host
      "response": "json" }                     // json | redirect (Location from the declared success)
  ],

  // ---- admin surface: declarative specs, host-rendered (§6) ----
  "admin": {
    "list": "admin/list.json",                 // columns, order, page_size, actions
    "form": "admin/form.json",                 // fields, readonly, validation
    "actions": [{ "key": "mark_spam", "label": "Mark spam", "endpoint": "mark_spam" }],
    "menu": { "label": "Contact messages", "group": "content" }   // no badge in v1: a count would be an RPC
  },

  // ---- what it may ask the host for. Not a permission *claim*: the host grants a fixed set and
  //      refuses anything absent here, so this list is a subset check, not an authority. ----
  "capabilities": { "mail": "reply+notify", "assets": "resolve", "http": "none", "cron": "none" },

  // ---- how it degrades when there is no database (§9) ----
  "export": {
    "cms": "native",
    "astro": { "mode": "forward", "requires": ["action_url"] },   // forward | refuse
    "static": { "mode": "forward", "requires": ["action_url"] }
  },

  // ---- it must be testable to be installable (D) ----
  "tests": { "entry": "test/run.mjs", "timeout_s": 60 },

  // ---- produced by the packager, verified at install; never hand-written ----
  "integrity": { "root": "3addd03d…", "files": { "dist/index.mjs": "9c1f…" } },
  "signature": { "alg": "ed25519", "key_id": "ed25519:9f2c…", "sig": "base64…" }
}
```

### What is deliberately absent, and why

| Absent | Why it cannot exist |
|---|---|
| `trust` / `permissions` / `sandbox` | A plugin's own claim about its trust is not evidence. Trust is derived: our root key → publisher key → package root → every file hash. A field here would be read by someone as authority. |
| `depends` / `dependencies` | Dependencies are resolved **at pack time** and vendored into the package (`dist/` or `node_modules/`). Runtime `npm install` would be a network capability and a supply-chain hole at install time. |
| `sql`, `migrations[].sql`, `ddl` | P-2, P-5. A plugin that can send SQL has a database handle in effect, and no containment in Node survives that. |
| `db`, `dsn`, `storage` | There is nothing to name: no handle is ever handed over. |
| `env`, `secrets` | The runner's environment is empty and read-only. A plugin that needs a secret stores it in its own settings as `secret: true`. |
| `network` / `egress` / `allowed_hosts` | The runner has no route. A field describing egress would be a promise the netns already keeps, and would invite someone to relax it. |
| `scripts` / `postinstall` | Install runs the host's sequence; there is no lifecycle shell. |
| `admin.html`, `admin.js`, `csp` | Admin UI is declarative (§6); headers and CSP are host-owned (§7 of Security DS-11). |
| `cron` / `schedule` | Deferred, not refused forever: scheduled work needs a lease, a catch-up policy and an overlap rule that v1 does not have. `"cron": "none"` is the only legal value. |
| `entry` at the top level | Code is reached through `dist/index.mjs` by convention, so there is no path for a manifest to point the runner at an arbitrary file. |

**Manifest validation cost** (measured, §11 P5): 113 µs for one manifest cold, **0.12 ms for 20**.
A bad manifest is refused before any code is loaded: `table outside its namespace → table:u_contact_message`,
`no export class → export:…`, `anonymous endpoint with no limits → limits:…`, `unknown auth → auth:…`,
`missing requires.cms → requires.cms`.

---

## 3. The eleven §12 questions, answered

Q1–Q11 are `IDEA.md` §12's list. **Q12–Q14 are the three the CEO constraint added mid-round** (distribution, migration authority, degradation); Q6, Q7 and Q11 are re-answered because the original brief permitted a first-party-only trust model and the constraint forbids it. Each: **Decision / Alternatives rejected / Why they lost / Failure mode if wrong.**

### Q1 — Table ownership and naming

**Decision.** A plugin's tables are `p_<id>_<name>` (`^p_[a-z][a-z0-9]{1,19}_[a-z0-9_]+$`, ≤ 48 chars).
The id grammar forbids hyphen and underscore precisely so the name is always a bare identifier —
no quoting, no `"..."` variants for a validator to miss. **Only the host's migration executor may
`CREATE`/`ALTER`/`DROP` a `p_*` table.** The admin table builder cannot: its identifier check is
`^u_[a-z0-9_]+$`, which accepts `u_product` and rejects both `p_contact_message` and `cms_page`
(measured, §11 P1 §4). `cms_table_registry` cannot even represent a plugin table — its
`CHECK(table_name GLOB 'u_*')` rejects `p_contact_message` while accepting `u_product` (measured, P1 §7),
which is correct and means plugin tables need their own ledger (`cms_plugin_migration`, §5), not a
widened core one.

*Alternatives rejected — and why they lost.* (a) `u_plugin_<id>_*` — reuses the user namespace, so the admin's own builder
could `DROP` a plugin's data and every "user tables are the operator's" statement becomes false.
(b) No prefix, plugin tables look like core tables — the DDL runner, the projection and the export
all key off a prefix; without one, "is this protected?" becomes a query against a registry that a
plugin's own migration could have written. (c) One shared table `p_plugin_data(plugin, table, json)` —
turns every plugin into an EAV store, kills CHECK constraints, makes `u_*`-style FKs impossible, and
makes a single-row corruption a whole-plugin outage.

*Failure mode if wrong.* Two plugins cannot collide by construction, but a plugin id can collide with
an **existing `u_*` table's intent** (`p_contact_message` next to `u_contact_message`); install warns
and lists similarly-named `u_*` tables rather than refusing. If the prefix rule is wrong, the failure
is a schema migration across every tenant that installed plugins — the one thing this design must not
require.

### Q2 — Migration ownership

**Decision.** Migrations are an array of **declarations** (`{version, changes:[{op,…}]}`), applied by
the host, additive-only, each version in one `BEGIN IMMEDIATE` that also writes the ledger row and an
audit row. Idempotence is the ledger, not `IF NOT EXISTS`: re-running an applied version is one
indexed SELECT — **51 µs** (measured, §11 P2 A). The ledger stores `sha256` of the canonical declaration;
an edited migration at an already-applied version is refused (`checksum_mismatch`, measured P2 D),
because a changed definition is otherwise invisible: a `CREATE TABLE IF NOT EXISTS` whose CHECK was
tightened leaves the old CHECK in place and a 50-character value still inserts under a "5-character"
rule (measured P2 B). A migration that fails half-way leaves **no table and no ledger row** (measured
P2 C). Allowed ops: `create_table`, `add_column` (nullable or with a literal default), `create_index`,
`drop_index`. `drop_table`, `rename`, `drop_column` are not in the grammar.

*Alternatives rejected — and why they lost.* (a) Plugin ships SQL and the host runs it on a connection scoped to its
tables — the "scoped connection" does not exist: `PRAGMA query_only` denies the plugin its own table
just as hard as `cms_page` (measured P2 F), and a write handle grants `ALTER TABLE cms_page ADD COLUMN`
**and** `DROP TABLE cms_redirect` (measured). So SQL-from-plugin means either no migrations or a
compromised core. (b) `CREATE TABLE IF NOT EXISTS` as the idempotence story — measured to hide drift
(P2 B). (c) A per-plugin `user_version` PRAGMA — one integer, no history, no checksum, and `PRAGMA` is
a statement class the host must never accept from a plugin.

*Failure mode if wrong.* If the declaration grammar cannot express something a real plugin needs
(a composite unique index with a partial `WHERE`, a generated column, a trigger), the plugin either
ships without it or the grammar grows — and every grammar growth is a new SQL emitter path that must be
tested against injection. The measured gate corpus (§11 P2 E, 19/19 correct at 10.3 µs) is the
regression test that has to grow with it.

### Q3 — The contract shape

**Decision.** §2. The manifest declares tables, migrations, settings, blocks, endpoints, admin specs,
capabilities, export behaviour and tests; the packager adds `integrity` and `signature`. Nothing is
inferrable: a plugin's files are not scanned for exports, its package is not `import()`ed to discover
what it can do, and its code is never read to decide what it may touch.

*Alternatives rejected — and why they lost.* (a) Convention-over-configuration (`dist/routes/*.js` becomes endpoints) —
discovery by directory means the filesystem is the contract, and a package can add a route by adding a
file, which is exactly the surface P-14 forbids. (b) A capability string in the manifest ("needs db") —
a claim, not a check (§2 absent table). (c) GraphQL/OpenAPI as the plugin ABI — both describe an HTTP
surface; the plugin's surface is RPC over a socket with a fixed op enum, and neither format has a way
to say "no filesystem, no network, no handle".

*Failure mode if wrong.* If the manifest is too thin, plugins will need host changes for each new
feature (a cron, a webhook, a payment provider) and the "installable by a non-developer" promise decays
into "installable if we ship a release". The mitigation is that additions are *additive enum members*
with their own bounds, not new mechanisms.

### Q4 — Admin UI: declarative or code

**Decision.** **Declarative**, with one escape hatch that is not available to third-party packages:
a registered admin component that lives in **our** source tree. Costed in §6. The declarative path is
cheap enough that the argument is not close: a 12-field form renders in **9.4 µs / 2,532 B**, a 50-row
× 6-column list in **69.5 µs / 13,340 B**, and the whole admin surface of the contact plugin is
**1,521 B of JSON** (measured, §11 P5). Validation of a submission against the same spec is **1.0 µs**,
and the spec is what refuses a hostile value — `state: 'new" onmouseover="alert(1)'` is rejected by the
enum, not escaped and stored (measured P5 §2).

*Alternatives rejected — and why they lost.* (a) Plugin ships React/JS for admin — it puts third-party code in the admin
origin, on the surface that holds the session cookie and the CSRF token; CSP is `script-src 'self'`,
so the module must be built into the admin bundle, which means an image release: the escape hatch with
none of the restraint. (b) An `<iframe sandbox>` pane per plugin — needs a second origin (Security C-4:
a host that serves tenant content never shares an origin with admin), a second session check, and a
`postMessage` bridge; three new trust boundaries to render a table. (c) Server-rendered HTML from the
plugin over RPC — puts plugin code on the admin render path and makes every admin page as available as
the least reliable plugin.

*Failure mode if wrong.* A plugin whose admin needs a bespoke interaction (a map picker, a calendar
drag) cannot have it, and the operator's workaround is the generic form. That is a product cost paid by
one plugin, not a security cost paid by everyone — which is the right way round.

### Q5 — Public endpoint security

**Decision.** The host owns the route, the parsing, the limits, the token and the response envelope;
the plugin sees a validated form and returns a status + JSON. Concretely, and measured end-to-end in §11 P4:

- Route shape `/_p/<id>/<endpoint>`, POST only unless declared. `GET` → **404**, not 405 (no oracle).
- Content type `application/x-www-form-urlencoded`; anything else → **415**. The form works without
  JavaScript, so it works in all three SKUs and in a text browser.
- Payload cap 16 KiB: declared `Content-Length` over cap → **413**; chunked with no length → **413**
  at the cap. Measured: 40 KiB declared and 64 KiB chunked both 413 — but only after fixing the
  obvious implementation, because `req.destroy()` before writing the response makes the client see
  `ECONNRESET` instead (measured first, §11 P4 §3).
- Per-IP bucket 5 / 10 min → the 6th is **429** with `Retry-After: 600`; per-tenant hourly budget
  from `limits.per_tenant_hour` → 429 with the same body.
- Intent token `_pt`: HMAC over `(tenant, plugin, endpoint, ts)`, 30-minute TTL, minimum fill time
  1.5 s. A missing token, a bad MAC, an expired token and a too-fast submission all return **one**
  status and **one** body — 403 `{"ok":false,"code":"PL_E_REJECTED"}` — measured as 1 distinct shape
  across 4 causes. That is the whole anti-oracle obligation and it is testable.
- Honeypot `_hp`: non-empty → **202** with the same body a success returns (`{"ok":true}`), no row
  written (measured: rows unchanged).
- The plugin never sees the raw request: no headers other than a hashed UA/IP, no cookies, no query
  string it did not declare.

*Alternatives rejected — and why they lost.* (a) A CAPTCHA/Turnstile by default — a third-party script on every client's
site, a GDPR conversation per client, and it fails closed when the vendor is down; it becomes a
per-endpoint opt-in via a `captcha` capability, not the baseline. (b) CSRF tokens on an anonymous
form — there is no ambient authority to forge: an attacker's cross-site POST is indistinguishable from
their own direct POST, which the bucket already bounds. CSRF belongs to `auth: "session"` endpoints,
and those use the admin contract unchanged. (c) Per-plugin in-process rate limiting written by the
plugin — the attacker controls the plugin's process budget by definition.

*Failure mode if wrong.* Spam that passes all four controls lands in the plugin's table and the admin
list. The blast radius is one table with a declared `export` class and a `pii` flag, a row cap, and an
admin "delete all" action — not the site. A distributed low-and-slow campaign (1 request per IP per
hour) is not stopped by any of this; the honest defences there are the tenant's hourly budget and the
form's own content validation, and neither is a wall.

### Q6 — Trust model (re-answered under the CEO constraint)

**Decision.** **Third-party plugins are supported, and containment is a process in a container with no
network, no addons, no filesystem write, and no database — reached over an RPC enum.** Three layers,
each load-bearing, each measured:

| Layer | Control | Measured |
|---|---|---|
| Network | the plugin runs in the `plugin-runner` service with `network_mode: none`; the app talks to it over a unix socket on a shared volume | `net.connect` → `ENETUNREACH`; container `--network none` (§11 P6 F) |
| Process | one child per plugin package: `node --permission`, `--allow-fs-read` = that package + its scratch dir, **no** `--allow-addons`, no `--allow-child-process`, no `--allow-worker` | fs outside `DENIED`, write `DENIED`, `child_process` `DENIED`, `worker_threads` `DENIED`, `new Database()` `ERR_DLOPEN_DISABLED` (§11 P6 A) |
| Contract | the RPC enum (§8); the host binds `(tenant, plugin)` to the channel and ignores any tenant field in the payload | by construction; falsifier P-14 |

**What Node's permission model is not** is the finding that decides this section: under `--permission`
alone, `fetch('http://127.0.0.1:PORT/…')` returned **200** and a raw `net.connect` POST delivered a
body — the exfil listener logged **two hits** (§11 P6 A). The flag covers fs, addons, child processes
and workers; it does not cover the network. So **egress is the netns, and nothing else**. Anyone who
reads "permission model" as "sandbox" in the SDS would ship a plugin host that phones home on its first
request.

*Alternatives rejected — and why they lost.* (a) `worker_threads` — shares the process, the uid, the fds and the address
space; `--permission` denies `new Worker` anyway, and Security C-3 already established that a worker is
a latency control, not a boundary. (b) WASM — the only mechanism with an *enforceable* memory ceiling
(`WebAssembly.Memory` max pages) and no ambient I/O at all, but it requires an ABI, a language, and a
toolchain that the plugin ecosystem (npm, TypeScript) does not have; a plugin that needs a library
with a native or Node-specific dependency cannot be built. Costed as the v2 option for
compute-only plugins. (c) Container per plugin — the strictest available boundary (own netns, own
cgroup, own uid) at **47.4–48.0 MB RSS and 0.19 s cold start per plugin** plus one compose service
each (measured, §11 P6 F/G), which contradicts IDEA §3's "nginx, app, acme. Nothing else" and prices
a five-plugin site at +240 MB and +1 s of `compose up`. (d) In-process `import()` with a review
process — that is Security P3/S-9, and it is precisely what "third-party" forbids.

*Failure mode if wrong.* The runner is one cgroup: a plugin that allocates until the ceiling takes its
co-tenants down with it. It cannot touch the host (separate container, socket-only), it cannot reach
the network, and it cannot read another plugin's files (`--allow-fs-read` is per package) — but it can
degrade the other plugins. The fix is container-per-plugin, and it is a compose change, not a
redesign (§8, "what this cannot do").

### Q7 — Capability scoping (re-answered)

**Decision.** There is no handle to scope, so scoping is the **RPC operation enum** plus the
**declaration allowlist**. §8 is the specification; the shape is:

- Every op is `store.*`, `settings.*`, `assets.resolve`, `mail.*`, `log.write`, `util.*` — 14 operations,
  each with a named cap and a stable error code.
- `store.*` takes a **logical table name that must appear in `tables[]`**; the host maps it to
  `p_<id>_<name>` and rejects anything else with `PL_E_NO_TABLE`. There is no way to express `cms_page`,
  `u_*`, another plugin's table, or a join.
- Values are bound parameters, columns are from the declaration, `where` operators are an enum
  (`=`, `!=`, `<`, `<=`, `>`, `>=`, `in`, `like_prefix`), `limit` ≤ 500, response ≤ 256 KiB.
- The host owns the connection. `BEGIN IMMEDIATE` per mutation, and the plugin's write is one statement.

*Alternatives rejected — and why they lost.* (a) A "restricted handle" via `PRAGMA query_only` — measured: it denies the
plugin's own insert (`SQLITE_READONLY`) and a normal write handle grants `ALTER TABLE cms_page`
(§11 P2 F). There is no pragma that means "may write p_contact_*". (b) A per-plugin SQLite
`authorizer` callback to allow only its own tables — better-sqlite3 does not expose `sqlite3_set_authorizer`,
and even with it, `ATTACH` and `VACUUM INTO` are file-naming primitives (Security M1) that an authorizer
must also deny, i.e. the same statement-class problem with a false sense of completeness. (c) A view per
plugin table and a handle that can only see views — views are read-only, so writes still need a path,
and the plugin could still `ATTACH`.

*Failure mode if wrong.* If the op enum is too narrow, plugins that need a join or an aggregate cannot
be written, and the workaround is N+1 queries over RPC (measured at 22 µs each, so 50 rows is ~1 ms —
acceptable for admin, not for a public list). That is the same aggregate gap Red Team B2 already
recorded against Data Sources; it is one gap, not two.

### Q8 — Disable vs uninstall

**Decision.** Four states, one default each.

| Operation | Tables | Code | Endpoints | Blocks | Data Sources |
|---|---|---|---|---|---|
| **disable** | untouched | not loaded | 404 | host-rendered "unavailable" placeholder, `data-plugin` retained | publish refuses while disabled |
| **enable** | — | spawned lazily on first RPC | live | live | allowed |
| **uninstall** | archived then dropped | package kept in the store, marked `uninstalled` | 404 | placeholder | refused |
| **downgrade** | **refused** | refused | — | — | — |

`uninstall` is two host operations in one transaction and one file operation: `VACUUM INTO
data/backups/plugin-<id>-<ts>.db` (the whole tenant file — the operation the export already uses), then
`DROP TABLE` for every declared table, then a ledger row `uninstalled` with the checksum. The archive
path is printed; there is no flag that skips it. The default for a *missing* archive is a refusal
(`PL_E_ARCHIVE_FAILED`), not a silent drop.

*Alternatives rejected — and why they lost.* (a) Disable = unload everything, including the block type — measured: a page
saved while the type is unregistered loses `data-gjs-type` (182 B vs 205 B, §11 P3 §2), so the block
degrades to an editable div and its internals become editable content that is silently lost when the
plugin returns. The host therefore **always registers a tombstone type for every installed plugin**,
enabled or not; that is the whole reason disable is a state and not an uninstall. (b) Uninstall keeps
the tables "for safety" — then a reinstall at a new version meets the old schema, the ledger says
`uninstalled`, and the migration executor cannot tell an abandoned table from a live one. (c) Downgrade
by running the older package against the newer schema "if additive" — that is a compatibility matrix
nobody can test, and a downgrade is exactly when an operator is already in an incident.

*Failure mode if wrong.* If a plugin is uninstalled and the operator later restores the archive, the
restore is a whole-tenant DB, not a table set: it rolls back every other change made since. A
table-scoped archive would be better and is deferred (§12 Q3 for the Architect).

### Q9 — Export semantics across the three SKUs

**Decision.** §9 is the table; the rule is: **the CMS bundle carries everything, the Astro and static
bundles carry what is still true without a database, and anything else is a refusal with a named
cause.** Because blocks are host-rendered from declarations, the *markup* is identical in all three
SKUs — only the submit target and the data change.

*Alternatives rejected — and why they lost.* (a) Render plugin markup at publish into the page body — measured: the stored
form is 564 B vs 205 B for the placeholder, attribute order changes, `novalidate` becomes
`novalidate=""`, and the minted `_pt` token is frozen into the page forever (§11 P3 §3). A token in
stored HTML is a secret in content. (b) Ship the plugin's code in the static bundle — a static site has
no Node; the file would be dead weight and an unreviewed script on the client's origin. (c) Silently
drop plugin rows — that is the Red Team O3 class of failure with a different noun.

*Failure mode if wrong.* A static export of a site whose contact form has no `action_url` refuses
(exit 22) instead of shipping a dead form. The operator's remedy is a settings field, not a rebuild.

### Q10 — Version compatibility

**Decision.** Semver range against the *image* (`requires.cms`), checked at install, at boot, and on
upgrade. The RPC contract has its own integer (`requires.runner`), because a plugin is coupled to the
op enum, not to our release cadence. Three outcomes:

- **in range** → load.
- **out of range** → the plugin is `broken`, **the CMS boots**, its endpoints 503, its blocks render the
  unavailable placeholder, the admin shows `requires ^3.0.0, running 2.4.1`. Never refuse to start the
  CMS (Data Model C4 vs Platform PD3 settled the same shape for a stale tenant).
- **ahead of the ledger** (downgrade) → refused at install, `PL_E_DOWNGRADE` naming both versions.

*Alternatives rejected — and why they lost.* (a) Refuse to boot on a version mismatch — one plugin's manifest becomes a
fleet outage, at every restart, exactly the failure DM11/PD3 fought over. (b) Run degraded and hope —
"degraded" is indistinguishable from "broken" to a visitor; the plugin's endpoints must be off, and
that is the same decision as `broken`. (c) Auto-update from a registry — a plugin updating itself is a
remote-code-execution feature with a marketing name; updates are an operator action with a signature
check.

*Failure mode if wrong.* A plugin pinned to a version we no longer ship is stuck until its publisher
releases; the site keeps working without it. The cost is a support conversation, not an outage.

### Q11 — Where plugin code lives (re-answered)

**Decision.** Runtime-loaded from an immutable, content-addressed **plugin store**:
`data/plugins/<publisher>/<id>/<version>/<root[0:16]>/`, mounted read-only into the runner, discovered
from `data/plugins/index.json` (host-written, never plugin-written). Installation is a host operation
(`skunkworks plugin install <pkg>` or an admin upload that lands in the same function); nothing is ever
`import()`ed from a tenant's writable tree. Dependencies are vendored at pack time and resolved inside
the package by the runner's fs allowlist — a plugin cannot reach the host's `node_modules` because the
path is not readable from its process (measured: read outside the allowed dir `DENIED`, §11 P6 A).

Boot sequence for one plugin, with measured costs: read manifest (113 µs) → verify signature
(84 µs) → verify `requires` → compare ledger → apply pending migrations (1.8 ms for two statements,
51 µs when up to date) → register declarations → *do not spawn yet*.

*Alternatives rejected — and why they lost.* (a) In-tree `plugins/<id>/` compiled with the app — the CEO constraint makes
this the exception, not the path; keeping it as the primary path would mean every third-party plugin
requires our release, which is the opposite of "installable into a running CMS". (b) `import()` from a
tenant directory — Security A-5/Runtime R5, and the same thing with a nicer name. (c) `npm install` at
install time — network at install, an unpredictable dependency graph, and a package that is not the
package that was signed.

*Failure mode if wrong.* If the store's immutability is ever broken (a writable plugin dir), the
signature check becomes theatre: the files verified at install are not the files executed at request.
The falsifier is a boot-time re-hash of the package root — 11.9 ms for 200 files/565 KB
(measured, §11 P7), i.e. affordable at boot and cheap enough to also run per spawn.

### Q12 (§12.12) — Distribution and supply chain

**Decision.** A plugin is a **signed package**, verified before it is unpacked and re-verified before
it runs.

*Format.* `contact-1.4.0.skwpkg` = gzip'd tar, deterministic: sorted paths, `mtime=0`, mode `0644`
(files) / `0755` (directories), no symlinks, no device nodes, no path outside the archive root.
Contents: `plugin.json` (with `integrity.files` = per-file sha256 and `integrity.root` = sha256 over the
sorted `path\0hash` lines), `signature.ed25519` (64 raw bytes over the **root**, not over the tarball —
so re-compressing the package does not invalidate it), `dist/` or `node_modules/` (vendored, no runtime
install), `admin/*.json`, `test/run.mjs`, `test-report.json`.

*Publisher identity.* Ed25519. `publisher.id` + `publisher.key_id` resolve in
`data/trust/publishers.json` (`{id, keys:[{key_id, spki_b64, not_before, not_after, revoked_at}]}`).
The fleet root key signs that file; a bundle ships the subset that authorised the plugins it carries.

*Install sequence, with measured costs.* parse manifest (113 µs) → resolve key → `verify` the root
(**84.4 µs**) → hash every file and compare (**11.9 ms for 200 files / 565 KB**) → assert the recomputed
root equals the signed one → check `revoked.json` (exact-match set) → check `requires.cms` →
check `test-report.runner_image_digest` against the running image → extract to
`data/plugins/<publisher>/<id>/<version>/<root[0:16]>/` (read-only). Total ≈ 12 ms per package, and it
is the same function at install and at boot (P-13).

*Revocation.* `data/trust/revoked.json`, signed by the root key, a set of package roots. Revoking
**disables** — it never deletes: rows survive, the plugin cannot be enabled again, and its tables stay
exportable. A revocation is checked at boot and at install, so a revoked plugin that is already running
stops on the next restart rather than on the next request.

*Version refusal.* `requires.cms` out of range → `broken` (§Q10), never a boot failure.

*What the admin sees before enabling.* Generated by the host **from the declarations**, never from
plugin-supplied prose — a plugin that writes its own consent screen can lie on it:

```
contact 1.4.0 · acme-labs · key ed25519:9f2c… · signature VALID · package root 3addd03d…
  can:    store messages in 2 tables of its own (p_contact_message, p_contact_setting)
          render a form on your pages · add a "Contact messages" admin page
          ask the CMS to email you when a message arrives
  cannot: read your pages, forms, users or settings · read any other plugin's data
          reach the internet · read or write files · run a database query
  data:   p_contact_message holds personal data (names, emails, messages)
          export class "rows" — it will travel with a CMS bundle; 412 rows today
  tests:  PASSED (14 cases, runner 1.0.0@sha256:892b…)
```

*Alternatives rejected — and why they lost.* (a) An npm registry — an npm package is not a signed artefact over the exact
bytes, `postinstall` runs code at install, transitive dependencies resolve at install time (a network
capability and an unpinned graph), and typosquatting is a solved problem only for registries with
moderation. (b) One OCI image per plugin — digests are excellent, but it makes every plugin a service
(§8.3's 48 MB + 0.19 s each), needs a registry and network at install, and turns a 565 KB package into a
200 MB one. (c) A checksum with no signature (TOFU) — a checksum says "this is what I downloaded", not
"this is who wrote it"; the first MITM or mirror compromise is undetectable.

*Failure mode if wrong.* A publisher's key is compromised and a malicious **signed** plugin is
installed. The containment is what makes that survivable rather than catastrophic: the plugin cannot
read the site DB, cannot read another plugin's data, cannot touch the filesystem, and **cannot reach the
network**, so it cannot exfiltrate what it can see — and what it can see is its own tables. The damage is
rows it writes and content it renders until revocation. Without the netns, the same compromise is a
tenant-data breach; that is the strongest argument for §8.1's network rule.

### Q13 (§12.13) — Migration authority when the plugin is untrusted

**Decision. The host is the only migration authority; the plugin is not running while its schema
changes.** Install/upgrade is a host operation executed before any child is spawned: the package's
`migrations[]` are data, the host validates them against the grammar, emits the SQL, and applies each
version in one `BEGIN IMMEDIATE` with the ledger row and a `cms_audit` row. The plugin's code is never
invoked to "run its migrations", and no migration hook exists in the RPC enum.

*Upgrade.* The diff is computed against the **ledger**, not the live schema: every `changes` entry with
`version > ledger.version` is applied in ascending order. Additive only. A declaration that would drop a
column, change a type, or rename a table is not expressible in the grammar, so it fails at validation
with `PL_E_DESTRUCTIVE_UPGRADE` and the message names the declaration and the version.

*Data transformation.* The grammar has no `sql` op, so a plugin that must reshape its data (split a
column, backfill a value) does it at runtime through `store.query`/`store.update` in bounded batches
(500 rows per call) during a declared "migration" endpoint the admin triggers once. That is slower and
visible in the admin, and it is the price of never giving a plugin SQL.

*Downgrade.* Refused (`PL_E_DOWNGRADE`). The ledger records every applied version, so "run 1.2.0 code
against a 1.4.0 schema" is expressible as a fact and refused as a decision. Rollback = restore from the
bundle, which is the operation the export already produces and Platform P9 already verifies.

*Alternatives rejected — and why they lost.* (a) The plugin runs its own migration at first boot — it would need a handle,
which is P-2's whole point, and it puts schema changes on the request path of a container that may be
untrusted. (b) A per-plugin database user — SQLite has no users; roles are a connection pragma. (c) The
operator pastes the plugin's SQL into the admin DDL runner — no ledger, no idempotence, no
reproducibility across a bundle, and the operator is now the one who caused the outage.

*Failure mode if wrong.* A plugin whose real change cannot be expressed in the grammar is stuck: it must
ship a new table and copy at runtime, or it must be uninstalled and reinstalled with an archive (which
loses nothing but requires the operator). The measured gate (§11 P2 E) is the regression test that
decides whether a grammar addition is safe; every addition is a new emitter path and a new corpus line.

### Q14 (§12.14) — Degradation contract: a dead plugin must not take the site down

**Decision. Three independent failure domains, three different answers.**

| Failure | Public page | Public endpoint | Admin |
|---|---|---|---|
| child not spawned yet | renders (no RPC on the render path) | spawn (29.3 ms) then serve | opens, shows settings |
| child dead / crash-looping | renders; the block shows `blocks[].unavailable_text` and its controls are `disabled` | **503** immediately (in-flight requests fail fast, not on timeout) | "broken: 5 crashes in 10 min", with the last error |
| child hung | renders | **503** at `timeout_ms` (default 800; measured 253 ms at a 250 ms deadline) | same |
| child throwing | renders | **502** `PL_E_PLUGIN_ERROR` + `ref` | log with stack |
| runner container down | renders | **503** | "runner unavailable" |
| plugin disabled / uninstalled | renders placeholder with `data-plugin` retained | **404** | listed, no menu entry |
| breaker open | renders | **503** + `Retry-After: 5` | state shown, "retry now" |

**Breaker.** Per `(tenant, plugin, endpoint)`: opens after 5 consecutive failures **or** 3 timeouts
within 30 s; stays open 30 s; then one half-open probe; a success closes it, a failure reopens it for
60 s (doubling to 5 min). While open, the endpoint answers without touching the child, so a hung plugin
costs one map lookup per request, not a deadline.

**Crash backoff.** Lazy respawn at 1 s, 2 s, 4 s, 8 s, 16 s, capped at 30 s; **5 crashes in 10 minutes
marks the plugin `broken`** and stops respawning until an operator acts. No infinite crash loop, no
"it works every other request".

**Render-time text is declared, not generated.** `blocks[].unavailable_text` is a manifest string
validated like every other string (≤ 200 chars, escaped, no HTML). The host never asks a dead plugin
what to say.

*Alternatives rejected — and why they lost.* (a) Hide the block when the plugin is unavailable — a page silently loses a
section, and the operator finds out from a customer. (b) Fail the page (500) when a plugin is down —
that is the availability coupling P-1 exists to forbid; it would make every plugin a dependency of every
page. (c) Retry with no breaker — a hung plugin converts every request into a deadline, so a single
plugin can consume the whole request budget at 800 ms each; measured, 50 concurrent requests hit the
deadline in 253 ms and the loop stayed at 2.7 ms, which is only true because the deadline is enforced by
a timer rather than by waiting on the child.

*Failure mode if wrong.* A plugin that is **slow but not dead** (600 ms per request, under the 800 ms
deadline) never trips the breaker; it degrades the page's submit latency and nothing else, and the only
signal is monitoring. That is a deliberate gap: the breaker measures failure, not slowness, because a
latency-based breaker on a 200 ms p95 baseline would open on a cold cache and stay open.

---

## 4. Questions A–E answered

### A. A contact-form plugin overlaps core `cms_form` / `cms_form_submission`. Replace, extend, or coexist?

**Decision. Coexist, with core unchanged and the plugin additive.** `cms_form` keeps its
`mode IN ('store','forward','disabled')` contract and remains the zero-code form for sites that install
no plugins; the contact plugin owns `p_contact_message` and does not read or write `cms_form*` at all.
The two are not two implementations of one thing: core forms store a JSON payload against a declared
field list and forward by email/webhook; a plugin form *is* code (validation, autoreply, spam heuristics,
retention, attachments) and its rows are typed columns an admin can filter and a Data Source can read.
Core forms cannot grow those without becoming a plugin runtime, which is what this paper is.

**Migration story for the table that already exists.** Nothing moves on install. A tenant that already
has `cms_form` rows and wants the plugin runs a one-shot **import** (admin action, one transaction):
rows from `cms_form_submission` are mapped into `p_contact_message` by field name, the source form is
set `mode='disabled'` (not deleted), and the import writes an `cms_audit` row with the count. There is
no dual-write and no view over both, because a dual-write is a reconciliation problem forever and a
view hides which store is authoritative.

*Alternatives rejected — and why they lost.* (a) The plugin replaces core forms — every page authored against `cms_form`
breaks, the static SKU loses its only form story (core forms are the thing that degrades to `forward`),
and the plugin becomes a mandatory install. (b) The plugin extends `cms_form` via a
`handler = 'plugin:<id>'` column — that is a core migration per plugin, and it makes a plugin's
behaviour reachable through a row in a protected table, which is the same class of hazard as
`cms_asset.storage_path` (Red Team O5): privileged behaviour selected by editable data.

*Failure mode if wrong.* Two form systems confuse an operator, who builds the same form twice. The
mitigation is the admin's install screen, which says what the plugin adds that core forms cannot do —
generated from the manifest, not from plugin prose (§12.12).

### B. Can a plugin expose a Data Source?

**Decision. Yes, and it never touches the resolver.** A plugin declares `tables[].public_read: true`
(default false). The **operator** then creates an ordinary `query` Data Source over that table, exactly
as over a `u_*` table. The resolver gains one rule: a `query` source may name a `p_*` table only when
(i) the plugin is enabled, (ii) the table is declared with `public_read: true`, and (iii) the columns
named are declared columns. No plugin code runs on this path — the resolver is the same code that
serves `u_*`, and `site.source()` never learns a plugin exists.

The snapshot rule (Runtime I14) therefore applies **unchanged**, and that is the point: the plugin's
rows are a normal `query` source with declared param domains, so an Astro/static export enumerates,
caps and refuses exactly as it does for `u_*`. The blog-plugin example in the brief works: the plugin
declares `p_blog_post` with `public_read: true`, the operator binds `data-source="posts"`, and
`<div data-gjs-type="list" data-source="posts" data-limit="3">` renders it — the repeat contract is
Runtime's `list` component, not a plugin-provided one.

*Alternatives rejected — and why they lost.* (a) A plugin-supplied `function` source — banned in v1 by four papers, and it
would put third-party code on the render path (P-1). (b) A plugin-declared SQL view — views are
migration-owned core objects (`cms_view_registry`), and a third-party plugin creating a view means SQL.
(c) A plugin RPC that returns rows for a source — a page then costs one RPC per source per request and
inherits the plugin's availability, which is exactly what P-1 exists to prevent.

*Failure mode if wrong.* A plugin whose data needs an aggregate or a join cannot back a Data Source
(the same B2 gap core `u_*` tables have). The operator's remedy is a core table fed by a webhook, or a
deferred aggregate op — not a plugin-specific mechanism.

### C. Can a plugin own assets / upload handling?

**Decision. No uploads in v1; full read access by key.** A plugin table may declare `asset_key`
columns (FK to `cms_asset(key)`, automatically indexed, with a generated delete guard — measured: without
one, `DELETE FROM cms_asset` with `foreign_keys=OFF` leaves a dangling key, and with the generated
trigger it raises `DM_E_ASSET_IN_USE`, §11 P1 §8). The plugin resolves keys through
`assets.resolve(key)` → `{key, url, width, height, alt, mime, bytes}` and never sees a path, a checksum
or bytes. A public form with a file input is **refused at manifest validation** in v1
(`accepts_upload` does not exist, and a field of kind `file` is not in the field vocabulary).

*Alternatives rejected — and why they lost.* (a) The plugin writes into `content/media/` — that is a filesystem write
(pointed at the one directory that nginx serves) from third-party code; measured `fs.write` is `DENIED`
even to its own dir, and granting it would be granting the symlink farm to a package (§11 P6 A). (b) The
plugin receives uploaded bytes over RPC and passes them to a host op — the bytes cross the boundary
unbounded (a 40 MB upload becomes a 40 MB RPC message), and the sniffing/re-encode/quota pipeline
(Security DS-8) would have to be trusted to honour a cap the plugin can ignore. (c) A separate
"upload broker" service — a whole subsystem for one feature.

*Failure mode if wrong.* A CV-upload form cannot be built as a plugin. The fix is a core feature, not
a plugin permission: `cms_asset` gains a public-upload intake (cap, sniff, re-encode, quarantine, then
a key), and the plugin receives the key in its form payload. That is §12 Q2 for the Architect.

### D. The test contract

**Decision. Every plugin ships its own test entry point, and a package without a passing report cannot
be installed or exported.** `plugin.json.tests = {entry, timeout_s}`; the packager runs it **inside the
runner container** against a scratch `site.db` with the plugin installed, and writes
`test-report.json` into the package (`{entry, passed, cases, runner_image_digest, at}`). Install
verifies the report's presence and its `runner_image_digest` against the running image; a mismatch is a
refusal (`PL_E_TESTS_STALE`), because a report produced by a different runner proves nothing about this
one. `make test` gains `test-plugins`, which runs every package in `plugins.lock` the same way — so CI
tests the bytes the bundle ships, not the source tree.

*Alternatives rejected — and why they lost.* (a) "Plugins are tested by their authors, trust the report" — the report would
be free text from the party being tested. (b) Tests run in the host process "for speed" — the test
suite would then need the DB handle the plugin must never have, and the harness becomes the hole.
(c) No test requirement — then "exportable" and "untestable" are the same word, and the first bad
plugin is discovered by a client's contact form.

*Failure mode if wrong.* A plugin whose tests pass but whose code paths are untested in production
(a real SMTP server, a real 10k-row admin list) ships. The measured costs make the gate cheap: container
start 0.19 s, plugin process 29.3 ms, manifest validation 0.12 ms for 20 (§11 P5, P6).

### E. Plugin settings: declared schema or free-form JSON?

**Decision. Declared and typed**, rendered by the admin, validated by the host on write, stored in the
plugin's own `p_<id>_setting(key, value_json)` with a key CHECK and a value NOT NULL. Types:
`string|int|bool|email|url|enum|asset_key`, each with `max`, `min`/`max`, `values`, `default`,
`required`, and `secret`. A setting absent from `settings[]` cannot be written (`PL_E_NO_SETTING`); a
value failing its declaration cannot be written (`PL_E_SETTING_INVALID`, with the field named).
`secret: true` values are write-only over the whole surface: `settings.get` returns `null` and
`settings.has` returns a boolean; the admin form shows `••••••` and an empty submit keeps the old value;
the exporter excludes the row from every bundle.

*Alternatives rejected — and why they lost.* (a) Free-form JSON — the admin cannot render it (it would need the plugin's
code in the admin, §6), the exporter cannot classify it (a blob of unknown shape is `pii` by default,
which means every plugin's settings are excluded and a buyer's site arrives unconfigured), and
validation moves into plugin code, i.e. the plugin validates its own inputs. (b) Settings in
`cms_settings` under `plugin.<id>.*` — the table is core-protected with `type IN
('int','bool','string','json','asset_key')` and `updated_by` pointing at a core user; a plugin writing
there is a plugin writing a protected table, and the export filter (`key NOT GLOB 'demo.*'`) would need
a second namespace rule.

*Failure mode if wrong.* A plugin needs a structured setting (a list of recipients, a mapping) and the
flat schema cannot express it; the operator's workaround is a JSON string field, which is the
free-form answer arriving through the back door. The fix is one more declared type (`list` with an
item schema), not a blob.

---

## 5. Table ownership and migration lifecycle

### The three classes, and the one that is new

| Class | Owner | DDL authority | Row authority | Export |
|---|---|---|---|---|
| `cms_*` | the image (Drizzle migrations) | image only; DDL runner refuses | CRUD forms (D8) | static projection |
| `u_*` | the tenant's admin | the DDL runner, `^u_[a-z0-9_]+$` | the admin | static projection |
| **`p_<id>_*`** | **the plugin's declarations, applied by the host** | **the migration executor only** | the plugin over RPC; the admin through declared forms | **the manifest's `export` class** |

`p_*` is not a third dialect of the DDL runner; it is a second *caller* of the same emitter. The
builder's AST (Data Model DM2) is reused with three ops removed (`drop_table`, `rename`, `drop_column`),
because a plugin is exactly the caller that must not be able to express destruction. The emitter is the
only place identifiers become SQL, and its identifier allowlist is the measured gate: a 19-statement
corpus — including `DROP TABLE cms_page`, `/* c */ DROP TABLE cms_asset`, `-- tidy\nDROP TABLE cms_nav`,
`ALTER TABLE cms_page ADD COLUMN`, `CREATE INDEX … ON cms_page`, `CREATE TRIGGER … DELETE FROM cms_page`,
`ATTACH DATABASE '../beta/site.db'`, `PRAGMA writable_schema=ON`, `CREATE TABLE "cms_page_shadow"`, and a
two-statement string whose second statement is hostile — yields **19/19 correct verdicts at 10.3 µs per
migration** (§11 P2 E, G). SQLite helps here in a way DML never does: `CREATE TABLE` takes a literal
identifier, so a static classifier over DDL is *sound* — you cannot compute a table name into a
`CREATE TABLE`.

### Collision with a `u_*` table

There is no mechanical collision: `p_contact_message` and `u_contact_message` are different tables and
both may exist. The real hazards are two, and both are handled at install:

1. **Intent collision** — a plugin creates `p_contact_message` while the tenant already curates
   `u_contact_message`. Install prints the similarly-named `u_*` tables (`SELECT name FROM
   cms_table_registry WHERE name LIKE '%' || ? || '%'`) and requires an explicit `--yes` when any match.
2. **Prefix collision** — a plugin id equal to an existing plugin's prefix (`con` vs `contact`) is
   impossible: ids are unique in the ledger, and the table regex embeds the full id followed by `_`.
   A `p_` prefix CHECK written as `GLOB 'p_*'` would accept the empty id `'p_'`; `GLOB 'p_?*'` does not
   (measured, §11 P1 §5) — the same off-by-one GLOB that made `/` uninsertable in `cms_page` in R1.

### Lifecycle

```
install    manifest → verify sig → verify requires → ledger insert (version, checksum)
           → apply migrations[version > ledger.version] in ONE BEGIN IMMEDIATE
             (each: declaration → emitter → statement, then ledger row + cms_audit row)
           → register declarations (tables, blocks, admin, endpoints, settings)
           → write data/plugins/index.json

upgrade    same path; the diff is computed against the ledger, not against the live schema.
           additive changes apply automatically; a declaration that would drop or retype a column is
           refused (PL_E_DESTRUCTIVE_UPGRADE) and the remedy is uninstall+archive+reinstall.

downgrade  refused at install (PL_E_DOWNGRADE). The documented rollback is restore-from-bundle.

disable    no DDL. Code not loaded; endpoints 404; blocks use the tombstone type; sources refused.

uninstall  VACUUM INTO data/backups/plugin-<id>-<ts>.db
           → DROP TABLE for every declared table, in one transaction, ledger row 'uninstalled'
           → package stays in the store, marked uninstalled; blocks use the tombstone type.
```

**Measured** (all §11 P2): apply 1.81 ms for a two-statement migration; re-run 51 µs (one indexed
SELECT); a failed migration leaves `p_contact_note exists=0, ledger v2 rows=0`; an edited migration at
an applied version returns `checksum_mismatch`; and `CREATE TABLE IF NOT EXISTS` does **not** update a
changed CHECK — a 50-character value still inserts under a "5-character" rule, which is why the checksum
is over the declaration and not over the resulting schema.

**What the ledger is.** One core table, not a plugin one:

```sql
CREATE TABLE p_plugin_migration (          -- 'p_' here means 'plugin system', not 'plugin-owned';
  plugin_id TEXT NOT NULL CHECK(plugin_id GLOB '[a-z][a-z0-9]*'),   -- the one p_ table the host owns
  version   INTEGER NOT NULL CHECK(version > 0),
  checksum  TEXT NOT NULL CHECK(length(checksum) = 64),
  state     TEXT NOT NULL DEFAULT 'applied' CHECK(state IN ('applied','uninstalled','broken')),
  at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(plugin_id, version)
);
```

The name is a wart: `p_plugin_migration` matches the plugin-table pattern, so either the system table
moves to `cms_plugin_*` (my preference — it is core, it is protected, it is exported as `rows`) or the
plugin id `plugin` is reserved. I recommend `cms_plugin_migration`, `cms_plugin_installed`,
`cms_plugin_revoked`, and the `p_` prefix stays exclusively for plugin-owned tables. The three core
tables then join `export-projection.json` as `rows`, and the projection stops being a static file
about `site.sql` (§5.1).

### 5.1 The projection has to become a function, and the measurement says so today

Data Model I10: *every table is classified in `schema/export-projection.json`, and a table in the DDL
and not in the file fails the build.* The check is a set difference over **the text of `site.sql`**:

```python
ddl = {l.split()[2] for l in open(SITE_SQL) if l.startswith("CREATE TABLE ")}
assert ddl == set(proj["tables"])
```

Measured against the schema a tenant actually runs (`site.sql` + `r2-amendments.sql`, `user_version=2`),
that gate is already stale by one table: **21 tables in `sqlite_master`, 20 classified,
`unclassified=['cms_trigger_registry']`** (§11 P1 §2). `r2-amendments.sql` added a table and the check
never saw it, because the check reads one file rather than the database. Installing one plugin makes it
worse in a way no static file can fix: **23 tables, 3 unclassified** — `cms_trigger_registry`,
`p_contact_message`, `p_contact_setting` (§11 P1 §3).

So the rule survives, the mechanism changes: the **union** is checked, against a database that has the
fixture plugins installed.

```
core_tables    = the 20 (+ cms_plugin_*) in site.sql      -> export-projection.json
plugin_tables  = every installed plugin's tables[]        -> its manifest's "export" field
assert set(sqlite_master) == core_tables ∪ plugin_tables
assert every plugin table's class ∈ {rows, empty, filtered}
```

The intent of I10 — *a table cannot join the schema without someone deciding what it means for a sale* —
is preserved exactly. What changes is that the decision is made by the plugin's publisher and reviewed
at install, instead of by whoever edits a JSON file in our repo. The export itself needs no change:
`VACUUM INTO` carries plugin rows automatically — measured: 200 rows in `p_contact_message` survived a
`VACUUM INTO`, 372,736 B of snapshot (§11 P1 §6). A plugin table declared `empty` is emptied in the
snapshot by the same code that empties `cms_form_submission`, keyed on the manifest rather than on a
hard-coded list.

Plugin tables also inherit Platform's quiescence rule unchanged: the count set `BUNDLE.json` carries is
taken over **every** table including `p_*`, before, after and inside the snapshot, so a row written
mid-export is either in all three or the export refuses (exit 23). A plugin is not an exception to
"a bundle cannot verify its own completeness" — it is one more table the same counts must cover, which
is exactly why the class belongs in the manifest rather than in a hard-coded list.

Two consequences the Architect has to accept or reject:

1. `cms_trigger_registry` gets a projection entry (it is `rows`: the DDL postcondition reads it).
2. A plugin's `export` class is **reviewed at install**, and the install screen shows it. A publisher
   declaring `rows` on a table of prospect emails must also declare `pii`, which is shown, counted into
   `EXPORT-NOTES.md`, and cannot be overridden by the plugin at export time.

---

## 6. Admin UI extension: declarative vs code

### The two costs

| | Declarative (specs in the manifest, host renders) | Code (a component in the admin bundle) |
|---|---|---|
| Render cost | 12-field form **9.4 µs / 2,532 B**; 50-row × 6-column list **69.5 µs / 13,340 B** | build-time inclusion, an image release, and a bundle-size delta nobody measures until it ships |
| Validation | **1.0 µs**, same spec that renders — one source of truth | the component validates; the host cannot re-derive the rules |
| What the plugin ships | **1,521 B of JSON** for a list + form | source + build output, signed, reviewed line by line because it runs on the admin origin |
| Consistency | every plugin's admin looks like the CMS because it *is* the CMS | each plugin is its own design; the operator learns N UIs |
| Reviewability | the whole surface is data, diffable before install | the surface is code; a signature says who wrote it, not what it does |
| Bespoke widgets | none — no map, calendar or chart | any widget |
| Install without us | yes | no — an image release |

### The argument that decides it

A third-party component rendered in the admin origin can read the DOM of the page that hosts it, and
the admin page contains the CSRF token because the admin UI must render it. That is not hypothetical:
it is the mechanism Security C-4 uses to reject path-prefixed demos sharing an origin with admin
("a demo page can `fetch('/admin/pages')` … and lift the token"). A plugin's admin component would sit
*inside* that origin with the session cookie attached, so every DS-11 control (session-bound CSRF, exact
`Origin`) passes while the plugin does whatever it likes. The only honest way to run third-party UI code
is a separate origin with no session — an iframe — which costs a second host, a second session check and
a `postMessage` protocol to render a table.

So: **declarative for everything a plugin needs to administer its own rows, and an escape hatch that is
in-tree only.** The hatch is `src/admin/components/<name>.tsx` in the admin component registry,
referenced by `admin.form.fields[].kind` (a closed enum compiled into the image). A manifest naming an
unregistered kind fails validation (`PL_E_SCHEMA`), so a third-party package cannot reach the hatch at
all.

**The hatch's price:** one component (~150–400 lines), one registry entry, one image build, one deploy —
the same release path as any core change, hours to days rather than a plugin install. That is the right
price for the only mechanism that keeps third-party code out of the admin origin.

### What the declarative surface must cover to be enough

| Admin need | Declarative answer |
|---|---|
| list, filter, sort, paginate | `admin.list` (columns, `order`, `page_size`) |
| view/edit one row | `admin.form` (the same field vocabulary as public blocks: text, email, textarea, select, bool, int, datetime, asset, page) |
| row actions | `admin.actions[]` → an endpoint, with a confirmation string |
| bulk actions | `admin.actions[].scope = "selected"`, capped at 200 ids per call |
| asset picker | `kind: "asset"` — the host's media picker writes a key, never a path |
| page picker | `kind: "page"` — the host's page list writes a path |
| rich text | `kind: "richtext"` — the host's editor component, stored with the I8 validator applied |
| a dashboard number | `admin.list` with `page_size: 1` and a `count` column kind; no chart |
| a bespoke interaction | **refused for third-party** — the hatch is ours |

Measured proof that the spec is the contract, not a suggestion: `state: 'new" onmouseover="alert(1)'` is
refused by the enum (`state:enum`), not escaped and stored; `priority: '42'` is refused by the int range;
a 4,001-character message is refused by `max` (§11 P5 §2). The renderer escapes every value it writes,
and the spec cannot express `class`, `style` or `on*`.

---

## 7. Public endpoint security

| Threat | Control | Measured |
|---|---|---|
| payload bomb | 16 KiB cap: declared-length pre-check **and** streamed count; nginx `client_max_body_size 32k` as the outer wall | 40 KiB declared → **413**; 64 KiB chunked → **413** (§11 P4 §3) |
| flood from one IP | token bucket 5 / 10 min per endpoint, in-process | 5 × 200 then **429** `Retry-After: 600` (§11 P4 §4) |
| distributed low-and-slow | per-tenant hourly budget (`limits.per_tenant_hour`, default 200) + the tenant's edge `limit_req` | budgeted, not measured |
| bot that fills every field | honeypot `_hp` → **202** with the *same* body as success, no row | rows unchanged, body identical (§11 P4 §6) |
| bot that submits in 80 ms | `_pt` carries `ts`; age < 1.5 s → the uniform 403 | 4 causes, **1 response shape** (§11 P4 §5) |
| token guessing / enumeration | HMAC-SHA256 16-byte MAC, constant-time compare; missing/bad/expired identical | same status and body |
| replay inside the TTL | token scoped to (tenant, plugin, endpoint); the bucket bounds replays, not the token | — |
| CSRF on a session endpoint | `auth: "session"` uses the admin CSRF contract unchanged (session-bound token, exact `Origin`) | inherited from DS-11 |
| plugin throwing / hanging | deadline `timeout_ms` (default 800, clamp 100–2000) → **503**; breaker per (tenant, plugin) | 50 concurrent vs a hung plugin → 50 × 503 at **253 ms**, loop gap **2.7 ms** (§11 P6 D) |
| error-message oracle | every plugin failure is `502 PL_E_PLUGIN_ERROR` with `{"ok":false}`; detail to the log with a correlation id | by construction |
| response bomb | JSON ≤ 8 KiB, fixed `Content-Type`, no `Set-Cookie`, no custom headers except a declared `Location` | by construction |

### The response contract

```
POST /_p/contact/submit        Content-Type: application/x-www-form-urlencoded
  → 200 {"ok":true}                          stored
  → 202 {"ok":true}                          accepted and dropped (honeypot) — indistinguishable
  → 403 {"ok":false,"code":"PL_E_REJECTED"}  token missing | bad MAC | expired | too fast
  → 413 {"ok":false,"code":"PL_E_TOO_LARGE","max_bytes":16384}
  → 415 {"ok":false,"code":"PL_E_CONTENT_TYPE"}
  → 422 {"ok":false,"code":"PL_E_INVALID","field":"email"}
  → 429 {"ok":false,"code":"PL_E_RATE","retry_s":600}          + Retry-After
  → 429 {"ok":false,"code":"PL_E_QUOTA","scope":"tenant_hour"}
  → 502 {"ok":false,"code":"PL_E_PLUGIN_ERROR","ref":"c-8f21"} plugin threw
  → 503 {"ok":false,"code":"PL_E_UNAVAILABLE"}                 breaker open | deadline exceeded
  → 404                                        GET, or an endpoint not in the manifest
```

Three deliberate omissions. **No 400**: a malformed request is indistinguishable from a hostile one and
gets the uniform rejection. **No 405**: a `GET` on a POST-only endpoint is a 404, so a scanner learns
nothing about which paths exist. **No `Set-Cookie`**: a public endpoint that can set a cookie can set one
on the tenant's origin, and the tenant's cookies belong to the host.

### CSRF, stated once

An **anonymous** endpoint has no session to forge: a cross-site POST carries exactly the credentials a
direct POST does, so a CSRF token defends nothing and costs a cookie. What it needs is intent (the `_pt`
token, bound to tenant+plugin+endpoint and time-boxed) and a bound (the bucket) — which is what it has.

A **session** endpoint is the admin surface's problem and uses the admin contract unchanged:
session-bound token compared against the exact `Origin`, no `text/plain` exemption (DS-11).

A **plugin never mints, stores or verifies a CSRF token.** If it could, a compromised plugin could mint
one for a surface it must not touch — and the admin's control would become "the plugin said so".

`auth: "code"` exists in the enum and is **refused in v1** (`PL_E_SCHEMA`): gated downloads are core
(IDEA §7.4), a plugin must not be able to gate paid bytes, and a code-verifying endpoint would need the
one secret the host keeps to itself.

### Quotas and growth, with the measured unit

A stored submission costs **553 B** marginal (300-char message + two 64-hex hashes, §11 P4 §8). At the
per-IP bucket alone (5 / 10 min = 720/day/IP) a thousand IPs produce 720k rows/day ≈ **398 MB/day**.
That is why the per-tenant hourly budget exists, and why a table declares `max_rows` (default 100,000 ≈
55 MB): the write path answers `PL_E_QUOTA` **before** SQLite answers `SQLITE_FULL`, the failure mode
where the admin cannot log in to fix it.

### What this cannot do

- Stop a human who types real messages. The plugin's own heuristics are the only defence, and they are
  the plugin's problem by design.
- Stop a botnet at 1 request per IP per hour. The tenant hourly budget is the only bound and it is
  blunt: 200/hour suits a contact form and is far too low for a ticket system — which is why it is a
  declared number, not a constant.
- Protect a static/Astro export's endpoint. There the form posts to an external URL the operator
  supplies, and none of these controls are ours any more — which is why §9 makes that an explicit
  pre-flight decision rather than a default.

---

## 8. Trust model and capability scoping

### Topology

```
                 ┌─────────────────────────── app (Node) ───────────────────────────┐
 public request →│ Fastify /_p/<id>/<key>                                            │
                 │   cap → bucket → token → validate → RPC ──► PluginHost ──┐       │
                 │ render path: NO plugin call; blocks rendered from the     │       │
                 │              manifest's declarations                      │       │
                 └──────────────────────────────────────────────────────────┼───────┘
                                                                            │ unix socket
                                         run/plugin.sock (shared volume)    │ 39.8k calls/s
                 ┌──────────────── plugin-runner (network_mode: none) ───────▼──────┐
                 │  one child per plugin package:                                  │
                 │  node --permission --allow-fs-read=<pkg> --allow-fs-read=<tmp>  │
                 │       no --allow-addons, no --allow-child-process,              │
                 │       no --allow-worker, no route                               │
                 │  stdio/IPC JSON, ≤1 KB responses                                │
                 └─────────────────────────────────────────────────────────────────┘
```

One runner container for **all** plugins. That is the decision §8.3 costs.

### 8.1 What is contained, and by what

| Capability | Denied by | Measured |
|---|---|---|
| read a file outside its package | `--allow-fs-read` | `DENIED ERR_ACCESS_DENIED` |
| read its own package | allowed, read-only mount | `ALLOWED 232` (bytes) |
| write anything | no `--allow-fs-write` | `DENIED ERR_ACCESS_DENIED` (even its scratch) |
| spawn a process | no `--allow-child-process` | `DENIED ERR_ACCESS_DENIED` |
| spawn a worker | no `--allow-worker` | `DENIED ERR_ACCESS_DENIED` |
| load a native addon | no `--allow-addons` | `new Database()` → `ERR_DLOPEN_DISABLED` |
| open any SQLite file | the above | denied |
| reach the network | **the netns, not the flag** | flag alone: `fetch` → **200**, `net.connect` → delivered; netns: `ENETUNREACH` |
| read another plugin's package | per-package fs allowlist | by construction |
| read the host's `node_modules` | not in the allowlist | `DENIED` |

The network row is the one that must be bold in the SDS: **`--permission` does not restrict `net`;
`fetch` and `net.connect` both succeeded and the exfil listener logged two hits.** A reader who takes
"the plugin runs under Node's permission model" as the containment story will ship a plugin host that
can POST a tenant's rows to the publisher on its first request. The netns is the control; the flag is
what stops a bug becoming a file write.

### 8.2 The RPC surface — every operation, its bound, its error

| Op | Shape | Bound | Refusal |
|---|---|---|---|
| `store.insert` | `(table, row)` | row ≤ 32 KiB, ≤ 24 columns, declared columns only, types coerced and checked | `PL_E_ROW`, `PL_E_NO_TABLE` |
| `store.update` | `(table, id, patch)` | ≤ 24 columns, one row | `PL_E_ROW` |
| `store.delete` | `(table, id)` | one row; `delete_all` is an admin action, not an op | `PL_E_ROW` |
| `store.query` | `(table, where, order, limit, offset)` | `limit ≤ 500`, `offset ≤ 10,000`, ops ∈ {=,!=,<,<=,>,>=,in,like_prefix}, `order` on declared+indexed columns, response ≤ 256 KiB | `PL_E_QUERY`, `PL_E_TOO_MANY` |
| `store.count` | `(table, where)` | same `where` grammar | `PL_E_QUERY` |
| `settings.get` | `(key)` | declared key; `secret` → `null` | `PL_E_NO_SETTING` |
| `settings.has` | `(key)` | boolean only | — |
| `settings.set` | `(key, value)` | declared type and bounds | `PL_E_SETTING_INVALID` |
| `assets.resolve` | `(key)` | one key → `{key,url,width,height,alt,mime,bytes}`; no path, no checksum, no bytes | `null` |
| `mail.send` | `(to, template, vars)` | `to` is the tenant's configured notification address **or** an address the host validated in *this* request; declared template; ≤ 32 KiB rendered | `PL_E_MAIL` |
| `log.write` | `(level, msg)` | ≤ 1 KiB, ≤ 100 lines/min/plugin | dropped |
| `util.now` | `()` | server clock, ISO 8601 | — |
| `util.random` | `(n)` | `n ≤ 32` bytes, CSPRNG | — |
| `util.hash` | `(algo, data)` | sha256/sha512, ≤ 1 KiB — idempotency keys, not crypto | `PL_E_ARG` |

**Deliberately absent**, each absence a decision: `sql`, `exec`, `prepare` (P-2); `db`, `attach` (no handle
exists); `fs.*` (no write; read is one directory); `net.*`, `http.*`, `fetch` (no route); `env` (empty);
`require`/`import` outside the package (fs allowlist); `worker`, `spawn` (flags); `assets.write`,
`assets.upload` (§4 C); `mail.raw` (no arbitrary headers or recipients — a contact form that can send to
any address is a spam relay); `tenant.*` (the host binds it; the plugin cannot name one); `cms.*` (no read
of pages, forms, settings, users); `store.raw`, `store.join` (aggregates are the deferred gap, not a
hidden escape); `cron` (no scheduled work in v1); `stream` (responses are bounded buffers).

### 8.3 What one plugin costs, and what container-per-plugin would cost instead

| Item | Measured |
|---|---|
| plugin child RSS | **38.2 MB** empty module, **42.8 MB** peak with a module loaded |
| spawn → module loaded → exit | **29.3 ms** median (min 28.4, max 30.8) |
| RPC round trip (IPC) | **22 µs** p50, **103 µs** p95, **27,591 calls/s** |
| app → runner hop (unix socket) | **15 µs** p50; two hops ≈ **37 µs** p50 |
| runner container idle (`node:22-alpine`) | **47.4–48.0 MB**, **0.19 s** cold start (10 runs, local image) |
| one hung plugin, 50 concurrent requests | 50 × `503` at **253 ms**, event-loop gap **2.7 ms** |
| manifest + signature verify at boot | 113 µs cold + 84 µs |
| package re-hash (200 files, 565 KB) | 11.9 ms |

**Five plugins** cost ≈ 191 MB inside the runner's cgroup and 145 ms of spawn on first use (lazy, so not
on the boot path), plus 0.19 s of container start at install. Container-per-plugin is ≈ 240 MB, five
compose services and five image references; it buys a per-plugin memory ceiling and per-plugin egress
policy. I do not pay that in v1 because the runner already removes the two things that matter (no
network, no host), and the remaining risk is availability *inside* the runner, which the breaker
contains.

### 8.4 What this cannot do — the honest list

1. **No per-plugin memory ceiling.** One cgroup for the runner; a plugin allocating 400 MB starves its
   co-tenants. Mitigations: `--max-old-space-size=96` per child (bounds the V8 heap, not Buffers), an
   RSS watchdog killing a child over 128 MB, and the breaker. The real fix is container-per-plugin at
   48 MB each.
2. **No per-plugin egress policy.** All plugins share "no route". A plugin that "needs to call Stripe"
   cannot, at all — that is a host webhook's job (`/api/hooks/<tenant>/…`), not a plugin capability.
3. **No native dependencies.** A plugin needing `sharp`, `bcrypt` or a database driver cannot run. That
   is a real product constraint (image processing, PDF generation) and the reason first-party plugins
   needing those stay in the core.
4. **No streaming or long jobs.** 256 KiB response cap, 2 s deadline at the top end.
5. **No cron in v1.** A plugin cannot wake itself; scheduled work is a host feature (a job table with a
   lease) that does not exist yet.
6. **A compromised runner is a compromised *runner*.** It holds plugin data in flight and the socket to
   the app; it does not hold the site DB, the session keys, or the network. The blast radius is the
   plugin tables it serves — which is why the socket protocol carries no SQL and no paths.

---

## 9. Export semantics per SKU

| | CMS bundle | Astro project | Static HTML/JS |
|---|---|---|---|
| Plugin code | package in `data/plugins/`, `index.json`, `trust/publishers.json` | **not shipped** | **not shipped** |
| Runner | `plugin-runner` service in compose (`network_mode: none`) | — | — |
| Blocks | host-rendered per request | host-rendered **at export**, written into the `.astro` page | host-rendered at export, written as `.html` |
| Endpoints | live | per `export.astro`: `forward` (rewrite `action` to `action_url`) or `refuse` | per `export.static`: same |
| Tables + rows | `rows`/`empty`/`filtered` per the manifest, inside `site.db` | via a bound `query` Data Source only (Runtime I14 enumeration), otherwise **absent** | same as Astro |
| Admin | yes | no | no |
| Refuses when | — | `mode: "refuse"`, or `forward` with no `action_url` | same |

### The pre-flight report, per plugin

```
PLUGINS
  contact 1.4.0  acme-labs  signature ok (ed25519:9f2c…)  tables 2 (rows 2, pii 1)
    cms     native        p_contact_message (rows, pii), p_contact_setting (rows)
    astro   forward       action_url = https://forms.acme.com/contact   [from settings]
    static  forward       action_url = https://forms.acme.com/contact   [from settings]
    data    NOT EXPORTED  p_contact_message holds 412 rows (pii) — no bound Data Source
  blog 2.0.1     acme-labs  signature ok  tables 3 (rows 2, empty 1, pii 0)
    static  forward       p_blog_post bound to source "posts" — 60 snapshot combos, cap 1024  OK
gated-downloads 1.0.0  acme-labs  signature ok
    static  REFUSED       requires a database (export.static.mode = "refuse")  → exit 22
```

Three refusals, each with a named cause and a remedy in the message:

- `PL_E_EXPORT_FORWARD_NO_TARGET` — `forward` with no `action_url` (the operator fills a setting; no
  rebuild).
- `PL_E_EXPORT_REFUSE` — the plugin declares `refuse` for this target. A plugin that gates paid bytes
  cannot exist in a static site; IDEA §5.1's gated-asset refusal is the same rule one level down.
- `PL_E_EXPORT_SNAPSHOT` — a bound Data Source over a plugin table whose param domain is not enumerable
  (Runtime I14's `free` param), exit 22.

### What degrades, honestly

A static export of a contact page is a form that posts to *someone else's* endpoint. Everything the
plugin would have done — the row, the admin list, the autoreply, the spam heuristics — happens on a
server the buyer may not own. That is not a degradation of the plugin contract; it is the same promise
IDEA §5.1 already makes for core forms ("post to a configured external endpoint"), and the pre-flight prints
the URL so nobody discovers it after the sale.

An Astro export is the same with one difference that costs the buyer nothing: the markup is generated at
export from the same declarations, so it is a real static form that can be restyled, and the `.astro`
page is editable like every other page (D24).

---

## 10. Worked example: the contact-form plugin, end to end

### 1. Authoring — the stored body holds a placeholder, not a form

The designer drops the block; GrapesJS stores **205 B** (measured, §11 P3 §1):

```html
<div data-gjs-type="plugin" data-plugin="contact" data-view="form"
     data-props="{&quot;title&quot;:&quot;Contact us&quot;}"></div>
```

`data-gjs-type` is re-emitted by the type's `model.defaults`, the only thing that keeps the lock
(Runtime M2 vs M3). Round-trip is **pass1 == input: true, pass2 == pass1: true** — the placeholder is a
fixpoint from the first save, unlike hand-authored markup (Runtime C5's 8/9 failures). The stored body
holds no `<form>`, no token, no plugin markup: a plugin upgrade changes what visitors see without
touching a page, and the token is never frozen into content (§11 P3 §3 shows the alternative: 564 B,
reordered attributes, a dead `_pt` value stored forever).

### 2. Render — the host builds the form from the declaration

```
GET /contact
  resolve page → body_html → walk components → type "plugin"
  → look up declarations[contact.blocks.form] → render 879 B (measured) → page shell
  → no RPC, no plugin process, no plugin code on this path
```

The 879 B contain **no `<script>`, no `<style>`, no `on*`**: a form that submits natively needs none, so
the page keeps `script-src 'self'` in all three SKUs (Runtime C2) and the I8 body validator has nothing
to reject. A plugin that wants client-side behaviour is asking for an island — which is a core
component, in our tree, versioned with the image, not something a package can ship.

```html
<form class="pl-form" method="post" action="/_p/contact/submit">
  <input type="hidden" name="_pt" value="eyJ0IjoiYWNtZSIsInAiOiJjb250YWN0IiwiZSI6InN1Ym1pdCIsInQiOjE3NjEw…">
  <input class="pl-hp" type="text" name="_hp" tabindex="-1" autocomplete="off" aria-hidden="true">
  <div class="pl-row"><label class="pl-label" for="f-name">Your name *</label>
    <input class="pl-input" type="text" id="f-name" name="name" required maxlength="120" value=""></div>
  … email, message …
  <button class="btn btn--primary" type="submit">Send</button>
</form>
```

The token is minted by the host (HMAC over tenant+plugin+endpoint+ts), because a token the plugin mints
is a token the plugin can forge. The honeypot is host-added and host-checked; the plugin never sees
`_hp`, so it cannot accidentally store it.

### 3. Submit — 0.22 ms in the host, 22 µs in the plugin

```
POST /_p/contact/submit   (237 B body)
  host:   cap ok → bucket 3/5 → token ok (age 2 s) → honeypot empty → fields validate (1.0 µs)
  RPC:    store.insert("message", {name,email,message,ip_hash,ua_hash})     ← 22 µs p50
  plugin: its own rules, returns {"ok":true}
  host:   200 {"ok":true}
```

Measured end to end: **p50 0.22 ms, p95 0.48 ms, max 1.88 ms** over 300 sequential submissions; the
first request after boot is 14.9 ms (JIT + statement prepare). Under 20-way concurrency: 20/20 `200`,
p50 4.0 ms, zero `SQLITE_BUSY` (§11 P4 §2, §9). One row costs **553 B**.

The insert is one host-emitted statement:

```sql
INSERT INTO p_contact_message(name,email,message,ip_hash,ua_hash) VALUES(?,?,?,?,?)
```

### 4. Admin — a list the host renders from `admin/list.json`

```
GET /admin/t/acme/p/contact/messages
  50 rows × 6 columns → 13,340 B in 69.5 µs (measured, §11 P5)
```

Columns are declared; `message` truncates at 80 characters with `…`; `state` renders as the host's pill;
`ip_hash` shows 8 characters. Row actions (`mark_read`, `mark_spam`) are declared actions → endpoints →
RPC; each writes one row plus one `cms_audit` row. No plugin JavaScript on this page.

### 5. Export — three answers from one manifest

- **CMS bundle**: `data/plugins/acme-labs/contact/1.4.0/3addd03d…/` (565 KB for a 200-file package),
  `index.json`, `trust/publishers.json`, and `plugin-runner` in compose. Install re-verifies the
  signature (84 µs) and the package root (11.9 ms), applies no migrations (51 µs), and the first
  submission spawns the child (29.3 ms).
- **Astro**: the `.astro` page carries the same 879 B of markup with `action` rewritten to
  `https://forms.acme.com/contact`; `p_contact_message` does not travel (no bound Data Source);
  `EXPORT-NOTES.md` says "412 rows (pii) not exported".
- **Static**: identical markup, no islands, no runner, no data; if `action_url` is empty the export stops
  at `PL_E_EXPORT_FORWARD_NO_TARGET` naming the setting to fill.

### 6. Failure, at each step

| Failure | Visitor sees | Operator sees |
|---|---|---|
| plugin process dead | the form renders (P-1); submit returns 503 | "contact: unavailable (breaker open)" |
| plugin hangs | 503 in ≤ 800 ms | one log line with the deadline and the correlation id |
| plugin throws | 502 with a generic body | the stack in the log, `ref` in the response |
| plugin disabled | form renders with `data-plugin` retained; submit 404 | the plugin listed as disabled |
| `action_url` missing at export | — | the export refuses, naming the setting |
| signature invalid | nothing: it never installs | install refuses with the publisher and key id |

---

## 11. What I measured (command + real output)

All commands run 2026-10-20 on macOS 15.7.4, Node v22.23.1, better-sqlite3 13.0.3, SQLite 3.43.2,
grapesjs 0.23.8 + jsdom 30.1.3, Docker 29.7.2 with `node:22-alpine` present locally. Scripts are
committed at `scripts/debate/r2-plugin/`; `p2`/`p4`/`p6` need `SK_PROBE_DEPS=<dir with better-sqlite3>`,
all accept `SK_PLUGIN_WORK` (default `~/.hermes/profiles/ceo/cache/scratch/pluginprobe/work`). Output
below is verbatim.

### P1 — the projection, the prefixes, and the asset guard (`p1_projection.py`)

```
$ python3 scripts/debate/r2-plugin/p1_projection.py
1. the shipped gate reads one DDL file, not the schema
   tables in site.sql                     : 20
   tables in export-projection.json       : 20
   site.sql - projection                  : []

2. same question against the schema a tenant actually runs (site.sql + r2-amendments.sql)
   user_version                           : 2
   tables in sqlite_master                : 21
   unclassified (build failure per I10)   : ['cms_trigger_registry']
   stale entries in projection            : []

3. after installing one plugin with 2 tables + 1 index
   tables in sqlite_master                : 23
   unclassified (build failure per I10)   : ['cms_trigger_registry', 'p_contact_message', 'p_contact_setting']
   of which plugin-owned                  : ['p_contact_message', 'p_contact_setting']

4. IDEA §6 DDL runner regex ^u_[a-z0-9_]+$ against plugin identifiers
   u_product              accepted=True
   p_contact_message      accepted=False
   cms_page               accepted=False

5. prefix CHECK: GLOB 'p_*' accepts an empty plugin id (the '*/' mistake, one level up)
   GLOB p_*     'p_'->1   'p_contact'->1
   GLOB p_?*    'p_'->0   'p_contact'->1

6. VACUUM INTO with 200 plugin rows (no filter can be applied: the file is the unit)
   live file 4096 B -> snapshot 372736 B ; rows live=200 snapshot=200
   snapshot unclassified tables           : ['cms_trigger_registry', 'p_contact_message', 'p_contact_setting']

7. cms_table_registry declares u_* only (CHECK table_name GLOB 'u_*')
   u_product              accepted
   p_contact_message      rejected (CHECK constraint failed)

8. a plugin table with an ASSET column, and the delete guard that does not exist yet
   fk=OFF, no plugin guard: asset deleted, rows still pointing at it = 1
   with a generated guard: DELETE refused (DM_E_ASSET_IN_USE)
   triggers in sqlite_master: ['trg_cms_asset_delete_guard', 'trg_cms_asset_sha_immutable', 'trg_cms_download_code_hash_immutable', 'trg_asset_guard_p_contact_attachment']

9. a manifest-declared class, validated against the same closed set
   plugin declares                        : {'p_contact_message': 'rows', 'p_contact_setting': 'rows'}
   covers its own tables                  : True
   every value in the projection's closed set: True
```

### P2 — migrations: ledger, drift, atomicity, and what a write handle reaches (`p2_migrate.mjs`)

```
$ node scripts/debate/r2-plugin/p2_migrate.mjs
A. idempotence by ledger, not by IF NOT EXISTS
   install #1 -> applied  (1.807708 ms, 2 statements)
   install #2 -> skip  (50.917 us: one indexed SELECT on the ledger PK)
   ledger rows: [{"plugin_id":"contact","version":1}]

B. `CREATE TABLE IF NOT EXISTS` is not idempotence: it hides a changed definition
   after a "v2" that only changed the CHECK: CHECK unchanged
   a 50-char message still inserts under the "new" 5-char rule: 1 row(s)
   => drift is invisible unless the migration text is checksummed (D)

C. failure atomicity: the table and the ledger row appear together or not at all
   refused with: no such table: p_contact_nothing
   p_contact_note exists=0  ledger v2 rows=0  (no half-installed plugin)

D. an edited migration is detected, not re-run
   same version, edited text -> checksum_mismatch

F. the engine does not protect cms_* — only the code path does
   ALTER cms_page: OK
   DROP cms_redirect: OK
   insert cms_settings under query_only: SQLITE_READONLY
   create p_x under query_only: SQLITE_READONLY
   => query_only denies the plugin its own table; a write handle grants it cms_page. No pragma splits them.

E. a statement-class gate over the exact corpus a plugin migration could carry
   allow -> accepted   CREATE TABLE p_contact_message (id INTEGER PRIMARY KEY)
   allow -> accepted   CREATE TABLE IF NOT EXISTS p_contact_tag (id INTEGER PRIMARY KEY)
   allow -> accepted   CREATE UNIQUE INDEX ix_p_contact_tag_key ON p_contact_tag(id)
   allow -> accepted   ALTER TABLE p_contact_message ADD COLUMN phone TEXT
   allow -> accepted   INSERT INTO p_contact_setting(key,value_json) VALUES('notify','"a@b.c"')
   deny  -> REFUSED forbidden_verb:DROP   DROP TABLE cms_page
   deny  -> REFUSED forbidden_verb:DROP   drop table if exists cms_redirect
   deny  -> REFUSED forbidden_verb:DROP   /* housekeeping */ DROP TABLE cms_asset
   deny  -> REFUSED forbidden_verb:DROP   -- tidy DROP TABLE cms_nav
   deny  -> REFUSED alter_outside_namespace:cms_page   ALTER TABLE cms_page ADD COLUMN injected TEXT
   deny  -> REFUSED alter_op_not_additive:RENAME TO   ALTER TABLE p_contact_message RENAME TO cms_page_x
   deny  -> REFUSED index_on_foreign_table:cms_page   CREATE INDEX ix_p_contact_bad ON cms_page(path)
   deny  -> REFUSED forbidden_statement:TRIGGER   CREATE TRIGGER p_contact_trg AFTER INSERT ON p_contact_message BEGIN DEL
   deny  -> REFUSED forbidden_statement:VIEW   CREATE VIEW p_contact_v AS SELECT * FROM cms_download_code
   deny  -> REFUSED forbidden_verb:ATTACH   ATTACH DATABASE '../beta/site.db' AS beta
   deny  -> REFUSED forbidden_verb:PRAGMA   PRAGMA writable_schema = ON
   deny  -> REFUSED forbidden_verb:DROP   CREATE TABLE p_contact_a (x TEXT); DROP TABLE cms_audit
   deny  -> REFUSED create_outside_namespace:cms_page_shadow   CREATE TABLE "cms_page_shadow" (x TEXT)
   deny  -> REFUSED create_outside_namespace:u_sneaky   CREATE TABLE p_contact_ok (x TEXT); CREATE TABLE u_sneaky (y TEXT)
   correct verdicts: 19/19

G. gate cost: 2000 x 2-statement migration in 20.6 ms = 10.3 us per migration
```

### P3 — the block: round-trip, disablement, and the alternative (`p3_block.mjs`)

```
$ node scripts/debate/r2-plugin/p3_block.mjs
1. placeholder only, type registered
   in   : <div data-gjs-type="plugin" data-plugin="contact" data-view="form" data-props="{&quot;title&quot;:&quot;Contact us&quot;,&quot;fields&quot;:[&quot;name&quot;,&quot;email&quot;,&quot;message&quot;]}"></div>
   out1 : <div data-gjs-type="plugin" data-plugin="contact" data-view="form" data-props="{&quot;title&quot;:&quot;Contact us&quot;,&quot;fields&quot;:[&quot;name&quot;,&quot;email&quot;,&quot;message&quot;]}"></div>
   pass1==input true  pass2==pass1 true  bytes 205  top-level components 1

2. placeholder only, type NOT registered (plugin disabled, page saved afterwards)
   out1 : <div data-plugin="contact" data-view="form" data-props="{&quot;title&quot;:&quot;Contact us&quot;,&quot;fields&quot;:[&quot;name&quot;,&quot;email&quot;,&quot;message&quot;]}"></div>
   pass1==input false  pass2==pass1 true  bytes 182
   data-plugin kept? true   data-view kept? true   data-gjs-type kept? false

3. placeholder + the plugin's rendered markup (the alternative: store the form)
   out1 : <div data-gjs-type="plugin" data-plugin="contact" data-view="form">
          <form method="post" action="/_p/contact/submit" novalidate="" class="plugin-form">
          <input type="hidden" name="_pt" value="tok_abc"/>
          <input type="text" name="_hp" tabindex="-1" autocomplete="off" class="plugin-form__hp"/>
          <label for="f-email" class="plugin-form__label">Email</label>
          <input id="f-email" type="email" name="email" required placeholder="you@example.com"/>
          <textarea name="message" rows="5" required maxlength="4000">
          </textarea>
          <button type="submit" class="btn">Send</button>
          </form>
          </div>
   surviving: <form:true action="/_p/contact/submit":true method="post":true type="hidden":true name="_pt":true required:true placeholder=:true maxlength=:true rows=:true novalidate:true tabindex=:true
   pass1==input false  pass2==pass1 true  bytes 564

4. props carrying a closing script tag, an angle bracket and entities
   in   : <div data-gjs-type="plugin" data-plugin="contact" data-view="form" data-props="{&quot;title&quot;:&quot;a&lt;/script&gt;&lt;img src=x onerror=alert(1)&gt;&quot;}"></div>
   out1 : <div data-gjs-type="plugin" data-plugin="contact" data-view="form" data-props="{&quot;title&quot;:&quot;a&lt;/script&gt;&lt;img src=x onerror=alert(1)&gt;&quot;}"></div>
   literal "</script>" in stored output? false   "<img" present? false

5. one page, K plugin blocks (marginal stored bytes and editor cost)
   k= 1  stored=  104 B  load=13.11 ms  marginal=- B/block
   k= 4  stored=  416 B  load=11.55 ms  marginal=80 B/block
   k=16  stored= 1670 B  load=17.34 ms  marginal=100 B/block
```

### P4 — the endpoint contract (`p4_endpoint.mjs`)

```
$ node scripts/debate/r2-plugin/p4_endpoint.mjs
endpoint up in 5.7 ms on 127.0.0.1:53562

1. a valid submission (token minted 2 s ago, human-shaped payload)
   status 200  body {"ok":true}  14.94 ms  row bytes 237
   rows=1

2. N=300 valid submissions, sequential (p50 / p95 / max)
   p50 0.22 ms  p95 0.48 ms  max 1.88 ms

3. payload cap = 16 KiB
   40 KiB body, declared length -> 413 {"ok":false,"code":"PL_E_REJECTED","max_bytes":16384}
   64 KiB chunked (no Content-Length) -> 413 {"ok":false,"code":"PL_E_REJECTED","max_bytes":16384}

4. per-IP bucket = 5 / 10 min
   statuses 200,200,200,200,200,429,429  7th: 429 retry-after=600 body={"ok":false,"code":"PL_E_REJECTED","retry_s":600}

5. rejections are one shape and one status (no oracle for a bot)
   no token             -> 403 {"ok":false,"code":"PL_E_REJECTED"}
   bad mac              -> 403 {"ok":false,"code":"PL_E_REJECTED"}
   expired (31 min)     -> 403 {"ok":false,"code":"PL_E_REJECTED"}
   too fast (200 ms)    -> 403 {"ok":false,"code":"PL_E_REJECTED"}
   distinct response shapes across 4 rejection causes: 1

6. honeypot: 202, identical body to success, no row written
   status 202 body {"ok":true} (a stored submission answers 200 {"ok":true})  rows 306 -> 306

7. content type and method
   application/json       -> 415
   GET /_p/contact/submit -> 404

8. storage cost per submission, measured as a marginal byte count
   306 -> 506 rows, 184320 -> 294912 B = 553 B/row marginal (300-char message + 64-hex ip/ua hash)
   /Users/…/endpoint.db-wal after checkpoint 0 B (a WAL tenant is never read-only: Data M2 / Platform P11)

9. 20 concurrent submissions (bucket raised to 100 for this section only)
   200s 20/20  p50 4.0 ms  p95 4.8 ms  max 4.8 ms
   SQLITE_BUSY count 0 (one process, one write connection, autocommit per insert)
```

Two implementation notes that are findings, not noise. (i) The first version used
`req.destroy(); send(413)` and the client saw **`ECONNRESET`, not 413** — the response dies with the
socket, so the cap must be "stop buffering, answer, then drain", with nginx's `client_max_body_size`
as the actual byte wall. (ii) The 413 body in the probe says `PL_E_REJECTED` and carries `max_bytes`;
the final contract in §7 renames it `PL_E_TOO_LARGE` and keeps the field — the probe's job was the
status and the cut-off, not the string.

### P5 — the declarative admin surface (`p5_admin.mjs`)

```
$ node scripts/debate/r2-plugin/p5_admin.mjs
manifest 601 B   list+form spec 1521 B   (the whole admin surface of the plugin)

1. declarative render cost (n=1000, warm)
   form: 12 fields                            9.4 us   2532 B
   list: 50 rows x 6 columns                  69.5 us   13340 B
   validate one submission against the spec   1.0 us   2 B

2. is the spec the contract? same input, three payloads
   valid              -> ok
   missing required   -> email:required
   too long           -> message:max
   enum escape        -> state:enum
   int out of range   -> priority:range

3. manifest validation at boot
   one manifest: valid in 113.4 us
   20 manifests: 0 error(s) in 0.12 ms (12020 B of JSON parsed+checked)

4. boot cost of 20 in-tree plugin modules (compiled with the app, not import()ed from a tenant dir)
   20 modules, 15790 B of source: 3.0 ms cold import (ESM parse+link)

5. what a bad manifest is refused for (first failure stops the plugin, not the boot)
   table outside its namespace        -> table:u_contact_message
   table with no export class         -> export:p_contact_message
   anonymous endpoint with no limits  -> limits:submit
   endpoint auth not in the enum      -> auth:submit
   requires.cms missing               -> requires.cms
```

Section 4 measures the *rejected* path (in-tree modules) only to show that its boot cost is 3.0 ms —
cheap, and irrelevant under the CEO constraint, which is why the number is here rather than in a decision.

### P6 — containment, its cost, and what the flag does not cover (`p6_trust.mjs` + Docker)

```
$ node scripts/debate/r2-plugin/p6_trust.mjs
A. inside `node --permission`, no --allow-addons
   fs.read outside              DENIED ERR_ACCESS_DENIED
   fs.read own dir              ALLOWED 232
   fs.write scratch             DENIED ERR_ACCESS_DENIED
   child_process                DENIED ERR_ACCESS_DENIED
   import better-sqlite3        ALLOWED function Database(filenameGiven, options
   open db via better-sqlite3   DENIED ERR_DLOPEN_DISABLED
   fetch 127.0.0.1:EXFIL        ALLOWED 200
   net.connect + raw HTTP POST  ALLOWED HTTP 200
   worker_threads               DENIED ERR_ACCESS_DENIED
   rss_after_load_MB            56.7
   exfil server hits: 2 ["/exfil?plugin=contact","/exfil?via=net"]
   file written outside the plugin dir: false

B. cost of one plugin process (10 spawns, cold)
   rss_MB                     38.2 MB
   rss_after_4MB_MB           46.8 MB
   spawn -> module loaded -> exit: median 29.3 ms  min 28.4  max 30.8
   peak RSS (kernel): 42.8 MB

C. RPC round trip over child_process IPC (JSON, 1 KB response)
   child ready: {"k":"ready","v":"39.3"}
   2000 calls in 72 ms = 27591 calls/s
   per call: p50 22 us  p95 103 us  max 2533 us

D. a plugin that never answers: 250 ms deadline, 50 concurrent public requests
   statuses: {"503":50}
   answered in p50 253 ms  max 253 ms   (deadline 250 ms)
   worst event-loop gap during the burst: 2.7 ms

E. the extra hop a containerised runner costs: unix socket, JSON lines, 2000 round trips
   2000 calls in 50 ms = 39838 calls/s   p50 15 us  p95 86 us
   two hops (socket + child IPC) therefore ~37 us at p50
```

F. the same image with no route: cold start, 10 runs

```
$ for i in $(seq 1 10); do /usr/bin/time -p docker run --rm --network none --memory 160m \
    --memory-swap 160m --pids-limit 64 --cap-drop ALL --read-only --user 10001:10001 \
    node:22-alpine node -e 'console.log("ok")' 2>&1 | awk '/real/{print $2}'; done
0.20 0.20 0.19 0.19 0.19 0.20 0.18 0.18 0.18 0.20
```

G. what "no route" does to the same call the child made earlier

```
$ docker run --rm --network none --memory 160m --pids-limit 64 --cap-drop ALL --read-only \
    --user 10001:10001 node:22-alpine node -e 'import("node:net").then(n=>{
      console.log("rss_MB",(process.memoryUsage().rss/1048576).toFixed(1));
      n.connect(80,"1.1.1.1").on("error",e=>console.log("egress",e.code))})'
rss_MB 47.4   egress ENETUNREACH
rss_MB 48.0   egress ENETUNREACH
rss_MB 47.9   egress ENETUNREACH
```

### P7 — supply chain (`p7_supply.mjs`)

```
$ node scripts/debate/r2-plugin/p7_supply.mjs
hash 200 files (564690 B): 11.9 ms
package root 3addd03dba02f2e6…
ed25519 sign: 36.0 us per signature
ed25519 verify: 84.4 us per signature, accepted=true
signature 64 B, public key 44 B (SPKI DER)
tamper one file: root changed=true, signature still valid=false, rehash 3.7 ms
per-file diff names the tampered path: ["dist/m7.mjs"]
revocation lookup over 1 root(s): not revoked (exact-match set, O(1))
```

### What I did **not** measure, and will not assert

- **Browser behaviour.** No Chromium here; the CSRF-token argument about admin UI code is reasoned from
  Security C-4 and DS-11, not observed. Red Team B11 is still open.
- **Per-plugin RSS under a real workload** (a plugin holding 10k rows in memory). The 38.2 MB figure is
  an empty module; the `--max-old-space-size` and watchdog design in §8.4 is untested.
- **A trust store with N publishers** — sign/verify cost is measured; key distribution and rotation are
  policy, not measurement.
- **Multipart/upload** — deliberately absent from v1 (§4 C), so nothing to measure.
- **A distributed spam wave.** The hourly budget is arithmetic over the measured 553 B/row, not an
  observation.
- **The composed runner path under load** (app → socket → runner → child). The socket hop and the child
  IPC are measured separately; the composed number, ~37 µs p50, is their sum and has not been run across
  two containers.

---

## 12. Open questions for the Architect

Ordered by what blocks the SDS first. Each is a decision I cannot make from inside this domain.

1. **A fourth service in `docker-compose.yml`.** IDEA §3 says "nginx, app, acme. Nothing else." §8 needs
   `plugin-runner` (`network_mode: none`, one cgroup, socket-only). Either that sentence changes or
   third-party plugins are impossible. This is the single blocking item.
2. **A public upload intake in `cms_asset`.** §4 C refuses plugin-owned uploads; the first client with a
   CV form needs the core to grow a public-intake path (cap → sniff → re-encode → quarantine → key).
   Who owns it, and does it ship in S3 or S5?
3. **Uninstall archive granularity.** §5 archives a whole `site.db` with `VACUUM INTO` — the operation
   the export already uses — which restores everything, not one plugin's tables. A table-scoped archive
   needs a per-table export format nobody has designed. Is whole-file acceptable for v1?
4. **The trust root for publishers.** Q12 assumes *we* hold an Ed25519 root and sign publisher keys.
   The alternative — each tenant's owner pastes a publisher's public key — removes us as a CA but makes
   every install a support call. That is a commercial and legal decision (we would be asserting an
   identity), not a technical one, and it needs the CEO.
5. **Does a sold CMS bundle ship third-party plugins at all?** The bundle carries their code, their
   runner service and their trust entries, which changes what a buyer supports and what we indemnify.
   §9 assumes yes, with the buyer's admin able to disable. The alternative — plugins are hosted-tier
   only — contradicts §1.1's sell-the-CMS promise.
6. **`cms_form` coexistence.** §4 A keeps core forms and adds the plugin alongside. Confirm two form
   systems is acceptable product surface, because the alternative (core forms become a plugin) removes
   the static SKU's only form story.
7. **Reservation of the `plugin` id and the rename of the ledger.** §5 recommends `cms_plugin_migration`
   / `cms_plugin_installed` / `cms_plugin_revoked` as core tables; Data Model owns that DDL and the
   projection entry. If the ledger stays `p_plugin_*`, the regex needs one carve-out and every "a `p_`
   table is plugin-owned" statement in the SDS becomes false.
8. **The projection's plugin classes (measured conflict).** I10's gate already fails on the amended
   schema (`cms_trigger_registry` unclassified) and cannot represent a runtime table. §5.1 makes the
   check a union of a static file and installed manifests — a change to another domain's invariant, and
   it needs a ruling rather than a footnote.
9. **Cron / scheduled plugin work.** Refused in v1. If a plugin needs a daily digest, the host needs a
   job table, a lease and an overlap rule — a feature with its own failure modes (a stuck lease on a box
   that rebooted). Defer or design now?
10. **Does the static SKU ever carry a plugin's data?** §9 says only through a bound `query` Data Source
    (Runtime I14), so a contact form's *messages* never travel to a static buyer — correct. But a
    "testimonials" plugin's rows would, and only if the operator binds a source. Confirm that an
    operator-created binding is the only door.
