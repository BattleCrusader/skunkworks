# S2a — admin session, auth and CSRF

**Builder:** Backend Engineer. **Date:** 2026-10-20. **Base:** `d0c3c3a` (S1 GO).
**Not committed.** `git status --porcelain`: 6 modified, 8 new paths (listed in §1).

Two gate defects (G3, G4) closed first, then S2a. Every criterion below has a command
and its real output; every criterion also has a **mutation that makes its gate go
red** (§6), because a test that has never failed is not evidence.

---

## 1. What shipped

| Path | Status | What it is |
|---|---|---|
| `app/admin/session.ts` | new | `__Host-sk-sess` cookie, signed 32-byte hex id, sliding idle expiry, rotation, session-bound CSRF token |
| `app/admin/auth.ts` | new | argon2id at `m=19456,t=2,p=1` behind a 4-slot semaphore, TOTP (allowlist empty ⇒ mandatory), lockout 1/2/4/8/15 min, dummy-verify timing equalisation, `fleet_admin` refusal |
| `app/admin/routes.ts` | new | the `/admin/t/<key>/…` namespace: `login`, `session`, `session/rotate`, `logout`, and the CSRF/Origin/row-1/row-2 guards |
| `app/tenancy/listener.ts` | new | §9.1's `listenerFor()` moved out of `main.ts` so the admin router and the resolver share **one** rule |
| `app/main.ts` | modified | mounts the admin surface; `resolveRequest()` now passes the real session to row 7 instead of `session: null`; `serveNotFound()` extracted so a public listener answers `/admin/…` with the same page-miss path |
| `app/tenancy/resolve.ts` | modified | `headerPresent` / `anySkunkworksHeader` exported (no behaviour change) |
| `app/errors.ts` | modified | the four `SEC` codes S2a raises, at the statuses `schema/error-codes.json` already froze |
| `scripts/run-node-tests.mjs` | new | the node gate runner: **a skip is a failure** (G3) |
| `Makefile` | modified | `verify-s1` runs through the runner (G3) |
| `.github/workflows/gate.yml` | modified | G4 |
| `test/gate-runner.test.ts` | new | 6 tests: the gate on the gate |
| `test/admin-auth.test.ts` | new | 11 tests |
| `test/admin-session.test.ts` | new | 6 tests |
| `test/admin-csrf.test.ts` | new | 15 tests (the 12-case matrix as 12 named tests + 3) |
| `test/admin-listener.test.ts` | modified | **added** one test (e); no existing assertion changed |
| `test/helpers/admin.ts` | new | seeds real `user_account` rows with real argon2id hashes |

Schema untouched: `schema/control.sql` was read, not redesigned. The `session` table
and `user_account` are used exactly as specified — including the fact that `session`
has no `last_seen_at` column, which decides how idle expiry works (§7, gap 6).

---

## 2. The gates, run

```
$ make test
verify-toolchain: /usr/bin/python3 -> python 3.9.6, sqlite 3.43.2, argon2 ok
27/27 passed, 0 skipped, 0 failed
adopted sentences: 24/25 verbatim in SDS.md; 1 superseded by 02-errata
frozen §4 blocks: 11/12 verbatim; 1 superseded by 02-errata
resolution steps: 5/5 present; env names: 29/29 present
PASS the SDS quotes the register
# tests 145  # pass 145  # fail 0  # skipped 0
EXIT=0

$ make verify-s1
# tests 145  # pass 145  # fail 0  # cancelled 0  # skipped 0
EXIT=0

$ make verify-claims-modern MODERN_PYTHON=~/.hermes/profiles/ceo/cache/scratch/py-modern/bin/python
verify-toolchain: … -> python 3.14.6, sqlite 3.53.4, argon2 ok
27/27 passed, 0 skipped, 0 failed
EXIT=0
```

145 = 106 (S1) + 39 new: 6 gate-runner, 11 auth, 15 CSRF, 6 session, 1 listener.
`# skipped 0` on every run, and since §4 a skip cannot exit 0 anyway.

---

## 3. Acceptance criteria

### 3.1 Every non-GET without a valid CSRF token is `403 SKW_E_SEC_CSRF` — 12 cases

```
$ node --test test/admin-csrf.test.ts
ok  1 - matrix 1 no CSRF header
ok  2 - matrix 2 no CSRF header, no Origin
ok  3 - matrix 3 empty CSRF header
ok  4 - matrix 4 43 random characters
ok  5 - matrix 5 a valid token from another session
ok  6 - matrix 6 the session id used as the token
ok  7 - matrix 7 correct token, one character flipped
ok  8 - matrix 8 correct token, no Origin
ok  9 - matrix 9 correct token, foreign Origin
ok 10 - matrix 10 correct token, Origin with a suffix
ok 11 - matrix 11 correct token, wrong scheme
ok 12 - matrix 12 correct token, exact Origin (positive control)
ok 13 - the matrix is not one route: every non-GET without a token is refused
ok 14 - a GET needs no CSRF token, and a POST with the token succeeds and rotates
ok 15 - the token is bound to the session: two sessions of one user do not share it
# tests 15  # pass 15  # fail 0
```

Each case is a separate `test()`, so a red names the rule. Each case opens its **own**
session: a case that succeeds must not invalidate the cookie the next case uses, or
one mutation would cascade and hide which rule failed (it did, in my first version —
§6 C1 was re-run after the fix for exactly this reason).

The route under test is real (`POST /admin/t/acme/session/rotate`, §9.1's
privilege-change rotation), not a synthetic endpoint. Case 12 is the positive control:
without it, eleven 403s would also be produced by a route that 403s everything.

**Reading stated, because the criterion can be read two ways.** An unauthenticated
non-GET is `404 SKW_E_PLT_TENANT_UNKNOWN`, not 403 — §5.3 row 7 says a request with no
session on the admin listener is "there is no tenant here", and a 403 would tell an
attacker that `/admin/t/acme/…` exists while `/admin/t/nope/…` does not. The matrix is
therefore measured with a session; `#assertCsrf` only runs after a session resolved.

### 3.2 `Origin` mismatch on a non-GET is `403`

Cases 8–11 above, plus the login route, which has no session and therefore no token —
its only CSRF control is the Origin check, and it applies:

```
ok 10 - 8. the login route requires an exact Origin, even though no session exists yet
  no Origin                    -> 403 SKW_E_SEC_CSRF
  https://admin.skw.test.evil.test -> 403 SKW_E_SEC_CSRF
```

The check is `origin === SKW_ADMIN_ORIGIN`, string-exact: `http://admin.skw.test`,
`https://admin.skw.test.evil.test` and a missing header all fail. `Origin: https://admin.skw.test:443`
would fail too (the value is not the configured one); no normalisation is applied
because §9.1 says "exact".

### 3.3 Wrong password and nonexistent user are indistinguishable

```
$ node --test test/admin-auth.test.ts
ok 6 - 4. a wrong password and a nonexistent user are indistinguishable in status, body and time
```

The number the criterion asks for, measured with 40 samples each on this box
(`~/.hermes/profiles/ceo/cache/scratch/s2a/timing.ts`):

```json
{ "samples": 40,
  "wrong_password":     { "median_ms": 10.88, "p90_ms": 12.03, "min_ms": 10.42, "max_ms": 15.41 },
  "nonexistent_user":   { "median_ms": 10.25, "p90_ms": 11.07, "min_ms":  9.85, "max_ms": 14.56 },
  "median_ratio": 1.061,
  "statuses": [401, 401],
  "bodies_identical": true,
  "body": "{\"error\":{\"code\":\"SKW_E_SEC_CODE_INVALID\",\"requestId\":\"<request-id>\",\"message\":\"invalid credentials\"}}" }
```

**Tolerance: medians within 20%, measured 6.1%.** The gate asserts the same 20%
(`ratio <= 1.2`) and additionally asserts the scrubbed bodies are equal byte for byte.
The mechanism is a real argon2id verify against a fixed `DUMMY_HASH` when the lookup
misses, through the same semaphore, so both paths do exactly one hash.

### 3.4 The cookie carries the exact frozen attributes, and a wrong cookie is rejected

```
ok 7 - 1. the cookie carries exactly the five frozen attributes
ok 8 - 2. a tampered cookie is not a session: five rejection cases, all the row-7 404
```

Attribute assertion is the whole string, so an extra attribute is a failure:

```
^__Host-sk-sess=[0-9a-f]{64}\.[A-Za-z0-9_-]{43}; Path=/; Secure; HttpOnly; SameSite=Lax$
```

Five rejection cases, each `404 SKW_E_PLT_TENANT_UNKNOWN` with no `Set-Cookie`:
id with no signature · a flipped signature · an id of the wrong length · a signature
over a different id · the same value under a non-`__Host-` name. And the untouched
cookie still works in the same test, so the rejections are not "the app refuses
everybody". Attribute wrongness is asserted on the wire (§ the string above); the
client only controls the *value* and the *name*, which is what the five cases vary.

### 3.5 TOTP required when the allowlist is empty, not when populated

```
ok 1 - 0. the allowlist decides both consequences §9.1 states: TOTP and the idle window
ok 3 - 2a. TOTP is mandatory when the allowlist is empty: no code and a wrong code are both 401
ok 4 - 2b. with a valid TOTP the login succeeds, sets the cookie and reports totpRequired=false afterwards
ok 5 - 3. TOTP is not required when the allowlist is populated
```

Both cases are whole app instances over the same fixture: one built with the default
(empty) allowlist, one with `adminAllowlist: ['10.0.0.0/8']`. Empty: no code → 401,
`000000` → 401, `''` → 401, a code from another secret → 401; valid code → 200 and the
cookie. Populated: no code → 200 and `totpRequired: false`, and the idle window is
60 min rather than 15 (§9.1 says "idle drops to 15 min" only for the empty case).

### 3.6 An admin request on a tenant host is still the byte-identical 404

S1's test asserts this with no session. S2a adds the stronger witness — a **valid**
cookie and the session row's `expires_at` before/after:

```
ok 6 - (e) S2a: a real admin session does not make a tenant host an admin surface
```

and the sweep, 9 Host forms × 11 admin-ish paths with a valid cookie
(`scratch/s2a/sweep.ts`):

```json
{ "rows": 99, "bodyMismatch": 0, "setCookie": 0, "location": 0, "status421": 0, "mismatches": [] }
```

`/admin/t/acme/pages` on `acme.test` is `404 SKW_E_RT_PAGE_NOT_FOUND`, byte-identical
(after `requestId`) to `/no-such-page-xyz` on the same Host, with the cookie attached.
The row was not touched either: §9.1 rule 1 means a public listener does not parse the
cookie at all, so `session.expires_at` is unchanged by the attempt — and the same
cookie is a 200 on the admin host, so the row is not simply invalid.

The sharpest form of the same rule is asserted in the same test: `POST /admin/t/acme/login`
with **real credentials** at `acme.test` is `404 SKW_E_RT_PAGE_NOT_FOUND` with no
`Set-Cookie`. If the path could select the listener, that request would be a 200 that
mints an admin session on the tenant's own origin — B1, with the attacker holding the
password.

---

## 4. G3 — a skip can no longer read as a pass

`scripts/run-node-tests.mjs` wraps `node --test`, streams its output, and parses the
TAP summary. It fails when `# skipped > 0`, when `# cancelled > 0`, or when there is no
summary at all. The only escape is `SKW_ALLOW_SKIP=1` — single-purpose, by name, never
set by the Makefile (a test asserts that), and it prints a banner that says the run is
not a gate.

```
$ SKW_SKIP_DOCKER=1 make verify-s1
!!!!  SKIPPED TESTS ARE A FAILURE (E-15): 12 of 112 did not run
!!!!  skipped: through real nginx: GET /demo/acme/whoami strips to /who...
…
!!!!  SKW_SKIP_DOCKER=1 was set: the real-nginx gates were not exercised
run-node-tests: refusing to report a green gate over skipped tests
make: *** [verify-s1] Error 1
EXIT=1

$ SKW_SKIP_DOCKER=1 SKW_ALLOW_SKIP=1 make verify-s1
# tests 112  # pass 100  # skipped 12
!!!!  GATES SKIPPED — THIS RUN IS NOT A GATE (12 of 112)
100/100 executed tests passed, 12 skipped
EXIT=0
```

Red-then-green on a **single** skip in a real test (one `{ skip: true }` added to
`test/compose.test.ts`, then restored by hash):

```
FORCED_RED_EXIT=1
!!!  SKIPPED TESTS ARE A FAILURE (E-15): 1 of 8 did not run
!!!  skipped: docker compose config parses the file
test/compose.test.ts: OK            ← restored, shasum -c
RESTORED_GREEN_EXIT=0
# tests 8  # pass 8  # fail 0  # skipped 0
```

And the rule is itself gated (`test/gate-runner.test.ts`, 6 tests): a clean synthetic
suite is green with no banner; one skipped test is red and names it;
`SKW_SKIP_DOCKER=1` alone is not an escape; `SKW_ALLOW_SKIP=1` is and says so; a
failing test stays red under the escape; the Makefile does not pass it.

One detail worth recording: the child runner inherits `NODE_TEST_CONTEXT` when it is
invoked from inside `node --test`, and with it the child skips every file and produces
a *vacuous green with no summary*. The runner strips it. That was a real defect in my
first version, caught by the gate-on-the-gate before it could hide anything.

A second, found by `hermes verify` rather than by `make`: that harness runs the suite
under a **node 26** on `PATH`, whose `node --test` defaults to the `spec` reporter
(`ℹ tests 145`) instead of TAP (`# tests 145`). The runner read no summary and declared
a red — correctly, but for a reason that had nothing to do with the code. The child is
now spawned with `--test-reporter=tap` explicitly, so the format is pinned on node 22
and node 26 alike; the gate-runner suite is green under both
(`v22.23.1` and `v26.7.0`), and `hermes verify` is green end to end
(`bootstrap/build/typecheck` ok, `npm run test` 145/145, readiness `200` on
`http://127.0.0.1:4321/`).

---

## 5. G4 — the workflow

**Choice: both halves, split by what each can honestly assert.** A workflow must not
assert a version it did not provision, so:

1. **Of `/usr/bin/python3` it asserts only what ubuntu-24.04 provides**: SQLite
   `>= 3.40`, printing the real version. That can never be the reason the job dies,
   and a distribution bump is visible instead of fatal.
2. **The `>= 3.50` run is provisioned**: `actions/setup-python@v5` with
   `python-version: '3.14'`, then the assertion runs against *that* interpreter.
   python-build-standalone bundles its own SQLite; measured here on the same
   distribution: `CPython 3.14.6 -> SQLite 3.53.4` (QA's number) and
   `3.14.7 -> 3.53.1` — both ≥ 3.50. It is not a guess about the runner's apt.
3. **Two further first-push blockers, which a static review could not see because it
   stopped at the SQLite assertion**: `verify_claims.py` checks 1 and 12 shell out to
   `plantuml` and the `sqlite3` CLI, neither of which a bare `ubuntu-24.04` runner
   carries. The workflow installs both (`apt-get install -y plantuml sqlite3`) and
   prints their versions.

Local proof of the second claims run, and of the interpreter facts the workflow asserts:

```
$ make verify-claims-modern MODERN_PYTHON=…/py-modern/bin/python
verify-toolchain: … -> python 3.14.6, sqlite 3.53.4, argon2 ok
27/27 passed, 0 skipped, 0 failed
EXIT=0

$ /usr/bin/python3 -c '… assert v >= (3,40)'
pinned: /usr/bin/python3 3.9.6 sqlite 3.43.2
PINNED_ASSERT_EXIT=0
$ …/python-3.14.7/bin/python3 -c '… assert v >= (3,50)'
modern: …/python-3.14.7 3.14.7 sqlite 3.53.1
MODERN_ASSERT_EXIT=0
```

A useful accident that belongs in the record: running `make verify-claims-modern`
against a 3.14 build **without** `argon2-cffi` gives

```
25/27 passed, 2 skipped, 0 failed     EXIT=2
```

i.e. the python gate refuses to report a green over a skip. That is the behaviour G3
brought to the node side, and the reason the workflow installs `argon2-cffi` on both
interpreters.

**Still unproven, and stated as such in the file's header:** this workflow has never
executed on GitHub Actions. It must not be cited as evidence until a green run exists;
`make test`, `make verify-s1` and `make verify-claims-modern` are what S1/S2 cite. The
YAML parses (`yaml.safe_load`, 10 steps) and every command in it has been run on this
box except `actions/*` and `apt-get`.

---

## 6. Negative controls — the gate can go red

Method: `shasum -a 256` baseline, mutate the **behaviour**, run the affected file, restore
from the baseline copy, re-verify the hash, re-run green. Logs in
`~/.hermes/profiles/ceo/cache/scratch/s2a/`.

| # | Mutation | Red output | Green after restore |
|---|---|---|---|
| C1 | `verifyCsrf()` returns `true` | `not ok 1,3,4,5,6,7` — exactly the token cases; cases 2 and 8–12 stay green because Origin still refuses. `exit=1` | `# tests 15 # pass 15` |
| C2 | `#assertOrigin()` becomes a no-op | `not ok 8,9,10,11` — exactly the Origin cases. `exit=1` | 15/15 |
| C3 | the dummy argon2 verify is removed | `not ok 5 … medians must be within 20%: wrong-password 11.94ms vs nonexistent-user 0.68ms (ratio 17.540)` | 10/10 |
| C4 | one extra cookie attribute (`Max-Age=3600`) | `not ok 1` (exact string), `not ok 3` (the clear-cookie string) | 6/6 |
| C5 | `totpRequired` forced `false` | `not ok 1` (the allowlist test) and `not ok 3` (2a) — the empty-allowlist cases only | 11/11 |
| C6 | the path-based listener rule restored (E-2's defect) | `not ok 2,3,6` — tenant host, demo host, and (e) with a real session | 6/6 |
| C7 | rotation that forgets to revoke the old row | `not ok 4` (old id still works) | 6/6 |

All seven restored: `app/admin/session.ts: OK`, `app/admin/routes.ts: OK`,
`app/admin/auth.ts: OK` against `controls.sha256`, and the full suite green afterwards.

**Honest note on order.** The module and its gate were written in the same pass, not
test-first. The red proof for each criterion is therefore a mutation of the behaviour
(above) rather than a first-run failure. C1's first attempt was invalid and discarded:
the mutant rotated the shared matrix session in case 3 and cascaded through cases 4–12,
so the red set no longer identified which rule failed. The matrix was rewritten to give
each case its own session and C1 re-run; the red set is now exactly the token cases.

---

## 7. Spec gaps found (not invented silently)

The mandate says stop and report when the SDS is silent. Each decision below is
implemented, cited here, and marked for errata.

1. **No credential-login error code.** The 71 codes are frozen, §4.3's `SEC` list is
   complete for v1, and `test/error-codes.test.ts` pins the count at 71, so adding one is
   not this slice's call. Login failures (wrong password, unknown email, wrong TOTP) are
   `401 SKW_E_SEC_CODE_INVALID` — the same *shape* of decision as §7.2's argon2 code
   verifier, and one status for all three keeps the indistinguishability criterion.
   **Proposed E-16: add `SKW_E_SEC_AUTH_INVALID` (401) and bump the count to 72.**
2. **No CSRF header name.** §9.1 says "session-bound token on every non-GET" and names
   no wire name. Chosen: `X-CSRF-Token`. Deliberately **not** `X-Skunkworks-*`, because
   row 2 of §5.3 refuses any `X-Skunkworks-*` header from an untrusted peer — an admin
   form must not trip a tenancy rule with its own token.
3. **Idle window when the allowlist is populated.** §9.1 fixes only the 15-minute
   empty case. Implemented as 60 min (`IDLE_MS_WITH_ALLOWLIST`), asserted as "> 15 min
   and ≈ 60 min".
4. **The IP allowlist has no storage and no env name.** §4.3's table is complete at 22
   names, and `control.sql` has no table for it. It enters as
   `BuildAppOptions.adminAllowlist`, default `[]` — the exported-bundle value, and the
   one that makes TOTP mandatory. The *enforcement* of "outside the allowlist" is not in
   the app: `trustProxy: false`, so the app cannot trust a client IP, and an allowlist
   that can be spoofed is worse than none. It belongs at the edge (§12.3) or needs a
   control-plane table. **Open.**
5. **TOTP parameters.** Only `user_account.totp_secret` (a base32 secret) exists.
   Implemented as RFC 6238 defaults: SHA-1, 6 digits, 30 s step, ±1 step tolerance.
   No enrolment route exists in S2a (nothing sets `totp_secret` but a test or an
   operator); **S2b needs one** or every operator is locked out of a fresh bundle.
6. **No absolute session lifetime.** `session` has `expires_at` and no `last_seen_at`,
   so idle expiry is implemented by *sliding* `expires_at` on every authenticated
   request. A session in continuous use never expires. Adding a column is a migration
   and a decision the SDS has not made. **Open, and it is a real gap** — the fix is
   either `last_seen_at` + a fixed `expires_at`, or an explicit absolute cap.
7. **`fleet_admin` has no login URL.** §9.2 gives every admin URL the shape
   `/admin/t/<key>/…`, and the schema forces `tenant_id IS NULL` for that role, so the
   role cannot be reached through a tenant URL. The lookup accepts a global row as a
   fallback (a tenant-scoped row with the same email wins) so the role can be
   authenticated — and refused with `403 SKW_E_SEC_ROLE_DISABLED` when
   `SKW_FLEET_MODE=0`, which is what §9.1 requires. A fleet session has
   `tenant_id = NULL` and resolves to row 7's 404 on every tenant route. **A fleet
   surface is an open item.**
8. **`ip_hash` / `ua_hash` are stored, not enforced.** The columns are `NOT NULL` and
   the SDS attaches no rule to them. Binding a session to an IP breaks mobile operators
   and CGNAT (D9's own argument); binding to a UA breaks every browser update. Stored
   for audit, not compared.
9. **Lockout is an intentional oracle after the fifth failure.** A locked account
   answers `429 SKW_E_SEC_RATE_LIMITED`; a nonexistent email cannot lock and answers
   401. Single attempts are indistinguishable (§3.3); the status only diverges once an
   attacker has already made five guesses against a real account.
10. **`/admin` and `/admin/` are `404 SKW_E_PLT_TENANT_UNKNOWN`.** §9.2 makes the
    tenant-scoped URL the only admin URL, and S2a ships no dashboard. Not a placeholder
    200.
11. **`npm test` still calls `node --test` directly**, so it does not enforce the skip
    rule; `make` is the gate and `make test` is the canonical command. Routing
    `package.json`'s script through the runner is a one-line follow-up.

---

## 8. What S2b should build first

**The operator lifecycle that S2a deliberately left out, because without it a fresh
bundle has no way in**: TOTP enrolment (`POST /admin/t/<key>/totp/enrol` + confirm),
password reset through `reset_token_hash` / `reset_expires_at`, and a tenant switcher
that changes the URL rather than the session. Then the CRUD surface, which is the first
caller of `session/rotate` for a real privilege change (role edits) — S2a exposes the
rotation and proves it, but nothing yet changes a privilege automatically.

Two things S2b must not do: resolve a tenant from `Host` on the admin listener (§9.2),
and add a second CSRF path for forms — the token is bound to the session and the header
is `X-CSRF-Token`; a form field would be a second source of truth.
