# S4 QA — Round 3 (final): the in-process plugin model, broken per item, and the self-checking budget

**Date:** 2026-10-21, 11:42–12:10 AEDT. **Tree:** `main` at `ae3c9bd` ("Self-checking test budget:
TEST_TIMEOUT_MS re-derived from a 73-row measurement table"). One tracked file was already modified when
this round started — `docs/build/STATUS.md` (a builder's status edit, not mine; left untouched). Nothing
was committed; every mutation was restored and proved by SHA-256.

**Box:** `cyberdeth.za.net`, macOS 15.7.4 arm64, 8 cpus, 16 GiB, node v22.23.1, Docker 29.7.2
(4-cpu / 1.5 GiB VM). **Load moved between 5.28 and 8.85 (1 min) across the round**; every run below
carries the load it was taken at.

**Verdict: GO on the in-process model as built — with one operator-facing defect that must be fixed
before the first client box: the install screen tells the operator that a zero-capability plugin "can
reach neither this site's data nor its mailer" and does not carry the one sentence E-33 requires.**
The mechanism itself held under every mutation I could aim at it: 12/12 hooks fire with the arguments
the table names and their return value reaches the product; the capability check, the `database_list`
assert, the `CONTEXT_ENDED` refusal, the three-in-60 s disable and the activation counter each went red
under their own mutation and stayed green under their neighbours'. The uninstall drain is the one part of
§13.3.8 that is not implemented in the operator path and has no gate.

---

## 1. The gate, three times, plus `verify-dist` (A)

```
$ bash scratch/qa3/run3.sh          # make test, three times, back to back
=== RUN 1 exit=0 seconds=149 load_before={ 5.42 5.83 6.77 } load_after={ 5.59 6.00 6.71 }
# tests 587 / # pass 587 / # fail 0 / # skipped 0 / # todo 0
=== RUN 2 exit=0 seconds=151 load_before={ 5.59 6.00 6.71 } load_after={ 7.08 6.35 6.72 }
# tests 587 / # pass 587 / # fail 0 / # skipped 0 / # todo 0
=== RUN 3 exit=0 seconds=154 load_before={ 7.08 6.35 6.72 } load_after={ 6.19 6.12 6.55 }
# tests 587 / # pass 587 / # fail 0 / # skipped 0 / # todo 0
```

| run | tests | pass | fail | skipped | exit | wall | load (start → end, 1 min) |
|---|---|---|---|---|---|---|---|
| 1 | 587 | 587 | 0 | 0 | **0** | 149 s | 5.42 → 5.59 |
| 2 | 587 | 587 | 0 | 0 | **0** | 151 s | 5.59 → 7.08 |
| 3 | 587 | 587 | 0 | 0 | **0** | 154 s | 7.08 → 6.19 |

Every phase of every run, from the logs (`scratch/qa3/make-test-{1,2,3}.log`):

```
verify-toolchain: /usr/bin/python3 -> python 3.9.6, sqlite 3.43.2, argon2 ok
27/27 passed, 0 skipped, 0 failed                      # verify-claims
§16 S2 rows: 13/13; required strings: 5/5; pointers: 33/33
PASS the SDS quotes the register                       # verify-frozen
verify-dist: 6/6 passed — the artefact on disk is the one asserted
verify-no-leak: clean — 0 skw-* containers, 0 skw-* networks
```

`make verify-dist` on its own:

```
$ /usr/bin/time -p make verify-dist
ok   D1  boot — node dist/app/main.js answers /healthz            :64713 /healthz 200 in 316 ms
ok   D2  page render — GET / reaches build/astro/server/entry.mjs  200 text/html, 304 B
ok   D3  the download — one redemption to a stamped file           303 -> 200, 1922 B, render != blob
ok   D4  migrate — --tenant all exit 0, tenants/acme/site.db at user_version 4
ok   D5  skwctl — admin bootstrap exit 0, <scratch>/enrolment.txt mode 0600
ok   D6  nginx_gen — 228 lines, byte-identical to nginx/conf.d/10-app.conf
verify-dist: 6/6 passed
real 6.75   load before { 8.85 6.51 6.63 }   after { 8.46 6.47 6.62 }
```

**Read:** three consecutive green runs with identical counts on a box carrying 5–9 load, and no
per-file timeout in any of them. This is the first round where that sentence is true without a caveat;
the 126 s budget (§6) is the reason, and the run that used to be lost (`first-boot-tls`) now has 5.7×
headroom rather than 1.3×.

A **fourth** `make test`, taken after every mutation was restored and after the probes were written
(`scratch/qa3/make-test-post-report.log`), is also green: **exit 0, 587/587, 156 s, load 3.92 → 8.85**,
with `27/27` claims, `pointers: 33/33`, `verify-dist: 6/6` and no-leak clean.

The certification run is `hermes verify --json` on the same tree (`scratch/qa3/hermes-verify.json`):
**`ok: true`, every phase exit 0, readiness `200` on `http://127.0.0.1:4321/`**, with
`npm run test` **587/587 in 117.8 s**, `make test` **587/587 in 120.5 s** (dist 6/6, no-leak clean),
typecheck twice, build twice, and bootstrap (`npm install`, 0 vulnerabilities).

---

## 2. The in-process model, each item broken (B)

Method: one edit at a time, the narrowest expression that disables the mechanism; the gate file named in
§13.1a/§16 S4 run through the shipped runner; file restored from the original bytes and **its SHA-256
compared before and after**. 19 mutations, all `restored_identical: true`. Records:
`scratch/qa3/mutations-*.json`; logs `scratch/qa3/mut-*.log`.

### 2.1 The twelve hooks — every one fires, with arguments, and its return value is used

`test/plugin-hooks-wired.test.ts` 12/12 (`H1`–`H12`). The fixture (`test/fixtures/plugins/hooksall`
declares all twelve) writes `{hook, call, value}` per dispatch to a JSONL file and returns a value
visibly different from the one it was handed, so the case can assert the **arguments** and the **effect**
separately. I then broke each call site by pointing it at a tenant with no registration (one token
changed), which is the narrowest way to prove the call site is on the request path rather than in a test:

| # | hook | kind | call site | what the case asserts (args + effect) | mutation | red |
|---|---|---|---|---|---|---|
| 1 | `content.render.html` | filter | `app/main.ts:639` `serveNotFound` | trace `{tenant,path,page.title}`; body carries `<p data-hook="content">` and the original body; status/route unchanged | `ctx.tenant.key` → `'__none__'` (`M9`) | **H2** |
| 2 | `page.head` | filter | `app/main.ts:648` → `shells/page.astro` `<head>` | trace `{tenant,path}`; `<meta name="hooksall"…>` in the served `<head>` | `M8` | **H1** |
| 3 | `asset.url` | filter | `app/main.ts:627` pre-pass | trace `{key,url}`; emitted `src="/media/cdn/work/one…"` | `M10` | **H3** |
| 4 | `form.validate` | filter | `app/forms/intake.ts:282` | trace `{form,values.email}`; a plugin refusal of an address core accepted → 422 and **no row** | `M12` | **H4** (+H5, cascade) |
| 5 | `form.submitted` | action | `app/forms/intake.ts:303` | trace `{form,submissionId}` after the row exists; token not in the payload | `M13` | **H5** |
| 6 | `admin.menu` | filter | `app/admin/routes.ts:773` | trace `items[]` contains core's `/pages`; declared screen kept, undeclared `not-a-screen` dropped | `M15` | **H6** |
| 7 | `mail.template` | filter | `app/plugins/context.ts:295` | trace `{template,vars.total}`; the returned vars are what `hostOp('mail.send')` measures (padded vars → `SKW_E_PL_MAIL: vars exceed 32 KiB`) | `M19` | **H7** |
| 8 | `page.rendered` | action | `app/main.ts:669` | trace `{path,status:200,ms:number}`; the fixture's `'IGNORED-BY-CONTRACT'` return appears nowhere in the body | `M11` | **H10** |
| 9 | `download.redeemed` | action | `app/download/plane.ts:388` | trace `{codeId,assetKey:'vault/book',jti:/^[0-9a-f]{32}$/}` on a real 303 redemption | `M16` | **H8** |
| 10 | `admin.login` | action | `app/admin/routes.ts:501` | trace `{tenant,operatorId}` after a real TOTP login | `M14` | **H9** |
| 11 | `plugin.enabled` | action | `app/plugins/runtime.ts:390` | trace `{tenant}` after the row is `enabled=1`; dispatched with the registered callbacks | `M17` | **H11** |
| 12 | `plugin.disabled` | action | `app/plugins/runtime.ts:452` | trace `{tenant,plugin}` before the prune | `M18` | **H11** |

`H12` is the no-plugin control: detach the runtime, the page still renders, the filter's markup is
absent and the row's own `/media/work/one` URL is used.

Two notes that matter for the record:

- **`M12` reddens H4 and H5.** Not a second defect: with `form.validate` unbound, H4's submission is no
  longer refused, so it **inserts a row and fires `form.submitted`**; H5 then reads the *first* trace line
  and sees `submissionId` 1 where its own response said 2 (`1 !== 2` at `plugin-hooks-wired.test.ts:269`).
  A cascade through test order, recorded rather than tidied.
- **`M17`/`M18` first attempt was a bad mutation, not a passing gate.** Changing only the dispatch's
  tenant label left the callbacks array intact, so the hook still fired and H11 stayed green; the
  mutation that actually disables the mechanism (empty callback list) reddens H11. Both attempts are in
  the record (`mutations-1792544015.json`, `mutations-1792544036.json`) because a mutation that cannot
  fail is the thing §13.1a warns about.

### 2.2 The per-request facade refuses an undeclared capability (and what it names)

`test/plugin-scope.test.ts` 7/7. Mutation `M1` — delete the comparison in `assertCapability`:

```diff
-    if (!grant.includes(capability)) {
+    if (false) { // MUTATION QA3: the capability comparison deleted
```

```
$ node scripts/run-node-tests.mjs --timeout=126000 test/plugin-scope.test.ts
not ok 3 - S3. an undeclared capability is refused SKW_E_PL_REJECTED before p_notes_note is touched
  error: 'store.delete on p_notes_note was NOT refused: the capability comparison in
          app/plugins/context.ts is gone, and this package just deleted a row it was
          never granted (witness §13.1a)'
# tests 7 # pass 6 # fail 1        exit 1        (S1, S2 and S4–S7 green)
```

That is §13.1a's exclusive witness, reproduced: the one check that replaced the runner's layer is a gate,
not a comment.

**But the refusal does not name the table.** §13.3.7/E-33 item 1 say the refusal names "the table and the
method". A real call (`scratch/qa3/probe-model.ts`, P1) prints:

```
code   : SKW_E_PL_REJECTED
message: store.delete needs capability store.delete, which probe did not declare
detail : {"plugin":"probe","method":"store.delete","capability":"store.delete","declared":["store.query"]}
names the table? false
```

The **table** is named only by the *other* refusal (`store.read('cms_page')` →
`SKW_E_PL_NO_TABLE: notes did not declare table "cms_page"`), which does not name the method. So the pair
covers both halves, but neither single refusal satisfies E-33's sentence. Defect **D5**, minor.

### 2.3 `ATTACH` is unexpressible and the `database_list` assert holds

- **Unexpressible:** `METHOD_CAPABILITY` has 14 methods, none takes SQL; `facade` is `Object.freeze`d and
  exposes no connection (`app/plugins/context.ts:63–114`, `348`). There is no `exec`, `prepare`,
  `attach`, `pragma` or `db` key — `S4` asserts the render facade's key set and `Object.isFrozen`.
- **The assert holds:** `assertOneDatabase` runs before the operation. Mutation `M2`
  (`if (names.length !== 1 || names[0] !== 'main')` → `if (false)`) reddens **S5** only. The live probe,
  with a sibling file attached through the layer below:

```
attach: code= SKW_E_PL_REJECTED | detail= {"plugin":"probe","attached":["main","other"],"disable_plugin":true}
```

### 2.4 `SKW_E_PL_CONTEXT_ENDED` on a handle used after the request

Mutation `M3` (`if (closed)` → `if (false)`) reddens **S6** only:

```
not ok 6 - S6 — a context used after its request ended refuses SKW_E_PL_CONTEXT_ENDED, not a reused handle
```

Live probe:

```
after close: code= undefined | class= Error | message= SKW_E_PL_CONTEXT_ENDED: probe called store.read after the request that built its context e…
```

It refuses, with the right *string*, but as a plain `Error` with no `.code`. `schema/error-codes.json`
maps `SKW_E_PL_CONTEXT_ENDED` to 500, and that mapping can never apply to this throw site — it is a
message, not an `AppError`. Defect **D8**, cosmetic unless a caller switches on `err.code`.

### 2.5 A throwing plugin is disabled after three failures in 60 s, and the site keeps serving

Mutation `M4` (threshold 3 → 4) reddens **L7** only. L7 is a dispatch-level proof; this round also drove
the product end to end (`scratch/qa3/probe-site.ts`: `thrower` installed, enabled on a real `buildApp`,
one stored page, real HTTP):

```
enabled; hooks in registry: 1
request 1: status=200 coreBody=true leaked=false enabled=1 registry=true
request 2: status=200 coreBody=true leaked=false enabled=0 registry=false
request 3: status=200 coreBody=true leaked=false enabled=0 registry=false
request 4: status=200 coreBody=true leaked=false enabled=0 registry=false
notice: SKW_E_PL_THROW :: thrower failed 3 times in 60 s (last: content.render.html) and was disabled
after disable: status=200 hooks=0
```

`thrower` throws in `content.render.html` and returns `42` from `page.head`, so request 1 is failures 1
and 2, request 2 is the third: the row flips to `enabled=0`, the registry is pruned, a notice exists, and
**every response is a 200 with the core body** — the plugin's return never reached the page.

The notice's code is invented at the throw site (`runtime.ts:477`, `SKW_E_PL_${reason}`) and
`SKW_E_PL_THROW`, `_WRONG_TYPE`, `_TIMEOUT`, `_BAD_VALUE`, `_REENTRANT` are **not in
`schema/error-codes.json`** (0 hits each). Defect **D6**, minor: an operator can quote a code the
taxonomy does not have.

### 2.6 Enable, disable, uninstall, without a restart

| step | gate | result | mutation that proves it |
|---|---|---|---|
| enable | `L1`–`L4`, `A2` | 4/4 + 10/10 | `M6` (remove `&act=`) → **L9** red |
| disable prunes the registry | `L8` | 8/10 under `M5` | `M5` (`registry.remove` no longer called) → **L8 red, L9 red** (L9 needs a working disable to re-enable) |
| re-enable is a new module instance | `L9` | pass | `M6` → **L9** red only |
| the activation number survives a restart | `A3` (two OS processes) | 4/4 | `M7` (`floor * 0`) → **A3** red only |
| **uninstall drains, then `SKW_E_PL_BUSY`** | **none exists** | — | — |

**The uninstall row of §13.3.8 is not implemented in the product path.** `runtime.uninstallBegin()` is
the only caller of `drain()`; nothing in `app/`, `test/` or `scripts/` calls it:

```
$ grep -rn uninstallBegin app/ test/ scripts/ --include=*.ts --include=*.mjs
app/plugins/runtime.ts:677:  async uninstallBegin(tenant: string, pluginId: string): Promise<void> {
$ node scratch/qa3/probe-model.ts      # P2
drain with one in-flight request: SKW_E_PL_BUSY after 129 ms
drain with none: returned
uninstallBegin has a caller in app/: NO — only its definition in app/plugins/runtime.ts
```

`skwctl plugin uninstall` goes to `install.ts:uninstallPlugin()` in a **different process**, which cannot
see the app's in-flight count at all. `SKW_E_PL_BUSY` appears in `app/errors.ts`,
`schema/error-codes.json` and `test/error-codes.test.ts` — and nowhere that can raise it from the
operator path. E-32's `U1`–`U3` (`test/plugin-lifecycle.test.ts`) do not exist; `grep -rn "U1"` over
`test/` returns nothing. Defect **D3**, and the largest NOT COVERED item of this round.

---

## 3. The honest limit: a synchronous hang cannot be timed out (C)

**From the code.** `HookBus.withTimeout` (`app/plugins/hooks.ts:285–299`) is
`Promise.race([Promise.resolve().then(fn), guard])` where `guard` rejects from a `setTimeout`. A
synchronous loop never yields, so the timer callback never runs; the race cannot settle. There is no
`worker_threads`, `vm.Script` timeout, watchdog or signal anywhere on the hook path —
`grep -rn "worker_threads\|new Worker\|vm.Script\|watchdog" app/` returns only the watermark renderer
(`app/download/render.ts`, `app/download/stamp-worker.ts`), which is not the plugin path. The file's own
header says it in the same words as the spec, and the docstring above `withTimeout` says what the race
can and cannot interrupt.

**From the spec and the docs** — the statement is in six places, all of them findable:

| where | line | what it says |
|---|---|---|
| `SDS.md` §2.3 boot order | 194 | "a package that hangs the loop synchronously during load cannot be timed out here either" |
| `SDS.md` §13.3 opening | 2437–2438 | "**a synchronously hanging plugin cannot be timed out in-process**" |
| `SDS.md` §13.3.6 | 2615–2619 | the block quote: "**This is the accepted cost of the model and nothing in this design mitigates it at runtime** … no watchdog, no worker thread, no `vm.Script` timeout, and no signal" |
| `docs/sds/13-plugin-model-delta.md` | 22, 104–106 | item 4 of "forget these seven things", and §4.5 |
| `docs/sds/02-errata.md` E-32 | 3304–3309, 3329–3331 | the drop-in and "there is deliberately no test for a synchronous hang" |
| `docs/build/STATUS.md` | 37, 69 | "**cannot be timed out in-process** — accepted cost, stated in the spec" |

**Discoverability: the documents pass, the product fails.** A reviewer who opens §13 or the delta doc
cannot miss it; a reviewer who reaches §13.3.6 finds a block quote, which is the form the errata asked
for. What is not discoverable is the same fact *from the product*: `skwctl plugin install` prints an
install screen that never mentions the hang, and the one line it prints about a package with no
capabilities is an active contradiction —

```
capabilities     none — it can reach neither this site's data nor its mailer
```

(`app/cli/skwctl.ts:714`). That is false in-process: the package can `import('better-sqlite3')`, open
`data/control.db` and read every tenant (§13.3.7, §13.4 item 5). So the accepted-cost statement is
discoverable in the spec and absent — worse, inverted — on the screen where the operator decides. This is
the same defect as **D1** below, seen from the honesty side, and it is why D1 is the top item.

The spec's own parenthetical at §13.3:2437 ("stated in §13.3.6 and repeated nowhere else") is also
literally false — §2.3, E-32, the delta doc and STATUS.md all repeat it. Trivial, but it is the kind of
sentence a reviewer quotes.

---

## 4. Revocation, quarantine, the notices screen, the counter (D)

| claim | gate | result |
|---|---|---|
| a root revoked **at install** is refused, by name and by source | `V1` + `V1b` positive control | **5/5**; file-only entry refused `SKW_E_PL_REVOKED`; the same package installs once the entry is gone |
| a root revoked after install is refused **at enable**, no uninstall | `V2` | refused `SKW_E_PL_REVOKED`, message names `notes` and `(file: …)`, registry empty, row `enabled=0`, still installed |
| the verb writes both sources and audits | `V3` | `table=written file=written`, `cms_audit action='plugin.revoke'`, idempotent second run, following `enable` exits 1 |
| an unsigned package cannot self-declare a publisher | `V4` | `publisher='unsigned'`, `fingerprint=null`, `claimed_publisher='acme-labs'` shown as a rejected claim; `SELECT … WHERE signature_state='unsigned' AND publisher <> 'unsigned'` returns no rows |
| the screen shows a disabled plugin, its reason, and re-enables it | `N1`–`N4`, `N3b` | **5/5**: `data-notice="badshape"` + `SKW_E_PL_LOAD` + "does not export activate"; `data-notice="actseq"` + `SKW_E_PL_REVOKED` + the revocation reason; two POST forms with the session CSRF; un-revoke → submit → `303` + "actseq enabled (activation 2, hooks: page.head)" → `GET /pricing` carries `<!--act:2-->`; no token → 403 |
| `activation_seq` survives a **real restart** | `A1`–`A4` | **4/4**: `enable → 1`; `disable → enable → 2`; **two separate OS processes** produce 3 and 4 from the row alone; a v3 file migrates to v4 with `activation_seq=0`. Mutation `M7` (ignore the row floor) reddens **A3** only. |

Two limitations of the notices screen, neither a spec violation and neither tested:

1. **The reason is in memory.** `PluginRuntime.notices` is a plain array (`runtime.ts:115`), so after a
   restart the screen says `disabled` with no reason. `N1`–`N4` all run in the process that failed.
2. **A clean disable and an auto-disable look identical in the row** — both are `enabled=0`. The
   difference lives only in the in-memory notice (and in D4 below).

---

## 5. Regression sweep on the long-standing claims (E)

One gate file at a time through the shipped runner, each with the load it ran at
(`scratch/qa3/file-*.log`):

| claim | file | result | load |
|---|---|---|---|
| first boot over HTTPS, `cert_state` honest | `first-boot-tls` T1–T5 | **5/5**, 22 s | 6.67 → 5.97 |
| export determinism at one `SKW_EXPORT_NOW` | `export-determinism` D1/D2 ×3 targets, D3, D4, D4b | **9/9** | 7.50 |
| install wall clock | `install` (real `install.sh --no-compose` + login) / `install-bundle` | **1/1** in 841 ms / **9/9** in 5 s | 6.67 / 7.24 |
| determinism hashes (tree-wide) | `export-determinism` (`hashTree` over every path, kind and byte) | **9/9** | 7.50 |
| the rename sampler: `dead===0` **with its barrier** | `nginx-media-e2e` N1–N5 / `farm` | **5/5**, 7 s / **5/5**, 3 s | 7.27 / 7.24 |
| one-use download accounting | `download-consume` C1–C4 / `download-redeem` | **4/4**, 5 s / **19/19**, 5 s | 7.50 / 7.38 |

What the numbers actually say:

- **HTTPS / `cert_state`:** T1 (the bundle claims `none`, no key travels), T2 (a pair per host, key 0600),
  T3 (`compose up` serves the page over HTTPS with the self-signed pair while the state stays `pending`),
  T4 (with no CA reachable the `acme` service claims nothing), T5 (against Pebble: issuance, replacement,
  `issued`, nginx reload). The honest-state property is asserted at both ends of the transition.
- **Rename sampler, with the barrier engaged** — the sampler's own final line, from the passing run:

  ```
  {"event":"done","samples":5901,"dead":0,"sawOld":48,"sawNew":5898,"windowSamples":45,
   "releaseReason":"window","oldStatuses":[200,404],"newStatuses":[200,404]}
  ```

  `windowSamples` 45 is the anti-vacuous half: 45 samples were taken while **both** URLs were supposed to
  resolve, and `dead` is 0 across 5,901 samples. This is the assertion the old test could not make.
- **Install:** 841 ms is the real `install.sh` leg (fresh prefix, bootstrap, sign-in asserted). It is two
  orders of magnitude inside §16's 300 s — but see NOT COVERED 2: it is `--no-compose`, and the row's
  "with images present" condition cannot be met on this box.
- **One use per token:** `download-consume` runs 8 processes against one `jti` (`uses=1`, one row), two
  `jti` (`uses=2`), and `max_uses=2` with 8 `jti` (exactly two spend), plus the quota-denial retry. The
  accounting is a mutual-exclusion invariant, so no schedule can change the answer.

---

## 6. The self-checking budget table (F)

`test/perf-budgets.json`: 73 rows, `multiplier: 4`, `staleCheckFloorMs: 3000`, measured 2026-10-21 on this
box at loads 5.28–8.00. `test/timeout-budget.test.ts` 4/4 in 96 ms.

**The derivation is real, not a sentence.** `B3` recomputes `ceil(4 × 31 273 / 1000) × 1000 = 126 000` and
compares it to **both** the Makefile default and the value the runner exported (`SKW_TEST_TIMEOUT_MS`), so
`make test TEST_TIMEOUT_MS=…` cannot quietly move it. `B1` checks every row's own consistency (worst idle
run is the maximum of its idle runs, the load is the load of *that* run, the box, the date, the hash).
`B2` checks completeness (every `test/**/*.test.ts` has a row) and freshness for rows ≥ 3 s plus the
largest. `B4` is the in-suite negative control. I broke it three ways:

| mutation | file (sha256 before = after) | result |
|---|---|---|
| `TEST_TIMEOUT_MS ?= 126000` → `125000` (`MB1`) | `Makefile` `0962c033…` | **B2 + B3 red**, exit 1 — "the budget in force is 125000 ms, below the derived floor" |
| one comment line added to the heaviest file (`MB2`) | `test/first-boot-tls.test.ts` `411cd0ca…` | **B2 red**, exit 1 — names the file, both hashes, the 31 273 ms row and the re-measure command |
| one comment line added to a 2 772 ms file (`MB3`) | `test/cli-bootstrap.test.ts` `c2bf2234…` | **4/4 green**, exit 0 — *the hole, below* |

```
- test/first-boot-tls.test.ts changed since it was measured (sha256 db1f99066af1…, recorded 411cd0ca42d4…):
  its 31273 ms row is stale — re-measure it with "node scripts/measure/test-file-budgets.mjs --files test/first-boot-tls.test.ts"
```

**Would a stale heavy file be caught?** Yes for the rows that can set the budget: the largest row and
every row ≥ 3 s are tied to the file's bytes, a new unmeasured file is refused by the completeness check,
and an edit to the heaviest file is named with both hashes. **No for the other 58 rows.** 15 of 73 rows
are hash-checked; the remaining 79% can be edited and the gate stays green (MB3). A file measured at
2 772 ms that grows to 120 s would leave the table claiming 31 273 ms is the heaviest, and the derivation
would be 4× a number that is no longer the maximum. This is the exact rot the table exists to prevent —
bounded by the fact that a file can only grow to 126 s before the suite itself loses it — and it is not
stated as a limit anywhere except the test file's own docstring ("what this gate cannot see: a row that
understates a file's real runtime"). Defect **D9**, minor.

**Is 126 s per file a reasonable ceiling?** As a **hang detector**, yes: node has one `--test-timeout` per
invocation and E-8 wants one runner, so a single constant must cover the heaviest file; 126 s turns a
wedged file into a 2-minute failure instead of an outage, and the whole suite is ~150 s, so the worst case
is ~1.8× a green run. As a **load-tolerance claim**, it is thinner than "4×" sounds: the 4× is against a
measurement already taken at load 7.3 on 8 cpus, and the S5 report records the same file **losing a run at
94.6 s** under a load it does not print (§11.5), while §10.5's run B lost it at the old 40 s budget on a box
that rose to load 36.40. So the margin against the worst run actually observed is **≈1.33×**, not 4×. The
constant is defensible and the derivation is honest, but a reader who hears "4× the worst file" should hear
"4× an already-loaded measurement, ~1.3× the worst contended run we have recorded". The Makefile comment does
name the file, the measurement, the load and the date, which is what makes that judgment possible.

---

## 7. Defects, in severity order

### D1 — the install screen tells the operator a false containment claim and omits the one sentence E-33 requires (major, security/honesty)

`skwctl plugin install` is the only surface on which the trust decision §8.5/§13.3.7 defines is made. It
prints (`app/cli/skwctl.ts:683–735`, the false line at `:714`; driven for real in `scratch/qa3/probe-model.ts` P3):

```
install screen — nothing@1.0.0
  publisher        unsigned
  key fingerprint  (none — unsigned)
  signature        none — no key vouches for these bytes
  capabilities     none — it can reach neither this site's data nor its mailer
  tables           none
…
plugin: installed id=nothing …
plugin: the runner scans /var/folders/…/plugins at start; restart the runner service to load nothing
```

Three things are wrong in eight lines:

1. **`none — it can reach neither this site's data nor its mailer` is false.** In-process, a package with
   zero declared capabilities can `import('better-sqlite3')` and read `data/control.db` — every tenant's
   data — or open a socket and send mail itself (§13.3.7; §13.4 item 5). The screen tells a
   non-developer the exact opposite of the model, on the line that decides whether they install it.
2. **The sentence E-33 item 6 requires is absent**, and so is the gate that was supposed to hold it:
   `grep -rn "They do not limit\|Capabilities describe" app/ test/` → nothing;
   `test/plugin-install.test.ts` does not exist (the only screen assertions are `plugin-trust.test.ts`
   T1/T3, which assert the *plain words per capability* and the ordering, not the disclaimer).
3. **The screen still speaks the retired architecture**: "the runner scans … restart the runner service"
   (`skwctl.ts:824`, again at `:1009`), with comments at `:820–822` and `:1006–1008` describing
   `runner/server.mjs` as live. There is no runner service. An operator will go looking for it. The same
   residue is in the plain-words table: `log.write` → "write a line to the **runner** log".

This is the defect E-33 exists to prevent — a surface that a reviewer reads as containment in a model that
removed the layer doing the containing — and it is on the install screen, not in a comment.

### D2 — two retired claims are still live text in the SDS, with no errata pointer (major, specification)

- `SDS.md:2856` (§15.3, "The budgets a Builder must not exceed"): **"a plugin RPC op | 2 s | circuit
  breaker → `SKW_E_PL_UNAVAILABLE`"**. There is no RPC, no per-op boundary and no circuit breaker; E-32's
  own "not true any more, and must not be written again" list names this sentence. The pointer set covers
  §15.2 but not §15.3, so `verify-frozen` cannot see it.
- `SDS.md:3079` (§18.1, the upgrade channel): "`BUNDLE.json` carries `image.app_digest` **and
  `image.runner_digest`**". E-31 item 2 deleted that field and `bundle_verify` now refuses a bundle that
  carries it; §12.6 (`:2317`) says so correctly. §18.1 was missed.

Neither is a code defect. Both are the class E-31/E-32 exist to close, and a Builder reading §15.3 for a
budget or §18.1 for the upgrade path is reading a document that describes the model that was deleted.

### D3 — the uninstall drain is dead code, so §13.3.8's uninstall row is unimplemented and ungated (major, data safety)

§13.3.8: "drain waits for the tenant's in-flight count to reach 0, bounded at 5 s, then refuses
`SKW_E_PL_BUSY` rather than drop a table under a live request." `drain()` works
(`SKW_E_PL_BUSY after 129 ms`), but its only caller, `uninstallBegin()`, has **no caller in `app/`,
`test/` or `scripts/`**, and the operator path (`skwctl plugin uninstall` → `install.ts`, another
process) cannot see the app's in-flight count. E-32's `U1`–`U3` do not exist. Nothing observes the
property, and the product does not implement it. The whole-tenant archive is taken first, so the failure
is recoverable — but "refuses rather than drop a table under a live request" is a sentence about
behaviour that no code path performs.

### D4 — `status='failed'` is not a column: the operator-ack gate is unreachable (moderate, specification)

`cms_plugin_installed` has no `status` column (`schema/site.sql:332–349`, and no migration adds one).
`runtime.readRow` computes `status` as `'enabled'`/`'disabled'` from `enabled` when the column is absent
(`runtime.ts:203, 209, 525–529`), so `row.status === 'failed'` at `:229` is never true; the refuse-without-ack
step of §13.3.2 is dead. `markFailed` itself only writes `enabled = 0` (`:426`), despite its own comment
and §13.3.6 saying it sets `status='failed'`. Consequence: a plugin auto-disabled by three failures is
row-identical to one an operator disabled deliberately; the only difference is an in-memory notice that a
restart erases. The retry path still works (the screen always sends `ackFailed: true`), so this is a
specification debt rather than a hole in behaviour — but the spec describes a control that does not exist.

### D5 — the capability refusal does not name the table (minor, specification)

E-33 item 1: "the refusal names the table and the method". The message and detail carry
`method`/`capability`/`declared`, never the table (probe P1: `names the table? false`). The table is only
named by the `SKW_E_PL_NO_TABLE` refusal, which does not name the method.

### D6 — the auto-disable notice carries a code that is not in the frozen taxonomy (minor, taxonomy)

`runtime.ts:477` builds `SKW_E_PL_${reason}`; `SKW_E_PL_THROW`, `_WRONG_TYPE`, `_TIMEOUT`, `_BAD_VALUE`,
`_REENTRANT`, `_UNDECLARED_CAPABILITY`, `_UNDECLARED_TABLE` are all absent from
`schema/error-codes.json` (0 hits). The admin screen renders them in `<code>` as if they were taxonomy.

### D7 — `docs/build/STATUS.md`'s "Open before S4 GO" is stale in the same file that reports three green runs (minor, documentation)

Items 1 (TLS never exercised), 2 (ACME cannot start), 3 (registry pull / `skw-runner:s4d`) and 5 (no
composed plugin invoke) are closed or withdrawn by the S4/S5 work recorded in the same file's plugin
section, and item 4's list (no uninstall, no signature flags) is out of date too. The header says "S4
final QA running" and "three consecutive green runs"; the open list underneath still describes the
pre-D36 tree.

### D8 — `SKW_E_PL_CONTEXT_ENDED` is thrown as a plain `Error` (cosmetic)

`schema/error-codes.json` maps it to 500; the throw site (`context.ts:220–224`) produces a `new Error` whose
`code` property is `undefined`. The string is right, so a plugin author sees it; a host that switches on
`err.code` does not.

### D9 — 79% of the budget table's rows are not hash-checked (minor, gate design)

15 of 73 rows are tied to their bytes. A row below `staleCheckFloorMs` can go arbitrarily stale up to the
126 s timeout without the gate noticing (MB3). Stated in the test's docstring, not in the table's own
documentation, and not in the Makefile's derivation note.

---

## 8. What is NOT COVERED

| # | item | why |
|---|---|---|
| 1 | **Uninstall's 5 s drain and `SKW_E_PL_BUSY` through the operator path** | no caller for `uninstallBegin`, no `U1`–`U3`, no test anywhere raises `SKW_E_PL_BUSY` — the primitive is exercised in a probe, the product path is not (D3) |
| 2 | **§16 S4 row 12: install on a clean host ≤ 5 min "with images present", `certificate: pending` allowed** | no released image on this box; every install gate runs `--no-compose`; `install.test.ts` asserts the outcome and explicitly not the time. Measured here: 841 ms for the local leg, which is not the row's condition |
| 3 | **A synchronous hang, as an execution** | instructed not to hang the suite, and E-32 says a test that hangs CI is not a gate. Verified by reading `withTimeout` + the spec (§3); not verified by hanging anything |
| 4 | **The notices screen's reason across a restart** | `notices` is an in-memory array; `N1`–`N4` all run in the process that failed. The screen promises an operator a reason that a restart erases — not claimed by the spec, not tested |
| 5 | **Per-(tenant, plugin) module memory at this tree state** | S5 measured 25 KiB/instance on a different tree; not re-measured here (the measurement tool is deliberately outside `make test`) |

Everything else in the brief was exercised: the three gate runs, `verify-dist`, all twelve hooks (each
broken), the capability check (broken), `ATTACH`/`database_list` (broken), `CONTEXT_ENDED` (broken), the
three-failure disable over real HTTP, enable/disable/re-enable (broken), revocation at install and enable,
the unsigned quarantine, the notices screen with a working re-enable, the counter across two OS processes
(broken), and the six long-standing claims.

---

## 9. Mutations, with hashes

All restorations verified by SHA-256 (`before == after` for every row). Full records:
`scratch/qa3/mutations-1792544015.json`, `-1792544036.json`, `-1792544078.json`, `-1792544118.json`;
per-mutation logs `scratch/qa3/mut-*.log`.

| id | mechanism | file | sha256 (before = after) | red | exit |
|---|---|---|---|---|---|
| M1 | `grant.includes(capability)` deleted | `app/plugins/context.ts` | `82fc72c8…eb2d` | S3 only | 1 |
| M2 | `database_list` assertion deleted | `app/plugins/context.ts` | `82fc72c8…eb2d` | S5 only | 1 |
| M3 | `closed` no longer refuses | `app/plugins/context.ts` | `82fc72c8…eb2d` | S6 only | 1 |
| M19 | `mail.template` dispatch unbound | `app/plugins/context.ts` | `82fc72c8…eb2d` | H7 only | 1 |
| M4 | threshold 3 → 4 | `app/plugins/runtime.ts` | `419a4c8e…bd95` | L7 only | 1 |
| M5 | `registry.remove` not called on disable | `app/plugins/runtime.ts` | `419a4c8e…bd95` | L8 + L9 | 1 |
| M6 | `&act=` removed from the import URL | `app/plugins/runtime.ts` | `419a4c8e…bd95` | L9 only | 1 |
| M17 | `plugin.enabled` dispatched with no callbacks | `app/plugins/runtime.ts` | `419a4c8e…bd95` | H11 only | 1 |
| M18 | `plugin.disabled` dispatched with no callbacks | `app/plugins/runtime.ts` | `419a4c8e…bd95` | H11 only | 1 |
| M7 | row floor ignored (`floor * 0`) | `app/plugins/registry.ts` | `6f2e3efb…8d86` | A3 only | 1 |
| M8 | `page.head` call unbound | `app/main.ts` | `6beca526…2e03` | H1 only | 1 |
| M9 | `content.render.html` call unbound | `app/main.ts` | `6beca526…2e03` | H2 only | 1 |
| M10 | `asset.url` call unbound | `app/main.ts` | `6beca526…2e03` | H3 only | 1 |
| M11 | `page.rendered` call unbound | `app/main.ts` | `6beca526…2e03` | H10 only | 1 |
| M12 | `form.validate` call unbound | `app/forms/intake.ts` | `e8d6e9a8…06c8` | H4 + H5 (cascade) | 1 |
| M13 | `form.submitted` call unbound | `app/forms/intake.ts` | `e8d6e9a8…06c8` | H5 only | 1 |
| M14 | `admin.login` call unbound | `app/admin/routes.ts` | `e6007494…5d63` | H9 only | 1 |
| M15 | `admin.menu` call unbound | `app/admin/routes.ts` | `e6007494…5d63` | H6 only | 1 |
| M16 | `download.redeemed` call unbound | `app/download/plane.ts` | `221297e9…d697` | H8 only | 1 |
| MB1 | `TEST_TIMEOUT_MS` 126000 → 125000 | `Makefile` | `0962c033…0111` | B2 + B3 | 1 |
| MB2 | a comment added to the heaviest test file | `test/first-boot-tls.test.ts` | `411cd0ca…0988` | B2 only | 1 |
| MB3 | a comment added to a 2 772 ms test file | `test/cli-bootstrap.test.ts` | `c2bf2234…d7b7` | **none — 4/4 green** (the hole) | 0 |

After the sweep: `git status --porcelain` → `M docs/build/STATUS.md` (pre-existing) and `?? scratch/qa3/`
plus `?? docs/build/S4-qa3.md` only; `git diff --stat` on tracked files → `docs/build/STATUS.md | 8 ++++++--`.
No `app/`, `test/`, `schema/` or `Makefile` change survived the round (verified by `git diff --name-only --
app test schema Makefile` returning nothing).

The four gate files touched by mutations were re-run after restoration: `plugin-scope` 7/7, `plugin-load`
10/10, `plugin-hooks-wired` 12/12, `plugin-activation-seq` 4/4, `timeout-budget` 4/4 — and a full
`make test` on the restored tree is **exit 0, 587/587** (fourth run, §1).

---

## 10. Reproducing

```
bash scratch/qa3/run3.sh                          # three make test runs, exit codes, loads
make verify-dist                                  # 6/6, 6.75 s
bash scratch/qa3/filesweep.sh                     # 16 gate files, one at a time, with loads
python3 scratch/qa3/mutate.py scratch/qa3/mutations.json
python3 scratch/qa3/mutate.py scratch/qa3/budget-mutations.json
node scratch/qa3/probe-model.ts                   # capability message/detail, drain, install screen
node scratch/qa3/probe-site.ts                    # three failures over real HTTP, site still 200
```

The probes and the driver are in `scratch/qa3/` and are not part of the suite; nothing in them is a gate.

---

## 11. Verdict

**GO on the in-process plugin model as a mechanism.** Twelve hooks fire with the arguments the table
names and their return values change what the host was about to use; the one capability layer is a gate
with an exclusive witness; `ATTACH` is inexpressible and the `database_list` assert fires; a stashed
facade refuses after the request; three failures in a minute disable a plugin while every request is a
200; enable, disable and the activation counter work without a restart, across a real process boundary;
revocation is read at install **and** at enable; an unsigned package cannot name itself; the notices
screen shows the code, the reason and a working re-enable. Three consecutive `make test` runs are green
with identical counts, and the self-checking budget is a real derivation with a real negative control.

**Not GO on the operator surface until D1 is fixed.** The install screen says a plugin with no
capabilities "can reach neither this site's data nor its mailer" — a false statement in a model whose
whole thesis is that capabilities are disclosure, not containment — omits the sentence E-33 requires, and
tells the operator to restart a runner service that no longer exists. Fix the screen, add the missing
string assertion, and this becomes a GO; the remaining defects are specification debt (D2, D3, D4) and
small (D5–D9).
