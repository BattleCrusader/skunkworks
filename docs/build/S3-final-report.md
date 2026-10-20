# S3 final report — the two round-2 majors: the occurrence-scoped register, and the retryable refusal

**Closes:** `S3R2-1` (register was file-scoped) and `S3R2-2` / **D34** (a watermark refusal is retryable
by contract) from `docs/build/S3-qa.md` §Defects.
**Tree:** `d3df7d0` (QA round 2) + this working tree, **uncommitted**, as instructed.
**Gate:** `make test` **421/421, 0 failed, 0 skipped, RC=0**, `verify-dist 6/6` inside it, **89.8 s**
(`scratch` log kept; node suite 68.0 s). `make test-perf` **8/8** (53.2 s) run separately because both
changes sit in the download path.

| Item | Severity | Was | Now proved by |
|---|---|---|---|
| S3R2-1 | Major | `claimed` was a set of **files**; a ninth site in `app/main.ts` left 15 occurrences behind 8 rows and E28-1/2/3 all green | `E28-2` compares **occurrence counts per file** and `E28-3` fails on a +1 site in a listed file **and** on a duplicate line; disk mutation → red naming `app/main.ts:715`, hash-restored green |
| S3R2-2 / D34 | Major (product) | `Retry-After` absent, a browser got JSON, and the denial was written as `kind='first'`, so **every retry was a second denial** | `R1`–`R4`: the header is a measured number and is asserted by value; a refusal that clears on attempt 2 serves the stamped file with `uses=1`; three failures are 3 rows, `uses=0`, terminal page |

---

## 1 — S3R2-1: the claim is per occurrence

### What was wrong

`auditWitnesses()` built `claimed` from `DIST_SITES.map(row => row.file)` and then asked whether each
**file** was in it. Fourteen occurrences sat behind eight rows, so three files were "claimed" by rows
that named one site each. QA appended a ninth runtime-path site to `app/main.ts` — the file where the
original `.ts`-resolver defect lived — and the register reported **green at 15 occurrences**. A gate
that cannot see its own class re-enter through a file it already lists is the same defect one level up.

### What it is now

`test/dist-witness.ts`:

```
DistSite { site, file, resolvedBy, anchors: string[], gate }
```

- **`anchors`** names each occurrence a row claims, by a substring of that site's source line
  (`schemaDirFrom(import.meta.url)`, `return process.cwd();`, `if (isMain(import.meta.url))`, …).
  Seven of the eight rows are anchored; fourteen anchors cover all **14** occurrences over **5** files.
- **`DIST_EXEMPT`** now carries the occurrence count it covers (`tools/regen_conf.ts`, **0** — the site is
  transitive through `test/helpers/fixture.ts`). A new marker in an exempt file reddens the count.
- `auditOccurrences(found)` is the pure audit; `auditWitnesses()` is that over the tree. Separation is what
  lets the negative control inject a site **in memory** and run in every `make test`.

Both directions now fail, which is the point:

| shape of the mistake | what reddens |
|---|---|
| a new site in a file rows already list | `unclaimed: app/main.ts:715 process.cwd() — return join(process.cwd(), 'scratch');` **and** `app/main.ts: 4 found / 3 claimed` |
| a new site in a file nobody lists | `unclaimed: …` (unchanged from before) |
| a new site whose line is identical to one a row claims | `claimErrors: "the schema directory" (app/main.ts): anchor "schemaDirFrom(import.meta.url)" matches 2 lines (app/main.ts:152, app/main.ts:998) — an anchor must name one site` |
| a row whose anchor no longer exists (the code moved) | `claimErrors: anchor "…" matches no line in the file` |
| two rows claiming the same line | `claimErrors: "A" and "B" both claim app/main.ts:152` |

### The negative control, run the way QA broke it

Appending a real site to `app/main.ts` (716 lines after the append):

```
BEFORE   12e9f7321c69a4377c995055a1a99def9886ce696e3e9d99758eacc3f46d2607
MUTATED  b6772ab01eebef96789dc2bb463be9584e159a121a34c7959c78173d6239c742
+ /** A ninth runtime-path site, appended by the S3R2-1 negative control. */
+ export function scratchDirFromCwd(): string {
+   return join(process.cwd(), 'scratch');
+ }

$ node --test test/dist-witness.test.ts
ok     1 - E28-1 — every register row names a D-assertion scripts/dist-gate.mjs actually runs
not ok 2 - E28-2 — every occurrence under app/ and tools/ is claimed by exactly one row anchor, and the counts agree per file
    unclaimed path sites (E-28 has no third option):
      app/main.ts:715 process.cwd() — return join(process.cwd(), 'scratch');
not ok 3 - E28-3 — a new site in a file the register already lists is unclaimed: the claim is per occurrence
# tests 3
# pass 1
# fail 2

RESTORED 12e9f7321c69a4377c995055a1a99def9886ce696e3e9d99758eacc3f46d2607
IDENTICAL: 12e9f7321c69a4377c995055a1a99def9886ce696e3e9d99758eacc3f46d2607
```

`E28-1` stays green on purpose: no row was added, and E28-1 asserts the *link* between rows and
`D<n>` assertions. E28-2 is the assertion that carries the class, and it names the **file, the line,
the marker and the code** — the three things QA's mutation needed to be caught.

### How a legitimate new site is added (the register must not become a tax)

One row, six lines:

```ts
{
  site: 'the scratch directory a tool writes',
  file: 'app/download/render.ts',
  resolvedBy: "join(process.cwd(), 'scratch')",
  anchors: ["join(process.cwd(), 'scratch')"],   // the unique half of the line
  gate: 'D1',                                    // the D<n> that executes it in dist/
},
```

…or, when nothing can execute it, one `DIST_EXEMPT` entry with a reason and a count. The failure message
prints the file, the line and the code you are adding, so the row is a paste. Nothing else changed: no
new command, no new target, `verify-dist` still 2.0 s and inside `make test`.

---

## 2 — S3R2-2 / D34: the retryable refusal

Three pieces, and the loop is the **page's**: nothing on the server waits longer than E-27's 2 s budget.

### 2.1 `Retry-After` is a measurement

`render.ts`:

```
retryAfterSeconds({ p50Ms, backlog, capacity }) =
  min(10, max(1, ceil(p50Ms * (1 + ceil(backlog / capacity)) / 1000)))
```

- **`p50Ms`** is the median of the last 64 **completed** renders, measured around the render itself
  (after acquisition, before the row). A failure is not a service time and is not recorded. Until the
  first render, the prior is `STAMP_BUDGET_MS / 4` = 500 ms — a prior, replaced by the first measurement.
- **`backlog`** is the **process-global** gate's `active + waiting` (E-27/D33: the global cap is the one
  that binds; a tenant-local count would tell a buyer behind a shared box that nothing is ahead of them).
  A refusal thrown from inside a render subtracts its own slot — it is not work anyone waits for.
- **Capped at 10 s**: the whole chain (3 attempts × (2 s budget + 10 s wait) = 36 s) has to fit inside the
  token's 600 s first window, or the third attempt could be answered `continuation_expired` instead of a
  page. That is asserted, not assumed, in `R1`.

It rides on the error: `AppError(code, message, detail, retryAfterSeconds?)`, so **every** 503 from
`SKW_E_SEC_WATERMARK_FAILED` carries it (`queue`, `timeout`, `renderer`, `io`, `spec_invalid`,
`unstampable`), and `sendError` — unchanged — puts `err.retryAfter` on the wire.

### 2.2 The page

`GET /d/<key>/file` with `Accept: text/html` that is refused gets `503 text/html` with the same
`Retry-After`, a page that says the code has not been used, and a **client-side** retry: `setTimeout`
at `retryAfter*1000 + Math.random()*250 ms` (independent jitter per browser), `<noscript>` falls back to
one `meta refresh`, attempt 3 is terminal. `?retry=N` counts retries already made; the server uses it
only to pick the page — never as an authorisation. A JSON client (a store, a test) keeps the taxonomy
body unchanged.

### 2.3 The ledger: `kind='denied'`, one row per attempt

This is the part that made the retry actually work. A watermark refusal used to be written as
`kind='first'`, which tripped `ux_ev_jti_first`; `consumeUse` then read that row back as a terminal
denial, so a retry after a 503 could **never** be served even when the renderer recovered — QA's
`W14` recorded exactly that. A refusal authorises nothing and spends nothing, so it is a `denied`
event, not a redemption:

- attempt 1 (fails) → `denied:denied_watermark:0`
- attempt 2 (succeeds) → `first:ok:<bytes>` and `uses = 1`, once.

That also tightens the E1 reconciliation (`uses == COUNT(kind='first')`), which a denied `first` row
used to break by construction.

**Two gates were re-specified, not weakened.** `W4` and `W14` asserted "a retry under the same jti is
still a denial, one row". D34 reverses that decision, so they now assert *more*: each attempt writes its
own row (2 rows after a retry, `kind='denied'` both), `uses` is still 0, and the refusal carries
`Retry-After` whose value equals the store's own `retryAfterSeconds()`.

### 2.4 Evidence

| case | measurement |
|---|---|
| `R1` | `retryAfterSeconds`: idle 500 ms/0 backlog → **1**; backlog 16 of 8 → **2**; p50 1800 ms → **2**; 60 s p50 → **10** (cap); p50 0/7/250/2 s all in 1..10; **3 attempts worst case 36 s < window 600 s** |
| `R2` | store with an injected clock: measured **p50 1800 ms → `retryAfterSeconds() = 2`**, and the refusal's `err.retryAfter = 2`; a 0 ms p50 → **1** (not a constant) |
| `R3` | attempt 1 → **503, `retry-after: 1`**, page waits **1000 ms + 250 ms jitter**, next `/d/acme/file?retry=1`; attempt 2 → **200**, `x-accel: /__protected/wm/<spec>/<source>.pdf`, the file is the render's bytes; rows `denied, first`; **`uses = 1`** |
| `R4` | 3 attempts → **3 × 503**, rows `denied:denied_watermark:0` ×3, **`uses = 0`**, **0** `first` rows, terminal page (`data-terminal="1"`, no `?retry=3`, "has not been used"); a 4th attempt still spends nothing |
| `W4` | forced renderer error → 503 `retry-after 1`, x-accel absent, `denied` row, `uses 0`; retry → 503, **2 rows**, `uses 0` |
| `W14` | queued refusal → `reason=queue` after 49 ms, **`retry-after 1` = the store's own number**, 2 rows after the retry, `uses 0`, no render row |

### 2.5 The one place D34 is only half met, said plainly

"Each attempt writes its own `cms_download_event` row **with its reason**": the row is written per
attempt, and its `outcome` is `denied_watermark` — the class. The **finer** reason (`queue` /
`timeout` / `renderer` / `io`) has no column: `cms_download_event` is frozen at
`(kind, outcome, bytes_declared, bytes_sent, ip_hash, ua_hash, ts)`, and putting a reason into
`bytes_sent` or the `jti` would be a fabrication. So the reason travels in the 503's `detail.reason`
(asserted in `R2`, `W14`) and in one stderr line per refusal:

```
download refusal: code=12 asset=1 reason=queue outcome=denied_watermark
```

A `reason` column is a site-schema v4 change (model + amendment + kysely + projection). That is S4 work,
listed below — not something to fake now.

---

## 3 — Gates, and what moved

```
make test       421/421   0 failed   0 skipped   RC=0   89.8 s   (was 417/417, 107 s)
  node suite    421/421   68.0 s
  verify-dist   6/6       2.0 s      D1 485 ms · D2 551 · D3 586 · D4 50 · D5 74 · D6 68
make test-perf  8/8       53.2 s     P-S3d-1 peak 8 · P-S3d-2 cold 333 ms (budget 2000)
```

Four new cases (`R1`–`R4`); `E28-2`/`E28-3` rewritten in place; `W4`/`W14` re-specified.
`git status --short`: `app/download/plane.ts`, `app/download/render.ts`, `app/errors.ts`, `app/main.ts`,
`test/dist-witness.ts`, `test/dist-witness.test.ts`, `test/download-watermark.test.ts`,
`?? test/download-retry.test.ts`, `?? docs/build/S3-final-report.md` — nothing else, nothing committed.

Also fixed in passing, because it was a false statement inside the register I was rewriting:
`DIST_EXEMPT`'s reason (`S3R2-5`) now says the tool **ships** but is never invoked and cannot work from
`dist`, instead of claiming it is not shipped.

---

## 4 — Still open for S4

| # | Item | Why it is S4 |
|---|---|---|
| 1 | **A `reason` column** on `cms_download_event` (or an outcome vocabulary) so "each attempt with its reason" is true at the row, not only in the response and the log | site v4: `gen_schema.py`, an amendment, kysely, export projection, frozen quotes |
| 2 | `S3R2-3` — `detail.reason='queue'` is unreachable in a one-store deployment; every production refusal is `timeout`, so an alert on `queue` reads zero. The reason is now **logged**, which gives an operator a key; the observable itself is unchanged | needs a decision about the specified observable vs the observed one |
| 3 | `S3R2-4` — `bundle_verify`'s render-row check is manifest- and extension-scoped (unlisted `site.db`, `site`, `site.db.bak` pass). Tree-scoped for directories, not for databases | fix with the writer that produces bundles |
| 4 | `S3R2-6` — the 2 000 ms budget starts at the stamp stage, not at the socket (~7 ms of verify + open + stat in front of it) | measured, unchanged; a decision, not a bug |
| 5 | `S3R2-7` — a middle-window token that names no redemption still runs a full render before answering 401 (`stamp` precedes `consume`) | wasted worker, not a wrong answer; needs the plane to read the ledger first |
| 6 | **A retry-storm measurement**: `R3`/`R4` prove the *contract*; nobody has driven 40 refused buyers through the page's jitter at once. QA's own unmeasured item | belongs in `test/perf` with a 40-buyer harness |
| 7 | The retry counter is **client-held** (`?retry=N`): a reload restarts at attempt 1. Harmless — nothing is spent and the token bounds the window — but an operator counting attempts from the query string would be wrong | needs a server-side attempt record, which is item 1's column again |
| 8 | `tools/regen_conf.ts` keeps `DIST_EXEMPT` (wording now true) until E-28 item 7 takes its root from `findProjectRoot` | S4 packaging |
| 9 | `check_frozen.py` still prints `pointers: 23/23` (E-28 builder item 8, `range(1, 29)`) | carried from round 1, untouched here |
