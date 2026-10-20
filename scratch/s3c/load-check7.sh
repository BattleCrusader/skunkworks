#!/bin/bash
# ITEM 0's proof: run the claims gate on a box that is actually busy.
# Eight `yes` loops on eight cores; the gate must still be green, because check 7 now
# asserts a ratio measured in one process and a derived floor that load can only raise.
set -u
pids=()
for i in $(seq 1 8); do yes > /dev/null & pids+=($!); done
sleep 3
echo "load average with 8 busy loops: $(sysctl -n vm.loadavg 2>/dev/null || uptime)"
set +e
/usr/bin/python3 scripts/model/verify_claims.py > scratch/s3c/out/claims-under-load.txt 2>&1
rc=$?
set -e
for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done
wait 2>/dev/null || true
echo "exit=$rc"
grep -E "^PASS  7|^FAIL  7|passed," scratch/s3c/out/claims-under-load.txt
