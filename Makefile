# Skunkworks — verification entry points.
#
# `make test` is the canonical command tooling looks for; `make verify` is the
# same thing spelled the way a human thinks about it. Both run every check and
# exit non-zero on failure.

.PHONY: help test test-perf verify verify-toolchain verify-gitignore verify-schema verify-claims \
        verify-claims-modern verify-frozen verify-s1 verify-dist verify-no-leak build typecheck diagrams

help:
	@echo "make test                run every verification check (canonical, deterministic)"
	@echo "make test-perf           the performance gate: wall-clock assertions, IDLE BOX ONLY"
	@echo "make verify              alias of make test"
	@echo "make verify-toolchain    assert \$$(PYTHON) imports argon2 and sqlite3 (E-15)"
	@echo "make verify-schema       generate both DDL files, apply them to real SQLite, run every negative test"
	@echo "make verify-claims       re-run every measurement the register and the SDS cite (27 checks)"
	@echo "make verify-claims-modern same gate on \$$(MODERN_PYTHON), whose SQLite is >= 3.50 (E-15)"
	@echo "make verify-frozen       assert docs/sds/SDS.md quotes the register verbatim"
	@echo "make verify-gitignore    assert .gitignore verdicts against git"
	@echo "make verify-s1           build, typecheck, and run the S1 gates in test/ (a skip is a failure, G3)"
	@echo "make verify-dist         execute dist/ as a child process: D1 boot, D2 page, D3 download, D4 migrate, D5 skwctl, D6 nginx_gen (E-28)"
	@echo "make build               tsc to dist/ plus the Astro middleware entry in build/astro/"
	@echo "make diagrams            re-render every .puml in docs/ and report each PNG's size"

# --- interpreters, declared (E-15) -------------------------------------------------
#
# `PYTHON ?= /usr/bin/python3` is deliberate and deterministic. It is NOT a claim that
# /usr/bin/python3 ships argon2-cffi — on most Linux distributions it does not.
# `verify-toolchain` runs first and fails with the package name and the interpreter
# path it tried, so a missing dependency is a red gate that says what to install
# instead of a quiet "25/27 passed, 2 skipped".
#
# `MODERN_PYTHON` is the second interpreter CI uses for the amendment chain: one whose
# SQLite is >= 3.50, which is the version that re-parses triggers on ALTER TABLE …
# RENAME and therefore the only one on which E-6's regression is visible.
PYTHON ?= /usr/bin/python3
MODERN_PYTHON ?= python3

test: verify-toolchain verify

verify: verify-gitignore verify-schema verify-claims verify-frozen verify-s1 verify-dist verify-no-leak

# E-15: preflight. Both imports are load-bearing — checks 17 and 21 need argon2, and
# every check needs a SQLite that can apply the frozen chain.
verify-toolchain:
	@$(PYTHON) -c 'import sys, sqlite3' 2>/dev/null || { \
	  echo "verify-toolchain: $(PYTHON) cannot import sqlite3 (the interpreter has no working sqlite3 module)"; \
	  echo "  tried: $(PYTHON)"; exit 1; }
	@$(PYTHON) -c 'import argon2' 2>/dev/null || { \
	  echo "verify-toolchain: $(PYTHON) cannot import argon2 — install argon2-cffi"; \
	  echo "  tried: $(PYTHON)"; \
	  echo "  (checks 17 and 21 skip without it, and a skip is a failure here — E-15)"; exit 1; }
	@printf 'verify-toolchain: %s -> python %s, sqlite %s, argon2 ok\n' \
	  "$(PYTHON)" "$$($(PYTHON) -c 'import sys;print(sys.version.split()[0])')" \
	  "$$($(PYTHON) -c 'import sqlite3;print(sqlite3.sqlite_version)')"

verify-schema:
	@$(PYTHON) scripts/model/gen_schema.py
	@$(PYTHON) scripts/model/validate_schema.py

# A skip is a failure: --allow-skip is never passed here (E-15).
verify-claims:
	@$(PYTHON) scripts/model/verify_claims.py

# The second run: the amendment chain on a SQLite that re-parses triggers (E-6/E-15).
verify-claims-modern: verify-toolchain
	@$(MODERN_PYTHON) scripts/model/verify_claims.py

verify-frozen:
	@$(PYTHON) scripts/model/check_frozen.py

verify-gitignore:
	@scripts/verify-gitignore.sh

# S1 — hosting core (SDS §16 S1). The build is part of the gate: the Astro
# middleware entry is a build artefact and a test that skipped the build would be
# asserting against a stale one.
build:
	@npm run --silent build

typecheck:
	@npx tsc -p tsconfig.json --noEmit
	@npx tsc -p tsconfig.test.json --noEmit

# --- the two node gates, and why there are two -------------------------------------
#
# `make test` is **deterministic**: it asserts correctness, structure and counts, and never a
# wall-clock value. `make test-perf` holds every assertion that measures time or a rate, because
# those measure the box: `S2-qa.md` D12 recorded test/sources.test.ts timing out at 15000 ms
# against a 10.47 s idle runtime under 6× CPU load, `test/integration/three-hosts.test.ts` losing
# a 17 MiB response at 14×, and a loaded `hermes verify` recording 13 of 300 failing.
#
# TEST_TIMEOUT_MS is derived, not guessed, and its input is recorded rather than remembered.
#
# `test/perf-budgets.json` is the table: every non-perf test file, measured alone, with the
# worst idle run, the date, the 1-minute load, the box and the file's sha256. "Idle" means the
# run started at a 1-minute load <= the CPU count, the same threshold perf-preflight refuses
# at. `test/timeout-budget.test.ts` asserts this constant is exactly ceil(4 x the largest
# recorded worst idle run), names the file that set it when the two disagree, and fails if a
# heavy file's bytes changed since it was measured.
#
# Derived 2026-10-21 from test/first-boot-tls.test.ts at 31 273 ms (load 7.32, 8 cpus):
# 4 x 31 273 = 125 092 -> 126 000. The old 40000 was 4.4x test/ddl-runner.test.ts at 8.99 s
# from S2; when first-boot-tls arrived at 30.76 s nothing compared the two, and the file spent
# four slices at 77% of the budget before losing a run at load 36.40. Re-measure with
# `node scripts/measure/test-file-budgets.mjs`; never edit a row by hand to quiet this gate.
#
# Both budgets matter: node applies --test-timeout to each test *and* to the file-level
# subtest, so a file whose total exceeds it fails even when every test inside it fits.
TEST_TIMEOUT_MS ?= 125000
PERF_TIMEOUT_MS ?= 180000

TEST_FILES := $(shell find test -name '*.test.ts' -not -path 'test/perf/*' | sort)
PERF_FILES := $(shell find test/perf -name '*.perf.test.ts' | sort)

# --test-timeout belongs to scripts/run-node-tests.mjs so that there is exactly one way the suite
# is invoked (E-8). The runner makes a skip a failure on the node side too, exactly as E-15
# requires of verify_claims.py. `SKW_SKIP_DOCKER=1` alone can no longer buy a green gate; the only
# escape is `SKW_ALLOW_SKIP=1`, which is never set here.
verify-s1: verify-toolchain build typecheck
	@node scripts/run-node-tests.mjs --timeout=$(TEST_TIMEOUT_MS) $(TEST_FILES)

# E-28: the gate that executes the artefact that ships. Every other code-executing gate
# here imports the TypeScript modules under Node's type stripping, where `import.meta.url`
# ends in `.ts` — so a resolver that only works in the source world is invisible to all of
# them. That is how a `.ts`-only worker URL reached production with 404/404 green. This
# target runs `dist/` as a child process and asserts six things (D1–D6) on what comes out;
# it is not a `test/**/*.test.ts` file because `npm test` does not build, and a dist case
# inside `test/` would either fail on a clean tree or be given a skip — and a skip is a
# failure here (E-8, E-15).
verify-dist: build
	@node scripts/dist-gate.mjs

# ITEM 0 (S4a): a run that leaves a `skw-*` container or network behind is red. It runs
# **last** in `verify` on purpose — a leak is left by a file that has already finished, so
# no test file can see it. The script carries its own negative control (create a
# container, skip the teardown, require the audit to name it, remove it, require clean);
# without that, a matcher that matches nothing would read as a tidy daemon.
#
# Docker is not optional here: the real-nginx gates already fail without a daemon (a skip
# is a failure, E-15), so an audit that cannot query it is a failure too, not a pass.
verify-no-leak: verify-s1
	@node scripts/leak-gate.mjs --self-test

# The performance gate. Not part of `make test`, and it says what it is before it runs: these
# assertions are only meaningful on a box that is not already busy. The load-average guard refuses
# to pretend (`SKW_PERF_FORCE=1` overrides it, and the banner then says the numbers are not a
# measurement).
test-perf: verify-toolchain typecheck
	@printf 'make test-perf: PERFORMANCE GATE — %s\n' "wall-clock assertions, not correctness"
	@node scripts/perf-preflight.mjs
	@node scripts/run-node-tests.mjs --timeout=$(PERF_TIMEOUT_MS) $(PERF_FILES)
	@printf 'make test-perf: covers the rate/timing assertions only. Not covered: plan, allowlist,\n'
	@printf '  budget-refusal, body-shape and count assertions — those are `make test`.\n'

diagrams:
	@plantuml -tpng -charset UTF-8 docs/sds/diagrams/*.puml docs/debate/diagrams/*.puml
	@python3 -c "import glob,os,struct; [print('%-52s %8d B  %dx%d' % ((p, os.path.getsize(p)) + struct.unpack('>II', open(p,'rb').read(33)[16:24]))) for p in sorted(glob.glob('docs/*/diagrams/*.png'))]"
