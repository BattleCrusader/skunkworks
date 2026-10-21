#!/bin/bash
# QA3: three consecutive `make test` runs, each with counts, exit code and box load.
set -u
cd /Volumes/Backup/Development/skunkworks || exit 99
out=scratch/qa3
mkdir -p "$out"
for i in 1 2 3; do
  load_before=$(sysctl -n vm.loadavg)
  start=$(date +%s)
  make test >"$out/make-test-$i.log" 2>&1
  code=$?
  end=$(date +%s)
  load_after=$(sysctl -n vm.loadavg)
  echo "=== RUN $i exit=$code seconds=$((end-start)) load_before=$load_before load_after=$load_after"
  grep -E "^(# tests|# pass|# fail|# skipped|# todo|verify-toolchain|NOT OK|OK )" "$out/make-test-$i.log" | tail -12
  grep -E "tests [0-9]+|# pass|# fail" "$out/make-test-$i.log" | tail -4
done
echo "=== ALL DONE"
