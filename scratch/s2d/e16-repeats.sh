#!/bin/bash
# The flake, measured: R repetitions of the E-16 ratio at a given sample count,
# under the same load shape the S2c run shared its box with.
# Usage: scratch/s2d/e16-repeats.sh <n-per-cause> <reps>
N=${1:-20}; R=${2:-8}
for i in $(seq 1 "$R"); do
  node scratch/s2d/e16-probe.ts "$N" 2>/dev/null | awk '/^--- interleaved/{f=1;next} /^--- sequential/{f=0} f && /ratio of medians/{gsub(/ratio of medians = /,""); print "n='"$N"' rep='"$i"' ratio", $1}'
done
