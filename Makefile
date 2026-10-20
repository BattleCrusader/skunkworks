# Skunkworks — verification entry points.
#
# `make test` is the canonical command tooling looks for; `make verify` is the
# same thing spelled the way a human thinks about it. Both run every check and
# exit non-zero on failure.

.PHONY: help test verify verify-gitignore verify-schema verify-claims verify-frozen diagrams

help:
	@echo "make test              run every verification check (canonical)"
	@echo "make verify            alias of make test"
	@echo "make verify-schema     generate both DDL files, apply them to real SQLite, run every negative test"
	@echo "make verify-claims     re-run every measurement the register and the SDS cite (27 checks)"
	@echo "make verify-frozen     assert docs/sds/SDS.md quotes the register verbatim"
	@echo "make verify-gitignore  assert .gitignore verdicts against git"
	@echo "make diagrams          re-render every .puml in docs/ and report each PNG's size"

test: verify

verify: verify-gitignore verify-schema verify-claims verify-frozen

verify-schema:
	@python3 scripts/model/gen_schema.py
	@python3 scripts/model/validate_schema.py

verify-claims:
	@python3 scripts/model/verify_claims.py

verify-frozen:
	@python3 scripts/model/check_frozen.py

verify-gitignore:
	@scripts/verify-gitignore.sh

diagrams:
	@plantuml -tpng -charset UTF-8 docs/sds/diagrams/*.puml docs/debate/diagrams/*.puml
	@python3 -c "import glob,os,struct; [print('%-52s %8d B  %dx%d' % ((p, os.path.getsize(p)) + struct.unpack('>II', open(p,'rb').read(33)[16:24]))) for p in sorted(glob.glob('docs/*/diagrams/*.png'))]"
