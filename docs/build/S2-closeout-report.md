# S2 closeout — M5, M6, and the load-sensitive gate

**Builder:** Backend engineer. **Date:** 2026-10-20. **Tree:** `639763e` + the working-tree changes
below (`git status --short` at the end: 10 modified files, 3 new paths — nothing committed, per the
brief). **Input:** `docs/build/S2-qa.md` round 2 (§6.2, §8 M5/M6/D12, §10), `docs/sds/02-errata.md`
§8 E-20(d)/E-23.

Three items, all closed: **M6** (the seal-health window), **M5** (a non-integer `limit` refused),
and **D12** (the suite split into a deterministic gate and a performance gate). No correctness
assertion was weakened and `SKW_ALLOW_SKIP` was never set.

| # | Item | Status | Witness |
|---|---|---|---|
| 1 | **M6** — health reports every unsealed day, bounded lookback | **closed** | `test/seal-health.test.ts` `M6-1`…`M6-5`; mutation `SEAL_HEALTH_LOOKBACK_DAYS 400 → 1` → 3 of 5 red |
| 2 | **M5** — `'5'`, `5.5`, `-1`, `'abc'` refused at publish and at resolve | **closed** | `test/sources.test.ts` `M5-1`; mutation of `requestLimit` → red |
| 3 | **D12** — perf assertions split out; `make test` deterministic | **closed** | `make test` 306/306 at 6× and 14× load; `make test-perf` 4/4 |

---

## 1. M6 — the health field reported only yesterday

**The defect, reproduced first** (`scratch/s2close/m6-probe.ts`, on the pre-fix tree): a tenant with
audit rows on D-4, D-3 and D-1 and a seal on D-1 only answered

```
health (sealSummary) {"last_sealed_day":"2026-10-19","unsealed":[],"late_days":0}
status  days=5       ["2026-10-16","2026-10-17"]
```

— a green health series over two days that were never anchored, exactly `S2-qa.md` §6/§10.

**The change** (`app/audit/scheduler.ts`):

- `SEAL_HEALTH_LOOKBACK_DAYS = 400`, exported, with the reason in the code. The bound is **the
  widest window `skwctl audit status --days` accepts (1..400)**: the field must not be narrower than
  the surface beside it, and a second number would be a second answer to "which days exist". A bound
  is needed at all because the field is served from the 30 s cache on an admin route — "since the
  tenant's first audit row" grows without limit with the age of the box, and a dashboard poll must
  not get slower every month. A gap older than 400 days is outside *every* surface the product
  offers (the CLI cannot print it either); `M6-5` asserts that trade rather than hiding it.
- `sealSummary` no longer calls `sealStatus({days: 1})`. It walks `scanGaps` — **the same rule the
  tick and `--heal` use** — over `[max(first audit day, lastEnded - 399), lastEnded]`, so "should
  have been sealed" has one definition in the product, and the only thing that changed is the
  window. Today is deliberately outside it: it has not ended and cannot be sealed (§9.6a step 1).
- `scanGaps` gained an optional `fromDay` (the tick and `--heal` pass nothing, so their behaviour is
  unchanged) — that is what makes the health call's cost constant rather than O(tenant age).

**The errata's example is now reachable**, and the test is written as that example:
`{last_sealed_day: D-1, unsealed: [D-4, D-3, D-2], late_days: 0}` with three gap days, not one.

**The test** (`test/seal-health.test.ts`, 5 cases, 630 ms):

| Case | What it proves |
|---|---|
| `M6-1` | the library field names **every** unsealed day with rows, oldest first — three days, not one — and does not name a day with no rows |
| `M6-2` | the same list is in the **HTTP** payload from `/admin/api/tenants/acme/health`, with `cache_seconds: 30` |
| `M6-3` | `skwctl audit status --days 5` prints the same days as `UNSEALED` and exits 1 |
| `M6-4` | `skwctl audit seal --heal` clears them from both surfaces; `late_days` becomes 3 and the CLI exits 0 |
| `M6-5` | the lookback is bounded, equals the CLI's own maximum, and a 401-day-old gap is outside both by design |

**Mutation record** (the E-22 discipline):

```
app/audit/scheduler.ts  sha256 before 2638a6c6f2197bb6…  (mutated 400 → 1)  restored, sha matches
not ok 1 - M6-1   not ok 2 - M6-2   ok 3 - M6-3   ok 4 - M6-4   not ok 5 - M6-5   # pass 2 # fail 3
```

The two that stay green are the ones the window does not own: `M6-3` (the CLI already printed the
gap) and `M6-4` (sealing clears it). That is the exclusive witness: the three reds can only be the
window.

**Cost at the bound** (why 400 is affordable, measured — `scratch/s2close/seal-cost.ts`): a tenant
with an audit row on **every** day of the 400-day window and **no seals at all** — the worst case,
because every day is unsealed and every one needs a `count(*)` — reports 400 unsealed days in
**16.2 ms**. On a 30 s cache that is 0.05 % of one core. The scan starts at the tenant's first audit
day, so a young tenant pays for its own age, not for the bound.

---

## 2. M5 — a non-integer `limit` was silently ignored

**The change:**

- `app/sources/compile.ts` — one exported rule, `requestLimit(value)`: **an integer, or
  `422 SKW_E_RT_SOURCE_UNKNOWN` / `reason='param_invalid'` / `detail.param='limit'`**. The old shape
  (`typeof requested === 'number' && Number.isFinite(...)`) had two answers for one rule: `'5'` fell
  through to `limit_default`, `5.5` was floored with no refusal, and only `-1` refused. Clamping to
  `limit_max` stays — asking for too many rows is `data-truncated`; asking for five and a half rows
  is not a number of rows.
- `app/sources/spec.ts` — `asLimit` (`limit_max`, `limit_default`) emits the **same** refusal shape
  (`param_invalid`, `param: 'limit'`, plus `detail.field` naming which spec field). This is what
  makes "refused at **publish**" literally true: the publish gate's only limit is the spec's
  (`publishSource` measures at `limit_max`), and §6.2 says the rule is enforced at publish *and*
  render, so one rule has one refusal shape on both paths. Nothing else changes: a malformed limit
  was refused before too, with the generic `reason='spec'`; the code, status and refusal are
  identical, the reason is now the one §6.2 names.

**The test** (`test/sources.test.ts` `M5-1`): the four shapes QA measured — `'5'`, `5.5`, `-1`,
`'abc'` — each at **both** moments, asserting code + reason + `detail.param`, that **zero**
`cms_datasource` rows were written, and a positive control (`limit: 2` resolves with `limit === 2`)
so the table cannot pass by refusing everything.

**Mutation record:**

```
app/sources/compile.ts  sha256 d11dd76e4abf309b…  before and after
mutant: `typeof value !== 'number' || !Number.isInteger(value)` → `typeof value !== 'number'`
not ok 1 - M5-1   error: 'resolve must refuse 5.5 (a fractional number)'      # restored
```

**One conflict with the spec text, stated rather than smoothed over.** Errata E-23 says
"`limit: 2.7` → floors to 2, as today" two sentences after saying a non-integer `limit` is refused.
This brief resolves it the other way — `5.5` is refused — and the code now follows the brief.
**§6.2's "2.7 floors" clause is therefore stale and needs an errata amendment** (see §6, open item 1).
No test asserted the flooring, so nothing was weakened to make this true.

---

## 3. D12 — the suite is now two gates

### 3.1 Classification: every assertion of a time or a rate

| Where | What it asserts | Kind | Now |
|---|---|---|---|
| `test/sources.test.ts` `S2E-2` | `cost_ms_max <= 1.5` (worst of 200 measured runs) | **RATE** | assertion moved to `make test-perf` `P-1`; `make test` keeps "measured, finite, stored" |
| `test/sources.test.ts` `V1-4` (old) | an expensive view body is refused by the **1.5 ms** ceiling (400 runs, 10.6 s) | **RATE + slow** | real-ceiling form moved to `P-2`; `make test` keeps a `budgetMsMax: 0` form (monotone, cannot flake) |
| `test/admin-sources.test.ts` `S2E-22` | `published.cost_ms_max <= 1.5` over HTTP | **RATE** | moved to `P-3`; the route's refusal path stays in `make test` (`S2E-23`, `S2E-24`) |
| `test/admin-auth.test.ts` case 4 | three login causes' **medians within 20 %**, n=60 | **TIME** | timing half moved to `P-4`; `make test` keeps status/code/body identity + the TOTP-count witness (4b) |
| `test/admin-auth.test.ts` case 3 | `expiresAt − now ≈ 60 min`, ±5 s | time-typed, **not load-sensitive** (a value computed from config, 5 s slack on 60 min) | stays |
| `test/admin-session.test.ts` | expiry ≈ 15 min out | same | stays |
| `test/ddl-runner.test.ts` `C7` | a rebuild reported the connections it waited behind (`waitedFor >= 1`) | structure under contention; **more** load means **more** contention | stays |
| `test/install.test.ts` | measures `wallMs`, asserts only the outcome — the comment says why | already the model | stays |
| `test/integration/three-hosts.test.ts` | 17 MiB body gets **some** response (3 attempts) | harness budget, not an assertion about time | stays; attempts 3 → 8, count in the failure message |
| `test/nginx-e2e.test.ts`, `test/onboarding.test.ts` | wait up to 15 s for nginx, then fail with a message | harness deadline | stays |

Nothing else in `test/` compares a duration or a rate; `grep -n "cost_ms\|hrtime\|performance.now\|median(" test/`
returns only the places above (helpers included).

### 3.2 What moved, and what `make test` still owns

`make test-perf` runs `test/perf/*.perf.test.ts` only:

- **`P-1`** an ordinary indexed query source publishes under the **real** 1.5 ms ceiling, five times;
  the drift alarm is on the **median** (see §3.4), not the max.
- **`P-2`** the real ceiling refuses a genuinely expensive view body (`cost_ms_max` **26.1–37.7 ms**
  across runs, quoted from the refusal).
- **`P-3`** the admin publish route returns the measured report under the real ceiling (the success
  path that used to be in `S2E-22`).
- **`P-4`** the three login causes' medians within 20 % at n=60 (the timing half of case 4).

`make test` keeps, for each of those, a **structural** assertion that a regression in the mechanism
would still break:

| Regression | Structural witness kept in `make test` |
|---|---|
| the publish gate stops consulting the budget | `S2E-3` (`budgetMsMax: 0` on a `query` → `SKW_E_RT_SOURCE_BUDGET`), `V1-4` (`budgetMsMax: 0` on a `view`, same code, `limit_ms === 0`) |
| the view source is not measured at all | `V1-4`'s positive control (`cost_ms_max > 0` for a view publish) |
| the measurement is not stored / not returned | `S2E-2` (`typeof cost_ms_max === 'number'`, finite, `> 0`, `cost_rows`), the stored row's columns |
| the admin publish route stops reaching the gate | `S2E-23` (C-18 refusal **through the route**), `S2E-24` (CSRF) |
| the three login failures stop being one response | case 4 (status 401, `SKW_E_SEC_AUTH_INVALID`, no cookie, no `Location`, byte-identical scrubbed bodies) |
| the work per attempt depends on the credentials | case `4b` (TOTP computations = 4 for four attempts, = 0 when optional) |

**The one regression that only `make test-perf` can see**, said plainly: an unknown email that skips
the **argon2 verify** entirely. The body is identical, the code is identical, the TOTP counter is
identical (it counts TOTP, not argon2) — only the medians move. `P-4` is the only witness for it, and
it is a timing gate by nature. That is why `make test-perf` exists rather than the assertion being
deleted.

### 3.3 The timeout, derived rather than widened

`--test-timeout` applies to **each test** *and* to the **file-level subtest**: a file whose total
exceeds it fails even when every test inside it fits (measured: two 700 ms tests with a 1000 ms
budget → `ok 1 - a`, `not ok 1 - <file>`). So the budget is derived from the worst **per-file** idle
runtime.

```
idle, per file, before the split        idle, per file, after the split
test/sources.test.ts   10 264 ms        test/ddl-runner.test.ts   9 036 ms
test/ddl-runner.test.ts 8 990 ms        test/nginx-e2e.test.ts    8 446 ms
test/nginx-e2e.test.ts  8 973 ms        test/env.test.ts          5 519 ms
test/env.test.ts        5 561 ms        test/onboarding.test.ts   2 372 ms
test/admin-auth.test.ts 3 153 ms        test/cli-bootstrap.test.ts 1 665 ms
                                        test/sources.test.ts        266 ms   (was 10 264)
                                        test/admin-auth.test.ts     768 ms   (was 3 153)
```

`TEST_TIMEOUT_MS = 40000` — **4.4×** the worst idle file (9.04 s). The old 15000 was **1.46×** the
old worst file, which is exactly why 6× load killed it. The split is what bought the margin; the
timeout change is the second half, not the first.

**This contradicts frozen text and the contradiction is recorded, not hidden:** `SDS.md:2489` and
errata §2 E-8 / §4 item 12 say "the suite also runs under `node --test --test-timeout=15000`". That
sentence is now false in its number (its intent — a regressed gate is a named red test, not a CI job
timeout — is unchanged, and the 5 s `spawnSync` in `test/env.test.ts` still bounds the one case that
used to hang). `make verify-frozen` is green because `check_frozen.py` does not quote this row.
**An errata amendment is owed** (§6, open item 2).

### 3.4 The load evidence

Load is `N × yes(1)` on an 8-core M1 (`scratch/s2close/load-run.sh N <cmd>`).

**Before the fix, reproduced myself** — a worktree at `639763e`, the old test file, the old 15 s cap:

```
$ git worktree add --detach /tmp/skw-prefix HEAD
$ bash load-run.sh 6 node --test --test-timeout=15000 test/sources.test.ts
not ok 1 - test/sources.test.ts   duration_ms: 15009.712459   EXIT=1
```

**After the fix, same file, same load, same 15 s cap** (i.e. the split alone is what fixed it):

```
$ bash load-run.sh 6 node --test --test-timeout=15000 test/sources.test.ts
# tests 16  # pass 16  # fail 0  # duration_ms 364.728   EXIT=0
```

**`make test` under 6× CPU load** (the ask):

```
$ bash load-run.sh 6 make test > scratch/s2close/make-test-final-6x.log
EXIT=0
# tests 306   # pass 306   # fail 0   # cancelled 0   # skipped 0   # duration_ms 47029.39
```

**`make test` under 14× CPU load** (the level at which QA lost the 17 MiB response and recorded a
13-of-300 `hermes verify`):

```
$ bash load-run.sh 14 make test        EXIT=0
# tests 306   # pass 306   # fail 0   # duration_ms 48751.32
```

**Idle, for comparison:** `EXIT=0`, `# tests 306 # pass 306`, `duration_ms 38679.48` (was
`50 269` before the split — the suite is also 12 s faster).

The 14× run found one more instance of the same class, which is now fixed: `V1-1` failed with
`cost_ms_max 12.358 ms exceeds the 1.5 ms budget (confirmed twice)` because `POSTS_VIEW` still
published against the default ceiling. It now states `budgetMsMax: 1_000` like `POSTS`, and 14× is
green. **Without that measurement I would have shipped a flake in a view fixture.**

**Why "the box decides a publish" is not hypothetical** (`scratch/s2close/cost-headroom.ts`, ten
publishes of the same fixture source):

```
idle            cost_ms_max max 0.0589 ms   -> 25.5x under the 1.5 ms ceiling
6x CPU load     cost_ms_max max 1.4010 ms   ->  1.1x, i.e. one sample in ten at 93% of the ceiling
```

Two such batches in a row is a refusal, and that is a `make test` failure with no code change. That
is the measurement behind `budgetMsMax` on every fixture publish.

### 3.5 `make test-perf` on an idle box

The gate refuses to pretend: `scripts/perf-preflight.mjs` prints the CPU count and load average,
**refuses** (exit 2) above the core count, warns above half, and honours `SKW_PERF_FORCE=1` with a
banner that says the numbers are not a measurement. Evidence it refuses:

```
$ make test-perf            # during another job on this box
  box: 8 cpus, 1-min load average 24.84
  REFUSED: load 24.84 on 8 cpus — this box is oversubscribed …
EXIT=2
```

The runs that count (this box is shared; the lowest load I could get was ~4.3 of 8 cores, which the
preflight reports as a **warning** run — stated rather than called idle):

```
$ make test-perf            # 1-min load average 4.26
  box: 8 cpus, 1-min load average 4.26
  WARNING: load 4.26 is over half the core count — the numbers below are a measurement,
  but a tighter one than usual.
P-1 cost_ms_max 0.0302 0.0157 0.0291 0.6738 0.0122 ms (budget 1.5)
P-2 expensive view cost_ms_max 37.731165999999575 ms (ceiling 1.5)
P-3 admin publish cost_ms_max 0.0340 ms
P-4 medians {"wrong_password":10.54,"unknown_email":10.32,"wrong_totp":10.62} ratio 1.029
      | wrong_password p10=10.33 p90=11.19 | unknown_email p10=10.12 p90=11.02 | wrong_totp p10=10.37 p90=11.34
# tests 4  # pass 4  # fail 0  # duration_ms 12203.73      EXIT=0
```

A second run at load 5.08 gave `P-1 0.0325 0.0151 0.0263 0.0195 0.0124`, `P-3 0.0538`,
`P-4 ratio 1.033`; a third at load 5.11 gave `P-1 0.0314 0.0543 0.0220 0.6836 0.0125`, `P-2 26.13 ms`,
`P-3 0.0358`, `P-4 ratio 1.020` — 4/4, exit 0, each time.

Two things in those numbers are worth reading rather than quoting:

- **The 0.6738 ms sample in `P-1`** is one deschedule of the whole process (`0.01 ms` query, same
  fixture), and it is why the drift alarm is on the **median** (0.0291 here) while the **max** is
  only compared to the product's own 1.5 ms ceiling. An alarm on the max would be red on any busy
  box and would be "fixed" by widening it — the thing this whole item exists to stop.
- **`P-4`'s ratio 1.029** with p10..p90 inside 1.1 ms of each cause is the shape of a real
  indistinguishable-timing result; the band is 1.20.

### 3.6 What the split does **not** cover — the honest list

- **`make test` no longer asserts any wall-clock number.** It asserts that the measurement happened,
  that it is finite and stored, and that the ceiling refuses when it is set to a value it cannot
  meet. If the fixture query got 100× slower but stayed under the product's 1.5 ms ceiling, `make
  test` would not notice; `make test-perf` would (median drift alarm).
- **`make test-perf` is not in CI and must not be a required check** until CI has an idle runner: it
  measures the box, and this box could not give me a genuinely idle window for the whole session.
- **The 17 MiB body case is still a harness assertion**, not a timing one: eight attempts, and a run
  where no attempt produces a response is still a failure that names the count. It passed at 14×.
- **`npm test` now excludes `test/perf/` too** (it is what `hermes verify` runs); `npm run test:perf`
  runs the perf files. `npm test` still does not route through `scripts/run-node-tests.mjs`, so it
  does not enforce skip-is-failure — pre-existing, recorded in errata §8's "not defects" list, and
  unchanged here.

---

## 4. Files changed

| File | Change |
|---|---|
| `app/audit/scheduler.ts` | `SEAL_HEALTH_LOOKBACK_DAYS = 400`; `scanGaps(..., fromDay?)`; `sealSummary` walks `scanGaps` over the bounded window instead of `sealStatus({days:1})` |
| `app/sources/compile.ts` | `requestLimit()` — integer or `param_invalid`/`limit`; `compile` uses it |
| `app/sources/spec.ts` | `asLimit` emits the same refusal shape (`param_invalid`, `param:'limit'`, `detail.field`) |
| `test/seal-health.test.ts` | **new** — `M6-1`…`M6-5` (library, HTTP payload, CLI, clearing, the bound) |
| `test/sources.test.ts` | `M5-1`; `S2E-2` asserts the measurement's shape not its value; `V1-4` becomes the monotone `budgetMsMax: 0` form with a positive control; `POSTS`/`POSTS_VIEW` state a ceiling load cannot cross |
| `test/admin-sources.test.ts` | `S2E-22` publishes through the gate directly and lists it; the route's success path moved to `P-3` |
| `test/admin-auth.test.ts` | case 4 keeps status/code/body identity (and clears the lockout counter it spends); the timing band moved to `P-4` |
| `test/helpers/http.ts` | `postRaw` attempts 3 → 8, count in the failure message, reason in the comment |
| `test/perf/login-timing.perf.test.ts` | **new** — `P-4` |
| `test/perf/sources-cost.perf.test.ts` | **new** — `P-1`, `P-2`, `P-3` |
| `scripts/run-node-tests.mjs` | `--timeout=<ms>` (default 15000, unchanged when absent) |
| `scripts/perf-preflight.mjs` | **new** — the load guard `make test-perf` runs first |
| `Makefile` | `TEST_FILES` excludes `test/perf/`; `TEST_TIMEOUT_MS = 40000`; new `test-perf`; `PERF_FILES`, `PERF_TIMEOUT_MS` |
| `package.json` | `test` excludes `test/perf/`; `test:perf` added |

Nothing under `docs/sds/` was touched. `scratch/s2close/` holds the probes, load harness and every
log quoted above (`make-test-final-6x.log`, `make-test-14x-2.log`, `test-perf-4.log`,
`perf-file-*.txt`, `cost-headroom.ts`, `m6-probe.ts`, `prefix-6x-sources.log`).

---

## 5. Verification summary

```
make test                 idle   EXIT=0   306/306  38.7 s     (was 300/300, 50.3 s)
make test                 6× CPU EXIT=0   306/306  47.0 s
make test                 14× CPU EXIT=0  306/306  48.8 s
make test-perf            idle-ish EXIT=0   4/4    12.2 s     P-2 refused 26.1–37.7 ms > 1.5 ms
make test-perf            load 24.8  EXIT=2 refused by its own preflight
make verify-claims / -frozen / -schema / -gitignore / -s1   green inside every `make test` above
```

Mutations (each restored; sha256 before == after, verified):

```
app/audit/scheduler.ts  2638a6c6f2197bb66076b23793fe3e2464114823e2d48db9c5450994baea3948  (M6 window → 1: 3 red)
app/sources/compile.ts  d11dd76e4abf309bcbbe3e6718aab0505fb7ada6f2ecb2716975ea0e1de30025  (M5 integer check removed: 1 red)
```

---

## 6. Open, and who owes it

1. **Errata E-23's "`limit: 2.7` → floors to 2" clause is stale** — the code refuses `5.5`, per this
   brief. §6.2 should say "an integer is clamped; anything else is `param_invalid`" and drop the
   flooring sentence. Architect.
2. **E-8's `--test-timeout=15000` is now 40000** (`SDS.md:2489`, errata §2 E-8 and §4 item 12). The
   derivation is in §3.3 above and in the Makefile. Architect: either amend the number or replace it
   with "derived from the measured worst-case idle file runtime, stated in the Makefile".
3. **The health field's 400-day bound is the product's widest audit read.** A gap older than that is
   invisible on both surfaces — deliberately, and `M6-5` asserts it — but if the product needs "every
   gap ever", that is an `audit_log`/export question, not this field.
4. **`make test-perf` has no CI home.** It needs a runner that is not running anything else; until
   then it is a developer gate, and the WARNING line in its output is the only thing between a green
   number and a busy box.
5. **Carried, untouched:** D6 (a raw `SQLITE_ERROR` on out-of-band column drift — a 500 on a public
   render), D9 (CI has never run), D10 (§17 attributes S2 proof to O-17/O-30/C-23), D11
   (`check_frozen.py` counts §16 rows instead of identifying them).
6. **`S2E-22`'s route-success path lives in `make test-perf` `P-3` only** — stated in §3.2 with the
   structural witness that stays. If a future reader disagrees with that trade, the fix is a
   per-source budget on the admin route, which is a product decision (it would let an operator raise
   the page budget), not a test change.
