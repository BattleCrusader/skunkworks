# Skunkworks — verification entry points.
#
# `make verify` is the canonical command: if a check exists, it runs here.
# Each target prints PASS/FAIL and exits non-zero on failure.

.PHONY: help verify verify-gitignore

help:
	@echo "make verify            run every verification check"
	@echo "make verify-gitignore  assert .gitignore verdicts against git"

verify: verify-gitignore

verify-gitignore:
	@scripts/verify-gitignore.sh
