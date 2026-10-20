
---

# Round 2 — the four fixes, the new surface, and the regression sweep

**Tree:** `1d80374` ("S3 fix: verify-dist (E-28), global stamp gate (E-27), two expiries (E-26), row-9
gates"), clean at 23:24 when this review began. **Gate:** `make test` **417/417, 0 failed, 0
skipped, RC=0** twice (87.92 s, 93.30 s); `verify-dist: 6/6 passed` inside both. The node suite
alone is 66.2 s; every probe below is mine, in `scratch/qa-s3r2/`.

**Verdict: GO on the four items — all four close, each one proved by breaking it — with one new
blocker-class gate defect and one measured product defect.** The four round-1 items are fixed and
their gates fail when the mechanism is removed. Two things the fix introduced are not: the E-28
register cannot see the class it exists to catch grow inside a file it already lists, and a burst
of ~32 simultaneous buyers loses ~30 % of its downloads to the queue deadline. Both are stated
below with numbers.

| round-1 item | closed? | how it was broken, and what went red |
|---|---|---|
| 1 · E-28 `verify-dist` | **yes** | resolver → `.ts`: `verify-dist` **1 of 6 failed (D3)**, node suite **416/417 (W3)**; each of D1–D6 reddens when its own `dist/` artefact is removed |
| 2 · E-27 `StampGate` | **yes** | 32 requests on a cap of 4: 28 measured *waiting* while 4 rendered, all settled, no hang, slots drain to 0; 24/24 queue-refused behind 8 held slots reproduced |
| 3 · E-26 `cexp` | **yes** | middle-window continuation 200 with **zero** event/first/render deltas, `uses` unchanged; no-row → `no_redemption` with no event row; `Max-Age == cexp − iat` exactly; render `= cexp + grace` |
| 4 · row 9 / `bundle_verify` | **yes, with three bypasses** | three refusals fire on my own fixtures, each with a negative control; an **unlisted** DB with render rows still passes |

---

## A.1 — `verify-dist`: reproduced red, and every `D<n>` executes its artefact

**NC-1, the reverted resolver, run by me.** `stampWorkerUrl`'s `metaUrl.endsWith('.ts') ? '.ts' : '.js'`
→ `'.ts'` alone (the pre-fix line):

```
sha256 before  1af54349c1b3624a4cf8813ed92ee06711a14d68e54df8e079f2d1ec21dcc4e4
sha256 broken  a9bd5ad61bced9d321e919fd1df49bbb75cac91de379a17d1ff9e96cc8472f17

$ make verify-dist          ok D1 · ok D2 · FAIL D3 · ok D4 · ok D5 · ok D6
  FAIL D3  GET /d/acme/file -> 503:
    {"code":"SKW_E_SEC_WATERMARK_FAILED",…,"detail":{"reason":"renderer","budget_ms":2000}}
  verify-dist: 1 of 6 failed — the artefact is not proved        EXIT=2

$ node scripts/run-node-tests.mjs …      # tests 417 · pass 416 · fail 1
  not ok 215 - W3 — the handed-off path is under content/protected/, never content/media/

sha256 restored 1af54349…   RESTORE: IDENTICAL   ->   verify-dist 6/6 passed
```

So the builder's correction to E-28's prediction is right and better than the errata: the gate
is red at D3 **and** the source suite is red at `W3`, 416/417. What E-28's item 3 predicted
(404/404 green, red only under `verify-dist`) was already false when it was written, and the
report says so rather than rewording the control. That is the correct handling of a control that
does not come out as specified.

**Is any `D<n>` a no-op?** Six runs. For each, one `dist/` artefact is moved aside, the gate is run
directly (`node scripts/dist-gate.mjs`, not `make`, so nothing rebuilds the damage away), and the
file is put back and re-hashed:

| removed | D1 | D2 | D3 | D4 | D5 | D6 | restore |
|---|---|---|---|---|---|---|---|
| `dist/app/main.js` | **FAIL** | **FAIL** | **FAIL** | ok | ok | ok | identical |
| `dist/app/download/stamp-worker.js` | ok | ok | **FAIL** | ok | ok | ok | identical |
| `dist/app/db/migrate.js` | **FAIL** | **FAIL** | **FAIL** | **FAIL** | **FAIL** | ok | identical |
| `dist/app/cli/skwctl.js` | ok | ok | ok | ok | **FAIL** | ok | identical |
| `dist/tools/nginx_gen.js` | ok | ok | ok | ok | ok | **FAIL** | identical |

No check passes on a missing artefact, and D3/D5/D6 are exclusive to the file each claims.
`migrate.js` reddens five because `main.js` and `skwctl.js` both import it — a shared import, not
a vacuous assertion. The gate's imports are fixture-building only (`uploadAsset`, `issueCode`,
`makeFixture`); D3's *assertion* runs the compiled `buildApp` through `scripts/dist-app-harness.mjs`,
which imports `../dist/app/main.js` and nothing from `app/`.

**What the gate still cannot see — the register is file-scoped.**

`auditWitnesses()` builds `claimed` from `DIST_SITES.map(row => row.file)` and tests
`!claimed.has(o.file)`. The tree has **14 occurrences over 5 files** and **8 rows** — `migrate.ts`
alone has five occurrences (two `import.meta.url`, two `process.cwd()`, one `process.argv[1]`) and
two rows. I added a ninth site to a file that is already claimed:

```ts
// app/main.ts, appended
export const qaRogueRoot = process.cwd();

# E28-1 8 rows -> D1, D2, D3, D4, D5, D6
# E28-2 15 occurrences over 5 files, 8 rows, 1 exempt        <- 14 became 15
ok E28-1 · ok E28-2 · ok E28-3        # pass 3, fail 0
sha256 restored: IDENTICAL
```

**Green.** The register's second assertion is "every occurrence … is claimed by a row or listed in
`DIST_EXEMPT`" (E-28), and its rule is "a new site in this class is a new row in the register …
there is no third option". The implementation supplies the third option: add the site to a file
that already has a row and nothing notices. The builder's own control (a new file,
`app/download/rogue.ts`) only exercises the half the predicate can see, and `E28-3`'s in-memory
check is the same file-level predicate restated — it cannot fail for a new site in an old file.
This is the E-22 shape ("a gate that cannot fail when its mechanism is removed is not a gate")
one level up: the gate can fail, but not for the change the rule is about, in the two files
(`render.ts`, `main.ts`) where the original defect lived.

---

## A.2 — the two gates: no deadlock, and the order is fixed

**24 concurrent, 8 slots held (`scratch/s3fix/probe-e27.ts`, re-run).** D4c: 24 waiters across 4
tenants behind 8 held slots, 500 ms waiter budget → **24 refused, 0 served, 23 `queue` + 1
`timeout`**, peak 8, every refusal one `first:denied_watermark` row with `uses=0`. Reproduced.

One honest qualifier: the first run of that probe **failed its own assertion** —
`D4 … SERVED after 2000 ms: 1`, at 2007 ms — while my `make test` was running in the background; an
immediate re-run under the same load gave 0/24 and exit 0. The budget is anchored at the **stamp stage**, a few ms after the
request arrives (verify, `openDb`, the source `statSync`, the range parse), so under CPU load a
served request can cross the buyer's 2 000 ms line by the width of that prefix. It is a tail of
~7 ms, not round 1's 2 163 ms, but the sentence "the budget is the request's" is true from the
stamp stage, not from the socket.

**The deadlock surface, exercised.** The state that can cycle is *holding a tenant slot and
waiting on the global gate*. To force it to be frequent I ran 4 tenants × 8 requests against a
global cap of 4 (tenant cap 8), sampling the shared gate every 5 ms:

```
# G1 32 requests, cap 4, render 120 ms, budget 2000 ms
#    all settled in 1043 ms; 200s 32; 503s 0; hung 0
#    renderer-observed peak 4; store peakGlobalInFlight 4
#    gate sampled 152x: max active 4, max WAITING 28   <- 28 requests held a tenant slot and
#                                                          were blocked on the global gate
#    latency min 132 / p50 533 / p95 1033 / max 1042 ms
#    slots after: active 0, waiting 0
# G3 post-run request on the same gate -> 200 in 208 ms
```

Twenty-eight requests in the dangerous state at once, and every one of them settled inside its
budget; the gate drained to zero, and the next request was served in 208 ms — so no slot leaked
on either refusal path, which is the leak that would turn a bounded wait into a permanent one.

**The order is fixed, by construction and not only by test.** `grep` over `app/` finds exactly one
acquirer and one releaser:

```
render.ts:504  if (!(await tenantGate.acquire(deadline))) …     <- tenant first
render.ts:509  if (!(await this.#global.acquire(deadline))) …    <- global second
render.ts:547  if (holdsGlobal) this.#global.release();          <- global released first
render.ts:548  tenantGate.release();
```

No other file in `app/` constructs or touches a `StampGate`; the argon2 `Semaphore` is a different
class and is never acquired inside a stamp. A request can therefore only block on the global gate
*while holding a tenant slot*, never the reverse, so there is no cycle to deadlock on — and the
28-waiter sample is the empirical confirmation that the state exists and still drains.

**Refusal-pressure behaviour, cap 1, 24 requests, 200 ms renders:** 9 served, 15 refused, all
`timeout`; **10 workers started for 24 requests** (a refused request starts none); 3 served and 5
refused per tenant — the single FIFO queue is fair across tenants; all settled in 2 034 ms; slots
0/0 afterwards. No request waited forever anywhere, including under the 40-buyer burst below.

**One instrument caveat, stated so the numbers are not misread.** With an *injected* renderer the
renderer-observed peak can exceed the cap once requests begin to time out (13 in the 40-burst),
because an injected renderer cannot be `terminate()`d: the request releases its slot at the
deadline while the injected body keeps sleeping. The store's own `peakGlobalInFlight()` was **8 in
every run**, and the shipped worker *is* terminated at `remaining`, so the cap holds; the
renderer's counter is only a cap measurement when nothing times out (which is why `W6`/`W6b`/
`P-S3d-1` use a 20 ms sleeper).

---

## A.3 — `cexp`: no INSERT on the continuation, no purchase, and the cookie does not outlive the render

`scratch/qa-s3r2/probe-cexp.ts` — a real `buildApp`, a real `site.db`, real HTTP, row counts over
the whole tenant before and after every request.

```
# A1 live download 200 uses=1 events=1 first=1 renders=1
# A1 cookie Max-Age 21600; iat …211 exp …811 cexp …20811 -> Max-Age == cexp-iat: true

# A2 middle window (exp < now <= cexp): 200, x-accel /__protected/wm/…
# A2 rows before {"events":1,"first":1,"renders":1} after identical — delta events 0, first 0, renders 0

# A3 middle window, no first row: 401 reason=no_redemption uses 0
#    delta events 0, first 0, renders +1

# A4 middle window, row outcome=denied_watermark: 401 reason=denied_watermark uses 0, delta 0

# A5 past cexp: 401 reason=continuation_expired, delta events 0, first 0, renders 0

# A6 render expires_at = 1792542418 = cexp + grace (21600): equal
# A6 cookie dies at iat + Max-Age = cexp; the render outlives the cookie by 21600 s (>= 0)

# A7 mid-window token with another asset's aid: 401 reason=binding
# A8 the same mid-window token from another UA: 401 reason=client
```

**"Performs no INSERT" is true of the ledger and false of the request, and the difference is worth
one line.** The continuation path inserts no `cms_download_event` row and moves no `uses` — A2 and
A3 both measure zero, and A4 shows a denial is not upgraded to a continuation. But the plane
stamps **before** it consumes, so a middle-window token that names no redemption still runs a
full render and writes a `cms_watermark_render` row (`A3: renders +1`) before answering 401. That
is not a purchase — no event row, no use, no file the buyer is entitled to — and the render is
keyed by `spec:source`, so if the same buyer then redeems properly the cache serves them from it.
It is a wasted worker, not a wrong answer. Stated because "no INSERT" in the report reads broader
than what was measured.

**The two attacks on the mint.** `scratch/qa-s3r2/probe-window.ts`:

```
# B1 grace 2 s: first download 200; cexp-iat 600 (the 600 s floor)
# B1 after 2.6 s (> grace): re-mint jti … reused: false
# B1 second download 200, uses 1 -> 2      <- past the reuse window a new jti spends a use
# B2 token minted at grace 21 600, setting then lowered to 5 s:
#    middle-window download 200, uses 1    <- the claim decides, not the setting
```

So the idempotent mint is bounded in time (a stale re-type is a new purchase, not a free one) and
a settings edit cannot retroactively shorten a token already in a browser. The consequence the
errata records — the reuse key is the client, not the code — is confirmed: inside six hours one
client re-downloads without spending, and `max_uses` therefore counts **clients**, not taps. That
is D32, and it is now true rather than aspirational.

---

## A.4 — `bundle_verify`: three refusals, three controls, and three ways past it

My own fixtures (`scratch/qa-s3r2/probe-bundle.mjs`), not the builder's `B1`–`B5`:

```
B0  clean bundle (2 files, correct hashes)        exit 0   "2 file(s) verified, no render tree, no render rows"
B-a files[] names content/protected/wm/…          exit 12  "a bundle must never contain a render"
B-b clean manifest, content/protected/ on disk    exit 12  "the bundle tree contains content/protected/"
B-c listed site.db with 2 cms_watermark_render     exit 12  "carries 2 cms_watermark_render row(s)"
B-c0 same DB, table only, 0 rows                  exit 0   CONTROL for B-c
B-d symlink into content/protected/               exit 12  "a symlink into content/protected/ is a render"
X-1 files[] written as ./content/protected/…      exit 12  normalisation holds
X-2 UNLISTED site.db with 3 render rows           exit 0   *** passes ***
X-3 listed DB with rows named "site"              exit 0   *** passes ***
X-4 listed DB with rows named "site.db.bak"       exit 0   *** passes ***
```

The refusals are real and the controls are the right ones: the empty-table case passes, so
refusal 3 is about rows and not about the schema. The `lstatSync` repair is real too — `B-d` is a
symlink whose target is the render, and it is refused.

**Two of the three holes are the same mistake the builder diagnosed.** Refusal 2 is tree-scoped
"because an omission is the likelier shape of the mistake". Refusal 3 is manifest-scoped and
extension-scoped: a `site.db` in the bundle that the manifest omits (X-2) is never opened, and a
database named `site` or `site.db.bak` (X-3, X-4) never matches `/\.(db|sqlite|sqlite3)$/`. The
canonical names are caught; the omission case that motivated refusal 2 is not. Nothing produces a
bundle yet, so this is a hole in a gate over a writer that does not exist — minor today, and the
thing to fix when S4 builds the writer.

---

## B — the queue deadline: the false-refusal rate at a realistic load

This is the question the builder's 24/24 answer does not settle: a correct fail-closed result and
a product defect are the same measurement seen from two sides. So I measured the other side, on
the shipped path, with the shipped 2 000 ms budget and **max(4, cores) = 8** global slots, and a
renderer whose service time is the *measured* one (below).

**The service time is calibrated, not assumed.** A real 40-page PDF, shipped worker, no injection:

```
# CAL 40-page PDF, one render at a time:            208 / 214 / 205 ms
# CAL 8 concurrent (8 distinct buyers, same asset): 543–602 ms, p50 583
```

Eight-way concurrency inflates a real render by 2.8× on an idle 8-core box. The injected renderer
draws 300–800 ms (mean 550), which is that loaded figure — so the refusals below are not an
artefact of an unrealistically fast renderer. They are, if anything, generous: a sleep holds a
slot without competing for a core, while a real `pdf-lib` worker competes with the event loop.

**N buyers per minute, independent exponential inter-arrivals (`scratch/qa-s3r2/probe-load.ts`):**

| load | buyers | refused `queue` | refused `timeout` | peak in flight | served p95 |
|---|---|---|---|---|---|
| **10/min**, 180 s | 30 | **0** (0.0 %) | 0 | 2 | 796 ms |
| **20/min**, 180 s | 60 | **0** (0.0 %) | 0 | 3 | 798 ms |
| **40/min**, 180 s | 120 | **0** (0.0 %) | 0 | 3 | 808 ms |
| 40 buyers in 10 s (40/min, clustered) | 40 | **0** | 0 | 8 | 779 ms |
| 40 buyers in 30 s | 40 | **0** | 0 | 4 | 798 ms |
| 24 buyers at once | 24 | 0 | 0 | 8 | max 1 954 ms |

**At ten, twenty and forty buyers per minute the false-refusal rate is zero — 0/30, 0/60,
0/120.** The queue does not misfire at the rates the brief asks about, and it does not misfire at
a 40-buyer cluster inside ten seconds either. Sustained capacity is ~870 buyers/min (8 slots ÷ 550 ms) — the constraint is
the **burst**, not the rate: 2 000 ms ÷ 550 ms is 3.6 waves of 8, so ~24–29 simultaneous buyers is
the edge, and everything below that is served.

**Where it does misfire** (`scratch/qa-s3r2/probe-load-cliff.ts`, all at once, shipped budget):

| simultaneous buyers | served | refused | of which `queue` | store peak |
|---|---|---|---|---|
| 16 | 16/16 | 0 | — | 8 |
| 24 | 21/24 | **3 (12 %)** | 0 | 8 |
| 28 | 27/28 | 1 | 0 | 8 |
| **32** | 23/32 | **9 (28 %)** | 0 | 8 |
| 36 | 28/36 | 8 (22 %) | 0 | 8 |
| **40** | 26/40 | **14 (35 %)** | 0 | 8 |
| 48 | 28/48 | 20 (42 %) | 4 | 8 |

The curve is not smooth because the service time is uniform and the waves quantise, but the
threshold is unambiguous: **up to ~24 simultaneous buyers nothing is refused; from ~32 upward
between a quarter and a half of legitimate first-downloads answer 503.** The 24-at-once case that
*succeeds* does so with a 1 954 ms tail — four milliseconds inside the budget. A 24-buyer burst is
already at the edge.

**What a refusal costs the buyer:** measured at every refusal in that table — `uses` summed over
the refused buyers **0**, and **exactly one** `first:denied_watermark` row each (3, 1, 9, 8, 14, 20
rows for 3, 1, 9, 8, 14, 20 refusals). No entitlement is burned, no partial file is served, and a
retry works. The cost is an error page and a reload, at the worst possible moment.

**Judgement.** At the load the brief names, this is not a defect. Above ~24 simultaneous it is one,
and the brief's criterion is right: a burst of shoppers producing 503s is a product defect even
though it is fail-closed. 32 people clicking in the same second is a modest launch for a list of a
few hundred. The mitigation is not a bigger semaphore (that is the memory ceiling D33 exists for)
but a longer budget for a *queued* request — the buyer would rather wait four seconds than see an
error page — or a retry-after response the form can act on. Either is a decision, not a bug fix,
which is why it is reported rather than patched.

**And the reason code an operator will never see.** Every production refusal above is
`reason='timeout'`, not `reason='queue'`: with one store every request carries the same budget, so
a waiter is granted its slot at the instant its own deadline passes and finds no time left. The
`queue` branch fires only when a *different* store's hold outlasts the waiter's budget — 4 of 20 in
the 48-buyer run, 0 in every other run, and 23 of 24 in `W14`'s two-store fixture. E-27 specifies
`detail.reason='queue'` as the observable and `W14` gates it, and both are correct; it is just that
a single-tenant launch produces `timeout`, so a dashboard or alert keyed on `queue` will read zero
during exactly the incident it was built for. `queued_ms` is present on both.

---

## C — the regression sweep: the four round-1 claims

| claim | how | result |
|---|---|---|
| one use per token under 8 parallel `Range` requests | `node --test --test-name-pattern="^R1 "` | `ok 1 - R1 … uses=1, event rows=1 (kinds first:ok), bytes_declared=1202` — **holds** |
| fail-closed under a real worker kill | `scratch/qa-s3/probe-d1.ts`, re-run | 12 000-page PDF, real `Worker.terminate()` at 2 008 ms → 503, `x-accel` absent, one `denied_watermark` row, `uses=0`; truncated PDF same; read-only tree same; next redemption 200 with a fresh render — **holds** |
| gated-absent 404 through nginx | `scratch/qa-s3/probe-d3.ts`, re-run against `nginx:1.31-alpine` | control `/public-media` 200; `/gated-media` **404, 153 B, sha 9f6d0b63**, byte-identical to `/traverse`'s refusal; `/gated-protected` 200 (the trust model, unchanged) — **holds** |
| the farm without Node | `node --test --test-name-pattern="N1 —" test/nginx-media-e2e.test.ts` | `ok 1 - N1 — with the app killed, /media/<key> is a 200 … everything else is a 502` — **holds** |

No regression in the four. The 417-test suite is green twice, including the thirteen new cases.

---

## D — the single `DIST_EXEMPT`, and what `verify-dist` costs the ordinary gate

**The exemption's conclusion is defensible; its stated premise is false.** `DIST_EXEMPT` says
`tools/regen_conf.ts` is "**Not shipped** (`Dockerfile.app` copies `dist/`, `build/`, `schema/` into
`/srv/app`)". `Dockerfile.app:18` is `COPY --from=build /src/dist ./dist`, and the file is on disk
after a build:

```
$ ls dist/tools/        nginx_gen.js   regen_conf.js      <- it ships, as compiled JS
```

The rest of the reason is true and is the part that matters: `REPO` comes from
`test/helpers/fixture.ts:11`, so in `dist` it resolves to `…/dist` and the tool cannot work
(`writeFileSync` into a `dist/nginx/…` that does not exist). Nothing invokes it. So: **no `D` row is
the right answer today, for the right reason, written with the wrong fact** — and an exemption
whose premise contradicts the errata's own "`dist/` carries the test tree into the image" is the
same defect class the register exists to prevent. E-28's item 7 (take the root from
`findProjectRoot`, then gate it) removes the need for the exemption entirely; until then the
sentence should say "ships but is never invoked and cannot work in `dist`".

**Cost inside `make test`:** `node scripts/dist-gate.mjs` is **1.99 s** wall for 6/6 (D1 379 ms,
D2 467, D3 562, D4 50, D5 75, D6 69, plus fixture construction). The `build` it depends on is
already a prerequisite of `verify-s1` and make runs it **once** (`[build] Building server
entrypoints…` appears once in the log), so the marginal cost is the 2.0 s, not the build.

```
make test        87.92 s   (417/417)      node suite 66.2 s · verify-dist 2.0 s · python+build ≈ 19.7 s
make test        93.30 s   (417/417)
```

**2.3 % of the gate.** No one skips an 88-second gate because it is 90 seconds. The thing that
makes `make test` slow is the 66-second node suite, not this.

---

## Defects

| id | Severity | What | Evidence |
|---|---|---|---|
| S3R2-1 | **Major** | **The E-28 register is file-scoped, so the class can grow silently inside a file it already lists.** `claimed` is a set of *files*; 14 occurrences sit behind 8 rows; a ninth site added to `app/main.ts` made it 15 occurrences and E28-1/2/3 all stayed **green**. E-28's rule says there is no third option, and this is one — in the two files where the original `.ts`-resolver defect lived. | A.1; `test/dist-witness.ts:185–192`; measured green at 15 occurrences |
| S3R2-2 | **Major (product)** | **A burst of ≥32 simultaneous buyers loses 28–42 % of legitimate downloads to the queue deadline.** 32 → 9/32 (28 %), 40 → 14/40 (35 %), 48 → 20/48 (42 %). 0/30, 0/60, 0/120 at 10/20/40 per minute, and 0/40 for 40 buyers inside 10 s, so the threshold is density, not rate. Fail-closed, `uses=0`, one `denied_watermark` row each: it costs a reload, not an entitlement. | B; `probe-load.ts`, `probe-load-cliff.ts` |
| S3R2-3 | Minor | **`detail.reason='queue'` is unreachable in a one-store deployment** — every production refusal is `timeout`, because a waiter is granted its slot at its own deadline. 15/15 (G2), 9/9 (32 buyers), 14/14 (40 buyers) were `timeout`; `queue` appears only at 48-buyer pressure (4 of 20) and in `W14`'s two-store fixture. The specified observable and the observed one differ, so an alert on `queue` reads zero during the incident it exists for. | §B; `probe-gate.ts` G2, `probe-load-cliff.ts` |
| S3R2-4 | Minor | **`bundle_verify`'s render-row check is manifest- and extension-scoped.** An unlisted `site.db` with 3 render rows verifies clean (exit 0), as does a listed DB named `site` or `site.db.bak`. The directory half is tree-scoped for exactly this reason; the DB half is not. | A.4 X-2/X-3/X-4 |
| S3R2-5 | Minor | **`DIST_EXEMPT`'s reason is factually wrong**: `dist/tools/regen_conf.js` ships in the image. The conclusion (no `D` row) still holds because nothing invokes it and it cannot work from `dist`. | D; `Dockerfile.app:18`, `ls dist/tools` |
| S3R2-6 | Minor | **The 2 000 ms budget starts at the stamp stage, not at the request.** Under CPU load one of 24 requests was served at 2 007 ms; idle runs give 0/24. Tail of ~7 ms (verify + `openDb` + source `statSync` + range parse), not round 1's 2 163 ms, but the claim is true from the stage, not the socket. | A.2; `probe-e27.ts` first run, exit 1 |
| S3R2-7 | Minor | **A middle-window token with no redemption still runs a full render** and writes a `cms_watermark_render` row before answering 401 `no_redemption` (stamp precedes consume). No event row, no use, no purchase; the render is reusable by the buyer's next legitimate redemption. | A.3 A3, `renders +1` |

**Carried, not new:** `check_frozen.py` still prints `pointers: 23/23` — E-28's builder item 8
(`range(1, 29)`, 28/28) is not applied, and neither are E-24/E-25's owed pointer lines. It is
outside the four items and does not affect any gate's verdict, but the errata's own builder list
owes it, so it should not be lost. `dist/test/**` still ships (E-28's "recorded, not closed").

**Severity call.** S3R2-1 is the highest: it is the same class of defect as S3-3, one level up —
the gate that was built to stop a 100 % download outage cannot see the outage's class re-enter
through the file it already lists, and it reports green while doing so. S3R2-2 is the highest
*customer-facing* one, but it is bounded, fail-closed, costs no entitlement, and does not fire at
any load the brief asked about.

**What would flip S3R2-1 to closed:** make the claim predicate per site, not per file — key the
row on `(file, resolvedBy)` or on `(file, line range)` and compare the occurrence count to the row
count, so a ninth site in `app/main.ts` reddens `E28-2` the way a ninth file does today. The
mutation in A.1 is the negative control, and it takes about ten lines.

---

## Method, and what I could not exercise

Ten probes, all in `scratch/qa-s3r2/`, run against `buildApp`, real `site.db` files, real HTTP, and
(for D3/N1) `nginx:1.31-alpine`. Every mutation was hashed before and after and restored
byte-identical:

```
app/download/render.ts   1af54349c1b3624a4cf8813ed92ee06711a14d68e54df8e079f2d1ec21dcc4e4  (NC-1)
app/main.ts              3a7e38487b2a51fb713fdd8a272d03615648f54ccd9fb17ba06572f8bcdfb6bc  -> +process.cwd()  ->  3a7e3848… IDENTICAL   (register attack)
dist/app/main.js         8424f370d3b7ec4f92a98c5b2ccac0d41a531d9dbb7a950ad39d3d6f908f97f2  (moved, restored)
dist/app/download/stamp-worker.js  19f24f862fc8449c760fd78781dc6647e30b34662a3f4720a00565d9b4867fa7
dist/app/db/migrate.js   1ac490250542e0d905b603eaf7cccceb46e1529805292dd9226abacdf7def352
dist/app/cli/skwctl.js   eee8471bd5a8e529032607a708603933a1d774a25063c5a7725d5c57952c4ee9
dist/tools/nginx_gen.js  2127133830d1e51f1b4eb411f3628416585fb7753e345dc2721a62e84117f935
```

`git status --short` at the end: `?? scratch/qa-s3r2/` only. `dist/` was rebuilt from the restored
sources and `verify-dist` re-run green (6/6) after the last mutation, so the artefact on disk is
not a poisoned one.

**What I did not exercise, said plainly.**

* **A real `worker_threads` kill during a 40-buyer burst.** `D1` proves the kill path; a burst that
  mixes kills and refusals was not run, so the peak-thread count under simultaneous terminations is
  unmeasured. The store's own peak stays 8; the thread count transiently includes terminating
  workers, and I have no number for that overlap.
* **The 503 retry under the same cookie at burst scale.** `W14` proves a retry under the same `jti`
  is still a denial and does not duplicate the row; I did not drive 40 refused buyers through a
  retry storm.
* **A bundle produced by a real writer.** None exists (S4). My fixtures are synthetic, which is why
  X-2/X-3/X-4 are reported as verifier holes and not as shipping defects.
* **RSS.** Still nobody's measurement. The cap is the control; the 2.8× concurrency inflation above
  is a time measurement, not a memory one.
* **`probe-e27.ts`'s timing assertion on a loaded box.** It failed once at 2 007 ms and passed on
  an immediate re-run at the same load. It is a probe, not a gate, so no gate is flaky because of it — but the claim it
  supports ("nothing served past the budget") should be read with the load it was taken under.
