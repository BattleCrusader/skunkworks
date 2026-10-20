#!/bin/bash
# Run a command under N CPU-load processes, then kill them. Usage: load-run.sh N cmd...
# The load is `yes` (one tight loop per core); N=6 on an 8-core box is the level QA used.
set -u
N="$1"; shift
pids=()
for _ in $(seq 1 "$N"); do yes > /dev/null & pids+=("$!"); done
sleep 1
"$@"
rc=$?
for p in "${pids[@]}"; do kill "$p" 2>/dev/null; done
wait 2>/dev/null
exit $rc
