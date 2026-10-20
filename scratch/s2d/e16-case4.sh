#!/bin/bash
# Reproduce the E-16 flake: run case 4 alone, R times, and print the ratio each run.
# The pattern is matched on the test's own name so nothing else in the file runs.
R=${1:-6}
for i in $(seq 1 "$R"); do
  out=$(node --test --test-reporter=tap --test-name-pattern='^4\. three login' test/admin-auth.test.ts 2>&1)
  echo "rep $i: $(echo "$out" | grep -E 'ratio|^# (pass|fail)|not ok' | tr '\n' ' ')"
done
