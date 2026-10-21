#!/bin/bash
# Three consecutive `make test` runs, with the box load before and after each.
# The counts are read from the TAP summary; nothing is filtered or re-run.
set -u
cd /Volumes/Backup/Development/skunkworks || exit 1
for i in 1 2 3; do
  before=$(uptime | sed -E 's/.*load averages?: //')
  start=$(date +%s)
  make test > "scratch/fix/make-test-$i.log" 2>&1
  code=$?
  end=$(date +%s)
  after=$(uptime | sed -E 's/.*load averages?: //')
  echo "=== RUN $i exit=$code seconds=$((end - start)) load_before={$before} load_after={$after}"
  grep -E '^# (tests|pass|fail|skipped|todo|cancelled) ' "scratch/fix/make-test-$i.log" | tr '\n' ' '
  echo
done
