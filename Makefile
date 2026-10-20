# Skunkworks — verification entry points.
#
# `make test` is the canonical command tooling looks for; `make verify` is the
# same thing spelled the way a human thinks about it. Both run every check and
# exit non-zero on failure.

.PHONY: help test verify verify-gitignore verify-schema verify-claims verify-frozen verify-s1 build typecheck diagrams

help:
	@echo "make test              run every verification check (canonical)"
	@echo "make verify            alias of make test"
	@echo "make verify-schema     generate both DDL files, apply them to real SQLite, run every negative test"
	@echo "make verify-claims     re-run every measurement the register and the SDS cite (27 checks)"
	@echo "make verify-frozen     assert docs/sds/SDS.md quotes the register verbatim"
	@echo "make verify-gitignore  assert .gitignore verdicts against git"
	@echo "make verify-s1         build, typecheck, and run the S1 gates in test/"
	@echo "make build             tsc to dist/ plus the Astro middleware entry in build/astro/"
	@echo "make diagrams          re-render every .puml in docs/ and report each PNG's size"

# The model gates need a python3 with argon2-cffi (checks 17 and 21 skip without it, and a skip
# is a failure here). /usr/bin/python3 on macOS/Linux ships it; override with `make PYTHON=...`.
PYTHON ?= $(shell test -x /usr/bin/python3 && echo /usr/bin/python3 || command -v python3)

test: verify

verify: verify-gitignore verify-schema verify-claims verify-frozen verify-s1

verify-schema:
	@$(PYTHON) scripts/model/gen_schema.py
	@$(PYTHON) scripts/model/validate_schema.py

verify-claims:
	@$(PYTHON) scripts/model/verify_claims.py

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

verify-s1: build typecheck
	@node --test --test-concurrency=1 $(shell find test -name '*.test.ts' | sort)

diagrams:
	@plantuml -tpng -charset UTF-8 docs/sds/diagrams/*.puml docs/debate/diagrams/*.puml
	@python3 -c "import glob,os,struct; [print('%-52s %8d B  %dx%d' % ((p, os.path.getsize(p)) + struct.unpack('>II', open(p,'rb').read(33)[16:24]))) for p in sorted(glob.glob('docs/*/diagrams/*.png'))]"
