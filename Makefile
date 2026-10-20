# Skunkworks — verification entry points.
#
# `make test` is the canonical command tooling looks for; `make verify` is the
# same thing spelled the way a human thinks about it. Both run every check and
# exit non-zero on failure.

.PHONY: help test verify verify-gitignore verify-schema verify-claims

help:
	@echo "make test              run every verification check (canonical)"
	@echo "make verify            alias of make test"
	@echo "make verify-schema     apply both DDL files to real SQLite, run the negative tests"
	@echo "make verify-claims     re-run every measurement docs/debate cites (19 checks)"
	@echo "make verify-gitignore  assert .gitignore verdicts against git"

test: verify

verify: verify-gitignore verify-schema verify-claims

verify-schema:
	@python3 scripts/model/gen_schema.py
	@python3 scripts/model/validate_schema.py

verify-claims:
	@python3 scripts/model/verify_claims.py

verify-gitignore:
	@scripts/verify-gitignore.sh
