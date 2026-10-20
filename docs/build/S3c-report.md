# S3c — the gated download plane

**Slice:** S3c (the money half of §16 S3: code issuance, redemption, the `jti` ledger, `X-Accel-Redirect`).
**Scope items:** 6 of 6. **`make test`:** 392/392, 0 skipped, RC=0. **`make test-perf`:** 6/6, RC=0.
**Watermarking (S3d) is not in this slice** and nothing here serves an un-stamped byte of a *stampable* asset
it was not given: see §8.

---

## 1. Item 0 — the load-sensitive claim, fixed by deriving rather than widening

**What check 7 asserted.** `verify_claims.py` measured one argon2id verify at `m=65536,t=3,p=1` and asserted the
*derived product* `t × 5000 > 300 s`. The product on this box is 295–331 s (§3 below), so the gate sat on its own
threshold: `S3b-report.md` §8 records one failure at **298.0 s** on a busy box and a pass on the idle rerun with
nothing changed. Widening 300 would have kept a gate whose verdict is a property of the scheduler.

**What it asserts now** (`scripts/model/verify_claims.py`, `argon2_lookup`), three assertions, none of which load
can flip:

1. **salted** — two hashes of one code differ and the verifier accepts the code, so a row cannot be found by
   hashing the input. This is the boolean the whole "a scan is the only alternative" argument rests on, and it is
   load-free.
2. **the cost tracks the parameters** — the heavy set (`m=65536,t=3`) costs **2.5–8×** the frozen set
   (`m=19456,t=2`), against a parameter ratio of 5.05×. Both medians are measured **in the same process, in the
   same run**, so load cancels out of the ratio.
3. **the derived scan has a floor** — `median_verify(frozen) × 5000 > 30 s`. This is a *lower bound*: load can
   only make a verify slower, so the assertion cannot flake in the direction that broke it; a halved parameter
   set (`t=1`, or `m≈9738`) derives to ~23 s and reddens it.

The 5,000-code figure at the *heavy* parameters — the number `SDS.md` §15.1 cites as 356–423 s — is now **printed
every run instead of asserted**. Four runs, three idle and one under eight busy loops:

```
PASS  7 ... verify=8.89ms (m=19456,t=2) salted (different hashes) -> derived 5000-code scan=44s at the
           frozen set and 296s at m=65536,t=3 (6.7x, parameter ratio 5.05x); hmac=0.499ms
PASS  7 ... verify=8.95ms ... 45s ... 295s ... (6.6x)
PASS  7 ... verify=10.05ms ... 50s ... 331s ... (6.6x)
PASS  7 ... verify=12.40ms ... 62s ... 346s ... (5.6x)     <- under 8x `yes` loops
```

`27/27 passed, 0 skipped, 0 failed` on all four. Note the third idle run's heavy product is **295 s**: the old
`> 300` gate was already red on an idle box in that run, before any load was applied.

```
$ /usr/bin/python3 scripts/model/verify_claims.py
27/27 passed, 0 skipped, 0 failed
$ bash scratch/s3c/load-check7.sh          # 8 busy loops for the duration
load average with 8 busy loops: { 3.58 3.51 3.71 }
exit=0
PASS  7 ... verify=12.4ms ... derived 5000-code scan=62s ... and 346s ... (5.6x)
27/27 passed, 0 skipped, 0 failed
```

---

## 2. What was built

| File | What it is |
|---|---|
| `app/download/code.ts` | Crockford codes, normalisation, `mintBatch` (hash outside, one insert transaction), `max_uses` resolution, the three issue-time refusals, CSV, webhook signature |
| `app/download/token.ts` | `v1.<payload>.<mac>`, the §7.4 verification order, `iph`/`uah`, the `__Host-` cookie |
| `app/download/ledger.ts` | `consumeUse` — insert-first, update-second, one `BEGIN IMMEDIATE`, on the `jti` |
| `app/download/plane.ts` | The form, `POST /d/<key>`, `GET /d/<key>/file`, the webhook route, range parsing, `Content-Disposition`, the sliding-window limiter |
| `app/download/adminCodes.ts` | `/admin/t/<key>/codes`: list, issue one, issue a CSV, revoke, reissue, edit |
| `app/main.ts` | `contentRoot` + `downloadLimits` options, `/d/:key`, `/d/:key/file`, `/api/hooks/:tenant/issue-code`, the shipped `cms_settings` seed, one shared argon semaphore |
| `app/admin/routes.ts` | `codes…` dispatch with origin + CSRF, an audit row per POST, and `semaphore`/`contentRoot` injection |
| `app/errors.ts` | Five mappings the download plane needs (`SEC_TOKEN_INVALID`, `SEC_TOKEN_MISMATCH`, `SEC_USES_EXHAUSTED`, `RT_ASSET_MISSING`, `DM_ASSET_UNSTAMPABLE`); all five already existed in `schema/error-codes.json`, so the 72-code count gate is untouched |
| `snippets/skunk-proxy.conf` | **One line removed** — see §7 |

`cms_download_code`, `cms_download_event` and `cms_asset` are unchanged. No migration, no new table.

---

## 3. The acceptance table, criterion by criterion

### 3.1 Eight parallel Range requests, one token → one use, one row

```
$ node scripts/run-node-tests.mjs --timeout=180000 test/download-redeem.test.ts
# R1 8 parallel ranges -> 200 x8, uses=1, event rows=1 (kinds first:ok), bytes_declared=200
ok 13 - R1 — 8 parallel Range requests under one token spend exactly one use and write one row
```

The same token then issues **eight more** ranges (`bytes=0-,2-,4-…`) and the counts do not move: `uses=1`,
`rows=1`. Two tokens:

```
ok 14 - R2 — two different tokens spend two uses and write two rows
```

**Two further witnesses, because one process cannot race itself.** `better-sqlite3` is synchronous and the event
loop runs one callback at a time, so the HTTP test above proves the *route's* accounting but cannot prove the
*transaction's* ordering — update-first would pass it by accident. Two more gates:

**(a) eight OS processes, one `jti`** (`test/download-consume.test.ts`, each child waits on a shared wall-clock
instant then runs one `BEGIN IMMEDIATE`):

```
ok 9  - C1. 8 processes, one jti: one redemption, seven continuations, one row
ok 10 - C2 — 8 processes, two jti: two uses, two rows
ok 11 - C3. 8 processes, 8 jti, max_uses=2: exactly two spend and six are denied
ok 12 - C4 — a quota denial is not a continuation: the same jti retried is denied again
```

**(b) a real nginx** (`test/nginx-gated-e2e.test.ts`, generated conf, app on the host, `content/` bind-mounted):

```
# G4 8 parallel ranges -> 206 x8, one use (2 -> 3), event rows 2 -> 3
ok 21 - G4 — 8 parallel ranges through the edge: one use, eight correct slices
```

### 3.2 `Range: bytes=1-` cannot bypass the counter

```
ok 15 - R3 — Range: bytes=1- cannot bypass the counter once the use is spent
ok 16 - R3b — an oversized range is clamped, still spends one use, and bytes_declared is the file
ok 17 - R3c — an unsatisfiable range is 416, writes no event and spends nothing
```

`R3`: a code with `max_uses=1`, one token spends it, a **second** token sends `Range: bytes=1-` → `410
SKW_E_SEC_USES_EXHAUSTED`, `uses` stays 1, and the ledger holds `first:ok` + `first:denied_quota`. `R3b`:
`bytes=0-999999999` is clamped to the file, still one use, `bytes_declared=200`. `R3c`: `bytes=210-` on a 200-byte
file → `416` with `Content-Range: bytes */200`, **no** `first` row, and the same token still works afterwards.

### 3.3 Unknown selector vs wrong secret

```
ok 18 - R4 — an unknown selector and a wrong secret are indistinguishable
```

Status `401`, code `SKW_E_SEC_CODE_INVALID`, and a body identical with `requestId` masked — that one field is
per-request by §4.3 and is the only one allowed to differ. Both refusals write a `denied`/`denied_token` row.

The timing, in `test/perf`:

```
$ node scripts/run-node-tests.mjs --timeout=180000 test/perf/download-timing.perf.test.ts
# medians: unknown-selector 10.22 ms, wrong-secret 10.22 ms (1.000x; tolerance 0.2x),
#   p10 10.12/10.13 ms, p90 10.82/10.83 ms over 1000 trials each
ok 1 - P-S3c-1. unknown selector vs wrong secret: 1,000 trials each, medians within 20%
```

**Tolerance stated:** `min(medians) ≥ 0.8 × max(medians)` — 20 % of the larger median. Trials alternate
(unknown, wrong, unknown, wrong…) so a load spike lands on both groups. Three runs: `10.22 / 10.22 ms (1.000x)`,
`10.28 / 10.28 ms (1.000x)`, and `10.68 / 10.67 ms (1.000x)` under `make test-perf`'s load. `P-S3c-2` also times a
random selector (50 trials, `10.21 ms`) — the dummy verify is the same call at the same parameters.

### 3.4 A garbage or oversized token is 401, never 500

```
ok 19 - R5. a garbage or oversized token is 401, never 500
```

Six cases: `not-a-token`, `two.parts`, `v1..`, `v2.…`, a MAC that base64url-decodes to **8 bytes** (the case where
`timingSafeEqual` throws `ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH` and a naive implementation answers 500), and a
5,000-character token. All `401 SKW_E_SEC_TOKEN_INVALID`.

```
ok 20 - R5b. a token minted for another client, asset or clock is refused
```

Wrong `iph`/`uah` → `TOKEN_MISMATCH`; a validly-signed token whose `aid` is *another gateable asset* →
`TOKEN_MISMATCH` (the binding is checked against `cms_download_code.asset_id`, which is stronger than a route
id); an expired token with `exp - iat = 600` → `TOKEN_INVALID`.

### 3.5 `报告.pdf`

```
ok 21 - R6 — 报告.pdf downloads with filename*=UTF-8''… and status 200
```

`Content-Disposition: attachment; filename="download.pdf"; filename*=UTF-8''%E6%8A%A5%E5%91%8A.pdf`, and the
fallback is asserted ASCII-only. Through nginx (G1) the same header survives with `200`.

### 3.6 An encrypted PDF is refused at issue, naming the asset

```
ok 4 - I4. an encrypted PDF is refused at issue, naming the asset
```

`422 SKW_E_DM_ASSET_UNSTAMPABLE`, `detail.reason='encrypted_bytes'`, `detail.asset={key:'vault/locked',
filename:'locked.pdf'}`. Two more refusals with the same code and their own reasons: `encrypted` (the flag,
on a plain PDF) and `access_class` (a `public` asset — a code for it would sell what `/media/<key>` gives away).
**Why the bytes are read:** `uploadAsset` never sets `encrypted`, so trusting the flag alone would gate a file
S3d's renderer refuses at download time; the check is `/\/Encrypt\s+(\d+\s+\d+\s+R|<<)/` over the first and last
512 KiB, which is where a trailer lives. A PDF whose trailer sits outside both windows is not detected — stated,
not implied.

### 3.7 `bytes_declared` is the authorised length; `bytes_sent` stays NULL

```
# G1 200 200 B sha256 25be815f content-length 200 bytes_declared 200 bytes_sent null uses=1
ok 18 - G1 — a redeemed cookie downloads the stored PDF through the edge, byte-identical
```

This is the criterion in one assertion: the ledger's `bytes_declared` equals the `Content-Length` **nginx** sent
(the app sends none — it hands off), the body's sha256 is the stored blob's, and `bytes_sent IS NULL`. `R7` adds
the range case: `bytes=10-19` records `bytes_declared=10`, not the file size.

### 3.8 `max_uses` NULL, and lowering it below `uses`

```
ok 24 - R9 — a code with max_uses NULL is unlimited only behind the toggle and the confirmation
ok 25 - R10 — lowering max_uses below uses blocks the next redemption immediately
ok 26 - R10b — a revoked code stops a token that was already minted
```

`R9` flips `cms_settings.download.allow_unlimited`, issues `max_uses NULL` with the confirmation, and three
redemptions spend three uses. `R10` spends one use, lowers `max_uses` to 1, and the next token is `410` with
`uses` unchanged. `R10b` revokes after a successful download and the same cookie is `401`.

`max_uses` resolution (`I2`): per-issue → `cms_settings.download.default_max_uses` (**3**, seeded at boot) → and a
**missing setting is a refusal** naming the key, never a silent 3.

---

## 4. The hand-off, executed by a real nginx

```
# G1 200 200 B sha256 25be815f content-length 200 bytes_declared 200 bytes_sent null uses=1
# G2 GET /__protected/25/25be815f…c2032d.pdf -> 404 (internal)
# G3 206 100 B range bytes 100-199/200 uses=2
# G4 8 parallel ranges -> 206 x8, one use (2 -> 3), event rows 2 -> 3
ok 18 - G1 …  ok 19 - G2 …  ok 20 - G3 …  ok 21 - G4 …
```

* **G1** — the redeemed cookie downloads the **stored bytes** through nginx, body sha256 equal to the blob's; the
  app's `X-Accel-Redirect` is consumed (`header(res,'x-accel-redirect') === undefined`).
* **G2** — a direct `GET /__protected/<hh>/<sha>.pdf` is nginx's **404**: the location is `internal`, and the
  file is not reachable by URL.
* **G3** — `bytes=100-199` is `206` with exactly those 100 bytes and `Content-Range: bytes 100-199/200`; the same
  token's `bytes=150-` is a continuation and spends nothing.
* **G4** — eight parallel ranges through nginx: eight correct slices, one use, one row.

**The URI is `/__protected/<hh>/<sha>.<ext>`**, not the brief's `/__protected/<sha256>.<ext>`: S3b fixed the tree
as `content/media/hh/<sha>.<ext>` (`cms_asset.storage_path` is a generated column with that fan-out), and the
internal location's alias is `/srv/content/media/`. One rule produces the URI — `storage_path` minus
`content/media/` — so there is no second naming scheme. A flat `/<sha>.<ext>` would have meant a second.

---

## 5. Order, and what it buys

```
stat the target  ->  validate the Range  ->  consume one use  ->  200 + X-Accel-Redirect
```

* a **missing blob** is `503 SKW_E_RT_ASSET_MISSING` from the app (R8) with `uses=0` and no event row — never a
  silent nginx 404, and the customer's code is not burned by our lost file;
* an **unsatisfiable range** is `416` with no `first` event (C-7's sentence, R3c);
* the **consume** is the insert-first/update-second pair inside one `BEGIN IMMEDIATE`; the unique partial index
  `ux_ev_jti_first` *is* the gate, and the `UPDATE` carries `uses < max_uses` so the counter cannot be raced by a
  JS-side read.

**Denial is not a continuation.** A denial is written as a `first` row with `outcome != 'ok'`; a retry under the
same `jti` finds a row and must not be served. `C4` and the `R3`/`R10` cases pin that. A row that names another
code or asset is refused too (`denied_token`) — a reused `jti` is not a free download.

---

## 6. Issuance, all three channels

```
ok 1 - I1 — a code is 16 Crockford characters; the row holds the selector and an argon2id hash
ok 5 - I5 — CSV: a blank max_uses uses the tenant default, and one bad line issues nothing
ok 6 - I6 — the signed webhook: good signature issues, a replayed order is 409, a bad one is 401
ok 7 - I7 — reissue revokes the old row and mints a new code
ok 8 - I8 — the admin screen issues, shows the plaintext once, and lists the codes
```

* **I1** — 16 Crockford chars, `selector == code[0..4]`, `code_hash` is `$argon2id$v=19$m=19456,t=2,p=1$…`, and a
  loop over every column asserts no string contains the secret or the whole code.
* **I5** — `email, asset_key, max_uses, expires_at`; blank `max_uses` → 3; a `"Doe, Jane" <jane@…>` cell is
  unwrapped to the address; one bad line (`no/such/asset`) refuses the file with `detail.line=3` and **mints
  nothing**. The batch is hashed outside the transaction and inserted inside one, because `better-sqlite3`
  transactions are synchronous and an `await` cannot sit in one.
* **I6** — `X-Skw-Signature: sha256=<hex>` over the raw body, per-tenant secret in
  `cms_settings.download.webhook_secret`, ±300 s `iat`. A replayed `order_ref` is `409 duplicate_order_ref` and
  mints nothing (the plaintext cannot be re-read). No configured secret → `404` (the channel does not exist).
* **I8** — the admin page shows the plaintext **once**, with "this is the only time these codes are shown"; the
  list shows the selector only; the encrypted-PDF refusal reaches the operator as `422` with the asset named.

---

## 7. A shipped blocker found by the e2e, and the one-line fix

`snippets/skunk-proxy.conf` carried:

```
proxy_ignore_headers X-Accel-Redirect;            # on any location proxying to a non-app upstream
```

That line comes from `r2-platform.md` item 6 — correct for a **non-app** upstream, where a compromised sidecar must
not mint an offload. But the snippet is the *only* include inside every app-proxying location, so with it in
place nginx discards the app's header and a gated download returns the app's empty `200`. G1 failed on exactly
that: `sha256(e3b0c442…)` (the empty string) against the file's `25be815f…`.

**The fix:** the directive is removed from the snippet, with a comment stating where the rule does belong and
naming the gate that fails without it. Nothing is weakened: no location in the generated config proxies to a
non-app upstream (the plugin runner is a unix socket, not a proxy), so the protection the line provided is
vacuous today and must be re-applied if such a location is ever added.

**For the architect:** this deserves an errata row, because the register's sentence ("add to the base snippet,
unconditionally") and §7.4 cannot both hold. I did not edit the frozen docs.

---

## 8. Decisions, deviations and gaps

1. **The limiter counts *refusals*, not all attempts.** §16 says "5 per 15 min per IP and per selector"; counting
   successes too would lock out the sixth *correct* redemption from an office NAT — the "denies a paying customer"
   failure this slice is supposed to avoid. The guessing wall is the point, so a refusal is what counts; a second,
   much larger bucket (60/15 min per IP) caps a flood that is not guessing. `R12` proves the 5-then-429 sequence
   *and* that a correct 6th attempt is still refused; `R12b` proves the IP window closes on its own across six
   distinct selectors. **Flagged for the architect** as a deliberate refinement of a spec sentence.
2. **`kind='range'` rows are not written.** The acceptance table says one event row per token, so a continuation
   writes nothing. The `range` kind stays in the schema for S3d. (`S3b-report.md`'s claim that the SDS's check 22
   writes `range` rows is about the claims gate, not this path.)
3. **Continuation grace is not implemented.** A token is valid for exactly 600 s; a re-request after that is
   `401`. An in-flight transfer is unaffected (nginx streams it after the redirect), so the 1 GiB/`limit_rate 1m`
   case only breaks if the client *resumes* later than ten minutes — §7.4's 21,600 s grace is the fix and it is
   not in this slice's six items. **S3d must wire it**: a stamped render's lifetime is token expiry + grace.
4. **Bundle codes are refused.** `POST /d/<key>` denies a row with `bundle_id IS NOT NULL` and no path issues one;
   a bundle is a multi-file delivery, which `aid`-binding forbids (C-7's own "what would overturn it" case).
5. **Multi-range is 416.** `bytes=0-1,5-6` would make `bytes_declared` a guess (nginx answers
   `multipart/byteranges`), so it is refused rather than half-counted.
6. **One shared argon2 semaphore.** `AdminSurface` now accepts a `semaphore`, and `main.ts` passes one instance to
   both it and the download plane: 4 slots per process is a memory ceiling (§7.2), not a per-surface one.
7. **`contentRoot` is a `buildApp` option, not an env name.** §4.3 fixes 23 names; production takes
   `/srv/content` (the compose mount) and a gate passes a temp dir.
8. **`downloadLimits` is a test seam** on `buildApp`, present only so `test/perf` can measure argon2 instead of the
   limiter's 429. The shipped limits are asserted on a plane built without it (R12/R12b).
9. **No pepper, no `code_lookup` column, no plaintext.** The `cms_download_code` CHECKs and the immutability
   triggers do the structural half; `I1` does the row-level half.

---

## 9. Mutation controls — a test that cannot fail is a comment

`node scratch/s3c/mutations.ts` (6 mutations, 9 gate runs; every file restored **IDENTICAL**):

```
M1 — the counter moves whatever the gate did            -> C1 RED, R1 RED
M2 — the MAC length is not checked before timingSafeEqual -> R5 RED
M3 — the UPDATE drops the quota guard                   -> R3 RED, R10 RED
M4 — an unknown selector skips the (dummy) argon2 verify -> P-S3c-1 RED
M5 — refusals no longer count toward the limiter        -> R12 RED, R12b RED
M6 — the token's aid is not checked against its code    -> R5b RED
all mutations reddened the owning gate and every file is byte-identical
```

M5 is the reason `R12b` exists: with only R12, removing the per-IP counter still left the per-*selector* counter
answering 429, so the mutation stayed green. The control found a hole in the gate, not in the code.

---

## 10. Reproducing the gate

```
make test                                  # 392 tests, 392 pass, 0 fail, 0 skipped, RC=0
make test-perf                             # 6 tests, 6 pass, RC=0 (idle box; the load guard refuses otherwise)
node scripts/run-node-tests.mjs --timeout=180000 \
  test/download-codes.test.ts test/download-consume.test.ts test/download-redeem.test.ts \
  test/nginx-gated-e2e.test.ts             # 33 tests, 33 pass
node scripts/run-node-tests.mjs --timeout=180000 test/perf/download-timing.perf.test.ts
node scratch/s3c/mutations.ts              # the six controls
bash scratch/s3c/load-check7.sh            # the claims gate under 8 busy loops
```

`make test` is unchanged in shape: `verify-toolchain` → `verify-gitignore` → `verify-schema` → `verify-claims` →
`verify-frozen` → `build` → `typecheck` → the node suite through `scripts/run-node-tests.mjs` with
`--test-timeout=40000`. `SKW_ALLOW_SKIP` was never set, nothing is skipped, and **no timing assertion was added to
`make test`** — the only wall-clock assertions in this slice are `test/perf/download-timing.perf.test.ts`, and its
assertion is a ratio, not a duration.

The perf gate passed **6/6 twice** while this slice was being built (`scratch/s3c/out/make-test-perf.txt`). Its
final re-run at 20:58 was **refused by the load guard**, not by a test:

```
  box: 8 cpus, 1-min load average 12.98
  REFUSED: load 12.98 on 8 cpus — this box is oversubscribed…
```

That is the guard doing its job on a shared box (load was 51 two minutes later, from other work). `SKW_PERF_FORCE=1`
would run it anyway and the banner would say the numbers are not a measurement, so it was not used; the run to
quote is the 6/6 above. `make test` — the canonical gate — was re-run after the last code change: **392/392, RC=0**.

`make test` count: 359 (S3b) → **392**, i.e. +33: 8 issuance, 4 consume, 17 redemption, 4 gated-nginx. The two
perf cases are in `make test-perf` only.

`hermes verify --json` on this tree, with the six boot keys and a scratch `SKW_DATA_DIR`:

```
ok: true
phases: npm install 0 · npm run build 0 · npm run typecheck 0 · npm run test 0 (52.9 s) ·
        make test 0 · make typecheck 0 · make build 0
readiness: http://127.0.0.1:4321/ -> 200 (0.03 s)
```

`npm run test` — the bare `node --test` invocation, not the runner — reports the same `tests 392 · pass 392 ·
fail 0 · skipped 0`, so the count is the suite's, not the runner's. The boot was a fresh `control.db` + four
tenants under `scratch/s3c/out/verify-data`, which is also the evidence that `seedSettings` works on a first boot
rather than only on an existing file.

---

## 11. What S3d must build first

**1. A second internal location, and the render as the thing handed off.** The plane today hands off
`cms_asset.storage_path` — the store's immutable blob. A stamped render is a *different* file, so
`X-Accel-Redirect` must point at `content/protected/wm/<…>` through a new `internal` location (aliased at
`/srv/content/protected/`, **not** `/srv/content/media/`, so the store's tree keeps one meaning), and
`consumeUse` must run *after* the render succeeds and before the redirect. Nothing in the current hand-off may be
reused for a stamped byte: `storage_path` is content-addressed and shared by every buyer, which is exactly what a
watermark must not be.

**2. The transient cache row, with its expiry derived from the token.** `cms_watermark_render(asset_id, spec_sha,
source_sha, path, expires_at)` already exists; `expires_at` must be **token `exp` +
`download.continuation_grace_s`**, and the sweep must delete file and row. That is why the grace (§8.3) is S3d's
first dependency: without it a render is either immortal or deleted under a running transfer. `spec_sha` includes
the buyer's email, so the hit rate is ≈1 and every redemption leaves a file — the sweep is not optional.

**3. The 2 s budget, off-loop, with the per-tenant semaphore of 8, and `denied_watermark` in the ledger.** The
`consumeUse` outcome union already carries `denied_watermark`; the fail-closed rule is "no un-stamped byte",
which means a timeout is `503 SKW_E_SEC_WATERMARK_FAILED` **and** a denied row, not a redirect.

**4. Make `stampable` a refusal where it has to be.** `issueCode` already returns `stampable: false` for video and
audio and the admin page says so; S3d decides whether a tenant that requires stamping may issue such a code at
all. The encrypted-PDF refusal is the pattern: fail at issue, in front of a human, naming the asset.

---

## 12. Test files added

| File | Cases |
|---|---|
| `test/download-codes.test.ts` | 8 — issuance, `max_uses`, unlimited, encrypted/public refusals, CSV, webhook, reissue, admin screen |
| `test/download-consume.test.ts` | 4 — 8-process races (one jti, two jti, cap 2), denial-vs-continuation |
| `test/download-redeem.test.ts` | 17 — the acceptance table over real sockets, plus the form and the limiter |
| `test/nginx-gated-e2e.test.ts` | 4 — the hand-off, `internal`, ranges, 8 parallel ranges through nginx |
| `test/perf/download-timing.perf.test.ts` | 2 — 1,000-trial medians, random selector |
| `test/helpers/consume-child.ts` | the child process for the multi-process race |

Four rows added to `test/witness.test.ts` (`consumeUse`, `verifyToken`, `redeem`, `assertGateable`), each with
its `Exclusive witness:` line in the source, so the mechanism → test link is enforced rather than asserted by
comment.
