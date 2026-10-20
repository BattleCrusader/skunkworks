#!/bin/bash
# ITEM 0's proof: ten consecutive full `make test` runs, each one's E-16 case recorded.
# A run is green only if make test exits 0 AND the E-16 case is reported ok.
cd "$(dirname "$0")/../.." || exit 2
LOG=scratch/s2d/ten-runs.log
: > "$LOG"
for i in $(seq 1 10); do
  start=$(date +%s)
  out=$(make test 2>&1)
  code=$?
  end=$(date +%s)
  counts=$(echo "$out" | grep -E '^# (tests|pass|fail|skipped) ' | tr '\n' ' ')
  e16=$(echo "$out" | grep -E '^(ok|not ok) [0-9]+ - 4\. three login' | head -1)
  claims=$(echo "$out" | grep -E '^[0-9]+/[0-9]+ passed' | tail -1)
  printf 'run %2d  exit=%d  %4ds  %s\n         %s\n         claims: %s\n' \
    "$i" "$code" "$((end-start))" "$counts" "$e16" "$claims" | tee -a "$LOG"
done
echo "--- summary" | tee -a "$LOG"
echo "runs: $(grep -c '^run ' "$LOG")  green: $(grep -c 'exit=0' "$LOG")  e16-ok: $(grep -c 'ok 16 - 4\. three login' "$LOG")  e16-red: $(grep -c 'not ok .*4\. three login' "$LOG")  claims-27: $(grep -c '27/27 passed' "$LOG")" | tee -a "$LOG"
