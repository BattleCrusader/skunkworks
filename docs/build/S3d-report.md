# S3d — per-purchaser watermarking, fail-closed

**Slice:** S3d (the last of §16 S3). **Scope items:** 5 of 5.
**`make test`:** 404/404, 0 failed, 0 skipped, RC=0 (`scratch/s3d/out/make-test.txt`).
**`make test-perf`:** the two new cases pass standalone; the gate itself was **refused by the
load guard** (load 10.65 on 8 cpus), exactly as `S3c-report.md` §10 recorded — the numbers below
are from the individual run and say what load they were taken at.

---

## 1. What was built

| File | What it is |
|---|---|
| `app/download/cp1252.ts` | **The one sanitiser.** Full 256-entry cp1252 table, a transliteration table for what cp1252 cannot carry (`→`→`->`, `✓`→`[ok]`), `?` for the rest, and `isCp1252` as the assertion its own test makes. |
| `app/download/watermark.ts` | The **rendered spec**, `parseSpecJson` (refuses, never defaults, on a field a renderer acts on), template resolution from the code row, `specSha` = SHA-256 over canonical JSON of the resolved text + geometry + logo hash + source hash, and the two renderers: `pdf-lib` drawn into the content stream, `sharp` compositing a footer band. |
| `app/download/stamp-worker.ts` | The worker entry. **The only place `pdf-lib`/`sharp` runs.** |
| `app/download/render.ts` | `WatermarkStore`: the cache (`spec_sha`, `source_sha`), the 2 s budget, the per-tenant semaphore of 8, in-flight de-duplication, the row→temp→rename order, and `sweep`. |
| `app/download/plane.ts` | The stamp moved **before** `consumeUse`; the hand-off now points at `/__protected/wm/…`; `denied_watermark` written before the 503. |
| `app/download/code.ts` | Two settings seeded: `download.continuation_grace_s` = 21600, `download.default_watermark_asset` = `""`. |
| `app/errors.ts` | `SKW_E_SEC_WATERMARK_FAILED` mapped to 503 (it was in `schema/error-codes.json` since S1; the map was missing it). |
| `app/main.ts` | `watermark` option and handle, and the 60 s sweep tick (unref'd, per tenant). |
| `tools/nginx_gen.ts`, `nginx/templates/server.tmpl`, `nginx/conf.d/10-app.conf` | The **second internal location** `/__protected/wm/` → `/srv/content/protected/wm/`. |
| `test/download-watermark.test.ts` | 12 cases, W1–W12. |
| `test/perf/watermark-concurrency.perf.test.ts` | 2 cases: the cap saturates at exactly 8; a 40-page PDF inside the budget. |
| `test/helpers/pdftext.ts` | Reads what the page **draws** (inflate + `Tj` operands in hex or literal form) — a watermark in `/Subject` would be one a buyer can delete. |
| `test/download-redeem.test.ts`, `test/nginx-gated-e2e.test.ts`, `test/witness.test.ts` | S3c's hand-off assertions moved to the render tree; G1 now proves the edge serves the render; three witness rows. |

No migration, no schema change: `cms_watermark_render`, `cms_asset.watermark_spec_json` and
`watermark_asset_id` already existed and are used as written.

---

## 2. The acceptance table, criterion by criterion

### 2.1 Two buyers, two files, two spec hashes, each with its own `order_ref`

```
$ node scripts/run-node-tests.mjs --timeout=120000 test/download-watermark.test.ts
# W1 2 buyers -> 2 files, spec_sha 9bd3edc46c58… vs b1d79cf947e0…, bytes 1898/1896, own order_ref: true/true
ok 1 - W1. two buyers of one asset get two files, two spec hashes, and their own order_ref
```

The assertion is not on the header alone: both files are read from
`content/protected/wm/<spec>/<asset>.pdf`, their content streams are inflated, and the drawn text
is asserted to contain **that buyer's** `ORD-ALICE-1001` / `ORD-BOB-2002` and **not** the other's.
Both still load in `pdf-lib` with both pages intact.

Through a real nginx, on a 200-byte hand-written fixture PDF, the same fact with the buyer's
`order_ref` present in the bytes the edge sent:

```
# G1 200 1217 B sha256 cb2d8146 (blob 25be815f) path content/protected/wm/4d821429cb5972748d6…
     content-length 1217 bytes_declared 1217 bytes_sent null uses=1 order_ref=true
```

`sha256(served) ≠ sha256(blob)` is the criterion in one line: **the edge no longer serves the
content-addressed blob for a gated asset.**

### 2.2 The same buyer twice → one render

```
# W2 2 downloads -> 1 render, 1 row, sha256 bee122d17640…, mtime unchanged
ok 2 - W2. the same buyer twice reuses one render: one row, one path, identical bytes
```

`spec_sha` is a function of the **code row** (`issued_to_email`, `order_ref`, `created_at`,
`code_selector`) and the resolved template — never of the token — so a second redemption of the
same code produces the same hash, the same path, and a byte-identical file with an unchanged
mtime. The row is not duplicated; a later `expires_at` extends the existing row and an earlier one
never shortens it (a slow retry must not delete a file a running transfer is reading).

### 2.3 The handed-off path is under `content/protected/`, never `content/media/`

```
# W3 x-accel /__protected/wm/f5842fec31bb01a6c64d0aa3… -> 1899 B under content/protected/
ok 3 - W3 — the handed-off path is under content/protected/, never content/media/
```

Asserted **on the header value**: `^/__protected/wm/[0-9a-f]{64}/[0-9a-f]{64}\.pdf$`, not equal to
`/__protected/<hh>/<sha>.pdf`, and the path it names is not the store's file. `STAMP_BUDGET_MS ===
2000` and `STAMP_CONCURRENCY === 8` are asserted in the same case, so the gate names the shipped
numbers rather than trusting the report.

The second location, and both staying `internal` through a real nginx:

```
# G2 GET /__protected/25/25be815f…pdf -> 404, GET /__protected/wm/4d821429cb59… -> 404 (internal)
```

### 2.4 A forced stamp failure: 503, `denied_watermark`, **no** `X-Accel-Redirect`

```
# W4 forced renderer error -> 503 SKW_E_SEC_WATERMARK_FAILED, x-accel undefined, outcome denied_watermark, uses 0
ok 4 - W4 — a stamp failure is 503, writes denied_watermark, and emits no X-Accel-Redirect
```

The body, verbatim from the probe run:

```json
{"error":{"code":"SKW_E_SEC_WATERMARK_FAILED",
          "message":"the watermark could not be rendered: renderer exploded",
          "detail":{"reason":"renderer","asset_key":"vault/book","budget_ms":2000}}}
```

Also asserted: no `content-disposition`, no PDF bytes in the body, `bytes_declared = 0`, `uses = 0`
(the buyer's entitlement is untouched), no render row written, the media path is not an app route
(`404`), and **a retry under the same token is still a denial** — one ledger row, not two. That last
one is C-4's rule applied here: a denial is not a continuation.

### 2.5 A forced budget overrun: the same path

```
# W5 budget 40 ms (shipped 2000) -> 503 SKW_E_SEC_WATERMARK_FAILED in 60 ms, x-accel undefined, outcome denied_watermark
ok 5 - W5 — a render that overruns the budget takes the same denial path
```

The budget is real because the render is **in a worker**: `pdf-lib` is synchronous, so an
in-process `Promise.race` against a timer cannot fire until the render has already returned — the
600 ms block §7.5 measured as 20/20 unrelated requests waiting 510–514 ms. `Worker.terminate()` is
what makes 2,000 ms a deadline instead of a wish; the same `Promise.race` is applied to the
injected renderer so a test cannot accidentally get a different contract.

### 2.6 The semaphore caps at 8

```
$ node scripts/run-node-tests.mjs --timeout=180000 test/perf/watermark-concurrency.perf.test.ts
# P-S3d-1 16 stamps -> 16 renders, peak in flight 8, cap 8
ok 1 - P-S3d-1. sixteen concurrent stamps reach exactly the cap of eight, then drain
```

The renderer blocks on a gate that opens when the eighth has started, so the case is decisive in
both directions: no semaphore drives 16 in flight (peak 16 → red); a cap of 4 never opens the gate
(safety timer at 4 s → peak 4 → red); a cap of 8 opens it, drains, and runs the next eight. In
`make test` (deterministic) W6 asserts the ceiling only — `peak ≤ 8` — with a sleeping renderer
that cannot flake:

```
# W6 16 concurrent stamps -> peak in flight 8 (cap 8)
```

**Measured, 40 pages, shipped path** (worker + pdf-lib, no injection):

```
# P-S3d-2 40 pages: cold 239 ms, second purchaser 232 ms, cache hit 0 ms (budget 2000 ms),
          bytes 19749/19734
```

That is ~6 ms/page including a fresh worker per stamp (the spike's 51.9/23.4 ms was in-process
and excludes it) — 8.4× inside the budget, and the second purchaser's file is a different hash.

### 2.7 An expired render is swept; the next request re-stamps

```
# W7 sweep -> rows 1, files 1; next request re-stamped /__protected/wm/4ea630e5621910bafa… -> 200
ok 7 - W7. a render past expires_at is swept, and the next request re-stamps rather than 404ing
```

`expires_at` is `token exp + download.continuation_grace_s` (default 21,600 s). The case sets it
into the past, runs `handle.watermark.sweep(db, now)`, asserts **the file and the row are both gone**,
then downloads again: `200`, the same path (same spec), the file written back, one row. A row whose
file is missing for any other reason is also re-rendered rather than handed off — `#read` treats a
size mismatch as a miss.

### 2.8 CJK name sanitised, `order_ref` intact

```
# W8 footer "licensed to ??@??.jp · order ORD-8123-XYZ" — order_ref intact, isCp1252=true
ok 8 - W8. a CJK name is sanitised to cp1252 in the footer while order_ref stays intact
```

The footer is read back out of the content stream, not from the input, and `isCp1252` is asserted
over it. `München · Øyvind Ærø` are preserved (W9), because cp1252 is the limit, not ASCII.

### 2.9 The sanitiser, once

```
# W9 sanitiser: "München · Øyvind Ærø" preserved, "→" -> "->", "张三" -> "??"
ok 9 - W9. the cp1252 sanitiser preserves, transliterates, and only then substitutes
```

Every output is asserted `isCp1252`, so a future font or call site cannot silently reintroduce a
character the encoder refuses. The PDF path, the image path and this test all call
`sanitiseCp1252`; there is no second table in the tree.

### 2.10 The worker loads from `dist/`, not only from the source tree

This one was a real bug found while writing the gate, and it is the failure mode that matters most:
under the test runner `import.meta.url` ends in `.ts`, so `new URL('./stamp-worker.ts', …)` resolves
and every test passes — while from `dist/` the same line names a file that does not exist, every
stamp throws, and **every paying download is a 503**. `stampWorkerUrl` follows the module's own
extension; W3 asserts both shapes and that the `.ts` one exists, and this probe runs the compiled
module with its compiled worker:

```
$ npm run build && node scratch/s3d/probe-dist.mjs
worker url: /Volumes/Backup/Development/skunkworks/dist/app/download/stamp-worker.js
renders: 2 distinct spec: 2
paths: content/protected/wm/… content/protected/wm/…
sizes: 1889/1890 reused: false/false
stampable(archive): null
sanitiser(张三): ?? specSha ok: true
files differ: true
```

---

## 3. The two-buyers / two-files proof, in full

```
$ node scripts/run-node-tests.mjs --timeout=120000 test/download-watermark.test.ts
# W1 2 buyers -> 2 files, spec_sha 9bd3edc46c58… vs b1d79cf947e0…, bytes 1898/1896, own order_ref: true/true
# W2 2 downloads -> 1 render, 1 row, sha256 bee122d17640…, mtime unchanged
```

Row state after W1 (one asset, two buyers):

| buyer | `order_ref` in footer | `spec_sha` | bytes |
|---|---|---|---|
| alice@example.com | `ORD-ALICE-1001` ✔ | `9bd3edc46c58…` | 1898 |
| bob@example.com | `ORD-BOB-2002` ✔ | `b1d79cf947e0…` | 1896 |

Each file contains its own `order_ref` **and not the other's**. Two rows, `source_sha` equal to the
asset's, `asset_id` equal, paths in different spec directories.

---

## 4. The fail-closed proof

Three independent witnesses, because "no un-stamped byte" is the sentence the whole slice exists
to make true:

1. **W4** — a renderer that throws: `503`, `denied_watermark` with `bytes_declared=0`, `uses=0`,
   no `X-Accel-Redirect`, no `content-disposition`, no PDF bytes in the body, and a retry is still
   a denial. **No header is emitted at all.**
2. **W5** — a render that never settles: the same 503, the same row, in 60 ms against a 40 ms
   budget (shipped: 2,000 ms).
3. **Mutations M1 and M3** (§7) — reverting the hand-off to `storage_path`, or disabling the stamp
   branch so a stampable asset falls back to the media tree, turns W1/W2/W3/W7/W8/W12 red. The
   fallback is not a code path that exists; it is a code path that fails the gate if added.

The one place a gated byte is still served un-stamped is an **archive/video/audio** asset (W11), and
that is §7.5's stated coverage list, not an accident: `stampable()` returns `null`, the S3c path
runs, and the issue screen already told the operator. See §8.3.

---

## 5. Order, and what it buys

```
stat the source blob  ->  stamp (or reuse)  ->  stat the render  ->  validate the Range
                      ->  consume one use   ->  200 + X-Accel-Redirect to /__protected/wm/…
```

* the source blob is stat'ed **first**: a missing store file is still
  `503 SKW_E_RT_ASSET_MISSING` and still spends nothing (R8);
* the stamp runs **before** `consumeUse`, so a render failure costs the buyer no use (W4: `uses=0`);
* the **render's** size is what the Range is measured against and what `bytes_declared` records —
  R3b/R3c now assert against the render, and R7 asserts `bytes_declared` equals nginx's
  `Content-Length` for the render;
* `consumeUse` is still the S3c insert-first/update-second pair inside one `BEGIN IMMEDIATE`; nothing
  in the accounting changed.

---

## 6. The sweep, and the bundle invariant

* `expires_at = token exp + download.continuation_grace_s` (seeded 21,600 s).
* `sweep(db, now)` deletes the file, then the row, then prunes empty spec directories and temp files
  older than an hour; a missing file is the postcondition, not an error.
* The tick in `main.ts` runs every 60 s per tenant, `unref`'d, and a tenant whose DB is unreadable is
  skipped with a line on stderr rather than taking the app down.
* W7 proves the delete and the re-stamp. W10 proves every render lives under `content/protected/wm/`
  and that **no symlink under `content/public` points at one** — the two trees an export walk can
  reach (`content/public`, `content/media`) cannot contain a render.

**Not built:** the bundle writer is S4. When it arrives, `content/protected/**` must be excluded from
every manifest; the invariant this slice can prove today is the one above (a render is never in
either exported tree, and never has a public link).

---

## 7. Mutation controls

`node scratch/s3d/mutations.ts` — 4 mutations, 4 gate runs, every file restored **byte-identical**:

```
RED  M1 — the hand-off is the store blob even when a render exists -> W3 reddened
RED  M2 — the spec hash covers the asset, not the buyer             -> W1 reddened
RED  M3 — a stampable asset silently falls back to the media tree   -> W4 reddened
RED  M4 — the sweep deletes the row but leaves the file            -> W7 reddened

4 mutations, every owning gate reddened, every file byte-identical
```

M2 is the one that matters: with `specSha` over the asset alone, two purchasers collide on one path
and W1 goes red on "two purchasers must never share bytes". M4 catches the sweep that leaks files.

---

## 8. Decisions, deviations, gaps

1. **The render is a worker, not a promise.** Required by §7.5's "off-loop" *and* by the 2 s cap:
   `terminate()` is the only mechanism that can stop synchronous `pdf-lib` work. Cost: ~60–100 ms of
   worker startup per stamp (included in the 239 ms cold measurement). A pool is the obvious next
   optimisation and is not needed at this hit rate (≈1 by design).
2. **A denial is final for that token.** `denied_watermark` is written as a `first` row, so the same
   `jti` retried hits C-4's "a denial is not a continuation" and is refused again (W4 asserts it).
   The buyer recovers by redeeming the code again, which mints a fresh token and spends nothing
   extra. **Flagged for the architect:** this is the correct reading of C-4 and C-16 together, but
   it means a transient renderer fault costs the buyer a form round-trip.
3. **An archive/video/audio asset is still served from `content/media/`** (W11, asserted, not
   assumed). §7.5 says those are not watermarked in v1 and the issue screen warns; denying them
   would be a product regression dressed as security. The failure mode this slice forbids — a
   *stampable* asset served un-stamped — cannot occur. **Recommendation:** if the product decides a
   gated video must never be sold un-stamped, refuse it at issue like an encrypted PDF (422
   `SKW_E_DM_ASSET_UNSTAMPABLE`), which is a one-line policy in `assertGateable` plus a test.
4. **An invalid `cms_asset.watermark_spec_json` fails at download (503), not at issue.** The
   encrypted-PDF precedent says it belongs at issue, in front of a human. Not done here: `issueCode`
   does not validate the spec JSON today, and adding that refusal is a separate acceptance line.
   **Flagged for S3-QA.**
5. **Token-level continuation grace is still not implemented.** `download.continuation_grace_s`
   exists, is seeded, and decides a render's lifetime; §7.4's "serve an expired token that has a
   `first` row" is *not* wired, because `R5b` pins an expired token to `401 SKW_E_SEC_TOKEN_INVALID`
   and that is a frozen gate this slice will not weaken. The two sentences conflict; the register
   should decide which one moves. The consequence today: a download resumed after 600 s needs a
   fresh redemption, while its render stays on disk for 6 hours.
6. **Two settings seeded.** `download.continuation_grace_s` (int, 21600) and
   `download.default_watermark_asset` (string, `""` = none). The latter is D20's tenant default; a
   per-asset `watermark_asset_id` wins. A missing grace falls back to 21,600 rather than refusing a
   download: the setting decides no money, and a seed that has not run yet must not deny a buyer.
7. **`SKW_E_SEC_WATERMARK_FAILED` was missing from `app/errors.ts`.** It has been in
   `schema/error-codes.json` since S1 and `AppError` throws on an unmapped code, so the first
   implementation of the denial path answered `500 SKW_E_PLT_INTERNAL`. Found by W4, fixed at the
   map, and `test/error-codes.test.ts` (which asserts the two sets are equal) is green.
8. **One worker per stamp means up to 8 × tenants workers.** The cap is per tenant by spec. A box
   with many simultaneously-active tenants has a memory ceiling that is 8 × N, not 8. Flagged for
   QA; a process-wide cap or a worker pool is the fix if it ever shows up in RSS.

---

## 9. What S3 QA should attack first

1. **The denial path under a real fault, not an injected one.** Kill the worker mid-render
   (`SIGKILL` a child, or a PDF that makes `pdf-lib` throw — a truncated xref), and confirm: 503,
   one `denied_watermark` row, no header, media blob never served, and the *next* redemption of the
   same code works. The injected renderer proves the branch; a real crash proves the branch's
   *recovery*.
2. **The token/grace contradiction (§8.5).** Mint a token, let it expire, and check what §7.4
   promises against what R5b asserts. This is the one place where two frozen documents disagree and
   the code chose the gate.
3. **`spec_sha` stability across a code edit.** `updateCode` can change `max_uses`, `expires_at` and
   revoke — none of which is in the spec. But if anything ever adds a field to the code that *is*
   in the spec, every buyer silently gets a second render. Ask for a test that pins the spec's
   inputs to the four columns it reads.
4. **Disk growth.** 1,000 buyers × a 5 MB book at +60 % ≈ 8 GB per campaign, alive for 6 hours after
   the last token. Watch `content/protected/wm` under a burst, and confirm the 60 s tick keeps up
   (a sweep that falls behind is a disk-full incident, and `SKW_E_PLT_DISK_FULL` is 507).
5. **The image path's readability.** W12 proves two buyers get different bytes and a valid 320×240
   PNG; it does not prove the footer is *legible* on a dark photograph. Look at one.
6. **The second location under a reload.** `nginx -s reload` with a request in flight against
   `/__protected/wm/`: the alias is a different tree, and a typo there is a 404 for a paying
   customer. G2 covers the direct-404 half; the reload half is not covered.

---

## 10. Reproducing the gate

```
make test                     # 404 tests, 404 pass, 0 fail, 0 skipped, RC=0
node scripts/run-node-tests.mjs --timeout=120000 test/download-watermark.test.ts     # 12/12
node scripts/run-node-tests.mjs --timeout=180000 test/nginx-gated-e2e.test.ts        # 4/4 (docker)
node scripts/run-node-tests.mjs --timeout=180000 test/perf/watermark-concurrency.perf.test.ts  # 2/2
node scratch/s3d/mutations.ts # 4 controls, all red, all files restored
```

`make test` went from **392 → 404** (+12: W1–W12). `make test-perf` gained two cases (6 → 8) and was
**refused by the load guard** on this box at load 10.65 (8 cpus); the two cases were run directly at
load 9.55 and are quoted above. No timing assertion was added to `make test`: the only wall-clock
assertions in this slice are in `test/perf`, and the deterministic suite's concurrency case (W6)
asserts a ceiling, not a duration. `SKW_ALLOW_SKIP` was never set; nothing is skipped.

The whole workspace, booted rather than only tested, with the six boot keys and a scratch
`SKW_DATA_DIR` (`scratch/s3d/hermes-verify.env`):

```
$ hermes verify --json
{"recipe":"Astro","ok":true,"phases":[
  npm install 0 · npm run build 0 · npm run typecheck 0 · npm run test 0 (63.5 s, 404/404) ·
  make test 0 (92.6 s, 404/404) · make typecheck 0 · make build 0],
 "readiness":{"url":"http://127.0.0.1:4321/","ready":true,"statusCode":200}}
```

