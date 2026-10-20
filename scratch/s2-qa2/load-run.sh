#!/bin/bash
# QA round 2 — the whole suite once under deliberate CPU load, to see whether the disclosed
# "1 failed of 300" is a timing-sensitive test rather than a correctness gate.
cd /Volumes/Backup/Development/skunkworks || exit 1
N=${1:-6}
pids=""
for i in $(seq "$N"); do yes > /dev/null & pids="$pids $!"; done
make test > scratch/s2-qa2/make-test-load.log 2>&1
code=$?
for p in $pids; do kill "$p" 2>/dev/null; done
echo "LOAD RUN EXIT=$code"
grep -E '^not ok|^# (tests|pass|fail)' scratch/s2-qa2/make-test-load.log
