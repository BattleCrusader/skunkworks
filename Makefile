# Skunkworks — verification entry points.
#
# `make test` is the canonical command tooling looks for; `make verify` is the
# same thing spelled the way a human thinks about it. Both run every check and
# exit non-zero on failure.

.PHONY: help test verify verify-toolchain verify-gitignore verify-schema verify-claims \
        verify-claims-modern verify-frozen verify-s1 build typecheck diagrams

help:
	@echo "make test                run every verification check (canonical)"
	@echo "make verify              alias of make test"
	@echo "make verify-toolchain    assert \$$(PYTHON) imports argon2 and sqlite3 (E-15)"
	@echo "make verify-schema       generate both DDL files, apply them to real SQLite, run every negative test"
	@echo "make verify-claims       re-run every measurement the register and the SDS cite (27 checks)"
	@echo "make verify-claims-modern same gate on \$$(MODERN_PYTHON), whose SQLite is >= 3.50 (E-15)"
	@echo "make verify-frozen       assert docs/sds/SDS.md quotes the register verbatim"
	@echo "make verify-gitignore    assert .gitignore verdicts against git"
	@echo "make verify-s1           build, typecheck, and run the S1 gates in test/"
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

verify: verify-gitignore verify-schema verify-claims verify-frozen verify-s1

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

# --test-timeout=15000 (E-8): a gate that regresses into a wait is red in under 20 s,
# with a named failure, instead of a CI job timeout.
verify-s1: verify-toolchain build typecheck
	@node --test --test-concurrency=1 --test-timeout=15000 $(shell find test -name '*.test.ts' | sort)

diagrams:
	@plantuml -tpng -charset UTF-8 docs/sds/diagrams/*.puml docs/debate/diagrams/*.puml
	@python3 -c "import glob,os,struct; [print('%-52s %8d B  %dx%d' % ((p, os.path.getsize(p)) + struct.unpack('>II', open(p,'rb').read(33)[16:24]))) for p in sorted(glob.glob('docs/*/diagrams/*.png'))]"
