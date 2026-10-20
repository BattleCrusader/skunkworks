# S2d — the transactional DDL runner, the six remaining ops, the audit seal, and the E-16 flake

**Builder:** Backend Engineer. **Date:** 2026-10-20. **Base:** `cf50147` (S2c).
**Not committed.** `git status --porcelain`: 7 modified, 7 new paths (§1).

All five items are in. The order was the work order's: **E-16 first (0)**, then the runner
(1), the six ops (2), the three context-dependent refusals (3), the audit chain verifier and
seal (4). Every acceptance criterion has a command and its real output (§3), every new gate
has a mutation that makes it go red (§6), and the rollback is proved by hashing the schema
before and after a batch whose third statement fails (§4).

**Two defects were found by executing SQL that had only ever been previewed, and they are
the argument for this slice.** (1) S2c's `emitCreateTable` declared `PRIMARY KEY ("id")` and
never declared `id`: the preview was SQL SQLite refuses — `no such column: "id"` — invisible
because nothing ran it. (2) A 12-step rebuild replayed an `asset` guard trigger verbatim
after dropping the column it named; SQLite accepts that and the failure surfaces later, on an
unrelated `DELETE FROM cms_asset`. Both are fixed, and both now have a gate: C5 (preview ==
execution) and O7 (the guard is regenerated). §7 items 1 and 10.

---

## 1. What shipped

| Path | Status | What it is |
|---|---|---|
| `app/ddl/run.ts` | **new**, 422 | §9.4's runner: `BEGIN IMMEDIATE` (retried and counted) → per-op plan → statements → `cms_table_registry` → `cms_audit` → postcondition → `COMMIT`; `ROLLBACK` and a discarded connection on any failure |
| `app/ddl/ops.ts` | **new**, 644 | the seven-op `DdlOp` union, the five refusals (three pure, two needing the schema), and `emit(op, ctx)` returning the exact statement list plus the registry effect and the audit images |
| `app/ddl/refuse.ts` | **new**, 16 | §4.4's five reasons and the one 422 constructor, shared by the emitter and the AST |
| `app/audit/chain.ts` | **new**, 277 | the canonical row, `auditHash`, `appendAudit`, `verifyChain`, `writeSeal`/`sealNow`, and `verifyAgainstSeal` — the verifier that compares count **and** head to the seal |
| `app/ddl/emit.ts` | modified | exports `emitColumn` (one column builder for create and add) and declares the `id` column (the S2c defect above) |
| `app/admin/crud.ts` | modified | imports the audit writer from `app/audit/chain.ts` instead of keeping its own copy, and accepts `u_*` tables (a table the builder creates has no other editing surface) |
| `app/admin/routes.ts` | modified, +95 | `builder/apply`: the form's POST runs the runner; the preview page grows an Apply button and its "not executed" text now says what applying does |
| `app/errors.ts` | modified | `SKW_E_DM_DDL_POSTCONDITION` (422) and `SKW_E_SEC_AUDIT_SEAL` (500) join the compile-time map, so both are raisable by the app and stay in step with `schema/error-codes.json` |
| `test/ddl-runner.test.ts` | **new**, 780 | 18 tests: the seven criteria, the six ops, the guard regeneration, the three refusals, the postcondition |
| `test/audit-seal.test.ts` | **new**, 234 | 8 tests: chain, seal, tamper-and-recompute, deleted tail, re-seal refusal |
| `test/helpers/ddl-child.ts` | **new**, 126 | the second **process** the serialisation, kill-mid-op and concurrent-write gates need |
| `test/admin-auth.test.ts` | modified | E-16's timing case: 20 samples → 60, interleaved rounds, band untouched |
| `test/admin-builder.test.ts` | modified | BUILD-8..10: apply creates, a refused apply changes nothing, apply is absent when `SKW_SCHEMA_EDIT=off` |
| `test/helpers/admin.ts` | modified | `percentile()`, so a failing timing gate reports the shape of the distribution |

`schema/*` is untouched: every table the runner writes (`cms_table_registry`,
`cms_trigger_registry`, `cms_audit`, `audit_seal`) already exists in the frozen DDL, so there
is no migration, no `gen_schema.py` bump and no re-baselined check 20.

---

## 2. The gates, run

```
$ make test
verify-toolchain: /usr/bin/python3 -> python 3.9.6, sqlite 3.43.2, argon2 ok
PASS  the SDS quotes the register
PASS  1 schema/ER parity + negative tests     v3: 36 entities == 36 CREATE TABLE
...
PASS  27 connection classes: query_only is not tenancy (C-15)   query_only: VACUUM INTO -> attempt to write a readonly database; ...
27/27 passed, 0 skipped, 0 failed
# tests 244
# pass 244
# fail 0
# cancelled 0
# skipped 0
```

244 = 215 (S2c) + 29 new: 18 runner, 8 audit/seal, 3 builder-apply.
`# skipped 0` — and since G3 a skip cannot exit 0 anyway.

Checks 18, 25 and 27 are untouched and still pass; nothing in this slice changed the
schema, the connection classes or the audit measurement those checks stand behind. Check 25
(10,000 rows chained, seal written, deleted tail caught) is the *measurement*; §9.6's
verifier is the code, and it is `verifyAgainstSeal` now rather than a promise.

---

## 3. The acceptance criteria, one by one

### 3.1 An op that names a table outside the four prefixes is refused by the AST, and no SQL reaches the engine

The criterion's own witness is the connection: the test passes an `open` factory that counts
calls, so "no SQL" is a fact about the handle, not a claim about the code path.

```
$ node --test --test-reporter=tap --test-concurrency=1 --test-name-pattern='^C1\.' test/ddl-runner.test.ts
ok 1 - C1. a table named outside u_ is refused by the AST, and the connection is never opened
# tests 1
# pass 1
# fail 0
```

Refused, each `422 SKW_E_DM_DDL_REJECTED` with `detail.reason='reserved_prefix'`:
`cms_evil`, `p_plugin_thing`, `sqlite_shadow`, `people`, `u_Bad`, `u_` — and the assertions
after the loop are the interesting ones:

```ts
assert.equal(opened, 0, 'the runner opened a connection for a request the AST refuses');
assert.equal(schemaDigest(path), before, 'a refused request changed the schema');
```

The pure half of §4.4 (`reserved_prefix`, `limit`, `default_required`,
`too_many_statements`) runs in `assertBatch` **before** the handle exists; the context half
(`rebuild_required`, the index-count `limit`) runs after the handle is open but before
`BEGIN IMMEDIATE`, and only reads `sqlite_master`.

### 3.2 A batch that fails on its third statement leaves the schema byte-identical

```
$ node --test --test-reporter=tap --test-concurrency=1 --test-name-pattern='^C2\.' test/ddl-runner.test.ts
ok 1 - C2. a batch failing on its third statement leaves the schema byte-identical
```

The batch: `create_table u_alpha` → `create_index ix_alpha_title` → `create_table u_alpha`
(again). The third statement is a duplicate and the batch is one transaction, so the first
two unwind. The proof is §4.

### 3.3 Two DDL ops racing on one tenant do not interleave

The criterion says "prove with two connections". Two connections in **one process cannot
race here**: `better-sqlite3` is synchronous, so a second handle cannot run while the first
is inside a transaction — the test would prove nothing about SQLite's locking. The gate uses
two **processes**, each with its own connection, which is the stronger arrangement: they
contend through the same file lock the production box contends through. A holds its
transaction open 400 ms after writing its statement; B starts 120 ms later.

```
$ node --test --test-reporter=tap --test-concurrency=1 --test-name-pattern='^C3\.' test/ddl-runner.test.ts
ok 1 - C3. two processes: BEGIN IMMEDIATE serialises the second behind the first
```

Asserted on the children's own reports: `A.lockAttempts >= 1`, `B.lockAttempts >= 2`
(B re-attempted the lock — it could not get in), `B.endedAt >= A.endedAt` (B did not finish
inside A's transaction), and afterwards both tables, both registry rows and both audit rows
exist **and the chain verifies**: the serialisation corrupted neither transaction's
bookkeeping.

### 3.4 The registry row and the audit row are in the DDL's transaction — proved by killing the process

The child runs a one-op batch and `SIGKILL`s itself in the `beforeCommit` hook: every
statement, the registry row and the audit row are written, and `COMMIT` has not run.

```
$ node --test --test-reporter=tap --test-concurrency=1 --test-name-pattern='^C4\.' test/ddl-runner.test.ts
ok 1 - C4. SIGKILL between the last statement and COMMIT leaves no table, no registry row, no audit row
```

```
assert.equal(child.signal, 'SIGKILL', ...);
// after reopening the file:
table u_murdered:       0 rows in sqlite_master
cms_table_registry:     0 rows
cms_audit:              0 rows
PRAGMA integrity_check: ok
schemaDigest before == after
```

`SIGKILL` is not catchable and no `finally` runs, so what unwound the transaction is SQLite's
WAL recovery on the next open — which is the only version of this claim worth making.

### 3.5 The runner executes exactly what `emit()` previews, for all six ops

For each op the test calls `emit(op, context(db))` **before** running, then runs the op
through an instrumented handle that records every `exec`, and compares arrays.

```
$ node --test --test-reporter=tap --test-concurrency=1 --test-name-pattern='^C5\.' test/ddl-runner.test.ts
ok 1 - C5. the executed SQL text equals the preview text for all six ops
```

Seven cases, because `create_table` is the seventh op and S2c already had it: `create_table`,
`add_column`, `create_index`, `drop_index`, `rename_table`, `drop_column` (the 12-step
rebuild), `drop_table`. The assertion is `assert.deepEqual(ddl, preview)` — byte equality of
each statement, in order. The only entries filtered out are the runner's own
`BEGIN IMMEDIATE` / `COMMIT`, which §9.4 wraps the op in and the op does not contain.

This gate is what caught the S2c defect: the preview and the execution are the same array,
so a preview of SQL SQLite rejects cannot survive one run.

### 3.6 Tamper one audit row and recompute the chain: the verifier must fail against the seal

Round 2's finding, reproduced as a gate. The attacker model is write access to `site.db`:
drop `trg_cms_audit_append_only`, rewrite what row 2 says, then recompute every `hash` and
`prev_hash` with the writer's own `auditHash`.

```
$ node --test --test-reporter=tap --test-concurrency=1 --test-name-pattern='^A4\.' test/audit-seal.test.ts
ok 1 - A4. THE CRITERION — tamper one row and recompute the chain: the walk passes, the seal refuses
```

The test asserts **both halves separately**, which is the whole point:

```ts
const walk = verifyChain(site);
assert.equal(walk.ok, true, 'the recomputed chain must pass the link walk — this is the premise of the seal');
assert.notEqual(walk.head, readSeal(control, 'acme', DAY)?.head, ...);
assert.throws(() => verifyAgainstSeal(site, control, 'acme', DAY),
  (err) => err instanceof AppError && err.code === 'SKW_E_SEC_AUDIT_SEAL',
  'an unanchored verifier would have passed this');
```

M7 (§6) removes the seal comparison and this test goes red, so the anchor is load-bearing
rather than decorative. The same test exists against the **DDL** runner's audit rows in
`ddl-runner.test.ts` C6.

Also gated: a deleted tail still walks and the seal catches the count (`A5`); a day with no
seal is a refusal, not a pass — "a missing digest is itself the evidence" (`A6`); and
re-sealing a day with a *different* head is refused, because accepting it would let an
attacker launder a tampered chain by re-sealing (`A7`).

### 3.7 Concurrent CRUD writes during a rebuild: no lost update, and the rebuild reports its waits

Two writer processes, one row per transaction through the production `createRow`, each
transaction held open 12 ms so it owns the write lock a third of the time. Five rebuilds
(`drop_column` / `add_column` on the table both writers are inserting into) run while they
are going.

```
$ node --test --test-reporter=tap --test-concurrency=1 --test-name-pattern='^C7\.' test/ddl-runner.test.ts
ok 1 - C7. concurrent CRUD writes during a rebuild lose nothing, and the rebuild reports its lock waits
```

- 80 of 80 rows survive, 80 distinct slugs: no lost update, none written twice.
- the rebuilt table's `sqlite_master.sql` is **byte-identical to `emitCreateTable`'s output**
  for the reduced column list — a rebuild cannot drift from a create.
- the chain still verifies after five rebuilds and 80 audited writes.
- the busiest report has `waitedFor >= 1`.

**What `waitedFor` can and cannot mean.** SQLite exposes no lock-holder identity, so the
number cannot be "the connections I waited behind" in the literal sense. It is the count of
**re-attempts of `BEGIN IMMEDIATE`**: each failed attempt was some other connection holding
the write lock, so it is a true lower bound and nothing more. `report.lockAttempts` and
`report.lockWaitMs` are exact. The field is documented as what it measures, in
`app/ddl/run.ts`'s `DdlReport`, rather than named for what one would like it to measure.

---

## 4. The rollback hash proof

The schema's identity is `sha256` over every object's `(type, name, tbl_name, sql)` in
`schemaDigest()`, the registry's own rows, and every table's row count — not a hash of the
file, which would be a witness to WAL bookkeeping as much as to the schema.

```
$ node --test --test-reporter=spec --test-concurrency=1 --test-name-pattern='^C2\.' test/ddl-runner.test.ts
✔ C2. a batch failing on its third statement leaves the schema byte-identical (22.5564ms)
```

Measured (`scratch/s2d/probe-digest.ts`, the same batch and the same digest as the test):

```
$ node scratch/s2d/probe-digest.ts
before   e5226ad192104cda0e25e30790c00fdc052c829d5be7efa1c14811677ec29399
error    SKW_E_DM_KEY_IN_USE: u_alpha already exists
after    e5226ad192104cda0e25e30790c00fdc052c829d5be7efa1c14811677ec29399
identical true
u_ tables 0 registry rows 0 audit rows 0
```

The digest covers all 53 schema objects (27 tables, 21 indexes, 5 triggers) with their
`sqlite_master.sql` text — 17.4 KB of canonical text — plus the registry's rows and every
table's row count. The failure is the third statement, and the first two are gone.

The three assertions after the digest comparison are what make the digest mean something:
the created table is absent, the registry row the first statement would have added is
absent, and the audit row is absent. A digest alone would pass if the batch had created the
table and then deleted it again.

---

## 5. ITEM 0 — the E-16 timing flake, measured, fixed, and proved

### 5.1 What failed, and why it was not drift

S2c recorded one full run in five red at `{wrong_password:40.42, unknown_email:31.20,
wrong_totp:40.66}` — ratio **1.303** against a 1.20 band, with A and C within 0.24 ms of each
other and B 9.2 ms faster. That shape is a statistic, not a phase: the test measured 20
samples per cause, and at n=20 on a loaded box one cause's sample median lands 20 % off its
neighbours.

Measured, with the load shape the failing run shared its box with (8 CPU burners, an fsync
writer on the same volume, memory churn — `scratch/s2d/load.sh`), running the measurement 12
times at n=20:

```
n=20 rep=1 ratio 1.071   n=20 rep=7  ratio 1.757
n=20 rep=2 ratio 1.009   n=20 rep=8  ratio 1.182
n=20 rep=3 ratio 1.079   n=20 rep=9  ratio 1.084
n=20 rep=4 ratio 1.140   n=20 rep=10 ratio 1.202
n=20 rep=5 ratio 1.066   n=20 rep=11 ratio 1.209
n=20 rep=6 ratio 1.080   n=20 rep=12 ratio 1.065
```

**3 of 12 over the band**, one at 1.757. Inside a single cause the distribution spans
p10=23.8 ms to p90=43.9 ms under that load — a factor of 1.84 — which is why a median of 20
samples is not a stable estimator. E-16's own text says the measurement is *"at least 40
samples each"*, and S2c shipped 20: the gate was under-sampled against its own spec, and that
is the defect. The 20 % band was never the problem and is untouched.

### 5.2 The fix

`test/admin-auth.test.ts` case 4:

- **60 samples per cause**, above E-16's floor of 40 (1.5× the shipped count);
- **interleaved**: one round is A (wrong password), B (unknown email), C (wrong TOTP)
  back-to-back, so every cause has a sample in every round and a load phase that slows the
  box cannot land inside one cause's block;
- **medians of the interleaved samples**, band **1.20** — unchanged;
- the failure message now carries `p10`/`p90` per cause, so the next reader can tell "the box
  was slow" (the whole spread moved) from "one cause does less work" (the median moved and
  the percentiles did not).

The same measurement at n=60 under the same load:

```
n=60 rep=1 ratio 1.087   n=60 rep=6  ratio 1.040
n=60 rep=2 ratio 1.025   n=60 rep=7  ratio 1.020
n=60 rep=3 ratio 1.050   n=60 rep=8  ratio 1.057
n=60 rep=4 ratio 1.079   n=60 rep=9  ratio 1.028
n=60 rep=5 ratio 1.122   n=60 rep=10 ratio 1.006
```

0 of 10 over the band, worst 1.122. The case's wall time rises from ~1.2 s to ~2.4 s idle
(~6 s under the heavy load), well inside the 15 s `--test-timeout` E-8 sets.

### 5.3 Ten consecutive full runs

Each run is `make test` (toolchain → gitignore → schema → **27/27 claims** → frozen quotes →
build → typecheck → 244 node tests), from `scratch/s2d/ten-runs.sh`, on the delivered tree:

```
run  1  exit=0    60s  # tests 244 # pass 244 # fail 0 # skipped 0
         ok 16 - 4. three login failure causes are indistinguishable in status, body and time
         claims: 27/27 passed, 0 skipped, 0 failed
run  2  exit=0    55s  # tests 244 # pass 244 # fail 0 # skipped 0
         ok 16 - 4. three login failure causes are indistinguishable in status, body and time
         claims: 27/27 passed, 0 skipped, 0 failed
run  3  exit=0    57s  # tests 244 # pass 244 # fail 0 # skipped 0
         ok 16 - 4. three login failure causes are indistinguishable in status, body and time
         claims: 27/27 passed, 0 skipped, 0 failed
run  4  exit=0    54s  # tests 244 # pass 244 # fail 0 # skipped 0
         ok 16 - 4. three login failure causes are indistinguishable in status, body and time
         claims: 27/27 passed, 0 skipped, 0 failed
run  5  exit=0    51s  # tests 244 # pass 244 # fail 0 # skipped 0
         ok 16 - 4. three login failure causes are indistinguishable in status, body and time
         claims: 27/27 passed, 0 skipped, 0 failed
run  6  exit=0    67s  # tests 244 # pass 244 # fail 0 # skipped 0
         ok 16 - 4. three login failure causes are indistinguishable in status, body and time
         claims: 27/27 passed, 0 skipped, 0 failed
run  7  exit=0    65s  # tests 244 # pass 244 # fail 0 # skipped 0
         ok 16 - 4. three login failure causes are indistinguishable in status, body and time
         claims: 27/27 passed, 0 skipped, 0 failed
run  8  exit=0    71s  # tests 244 # pass 244 # fail 0 # skipped 0
         ok 16 - 4. three login failure causes are indistinguishable in status, body and time
         claims: 27/27 passed, 0 skipped, 0 failed
run  9  exit=0    67s  # tests 244 # pass 244 # fail 0 # skipped 0
         ok 16 - 4. three login failure causes are indistinguishable in status, body and time
         claims: 27/27 passed, 0 skipped, 0 failed
run 10  exit=0    68s  # tests 244 # pass 244 # fail 0 # skipped 0
         ok 16 - 4. three login failure causes are indistinguishable in status, body and time
         claims: 27/27 passed, 0 skipped, 0 failed
```

**10 runs, 10 green, the E-16 case `ok` in all ten**, 244/244 tests and 27/27 claims each
time (`scratch/s2d/ten-runs.log`: `runs: 10  green: 10  e16-ok: 10  e16-red: 0
claims-27: 10`). Before the fix the same command produced one red in five (S2c's record) and,
under the load generator, three reds in twelve measurement repetitions at n=20 (§5.1).

### 5.4 The mutation that must still trip it

`M1` in §6 injects a real 12 ms delay into the **unknown-email** failure path in
`app/admin/auth.ts` — one cause, not all three — and the case goes red:

```
RED  M1 auth: a real delay on one failure path (E-16)
       app/admin/auth.ts: 13996 -> 14082 bytes; exit 1;
       not ok 1 - 4. three login failure causes are indistinguishable in status, body and time
       restored: sha256 ok
```

A 12 ms delay on a ~32 ms sample is +37 %, comfortably outside a 20 % band — so the gate is
sensitive to the thing it is for (one cause doing different work) while being insensitive to
the thing that made it flake (which 20 samples of a 1.8×-spread distribution happened to
catch).

---

## 6. Negative controls — every new gate goes red when its behaviour is broken

Method: sha256 baseline → apply one exact mutation → run the one affected gate → restore →
verify the hash → report. Script: `python3 scratch/s2d/negative-controls.py`. The criterion
for "caught" is that the **named** gate is the one that failed, not merely that something
went red.

```
root: /Volumes/Backup/Development/skunkworks
RED  M1 auth: a real delay on one failure path (E-16)
       app/admin/auth.ts: 13996 -> 14082 bytes; exit 1; not ok 1 - 4. three login failure causes are indistinguishable in status, body and time
       restored: sha256 ok
RED  M2 runner: the registry row is not written
       app/ddl/run.ts: 18103 -> 18180 bytes; exit 1; not ok 1 - O1. create_table: registry row, audit row and the asset guard in one transaction
       restored: sha256 ok
RED  M3 runner: COMMIT before the postcondition
       app/ddl/run.ts: 18103 -> 18103 bytes; exit 1; not ok 1 - R2. the postcondition refuses a table outside the four prefixes even if SQLite accepted it
       restored: sha256 ok
RED  M4 runner: the failure path commits the partial batch
       app/ddl/run.ts: 18103 -> 17969 bytes; exit 1; not ok 1 - C2. a batch failing on its third statement leaves the schema byte-identical
       restored: sha256 ok
RED  M5 AST: no default_required refusal
       app/ddl/ops.ts: 27747 -> 27526 bytes; exit 1; not ok 1 - O2. add_column: in place when SQLite allows it, refused without a default when it does not
       restored: sha256 ok
RED  M6 AST: no rebuild_required refusal
       app/ddl/ops.ts: 27747 -> 27557 bytes; exit 1; not ok 1 - O3. drop_column: rebuild_required on an indexed column, rebuild when the caller asks
       restored: sha256 ok
RED  M7 verifier: compares the chain but not the seal
       app/audit/chain.ts: 10213 -> 10164 bytes; exit 1; not ok 1 - A4. THE CRITERION — tamper one row and recompute the chain: the walk passes, the seal refuses
       restored: sha256 ok
RED  M8 emitter: CREATE TABLE loses its id column (the S2c defect)
       app/ddl/emit.ts: 6713 -> 6699 bytes; exit 1; not ok 2 - C5. the executed SQL text equals the preview text for all six ops
       restored: sha256 ok

proof: PASS — all 8 mutations tripped their gate, and every file came back byte-identical
```

Two of these are worth reading twice:

- **M4** is not "remove the `ROLLBACK`". Removing it leaves the gate green, because the
  `finally` rolls the transaction back and `close()` discards the handle — the belt-and-braces
  is real. What the mutation has to do is commit the partial batch, and then C2 goes red. A
  mutation that does not change behaviour proves nothing, and reporting it as a caught
  mutation would have been a lie.
- **M7** removes the seal comparison and only `A4` goes red — the link walk still passes on
  the tampered file. That is round 2's finding, in one line of diff.

---

## 7. Decisions, spec gaps, and what this slice changed that it was not asked to

1. **The S2c emitter produced SQL SQLite refuses.** `CREATE TABLE "u_x" ("col" TEXT,
   PRIMARY KEY ("id"))` — no `id` column. Fixed in `emit.ts`; C5 is the gate that would have
   caught it earlier, and is the reason "the preview is the SQL that runs" has to be a test
   rather than a promise. `id` is also now reserved: a column named `id` is a 400.
2. **`drop_column` always rebuilds; `add_column` rebuilds only when SQLite refuses the
   ALTER.** §4.4's rule is that an indexed or FK-referenced column is `rebuild_required`
   without the flag; an unindexed column compiles to the 12-step rebuild, which is the other
   half of the same sentence ("compiles to the 12-step rebuild or is refused"). `add_column`
   with `NOT NULL` and a reference type cannot go through `ALTER` at all — with
   `foreign_keys=ON` SQLite refuses a `REFERENCES` clause whose default is not NULL, and a
   `NOT NULL` column needs a default — so it takes the rebuild, where `foreign_keys=OFF` is
   legal. `PRAGMA foreign_key_check` runs inside the transaction afterwards and refuses the
   commit if the graph is broken.
3. **The rebuild regenerates from `cms_table_registry.columns_json`, not from SQL text.**
   That is what the column is for ("the closed-type column inventory Kysely types are
   regenerated from"), and it gives a testable invariant: the rebuilt table's
   `sqlite_master.sql` equals `emitCreateTable`'s output byte for byte (C7 asserts it). A
   `u_*` table with no registry row cannot be edited at all — `SKW_E_DM_DDL_POSTCONDITION`.
4. **The registry's `columns_json` carries `id`; the AST's `columns` does not.** Getting this
   wrong double-counts the primary key, and the first run did. `astColumns()` is the single
   place that strips it, so every one of the six ops agrees.
5. **`SKW_DDL_MAX_STATEMENTS` caps operations, not statements.** §4.4's refusal says
   "operations" and §9.4's diagram says "≤ 8 statements"; a 12-step rebuild is one operation
   and eleven statements. The cap is enforced on the batch length (where the refusal is
   specified), and the report exposes the statement count so the difference is visible.
6. **`crud.ts` now edits `u_*` rows.** §9.3 says "row data in `cms_*`"; a table the builder
   creates has no other editing surface, and the alternative is a table with no way to put
   data in it. Same writer, same audit row, same `admin-write` class, same three
   immutability rules. `p_*` stays out — a plugin's rows are the plugin's.
7. **The apply route lets refusals propagate as taxonomy JSON.** §4.3 says every response the
   app emits is `{error:{code,message?,requestId,detail?}}`, so an HTML error page would be a
   defect; the client's `fetch` shows the code and `reason` rather than a rendered guess.
   A form that rendered refusals would need an exemption this slice may not grant itself.
8. **The audit canonical row moved to `app/audit/chain.ts`.** S2c defined it inside
   `crud.ts` and exported `auditHash` "so a verifier uses the writer's definition"; now there
   is one definition and the writer imports it. The bytes are unchanged — A1 recomputes every
   stored row with the verifier's copy and compares.
9. **`audit_seal` is cumulative and sealed once per day.** `rows` is `count(cms_audit)` and
   `head` the chain's last hash (§9.6's own wording). Re-sealing the same day with a
   different head is refused (`SKW_E_SEC_AUDIT_SEAL`), because otherwise "tamper, recompute,
   re-seal" would launder the chain; re-sealing with the same head is idempotent for a daily
   job that ran twice.
10. **A rebuild regenerates the asset guard instead of replaying it.** Measured before the
    fix: `drop_column u_post.cover` (the only ASSET column) left `trg_asset_guard_u_post` in
    place, its `WHEN` clause naming a column that no longer existed. SQLite accepts a
    `CREATE TRIGGER` whose body names a missing column — it resolves the name when the
    trigger *fires* — so the damage would have surfaced as an error on an unrelated
    `DELETE FROM cms_asset`, months later. The rebuild now rebuilds the guard from the
    surviving columns, deletes the old registry row when no asset column remains, and
    `O7` holds both halves. The same class of bug as the S2c emitter: correct-looking SQL
    nobody executed.
11. **`waitedFor` is a lower bound, not a head count** (§3.7). SQLite does not expose who
    holds a lock; the field is the number of `BEGIN IMMEDIATE` re-attempts and is documented
    as that.

---

## 8. What remains for S2e / S3

S2's own criteria, still open from S2b/S2c and **not** in this slice:

1. **The Data Source registry, resolver and publish gate** (§6.2): `cms_datasource` rows, the
   plan-before-measure rule (a `SCAN` refuses at publish), `cost_ms_max`, the parameter-set
   cache key, and `site.page(path)` with the nested-path case. This is the largest remaining
   piece of S2.
2. **The preview token** (O-29): `status='draft'`, 30 min, `no-store`.
3. **Kysely types regenerated from `columns_json`.** The registry is now accurate for all
   seven ops (that is what the index/column counts are for), but no generator reads it yet.
4. **The daily seal job.** `sealNow()` exists and is gated; what does not is the scheduler
   that calls it once per tenant per UTC day, and the operator-facing command that runs
   `verifyAgainstSeal` for a tenant and a day. `SKW_SCHEMA_EDIT=off` hides the builder, as
   §9.4 requires.
5. **`cms_view_registry`** (§4.1): views are migration-owned and the postcondition is
   specified as "a view not in this registry fails the DDL runner's postcondition", but the
   runner creates no views, so the check is not implemented — it belongs with the first op
   that can create one, which is not in the seven-op union.
6. **S3** takes the audit chain's write volume: gated downloads add `cms_download_event`
   rows, and the seal's per-tenant-per-day shape is what makes that affordable (32.1 KB per
   tenant-year, check 25).

---

## 9. Files

```
 M app/admin/crud.ts        M app/ddl/emit.ts        M test/admin-auth.test.ts
 M app/admin/routes.ts      M app/errors.ts          M test/admin-builder.test.ts
 M test/helpers/admin.ts
?? app/audit/chain.ts       ?? app/ddl/ops.ts        ?? app/ddl/refuse.ts
?? app/ddl/run.ts           ?? test/audit-seal.test.ts   ?? test/ddl-runner.test.ts
?? test/helpers/ddl-child.ts
?? docs/build/S2d-report.md
?? scratch/s2d/             (probes, the load generator, the ten-run loop, negative controls)
```

`scratch/s2d/` is not a deliverable and is not committed: it holds the measurement scripts
the numbers in §5 and §6 come from, so a reader can re-run them.
