# S1 — Hosting core: independent QA, round 2 (post-errata rework)

**Reviewer:** QA (independent of the builder). **Date:** 2026-10-20.
**Tree:** `/Volumes/Backup/Development/skunkworks`, uncommitted, as delivered after the 15-item
rework. **Previous verdict:** NO-GO (`S1-qa.md`, HEAD~). **This verdict: GO.**
Both blockers are dead by re-attempt, not by assertion. All four negative controls I ran went red
and every file I mutated was restored by hash. Two new **gate-only** majors remain (G3, G4) and
must be closed before S2 leans on this gate; neither is a defect in S1's behaviour.

Environment I measured on: macOS 15.7.4, Node v22.23.1, Docker 29.7.2, nginx `1.31-alpine`,
`/usr/bin/python3` 3.9.6 / SQLite 3.43.2, and a second interpreter 3.14.6 / SQLite **3.53.4**.

---

## 0. Summary — every round-1 finding, closed or re-raised

| # | Round-1 finding | Status now | Where it is proved |
|---|---|---|---|
| **B1** | `/admin/*` on **any** Host was the admin listener; every tenant site served the admin surface; the test asserted it | **CLOSED** | §2: 110-combination sweep, 0 × 421, 0 × `Set-Cookie`, byte-identical bodies on 4 tenant hosts; control 4 puts B1 back and the suite goes red |
| **B2** | suspend / archive / mode / `db_version` / deleted domain invisible until restart | **CLOSED** | §3: all six mutations by a **second connection**, visible on the next request; counter proven same-transaction by `ROLLBACK` |
| **M1** | client `X-Forwarded-Prefix` became `tenant.prefix` | **CLOSED** | `via='host'` now yields `prefix: ""` for both `/demo/evil` and `/demo/acme`; header-routed still `/demo/acme` (§6) |
| **M2** | every non-`AppError` borrowed the 503 code | **CLOSED** | malformed JSON → `400 SKW_E_PLT_REQUEST_INVALID`; 17 MiB direct → `413 SKW_E_PLT_BODY_TOO_LARGE` (§6) |
| **M3** | a new domain 404s at the edge until someone reloads nginx | **CLOSED as specified**, re-raised as an operational risk | E-12 is now a 4-step ordered contract with a gated negative (`test/onboarding.test.ts`); the *manual* sequence remains — §8 |
| **m1** | convergence compared `(type,name)`, so a missing CHECK passed | **CLOSED** | control 3: one dropped CHECK turns **both** gates red, naming `cms_download_code` |
| **m2** | `Retry-After` had no wire gate | **CLOSED** | control 1: suppressed header → `not ok 19` |
| **m3** | env gate hung >180 s instead of failing | **CLOSED** | control 2: red in ~5 s by named `ETIMEDOUT`; with the inner timeout removed, the suite belt kills it at 15.06 s |
| **m4** | demo key capped at 32 while `tenant.key` allows 40 | **CLOSED** | `10-app.conf` carries `{0,39}` ×3; 0 unquoted location regexes |
| **m5** | edge 413 was nginx HTML, outside the always-JSON claim | **CLOSED** (scoped, not "fixed") | E-13 names the four out-of-app responses; the 17 MiB edge case asserts `text/html` + no taxonomy code |
| **m6** | HTTP/1.1 with no `Host` → `{}` 400 | **CLOSED** (scoped) | asserted as "400, no tenant, nothing about the body" |
| **m7** | undeclared interpreter prereqs; the pin hid E-6 | **CLOSED in substance, defective in CI** | `make verify-toolchain` fails loudly; `verify-claims-modern` → 27/27 on SQLite 3.53.4, exit 0. The CI half is G4 |
| **G3** | — | **NEW, major (gate)** | `SKW_SKIP_DOCKER=1 make verify-s1` → **exit 0 with 12 skipped**, i.e. every nginx gate silently off (§7) |
| **G4** | — | **NEW, major (gate)** | `.github/workflows/gate.yml` has never run **and** aborts at its own interpreter assertion on the runner it names (§7) |

No round-1 finding was dropped silently. Nothing in the errata's §3 "settled ground" was
re-litigated by me.

---

## 1. The gates, run myself

```
$ make test
verify-toolchain: /usr/bin/python3 -> python 3.9.6, sqlite 3.43.2, argon2 ok
PASS  1 schema/ER parity + negative tests   …  PASS  27 connection classes …
27/27 passed, 0 skipped, 0 failed
adopted sentences: 24/25 verbatim in SDS.md; 1 superseded by 02-errata
frozen §4 blocks: 11/12 verbatim; 1 superseded by 02-errata
resolution steps: 5/5 present; env names: 29/29 present
PASS the SDS quotes the register
# tests 106  # pass 106  # fail 0  # skipped 0
EXIT=0                                    (34.8 s wall)

$ make verify-s1
verify-toolchain: /usr/bin/python3 -> python 3.9.6, sqlite 3.43.2, argon2 ok
# tests 106  # pass 106  # fail 0  # skipped 0
EXIT=0                                    (25.6 s wall)

$ make verify-claims-modern MODERN_PYTHON=…/py-modern/bin/python
verify-toolchain: … -> python 3.14.6, sqlite 3.53.4, argon2 ok
27/27 passed, 0 skipped, 0 failed
EXIT=0

$ SKW_SKIP_DOCKER=1 make verify-s1
# tests 106  # pass 94  # fail 0  # skipped 12
EXIT=0                                    ← G3, §7
```

`# skipped 0` on the first two runs is real, not a quiet skip: the two nginx suites ran against
`nginx:1.31-alpine` (11 + 1 tests). The builder's 106/106 on two interpreters is true as written.

---

## 2. B1 re-attempt — `/admin/…` on a production tenant host

App-direct (the listener is app state; nginx only forwards `Host`), fixture `control.db`/`site.db`,
real `buildApp`. For each Host I compare `/admin/t/acme/pages` against `/no-such-page-xyz` on the
**same** Host, with `requestId` normalised:

```
{"host":"acme.test",      "admin":{"status":404,"code":"SKW_E_RT_PAGE_NOT_FOUND"},
                          "unknown":{"status":404,"code":"SKW_E_RT_PAGE_NOT_FOUND"},
                          "bodyEqual":true,"headersEqual":true,"setCookie":null,"location":null}
{"host":"www.acme.test",  … "bodyEqual":true,"headersEqual":true …}
{"host":"beta.test",      … "bodyEqual":true,"headersEqual":true …}
{"host":"acme-demo.test", … "bodyEqual":true,"headersEqual":true …}   ← the demo host: 404, not 421
{"host":"demos.skw.test", "admin":{"code":"SKW_E_PLT_TENANT_UNKNOWN"},
                          "unknown":{"code":"SKW_E_PLT_TENANT_UNKNOWN"},
                          "bodyEqual":true,"headersEqual":true …}     ← that host maps to no tenant
{"host":"admin.skw.test", … "bodyEqual":true,"headersEqual":true …}
```

Bodies and header sets are equal on every row: **no** `Set-Cookie`, **no** `Location`, **no** 421.
The demo-host row is the one round 1 could not get — it used to be 421, i.e. an oracle that said
"this path is special".

Sweep for any Host/path that reaches the admin surface — 10 Host forms × 11 paths
(`/admin`, `/admin/`, `/admin/t/acme/pages`, `/ADMIN/…`, `//admin`, `/admin%2F…`, `/adminish`,
`/demo/acme/admin/…`, `/./admin`, `/admin/../admin/…`, `/admin?x=1`):

```
sweep rows=110  421s=0  setCookies=0  locations=0
```

That is structural, not luck: `listenerFor()` now takes **only** the Host, and `resolveRequest()`
has exactly one branch keyed on it. There is no code path where a pathname can mount the admin
surface.

The admin host **is** the admin surface. The only S1-visible discriminator is row 1 (it fires only
when `listener='admin'`):

```
admin.skw.test + X-Skunkworks-Tenant: ''      -> 421 SKW_E_PLT_EDGE_PROOF   (row 1)
acme.test     + X-Skunkworks-Tenant: ''      -> 200 acme, via=host          (row 8)
admin.skw.test /healthz, /readyz              -> 200 (answered before resolution, §9.5)
admin.skw.test /pricing, /media/x.png         -> 404 SKW_E_PLT_TENANT_UNKNOWN (rule 2)
```

S1 mounts no admin *route* (`session: null` by design; S2 owns auth), so "reachable" cannot mean a
200 here. What is proven is what §9.1 claims: one Hostname flips the listener, every other Host
does not, and a tenant header present at all is refused on it.

Hostile Host forms fold as specified: `ADMIN.SKW.TEST.` → admin, `admin.skw.test:8443` → admin,
`admin.skw.test.evil.test` → public, `evil.admin.skw.test` → public, `null`/`''` → public.

**One observation, not a finding.** `listenerFor('admin%2Eskw.test')` → `admin`: `normaliseHost()`
runs `domainToASCII`, which percent-decodes. It is fail-*closed* (it grants the admin listener, never
a tenant), and it cannot come from a `domain` row — `domain.host` is `CHECK(host NOT GLOB
'*[^a-z0-9.-]*')`, so `%` is refused at the schema. Worth remembering when S2 lands
`__Host-sk-sess`: the `__Host-` prefix binds to the literal host, so no cookie would be sent to the
`%`-form anyway.

---

## 3. B2 re-attempt — control writes seen on the next request, no restart

Second `control.db` connection while the app serves; `rev` read from `control_revision`:

```
warm                                         rev=10 -> 200 acme
after UPDATE tenant.status=suspended         rev=11 -> 404 SKW_E_PLT_TENANT_UNKNOWN
after UPDATE tenant.status=archived          rev=12 -> 404 SKW_E_PLT_TENANT_UNKNOWN
after UPDATE tenant.status=active            rev=13 -> 200 acme
after DELETE FROM domain acme.test           rev=14 -> 404 SKW_E_PLT_TENANT_UNKNOWN
after INSERT domain acme.test                rev=15 -> 200 acme
after UPDATE tenant.db_version=9             rev=16 -> 503 SKW_E_DM_SCHEMA_STALE  retry-after=5
after UPDATE tenant.db_version=3             rev=17 -> 200 acme
after INSERT domain new.test                 rev=18 -> 200 on new.test  (tenant count unchanged)
```

The last row is the one the old stamp could never see: a new host with **no** tenant insert now
routes on the next request.

**Same transaction, by construction and by measurement.** The counter is moved by six `AFTER
INSERT/UPDATE/DELETE` triggers on `tenant` and `domain` whose body is
`UPDATE control_revision SET rev = rev + 1, changed_at = … WHERE id = 1;` — application code never
touches it, so a write from `sqlite3`, `migrate` or the next image bumps it too. Proven, not
assumed:

```
rev before=19  inside-open-txn=20  after-ROLLBACK=19     ← the bump rolled back with the write
UPDATE beta status=active (no-op value): rev 19 -> 20    ← still an UPDATE, still moves
```

**§5.4a, one read per request:**

```
stats before={"stampReads":132,"rebuilds":10}  after 5 requests={"stampReads":137,"rebuilds":11}
deltaStampReads=5  deltaRebuilds=1
```

Five requests → five stamp reads, one rebuild. The stamp is `rev || ':' || PRAGMA user_version` from
the control handle the map already holds. The design caveat is honest and unchanged from the errata:
the read is one per *map lookup*, and today the resolver makes exactly one lookup per request.

---

## 4. Negative controls — break, prove red, restore, prove green

Method identical for each: `shasum -a 256` baseline, mutate the **behaviour** (never the test,
except 2b where the test *is* the thing under test), run the named gate, restore from the baseline
copy, re-hash, re-run.

### 4.1 E-7 — `Retry-After` suppressed in `sendError()`

```ts
// app/main.ts
if (false && err.retryAfter !== undefined) reply.header('retry-after', String(err.retryAfter));
```

```
$ node --test --test-timeout=15000 test/tenancy/resolve.test.ts
not ok 19 - E-7 — every code with a retry_after entry carries the header, with that value
# tests 20  # pass 19  # fail 1
RED_EXIT=1
→ restored 399dc59f32fc…  →  # tests 20  # pass 20  # fail 0   GREEN_EXIT=0
```

### 4.2 E-8 — the boot refusal removed (the regression that used to hang)

`assertNoDeletedPrefixes()` made a no-op, test file untouched:

```
$ node --test --test-timeout=15000 test/env.test.ts
not ok 7 - the real process refuses to start and exits non-zero, naming the key on stderr
  error: 'the process booted instead of refusing: SKUNK_EDGE_TOKEN (the ^SK_|^SKUNK_ refusal regressed)'
# tests 9  # pass 5  # fail 4
RED_EXIT=1        wall clock: real 0m10.374s      ← round 1 measured >180 s and never returned
```

**Second belt, proved separately (2b):** with the inner `spawnSync({timeout: 5000})` deleted as well
— i.e. the exact shape of the round-1 defect — the outer runner still bounds it:

```
$ node --test --test-timeout=15000 test/env.test.ts
not ok 1 - test/env.test.ts
  error: 'test timed out after 15000ms'
# tests 1  # cancelled 1
RED_EXIT=1        real 0m15.060s
```

A red test in 5 s, or a cancelled test in 15 s. Never a wait.

### 4.3 E-14 — one `CHECK` dropped from `r3`

First attempt was invalid and I discarded it: I removed the whole `CHECK(...)` line from
`cms_download_code_r3`, which left a dangling comma, so the migration died on `near ")": syntax
error` — red for the wrong reason. Redone by removing the inline constraint, SQL still valid:

```sql
-- schema/r3-amendments.sql
-  code_selector TEXT NOT NULL UNIQUE CHECK(length(code_selector) = 4),
+  code_selector TEXT NOT NULL UNIQUE,  -- NEGATIVE CONTROL E-14
```

```
$ node --test --test-timeout=15000 test/migrate.test.ts
not ok 3 - a v1 site.db is migrated through the frozen chain to v3
  error: 'site.db v1->v3: table text drift (CHECK constraints live here): cms_download_code'
not ok 4 - E-14 negative control — dropping one CHECK …
# tests 9  # pass 7  # fail 2      TS_RED_EXIT=1

$ /usr/bin/python3 scripts/model/verify_claims.py
FAIL  20 migration chain v1->v3 converges on site.sql
       AssertionError: site.db: table text drift (CHECK constraints live here): ['cms_download_code']
26/27 passed, 0 skipped, 1 failed        PY_RED_EXIT=1
```

Both planes' gates name the object. This is precisely the case round 1 said was invisible: the
table set, the column sets and the trigger sets are identical; only the text differs.

```
→ restored 9501211c3020…  →  migrate 9/9 GREEN_EXIT=0,  check 20 PASS, 27/27, PY_GREEN_EXIT=0
```

### 4.4 E-2 — the path-based listener rule restored (B1, verbatim)

```ts
// app/main.ts, resolveRequest()
const listener = pathname === '/admin' || pathname.startsWith('/admin/')
  ? 'admin'
  : listenerFor(host, adminHost);
```

```
$ node --test --test-timeout=15000 test/admin-listener.test.ts
ok     1 - (a) the listener is the admin hostname, and the path never selects it
not ok 2 - (b) /admin/t/acme/pages on a tenant host is the same 404 as an unknown path …
not ok 3 - (c) the same path on a demo host is the same 404, not a 421
ok     4 - (d) the admin host with no session is 404 …
ok     5 - (d2) the admin host refuses a tenant header that is present at all (row 1)
# tests 5  # pass 3  # fail 2      RED_EXIT=1
```

My own B1 probe agrees under the mutation — which is also the proof that the probe is a real
instrument and not a zero that always reads zero:

```
{"host":"acme.test","admin":{"code":"SKW_E_PLT_TENANT_UNKNOWN"},
                    "unknown":{"code":"SKW_E_RT_PAGE_NOT_FOUND"},"bodyEqual":false}
→ restored 399dc59f32fc…  →  # tests 5  # pass 5  # fail 0   GREEN_EXIT=0
```

### 4.5 Restore proof

```
$ shasum -a 256 -c baseline.sha256
app/main.ts: OK
app/env.ts: OK
schema/r3-amendments.sql: OK
docs/sds/SDS.md: OK
docs/sds/02-errata.md: OK
b0b8e4d577694b69baa4eeeaf379959277431323cabc1e90e1e0f18e084cb599  scripts/model/check_frozen.py
a6eda489d68ffef2a56336dcc570bedad1aedc14bc47a9910d6ccbf8525c505b  test/env.test.ts

$ make test                 # after every mutation was reverted
27/27 passed, 0 skipped, 0 failed
PASS the SDS quotes the register
# tests 106  # pass 106  # fail 0  # skipped 0
EXIT=0

$ git status --porcelain | wc -l
42                          # 36 modified + 6 untracked — the state I received
```

**4 of 4 controls went red, none by hanging.** No file was left modified.

---

## 5. The supersession audit

`scripts/model/check_frozen.py` carries two `SUPERSEDED` entries — `C-25` (E-2) and `proxy snippet`
(E-11). Each runs the same four assertions in `superseded()`: the errata item exists in
`02-errata.md`; its section carries the exact `SUPERSEDES` marker; the retired text is **absent**
from `SDS.md`; the replacement is present **verbatim**. I proved each branch fires, one mutation at
a time, rather than reading the code and believing it:

| Assertion broken | Mutation | Output | rc |
|---|---|---|---|
| (c) retired text absent | §5.6 replaced with the **retired** C-25 sentence | `BAD SUPERSESSION: C-25: the retired text is STILL in SDS.md — the supersession was not applied` → `FAIL the SDS paraphrases the register` | 1 |
| (a) errata item exists | `### E-2 —` renamed to `### E-2x —` | `BAD SUPERSESSION: C-25: errata item E-2 is missing from 02-errata.md` | 1 |
| (b) marker present | `§2 C-25` → `§2 C-26` in the marker | `BAD SUPERSESSION: C-25: E-2 does not carry the marker 'SUPERSEDES 00-adjudication.md §2 C-25'` | 1 |
| (d) replacement verbatim | `no other Host` → `no other host` in §5.6 | `BAD SUPERSESSION: C-25: the E-2 replacement is not verbatim in SDS.md` | 1 |
| entry load-bearing | the whole `proxy snippet` entry deleted | `MISSING block: proxy snippet` → `FAIL` | 1 |

Every mutation restored, `PASS the SDS quotes the register`, `rc=0` after each.

**A note on the first row, because it is evidence in both directions.** My first attempt pasted only
the *tail* of the retired sentence (`and the admin listener returns 421 …`) under the new text, and
the check **passed**. That is not a hole: `norm(old) in NSDS` requires the retired sentence
contiguously, and a tail is genuinely not the retired text. It is why the second attempt replaced
the sentence whole. The assertion is exact, not substring-loose — and it is exact in the direction
that matters (re-introducing the *rule* fails).

**Was anything weakened or removed relative to HEAD~?** No. The diff is 84 insertions, 5 deletions,
and the deletions are three print statements' arithmetic plus two list comprehensions gaining an
` and X not in SUPERSEDED` clause. Concretely:

- Every non-superseded artefact is asserted exactly as before: 25 adopted sentences, 12 frozen §4
  blocks, the resolution-step numbers, 29 env names. Nothing moved out of `BLOCKS` or `found`.
- The exclusion is keyed to a dict whose every member carries the four assertions above — not a
  pattern, not a wildcard, and there is no "skip if missing" path: a missing errata item is an
  error, not a bypass.
- `ok = not (missing or bad or step_missing or env_missing)` **gained** `bad_supersessions`. The
  net direction of the change is strictly stronger than HEAD~, which had no supersession concept at
  all and would have failed on correct errata text.
- The other three `SUPERSEDES` markers of §1 (E-1, E-4, E-13) need no entry and get none: E-1
  renumbers nothing that `| N |` checks, and E-4/E-13 touch text this check never quoted. Their
  unchanged assertions still run.

**One tightness note, not a defect.** The snippet's marker string is `SUPERSEDES 00-adjudication.md
§4.1`, which is also the opening of E-1's marker. Because the check scopes the marker search to
E-11's own section, the assertion is sound today; but it would be tighter if it required the
errata's own words (`§4.1's snippet`) rather than a prefix that two items share. Zero effect on this
slice.

---

## 6. Prior majors, re-attempted directly

```
M1  /whoami on acme.test + X-Forwarded-Prefix: /demo/evil  -> 200 via=host  prefix=""
M1  /whoami on acme.test + X-Forwarded-Prefix: /demo/acme  -> 200 via=host  prefix=""
M1  /whoami on demos.skw.test + tenant:acme + token + /demo/acme -> prefix="/demo/acme"   (header path intact)
M2  malformed JSON body            -> 400 {"error":{"code":"SKW_E_PLT_REQUEST_INVALID","requestId":…}}
E-4 17 MiB direct to the app       -> 413 SKW_E_PLT_BODY_TOO_LARGE
m4  10-app.conf demo-key grammar   -> ["[a-z0-9-]{0,39}" ×3]      (40 = tenant.key's max)
m4  unquoted location regexes      -> 0
```

The two halves of E-11 hold independently — the snippet clears the header and the resolver ignores
it on `via='host'` — which is why my round-1 control had to break both to see red. E-4's status and
code now agree on the wire, so `SKW_E_PLT_TENANT_UNAVAILABLE` is back to meaning only what §5.3 row
10 says.

---

## 7. New findings

### G3 — the entire edge layer can be skipped, and the gate still exits 0 (major, gate)

`test/nginx-e2e.test.ts` and `test/onboarding.test.ts` short-circuit on `SKW_SKIP_DOCKER=1`. That
is a reasonable convenience for a box with no daemon; what is not reasonable is that nothing
counts the skips:

```
$ SKW_SKIP_DOCKER=1 node --test --test-timeout=15000 test/nginx-e2e.test.ts test/onboarding.test.ts
ok 1 - through real nginx: GET /demo/acme/whoami strips to /whoami …   # SKIP
… ok 12 …                                                              # SKIP
rc=0

$ SKW_SKIP_DOCKER=1 make verify-s1
# tests 106  # pass 94  # fail 0  # skipped 12
EXIT=0
```

Twelve skipped tests is not a corner of the suite — it is E-1(b) (the empty header through the real
edge), E-5 (the slash-less 301 and the 40-char key), E-11 (the prefix clear), E-12 (onboarding) and
E-13 (the edge 413). This repository already holds the opposite rule for its Python gate: *"a skip
is a failure unless `--allow-skip`, and the Makefile never passes it"* (E-15). The node side has no
such rule, so `make test` green does not mean the edge was exercised. My own run had `# skipped 0`
and all 12 passed, so the behaviour is real today; the gate is what is weak.

**Why it is not a blocker:** default is to run, the skip prints per test, and no shipped behaviour
depends on it. **Why it must close before S2:** S2's CSRF matrix and session cookie live on the
same edge, and "green" must not be purchasable with an env var. The fix is one line — assert
`# skipped 0` in the Makefile, or fail when `SKW_SKIP_DOCKER` is set and `CI` is.

### G4 — the CI workflow has never run and cannot pass as written (major, gate)

`.github/workflows/gate.yml` is honest about being unexecuted (`S1-report.md` §8.4.7), and I did not
run GitHub Actions. But it is not merely unproven: its second step asserts

```
python3 -c '… assert v >= (3,50), "modern interpreter has SQLite %s < 3.50" …'
```

on `runs-on: ubuntu-24.04`, whose system `python3` links **SQLite 3.45.1** — the distribution's
SQLite, not one Python ships. The job therefore aborts in the `interpreters` step, before `npm ci`
and before any gate, on the very runner it names. There is no step that installs a ≥ 3.50 SQLite.
So E-15's "CI runs the claims gate twice" is satisfied by a file, not by a run, and the file as
written would go red for a reason that has nothing to do with the code.

Not a blocker for S1 (the DoD in errata §4 is `make test` + `make verify-s1` on both interpreters,
and I ran both here), but it must not be cited as evidence until it has run green once.

---

## 8. The six open items in `S1-report.md` §8.4, judged

| # | Open item | Blocker? | Judgement |
|---|---|---|---|
| 8.4.7 | CI workflow unexecuted | **No** — but the file is broken, not just unrun | **Follow-up, must fix before citing CI.** G4: the SQLite ≥ 3.50 assertion fails on `ubuntu-24.04` (3.45.1). Add an install step (or use a `python:3.14` container) and treat the first green run as the evidence |
| 8.4.1 | Row-6 miss for a well-formed header naming an unknown tenant → `404 SKW_E_PLT_TENANT_UNKNOWN`, reported at row 6 | **No** | **Follow-up, documentation.** The behaviour is the only defensible one (a 500 or a lie about the row are worse), the code is indistinguishable from row 8's miss so there is no oracle, and the test asserts the row. E-1's status table should gain "row 6 with no `tenant` row" in the next errata pass. Spec gap, not a code defect |
| 8.4.3 | Three constraint drifts fixed outside the errata's file list (`A8b`: `cms_redirect.from_path` NOT GLOB `//*`, `cms_form_submission.state` `'suppressed'`, `cms_datasource.cost_ms_p95 >= 0`) | **No** | **Follow-up, documentation — and the change is good.** These are exactly what E-14 exists to catch, and I proved the gate catches that class (§4.3). But a frozen file (`r3-amendments.sql`) gained three rebuilds the Architect never specified; that needs an errata line (E-16) recording A8b and its justification, or the next reviewer re-derives it. Gated, correct, undocumented |
| 8.4.5 | `nginx/templates/server.tmpl` updated but nothing reads it | **No** | **Follow-up.** Either delete it or make `generateAppConf()` render it. Today it is a second, ungated copy of the config shape — the "two sources of truth" failure mode the SDS forbids elsewhere. A reader can be misled; no gate can be |
| 8.4.6 | §3's `Makefile` fence still lists `test / verify / verify-schema / verify-claims / verify-gitignore` | **No** | **Follow-up, documentation.** The fence is stale by E-10's own restriction (only the paragraph after it may change), so this is the errata's constraint, not an omission. It should be corrected in the same pass that adds E-16 — §3 is the file-list authority, and it now omits two targets the DoD depends on |
| 8.4.4 | E-6 forbids the literal `legacy_alter_table` in `verify_claims.py`, so the stronger "run the chain with the pragma explicitly OFF" sub-case was dropped | **No** | **Follow-up, no action needed.** The claim is carried: the chain applies with the pragma unset on **both** interpreters (3.43.2 and 3.53.4), and my §4.3 control shows the convergence comparison has teeth. A source assertion plus a real comparison is stronger than an explicit-OFF run, which would only have named the pragma |

Also judged, from §8.4's remaining items: 8.4.2 (mode flip moves the stamp but no longer changes
routing) is **correct** — asserting a 404 there would re-introduce the listener decision keyed on
tenant mode that §9.1 rule 4 forbids; 8.4.8 (`AppHandle.tenants` exposed read-only) is a
justifiable test seam and changes no behaviour; 8.4.9 (`listenerFor` takes no pathname) is the right
shape, and it is why my B1 sweep could not find a path-based hole; 8.4.10 (free port so the timeout
path fires rather than `EADDRINUSE`) is correct and I measured it.

---

## 9. What is most likely to break in week one

**Onboarding — and it is now a *documented* trap rather than an undocumented one, which makes it
more likely to be misread.** E-12 turns "picked up on the next request" into a four-step ordered
sequence: commit rows → `nginx_gen --write` → `nginx -t` → `nginx -s reload`. Between step 1 and
step 3 the two planes deliberately disagree: E-3's revision counter makes the **app** serve the new
host on the very next request, while the **edge** still 404s it because `server_name` is a generated
artefact. So the operator's first check (`curl` from inside the box, or the app's own log showing
the tenant served) succeeds and the customer's check fails. That is a support ticket that looks like
a tenancy bug and is not one. It is gated (`test/onboarding.test.ts` asserts the 404 *before* the
reload and 200 after) and it is specified — but nothing automates steps 2–4, and `rev` bumping makes
the window more convincing, not less.

Second, lower: a `tenant.db_version` raise fans out to `migrateTenant()` **inline on the request
path** through `probe()`. A mass raise (a deploy that bumps every tenant) turns a burst of requests
into concurrent migrations of the same files, and `SQLITE_BUSY` there is a 503 `SKW_E_DM_BUSY` with
`Retry-After: 1` — correct by contract, alarming in a dashboard. Worth a look in S2, not an S1
defect: it is the same design round 1 reviewed.

---

## 10. What I did not prove

- No `docker compose up`. The compose gate is `docker compose config`; the two digest-pinned images
  still do not exist.
- GitHub Actions was not executed. G4 is a static judgement about `ubuntu-24.04`'s bundled SQLite.
- Nothing about S2–S4: sessions, the admin CRUD surface, byte serving, export, plugins. Where B1's
  severity depended on S2 (the session cookie on that surface) I say so.
- Load and concurrency: every request above was serial. §5.4a's single-flight is argued by
  `better-sqlite3`'s synchronous `refresh()` and measured as one rebuild per bump, not raced.
- I did not re-derive the 27 claim checks; I ran them on two interpreters and read the ones E-6/E-14
  touch.

---

## 11. Reproduction

```
cd /Volumes/Backup/Development/skunkworks
make test                     # 27/27 claims, 106/106 tests, exit 0
make verify-s1                # 106/106, exit 0
make verify-claims-modern MODERN_PYTHON=…/py-modern/bin/python   # 27/27 on SQLite 3.53.4
SKW_SKIP_DOCKER=1 make verify-s1                                 # exit 0, 12 skipped — G3
```

My probes live outside the repo, in
`~/.hermes/profiles/ceo/cache/scratch/qa2/`: `b1b2.ts` (B1 sweep + B2 matrix over a second
connection), `m1m2.ts` (M1/M2/E-4/m4), `baseline.sha256` + `base/` (the restore proofs), and
`ctl{1,2a,2b,3,4,D1,D-a,D-b,D-d}-*.log` (every control's red and green output, verbatim).
The repo is byte-identical to the state I received apart from this report: `git status --porcelain`
is 43 entries — the same 36 modified files and 6 untracked paths as delivered, plus
`docs/build/S1-qa.md` (the deliverable) — and every baseline hash verifies.
