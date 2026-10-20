# S2b — first-run bootstrap, operator lifecycle, fleet console

**Builder:** Backend Engineer. **Date:** 2026-10-20. **Base:** `beda107` (S2a GO, errata E-16..E-19 + D28–D30).
**Not committed.** `git status --porcelain`: 10 modified, 9 new paths (§1).

Scope, in the order the work order gives it: **E-19 bootstrap (item 1)**, **TOTP enrolment +
`reset-totp` (2)**, **password reset (3)**, **fleet console + switcher (4)**. Item 5 (the first CRUD
read path) was reached and is in for list + detail on `render-read`. E-17 (the IP allowlist) is **not
in this slice** — it is not in S2b's scope list, and half-wiring an env name without the edge rule
would be worse than leaving it (§7).

Every criterion below has a command and its real output. Every new gate also has a **mutation that
makes it go red** (§6), because a test that has never failed is not evidence.

---

## 1. What shipped

| Path | Status | What it is |
|---|---|---|
| `app/cli/skwctl.ts` | new, 558 | `admin bootstrap` / `reset-totp` / `reset-password` (E-19, D30) |
| `app/admin/totp.ts` | new, 57 | one secret mint (20 bytes → base32), one grouping, one `otpauth://` URI |
| `app/admin/routes.ts` | rewritten, 806 | D29's shapes, E-16's login, enrolment/confirm, reset request, pages read path |
| `app/admin/auth.ts` | modified | `SKW_E_SEC_AUTH_INVALID`; one TOTP verification per attempt, before the password verdict; `reason` off-wire |
| `app/admin/session.ts` | modified | `SESSION_ABSOLUTE_MS`, the clamped slide, rotation inherits `created_at` (E-18) |
| `app/main.ts` | modified | the urlencoded body parser D29's login form needs |
| `app/errors.ts`, `schema/error-codes.json` | modified | `AUTH_INVALID`, 71 → 72 codes, `SEC` area row |
| `schema/control.seed.json` | new | the seed: one production tenant + one **claim marker** (E-19) |
| `tools/seed_control.mjs` | new | seed → `control.db`, one transaction, three refusals |
| `tools/bundle_verify.mjs` | new | `BUNDLE.json` sha256 + symlink escape check (exit 12) |
| `tools/install_check.mjs` | new | install's own smoke test: boot the installed app, log in, `GET /admin` |
| `install.sh` | new | verify → control.sql → seed → .env → bootstrap → compose up (exit 11/12/15/16/17) |
| `test/cli-bootstrap.test.ts` | new, 389 | E-19's ten cases, as processes |
| `test/admin-operator.test.ts` | new, 463 | D28/D29, enrolment, password reset, pages |
| `test/install.test.ts` | new, 108 | `./install.sh` end to end, twice |
| `test/admin-auth.test.ts`, `test/admin-session.test.ts`, `test/error-codes.test.ts`, `test/helpers/admin.ts` | modified | E-16/E-18 assertions; the login helper's `key` became an assertion instead of a URL segment |

`schema/control.sql` is **untouched**: E-18's cap is a function of `created_at` and E-19's secret lives
in `totp_secret`, exactly as the errata says. No `control-r4.sql`, no `gen_schema.py` bump, no
re-baselined check 20.

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
# tests 176
# pass 176
# fail 0
# skipped 0
EXIT=0

$ make verify-s1
# tests 176  # pass 176  # fail 0  # skipped 0
EXIT=0
```

176 = 145 (S2a) + 31 new: 10 bootstrap, 13 operator, 4 session, 2 auth, 2 error-codes, 1 install.
`# skipped 0` on both, and since G3 a skip cannot exit 0 anyway.

`hermes verify --json` — the full harness including a runtime boot — on the delivered tree:

```
{"recipe":"Astro","ok":true,
 "phases":[bootstrap 0, build 0, "npm run typecheck" 0, "npm run test" 0 (176/176),
           "make test" 0 (176/176), "make typecheck" 0, "make build" 0],
 "readiness":{"url":"http://127.0.0.1:4321/","ready":true,"statusCode":200}}
```

**Baseline for comparison, measured before any edit:** `# tests 145 # pass 145 # fail 0 # skipped 0`,
`make test` 45 s wall. After: 176, 39 s.

---

## 3. Acceptance criteria

### 3.1 bootstrap on a fresh `control.db` yields a working login — bootstrap → TOTP → cookie → 200 on `/admin`

```
$ node --test --test-reporter=tap test/cli-bootstrap.test.ts
ok 1 - 1. a fresh seeded control.db and nothing else yields one operator, and a code from the printed URI logs in
ok 2 - 10. the otpauth URI parses and its secret verifies a TOTP code
# tests 10  # pass 10  # fail 0
```

Test 1 is the whole path: `spawnSync(node app/cli/skwctl.ts admin bootstrap --generate-password
--enrolment-out …)`, then `buildApp` on the same `control.db`, then `POST /admin/login` with the
password from the file and `totpCode(secretFromTheUri, now)`, then `GET /admin` with the cookie:

```
install_check: signed in as owner@acme.test, GET /admin 200 (text/html)
```

which is the same assertion the installer makes for itself (`./install.sh … --verify-login`).

### 3.2 bootstrap twice: second run exits 3, no row changed, first credentials still work

```
ok 3 - 2. a second run exits 3 and leaves password_hash, totp_secret and must_change byte-identical

$ ./install.sh --target /tmp/skw-install/data --no-compose --skip-dns      # second run
REFUSAL: ALREADY_BOOTSTRAPPED: every operator row is claimed; nothing was written. To change a factor:
  skwctl admin reset-totp     --email <email> --enrolment-out <path>
  skwctl admin reset-password --email <email> (--password-stdin | --generate-password)
install: bootstrap: this box is already set up; nothing changed (exit 3)
install: done. …
EXIT=0
```

Exit 3 is the **only** benign refusal; `install.sh` maps it to a note and continues, and maps anything
else to **16**. The test re-logs-in after the second run with the first credentials
(`assert.equal(again.status, 200)`), so the refusal provably did not rotate a secret it did not create.

### 3.3 the file is 0600, stdout carries no plaintext, and the password is in no audit row or log

```
$ stat -f "mode=%Lp %N" /tmp/skw-m1/data/first-login.txt /tmp/skw-m1.env
mode=600 /tmp/skw-m1/data/first-login.txt
mode=600 /tmp/skw-m1.env

$ grep -c -- "$PW" /tmp/skw-m1.log        # $PW from the enrolment file
0
$ grep -c -- "$SC" /tmp/skw-m1.log        # $SC the base32 secret
0
$ grep -c -- "$PW" /tmp/skw-m1.env ; grep -c -- "$SC" /tmp/skw-m1.env
0
0
$ sqlite3 … "SELECT count(*) FROM audit_log WHERE after_json LIKE '%$SC%';"
0
$ sqlite3 … "SELECT count(*) FROM audit_log WHERE after_json LIKE '%$PW%';"
0
$ grep -E "^(enrolment written|login|email)" /tmp/skw-m1.log
enrolment written: /tmp/skw-m1/data/first-login.txt (0600, mode O_EXCL)
login: https://admin.skw.test/admin/login
email: owner@acme.test
```

Stdout is three lines: the path, the URL, the email. The secret is in exactly one row of the database
(`user_account.totp_secret`, which is where it lives) and in the file — test 9 asserts both halves,
including that `audit_log.after_json` does not carry it.

### 3.4 the `otpauth://` URI parses and its secret verifies a code

```
ok 2 - 10. the otpauth URI parses and its secret verifies a TOTP code
```

Asserted against `new URL(...)`: scheme `otpauth:`, host `totp`, path `/Skunkworks:<email>`,
`issuer=Skunkworks`, `algorithm=SHA1`, `digits=6`, `period=30`, `secret` a 32-character base32 string
(20 bytes), and `verifyTotp(secret, totpCode(secret, now)) === true`.

### 3.5 a fresh bundle can be logged into end to end with `install.sh` only — measured

```
$ /usr/bin/time -p env SKW_ENV_FILE=/tmp/skw-m1.env ./install.sh \
      --target /tmp/skw-m1/data --no-compose --skip-dns --verify-login
install: verify: no BUNDLE.json at . (source tree install); nothing to hash
install: schema: control.sql applied to /tmp/skw-m1/data/control.db (v3)
seed_control: 1 tenant(s), 1 claim marker(s), one transaction
install: env: /tmp/skw-m1.env written (0600) with a fresh key per install
enrolment written: /tmp/skw-m1/data/first-login.txt (0600, mode O_EXCL)
install: bootstrap: enrolment written to /tmp/skw-m1/data/first-login.txt (0600)
install: compose: skipped (--no-compose)
migrate: tenant acme created
install_check: signed in as owner@acme.test, GET /admin 200 (text/html)
install: done. Sign in at https://admin.skw.test/admin/login, then delete /tmp/skw-m1/data/first-login.txt.
real 0.42
```

**Measured install + bootstrap: 0.42 s / 0.38 s / 0.37 s over three clean runs (median 0.38 s).** The
run includes DDL, seed, `.env` generation, bootstrap (argon2 at `m=19456,t=2,p=1`), the app's boot
migration, and a real login. `make build` and the image are excluded, as they are for any install: the
container ships `dist/`.

**What the measurement does not cover, stated plainly.** The `docker compose up -d` step is
**unexercised**: `docker-compose.yml` pins `ghcr.io/skunkworks/app@sha256:0000…` (D10's digest is S4's
release artefact) and the pull is refused by the registry:

```
$ ./install.sh --target /tmp/skw-m4/data --skip-dns
Error response from daemon: error from registry: denied
install: REFUSAL: docker compose up -d failed
EXIT=17
```

`--no-compose` is therefore what the gate measures, and exit **17** is an addition (§11.6 names no code
for a compose failure). The five-minute number in §16 is S4's row; this proves the command and the login
it enables.

Two defects found by running it rather than reading it: `docker-compose.yml` requires `ACME_EMAIL`
(`${ACME_EMAIL:?…}`) and install.sh did not generate it — fixed, `--email` defaults to
`admin@<admin host>`; and `install.sh` wrote `./.env` unconditionally, which two concurrent runs (and a
gate) would share — `SKW_ENV_FILE` now names the file.

### 3.6 rotation on privilege change still invalidates the old session (S2a regression)

```
$ node --test test/admin-session.test.ts
ok 4 - 4. rotation on privilege change: new id, old id dead, rotated_from recorded
```

and the same rule is now exercised by a *real* privilege change rather than the rotate route alone:
`totp/confirm` rotates, and the pre-enrolment cookie is `404` (`E19-2a`).

### 3.7 E-16 — failed login returns the new code; a bad download code still returns `CODE_INVALID`

```
ok 3 - 2a. TOTP is mandatory when the allowlist is empty: no code and a wrong code are both 401
ok 6 - 4. three login failure causes are indistinguishable in status, body and time
ok 5 - E-16: a credential login failure has its own code, 401, and no Retry-After
ok 6 - E-16: the split is real — a download code still raises CODE_INVALID, and the admin surface cannot raise it
```

Both halves are asserted: `SKW_E_SEC_AUTH_INVALID` is in `areas.SEC`, mapped to 401, carries no
`Retry-After`; `SKW_E_SEC_CODE_INVALID` keeps 401 and its own row; the two bodies are equal **after
normalising only the code**, which is what makes one counter per decision possible; and a structural
assertion walks `app/admin/*.ts` and requires zero `AppError('SKW_E_SEC_CODE_INVALID'` — the login path
cannot emit the paid-download code by accident, which is exactly what S2a did.

The work-shape rule is measured, not asserted in prose: `ok 7 - 4b. … the work an attempt does is a
function of configuration only`. With TOTP mandatory, four attempts (success, wrong password, unknown
email, wrong TOTP) increment the TOTP-verification counter by exactly **4**; with the allowlist populated
the same two attempts increment it by **0**. Test 4 measures three causes and requires medians within
20 % (measured ratio below the bound on every run) with byte-equal scrubbed bodies.

### 3.8 E-18 — the absolute cap, with recent activity

```
ok 6 - 7. E-18(a): a session touched every 5 minutes is refused at created_at + 12 h, with 404 and no Set-Cookie
ok 7 - 8. E-18(b): the slide clamps at created_at + SESSION_ABSOLUTE_MS, asserted on the stored value
ok 8 - 9. E-18(c): rotation at 11 h 59 m inherits created_at, so the child dies one minute later
ok 9 - 10. E-18(d): a session dead by idle inside the cap is refused, and the attempt does not slide it
```

(a) is the sliding case driven through `readAndTouch` at 5-minute steps until the cap, then over HTTP
with a *future* `expires_at` — the polling-tab case — and asserts 404, no `Set-Cookie`, and that the
row was not slid. (b) asserts the clamp on the stored value. (c) rotates at 11 h 59 m and asserts the
child's `created_at` equals the parent's, then dead one minute later. (d) is the idle case inside the
cap, asserting the refused attempt wrote nothing.

### 3.9 the tenant switcher changes the URL, not the session

```
ok 3 - D29-3. the switcher changes the URL; the session row tenant is unchanged
ok 4 - D29-4. another tenant's /admin/t/<key>/… is refused for a non-fleet operator
ok 5 - D29-5. a fleet operator reaches the console and no tenant URL
```

Following the link the console offers (`/admin/t/acme/`) returns 200 and the `session.tenant_id` is
byte-identical before and after. With an acme session, `/admin/t/beta/`, `/admin/t/beta/session` and
`/admin/t/beta/pages` are all `404 SKW_E_PLT_TENANT_UNKNOWN` with no `Set-Cookie`, and the session row
is neither re-tenanted nor revoked. A fleet session (`tenant_id IS NULL`) sees every active tenant on
`/admin` and is refused every tenant URL — the true statement for a session with no tenant.

### 3.10 D28 and D29, asserted as shapes

```
ok 7 - D28. the CSRF token is a header and there is no form-field alternative
ok 6 - D29-6. /admin/login is the only login URL: a page for GET, a real form post for POST
ok 1 - D29-1. GET /admin with no session is the row-7 404, not a login redirect
ok 2 - D29-2. the console lists the tenant an operator may reach, and only that one
```

A urlencoded body carrying `csrfToken=` and `_csrf=` in place of the header is `403 SKW_E_SEC_CSRF`;
the same request with `X-CSRF-Token` succeeds. `POST /admin/t/acme/login` — the old per-tenant login —
is `404`, because a login URL that names a tenant is the second source of truth §9.2 forbids.

---

## 4. Item 5 — the first CRUD read path, on `render-read`

```
ok 12 - CRUD-1. GET pages lists this tenant's cms_page rows, and the detail is one row
ok 13 - CRUD-2. the list is tenant-scoped: beta's page id is not reachable from acme
```

`GET /admin/t/<key>/pages` and `GET /admin/t/<key>/pages/<id>` open the tenant's `site.db` through
`openRenderRead` (§2.2: `readonly`, `query_only=1`, `foreign_keys=1`, `busy_timeout`) and close it; a
missing id is `404 SKW_E_RT_PAGE_NOT_FOUND`; both responses are `no-store`.

---

## 5. Item 2 — enrolment for a second operator, and `reset-totp`

```
ok 8 - E19-2a. enrolment hands out a secret that is not written until a code proves it
ok 9 - E19-2b. skwctl admin reset-totp replaces the secret and revokes the sessions
```

**The one design decision the errata leaves open.** `user_account` has no "pending secret" column, so a
two-step enrolment cannot be persisted without a migration. The pending secret is therefore held in
memory, per session, for ten minutes, and `totp_secret` is written only when a code proves an
authenticator holds it. Until then the operator's **existing** secret keeps working, so a mistyped
enrolment cannot lock anybody out — which a write-then-confirm design would. A restart drops a pending
enrolment, and the operator starts again; nothing is lost but ten minutes. Confirm rotates the session,
because adding a second factor is a privilege change.

---

## 6. Negative controls — each gate goes red when its behaviour is broken

Method: `shasum -a 256` baseline, mutate the behaviour, run the affected file, restore, re-verify the
hash, re-run green.

| # | Mutation | Red output | Green after restore |
|---|---|---|---|
| M1 | the TOTP verification moved back behind `if (!passwordOk) return` | `not ok 7 - 4b. E-16: the work an attempt does is a function of configuration only` (12 tests, 1 fail) | 12/12 |
| M2 | bootstrap writes the enrolment **to stdout** instead of the file | `not ok 1,2,5,9,10` — the login case, the URI case, the created-owner case, the 0600/O_EXCL case and the "secret in no other artefact" case (10 tests, 5 fail) | 10/10 |
| M3 | the absolute cap removed from `SessionStore.read()` | `not ok 6 - 7. E-18(a): … refused at created_at + 12 h` (10 tests, 1 fail) | 10/10 |
| M4 | `#assertTenantMatches` becomes `return` | `not ok 4,5,13` — cross-tenant refusal, the fleet tenant URL, and the tenant-scoped page read | 13/13 |
| M5 | the login code back to `SKW_E_SEC_CODE_INVALID` | `not ok 3,6` — 2a and the three-cause case | 12/12 |

All restored: `app/admin/auth.ts: OK`, `app/admin/session.ts: OK`, `app/admin/routes.ts: OK`,
`app/cli/skwctl.ts: OK` against the baselines, and the full suite green afterwards.

**Honest note on order.** E-16 and E-18 were written test-first (the red runs are in §2 of the session
log: 5 failures for E-16, then 4 for E-18). Items 1–5 were written test-and-code in the same pass and
their red proof is the mutation table above — the same method S2a used, for the same reason.

---

## 7. Spec gaps, deviations and what is not done

1. **`dist/cli/skwctl.js` vs `dist/app/cli/skwctl.js`.** E-19's example invocation is
   `node dist/cli/skwctl.js`. This repo's `tsconfig` has `rootDir: "."` and `include: ["app/**"]`, so
   `app/cli/skwctl.ts` compiles to `dist/app/cli/skwctl.js`, and `install.sh` runs the real path. Making
   the errata's path true would mean a second compile root. Reported, not worked around.
2. **E-17 is not in this slice.** No `SKW_ADMIN_ALLOWLIST` parser, no `allowNodes` in the generated admin
   block, no deletion of `SKW_ADMIN_HOST`/`SKW_DEMOS_HOST`. The bootstrap file states
   `TOTP: required` because every bundle's allowlist is empty — the invariant, not a reading of an env
   name that the table does not contain yet. S2c's first job.
3. **`reset_token_hash` delivery.** Every bundle runs `SKW_EMAIL_MODE=off`, so there is no channel to mail
   a link through. `POST /admin/t/<key>/password/reset-request` returns the token to the already
   authenticated operator, over TLS, on the admin host; with smtp configured it would be mailed and the
   field would be absent, and **v1 has no mailer**. The token is 32 random bytes, stored as sha256,
   30 minutes, single-use, and consuming it revokes every session of the account.
4. **A reset token is not rate-limited.** `SKW_E_SEC_RATE_LIMITED` exists and the login path uses it; the
   reset-consumption route has no bucket because §9.1 attaches the lockout to credentials and the token
   is 256 bits. Stated so it is a decision, not an omission.
5. **`/admin` HTML is a console, not a UI.** §9.2's switcher needs somewhere to land, so the console is a
   list of links and the tenant home is a nav. The backend mandate says no admin UI beyond the routes;
   this is the minimum that makes the switcher testable, and it is unstyled on purpose.
6. **`tools/seed_control.mjs`, not `.py`.** §3's layout names `tools/seed_control.py`; the seed needs the
   image's own SQLite and CHECK constraints, and that is `better-sqlite3`. A python implementation would
   be a second SQLite binding to keep in step.
7. **`exit 17` for a compose failure** is an addition: §11.6 names 11/12/15/16 and no code for compose.
8. **`ENROLMENT_EXISTS` and `ADMIN_ORIGIN_UNSET`** are two refusal reasons E-19's list does not name: the
   first is the `O_EXCL` case the errata *requires* a refusal for, the second is "there is no admin URL to
   print".
9. **No sweeper.** E-18 describes one ("the sweeper deletes a row when either deadline has passed"); no
   sweeper exists in the codebase and this slice did not add one. Expiry is enforced on every read, which
   is what the gate asserts; deleting rows is housekeeping.
10. **`must_change` is still not a control**, per E-19. Bootstrap clears it; nothing expires a password.
11. **A fleet operator's session has no tenant and no tenant URL** — the console is its whole surface.
    That is D29 read literally, and it closes S2a's gap 7 as far as a surface, not as far as fleet CRUD.

---

## 8. What S2c must build first

**E-17, in full.** The allowlist is the one control D9 sells in writing that has no storage, no parser
and no enforcement: `SKW_ADMIN_ALLOWLIST` (23 names, `SUPERSEDES §4.2`), one parser shared by
`app/env.ts` and `tools/nginx_gen.ts`, `allow`/`deny` lines in the admin block only, the derived
`demos.` host, and E-13's fifth exception (nginx's `403`, `text/html`, no taxonomy code, no
`Set-Cookie`). It also unblocks the one line this slice could only state as an invariant — whether the
bootstrap file should say "TOTP required" depends on the parser it does not have yet.
