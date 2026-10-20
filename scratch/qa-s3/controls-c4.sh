#!/bin/bash
# QA S3 — control C4, corrected: the first attempt's Python replacement never matched, so
# the file was byte-identical and the green proved nothing. Here the mutation is applied by
# a checked script that refuses to write if the target text is absent.
set -u
cd /Volumes/Backup/Development/skunkworks || exit 1
OUT=scratch/qa-s3/controls-c4.log
F=nginx/templates/server.tmpl
: > "$OUT"

for mode in c4a c4b; do
  before=$(shasum -a 256 "$F" | awk '{print $1}')
  cp "$F" "scratch/qa-s3/server.tmpl.$mode.bak"
  echo "=== CONTROL $mode" >> "$OUT"
  echo "sha256 before:   $before" >> "$OUT"
  if ! python3 scratch/qa-s3/mutate.py "$F" "$mode" >> "$OUT" 2>&1; then
    echo "MUTATION FAILED — no gate run" >> "$OUT"
    cp "scratch/qa-s3/server.tmpl.$mode.bak" "$F"
    continue
  fi
  broken=$(shasum -a 256 "$F" | awk '{print $1}')
  echo "sha256 broken:   $broken" >> "$OUT"
  if [ "$before" = "$broken" ]; then
    echo "MUTATION WAS A NO-OP — no gate run" >> "$OUT"
    cp "scratch/qa-s3/server.tmpl.$mode.bak" "$F"
    continue
  fi
  echo "--- diff" >> "$OUT"
  diff -u "scratch/qa-s3/server.tmpl.$mode.bak" "$F" >> "$OUT"
  echo "--- GATE $mode nginx N1" >> "$OUT"
  node --test --test-concurrency=1 --test-timeout=180000 --test-name-pattern="N1" test/nginx-media-e2e.test.ts >> "$OUT" 2>&1
  echo "--- GATE $mode exit=$?" >> "$OUT"
  cp "scratch/qa-s3/server.tmpl.$mode.bak" "$F"
  after=$(shasum -a 256 "$F" | awk '{print $1}')
  echo "sha256 restored: $after" >> "$OUT"
  if [ "$before" = "$after" ]; then echo "RESTORE: IDENTICAL" >> "$OUT"; else echo "RESTORE: MISMATCH" >> "$OUT"; fi
  echo "" >> "$OUT"
done
