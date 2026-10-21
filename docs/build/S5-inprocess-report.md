# S5 — the in-process plugin model: the runner retired, the loader built, three retained blockers closed

**Date:** 2026-10-21. **Builder:** S5 backend pass. **Authority:** `docs/sds/SDS.md` §13.3.1–§13.3.9 and §13.1a;
`docs/sds/02-errata.md` E-31…E-33; `docs/sds/13-plugin-model-delta.md` for what to forget.
**Decision of record:** D36 — plugins load in-process inside the website container, WordPress-style.

**Result: 5 of 5 items done.** `make test` exits 0 at **554/554 node tests, 27/27 claims, frozen PASS
(`pointers: 23/23`), `verify-dist` 6/6**, wall clock **191.78 s**, measured at **load average 67.32
(1 min) / 51.87 (5 min)** — the box was heavily loaded throughout this pass, and every timing number in
this document is quoted with the load beside it. `hermes verify --json` returns **`ok: true`** with all seven phases green and a live readiness probe
(`200` on `http://127.0.0.1:4321/`), which is the run that records the evidence for this workspace; earlier
full runs were green at load 71.76 and 67.32, and two lost one file to the 40 s per-file timeout under load
44–65 (below). Nothing was committed.

**Closeout pass, same day — §10 supersedes the counts above:** the gate is now **583/583 node tests** (the
eight new ones are S1–S4 and G1–G4), and `make test` is **exit 0 in two of three consecutive runs**; the
third lost one pre-existing file to the per-file budget with **no assertion failing**. §10 also records the
class of assertion that made the rename sampler fail at load 22–34, the four sites that shared it, the
per-tenant handle `sync()` now reuses, and the form component the registry had declared but never had.

Two things a reader should take from this report before anything else:

1. **The capability check is now a single layer with an exclusive witness.** It was mutated, seen red,
   and restored byte-identically (§4). That is the replacement for the second layer the runner provided,
   and it is the only thing standing between a package and a table it did not declare.
2. **E-29's pointer item has NOT landed** (§6). It is verified, measured, and reported rather than
   half-applied: raising `POINTERS` without the E-24…E-33 pointer lines in the SDS would turn
   `make verify-frozen` red, which is worse than the current honest 23/23 against a stale range.

---

## 1. Item 1 — the runner is retired

### Failing test first

`test/compose.test.ts` was rewritten to §16 S1's new row *before* `docker-compose.yml` was touched, and
run: `not ok 2 — exactly three services … plugin-runner is absent by name`, `# pass 6 # fail 1`. Then the
service was deleted and the same file went `# pass 7 # fail 0`.

### What was deleted, with line counts

| Artefact | Lines | What it was |
|---|---:|---|
| `runner/server.mjs` | 638 | socket server, supervisor, per-child spawn, 2 s op timeout, `PL_OOM` classification |
| `runner/child.mjs` | 127 | `node --permission` entry point per package, bound host channel |
| `runner/Dockerfile` | 41 | the runner image |
| `runner/package.json` | 11 | the runner image's manifest |
| `app/plugins/host.ts` | 262 | socket client, reconnect, 5 s per-op timeout, host-call answering |
| `test/runner-contain.test.ts` | 238 | R6: the container half (no netns, no fetch) |
| `test/runner-memory.test.ts` | 217 | M1–M4: the 384 MiB cgroup ceiling |
| `test/plugin-host.test.ts` | 616 | the runner-wired endpoint gate (P1–P7, E1–E6) |
| `test/plugin-composed.test.ts` | 328 | C1–C4: the two-container composed path |
| `test/plugin-capability.test.ts` | 354 | the **two-layer** capability gate — the premise §13.1a deletes |
| `test/fixtures/runner_client.mjs` | 76 | the fixture that spoke the frame protocol |
| **Total deleted** | **2,908** | |

`app/plugins/protocol.ts` (336 lines) was **renamed** to `app/plugins/manifest.ts`, not dropped: §13.3.9
says the file keeps the manifest grammar and loses the frame types, and it had already lost them. The name
`protocol.ts` in a tree with no protocol is an invitation to build one, so the name went with the wire.
Fourteen import sites were updated (`app/plugins/{install,trust,ops}.ts`, `app/export/index.ts`,
`tools/plugin_sign.ts`, three tests).

`docker-compose.yml`: the `plugin-runner` service is gone (34 lines), `app`'s `/srv/run` volume is gone
with the socket, and the comment that explained the `SKW_APP_IMAGE` escape hatch no longer cites a second
service. Three services: `nginx`, `app`, `acme`.

`app/main.ts`: the socket binding, `plugins.connect()`, `plugins.list()` and `plugins.close()` are gone.
Step 6 of §2.3 now **loads the plugins the rows say are enabled** and prints
`plugins: in-process, N package(s) activated`.

`test/first-boot-tls.test.ts`: the composed gate no longer injects a `plugin-runner` override and no longer
builds `skw-runner:s4e` — it was the last thing in the tree still asking for an image that no longer exists,
and it failed with `unable to prepare context: path "runner" not found` until fixed.

**§16 S1's row** now reads: *"compose has exactly **3** services (`nginx`, `app`, `acme`), `plugin-runner`
is **absent by name**, and `app` publishes no port"*, and the gate is named. The test asserts the absence
explicitly (`services['plugin-runner'] === undefined`), not just a three-name list: a removal plus an
addition would keep the count at 3 and the list comparison would still say three.

---

## 2. Item 2 — the in-process loader, the registry, the twelve hooks, the facade

Five modules, ~1,700 lines of source, all new except `endpoint.ts` (rewritten) and `manifest.ts` (renamed):

| File | Lines | §13.3 |
|---|---:|---|
| `app/plugins/manifest.ts` | 423 | the manifest grammar + `main` + `hooks` + the twelve hook names |
| `app/plugins/runtime.ts` | 578 | §13.3.2 load path, §13.3.8 lifecycle, the failure model |
| `app/plugins/context.ts` | 354 | §13.3.5 per-request facade and §13.3.7's one check |
| `app/plugins/registry.ts` | 304 | §13.3.3 per-tenant, prunable, snapshotted, closed |
| `app/plugins/hooks.ts` | 298 | §13.3.4 twelve hooks, five rules, the timeout that says what it cannot do |
| `app/plugins/revocation.ts` | 165 | §8.5's two sources, read at install **and** at enable |
| `app/plugins/endpoint.ts` | 132 | the in-process endpoint route |

### §13.3.2 — the load path, ten steps, each named in the source

`runtime.enable()` follows the spec's numbering: (1) row, refuse `failed` without an ack; (2) revocation,
both sources; (3) `root_hash` recomputed from disk, `SKW_E_PL_SIGNATURE` on a moved byte, plus the
detached signature when the package carries one; (4) the manifest's schema range against the tenant,
`SKW_E_PL_SCHEMA`; (5) `realpath(main)` under the package root, `SKW_E_PL_LOAD`; (6) `import()` with
`?tenant=…&act=<n>`; (7) `typeof activate === 'function'`, `SKW_E_PL_LOAD`; (8) `activate(ctx)` with a
recorder that closes; (9) `closeActivation()` then `registry.commit()`; (10) `enabled=1`, counter + 1,
audit row.

**The cache-buster** is a process-wide monotonic counter per (tenant, plugin), and *process-wide is
deliberate*: Node's ESM cache is process-scoped, so a counter that reset with a new registry would hand
the next activation the same URL and get the cached namespace back. A gate that built two runtimes in one
process found exactly that (`L9` failed with `act=2` until `SEQUENCES` moved out of the class). The
tenant is in the URL for the reason §13.3.2 gives — one module instance per (tenant, plugin, activation),
so module-level state cannot carry a value between tenants by accident.

### §13.3.3 — the registry

`Map<tenant, Map<plugin, {hooks, endpoints, screens, activationSeq}>>`, with the four properties the spec
requires and a test each: per tenant (`L1` asserts `describe('beta')` is empty while acme has the plugin),
prunable (`disable` is `map.delete`; `L8` asserts `hooksFor` is empty afterwards), snapshotted
(`snapshot()` freezes a fresh array per hook), and closed to registration (`ActivationRecorder.on()`
throws `SKW_E_PL_REJECTED` once `closeActivation()` ran).

### §13.3.4 — the twelve hooks

Six filters and six actions in `manifest.ts`, frozen, with `hookKind()` returning `null` for anything
else. `ctx.on()` refuses a name outside the twelve **and** a hook the manifest did not declare (`L4`, by
name: `"route.resolve" is not one of the twelve hooks (§13.3.4)`). The five rules are each a branch in
`dispatchFilter`: only the named value, `undefined`/`null` = no change, wrong type = failure + original,
throw caught + original, registration order with a re-entrancy guard. `asset.url` additionally requires
root-relative or `https://` absolute (`acceptedAssetUrl`), per its row.

**Wired call sites.** `content.render.html` runs inside the render call in `app/main.ts` (`serveNotFound`,
where the page body is assembled) and `page.rendered` runs as an action after the response is written.
**Not yet wired:** `page.head` (needs the shell to accept a head fragment), `form.validate`,
`form.submitted`, `admin.menu`, `mail.template`, `asset.url`, `download.redeemed`, `admin.login`. The
dispatch primitive is built and tested for all twelve; the remaining call sites are item 7 of §7 below,
not a claim of completion.

### §13.3.5 — the per-request facade

Built by `makePluginContext()` per request, frozen, closing over a tenant-bound connection and a `closed`
flag. It has **no** `Database`, no control handle, no path and no `process.env`. The mode decides which
methods exist: `render` and `activation` get ten read methods; `endpoint` and `admin` add
`store.write`/`store.update`/`store.delete`/`settings.set`. In render those four keys are **absent**, not
disabled (`S4` asserts `'store.write' in facade === false`). A tenant argument is refused `SKW_E_PL_REJECTED`
and audited (`S2`, action `plugin.tenant_argument`). `ATTACH` is inexpressible — no method takes SQL — and
`PRAGMA database_list` is asserted to be exactly `main` before every operation; a second entry refuses and
carries `detail.disable_plugin = true` (`S5`). After `close()` every call is `SKW_E_PL_CONTEXT_ENDED` (`S6`).

---

## 3. Item 3 — the failure model

- **Load time.** Steps 2–9 of `enable()` are one `try/catch`. A package that throws at import, whose
  `activate` throws, or whose export shape is wrong is marked failed, `enabled=0`, an admin notice names
  the code and the plugin, and the registry never receives the hooks. `L2` asserts the refusal
  (`SKW_E_PL_LOAD`), the row, the notice, and that the *same runtime* then loads a good package.
- **Per request.** Every dispatch is `try/catch` plus `await Promise.race` against
  `SKW_PLUGIN_HOOK_TIMEOUT_MS` (default 2000). `L5` (a throwing filter) and `L6` (a wrong-type return)
  both assert the value passed in is what the page gets.
- **Three failures in 60 s** disable the plugin: registry pruned, `enabled=0`, notice
  (`"… failed 3 times in 60 s (last: content.render.html) and was disabled"`) — `L7`.
- **The accepted cost** is preserved verbatim as a block comment at the top of `app/plugins/hooks.ts` and
  again in §13.3.6 of the SDS, which was already amended. The code comment says the sentence the spec
  says: *"The synchronously hanging plugin cannot be timed out in-process. This is the accepted cost of the
  model and nothing in this design mitigates it at runtime."* Nothing in `hooks.ts` claims otherwise, and
  the `withTimeout` docstring says in one line what the race can and cannot interrupt.

---

## 4. Item 4 — the one-layer witness (mutation, red, restored)

**Mechanism:** `assertCapability()` in `app/plugins/context.ts`. **Witness:**
`test/plugin-scope.test.ts S3`, registered in the `WITNESSES` table (`mechanism: 'assertCapability'`), so
`test/witness.test.ts` W1–W5 hold the link in both directions.

**The mutation applied** — the exact edited expression:

```diff
-    if (!grant.includes(capability)) {
+    if (false) { // MUTATION S5: the capability comparison deleted
```

| | SHA-256 of `app/plugins/context.ts` |
|---|---|
| before | `311afe567890ff73eaf6568dbf5169bb02505e767dea078e73d3ff89189622f4` |
| mutated | `7208cf2d74b4a1b9f81d9fc26c7e4ed961cf29ac5d6253e6776acc12df8d2743` |
| after restore | `311afe567890ff73eaf6568dbf5169bb02505e767dea078e73d3ff89189622f4` — byte-identical |

**The gate that went red** (one test, and it names the table):

```
not ok 3 - S3. an undeclared capability is refused SKW_E_PL_REJECTED before p_notes_note is touched
  error: 'store.delete on p_notes_note was NOT refused: the capability comparison in
          app/plugins/context.ts is gone, and this package just deleted a row it was
          never granted (witness §13.1a)'
# tests 7 # pass 6 # fail 1
```

**The gates that stayed green** in the same mutated run: `S1` (tenant binding), `S2` (tenant argument
refused), `S4` (facade shape), `S5` (ATTACH/`database_list`), `S6` (`CONTEXT_ENDED`), `S7` (hook surface).
With the file restored: `# tests 7 # pass 7 # fail 0`.

That is §13.1a's replacement for the deleted second layer, and it is the mutation record §13.1a requires:
the edited expression, the gate that went red, the gates that stayed green, and the file's SHA-256 before
and after.

---

## 5. Item 5 — the retained-scope blockers, measured

### 5a. Revocation was a silent no-op — now a check at **install and enable**

**The defect, reproduced first.** Writing `data/trust/revoked.json` for a package root and installing that
exact root exited 0 and installed, because the install read `cms_plugin_revoked` only — and nothing but a
test ever wrote that table, so the file §8.5 names as the install's record had no reader at all.

**What was built.** `app/plugins/revocation.ts`: one reader of both sources (`revokedRoot`), one writer of
both (`revokeRoot`), the file in its own format (`skw-revoked/1`, 0600, tmp+rename). `install.inspectPackage`
step 2 now consults both, and `runtime.load()` step 2 consults both **at enable**, because under D36 enable
is when code starts running. `skwctl plugin revoke <id> [--root] [--reason]` writes the table (inside the
transaction) and the file, appends a `plugin.revoke` audit row recording both writes, and disables the
package if it was enabled — so a revoked package is stopped without an uninstall.

**Proof at INSTALL** (`test/plugin-revocation.test.ts V1`):

```
ok 1 - V1 — a root named only in data/trust/revoked.json is refused at install, by name and by source
```

`skwctl plugin install … --allow-unsigned` → **exit 1**, stderr carries `SKW_E_PL_REVOKED`,
`revoked on this install (file: …)`, and the package id; no `cms_plugin_installed` row is written. The
positive control is `V1b`: the same package with the same report installs once the file entry is gone, and
then a root inserted into `cms_plugin_revoked` refuses the install as well — neither source is decorative.

**Proof at ENABLE** (`V2`):

```
ok 3 - V2 — a root revoked after install is refused at ENABLE, without an uninstall
```

Install while trusted → write **only** the file → `runtime.enable()` throws `SKW_E_PL_REVOKED`, the message
names `notes` and `(file: …)`, the registry has no entry (the import never ran), and the row is `enabled=0`
while still installed. That is revocation without uninstall, which is the whole point under in-process
loading.

**The verb** (`V3`): `skwctl plugin revoke notes --tenant acme --reason 'S5 proof'` →
`plugin: revoked id=notes root=…`, `table=written file=written`; the file carries the root and the reason,
the table carries both, `cms_audit` holds `action='plugin.revoke'` with `table_written: true,
file_written: true`; a second revoke says `table=already present file=already present` (idempotent, no
rewritten timestamp); and the following `skwctl plugin enable notes` **exits 1** with `SKW_E_PL_REVOKED`
in the refusal.

### 5b. An unsigned package can no longer self-declare a publisher

**The defect.** `verifyPackageSignature()` returned `publisher: manifest.publisher?.id ?? 'unsigned'` for an
unsigned package, so a package that wrote `"publisher": {"id": "acme-labs"}` landed in
`cms_plugin_installed` and in the audit chain as `publisher=acme-labs` with a null fingerprint — a package
naming its own trustworthiness.

**The fix.** Unsigned is now a state, not a claim: `publisher: 'unsigned'`, `fingerprint: null`, and the
manifest's claim is quarantined in a new `claimed_publisher` field that the install screen shows **as a
rejected claim** beside `publisher: "unsigned"`. Nothing merges the two.

**The proof** (`V4`, on the `claimant` fixture — an unsigned package whose manifest says `acme-labs`):

```
ok 5 - V4 — an unsigned package cannot make itself a publisher; the claim is quarantined
```

— `inspectPackage`: `state='unsigned'`, `publisher='unsigned'`, `fingerprint=null`,
`claimed_publisher='acme-labs'`, `screen.publisher='unsigned'`;
— the row: `publisher='unsigned'`, `publisher_key_fingerprint=NULL`, `signature_state='unsigned'`;
— the audit row: `after_json.publisher === 'unsigned'` and `allow_unsigned === true`;
— structurally: `SELECT plugin_id FROM cms_plugin_installed WHERE signature_state='unsigned' AND
publisher <> 'unsigned'` returns **no rows** — the audit row cannot be made to say otherwise, because the
value it copies is the row's, and the row's is the literal `unsigned`.

### 5c. `SKW_E_PL_SCHEMA` had no HTTP mapping

**The defect, reproduced as a failing test first**:

```
not ok 5 - S5: every PL refusal that can reach a response is mapped — SKW_E_PL_SCHEMA included
  error: 'no HTTP mapping for SKW_E_PL_SCHEMA (schema/error-codes.json)'
```

which is the QA's `INTERNAL: no HTTP mapping` verbatim, raised from `new AppError('SKW_E_PL_SCHEMA', …)`.
The frozen taxonomy's own `areas.PL` list named 27 codes while the HTTP map carried 5; five of the six
missing ones were unreachable in the worst possible way — constructing the error threw.

**Mapped:** `SKW_E_PL_SCHEMA` 409, `SKW_E_PL_DESTRUCTIVE_UPGRADE` 409, `SKW_E_PL_REJECTED` 403,
`SKW_E_PL_BUSY` 409, `SKW_E_PL_LOAD` 500, `SKW_E_PL_CONTEXT_ENDED` 500 — in `app/errors.ts` and mirrored in
`schema/error-codes.json` (whose area list gains LOAD/BUSY/CONTEXT_ENDED). `SKW_E_PL_OOM` is **withdrawn**
from both, with the runner, and the test asserts its absence in all three places. The plugin-facing codes
(`ROW`, `QUERY`, `NO_TABLE`, `MAIL`) stay out of the map deliberately, and the test asserts that too:
they are thrown as plain `Error` to the plugin and never become an HTTP response.

`test/error-codes.test.ts` total moves 82 → 84 with the reason recorded at the assertion.

---

## 6. E-29's pointer — verified, and **not applied**

```
$ python3 scripts/model/check_frozen.py | tail -3
§16 S2 rows: 13/13; required strings: 5/5; pointers: 23/23
PASS the SDS quotes the register

$ grep -n "POINTERS" scripts/model/check_frozen.py
218:POINTERS = tuple(f"E-{n}" for n in range(1, 24))
```

E-29's item 5 asked for `range(1, 31)` and E-31's item 7 for `range(1, 34)`. **Neither has landed.** The
SDS carries pointer lines through E-23 only (plus E-31 at §3's path table and E-33 at §13.1a). Raising the
range without writing the E-24…E-33 pointer lines at the sections those errata amend would turn
`make verify-frozen` red — a gate made worse to look more complete — so the range is left alone and the
shortfall is reported here and in §7. **This is the honest reading of "verify": the item was checked, and
it is not applied.**

> **Superseded — see §9.3.** The E-24…E-33 pointer lines were written and `POINTERS` was raised to
> `range(1, 34)` in the S4-completion pass; `make verify-frozen` reports `pointers: 33/33`.

---

## 7. What remains before S4 can be GO

1. **The remaining seven hook call sites** (§2 above): `page.head` (needs a head-fragment local in the
   shell), `form.validate` + `form.submitted`, `admin.menu`, `mail.template`, `asset.url`,
   `download.redeemed`, `admin.login`. The dispatch primitive and its rules are built and tested for all
   twelve; the call sites are not, and no row of §16 S4 may be marked green on the strength of `content.
   render.html` alone.
2. **`activation_seq` as a column** (E-31 item 5). The counter lives in the process, which is sufficient
   for the ESM cache it guards and for L9; the migration onto `cms_plugin_installed` is owed, and the code
   comment says so rather than implying the column exists.
3. **E-29's pointer range and the E-24…E-33 pointer lines** (§6). Documentation, and gated by
   `make verify-frozen`.
4. **`§13.4` item 6's memory measurement** — one module instance per enabled (tenant, plugin) pair. Not
   measured here; the box was at load 65–72 and any number taken under it would be noise dressed as a
   budget.
5. **The admin notice has no screen.** `runtime.noticesFor(tenant)` exists and is asserted; nothing in the
   admin UI renders it yet, so "an admin notice names the code and the plugin" is true of the data and not
   yet of the product.
6. **`skwctl plugin enable` and the app's registry are reconciled lazily**, once per plugin request
   (`runtime.sync`). That is what makes enable/disable restart-free from the CLI, and it costs one SELECT
   per plugin request per tenant — measured only as "it runs", not as a budget.
7. **The remaining S4 rows that this pass did not touch** — the editor, export and install rows of §16 S4
   are unchanged and were green before it; this report claims nothing about them.

> **Items 1, 2, 3 and 5 of this list are closed in §9**, and item 4 (the memory measurement) is measured
> there. Item 6's SELECT is now a stated budget with a measured number (§9.5).

---

## 8. The commands this report rests on

| What | Command | Result |
|---|---|---|
| the whole gate | `hermes verify --json` | **`ok: true`** — bootstrap, build, typecheck, `npm run test`, `make test`, and readiness `200`; 554/554 tests in 166.1 s |
| the whole gate, standalone | `make test` | **exit 0**; 554/554 tests, 27/27 claims, frozen PASS, dist 6/6; 191.78 s at load 67.32 (and 191.86 s at load 71.76 on the first green run) |
| the runner gone | `node --test test/compose.test.ts` | 7/7 (was red at 6/7 before `docker-compose.yml` changed) |
| the loader | `node --test test/plugin-load.test.ts` | 10/10 (L1–L10) |
| the scope gate | `node --test test/plugin-scope.test.ts` | 7/7 (S1–S7), and 6/7 under the §4 mutation |
| revocation + audit | `node --test test/plugin-revocation.test.ts` | 5/5 (V1, V1b, V2, V3, V4) |
| the witness table | `node --test test/witness.test.ts` | 5/5 (W1–W5, incl. the new `assertCapability` row) |
| the taxonomy | `node --test test/error-codes.test.ts` | 8/8 |
| the artefact | `make build && make verify-dist` | 6/6 — the dist tree imports a plugin too |

**Flakiness, stated rather than smoothed.** Four `make test` runs were made. Two were green end to end
(554/554 at load 71.76 and at 67.32). In two others the only failure was one file's 40 s timeout —
`test/export-resilience.test.ts` once (`error: 'test timed out after 40000ms'`, 549/550 collected, load
43.9) and, in a separate run, the HTTP sampler `test/nginx-media-e2e.test.ts N3`
(`'the sampler never saw the old URL'`, load 56.3). Each passes 5/5 when run alone, immediately before and
after. Both are load artefacts of an HTTP sampler and a child-process-spawning suite on a box at load 44–72;
neither touches the plugin model, and neither was skipped, weakened or re-run until green inside a single
`make test` invocation. The two green runs are the numbers quoted above.

---

## 9. S4-completion pass — the call sites, the counter, the pointer lines, the screen

**Date:** 2026-10-21, second pass. **Result: 5 of 5 items done.** `make test` exits **0** at
**575/575 node tests, 27/27 claims, frozen PASS (`pointers: 33/33`), `verify-dist` 6/6**; the node
suite reports **148.25 s**, the whole gate ~3 min, at **load average 14.10 (1 min) at the start and
29.37 (5 min 30.51) at the end** — every timing number below is quoted with the load beside it.
Nothing was committed. Three new test files (**21 cases**: H1–H12, A1–A4, N1–N4/N3b), one child
helper and two fixture packages are added; no gate was weakened, no test was skipped, and
`SKW_ALLOW_SKIP` was never set.

The one sentence that matters: **all twelve hooks now have a call site, and each one is proved to
fire with the arguments §13.3.4 names and to change the value the host was about to use.** The
dispatch primitive existed before this pass; what did not exist was the product calling it.

### 9.1 Item 1 — the ten host call sites of the twelve hooks

`app/plugins/site.ts` is new: one attach point (`attachPluginRuntime`, called by `buildApp` after
step 6) and two functions, `filterSite` / `actionSite`, that every host module uses. A filter with no
callbacks is **not a dispatch** — the value passes through with no snapshot, no counter and no
allocation — which `H12` proves by detaching the runtime mid-flight and re-rendering the page.

| Hook | Kind | Call site (file: what it does there) | Case |
|---|---|---|---|
| `content.render.html` | filter | `app/main.ts` `serveNotFound` — replaces `page.bodyHtml` | H2 |
| `page.head` | filter | `app/main.ts` `serveNotFound` → `head` local → `app/render/pages/*.astro` → `shells/page.astro` `<head>` | H1 |
| `asset.url` | filter | `app/main.ts` `serveNotFound` pre-pass (`assetUrlsIn`) → `editor/render.ts` `urlFor` → `render/body.ts` → emitted `src`/`href` | H3 |
| `form.validate` | filter | `app/forms/intake.ts` `submitCoreForm` — core's verdict is the value it may only worsen (`coreRefused`) | H4 |
| `form.submitted` | action | `app/forms/intake.ts` — after the `cms_form_submission` insert, with the row id | H5 |
| `admin.menu` | filter | `app/admin/routes.ts` `#tenantHome` — core's items in, a declared screen's entry out | H6 |
| `mail.template` | filter | `app/plugins/context.ts` `facade['mail.send']` — the host's only mail path, before `hostOp('mail.send')` | H7 |
| `download.redeemed` | action | `app/download/plane.ts` `redeem` — after the code verified, before the 303 | H8 |
| `admin.login` | action | `app/admin/routes.ts` `#login` — after authentication, `{tenant, operatorId}` | H9 |
| `page.rendered` | action | `app/main.ts` `serveNotFound` — after the response is written, `{path, status, ms}` | H10 |
| `plugin.enabled` | action | `app/plugins/runtime.ts` `load` step 10 — after `registry.commit` and the row update | H11 |
| `plugin.disabled` | action | `app/plugins/runtime.ts` `disable` — before the prune, on the callbacks it had | H11 |

**Two things had to be built to have a real call site, and both are product, not harness:**

1. **Core form intake** (`app/forms/intake.ts`, `POST /f/<key>`). §8.6/O-30 specified it and nothing
   in the tree implemented it, so `form.validate`/`form.submitted` had nowhere to run. The route is
   O-30's contract in O-30's order: 16 KiB cap, 5 per 10 min per hashed address, intent token
   `_pt` (HMAC over `tenant|form|ts`, 30 min, 1.5 s minimum fill), honeypot `_hp` → `202` with **no
   row and no hook**, core's rules first, then the filter, then the row, then the action.
2. **`page.head` needed a shell that accepts a head fragment.** `shells/page.astro` gained an
   optional `head` prop rendered **inside `<head>` and nowhere else**; the filter has no parameter
   for the body, the status or a header, and the 4 KiB cap is enforced by the bus (`page.head` →
   `bad_value` above the limit). The fragment is emitted adjacent to `</title>` on the same source
   line: a new line would have changed the served bytes for **every** page on a box with no plugin,
   which `export-targets.test.ts` T1/T2 caught (it compares the static tree to the served page byte
   for byte). That failure is recorded here because it is the reason the shell looks odd.

**The fixture** (`test/fixtures/plugins/hooksall`: twelve declared hooks, one table, one screen)
appends a JSONL trace line per dispatch and returns a value visibly different from the one it was
handed. `H7` is the return-value witness that a hook's *effect* cannot be faked: the fixture pads
the vars object it returns when it sees `pad: 'yes'`, and the host's own 32 KiB measure refuses the
send (`SKW_E_PL_MAIL: vars exceed 32 KiB`) — the same call without the pad is `{queued: true}`.

**One rule was wrong, and the gate found it.** `H6` failed with core's entire menu missing: the
`admin.menu` filter in `hooks.ts` kept **only** entries matching a declared screen, so the first
plugin to implement the hook deleted the operator's navigation. §13.3.4's row says an entry
"pointing anywhere else is dropped" — it does not say core's own entries have to be justified by the
filter. The rule now applies to what the filter **added** (identity by handed-in href), and core's
items survive; `H6` asserts both halves (a declared screen is kept, an undeclared href is dropped,
`/pages` is still there).

### 9.2 Item 2 — `activation_seq` as a column (E-31 item 5)

The counter was process-wide. Inside one process that is the whole of the ESM cache story, and L9
still proves it; **across a restart it was a guess**, because a new process starts at zero, hands
`import()` the URL the previous process used, and gets the namespace that process already
evaluated.

- `schema/site.sql` at **v4** (`scripts/model/gen_schema.py`, `SCHEMA_VERSION = 4`):
  `activation_seq INTEGER NOT NULL DEFAULT 0 CHECK(activation_seq >= 0)` on
  `cms_plugin_installed`, and `tenant.db_version` now defaults to 4.
- `schema/r4-amendments.sql`: one `ALTER TABLE … ADD COLUMN`, `PRAGMA user_version = 4`, applied
  outside a table rebuild. Wired into `app/db/migrate.ts` as the `at === 3` step.
- `runtime.enable` reads the row, asks `registry.nextActivation(tenant, id, floor)` for
  `max(process, row) + 1`, and step 10 writes that number back in the same statement that sets
  `enabled = 1`. The URL, the entry and the row cannot disagree, and a refused enable consumes the
  number (the notices gate `N3` asserts that: the retry after a revocation is activation 2, not 1) —
  a counter that re-issued a URL the cache had seen would be the failure it exists to prevent.
- `verify_claims.py` check 20 now runs the chain **v1 → r2 → r3 → r4** and asserts convergence on
  the v4 DDL (27/27 claims green); `test/migrate.test.ts` targets v4; `scripts/dist-gate.mjs` D4
  compares the migrated file against `schema/site.sql`'s own `user_version` instead of a literal 3,
  so the next bump cannot read as a build failure; `docs/sds/01-verification.md` and SDS §4/§17's
  column counts move 297 → **298** and 228 → **229**.

**The restart proof is two OS processes, not a simulation** (`test/plugin-activation-seq.test.ts`):
the fixture package reads the `?act=` its own `import.meta.url` carried and returns it through
`page.head`, so the number in the URL and the number the module saw are the same observation.

```
A1  the DDL carries activation_seq, DEFAULT 0, NOT NULL; user_version = 4
A2  enable -> entry 1, module saw act=1, row 1; disable -> enable -> entry 2, act=2, row 2
A3  child process #1: entry 3, head <!--act:3-->, row 3
    child process #2: entry 4, head <!--act:4-->, row 4
A4  a v3 file (column dropped, user_version 3) migrates to v4, keeps its row, activation_seq = 0
```

### 9.3 Item 3 — the missing pointer lines (E-29's range, E-24…E-33)

Four passes reported this and left it. It is closed: each erratum now has a pointer line at the
section it amends, and only then was the range raised.

| Erratum | Pointer line at |
|---|---|
| E-24 | §6.2 (the `query` grammar) |
| E-25, E-28 | §16 (delivery slices — the gate set and the test-timeout row) |
| E-26 | §7.4 (the token) |
| E-27 | §7.5 (watermarking) |
| E-29 | §12.5 (TLS) |
| E-30 | §8.4 (containment) |
| E-31 | §3 (already) and §13.3 |
| E-32 | §8.6, §13.3, §15.2 |
| E-33 | §13.1a (already) |

`scripts/model/check_frozen.py`: `POINTERS = tuple(f"E-{n}" for n in range(1, 34))`, with the mapping
in a comment so the next reader knows where each line is. Output:

```
$ python3 scripts/model/check_frozen.py | tail -3
§16 S2 rows: 13/13; required strings: 5/5; pointers: 33/33

PASS the SDS quotes the register
```

### 9.4 Item 4 — the runtime-notice screen

`GET /admin/t/<key>/plugins` (and the tenant home's `Plugins (N)` entry) renders what
`runtime.noticesFor(tenant)` and the rows actually say:

- **Notices** — plugin, code, message, when. Populated by a failed load, a three-in-60-s
  auto-disable, and a revocation refusal.
- **Loaded now** — the registry's entries with their `activation_seq` and hook list.
- **Installed** — the rows with `enabled`, `activation_seq`, and a state that distinguishes
  `enabled, loaded` from `enabled, NOT loaded — failed since boot`.
- **Re-enable** — a `POST /admin/t/<key>/plugins/enable` form per package that is not running,
  session CSRF in a hidden field and the `Origin` check in front of it, calling
  `runtime.enable(tenant, id, { ackFailed: true })` (the operator's acknowledgement is the one thing
  §13.3.6 requires before a `failed` row is retried) and redirecting with a flash that names the
  activation number.

**A second defect surfaced while building it**: the notice's `code` was `SKW_E_PL_LOAD` for *every*
load-time refusal, because `runtime.load` parsed the code out of the error **message** and an
`AppError`'s message is prose. A revocation and a broken module were indistinguishable on the screen
an operator acts on. `err instanceof AppError ? err.code : code(message)` fixes it, and `N1` asserts
`SKW_E_PL_LOAD` for `badshape` **and** `SKW_E_PL_REVOKED` with the revocation reason for `actseq`.

Proof (`test/admin-plugin-notices.test.ts`, 5/5):

```
N1  data-notice="badshape" + SKW_E_PL_LOAD + "does not export activate"
    data-notice="actseq"  + SKW_E_PL_REVOKED + "S5 notices gate"
N2  two POST forms, name="plugin", name="csrf" = the session's token
N4  the tenant home nav reads Plugins (2)
N3  un-revoke (both sources) -> submit the form -> 303 + "actseq enabled (activation 2, hooks: page.head)"
    -> screen says "enabled, loaded" -> GET /pricing carries <!--act:2-->
N3b no CSRF token -> 403 SKW_E_SEC_CSRF (the field is not a bypass)
```

`#assertCsrf` now also accepts the `csrf` **body field**, because a JS-free HTML form cannot set
`X-CSRF-Token` and the admin surface has no JavaScript by design. The token is still the session's
own HMAC and `#assertOrigin` still runs first; `N3b` is the negative control.

### 9.5 Item 5 — the two numbers §13.4 asked for

`scripts/measure/plugin-budget.ts` (a measurement tool, deliberately **not** in `make test`), run
three times at load **8.74 (1 min) / 23.3 (5 min)**:

```
instances 12   heap per module instance (median) 25,504 B   (25 KiB; total heap delta 397,928 B)
rss delta total 950,272 B      sync() 730.6–767.3 us/call      enabled-rows SELECT 3.0 us/call
```

- **§13.4 item 6:** one module instance per enabled (tenant, plugin) pair costs **≈25 KiB of heap**
  for the reference package (12 tenants, forced GC, delta across the eleventh activation).
  That is the number the spec asked to measure instead of assume.
- **`runtime.sync`'s one SELECT per plugin request** is now a stated budget: **≈0.75 ms per
  plugin-bearing request** at load 8.74, of which the SELECT is **3.0 µs**. The remaining 99.6% is
  `openAdminWrite()` — a fresh SQLite connection per call. That is the budget as it stands, and it
  is the obvious next optimisation (a per-tenant cached handle); it is named in §9.6 rather than
  done here, because a connection-lifetime change under a green gate on a loaded box is a change
  that deserves its own failing test first.

### 9.6 What remains before S4 can be GO

1. **`runtime.sync` pays for a connection per request** (~0.75 ms, 3 µs of it the query — §9.5). A
   stated cost, not a hidden one, and the one performance item this pass leaves open.
2. **The core form intake has no renderer.** `POST /f/<key>` is real, rate-limited, token-checked
   and hook-wired, but nothing generates the markup that embeds `_pt` — the component registry
   declares `components/form.ts` and that file has never existed (it predates this pass). Until it
   does, a core form is authored by hand and must carry a minted token.
3. **`plugin.enabled`/`plugin.disabled` payloads are `{tenant}`** (plus `plugin` on disable) exactly
   as §13.3.4's table says; nothing dispatches `page.head` for a *preview* render distinct from a
   public one, which the spec does not ask for and this pass did not invent.
4. **The §16 S4 rows this pass did not touch** — the editor, export and install rows — are unchanged
   and were green before it; this report claims nothing new about them.
5. **Nothing is committed.** The tree carries the work; the branch is the caller's to review.

### 9.7 The commands this section rests on

| What | Command | Result |
|---|---|---|
| the whole gate | `make test` | **exit 0** — 575/575 tests, 148.25 s node suite, 27/27 claims, `pointers: 33/33`, dist 6/6; load 14.10 → 29.37 |
| the whole gate, recorded | `hermes verify --json` | **`ok: true`** — bootstrap, build, typecheck, `npm run test` (575/575, 152.7 s), `make test` (exit 0, dist 6/6), `make typecheck`, `make build`, readiness `200` on `http://127.0.0.1:4321/`; load 37.36 at the end |
| the hook call sites | `node --test test/plugin-hooks-wired.test.ts` | 12/12 (H1–H12) |
| the counter, across processes | `node --test test/plugin-activation-seq.test.ts` | 4/4 (A1–A4) |
| the notices screen | `node --test test/admin-plugin-notices.test.ts` | 5/5 (N1–N4, N3b) |
| the pointer lines | `python3 scripts/model/check_frozen.py` | `pointers: 33/33`, PASS |
| the schema chain | `python3 scripts/model/verify_claims.py` | 27/27, check 20 now v1→v4 |
| the built artefact | `make build && make verify-dist` | 6/6, D4 at `user_version 4` |
| the budget | `node --expose-gc scripts/measure/plugin-budget.ts` | 25 KiB/instance; sync 0.75 ms, SELECT 3.0 µs |

---

## 10. S5 closeout pass — the sampler class, the per-tenant handle, and the form component

**Date:** 2026-10-21. **Trigger:** a QA run that reported 575/575 and then measured **574/575, EXIT 2** on
`test/nginx-media-e2e.test.ts:302` (N3) at load **22–34**, failing on `the sampler never saw the old URL`.
That assertion was true by luck, not by construction: it depended on a child process finishing its *boot*
inside a 150 ms sleep. **Result: all four items done.** `make test` is 583/583 in two of three consecutive
runs; the third lost one pre-existing file to the 40 s per-file budget and **no assertion failed in any
run** (§10.5).

### 10.1 N3 — the assertion was about node's boot time, not about the rename

The sampler is a second process issuing real requests to the real edge while the test process renames.
The old test slept 150 ms and then called `renameAsset`, and asserted `sawOld > 0`. Node's boot is ~110 ms
on this box, so the margin was the difference between two numbers that both move:

| the same file, before the fix | 1-min load | samples | `sawOld` |
|---|---|---|---|
| measured here | 12.30 | 976 | 32 (3.3% of samples) |
| measured here | 12.30 | 1235 | 96 (7.8%) |
| measured here | 12.30 | 663 | 53 (8.0%) |
| QA's failing run | 22–34 | — | **0** |

At load 12 the child usually won the race; at load 22–34 it never did. The assertion was a measurement of
how fast node starts under load, dressed as a statement about the rename's atomicity.

**The window is now a place the test holds open, not a duration it hopes to hit.** Two handshakes:

1. **`ready`.** The sampler prints `{"event":"ready"}` the first time the old URL resolves. The test waits
   for that line before it calls `renameAsset` — so `sawOld > 0` is true by construction before the rename
   exists, on any box.
2. **The hold.** `renameAsset` parks between "the new links exist" (step 1) and "the old links are removed"
   (step 3), test-only and gated on `SKW_RENAME_WINDOW_HOLD`, until the sampler has sampled **both** URLs
   resolving *n* times. It writes `window-open.json`, blocks, and the sampler writes `window-release`. So
   the samples `dead` counts are samples *of the window* and not of its two endpoints.

The release is never a timeout in the passing path, and it is written on three conditions only — the
property held (`window`), the property failed (`dead`, so the gate reports `dead > 0` instead of hanging),
or the harness itself is broken (`timeout`, which fails the gate and the barrier throws).

| the protocol line | what it means | who acts on it |
|---|---|---|
| `{"event":"ready","sawOld":≥1}` | the old URL resolved at least once | the test starts the rename |
| `{"event":"release","reason":"window"}` | both URLs resolved in ≥3 rounds inside the hold | `renameAsset` leaves the window |
| `{"event":"release","reason":"dead"}` | a round saw **neither** URL — the violation | `renameAsset` leaves, and the gate reddens |
| `{"event":"done",…}` | final counts: `samples`, `dead`, `sawOld`, `sawNew`, `windowSamples` | the assertions |

**What the gate asserts now**, in this order: the hold engaged at all (`window-open.json` exists);
`releaseReason === 'window'`; `dead === 0`; **`windowSamples >= 3`** (the anti-vacuous half — `dead === 0`
means nothing unless the samples were taken while both URLs were supposed to resolve); and `sawOld > 0` /
`sawNew > 0` as protocol checks. Nothing was weakened: `dead === 0` survives, and a new assertion was
added that the old test could not make.

**Why blocking is safe.** `/media/` is served by nginx from the farm directory and never proxies to the
app (that is what N1 proves by killing the app). The only thing that stops answering while the window is
open is the code that is waiting. The wait is `Atomics.wait` on a `SharedArrayBuffer` — a synchronous park,
so `renameAsset` keeps its synchronous signature for every caller, and the loop polls a file every 5 ms
for the few milliseconds the gate holds it.

**Red first, by injection.** `app/assets/library.ts` was edited to the wrong order — remove the old links
*before* the new ones exist, with the hold between them — and the gate was run twice. The file was then
restored and its **sha256 verified: `3a0169eed50250cfe677573db0074228b2d804743150f5603c30926886f0feb2`**.

| the broken rename | 1-min load | `dead` | `windowSamples` | `releaseReason` | the gate |
|---|---|---|---|---|---|
| old links removed before the new exist | 9.66 | **42** | 0 | `dead` | **red** — "released on `dead`, not because both URLs resolved" |
| the same, second run | 8.56 | **9** | 0 | `dead` | **red** — same assertion |

**Green, at the load that used to break it** (three consecutive runs of the file):

| run | 1-min load | samples | `dead` | `sawOld` | `windowSamples` | release |
|---|---|---|---|---|---|---|
| 1 | 24.86 | 4137 | 0 | 15 | 13 | `window` |
| 2 | 21.86 | 4744 | 0 | 11 | 8 | `window` |
| 3 | 20.67 | 4326 | 0 | 11 | 8 | `window` |

### 10.2 The class audit — four sites, not one

The class: **an assertion whose truth depends on a sampler or a retry counter happening to observe an
intermediate state.** Everything in `test/` that spawns a second process, polls, or counts an attempt was
read. Four sites were in the class; all four now hold the state open instead of racing it. Two others were
considered and are not in it, with the reason recorded.

| # | site | what it asserted, and what it really measured | what was done |
|---|---|---|---|
| 1 | `nginx-media-e2e` **N3** | `sawOld > 0` — the sampler's boot time | barrier (§10.1) |
| 2 | `farm.test` **F3** | the same, one layer down (no nginx): `sleep(120)` + `sawOld > 0`, plus **`samples > 200`** — a throughput floor (500 reads/s) inside a correctness gate | the same barrier; the throughput floor **removed**, replaced by `windowSamples >= 3`, which is deterministic and says more |
| 3 | `ddl-runner` **C3** | `B.lockAttempts >= 2` — "B had to retry", true only if B's first `BEGIN IMMEDIATE` landed inside A's 400 ms hold, with B started after a 120 ms sleep | barrier: A prints `holding` when the lock is held and holds until B proves collision (`signalOnBusy` creates `lock-release` on its first `SQLITE_BUSY`). A cannot commit before B collides |
| 4 | `ddl-runner` **C7** | `contended.waitedFor >= 1` — "the rebuild reported a wait", over five attempts with two writers on a 12 ms cycle | barrier: w1's first transaction holds the lock until the first rebuild's `BEGIN IMMEDIATE` collides (`holdFirstUntil`), and the assertion moved to that rebuild, not to the busiest of five |

Both barriers live in the helpers (`test/helpers/http-sampler.mjs`, `farm-sampler.mjs`, `ddl-child.ts`) and
in the one test-only, env-gated hook in `app/assets/library.ts`. The `ddl-child` side uses `runDdl`'s
`open` seam, which the code already documents as a test seam — no product code changed shape for it.

**Not this class, because:**

- **`pollFor` in `nginx-media-e2e` (N3's 301, N4's 404)** — it polls until the system reaches a *settled*
  end state and asserts that state. Load can only make it take longer, never make the answer different;
  the 4 s bound is a hang-detector, and a hang is a real failure.
- **`first-boot-tls` (cert issuance, 90 s internal deadline)** — end state, not an intermediate one. It is
  the file with the smallest margin against the suite's 40 s per-file budget, which is a different problem
  and is measured in §10.5.
- **`island-ua`** — waits for `DevToolsActivePort` and for `SIGKILL` to land; both are readiness/teardown,
  and its one retry loop relaxes no assertion.
- **`download-consume`** — parallel children, and it asserts `spent === 1`. That is a mutual-exclusion
  invariant that holds for **every** interleaving, so the schedule cannot change the answer.
- **`download-watermark`'s `queued_ms >= 30`** — a wall-clock number, but a *lower* bound produced by an
  injected 40 ms budget: load can only increase it, which is the opposite of the fragility this audit is
  for. Left where it is, because moving it to `test/perf` would remove the only assertion that the refusal
  reports the wait it claims.

### 10.3 `runtime.sync` — one connection per tenant, not per request

§9.5 measured `sync()` at **730.6–767.3 µs per call at load 8.74**, of which the `SELECT` was **3.0 µs**:
99.6% was `openAdminWrite()` — a fresh connection, per plugin-bearing request. The fix is a per-tenant
cached handle, and it was written test-first.

**Failing first.** The test (`test/plugin-sync-handle.test.ts`, S1–S4) counts connections through a
monotonic diagnostic added to `app/db/classes.ts` (`connectionCount()`), so the number is measured rather
than asserted. Against the pre-fix behaviour — restored by temporarily returning a fresh handle from
`syncHandle` — S1 fails with exactly the number in the brief:

```
not ok 1 - S1 — twenty syncs after the first open one connection, not twenty
  twenty syncs opened 20 connections (a per-request handle would open 20, ~0.75 ms each)
```

**The design.** A `render-read` handle per tenant (`openRenderRead`: `readonly` + `query_only=1`) — the
SELECT path cannot write — cached in the runtime and keyed on the **file's identity** (`dev:ino`), not on
the path, because a restore replaces the inode and a handle to the old one would answer with rows the site
no longer has. One `statSync` (~2 µs) per call is the price of not being wrong.

**The regression this found, and the fix.** The first version cached in `boot()` too, and that broke
`test/tenancy/resolve.test.ts`: an open handle — even a readonly one — holds a shared lock, and
`PRAGMA journal_mode = DELETE` needs an exclusive one. Measured directly: a WAL database with one readonly
connection open answers `SQLITE_BUSY`, and the flip succeeds the moment it closes. Boot is one pass over
every tenant before any request is served, so it has nothing to amortise: `boot()` now uses a transient
handle (`cache: false`) and only `sync()` caches. S4 keeps the constraint alive as an assertion, and
`discardSyncHandle(tenant)` exists for a caller about to change the file's journal mode or replace it.

| what | before | after | load |
|---|---|---|---|
| `runtime.sync`, end to end | 730.6–767.3 µs/call (§9.5) | **56.4 µs/call** (`plugin-budget.ts`) | 8.74 → **33.00** |
| connection open + SELECT + close, vs a cached call | 692.62 µs | 17.92 µs (**38.7×**) | 30.68 |
| the `SELECT` itself | 3.0 µs | 2.81 µs | — |
| connections opened by 20 syncs after the first | 20 | **0** (S1) | — |

The improvement is 13× *while being measured at four times the load* it was measured at before.

**Behaviour is unchanged**, and that is asserted rather than assumed: S2 writes a `cms_plugin_installed`
row through a *different* connection after the handle is cached, and the next `sync()` sees it, refuses to
activate the package (no bytes on disk), records the notice, and leaves `enabled = 0` — the cache is a
handle, not a snapshot. S3 replaces the file and asserts the handle is reopened.

### 10.4 The form component — `components/form.ts` exists, and a page can submit

`schema/component-registry.json` declared `components/form.ts` and the file had never been written, so the
`form` block the editor's palette offers rendered markup that posted to the page's own URL with no `_pt`,
which `submitCoreForm` refuses as `missing`. Every existing form gate minted the token itself (H4/H5 of
`plugin-hooks-wired.test.ts`), so the suite could not see it: they prove the *intake* works, not that
anything a page emits can satisfy it.

The renderer emits the intake's contract, from the intake's own functions:

| the intake checks | what the renderer emits |
|---|---|
| `action` = `POST /f/<key>` | `<form method="post" action="/f/<key>">` (`forward` mode keeps its declared `action_url`) |
| `_pt` = `HMAC(SKW_SESSION_KEY, tenant\|form\|ts)`, 30 min | `<input type="hidden" name="_pt" value="<ts>.<mac>">`, minted by `formIntentToken()` — the only minter in the tree |
| `_hp` non-empty → 202 and no row | `<input name="_hp" value="">` inside an `aria-hidden` wrapper placed out of the tab order |
| declared fields only, required, per-field max | one input per `fields_json` entry the markup lacks, with `required` and `maxlength` |

It is wired into **`renderStoredBody()`** — the one function the site and all three exporters share — so a
page cannot render a submittable form on the site and a token-less one in a bundle. The context is passed
only by the serve path (`app/main.ts`): the export path has no `SKW_SESSION_KEY`, and a token minted at
export time would be stale before a visitor loaded the bundle, so the form there carries
`data-form-intent="absent"`. Pages are served `cache-control: no-store`, so a rendered `_pt` is never
served from a cache older than its 30-minute TTL.

**Proof** (`test/form-component.test.ts`, G1–G4, 4/4): G1 takes the block from the registry — not from a
string in the test — and asserts the renderer file the entry names exists (the assertion that would have
been red for the life of the registry). G2 stores that block on a page, serves it, and asserts the action,
the method, `data-form-intent="minted"`, that the emitted `_pt` **verifies for `(acme, contact)`** and does
**not** verify for `(acme, newsletter)`, that `_hp` is empty, and that `message` — declared in
`fields_json`, absent from the registry markup — was rendered with `required` and `maxlength="200"`. G3
waits out O-30's 1.5 s minimum fill and POSTs the page's own fields and the page's own token to
`/f/contact`: **202 with an id, and a `cms_form_submission` row carrying the values and not the token**.
G4 is the negative control set: no `_pt` → 400 `token is missing`; the same token presented to
`/f/newsletter` → 400 `token is signature`; a filled `_hp` → **202 and no row**.

### 10.5 Stability across three consecutive runs

Three `make test` runs, back to back, nothing else started by this pass:

| run | load (start → end, 1 min) | node suite | result |
|---|---|---|---|
| A | 46.08 → 18.40 | 583/583, 158.87 s | **exit 0** — claims 27/27, frozen PASS, dist 6/6, no-leak clean |
| B | 8.90 → 36.40 | 582/583, one file timed out | **exit 2** — `test/first-boot-tls.test.ts` hit the 40 000 ms per-file budget; **0 assertion failures** |
| C | 26.44 → 48.10 | 583/583, 174.77 s | **exit 0** — as A |

A fourth full run, `hermes verify --json` (bootstrap → build → typecheck → `npm run test` → `make test` →
`make typecheck` → `make build` → readiness), returned **`ok: true`, exit 0**: `npm run test` **583/583 in
166.33 s**, `make test` **583/583 in 182.31 s** with `verify-dist` 6/6 and no-leak clean, and readiness `200`
on `http://127.0.0.1:4321/`; load 9.68 → 17.99. That is the run that records verification evidence for this
workspace.

So: **2 of 3 consecutive `make test` runs green, and no run failed an assertion; 4 of 4 full runs green on
the node suite.** Run B's single failure is the file budget, not
behaviour, and it is pre-existing rather than introduced here: `first-boot-tls.test.ts` was untouched by
this pass, and it takes **30.76 s alone at load 25.16** — 77% of its 40 s budget before any contention.
That file's fixed TLS waits are larger than the 4.4×-of-`ddl-runner` derivation behind `TEST_TIMEOUT_MS`,
which is why it is one of the two files §9.7 already recorded losing under load. `TEST_TIMEOUT_MS` was
**not** raised: widening a gate's budget is a decision for the pass that owns the gate, not a silent fix
inside this one, and the number it would need (≈60 s for 2× margin on the slowest file) is a change with
its own consequences for a hung test.

Every file this pass touched — `nginx-media-e2e`, `farm`, `ddl-runner`, `plugin-sync-handle`,
`form-component`, and `tenancy/resolve` — passed in all three runs.

### 10.6 The commands this section rests on

| What | Command | Result |
|---|---|---|
| the sampler gate, three runs at the load that used to break it | `node --test test/nginx-media-e2e.test.ts` | 5/5 ×3; `dead 0`, `windowSamples` 13/8/8, `release 'window'`; load 24.86 / 21.86 / 20.67 |
| the same gate with the rename order broken | edit `app/assets/library.ts`, run, restore | **red twice**: `dead 42` (load 9.66), `dead 9` (load 8.56); restored to sha256 `3a0169ee…0feb2` |
| the farm rename gate | `node --test test/farm.test.ts` | 5/5; `dead 0`, `windowSamples` ≥ 3 |
| the two DDL contention gates | `node --test test/ddl-runner.test.ts` | 18/18 (C3, C7 now barrier-held) |
| the connection budget | `node --expose-gc scripts/measure/plugin-budget.ts` | **sync 56.4 µs/call** at load 33.00 (was 730.6–767.3 at 8.74); SELECT 2.81 µs |
| the cached handle | `node --test test/plugin-sync-handle.test.ts` | 4/4 (S1–S4); 20 syncs → **0** connections; red at 20 before the fix |
| the form component | `node --test test/form-component.test.ts` | 4/4 (G1–G4); 202 + row from the page's own token; 3 refusals |
| the whole gate | `make test` | **exit 0** 583/583 in runs A and C; run B exit 2 on a per-file timeout only; loads in §10.5 |
| the file that lost run B, alone | `node --test test/first-boot-tls.test.ts` | 5/5 in **30.76 s** at load 25.16 — 77% of the 40 s budget |

## 11. `TEST_TIMEOUT_MS` — the constant that could not name its input

### 11.1 What rotted, and what the table found that the comment could not

S2 derived `TEST_TIMEOUT_MS = 40000` as 4.4× the then-worst idle file, `test/ddl-runner.test.ts` at 9.04 s. The derivation was a sentence in the `Makefile`: true when written, unreadable to any gate. `test/first-boot-tls.test.ts` then arrived at 30.76 s alone at load 25.16 — 77 % of 40 s — and §10.5's run B lost it at load 36.40 with **0 assertion failures**. Four slices of headroom were spent silently because no code compared the constant with the file set it was supposed to cover.

The table found a second fact the sentence could not see: `first-boot-tls` was not even the heaviest file. `test/export-resilience.test.ts` measured **34 199 ms** at load 8.94 in the first sweep, and it was not slow because exporting is slow. `test/helpers/full-disk.ts` forked `df` after every 4 KiB write while filling a 1 MB disk image, and the test leaked a mounted volume on the D1 path: **99 `/Volumes/skwfull*` mounts and 288 `skw-dmg-*` scratch directories** were attached on this box by the time it was measured. A measurement table found both in one pass; the comment had never looked.

### 11.2 The mechanism: a table, a gate, and a measurement command

| Piece | What it does |
|---|---|
| `test/perf-budgets.json` | 73 rows, one per non-perf test file: `worstIdleMs`, `measuredOn`, `load1m`, `box`, `sha256`, and the `runs` behind the worst value. "Idle" is the preflight's own definition: the run **started** at a 1-minute load ≤ the CPU count. Loaded runs are recorded and excluded; a file with no idle run has no `worstIdleMs` and cannot set the budget. |
| `test/timeout-budget.test.ts` | B1 row integrity; B2 completeness (every non-perf test file has a row, so a new file cannot enter the suite unmeasured) and hash freshness for every row ≥ 3 s and for the largest row; B3 `TEST_TIMEOUT_MS` exactly `ceil(4 × max / 1000) × 1000`, both in the Makefile **and** in the value the runner exported (`SKW_TEST_TIMEOUT_MS`); B4 in-suite negative controls (a raised row and a forged hash must both be red and name the file). |
| `scripts/measure/test-file-budgets.mjs` | Runs each file alone through the same `scripts/run-node-tests.mjs`, waits for an idle window, records before/after load on every run, keeps the worst idle run, and rewrites the table. |

The gate reads the **effective** budget, not only the Makefile: `scripts/run-node-tests.mjs` now exports `SKW_TEST_TIMEOUT_MS`, so `make test TEST_TIMEOUT_MS=…` cannot lower or raise the constant without a named red test. A row at or above 3 s is tied to its file's sha256 — edit a heavy test and the gate names it and asks for a re-measurement instead of comparing today's budget to yesterday's bytes.

**Failing test first.** With no table, all four gate tests were red; the first was `'/…/test/perf-budgets.json does not exist: TEST_TIMEOUT_MS has no recorded input'` (`scratch/evidence-missing-table.log`).

### 11.3 The measurements

Every number was taken one file at a time, `--test-concurrency=1`, on this box: `cyberdeth.za.net`, macOS 15.7.4 arm64, **8 cpus**, 16 GiB, Node v22.23.1, Docker 29.7.2 (4-cpu / 1.5 GiB VM), 2026-10-21 between 10:36 and 11:04 AEDT. `load1m` is the 1-minute average when the run that produced `worstIdleMs` started.

| worst idle ms | load1m | measured | file |
|---:|---:|---|---|
| **31 273** | 7.32 | 2026-10-21 | `test/first-boot-tls.test.ts` |
| 9 025 | 7.79 | 2026-10-21 | `test/ddl-runner.test.ts` |
| 8 639 | 7.70 | 2026-10-21 | `test/nginx-e2e.test.ts` |
| 7 263 | 5.28 | 2026-10-21 | `test/install-bundle.test.ts` |
| 7 129 | 7.98 | 2026-10-21 | `test/export-resilience.test.ts` |
| 7 035 | 7.15 | 2026-10-21 | `test/nginx-media-e2e.test.ts` |
| 6 008 | 7.91 | 2026-10-21 | `test/env.test.ts` |
| 5 788 | 7.66 | 2026-10-21 | `test/download-redeem.test.ts` |
| 5 028 | 7.89 | 2026-10-21 | `test/download-consume.test.ts` |
| 4 875 | 8.00 | 2026-10-21 | `test/install.test.ts` |
| 4 364 | 7.60 | 2026-10-21 | `test/download-watermark.test.ts` |
| 3 956 | 6.34 | 2026-10-21 | `test/island-ua.test.ts` |

The full set is `test/perf-budgets.json` (73 files; the suite is 587 tests). `test/nginx-gated-e2e.test.ts` is 2 159 ms at load 7.15; `test/farm.test.ts` 3 357 ms at 7.32.

**Where `first-boot-tls`'s 26–31 s goes.** The file now prints its own phase line on every run. This is one full run at load 5.86 → 6.05, `total=25 672 ms` (wall 25 931 ms), 5/5:

| phase | ms | share |
|---|---:|---:|
| ACME: Pebble start + `acme` recreate + issuance to `issued` | 12 480 | 48.6 % |
| Docker lifecycle: image build + `compose up -d` + nginx's first TLS answer + `compose down -v` | 6 816 | 26.5 % |
| setup: `tsc` + `install.sh` + fixture/export | 4 034 | 15.7 % |
| served-response checks: app 200, `nginx -s HUP` + new cert | 1 383 | 5.4 % |
| unaccounted (T1/T2/T4 bodies, module load) | 951 | 3.7 % |

The narrowest reading of "container startup" — `compose up -d` returning plus nginx's first TLS answer — is **1 466 ms, 5.7 %**. Teardown alone is 4 363 ms. The 30 s is a real three-service install, a real Pebble ACME round trip (8 549 ms in issuance alone) and a real teardown, not a container-start stall. **The fix for this file is the budget**, and the phase line is the evidence a future reader needs to re-derive it. No test-design change could remove 20 s without removing what T1–T5 assert.

**The test-design fix was `export-resilience`, where the cost was waste.** `statfsSync` replaces the `df` fork per 4 KiB write; D1/D5 detach their own volumes in `finally` (the module-level `volume` variable meant D1's mount was overwritten by D2's and never detached); `detach()` removes its `mkdtemp` directory. Measured: **34 199 ms → 7 129 ms** (79 % less), 5/5 both before and after, and the run now leaves **0** mounts and **0** scratch dirs.

### 11.4 Negative controls

1. **A row below the measurement, constant untouched.** `first-boot-tls`'s `worstIdleMs` 31 273 → 5 000 while the Makefile stayed at 126 000. The gate went red and named the file and its real value: `test/first-boot-tls.test.ts: worstIdleMs 5000 is not the maximum of its idle runs (31273)`. B2/B3 additionally named `test/nginx-e2e.test.ts` as the new heaviest and the constant as "above the derived value" (`scratch/evidence-budget-red.log`). Restored.
2. **An understated row and a budget derived from it.** Row 5 000, `TEST_TIMEOUT_MS=20000` (4 × 5 000, so the table and the constant agree), then the file itself: `not ok 1 - test/first-boot-tls.test.ts`, `error: 'test timed out after 20000ms'`, `# cancelled 1`, the runner banner `CANCELLED TESTS — THIS RUN IS NOT A GATE (1 cancelled)`, exit 1 (`scratch/neg-control-timeout.log`). This is the original failure reproduced: an understated table does not merely look wrong, it loses the run.
3. **The effective budget, not the Makefile.** Runner `--timeout=125000` (1 s below the derivation), Makefile unchanged: B2/B3 red with `the budget in force is 125000 ms, below the derived floor of 126000 ms = 4 × 31273 ms, the worst idle run of test/first-boot-tls.test.ts … That file sets the budget.` (`scratch/evidence-effective-budget.log`).
4. **In-suite controls.** B4 runs on every gate invocation: a heaviest row raised to 125 092 ms and a forged sha256 on that row both produce red, named failures. A checker that cannot fail is not a checker.
5. **A new file the table has never seen.** A probe `test/zz-unmeasured-probe.test.ts` was added and the gate run: red, `these test files have no row in test/perf-budgets.json, so TEST_TIMEOUT_MS cannot see them: test/zz-unmeasured-probe.test.ts — measure them with "node scripts/measure/test-file-budgets.mjs --files test/zz-unmeasured-probe.test.ts"` (`scratch/evidence-completeness.log`). The probe was removed; the gate is green. This is the control for the actual rot: a heavier file appearing and no number moving.

### 11.5 Re-derivation and stability

`ceil(4 × 31 273 / 1000) × 1000 = 126 000`. The Makefile carries the file, the measurement, the load, the date and the old derivation beside the number.

Three consecutive `make test` runs, back to back, nothing else started by this pass:

| run | load (start → end, 1 min) | node suite | result |
|---|---|---|---|
| 1 | 5.83 → 7.86 | 587/587, 155.72 s | **exit 0** — claims 27/27, frozen PASS, dist 6/6, no-leak clean |
| 2 | 7.86 → 13.16 | 587/587, 157.21 s | **exit 0** — as run 1 |
| 3 | 13.16 → 8.01 | 587/587, 157.43 s | **exit 0** — as run 1 |

An earlier sequence is worth recording because it found two failures that were not the budget. Run 1 was green (587/587, 145.27 s, load 5.91 → 5.84). Run 2 lost **T5** at 94.6 s: `400 JWS has an invalid anti-replay nonce`, a pre-existing Pebble/ACME flake that the old 40 s budget would have hidden as a cancel; it occurred once in eight `first-boot-tls` runs measured today, and 3/3 standalone runs after it were green. Run 3 lost **C6 in `ddl-runner`**: the test sealed the hard-coded day `2026-10-20` at the hard-coded instant `2026-10-21T00:00:05Z` while its audit rows were stamped by the real clock. At 11:03 AEDT (00:03Z) the rows were no longer on 2026-10-20, the segment was `empty`, and `verifyAgainstSeal` returned `empty` where the test expected `verified`. That failure was permanent from that minute on, not a flake: the day and the instant now come from one `now` (the rows are backdated to yesterday noon, the seal is on-time), and `ddl-runner` is 18/18 in 9.0 s. The three runs in the table above were taken after both findings, and after the gate's completeness check was added.

### 11.6 What this changes, and what it costs

- A hung unit test now takes up to 126 s to fail instead of 40 s. That is the price of one constant covering the heaviest file. Per-file budgets would keep 40 s for the other 72 files, but node has one `--test-timeout` per invocation and E-8 wants one runner invocation with one summary; the table makes the trade visible instead of implicit.
- `docs/sds/02-errata.md`'s S2 amendment still says `40 000 ms today`. It is the record of that amendment, not a live claim; the live derivation is `Makefile` + `test/perf-budgets.json` + `test/timeout-budget.test.ts`.
- The table is now the only place a per-file runtime is authoritative. Re-measuring is a command, not a memory: `node scripts/measure/test-file-budgets.mjs` (all files) or `--files <file>` (one). Do not hand-edit a row to quiet the gate; the gate checks the row against its own runs and the file's bytes.

### 11.7 The commands this section rests on

| What | Command | Result |
|---|---|---|
| the table | `node scripts/measure/test-file-budgets.mjs --fresh --exclude test/timeout-budget.test.ts` | 72 files, one idle run each, loads 5.28–8.00 |
| the missing-idle rows | `node scripts/measure/test-file-budgets.mjs --files <7 files>` | all 7 acquired an idle run; loads 5.28–6.34 |
| the gate | `node scripts/run-node-tests.mjs --timeout=126000 test/timeout-budget.test.ts` | 4/4, exit 0 |
| the gate with no table | `mv test/perf-budgets.json …` + the gate | 4/4 red, first failure names the missing file |
| the budget control | row 5 000 ms, Makefile 126 000 | B1 red: `worstIdleMs 5000 is not the maximum of its idle runs (31273)` |
| the real timeout control | row 5 000 ms, Makefile 20 000, run the file | `not ok 1 - test/first-boot-tls.test.ts`, `timed out after 20000ms`, exit 1 |
| the effective budget | runner `--timeout=125000` | red: 125 000 is below the 126 000 derived floor |
| `first-boot-tls` alone | `node scripts/run-node-tests.mjs --timeout=126000 test/first-boot-tls.test.ts` | 5/5 ×3; 25 931 / 31 273 ms; phase line per run |
| `export-resilience` alone | same runner, that file | 5/5; 34 199 ms before, 7 129 ms after; 0 mounts/dirs left |
| `ddl-runner` alone | same runner, that file | 18/18 in 9 025 ms after C6's date fix |
| the whole gate | `make test` | three consecutive runs: §11.5 |

---

## 12. S4 round-3 fixes — D1 (the screen), D3 (the drain), and the notice a restart used to erase

**Date:** 2026-10-21, 12:05–12:35 AEDT. **Tree:** `main` at `ae3c9bd` plus this pass' working tree; **nothing committed**.
**Box:** `cyberdeth.za.net`, macOS 15.7.4 arm64, 8 cpus, 16 GiB, node v22.23.1, Docker 29.7.2 (4-cpu / 1.5 GiB VM).
**Load (1 min) moved between 6.26 and 14.02 across the pass** — recorded beside every number below, as in
`S4-qa3.md`. The round-3 verdict was GO on the in-process mechanism and NOT GO on the operator surface for
one reason, D1; D3 and the in-memory notices were the two other real gaps.

### 12.1 D1 — the install screen told the operator a false containment claim, and spoke of a runner that does not exist

`skwctl plugin install` is the only surface on which the trust decision §8.5/§13.3.7 defines is made. It
printed, for a zero-capability package (`S4-qa3.md` §7 D1; probe P3):

```
  capabilities     none — it can reach neither this site's data nor its mailer
…
plugin: the runner scans /var/folders/…/plugins at start; restart the runner service to load nothing
```

Both lines were false in-process. A package with no declared capability can `import('better-sqlite3')`, open
`data/control.db` and read every tenant (§13.3.7, §13.4 item 5); and there is no runner service — D36 deleted
it, and the sentence sent an operator looking for one. The one sentence E-33 item 6 requires was absent, and
so was the gate that was supposed to hold it — `test/plugin-install.test.ts` did not exist.

**Now printed** (`scratch/fix/install-screen-after.txt`, from a real `skwctl plugin install` of
`test/fixtures/plugins/nothing` — capabilities `[]`):

```
install screen — nothing@1.0.0
  publisher        unsigned
  key fingerprint  (none — unsigned)
  first-party      no — and unsigned
  signature        none — no key vouches for these bytes
  test report      2026-10-21T00:00:00.000Z  sha256:ed082f88384c08f4…  image sha256:report
  capabilities     none declared — the package asks this CMS for no operations
  what this means  Capabilities describe what this plugin asks the CMS for. They do not limit what its code can do: a plugin runs inside the site's process, with the site's own access to its files and databases.
  tables           none
…
plugin: in-process; the site loads nothing on the first request after `skwctl plugin enable` — no restart, no service
```

and, at uninstall:

```
plugin: in-process; the running site drops the hooks on its next request — no restart, no service
plugin: this command runs in its own process and cannot see the site's in-flight requests; on a live site uninstall from /admin/t/acme/plugins so the drain runs first and refuses SKW_E_PL_BUSY rather than dropping a table under a request
```

What changed, and where:

| thing | before | after |
|---|---|---|
| the zero-capability line | `none — it can reach neither this site's data nor its mailer` | `none declared — the package asks this CMS for no operations` |
| capability wording for a non-empty list | `N granted:` | `N declared:` |
| the E-33 sentence | absent | `CAPABILITIES_ARE_DISCLOSURE` in `app/plugins/trust.ts`, printed under **every** capability list (both branches) |
| install hand-off | `the runner scans … restart the runner service` | `in-process; the site loads <id> on the first request after \`skwctl plugin enable\` — no restart, no service` |
| uninstall hand-off | `restart the runner service to release the code` | `in-process; the running site drops the hooks on its next request` + the honest statement that the CLI cannot drain |
| `log.write` plain words | `write a line to the runner log` | `write a line to the site log` |
| the test-report label on the screen | `runner <digest>` | `image <digest>` |
| `install.ts` test-report refusals | `inside the runner image` / `by another runner image` | `inside the test image` / `with a different test image` |

`runner_image_digest` and `--runner-digest` are **not** renamed: they are the report field the packager writes
and `bundle_verify` reads, i.e. a wire format, not an operator string. `app/plugins/install.ts:52–66` says so,
and that comment is the one named entry in the test's allowlist.

Two gates had pinned the retired text and were therefore asserting the lie: `test/cli-plugin.test.ts` O1
(`the runner scans … restart the runner service to load contact`) and O4 (`restart the runner service to
release the code for guestbook`). Both now assert the true sentence **and** `doesNotMatch(/runner/i)` — a
stronger assertion than the one they replaced, not a weaker one.

### 12.2 The gate, and the grep proof

`test/plugin-install.test.ts` — five cases, all driven through the real CLI process
(`spawnSync(node, app/cli/skwctl.ts …)`), so the strings are the product's and not a copy:

| case | what it asserts |
|---|---|
| P0 | install, enable and uninstall each exit 0 and the screen is printed at all |
| P1 | the errata's E-33 item 6 sentence, **parsed out of `docs/sds/02-errata.md`** (not a literal that can drift), is present in the install output character for character; and the parsed sentence equals the constant this gate holds |
| P2 | the zero-capability section contains no containment claim (`can reach neither`, `nor its mailer`, `cannot reach`, `cannot send mail`, `has no access to site data`) and does say `none declared` |
| P3 | the combined output of install + enable + uninstall contains **no occurrence of `runner` at all** |
| P4 | the source scan behind P3 can fail: a live service string is flagged, a comment is flagged unless the named allowlist holds it, an allowlisted comment is accepted, and `runner_image_digest` / `--runner-digest` are *not* flagged |

The source scan covers `app/cli/skwctl.ts`, `app/plugins/install.ts` and `app/plugins/trust.ts` (where
`CAPABILITY_TEXT` lives). One hit remains, and it is the allowlisted one:

```
$ grep -rnE "runner[[:space:]-]+(service|scans?|log|container|image|process|daemon|socket)|restart the runner|the runner (scans|holds|refuses|loads)" \
    app/cli/skwctl.ts app/plugins/install.ts app/plugins/trust.ts
app/plugins/install.ts:60:   * change, not a UI fix. What it does **not** name is a service — the runner service is gone
```

Everything else in those three files is either a `runner_image_digest` identifier or a comment explaining why
the field keeps its name. The allowlist entry is
`{file: app/plugins/install.ts, contains: 'the runner service is gone', why: 'names the deleted service only to explain why runner_image_digest keeps its name…'}`,
and P4's self-check pushes a synthetic entry to prove the mechanism admits and refuses for the right reason.

### 12.3 D3 — the uninstall drain now has a caller, on the surface that can see in-flight requests

`runtime.uninstallBegin()` had no caller anywhere in `app/`, `test/` or `scripts/`, and `SKW_E_PL_BUSY` could
not be raised from any operator path: §13.3.8's uninstall row was a sentence about behaviour no code
performed. `skwctl plugin uninstall` runs in **another process** and cannot see the app's in-flight count, so
the drain was wired where the count lives:

- **`PluginRuntime.uninstall(tenant, pluginId, {timeoutMs})`** — drain → `disable` (hooks leave the registry
  before any table moves) → `discardSyncHandle` (our own open reader would make `wal_checkpoint(TRUNCATE)`
  return `busy`) → `uninstallPlugin` (archive, then drop, in one transaction).
- **`uninstallBegin` names the plugin.** `drain()` writes a tenant-shaped refusal because its other callers do
  not know a plugin; the translation to
  `gatehook was not uninstalled: tenant acme still has 1 request(s) in flight after 5000 ms, and nothing was removed`
  happens in one place, with `{tenant, plugin, in_flight, waited_ms}` in the detail.
- **`POST /admin/t/<key>/plugins/uninstall`** — the in-process operator surface (session CSRF + origin, like
  `enable`), with a per-row **Uninstall** form on the plugins screen. `SKW_E_PL_BUSY` is re-thrown so it is a
  **409** with the code; every other failure is a 303 flash carrying the code in the text.
- **`skwctl plugin uninstall` says what it cannot do** rather than implying a drain it does not run.

`test/plugin-lifecycle.test.ts` — U1–U3, and the numbers are from a real run (`scratch/fix/probe-drain.txt`,
taken at load 11.02):

```
in_flight_before_uninstall: 1
uninstall_during_request: status=409 code=SKW_E_PL_BUSY waited_ms=5016
message: gatehook was not uninstalled: tenant acme still has 1 request(s) in flight after 5000 ms, and nothing was removed
held_request_after_release: status=200 body={"held":true,"plugin":"gatehook"}
uninstall_when_idle: status=303 waited_ms=5 flash=… gatehook uninstalled (tables: none; archive …json)
package_on_disk_after: false
archive: gatehook-1.0.0-2026-10-21T01-34-06-000Z.json 1600 bytes
```

The in-flight request is a **real one**: `GET /_plugin/gatehook/hold` on the tenant's own host, held inside the
package's endpoint handler until the gate writes a release file, and counted by the app's own
`plugins.enter()`. (A hook could not hold it: hooks are bounded by `SKW_PLUGIN_HOOK_TIMEOUT_MS`, 2 s by
default, so the dispatch timeout would release the request before the 5 s drain budget could be reached — the
fixture's header says so.) U1 therefore asserts: 409 with `SKW_E_PL_BUSY`, the plugin named, `waitedMs >= 4 500`,
the row, the package tree **and** the registry entry all still present, the held request completes 200 against
the live package, and the retry removes it. U2 is the idle uninstall (303, archive written, table dropped, row
gone, tree gone, `elapsed < 2 000 ms`). U3 is the second uninstall: `SKW_E_PL_UNAVAILABLE` from the runtime and
in the flash.

### 12.4 Notices survive a restart — stored in `cms_audit`, and why that table

The reason a plugin was disabled lived in `PluginRuntime.notices`, a plain array. An operator who restarted
lost the explanation — on the screen they open *because* the site is up, the plugin is off and nothing says
why.

**Store: the tenant's existing `cms_audit`, `action='plugin.failed'`, `actor_label='plugin-runtime'`, with
`{code, message, at}` in `after_json`.** Not a new `cms_plugin_notice` table, for three reasons, the third
decisive:

1. **No schema bump.** `cms_audit` exists in every `site.db` version; a new table would need v5, and
   `user_version = 4` is asserted by `verify-dist` D4, `plugin-activation-seq` A1/A4 and others.
2. **Append-only by trigger** (`trg_cms_audit_append_only`, `trg_cms_audit_no_delete`) — the code that writes a
   notice cannot edit or back-date it, and there is already an index on `(action, ts)`.
3. **One record, not two.** A notice *is* the audit event the chain records, seen by the person who has to act
   on it. Two stores would be two things that can disagree.

`noticesFor()` merges the process's own notices with the latest persisted notice per plugin, deduped on
`(plugin, code, at)`, sorted by instant; a failed read returns the in-memory list (a database problem must not
hide a failure this process witnessed). The previously unused `allNotices()` accessor was deleted rather than
left as a second, in-memory-only answer to the same question. **Cost, stated:** an immutable log means a notice
for a package that was later uninstalled stays readable; the screen shows notices and installed packages side
by side, which is the honest presentation of "this failed, at this time".

**Proof across two OS processes** (`scratch/fix/probe-notice.txt`; N5 in `test/admin-plugin-notices.test.ts`):

```
process A pid=27778 notices=1 code=SKW_E_PL_LOAD at=2026-10-21T01:34:09.558Z
process A message: badshape does not export activate(ctx); the manifest's main is not a plugin
process B pid=27780 status=200
process B notices table:
<tr data-notice="badshape"><td>badshape</td><td><code>SKW_E_PL_LOAD</code></td><td>badshape does not export activate(ctx); the manifest&#39;s main is not a plugin</td><td>2026-10-21T01:34:09.558Z</td></tr>
process B shows A's instant: true
```

Process B builds the app fresh, seeds its own operator, signs in over HTTP and fetches
`/admin/t/acme/plugins`. It never witnessed the failure; the code, the reason and the instant are all there.

### 12.5 Red before green — five mutations, each restored byte-identical

Driver `scratch/fix/mutate.py` (one edit, the gate file through the shipped runner, then the original bytes
back and a SHA-256 comparison). Records: `scratch/fix/mutations.json`.

| id | mutation | file | sha256 before = after | red |
|---|---|---|---|---|
| MD1a | the E-33 sentence's `lines.push` deleted | `app/cli/skwctl.ts` | `99b34cec5ede…` | **P1** only |
| MD1b | the false claim put back on the zero-capability line | `app/cli/skwctl.ts` | `99b34cec5ede…` | **P2** only |
| MD3a | `uninstall()` skips `uninstallBegin` (the pre-fix behaviour) | `app/plugins/runtime.ts` | `7edad9d32e95…` | **U1** only |
| MD3b | the busy refusal rethrown as `drain()` writes it (tenant, not plugin) | `app/plugins/runtime.ts` | `7edad9d32e95…` | **U1** (`the refusal must name the plugin, not only the tenant`) and, as a cascade, U2/U3/U0 — the failed assertion leaves the held request unreleased, so the later cases run against a tenant that never drains. Recorded rather than tidied. |
| MN5a | `persistNotice` call removed (the pre-fix state: memory only) | `app/plugins/runtime.ts` | `7edad9d32e95…` | **N5** only (`the restarted process must still show the notice`) |

The first, pre-fix red of the D1 gate is in the record too: before any fix,
`node scripts/run-node-tests.mjs --timeout=126000 test/plugin-install.test.ts` was **1 pass / 4 fail** (P0 green,
P1–P4 red), with P4 naming the two live `restart the runner service` lines, the two `runner image` refusals and
`'log.write': 'write a line to the runner log'`.

### 12.6 The gate, three times, with the load

```
$ bash scratch/fix/run3.sh
=== RUN 1 exit=0 seconds=158 load_before={ 8.06 8.52 8.78 } load_after={ 6.17 7.50 8.32 }
# tests 597 # pass 597 # fail 0 # cancelled 0 # skipped 0 # todo 0
=== RUN 2 exit=0 seconds=160 load_before={ 6.17 7.50 8.32 } load_after={ 7.05 7.22 8.05 }
# tests 597 # pass 597 # fail 0 # cancelled 0 # skipped 0 # todo 0
=== RUN 3 exit=0 seconds=153 load_before={ 7.05 7.22 8.05 } load_after={ 6.98 7.06 7.84 }
# tests 597 # pass 597 # fail 0 # cancelled 0 # skipped 0 # todo 0
```

| run | tests | pass | fail | skipped | exit | wall | load (1 min, start → end) |
|---|---|---|---|---|---|---|---|
| 1 | 597 | 597 | 0 | 0 | **0** | 158 s | 8.06 → 6.17 |
| 2 | 597 | 597 | 0 | 0 | **0** | 160 s | 6.17 → 7.05 |
| 3 | 597 | 597 | 0 | 0 | **0** | 153 s | 7.05 → 6.98 |

This sequence is the one that matters: the last **code** edit before it was a comment in `runtime.ts`. The only
change afterwards is markdown in this section, and `make verify` on the resulting tree is green —
`27/27` claims, `pointers: 33/33`, `PASS the SDS quotes the register`, `verify-dist: 6/6` (D1 boot 415 ms,
D2 render 1 154 ms, D3 download 1 144 ms, D4 `user_version 4`, D5 `skwctl` 76 ms, D6 228 lines byte-identical),
`verify-no-leak: clean` with its negative control, and the S1 node phase at `0 skipped / 0 cancelled`
(155.4 s, load 6.12 → 6.86). An earlier three-run sequence in the pass — 164 s / 157 s / 180 s at
6.60 → 7.92, 7.92 → 7.94, 7.94 → 14.02 — is superseded by the numbers above and is not what the claim rests
on. `SKW_ALLOW_SKIP` was never set in any run (`grep -rn SKW_ALLOW_SKIP scratch/fix/*.log` matches only the
gate-runner's own test case, which asserts that the escape exists).

`hermes verify --json` on the same tree is **`ok: true`**, every phase exit 0: bootstrap (`npm install`, 0
vulnerabilities), `npm run build`, `npm run typecheck`, `npm run test` **597/597 in 137.0 s**, `make test`
**597/597 in 150.4 s** (dist 6/6, no-leak clean), `make typecheck`, `make build`, and readiness **200** on
`http://127.0.0.1:4321/` in 56 ms (`scratch/fix/hermes-verify-2.json`). Its first attempt came back 596/597 on
**T5** with the same Pebble message (`400 JWS has an invalid anti-replay nonce`) — the flake named in §11.5,
now seen twice in this pass, both times in that test and never in a plugin gate. That is the whole of the
flake's history here: four `make test` runs and one `hermes verify` green on T5, one `hermes verify` red on it.

597 is 587 + 10: P0–P4 (5), U0–U3 (4), N5 (1). Every non-node phase of every run is green as well —
`verify-toolchain` (python 3.9.6, sqlite 3.43.2, argon2 ok), `27/27 passed, 0 skipped, 0 failed`,
`pointers: 33/33`, `PASS the SDS quotes the register`, `verify-dist: 6/6`, `verify-no-leak: clean` with its
negative control (`created skw-leak-probe-… and skipped its teardown — the audit names it (red, as required)`).

Two things the earlier attempts in this pass found, recorded because they are not the budget:

- **Two gates had pinned D1's lie** (O1/O4 in `test/cli-plugin.test.ts`); the first attempt in this pass came
  back **594 pass / 3 fail** on exactly those two plus one `first-boot-tls` T5
  (`400 JWS has an invalid anti-replay nonce`, the pre-existing Pebble flake §11.5 documents at 1-in-8). The
  assertions were corrected to the true sentence plus a negative; T5 has been green in every run since.
- **`test/perf-budgets.json` gained two rows** because the table is complete by construction:
  `test/plugin-install.test.ts` 474 ms (load 5.66) and `test/plugin-lifecycle.test.ts` 5 758 ms (load 5.66),
  both idle runs, written by `node scripts/measure/test-file-budgets.mjs --files …`. `test/timeout-budget.test.ts`
  is 4/4 green and the constant did not move (the heaviest row is still 31 273 ms).

### 12.7 What this section does **not** claim

- §16 S4 row 12 (`install on a clean host ≤ 5 min with images present`), the synchronous-hang claim and
  per-(tenant, plugin) module memory remain **NOT COVERED**, exactly as `S4-qa3.md` §8 says. Nothing here
  fakes coverage for them.
- D2 (the two retired SDS sentences), D4 (`status='failed'` is not a column), D5 (the capability refusal does
  not name the table), D6 (auto-disable codes outside the taxonomy), D7 (`STATUS.md`'s stale open list),
  D8 (`SKW_E_PL_CONTEXT_ENDED` as a plain `Error`) and D9 (79 % of the budget rows unhash-checked) are
  **untouched**. D1, D3 and the in-memory notices were this pass' scope.
- The CLI uninstall still archives and drops **without** a drain. That is now said on the screen and in the
  command's own output, and the drain lives on the admin surface, which is the only surface in the process
  that can see the count. A future `skwctl` that talks to the app over a socket would move it; nothing here
  pretends it already does.

### 12.8 Commands this section rests on

| What | Command | Result |
|---|---|---|
| the operator text | `node scratch/fix/capture-screen.ts` | `scratch/fix/install-screen-after.txt` |
| the D1 gate | `node scripts/run-node-tests.mjs --timeout=126000 test/plugin-install.test.ts` | 5/5 (1/4 red before the fix) |
| the drain, as numbers | `node scratch/fix/probe-drain.ts` | 409 `SKW_E_PL_BUSY` after 5 016 ms; 303 in 5 ms when idle |
| the drain gate | `… test/plugin-lifecycle.test.ts` | 4/4 (U1 5 134 ms) |
| the restart | `node scratch/fix/probe-notice.ts` | pids 27778 → 27780; same instant on the screen |
| the restart gate | `… test/admin-plugin-notices.test.ts` | 6/6 |
| red before green | `python3 scratch/fix/mutate.py` | 5 mutations, 5 red for their own reason, 5 restored identical |
| the budget rows | `node scripts/measure/test-file-budgets.mjs --files test/plugin-install.test.ts,test/plugin-lifecycle.test.ts` | two rows, loads 5.66 |
| the whole gate | `bash scratch/fix/run3.sh` | three consecutive exit 0, 597/597: §12.6 |

---

## 13. Closeout — the login scan, the domain scan, the index-audit gate, and `cms_nav`

**Date:** 2026-10-21. **Scope:** the last backend pass before the CMS goes to real clients — the
two read paths that scan unauthenticated or tenant input, the gate that keeps a plan from
regressing silently, and the navigation table that had no reader. **Nothing was committed.**

`make test` is **exit 0 at 616/616 node tests** (597 + the 19 in this section), `27/27` claims,
frozen `PASS` (`pointers: 33/33`), `verify-dist` 6/6, `verify-no-leak: clean` with its negative
control, node phase **143.1 s**, whole gate **167.39 s wall clock**, load **4.90 at launch → 3.74 at
the end** on the 8-CPU box (`darwin 24.6.0 arm64`, node v22.23.1, better-sqlite3 13 /
SQLite 3.53.4). Repeats on the final bytes (after the last edit) are **616/616 in 159.25 s and
161.36 s**, both exit 0, with the 1-minute load reaching **11–12** while they ran — the box was
shared, and the gate is green loaded as well as idle. An earlier full run in this pass came back **614/616**: the two failures were
`T5` (Pebble, `400 JWS has an invalid anti-replay nonce` — the 1-in-8 flake §11.5 documents, 95.6 s
in that run) and `B2` in `test/timeout-budget.test.ts` because the three new test files had no rows
in `test/perf-budgets.json`. The rows were then measured with the documented script (168 / 683 / 541 ms,
load 4.90) and B2 is 4/4; T5 has been green since.

### 13.1 Item 1 — the login path was an unindexed scan, on unauthenticated input

`app/admin/auth.ts:267` authenticates with

```sql
SELECT id, tenant_id, email, password_hash, role, totp_secret, failed_logins, locked_until
  FROM user_account WHERE email = ?
```

and the only index on `user_account(email)` was
`ux_user_email_global ON user_account(email) WHERE tenant_id IS NULL` — **partial**, so it covers the
fleet operator and nobody else. Every tenant admin login read the whole table, before the password
was checked, on a form that takes an unauthenticated `email`.

The index added is **non-unique on purpose**:

```sql
CREATE INDEX ix_user_email ON user_account(email);
```

`Auth.authenticate()` refuses two rows with one email as *ambiguous* and returns the same 401 as a
wrong password, so the response cannot be used to learn that an email exists twice. A UNIQUE index
would move that decision into SQLite: the second tenant's `INSERT` would fail with a constraint
error at provisioning time, and the ambiguity branch the code is written around could never run.
The index makes the lookup a seek; it does not assert a rule the app owns. The reason is in three
places a reader will hit: the generator comment (`scripts/model/gen_schema.py`), the migration
comment (`schema/control-r4.sql`), and the assertion named "the login index is non-unique on
purpose" in `test/index-audit.test.ts`.

| | plan (`EXPLAIN QUERY PLAN`) | measured |
|---|---|---|
| before (`HEAD`) | `SCAN user_account` | 0.7296 ms/lookup |
| after | `SEARCH user_account USING INDEX ix_user_email (email=?)` | 0.0016 ms/lookup |

Measured on 20,000 `user_account` rows, 200 lookups after a 50-lookup warm-up, same process, same
box, load **5.00 → 5.16** (`scratch/index-before-after.mjs`). The 456× is real and it is *not* the
login's cost: a real login spends ~30–50 ms in one argon2id verify at `m=19456,t=2,p=1`, and the
0.73 ms query was a small part of it. The defect was the scan of unauthenticated input and the
linear growth behind it, not a slow login. That distinction is why the gate asserts the plan rather
than a duration.

**The ambiguity refusal still works, proved after the index** (`test/login-ambiguity.test.ts`, 5/5):

- two `user_account` rows with one email in two tenants are **storable** (the insert succeeds; the
  index is not a uniqueness constraint) and `PRAGMA index_list` says `unique = 0`;
- `Auth.authenticate()` with the *correct* password of both rows returns `ok: false`,
  `reason: 'ambiguous'`, code `SKW_E_SEC_AUTH_INVALID`, status 401;
- the wire body for the ambiguous email is byte-identical to the body for an unknown email after
  `requestId` is scrubbed, and contains no `ambiguous`/`two`/`tenant`;
- a single-row email still logs in (200 with a `csrfToken`) — the index is not a refusal.

### 13.2 Item 2 — `domain(tenant_id)` had no index except the partial primary one

`app/cli/export.ts:117` lists a tenant's hosts with

```sql
SELECT host, kind, is_primary, cert_state FROM domain
 WHERE tenant_id = (SELECT id FROM tenant WHERE key = ?)
 ORDER BY is_primary DESC, host
```

`ux_domain_primary ON domain(tenant_id) WHERE is_primary = 1` is partial, so the listing scanned
`domain` and then sorted it with a temp b-tree. The index added is

```sql
CREATE INDEX ix_domain_tenant ON domain(tenant_id, is_primary DESC, host);
```

The trailing columns are the listing's own `ORDER BY`: the seek and the sort become one index read,
so the temp b-tree disappears as well. The leading column is the predicate, so any other
`WHERE tenant_id = ?` read still uses it.

| | plan | measured |
|---|---|---|
| before | `SCAN domain \| SCALAR SUBQUERY 1 \| SEARCH tenant USING COVERING INDEX sqlite_autoindex_tenant_1 (key=?) \| USE TEMP B-TREE FOR ORDER BY` | 0.2412 ms/listing |
| after | `SEARCH domain USING INDEX ix_domain_tenant (tenant_id=?) \| SCALAR SUBQUERY 1 \| SEARCH tenant USING COVERING INDEX sqlite_autoindex_tenant_1 (key=?)` | 0.0021 ms/listing |

2,000 tenants / 8,000 domains, 1,000 listings per run, load 5.00 → 5.16, same script.

**Migration.** Both indexes are in the generated DDL (`schema/control.sql`, from the one spec in
`gen_schema.py`) and in `schema/control-r4.sql`, so the v3 → v4 chain still lands on the fresh
schema — `test/migrate.test.ts` and `verify_claims.py` check 20 compare the index set and pass.
`migrate` is version-gated, so a file **already stamped v4** will not re-run the delta and keeps
the old plan; there is no deployed v4 database this repository knows of, and the delta says so. If
one appears before a v5, the v5 delta must repeat the two statements — an ungated
`CREATE INDEX IF NOT EXISTS` in the runner would hide exactly the divergence `comparePlanes` exists
to catch, so there is deliberately none.

### 13.3 Item 3 — the index-audit gate

`test/index-audit.test.ts` (7 tests) runs `EXPLAIN QUERY PLAN` over **36 statements transcribed
from the request path** — tenancy resolution, the page lookups (draft and published), nav, assets,
the download plane, forms, settings, plugins, audit, and the admin's session/login reads — against
the DDL the image ships (`schema/site.sql`, `schema/control.sql`, built fresh in memory). Each entry
carries the `file:line` it was taken from. A `SCAN` fails with the query name, the plan text and the
source:

```
index audit: 2 SCAN(s)
domain.by_tenant: SCAN (expected SEARCH) — plan: SCAN domain | SCALAR SUBQUERY 1 |
  SEARCH tenant USING COVERING INDEX sqlite_autoindex_tenant_1 (key=?) | USE TEMP B-TREE FOR ORDER BY
  [app/cli/export.ts:117]
login.by_email: SCAN (expected SEARCH) — plan: SCAN user_account [app/admin/auth.ts:267]
```

That is the run **before** the two indexes were added — the gate was written and run red first. It is
7/7 green now.

**The allowlist is three entries, each a sentence, and it is checked in both directions.** An entry
must still describe a real `SCAN`, or the gate fails as a *stale allowlist entry* — a comment that no
longer matches reality is worse than no comment. The three:

1. `audit.newest` — `SELECT … FROM cms_audit ORDER BY ts DESC LIMIT 50`. The plan reads
   `SCAN cms_audit USING INDEX ix_ca_ts`: SQLite walks the index backwards and stops after 50 rows.
   There is no table walk and no temp b-tree, and the gate asserts the absence of
   `USE TEMP B-TREE` on this query specifically, because a sort is the thing that would make the
   word "SCAN" true.
2. `control.tenants_all` and 3. `control.domains_all` — `SELECT … FROM tenant` and
   `SELECT host, tenant_id FROM domain` in `app/tenancy/cache.ts`. No predicate: the cache loads the
   whole routing table at boot and on a revision bump, and these are the control plane's registry
   tables — one row per tenant, one per host, a documented small set (SDS §5.3). An index cannot
   improve reading every row.

**Negative control, run in the gate itself** (not a paragraph): a scratch copy of the same DDL drops
the new index and the audit is required to go red naming that query —

- `DROP INDEX ix_user_email` → exactly one failure, `login.by_email: SCAN (expected SEARCH) — plan:
  SCAN user_account`;
- `DROP INDEX ix_domain_tenant` → exactly one failure, `domain.by_tenant: SCAN (expected SEARCH) —
  plan: SCAN domain | …`.

Both are green as controls (they expect the red) and would fail if the audit stopped detecting scans.
The gate also asserts the index **shape**: `ix_user_email` is non-unique and non-partial on `email`;
`ix_domain_tenant` is non-unique on `(tenant_id, is_primary, host)`. Dropping an index from
`gen_schema.py` therefore goes red twice — once on the plan, once on the shape.

The control was also run against the **shipped file**, not only a scratch copy: the
`CREATE INDEX ix_user_email …` line was deleted from `schema/control.sql`, the gate was run, and it
went red at `3 pass / 4 fail` with

```
login.by_email: SCAN (expected SEARCH) — plan: SCAN user_account [app/admin/auth.ts:267]
```

then the file was restored and `diff` confirmed byte-identical. That is the failure a real
regression would print.

**What the gate does not cover, measured rather than assumed:** `app/download/code.ts:242`
(`SELECT id FROM cms_download_code WHERE order_ref = ? AND revoked_at IS NULL`) also scans. It is on
the **code-issue** path — one lookup per order webhook — not a per-request read, so it is outside
this gate's list and was not given an index; it is recorded here rather than allowlisted, because an
allowlist entry is a claim that a scan is legitimate and this one is only infrequent.

### 13.4 Item 4 — the nav verdict: `cms_nav` rendered nowhere, and now renders in the shell

**Verdict: nothing rendered navigation from `cms_nav`.** At `HEAD`, `git grep -n cms_nav HEAD -- app/`
returned exactly one hit: a comment in `app/assets/url.ts:8` ("a page body, a datasource row and a
`cms_nav.href_target` all carry the key"). The `nav` array at `app/admin/routes.ts:788` is the admin
console's own hard-coded list, not rows. None of the three export writers (`app/export/project.ts`,
`astro.ts`, `static.ts`) reads the table; `shellSource()` in `app/export/astro.ts` is a generated
string with one `<main>` and no menu. So the table, its `ux_nav_pos` index and its CRUD form were
write-only: a tenant site had no header or footer menu at all.

**Wired, minimally, in the shell:**

- `app/render/nav.ts` — `loadNav(db)` runs one query per location
  (`WHERE location = ? AND visible = 1 ORDER BY ifnull(parent_id, 0), position`), which is a
  **SEARCH** on `ux_nav_pos` (it is one of the 36 audited statements), plus one indexed lookup per
  `page`/`asset` row to resolve its href; the tree is assembled in memory — a query per parent
  would be `WHERE parent_id = ?`, whose leading column that index does not have. `position` order is
  the query's, so the order a client sets is the order that renders.
- Href resolution, all of it before any markup: `page` rows must name a path with a **published**
  `cms_page`; `asset` rows resolve through the same `assetUrl()` the page bodies use, and a gated
  asset is refused (it has no farm link — publishing one would be a 404 dressed as a resource);
  `url` rows must be `http:`/`https:` (`javascript:` in an `href` is the one XSS a server-side
  renderer can hand a browser with no script tag). `visible = 0` rows do not render, and neither do
  their descendants.
- `app/render/components/shells/nav-list.astro` (recursive) rendered by `page.astro` as
  `<header><nav aria-label="Main">…</nav></header>` and `<footer><nav aria-label="Footer">…</nav></footer>`;
  `app/main.ts` passes the tree in the Astro locals. When both menus are empty the shell writes no
  `<header>`/`<footer>` and not one byte changes — which is why the three export trees are still
  byte-identical to the served pages in `test/export-targets.test.ts` (T1/T2/T3 green).

**Refusal by name.** A nav row the renderer cannot resolve fails the render instead of rendering a
dead link. The error names the row id, its label, its kind and its target:
`SKW_E_RT_NAV_TARGET_MISSING` for a `page`/`asset` target with no row behind it (or a draft, which
is not a page yet), `SKW_E_RT_NAV_HREF_REFUSED` for a non-internal path, a non-http(s) URL, a gated
asset or a parent cycle. Both are 500: the page exists, the site's configuration cannot produce it.
`safeMessage()` drops anything containing a slash from the wire body, so the browser gets the code
and the log gets the name — the test asserts the thrown message (`nav item <id> "Careers" (page)
points at a path with no published page: /careers`), and the HTTP test asserts the response is not
200 and carries neither `href="/careers"` nor the label.

`test/nav-render.test.ts` is 7/7: a header with `Company` (positions 0) over `Story`/`Team`
(positions 0/1) and `Careers`/`Contact` (1/2) renders in that order, nested inside its parent, with
the invisible row absent and the footer's off-site link intact; a missing page, a draft target, a
`javascript:` URL and a gated asset are each refused by name; the served page with a dead menu entry
is not a 200.

**What item 4 does not claim.** The three **export** targets still do not carry nav: `Projection`
(version 2) has pages, assets and library rows and no nav, so an exported tree's `Shell.astro` has
an empty menu even when the served site has one. SDS §11.1's table lists "Pages, slugs, nav" as
projected, so this is a real remaining gap, not a decision. It is invisible to today's byte-identity
gate only because no fixture seeds `cms_nav`; a tenant with nav rows exported tomorrow would serve a
different menu than its live site. Closing it means a `Projection` nav field plus matching markup in
`shellSource()` **and** `static.ts` (three renderers kept byte-identical), which is a slice of its
own — it is not half-done here. Second: the refusal happens at **render** time; the admin CRUD form
still accepts a nav row that points nowhere, so the first visitor sees the 500. Validating at write
time is the better place for it and is not in this pass.

### 13.5 What this pass does not claim

- **Not a login speed-up.** The query went from 0.73 ms to 0.0016 ms; argon2 dominates a login. The
  claim is the plan and the removal of a scan over unauthenticated input.
- **No deployed-database migration.** `migrate` is version-gated: a v4 control.db keeps the old plan
  until a v5 delta repeats the two `CREATE INDEX` statements. Fresh installs, and v3 files migrating
  now, get them. There is no deployed v4 file this repository knows of.
- **Two SDS numbers are stale and were not edited.** §15 says "26 explicit indexes" and "110,592 B"
  for an empty `control.db`; the tree already had 30 explicit indexes (36 CREATE TABLE, not 35) and a
  122,880 B empty control.db **before** this pass. It is 32 indexes and 131,072 B now. The SDS is the
  register and this pass did not own it; the numbers are recorded here rather than quietly changed.
- **`make test-perf` was not run.** The query timing above is a micro-benchmark with the load quoted;
  it is not the perf gate, which requires an idle box by its own definition.
- **No commit.** `git status` holds the work; nothing was staged or committed.

### 13.6 Commands this section rests on

| What | Command | Result |
|---|---|---|
| red before green, login + domain | `node scripts/run-node-tests.mjs --timeout=126000 test/index-audit.test.ts` | first run 1 pass / 6 fail (the audit case naming both queries; the shape and control cases also need the indexes); 7/7 after |
| the ambiguity proof | `… test/login-ambiguity.test.ts` | first run 2/5 (shape and plan red on the missing index); 5/5 after |
| the nav verdict and its gate | `… test/nav-render.test.ts` | 0/1 before (`ERR_MODULE_NOT_FOUND app/render/nav.ts`); 7/7 after |
| before/after plans and ms | `node scratch/index-before-after.mjs` | §13.1/§13.2 tables, load 5.00 → 5.16 |
| schema and chain | `python3 scripts/model/validate_schema.py` | `FAILURES: none`; control 9 tables / 11 indexes |
| migration convergence | `… test/migrate.test.ts test/export-targets.test.ts test/error-codes.test.ts test/export-determinism.test.ts` | 32/32 |
| the budget rows | `node scripts/measure/test-file-budgets.mjs --files test/index-audit.test.ts,test/login-ambiguity.test.ts,test/nav-render.test.ts` | 168 / 683 / 541 ms, load 4.90 |
| the whole gate | `make test` | exit 0, 616/616, 167.39 s, load 4.90 → 3.74; repeat on the final bytes 616/616 in 159.25 s |
