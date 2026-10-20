#!/bin/bash
# QA S3 round 2 / A.1 second half — is each of D1..D6 really executing dist/, or could it
# pass with the artefact deleted?  For each check, remove the file it claims to run, run
# `node scripts/dist-gate.mjs` DIRECTLY (no `make`, so nothing rebuilds the damage away),
# record which ids went red, and restore the file byte-identical.
set -u
cd /Volumes/Backup/Development/skunkworks
L=scratch/qa-s3r2/dist-controls.log
: > "$L"

run_case () {
  local label="$1"; shift
  local target="$1"; shift
  echo "===== $label : remove $target" >> "$L"
  local before
  before=$(shasum -a 256 "$target" | cut -d' ' -f1)
  mv "$target" "$target.qa-aside"
  node scripts/dist-gate.mjs > scratch/qa-s3r2/_gate.tmp 2>&1
  local rc=$?
  echo "exit=$rc" >> "$L"
  grep -E "^ok   D|^FAIL D|^verify-dist:" scratch/qa-s3r2/_gate.tmp | sed 's/ *$//' >> "$L"
  mv "$target.qa-aside" "$target"
  local after
  after=$(shasum -a 256 "$target" | cut -d' ' -f1)
  if [ "$before" = "$after" ]; then echo "restore: IDENTICAL $after" >> "$L"; else echo "restore: ***DIFFERS*** $before -> $after" >> "$L"; fi
  echo >> "$L"
}

run_case "D1/D2/D3 entry" dist/app/main.js
run_case "D3 worker"      dist/app/download/stamp-worker.js
run_case "D4 migrate"     dist/app/db/migrate.js
run_case "D5 skwctl"      dist/app/cli/skwctl.js
run_case "D6 nginx_gen"   dist/tools/nginx_gen.js

echo "done"
cat "$L"
