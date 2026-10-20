# S2 QA — round 2, against the E-20..E-23 fix

**QA:** independent of the Builder. **Date:** 2026-10-20. **Tree:** `9c6402b` ("S2 fix: segment seal
(E-20), view anchoring (E-21), exclusive witness (E-22), §16 repaste (E-23)"), `git status --short`
empty except my own untracked probe directory `scratch/s2-qa2/`.

**Method.** Round 1's findings are re-tested against the implementation, not against the tests: the
blocker through the real `skwctl` on real `control.db`/`site.db` files, M1 through the real publish
gate, resolver and DDL runner, M3 by disabling the mechanism and watching the gate, M2 by counting
§16's rows, and the four `check_frozen.py` supersessions by breaking each of their three legs.
`make test` was run three times with full logs, and once under deliberate CPU load to chase the
Builder's disclosed flake.

---

## 0. Verdict — **GO**

| | |
|---|---|
| Blocker (B1) | **closed.** The seal verifies a day that has a successor (step 3 **PASS**) *and* refuses a tampered segment (step 4 `head_mismatch`) and a truncated one (step 5 `count_mismatch`). The control now has discriminating power, which it did not have in round 1. |
| Round-1 majors | M1 **closed**, M3 **closed**, M2 **closed**, M4 **partly closed** — the dangerous direction is gone (no plan/index/budget rule claims to be re-checked at render), but the replacement sentence contradicts its own table and one of the rules it names is not implemented (**M5**, new). |
| Round-1 minors | D5 **not closed** and now written into the SDS as if it were (M5); D6, D10 open by the errata's own decision; D8 unchanged (S2b's, not this slice's). |
| Gates | `make test` **exit 0 three times** (300/300 each), `make verify-claims-modern` **27/27**. |
| New majors | **M5** (§6.2 asserts a `limit` refusal that does not exist; `limit:'5'` still resolves) and **M6** (the seal-health field cannot report a gap older than one day). |
| New minors | **the suite is not load-tolerant** — 2 named failures at 14× CPU load and **13 of 300** in a `hermes verify` run, on a tree that is green six times when idle (this is the disclosed flake's class, D12); `check_frozen.py`'s new completeness phase counts rows instead of identifying them; §16's seal row names a test file that does not contain `B1-8`. |

**Why GO and not NO-GO.** The rule in `.agents/QA.md` is "no GO with an open blocker", and there is
none: the integrity anchor of §9.6 now works, and it was demonstrated on real files in both
directions. M5 and M6 are majors for the CEO to disposition, not controls that fail open on a
security decision — M5 renders `limit_default` rows where a caller asked for `limit`, and M6 makes a
missed seal day invisible on one surface while `audit status` and the `audit_log` gap rows still
report it. Neither corrupts data, serves the wrong tenant's rows, or accepts a forged token.

**What changed my judgement since round 1, in one line:** round 1's blocker was a control that
always accused; the fix produced a control that accuses only when something is wrong, and I could not
break it in seven attempts.

---

## 1. Round-1 findings, closed or re-raised

| Round-1 | Subject | Round-2 status | Evidence |
|---|---|---|---|
| **B1** blocker | a seal older than the latest row can never verify; both gates tested only the failing direction | **CLOSED** | §2, seven steps; step 3 PASS, steps 4–5 refuse with distinct reasons; `B1-1` exists and check 25 now asserts both directions |
| **D1 / M1** major | a `view` source is not anchored; re-pointing the view serves `cms_page` | **CLOSED** | §3.1 — `422 SKW_E_RT_SOURCE_UNKNOWN reason=view_checksum`, zero rows; the DDL path un-publishes and audits in the same transaction |
| **D3 / M3** major (gate) | the SCAN refusal has no exclusive witness | **CLOSED** | §3.2 — disabling `refusePlan` leaves `S2E-1` green and makes `S2E-11` red; the reverse mutation does the reverse |
| **D2 / M2** major (process) | §16 S2 is 8 rows of 11; E-16..E-19 never pasted | **CLOSED** | §5 — 13 rows, `13/13`, five required strings present, 23/23 pointer items, `make verify-frozen` PASS |
| **D4 / M4** major (spec) | "re-checked at render" is true of one rule | **PARTLY CLOSED → M5** | §3.3 — the plan/index/budget overclaim is gone; the new sentence says "exactly the two rows marked **both**" while its table marks **three**, and the third (`limit`) is not implemented |
| **D5** minor | `limit: '5'` is silently ignored | **RE-RAISED as M5 (major)** | §3.3 — still ignored (`rows=3 limit=3`), now asserted by the SDS, with no test |
| **D6** minor | a raw `SQLITE_ERROR` on out-of-band column drift | **open, as disclosed** | §3.3 `a1.` — `code=SQLITE_ERROR`, `no such column: "slug"`; the errata queues it for S3 |
| **D7** minor | the reports say `scratch/s2d` / `scratch/s2e` are uncommitted and they are committed | **declined by the errata** (not a spec defect) — accepted | errata §10 |
| **D8** minor | no session sweeper | unchanged, S2b's build gap against E-18 | not re-tested; nothing in this fix touches it |
| **D9** carried | CI has never run | **still open** | `gate.yml` unchanged; no green run exists |
| **D10** minor | §17 claims S2 proof for O-17 (`site.page`), O-30 (spam), C-23 (publish refusal) | **open, as disclosed** | §7 — SDS.md:2596/2622/2635 still say `S2 (…)`; `grep -rn site.page app test` → 0 |

---

## 2. The blocker, re-attempted — seven steps, real CLI, real files

`node scratch/s2-qa2/b1-reattempt.ts` (log `scratch/s2-qa2/b1-reattempt.out`). `skwctl` is spawned as
a subprocess exactly as an operator runs it, against a real `control.db` and real
`tenants/<key>/site.db`; audit rows are written with the product's own `appendAudit`; the tamper uses
a second connection and hand SQL, which is what an attacker with the file does.

```
today=2026-10-20  sealed day D=2026-10-19  successor day=2026-10-20  earlier day=2026-10-17

1. seal 2026-10-19, then verify it
   $ skwctl audit seal --tenant acme --day 2026-10-19
     stdout: seal: tenant=acme day=2026-10-19 sealed rows_in_day=3 first_id=3 last_id=5 late=no sealed_at=2026-10-20T07:40:46.520Z   exit=0
   $ skwctl audit verify --tenant acme --day 2026-10-19
     stdout: verified: tenant=acme day=2026-10-19 rows_in_day=3 first_id=3 last_id=5 late=no sealed_at=…   exit=0
   STEP 1 RESULT: PASS (verified)

2. write one audit row dated the NEXT day (2026-10-20)
   appended id=6 with ts 2026-10-20T06:00:00Z; cms_audit rows now 6, the seal covers 3

3. verify 2026-10-19 again — THE BLOCKER
   $ skwctl audit verify --tenant acme --day 2026-10-19
     stdout: verified: tenant=acme day=2026-10-19 rows_in_day=3 first_id=3 last_id=5 late=no   exit=0
   STEP 3 RESULT: PASS — the sealed day still verifies after its successor (library status=verified)

4. tamper a row INSIDE 2026-10-19's segment and recompute every hash
   id 4 action changed to 'page.forged'; every prev_hash/hash recomputed
   $ skwctl audit verify --tenant acme --chain
     stdout: chain: tenant=acme ok rows=6 head=cbf4bbe0d78414df2c08d3e1fa66339c4f231c10bcbd8515ca1977bc6ac1613f   exit=0
   $ skwctl audit verify --tenant acme --day 2026-10-19
     stderr: REFUSAL: AUDIT_SEAL_MISMATCH: SKW_E_SEC_AUDIT_SEAL: the last hash of 2026-10-19's segment is not the seal's head   exit=1
   STEP 4 RESULT: PASS (refused) reason=SKW_E_SEC_AUDIT_SEAL/head_mismatch

5. delete the LAST row of a sealed segment (tenant del, no successor: only the seal can see it)
   $ skwctl audit seal --tenant del --day 2026-10-19  -> sealed rows_in_day=3 first_id=1 last_id=3   exit=0
   $ skwctl audit verify --tenant del --chain         -> chain: tenant=del ok rows=2   exit=0
   $ skwctl audit verify --tenant del --day 2026-10-19
     stderr: REFUSAL: AUDIT_SEAL_MISMATCH: SKW_E_SEC_AUDIT_SEAL: 2026-10-19 has 2 rows between 1 and 3; the seal records 3   exit=1
   STEP 5 RESULT: PASS (refused) reason=SKW_E_SEC_AUDIT_SEAL/count_mismatch

6. backfill beta's unsealed past day 2026-10-16 on 2026-10-20
   $ skwctl audit seal --tenant beta --day 2026-10-16
     stdout: seal: tenant=beta day=2026-10-16 sealed rows_in_day=2 first_id=1 last_id=2 late=yes sealed_at=2026-10-20T07:40:47.514Z   exit=0
   $ skwctl audit verify --tenant beta --day 2026-10-16  -> verified … late=yes   exit=0
   STEP 6 RESULT: late=1 YES; verify PASS; seal exit=0

7. seal 2026-10-19 twice for tenant dup, with a DIFFERENT head the second time
   (a row dated 2026-10-19 was appended after the seal, so a re-seal would compute rows 1..4 and a new head)
   $ skwctl audit seal --tenant dup --day 2026-10-19
     stdout: seal: tenant=dup day=2026-10-19 already_sealed (no write) rows_in_day=3 …   exit=0
   stored row before re-seal: {"first_id":1,"last_id":3,"rows_in_day":3,"head":"27d56541…424a","late":0}
   stored row after  re-seal: {"first_id":1,"last_id":3,"rows_in_day":3,"head":"27d56541…424a","late":0}
   byte-identical after the second seal: YES
   direct UPDATE audit_seal: aborted — SKW_E_SEC_AUDIT_SEAL
   7b. writeSeal with a different head: REFUSED SKW_E_SEC_AUDIT_SEAL reason=already_sealed
   7b. stored row after the direct attempt: unchanged YES
   STEP 7 RESULT: second seal exit=0; row unchanged YES
```

**The judgement the task asks for, stated plainly.** Step 3 passes **and** step 4 refuses, so the
pass in step 3 is not vacuous — the same command, on the same day, flips to exit 1 with
`head_mismatch` the moment a row inside the segment changes, and to `count_mismatch` when the tail is
truncated (step 5, where the whole-file walk is `ok` and only the seal can see it). If step 4 had
also passed, this would be a NO-GO on the grounds that the control cannot tell tamper from Tuesday.
It does.

Two details worth recording rather than smoothing over:

- **Step 7's exit code is 0 by design, not by accident.** E-20 rule (a) says a re-run reports
  `already_sealed` as a *non-failure* ("this day is anchored" is the outcome wanted), while the
  *write* is refused. I checked both halves: the CLI prints the stored row and exits 0; `writeSeal`
  called directly with a different head throws `SKW_E_SEC_AUDIT_SEAL reason=already_sealed`; and a
  raw `UPDATE audit_seal` is aborted by `trg_audit_seal_immutable`. A second head cannot land.
- **Step 8 in the log** (`audit status --days 6`) shows the operator's view: the tampered day still
  reads `sealed`, the earlier unsealed day reads `UNSEALED`, exit 1. `status` reports the *series*
  and the chain walk, not per-day verification — that is `audit verify --day`, and it is why the
  health field matters (§6, M6).

**Corroboration that `B1-1` is red on the old tree.** I did not re-check out `b1aec3e`, but the old
predicate is still in git and it decides the question:

```
$ git show b1aec3e:app/audit/chain.ts | sed -n 252,277p
  const report = verifyChain(db);            // every row in the file
  if (seal.rows !== report.rows || seal.head !== report.head)
    throw new AppError('SKW_E_SEC_AUDIT_SEAL', `the chain disagrees with the seal for ${day}`, …)
```

A day with a successor has `report.rows > seal.rows`, so `B1-1` must be red there. The Builder's
claim survives the check.

---

## 3. The majors, re-attempted

### 3.1 M1 — the `view` source is anchored (E-21)

`node scratch/s2-qa2/m1-view.ts` (log `scratch/s2-qa2/m1-view.out`). Real publish gate, real
resolver on a render-read handle, real DDL runner.

```
sqlite_master.sql at publish     "CREATE VIEW cms_v_posts_public AS SELECT title FROM u_posts WHERE status = 'published'"
registry checksum                3595aa0d25c12ea8…
publish view source              ok published_at=2026-10-20T07:41:29.350Z plan=[] cost_rows=3
resolve before the re-point      RESOLVED rows=[{"title":"Post 1"},{"title":"Post 2"},{"title":"Post 3"}]
sqlite_master.sql after re-point "CREATE VIEW cms_v_posts_public AS SELECT path AS title FROM cms_page"
registry checksum (unchanged)    3595aa0d25c12ea8…
cms_page rows that must NOT be served  [{"title":"/pricing"}]
view_checksum tenant=acme relation=cms_v_posts_public registered=3595aa0d25c12ea8 found=7f1881534cf48b0a
resolve after the re-point       REFUSED SKW_E_RT_SOURCE_UNKNOWN reason=view_checksum registered=3595aa0d… found=7f188153…
cms_datasource untouched?        {"key":"view-posts","published":1}
```

Round 1's A5 is dead: the re-pointed view keeps the same column **names** (`path AS title`), so the
allowlist cannot refuse it, and the checksum does — with zero rows served. The published row is left
alone, which is right: the source is still published, its relation is no longer the object it was
published against.

Part 2, the DDL postcondition (E-21's second half, checklist item 8):

```
publish view source over cms_v_posts_2   ok
resolve before the DDL                   RESOLVED rows=[Post 1,Post 2,Post 3]
runDdl rename_table                      ops=1 statements=1 audit=[{"from":"ddl.rename_table","to":"u_posts_2"}]
view body now names                      "CREATE VIEW cms_v_posts_2 AS SELECT title FROM \"u_posts_2\" WHERE status = 'published'"
registry checksum moved?                 YES 32b2c021fe4f… -> 70174426da73…
cms_datasource published_at              {"key":"view-ddl","published_at":null,"is_public":0}
audit rows added                         [{"action":"source.view_redefined","target_kind":"view","target_id":"cms_v_posts_2",
                                           "before_json":"{\"checksum\":\"32b2c021…\"}",
                                           "after_json":"{\"checksum\":\"70174426…\",\"unpublished\":[\"view-ddl\"]}"}, …]
resolve after the DDL                    REFUSED SKW_E_RT_SOURCE_UNKNOWN reason=not_published
republish                                ok
resolve after the republish              RESOLVED rows=[Post 1,Post 2,Post 3]
```

SQLite really did rewrite the view body on `RENAME` (measured, not assumed), the checksum moved, the
source was un-published in the same transaction, one `cms_audit` row carries both digests, and the
next resolve refuses with an existing code. **M1 closed.**

### 3.2 M3 — the plan refusal now has an exclusive witness (E-22)

Two mutations, each restored and re-hashed.

**Mutation A — the plan rule disabled at its call site** (`app/sources/publish.ts:203`,
`if (report.scan) refusePlan(...)` → `if (false) …`), sha before `3820e77c…`, mutated `f9023ebf…`:

```
ok 1 - S2E-1. a query source with SCAN in its plan is refused at publish, naming the column that caused it
not ok 2 - S2E-11. a plan-only SCAN is refused even when every column it names is indexed, and the refusal names the plan (exclusive witness for refusePlan)
  error: 'a plan-only SCAN must be refused'
ok 3 - S2E-10. a query source cannot name a `cms_*` table, and a limit above limit_max is clamped and flagged
# pass 2 # fail 1
```

**Mutation B — the index rule disabled** (`assertIndexedColumns` returns on its first line),
sha before `1562396831…`, mutated `324690a934…`:

```
not ok 1 - S2E-1. a query source with SCAN in its plan is refused at publish, naming the column that caused it
ok 2 - S2E-11. a plan-only SCAN is refused even when every column it names is indexed, and the refusal names the plan (exclusive witness for refusePlan)
ok 3 - S2E-10. …
# pass 2 # fail 1
```

Both restored (`git checkout --`, `diff -q` against a pre-mutation copy, `shasum` identical:
`3820e77ce1902342baddfa0225e2b233149da4a90332bb33dcb977f6950318e8`,
`1562396813831b4af1e08329c21cf924b38fc4c27f88c1910408321a1d85f97c`), then green again (`ok 1, ok 2,
ok 3`). The two mechanisms are now distinguishable in both directions — the round-1 finding is gone,
and it was gone for the reason the errata gives (a distinct `detail.reason='plan_scan'` /
`role='plan'` shape plus a case only the plan rule can refuse). **M3 closed.**

`test/witness.test.ts` (W1–W5) adds the bidirectional link (a renamed test, an unregistered
`Exclusive witness:` comment) and passes 5/5.

### 3.3 M2 and M4 — the register (E-23)

**M2 closed.** `docs/sds/SDS.md` §16 S2 now has **13** data rows; `make verify-frozen` prints
`§16 S2 rows: 13/13; required strings: 5/5; pointers: 23/23`; the three bootstrap rows, the seal row
and the view row are present verbatim. The E-16..E-19 pointer line exists
(`> Amended by 02-errata.md E-16, …, E-23.`).

**M4 partly closed, and the replacement contains a new contradiction.** The good half is real: the
plan, index and budget rules no longer claim to be re-checked at render, and the render-time
allowlist check genuinely fires when a table is rebuilt **in band**:

```
e0. resolve notes before the in-band drop   RESOLVED rows=1
e1. resolve notes after the in-band drop    REFUSED SKW_E_RT_SOURCE_UNKNOWN reason=column_not_allowed column=body
```

`runDdl drop_column u_notes.body` updates `cms_table_registry.columns_json` in the same transaction,
and the next resolve refuses with the taxonomy code. That is "re-checked at render" with teeth.

Two things are still wrong, and they are the reason M4 is not closed:

1. **The sentence contradicts its own table.** §6.2 says *"'Re-checked at render' in this document
   means exactly the two rows marked **both**, and no other rule may claim it."* The table beneath it
   marks **three** rows `publish **and** render` (allowlist, view checksum, `limit`), plus a fourth
   row whose cell reads `structural | both`. Counted mechanically from the file, not by eye.
2. **The third of those rows is not implemented.** §6.2 now says a non-integer `limit` is refused,
   `422 SKW_E_RT_SOURCE_UNKNOWN reason='param_invalid' detail.param='limit'`. It is not:

```
a0. resolve before any drift             RESOLVED rows=3 limit=3 truncated=false
b.  limit: "5" (string, as an attribute) RESOLVED rows=3 limit=3 truncated=false     <- silently ignored
c.  limit: 2.7                           RESOLVED rows=2 limit=2 truncated=false     <- floors, as specified
d.  limit: 1000 (limit_max 5)            RESOLVED rows=3 limit=5 truncated=true      <- clamps, as specified
```

`app/sources/compile.ts:136-143` keeps the round-1 shape: `if (typeof requested === 'number' && …)`,
so a string falls through to `spec.limitDefault`. `grep -rn "limit: '5'" test/` finds no case, so
nothing witnesses the new rule. **This is M5**, below.

The out-of-band case remains D6 and is unchanged: `a1.` above gives
`code=SQLITE_ERROR … no such column: "slug"`. The errata queues it for S3, and I accept that
disposition — but note that §6.2's parenthetical reason for the allowlist rule ("a table can be
**rebuilt** between publish and resolve") is precisely the case the record cannot see. The rule
catches a rebuild that goes through the runner; it cannot catch a rebuild that does not. That should
be said in the sentence, or D6 should be closed in S2 — not both deferred.

---

## 4. The supersessions in `check_frozen.py` — audited, not assumed

`scripts/model/check_frozen.py` carries **four** named entries: `C-21 → E-20`, `C-24 → E-19`,
`C-25 → E-2`, `proxy snippet → E-11`. Each is asserted three ways: the errata item must carry the
`SUPERSEDES` marker, the retired text must be **absent** from `SDS.md`, and the replacement must be
**present verbatim**.

I broke each leg on the real tree, ran `python3 scripts/model/check_frozen.py`, and restored with
`git checkout --`, proving the restore by hash (`SDS.md 2b21a3ebb15ba9efe0cafe51d58706cd537c1fa4af35b9179735e1b79971e6e7`,
`02-errata.md a09b6237327d1321c8dce4bb962135f7af7ef35c9beb54ee69e9a07e02607eba` before **and** after).

| Mutation | Result |
|---|---|
| **The retired C-21 sentence put back** into §9.6 (a second block quote above §9.6a) | `BAD SUPERSESSION: C-21: the retired text is STILL in SDS.md — the supersession was not applied` → **FAIL, exit 1** |
| **One line of the E-20 replacement deleted** (`> sealed stays **visibly unsealed**, … carries \`late = 1\`.`) | `BAD SUPERSESSION: C-21: the E-20 replacement is not verbatim in SDS.md` → **FAIL, exit 1** |
| **The E-11 replacement line removed** from §4's snippet (`proxy_set_header X-Forwarded-Prefix "";`) | `BAD SUPERSESSION: proxy snippet: the retired text is STILL in SDS.md` → **FAIL, exit 1** (removing the fix reconstructs the retired three-line block — a nice property of the assertion) |
| **E-2's marker renamed** (`SUPERSEDES … §2 C-25` → `… §2 C-24`) in `02-errata.md` | `BAD SUPERSESSION: C-25: E-2 does not carry the marker 'SUPERSEDES 00-adjudication.md §2 C-25'` → **FAIL, exit 1** |

**Is any assertion weaker than at `100f058`?** No. `git diff 100f058 HEAD -- scripts/model/check_frozen.py`
is **+90 / −1**: the two dict entries (`C-21`, `C-24`) are new, the completeness phase is new, and
the only changed line is the `ok = not (…)` expression, which gains three terms. The quote phase —
the `found`/`missing` loop, `norm`, the `BLOCKS` table, the step-number and env-name checks — is
byte-identical. The `C-21` entry *adds* two assertions (absence + marker) to the one that existed
(presence), and switches the object of the assertion because the spec changed the object.

Two honest qualifications:

1. **Two supersessions are older than this fix.** `C-25` and `proxy snippet` were already entries at
   `100f058`, so this pass added two, not four. The report's "four named entries" is right about the
   file and loose about the diff.
2. **The new completeness phase counts rows; it does not identify them.** Only the five
   `S2_REQUIRED` strings are matched. I swapped one of the other eight acceptance rows
   (`SKW_SCHEMA_EDIT=off` hides the builder) for a row reading `| a note that is not a criterion | nothing |`
   and the check still printed `§16 S2 rows: 13/13; required strings: 5/5; pointers: 23/23` →
   **PASS**. E-23's phase closes "8 rows instead of 13"; it does not close "a row replaced by a
   different row". This is a new-gate weakness, not a regression (`100f058` had no such phase), and
   it is the same shape E-22 exists to prevent — **minor, D11**.

---

## 5. §16 S2, all 13 rows, run myself

Commands are `node --test --test-reporter=tap --test-concurrency=1 …` on `9c6402b`; every PASS below
is a run I did in this session, not a quotation from the Builder.

| # | Criterion | What I ran | Result |
|---|---|---|---|
| 1 | every non-GET without a valid CSRF token is `403 SKW_E_SEC_CSRF` | `--test-name-pattern='^matrix' test/admin-csrf.test.ts` | **PASS** — 12/12: 11 refusals + case 12 (exact Origin + good token) as the positive control |
| 2 | `Origin` mismatch on a non-GET is `403` | same run, cases 8–11 | **PASS** — no Origin, foreign Origin, `…evil.test`, wrong scheme |
| 3 | the DDL AST refuses the two statements SQLite refuses, before any SQL | `--test-name-pattern='^O[1-4]\.' test/ddl-runner.test.ts` | **PASS** — O2 (`open` throws if called, so no SQL ran), O3 (`rebuild_required`); the corrected gate cell is now honest |
| 4 | a `u_*` table with an `asset_key` gets its guard trigger in the same transaction | O1 in the same run | **PASS** — trigger + registry + audit rows in one batch, C4 proves one transaction |
| 5 | a `query` source with a `SCAN` in its plan is refused at publish | `--test-name-pattern='^S2E-1\.'` then `'^S2E-11\.'` on `test/sources.test.ts` | **PASS** — and the exclusive witness is proved by mutation (§3.2) |
| 6 | two parameter sets inside one TTL return their own rows | `--test-name-pattern='^S2E-6\.' test/sources.test.ts` | **PASS** — both orders |
| 7 | a preview token is accepted only for `status='draft'`, 30 min, `no-store` | `test/preview.test.ts` | **PASS** — 4/4 |
| 8 | `SKW_SCHEMA_EDIT=off` hides the builder entirely | `--test-name-pattern='^BUILD-'` on `test/admin-builder.test.ts` | **PASS** — absent, not disabled |
| 9 | a fresh seeded `control.db` yields exactly one operator, and a code from the printed URI logs in | `test/cli-bootstrap.test.ts` (case 1) | **PASS** — 10/10 in the file |
| 10 | a second bootstrap writes nothing: exit 3, three columns byte-identical | same file, case 2 | **PASS** |
| 11 | no TOTP secret or password reaches stdout, `audit_log`, `BUNDLE.json`, `control.seed.json` | same file, case 9 | **PASS** |
| 12 | a day sealed on the 20th verifies after the chain grows on the 21st; tampered/deleted/truncated days refuse with their own reasons | `test/audit-seal.test.ts` (18/18), `test/seal-scheduler.test.ts` (8/8), `test/cli-audit.test.ts` (6/6) + §2 | **PASS** — and the seven-step CLI re-attempt is the independent witness |
| 13 | a `view` source is anchored, a DDL op un-publishes it, the checksum is hashed once per stamp | `--test-name-pattern='^V1-[1-4]\.' test/sources.test.ts` | **PASS** — 4/4, plus §3.1 |

**13/13 PASS, 0 FAIL, 0 NOT COVERED.** Two accuracy notes on the *cells*, neither affecting a gate:
row 12 names `test/audit-seal.test.ts ``B1-1``…``B1-11`` and `B1-8` lives in
`test/seal-scheduler.test.ts` (the range implies one file); row 5's cell is long but correct.

---

## 6. Gates, and the disclosed flake

### 6.1 Three runs, full logs

```
$ make test > scratch/s2-qa2/make-test-1.log   # EXIT=0   # tests 300  # pass 300  # fail 0  # skipped 0
$ make test > scratch/s2-qa2/make-test-2.log   # EXIT=0   # tests 300  # pass 300  # fail 0  # skipped 0
$ make test > scratch/s2-qa2/make-test-3.log   # EXIT=0   # tests 300  # pass 300  # fail 0  # skipped 0
$ grep -c '^not ok' scratch/s2-qa2/make-test-*.log   ->  0, 0, 0
$ make verify-claims-modern                     # 27/27 passed, 0 skipped, 0 failed   EXIT=0
```

`make test` pulls in `verify-gitignore`, `verify-schema`, `verify-claims`, `verify-frozen` and
`verify-s1` (which builds and typechecks), so the three green runs cover the whole gate chain. Check
25 now asserts both directions and says so:

```
PASS  25 audit chain needs a daily seal (C-21)   10000 rows chained 62.0ms, 2 segments verified, sealed 101us;
      grew by 5 rows on 2026-10-22 in 141us -> 2026-10-20 still ok (head db0d9418..); row 9990 deleted ->
      walk ok but rows=9989 of 9990 and head b83e1487.. of db0d9418.. -> SKW_E_SEC_AUDIT_SEAL,
      while 2026-10-21 stays ok
```

The positive direction is a real `assert`, not a print (`scripts/model/verify_claims.py:1215`:
`assert ok_after and head_after == hashes[SPLIT]`), and the two days are asserted independent. One
caveat: check 25 re-implements the segment walk in Python, so it measures the *model*; the *module*
is witnessed by `B1-1`/`B1-3`, and mutation row 6 (deleting the `WHERE id BETWEEN` bound turns
`B1-1` red) is what makes that link real.

### 6.2 The flake — the instance is lost, the class is real, and it is not one test

**Six clean `make test` runs are green on this tree**: three before the load experiments
(`scratch/s2-qa2/make-test-{1,2,3}.log`), one after (`-4.log`), and two more run back-to-back with
`npm run test` (`/tmp/qa2-*`) — all 300/300, `# fail 0`. A final `hermes verify --json` on the idle
box is **ok: true**, with both of its suite phases (`npm run test` 50.7 s, `make test` 67.0 s) green. The Builder's five logs
(`/tmp/skw-final.log`, `/tmp/skw-run-1..4.log`) are green too. The failing name is not in any
surviving log (I searched `/tmp/*.log` and the repo): no log with `# tests 300` and `# fail 1`
exists, so "lost to a tail-only capture" is accurate and unrecoverable.

I did not leave it at "not reproduced", because that is a weak finding. Three things came out, and
they move this from "a suspected timing assertion" to "a suite that is not load-tolerant in at least
three places".

**1. One historical failure exists in this box's logs, and it is a timing test.**
`/tmp/s2c-make-test-final.log` (16:01 today, 215 tests, the pre-fix tree) records
`not ok 16 - 4. three login failure causes are indistinguishable in status, body and time`,
`# fail 1`. The test is still in the suite (`test/admin-auth.test.ts:163`), was rewritten in S2d from
n=20 to n=60 samples, and passes **5/5 in isolation** now. A plausible candidate, not a current
failure.

**2. Moderate load kills the file-level 15 s ceiling.** With six `yes(1)` processes:

```
$ bash scratch/s2-qa2/load-run.sh 6
not ok 28 - test/sources.test.ts
  duration_ms: 15006.396625
  error: 'test timed out after 15000ms'
  code: 'ERR_TEST_FAILURE'
# tests 286  # pass 285  # fail 0        EXIT=2
```

`test/sources.test.ts` takes **10.47 s** unloaded — a **1.43× margin** to the cap, measured, and the
only file remotely near it (next: `admin-auth` 3.02 s, 15/15 green standalone). That is where the
200-run `cost_ms_max` measurements live, i.e. the perf/cost area the Builder guessed.

**3. Heavier load fails a second, unrelated test — and a full `hermes verify` run failed thirteen.**
At fourteen `yes(1)` processes:

```
$ bash scratch/s2-qa2/load-run.sh 14
not ok 185 - a 17 MiB body direct to the app is 413 SKW_E_PLT_BODY_TOO_LARGE (§4.3 E-4)
  error: 'no HTTP response to a 17825792-byte body after 3 attempts'   (test/integration/three-hosts.test.ts:93)
not ok 28 - test/sources.test.ts   (test timed out after 15000ms)
# tests 286  # pass 284  # fail 1        EXIT=2
```

and the same tree under `hermes verify --json` — whose phases are `npm install`, `npm run build`,
`npm run typecheck`, `npm run test` (300/300 green), then `make test` — recorded:

```
"command": "make test", "exitCode": 2, "ok": false
# tests 300  # pass 287  # fail 13
run-node-tests: 13 failed of 300
```

Thirteen, not one. The verify harness captured only the tail, so those thirteen names are lost the
same way the Builder's one was — I am reporting the count, not guessing the names. The mechanism is
ordinary contention: a 17 MiB upload with a three-attempt response budget, a 10.5 s file against a
15 s cap, and a suite that runs a 200-sample cost measurement inside the same 15 s window.

**Judgement.** The disclosed flake is **real as a class** and **not one test**: at least two named
tests fail under CPU contention, the count scales with load (1 → 2 → 13 as the box gets busier), and
the failures are in the *harness* (timeouts, response budgets), not in an assertion about behaviour.
I could not reproduce the Builder's single failure and will not name it. This is **D12**, and it is
the one defect in this review that is *guaranteed* to recur: CI has never run (D9), CI boxes are
slower than this laptop and run other jobs beside this one, and the first red build will be
indistinguishable from the "1 failed of 300" nobody could name. Fix it before the next slice: raise
`--test-timeout` for the suite (or set it per file), split `sources.test.ts`, and give the 17 MiB case
a response budget that is not three attempts inside a default socket timeout. No correctness change
is involved.

---

## 7. The Builder's remaining items, judged

| Item | Builder's position | My judgement |
|---|---|---|
| **The unreproduced flake** | "1 failed of 300", name lost, "not calling it fixed" | **Correctly disclosed, and now explained as a class rather than an instance.** 11 green idle runs exist plus a green `hermes verify` (which runs the suite twice); under CPU load I can produce 2 named failures, and a loaded `hermes verify` produced 13 of 300. Not a correctness gate, but it will make CI red for reasons unrelated to the code. Keep it open as D12 and fix it before the next slice. |
| **D6** — raw `SQLITE_ERROR` on out-of-band column drift | queued for S3's error surface | **Accept the deferral, with one condition.** Confirmed live (§3.3 `a1.`). The condition: §6.2's parenthetical gives "a table can be **rebuilt** between publish and resolve" as the *reason* the allowlist is re-checked, and an out-of-band rebuild is the case the record cannot see. Either narrow that sentence or fix D6 in S2; leaving both is the M4 shape again. |
| **D10** — §17 attributes S2 proof to O-17, O-30, C-23 | belongs to the §17 register pass | **Accept the deferral.** Still exactly as round 1 found it (§17 rows at `SDS.md:2596`, `:2622`, `:2635`; `grep -rn site.page app test` → 0). It is a register lie with no code behind it, and it should not survive S3. |
| **Item-12 artifact naming** (`S2-fix-mutations.md` + `S2-fix-report.md` instead of `S2-fix.md`) | flagged rather than silently renamed | **Acceptable, and the right call to flag it.** The checklist names one file; two exist and together are a superset. The cost is traceability: a reader following §9 item 12 finds no `S2-fix.md`. Either rename or have the errata record the two-file shape — but this does not block. |
| **"Nothing committed"** (§4.4 of the fix report) | tree carries the fix as working-tree changes | **Stale.** The tree is clean at `9c6402b`, and `git log` shows the fix commit. The statement was true when written; it is not true of the artifact I reviewed. Harmless, but the report should not be read as describing an uncommitted tree. |

---

## 8. Defects, round 2

| # | Severity | Defect | Evidence |
|---|---|---|---|
| **M5** | major | **§6.2 asserts a `limit` refusal that does not exist, and its sentence contradicts its own table.** `limit:'5'` resolves with `limit_default`; no test covers it; the sentence says "exactly the two rows marked **both**" while three rows are marked both. E-23's body requires the code change and a test; the §9 checklist item 11 omits both, so the Builder's "12/12" is right against the checklist and wrong against the item | §3.3 `b.`; `app/sources/compile.ts:136-143`; table counted mechanically |
| **M6** | major | **The seal-health field cannot report a gap older than one day.** `sealSummary` calls `sealStatus({days: 1})`, so `"unsealed"` is structurally at most yesterday. E-20(d)'s own example (`unsealed: ["2026-10-18"]` under `last_sealed_day: 2026-10-20`) is unreachable | `node scratch/s2-qa2/seal-health.ts` → `{"last_sealed_day":"2026-10-19","unsealed":[],"late_days":0}` while `sealStatus days=5` → `unsealed=["2026-10-16"]`; `app/audit/scheduler.ts:313` |
| **D11** | minor (gate) | `check_frozen.py`'s completeness phase counts §16 S2 rows and identity-checks only five of them: swapping another acceptance row for a non-criterion row still prints `13/13` and PASSes | §4 |
| **D12** | minor (gate) | **The suite fails under CPU contention, in more than one place, and the count scales with load.** `test/sources.test.ts` hits the 15 s per-file cap (10.47 s idle, a 1.43× margin) at 6× load; `a 17 MiB body … 413` (`test/integration/three-hosts.test.ts:93`) gets no response at 14× load; a `hermes verify` run recorded `13 failed of 300`. Six idle runs are green, so this is the harness, not the code — and CI has never run | §6.2 |
| **D6** | minor | raw `SQLITE_ERROR` on out-of-band column drift — open by decision, queued S3 | §3.3 `a1.` |
| **D10** | minor (traceability) | §17 claims S2 proof for O-17, O-30, C-23 — open by decision | §7 |
| **D13** | minor (accuracy) | §16 row 12's gate cell names `test/audit-seal.test.ts` `B1-1`…`B1-11`; `B1-8` is in `test/seal-scheduler.test.ts` | §5 |
| **D9** | carried | CI has never run | unchanged |

Nothing here is a blocker. **M5 and M6 are the two decisions the CEO owes this slice.**

---

## 9. What I did not prove

- **CI.** `gate.yml` still has no green run (D9). Everything above is this laptop.
- **A real nginx** for the S2 paths — unchanged from round 1.
- **`B1-1` red on a checked-out `b1aec3e`.** I corroborated it from the old source in git, not by
  running the new test against the old tree.
- **The flake's identity.** I can make failures happen (two named tests; thirteen unnamed in the
  verify harness) but I cannot prove which one the Builder saw, and the thirteen names are gone.
- **Argon2 timing stability over many runs** — I ran case 4 five times green, not ten.
- **The `limit` fix is S4's problem only if someone remembers.** Nothing in this tree will notice if
  it is forgotten; that is M5.

---

## 10. The one thing most likely to break in week one

**A missed seal day, and the operator surface that says everything is fine.**

The seal itself is now correct — that is what this round establishes. What is not correct is its
*visibility*. The tick only fires in a live process, at 00:00 UTC, with no startup catch-up; a
deploy, a restart or a paused VM that straddles midnight simply loses that day. The durable record is
there (the next tick writes one `audit_log` row, `action='audit.seal_gap'`, and does **not** heal it —
rule (c), correctly), and `skwctl audit status` shows it.

But the field the errata designates as the operator's surface,
`/admin/api/tenants/<key>/health → "seal": {"unsealed": [...], "late_days": n}`, is computed with a
**one-day window**. On the exact scenario that matters — a gap three days back, yesterday sealed —
it answers:

```
{"last_sealed_day":"2026-10-19","unsealed":[],"late_days":0}
```

An operator watching health sees a green series over a day that was never anchored, which is the same
disease as the round-1 blocker in a smaller place: the control's *report* is not the control's
*verdict*. Week one is when deployments are frequent, midnight UTC is when they are most likely to be
running, and nobody reads `audit_log` for a row they were never told about.

---

## 11. Reproduction

```
git log --oneline -1                     # 9c6402b
make test                                # exit 0, 300/300 (run it three times; logs in scratch/s2-qa2/)
make verify-claims-modern                # exit 0, 27/27; check 25 asserts both directions
node scratch/s2-qa2/b1-reattempt.ts      # the seven steps, real skwctl; log b1-reattempt.out
node scratch/s2-qa2/m1-view.ts           # M1: re-point, DDL postcondition; log m1-view.out
node scratch/s2-qa2/m2m4-render.ts       # M4/D5/D6: allowlist in and out of band, limit vectors
node scratch/s2-qa2/seal-health.ts       # M6: the health window vs the specified example
bash scratch/s2-qa2/load-run.sh 6        # D12: make test under 6x CPU load  -> sources.test.ts times out
bash scratch/s2-qa2/load-run.sh 14       # D12: 14x load -> also the 17 MiB body case gets no response
```

Mutations (all restored, `git checkout --` + `shasum`, before == after):

```
app/sources/publish.ts  3820e77ce1902342baddfa0225e2b233149da4a90332bb33dcb977f6950318e8   (M3, plan rule)
app/sources/plan.ts     1562396813831b4af1e08329c21cf924b38fc4c27f88c1910408321a1d85f97c   (M3, index rule)
docs/sds/SDS.md         2b21a3ebb15ba9efe0cafe51d58706cd537c1fa4af35b9179735e1b79971e6e7   (4 supersession tests)
docs/sds/02-errata.md   a09b6237327d1321c8dce4bb962135f7af7ef35c9beb54ee69e9a07e02607eba   (marker test)
```

`git status --short` at the end of this review: `?? scratch/s2-qa2/` only. Nothing was fixed, nothing
was committed, and every mutation was restored and re-hashed.
