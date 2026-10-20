#!/bin/bash
# A load generator shaped like the S2c flake: CPU contention, an fsync-heavy writer
# on the SAME volume as the repo, and memory churn — the shape of the docker build
# the failing run shared its box with.
# Usage: scratch/s2d/load.sh <seconds> <cmd...>
DUR=${1:-30}; shift
set +m
PIDS=()
TMPD="$(cd "$(dirname "$0")" && pwd)/tmp"
mkdir -p "$TMPD"
for i in 1 2 3 4 5 6 7 8; do
  ( end=$((SECONDS+DUR)); while [ $SECONDS -lt $end ]; do :; done ) 2>/dev/null &
  PIDS+=($!)
done
( end=$((SECONDS+DUR)); while [ $SECONDS -lt $end ]; do dd if=/dev/zero of="$TMPD/x.$$" bs=1m count=32 conv=fsync 2>/dev/null; done ) 2>/dev/null &
PIDS+=($!)
( end=$((SECONDS+DUR)); node -e 'const t=Date.now()+'"$DUR"'*1000; const keep=[]; while(Date.now()<t){ keep.push(Buffer.alloc(8*1024*1024,1)); if(keep.length>60) keep.splice(0,30);} ' ) 2>/dev/null &
PIDS+=($!)
sleep 1
"$@"
RC=$?
for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null; done
rm -rf "$TMPD"
wait 2>/dev/null
exit $RC
