# S2 QA — admin + data plane, reviewed as a whole (S2a–S2e)

**QA:** independent of the Builder. **Date:** 2026-10-20. **Tree:** `b1aec3e` (S2e), clean at
start (`git status --short` empty). **Method:** `docs/sds/SDS.md` §16 S2 row by row, the five
gates' negative controls, and seven defeat attempts against the implementation rather than the
tests.

---

## 0. Verdict — **NO-GO**

| | |
|---|---|
| §16 S2 rows | **8 of 8 have a green gate I ran myself. 0 NOT COVERED. 0 FAIL.** One row (the DDL AST) is covered by *substituted* gates: the file §16 names does not exist. |
| Gates | `make test` **exit 0** (27/27 claims, 269/269 tests, 0 skipped). `make verify-s1` **exit 0**. `make verify-claims-modern` **exit 0** (27/27, SQLite 3.53.x). |
| Negative controls | **5 of 5 go red** when broken and green again after a hash-verified restore. One of them exposed a *redundant* refusal, not a hole (§3, NC1). |
| Defeat attempts | **7 of 9 fail closed.** One is broken — **A5**, a `view` source re-pointed at `cms_page` after publish — and one is weak — **A5b**, an out-of-band column drop becomes a raw `SQLITE_ERROR`. The seal is not a defeat attempt; it is B1, below. |
| Blocker | **B1 — the daily seal can never verify a day that has any later audit row.** The C-21 anchor is write-only, and the gate that "proves" it tests only the failing direction, so the defect reads as a pass. |
| Majors | 4 (§6): the view source is unanchored; errata item 12 is undone and §16 is stale; the plan refusal has no exclusive witness; §6.2's "re-checked at render" is only true of the column allowlist. |

The table is green and the slice is still not GO. §16 S2's eight rows do not cover the seal, the
operator bootstrap (until the errata adds three rows, which were not pasted), the source allowlist
or the resolver's tenant isolation — i.e. **the risk that stops S2 lives outside the table QA was
told to grade.** That is a finding about the table as much as about the code.

---

## 1. The gates, run myself

```
$ make test
verify-toolchain: /usr/bin/python3 -> python 3.9.6, sqlite 3.43.2, argon2 ok
PASS  13 must-ignore + 7 must-keep = 20 paths behave as intended
PASS  1 schema/ER parity + negative tests …  PASS 27 connection classes: query_only is not tenancy (C-15)
27/27 passed, 0 skipped, 0 failed
1..269
# tests 269  # pass 269  # fail 0  # skipped 0
make test  45.76s user 6.88s system 88% cpu 59.729 total
EXIT=0

$ make verify-s1
1..269
# tests 269  # pass 269  # fail 0  # skipped 0
VERIFY_S1_EXIT=0

$ make verify-claims-modern          # MODERN_PYTHON=python3, SQLite >= 3.50
27/27 passed, 0 skipped, 0 failed
EXIT=0
```

**G3 is still closed** (this was S1-qa's gate finding, re-checked because S2 rides the same edge):

```
$ SKW_SKIP_DOCKER=1 make verify-s1
!!!  skipped: E-17: a peer outside SKW_ADMIN_ALLOWLIST is nginx's 403, …
run-node-tests: refusing to report a green gate over skipped tests
EXIT=2
```

269 = 244 (S2d) + 25 new, and I counted the new files independently: `sources` 10, `preview` 4,
`kysely-types` 3, `seal-scheduler` 4, `admin-sources` 4. The builder's arithmetic is right.

**Carried, not re-raised:** `.github/workflows/gate.yml` still says of itself *"This workflow has
still never executed on GitHub Actions"*. §16's preamble ("a slice is done when its gate is green
in CI") is therefore unproven for S2 as it was for S1. S1-qa recorded it as a follow-up (G4); I
add only that the file has since been repaired (a provisioned 3.14 interpreter asserting ≥ 3.50)
and still has no green run.

---

## 2. §16 S2, line by line

Every row below was run on this tree, by me, with the pattern that selects it.

| # | Criterion (§16 S2) | Gate as written | What I ran | Result |
|---|---|---|---|---|
| 1 | every non-GET without a valid CSRF token is `403 SKW_E_SEC_CSRF` | 12-case suite | `node --test --test-name-pattern='^matrix' test/admin-csrf.test.ts` | **PASS** — 11 of the 12 matrix cases are refusals with that exact code; case 12 is the positive control (exact Origin + good token → 200), so the matrix is not a list of refusals with no success path. The file's 15 tests all pass |
| 2 | `Origin` mismatch on a non-GET is `403` | same | same run, cases 8–11 (no Origin, foreign Origin, `admin.skw.test.evil.test`, `http://` scheme) | **PASS** — all four 403 `SKW_E_SEC_CSRF`; the suffix case is the one that catches a `startsWith` comparison |
| 3 | the DDL AST refuses the two statements SQLite refuses, **before any SQL** | `ddl.test.ts` over the 19-statement corpus | `node --test --test-name-pattern='^O[23]\.' test/ddl-runner.test.ts` | **PASS, by substitution.** O2 refuses `ADD COLUMN … NOT NULL` with no default with `open: () => { throw }` — the connection provably never opens; O3 refuses `DROP COLUMN` on an indexed column with `rebuild_required`. **The gate §16 names does not exist**: there is no `test/ddl.test.ts`, and the 19-statement corpus is the *write validator's* (§10, S4's), not the DDL AST's. Behaviour gated; gate cell wrong |
| 4 | a `u_*` table with an `asset_key` gets its guard trigger **in the same transaction** | schema assertion after the runner | `node --test --test-name-pattern='^O1\.' test/ddl-runner.test.ts` | **PASS** — the trigger is statement 2 of the emitted batch (`CREATE TRIGGER "trg_asset_guard_u_post" BEFORE DELETE ON cms_asset`), its registry row is statement 3; C4 (`SIGKILL` before COMMIT) proves the batch is one transaction; O1 then fires the guard with `foreign_keys=0` and gets `SKW_E_DM_ASSET_IN_USE` |
| 5 | a `query` source with a `SCAN` in its plan is refused at publish | plan test with an unindexed column | `node --test --test-name-pattern='^S2E-[12]\.' test/sources.test.ts`; `node scratch/s2e/plan-refusal.ts` | **PASS** — refused `422 SKW_E_RT_SOURCE_UNINDEXED`, `detail.column='status'`, `detail.plan=["SCAN u_posts USING INDEX ix_posts_published_at"]`; adding `ix_posts_status` publishes it (`SEARCH … (status=?)`, `cost_ms_max=0.033`, `cost_rows=6`). Reproduced the builder's probe verbatim. **But see §3 NC1**: the refusal has two witnesses and the test cannot tell them apart |
| 6 | two parameter sets inside one TTL return their own rows | cache test, both orders | `node --test --test-name-pattern='^S2E-6\.' test/sources.test.ts`; `node scratch/s2e/cache-ttl.ts` | **PASS** — order A and order B both correct, `row sets differ: true`, cache size 2, plus an enum pair (`draft` 2 / `published` 5). The probe reproduces |
| 7 | a preview token is accepted only for `status='draft'`, 30 min, `no-store` | O-29 test | `node --test test/preview.test.ts` | **PASS** — 4/4. Draft renders 200 with `cache-control: no-store`; published page 404; a token 30 min + 1 s old 404; another path 404; `exp` exactly `now + 1800`; one log line per accepted render |
| 8 | `SKW_SCHEMA_EDIT=off` hides the builder entirely | UI assertion, no disabled control | `node --test --test-name-pattern='^(BUILD-1|BUILD-2)\.' test/admin-builder.test.ts` | **PASS** — off: `/builder` is 404 `SKW_E_PLT_TENANT_UNKNOWN` **and** the tenant home contains no `/builder/i`; on: the link and the form are present. This is the "absent, not disabled" shape §9.4 asks for |

**Tally: 8/8 PASS, 0 FAIL, 0 NOT COVERED, 1 substituted gate (row 3).**

### 2.1 The rows the errata added, and the ones §17 claims

The errata's checklist item 12 requires three new §16 S2 rows; they are **not in §16** (see §6,
D2). The gates exist and are green, so I adjudicate them here instead:

| Criterion (02-errata.md §7) | What I ran | Result |
|---|---|---|
| a fresh seeded `control.db` and nothing else yields one operator, and a TOTP code from the printed URI logs in | `node --test test/cli-bootstrap.test.ts` (test 1) | **PASS** — 10/10 in the file, including a real code from the URI logging in through the login route |
| a second bootstrap writes nothing: exit 3, `password_hash`/`totp_secret`/`must_change` byte-identical | same file, test 2 | **PASS** |
| no TOTP secret or password reaches stdout, `audit_log`, `BUNDLE.json` or `control.seed.json` | same file, test 9 | **PASS** |

§17 rows whose "Proved by" cell says **S2** — checked because a false attribution is how a
register rots:

| Register row | §17 claim | What exists | Judgement |
|---|---|---|---|
| C-11 `/admin/t/<key>/…`, session only | S2 (resolver test) | session-before-action is the first line of `#tenantRoute`; the no-session paths are 404 in the listener/auth suites | **covered** (the name "resolver test" is loose, the behaviour is gated) |
| C-13 seven-op AST | MT + S2 corpus | S2's corpus is `ddl-runner.test.ts` O1–O7/R1–R4 (18 tests) | **covered** |
| C-18 `function` removed | MT + S2 publish gate | `S2E-8` + `S2E-23` (HTTP) | **covered** |
| C-23 `template` is a slug against the shell registry | MT check 26; **S2 (publish refusal)** | no S2 test; §16 puts that publish refusal in **S4** | **mis-attributed** — D10 |
| O-17 `site.page(path)` nested path | **S2 (nested-path test)** | `site.*` does not exist anywhere in `app/` or `test/` (`grep -rn "site\.page"` → 0) | **mis-attributed** — D10; the builder's own §7.1 defers it to S4 |
| O-30 spam cases | **S2 (spam cases)** | no intake, no spam test anywhere | **mis-attributed** — D10 |
| O-33 `SKW_FLEET_MODE=0` role refusal | S2 (role refusal) | `admin-auth.test.ts:317`, 403 `SKW_E_SEC_ROLE_DISABLED`, no `Set-Cookie` | **covered** |

---

## 3. Negative controls — five, broken, proved red, restored by hash

Method for each: `sha256sum` the file, mutate one behaviour, run the gate that owns it, `git
checkout --` the file, `sha256sum` again, re-run the gate. The tree is `b1aec3e`, so the restore
is exact and the hash is the proof.

### NC1 — SCAN refusal (`app/sources/publish.ts`, `app/sources/plan.ts`)

| Mutation | Gate | Result |
|---|---|---|
| `if (report.scan) refusePlan(report, n.spec)` → `if (false)` | S2E-1 | **`ok 1` — still green.** |
| `culpritColumn` skips its `where` loop (names `title` instead of `section`) | S2E-1 | **`not ok 1` — "the refusal must name section; detail was {"column":"title",…}"** |
| both `refusePlan` **and** `assertIndexedColumns` disabled | S2E-1 | **`not ok 1` — "an unindexed filter column must be refused"** |

**This is a finding, not just a control.** The plan refusal has **no exclusive witness**: with it
disabled, `assertIndexedColumns` throws the same code, the same `detail.column` and a `plan` array
that still matches `/SCAN/`, so S2E-1 cannot tell whether `EXPLAIN QUERY PLAN` ran at all. The
builder's M1 reports this mutation turning S2E-1 red; on this tree it does not, so either M1
mutated more than the plan line or the run predates the index rule. Either way the gate **as
committed** cannot witness the check it is named for. The behaviour is still refused; the gate for
the row's headline check is deadweight. Defect **D3**.

Hashes after restore: `publish.ts f9352c51dff126e0483ce82081e107a54d6bfb8d5107c49b26353b4d2748655b`,
`plan.ts b6a6db202cac4769db3a9763dd929b398ea77e8cd01441ba5b0219e8a585bc20` — both identical to
before. Green after: `ok 1`, `ok 2`.

### NC2 — the parameter-set cache (`app/sources/cache.ts`)

Mutation: `cacheKey(...)` drops `sha256(canonicalParams(params))` — the O-10 defect itself.

```
not ok 1 - S2E-6. two parameter sets inside one TTL return their own rows, in both orders (O-10)
    the {limit:5} request was served the {limit:3} entry
# pass 0  # fail 1
```

Restored `c81c8d147b4bed0e5b3ce77a9c831690b9194f3ecac3c6969e6cc76d17d71697` (identical) → `ok 1`. **Control passes.**

### NC3 — `is_public` (`app/sources/publish.ts`)

Mutation: `isPublic: input.isPublic === true` → `input.isPublic !== false` (the default flips to
public).

```
not ok 1 - S2E-4. is_public=false is refused by the resolver; an audited publish flips it …
# pass 0  # fail 1
```

Restored `f9352c51…` (identical) → `ok 1`. **Control passes** — and it fails on the *default*,
not only on an explicit `false`, which is the case that matters.

### NC4 — preview token (`app/render/preview.ts`)

Mutation: `if (row === undefined || row.status !== 'draft')` → `if (row === undefined)` (a token
is accepted for a published page).

```
not ok 1 - S2E-12. the same token is rejected for a published page
# pass 0  # fail 1
```

Restored `a4e73b4b161d92ae6ea5013da9d9536d2e19971650a17c17c3c70b1f7429faff` (identical) → 4/4 green. **Control passes.**

### NC5 — audit seal (`app/audit/chain.ts`)

Mutation: `writeSeal` returns the existing seal instead of refusing a different head.

```
not ok 1 - S2E-19. a second seal for the day with a different head is refused and does not overwrite the anchor
# pass 0  # fail 1
```

Restored `ed9fe1fd05ede1ff6d226bb94d8965ceab69fc1a0bd35fbdcde91bc0e721f859` (identical) → 4/4 green. **Control passes.**

> NC5 proves the refusal *fires*. It does not prove the seal is *useful* — that is §5, and the
> answer there is no.

---

## 4. Defeat attempts against the implementation

All through the real app (`buildApp` + a socket + a real session), the real schema, or the exact
object `main.ts` hands a template. No mocking.

| # | What I sent | What came back | Verdict |
|---|---|---|---|
| **A1** | `POST /admin/t/acme/sources/publish` JSON, `columns:["title","secret_col"]` — bypassing any form | `422 SKW_E_RT_SOURCE_UNKNOWN`, `{"reason":"column_not_allowed","column":"secret_col","role":"columns","relation":"u_posts"}`; `cms_datasource` rows written: **0**. A column of another table (`body_html`) → 422. `table:"cms_audit"` → 422 (grammar refuses the prefix) | **Held.** The allowlist is the schema's record, not a config list, and the JSON route is the same gate as a form would be |
| **A2** | five grammar injections: `where.op = "= ? OR 1=1 --"`; `where.col = 'status" OR 1=1 --'`; `order.dir = "DESC; DROP TABLE u_posts"`; `table = "u_posts; DROP TABLE u_posts"`; `columns:["title","title FROM u_posts; --"]` | all five `422 SKW_E_RT_SOURCE_UNKNOWN`; `u_posts` still 1 table / 6 rows afterwards | **Held.** Operators are a closed set (`WHERE_OPS`), identifiers are `^[a-z][a-z0-9_]{0,39}$` and quoted, values are always `?` |
| **A2b** | runtime params on the published source: `status="published' OR 1=1 --"`; `order:"title;--"`; `status=1`; `limit:"5; DROP TABLE u_posts"` | `param_invalid`, `param_unknown`, `param_invalid`; **the fourth resolved 3 rows** (the string `limit` is ignored, not refused) | **Mostly held**; the silently-ignored string `limit` is **D5** |
| **A3** | `is_public=false`, asked from the object `main.ts` builds (`createRenderData(..., audience:'render')`), then with `audience:'preview'` | render: `SKW_E_RT_SOURCE_UNKNOWN reason=not_public key=private-posts`. preview: **resolves 3 rows** — by design, and reachable only with a valid O-29 token: `/soon` with no token → 404, forged token → 404, token minted for another path → 404 | **Held.** Note for the record: **no S2 shell calls `data.source`** (`grep -rn "data.source"` matches only the doc comment), so "publish then render on a page" has no end-to-end gate in this slice — see §8 |
| **A4** | reuse a preview token 30 min + 1 s after minting; then after the page is published; then a token minted for another tenant; then one minted with `exp` 90 min out | 404, 404, 404, 404; the published page with no token 200 | **Held.** `verifyPreviewToken` also refuses `remaining > 1800`, so a long-lived token minted by a key-holder is not accepted |
| **A5** | a `view` source over `cms_v_posts_public`; then `DROP VIEW`; then `CREATE VIEW … AS SELECT path AS title, slug FROM cms_page`; then recreate it without `title` | dropped → `SKW_E_RT_SOURCE_UNKNOWN reason=view_missing` (a taxonomy refusal, not a SQL error). **re-pointed → RESOLVED `[{"title":"/pricing","slug":"pricing"},{"title":"/soon","slug":"soon"}]`** — `cms_page` rows served through a source published over `u_posts`. altered-without-title → `column_not_allowed` | **BROKEN — D1.** The `checksum` in `cms_view_registry` is never read; the publish anchor does not survive a view redefinition |
| **A5b** | a `query` source whose table lost a column out-of-band (`ALTER TABLE u_posts DROP COLUMN slug`) | `SQLITE_ERROR: no such column: "slug"` — raw, no taxonomy code, i.e. a 500 on a public render | **Weak — D6.** Needs out-of-band drift (the DDL runner updates `columns_json` in the same transaction), but the resolver has no catch-all |
| **A6** | concurrent publish + resolve of the same source: a child process published 25 times (alternating two specs) while the parent resolved in a loop, two connections | `child exit 0`; **726 resolutions** during the loop; distinct shapes `{"3 rows [title]":623, "3 rows [slug,title]":103}`; **errors: none**; no `SQLITE_BUSY`; 14 cache clears | **Held.** A resolver never saw a half-published spec, and a republish was never served from a stale cache entry (the key carries `specRev`) |
| **A7** | `limit=1000` (max 5); `limit=-5`; `limit=0`; `limit=2.7`; `limit="5"`; `limit=Number.MAX_SAFE_INTEGER` | clamped `limit=5 truncated=true`; refused `param_invalid`; refused; floored to 2; **`limit="5"` → `rows=3 limit=3` (silently ignored)**; clamped 5 truncated | **Held except the string** — **D5**, and it is the shape S4's `data-limit` attribute will produce |

Two more things I sent that are worth recording:

- **A published page's own `?preview=` token**: `/pricing?preview=<token minted for /soon>` → 404.
  A token cannot be re-pointed by path.
- **`limit` above `limit_max` on a `view` source** published fine with an **unindexed `order`
  column** — because the plan and index rules run only `if (kind === 'query')`. §6.2 says
  "table/view". See D1.

---

## 5. The daily seal — the clock works, the anchor does not

### 5.1 It runs on a clock

`buildApp` starts it (`app/main.ts:150`), so the running process is the invoker; the timer is
`unref()`d so it cannot hold shutdown. Measured:

```
ms to next UTC midnight at 23:00:00Z      : 3600000
ms to next UTC midnight at 00:00:00Z      : 86400000      (no zero-delay spin)
ms to next UTC midnight at 23:59:59.500Z  : 500
scheduler nextRunAt: 2026-10-21T00:00:00.000Z | stopped? false
after stop(): stopped? true | seal rows written: 0
```

The tick seals `utcDay(tick - 1000)` — the day that just ended — and `skwctl audit seal|verify`
is the operator's half. So **the answer to "does anything invoke it" is yes**.

### 5.2 A missed day is silent

If the process is not alive at 00:00 UTC (a deploy, a crash, a paused VM) the tick is simply not
scheduled for that day. Nothing backfills it, nothing scans the seal table for gaps, and `/healthz`
reports `{ build, uptime }` only.

```
seal rows for 2026-10-21: 0
verifyAgainstSeal(acme, 2026-10-21): REFUSED SKW_E_SEC_AUDIT_SEAL / no seal for 2026-10-21
skwctl audit verify --day 2026-10-21 -> exit 1  stderr="REFUSAL: AUDIT_SEAL_MISMATCH: SKW_E_SEC_AUDIT_SEAL: no seal for 2026-10-21"
```

So a missed day is visible **only** to an operator who already suspects it and names the exact
date. That is not "visible"; it is "findable". And the repair is not faithful: `sealDay` is
cumulative (`rows = count(cms_audit)`, `head = chain head now`), so a backfilled seal for the 21st
written on the 22nd records the 22nd's row count:

```
backfilled seal for 2026-10-21: [{"key":"acme","rows":2,"created":true}]   # one of those rows is the 22nd's
seal row: {"tenant_key":"acme","day":"2026-10-21","rows":2,"head":"6400a793…","sealed_at":"2026-10-22T12:00:00.000Z"}
```

Only `sealed_at > day` betrays it, and nothing checks that.

### 5.3 **B1 — a seal older than the latest audit row can never verify** (the blocker)

`verifyChain` walks the whole chain and returns the head of *all* rows; `verifyAgainstSeal`
compares `seal.rows`/`seal.head` to that live report. So a seal is only verifiable while the chain
still has exactly the rows it sealed — i.e. between the seal and the next audit write.

```
verify 2026-10-20 immediately after its seal   : OK rows=2
verify 2026-10-20 after one row on the 21st    : REFUSED SKW_E_SEC_AUDIT_SEAL / the chain disagrees with the seal for 2026-10-20
verify 2026-10-21 immediately after its seal   : OK rows=3
verify 2026-10-21 after one row on the 22nd    : REFUSED SKW_E_SEC_AUDIT_SEAL / the chain disagrees with the seal for 2026-10-21
verify 2026-10-20 the day after that           : REFUSED SKW_E_SEC_AUDIT_SEAL / the chain disagrees with the seal for 2026-10-20
```

Consequences, in order of how much they matter:

1. **The control has no discriminating power for history.** `skwctl audit verify --day <any past
   day>` returns exit 1 "the chain disagrees with the seal" for an untouched log and for a
   tampered one. A signal that always fires is not a signal — and the operator's rational response
   after the third false alarm is to stop running it.
2. **The series is write-only.** Every day's seal is correct at the instant it is written and
   unusable afterwards. It anchors nothing that can be re-checked.
3. **The builder's gate blesses it.** S2E-21 asserts that a chain which moved after the seal must
   fail — correct for tamper, but equally true of every new day's traffic, and nothing in the suite
   separates the two. `verify_claims.py` check 25 has the same shape: it deletes the tail and
   asserts the seal mismatches; it never asserts that an *untouched, grown* chain still verifies.
   Both gates can only pass in the failing direction, which is why 269/269 green did not catch it.
4. **S3 makes it certain.** Gated downloads write `cms_download_event` and audit rows continuously,
   so from S3's first day every prior seal mismatches. The fix is small — recompute the head after
   `seal.rows` rows and compare that prefix, or store a per-day delta and compare
   `count(*) WHERE ts LIKE day` — but it is a change to `chain.ts` and to both gates, not a note.

**This is the blocker.** It is not a data-exposure defect; it is the integrity anchor of §9.6,
shipped in a state where the only way to use it produces a false accusation.

---

## 6. Defects

| # | Severity | Defect | Evidence |
|---|---|---|---|
| **B1** | **blocker** | A seal older than the latest audit row always fails verification; the control cannot distinguish tamper from ordinary new traffic, and its two gates test only the failing direction | §5.3 |
| **D1** | major | A `view` source is not anchored to its definition: `cms_view_registry.checksum` is written and never read, so re-pointing the view (e.g. `AS SELECT path AS title … FROM cms_page`) makes the published source serve another table with no republish. `view` sources also skip the plan and index rules (`if (kind === 'query')`) | §4 A5; `grep -rn checksum app/` → trigger registry only |
| **D2** | major (process) | Errata checklist item 12 is not done: none of E-16..E-19 is pasted into `SDS.md`, there are **0** `Amended by 02-errata.md E-16…E-19` pointers against **14** for E-1..E-15, and §16 S2 still has **8** rows instead of the 11 the errata requires — the three bootstrap rows are absent. None of `SKW_E_SEC_AUTH_INVALID`, `SKW_ADMIN_ALLOWLIST`, `SESSION_ABSOLUTE_MS` or `skwctl admin bootstrap` appears in the SDS at all. (`make test` passes because the frozen-quotes gate compares quotes, not completeness.) The errata also says "add the **four** §16 rows below" and then lists three | §2.1; `grep -n "Amended by 02-errata" docs/sds/SDS.md` |
| **D3** | major (gate) | The SCAN refusal has no exclusive witness: with `refusePlan` disabled, S2E-1 stays green because `assertIndexedColumns` produces the same code, column and plan text. §16 row 3 also names a `ddl.test.ts` and a 19-statement corpus that do not exist in S2 (the corpus is the S4 write validator's) | §3 NC1 |
| **D4** | major (spec/impl) | §6.2 says every rule is "enforced at publish and **re-checked at render**". Only the column allowlist is re-checked; the plan, index and budget rules run at publish only, and only for `query`, though §6.2 says "table/view". A dropped index or a re-pointed view therefore serves without republish | §4 A5/A5b; `app/sources/resolve.ts` |
| **D5** | minor | `limit` as a string is **silently ignored** rather than refused or coerced: `data.source('posts',{limit:'5'})` returns 3 rows. Every other invalid or unknown parameter is a `param_invalid`/`param_unknown`, and the `list` component's `data-limit` is an HTML attribute, i.e. always a string | §4 A2b/A7 |
| **D6** | minor | A `query` source whose table lost a column out-of-band throws a raw `SQLITE_ERROR` (`no such column: "slug"`) with no taxonomy code — a 500 on a public render. The DDL runner keeps registry and table consistent, so this needs out-of-band drift | §4 A5b |
| **D7** | minor (accuracy) | S2d and S2e both state `scratch/s2d/` / `scratch/s2e/` are "not committed". They are: 17 files, in `100f058` and `b1aec3e` | `git ls-files scratch/s2d scratch/s2e` |
| **D8** | minor | No session sweeper: expired `session` rows are enforced on read but never deleted (disclosed in S2b §7.9) | S2b §7.9 |
| **D9** | carried (gate) | CI has still never run; §16's "green in CI" is unproven for S2. Repaired in the file, no green run | `gate.yml` header; S1-qa G4 |
| **D10** | minor (traceability) | §17 claims S2 proof for **O-17** (`site.page` — not implemented anywhere), **O-30** (spam cases — no code, no test) and **C-23** (publish refusal — no test, and §16 puts it in S4) | §2.1 |

---

## 7. The builder's "remaining" list, judged

S2e §7 lists five items and calls none of them a row of §16. That framing is *mostly* right and
partly a deferral dressed as S4.

| S2e §7 item | Builder's owner | My judgement |
|---|---|---|
| 1. `site.page(path)` nested-path test | S4 (template helper) | **Genuinely S4.** Nothing in the resolver depends on it, and §6.3's `list` is where it is used. But §17 **already claims it as S2** (O-17) — the deferral is honest, the register is not (D10) |
| 2. `cms_view_registry` postcondition **and a checksum comparison for a `view` source** | S4 / "no gate to write yet" | **S2 gap, not S4.** The postcondition half is fair (no op creates a view). The checksum half is not: my A5 re-points a view with one statement and the published source serves `cms_page`. The gate is a resolve-time `sqlite_master.sql` hash against `checksum`, it is writable today, and it is the only thing that makes a `view` source an anchored object. **Reject the deferral.** |
| 3. `list`'s SSR and the `data-truncated` wire form | S4 | **Genuinely S4** — except the input side: the `limit` the `list` will pass comes from an attribute and is a string, which S2 silently ignores (**D5**). Small S2 fix, S4 blocker otherwise |
| 4. Export enumeration of source parameters (`SKW_SNAPSHOT_MAX_COMBOS`, `free` refusal) | S4 | **Genuinely S4** — exporter work, §6.4 |
| 5. The source authoring form | S4 | **Genuinely S4** — the JSON route is the gate's caller and the form must not be a second gate |

**Tally: 3 genuinely S4, 1 S2 gap (item 2), 1 partly S2 (item 3's `limit` coercion).** Two items
that S2d disclosed and S2e did not close are also still open by design: the DDL runner's
`cms_view_registry` postcondition, and the session sweeper.

---

## 8. What I did not prove

- **The last mile: publish → page → rendered rows.** No S2 shell calls `data.source` (`grep`
  matches the doc comment only), so the only end-to-end path exercised is "a draft page renders
  with a token". The source plane is reached through the exact object `main.ts` constructs, not
  through a template. S4's `list` is the first consumer, and that integration has no gate yet.
- **`make test` under CI.** D9.
- **A real nginx for the S2 paths.** The edge suites ran (G3 proves they are not skipped), but the
  CSRF/session/source routes were exercised on `app.listen`, not through the generated config.
- **Argon2 timing stability over many runs.** I ran the suite once (§1); S2d's §5.3 reports ten
  runs. The E-16 case passed in my run; I did not re-measure the distribution.
- **`SKW_SCHEMA_EDIT=off` on a public listener** (only the admin host was exercised).

---

## 9. The one thing most likely to break in week one

**The daily audit seal — first deploy that is not at 23:50.** Two failures land together and both
look like something else:

1. A deploy or a restart that straddles 00:00 UTC means no tick, so that day has **no seal**, and
   nothing anywhere says so — not `/healthz`, not the console, not a log line at startup. The
   operator finds out only by running `skwctl audit verify --day <that date>`.
2. From the first audit row written after a seal, `skwctl audit verify --day <that day>` answers
   **`SKW_E_SEC_AUDIT_SEAL — the chain disagrees with the seal`**, which is the exact string a real
   tamper produces. The first person to run it will escalate a false incident; the second will stop
   running it.

That is the failure mode I would expect in week one: not an attacker, an operator losing trust in
the one control that is supposed to be trustworthy when everything else has been rewritten.

---

## 10. Reproduction

Everything above is a command on `b1aec3e`, in this order:

```
make test                       # exit 0, 27/27 claims, 269/269
make verify-s1                  # exit 0, 269/269
make verify-claims-modern       # exit 0, 27/27
SKW_SKIP_DOCKER=1 make verify-s1  # exit 2 — the skip gate still holds

node --test --test-reporter=tap --test-concurrency=1 test/admin-csrf.test.ts
node --test --test-reporter=tap --test-concurrency=1 --test-name-pattern='^O1\.' test/ddl-runner.test.ts
node --test --test-reporter=tap --test-concurrency=1 --test-name-pattern='^O[23]\.' test/ddl-runner.test.ts
node --test --test-reporter=tap --test-concurrency=1 --test-name-pattern='^S2E-[12]\.' test/sources.test.ts
node --test --test-reporter=tap --test-concurrency=1 --test-name-pattern='^S2E-6\.' test/sources.test.ts
node --test --test-reporter=tap --test-concurrency=1 test/preview.test.ts
node --test --test-reporter=tap --test-concurrency=1 --test-name-pattern='^(BUILD-1|BUILD-2)\.' test/admin-builder.test.ts
node --test --test-reporter=tap --test-concurrency=1 test/cli-bootstrap.test.ts
node scratch/s2e/plan-refusal.ts
node scratch/s2e/cache-ttl.ts
```

The probes this review added are in `scratch/s2-qa/` (untracked, not committed — `git status`
shows exactly that one directory):

| File | What it does |
|---|---|
| `defeat.ts` | A1–A5, A7 over a real socket with a real session; the JSON route, the resolver, the preview token, the view re-point |
| `pub-loop.ts`, `race.ts` | A6: two processes, 25 publishes against 726 resolutions |
| `seal-clock.ts` | §5.1/5.2: the schedule arithmetic, the tick's day, the missed day, the CLI's exit codes |
| `seal-backfill.ts` | §5.2: a backfilled seal carries the file's current rows/head |
| `seal-history.ts` | §5.3: the blocker, five verifications |
| `drop-column.ts` | A5b: the raw `SQLITE_ERROR` |

Mutations were made with `perl -0pi`, reverted with `git checkout --`, and every file's SHA-256
was taken before and after; the five hashes in §3 are identical to the ones on `b1aec3e`:

```
f9352c51dff126e0483ce82081e107a54d6bfb8d5107c49b26353b4d2748655b  app/sources/publish.ts
c81c8d147b4bed0e5b3ce77a9c831690b9194f3ecac3c6969e6cc76d17d71697  app/sources/cache.ts
a4e73b4b161d92ae6ea5013da9d9536d2e19971650a17c17c3c70b1f7429faff  app/render/preview.ts
ed9fe1fd05ede1ff6d226bb94d8965ceab69fc1a0bd35fbdcde91bc0e721f859  app/audit/chain.ts
b6a6db202cac4769db3a9763dd929b398ea77e8cd01441ba5b0219e8a585bc20  app/sources/plan.ts
```
