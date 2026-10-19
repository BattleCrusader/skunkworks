# Skunkworks — verification entry points.
#
# `make test` is the canonical command tooling looks for; `make verify` is the
# same thing spelled the way a human thinks about it. Both run every check and
# exit non-zero on failure.

.PHONY: help test verify verify-gitignore

help:
	@echo "make test              run every verification check (canonical)"
	@echo "make verify            alias of make test"
	@echo "make verify-gitignore  assert .gitignore verdicts against git"

test: verify

verify: verify-gitignore

verify-gitignore:
	@scripts/verify-gitignore.sh
