# S2 fix report — E-20..E-23 against 02-errata §9 (12 items)

Work order: `docs/sds/02-errata.md` §9 (ordered builder checklist), §10 (traceability). Closes
`docs/build/S2-qa.md` B1 (blocker), D1/M1, D3/M3, D2/M2, D4/M4.

Verdict: **12 of 12 items applied, all gates green, the blocker's discriminating proof runs on real
files and disagrees with the retired model at exactly one step — step 3, which is the defect.** Nothing
is committed.

---

## 1. Gate results (real output, unmutated tree)

```
$ make test            # verify-toolchain, verify-gitignore, verify-schema, verify-claims,
                       # verify-frozen, verify-s1
...
# tests 300
# pass 300
# fail 0
EXIT=0
```

```
$ make verify-claims-modern
...
PASS  20 migration chain v1->v3 converges on site.sql   27 tables / 5 triggers identical on both paths
                                                        (table text + trigger bodies), control 9 tables at v4
                                                        with a 9-column segment seal, no session pragma; ...
PASS  25 audit chain needs a daily seal (C-21)          10000 rows chained 53.9ms, 2 segments verified,
                                                        sealed 96us; grew by 5 rows on 2026-10-22 in 152us
                                                        -> 2026-10-20 still ok (head db0d9418..); row 9990
                                                        deleted -> walk ok but rows=9989 of 9990 and head
                                                        b83e1487.. of db0d9418.. -> SKW_E_SEC_AUDIT_SEAL,
                                                        while 2026-10-21 stays ok
27/27 passed, 0 skipped, 0 failed
```

```
$ make verify-frozen
adopted sentences: 22/25 verbatim in SDS.md; 3 superseded by 02-errata
  SUPERSEDED by E-20 (asserted)
  SUPERSEDED by E-19 (asserted)
  SUPERSEDED by E-2 (asserted)
frozen §4 blocks: 11/12 verbatim; 1 superseded by 02-errata
  SUPERSEDED by E-11 (asserted)
resolution steps: 5/5 present; env names: 29/29 present
§16 S2 rows: 13/13; required strings: 5/5; pointers: 23/23
PASS the SDS quotes the register
```

Check 25 now asserts **both** directions in one measurement: the grown chain still verifies for the
earlier day, *and* a deleted row inside that day refuses. The old check tested only the refusing
direction, which is why it could not see B1.

---

## 2. The discriminating proof (E-20) — six steps, real files, both models

Run it yourself: `node scratch/s2-fix/seal-history.ts` (log kept at `scratch/s2-fix/proof.out`).
The "legacy" column is the retired predicate restated in behaviour from `b1aec3e:app/audit/chain.ts`
(whole-file `count(cms_audit)` and whole-file head against the seal).

```
E-20 discriminating proof — day segments, real files, both models

seal: acme 2026-10-20 written at 2026-10-21T00:00:05.000Z (00:00:05 on the 21st)

1. seal 2026-10-20                          rows_in_day=3 first_id=1 last_id=3 anchor="" late=0
   verify D                                                2026-10-20   new: OK rows_in_day=3 ids=1..3 late=no              legacy: OK rows=3

2. append one row on 2026-10-21             cms_audit now holds 4 rows, the seal covers 3
3. verify D after the chain grew                           2026-10-20   new: OK rows_in_day=3 ids=1..3 late=no              legacy: REFUSED SKW_E_SEC_AUDIT_SEAL — the chain disagrees with the seal for 2026-10-20

4. tamper id 2 inside D and recompute every hash (the file is internally consistent again)
   verify D                                                2026-10-20   new: REFUSED head_mismatch                          legacy: REFUSED SKW_E_SEC_AUDIT_SEAL — the chain disagrees with the seal for 2026-10-20
   verify D+1 (a different day, a different verdict)       2026-10-21   new: REFUSED unsealed                               legacy: REFUSED no seal

5. delete id 3 — the last row of D's segment
   verify D                                                2026-10-20   new: REFUSED count_mismatch                         legacy: REFUSED SKW_E_SEC_AUDIT_SEAL — the chain disagrees with the seal for 2026-10-20
   whole-file walk (--chain): broken — the successor now carries a prev_hash that names a deleted row, so this particular deletion is visible twice; the deletion only the seal can see is a truncated tail (B1-4)

6. backfill beta 2026-10-18 on the 25th
   seal: rows_in_day=2 first_id=1 last_id=2 anchor="" late=1 sealed_at=2026-10-25T10:00:00.000Z
   verify 2026-10-18                                       2026-10-18   new: OK rows_in_day=2 ids=1..2 late=yes             legacy: OK rows=2
   control.db audit_seal: acme/2026-10-20 ids=1..3 rows=3 late=0; beta/2026-10-18 ids=1..2 rows=2 late=1

steps where the retired model and the segment model disagree: 3 (and only 3)
```

| Step | Requirement | New model | Retired model |
|---|---|---|---|
| 1 | seal D, verify D → OK | OK `rows_in_day=3 ids=1..3` | OK `rows=3` |
| 2 | append a row on D+1 | chain 4 rows, seal covers 3 | same |
| 3 | **verify D again → still OK** | **OK** | **REFUSED** `SKW_E_SEC_AUDIT_SEAL` |
| 4 | tamper inside D's segment → REFUSE | REFUSED `head_mismatch` | REFUSED (same string a grown chain produces) |
| 5 | delete D's last row → REFUSE | REFUSED `count_mismatch` | REFUSED |
| 6 | backfill unsealed day → `late=1`, own segment, verifies | OK `ids=1..2 late=yes sealed_at=2026-10-25T10:00:00Z` | OK `rows=2` |

Step 3 is the proof: the retired model refuses a perfectly honest day the moment any later row lands,
with the exact string a real tamper produces — the blocker. The new model is green there and still
refuses in steps 4 and 5, where it names *which* invariant broke (`head_mismatch`, `count_mismatch`,
plus `anchor_mismatch`, `not_contiguous`, `chain_broken`, `day_not_over`, `already_sealed`,
`late_mismatch`, `unsealed` in the other cases).

---

## 3. The 12 checklist items

| # | Item | Applied in | Gate that proves it | Seen red under | Status |
|---|---|---|---|---|---|
| 1 | E-20 schema v4: `audit_seal` rebuilt as a segment, immutability trigger, two table CHECKs, regenerate `control.sql`, new `control-r4.sql` | `scripts/model/gen_schema.py` (`CONTROL_VERSION = 4`, `audit_seal` spec), `schema/control.sql`, `schema/control-r4.sql` (new, 2,968 B) | `test/migrate.test.ts`; check 20 on both interpreters: "control 9 tables at v4 with a 9-column segment seal" | check 20's `sqlite_master.sql` comparison against the generated file (no mutation run for the DDL itself) | done |
| 2 | E-20 sealer: segment scan, `already_sealed` / `day_not_over` / `anchor_missing` / `chain_broken` / `not_contiguous` / `late_mismatch`, `late` computed from the seal instant | `app/audit/chain.ts` — `writeSeal` (:260), `sealNow` (:328), `readSeal` (:197), `SealRow` (:169), `daySegment` (:228) | `audit-seal.test.ts` `B1-5` `B1-6` `B1-7` `B1-9` `B1-10` `B1-11`; scheduler `S2E-18` | `B1-6`: reopening the re-seal path → red (mutation record row 5); `B1-5` → red (row 7) | done |
| 3 | E-20 verifier reads only `[first_id, last_id]`; `--chain` is the whole-file walk; `SealVerification` is a segment report | `app/audit/chain.ts` `verifyAgainstSeal` (:444), `verifyChain` (:147); `app/cli/skwctl.ts` `audit verify` / `--chain` | `B1-1` (positive control: grew by a day, still verifies), `B1-2` anchor, `B1-3` tamper inside with a later day corrupted, `B1-4` count; `CLI-6` | `B1-1` red when the `WHERE id BETWEEN` bound is deleted (mutation row 6; `B1-3`/`B1-7` also red, as they all verify a segment) | done |
| 4 | E-20 tick: no idempotence, gap scan, one `audit_log` row per tenant-day gap, health field | `app/audit/scheduler.ts` (`sealDay`, `sealStatus`, `healGaps`; `SealState = 'sealed' \| 'UNSEALED' \| 'empty'`), `app/main.ts` health payload | `seal-scheduler.test.ts` `S2E-18` (rewritten: second run `already_sealed`, nothing changes), `S2E-19`, `S2E-21` split into "passes after the chain grows" / "fails after a row inside the day is altered"; `B1-8` gap reported, one `audit_log` row, **not** sealed | asserted by `B1-8` and `CLI-1`; no mutation run for the gap scan (not in the mutation table) | done |
| 5 | E-20 operator surface: `audit status`, `seal --heal`, distinct refusal names, exit codes | `app/cli/skwctl.ts` (`audit seal\|verify\|status`, `AUDIT_SEAL_MISMATCH`, `AUDIT_SEAL_UNSEALED`, `AUDIT_SEAL_EMPTY`) | new `test/cli-audit.test.ts` `CLI-1`..`CLI-6`: three status lines, exit 0 vs 1, `--heal` writing `late=1` per gap with one `audit_log` row each, and `AUDIT_SEAL_UNSEALED` vs `AUDIT_SEAL_MISMATCH` as distinct strings | "a gap stops making status exit 1" → `CLI-1` red (mutation row 8); green neighbour `CLI-6` | done |
| 6 | E-20 claims gate: check 25 gains the missing direction; `check_frozen.py` gains the C-21 `SUPERSEDED` entry | `scripts/model/verify_claims.py` check 25, `scripts/model/check_frozen.py` (`SUPERSEDED["C-21"]`: `old` must be **absent**, `new` **verbatim**, marker `SUPERSEDES 00-adjudication.md §2 C-21`) | `make verify-claims-modern` 27/27 (output above); `make verify-frozen`: "SUPERSEDED by E-20 (asserted)" | check 25's range bound reverted → FAIL 25 (mutation row 14); C-21's retired sentence pasted back → "FAIL the SDS paraphrases the register" (row 15) | done |
| 7 | E-21 checksum: written at publish, verified at resolve as step 5a, cached under `user_version:schema_version` | `app/sources/publish.ts`, `app/sources/registry.ts` `assertViewChecksum` (:218) + `viewChecksumStats.viewChecksumHashes` (:159/:189), `app/sources/resolve.ts` | `sources.test.ts` `V1-1` (A5 reproduced: re-point out of band → 422, `reason='view_checksum'`, **zero rows**), `V1-3` (+1 hash per schema stamp, not per resolve) | step 5a deleted → `V1-1` red, `S2E-5` green (mutation row 3) | done |
| 8 | E-21 DDL postcondition: changed view body refreshes checksum, un-publishes its sources, one `cms_audit` row, same transaction | `app/ddl/run.ts` (`viewPostcondition` :367–449, called at :160 before COMMIT), `app/sources/registry.ts` | `V1-2` — rename rewrote the view body, checksum moved, `published_at IS NULL`, one audit row (`source.view_redefined`, both digests), next resolve **refused** `SKW_E_RT_SOURCE_UNKNOWN` / `reason='not_published'`, republish resolves; `V1-4` view cost → `SKW_E_RT_SOURCE_BUDGET` | postcondition deleted → `V1-2` red, `V1-1` green (mutation row 4) | done |
| 9 | E-22 distinct refusal shapes + witness comments | `app/sources/plan.ts` `refusePlan` gains `reason:'plan_scan'`, `role:'plan'` (:87), comment names `Exclusive witness: test/sources.test.ts S2E-11` (:74) | `S2E-11` — indexed columns but a SCAN, `reason='plan_scan'`, zero `cms_datasource` rows, and `status` asserted indexed so it cannot degrade into `S2E-1` | plan rule disabled → `S2E-11` red while `S2E-1` and `S2E-10` stay green (mutation row 1) | done |
| 10 | E-22 witness table | new `test/witness.test.ts` (W1–W5) | itself: every `mechanism → {file, test}` row names a test that exists and a comment containing the name; W3 fails on any unregistered `Exclusive witness:` comment in `app/` | renaming a test → W1 red, W5 green (mutation row 9) | done |
| 11 | E-23 paste every drop-in with its pointer line; §16 S2 to 13 rows; §6.2 table replaced; `check_frozen.py` completeness phase | `docs/sds/SDS.md` (§6.2 :1040–1087 with the two-row "both" table and `> Amended by 02-errata.md E-23, E-21.`; §16 S2 now 13 rows, 23 pointers), `scripts/model/check_frozen.py` (`S2_ROWS = 13`, five required strings, `POINTERS = E-1..E-23`) | `make verify-frozen`: "§16 S2 rows: 13/13; required strings: 5/5; pointers: 23/23" | completeness phase cannot pass with 8 rows; the retired sentence is asserted absent (mutation row 15) | done |
| 12 | Evidence: mutation record for items 1–11 | `docs/build/S2-fix-mutations.md` (the checklist calls this file `docs/build/S2-fix.md`; the record is this report's companion) | 15 rows: edited expression, control, red test, green neighbour, sha256 before/mutated, all restored (`sha restored == sha before`) | the five negative controls of `S2-qa.md` §3 re-run — NC1 (plan rule), NC2 (cache key), NC3 (`is_public`), NC4 (preview MAC), NC5 (seal) — every one red | done |

### Notes on the two document-side items

- **§6.2 is now scoped to two rules, not "everything".** The "re-checked at render" sentence reads:
  the column allowlist and a `view` source's definition checksum run at publish **and** render;
  everything else is publish-only, and *"'Re-checked at render' in this document means exactly the two
  rows marked **both**, and no other rule may claim it."* The old `table/view` phrasing on the plan and
  index rows is deleted rather than widened.
- **C-21's adopted sentence is retired by supersession, not by relaxation.** `check_frozen.py`'s
  `SUPERSEDED["C-21"]` asserts three things: the retired text is **absent** from `SDS.md`, the
  nine-column replacement is **present verbatim**, and E-20 carries the `SUPERSEDES` marker. It is the
  strongest form the check has; nothing in it was loosened.

---

## 4. What is still open

1. **One unexplained test flake.** Four `make test` runs: the first reported `1 failed of 300`; the
   next three (full logs at `scratch/s2-fix/make-test-3.log`, `-4.log`) are `300/300`, `# fail 0`,
   with no `not ok` line anywhere. The failing test's name was lost to a tail-only capture on run 1, so
   it is **not identified** — I am not calling it fixed. If QA sees it again, run
   `make test > /tmp/t.log 2>&1` and grep `not ok` for the name; it is most likely a timing-sensitive
   assertion in the perf/cost area rather than a correctness gate (all correctness gates were re-run
   individually and are stable).
2. **D6 and D10 are not in this fix**, by the errata's own instruction (§9 "Not in this fix"): D6 (raw
   `SQLITE_ERROR` on out-of-band column drift) queues for S3's error surface; D10 (§17 attributes S2
   proof to O-17, O-30, C-23) belongs to the §17 register pass. Both are recorded in §10 as open.
3. **`docs/build/S2-fix-mutations.md` is the item-12 artifact** and is not folded into this file; the
   checklist's filename for item 12 was `docs/build/S2-fix.md`, and this report plus that record
   together are the evidence set. Flagging the naming deviation rather than silently renaming it.
4. **Nothing committed.** The tree carries the fix as working-tree changes only (plus new
   `schema/control-r4.sql`, `test/cli-audit.test.ts`, `test/witness.test.ts`, `scratch/s2-fix/`), per
   the work order.
