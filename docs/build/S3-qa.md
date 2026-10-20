# S3 QA — assets, the farm, gated downloads, watermarking

**Slice:** S3 (S3a assets · S3b farm/renditions/D31 · S3c download plane · S3d watermarking).
**Tree:** `dafd9a3` (S3d) + the working tree. **`git status`:** clean at 22:23 when this review began. `docs/sds/02-errata.md` gained §12
(E-26..E-28, 483 lines) **at 22:31, during the review**, from another process — see §8.
**Gate:** `make test` **404/404, 0 failed, 0 skipped, RC=0**, three times. `make test-perf` **8/8, RC=0**.
**Verdict: NO-GO.** The download plane is the best-built thing in this repository; the slice is not done,
because two CEO decisions it was built against are not implemented, one acceptance row has no gate at
all, and the build has no gate that ever executes `dist/`.

---

## 1. The verdict, in one page

**What holds.** The money path is correct and adversarially tested. One use per token under 8 parallel
ranges over HTTP, 8 OS processes and a real nginx; insert-first accounting that survives 24 concurrent
threads (check 22) and 8 processes; `Range: bytes=1-` cannot buy a second read; an unknown selector and a
wrong secret are one status, one body and 1.003× in time over 1,000 trials; a garbage MAC is 401 and not
500; `报告.pdf` is `filename*=UTF-8''…`; `bytes_declared` is what nginx sent and `bytes_sent` is NULL.
Watermarking fails closed on a **real** worker termination, a **real** `pdf-lib` exception and a **real**
filesystem fault (my D1), and recovers on the next redemption with the denial costing nothing. A gated
asset has no farm link and a forced `X-Accel-Redirect: /media/<gated-key>` is a 404 — the same 153-byte 404
a key that never existed gets. Every mechanism I broke went red (six runs over five mechanisms) and every
file came back byte-identical.

**What does not.** Four things, in order of how much they will cost:

1. **D33 is not implemented — there is no global semaphore.** `app/download/render.ts` has one
   `Semaphore` per tenant key and nothing else. Measured: **32 renders in flight at once across 4
   tenants**, against D33's `max(4, cores)` = **8** on this 8-core box. At D33's own ~50 MB per worker
   that is ~1.6 GB of worker memory on a box that is also serving pages. Four times the stated ceiling.
2. **The 2 s budget does not cover the queue.** The timer starts inside the acquired slot
   (`render.ts:341`), so a request waits for a slot with no deadline and then starts its two seconds.
   Measured: **8 of 24** requests took longer than 2,000 ms (max 2,163 ms) and were served 200.
3. **D32 is not implemented — there is no continuation grace.** An expired token is
   `401 SKW_E_SEC_TOKEN_INVALID` at `token.ts:134`, so §7.4's grace is unreachable; and a re-mint is not
   idempotent, so a resume **costs a use**: measured `uses 1 → 2`, two `first:ok` rows.
4. **One §16 S3 row is not covered.** "a render … never appears in a bundle" — there is no bundle writer
   in the tree, and `tools/bundle_verify.mjs` happily verifies a bundle that **contains** a live render
   (exit 0, "1 file(s) verified"). The exclusion is a property of a writer that does not exist.

None of the four is a mistake in code that was written. All four are the same shape: a sentence in a
frozen document that no code and no gate makes true.

---

## 2. A — the gate, run three times

```
$ make test     # 22:23  404 tests, 404 pass, 0 fail, 0 skipped, EXIT=0, 64,709 ms
$ make test     # 22:26  404 tests, 404 pass, 0 fail, 0 skipped, EXIT=0, 63,634 ms
$ make test     # 22:33  404 tests, 404 pass, 0 fail, 0 skipped, EXIT=0, 65,743 ms
```

`grep -c '^not ok'` = **0** in all three. Logs: `scratch/qa-s3/test-run{1,2,3}.log`. Phase order is
`verify-toolchain → verify-gitignore → verify-schema → verify-claims → verify-frozen → build → typecheck →
the node suite`, and `verify-claims` reported **27/27 passed, 0 skipped** in each run, including check 22
(the 24-thread one-`jti` case: `24 concurrent threads, one jti -> uses=1, first rows=1; cap 2 reached ->
J3 outcome=denied_quota uses=2 (0 rows updated); Range row writes=1, uses=2`).

```
$ make test-perf
  box: 8 cpus, 1-min load average 5.37
  WARNING: load 5.37 is over half the core count …
8 tests, 8 pass, 0 fail, 0 skipped, EXIT=0, 43,942 ms
```

The load guard **did not refuse** this time (it refused at 10.65 and 12.98 for S3c/S3d). The banner's own
warning is worth quoting because every number below was taken under it. The perf numbers:

```
# P-S3c-1 medians: unknown-selector 12.14 ms, wrong-secret 12.17 ms (1.003x; tolerance 0.2x),
#         p10 11.49/11.46 ms, p90 13.68/13.67 ms over 1000 trials each
# P-S3c-2 random-selector median 11.69 ms over 50 trials
# P-S3d-1 16 stamps -> 16 renders, peak in flight 8, cap 8
# P-S3d-2 40 pages: cold 214 ms, second purchaser 206 ms, cache hit 0 ms (budget 2000 ms)
# P-1 0.0313 0.0150 0.0123 0.0196 0.0155 ms (budget 1.5)   # P-2 74.4 ms refusal   # P-3 0.0157 ms
```

---

## 3. B — §16 S3, row by row

The table is SDS §16 S3's, in its order. "Command" is the command I ran; the `ok` line is from
`scratch/qa-s3/test-run3.log` unless stated.

| # | Acceptance criterion | Command | Real output | Verdict |
|---|---|---|---|---|
| 1 | 8 parallel `Range` requests under one token spend **one** use | `make test`; `node --test --test-name-pattern=R1 test/download-redeem.test.ts` | `ok 186 - R1 — 8 parallel Range requests under one token spend exactly one use and write one row`; `ok 182 - C1. 8 processes, one jti: one redemption, seven continuations, one row`; `ok 306 - G4` (through nginx) | **PASS** |
| 2 | two different tokens spend two | same | `ok 187 - R2`; `ok 183 - C2 — 8 processes, two jti: two uses, two rows` | **PASS** |
| 3 | `Range: bytes=1-` cannot bypass the counter | same | `ok 188 - R3`; `ok 189 - R3b` (oversized clamped, one use, `bytes_declared` = the render); `ok 190 - R3c` (unsatisfiable → 416, no event, nothing spent) | **PASS** |
| 4 | unknown selector vs wrong secret: same status, body and time, medians within 20 % | `make test-perf` | `ok 1 - P-S3c-1 … 12.14 ms vs 12.17 ms (1.003x)` over 1,000 trials each, alternating | **PASS** (load 5.37; see §7) |
| 5 | oversized/garbage token → 401, never 500 (MAC length check) | `make test` | `ok 192 - R5. a garbage or oversized token is 401, never 500` (6 cases incl. an 8-byte MAC); `ok 193 - R5b` | **PASS** |
| 6 | `报告.pdf` → `filename*=UTF-8''…`, 200 | `make test` | `ok 194 - R6`; `ok 303 - G1` (the same header through nginx) | **PASS** |
| 7 | watermark timeout denies 503 + `denied_watermark`; **no un-stamped byte** | `make test`; my `probe-d1.ts` | `ok 206 - W4`; `ok 207 - W5`; D1a/D1b/D1c below — real fault, 503, one row, no header, recovery | **PASS** for a stampable asset; **stated gap** for archive/video/audio (`ok 213 - W11` serves a gated zip from `content/media/`, un-stamped — §7.5's coverage list, and the case says so) |
| 8 | `encrypted=1` refused at **issue**, asset named | `make test` | `ok 177 - I4. an encrypted PDF is refused at issue, naming the asset` — `422 SKW_E_DM_ASSET_UNSTAMPABLE`, `detail.asset.key='vault/locked'` | **PASS** |
| 9 | a render is deleted at token expiry + grace **and never appears in a bundle** | `make test`; my `probe-d5.ts` | sweep half: `ok 209 - W7 … sweep -> rows 1, files 1; next request re-stamped … -> 200`. Bundle half: `bundle_verify` on a bundle containing a live render → **exit 0, "1 file(s) verified"** | **NOT COVERED** |
| 10 | `bytes_declared` = authorised `Content-Length`; `bytes_sent` NULL | `make test` | `ok 303 - G1 — … content-length 1217 bytes_declared 1217 bytes_sent null uses=1`; `ok 195 - R7` (a range records 10, not the file size) | **PASS** |

**9 PASS, 1 NOT COVERED, 0 FAIL.**

Row 9's two halves fail differently and both matter:

* the sweep is gated, but **the arithmetic is not**. `W7` sets `expires_at` into the past itself, so
  nothing asserts that the value written at stamp time is `token exp + grace`. I read it in `plane.ts:459`
  (`claims.exp + this.#graceSeconds(db)`) — a code reading, not a gate. Under E-26 it must become
  `cexp + grace`, and no gate will notice if it does not.
* the bundle half **cannot** be gated today: there is no bundle writer (`tools/bundle_verify.mjs` verifies
  a manifest; nothing produces one — S4 owns it). My D5 is the strongest available substitute and it
  shows the exclusion is nobody's job: a bundle that contains `content/protected/wm/…` verifies clean.
  This row is mis-scoped for S3; it belongs to S4, or S3 owes the writer's exclusion rule and a
  `bundle_verify` refusal.

---

## 4. C — the negative controls

Six runs over five mechanisms. Each: hash → back up → break exactly one thing → run the owning gate →
restore → hash again. **Every file came back byte-identical.**

### C1 — one-use accounting (`app/download/ledger.ts`)

Break: `if (inserted.changes === 1)` → `if (true)`, so the counter moves whatever the ledger said.

```
sha256 before:   e6b27e8b714aeed41905fc3de5f6a1f53d171cda71ce23bcf565ef805c21c289
sha256 broken:   3a5517b5991ac7362f9753e846912c31fafbd948ba669e698fc365c282afd318
not ok 1 - C1. 8 processes, one jti: one redemption, seven continuations, one row
not ok 2 - C2 — 8 processes, two jti: two uses, two rows
# pass 1 / # fail 2 / exit=1
sha256 restored: e6b27e8b714aeed41905fc3de5f6a1f53d171cda71ce23bcf565ef805c21c289   RESTORE: IDENTICAL
```

### C2 — the gated-absence 404 (`app/assets/farm.ts`)

Break: the `access_class === 'gated'` branch no longer matches, so a gated asset gets a farm link.

```
sha256 before:   c04523cb1e94d91730694bef2d6eaa61c14215d929261a75b30dff3db178aa2b
sha256 broken:   2da72f3402379adb66f05a3e7d401d8ec0defe022d5d2b4154bf9465a0cca079
not ok 1 - F2 — a gated asset has NO link, by key and by checksum; flipping it public creates one
# pass 0 / # fail 1 / exit=1
sha256 restored: c04523cb1e94d91730694bef2d6eaa61c14215d929261a75b30dff3db178aa2b   RESTORE: IDENTICAL
```

### C3 — the watermark fail-closed path (`app/download/plane.ts`)

Break: `if (stampable(asset) !== null)` → `if (false)`, so a stampable asset silently falls back to
`content/media/` — the exact M3 mutation S3d claims, run against W4.

```
sha256 before:   ed1c94bceb843cda97a5f07ed381488ec5b0ffbfd1872bd4f6a2a5c2ebc2ecfc
sha256 broken:   0f66220f560e5c2feea82e4db9e65b6ac0eddcf5c263d967db9b68f1753cd0ec
not ok 1 - W4 — a stamp failure is 503, writes denied_watermark, and emits no X-Accel-Redirect
  error: Expected values to be strictly equal:  200 !== 503
# pass 0 / # fail 1 / exit=1
sha256 restored: ed1c94bceb843cda97a5f07ed381488ec5b0ffbfd1872bd4f6a2a5c2ebc2ecfc   RESTORE: IDENTICAL
```

**The first attempt at this control was invalid and is recorded as such.** The mutation string carried a
shell-escaped `\&\&`, which produced a TypeScript *syntax error*; the file went red on a parse failure, not
on W4's assertion. A red gate for the wrong reason is not a control. It was re-run with `if (false)`, and
the failure above is the assertion (`200 !== 503`), not a parse error.

### C4a — the farm served without Node, header half (`tools/nginx_gen.ts`)

Break: the `/media/` location's `Cache-Control: … immutable` → `no-store`.

```
sha256 before:   2bb303d0b5ee52445bfad01317ff88b40d412d5350528469ba031f0d845b26ff
sha256 broken:   571ce5ee8ace7538122d016c6e2c000a650be2c4c3513f3f0e36f0e2ca05e5b5
not ok 1 - N1 — with the app killed, /media/<key> is a 200 …
  error: The input did not match the regular expression /immutable/. Input: 'no-store'
# pass 0 / # fail 1 / exit=1
sha256 restored: 2bb303d0b5ee52445bfad01317ff88b40d412d5350528469ba031f0d845b26ff   RESTORE: IDENTICAL
```

### C4b — the farm moved behind Node, config shape (`tools/nginx_gen.ts`)

Break: `alias /srv/content/public/; try_files $uri =404;` → `proxy_pass http://app:3000;`, i.e. `/media/`
would go through the app.

```
sha256 before:   2bb303d0b5ee52445bfad01317ff88b40d412d5350528469ba031f0d845b26ff
sha256 broken:   b35ee7876ff5b62be38149a0941236378a19ae4461f1bdc501b1eb8149506b3d
not ok 1 - N1 …
  error: The input did not match the regular expression
         /location \/media\/ \{[\s\S]*?alias \/srv\/content\/public\/;[\s\S]*?try_files \$uri =404;/
# pass 0 / # fail 1 / exit=1  (the file-level hook fails before the body: the gate refuses a generator
#                               change that would stop it testing the edge)
sha256 restored: 2bb303d0b5ee52445bfad01317ff88b40d412d5350528469ba031f0d845b26ff   RESTORE: IDENTICAL
```

C4's first attempt mutated `nginx/templates/server.tmpl` and the gate **stayed green with a byte-identical
file** — because **nothing in the tree reads `server.tmpl`**. It is a dead copy of the config. See §7,
defect S3-5.

### C5 — D31's publish refusal (`app/sources/publish.ts`)

Break: `{ defaultAboveMax: 'refuse' }` → `{ defaultAboveMax: 'clamp' }`.

```
sha256 before:   82e0077135bd2e8de1d04fa69379794c3ffb71dd58d425b3daea610f2da043f2
sha256 broken:   2033f7eae9f20607d7e229f6eeb823968fc894ee9d78f228298d16db24b0241a
not ok 2 - D31-1. publish refuses limit_default > limit_max, names the field, and writes no row
# pass 3 / # fail 1 / exit=1     (only its own case reddens; D31-0/2/3 stay green)
sha256 restored: 82e0077135bd2e8de1d04fa69379794c3ffb71dd58d425b3daea610f2da043f2   RESTORE: IDENTICAL
```

That exclusivity is the point: the publish refusal, the render clamp (`D31-2`) and the compile clamp
(`D31-3`) are three witnesses of three different branches, and removing one reddens one.

Logs: `scratch/qa-s3/controls.log`, `controls-c3.log`, `controls-c4b.log`.

---

## 5. D — the six defeat attempts, on the real system

Probes are mine, in `scratch/qa-s3/`, run against `buildApp` and a real `site.db`; D3/D6 through
`nginx:1.31-alpine` with the generated conf. Raw logs are named per attempt.

### D1 — denial under a real fault (not an injected renderer)

`probe-d1.ts`. Three faults, none of them a stub:

```
# D1 shipped budget 2000 ms, per-tenant cap 8
# D1a huge.pdf (12000 pages) -> 503 SKW_E_SEC_WATERMARK_FAILED in 2010 ms, x-accel=undefined,
      disposition=undefined, bodyHasPDF=false, rows=[denied_watermark/0], uses=0
# D1a retry same token -> 503 SKW_E_SEC_WATERMARK_FAILED, rows=[denied_watermark/0], uses=0
# D1b truncated pdf -> 503 SKW_E_SEC_WATERMARK_FAILED, x-accel=undefined, disposition=undefined,
      bodyHasPDF=false, rows=[denied_watermark/0], uses=0
# D1c read-only render tree -> 503 SKW_E_SEC_WATERMARK_FAILED, x-accel=undefined,
      rows=[denied_watermark/0], uses=0
# D1c next redemption -> 200, x-accel=/__protected/wm/…, bodyBytes=0,
      rows=[denied_watermark,ok], uses=1, render tree mode=700
```

* **D1a is the kill.** A 12,000-page PDF really crossed 2,000 ms, so `Worker.terminate()` really fired
  mid-stamp — not `Promise.race` against a fake. 2,010 ms, one ledger row, no header, `uses=0`.
  A `worker_threads` worker cannot be `SIGKILL`ed from outside the process without killing the app
  (it is a thread, not a child), so the runtime's own `terminate()` and a real renderer exception are the
  two deaths that exist; both are exercised.
* **D1b** is a genuinely truncated PDF (`pdf-lib`: "Failed to parse invalid PDF object"). Same shape.
* **D1c is the recovery half.** A real filesystem fault (the render tree unwritable) → 503, one row,
  `uses=0`; then the fault is removed and the *same code* re-redeemed: 200, a fresh render, `uses=1`,
  rows `[denied_watermark, ok]`. The denial cost nothing and the next redemption works.

Verdict: the fail-closed path holds under a real fault, and the buyer's entitlement survives it.

### D2 — continuation (`probe-d2.ts`)

```
# D2 mint+download -> 200, jti 2676d465…, uses=1, rows=[first:ok]
# D2a expired 100 s ago (inside the 21600 s grace), Range resumed -> 401 SKW_E_SEC_TOKEN_INVALID,
      uses=1, rows=1, x-accel=undefined
# D2b expired 24,400 s ago (past the 21600 s grace) -> 401 SKW_E_SEC_TOKEN_INVALID, uses=1, rows=1
# D2c re-mint -> 303, same jti as the first mint: false, download -> 200, uses=2,
      rows=[first:ok,first:ok]
# D2 grace setting: {"key":"download.continuation_grace_s","value_json":"21600"}
```

All three D32 clauses are absent:

| D32 clause | Measured |
|---|---|
| an expired token resumed inside the grace window works, and spends nothing | **401**, refused |
| past the grace window it refuses | 401 — correct, but for the wrong reason (`exp`, not `cexp`) |
| a mint inside the window returns the same `jti`, so a resume is not a free extra use | **a new `jti`; the resume spends a second use** (`uses 1 → 2`) |

The setting exists (21,600) and is read, but only to date a render. An 800 MB file at `limit_rate 1m`
takes 800 s; the transfer itself survives (nginx streams after the redirect) but any resume after 600 s
is a 401 and a re-typed code — and with the default `max_uses=3`, two dropped connections spend the
whole entitlement.

Note `R5b` (`ok 193`) is the gate that pins the current behaviour: an expired token is 401. It is green,
and it is green *against* D32. E-26 (which landed during this review) resolves that by superseding R5b's
*sentence* while keeping its assertion for the token R5b actually builds.

### D3 — the hand-off cannot reach a gated blob (`probe-d3.ts`)

A stub upstream emits the header the shipped plane deliberately never emits. The **control** matters:
without it, a 404 below would prove only that nginx ignores `X-Accel-Redirect`.

```
# D3 /public-media     -> 200, 30 B, sha256 4f100c99, publicBytes=true   <- CONTROL: nginx follows the header
# D3 /gated-media      -> 404, 153 B, sha256 9f6d0b63, pdf=false, publicBytes=false
# D3 /gated-protected  -> 200, 200 B, sha256 25be815f, pdf=true
# D3 /traverse         -> 404, 153 B, sha256 9f6d0b63, pdf=false
```

A forced `/media/vault/book.pdf` for a gated asset is nginx's 153-byte 404 — byte-identical to the
`/traverse` refusal and to the missing-key 404 `N2` records (`9f6d0b63`). The blob is never served. The
absence of the farm link is the whole defence, and it holds.

Two things this also shows, stated rather than buried:

* `/__protected/<hh>/<sha>.pdf` **is** reachable when the app names it (200, the store blob). That is the
  trust model — the app is the authoriser — but it means the edge has no second line for the direction
  that matters most: a bug in the stamp branch that emitted `storage_path` would serve an un-stamped
  gated blob and the edge would not refuse it. `W3`/M1 cover the code path; nothing covers the header.
* `/media/../__protected/…` is normalised and refused (404), so traversal is not the way in.

### D4 — 32 simultaneous redemptions across 4 tenants (`probe-d4.ts`)

```
# D4 cores=8, D33 global cap would be max(4, cores)=8, per-tenant cap 8
# D4 32 downloads in 184 ms, statuses [[200,32]], renders=32
# D4 PEAK renders in flight at once (4 tenants x 8) = 32
# D4 per-tenant peak t1 = 8   t2 = 8   t3 = 8   t4 = 8
# D4 accounting t1: uses=8, events=[{"outcome":"ok","n":8}]   … t2, t3, t4 identical
```

**Peak 32 against a cap of 8.** The instrument is verified in both directions: it reports exactly 8 per
tenant (the per-tenant semaphore is real and binding) and 32 in total (there is nothing else). Accounting
is exact under the burst — 8 uses and 8 `ok` rows per tenant, 32 renders for 32 distinct buyers, no
coalescing.

The injected renderer is the right instrument here: the semaphore's job is to bound *entries*, and the
count is taken inside it. `P-S3d-1`'s own peak is measured the same way.

**D4b — the budget does not cover the queue** (`probe-d4b.ts`), same tenant, shipped cap 8, 700 ms renderer:

```
# D4b 24 concurrent first-downloads, cap 8, renderer holds 700 ms, budget 2000 ms
# D4b all settled in 2165 ms; peak in flight 8; 200s 24/24;
      per-request min 722 / p50 1446 / max 2163 ms
# D4b requests whose TOTAL exceeded the 2000 ms budget: 8/24 (statuses [200])
```

Eight of twenty-four requests took longer than the 2,000 ms budget and were served 200, because the timer
starts after the slot is acquired. At 32 tenants' worth of load the tail is what the buyer sees, and
nothing in the code bounds it.

### D5 — a bundle with a gated asset and a live render (`probe-d5.ts`)

```
# D5 download -> 200, hand-off /__protected/wm/bede5f5b53ce91252f416905c34591875e21c6a12daa…
# D5 live render: protected/wm/bede5f5b…/be… (1862 B, sha256 0d340980)
# D5 export trees: content/public 2 entries, content/media 4 entries,
      entries naming the render or 'protected': 0
# D5 symlinks under content/public that resolve into content/protected: 0
# D5 bundle_verify on a bundle that CONTAINS the render -> exit 0: bundle_verify: 1 file(s) verified
```

The two trees an exporter can walk are clean — the render is under `content/protected/wm/`, no public
symlink resolves into it, and no entry names it. **But nothing refuses a bundle that carries one.** The
verifier checks hashes; it has no notion of an excluded tree. The row is not covered, and the honest
statement is that the exclusion must be a rule in the S4 writer plus a refusal in the verifier — the
`linksPointingAt` helper S3b built is not wired into anything.

### D6 — the farm at the instant of a rename and of a delete (`probe-d6.ts`)

```
# D6-R 24 renames, request issued immediately (slowest rename 4.93 ms):
      [["new:200",2],["old:404",24],["new:404",22]], servedBytesNotTheAsset=0
# D6-R container could see the new link immediately in 3/24 cases (host always could);
      edge settled to 200 in p50 53.5 ms / p95 853.9 ms / max 860.6 ms
# D6-D 12 deletes (each after a rename), request issued immediately: [[404,12]], bytesServedAfterDelete=0
# D6 log: ' 500 ' occurrences=0, 'open() … failed' occurrences=0
```

Read honestly, this is **two facts and one artefact**:

* **no 500s** — zero ` 500 ` in nginx's error log across 24 renames and 12 deletes, and zero failed
  `open()`. The `[crit] stat() … (22: Invalid argument)` lines are the bind mount, not a 500, and nginx
  still answered 404.
* **no stale bytes** — every 200 served the asset's own sha256 (`servedBytesNotTheAsset=0`), including the
  two settles inside the loop and the delete half (`bytesServedAfterDelete=0`).
* the 22 immediate 404s are **the mount, not the farm**: in only 3 of 24 cases could the *container itself*
  see the link that the host had just written; the edge caught up in a p50 of 53.5 ms and a p95 of 854 ms.
  The farm's own view was verified separately: after each rename the host tree holds exactly the new
  link and nothing else (`scratch/qa-s3/try-rename.ts`).

That lag is a deployment property worth knowing (a key renamed a millisecond ago can 404 for most of a
second on a Docker-Desktop bind mount), but it is the mount's clock, not the farm's correctness. On a real
Linux bind mount it will be far shorter and it is still not zero — the farm has no atomic switch, by
design, because the 301 half is a config reload anyway.

---

## 6. E — the two builder flags, judged

### (i) "per-tenant 8 × N workers, now bounded by D33" — the bound is not there, and it is not close

**The global semaphore does not exist.** `app/download/render.ts` holds `#semaphores: Map<string,
Semaphore>` (one lazily created per tenant, `:207–213`) and `STAMP_CONCURRENCY = 8`. Nothing in `app/`
creates a second semaphore — `grep -rn 'global' app/` returns nothing on this path.

**Measured, not inferred:** 32 renders in flight across 4 tenants against `max(4, cores) = 8` on this
8-core box. D33's own number — ~50 MB per worker — puts that at ~1.6 GB of worker memory, on a process
that is also serving pages and holding every site's SQLite handle. D33's floor of 4 is likewise absent.

**And the bound D33 assumes is not the only one missing.** The 2,000 ms budget starts *inside* the slot, so
the queue is unbounded in the dimension that hurts a buyer: 8 of 24 requests over budget and still served
200. E-27 names both halves (the semaphore and the arrival-time budget) and prescribes the acquisition
order (tenant, then global) and the `reason='queue'` denial. None of it is implemented.

Judgment: **D33 is unimplemented, the flag was correct, and the risk has not moved.** The fix is small and
local — one `Semaphore(max(4, os.availableParallelism()))` on the store, acquired second, plus moving the
timer to arrival — but it is a change to the money path and needs `W6` (two tenants, injected capacity 4)
and `W14` (queue deadline) as its gates, exactly as E-27 says.

### (ii) "the compiled-dist-only worker-URL bug" — one gate now catches the literal, none executes `dist/`

**Is there a gate that would have caught it?** Partly, and the distinction is the whole finding.

I restored the pre-fix resolver (`const suffix = '.ts';` — always the `.ts` sibling) and ran the suite:

```
$ make test   (with the .ts-only worker URL)
# tests 404   # pass 403   # fail 1
not ok 205 - W3 — the handed-off path is under content/protected/, never content/media/
  error: The input did not match the regular expression /\/dist\/app\/download\/stamp-worker\.js$/
         Input: '…/dist/app/download/stamp-worker.ts'
sha256 restored: 8b968bbebf4ffbcf3dad4d3db939c4231bca5d45f52904e474c926cc432a5f25   RESTORE: IDENTICAL
```

So the *exact reverted line* is caught — by `W3`, which checks both shapes and `existsSync` on the `.ts`
one. But `W3`'s `.js` half is a **string** match. It never stats the file, never starts a worker, and never
runs a line from `dist/`. The class is therefore still open: a resolver that returns the right-shaped path
in the wrong place — a layout change, an excluded emit, an image that does not copy the worker — passes
`W3` and 503s every download.

Measured, from the built tree:

```
$ npm run build && node scratch/s3d/probe-dist.mjs     (shipped source, restored)
worker url: …/dist/app/download/stamp-worker.js
renders: 2 distinct spec: 2 ; sizes 1886/1889 ; files differ: true ; probe exit=0

$ (same build, with the .ts-only resolver)
worker url: …/dist/app/download/stamp-worker.ts
AppError: the watermark could not be rendered: Cannot find module '…/dist/app/download/stamp-worker.ts'
  { code: 'SKW_E_WATERMARK_FAILED', status: 503, detail: { reason: 'renderer', budget_ms: 2000 } }
probe exit=1
```

**What should exist.** E-28's `make verify-dist`: a target wired into `verify`, running `dist/` as a child
process, with D3 — one redemption end to end asserting `x-accel-redirect: /__protected/wm/…` and that the
named file exists and is not the blob — plus the register (`test/dist-witness.test.ts`) that fails on any
unclaimed `import.meta.url` / `process.argv[1]` / `process.cwd()` / `require.resolve` under `app/` and
`tools/`. That is the right shape: the gate must execute the artefact, not call a function that computes a
string, because the defect lives in the difference between the two worlds and only one of them ships.

The rest of E-28's audit also checks out: `dist/` carries the test tree (`dist/test/…`) and
`tools/regen_conf.ts` resolves `REPO` to `…/dist`, so `node dist/tools/regen_conf.js` cannot work — neither
is shipped, and neither is gated.

---

## 7. Defects

| id | Severity | What | Evidence |
|---|---|---|---|
| S3-1 | **Blocker** | **No global watermark semaphore (D33).** 8 × N workers; measured 32 in flight on 4 tenants against a cap of 8. ~1.6 GB of workers on a box also serving pages. | D4; `render.ts:207–213` |
| S3-2 | **Blocker** | **No continuation grace, and a re-mint is not idempotent (D32).** An expired token is 401, so a resume costs the buyer a use; measured `uses 1 → 2`. §7.4's grace is unreachable code. | D2; `token.ts:134` |
| S3-3 | **Major** | **No gate executes `dist/`.** The reverted worker URL is now caught by `W3`'s string check, but existence/layout in the shipped artefact is proved by nothing; that class already produced a 100 % download outage with 404/404 green. | §6(ii); E-28 |
| S3-4 | **Major** | **The 2 s budget excludes the queue.** The timer starts after acquisition; 8/24 requests over budget, served. | D4b; `render.ts:341` |
| S3-5 | **Major** | **`nginx/templates/server.tmpl` is dead.** Nothing reads it; `tools/nginx_gen.ts` builds the config in TypeScript. S3b and S3d both list it as modified, and a change made there reaches production never — and no gate notices, because the gate regenerates from the generator. | C4's first attempt: mutate the template → gate **green**, file byte-identical; `grep -rn server.tmpl` finds only docs |
| S3-6 | **Major** | **§16 row 9 has no gate for the bundle half.** `bundle_verify` accepts a bundle containing a live render (exit 0). No writer exists, so nothing enforces the exclusion; `linksPointingAt` is unwired. | D5 |
| S3-7 | Minor | **The render's `expires_at` arithmetic is unasserted.** `W7` sets the column itself; nothing proves it is written as `exp + grace` (and it must become `cexp + grace`). | §3 row 9 |
| S3-8 | Minor | **A gated archive/video/audio is served un-stamped** from `content/media/` (`W11`), and `/__protected/` still aliases the store, so any future code path that emits that URI serves the shared blob. Stated in §7.5; a product decision, not a bug — but "no un-stamped byte" is unconditional prose. | `ok 213 - W11`; D3's `/gated-protected` 200 |
| S3-9 | Minor | `dist/` carries `dist/test/**` into the image (E-28's "recorded, not closed"). | `tsconfig.json` `rootDir: "."` |

**No GO with an open blocker**, and S3-1/S3-2 are blockers: both are CEO decisions in `IDEA.md` §13 that
the slice was built against, both are now errata of record (E-26/E-27), and both are measurably absent.

### The one thing most likely to break in week one

**The first real campaign email.** Fifty buyers clicking at once is normal for a launch, and each click
that reaches a gated PDF is a `pdf-lib` worker of ~50 MB. With no global cap, four active tenants put 32
workers (~1.6 GB) into a process that is also holding every site's SQLite handle and answering pages; the
first symptom will not be a slow download, it will be the OOM killer choosing a victim — possibly nginx,
which takes the whole box down. The queue behind those workers has no deadline, so the buyers who are not
killed by the OOM wait past the 2 s budget that was supposed to protect them (8 of 24 measured).

Second, if the client's book is large and their connection is not: the first buyer whose download is
interrupted after ten minutes gets a 401, re-types the code, and spends a second of three uses.

---

## 8. Method, tree state, and what I could not gate

**The tree moved under the review.** `docs/sds/02-errata.md` gained §12 (E-26 continuation, E-27 global
semaphore, E-28 dist gate — 483 lines) at **22:31**, between my first and second `make test` runs. It is
the Architect's, not mine, and it is uncommitted. It does not change any code, and `make test` stayed
404/404 across its arrival (`verify-frozen` quotes none of the blocks it adds, as the errata itself says).
It does change the *specification of record*: after 22:31, D32 and D33 are frozen text with prescribed
tests (`R13`, `R14`, `W13`, `W6`-extended, `W14`), and E-28 prescribes the gate S3-3 says is missing. My
verdict is against the code, not against that document; the document makes the two blockers harder to
argue with, not easier.

**Files I mutated and restored, with hashes.** All six are byte-identical to their pre-review state; the
only untracked path is `scratch/qa-s3/`.

```
app/download/ledger.ts          e6b27e8b714aeed41905fc3de5f6a1f53d171cda71ce23bcf565ef805c21c289
app/assets/farm.ts              c04523cb1e94d91730694bef2d6eaa61c14215d929261a75b30dff3db178aa2b
app/sources/publish.ts          82e0077135bd2e8de1d04fa69379794c3ffb71dd58d425b3daea610f2da043f2
app/download/plane.ts           ed1c94bceb843cda97a5f07ed381488ec5b0ffbfd1872bd4f6a2a5c2ebc2ecfc
app/download/render.ts          8b968bbebf4ffbcf3dad4d3db939c4231bca5d45f52904e474c926cc432a5f25
tools/nginx_gen.ts              2bb303d0b5ee52445bfad01317ff88b40d412d5350528469ba031f0d845b26ff
nginx/templates/server.tmpl     f24e0bdf5d8b4a7a4021d213ae6a60e497f001a33ea52789f59ed4b1013cec71
```

`git status --short` at the end: `M docs/sds/02-errata.md` (the Architect's, pre-existing this review) and
`?? scratch/qa-s3/`. `dist/` was rebuilt from the restored sources and `node scratch/s3d/probe-dist.mjs`
re-run green after the last mutation, so the artefact on disk is not a poisoned one.

**What I could not gate, said plainly.**

* **A `worker_threads` kill.** The watermark worker is a thread, not a child process, so no signal can
  kill it without killing the app. I exercised the two real deaths that exist — the runtime's own
  `terminate()` at the budget (2,010 ms, a real 12,000-page render) and a real `pdf-lib` exception on a
  truncated file — and a real filesystem fault for the recovery half. A whole-process `SIGKILL` mid-stamp
  was not useful: the client gets a connection error, not a 503, so it proves nothing about the branch.
* **The bundle row.** No bundle writer exists. My D5 is the strongest available substitute and it is
  reported as NOT COVERED rather than dressed up.
* **`nginx -s reload` with a request in flight against `/__protected/wm/`** (S3d §9.6) — not covered by any
  gate; I did not add docker/reload choreography for it.
* **The image watermark's legibility on a dark photograph** (S3d §9.5) — a judgement for a human looking at
  a file. `W12` proves two buyers get different bytes and a valid 320×240 PNG; nobody has looked.
* **RSS.** Neither suite measures it, and D33's 50 MB/worker is round 2's number. The cap is the control;
  RSS is what an operator watches.

**What would flip this to GO**, in order: (1) the global semaphore and the arrival-time budget, with
`W6`'s two-tenant case and `W14` (`S3-1`, `S3-4`); (2) `cexp`, the two windows and the idempotent mint,
with `R13`/`R14` (`S3-2`); (3) `make verify-dist` with D3 and the register (`S3-3`); (4) either a
`bundle_verify` refusal for `content/protected/**` or the row moved to S4 with its owner named (`S3-6`);
(5) delete `nginx/templates/server.tmpl`, which is a trap with no reader (`S3-5`).

---

# Round 2 — the four fixes, the new surface, and the regression sweep

**Tree:** `1d80374` ("S3 fix: verify-dist (E-28), global stamp gate (E-27), two expiries (E-26), row-9
gates"), clean at 23:24 when this review began. **Gate:** `make test` **417/417, 0 failed, 0
skipped, RC=0** twice (87.92 s, 93.30 s); `verify-dist: 6/6 passed` inside both. The node suite
alone is 66.2 s; every probe below is mine, in `scratch/qa-s3r2/`.

**Verdict: GO on the four items — all four close, each one proved by breaking it — and no open
blocker.** Two majors are left, neither of them a blocker: the E-28 register cannot see the class
it exists to catch grow inside a file it already lists (the same class as S3-3, which was Major),
and a burst of ~32 simultaneous buyers loses ~30 % of its downloads to the queue deadline (a
product defect, fail-closed, no entitlement lost). Both are stated below with numbers.

| round-1 item | closed? | how it was broken, and what went red |
|---|---|---|
| 1 · E-28 `verify-dist` | **yes** | resolver → `.ts`: `verify-dist` **1 of 6 failed (D3)**, node suite **416/417 (W3)**; each of D1–D6 reddens when its own `dist/` artefact is removed |
| 2 · E-27 `StampGate` | **yes** | 32 requests on a cap of 4: 28 measured *waiting* while 4 rendered, all settled, no hang, slots drain to 0; 24/24 refused behind 8 held slots reproduced (23 `queue`, 1 `timeout`) |
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

The curve is not smooth because the service time is uniform and the waves quantise, and 24 is a
coin flip rather than a line: **0/24 in the run above (max latency 1 954 ms — four milliseconds
inside the budget) and 3/24 in this one.** Below 24 nothing was refused in any run; from 32 upward
between a quarter and a half of legitimate first-downloads answer 503. A 24-buyer burst is already
at the edge; a 32-buyer burst is past it.

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

**And the reason code an operator will never see.** Almost every production refusal above is
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
