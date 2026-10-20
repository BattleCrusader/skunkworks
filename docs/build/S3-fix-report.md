# S3 fix report — E-26, E-27, E-28 and the two §16 row-9 holes

**Closes:** all four items of `docs/build/S3-qa.md`'s NO-GO.
**Tree:** `a65b122` (QA review) + this working tree, uncommitted, as instructed.
**Gate:** `make test` **417/417, 0 failed, 0 skipped, RC=0** — three times, consecutively
(`scratch/s3fix/make-test-1.log`, `make-test-2.log`, `make-test-3.log`) — and `verify-dist 6/6`
inside it.

Before this pass the same gate was **404/404**. The thirteen new cases are the four items'
gates: `R13`, `R14`, `W6b`, `W13`, `W14`, `B1`–`B5` (bundle), `E28-1`–`E28-3` (register).

| Item | E | What was missing | What now proves it |
|---|---|---|---|
| 1 | E-28 | no gate ever executed `dist/` | `make verify-dist` (D1–D6) + `test/dist-witness.ts` register, wired into `verify` |
| 2 | E-27 | no process-global cap; budget started after acquisition | `StampGate` (tenant→global, fixed order), arrival-anchored budget, `W6`/`W6b`/`W14`, `P-S3d-1` |
| 3 | E-26 | `cexp` absent, grace unreachable, re-mint spent a use | `cexp` in the payload and its step-(5) checks, `maySpend` into the ledger, `jti` reuse at mint, `R13`/`R14`/`W13` |
| 4 | §16 row 9 | `expires_at` arithmetic unasserted; `bundle_verify` accepted a render | `W13` (cexp + grace, explicitly not exp + grace); `bundle_verify` refusal + `B1`–`B5` |

---

## 1 — E-28: `make verify-dist`, the gate that executes the artefact

### What it is

`scripts/dist-gate.mjs`, run by a new `verify-dist: build` target, and `verify` is now
`verify-gitignore → verify-schema → verify-claims → verify-frozen → verify-s1 → verify-dist`,
so `make test` runs it. Six assertions, each on a **child process running `dist/`**:

| id | runs | proves |
|---|---|---|
| D1 | `node dist/app/main.js`, six boot keys, scratch `SKW_DATA_DIR` | `/healthz` 200 in 314 ms — `isMain`, `schemaDirFrom`, `findProjectRoot` |
| D2 | `GET /` with `Host: acme.test` | 200 `text/html`, 304 B, page title rendered — `astroHandler` → `build/astro/server/entry.mjs` |
| D3 | `POST /d/acme` → 303+cookie, `GET /d/acme/file` | 200, `x-accel-redirect: /__protected/wm/<spec>/<sha>.pdf`, the named file exists, 1 914 B, sha ≠ the blob's — `stampWorkerUrl` **and** `new Worker` |
| D4 | `node dist/app/db/migrate.js --tenant all` on a fixture with **no** `site.db` | exit 0, `tenants/acme/site.db` at `user_version` 3 |
| D5 | `node dist/app/cli/skwctl.js admin bootstrap --enrolment-out …` | exit 0, file mode **0600** |
| D6 | `node dist/tools/nginx_gen.js --data-dir … --out …` | 180 lines, **byte-identical** to `nginx/conf.d/10-app.conf` |

D3 uses `scripts/dist-app-harness.mjs` — the built `buildApp` with an explicit
`--content-root`, because `node dist/app/main.js` takes `/srv/content`, which a gate may not
write. It imports `dist/app/main.js`; nothing in the gate imports `app/*.ts` to *run* code.
The fixture is built by the gate from source (`makeFixture`, `uploadAsset`, `issueCode`),
which E-28 explicitly allows: `dist/` is the only thing D1–D6 relax — and the gate never reads
or writes `data/` or `content/`.

### The register

`test/dist-witness.ts` — `DIST_SITES` (8 rows over 5 files: the worker URL, the schema dir,
the Astro entry, three `isMain`s, `findProjectRoot`, nginx_gen's output root) and
`DIST_EXEMPT` (1 entry, `tools/regen_conf.ts`, with the reason E-28 gives). Three assertions in
`test/dist-witness.test.ts`, which runs in `make test`:

```
# E28-1 8 rows -> D1, D2, D3, D4, D5, D6 (gate runs D1, D2, D3, D4, D5, D6)
# E28-2 14 occurrences over 5 files, 8 rows, 1 exempt
# E28-3 a real occurrence (app/cli/skwctl.ts) is covered; an invented one is not
```

The scan skips comment lines, so a doc comment that *describes* `import.meta.url` is not a
site. `gateIds()` reads the `CHECKS` table out of `scripts/dist-gate.mjs`, so a renamed `D<n>`
reddens `E28-1` rather than leaving the table pointing at nothing.

**Register control.** Adding `app/download/rogue.ts` with one `export const here =
import.meta.url;` turned `E28-2` red with the exact `file:line`:

```
not ok 2 - E28-2 — every marker occurrence under app/ and tools/ is claimed by a row or exempt with a reason
    unclaimed path sites (E-28 has no third option):
      app/download/rogue.ts:2 import.meta.url — export const here = import.meta.url;
```

Removing the file restored green. That is assertion 3's purpose: the class cannot grow
silently.

### The negative control — and one correction to E-28's own wording

**NC-1, the literal revert** (`stampWorkerUrl` → `new URL('./stamp-worker.ts', metaUrl)`):

```
sha256 before  1af54349c1b3624a4cf8813ed92ee06711a14d68e54df8e079f2d1ec21dcc4e4
sha256 broken  117e3d87b92cdc8dbdd8dd9a80df4221181b6f51d5ab145cbe7af323125db11c

$ make verify-dist
ok   D1 … ok   D2 …
FAIL D3  the download — one redemption to a stamped file under content/protected/wm/
          GET /d/acme/file -> 503:
          {"error":{"code":"SKW_E_SEC_WATERMARK_FAILED", …, "detail":{"reason":"renderer","asset_key":"vault/book","budget_ms":2000}}}
ok   D4 … ok   D5 … ok   D6 …
verify-dist: 1 of 6 failed — the artefact is not proved      (make: Error 1)

$ node scripts/run-node-tests.mjs … (the node suite)
# tests 417   # pass 416   # fail 1
not ok 215 - W3 — the handed-off path is under content/protected/, never content/media/

sha256 restored 1af54349c1b3624a4cf8813ed92ee06711a14d68e54df8e079f2d1ec21dcc4e4   IDENTICAL
```

**So `make test` does not stay green under this exact mutation** — `W3`'s string check catches
it (`expected /\/dist\/app\/download\/stamp-worker\.js$/, input …stamp-worker.ts`). E-28's item 3
predicts 404/404; that prediction was already false when it was written, because QA had
measured `403/404` with `W3` red (`S3-qa.md` §6(ii)). Rather than reword the control to fit, I
ran the mutation the errata's own sentence names as the one that *does* escape: a resolver that
returns the right-shaped path in the wrong place.

**NC-2, the excluded emit** (`tsconfig.json` `exclude` gains `app/download/stamp-worker.ts`; a
clean build then emits `render.js` but no worker — the "excluded emit / image that does not copy
the worker" case):

```
sha256 tsconfig before  206c659a4204c4588e4bcaa4efa4b822434d968c2b21156d1d51d2087e393300
$ make build && ls dist/app/download/   ->  adminCodes code cp1252 ledger plane render token watermark   (no stamp-worker)

$ make verify-dist
ok   D1 … ok   D2 …
FAIL D3 … GET /d/acme/file -> 503
ok   D4 … ok   D5 … ok   D6 …
verify-dist: 1 of 6 failed

$ node scripts/run-node-tests.mjs … (the node suite)
# tests 417   # pass 417   # fail 0   # skipped 0        EXIT=0

$ (restore) sha256 tsconfig  206c659a…  IDENTICAL   ->   verify-dist 6/6 passed
```

**That is the contrast the item exists for**: 417/417 green on every gate that reads the
source, red at exactly one assertion the moment the artefact is executed. NC-1 shows the gate
also catches the historical line; NC-2 shows the class it was built for.

---

## 2 — E-27: the process-global semaphore, and the budget measured from arrival

### What changed (`app/download/render.ts`)

* `StampGate` — a counting gate whose `acquire(deadlineMs)` **expires**: a waiter past its
  deadline is removed from the queue and answers `false` *before* anything runs. `Semaphore`
  (the argon2 one) is untouched; adding a deadline there would change a different contract.
* `globalStampConcurrency() = max(4, availableParallelism())`; the gate is a **process
  singleton**, created once, shared by every tenant's render path. `WatermarkDeps.globalConcurrency`
  exists so a gate can size it (`W6b`); production creates no second one.
* Acquisition is **tenant, then global**; release is the reverse, in one `finally`.
* `#stamp` takes `arrival = now()` **at the stamp stage, before either acquisition**, and
  `deadline = arrival + budgetMs`. A grant with no time left is refused before `#render` is
  called, so **no worker starts**. `#render(job, remaining)` is handed the time that is left —
  the worker's own `terminate()` timer is that number, not a fresh 2 000 ms.
* The peak counters now count **renders**, not granted slots: a request holding a tenant slot
  and waiting on the global one has started no worker, and "peak 8" must keep meaning eight
  workers.

### The gates

```
# W6  16 concurrent stamps -> peak in flight 8 (tenant cap 8, global cap 8, effective 8)
# W6b two tenants x 8 -> global peak 4 (cap 4); per tenant acme 4 beta 4
# P-S3d-1 16 stamps -> 16 renders, peak in flight 8, per-tenant cap 8, global cap 8, effective 8
# W14 global cap 1; holder budget 300 ms -> 503 timeout; waiter budget 40 ms -> 503
#     reason=queue after 44 ms (queued_ms 42), one denied_watermark row, uses 0, no render
```

`W6b` is E-27's extension of `W6`: two tenants, injected global capacity 4, all 16 settle,
global peak **4**, each tenant ≤ 4. `W14` asserts the whole refusal: 503
`SKW_E_SEC_WATERMARK_FAILED`, `detail.reason='queue'`, `budget_ms`, `queued_ms ≥ 30`, no
`x-accel-redirect`, no `content-disposition`, exactly one `first:denied_watermark` row with
`bytes_declared=0`, `uses=0`, no `cms_watermark_render` row, and a retry under the same `jti`
is still one row.

### The measurement QA asked for

`scratch/s3fix/probe-e27.ts` (evidence, not a gate). Real `buildApp`, real fixture, a 700 ms
injected renderer, the shipped 2 000 ms budget:

```
# D4 4 tenants x 6 (renderer 700 ms, budget 2000 ms): 24 concurrent -> statuses [200,503],
#    served 16, refused 8 ["timeout"]
#    peak in flight globally 8 (cap 8); per tenant t1=5 t2=5 t3=5 t4=4; renderer-observed peak 8
#    served latency min 706 / p50 1363 / max 1374 ms; SERVED after 2000 ms: 0
# D4b 24 on one tenant (renderer 700 ms, budget 2000 ms): 24 concurrent -> served 16, refused 8
#    peak in flight globally 8; per tenant t1=8 t2=5 t3=5 t4=5; SERVED after 2000 ms: 0
#    served latency min 707 / p50 1342 / max 1385 ms
```

Before: **32 in flight across 4 tenants** (QA D4) and **8 of 24 served at 2 163 ms** (D4b).
Now: **8 in flight, none served past the budget** — the tail is a 503, not a slow 200.

**`reason='queue'` at scale.** With one store every request has the same budget, so a waiter
is granted a slot at the very instant its own deadline passes; its refusal is `timeout` (it
held a slot, briefly). `reason='queue'` — refused while it never held one — needs a holder
whose hold outlasts the waiter's budget, which in production is another store on the same box.
D4c is that, at 24 requests:

```
# D4c 24 waiters across 4 tenants behind 8 held slots (waiter budget 500 ms):
#    24 concurrent -> statuses [503], served 0, refused 24 ["queue"]
#    refusals by reason: queue 24, timeout 0
#    every one of the 24 queue refusals: one first:denied_watermark row, uses 0
```

That is the honest shape of the reason: `queue` = never held a slot; `timeout` = held one and
ran out of time. Both are `503 SKW_E_SEC_WATERMARK_FAILED`, both write **one** row, both spend
**no** use, neither starts a worker.

### Mutations (each restored byte-identical)

| mutation | gate that reddened |
|---|---|
| the global `acquire` removed | `W6b` — "peak in flight across two tenants was **16**, above the injected global cap of 4"; `W14` also red |
| `arrival` moved to after acquisition (the old `render.ts:341` placement) | `W14` — "queued_ms **2**"; `W6`/`W6b` also red |

---

## 3 — E-26: two expiries, a grace that only continues, and a mint that reuses its `jti`

### What changed

* **`token.ts`** — `Claims.cexp`; step (5) checks `exp − iat = 600`, `cexp ≥ exp`,
  `cexp − iat ≤ 86 400`, `iat ≤ now + 30`, and **no `now ≤ exp` test**; step (8)'s first half is
  `now > cexp → { ok: false, reason: 'continuation_expired' }`, before the database is opened.
  `VerifyFailure` gains that reason, so `detail.reason` is the failure without a mapping.
* **`ledger.ts`** — `ConsumeInput.maySpend`. False in the middle window: the function reads
  the `jti`'s `first` row and either serves it as a continuation or answers `no_redemption`.
  **It performs no `INSERT` and no `UPDATE` on that path** — that is the sentence the item is
  about, and it is a branch, not a comment.
* **`plane.ts`** — `cexp = iat + max(grace, 600)` (so `cexp ≥ exp`, and a grace of 0 makes the
  second window empty); `Max-Age = cexp − iat`; the grace setting is clamped to **86 400**;
  the render's `expires_at` is `cexp + grace`; `maySpend = nowS ≤ exp`; `no_redemption` is
  `401 SKW_E_SEC_TOKEN_INVALID` with `detail.reason='no_redemption'` and a cleared cookie;
  `#reusableJti()` finds the newest `ok` `first` row for `(code, asset, ip, ua)` inside the
  window and reuses its `jti`.

### The proof

`R13` — the window table, six cases over a real socket and a real ledger:

```
# R13 live 200 uses=1; past-exp resume 200 uses=1 rows=1; past-cexp 401 continuation_expired
#     uses=1; no-row 401 no_redemption rows=0; other client 401; cexp-iat 86401 401
```

`R14` — the mint's idempotency, and **the spend-nothing proof**:

```
# R14 two mints -> one jti 71023e6c…, iat 1792498478/1792498479,
#     two downloads -> uses 1, first rows 1
```

Two `POST /d/acme` from one IP/UA inside the window, 1.1 s apart: **same `jti`**, `iat`
re-stamped, `cexp − iat = 21 600`. The first download spends one use; the second token's
download spends **none**; `uses = 1`; exactly **one** `first` row. Before the fix, QA measured
`uses 1 → 2` and two `first:ok` rows.

The resume itself (`R13 b`): the same token with `iat = now − 1200`, `exp = now − 600`,
`cexp = now + 20 400` → **200**, `x-accel-redirect: /__protected/wm/…`, `uses` still **1**, no
new row. Past `cexp` → **401 `continuation_expired`**, `uses` unchanged, no row (the token is
refused before the tenant database is opened).

### A consequence the errata did not state, and how the affected gates were kept honest

An idempotent mint means *the same client* re-redeeming inside six hours is a continuation, so
`max_uses` counts **clients**, not taps. `R3`, `R9`, `R10` and `G3`/`G4` all meant "a second,
independently counted use" and were re-redeeming from the same (absent) User-Agent. They now
redeem as a **different client** (`redeemAs(code, 'second-device/1.0')`, `G3`/`G4` with their
own UA on both the redeem and the file request, because the token binds `uah`). The assertions
are unchanged; the meaning of "a new token" now matches E-26's key. This is the same fact
E-26 records as "the resume key is the client, not the code".

### Mutation

`maySpend: … <= claims.exp` → `maySpend: true`: `R5b` and `R13` red. Restored byte-identical.

---

## 4 — §16 S3 row 9: the two holes

### (a) the arithmetic — `W13`

```
# W13 exp=iat+600 cexp=iat+21600; expires_at - cexp = 21600 s
#     (and cexp - exp = 21000 s, so exp+grace would be 6 h early); past-cexp 401 writes no row
```

The case reads the token's own `cexp` out of the minted cookie and asserts
`Date.parse(expires_at) === (cexp + 21_600) × 1000`, **and** `≠ (exp + 21 600) × 1000`. `W7` is
untouched: it sets the column itself and asserts the sweep, which is a different claim. The
case also asserts that a request past `cexp` writes **no render row and no event row** — it
never reaches the database.

### (b) the verifier — `bundle_verify.mjs`

Three independent refusals, because a manifest is a claim and the three can disagree:

1. a `files[]` path that is or is under `content/protected/`;
2. a `content/protected/` directory anywhere in the bundle **tree**, even when the manifest
   omits it (the omission is the likelier mistake);
3. a SQLite database in the bundle with **rows** in `cms_watermark_render`. The table existing
   is not a refusal: every `site.db` has it in its schema, and a verifier that refused the
   schema would refuse every real bundle.

Plus the symlink half: a link whose target resolves inside a `content/protected/` tree is
refused as a render. **This half was dead code**: the check called `statSync(full)`, which
follows the link and reports the *target's* type, so `isSymbolicLink()` was always false. It now
uses `lstatSync`, and resolves the target properly (absolute targets previously normalised to
nonsense). Found while writing `B4`; it is a defect of the same file, not a new rule.

### The negative controls — `test/bundle-verify.test.ts`

```
ok 1 - B1 — a clean bundle verifies, and says what it checked          (exit 0, "2 file(s) verified … no render tree, no render rows")
ok 2 - B2 — a bundle that CONTAINS a render is refused, exit 12       (QA measured exit 0 here)
ok 3 - B3 — the render present but OMITTED from the manifest is still refused
ok 4 - B4 — a symlink into content/protected/ is a render in the bundle
ok 5 - B5 — a site.db carrying render ROWS is refused; one carrying only the table is not
```

`B2` is the exact bundle QA built: `content/protected/wm/<spec>/<sha>.pdf`, `files[]` listing
it with a correct hash. Before: `exit 0, "1 file(s) verified"`. Now:
`bundle_verify: REFUSAL: a bundle must never contain a render: content/protected/wm/… is under
content/protected/ (§16 S3 row 9)`, exit **12** — the code `install.sh --verify` already
treats as a failed bundle.

**Stated plainly: this closes the verifier half only.** Nothing in this tree produces a bundle;
the writer is S4. The row's first sentence (the sweep) is `W7`, and now the arithmetic behind it
is `W13`.

---

## 5 — The gate, and every mutation run

```
$ make test        # twice, consecutively
# tests 417   # suites 10   # pass 417   # fail 0   # cancelled 0   # skipped 0
verify-dist: executing dist/ as a child process (E-28)
ok D1 (484 ms) · ok D2 (456 ms) · ok D3 (582 ms) · ok D4 (65 ms) · ok D5 (71 ms) · ok D6 (67 ms)
verify-dist: 6/6 passed — the artefact on disk is the one asserted
```

| item | mutation | red | green |
|---|---|---|---|
| E-28 | `stampWorkerUrl` → `.ts` | `verify-dist` D3 (503, `reason: renderer`) — and `W3`, 416/417 | D1, D2, D4–D6 |
| E-28 | worker excluded from the emit | `verify-dist` D3 only | **417/417** node suite; D1, D2, D4–D6 |
| E-28 | an unregistered `import.meta.url` under `app/` | `E28-2`, naming `app/download/rogue.ts:2` | `E28-1`, `E28-3` |
| E-27 | global `acquire` removed | `W6b` (peak 16 vs cap 4), `W14` | `W6`, `P-S3d-1` |
| E-27 | budget moved to after acquisition | `W14` (`queued_ms 2`), `W6`, `W6b` | — |
| E-26 | `maySpend` guard removed | `R5b`, `R13` | `R1`–`R12`, `R14` |
| row 9 | (a fixture, not a mutation) | `B2`–`B5` | `B1` |

Files mutated and restored, with hashes (all byte-identical):

```
app/download/render.ts   1af54349c1b3624a4cf8813ed92ee06711a14d68e54df8e079f2d1ec21dcc4e4
app/download/plane.ts    babd785c22d01fdca45386efc45d6056498d1116391df5fba517a71c8cee4026
tsconfig.json            206c659a4204c4588e4bcaa4efa4b822434d968c2b21156d1d51d2087e393300
```

`make test-perf`'s `P-S3d-1`/`P-S3d-2` were run on their own after the change
(`SKW_PERF_FORCE=1`, one box): 16 stamps → 16 renders, peak 8, effective cap 8; 40 pages cold
157 ms / second purchaser 199 ms / cache hit 1 ms against the 2,000 ms budget. The full
`make test-perf` was not re-run under the idle-box guard; it is not part of `make test`.

---

## 6 — What remains before S3 can be GO

1. **S3-5 — `nginx/templates/server.tmpl` is dead.** Nothing reads it, and a change made there
   reaches production never (QA's C4 first attempt stayed green with a byte-identical file).
   Deleting it is a one-line change and no gate has an opinion, which is exactly the problem.
   **Not in my brief; still open.**
2. **S4 — the bundle writer.** Row 9's exclusion now has a verifier and no author. Until the
   writer walks only `content/public` + `content/media` and refuses `content/protected`, the
   rule is enforced on the way in and unenforced on the way out.
3. **`sweep` is not in any gate at a fixed instant beyond `W7`.** `W7` covers the row and the
   file; the minute tick in `main.ts` is unasserted. Minor.
4. **`dist/` carries `dist/test/**` into the image** (`tsconfig.json` `rootDir: "."`, and
   `tools/regen_conf.ts` imports a test helper). E-28 records it as S4 packaging work; `D1`–`D6`
   make `dist/` the thing worth keeping small, so it is now more expensive to ignore.
5. **RSS is still unmeasured.** D33's ~50 MB/worker is round 2's number; the cap is the control
   and RSS is what an operator watches. Unchanged, and correctly outside `make test`.
6. **E-26's resume key is the client.** A buyer who changes network or browser spends a use to
   resume. That is D32's own key — recorded, not closed, by the errata itself.

Nothing in items 1–4 is a regression this pass introduced; item 2 is the only one that keeps
row 9 from being *closed* rather than *half-closed*.

---

## 7 — Three things I found that the errata did not say

1. **E-28's negative control is not reproducible as written.** It says `make test` stays
   `404/404` when `stampWorkerUrl` is reverted; `W3` asserts the `.js` string and reddens. QA
   had already measured `403/404`. The substitution is a different mutation in the same class
   (NC-2), and it produces the contrast the item is for.
2. **`bundle_verify`'s symlink check could never fire** (`statSync` follows links). Fixed with
   `lstatSync`; `B4` is its gate.
3. **`reason='queue'` and `reason='timeout'` are boundary-adjacent by construction.** With one
   uniform budget a waiter is always granted a slot at its own deadline, so `queue` is only
   reachable when a *different* store's hold outlasts the waiter's budget. Both branches are
   now gated (`W14` for `queue`, `W5` for `timeout`), and both have identical observable
   effects on the buyer: no worker, one `denied_watermark` row, no use spent, no file.
