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
